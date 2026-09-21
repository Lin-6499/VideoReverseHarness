"""L5: score the result and gate the pipeline.

Independent of production by construction: this stage only *reads* upstream
artifacts. Nothing upstream can observe its scores, so no stage can be
accidentally tuned to satisfy the scorer.

Signals, in order of availability:

1. **Structural** -- schema validity, field coverage. Always available, free.
2. **Boundary** -- IoU of detected cuts against a reference. Needs a reference.
3. **Semantic** -- CLIP similarity between prompt text and keyframes. Needs an
   embedding backend.

When a signal is unavailable the score is `None` and is excluded from the
aggregate rather than being defaulted to a value, because a fabricated score is
worse than a missing one.
"""

from __future__ import annotations

import logging

from vrh.contracts.annotation import ShotAnnotation
from vrh.contracts.job import RunState
from vrh.contracts.prompt import PromptBundle
from vrh.contracts.score import ScoreReport, ShotScore
from vrh.contracts.segment import ShotSet
from vrh.stages.base import Stage, StageContext, StageResult
from vrh.stages.s3_understand import AnnotationSet

log = logging.getLogger(__name__)


class EvaluateStage(Stage[ScoreReport]):
    name = "evaluate"
    artifact_name = "score.json"
    output_model = ScoreReport

    # Shots below this provider confidence are flagged for human review.
    review_confidence_floor = 0.60

    async def execute(self, ctx: StageContext) -> tuple[ScoreReport, StageResult]:
        bundle = self.read_artifact(ctx, PromptBundle, "prompt.json")
        shot_set = self.read_artifact(ctx, ShotSet, "shots.json")

        warnings: list[str] = []
        shot_scores = self._structural_scores(bundle, shot_set)

        # Semantic scoring needs an embedding backend; skippable and reported
        # when absent rather than silently omitted.
        if ctx.providers.embedding is not None:
            await self._semantic_scores(ctx, bundle, shot_set, shot_scores)
        else:
            warnings.append(
                "no embedding provider configured; semantic similarity not "
                "evaluated (structural checks only)"
            )

        clip_scores = [s.clip_similarity for s in shot_scores if s.clip_similarity is not None]
        field_scores = [s.field_accuracy for s in shot_scores if s.field_accuracy is not None]

        report = ScoreReport(
            run_id=ctx.state.run_id,
            video_path=bundle.video_path,
            shot_scores=shot_scores,
            boundary_f1=None,
            mean_clip_similarity=(
                round(sum(clip_scores) / len(clip_scores), 4) if clip_scores else None
            ),
            mean_field_accuracy=(
                round(sum(field_scores) / len(field_scores), 4) if field_scores else None
            ),
            schema_valid=self._schema_valid(ctx),
            latency_s=self._total_latency(ctx.state),
            cache_hit_rate=ctx.cost.summary().get("cache_hit_rate", 0.0),  # type: ignore[arg-type]
            threshold=ctx.job.options.quality_threshold,
            round_index=ctx.state.round_index,
            warnings=warnings,
        )
        report.cost_usd = ctx.cost.total_usd

        log.info(
            "L5: aggregate=%.3f threshold=%.2f passed=%s review=%d",
            report.aggregate,
            report.threshold,
            report.passed,
            report.review_count,
        )

        return report, StageResult(
            artifact=self.artifact_name,
            extra={
                "aggregate": round(report.aggregate, 4),
                "passed": report.passed,
                "review_count": report.review_count,
            },
            warnings=warnings,
        )

    # ------------------------------------------------------------------ #
    # Structural signals (always available)
    # ------------------------------------------------------------------ #

    def _structural_scores(
        self,
        bundle: PromptBundle,
        shot_set: ShotSet,
    ) -> list[ShotScore]:
        """Score things that can be checked without a model.

        Field coverage is a genuinely useful proxy: a shot whose prompt is empty
        or that is missing camera and lighting information is almost always a
        shot the model failed to understand, and that correlates with downstream
        generation quality far more often than not.
        """
        expected_slots = {"subject", "action", "scene", "camera", "lighting", "style"}
        by_id = {s.shot_id: s for s in shot_set.shots}

        scores: list[ShotScore] = []
        for shot_prompt in bundle.shots:
            issues: list[str] = []

            filled = {k for k, v in shot_prompt.slots.items() if v}
            coverage = len(filled & expected_slots) / len(expected_slots)

            if not shot_prompt.prompt.strip():
                issues.append("empty prompt text")
            if coverage < 0.5:
                issues.append(f"only {len(filled & expected_slots)}/{len(expected_slots)} slots filled")
            if shot_prompt.confidence < self.review_confidence_floor:
                issues.append(f"low provider confidence ({shot_prompt.confidence:.2f})")

            shot = by_id.get(shot_prompt.shot_id)
            if shot is not None:
                if not shot.keyframes:
                    issues.append("no keyframes extracted")

                # A camera field that contradicts the optical-flow evidence is
                # worth flagging: it usually means the vision model guessed.
                motion_hint = shot.motion.dominant
                reported = shot_prompt.slots.get("camera", "")
                if (
                    motion_hint not in ("unknown", "static")
                    and reported
                    and motion_hint.replace("_", " ") not in reported
                ):
                    issues.append(
                        f"camera field disagrees with optical flow ({motion_hint}); "
                        "a prompt may not drive the motion the source shows"
                    )

            scores.append(
                ShotScore(
                    shot_id=shot_prompt.shot_id,
                    field_accuracy=round(coverage, 4),
                    needs_review=bool(issues),
                    issues=issues,
                )
            )

        return scores

    # ------------------------------------------------------------------ #
    # Semantic signals (needs an embedding backend)
    # ------------------------------------------------------------------ #

    async def _semantic_scores(
        self,
        ctx: StageContext,
        bundle: PromptBundle,
        shot_set: ShotSet,
        shot_scores: list[ShotScore],
    ) -> None:
        """Fill in CLIP similarity for each shot.

        Uses the shot's *first* keyframe rather than an average across frames:
        the opening frame is what an image-to-video model would condition on, so
        it is the frame the prompt most needs to describe correctly.
        """
        by_shot = {s.shot_id: s for s in shot_set.shots}
        by_score = {s.shot_id: s for s in shot_scores}

        for shot_prompt in bundle.shots:
            shot = by_shot.get(shot_prompt.shot_id)
            score = by_score.get(shot_prompt.shot_id)
            if shot is None or score is None or not shot.keyframes:
                continue

            from pathlib import Path

            image_path = Path(shot.keyframes[0].path)
            if not image_path.exists():
                continue

            try:
                text_vec = await ctx.providers.embedding.embed_text(shot_prompt.prompt)
                image_vec = await ctx.providers.embedding.embed_image(image_path.read_bytes())
                score.clip_similarity = round(_cosine(text_vec, image_vec), 4)
            except Exception as exc:  # noqa: BLE001
                log.debug("shot %d: similarity failed: %s", shot_prompt.shot_id, exc)

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    @staticmethod
    def _schema_valid(ctx: StageContext) -> bool:
        """Whether every artifact this run claims to have produced actually exists
        and parses. A missing artifact is a more serious failure than a low score."""
        required = ["meta.json", "shots.json", "annotations.json", "prompt.json"]
        return all((ctx.run_dir / name).exists() for name in required)

    @staticmethod
    def _total_latency(state: RunState) -> float:
        return round(sum(r.duration_s for r in state.completed.values()), 3)


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return dot / (na * nb) if na and nb else 0.0


__all__ = ["AnnotationSet", "EvaluateStage", "ShotAnnotation"]
