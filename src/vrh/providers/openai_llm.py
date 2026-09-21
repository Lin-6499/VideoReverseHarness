"""OpenAI-compatible text LLM provider.

Used at L4 for two jobs: merging annotations into a global bundle, and polishing
slot-filled prompt text. Both are constrained by explicit output schemas rather
than free-form instructions.
"""

from __future__ import annotations

import httpx

from vrh.providers.base import RetryableError
from vrh.providers.openai_vlm import _extract_json


class OpenAILLMProvider:
    """Text completion via an OpenAI-compatible chat endpoint."""

    def __init__(
        self,
        model: str,
        api_key: str,
        base_url: str | None = None,
        timeout_s: float = 60.0,
        temperature: float = 0.0,
    ) -> None:
        self.name = f"openai:{model}"
        self._model = model
        self._api_key = api_key
        self._base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
        self._timeout = timeout_s
        self._temperature = temperature

    async def complete(
        self,
        system: str,
        user: str,
        *,
        json_schema: dict | None = None,
    ) -> str:
        payload: dict = {
            "model": self._model,
            "temperature": self._temperature,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        }
        if json_schema is not None:
            payload["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "result", "schema": json_schema, "strict": False},
            }

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            try:
                resp = await client.post(
                    f"{self._base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self._api_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
            except httpx.TransportError as exc:
                raise RetryableError(f"transport failure: {exc}") from exc

        if resp.status_code == 429 or resp.status_code >= 500:
            raise RetryableError(f"HTTP {resp.status_code}: {resp.text[:200]}")
        if resp.status_code >= 400:
            raise RuntimeError(f"llm request failed: HTTP {resp.status_code} {resp.text[:300]}")

        return resp.json()["choices"][0]["message"]["content"]


__all__ = ["OpenAILLMProvider", "_extract_json"]
