"""Read saved execution evidence for the Chinese comparison-PDF cover.

Never query the PDF generator's host: it may not be the inference machine.
"""
from __future__ import annotations

import csv
import json
import math
from datetime import datetime, timezone, timedelta
from pathlib import Path

WORKFLOWS = (
    ('flux2klein_lanpaint', 'Flux2 Klein＋LanPaint'),
    ('firered', 'FireRed FP8'),
    ('qwen2511_lanpaint', 'Qwen Image 2.1 INT8'),
)


def read_json(path):
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (TypeError, ValueError):
        return None


def read_rows(path):
    try:
        lines = path.read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError:
        return []
    rows = []
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            rows.append(row)
    return rows


def seconds(value):
    value = number(value)
    if value is None:
        return '未記錄'
    if value < 60:
        return f'{value:.2f} 秒'
    minutes, remainder = divmod(round(value), 60)
    hours, minutes = divmod(minutes, 60)
    return (f'{hours} 小時 ' if hours else '') + f'{minutes} 分 {remainder} 秒'


def memory(value):
    value = number(value)
    return f'{value / 1024:.2f} GiB' if value is not None else '未記錄'


def date_text(value):
    try:
        stamp = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        if stamp.tzinfo is None:
            return str(value) + '（時區未記錄）'
        return stamp.astimezone(timezone(timedelta(hours=8))).strftime('%Y年%m月%d日 %H:%M:%S（北京時間）')
    except ValueError:
        return '未記錄'


def collect_report(root, logs_dir=None, job_file=None, environment_file=None, counts=None, model_files=None, prompts=None):
    root = Path(root)
    logs = Path(logs_dir) if logs_dir else root / 'logs'
    job = read_json(job_file or root / 'job.json')
    environment = read_json(environment_file or logs / 'environment.json')
    if not environment and environment_file is None:
        for workflow, _ in WORKFLOWS:
            environment = read_json(logs / f'{workflow}_environment.json')
            if environment:
                break
    report = {'name': job.get('name') or root.name, 'created_at': date_text(job.get('created_at')),
              'pair_count': (counts or {}).get('pairs', job.get('pair_count')),
              'black_count': (counts or {}).get('black', job.get('black_mask_count')),
              'environment': environment, 'models': [], 'notes': []}
    gpu_names, totals = set(), []
    for workflow, label in WORKFLOWS:
        summary = read_json(logs / f'{workflow}_vram_summary.json')
        progress = job.get('workflow_progress', {}).get(workflow, {})
        previous = read_rows(logs / 'before-auto-recovery' / f'{workflow}.log')
        rows = previous + read_rows(logs / f'{workflow}.log')
        successful = {}
        failures = 0
        for row in rows:
            if row.get('status') == 'failed':
                failures += 1
            if row.get('status') == 'completed' and isinstance(row.get('stem'), str):
                successful[row['stem']] = row
        generated = [row for row in successful.values() if not row.get('empty_mask_passthrough')]
        samples = {stem: value for stem, raw in progress.get('timing_samples', {}).items()
                   if (value := number(raw)) is not None}
        for row in generated:
            value = number(row.get('elapsed_seconds'))
            if value is not None:
                samples[row['stem']] = value
        durations = list(samples.values())
        if any(row.get('model') == 'qwenlanpaint' for row in rows):
            label = 'Qwen Image Edit 2511＋LanPaint'
        first = durations[0] if durations else number(progress.get('first_seconds'))
        warm = sum(durations[1:]) / len(durations[1:]) if len(durations) > 1 else number(progress.get('warm_average_seconds'))
        average = sum(durations) / len(durations) if durations else None
        used = []
        try:
            with (logs / f'{workflow}_vram.csv').open(encoding='utf-8', newline='') as handle:
                for sample in csv.DictReader(handle):
                    if sample.get('gpu_name'):
                        gpu_names.add(sample['gpu_name'])
                    total = number(sample.get('memory_total_mib'))
                    if total is not None:
                        totals.append(total)
                    value = number(sample.get('memory_used_mib'))
                    if value is not None:
                        used.append(value)
        except (OSError, csv.Error, UnicodeDecodeError):
            pass
        gpu_names.update(name for name in summary.get('gpu_names', []) if isinstance(name, str))
        total = number(summary.get('memory_total_mib'))
        if total is not None:
            totals.append(total)
        peak = number(summary.get('memory_used_peak_mib'))
        mean = number(summary.get('memory_used_mean_mib'))
        elapsed = number(summary.get('elapsed_seconds'))
        if elapsed is None and progress.get('state') == 'completed':
            elapsed = number(progress.get('elapsed_seconds'))
        counts_for_model = (counts or {}).get('results', {}).get(workflow)
        recorded_count = max(len(successful), progress.get('completed', 0)) if successful or progress else None
        completed = counts_for_model if counts_for_model is not None else recorded_count
        passthrough = max(sum(bool(row.get('empty_mask_passthrough')) for row in successful.values()), progress.get('passthrough', 0)) if successful or progress else None
        if previous or len(samples) > len(generated):
            report['notes'].append(f'{label} 曾續跑；耗時平均合併現存成功紀錄，總耗時及顯存僅列最近一次執行。')
        report['models'].append(dict(name=label, prompts=(prompts or {}).get(workflow, {}), model_file=(model_files or {}).get(workflow) or '未記錄', completed=completed, passthrough=passthrough,
            first=first, warm=warm, average=average, elapsed=elapsed,
            peak=peak if peak is not None else max(used) if used else None,
            mean=mean if mean is not None else sum(used) / len(used) if used else None,
            samples=len(durations), failures=failures if rows else None))
    report['gpu_names'] = '、'.join(sorted(gpu_names)) or environment.get('gpu_name') or '未記錄'
    report['gpu_total'] = memory(max(totals) if totals else environment.get('gpu_memory_total_mib'))
    return report



def diffusion_model_files(paths):
    from PIL import Image
    names = set()
    for path in paths:
        try:
            with Image.open(path) as image:
                prompt = json.loads(image.info.get('prompt', '{}'))
            if not isinstance(prompt, dict):
                continue
            for node in prompt.values():
                if not isinstance(node, dict):
                    continue
                kind = str(node.get('class_type', '')).lower()
                if not any(token in kind for token in ('unet', 'checkpoint', 'diffusion')):
                    continue
                for key in ('unet_name', 'ckpt_name', 'model_name', 'model_path'):
                    value = node.get('inputs', {}).get(key)
                    if isinstance(value, str) and value:
                        names.add(value.replace('\\', '/').rsplit('/', 1)[-1])
        except (OSError, ValueError, TypeError):
            continue
    return '、'.join(sorted(names)) or '未記錄'


def saved_prompts(paths):
    from PIL import Image
    texts = {'positive': [], 'negative': []}
    found = False
    for path in paths:
        try:
            with Image.open(path) as image:
                graph = json.loads(image.info.get('prompt', '{}'))
            if not isinstance(graph, dict):
                continue
        except (OSError, ValueError, TypeError):
            continue

        def visit(link, role, seen):
            nonlocal found
            if not isinstance(link, list) or len(link) != 2:
                return
            key = str(link[0])
            if key in seen:
                return
            node = graph.get(key, {})
            inputs = node.get('inputs', {})
            kind = str(node.get('class_type', '')).lower()
            if 'textencode' in kind:
                found = True
                if kind == 'textencodeqwenimage21':
                    value = inputs.get('negative_prompt' if role == 'negative' else 'prompt')
                else:
                    value = inputs.get('prompt', inputs.get('text'))
                if isinstance(value, str) and value.strip() and value not in texts[role]:
                    texts[role].append(value)
                return
            for name in ('conditioning', 'positive', 'negative'):
                if name in inputs:
                    visit(inputs[name], role, seen | {key})

        for node in graph.values():
            if not isinstance(node, dict):
                continue
            for name, link in node.get('inputs', {}).items():
                if name in ('positive', 'negative', 'conditioning'):
                    visit(link, 'negative' if name == 'negative' else 'positive', set())
    return {role: '\n'.join(values) for role, values in texts.items()} if found else {}

def cover_lines(report):
    def value(item):
        return '未記錄' if item is None else str(item)
    lines = [
        '漫畫去字修復報告',
        '任務：' + report['name'],
        '日期：' + report['created_at'],
        f"圖片：{value(report['pair_count'])} 張；全黑 Mask：{value(report['black_count'])} 張",
        'GPU：' + report['gpu_names'],
        '顯存：' + report['gpu_total'] + '；系統記憶體：' + memory(report['environment'].get('ram_total_mib')),
        '',
    ]
    for model in report['models']:
        lines += [
            model['name'],
            '繪圖模型：' + model['model_file'],
            '首圖：' + seconds(model['first']) + '；非首圖平均：' + seconds(model['warm']) + '／張',
            '總耗時：' + seconds(model['elapsed']) + '；峰值顯存：' + memory(model['peak']),
        ]
        prompts = model.get('prompts', {})
        lines.append('提示詞：' + (prompts.get('positive', '未記錄') or '空白'))
        if prompts.get('negative'):
            lines.append('負向提示詞：' + prompts['negative'])
        lines.append('')
    lines += ['直通、跳過與失敗不計入生成平均；顯存為整卡採樣占用。',
              '缺少歷史資料顯示「未記錄」。'] + report['notes']
    return lines


def draw_cover(report, width, height, load_font):
    """Plain black text on white, with complete wrapped filenames and no decoration."""
    from PIL import Image, ImageDraw
    page = Image.new('RGB', (width, height), 'white')
    draw = ImageDraw.Draw(page)
    margin = 110
    lines = cover_lines(report)
    # Fit all text on one cover; start generously and retain readable CJK text.
    for size in (44, 42, 40, 38, 36, 34, 32):
        font = load_font(size)
        wrapped = []
        for line in lines:
            current = ''
            for char in line:
                if current and draw.textlength(current + char, font=font) > width - margin * 2:
                    wrapped.append(current); current = ''
                current += char
            wrapped.append(current)
        spacing = int(size * 1.7)
        if len(wrapped) * spacing <= height - margin * 2:
            break
    else:
        raise ValueError('報告文字超出單頁，請精簡任務名稱或備註。')
    for index, line in enumerate(wrapped):
        draw.text((margin, margin + index * spacing), line, font=font, fill='black')
    return page


def capture_environment(comfy_url=None):
    """Capture the execution host once, never its credentials or external addresses."""
    import platform
    import subprocess
    import urllib.request
    from importlib.metadata import PackageNotFoundError, version

    data = {'recorded_at': datetime.now(timezone.utc).isoformat(),
            'os': platform.platform(), 'python_version': platform.python_version(),
            'app_version': read_json(Path(__file__).resolve().parents[1] / 'config/runtime.json').get('app_version')}
    try:
        for line in Path('/proc/cpuinfo').read_text().splitlines():
            if line.startswith('model name'):
                data['cpu_model'] = line.split(':', 1)[1].strip()
                break
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemTotal:'):
                data['ram_total_mib'] = int(line.split()[1]) / 1024
                break
        # Prefer the container's assigned RAM limit when lower than the host total.
        for name in ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']:
            try:
                limit = int(Path(name).read_text().strip()) / 1024**2
                if limit > 0:
                    data['ram_total_mib'] = min(data.get('ram_total_mib', limit), limit)
            except (OSError, ValueError):
                pass
    except (OSError, ValueError):
        pass
    try:
        data['pytorch_version'] = version('torch')
    except PackageNotFoundError:
        pass
    try:
        result = subprocess.run(['nvidia-smi', '--query-gpu=driver_version', '--format=csv,noheader'],
                                capture_output=True, text=True, timeout=3, check=True)
        data['driver_version'] = '、'.join(sorted(set(result.stdout.strip().splitlines())))
    except (OSError, subprocess.SubprocessError):
        pass
    if comfy_url:
        try:
            with urllib.request.urlopen(comfy_url.rstrip('/') + '/system_stats', timeout=3) as response:
                system = json.load(response).get('system', {})
            for field in ['comfyui_version', 'pytorch_version']:
                if system.get(field):
                    data[field] = system[field]
            if number(system.get('ram_total')) is not None:
                data['ram_total_mib'] = float(system['ram_total']) / 1024**2
        except (OSError, ValueError, AttributeError):
            pass
    # Read the installed torch build's static version constants without importing torch.
    # CUDA driver support is not the same as the CUDA runtime used by PyTorch.
    try:
        import ast
        from importlib.metadata import distribution
        source = Path(distribution('torch').locate_file('torch/version.py')).read_text()
        for node in ast.parse(source).body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'cuda' for t in node.targets):
                data['cuda_version'] = ast.literal_eval(node.value)
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == 'cuda':
                data['cuda_version'] = ast.literal_eval(node.value)
    except (PackageNotFoundError, OSError, ValueError, SyntaxError):
        pass
    return data
