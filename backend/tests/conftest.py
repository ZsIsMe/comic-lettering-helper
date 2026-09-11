from __future__ import annotations

import os
import sys
from pathlib import Path


BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))
os.environ.setdefault("COMIC_APP_ROOT", str(BACKEND_ROOT.parent))
os.environ.setdefault("COMIC_DATA_ROOT", str(BACKEND_ROOT.parent / "var-test"))
os.environ.setdefault("COMFY_ROOT", str(BACKEND_ROOT.parent / "var-test" / "ComfyUI"))
