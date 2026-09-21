"""Cost accounting and budget enforcement.

A non-zero `max_usd_per_video` aborts the run rather than logging a warning and
continuing. Silent overspend is worse than a failed run: it is discovered at the
end of the month, not at the point of the mistake.

Prices come from config because per-token rates change constantly and hardcoding
them guarantees staleness.
"""

from __future__ import annotations

import logging

from vrh.config import CostConfig
from vrh.contracts.annotation import ShotAnnotation
from vrh.contracts.segment import ShotContext
from vrh.middleware.base import BudgetExceededError, ProviderMiddleware
from vrh.providers.base import LLMProvider, VisionProvider

log = logging.getLogger(__name__)


class CostTracker:
    """Accumulates estimated spend across a run.

    Shared by reference across all middleware wrappers in one run, so a single
    instance observes every call.
    """

    def __init__(self, cfg: CostConfig) -> None:
        self._cfg = cfg
        self.vision_calls = 0
        self.vision_frames = 0
        self.llm_calls = 0
        self.input_tokens = 0
        self.output_tokens = 0

    def charge_vision(self, frame_count: int) -> None:
        self.vision_calls += 1
        self.vision_frames += frame_count
        self._check_budget()

    def charge_llm(self, input_tokens: int, output_tokens: int) -> None:
        self.llm_calls += 1
        self.input_tokens += input_tokens
        self.output_tokens += output_tokens
        self._check_budget()

    @property
    def total_usd(self) -> float:
        if not self._cfg.track:
            return 0.0
        vision = self.vision_frames * self._cfg.price_per_image
        text = (self.input_tokens / 1000) * self._cfg.price_per_1k_input_tokens + (
            self.output_tokens / 1000
        ) * self._cfg.price_per_1k_output_tokens
        return round(vision + text, 6)

    def _check_budget(self) -> None:
        cap = self._cfg.max_usd_per_video
        if cap > 0 and self.total_usd > cap:
            raise BudgetExceededError(
                f"spend cap exceeded: ${self.total_usd:.4f} > ${cap:.4f} "
                f"(vision calls={self.vision_calls}, llm calls={self.llm_calls})"
            )

    def summary(self) -> dict[str, float | int]:
        return {
            "vision_calls": self.vision_calls,
            "vision_frames": self.vision_frames,
            "llm_calls": self.llm_calls,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_usd": self.total_usd,
        }

    def log_summary(self) -> None:
        s = self.summary()
        log.info(
            "cost: $%.4f | vision %d calls / %d frames | llm %d calls",
            s["total_usd"],
            s["vision_calls"],
            s["vision_frames"],
            s["llm_calls"],
        )


class CostTrackingVision(ProviderMiddleware[VisionProvider]):
    """Charges the tracker after each successful vision call."""

    def __init__(self, inner: VisionProvider, tracker: CostTracker) -> None:
        super().__init__(inner)
        self._tracker = tracker

    async def annotate(
        self,
        frames: list[bytes],
        context: ShotContext,
    ) -> ShotAnnotation:
        result = await self._inner.annotate(frames, context)  # type: ignore[attr-defined]
        self._tracker.charge_vision(len(frames))
        return result


class CostTrackingLLM(ProviderMiddleware[LLMProvider]):
    """Charges the tracker after each LLM call.

    Token counts are approximated from character length when the provider does
    not report usage. Rough, but sufficient for budget enforcement -- the cap
    exists to stop runaway spend, not to produce an invoice.
    """

    def __init__(self, inner: LLMProvider, tracker: CostTracker) -> None:
        super().__init__(inner)
        self._tracker = tracker

    async def complete(
        self,
        system: str,
        user: str,
        *,
        json_schema: dict | None = None,
    ) -> str:
        result = await self._inner.complete(system, user, json_schema=json_schema)
        # ~4 characters per token is a reasonable English approximation.
        self._tracker.charge_llm(
            input_tokens=len(system + user) // 4,
            output_tokens=len(result) // 4,
        )
        return result
