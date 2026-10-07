"""Short-lived, process-local progress for synchronous project creation."""
from __future__ import annotations

import threading
import time

from .projects import ProjectConflict


class UploadProgressRegistry:
    def __init__(self, *, ttl_seconds: float = 3600, capacity: int = 256):
        self.ttl_seconds = ttl_seconds
        self.capacity = capacity
        self._lock = threading.Lock()
        self._entries: dict[str, tuple[float, dict]] = {}

    def _prune(self, now: float) -> None:
        expired = [key for key, (updated, value) in self._entries.items()
                   if value['stage'] in ('completed', 'failed') and now - updated >= self.ttl_seconds]
        for key in expired:
            del self._entries[key]

    def register(self, progress_id: str, total: int) -> None:
        with self._lock:
            now = time.monotonic()
            self._prune(now)
            if progress_id in self._entries:
                raise ProjectConflict('上傳進度 ID 已使用，請重新建立項目')
            if len(self._entries) >= self.capacity:
                finished = sorted((updated, key) for key, (updated, value) in self._entries.items()
                                  if value['stage'] in ('completed', 'failed'))
                if not finished:
                    raise ProjectConflict('同時建立的項目過多，請稍後重試')
                del self._entries[finished[0][1]]
            self._entries[progress_id] = (now, {
                'stage': 'validating', 'completed': 0, 'total': total,
                'filename': None, 'error': None,
            })

    def update(self, progress_id: str, **changes) -> None:
        with self._lock:
            _, value = self._entries[progress_id]
            self._entries[progress_id] = (time.monotonic(), {**value, **changes})

    def read(self, progress_id: str) -> dict:
        with self._lock:
            self._prune(time.monotonic())
            return self._entries[progress_id][1].copy()
