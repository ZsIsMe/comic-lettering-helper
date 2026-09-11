#!/usr/bin/env python3
"""Run independent Qwen 2511 or Flux2-klein UI workflows through ComfyUI."""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageChops


COMFY_BIN = "/root/miniconda3/bin/comfy"
COMFY_URL = "http://127.0.0.1:6006"
COMFY_INPUT = Path("/root/ComfyUI/input")
COMFY_OUTPUT = Path("/root/ComfyUI/output")
WORKFLOW_ROOT = Path("/root/ComfyUI/user/default/workflows")
CONFIG = {
    "nunchaku_flux1_fill_removal": {
        "workflow": "Nunchaku-FLUX1-Fill-INT4-RemovalV2-Manga-CropStitch-20step.json",
        "image_node": 17,
        "mask_node": 61,
        "save_node": 9,
        "seed_node": 3,
        "prefix": "nunchaku_flux1_fill_removal20_",
    },
    "onereward_remove_lora": {
        "workflow": "OneReward-Fill-FP8-ObjectRemovalLoRA-Manga-Mask-CropStitch.json",
        "image_node": 17,
        "mask_node": 18,
        "save_node": 9,
        "seed_node": 3,
        "prefix": "onereward_remove_lora_",
    },
    "qwenlanpaint": {
        "workflow": "Qwen-Image-Edit-2511-LanPaint-V2-4Steps-manga.json",
        "image_node": 168,
        "mask_node": None,
        "save_node": 166,
        "seed_node": 161,
        "prefix": "qwen2511_lanpaint_rgba_",
    },
    "qwenlanpaint_native": {
        "workflow": "Qwen-Image-Edit-2511-LanPaint-V2-4Steps-manga-nativepad.json",
        "image_node": 168,
        "mask_node": None,
        "save_node": 166,
        "seed_node": 161,
        "prefix": "qwen2511_lanpaint_nativepad_",
    },
    "qwenlanpaint_aligned": {
        "workflow": "Qwen-Image-Edit-2511-LanPaint-V2-4Steps-manga-aligned-cropstitch.json",
        "image_node": 168,
        "mask_node": None,
        "save_node": 166,
        "seed_node": 161,
        "prefix": "qwen2511_lanpaint_aligned_cropstitch_",
    },
    "qwen": {
        "workflow": "Qwen-Image-Edit-2511-FP8-Manga-Mask-Lightning-4step.json",
        "image_node": 107,
        "mask_node": 370,
        "save_node": 345,
        "seed_node": 302,
        "prefix": "qwen2511_selected7_",
    },
    "flux2": {
        "workflow": "Flux2-Klein-9B-FP8-Manga-Mask-4step.json",
        "image_node": 297,
        "mask_node": 304,
        "save_node": 319,
        "seed_node": 280,
        "prefix": "flux2klein_selected7_",
    },
    "flux2lanpaint": {
        "workflow": "Flux2-Klein-9B-FP8-Manga-Mask-LanPaint-4step.json",
        "image_node": 297,
        "mask_node": 304,
        "save_node": 319,
        "seed_node": 280,
        "prefix": "flux2klein_lanpaint_selected7_",
    },
}

OCCLUSION_PROMPT = (
    "移除遮罩区域内的漫画拟声词、效果字和残留笔画。根据遮罩边缘实际可见的线稿、网点、"
    "黑白块、灰度与阴影，自然补全被遮挡的黑白漫画内容，保持原有画风、人物、物体和构图一致；"
    "遮罩外区域保持不变，不添加文字或新的画面元素。"
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def set_widget(nodes: list[dict], node_id: int, index: int, value) -> None:
    node = next((item for item in nodes if item.get("id") == node_id), None)
    if node is None:
        raise KeyError(f"node {node_id} not found")
    node.setdefault("widgets_values", [])[index] = value


def workflow_nodes(workflow: dict) -> list[dict]:
    """Return root nodes plus nodes nested in ComfyUI subgraphs."""
    nodes = list(workflow.get("nodes", []))
    for subgraph in workflow.get("definitions", {}).get("subgraphs", []):
        nodes.extend(subgraph.get("nodes", []))
    return nodes


def make_lanpaint_rgba(stem: str, image_name: str, mask_name: str) -> str:
    """Embed the binary mask as transparent alpha for LanPaint LoadImage."""
    image_path = COMFY_INPUT / image_name
    mask_path = COMFY_INPUT / mask_name
    output_name = f"qwenlanpaint_rgba_{stem}.png"
    output_path = COMFY_INPUT / output_name
    with Image.open(image_path) as source, Image.open(mask_path) as source_mask:
        source_rgb = source.convert("RGB")
        image = source_rgb.convert("RGBA")
        mask = source_mask.convert("L")
        if mask.size != image.size:
            mask = mask.resize(image.size, Image.Resampling.NEAREST)
        # ComfyUI LoadImage emits MASK = 1 - alpha.
        alpha = mask.point(lambda value: 0 if value >= 128 else 255)
        if alpha.getextrema() != (0, 255):
            raise ValueError(f"{stem}: LanPaint alpha must contain transparent and opaque pixels")
        image.putalpha(alpha)
        if ImageChops.difference(image.convert("RGB"), source_rgb).getbbox() is not None:
            raise ValueError(f"{stem}: LanPaint RGBA RGB content is not the source image")
        image.save(output_path)
    with Image.open(output_path) as saved:
        if saved.mode != "RGBA" or saved.getchannel("A").getextrema() != (0, 255):
            raise ValueError(f"{stem}: saved LanPaint input failed RGBA alpha validation")
    return output_name


def mask_has_edit_pixels(mask_name: str) -> bool:
    with Image.open(COMFY_INPUT / mask_name) as source:
        return source.convert("L").getbbox() is not None


def save_empty_mask_passthrough(image_name: str, prefix: str, stem: str) -> str:
    output_name = f"{prefix}{stem}_00001_.png"
    with Image.open(COMFY_INPUT / image_name) as source:
        source.convert("RGB").save(COMFY_OUTPUT / output_name)
    return output_name


def add_qwen_condition_fill(workflow: dict, fill: str) -> None:
    color = "#808080" if fill == "gray" else "#FFFFFF"
    nodes = workflow["nodes"]
    crop = next(item for item in nodes if item.get("id") == 398)
    config = next(item for item in nodes if item.get("id") == 283)
    prompt = next(item for item in nodes if item.get("id") == 223)
    workflow["links"] = [link for link in workflow["links"] if link[0] != 905]
    crop["outputs"][1]["links"] = [914, 916]
    crop["outputs"][2]["links"] = [906, 917]
    config["inputs"][0]["link"] = 918
    prompt["widgets_values"][0] = OCCLUSION_PROMPT
    nodes.extend([
        {
            "id": 403, "type": "LayerUtility: ColorImage V2", "title": f"{fill} Mask 填充图",
            "pos": [-250, 250], "size": [300, 170], "flags": {}, "order": 8, "mode": 0,
            "inputs": [
                {"name": "size_as", "type": "*", "link": 914},
                {"name": "size", "type": "COMBO", "link": None},
                {"name": "custom_width", "type": "INT", "link": None},
                {"name": "custom_height", "type": "INT", "link": None},
                {"name": "color", "type": "STRING", "link": None},
            ],
            "outputs": [{"name": "image", "type": "IMAGE", "links": [915]}],
            "properties": {"cnr_id": "comfyui_layerstyle", "Node name for S&R": "LayerUtility: ColorImage V2"},
            "widgets_values": ["custom", 512, 512, color],
        },
        {
            "id": 404, "type": "ImageCompositeMasked", "title": "用中性色遮挡原字形",
            "pos": [100, 200], "size": [300, 180], "flags": {}, "order": 9, "mode": 0,
            "inputs": [
                {"name": "destination", "type": "IMAGE", "link": 916},
                {"name": "source", "type": "IMAGE", "link": 915},
                {"name": "x", "type": "INT", "widget": {"name": "x"}, "link": None},
                {"name": "y", "type": "INT", "widget": {"name": "y"}, "link": None},
                {"name": "resize_source", "type": "BOOLEAN", "widget": {"name": "resize_source"}, "link": None},
                {"name": "mask", "type": "MASK", "link": 917},
            ],
            "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": [918]}],
            "properties": {"cnr_id": "comfy-core", "Node name for S&R": "ImageCompositeMasked"},
            "widgets_values": [0, 0, False],
        },
    ])
    workflow["links"].extend([
        [914, 398, 1, 403, 0, "IMAGE"],
        [915, 403, 0, 404, 1, "IMAGE"],
        [916, 398, 1, 404, 0, "IMAGE"],
        [917, 398, 2, 404, 5, "MASK"],
        [918, 404, 0, 283, 0, "IMAGE"],
    ])
    workflow["last_node_id"] = max(workflow.get("last_node_id", 0), 404)
    workflow["last_link_id"] = max(workflow.get("last_link_id", 0), 918)


def use_qwen_no_ref_conditioning(workflow: dict) -> None:
    nodes = workflow["nodes"]
    encoder = next(item for item in nodes if item.get("id") == 284)
    extractor = next(item for item in nodes if item.get("id") == 304)
    encoder["outputs"][0]["links"] = None
    extractor["outputs"][9]["links"] = [680, 876]
    for link in workflow["links"]:
        if link[0] in {680, 876}:
            link[1] = 304
            link[2] = 9


def make_workflow(model: str, stem: str, image_name: str, mask_name: str, seed: int, condition_fill: str, qwen_no_ref: bool, output_prefix: str | None, workflow_override: str | None = None) -> Path:
    config = CONFIG[model]
    source = Path(workflow_override) if workflow_override else WORKFLOW_ROOT / config["workflow"]
    workflow = json.loads(source.read_text(encoding="utf-8"))
    if model in {"qwenlanpaint", "qwenlanpaint_native", "qwenlanpaint_aligned"}:
        image_name = make_lanpaint_rgba(stem, image_name, mask_name)
    nodes = workflow_nodes(workflow)
    set_widget(nodes, config["image_node"], 0, image_name)
    if config["mask_node"] is not None:
        set_widget(nodes, config["mask_node"], 0, mask_name)
    prefix = output_prefix or config["prefix"]
    if condition_fill != "none" and output_prefix is None:
        prefix = f"qwen2511_{condition_fill}_"
    if model == "qwen" and qwen_no_ref:
        prefix = "qwen2511_norefcond_"
    set_widget(nodes, config["save_node"], 0, f"{prefix}{stem}")
    set_widget(nodes, config["seed_node"], 0, seed)
    if model == "qwen" and condition_fill != "none":
        add_qwen_condition_fill(workflow, condition_fill)
    if model == "qwen" and qwen_no_ref:
        use_qwen_no_ref_conditioning(workflow)
    target_dir = Path("/tmp/independent_edit_workflows") / model
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{stem}.json"
    target.write_text(json.dumps(workflow, ensure_ascii=False), encoding="utf-8")
    return target


async def submit(workflow: Path) -> str:
    process = await asyncio.create_subprocess_exec(
        COMFY_BIN,
        "--json",
        "run",
        "--workflow",
        str(workflow),
        "--host",
        "127.0.0.1",
        "--port",
        "6006",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    events = []
    for line in stdout.decode("utf-8", "replace").splitlines():
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    if process.returncode != 0:
        raise RuntimeError(stderr.decode("utf-8", "replace") or str(events))
    for event in reversed(events):
        prompt_id = event.get("data", {}).get("prompt_id")
        if prompt_id:
            return prompt_id
    raise RuntimeError(f"No prompt id: {events}")


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


async def wait_history(prompt_id: str, poll_interval: float) -> dict:
    while True:
        await asyncio.sleep(poll_interval)
        try:
            history = await asyncio.to_thread(get_json, f"{COMFY_URL}/history/{prompt_id}")
        except (TimeoutError, urllib.error.URLError):
            # Large model cold-loads can temporarily block ComfyUI's HTTP server.
            # The queued prompt is still running, so keep polling instead of
            # failing the batch and restarting the server mid-load.
            continue
        if prompt_id in history:
            return history[prompt_id]


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


def outputs(history: dict) -> list[str]:
    result = []
    for node_output in history.get("outputs", {}).values():
        result.extend(item["filename"] for item in node_output.get("images", []) if item.get("filename"))
    return result


def pairs(root: str) -> list[tuple[str, str, str]]:
    image_dir = COMFY_INPUT / root / "pair"
    mask_dir = COMFY_INPUT / root / "pair_mask"
    images = {p.stem: p for suffix in ("*.jpg", "*.jpeg", "*.png") for p in image_dir.glob(suffix)}
    masks = {p.stem: p for p in mask_dir.glob("*.png")}
    missing_masks = sorted(set(images) - set(masks))
    missing_images = sorted(set(masks) - set(images))
    if missing_masks or missing_images:
        raise ValueError(
            f"source/Mask stem mismatch: missing_masks={missing_masks}, "
            f"missing_sources={missing_images}"
        )
    return [
        (stem, f"{root}_{images[stem].name}", f"{root}_mask_{masks[stem].name}")
        for stem in sorted(images)
    ]


def validate_pair_inputs(batch: list[tuple[str, str, str]]) -> None:
    if not batch:
        raise ValueError("no paired source/Mask images found")
    for stem, image_name, mask_name in batch:
        with Image.open(COMFY_INPUT / image_name) as source, Image.open(COMFY_INPUT / mask_name) as mask:
            if source.size != mask.size:
                raise ValueError(
                    f"{stem}: source/Mask size mismatch: source={source.size}, mask={mask.size}"
                )
            source.convert("RGB")
            mask.convert("L")


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=CONFIG, required=True)
    parser.add_argument("--input-root", default="codex_selected7")
    parser.add_argument("--smoke-only", action="store_true")
    parser.add_argument("--skip", action="store_true")
    parser.add_argument("--seed-base", type=int, default=251100)
    parser.add_argument("--condition-fill", choices=("none", "gray", "white"), default="none")
    parser.add_argument("--only-stem", default=None)
    parser.add_argument("--qwen-no-ref", action="store_true")
    parser.add_argument("--output-prefix", default=None, help="Batch-specific SaveImage prefix")
    parser.add_argument("--workflow-override", default=None, help="Use an alternate workflow JSON without changing the production default")
    parser.add_argument("--poll-interval", type=float, default=1.0)
    args = parser.parse_args()
    config = CONFIG[args.model]
    active_prefix = args.output_prefix or config["prefix"]
    batch = pairs(args.input_root)
    validate_pair_inputs(batch)
    if args.only_stem:
        batch = [item for item in batch if item[0] == args.only_stem]
    if args.smoke_only:
        batch = batch[:1]
    log_key = re.sub(r"[^A-Za-z0-9_.-]+", "_", active_prefix).strip("_")
    log_path = COMFY_OUTPUT / f"{args.model}_{log_key}_timings.jsonl"
    existing = set()
    if args.skip:
        pattern = re.compile(rf'^{re.escape(active_prefix)}(.+?)_\d+_\.png$')
        for path in COMFY_OUTPUT.glob(f'{active_prefix}*.png'):
            match = pattern.match(path.name)
            if match:
                existing.add(match.group(1))
    for index, (stem, image_name, mask_name) in enumerate(batch):
        if stem in existing:
            print(json.dumps({"model": args.model, "stem": stem, "status": "skipped"}), flush=True)
            continue
        seed = args.seed_base + index
        started = time.monotonic()
        record = {"model": args.model, "stem": stem, "seed": seed, "started_at": now_iso()}
        try:
            if not mask_has_edit_pixels(mask_name):
                output_name = save_empty_mask_passthrough(image_name, active_prefix, stem)
                record.update(
                    status="completed", outputs=[output_name], empty_mask_passthrough=True
                )
                raise StopIteration
            workflow = make_workflow(
                args.model, stem, image_name, mask_name, seed, args.condition_fill, args.qwen_no_ref,
                active_prefix, args.workflow_override,
            )
            prompt_id = await submit(workflow)
            history = await wait_history(prompt_id, max(0.2, args.poll_interval))
            status = history.get("status", {})
            if not status.get("completed") or status.get("status_str") != "success":
                raise RuntimeError(json.dumps(status, ensure_ascii=False))
            output_names = outputs(history)
            record.update(
                status="completed",
                prompt_id=prompt_id,
                outputs=output_names,
                execution_seconds=execution_seconds(history),
            )
        except StopIteration:
            pass
        except Exception as exc:
            record.update(status="failed", error=str(exc))
        record.update(finished_at=now_iso(), elapsed_seconds=round(time.monotonic() - started, 3))
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
        print(json.dumps(record, ensure_ascii=False), flush=True)
        if record["status"] == "failed":
            raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
