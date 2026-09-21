"""Provider abstractions.

Every external dependency (vision model, LLM, ASR, media tooling) is reached
through a Protocol defined here. Swapping a model means adding one file to
`vrh.providers` and changing a config value -- nothing else.

`FakeProvider` implementations live alongside the real ones so that the whole
pipeline can run end-to-end with zero network access.
"""

from vrh.providers.base import (
    ASRProvider,
    LLMProvider,
    ProviderError,
    RetryableError,
    TransientProviderError,
    VisionProvider,
)
from vrh.providers.fake import FakeASRProvider, FakeLLMProvider, FakeVisionProvider
from vrh.providers.registry import build_providers

__all__ = [
    "ASRProvider",
    "FakeASRProvider",
    "FakeLLMProvider",
    "FakeVisionProvider",
    "LLMProvider",
    "ProviderError",
    "RetryableError",
    "TransientProviderError",
    "VisionProvider",
    "build_providers",
]
