"""The quality gate.

`ScoreReport.passed` is a naive threshold check. The gate adds the policy that a
threshold check cannot express: which shots need human attention, whether a
failure is retryable, and what to change on the next attempt.

Separating these means the scoring thresholds can be tuned without touching
retry policy, and vice versa.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from vrh.contracts.score import ScoreReport


@dataclass
class GateDecision:
    """What to do about a score report."""

    passed: bool
    retryable: bool
    feedback: str = ""
    review_shot_ids: list[int] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    @property
    def needs_human_review(self) -> bool:
        return bool(self.review_shot_ids)


class QualityGate:
    """Turns a `ScoreReport` into a `GateDecision`."""

    def __init__(
        self,
        threshold: float = 0.7,
        min_boundary_f1: float = 0.80,
        min_clip_similarity: float = 0.60,
        max_review_fraction: float = 0.25,
    ) -> None:
        self.threshold = threshold
        self.min_boundary_f1 = min_boundary_f1
        self.min_clip_similarity = min_clip_similarity
        # Above this share of flagged shots, the problem is systemic rather than
        # localised, so a targeted fix will not help.
        self.max_review_fraction = max_review_fraction

    def decide(self, report: ScoreReport) -> GateDecision:
        reasons: list[str] = []
        retryable = True

        if not report.schema_valid:
            reasons.append("output failed schema validation")
            # A schema failure means a stage is broken. Repeating it unchanged
            # would produce the same result, so this is not retryable as-is.
            retryable = False

        if report.aggregate < self.threshold:
            reasons.append(
                f"aggregate {report.aggregate:.3f} below threshold {self.threshold:.2f}"
            )

        if report.boundary_f1 is not None and report.boundary_f1 < self.min_boundary_f1:
            reasons.append(
                f"shot boundaries imprecise (F1={report.boundary_f1:.2f}); "
                "a lower cut threshold may help"
            )

        if (
            report.mean_clip_similarity is not None
            and report.mean_clip_similarity < self.min_clip_similarity
        ):
            reasons.append(
                f"prompts weakly matched to imagery "
                f"(CLIP={report.mean_clip_similarity:.2f}); "
                "the vision model may be under-describing the footage"
            )

        review_ids = [s.shot_id for s in report.shot_scores if s.needs_review]
        total = max(1, len(report.shot_scores))
        if len(review_ids) / total > self.max_review_fraction:
            reasons.append(
                f"{len(review_ids)}/{total} shots flagged for review, above the "
                f"{self.max_review_fraction:.0%} systemic threshold"
            )

        passed = not reasons and report.schema_valid

        return GateDecision(
            passed=passed,
            retryable=retryable and not passed,
            feedback=report.diff_summary if not passed else "",
            review_shot_ids=review_ids,
            reasons=reasons,
        )
