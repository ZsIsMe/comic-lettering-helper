import asyncio
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

COMFY_INPUT = Path("/root/ComfyUI/input")
COMFY_OUTPUT = Path("/root/ComfyUI/output")
COMFY_BIN = "/root/miniconda3/bin/comfy"
COMFY_URL = "http://127.0.0.1:6006"
BASE_WORKFLOW = Path(
    os.environ.get("FIRERED_BASE_WORKFLOW", "/tmp/FireRed-1.1-BF16-Manga-Mask.json")
)
NO_LORA = os.environ.get("FIRERED_NO_LORA", "0") == "1"
LATENT_MASK = os.environ.get("FIRERED_LATENT_MASK", "0") == "1"
LORA_NAME = os.environ.get(
    "FIRERED_LORA_NAME",
    "FireRed-Image-Edit-1.1-Lightning-8steps-v1.2.safetensors",
)
BATCH_NAME = os.environ.get("FIRERED_BATCH_NAME", "firered_batch")
PAIR_DIR = COMFY_INPUT / os.environ.get("FIRERED_PAIR_DIR", ".")
MASK_DIR = COMFY_INPUT / os.environ.get("FIRERED_MASK_DIR", ".")
OUTPUT_PREFIX = os.environ.get("FIRERED_OUTPUT_PREFIX", "FireRed-batch-")
SKIP_STEMS = {x for x in os.environ.get("FIRERED_SKIP_STEMS", "12_01").split(",") if x}
LOAD_FLAT = os.environ.get("FIRERED_LOAD_FLAT", "0") == "1"
FLAT_NAME_PREFIX = os.environ.get("FIRERED_FLAT_NAME_PREFIX", "")
MASK_FLAT_NAME_PREFIX = os.environ.get("FIRERED_MASK_FLAT_NAME_PREFIX", FLAT_NAME_PREFIX)
INPUT_PREFIX = os.environ.get("FIRERED_INPUT_PREFIX", "")
ONLY_STEM = os.environ.get("FIRERED_ONLY_STEM", "")
PRESERVE_WORKFLOW = os.environ.get("FIRERED_PRESERVE_WORKFLOW", "0") == "1"
WORKFLOW_DIR = Path("/tmp/firered_batch_workflows") / BATCH_NAME
LOG_PATH = COMFY_OUTPUT / f"{BATCH_NAME}_timings.jsonl"
SUMMARY_PATH = COMFY_OUTPUT / f"{BATCH_NAME}_summary.json"
PROMPT = (
    "移除图中的拟声词、效果字及残留笔画，"
    "依照文字周围的漫画线稿、黑白块、网点、阴影和背景纹理，"
    "自然补全被文字覆盖的背景。保持人物、构图及其他内容不变，不新增物体，"
    "不生成任何文字、字母、汉字、数字或符号。"
)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def submit_once(workflow_path: Path) -> str:
    process = await asyncio.create_subprocess_exec(
        COMFY_BIN,
        "--json",
        "run",
        "--workflow",
        str(workflow_path),
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
    raise RuntimeError(f"comfy run returned no prompt_id: {events}")


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


async def get_history(prompt_id: str) -> dict | None:
    payload = await asyncio.to_thread(get_json, f"{COMFY_URL}/history/{prompt_id}")
    return payload.get(prompt_id)


def output_filenames(history: dict) -> list[str]:
    names = []
    for node_output in history.get("outputs", {}).values():
        for image in node_output.get("images", []):
            if image.get("filename"):
                names.append(image["filename"])
    return names


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


def set_widget(nodes: list, node_id: int, index: int, value) -> None:
    for node in nodes:
        if node.get("id") == node_id:
            widgets = node.setdefault("widgets_values", [])
            widgets[index] = value
            return
    raise KeyError(f"node {node_id} not found")


def add_latent_noise_mask(workflow: dict) -> None:
    """Expose the crop-aligned mask to the FireRed subgraph and mask sampling."""
    subgraph = workflow["definitions"]["subgraphs"][0]
    nodes = subgraph["nodes"]
    vae_encode = next(item for item in nodes if item.get("id") == 125)
    sampler = next(item for item in nodes if item.get("id") == 130)

    # Replace VAEEncode -> KSampler with VAEEncode -> SetLatentNoiseMask -> KSampler.
    subgraph["links"] = [link for link in subgraph["links"] if link["id"] != 303]
    vae_encode["outputs"][0]["links"] = [
        link_id for link_id in (vae_encode["outputs"][0].get("links") or []) if link_id != 303
    ]
    sampler["inputs"][3]["link"] = 370

    mask_input_slot = len(subgraph["inputs"])
    subgraph["inputs"].append(
        {
            "id": "76439b24-f403-4bb6-92ac-b195f78d880b",
            "linkIds": [369],
            "name": "mask",
            "pos": [-1138.255859375, -1030],
            "type": "MASK",
        }
    )
    nodes.append(
        {
            "id": 172,
            "type": "SetLatentNoiseMask",
            "pos": [300, -940],
            "size": [230, 82],
            "flags": {},
            "order": 20,
            "mode": 0,
            "inputs": [
                {"name": "samples", "type": "LATENT", "link": 368},
                {"name": "mask", "type": "MASK", "link": 369},
            ],
            "outputs": [{"name": "LATENT", "type": "LATENT", "links": [370]}],
            "properties": {
                "Node name for S&R": "SetLatentNoiseMask",
                "cnr_id": "comfy-core",
            },
            "widgets_values": [],
            "title": "Restrict FireRed sampling to cropped mask",
        }
    )
    subgraph["links"].extend(
        [
            {"id": 368, "origin_id": 125, "origin_slot": 0, "target_id": 172, "target_slot": 0, "type": "LATENT"},
            {"id": 369, "origin_id": -10, "origin_slot": mask_input_slot, "target_id": 172, "target_slot": 1, "type": "MASK"},
            {"id": 370, "origin_id": 172, "origin_slot": 0, "target_id": 130, "target_slot": 3, "type": "LATENT"},
        ]
    )
    subgraph["state"]["lastNodeId"] = max(subgraph["state"].get("lastNodeId", 0), 172)
    subgraph["state"]["lastLinkId"] = max(subgraph["state"].get("lastLinkId", 0), 370)

    crop = next(item for item in workflow["nodes"] if item.get("id") == 174)
    fire_red = next(item for item in workflow["nodes"] if item.get("id") == 167)
    crop["outputs"][2]["links"] = [376]
    fire_red["inputs"].append({"name": "mask", "type": "MASK", "link": 376})
    workflow["links"].append([376, 174, 2, 167, len(fire_red["inputs"]) - 1, "MASK"])
    workflow["last_link_id"] = max(workflow.get("last_link_id", 0), 376)


def make_workflow(stem: str, original_name: str, mask_name: str) -> Path:
    WORKFLOW_DIR.mkdir(parents=True, exist_ok=True)
    workflow = json.loads(BASE_WORKFLOW.read_text(encoding="utf-8"))
    set_widget(workflow["nodes"], 143, 0, original_name)
    set_widget(workflow["nodes"], 171, 0, mask_name)
    set_widget(workflow["nodes"], 9, 0, f"{OUTPUT_PREFIX}{stem}")
    if PRESERVE_WORKFLOW:
        path = WORKFLOW_DIR / f"{stem}.json"
        path.write_text(json.dumps(workflow, ensure_ascii=False), encoding="utf-8")
        return path
    set_widget(workflow["nodes"], 167, 0, PROMPT)
    set_widget(workflow["nodes"], 167, 1, "FireRed-Image-Edit-1.1-transformer.safetensors")
    subgraph = workflow["definitions"]["subgraphs"][0]
    nodes = subgraph["nodes"]
    if NO_LORA:
        # The no-LoRA workflow exposes only prompt, UNet, CLIP, and VAE.
        set_widget(workflow["nodes"], 167, 2, "qwen2.5vl-7b-bf16.safetensors")
        set_widget(workflow["nodes"], 167, 3, "qwen_image_vae.safetensors")
        set_widget(nodes, 115, 0, "qwen2.5vl-7b-bf16.safetensors")
        set_widget(nodes, 116, 0, "qwen_image_vae.safetensors")
        set_widget(nodes, 118, 0, PROMPT)
        set_widget(nodes, 128, 0, "FireRed-Image-Edit-1.1-transformer.safetensors")
        set_widget(nodes, 130, 2, 40)
        set_widget(nodes, 130, 3, 4)
        set_widget(nodes, 155, 0, 40)
        set_widget(nodes, 162, 0, 4)
    else:
        set_widget(workflow["nodes"], 167, 2, LORA_NAME)
        set_widget(workflow["nodes"], 167, 3, "qwen2.5vl-7b-bf16.safetensors")
        set_widget(workflow["nodes"], 167, 4, "qwen_image_vae.safetensors")
        set_widget(workflow["nodes"], 167, 5, True)
        set_widget(nodes, 115, 0, "qwen2.5vl-7b-bf16.safetensors")
        set_widget(nodes, 116, 0, "qwen_image_vae.safetensors")
        set_widget(nodes, 118, 0, PROMPT)
        set_widget(nodes, 128, 0, "FireRed-Image-Edit-1.1-transformer.safetensors")
        set_widget(nodes, 130, 2, 8)
        set_widget(nodes, 130, 3, 1)
        set_widget(nodes, 151, 0, LORA_NAME)
        set_widget(nodes, 153, 0, True)
        set_widget(nodes, 156, 0, 8)
        set_widget(nodes, 163, 0, 1)

    if LATENT_MASK:
        add_latent_noise_mask(workflow)

    path = WORKFLOW_DIR / f"{stem}.json"
    path.write_text(json.dumps(workflow, ensure_ascii=False), encoding="utf-8")
    return path


def append_log(record: dict) -> None:
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def completed_stems() -> set[str]:
    done = set(SKIP_STEMS)
    output_pattern = re.compile(rf"^{re.escape(OUTPUT_PREFIX)}(.+?)_\d+_\.png$")
    for path in COMFY_OUTPUT.glob(f"{OUTPUT_PREFIX}*.png"):
        match = output_pattern.match(path.name)
        if match:
            done.add(match.group(1))
    if not LOG_PATH.exists():
        return done
    for line in LOG_PATH.read_text(encoding="utf-8").splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if record.get("status") == "completed":
            done.add(record["stem"])
    return done


def discover_pairs() -> list[tuple[str, str, str]]:
    originals = {}
    for suffix in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG"):
        for path in PAIR_DIR.glob(suffix):
            if INPUT_PREFIX and not path.stem.startswith(INPUT_PREFIX):
                continue
            stem = path.stem[len(INPUT_PREFIX):] if INPUT_PREFIX else path.stem
            originals[stem] = (
                f"{FLAT_NAME_PREFIX}{path.name}"
                if LOAD_FLAT
                else path.relative_to(COMFY_INPUT).as_posix()
            )
    masks = {}
    for path in MASK_DIR.glob("*.png"):
        if INPUT_PREFIX and not path.stem.startswith(INPUT_PREFIX):
            continue
        stem = path.stem[len(INPUT_PREFIX):] if INPUT_PREFIX else path.stem
        masks[stem] = (
            f"{MASK_FLAT_NAME_PREFIX}{path.name}"
            if LOAD_FLAT
            else path.relative_to(COMFY_INPUT).as_posix()
        )
    wanted = sorted(set(originals) & set(masks))
    return [(stem, originals[stem], masks[stem]) for stem in wanted]


def mask_has_edit_pixels(mask_name: str) -> bool:
    with Image.open(COMFY_INPUT / mask_name) as source:
        return source.convert("L").getbbox() is not None


def save_empty_mask_passthrough(original_name: str, stem: str) -> str:
    output_name = f"{OUTPUT_PREFIX}{stem}_00001_.png"
    with Image.open(COMFY_INPUT / original_name) as source:
        source.convert("RGB").save(COMFY_OUTPUT / output_name)
    return output_name


async def run_one(stem: str, original_name: str, mask_name: str) -> dict:
    workflow_path = make_workflow(stem, original_name, mask_name)
    started_iso = now_iso()
    started = time.monotonic()
    prompt_id = None
    try:
        prompt_id = await submit_once(workflow_path)
        while True:
            await asyncio.sleep(1)
            history = await get_history(prompt_id)
            if history is None:
                continue
            status = history.get("status", {})
            state = status.get("status_str")
            if status.get("completed") and state == "success":
                record = {
                    "stem": stem,
                    "status": "completed",
                    "prompt_id": prompt_id,
                    "started_at": started_iso,
                    "finished_at": now_iso(),
                    "elapsed_seconds": round(time.monotonic() - started, 3),
                    "execution_seconds": execution_seconds(history),
                    "outputs": output_filenames(history),
                }
                append_log(record)
                return record
            if status.get("completed") and state != "success":
                raise RuntimeError(json.dumps(status, ensure_ascii=False))
    except Exception as exc:
        record = {
            "stem": stem,
            "status": "failed",
            "prompt_id": prompt_id,
            "started_at": started_iso,
            "finished_at": now_iso(),
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "error": str(exc),
        }
        append_log(record)
        return record


async def main() -> None:
    WORKFLOW_DIR.mkdir(parents=True, exist_ok=True)
    pairs = discover_pairs()
    if ONLY_STEM:
        pairs = [pair for pair in pairs if pair[0] == ONLY_STEM]
    done = completed_stems()
    pending = [pair for pair in pairs if pair[0] not in done]
    print(json.dumps({"event": "batch_start", "time": now_iso(), "pairs": len(pairs), "pending": len(pending)}, ensure_ascii=False), flush=True)
    records = []
    batch_started = time.monotonic()
    for index, pair in enumerate(pending, 1):
        print(json.dumps({"event": "item_start", "index": index, "total": len(pending), "stem": pair[0], "time": now_iso()}, ensure_ascii=False), flush=True)
        stem, original_name, mask_name = pair
        if mask_has_edit_pixels(mask_name):
            record = await run_one(*pair)
        else:
            started = now_iso()
            output_name = save_empty_mask_passthrough(original_name, stem)
            record = {
                "stem": stem,
                "status": "completed",
                "started_at": started,
                "finished_at": now_iso(),
                "elapsed_seconds": 0.0,
                "execution_seconds": 0.0,
                "outputs": [output_name],
                "empty_mask_passthrough": True,
            }
            append_log(record)
        records.append(record)
        print(json.dumps({"event": "item_end", **record}, ensure_ascii=False), flush=True)
        if record["status"] == "failed":
            break
    completed = [row for row in records if row["status"] == "completed"]
    failed = [row for row in records if row["status"] == "failed"]
    durations = [row["elapsed_seconds"] for row in completed]
    summary = {
        "finished_at": now_iso(),
        "processed_this_run": len(records),
        "completed": len(completed),
        "failed": len(failed),
        "failed_stems": [row["stem"] for row in failed],
        "wall_seconds": round(time.monotonic() - batch_started, 3),
        "mean_seconds": round(sum(durations) / len(durations), 3) if durations else None,
        "min_seconds": min(durations) if durations else None,
        "max_seconds": max(durations) if durations else None,
    }
    SUMMARY_PATH.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"event": "batch_end", **summary}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
