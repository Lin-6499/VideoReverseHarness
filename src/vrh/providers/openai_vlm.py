"""OpenAI-compatible vision provider.

Works against any endpoint exposing the `/chat/completions` shape with image
content blocks, which covers OpenAI, Azure OpenAI, and most self-hosted
gateways. Set `base_url` to point elsewhere.
"""

from __future__ import annotations

import base64
import json
import re

import httpx

from vrh.contracts.annotation import (
    ActionAnnotation,
    AudioAnnotation,
    CameraAnnotation,
    ShotAnnotation,
)
from vrh.contracts.segment import ShotContext
from vrh.providers.base import RetryableError

SYSTEM_PROMPT = """\
You annotate a single shot from a video. Return ONLY valid JSON matching the
schema below. Do not add commentary or markdown fences.

{
  "subject": "short generic description, never a real name",
  "subject_count": 1,
  "action": {"label": "snake_case verb phrase", "phase": "start|mid|end|single",
             "confidence": 0.0},
  "scene": "short setting description",
  "environment": "indoor|outdoor|studio|abstract|unknown",
  "time_of_day": "dawn|day|dusk|night|unknown",
  "camera": {"shot_size": "extreme_wide|wide|medium|close|extreme_close|unknown",
             "angle": "eye_level|high|low|dutch|overhead|unknown",
             "motion": "static|pan_left|pan_right|tilt_up|tilt_down|dolly_in|dolly_out|zoom_in|zoom_out|handheld|tracking|unknown",
             "speed": "static|slow|medium|fast"},
  "lighting": "snake_case descriptor",
  "color_palette": ["2-4 short colour descriptors"],
  "composition": "short descriptor",
  "visual_style": "short style descriptor",
  "on_screen_text": ["verbatim text visible in frame"],
  "confidence": 0.0
}

Rules:
- Describe people by appearance and role only. Never infer or state identity.
- Base camera motion on visible evidence; a hint is provided but override it
  when the frames disagree.
- Keep every string under 12 words.
"""


def _extract_json(text: str) -> dict:
    """Pull a JSON object out of a model response.

    Models occasionally wrap output in fences despite instructions, so we strip
    those rather than failing the run.
    """
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", cleaned, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


class OpenAIVisionProvider:
    """Vision understanding via an OpenAI-compatible chat endpoint."""

    def __init__(
        self,
        model: str,
        api_key: str,
        base_url: str | None = None,
        timeout_s: float = 90.0,
        temperature: float = 0.0,
        max_concurrency: int = 4,
    ) -> None:
        self.name = f"openai_vlm:{model}"
        self._model = model
        self._api_key = api_key
        self._base_url = (base_url or "https://api.openai.com/v1").rstrip("/")
        self._timeout = timeout_s
        self._temperature = temperature

    async def annotate(
        self,
        frames: list[bytes],
        context: ShotContext,
    ) -> ShotAnnotation:
        if not frames:
            raise ValueError(f"shot {context.shot_id}: no frames supplied")

        user_content: list[dict] = [
            {
                "type": "text",
                "text": (
                    f"Shot {context.shot_id} of {context.total_shots}. "
                    f"Duration {context.duration_s:.2f}s. "
                    f"Optical-flow motion hint: {context.motion_hint}. "
                    "Annotate this shot."
                ),
            }
        ]
        for i, frame in enumerate(frames):
            b64 = base64.b64encode(frame).decode("ascii")
            user_content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                }
            )
            # Label frames so the model can reason about ordering.
            user_content[-1]["image_url"]["detail"] = "low" if i else "auto"

        payload = {
            "model": self._model,
            "temperature": self._temperature,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_content},
            ],
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
            raise RuntimeError(f"vision request failed: HTTP {resp.status_code} {resp.text[:300]}")

        body = resp.json()
        content = body["choices"][0]["message"]["content"]
        return self._to_annotation(_extract_json(content), context)

    @staticmethod
    def _to_annotation(data: dict, context: ShotContext) -> ShotAnnotation:
        action_raw = data.get("action") or {}
        camera_raw = data.get("camera") or {}

        return ShotAnnotation(
            shot_id=context.shot_id,
            subject=str(data.get("subject", ""))[:200],
            subject_count=max(0, int(data.get("subject_count", 1) or 0)),
            action=ActionAnnotation(
                label=str(action_raw.get("label", "")),
                phase=str(action_raw.get("phase", "mid")),
                confidence=float(action_raw.get("confidence", 0.0) or 0.0),
            ),
            scene=str(data.get("scene", ""))[:200],
            environment=str(data.get("environment", "unknown")),
            time_of_day=str(data.get("time_of_day", "unknown")),
            weather=str(data.get("weather", "")),
            camera=CameraAnnotation(
                shot_size=str(camera_raw.get("shot_size", "unknown")),
                angle=str(camera_raw.get("angle", "eye_level")),
                motion=str(camera_raw.get("motion", context.motion_hint)),
                speed=str(camera_raw.get("speed", "static")),
            ),
            lighting=str(data.get("lighting", "")),
            color_palette=[str(c) for c in (data.get("color_palette") or [])][:4],
            composition=str(data.get("composition", "")),
            visual_style=str(data.get("visual_style", "")),
            on_screen_text=[str(t) for t in (data.get("on_screen_text") or [])][:8],
            audio=AudioAnnotation(),  # audio is merged in separately at L3
            confidence=float(data.get("confidence", 0.0) or 0.0),
            provider="openai_vlm",
        )
