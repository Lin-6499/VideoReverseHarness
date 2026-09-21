"""Compliance guard re-export.

The implementation lives in `vrh.middleware.compliance` because it is chain-based
like the other cross-cutting concerns. This module exists so callers can import
it from the domain-appropriate namespace.
"""

from vrh.middleware.compliance import ComplianceGuard, ComplianceMiddleware

__all__ = ["ComplianceGuard", "ComplianceMiddleware"]
