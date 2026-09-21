"""Deterministic providers requiring no network access.

These are not throwaway stubs. They are the reference implementation of the
provider contract and they matter for three reasons:

1. The pipeline is testable end-to-end in CI with no credentials and no cost.
2. They make the *shape* of the data explicit -- a new real provider is written
   by matching this output, not by reading prose documentation.
3. They give a stable baseline: when a real provider scores worse than `fake`
   on the fixture set, something is genuinely wrong.

Output is deterministic given the same input, so they are safe to use in
regression tests.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from vrh.contracts.annotation import (
    ActionAnnotation,
    AudioAnnotation,
    CameraAnnotation,
    ShotAnnotation,
)
from vrh.contracts.segment import ShotContext

# Motion words the fake provider rotates through, so fixture output exercises
# more than one code path in the preset mapper.
_MOTIONS = ["static", "dolly_in", "pan_left", "handheld", "tilt_up"]
_SHOT_SIZES = ["wide", "medium", "close"]
_LIGHTING = ["high_key_neutral", "low_key_warm", "golden_hour", "overcast_soft"]
_STYLES = [
    "35mm film grain, documentary",
    "clean digital, commercial",
    "moody cinematic, shallow depth of field",
]
_SCENES = [
    "a quiet city street at dusk",
    "an open field under overcast sky",
    "an interior studio with soft lighting",
]


def _stable_index(seed: str, modulus: int) -> int:
    """Deterministic index from a string. Avoids Python's salted hash()."""
    digest = hashlib.sha256(seed.encode()).digest()
    return int.from_bytes(digest[:4], "big") % modulus


@dataclass
class _FakeTranscriptSegment:
    start: float
    end: float
    text: str


class FakeVisionProvider:
    """Produces plausible annotations without looking at the pixels."""

    name = "fake"

    def __init__(self, **_kwargs: object) -> None:
        pass

    async def annotate(
        self,
        frames: list[bytes],
        context: ShotContext,
    ) -> ShotAnnotation:
        seed = f"{context.shot_id}:{context.start_s:.2f}:{len(frames)}"

        motion = context.motion_hint
        if motion in ("unknown", "", None):
            motion = _MOTIONS[_stable_index(seed, len(_MOTIONS))]

        # Confidence is deliberately spread across the range so quality-gate and
        # review-flagging logic gets exercised by the fixture run.
        confidence = 0.55 + (_stable_index(seed + "conf", 45) / 100)

        return ShotAnnotation(
            shot_id=context.shot_id,
            subject="a person in a dark jacket",
            subject_count=1,
            action=ActionAnnotation(
                label="walking_forward",
                phase="mid",
                confidence=confidence,
            ),
            scene=_SCENES[_stable_index(seed + "scene", len(_SCENES))],
            environment="outdoor",
            time_of_day="dusk",
            camera=CameraAnnotation(
                shot_size=_SHOT_SIZES[_stable_index(seed + "size", len(_SHOT_SIZES))],
                angle="eye_level",
                motion=motion,
                speed="slow" if motion != "static" else "static",
            ),
            lighting=_LIGHTING[_stable_index(seed + "light", len(_LIGHTING))],
            color_palette=["desaturated blue", "warm amber"],
            composition="rule_of_thirds",
            visual_style=_STYLES[_stable_index(seed + "style", len(_STYLES))],
            audio=AudioAnnotation(music="present", music_mood="ambient"),
            confidence=round(confidence, 3),
            provider=self.name,
        )


class FakeLLMProvider:
    """Echoes a structured, deterministic answer.

    Recognises the two call shapes the pipeline actually uses (merge and polish)
    by inspecting the system prompt, so real prompts can be swapped in without
    changing the pipeline.
    """

    name = "fake"

    def __init__(self, **_kwargs: object) -> None:
        pass

    async def complete(
        self,
        system: str,
        user: str,
        *,
        json_schema: dict | None = None,
    ) -> str:
        if json_schema is not None or "json" in system.lower():
            return self._merge_json(user)
        return self._polish_text(user)

    @staticmethod
    def _merge_json(user: str) -> str:
        import json
        import re

        shots = re.findall(r'"shot_id":\s*(\d+)', user)
        styles = re.findall(r'"visual_style":\s*"([^"]*)"', user)
        dominant_style = styles[0] if styles else "cinematic"

        return json.dumps(
            {
                "global_prompt": (
                    f"A {len(shots) or 1}-shot sequence, {dominant_style}. "
                    "Consistent subject and lighting across cuts."
                ),
                "style_anchor": dominant_style,
                "genre": "documentary",
                "pacing": "slow" if len(shots) <= 3 else "medium",
            }
        )

    @staticmethod
    def _polish_text(user: str) -> str:
        # The pipeline passes slot text as the user message; return it trimmed
        # and de-duplicated so the round-trip is observable.
        seen: list[str] = []
        for part in (p.strip() for p in user.split(",")):
            if part and part not in seen:
                seen.append(part)
        return ", ".join(seen)


class FakeASRProvider:
    """Returns a short deterministic transcript."""

    name = "fake"

    def __init__(self, **_kwargs: object) -> None:
        pass

    async def transcribe(self, audio_path: str) -> list[_FakeTranscriptSegment]:
        return [
            _FakeTranscriptSegment(0.0, 2.0, "This is a placeholder transcript."),
            _FakeTranscriptSegment(2.0, 4.0, "Replace the ASR provider to use real audio."),
        ]


class FakeEmbeddingProvider:
    """Hashes text/image bytes into a fixed-width unit vector.

    Not semantically meaningful, but stable enough to exercise the scoring path
    and to prove the plumbing works before a real CLIP backend is wired in.
    """

    name = "fake"
    dim = 64

    def __init__(self, **_kwargs: object) -> None:
        pass

    async def embed_text(self, text: str) -> list[float]:
        return self._vector(text.encode())

    async def embed_image(self, image_bytes: bytes) -> list[float]:
        return self._vector(image_bytes)

    def _vector(self, payload: bytes) -> list[float]:
        import math

        raw = hashlib.sha512(payload).digest()
        vals = [(b - 127.5) / 127.5 for b in raw[: self.dim]]
        norm = math.sqrt(sum(v * v for v in vals)) or 1.0
        return [v / norm for v in vals]
