"""Middleware base types.

A middleware is a provider that wraps another provider. It must satisfy the same
Protocol as the thing it wraps, so the chain is transparent to callers.
"""

from __future__ import annotations

from typing import Any, Generic, TypeVar

from vrh.providers.base import ProviderError

T = TypeVar("T")


class ProviderMiddleware(Generic[T]):
    """Base class for provider wrappers.

    Subclasses override only the methods they care about and forward the rest via
    `self._inner`. `proxy_method` exists so wrapping is mechanical rather than
    hand-written per method.
    """

    def __init__(self, inner: T) -> None:
        self._inner = inner

    def __getattr__(self, item: str) -> Any:
        # Only reached for attributes this class does not define, which is
        # exactly the forwarding case we want.
        return getattr(self._inner, item)

    @property
    def name(self) -> str:
        inner_name = getattr(self._inner, "name", "unknown")
        return f"{type(self).__name__}({inner_name})"


class BudgetExceededError(ProviderError):
    """Raised when a configured spend cap is hit.

    Non-retryable by design: retrying a budget failure just spends more.
    """


class ComplianceError(ProviderError):
    """Raised when a compliance guard rejects an output outright."""
