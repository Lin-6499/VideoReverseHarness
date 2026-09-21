"""L3 output: what a vision model observed in each shot.

Structured, not prose. `ShotAnnotation` is the meeting point between the
observation-heavy vision model and the language-heavy LLM: the vision model
fills these slots, the LLM never sees the pixels. Keeping this structured is
what allows field-level scoring at L5 instead of vague "looks right" judgement.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ActionAnnotation(BaseModel):
    """A single action label with a temporal span.

    `phase` disambiguates the same label appearing at different points of a
    motion: "walking_toward_camera" reads differently as `start` vs `end`.
    """

    label: str = Field(
        default="",
        description="snake_case action label, e.g. 'walking_toward_camera'. "
        "Empty when the action could not be determined.",
    )
    phase: str = Field(
        default="mid",
        description="start | mid | end | single. Optional refinement.",
    )
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class CameraAnnotation(BaseModel):
    """How the camera behaves, as inferred from frames plus the L2 hint.

    `shot_size` uses the standard five-step scale so downstream prompt templates
    can map it to model-specific vocabulary without guessing.
    """

    shot_size: str = Field(
        default="unknown",
        description="extreme_wide | wide | medium | close | extreme_close | unknown",
    )
    angle: str = Field(
        default="eye_level",
        description="eye_level | high | low | dutch | overhead | unknown",
    )
    motion: str = Field(
        default="static",
        description="Camera move in snake_case. The vision model may override "
        "L2's optical-flow guess when the visual evidence disagrees.",
    )
    speed: str = Field(default="static", description="static | slow | medium | fast")


class AudioAnnotation(BaseModel):
    """Anything audible during the shot."""

    has_speech: bool = False
    transcript: str = Field(default="", description="Verbatim speech in this shot.")
    speaker_count: int = Field(default=0, ge=0)
    music: str = Field(default="none", description="none | present | dominant")
    music_mood: str = Field(default="", description="e.g. 'tense', 'uplifting'.")
    sfx: list[str] = Field(
        default_factory=list, description="Notable non-speech sounds."
    )


class ShotAnnotation(BaseModel):
    """Everything observed about one shot.

    Produced by: L3 understand (one VisionProvider call per shot).
    Consumed by: L4 generate.

    `observed_*` lists are capped by the provider prompt; unbounded lists are a
    common source of prompt bloat and unpredictable cost.
    """

    shot_id: int = Field(ge=1)

    subject: str = Field(
        default="",
        description="Primary subject described generically. Real names are "
        "stripped by the compliance guard -- see vrh.compliance.",
    )
    subject_count: int = Field(default=1, ge=0)

    action: ActionAnnotation = Field(default_factory=ActionAnnotation)
    secondary_actions: list[ActionAnnotation] = Field(default_factory=list)

    scene: str = Field(default="", description="Short setting description.")
    environment: str = Field(
        default="", description="indoor | outdoor | studio | abstract | unknown"
    )
    time_of_day: str = Field(default="unknown", description="dawn | day | dusk | night | unknown")
    weather: str = Field(default="", description="Empty when not applicable.")

    camera: CameraAnnotation = Field(default_factory=CameraAnnotation)
    lighting: str = Field(default="", description="e.g. 'low_key_warm'.")
    color_palette: list[str] = Field(
        default_factory=list, description="2-4 dominant colour descriptors."
    )
    composition: str = Field(default="", description="e.g. 'rule_of_thirds'.")
    visual_style: str = Field(
        default="", description="e.g. '35mm film grain, documentary'."
    )

    on_screen_text: list[str] = Field(
        default_factory=list,
        description="OCR result. Also passed through the compliance guard.",
    )
    audio: AudioAnnotation = Field(default_factory=AudioAnnotation)

    confidence: float = Field(
        default=0.0,
        ge=0.0,
        le=1.0,
        description="Provider's self-reported confidence. Drives human-review "
        "flagging at L5.",
    )
    provider: str = Field(default="", description="Which provider produced this.")
