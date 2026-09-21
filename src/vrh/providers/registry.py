"""Provider construction from configuration.

This module is the single place that knows which implementation backs which
slot. Adding a model means adding one factory function and one config value --
never touching the pipeline.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from vrh.config import ProviderConfig, Settings
from vrh.providers.base import ASRProvider, LLMProvider, VisionProvider


class ProviderConfigError(RuntimeError):
    """Raised when a provider is requested but cannot be constructed."""


@dataclass
class Providers:
    """The resolved provider set for one run."""

    vision: VisionProvider
    llm: LLMProvider
    asr: ASRProvider | None = None
    embedding: Any | None = None

    def describe(self) -> dict[str, str]:
        return {
            "vision": getattr(self.vision, "name", "?"),
            "llm": getattr(self.llm, "name", "?"),
            "asr": getattr(self.asr, "name", "none") if self.asr else "none",
            "embedding": getattr(self.embedding, "name", "none")
            if self.embedding
            else "none",
        }


def _require_api_key(cfg: ProviderConfig, slot: str) -> str:
    """Resolve the credential, failing loudly when it is missing.

    We look the key up by *name* so credentials never appear in config files.
    """
    if not cfg.api_key_env:
        raise ProviderConfigError(
            f"provider '{cfg.name}' for slot '{slot}' requires api_key_env to be set"
        )
    key = os.environ.get(cfg.api_key_env, "")
    if not key:
        raise ProviderConfigError(
            f"environment variable '{cfg.api_key_env}' is empty but provider "
            f"'{cfg.name}' (slot '{slot}') needs it"
        )
    return key


# --------------------------------------------------------------------------- #
# Factories
# --------------------------------------------------------------------------- #


def _build_vision(cfg: ProviderConfig) -> VisionProvider:
    if cfg.name == "fake":
        from vrh.providers.fake import FakeVisionProvider

        return FakeVisionProvider()

    if cfg.name == "openai_vlm":
        from vrh.providers.openai_vlm import OpenAIVisionProvider

        return OpenAIVisionProvider(
            model=cfg.model or "gpt-4o-mini",
            api_key=_require_api_key(cfg, "vision"),
            base_url=cfg.base_url or None,
            timeout_s=cfg.timeout_s,
            temperature=cfg.temperature,
        )

    if cfg.name == "gemini_vlm":
        from vrh.providers.gemini_vlm import GeminiVisionProvider

        return GeminiVisionProvider(
            model=cfg.model or "gemini-2.5-flash",
            api_key=_require_api_key(cfg, "vision"),
            base_url=cfg.base_url or None,
            timeout_s=cfg.timeout_s,
            temperature=cfg.temperature,
        )

    raise ProviderConfigError(
        "unknown vision provider "
        f"'{cfg.name}'. Available: fake, openai_vlm, gemini_vlm"
    )


def _build_llm(cfg: ProviderConfig) -> LLMProvider:
    if cfg.name == "fake":
        from vrh.providers.fake import FakeLLMProvider

        return FakeLLMProvider()

    if cfg.name == "openai":
        from vrh.providers.openai_llm import OpenAILLMProvider

        return OpenAILLMProvider(
            model=cfg.model or "gpt-4o-mini",
            api_key=_require_api_key(cfg, "llm"),
            base_url=cfg.base_url or None,
            timeout_s=cfg.timeout_s,
            temperature=cfg.temperature,
        )

    raise ProviderConfigError(f"unknown llm provider '{cfg.name}'. Available: fake, openai")


def _build_asr(cfg: ProviderConfig) -> ASRProvider | None:
    if cfg.name in ("", "none"):
        return None
    if cfg.name == "fake":
        from vrh.providers.fake import FakeASRProvider

        return FakeASRProvider()

    raise ProviderConfigError(f"unknown asr provider '{cfg.name}'. Available: fake, none")


def _build_embedding(cfg: ProviderConfig) -> Any | None:
    if cfg.name in ("", "none"):
        return None
    if cfg.name == "fake":
        from vrh.providers.fake import FakeEmbeddingProvider

        return FakeEmbeddingProvider()

    raise ProviderConfigError(
        f"unknown embedding provider '{cfg.name}'. Available: fake, none"
    )


_FACTORIES: dict[str, Callable[[ProviderConfig], Any]] = {
    "vision": _build_vision,
    "llm": _build_llm,
    "asr": _build_asr,
    "embedding": _build_embedding,
}


def build_providers(settings: Settings) -> Providers:
    """Construct the provider set described by `settings`."""
    return Providers(
        vision=_FACTORIES["vision"](settings.providers.vision),
        llm=_FACTORIES["llm"](settings.providers.llm),
        asr=_FACTORIES["asr"](settings.providers.asr),
        embedding=_FACTORIES["embedding"](settings.providers.embedding),
    )
