"""L3: understand each shot.

Calls the vision provider once per shot, with bounded concurrency. Shots are
independent, so fan-out here is safe and gives the single largest wall-clock
improvement in the pipeline.

Audio is merged here rather than in a separate stage because ASR output is
per-video, not per-shot, and aligning it to shot boundaries is naturally part of
assembling a shot's full annotation.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from pydantic import BaseModel, Field

from vrh.contracts.annotation import AudioAnnotation, ShotAnnotation
from vrh.contracts.segment import ShotSet
from vrh.stages.base import Stage, StageContext, StageResult

log = logging.getLogger(__name__)


class AnnotationSet(BaseModel):
    """L3 output. A list wrapper rather than a bare list so the artifact stays
    extensible without breaking readers."""

    video_path: str
    annotations: list[ShotAnnotation] = Field(default_factory=list)
    provider: str = ""

    @property
    def count(self) -> int:
        return len(self.annotations)


class UnderstandStage(Stage[AnnotationSet]):
    name = "understand"
    artifact_name = "annotations.json"
    output_model = AnnotationSet

    # Shots are independent, so this is bounded only by provider rate limits.
    max_concurrency = 4

    async def execute(self, ctx: StageContext) -> tuple[AnnotationSet, StageResult]:
        shot_set = self.read_artifact(ctx, ShotSet, "shots.json")
        warnings: list[str] = []

        if not shot_set.shots:
            raise ValueError("shots.json contains no shots; nothing to annotate")

        semaphore = asyncio.Semaphore(self.max_concurrency)
        transcripts = await self._transcribe(ctx, shot_set, warnings)

        async def annotate_one(shot) -> ShotAnnotation | None:
            frames = self._load_frames(shot)
            if not frames:
                warnings.append(f"shot {shot.shot_id}: no readable keyframes; skipped")
                return None

            context = shot_set.context_for(shot)
            async with semaphore:
                try:
                    annotation = await ctx.providers.vision.annotate(frames, context)
                except Exception as exc:  # noqa: BLE001 - one bad shot must not
                    # fail the whole run; we record it and continue.
                    log.error("shot %d annotation failed: %s", shot.shot_id, exc)
                    warnings.append(f"shot {shot.shot_id}: annotation failed ({exc})")
                    return None

            annotation.audio = self._audio_for(shot, transcripts)
            return annotation

        results = await asyncio.gather(*(annotate_one(s) for s in shot_set.shots))
        annotations = [a for a in results if a is not None]

        if len(annotations) < len(shot_set.shots):
            warnings.append(
                f"{len(shot_set.shots) - len(annotations)} of "
                f"{len(shot_set.shots)} shots could not be annotated"
            )

        log.info("L3: annotated %d/%d shots", len(annotations), len(shot_set.shots))

        return (
            AnnotationSet(
                video_path=shot_set.video_path,
                annotations=annotations,
                provider=getattr(ctx.providers.vision, "name", ""),
            ),
            StageResult(
                artifact=self.artifact_name,
                extra={"annotated": len(annotations), "total_shots": len(shot_set.shots)},
                warnings=warnings,
            ),
        )

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    @staticmethod
    def _load_frames(shot) -> list[bytes]:
        payloads: list[bytes] = []
        for keyframe in shot.keyframes:
            path = Path(keyframe.path)
            if path.exists():
                payloads.append(path.read_bytes())
        return payloads

    async def _transcribe(
        self,
        ctx: StageContext,
        shot_set: ShotSet,
        warnings: list[str],
    ) -> list:
        """Transcribe the audio track, if one was extracted and ASR is configured."""
        if ctx.providers.asr is None:
            return []

        audio_path = ctx.run_dir / "audio.wav"
        if not audio_path.exists():
            return []

        try:
            segments = await ctx.providers.asr.transcribe(str(audio_path))
            log.info("transcribed %d segments", len(segments))
            return segments
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"transcription failed: {exc}")
            log.warning("transcription failed: %s", exc)
            return []

    @staticmethod
    def _audio_for(shot, transcripts: list) -> AudioAnnotation:
        """Collect transcript text overlapping a shot's time span.

        This is why ASR timestamps are mandatory: without them we cannot tell
        which shot a given line of speech belongs to, and the audio fields in the
        final prompt would be wrong rather than merely missing.
        """
        if not transcripts:
            return AudioAnnotation()

        overlapping = [
            seg.text
            for seg in transcripts
            if getattr(seg, "end", 0) > shot.start_s and getattr(seg, "start", 0) < shot.end_s
        ]
        if not overlapping:
            return AudioAnnotation()

        speakers = {getattr(seg, "speaker", None) for seg in transcripts}
        return AudioAnnotation(
            has_speech=True,
            transcript=" ".join(overlapping).strip(),
            speaker_count=len({s for s in speakers if s}),
        )
