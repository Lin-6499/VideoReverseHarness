"""L2: split the video into shots and extract representative frames.

This stage is the accuracy bottleneck of the whole harness. Two design points
matter more than anything else here:

1. **Cut detection and motion analysis are separate passes.** Detecting *that*
   the picture changed is cheap; determining *how the camera moved* is what makes
   the camera prompt field possible.

2. **Keyframes are content-addressed.** Every extracted frame is stored under its
   SHA-256. Two shots containing the same frame share one file and one API call.

The stage degrades gracefully: if PySceneDetect is unavailable it falls back to
uniform segmentation, and reports that in `warnings` rather than pretending the
result is a real cut detection.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from vrh.contracts.media import MediaMeta
from vrh.contracts.segment import Keyframe, Shot, ShotContext, ShotSet
from vrh.media import extract_frame
from vrh.media.motion import MotionAnalyzer
from vrh.stages.base import Stage, StageContext, StageResult

log = logging.getLogger(__name__)

try:
    from scenedetect import ContentDetector, SceneManager, open_video

    _SCENEDETECT_AVAILABLE = True
except ImportError:  # pragma: no cover
    _SCENEDETECT_AVAILABLE = False


class SegmentStage(Stage[ShotSet]):
    name = "segment"
    artifact_name = "shots.json"
    output_model = ShotSet

    async def execute(self, ctx: StageContext) -> tuple[ShotSet, StageResult]:
        meta = self.read_artifact(ctx, MediaMeta, "meta.json")

        warnings: list[str] = []
        boundaries, cut_warnings = self._detect_cuts(ctx, meta)
        warnings.extend(cut_warnings)

        boundaries = self._enforce_limits(boundaries, ctx, meta, warnings)

        shots = self._build_shots(boundaries, ctx, meta)

        if ctx.job.options.segment.detect_motion:
            analyzer = MotionAnalyzer()
            for shot in shots:
                paths = [Path(k.path) for k in shot.keyframes]
                shot.motion = analyzer.analyse(paths)
        else:
            warnings.append(
                "motion detection disabled; the camera field in final prompts "
                "will be unreliable"
            )

        shot_set = ShotSet(
            video_path=meta.path,
            shots=shots,
            strategy=ctx.job.options.keyframes.strategy,
            normalised_fps=None,
            warnings=warnings,
        )

        if len(shots) == 1 and meta.duration_s > 30:
            warnings.append(
                "only one shot detected across a long video; cut detection may "
                "have failed -- try lowering segment.cut_threshold"
            )

        total_frames = sum(len(s.keyframes) for s in shots)
        log.info(
            "L2: %d shots, %d keyframes (strategy=%s)",
            len(shots),
            total_frames,
            ctx.job.options.keyframes.strategy,
        )

        return shot_set, StageResult(
            artifact=self.artifact_name,
            extra={"shot_count": len(shots), "keyframe_count": total_frames},
            warnings=warnings,
        )

    # ------------------------------------------------------------------ #
    # Cut detection
    # ------------------------------------------------------------------ #

    def _detect_cuts(
        self, ctx: StageContext, meta: MediaMeta
    ) -> tuple[list[float], list[str]]:
        """Return shot start times in seconds."""
        warnings: list[str] = []
        duration = meta.duration_s

        if not _SCENEDETECT_AVAILABLE:
            warnings.append(
                "PySceneDetect not installed; using uniform segmentation. "
                "Install with: pip install 'vrh[media]'"
            )
            return self._uniform_boundaries(duration, target=3.0), warnings

        threshold = ctx.job.options.segment.cut_threshold

        # On a retry, nudge the threshold in the direction the feedback implies.
        # A failed round reporting "boundaries imprecise" most often means the
        # detector merged visually similar shots, so we lower the threshold.
        if ctx.feedback and "boundar" in ctx.feedback.lower():
            threshold = max(8.0, threshold * 0.75)
            warnings.append(
                f"retry round: lowered cut threshold to {threshold:.1f} based on "
                "previous round's feedback"
            )

        try:
            video = open_video(str(meta.path))
            manager = SceneManager()
            manager.add_detector(
                ContentDetector(
                    threshold=threshold,
                    min_scene_len=max(
                        1,
                        int(ctx.job.options.segment.min_shot_duration_s * meta.fps),
                    ),
                )
            )
            manager.detect_scenes(video, show_progress=False)
            scene_list = manager.get_scene_list()

            if not scene_list:
                warnings.append(
                    f"no cuts detected at threshold {threshold:.1f}; "
                    "treating the video as a single shot"
                )
                return [0.0], warnings

            # `seconds` is the supported accessor; `get_seconds()` is deprecated
            # in PySceneDetect >=0.6.4 and slated for removal.
            boundaries = [scene[0].seconds for scene in scene_list]
            if boundaries and boundaries[0] > 0.5:
                boundaries.insert(0, 0.0)
            return boundaries, warnings

        except Exception as exc:  # noqa: BLE001 - fall back rather than fail
            warnings.append(f"cut detection failed ({exc}); using uniform segmentation")
            return self._uniform_boundaries(duration, target=3.0), warnings

    @staticmethod
    def _uniform_boundaries(duration: float, target: float) -> list[float]:
        """Fallback: evenly spaced boundaries every `target` seconds."""
        count = max(1, int(duration / target))
        return [i * (duration / count) for i in range(count)]

    def _enforce_limits(
        self,
        boundaries: list[float],
        ctx: StageContext,
        meta: MediaMeta,
        warnings: list[str],
    ) -> list[float]:
        """Cap shot count against the configured budget."""
        max_shots = ctx.job.options.max_shots
        if len(boundaries) > max_shots:
            warnings.append(
                f"{len(boundaries)} shots exceeded max_shots={max_shots}; "
                "shots were merged. Raise options.max_shots to capture detail."
            )
            step = len(boundaries) / max_shots
            boundaries = [boundaries[int(i * step)] for i in range(max_shots)]
        return boundaries

    # ------------------------------------------------------------------ #
    # Frame extraction
    # ------------------------------------------------------------------ #

    def _build_shots(
        self,
        boundaries: list[float],
        ctx: StageContext,
        meta: MediaMeta,
    ) -> list[Shot]:
        duration = meta.duration_s
        shots: list[Shot] = []

        for idx, start in enumerate(boundaries):
            end = boundaries[idx + 1] if idx + 1 < len(boundaries) else duration
            if end - start < ctx.job.options.segment.min_shot_duration_s and idx > 0:
                # Absorb a sliver into the previous shot rather than emitting it.
                shots[-1].end_s = end
                continue

            keyframes = self._extract_keyframes(start, end, ctx, meta, idx + 1)
            if not keyframes:
                continue

            shots.append(
                Shot(
                    shot_id=len(shots) + 1,
                    start_s=round(start, 3),
                    end_s=round(end, 3),
                    cut_type="start" if idx == 0 else "hard",
                    keyframes=keyframes,
                )
            )

        return shots

    def _extract_keyframes(
        self,
        start: float,
        end: float,
        ctx: StageContext,
        meta: MediaMeta,
        shot_id: int,
    ) -> list[Keyframe]:
        """Extract and content-address the frames representing one shot."""
        timestamps = self._pick_timestamps(start, end, ctx)
        keyframes: list[Keyframe] = []

        for i, ts in enumerate(timestamps):
            # The filename embeds a content-neutral placeholder first; we rename
            # after hashing so the on-disk name *is* the content hash.
            scratch = ctx.frame_dir / f"shot{shot_id:04d}_{i:02d}.jpg"
            try:
                extract_frame(meta.path, ts, scratch)
            except Exception as exc:  # noqa: BLE001
                log.warning("shot %d: frame extraction at %.2fs failed: %s", shot_id, ts, exc)
                continue

            digest = hashlib.sha256(scratch.read_bytes()).hexdigest()
            final = ctx.keyframe_dir / f"{digest[:16]}.jpg"

            if final.exists():
                # Already on disk from another shot: drop the duplicate. This is
                # the deduplication that keeps API spend down.
                scratch.unlink(missing_ok=True)
            else:
                final.parent.mkdir(parents=True, exist_ok=True)
                scratch.replace(final)

            keyframes.append(
                Keyframe(
                    frame_index=i,
                    timestamp_s=round(ts, 3),
                    path=str(final),
                    sha256=digest,
                    width=meta.display_width,
                    height=meta.display_height,
                )
            )

        return keyframes

    def _pick_timestamps(self, start: float, end: float, ctx: StageContext) -> list[float]:
        """Choose which timestamps to sample within a shot.

        Three strategies, in increasing cost and fidelity:

        - `fixed`:   every N seconds. Cheapest; misses mid-shot changes.
        - `triple`:  start, middle, end. Small, and captures the arc of a shot.
        - `adaptive`: opens with the triple, then adds frames while optical flow
          shows meaningful change. Best value per unit cost -- the default.
        """
        opts = ctx.job.options.keyframes
        duration = end - start
        max_frames = opts.max_per_shot

        # Guard against sampling the exact final frame, which some decoders
        # cannot return.
        usable_end = end - min(0.05, duration * 0.02)

        if opts.strategy == "fixed":
            count = max(1, min(max_frames, int(duration / opts.fixed_interval_s) + 1))
            if count == 1:
                return [start + duration / 2]
            step = duration / count
            return [start + step * i for i in range(count)]

        # triple and adaptive share the same base sampling.
        candidates = [
            start + duration * 0.05,
            start + duration * 0.5,
            start + duration * 0.9,
        ]

        if opts.strategy == "adaptive" and duration > 0.8:
            # Add extra sample points that the motion analyser will use to decide
            # whether the shot contains internal change worth describing.
            extra_count = min(max_frames - 3, int(duration / 0.4))
            for i in range(1, extra_count + 1):
                candidates.append(start + duration * (i / (extra_count + 1)))

        if len(candidates) > max_frames:
            # Keep the first and last, thin the middle.
            step = len(candidates) / max_frames
            candidates = [candidates[int(i * step)] for i in range(max_frames)]

        return sorted({round(min(t, usable_end), 3) for t in candidates})


def build_context(shot_set: ShotSet, shot: Shot) -> ShotContext:
    """Public helper: build a `ShotContext` for one shot in a set."""
    return shot_set.context_for(shot)
