from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    app_root: Path = Path(os.getenv("COMIC_APP_ROOT", "/root/comic-inpaint"))
    comfy_root: Path = Path(os.getenv("COMFY_ROOT", "/root/ComfyUI"))
    comfy_url: str = os.getenv("COMFY_URL", "http://127.0.0.1:6006")
    data_root: Path = Path(os.getenv("COMIC_DATA_ROOT", "/root/autodl-tmp/comic-inpaint"))
    max_upload_mb: int = int(os.getenv("COMIC_MAX_UPLOAD_MB", "2048"))
    python_bin: str = os.getenv("COMFY_PYTHON", "/root/comfy-qwen21-venv/bin/python")

    @property
    def tools_root(self) -> Path:
        return self.app_root / "runtime-tools"

    @property
    def workflow_root(self) -> Path:
        return self.comfy_root / "user" / "default" / "workflows"

    @property
    def comfy_input(self) -> Path:
        return self.comfy_root / "input"

    @property
    def comfy_output(self) -> Path:
        return self.comfy_root / "output"

    @property
    def jobs_root(self) -> Path:
        return self.data_root / "jobs"


settings = Settings()
