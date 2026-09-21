"""The three provider protocols every stage depends on.

Design rule: providers take *data* and return *contracts*. They never touch
the filesystem, never read config, and never know what stage called them. This
keeps them trivially mockable and keeps caching/retry/cost logic in middleware
where it belongs.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from vrh.contracts.annotation import ShotAnnotation
from vrh.contracts.segment import ShotContext

# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #


class ProviderError(RuntimeError):
    """Base class for all provider failures."""


class RetryableError(ProviderError):
    """A failure that is worth retrying (429s, connection resets, 5xx).

    Middleware keys its retry decision off this type. Anything that is not a
    `RetryableError` is treated as permanent and bubbles straight up.
    """


# Alias kept for readability at call sites.
TransientProviderError = RetryableError


# --------------------------------------------------------------------------- #
# Protocols
# --------------------------------------------------------------------------- #


@runtime_checkable
class VisionProvider(Protocol):
    """Vision-language understanding of a single shot.

    Implementations receive decoded frame bytes plus the shot's temporal
    context, and must return one validated `ShotAnnotation`.
    """

    name: str

    async def annotate(
        self,
        frames: list[bytes],
        context: ShotContext,
    ) -> ShotAnnotation:
        ...


@runtime_checkable
class LLMProvider(Protocol):
    """Text-only reasoning.

    Used for two jobs: merging per-shot annotations into a coherent bundle,
    and polishing slot-filled text into a final prompt.
    """

    name: str

    async def complete(
        self,
        system: str,
        user: str,
        *,
        json_schema: dict | None = None,
    ) -> str:
        ...


@runtime_checkable
class ASRProvider(Protocol):
    """Speech-to-text with word- or segment-level timestamps.

    Timestamps are mandatory: without them we cannot align transcript segments
    to shot boundaries, and the audio fields become useless.
    """

    name: str

    async def transcribe(self, audio_path: str) -> list[TranscriptSegment]:
        ...


class TranscriptSegment(Protocol):
    """Structural type for one transcript span. Kept loose so ASR backends
    can return their own dataclasses as long as the fields line up."""

    start: float
    end: float
    text: str


__all__ = [
    "ASRProvider",
    "LLMProvider",
    "ProviderError",
    "RetryableError",
    "TranscriptSegment",
    "TransientProviderError",
    "VisionProvider",
]
