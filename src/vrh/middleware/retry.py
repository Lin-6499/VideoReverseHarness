"""Retry middleware.

Only retries errors explicitly typed as retryable. This matters: a blanket
`except Exception: retry` turns a misconfiguration into an hour of wasted API
spend, and turns a permanent 400 into a retry storm.
"""

from __future__ import annotations

import asyncio
import logging
import random

from vrh.contracts.annotation import ShotAnnotation
from vrh.contracts.segment import ShotContext
from vrh.middleware.base import ProviderMiddleware
from vrh.providers.base import RetryableError, VisionProvider

log = logging.getLogger(__name__)


class RetryMiddleware(ProviderMiddleware[VisionProvider]):
    """Retries retryable failures with exponential backoff and jitter."""

    def __init__(
        self,
        inner: VisionProvider,
        max_retries: int = 3,
        base_delay_s: float = 1.0,
        max_delay_s: float = 30.0,
    ) -> None:
        super().__init__(inner)
        self._max_retries = max_retries
        self._base_delay = base_delay_s
        self._max_delay = max_delay_s
        self.retry_count = 0

    async def annotate(
        self,
        frames: list[bytes],
        context: ShotContext,
    ) -> ShotAnnotation:
        attempt = 0
        while True:
            try:
                return await self._inner.annotate(frames, context)  # type: ignore[attr-defined]
            except RetryableError as exc:
                attempt += 1
                if attempt > self._max_retries:
                    log.warning(
                        "shot %s: giving up after %d attempts: %s",
                        context.shot_id,
                        attempt,
                        exc,
                    )
                    raise

                self.retry_count += 1
                delay = min(self._base_delay * (2 ** (attempt - 1)), self._max_delay)
                # Jitter prevents synchronised retry storms across concurrent shots.
                delay *= 0.5 + random.random()
                log.info(
                    "shot %s: retryable failure (attempt %d/%d), sleeping %.1fs",
                    context.shot_id,
                    attempt,
                    self._max_retries,
                    delay,
                )
                await asyncio.sleep(delay)
