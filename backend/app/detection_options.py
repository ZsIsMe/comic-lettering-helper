"""User-adjustable detection settings shared by project creation and inference."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class DetectionOptions(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    mask_dilate: int = Field(ge=0, le=64)
    mask_mode: Literal['text_onomatopoeia', 'text', 'onomatopoeia', 'all']
    bubble_enabled: bool
    bubble_shrink_percent: float = Field(ge=0, le=10)
