import importlib.util
import json
import sys
from pathlib import Path
import pytest

TOOLS = Path(__file__).resolve().parents[2] / 'runtime-tools'
spec = importlib.util.spec_from_file_location('report_summary_test', TOOLS / 'inpaint_report_summary.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def test_saved_logs_recover_overwritten_statistics_and_exclude_passthrough(tmp_path):
    logs = tmp_path / 'logs'; logs.mkdir()
    rows = [
        {'stem': 'black', 'status': 'completed', 'empty_mask_passthrough': True, 'elapsed_seconds': 0.1},
        {'stem': 'a', 'status': 'completed', 'elapsed_seconds': 90},
        {'stem': 'b', 'status': 'failed', 'elapsed_seconds': 1000},
        {'stem': 'b', 'status': 'completed', 'elapsed_seconds': 30},
    ]
    (logs / 'flux2klein_lanpaint.log').write_text('warning\n' + '\n'.join(map(json.dumps, rows)))
    (logs / 'flux2klein_lanpaint_vram_summary.json').write_text(json.dumps({
        'gpu_names': ['Test GPU'], 'memory_total_mib': 32768,
        'memory_used_peak_mib': 24576, 'memory_used_mean_mib': 16384, 'elapsed_seconds': 130,
    }))
    data = report.collect_report(tmp_path)
    model = data['models'][0]
    assert model['completed'] == 3
    assert model['passthrough'] == 1
    assert (model['first'], model['warm'], model['average'], model['elapsed']) == (90, 30, 60, 130)
    assert model['failures'] == 1
    assert data['gpu_names'] == 'Test GPU'
    assert data['gpu_total'] == '32.00 GiB'
    assert model['peak'] == 24576
    assert data['environment'] == {}


def test_missing_data_is_not_zero_or_pdf_hosts_environment(tmp_path):
    data = report.collect_report(tmp_path)
    assert data['gpu_names'] == 'Not recorded'
    assert data['models'][0]['first'] is None
    assert data['models'][0]['elapsed'] is None
    assert report.seconds(None) == 'Not recorded'
    assert report.memory(None) == 'Not recorded'
    assert report.seconds(0) == '0.00 s'


def test_explicit_saved_environment_csv_and_legacy_model(tmp_path):
    logs = tmp_path / 'logs'; logs.mkdir()
    (logs / 'environment.json').write_text(json.dumps({'cpu_model': 'Saved CPU', 'os': 'Saved OS'}))
    (logs / 'qwen2511_lanpaint.log').write_text(json.dumps({'model': 'qwenlanpaint', 'stem': 'a', 'status': 'completed', 'elapsed_seconds': 10}))
    (logs / 'qwen2511_lanpaint_vram.csv').write_text('gpu_name,memory.total,memory_total_mib,memory_used_mib\nSaved GPU,,32768,1024\nSaved GPU,,32768,3072\n')
    data = report.collect_report(tmp_path)
    assert data['environment']['cpu_model'] == 'Saved CPU'
    assert data['models'][2]['name'] == 'Qwen Image Edit 2511+LanPaint'
    assert data['models'][2]['peak'] == 3072
    assert data['models'][2]['mean'] == 2048


def test_generator_passes_report_before_comparison_pages_without_writing_pdf(tmp_path, monkeypatch):
    # Inspect the source-page sequence at save time, without opening/rendering any PDF.
    from PIL import Image
    monkeypatch.syspath_prepend(str(TOOLS))
    spec = importlib.util.spec_from_file_location('compare_report_test', TOOLS / 'make_three_model_inpaint_compare_pdf.py')
    generator = importlib.util.module_from_spec(spec); spec.loader.exec_module(generator)
    for folder in ['pair', 'pair_mask', 'result_flux2klein_lanpaint', 'result_firered', 'result_qwen2511_lanpaint']:
        path = tmp_path / folder; path.mkdir()
        Image.new('RGB', (8, 8), 'white').save(path / 'edit.png')
        Image.new('RGB', (8, 8), 'black').save(path / 'black.png')
    cover = Image.new('RGB', (16, 16), 'blue')
    captured = {}
    monkeypatch.setattr(generator, 'draw_cover', lambda *args: cover.copy())
    monkeypatch.setattr(generator, '_as_jpeg_image', lambda page: page.copy())
    def save(image, path, **kwargs):
        captured['first_pixel'] = image.getpixel((0, 0))
        captured['following_pages'] = len(kwargs['append_images'])
    monkeypatch.setattr(Image.Image, 'save', save)
    generator.build_pdf(tmp_path, tmp_path / 'out.pdf', .4)
    assert captured == {'first_pixel': (0, 0, 255), 'following_pages': 1}


@pytest.mark.parametrize("workflows", [
    ("firered",),
    ("qwen2511_lanpaint", "flux2klein_lanpaint"),
    ("flux2klein_lanpaint", "firered", "qwen2511_lanpaint"),
])
def test_generator_uses_only_selected_workflow_columns(tmp_path, monkeypatch, workflows):
    from PIL import Image
    monkeypatch.syspath_prepend(str(TOOLS))
    spec = importlib.util.spec_from_file_location('compare_selected_test', TOOLS / 'make_three_model_inpaint_compare_pdf.py')
    generator = importlib.util.module_from_spec(spec); spec.loader.exec_module(generator)
    for folder in ['pair', 'pair_mask', *(f'result_{key}' for key in workflows)]:
        path = tmp_path / folder; path.mkdir()
        Image.new('RGB', (8, 8), 'white').save(path / 'edit.png')
    pasted = []
    monkeypatch.setattr(generator, 'draw_cover', lambda *args: Image.new('RGB', (16, 16)))
    monkeypatch.setattr(generator, '_as_jpeg_image', lambda page: page.copy())
    monkeypatch.setattr(generator, 'paste_centered', lambda canvas, image, box: pasted.append(box))
    monkeypatch.setattr(Image.Image, 'save', lambda *args, **kwargs: None)

    generator.build_pdf(tmp_path, tmp_path / 'out.pdf', .4, workflows=workflows)

    saved = json.loads((tmp_path / 'out.report.json').read_text())
    expected = [key for key in generator.WORKFLOW_LABELS if key in workflows]
    assert [model['name'] for model in saved['models']] == [generator.WORKFLOW_LABELS[key] for key in expected]
    assert len(pasted) == len(workflows) + 1


def test_cover_uses_saved_execution_snapshot(tmp_path):
    logs = tmp_path / 'logs'; logs.mkdir()
    (logs / 'firered_environment.json').write_text(json.dumps({'cpu_model': 'Inference CPU', 'ram_total_mib': 65536, 'cuda_version': '13.0'}))
    data = report.collect_report(tmp_path)
    assert data['environment']['cpu_model'] == 'Inference CPU'
    assert data['environment']['cuda_version'] == '13.0'
    assert report.memory(data['environment']['ram_total_mib']) == '64.00 GiB'


def test_environment_snapshot_reads_comfy_versions_without_importing_torch(monkeypatch):
    import io
    import platform
    import subprocess
    import urllib.request
    from types import SimpleNamespace
    monkeypatch.setattr(platform, 'platform', lambda: 'Saved Test OS')
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: SimpleNamespace(stdout='595.71.05\n'))
    urls = []
    def open_url(url, **kwargs):
        urls.append(url)
        return io.BytesIO(json.dumps({'system': {'comfyui_version': '0.37.0', 'pytorch_version': '2.14.0+cu130', 'ram_total': 64 * 1024**3}}).encode())
    monkeypatch.setattr(urllib.request, 'urlopen', open_url)
    data = report.capture_environment('http://127.0.0.1:6006')
    assert data['comfyui_version'] == '0.37.0'
    assert data['pytorch_version'] == '2.14.0+cu130'
    assert data['ram_total_mib'] == 65536
    assert data['driver_version'] == '595.71.05'
    assert urls == ['http://127.0.0.1:6006/system_stats']
    assert 'command' not in data and 'hostname' not in data


def test_resumed_job_preserves_original_first_image_and_marks_recent_vram_scope(tmp_path):
    logs = tmp_path / 'logs'; logs.mkdir()
    (tmp_path / 'job.json').write_text(json.dumps({'workflow_progress': {'firered': {
        'timing_samples': {'a': 90, 'b': 30}, 'state': 'completed', 'completed': 3,
    }}}))
    (logs / 'firered.log').write_text(json.dumps({'stem': 'c', 'status': 'completed', 'elapsed_seconds': 50}))
    data = report.collect_report(tmp_path)
    assert data['models'][1]['completed'] == 3
    assert data['models'][1]['first'] == 90
    assert data['models'][1]['warm'] == 40
    assert any('latest run' in note for note in data['notes'])


def test_cover_drawing_accepts_missing_metadata_without_producing_pdf(tmp_path, monkeypatch):
    monkeypatch.syspath_prepend(str(TOOLS))
    from make_inpaint_compare_pdf import _load_cjk_font
    data = report.collect_report(tmp_path)
    cover = report.draw_cover(data, 3308, 2339, _load_cjk_font)
    assert cover.size == (3308, 2339)
    cover.close()


def test_model_filename_comes_from_saved_prompt_not_current_config(tmp_path):
    from PIL import Image, PngImagePlugin
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text('prompt', json.dumps({
        '1': {'class_type': 'UNETLoader', 'inputs': {'unet_name': 'models/actual-model.safetensors'}},
        '2': {'class_type': 'CLIPLoader', 'inputs': {'clip_name': 'encoder.safetensors'}},
    }))
    path = tmp_path / 'result.png'
    Image.new('RGB', (8, 8)).save(path, pnginfo=metadata)
    assert report.diffusion_model_files([path]) == 'actual-model.safetensors'
    assert report.diffusion_model_files([]) == 'Not recorded'


def test_report_font_needs_no_installed_fonts(monkeypatch):
    monkeypatch.syspath_prepend(str(TOOLS))
    from make_inpaint_compare_pdf import _load_report_font
    monkeypatch.setattr(Path, 'is_file', lambda self: False)
    assert _load_report_font(32).getbbox('English report') is not None


def test_english_prompt_translation_retains_original_metadata(tmp_path):
    data = report.collect_report(tmp_path, prompts={'firered': {'positive': report.PRODUCTION_PROMPT}})
    text = '\n'.join(report.cover_lines(data))
    assert text.isascii()
    assert '[English translation] ' + report.ENGLISH_PROMPT in text
    assert data['models'][1]['prompts']['positive'] == report.PRODUCTION_PROMPT


def test_plain_cover_keeps_only_requested_fields(tmp_path):
    data = report.collect_report(tmp_path)
    lines = report.cover_lines(data)
    text = '\n'.join(lines)
    assert 'Diffusion model: Not recorded' in text
    assert 'subsequent average' in text
    assert 'peak VRAM' in text
    assert 'PyTorch' not in text and '採樣器' not in text


def test_saved_prompt_polarity_and_blank_negative(tmp_path):
    from PIL import Image, PngImagePlugin
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text('prompt', json.dumps({
        '1': {'class_type': 'TextEncodeQwenImage21', 'inputs': {'prompt': '修復文字區域', 'negative_prompt': ''}},
        '2': {'class_type': 'KSampler', 'inputs': {'positive': ['1', 0], 'negative': ['1', 1]}},
    }))
    path = tmp_path / 'result.png'
    Image.new('RGB', (8, 8)).save(path, pnginfo=metadata)
    prompts = report.saved_prompts([path])
    assert prompts == {'positive': '修復文字區域', 'negative': ''}
    data = report.collect_report(tmp_path, prompts={'qwen2511_lanpaint': prompts})
    text = '\n'.join(report.cover_lines(data))
    assert 'Prompt: [Unicode escapes] \\u4fee\\u5fa9\\u6587\\u5b57\\u5340\\u57df' in text
    assert 'Negative prompt' not in text
