#!/usr/bin/env python3
"""Run the fixed Qwen Image 2.1 INT8 manga inpaint workflow."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import statistics
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

from PIL import Image


MODEL_FILES = {
    "UNETLoader": ("unet_name", "qwen_image_2.1_int8_convrot.safetensors"),
    "CLIPLoader": ("clip_name", "qwen3vl_8b_int8_convrot.safetensors"),
    "VAELoader": ("vae_name", "qwen_image_2.1_vae_bf16.safetensors"),
}
REQUIRED_NODES = {
    "LoadImage",
    "ImageToMask",
    "ThresholdMask",
    "GrowMaskWithBlur",
    "GrowMask",
    "MaskToImage",
    "UNETLoader",
    "CLIPLoader",
    "VAELoader",
    "QwenImage21Cache",
    "TextEncodeQwenImage21",
    "KSampler",
    "VAEDecode",
    "SplitImageWithAlpha",
    "GetImageSize",
    "ImageScale",
    "ImageCompositeMasked",
    "SaveImage",
}
SOURCE_SUFFIXES = {".jpg", ".jpeg", ".png"}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def request_json(url: str, payload: dict | None = None, timeout: float = 60) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def _index_images(directory: Path, suffixes: set[str], label: str) -> dict[str, Path]:
    indexed: dict[str, Path] = {}
    if not directory.is_dir():
        return indexed
    for path in sorted(directory.iterdir()):
        if (
            not path.is_file()
            or path.name.startswith("._")
            or path.suffix.lower() not in suffixes
        ):
            continue
        if path.stem in indexed:
            raise ValueError(f"duplicate {label} stem: {path.stem}")
        indexed[path.stem] = path
    return indexed


def paired_inputs(input_dir: Path, input_root: str) -> list[tuple[str, Path, Path]]:
    root = (input_dir / input_root).resolve()
    if not root.is_relative_to(input_dir.resolve()):
        raise ValueError("--input-root must stay inside ComfyUI/input")
    image_dir = root / "pair"
    mask_dir = root / "pair_mask"
    images = _index_images(image_dir, SOURCE_SUFFIXES, "source")
    masks = _index_images(mask_dir, {".png"}, "Mask")
    missing_masks = sorted(set(images) - set(masks))
    missing_sources = sorted(set(masks) - set(images))
    if missing_masks or missing_sources:
        raise ValueError(
            "source/Mask stem mismatch: "
            f"missing_masks={missing_masks}, missing_sources={missing_sources}"
        )
    if not images:
        raise ValueError(f"no source/Mask pairs under {root}")

    result = []
    for stem in sorted(images):
        source_path = images[stem]
        mask_path = masks[stem]
        with Image.open(source_path) as source, Image.open(mask_path) as mask:
            if source.size != mask.size:
                raise ValueError(
                    f"{stem}: source/Mask size mismatch: source={source.size}, mask={mask.size}"
                )
            source.convert("RGB").load()
            mask.convert("L").load()
        result.append((stem, source_path, mask_path))
    return result


def mask_has_edit_pixels(mask_path: Path) -> bool:
    with Image.open(mask_path) as mask:
        binary = mask.convert("L").point(lambda value: 255 if value >= 128 else 0)
        return binary.getbbox() is not None


def prepare_inputs(
    input_dir: Path, input_root: str, batch: list[tuple[str, Path, Path]]
) -> dict[str, tuple[str, str]]:
    prepared_root = input_dir / input_root / "_qwen21_prepared"
    source_dir = prepared_root / "pair"
    mask_dir = prepared_root / "pair_mask"
    source_dir.mkdir(parents=True, exist_ok=True)
    mask_dir.mkdir(parents=True, exist_ok=True)
    result = {}
    for stem, source_path, mask_path in batch:
        prepared_source = source_dir / f"{stem}.png"
        prepared_mask = mask_dir / f"{stem}.png"
        with Image.open(source_path) as source:
            source.convert("RGB").save(prepared_source)
        with Image.open(mask_path) as mask:
            binary = mask.convert("L").point(
                lambda value: 255 if value >= 128 else 0
            )
            binary.save(prepared_mask)
        result[stem] = (
            PurePosixPath(
                input_root, "_qwen21_prepared", "pair", prepared_source.name
            ).as_posix(),
            PurePosixPath(
                input_root, "_qwen21_prepared", "pair_mask", prepared_mask.name
            ).as_posix(),
        )
    return result


def preflight(url: str, workflow: dict) -> None:
    info = request_json(url.rstrip("/") + "/object_info")
    workflow_nodes = {node.get("class_type") for node in workflow.values()}
    missing = sorted((REQUIRED_NODES | workflow_nodes) - set(info))
    if missing:
        raise RuntimeError(f"ComfyUI is missing required nodes: {missing}")
    for class_type, (field, expected) in MODEL_FILES.items():
        choices = info[class_type]["input"]["required"][field][0]
        if expected not in choices:
            raise RuntimeError(f"{class_type} cannot see required model: {expected}")


def output_names(history: dict, save_node: str) -> list[str]:
    node_output = history.get("outputs", {}).get(save_node, {})
    return [
        item["filename"]
        for item in node_output.get("images", [])
        if item.get("filename") and item.get("type", "output") == "output"
    ]


def execution_seconds(history: dict) -> float | None:
    started = finished = None
    for event, data in history.get("status", {}).get("messages", []):
        if event == "execution_start":
            started = data.get("timestamp")
        elif event in {"execution_success", "execution_error", "execution_interrupted"}:
            finished = data.get("timestamp")
    if isinstance(started, (int, float)) and isinstance(finished, (int, float)):
        return round((finished - started) / 1000, 3)
    return None


def wait_history(url: str, prompt_id: str, poll_interval: float, timeout: float) -> dict:
    started = time.monotonic()
    while time.monotonic() - started <= timeout:
        try:
            history = request_json(url.rstrip("/") + "/history/" + prompt_id)
        except (TimeoutError, urllib.error.URLError):
            # A cold model load can temporarily block the ComfyUI HTTP server.
            time.sleep(poll_interval)
            continue
        if prompt_id in history:
            entry = history[prompt_id]
            status = entry.get("status", {})
            if status.get("completed") or status.get("status_str") == "error":
                return entry
        time.sleep(poll_interval)
    raise TimeoutError(f"prompt {prompt_id} did not finish within {timeout:g} seconds")


def write_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        handle.flush()


def write_summary(log_path: Path, workflow_sha256: str) -> None:
    records = [
        json.loads(line)
        for line in log_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    current = [
        row for row in records if row.get("workflow_sha256") == workflow_sha256
    ]
    latest = {}
    for row in current:
        latest[row["stem"]] = row
    generated = sorted(
        (
            row
            for row in latest.values()
            if row.get("status") == "completed"
            and not row.get("empty_mask_passthrough")
        ),
        key=lambda row: row["started_at"],
    )
    summary = {
        "workflow_sha256": workflow_sha256,
        "generated_count": len(generated),
        "passthrough_count": sum(
            row.get("status") == "completed"
            and bool(row.get("empty_mask_passthrough"))
            for row in latest.values()
        ),
        "failed_attempts": sum(row.get("status") == "failed" for row in current),
        "first_generated_stem": generated[0]["stem"] if generated else None,
        "definitions": {
            "elapsed_seconds": (
                "Per-image passthrough or ComfyUI submission through saved-output "
                "completion; excludes full-batch validation, input normalization, "
                "model downloads, and server startup."
            ),
            "execution_seconds": (
                "ComfyUI execution_start through execution_success; excludes queue wait."
            ),
            "average_excluding_first": (
                "Excludes the first successful generated image; black-Mask passthroughs "
                "and failed attempts are excluded from all timing averages."
            ),
        },
        "metrics": {},
    }
    for field in ("elapsed_seconds", "execution_seconds"):
        values = [row[field] for row in generated if row.get(field) is not None]
        warm_values = [row[field] for row in generated[1:] if row.get(field) is not None]
        summary["metrics"][field] = {
            "first": generated[0].get(field) if generated else None,
            "average": statistics.mean(values) if values else None,
            "average_excluding_first": statistics.mean(warm_values) if warm_values else None,
            "count": len(values),
        }
    summary_path = log_path.with_name(log_path.stem + "_summary.json")
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfy-root", type=Path, default=Path("/root/ComfyUI"))
    parser.add_argument("--url", default="http://127.0.0.1:6006")
    parser.add_argument("--workflow", type=Path, required=True)
    parser.add_argument("--input-root", required=True)
    parser.add_argument("--output-prefix", required=True)
    parser.add_argument("--skip", action="store_true")
    parser.add_argument("--poll-interval", type=float, default=1.0)
    parser.add_argument("--timeout", type=float, default=3600)
    parser.add_argument("--seed-base", type=int, default=210000)
    parser.add_argument("--log-dir", type=Path)
    args = parser.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.output_prefix):
        raise SystemExit("--output-prefix must be a non-empty filename-safe prefix")
    if args.poll_interval <= 0:
        raise SystemExit("--poll-interval must be positive")
    input_dir = args.comfy_root / "input"
    output_dir = args.comfy_root / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    template = json.loads(args.workflow.read_text(encoding="utf-8"))
    workflow_sha256 = hashlib.sha256(
        json.dumps(template, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    batch = paired_inputs(input_dir, args.input_root)
    log_dir = args.log_dir or output_dir
    safe_prefix = re.sub(r"[^A-Za-z0-9_.-]+", "_", args.output_prefix).strip("_")
    log_path = log_dir / f"qwen21_{safe_prefix}_timings.jsonl"
    client_id = str(uuid.uuid4())

    existing = set()
    if args.skip:
        pattern = re.compile(rf"^{re.escape(args.output_prefix)}(.+?)_\d+_\.png$")
        for path in output_dir.glob(f"{args.output_prefix}*.png"):
            match = pattern.match(path.name)
            if match:
                existing.add(match.group(1))

    # Pair validation above always covers the full batch. A fully skipped or all-black
    # pending batch does not need a running ComfyUI server or prepared inference inputs.
    inference_batch = [
        item
        for item in batch
        if item[0] not in existing and mask_has_edit_pixels(item[2])
    ]
    prepared: dict[str, tuple[str, str]] = {}
    if inference_batch:
        preflight(args.url, template)
        prepared = prepare_inputs(input_dir, args.input_root, inference_batch)

    for index, (stem, source_path, mask_path) in enumerate(batch):
        if stem in existing:
            print(json.dumps({"stem": stem, "status": "skipped"}), flush=True)
            continue
        started = time.monotonic()
        record = {
            "workflow": "qwen_image_2.1_int8",
            "workflow_sha256": workflow_sha256,
            "stem": stem,
            "seed": args.seed_base + index,
            "started_at": now_iso(),
        }
        try:
            if not mask_has_edit_pixels(mask_path):
                output_name = f"{args.output_prefix}{stem}_00001_.png"
                with Image.open(source_path) as source:
                    source.convert("RGB").save(output_dir / output_name)
                record.update(
                    status="completed",
                    outputs=[output_name],
                    empty_mask_passthrough=True,
                )
            else:
                prompt = copy.deepcopy(template)
                source_name, mask_name = prepared[stem]
                prompt["1"]["inputs"]["image"] = source_name
                prompt["2"]["inputs"]["image"] = mask_name
                prompt["13"]["inputs"]["seed"] = args.seed_base + index
                prompt["19"]["inputs"]["filename_prefix"] = (
                    f"{args.output_prefix}{stem}"
                )
                response = request_json(
                    args.url.rstrip("/") + "/prompt",
                    {"prompt": prompt, "client_id": client_id},
                )
                if not response.get("prompt_id") or response.get("node_errors"):
                    raise RuntimeError(json.dumps(response, ensure_ascii=False))
                prompt_id = response["prompt_id"]
                history = wait_history(
                    args.url, prompt_id, args.poll_interval, args.timeout
                )
                status = history.get("status", {})
                if not status.get("completed") or status.get("status_str") != "success":
                    raise RuntimeError(json.dumps(status, ensure_ascii=False))
                names = output_names(history, "19")
                if len(names) != 1:
                    raise RuntimeError(f"expected exactly one output image, got {names}")
                expected_prefix = f"{args.output_prefix}{stem}_"
                if (
                    Path(names[0]).name != names[0]
                    or not names[0].startswith(expected_prefix)
                    or not (output_dir / names[0]).is_file()
                ):
                    raise RuntimeError(f"expected saved output for {stem}, got {names[0]}")
                record.update(
                    status="completed",
                    prompt_id=prompt_id,
                    outputs=names,
                    execution_seconds=execution_seconds(history),
                )
        except Exception as error:
            record.update(status="failed", error=str(error))
        record.update(
            finished_at=now_iso(),
            elapsed_seconds=round(time.monotonic() - started, 3),
        )
        write_jsonl(log_path, record)
        write_summary(log_path, workflow_sha256)
        print(json.dumps(record, ensure_ascii=False), flush=True)
        if record["status"] == "failed":
            raise SystemExit(1)


if __name__ == "__main__":
    main()
