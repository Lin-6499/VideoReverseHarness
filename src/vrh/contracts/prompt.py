"""L4 output: the actual deliverable.

`PromptBundle` is what a user consumes. It carries three granularities because
downstream tools need different things: per-shot prompts for I2V reproduction,
a global prompt for T2V style alignment, and a reusable style anchor that can be
prepended to unrelated prompts.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ShotPrompt(BaseModel):
    """One shot's reproduction prompt.

    `prompt` is slot-filled then LLM-polished. `slots` retains the structured
    form so the prompt can be regenerated for a different target model without
    re-running the expensive vision stage.
    """

    shot_id: int = Field(ge=1)
    start_s: float = Field(ge=0)
    end_s: float = Field(gt=0)

    prompt: str = Field(min_length=1)
    negative_prompt: str = Field(default="")
    slots: dict[str, str] = Field(
        default_factory=dict,
        description="Structured form: subject/action/scene/camera/lighting/style.",
    )

    duration_s: float = Field(default=0.0, gt=0)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)

    @property
    def timecode(self) -> str:
        return f"{self.start_s:.2f}-{self.end_s:.2f}s"


class PromptBundle(BaseModel):
    """L4's complete output for one video."""

    video_path: str
    target_model: str = Field(
        default="generic",
        description="Which preset produced this bundle, e.g. 't2v_generic'.",
    )

    global_prompt: str = Field(
        default="",
        description="Whole-video style and content summary for T2V use.",
    )
    style_anchor: str = Field(
        default="",
        description="Reusable style prefix. Portable across unrelated videos.",
    )
    genre: str = Field(default="")
    pacing: str = Field(
        default="", description="slow | medium | fast, derived from shot durations."
    )

    shots: list[ShotPrompt] = Field(default_factory=list)

    aspect_ratio: str = Field(default="")
    total_duration_s: float = Field(default=0.0, ge=0)

    warnings: list[str] = Field(default_factory=list)

    @property
    def shot_count(self) -> int:
        return len(self.shots)

    def to_flat_text(self) -> str:
        """Render as a single copy-pasteable block.

        Convenience for the common case where a user just wants text to drop
        into a generation UI.
        """
        lines = [f"# {self.global_prompt}", "", f"style: {self.style_anchor}", ""]
        for s in self.shots:
            lines.append(f"[{s.timecode}] {s.prompt}")
        return "\n".join(lines)
