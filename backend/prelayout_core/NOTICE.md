# Prelayout core provenance

Source: comic-text-detector commit `ffa7b7e2c3ea87c191d2483d736d0e1975179782`. GPL-3.0 text is preserved in `LICENSE`.

The following source-only modules were adapted (no checkpoint, model cache, font, input image or user data is included):

- `new_detect_folder.py`
- `detect_folder.py`
- `inference.py`
- `basemodel.py`
- `measure_ocr.py`
- `utils/yolov5_utils.py`
- `utils/db_utils.py`
- `utils/io_utils.py`
- `utils/imgproc_utils.py`
- `utils/textblock.py`
- `utils/textmask.py`
- `utils/weight_init.py`
- `models/yolov5/yolo.py`
- `models/yolov5/common.py`
- `建立对齐方框/layout_core.py`
- `建立对齐方框/preview_draw.py`
- `建立对齐方框/bubble_pipeline.py`
- `建立对齐方框/bubble_neck_split.py`
- `建立对齐方框/bubble_completion.py`
- `建立对齐方框/preview_split_centers.py`
- `ctd_overlay_processor/analyze_text_core.py`
- `ctd_overlay_processor/font_size_calibration.py`
- `ctd_overlay_processor/mit48px_ocr.py`
- `ctd_overlay_processor/vendor/mit48px_ctc.py`

Imports are scoped under prelayout_core.vendor; legacy executable entry points and path injection are removed. Asset paths are external. Training logging dependencies are omitted. Torch loads use weights_only=True. The worker calls only detection, alignment, measurement and OCR stages, not the legacy inpainting/preview pipeline.

`lp_to_meo.py` and `build_text_rect_update.py` are copied from the same source commit for format and matching compatibility. The vendored mit48 implementation originates from BallonsTranslator and manga-image-translator; upstream notices in the source are retained.

The web adapter adds optional per-page progress callbacks, immutable publication and per-page measure caches. Deprecated NumPy aliases and pkg_resources version comparisons are updated for the observed source runtime. Unused desktop/standalone helper imports are removed. Network/model packages are namespaced to avoid reliance on a top-level models directory. Local synthetic probes verify control flow and geometry; CUDA inference remains a separate target-environment acceptance step.
