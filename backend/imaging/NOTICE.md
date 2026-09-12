# Detection core provenance

Extracted on 2026-09-12 from Solid Inpaint (`comic-text-detector-inpaint`), reference HEAD `a94fd14d7594ea5bf005b1e1ad2d56731f1a8619`. Working files were used; their hashes are recorded below. No Qt, desktop project store, fixed personal paths or detector-vendor runtime is imported.

The bubble geometry/2% inset code credits manga-translator-ui `ballon_fill.py` and `mangalens_detector.py` under GPL-3.0, as stated in the source. The supplied `vendor/LICENSE-BallonsTranslator` is retained verbatim as `LICENSE`. Preserve these notices when redistributing derived code. Model weights have their own upstream terms and are not included.

```json
{
  "detect_solid_inpaint_folder.py": "fbeba94473b51a3555f173f1d9a4a1336ed0dafe9312d079bb8b28adf9584675",
  "bubble_solid.py": "a5897f18469489ed7d74a0829ab602849a940c42fe1991cf0d17a6566948482a",
  "rfdetr_detector.py": "c8916763ffb5821ef353078b4b265b2a3224efee1316de80eada1deb62a5ca97",
  "load_model.py": "2b6771d01b14f0fc8310eca913848291b5a9432a0ecb092f24cf452e12ff062c"
}
```

## Classification synchronization (2026-09-12)

`solid.py` background sampling and solid classification were synchronized with
Solid Inpaint commit `be48a987af9d3dc00034dc5800bd0a9e117b66d0` (`detect_solid_inpaint_folder.py`,
SHA-256 `b180a031cfaf01cc556ac0f033c95af119185b5e83944bf18cb4e0473de0faa6`).
This revision separates interior/exterior text classification, checks exterior
near and extended rings, and makes bubble fill expansion additive while respecting
repair and protected regions. Only the pure image functions are imported; relative
imports remain standalone, with no Qt or desktop project-store dependency.

`backend/tests/test_bubble_classification.py` adapts the pure image regression cases
from the same commit's `tests/test_bubble_solid.py`; desktop persistence and model
loading integration tests are excluded. The original extraction hashes above
remain the provenance for components that were not changed in this synchronization.
