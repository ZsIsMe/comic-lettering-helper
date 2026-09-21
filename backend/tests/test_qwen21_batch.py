from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest
from PIL import Image


REPO = Path(__file__).resolve().parents[2]
RUNNER_PATH = REPO / "runtime-tools/run_qwen21_batch.py"
API_PATH = REPO / "workflows/Qwen-Image-2.1-INT8-Manga.api.json"
BATCH_UI_PATH = REPO / "workflows/Qwen-Image-2.1-INT8-Manga.json"
HAND_UI_PATH = REPO / "workflows/handpaint/Qwen手塗去字.json"
OBJECT_INFO_PATH = os.environ.get("QWEN21_OBJECT_INFO_FIXTURE")


def load_runner():
    spec = importlib.util.spec_from_file_location("run_qwen21_batch", RUNNER_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def ui_nodes(path: Path) -> dict[int, dict]:
    workflow = json.loads(path.read_text(encoding="utf-8"))
    return {node["id"]: node for node in workflow["nodes"]}


def test_api_workflow_has_fixed_qwen21_mask_and_composite_contract():
    workflow = json.loads(API_PATH.read_text(encoding="utf-8"))
    assert workflow["4"] == {
        "class_type": "ThresholdMask",
        "inputs": {"mask": ["3", 0], "value": 0.5},
    }
    assert workflow["5"]["inputs"] == {
        "mask": ["4", 0],
        "expand": 0,
        "incremental_expandrate": 0,
        "tapered_corners": True,
        "flip_input": False,
        "blur_radius": 0,
        "lerp_alpha": 1,
        "decay_factor": 1,
        "fill_holes": True,
    }
    assert workflow["6"]["inputs"] == {
        "mask": ["5", 0],
        "expand": 8,
        "tapered_corners": True,
    }
    assert workflow["12"]["inputs"]["resolution"] == 0
    assert workflow["12"]["inputs"]["images.image_1"] == ["1", 0]
    assert workflow["12"]["inputs"]["images.image_2"] == ["7", 0]
    assert workflow["13"]["inputs"]["seed"] == 0
    assert workflow["13"]["inputs"]["steps"] == 25
    assert workflow["13"]["inputs"]["cfg"] == 1
    assert workflow["13"]["inputs"]["sampler_name"] == "euler"
    assert workflow["13"]["inputs"]["scheduler"] == "simple"
    assert workflow["15"]["class_type"] == "SplitImageWithAlpha"
    assert workflow["17"]["inputs"]["upscale_method"] == "lanczos"
    assert workflow["18"]["inputs"]["mask"] == ["6", 0]
    assert workflow["19"]["class_type"] == "SaveImage"
    assert [node for node in workflow.values() if node["class_type"] == "SaveImage"] == [
        workflow["19"]
    ]
    assert not any("LanPaint" in node["class_type"] for node in workflow.values())


@pytest.mark.parametrize("path", [BATCH_UI_PATH, HAND_UI_PATH])
def test_ui_workflows_match_fixed_api_parameters(path: Path):
    nodes = ui_nodes(path)
    assert nodes[8]["widgets_values"] == [
        "qwen_image_2.1_int8_convrot.safetensors",
        "default",
    ]
    assert nodes[9]["widgets_values"] == [
        "qwen3vl_8b_int8_convrot.safetensors",
        "qwen_image",
        "default",
    ]
    assert nodes[10]["widgets_values"] == ["qwen_image_2.1_vae_bf16.safetensors"]
    assert nodes[11]["widgets_values"] == ["auto", "default"]
    assert nodes[12]["widgets_values"][2] == 0
    assert nodes[13]["widgets_values"][2:] == [25, 1, "euler", "simple", 1]
    assert nodes[5]["widgets_values"] == [0, 0, True, False, 0, 1, 1, True]
    assert nodes[6]["widgets_values"] == [8, True]
    assert nodes[17]["widgets_values"][0] == "lanczos"
    assert nodes[19]["type"] == "SaveImage"
    assert sum(node["type"] == "SaveImage" for node in nodes.values()) == 1
    assert not any("LanPaint" in node["type"] for node in nodes.values())


def test_batch_and_handpaint_mask_entry_points_are_distinct():
    batch = ui_nodes(BATCH_UI_PATH)
    handpaint = ui_nodes(HAND_UI_PATH)
    assert batch[2]["type"] == "LoadImage"
    assert batch[3]["type"] == "ImageToMask"
    assert 2 not in handpaint
    assert 3 not in handpaint
    assert handpaint[1]["outputs"][1]["links"] == [2]
    assert handpaint[4]["inputs"][0]["link"] == 2


@pytest.mark.parametrize("path", [BATCH_UI_PATH, HAND_UI_PATH])
def test_ui_workflow_links_are_bidirectionally_consistent(path: Path):
    workflow = json.loads(path.read_text(encoding="utf-8"))
    nodes = {node["id"]: node for node in workflow["nodes"]}
    links = {link[0]: link for link in workflow["links"]}
    assert len(links) == len(workflow["links"])
    for link_id, source, source_slot, target, target_slot, kind in links.values():
        assert nodes[source]["outputs"][source_slot]["type"] == kind
        assert link_id in (nodes[source]["outputs"][source_slot]["links"] or [])
        assert nodes[target]["inputs"][target_slot]["type"] == kind
        assert nodes[target]["inputs"][target_slot]["link"] == link_id


def test_api_fields_match_saved_live_object_info():
    if not OBJECT_INFO_PATH:
        pytest.skip("QWEN21_OBJECT_INFO_FIXTURE is not set")
    fixture = Path(OBJECT_INFO_PATH)
    if not fixture.is_file():
        pytest.fail(f"QWEN21_OBJECT_INFO_FIXTURE does not exist: {fixture}")
    info = json.loads(fixture.read_text(encoding="utf-8"))
    workflow = json.loads(API_PATH.read_text(encoding="utf-8"))
    for node in workflow.values():
        schema = info[node["class_type"]]["input"]
        allowed = set(schema.get("required", {})) | set(schema.get("optional", {}))
        for field in node["inputs"]:
            if field.startswith("images.image_"):
                assert "images" in allowed
            else:
                assert field in allowed, (node["class_type"], field)


def test_black_mask_passthrough_writes_one_output_and_timing(monkeypatch, tmp_path):
    runner = load_runner()
    comfy = tmp_path / "ComfyUI"
    pair = comfy / "input" / "batch" / "pair"
    masks = comfy / "input" / "batch" / "pair_mask"
    pair.mkdir(parents=True)
    masks.mkdir(parents=True)
    Image.new("RGB", (16, 12), "white").save(pair / "page.png")
    Image.new("L", (16, 12), 0).save(masks / "page.png")
    monkeypatch.setattr(
        runner,
        "preflight",
        lambda *_args: pytest.fail("all-black batch must not require ComfyUI"),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(RUNNER_PATH),
            "--comfy-root",
            str(comfy),
            "--url",
            "http://unused",
            "--workflow",
            str(API_PATH),
            "--input-root",
            "batch",
            "--output-prefix",
            "job_qwen_",
            "--log-dir",
            str(tmp_path / "logs"),
        ],
    )
    runner.main()
    output = comfy / "output/job_qwen_page_00001_.png"
    assert output.is_file()
    with Image.open(output) as image:
        assert image.mode == "RGB"
        assert image.size == (16, 12)
    timing = tmp_path / "logs/qwen21_job_qwen_timings.jsonl"
    record = json.loads(timing.read_text(encoding="utf-8"))
    assert record["status"] == "completed"
    assert record["empty_mask_passthrough"] is True
    assert record["outputs"] == [output.name]


def test_all_pairs_are_validated_before_preflight(monkeypatch, tmp_path):
    runner = load_runner()
    comfy = tmp_path / "ComfyUI"
    pair = comfy / "input" / "batch" / "pair"
    masks = comfy / "input" / "batch" / "pair_mask"
    pair.mkdir(parents=True)
    masks.mkdir(parents=True)
    Image.new("RGB", (16, 12), "white").save(pair / "a.png")
    Image.new("L", (15, 12), 255).save(masks / "a.png")
    called = False

    def fake_preflight(*_args):
        nonlocal called
        called = True

    monkeypatch.setattr(runner, "preflight", fake_preflight)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(RUNNER_PATH),
            "--comfy-root",
            str(comfy),
            "--workflow",
            str(API_PATH),
            "--input-root",
            "batch",
            "--output-prefix",
            "job_qwen_",
        ],
    )
    with pytest.raises(ValueError, match="size mismatch"):
        runner.main()
    assert called is False
    assert not list((comfy / "output").iterdir())


def test_duplicate_source_stem_is_rejected_and_appledouble_is_ignored(tmp_path):
    runner = load_runner()
    input_dir = tmp_path / "input"
    pair = input_dir / "batch/pair"
    masks = input_dir / "batch/pair_mask"
    pair.mkdir(parents=True)
    masks.mkdir(parents=True)
    Image.new("RGB", (8, 8)).save(pair / "page.png")
    Image.new("RGB", (8, 8)).save(pair / "page.jpg")
    (pair / "._ignored.png").write_bytes(b"not an image")
    Image.new("L", (8, 8)).save(masks / "page.png")
    with pytest.raises(ValueError, match="duplicate source stem"):
        runner.paired_inputs(input_dir, "batch")


def test_prepared_inputs_normalize_grayscale_source_and_mask(tmp_path):
    runner = load_runner()
    input_dir = tmp_path / "input"
    pair = input_dir / "batch/pair"
    masks = input_dir / "batch/pair_mask"
    pair.mkdir(parents=True)
    masks.mkdir(parents=True)
    Image.new("L", (8, 8), 127).save(pair / "page.png")
    mask = Image.new("L", (8, 8), 127)
    mask.putpixel((2, 2), 128)
    mask.save(masks / "page.png")
    batch = runner.paired_inputs(input_dir, "batch")
    prepared = runner.prepare_inputs(input_dir, "batch", batch)
    source_name, mask_name = prepared["page"]
    with Image.open(input_dir / source_name) as source:
        assert source.mode == "RGB"
    with Image.open(input_dir / mask_name) as normalized_mask:
        assert normalized_mask.mode == "L"
        assert set(normalized_mask.getdata()) == {0, 255}


def test_summary_records_first_average_and_warm_average(tmp_path):
    runner = load_runner()
    log_path = tmp_path / "timings.jsonl"
    rows = [
        {"stem": "first", "workflow_sha256": "hash", "status": "completed", "started_at": "1", "elapsed_seconds": 10.0, "execution_seconds": 9.0},
        {"stem": "second", "workflow_sha256": "hash", "status": "completed", "started_at": "2", "elapsed_seconds": 6.0, "execution_seconds": 5.0},
        {"stem": "black", "workflow_sha256": "hash", "status": "completed", "started_at": "3", "elapsed_seconds": 0.1, "empty_mask_passthrough": True},
    ]
    log_path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
    runner.write_summary(log_path, "hash")
    summary = json.loads((tmp_path / "timings_summary.json").read_text(encoding="utf-8"))
    assert summary["generated_count"] == 2
    assert summary["metrics"]["elapsed_seconds"] == {
        "first": 10.0,
        "average": 8.0,
        "average_excluding_first": 6.0,
        "count": 2,
    }


def test_fully_skipped_batch_does_not_require_comfyui(monkeypatch, tmp_path):
    runner = load_runner()
    comfy = tmp_path / "ComfyUI"
    pair = comfy / "input/batch/pair"
    masks = comfy / "input/batch/pair_mask"
    output = comfy / "output"
    pair.mkdir(parents=True)
    masks.mkdir(parents=True)
    output.mkdir(parents=True)
    Image.new("RGB", (8, 8), "white").save(pair / "page.png")
    Image.new("L", (8, 8), 255).save(masks / "page.png")
    Image.new("RGB", (8, 8), "white").save(output / "job_qwen_page_00001_.png")
    monkeypatch.setattr(
        runner,
        "preflight",
        lambda *_args: pytest.fail("fully skipped batch must not require ComfyUI"),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(RUNNER_PATH),
            "--comfy-root",
            str(comfy),
            "--workflow",
            str(API_PATH),
            "--input-root",
            "batch",
            "--output-prefix",
            "job_qwen_",
            "--skip",
        ],
    )
    runner.main()
    assert not (comfy / "input/batch/_qwen21_prepared").exists()
