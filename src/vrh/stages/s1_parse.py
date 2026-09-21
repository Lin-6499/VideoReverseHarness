"""L1: parse the source video.

Purely mechanical. Reads container/stream metadata and extracts the audio track.
No semantic judgement happens here -- if a field would require watching the
video, it belongs in a later stage.
"""

from __future__ import annotations

import logging

from vrh.contracts.media import MediaMeta
from vrh.media import extract_audio, probe
from vrh.stages.base import Stage, StageContext, StageResult

log = logging.getLogger(__name__)


class ParseStage(Stage[MediaMeta]):
    name = "parse"
    artifact_name = "meta.json"
    output_model = MediaMeta

    async def execute(self, ctx: StageContext) -> tuple[MediaMeta, StageResult]:
        meta = probe(ctx.job.video_path)

        warnings: list[str] = []
        extra: dict[str, object] = {
            "duration_s": meta.duration_s,
            "shot_count_estimate": None,
        }

        if ctx.job.options.segment.target_fps and meta.fps > ctx.job.options.segment.target_fps * 1.5:
            warnings.append(
                f"source is {meta.fps:.2f}fps, above the "
                f"{ctx.job.options.segment.target_fps:.0f}fps normalisation target; "
                "frames will be resampled and timing may drift slightly"
            )

        if meta.is_vfr_risk:
            warnings.append(
                f"framerate {meta.fps:.3f} suggests a variable-framerate source; "
                "timecodes may not align exactly with playback"
            )

        if meta.rotation:
            log.info(
                "rotation metadata %d deg applied (display %dx%d)",
                meta.rotation,
                meta.display_width,
                meta.display_height,
            )
            extra["rotation"] = meta.rotation

        # Audio extraction is best-effort: a missing or unreadable audio track
        # should degrade the result, not fail the run.
        if ctx.job.options.include_audio and meta.has_audio:
            audio_path = ctx.run_dir / "audio.wav"
            try:
                extract_audio(ctx.job.video_path, audio_path)
                extra["audio_path"] = str(audio_path)
                log.info("extracted audio -> %s", audio_path)
            except Exception as exc:  # noqa: BLE001 - deliberately broad
                warnings.append(f"audio extraction failed: {exc}")
                log.warning("audio extraction failed: %s", exc)
        elif ctx.job.options.include_audio and not meta.has_audio:
            warnings.append("source has no audio track; audio fields will be empty")

        # A rough shot-count estimate from duration alone. Gives the user a cost
        # signal before the expensive stage runs.
        avg_shot = 3.0
        extra["shot_count_estimate"] = max(1, int(meta.duration_s / avg_shot))

        return meta, StageResult(
            artifact=self.artifact_name,
            extra=extra,
            warnings=warnings,
        )
