"""Multi-cell inference must remain independent and publish whole pages atomically."""
import asyncio
import hashlib
import json
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.engine import WORKFLOW_META
from app.project_api import create_project_router
from app.projects import ProjectStore, atomic_json
from app.repair_scope import fit_scope, scope_rects, validate_scope
from app.repository import JobRepository
from test_engine import make_manager, make_record
from test_projects import Manager


def grid(cells=None):
    return dict(verticalGuides=[2, 4], horizontalGuides=[2], selectedCells=cells if cells is not None else [
        dict(column=0, row=0), dict(column=2, row=0), dict(column=1, row=1),
    ])


def make_grid_job(tmp_path, value=None):
    manager, repository = make_manager(tmp_path)
    record = make_record()
    record.pair_count = record.total_runs = 1
    repository.write(record)
    root = repository.job_dir(record.id)
    source = Image.new('RGB', (6, 4))
    for y in range(4):
        for x in range(6):
            source.putpixel((x, y), (x * 20, y * 20, 60))
    mask = Image.new('L', source.size)
    for point in [(0, 0), (3, 2), (3, 0)]:
        mask.putpixel(point, 255)
    for folder, image in [('pair', source), ('pair_mask', mask)]:
        path = root / 'uploads' / folder / '01.png'
        path.parent.mkdir(parents=True)
        image.save(path)
    atomic_json(root / 'input_geometry.json', {'01': grid() if value is None else value})
    return manager, repository, record, root, source


@pytest.mark.parametrize('bad', [
    dict(verticalGuides=[4, 2], horizontalGuides=[], selectedCells=[]),
    dict(verticalGuides=[2, 2], horizontalGuides=[], selectedCells=[]),
    dict(verticalGuides=[0], horizontalGuides=[], selectedCells=[]),
    dict(verticalGuides=[6], horizontalGuides=[], selectedCells=[]),
    dict(verticalGuides=[True], horizontalGuides=[], selectedCells=[]),
    grid([dict(column=3, row=0)]), grid([dict(column=0, row=2)]),
    grid([dict(column=True, row=0)]), grid([dict(column=0, row=0)] * 2),
    dict(verticalGuides=[], horizontalGuides=[], selectedCells='all'),
    dict(verticalGuides=[], horizontalGuides=[], selectedCells=[], extra=True),
])
def test_invalid_grid_rejected(bad):
    with pytest.raises(ValueError):
        validate_scope(bad, 6, 4)


def test_grid_guide_count_limit_and_apply_all_tiny_page():
    with pytest.raises(ValueError):
        validate_scope(dict(verticalGuides=list(range(1, 130)), horizontalGuides=[], selectedCells=[]), 200, 4)
    assert fit_scope(grid(), 1, 1) == dict(verticalGuides=[], horizontalGuides=[], selectedCells=[dict(column=0, row=0)])
    assert fit_scope(grid([]), 1, 1)['selectedCells'] == []
    assert scope_rects(grid(), 6, 4) == [
        dict(x=0, y=0, width=2, height=2), dict(x=4, y=0, width=2, height=2), dict(x=2, y=2, width=2, height=2),
    ]


@pytest.mark.parametrize('workflow', ['firered', 'flux2klein_lanpaint', 'qwen2511_lanpaint'])
def test_grid_independent_crops_partial_resume_and_full_reassembly(tmp_path, workflow):
    manager, repository, record, root, base = make_grid_job(tmp_path)
    record.workflows = [workflow]
    repository.write(record)
    batch, stems = manager._prepare_comfy_input(record)
    assert stems == ['01']
    units = manager._input_plan(record, stems)['01']
    assert len(units) == 3 and len({unit['stem'] for unit in units}) == 3
    for unit in units:
        path = manager.settings.comfy_input / batch / 'pair' / f"{unit['stem']}.png"
        flat = manager.settings.comfy_input / f'{batch}_{path.name}'
        with Image.open(path) as image:
            assert image.size == (2, 2)
            assert image.getpixel((0, 0)) == base.getpixel((unit['rect']['x'], unit['rect']['y']))
        assert flat.is_file() and not flat.is_symlink()
    with Image.open(manager.settings.comfy_input / batch / 'pair_mask' / f"{units[1]['stem']}.png") as mask:
        assert mask.getbbox() is None
    prefix = f"web_{record.id.replace('-', '')[:12]}_{WORKFLOW_META[workflow]['prefix']}_"
    manager.settings.comfy_output.mkdir(parents=True)
    first = manager.settings.comfy_output / f"{prefix}{units[0]['stem']}_00001_.png"
    Image.new('RGB', (2, 2), 'red').save(first)
    assert manager._sync_available_outputs(record, workflow, prefix, stems) == 0
    final = root / 'inpaint_workflows' / workflow / '01.png'
    assert not final.exists()
    manager._cleanup_comfy_staging(batch, record)
    assert not first.exists()
    manager._prepare_comfy_input(record)
    manager._prepare_existing_outputs(record, stems)
    with Image.open(first) as image:
        assert image.getpixel((0, 0)) == (255, 0, 0)
    # Second cell is black-mask passthrough, third cell is independently generated.
    for unit, color in [(units[1], None), (units[2], (0, 255, 0))]:
        raw = manager.settings.comfy_output / f"{prefix}{unit['stem']}_00001_.png"
        if color is None:
            with Image.open(manager.settings.comfy_input / batch / 'pair' / f"{unit['stem']}.png") as image:
                image.save(raw)
        else:
            Image.new('RGB', (2, 2), color).save(raw)
    assert manager._sync_available_outputs(record, workflow, prefix, stems, require_all=True) == 1
    assert record.results[workflow] == ['01.png']
    with Image.open(final) as image:
        assert image.size == base.size
        for y in range(4):
            for x in range(6):
                expected = (255, 0, 0) if x < 2 and y < 2 else (0, 255, 0) if 2 <= x < 4 and y >= 2 else base.getpixel((x, y))
                assert image.getpixel((x, y)) == expected
    # Restore every crop from the full saved page if both temporary raw and cache are gone.
    import shutil
    manager._cleanup_comfy_staging(batch, record)
    shutil.rmtree(root / 'crop_results')
    manager._prepare_existing_outputs(record, stems)
    assert all((manager.settings.comfy_output / f"{prefix}{unit['stem']}_00001_.png").is_file() for unit in units)
    Image.new('RGB', (3, 2)).save(first)
    with pytest.raises(RuntimeError):
        manager._sync_available_outputs(record, workflow, prefix, stems, require_all=True)
    with Image.open(final) as image:
        assert image.getpixel((0, 0)) == (255, 0, 0)


def test_grid_crop_names_cannot_collide_with_source_stem(tmp_path):
    manager, _, record, root, _ = make_grid_job(tmp_path)
    collision = f"scope_{hashlib.sha256(b'01').hexdigest()}_0"
    for folder in ['pair', 'pair_mask']:
        import shutil
        shutil.copy2(root / 'uploads' / folder / '01.png', root / 'uploads' / folder / f'{collision}.png')
    atomic_json(root / 'input_geometry.json', {'01': grid(), collision: dict(x=0, y=0, width=1, height=1)})
    _, stems = manager._prepare_comfy_input(record)
    units = [unit for page in manager._input_plan(record, stems).values() for unit in page]
    assert len({unit['stem'] for unit in units}) == 4
    manager.settings.comfy_output.mkdir(parents=True)
    for unit in units:
        rect = unit['rect']
        color = 'blue' if unit['stem'] == collision else 'red'
        Image.new('RGB', (rect['width'], rect['height']), color).save(manager.settings.comfy_output / f"test_{unit['stem']}_00001_.png")
    assert manager._sync_available_outputs(record, record.workflows[0], 'test_', stems, require_all=True) == 2
    with Image.open(root / 'inpaint_workflows/flux2klein_lanpaint' / f'{collision}.png') as image:
        assert image.getpixel((0, 0)) == (0, 0, 255)
    with Image.open(root / 'inpaint_workflows/flux2klein_lanpaint/01.png') as image:
        assert image.getpixel((0, 0)) == (255, 0, 0)


@pytest.mark.parametrize('value', [grid([]), grid([dict(column=2, row=0)])])
def test_empty_or_black_selected_cells_never_contact_comfy(tmp_path, value):
    manager, repository, record, root, base = make_grid_job(tmp_path, value)
    manager._wait_comfy = AsyncMock(side_effect=AssertionError('no model required'))
    asyncio.run(manager._run_job(record.id))
    saved = repository.read(record.id)
    assert saved.state.value == 'completed' and saved.completed_total == 1
    assert saved.black_mask_count == 1
    manager._wait_comfy.assert_not_called()
    with Image.open(root / 'inpaint_workflows/flux2klein_lanpaint/01.png') as image:
        assert image.tobytes() == base.tobytes()


def test_grid_orchestration_keeps_page_counts_and_qwen_staged_mask_lookup(tmp_path, monkeypatch):
    manager, repository, record, root, _ = make_grid_job(tmp_path)
    record.workflows = ['flux2klein_lanpaint', 'firered', 'qwen2511_lanpaint']
    record.total_runs = 3
    repository.write(record)
    manager._wait_comfy = AsyncMock()
    manager._package = AsyncMock(return_value=None)
    manager.settings.comfy_output.mkdir(parents=True)

    async def spawn(*args, **kwargs):
        workflow = args[args.index('--label') + 1]
        prefix = f"web_{record.id.replace('-', '')[:12]}_{WORKFLOW_META[workflow]['prefix']}_"
        log = __import__('pathlib').Path(args[args.index('--log') + 1])
        rows = []
        for unit in manager._input_plan(record, ['01'])['01']:
            Image.new('RGB', (2, 2), 'red').save(manager.settings.comfy_output / f"{prefix}{unit['stem']}_00001_.png")
            rows.append(dict(stem=unit['stem'], status='completed', elapsed_seconds=3, empty_mask_passthrough=unit['rect']['x'] == 4))
        log.write_text(''.join(json.dumps(row) + '\n' for row in rows))
        process = Mock(returncode=0)
        process.wait = AsyncMock(return_value=0)
        process.communicate = AsyncMock(return_value=(b'', None))
        return process

    monkeypatch.setattr('app.engine.asyncio.create_subprocess_exec', spawn)
    asyncio.run(manager._run_job(record.id))
    saved = repository.read(record.id)
    assert saved.state.value == 'completed' and saved.completed_total == saved.total_runs == 3
    for workflow in record.workflows:
        assert saved.results[workflow] == ['01.png']
        progress = saved.workflow_progress[workflow]
        assert progress.completed == progress.total == progress.generated == 1
        assert progress.passthrough == 0 and len(progress.timing_samples) == 2
        with Image.open(root / 'inpaint_workflows' / workflow / '01.png') as image:
            assert image.size == (6, 4)


def test_grid_api_snapshot_export_import_and_disabled_scope(tmp_path):
    source, mask = tmp_path / '01.png', tmp_path / 'mask.png'
    Image.new('RGB', (6, 4), 'gray').save(source)
    Image.new('L', (6, 4), 255).save(mask)
    store = ProjectStore(tmp_path / 'projects')
    project = store.create('grid', {'01': source}, {'01': mask})
    repository = JobRepository(tmp_path / 'jobs')
    app = FastAPI()
    app.include_router(create_project_router(Settings(data_root=tmp_path), repository, Manager(), store))
    page = project['pages'][0]
    with TestClient(app) as client:
        changed = client.put(f"/api/projects/{project['id']}/pages/{page['id']}/repair-scope", json=dict(revision=0, enabled=True, rect=grid())).json()
        exported = client.get(f"/api/projects/{project['id']}/repair-scope/export").json()
        assert exported['pages'] == {'01.png': grid()}
        imported = store.create('imported', {'01': source}, {'01': mask}, repair_scope=exported)
        assert imported['repair_scope']['pages'][imported['pages'][0]['id']] == grid()
        snapshot = store.snapshot(project['id'], changed['revision'])
        with Image.open(store.asset_path(project['id'], snapshot['pages'][0]['mask'])) as image:
            assert image.getpixel((3, 0)) == 0
            assert image.getpixel((0, 0)) == 255
        job = client.post(f"/api/projects/{project['id']}/jobs", json=dict(workflows=['firered'], expected_revision=changed['revision']))
        assert job.status_code == 202, job.text
        assert json.loads((repository.job_dir(job.json()['id']) / 'input_geometry.json').read_text()) == {'01': grid()}
    project = store.save_repair_scope(imported['id'], imported['pages'][0]['id'], 0, False, grid([]))
    assert 'repair_rect' not in store.snapshot(project['id'], project['revision'])['pages'][0]


def test_later_partial_crops_are_cached_and_completed_pages_are_not_reencoded(tmp_path, monkeypatch):
    manager, _, record, root, _ = make_grid_job(tmp_path)
    batch, stems = manager._prepare_comfy_input(record)
    units = manager._input_plan(record, stems)['01']
    manager.settings.comfy_output.mkdir(parents=True)
    prefix = 'test_'
    last_raw = manager.settings.comfy_output / f"{prefix}{units[-1]['stem']}_00001_.png"
    Image.new('RGB', (2, 2), 'green').save(last_raw)
    assert manager._sync_available_outputs(record, record.workflows[0], prefix, stems) == 0
    assert manager._crop_result_path(record, record.workflows[0], units[-1]).is_file()
    for unit in units[:-1]:
        Image.new('RGB', (2, 2), 'red').save(manager.settings.comfy_output / f"{prefix}{unit['stem']}_00001_.png")
    assert manager._sync_available_outputs(record, record.workflows[0], prefix, stems) == 1
    final = root / 'inpaint_workflows/flux2klein_lanpaint/01.png'
    before = final.stat().st_mtime_ns
    monkeypatch.setattr('app.engine.paste_result', Mock(side_effect=AssertionError('unchanged page must not be reencoded')))
    assert manager._sync_available_outputs(record, record.workflows[0], prefix, stems) == 1
    assert final.stat().st_mtime_ns == before
