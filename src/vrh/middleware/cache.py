"""Content-addressed cache.

Keyed on `sha256(input) + provider name + model + temperature`, so:

- The same frame reached by two different shots costs one API call, not two.
- Changing the model invalidates automatically -- no stale results.
- Changing temperature invalidates automatically, which matters because a
  non-zero temperature means the result is not a pure function of the input.

This is the primary cost lever. At M-scale (thousands of videos) a hit rate of
30% is worth more than any model substitution.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
from pathlib import Path
from typing import Any

from vrh.contracts.annotation import ShotAnnotation
from vrh.contracts.segment import ShotContext
from vrh.middleware.base import ProviderMiddleware
from vrh.providers.base import LLMProvider, VisionProvider

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cache (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    created_at  REAL NOT NULL,
    provider    TEXT NOT NULL,
    hits        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cache_created ON cache(created_at);
"""


class ResponseCache:
    """SQLite-backed key/value store for provider responses.

    SQLite rather than Redis or a file tree: it is in the standard library, it
    handles concurrent readers, and it keeps the whole cache in one inspectable
    file. At single-machine scale nothing else is justified.
    """

    def __init__(self, path: str | Path, ttl_days: int = 0) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._ttl_s = ttl_days * 86400 if ttl_days > 0 else None
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.executescript(_SCHEMA)
        self._conn.commit()
        self.hits = 0
        self.misses = 0

    @staticmethod
    def make_key(*parts: Any) -> str:
        """Stable key from heterogeneous parts.

        Bytes are hashed directly; everything else goes through canonical JSON
        (sorted keys) so dict ordering cannot change the key.
        """
        h = hashlib.sha256()
        for part in parts:
            h.update(b"\x1f")  # separator so ('ab','c') != ('a','bc')
            if isinstance(part, bytes):
                h.update(part)
            elif isinstance(part, str):
                h.update(part.encode("utf-8"))
            else:
                h.update(json.dumps(part, sort_keys=True, default=str).encode("utf-8"))
        return h.hexdigest()

    def get(self, key: str) -> Any | None:
        row = self._conn.execute(
            "SELECT value, created_at FROM cache WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            self.misses += 1
            return None

        value, created_at = row
        if self._ttl_s is not None and (time.time() - created_at) > self._ttl_s:
            self._conn.execute("DELETE FROM cache WHERE key = ?", (key,))
            self._conn.commit()
            self.misses += 1
            return None

        self._conn.execute("UPDATE cache SET hits = hits + 1 WHERE key = ?", (key,))
        self._conn.commit()
        self.hits += 1
        return json.loads(value)

    def put(self, key: str, value: Any, provider: str = "") -> None:
        self._conn.execute(
            "INSERT OR REPLACE INTO cache (key, value, created_at, provider) "
            "VALUES (?, ?, ?, ?)",
            (key, json.dumps(value, default=str), time.time(), provider),
        )
        self._conn.commit()

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total else 0.0

    def stats(self) -> dict[str, Any]:
        count = self._conn.execute("SELECT COUNT(*) FROM cache").fetchone()[0]
        return {
            "entries": count,
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": round(self.hit_rate, 4),
        }

    def close(self) -> None:
        self._conn.close()


class CacheMiddleware(ProviderMiddleware[VisionProvider]):
    """Caches vision annotations.

    The cache key includes the frame *contents* and the full shot context. Two
    shots with identical pixels but different narrative positions can legitimately
    warrant different annotations, so position is part of the key.
    """

    def __init__(
        self,
        inner: VisionProvider,
        cache: ResponseCache,
        model_id: str = "",
        temperature: float = 0.0,
    ) -> None:
        super().__init__(inner)
        self._cache = cache
        self._model_id = model_id or getattr(inner, "name", "")
        self._temperature = temperature

    async def annotate(
        self,
        frames: list[bytes],
        context: ShotContext,
    ) -> ShotAnnotation:
        key = ResponseCache.make_key(
            "vision",
            self._model_id,
            self._temperature,
            # Hash the frames together so frame count and order both matter.
            *[hashlib.sha256(f).hexdigest() for f in frames],
            context.model_dump(mode="json"),
        )

        cached = self._cache.get(key)
        if cached is not None:
            return ShotAnnotation.model_validate(cached)

        result = await self._inner.annotate(frames, context)  # type: ignore[attr-defined]
        self._cache.put(key, result.model_dump(mode="json"), provider=self._model_id)
        return result


class LLMCacheMiddleware(ProviderMiddleware[LLMProvider]):
    """Caches LLM completions.

    Cache key is the system + user prompt plus the model. Without this, a rerun
    still pays for the global-synthesis call even when every vision annotation
    came from cache -- which makes the "rerun costs nothing" property fail in
    exactly the situation it is most expected to hold.

    Deliberately *not* keyed on temperature: the provider interface does not
    expose it, and any non-zero temperature would make this cache unsound. The
    default configuration runs at temperature 0.
    """

    def __init__(
        self,
        inner: LLMProvider,
        cache: ResponseCache,
        model_id: str = "",
    ) -> None:
        super().__init__(inner)
        self._cache = cache
        self._model_id = model_id or getattr(inner, "name", "")

    async def complete(
        self,
        system: str,
        user: str,
        *,
        json_schema: dict | None = None,
    ) -> str:
        key = ResponseCache.make_key(
            "llm",
            self._model_id,
            system,
            user,
        )

        cached = self._cache.get(key)
        if cached is not None:
            return str(cached)

        result = await self._inner.complete(system, user, json_schema=json_schema)
        self._cache.put(key, result, provider=self._model_id)
        return result
