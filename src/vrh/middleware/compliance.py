"""Compliance guard.

Runs on annotations *before* they reach prompt generation, so identifying
content cannot leak into a deliverable prompt.

The guard is a redaction layer, not a refusal layer. Blocking the run because a
frame contains a face would make the tool useless for its main use case
(real-world footage). Genericising the description preserves utility while
removing the identifying information.
"""

from __future__ import annotations

import re

from vrh.config import ComplianceConfig
from vrh.contracts.annotation import ShotAnnotation
from vrh.contracts.segment import ShotContext
from vrh.middleware.base import ProviderMiddleware
from vrh.providers.base import VisionProvider

# Patterns that indicate an identity claim rather than an appearance description.
# The goal is to catch "this is <name>" style output, not to censor the word
# "man" or "woman" -- those are legitimate generic descriptors.
_IDENTITY_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b(?:is|looks like)\s+[A-Z][a-z]+\s+[A-Z][a-z]+\b"), " a person"),
    (re.compile(r"\bMr\.?\s+[A-Z][a-z]+\b"), " a man"),
    (re.compile(r"\bMs\.?|Mrs\.?\s+[A-Z][a-z]+\b"), " a woman"),
    (re.compile(r"\b[A-Z][a-z]+\s+(?:Smith|Johnson|Williams|Brown|Jones|Miller)\b"), " a person"),
    (re.compile(r"\b(?:age|aged)\s+\d{1,3}\b"), " "),
    (re.compile(r"\b(?:Asian|Caucasian|Black|Hispanic|Latino)\s+(?:man|woman|person)\b"), " a person"),
]

# Words that should never survive into a prompt because they imply identity or
# are otherwise unsafe to propagate.
_BLOCKED_TERMS = re.compile(
    r"\b(?:passport|id\s*card|licence\s*number|license\s*number|ssn|social\s+security)\b",
    re.IGNORECASE,
)


class ComplianceGuard:
    """Redacts identifying content from annotations."""

    def __init__(self, cfg: ComplianceConfig) -> None:
        self._cfg = cfg
        self.redactions = 0

    def scrub(self, annotation: ShotAnnotation) -> ShotAnnotation:
        """Return a redacted copy. The input is not mutated.

        Returns a copy so the original annotation stays available for debugging
        and for the audit trail.
        """
        if not self._cfg.enabled:
            return annotation

        data = annotation.model_dump()

        if self._cfg.redact_faces:
            for field in ("subject", "scene", "composition"):
                if isinstance(data.get(field), str):
                    data[field] = self._redact(data[field])

        if self._cfg.block_identifying_text:
            data["on_screen_text"] = [
                self._redact(t)
                for t in data.get("on_screen_text", [])
                if not _BLOCKED_TERMS.search(t)
            ]
            if isinstance(data.get("action", {}).get("label"), str):
                data["action"]["label"] = _BLOCKED_TERMS.sub("", data["action"]["label"])

        for term in self._cfg.custom_blocklist:
            if not term:
                continue
            pattern = re.compile(re.escape(term), re.IGNORECASE)
            for field in ("subject", "scene", "composition"):
                if isinstance(data.get(field), str):
                    data[field] = pattern.sub("", data[field])

        return ShotAnnotation.model_validate(data)

    def _redact(self, text: str) -> str:
        original = text
        for pattern, replacement in _IDENTITY_PATTERNS:
            text = pattern.sub(replacement, text)
        text = _BLOCKED_TERMS.sub("", text)
        if text != original:
            self.redactions += 1
        # Collapse whitespace left behind by removals.
        return re.sub(r"\s{2,}", " ", text).strip()

    def summary(self) -> dict[str, int]:
        return {"redactions": self.redactions}


class ComplianceMiddleware(ProviderMiddleware[VisionProvider]):
    """Applies the guard to every annotation leaving the provider chain."""

    def __init__(self, inner: VisionProvider, guard: ComplianceGuard) -> None:
        super().__init__(inner)
        self._guard = guard

    async def annotate(
        self,
        frames: list[bytes],
        context: ShotContext,
    ) -> ShotAnnotation:
        result = await self._inner.annotate(frames, context)  # type: ignore[attr-defined]
        return self._guard.scrub(result)
