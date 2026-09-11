# Project rules

- This repository packages the three validated production workflows: FireRed FP8, Qwen Image Edit 2511 + LanPaint, and Flux2 Klein FP8 + LanPaint.
- Do not change prompts, samplers, steps, CFG, LoRA settings, crop/stitch geometry, or other tuned workflow parameters without an explicit request and a new GPU regression test.
- Public users upload a source folder and a standalone black-and-white Mask folder. Qwen RGBA construction stays internal to `runtime-tools/run_independent_edit_models_batch.py`.
- Run GPU work serially. Never use a true multi-image tensor batch for these workflows on the 32 GB target.
- Pair files by basename stem, not directory order. Ignore `._*`; reject duplicates and mismatches before GPU work.
- Use real files under `ComfyUI/input` for FireRed flattened inputs. ComfyUI 0.34 rejects image symlinks there.
- Entirely black Masks are passthroughs and must not invoke a model or create a PDF page.
- The user-facing service runs on port 6008. Native ComfyUI remains available through AutoDL WebUI-6006; the backend calls it locally at `127.0.0.1:6006`.
- Never place AutoDL developer tokens, SSH credentials, API keys, user uploads, generated outputs, or runtime logs in the published image or repository.
- Before saving an AutoDL image, run `deploy/prepublish-clean.sh` in dry-run mode, inspect its exact paths, then use `--apply` only on the intended build instance.
