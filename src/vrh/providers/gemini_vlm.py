"""Google Gemini vision provider.

Why a separate implementation rather than reusing `openai_vlm`:

Gemini's REST shape is *not* OpenAI-compatible. The differences that matter:

  - images go in `inline_data` parts with `mime_type` + base64 `data`,
    not `image_url` blocks
  - the API key travels in the `x-goog-api-key` header, not `Authorization: Bearer`
  - one endpoint per model: POST /v1beta/models/{model}:generateContent
  - the reply nests at `candidates[0].content.parts[*].text`
  - JSON mode is requested via `generationConfig.responseMimeType`, and the
    schema is *not* enforced the way OpenAI enforces `json_schema`

Everything above the transport -- the annotation contract, the system prompt,
the JSON extraction and the retry semantics -- is shared with the OpenAI
provider, so the two stay behaviourally comparable for A/B work.
"""

from __future__ import annotations

import base64

import httpx

from vrh.contracts.annotation import ShotAnnotation
from vrh.contracts.segment import ShotContext
from vrh.providers.base import RetryableError
from vrh.providers.openai_vlm import SYSTEM_PROMPT, _extract_json

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"


class GeminiVisionProvider:
    """Vision understanding via the Gemini `generateContent` endpoint."""

    def __init__(
        self,
        model: str,
        api_key: str,
        base_url: str | None = None,
        timeout_s: float = 90.0,
        temperature: float = 0.0,
    ) -> None:
        self.name = f"gemini:{model}"
        self._model = model
        self._api_key = api_key
        # Trailing slash would produce `//v1beta`, which the API rejects.
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self._timeout = timeout_s
        self._temperature = temperature

    async def annotate(
        self,
        frames: list[bytes],
        context: ShotContext,
    ) -> ShotAnnotation:
        if not frames:
            raise ValueError(f"shot {context.shot_id}: no frames supplied")

        # Text first, then images in temporal order. Gemini treats a text part
        # before media as instruction and everything after as evidence, which is
        # exactly the framing we want.
        parts: list[dict] = [
            {
                "text": (
                    f"Shot {context.shot_id} of {context.total_shots}. "
                    f"Duration {context.duration_s:.2f}s. "
                    f"Optical-flow motion hint: {context.motion_hint}. "
                    "Annotate this shot."
                )
            }
        ]
        for frame in frames:
            parts.append(
                {
                    "inline_data": {
                        "mime_type": "image/jpeg",
                        "data": base64.b64encode(frame).decode("ascii"),
                    }
                }
            )

        payload = {
            "system_instruction": {"parts": [{"text": SYSTEM_PROMPT}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "temperature": self._temperature,
                "responseMimeType": "application/json",
            },
        }

        url = f"{self._base_url}/v1beta/models/{self._model}:generateContent"

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            try:
                resp = await client.post(
                    url,
                    headers={
                        "x-goog-api-key": self._api_key,
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
            except httpx.TransportError as exc:
                raise RetryableError(f"transport failure: {exc}") from exc

        if resp.status_code == 429 or resp.status_code >= 500:
            raise RetryableError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        if resp.status_code >= 400:
            raise RuntimeError(
                f"vision request failed: HTTP {resp.status_code} {resp.text[:300]}"
            )

        return self._to_annotation(_extract_json(_first_text(resp.json())), context)

    @staticmethod
    def _to_annotation(data: dict, context: ShotContext) -> ShotAnnotation:
        # Field mapping is identical to the OpenAI path on purpose: both must
        # produce the same ShotAnnotation so downstream stages cannot tell them
        # apart. Kept as a delegate rather than a copy so the two cannot drift.
        from vrh.providers.openai_vlm import OpenAIVisionProvider

        annotation = OpenAIVisionProvider._to_annotation(data, context)
        # Only the provenance label differs -- that is what shows up in
        # annotations.json and is how we confirm which backend actually ran.
        annotation.provider = "gemini_vlm"
        return annotation


def _first_text(body: dict) -> str:
    """Pull the text of the first candidate part out of a Gemini response.

    Failures here are worth distinct messages: a safety block returns HTTP 200
    with no `parts` at all, and reporting that as "no content" would send you
    looking for a parsing bug instead of a content filter.
    """
    candidates = body.get("candidates") or []
    if not candidates:
        feedback = body.get("promptFeedback") or {}
        reason = feedback.get("blockReason")
        if reason:
            raise RuntimeError(f"Gemini blocked the prompt (blockReason={reason})")
        raise RuntimeError(f"Gemini returned no candidates: {str(body)[:300]}")

    parts = (candidates[0].get("content") or {}).get("parts") or []
    chunks = [p.get("text", "") for p in parts if isinstance(p, dict)]
    text = "".join(chunks).strip()
    if not text:
        finish = candidates[0].get("finishReason", "unspecified")
        raise RuntimeError(
            f"Gemini returned an empty candidate (finishReason={finish})"
        )
    return text
