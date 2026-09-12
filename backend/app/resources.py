"""One process-wide reservation shared by detection and ComfyUI jobs."""
from threading import Lock


class ResourceGate:
    def __init__(self) -> None:
        self._lock = Lock()
        self._owner: str | None = None
        self._recovering: set[str] = set()

    def retain(self, owner: str) -> None:
        """Retain every surviving process during startup, even after an unsafe prior overlap."""
        with self._lock:
            if self._owner is None:
                self._owner = owner
            elif self._owner != owner:
                self._recovering.add(owner)

    @property
    def owner(self) -> str | None:
        with self._lock:
            return self._owner

    def claim(self, owner: str) -> bool:
        with self._lock:
            if self._owner is not None and self._owner != owner:
                return False
            self._owner = owner
            return True

    def release(self, owner: str) -> None:
        with self._lock:
            if self._owner == owner:
                self._owner = self._recovering.pop() if self._recovering else None
            else:
                self._recovering.discard(owner)
