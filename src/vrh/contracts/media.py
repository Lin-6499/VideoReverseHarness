"""L1 output: technical metadata about the source video.

Deliberately contains *no* semantic judgement. If a field here required
watching the video, it belongs in a later contract.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, computed_field

Orientation = Literal["landscape", "portrait", "square"]


class MediaMeta(BaseModel):
    """Technical description of a source video file.

    Produced by: L1 parse
    Consumed by: L2 segment (framerate/rotation), L4 generate (aspect ratio
    and duration appear verbatim in prompts).
    """

    model_config = {"frozen": True}

    path: str = Field(description="Absolute path to the source file.")
    duration_s: float = Field(gt=0, description="Total duration in seconds.")
    fps: float = Field(gt=0, description="Nominal frames per second.")
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    codec: str = Field(default="unknown", description="Video codec tag, e.g. h264.")
    bitrate_bps: int | None = Field(default=None)
    audio_codec: str | None = Field(
        default=None, description="None means the file has no audio track."
    )
    audio_channels: int | None = Field(default=None)

    # Rotation is the single most common source of silent corruption: a
    # portrait phone video reports 1920x1080 plus rotate=90. Ignoring the tag
    # makes every downstream aspect-ratio field wrong.
    rotation: int = Field(
        default=0,
        description="Rotation metadata in degrees (0/90/180/270). Must be "
        "applied before computing display dimensions.",
    )

    @computed_field  # type: ignore[prop-decorator]
    @property
    def display_width(self) -> int:
        """Width as actually seen by a viewer, after applying rotation."""
        if self.rotation in (90, 270):
            return self.height
        return self.width

    @computed_field  # type: ignore[prop-decorator]
    @property
    def display_height(self) -> int:
        """Height as actually seen by a viewer, after applying rotation."""
        if self.rotation in (90, 270):
            return self.width
        return self.height

    @computed_field  # type: ignore[prop-decorator]
    @property
    def orientation(self) -> Orientation:
        w, h = self.display_width, self.display_height
        if w == h:
            return "square"
        return "portrait" if h > w else "landscape"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def aspect_ratio(self) -> str:
        """Reduced aspect ratio string, e.g. '9:16'.

        Snaps to the nearest common ratio when within 2% tolerance, because
        encoders routinely produce 1080x1918 instead of 1080x1920.
        """
        w, h = self.display_width, self.display_height

        common = [
            (16, 9), (9, 16), (4, 3), (3, 4), (21, 9),
            (1, 1), (2, 1), (1, 2), (3, 2), (2, 3),
        ]
        ratio = w / h
        for cw, ch in common:
            if abs(ratio - cw / ch) / (cw / ch) < 0.02:
                return f"{cw}:{ch}"

        from math import gcd

        g = gcd(w, h)
        return f"{w // g}:{h // g}"

    @computed_field  # type: ignore[prop-decorator]
    @property
    def has_audio(self) -> bool:
        return self.audio_codec is not None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_vfr_risk(self) -> bool:
        """Heuristic flag for variable-framerate sources.

        We can only flag it from the nominal fps here; exact detection happens
        during decode. VFR is the classic cause of cumulative timecode drift,
        so L2 checks this and forces a normalisation pass when set.
        """
        return self.fps > 61 or (self.fps != round(self.fps) and self.fps % 1 != 0)
