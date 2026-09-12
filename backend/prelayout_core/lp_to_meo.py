#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# python3 lp_to_meo.py 輸入.txt
# python3 lp_to_meo.py 輸入.txt 輸出.json
# # 不產生過濾檔
# python3 lp_to_meo.py 輸入.txt --no-filter
# # 改為只留 groupId=0（MEO 為 0-based，對應 LP 第 1 群組）
# python3 lp_to_meo.py 輸入.txt --filter-group 0
"""
LP格式(.txt) 轉換為 MEO格式(.json) 的腳本

LP格式常量：
  PIC_START   = ">>>>>>>>[" (8個>)
  PIC_END     = "]<<<<<<<<"
  LABEL_START = "----------------[" (16個-)
  LABEL_END   = "]----------------"
  SEPARATOR   = "-"

MEO格式為JSON，結構：
  {
    "version": [1, 0],
    "comment": "...",
    "groupList": [{ "name": "...", "color": "FF0000", "font-size": -1.0, "text-direction": "horizontal" }],
    "transMap": {
      "pic.jpg": [{ "index": 1, "groupId": 0, "x": 0.1234, "y": 0.5678, "text": "..." }]
    }
  }

用法：
  python lp_to_meo.py <輸入.txt> [輸出.json] [--no-filter] [--filter-group N]

轉換完成後預設另存一份僅含指定 groupId 的 transMap（與 MEO 內 0-based 的 groupId 一致，預設 1）：
  若輸入為 翻譯.txt，主檔為 翻譯_meo.json，過濾檔為 翻譯_meo.框外.json
"""

import argparse
import json
import re
import sys
from pathlib import Path

# LP 格式常量（與 TransFileConstants.kt 一致）
PIC_START   = ">>>>>>>>[";  PIC_END   = "]<<<<<<<<"
LABEL_START = "----------------["; LABEL_END = "]----------------"
SEPARATOR   = "-"

# 各群組預設顏色（與 TransFile.kt 中 DEFAULT_COLOR_HEX_LIST 一致）
DEFAULT_COLOR_HEX_LIST = [
    "FF0000", "0000FF", "008000",
    "1E90FF", "FFD700", "FF00FF",
    "A0522D", "FF4500", "9400D3",
]


def _parse_lp(lines: list[str]) -> dict:
    """解析LP格式內容，返回與MEO結構相同的dict。"""
    line_count = len(lines)
    ptr = [0]  # 使用list讓巢狀函數可修改

    def parse_text(*stop_marks: str) -> str:
        """從當前行逐行讀取文字，遇到任一stop_mark前綴時停止。"""
        buf = []
        while ptr[0] < line_count:
            line = lines[ptr[0]]
            if any(line.startswith(m) for m in stop_marks):
                break
            buf.append(line)
            ptr[0] += 1
        text = "\n".join(buf)
        text = re.sub(r"\n+", "\n", text).strip()
        return text

    def parse_label(index: int) -> dict:
        """解析一個標籤行及其後的文字內容。"""
        line = lines[ptr[0]]
        # 格式：----------------[N]----------------[x,y,groupId]
        after_index = line.split(LABEL_END, 1)[1]
        prop_str = after_index.strip().lstrip("[").rstrip("]")
        props = [p.strip() for p in prop_str.split(",")]

        x        = float(props[0])
        y        = float(props[1])
        group_id = int(props[2]) - 1  # LP存1-based，MEO用0-based

        ptr[0] += 1
        text = parse_text(PIC_START, LABEL_START)

        return {"index": index, "groupId": group_id, "x": x, "y": y, "text": text}

    def parse_pic_head() -> str:
        """解析圖片名稱行，格式：>>>>>>>>[picName]<<<<<<<<"""
        line = lines[ptr[0]]
        pic_name = line.replace(PIC_START, "").replace(PIC_END, "")
        ptr[0] += 1
        return pic_name

    def parse_pic_body() -> list:
        """解析一張圖片下的全部標籤，完成後將指標移到下一個PIC_START。"""
        index  = 0
        labels = []
        while ptr[0] < line_count and lines[ptr[0]].startswith(LABEL_START):
            index += 1
            labels.append(parse_label(index))
        # 跳過空行，移到下一個PIC_START
        while ptr[0] < line_count and not lines[ptr[0]].startswith(PIC_START):
            ptr[0] += 1
        return labels

    # --- 主解析流程 ---

    # 版本行：格式 "1, 0"
    v_parts = [p.strip() for p in lines[ptr[0]].split(",")]
    if len(v_parts) != 2 or not all(p.isdigit() for p in v_parts):
        raise ValueError(f"無效的版本行：{lines[ptr[0]]!r}")
    version = [int(v_parts[0]), int(v_parts[1])]
    ptr[0] += 1

    # 分隔符
    ptr[0] += 1

    # 群組列表（最多9個，直到遇到 SEPARATOR 行）
    group_list = []
    while ptr[0] < line_count and lines[ptr[0]] != SEPARATOR and len(group_list) < 9:
        name = lines[ptr[0]]
        if not name.strip():
            raise ValueError("群組名稱不能為空白")
        group_list.append({
            "name":           name,
            "color":          DEFAULT_COLOR_HEX_LIST[len(group_list)],
            "font-size":      -1.0,
            "text-direction": "horizontal",
        })
        ptr[0] += 1

    if ptr[0] >= line_count or lines[ptr[0]] != SEPARATOR:
        raise ValueError("群組數量超過上限（最多9個）或缺少分隔符")
    ptr[0] += 1

    # 備註（直到第一個PIC_START）
    comment = parse_text(PIC_START)

    # 翻譯內容
    trans_map: dict[str, list] = {}
    while ptr[0] < line_count and lines[ptr[0]].startswith(PIC_START):
        pic_name          = parse_pic_head()
        trans_map[pic_name] = parse_pic_body()

    return {
        "version":   version,
        "comment":   comment,
        "groupList": group_list,
        "transMap":  trans_map,
    }


def _sort_by_digit(names: list[str]) -> list[str]:
    """按數字感知順序排序（對應 Kotlin sortByDigit）。"""
    def key(name: str):
        parts = re.split(r"(\d+)", name)
        return [int(p) if p.isdigit() else p.lower() for p in parts]
    return sorted(names, key=key)


def filter_meo_data_by_group_id(data: dict, group_id: int) -> dict:
    """僅保留 transMap 中 groupId 等於指定值的條目；圖片節點內陣列為空則整張圖不保留。"""
    new_trans: dict[str, list] = {}
    for k, v in data["transMap"].items():
        filtered_v = [item for item in v if item.get("groupId") == group_id]
        if filtered_v:
            new_trans[k] = filtered_v
    return {**data, "transMap": new_trans}


def _default_output_path(src: Path) -> Path:
    """未指定輸出時，將 翻譯.txt 轉為 翻譯_meo.json。"""
    return src.with_name(f"{src.stem}_meo.json")


def _filtered_output_path(dst: Path) -> Path:
    """過濾檔固定使用 .框外.json，避免後續流程誤用群組編號命名。"""
    return dst.with_name(f"{dst.stem}.框外{dst.suffix}")


def convert(
    input_path: str,
    output_path: str | None = None,
    *,
    filter_group_id: int | None = 1,
) -> None:
    """將LP格式的txt文件轉換為MEO格式的JSON文件；可選寫出依 groupId 過濾的第二份 JSON。"""
    src = Path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"找不到輸入文件：{input_path}")

    dst = Path(output_path) if output_path else _default_output_path(src)

    print(f"正在讀取：{src}")

    # 嘗試UTF-8（含BOM），失敗則回退GBK
    try:
        content = src.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        content = src.read_text(encoding="gbk")

    lines = content.splitlines()

    data = _parse_lp(lines)

    # 對 transMap 的圖片名稱按數字感知順序排序
    sorted_keys      = _sort_by_digit(list(data["transMap"].keys()))
    data["transMap"] = {k: data["transMap"][k] for k in sorted_keys}

    dst.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    if filter_group_id is not None:
        filtered = filter_meo_data_by_group_id(data, filter_group_id)
        filtered_path = _filtered_output_path(dst)
        filtered_path.write_text(
            json.dumps(filtered, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        f_labels = sum(len(v) for v in filtered["transMap"].values())
        print(f"  已寫入過濾版（groupId={filter_group_id}）：{filtered_path}（標籤數 {f_labels}）")

    total_labels = sum(len(v) for v in data["transMap"].values())
    print(f"轉換完成！輸出至：{dst}")
    print(f"  版本：{data['version']}")
    print(f"  備註：{data['comment'][:30]!r}{'...' if len(data['comment']) > 30 else ''}")
    print(f"  群組數：{len(data['groupList'])}")
    print(f"  圖片數：{len(data['transMap'])}")
    print(f"  標籤總數：{total_labels}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="LP 轉 MEO（JSON），並可選產生僅含指定群組的過濾 JSON",
    )
    parser.add_argument("input", help="輸入 .txt")
    parser.add_argument("output", nargs="?", default=None, help="輸出 .json（預設為 <輸入主檔名>_meo.json）")
    parser.add_argument(
        "--no-filter",
        action="store_true",
        help="不產生 *.框外.json",
    )
    parser.add_argument(
        "--filter-group",
        type=int,
        default=1,
        metavar="N",
        help="過濾檔僅保留 transMap 中 groupId 為 N 的條目（MEO 為 0-based，預設 1）",
    )
    args = parser.parse_args()

    try:
        convert(
            args.input,
            args.output,
            filter_group_id=None if args.no_filter else args.filter_group,
        )
    except Exception as e:
        print(f"錯誤：{e}", file=sys.stderr)
        sys.exit(1)
