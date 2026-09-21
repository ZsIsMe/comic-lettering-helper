#!/usr/bin/env python3
"""One-shot generator for the checked-in Qwen 2.1 UI workflow JSON files."""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROMPT = (
    "移除遮罩区域内的漫画拟声词、效果字和残留笔画。根据遮罩边缘实际可见的线稿、网点、"
    "黑白块、灰度与阴影，自然补全被遮挡的黑白漫画内容，保持原有画风、人物、物体和构图一致；"
    "遮罩外区域保持不变，不添加文字或新的画面元素。"
)


def port(name, kind, link=None, widget=False, shape=None):
    value = {"name": name, "type": kind, "link": link}
    if widget:
        value["widget"] = {"name": name}
    if shape is not None:
        value["shape"] = shape
    return value


def output(name, kind, links):
    return {"name": name, "type": kind, "links": links or None}


def node(node_id, kind, pos, inputs, outputs, widgets=None, size=(280, 120), title=None, cnr="comfy-core"):
    value = {
        "id": node_id,
        "type": kind,
        "pos": list(pos),
        "size": list(size),
        "flags": {},
        "order": node_id,
        "mode": 0,
        "inputs": inputs,
        "outputs": outputs,
        "properties": {"cnr_id": cnr, "Node name for S&R": kind},
        "widgets_values": widgets or [],
    }
    if title:
        value["title"] = title
    return value


def workflow(handpaint: bool) -> dict:
    links = []

    def link(link_id, source, source_slot, target, target_slot, kind):
        links.append([link_id, source, source_slot, target, target_slot, kind])

    nodes = [
        node(1, "LoadImage", (-1100, 100), [], [output("IMAGE", "IMAGE", [1, 13, 23]), output("MASK", "MASK", [2] if handpaint else [])], ["", "image"], (320, 320), "上傳原圖・右鍵開啟遮罩編輯器" if handpaint else "原圖"),
    ]
    if handpaint:
        link(2, 1, 1, 4, 0, "MASK")
    else:
        nodes.append(node(2, "LoadImage", (-1100, 500), [], [output("IMAGE", "IMAGE", [2]), output("MASK", "MASK", [])], ["", "image"], (320, 320), "獨立黑白 Mask"))
        nodes.append(node(3, "ImageToMask", (-700, 520), [port("image", "IMAGE", 2), port("channel", "COMBO", None, True)], [output("MASK", "MASK", [3])], ["red"], (240, 90)))
        link(2, 2, 0, 3, 0, "IMAGE")
        link(3, 3, 0, 4, 0, "MASK")
    nodes.extend([
        node(4, "ThresholdMask", (-400, 500), [port("mask", "MASK", 2 if handpaint else 3), port("value", "FLOAT", None, True)], [output("MASK", "MASK", [4])], [0.5], (240, 90), "Mask 二值化 0.5"),
        node(5, "GrowMaskWithBlur", (-100, 500), [port("mask", "MASK", 4)], [output("mask", "MASK", [5]), output("mask_inverted", "MASK", [])], [0, 0, True, False, 0, 1, 1, True], (290, 245), "填補 Mask 內洞", "comfyui-kjnodes"),
        node(6, "GrowMask", (260, 500), [port("mask", "MASK", 5), port("expand", "INT", None, True), port("tapered_corners", "BOOLEAN", None, True)], [output("MASK", "MASK", [6, 24])], [8, True], (250, 110), "外擴 8px・斜角收尖"),
        node(7, "MaskToImage", (580, 500), [port("mask", "MASK", 6)], [output("IMAGE", "IMAGE", [7])], [], (230, 70), "Mask 參考圖"),
        node(8, "UNETLoader", (-700, -400), [], [output("MODEL", "MODEL", [8])], ["qwen_image_2.1_int8_convrot.safetensors", "default"], (480, 90)),
        node(9, "CLIPLoader", (-700, -250), [], [output("CLIP", "CLIP", [9])], ["qwen3vl_8b_int8_convrot.safetensors", "qwen_image", "default"], (480, 120)),
        node(10, "VAELoader", (-700, -60), [], [output("VAE", "VAE", [10, 17])], ["qwen_image_2.1_vae_bf16.safetensors"], (480, 70)),
        node(11, "QwenImage21Cache", (-100, -400), [port("model", "MODEL", 8), port("device", "COMBO", None, True), port("dtype", "COMBO", None, True)], [output("MODEL", "MODEL", [11])], ["auto", "default"], (280, 100)),
    ])
    text_inputs = [
        port("clip", "CLIP", 9),
        port("images.image_1", "IMAGE", 1, shape=7),
        port("vae", "VAE", 10, shape=7),
        port("prompt", "STRING", None, True),
        port("negative_prompt", "STRING", None, True),
        port("resolution", "INT", None, True),
        port("images.image_10", "IMAGE", None, shape=7),
        port("images.image_11", "IMAGE", None, shape=7),
        port("images.image_12", "IMAGE", None, shape=7),
        port("images.image_2", "IMAGE", 7, shape=7),
        port("images.image_3", "IMAGE", None, shape=7),
        port("images.image_4", "IMAGE", None, shape=7),
        port("images.image_5", "IMAGE", None, shape=7),
        port("images.image_6", "IMAGE", None, shape=7),
        port("images.image_7", "IMAGE", None, shape=7),
        port("images.image_8", "IMAGE", None, shape=7),
        port("images.image_9", "IMAGE", None, shape=7),
    ]
    nodes.extend([
        node(12, "TextEncodeQwenImage21", (880, 80), text_inputs, [output("positive", "CONDITIONING", [12]), output("negative", "CONDITIONING", [14]), output("latent", "LATENT", [15])], [PROMPT, "", 0], (520, 560), "固定漫畫補洞提示詞・resolution 0"),
        node(13, "KSampler", (1500, 30), [port("model", "MODEL", 11), port("positive", "CONDITIONING", 12), port("negative", "CONDITIONING", 14), port("latent_image", "LATENT", 15), port("seed", "INT", None, True), port("steps", "INT", None, True), port("cfg", "FLOAT", None, True), port("sampler_name", "COMBO", None, True), port("scheduler", "COMBO", None, True), port("denoise", "FLOAT", None, True)], [output("LATENT", "LATENT", [16])], [0, "randomize", 25, 1, "euler", "simple", 1], (300, 270)),
        node(14, "VAEDecode", (1880, 40), [port("samples", "LATENT", 16), port("vae", "VAE", 17)], [output("IMAGE", "IMAGE", [18])], [], (230, 70)),
        node(15, "SplitImageWithAlpha", (2180, 40), [port("image", "IMAGE", 18)], [output("IMAGE", "IMAGE", [19]), output("MASK", "MASK", [])], [], (250, 70), "只取生成 RGB"),
        node(16, "GetImageSize", (-700, 160), [port("image", "IMAGE", 13)], [output("width", "INT", [20]), output("height", "INT", [21]), output("batch_size", "INT", [])], [], (200, 120), "原圖尺寸"),
        node(17, "ImageScale", (2500, 40), [port("image", "IMAGE", 19), port("upscale_method", "COMBO", None, True), port("width", "INT", 20, True), port("height", "INT", 21, True), port("crop", "COMBO", None, True)], [output("IMAGE", "IMAGE", [22])], ["lanczos", 512, 512, "disabled"], (300, 160), "Lanczos 還原原尺寸"),
        node(18, "ImageCompositeMasked", (2860, 40), [port("destination", "IMAGE", 23), port("source", "IMAGE", 22), port("x", "INT", None, True), port("y", "INT", None, True), port("resize_source", "BOOLEAN", None, True), port("mask", "MASK", 24)], [output("IMAGE", "IMAGE", [25])], [0, 0, False], (310, 190), "僅在處理後 Mask 內貼回"),
        node(19, "SaveImage", (3250, 40), [port("images", "IMAGE", 25)], [], ["qwen21_int8_manga"], (420, 380), "唯一最終結果"),
    ])
    for args in [
        (1, 1, 0, 12, 1, "IMAGE"), (4, 4, 0, 5, 0, "MASK"),
        (5, 5, 0, 6, 0, "MASK"), (6, 6, 0, 7, 0, "MASK"),
        (7, 7, 0, 12, 9, "IMAGE"), (8, 8, 0, 11, 0, "MODEL"),
        (9, 9, 0, 12, 0, "CLIP"), (10, 10, 0, 12, 2, "VAE"),
        (11, 11, 0, 13, 0, "MODEL"), (12, 12, 0, 13, 1, "CONDITIONING"),
        (14, 12, 1, 13, 2, "CONDITIONING"), (15, 12, 2, 13, 3, "LATENT"),
        (16, 13, 0, 14, 0, "LATENT"), (17, 10, 0, 14, 1, "VAE"),
        (18, 14, 0, 15, 0, "IMAGE"), (13, 1, 0, 16, 0, "IMAGE"),
        (19, 15, 0, 17, 0, "IMAGE"), (20, 16, 0, 17, 2, "INT"),
        (21, 16, 1, 17, 3, "INT"), (22, 17, 0, 18, 1, "IMAGE"),
        (23, 1, 0, 18, 0, "IMAGE"), (24, 6, 0, 18, 5, "MASK"),
        (25, 18, 0, 19, 0, "IMAGE"),
    ]:
        link(*args)
    if handpaint:
        note = (
            "## Qwen Image 2.1 INT8 手塗去字\n\n"
            "1. 上傳原圖，右鍵開啟遮罩編輯器。\n"
            "2. 塗白要修復的文字區域並保存到節點。\n"
            "3. 工作流會先二值化、補洞並外擴 8px，再用原圖與 Mask 參考圖生成。\n"
            "4. 最終只把處理後 Mask 內的 RGB 貼回原圖。未塗抹時不要執行。\n\n"
            "固定使用 Qwen Image 2.1 INT8、25 steps、CFG 1、Euler/simple、resolution 0；不使用 LanPaint。"
        )
        nodes.append(node(20, "MarkdownNote", (-1100, 880), [], [], [note], (620, 310)))
    return {
        "id": "8f333143-1c0f-45fa-b33c-16f10d6baa21" if handpaint else "9185edab-173f-4271-9fa5-b08fe3413d54",
        "revision": 0,
        "last_node_id": 20 if handpaint else 19,
        "last_link_id": 25,
        "nodes": sorted(nodes, key=lambda item: item["id"]),
        "links": sorted(links, key=lambda item: item[0]),
        "groups": [],
        "config": {},
        "extra": {"ds": {"scale": 0.7, "offset": [1250, 500]}},
        "version": 0.4,
    }


def main():
    targets = [
        (ROOT / "workflows/Qwen-Image-2.1-INT8-Manga.json", False),
        (ROOT / "workflows/handpaint/Qwen手塗去字.json", True),
    ]
    for path, handpaint in targets:
        path.write_text(json.dumps(workflow(handpaint), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
