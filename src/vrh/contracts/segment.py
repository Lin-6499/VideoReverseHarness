"""L2 output: how the video is divided into shots, and which frames represent
each shot.

The important field here is `Shot.motion` -- the optical-flow derived motion
descriptor. Hard-cut detection alone only tells you *that* the picture changed;
motion analysis tells you *how the camera moved*, which is what the `camera`
slot in the final prompt actually needs. Most naive implementations skip this
and then cannot populate the camera field at all.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

CutType = Literal["hard", "soft", "start", "end"]
Framing = Literal["wide", "medium", "close", "extreme_close", "unknown"]


class Keyframe(BaseModel):
    """One extracted frame, addressed by content hash.

    `sha256` is the cache key. Two shots that share a frame share one file on
    disk and one API call. This is the single largest cost lever in the system.
    """

    frame_index: int = Field(ge=0, description="Ordinal within the shot.")
    timestamp_s: float = Field(ge=0, description="Presentation time in seconds.")
    path: str = Field(description="Absolute path to the extracted JPEG.")
    sha256: str = Field(min_length=16, description="Content hash of the frame pixels.")
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class MotionDescriptor(BaseModel):
    """Camera and subject motion for one shot, derived from optical flow.

    `dominant` is the classified camera move; `confidence` records how clear the
    flow field was. Low-confidence moves should be surfaced for human review
    rather than silently reported as fact.
    """

    dominant: Literal[
        "static",
        "pan_left",
        "pan_right",
        "tilt_up",
        "tilt_down",
        "dolly_in",
        "dolly_out",
        "zoom_in",
        "zoom_out",
        "handheld",
        "tracking",
        "unknown",
    ] = "unknown"

    magnitude: float = Field(
        default=0.0,
        ge=0.0,
        description="Mean flow magnitude in pixels/frame, normalised by frame width.",
    )
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    consistency: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="How uniform the flow field is. High values indicate a global "
        "camera move; low values indicate independent subject motion.",
    )


class Shot(BaseModel):
    """One continuous take between two cut points."""

    shot_id: int = Field(ge=1, description="1-based ordinal within the video.")
    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)
    cut_type: CutType = Field(
        default="hard",
        description="How this shot began. 'start' marks the first shot, 'end' is "
        "reserved for a synthetic tail marker.",
    )
    keyframes: list[Keyframe] = Field(default_factory=list)
    motion: MotionDescriptor = Field(default_factory=MotionDescriptor)
    framing: Framing = Field(
        default="unknown",
        description="Rough shot size. Heuristic at L2; refined by L3 if needed.",
    )

    @model_validator(mode="after")
    def _check_ordering(self) -> Shot:
        if self.end_s <= self.start_s:
            raise ValueError(
                f"shot {self.shot_id}: end_s ({self.end_s}) must exceed "
                f"start_s ({self.start_s})"
            )
        return self

    @property
    def duration_s(self) -> float:
        return self.end_s - self.start_s

    @property
    def keyframe_paths(self) -> list[str]:
        return [k.path for k in self.keyframes]


class ShotContext(BaseModel):
    """Everything a vision provider needs to know about a shot's position.

    Passed to `VisionProvider.annotate`. Included in the cache key, which is why
    neighbouring shot ids are part of it -- the same frame in a different
    narrative position can legitimately warrant a different annotation.
    """

    shot_id: int
    start_s: float
    end_s: float
    duration_s: float
    prev_shot_id: int | None = Field(
        default=None, description="None when this is the first shot."
    )
    next_shot_id: int | None = Field(
        default=None, description="None when this is the last shot."
    )
    total_shots: int = Field(ge=1)
    motion_hint: str = Field(
        default="unknown",
        description="L2's motion guess, offered to the vision model as a hint it "
        "may override.",
    )


class ShotSet(BaseModel):
    """L2's complete output for one video."""

    video_path: str
    shots: list[Shot] = Field(default_factory=list)
    strategy: str = Field(
        default="adaptive",
        description="Which keyframe strategy produced this set: "
        "fixed | triple | adaptive.",
    )
    normalised_fps: float | None = Field(
        default=None,
        description="Set when L2 resampled a VFR/odd-framerate source.",
    )
    warnings: list[str] = Field(
        default_factory=list,
        description="Non-fatal issues (e.g. 'single shot detected, cut "
        "detection may have failed'). Surfaced in the report.",
    )

    @property
    def shot_count(self) -> int:
        return len(self.shots)

    @property
    def total_duration_s(self) -> float:
        return sum(s.duration_s for s in self.shots)

    def context_for(self, shot: Shot) -> ShotContext:
        """Build the `ShotContext` for one shot, resolving neighbours."""
        i = shot.shot_id - 1
        prev_id = self.shots[i - 1].shot_id if i > 0 else None
        next_id = self.shots[i + 1].shot_id if i + 1 < len(self.shots) else None
        return ShotContext(
            shot_id=shot.shot_id,
            start_s=shot.start_s,
            end_s=shot.end_s,
            duration_s=shot.duration_s,
            prev_shot_id=prev_id,
            next_shot_id=next_id,
            total_shots=len(self.shots),
            motion_hint=shot.motion.dominant,
        )
