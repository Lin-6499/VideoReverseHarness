"""L4: turn annotations into prompts.

Two-step design, and the split is deliberate:

  Step 1 (deterministic): map annotation fields into preset slots. Pure
  function, no model involved. This is what makes the result reproducible.

  Step 2 (LLM): merge per-shot observations into a global prompt and style
  anchor that a per-shot view cannot produce.

The per-shot prompt text is intentionally *not* LLM-rewritten by default. An LLM
rephrasing each shot adds cost, adds non-determinism, and mostly rewords what the
slots already say. The LLM's comparative advantage is cross-shot synthesis, so
that is the only place it is used.
"""

from __future__ import annotations

import logging

from vrh.contracts.prompt import PromptBundle, ShotPrompt
from vrh.stages.base import Stage, StageContext, StageResult
from vrh.stages.s3_understand import AnnotationSet

log = logging.getLogger(__name__)

MERGE_SYSTEM = """\
You are given structured annotations for every shot of a short video. Produce a
single JSON object with exactly these keys:

{
  "global_prompt": "one or two sentences capturing the whole video's subject,
                    setting and style, suitable as a text-to-video prompt",
  "style_anchor": "a short reusable style prefix, under 15 words",
  "genre": "one lowercase word",
  "pacing": "slow | medium | fast"
}

Describe only what the annotations support. Do not invent subjects, locations or
brands. Keep global_prompt under 60 words.
"""


class GenerateStage(Stage[PromptBundle]):
    name = "generate"
    artifact_name = "prompt.json"
    output_model = PromptBundle

    async def execute(self, ctx: StageContext) -> tuple[PromptBundle, StageResult]:
        annotations = self.read_artifact(ctx, AnnotationSet, "annotations.json")
        warnings: list[str] = []

        if not annotations.annotations:
            raise ValueError("no annotations available to generate prompts from")

        shots = [
            self._render_shot_prompt(ann, ctx.preset)
            for ann in annotations.annotations
        ]

        global_fields = await self._merge_globally(ctx, annotations, shots, warnings)

        aspect_ratio = self._aspect_ratio(ctx)
        total_duration = sum(s.duration_s for s in shots)

        bundle = PromptBundle(
            video_path=annotations.video_path,
            target_model=ctx.preset.name,
            global_prompt=global_fields.get("global_prompt", ""),
            style_anchor=global_fields.get("style_anchor", ""),
            genre=global_fields.get("genre", ""),
            pacing=global_fields.get("pacing", self._infer_pacing(shots)),
            shots=shots,
            aspect_ratio=aspect_ratio,
            total_duration_s=round(total_duration, 3),
            warnings=warnings,
        )

        if not bundle.global_prompt:
            bundle.global_prompt = self._fallback_global(shots)
            warnings.append("global prompt fell back to a locally generated summary")

        log.info("L4: rendered %d shot prompts", len(shots))

        return bundle, StageResult(
            artifact=self.artifact_name,
            extra={"shot_prompts": len(shots), "preset": ctx.preset.name},
            warnings=warnings,
        )

    # ------------------------------------------------------------------ #
    # Deterministic slot filling
    # ------------------------------------------------------------------ #

    def _render_shot_prompt(self, ann, preset) -> ShotPrompt:
        """Map one annotation into preset slots and render the text.

        Everything here is a pure function of the annotation and the preset,
        which is what guarantees that the same input produces the same prompt.
        """
        camera_parts: list[str] = []
        shot_size = preset.map_shot_size(ann.camera.shot_size)
        if shot_size:
            camera_parts.append(shot_size)
        motion = preset.map_motion(ann.camera.motion)
        if motion:
            camera_parts.append(motion)
        if ann.camera.speed not in ("", "static") and ann.camera.motion != "static":
            camera_parts.append(f"{ann.camera.speed} speed")
        if ann.camera.angle not in ("", "eye_level", "unknown"):
            camera_parts.append(f"{ann.camera.angle} angle")

        action_text = ann.action.label.replace("_", " ").strip()
        if ann.action.phase in ("start", "end"):
            action_text = f"{action_text} ({ann.action.phase})" if action_text else ""

        slots = {
            "subject": ann.subject,
            "action": action_text,
            "scene": self._compose_scene(ann),
            "camera": ", ".join(camera_parts),
            "lighting": ann.lighting.replace("_", " "),
            "style": ann.visual_style,
            "audio": ann.audio.music_mood if ann.audio.music != "none" else "",
        }


        # Duration comes from the shot itself. We read it from the annotation's
        # companion shot set rather than re-deriving it, so timing stays exact.
        start_s, end_s = self._shot_span(ann.shot_id)

        return ShotPrompt(
            shot_id=ann.shot_id,
            start_s=start_s,
            end_s=end_s,
            prompt=preset.render_slots(slots),
            negative_prompt=preset.negative_prompt,
            slots={k: v for k, v in slots.items() if v},
            duration_s=max(0.01, end_s - start_s),
            confidence=ann.confidence,
        )

    @staticmethod
    def _compose_scene(ann) -> str:
        parts = [ann.scene]
        if ann.time_of_day not in ("", "unknown"):
            parts.append(ann.time_of_day)
        if ann.weather:
            parts.append(ann.weather)
        return ", ".join(p for p in parts if p)

    # Injected by the pipeline before execution; kept as an attribute so tests
    # can supply spans without constructing a full shot set.
    _shot_spans: dict[int, tuple[float, float]] = {}

    def _shot_span(self, shot_id: int) -> tuple[float, float]:
        return self._shot_spans.get(shot_id, (0.0, 1.0))

    def load_spans(self, ctx: StageContext) -> None:
        """Read shot timecodes so prompts carry accurate timing.

        Timing lives in `shots.json` rather than in the annotation contract: the
        annotation describes content, the shot set describes structure, and
        keeping them separate means L3 can be re-run without disturbing timing.
        """
        from vrh.contracts.segment import ShotSet

        shot_set = self.read_artifact(ctx, ShotSet, "shots.json")
        self._shot_spans = {s.shot_id: (s.start_s, s.end_s) for s in shot_set.shots}

    def _aspect_ratio(self, ctx: StageContext) -> str:
        from vrh.contracts.media import MediaMeta

        try:
            return self.read_artifact(ctx, MediaMeta, "meta.json").aspect_ratio
        except FileNotFoundError:
            return ""

    # ------------------------------------------------------------------ #
    # LLM-based global synthesis
    # ------------------------------------------------------------------ #

    async def _merge_globally(
        self,
        ctx: StageContext,
        annotations: AnnotationSet,
        shots: list[ShotPrompt],
        warnings: list[str],
    ) -> dict[str, str]:
        """Ask the LLM for the cross-shot view that per-shot prompts cannot give."""
        import json

        digest = [
            {
                "shot_id": a.shot_id,
                "subject": a.subject,
                "action": a.action.label,
                "scene": a.scene,
                "visual_style": a.visual_style,
                "lighting": a.lighting,
                "camera_motion": a.camera.motion,
            }
            for a in annotations.annotations
        ]

        user = (
            f"Video annotations ({len(digest)} shots):\n"
            f"{json.dumps(digest, ensure_ascii=False, indent=2)}\n\n"
            f"Mean shot duration: {sum(s.duration_s for s in shots) / max(1, len(shots)):.2f}s"
        )

        try:
            raw = await ctx.providers.llm.complete(
                MERGE_SYSTEM,
                user,
                json_schema={
                    "type": "object",
                    "properties": {
                        "global_prompt": {"type": "string"},
                        "style_anchor": {"type": "string"},
                        "genre": {"type": "string"},
                        "pacing": {"type": "string"},
                    },
                    "required": ["global_prompt", "style_anchor"],
                },
            )
            from vrh.providers.openai_vlm import _extract_json

            data = _extract_json(raw)
            return {k: str(v) for k, v in data.items() if isinstance(v, (str, int, float))}

        except Exception as exc:  # noqa: BLE001 - global synthesis is optional
            warnings.append(f"global synthesis failed, using local fallback: {exc}")
            log.warning("global merge failed: %s", exc)
            return {}

    @staticmethod
    def _infer_pacing(shots: list[ShotPrompt]) -> str:
        if not shots:
            return ""
        import statistics

        mean_duration = statistics.mean(s.duration_s for s in shots)
        if mean_duration < 1.5:
            return "fast"
        if mean_duration < 4.0:
            return "medium"
        return "slow"

    @staticmethod
    def _fallback_global(shots: list[ShotPrompt]) -> str:
        """Build a summary locally when the LLM is unavailable.

        Deliberately dull rather than creative: a locally assembled summary is
        honest about being derived from slots, and signals to the user that the
        global fields are mechanical.
        """
        if not shots:
            return ""
        subjects = [s.slots.get("subject", "") for s in shots if s.slots.get("subject")]
        styles = [s.slots.get("style", "") for s in shots if s.slots.get("style")]
        subject = subjects[0] if subjects else "a subject"
        style = styles[0] if styles else "cinematic"
        return f"{len(shots)}-shot sequence featuring {subject}. Style: {style}."
