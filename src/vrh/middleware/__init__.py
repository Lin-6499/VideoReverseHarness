"""Cross-cutting concerns, composed as wrappers around providers.

The chain is built outside-in:

    RateLimit(CostTrack(Cache(Retry(Redact(RawProvider)))))

Each layer sees only its own concern. Adding an audit log means inserting one
more wrapper; it never means editing a stage. This is the single most valuable
structural decision in the harness -- it keeps retry, caching and cost logic out
of the code that actually understands video.
"""

from vrh.middleware.base import ProviderMiddleware
from vrh.middleware.cache import CacheMiddleware, LLMCacheMiddleware
from vrh.middleware.compliance import ComplianceMiddleware
from vrh.middleware.cost import CostTracker, CostTrackingLLM, CostTrackingVision
from vrh.middleware.retry import RetryMiddleware

__all__ = [
    "CacheMiddleware",
    "ComplianceMiddleware",
    "CostTracker",
    "CostTrackingLLM",
    "CostTrackingVision",
    "LLMCacheMiddleware",
    "ProviderMiddleware",
    "RetryMiddleware",
]
