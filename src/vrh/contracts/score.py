"""L5 output: the quality gate's verdict.

Kept separate from the prompt contracts on purpose. If evaluation data leaked
into `PromptBundle`, downstream stages could (accidentally or otherwise) optimise
against the scorer instead of against reality.

Every score is decomposed by layer so a regression is *attributable*: a drop in
`boundary_f1` implicates L2, a drop in `field_accuracy` implicates L3.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, computed_field


class ShotScore(BaseModel):
    """Per-shot evaluation detail."""

    shot_id: int = Field(ge=1)
    clip_similarity: float | None = Field(
        default=None,
        ge=-1.0,
        le=1.0,
        description="Cosine similarity between the shot's prompt embedding and its "
        "keyframe embedding. None when no embedding backend is configured.",
    )
    boundary_iou: float | None = Field(
        default=None, ge=0.0, le=1.0, description="IoU against the reference cut."
    )
    field_accuracy: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Fraction of structured fields matching the reference "
        "annotation, when a reference exists.",
    )
    needs_review: bool = Field(
        default=False,
        description="Flagged for human review -- low confidence or low score.",
    )
    issues: list[str] = Field(default_factory=list)


class ScoreReport(BaseModel):
    """Aggregate quality verdict for one run.

    The `passed` flag drives the optional rollback in the pipeline. `diff_summary`
    is fed back into the retry so the second attempt is informed rather than
    merely repeated.
    """

    run_id: str
    video_path: str

    shot_scores: list[ShotScore] = Field(default_factory=list)

    boundary_f1: float | None = Field(default=None, ge=0.0, le=1.0)
    mean_clip_similarity: float | None = Field(default=None, ge=-1.0, le=1.0)
    mean_field_accuracy: float | None = Field(default=None, ge=0.0, le=1.0)

    schema_valid: bool = Field(
        default=True, description="Whether every produced artifact parsed cleanly."
    )
    cost_usd: float = Field(default=0.0, ge=0.0)
    latency_s: float = Field(default=0.0, ge=0.0)
    cache_hit_rate: float = Field(default=0.0, ge=0.0, le=1.0)

    # Records the gate target in force for this run. Intentionally unbounded
    # above 1.0: a value >1 is a legal way to declare "never satisfied" (a caller
    # may want to force the retry loop to exhaust), and this report only mirrors
    # the configured value. The *configuration* side (job.RunOptions) still
    # enforces [0,1] for ordinary use.
    threshold: float = Field(default=0.7, ge=0.0)
    round_index: int = Field(default=0, ge=0)
    warnings: list[str] = Field(default_factory=list)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def aggregate(self) -> float:
        """Single comparable number, weighted toward semantic fidelity.

        Weights are explicit rather than tuned, because an opaque score is worse
        than a crude one: you cannot debug what you cannot explain.
        """
        parts: list[tuple[float, float]] = []
        if self.mean_clip_similarity is not None:
            # Map cosine [-1,1] onto [0,1] before weighting.
            parts.append(((self.mean_clip_similarity + 1) / 2, 0.5))
        if self.boundary_f1 is not None:
            parts.append((self.boundary_f1, 0.2))
        if self.mean_field_accuracy is not None:
            parts.append((self.mean_field_accuracy, 0.3))
        if not parts:
            return 0.0
        total_w = sum(w for _, w in parts)
        return sum(v * w for v, w in parts) / total_w

    @computed_field  # type: ignore[prop-decorator]
    @property
    def passed(self) -> bool:
        return self.schema_valid and self.aggregate >= self.threshold

    @computed_field  # type: ignore[prop-decorator]
    @property
    def review_count(self) -> int:
        return sum(1 for s in self.shot_scores if s.needs_review)

    @property
    def diff_summary(self) -> str:
        """Human/model readable description of what went wrong.

        Fed back into the retry round. Empty when the run passed.
        """
        if self.passed:
            return ""
        problems: list[str] = []
        if not self.schema_valid:
            problems.append("output failed schema validation")
        if self.boundary_f1 is not None and self.boundary_f1 < 0.8:
            problems.append(
                f"shot boundaries imprecise (F1={self.boundary_f1:.2f}); "
                "consider a lower cut-detection threshold"
            )
        if self.mean_clip_similarity is not None and self.mean_clip_similarity < 0.6:
            problems.append(
                f"prompts weakly matched to imagery (CLIP={self.mean_clip_similarity:.2f})"
            )
        if self.mean_field_accuracy is not None and self.mean_field_accuracy < 0.8:
            problems.append(
                f"structured fields inaccurate ({self.mean_field_accuracy:.2f})"
            )
        if self.review_count:
            problems.append(f"{self.review_count} shots flagged for review")
        return "; ".join(problems) if problems else "aggregate score below threshold"
