"""Create isolated, synthetic browser acceptance data. No user images or models are read."""
import argparse
import io
import json
from pathlib import Path
from PIL import Image, ImageDraw
from app.prelayout.store import PrelayoutStore, atomic_json, now
from prelayout_core.data import identifier, export_item


def png(size):
    image = Image.new('RGB', size, '#f5f5f3')
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], 320):
        draw.rectangle((35, y + 35, size[0] - 35, min(y + 280, size[1] - 1)), outline='#c1c1bd', width=3)
    output = io.BytesIO(); image.save(output, 'PNG'); image.close(); return output.getvalue()


def create(root, output):
    store = PrelayoutStore(root / 'prelayout')
    normal = png((2000, 3000))
    uploads = [(f'{index:03}.png', normal) for index in range(1, 98)]
    uploads += [('098.png', png((8000, 12000))), ('099.png', png((1200, 24000))), ('100.png', normal)]
    project = store.create('自動驗收資料（合成）', uploads)
    measure = {'pages': {}}
    for index, page in enumerate(project['pages']):
        dense = index == 96
        values = []
        for n in range(240 if dense else 35):
            x, y = .12 + (n % 7) * .12, .10 + (n // 7) * (.024 if dense else .16)
            cx, cy = x * page['width'], y * page['height']
            values.append({'_id': identifier(), 'index': n + 1, 'text': f'文字{n + 1}\n測試', 'x': x, 'y': y, 'font-size': 48 if dense else 60,
                           'rotation': 0, 'orientation': 'vertical' if n % 2 == 0 else 'horizontal',
                           'color': '#202020', 'stroke-color': '#ffffff', 'stroke-weight': 10 if dense else 1,
                           'xyxy_pixel': [cx - 50, cy - 100, cx + 50, cy + 100], 'match_status': 'unmatched' if n == 0 else 'auto',
                           'fixture_unknown': {'retained': True}})
        store.save_page(project['id'], page['id'], 0, values, 'fixture-initial')
        measure['pages'][page['name']] = [{'xyxy_pixel': item['xyxy_pixel'], 'center_normalized': [item['x'], item['y']], 'font_size': 60, 'orientation': item['orientation'], 'text_color': 'black', 'source_block_index': n} for n, item in enumerate(values)]
    project = store.read(project['id']); did = identifier('d')
    folder = store.directory(project['id']) / 'detections' / did
    atomic_json(folder / 'task.json', {'id': did, 'project_id': project['id'], 'state': 'completed', 'created_at': now(), 'pid': None, 'message': '合成驗收資料；沒有執行模型'})
    atomic_json(folder / 'output' / 'measure.json', measure)
    atomic_json(folder / 'output' / 'complete.json', {'pages': [p['name'] for p in project['pages']]})
    project['detection_id'] = did; store.write(project)
    output.mkdir(parents=True, exist_ok=True)
    (output / 'fixture.json').write_text(json.dumps(project, ensure_ascii=False))
    (output / 'sample.png').write_bytes(normal)
    (output / 'sample_bt.json').write_text(json.dumps({'version': [1, 0], 'comment': '合成匯入', 'extra_top': {'kept': True}, 'groupList': [{'name': '對話'}, {'name': '框外'}], 'transMap': {'001.png': [export_item(item) for item in store.page(project['id'], project['pages'][0]['id'])['items']]}}))
    print(json.dumps({'project': project['id'], 'pages': len(project['pages']), 'fixture': str(output / 'fixture.json')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--data-root', type=Path, required=True); parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(); create(args.data_root, args.output)
