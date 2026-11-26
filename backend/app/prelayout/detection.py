"""Optional process-isolated CTD/OCR tasks sharing only the application's GPU gate."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import signal
import shutil
import subprocess
import urllib.request
from pathlib import Path

from prelayout_core.data import identifier, read_json, validate_measure
from prelayout_core.characters import validate_character_boxes
from prelayout_core.preview import load_overlay
from prelayout_core.ocr_engine import charspot_assets, configured_ocr_device
from .store import Conflict, atomic_json, now

ACTIVE = {'queued', 'validating', 'detecting', 'aligning', 'measuring', 'previewing', 'calibrating', 'publishing', 'cancelling', 'recovery_required'}
logger = logging.getLogger(__name__)


class PrelayoutDetection:
    def __init__(self, settings, store, gate):
        self.settings, self.store, self.gate = settings, store, gate
        self.models = Path(os.getenv('COMIC_PRELAYOUT_MODEL_ROOT', '/root/models/comic-prelayout'))
        display_font = os.getenv('COMIC_PRELAYOUT_DISPLAY_FONT', '').strip()
        self.display_font_custom = bool(display_font)
        self.display_font = Path(display_font).expanduser() if display_font else self.models / 'NotoSansCJKjp-Medium.otf'
        self.python = os.getenv('COMIC_PRELAYOUT_PYTHON', '')
        self.device = os.getenv('COMIC_PRELAYOUT_DEVICE', 'cuda').strip().lower()
        self.ocr_engine = os.getenv('COMIC_PRELAYOUT_OCR_ENGINE', 'charspot').strip().lower()
        self.tasks, self.processes = {}, {}
        self.cleanup_task = None
        self._cleanup_stopping = False

    def availability(self):
        files = {'ctd': 'comictextdetector.pt', 'font': 'NotoSansCJKjp-Medium.otf',
                 'metrics': 'NotoSansCJKjp-Medium.ink-metrics.json'}
        present = {key: (self.models / value).is_file() for key, value in files.items()}
        ocr_device, ocr_error = None, ''
        try:
            if self.ocr_engine not in ('charspot', 'mit48'):
                raise ValueError('COMIC_PRELAYOUT_OCR_ENGINE 只接受 charspot 或 mit48')
            ocr_device = configured_ocr_device(self.ocr_engine, self.device)
            present['ocr'] = all((self.models / name).is_file() for name in charspot_assets(ocr_device))
        except ValueError as exc:
            ocr_error = str(exc)
            present['ocr'] = False
        runtime = bool(self.python and Path(self.python).is_file() and os.access(self.python, os.X_OK))
        display_font_available = self.display_font.is_file()
        try:
            stat = self.display_font.stat() if display_font_available else None
            # The path distinguishes different fonts with identical size and timestamps,
            # while the hash keeps server filesystem paths out of the public response.
            font_version = hashlib.sha256(
                f'{self.display_font.resolve()}\0{stat.st_mtime_ns}\0{stat.st_size}'.encode()
            ).hexdigest() if stat else ''
        except OSError:
            display_font_available = False
            font_version = ''
        supported = self.device in ('cuda', 'mps')
        return {'assets': present, 'runtime': runtime, 'device': self.device,
                'ocr_engine': self.ocr_engine, 'ocr_device': ocr_device, 'ocr_error': ocr_error,
                'methods': {'fixed': supported and runtime and present['ctd'],
                            'single_char': supported and runtime and present['ctd'],
                            'ocr_aligned': supported and runtime and all(present.values())}, 'gpu_owner': self.gate.owner,
                'display_font_available': display_font_available, 'display_font_custom': self.display_font_custom,
                'font_version': font_version,
                'message': '模型只供偵測與字級計算；人工編輯不需要模型。'}

    def status(self, pid, recover=False):
        self.store.read(pid)
        return self._status(self.store.directory(pid), recover)

    def _status(self, directory, recover=False):
        records = []
        for path in (directory / 'detections').glob('d_*/task.json'):
            record = read_json(path.read_bytes())
            if recover and record['state'] in ACTIVE and not record.get('pid'):
                record['pid'] = self.discover_process(record)
            progress_path = path.parent / 'progress.json'
            if record['state'] in ACTIVE - {'cancelling', 'recovery_required'} and progress_path.exists():
                record.update(read_json(progress_path.read_bytes()))
            records.append(record)
        return max(records, key=lambda r: r['created_at']) if records else None

    def busy(self, pid):
        record = self.status(pid)
        return bool(record and record['state'] in ACTIVE)

    def task_path(self, pid, did):
        return self.store.directory(pid) / 'detections' / did / 'task.json'

    def update(self, project_id, did, **values):
        with self.store.lock(project_id):
            path = self.task_path(project_id, did)
            record = read_json(path.read_bytes())
            record.update(values, updated_at=now())
            atomic_json(path, record)
            return record

    def discover_process(self, record):
        # A crash can occur after spawn but before task.json receives the PID.
        # Locate only our worker with this random task ID, never an unrelated Python job.
        try:
            output = subprocess.check_output(['ps', '-axo', 'pgid=,stat=,command='], text=True, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as exc:
            raise Conflict('無法檢查偵測程序，請保留 GPU 占用並重試') from exc
        for line in output.splitlines():
            fields = line.strip().split(None, 2)
            if len(fields) == 3 and not fields[1].startswith('Z') and 'prelayout_core.worker' in fields[2] and record['id'] in fields[2]:
                return int(fields[0])
        return None

    def process_alive(self, record, verify=False):
        group = record.get('pid')
        if not isinstance(group, int) or group <= 1:
            return False
        try:
            # The worker and both model phases share a process group. A surviving child
            # still owns the GPU even when its orchestrating parent has exited.
            output = subprocess.check_output(['ps', '-axo', 'pgid=,stat=,command='], text=True, stderr=subprocess.DEVNULL)
            for line in output.splitlines():
                fields = line.strip().split(None, 2)
                if len(fields) == 3 and fields[0] == str(group) and not fields[1].startswith('Z'):
                    if 'prelayout_core.worker' in fields[2] and record['id'] in fields[2]:
                        return True
            return False
        except (OSError, subprocess.SubprocessError):
            if verify:
                return False
            # Failure to inspect is not evidence of exit; retain the reservation.
            try:
                os.killpg(group, 0)
                return True
            except ProcessLookupError:
                return False
            except PermissionError:
                return True

    async def terminate_group(self, record, process=None):
        group = record.get('pid')
        if not group:
            return
        async def alive(verify=False):
            return await asyncio.to_thread(self.process_alive, record, verify)
        if process is None and not await alive(verify=True):
            if await alive():
                raise Conflict('無法確認原有程序身分，保留 GPU 占用；請先檢查原程序狀態')
            return
        if (process and process.returncode is None) or await alive():
            try:
                os.killpg(group, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = asyncio.get_running_loop().time() + 10
        while await alive() and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(.1)
        if await alive():
            try:
                os.killpg(group, signal.SIGKILL)
            except ProcessLookupError:
                pass
            while await alive():
                await asyncio.sleep(.1)
        if process:
            await process.wait()

    async def start(self):
        completed = []
        for path in self.store.projects.glob('pl_*/project.json'):
            pid = path.parent.name
            try:
                directory = self.store.directory(pid)
            except KeyError:
                continue
            record = await asyncio.to_thread(self._status, directory, True)
            if record and record['state'] in ACTIVE:
                # Only interrupted work needs the project contents before accepting new work.
                try:
                    self.store.read(pid)
                except (KeyError, FileNotFoundError, ValueError):
                    continue
                if await asyncio.to_thread(self.process_alive, record):
                    self.gate.retain(record['id'])
                    self.update(pid, record['id'], pid=record['pid'], state='recovery_required', message='保留執行中的偵測程序，等待結束後恢復結果')
                    self.tasks[pid] = asyncio.create_task(self._watch_recovered(pid, record))
                else:
                    try:
                        if record['state'] == 'cancelling':
                            self.update(pid, record['id'], state='cancelled', message='已取消')
                        elif (self.task_path(pid, record['id']).parent / 'output' / 'complete.json').exists():
                            self.publish(pid, record['id'], cleanup=False)
                            completed.append((pid, record['id']))
                        else:
                            self.update(pid, record['id'], state='failed', message='服務中斷，原有排版已保留；可重新提交偵測')
                    except Exception as exc:
                        self.update(pid, record['id'], state='failed', message=str(exc))
            elif record and record['state'] == 'completed':
                completed.append((pid, record['id']))
        if completed:
            self._cleanup_stopping = False
            self.cleanup_task = asyncio.create_task(self._cleanup_completed(completed), name='prelayout-input-cleanup')

    async def _cleanup_completed(self, completed):
        # Retry unfinished reclamation without holding up service readiness.
        for pid, did in completed:
            if self._cleanup_stopping:
                break
            try:
                await asyncio.to_thread(self.cleanup_input, pid, did)
            except (KeyError, FileNotFoundError):
                # The project or task may have been deleted since startup.
                continue
            except Exception:
                logger.exception('無法清理預排版任務輸入：%s/%s', pid, did)

    async def _watch_recovered(self, pid, record):
        try:
            while await asyncio.to_thread(self.process_alive, record):
                await asyncio.sleep(1)
            path = self.task_path(pid, record['id']).parent / 'output' / 'complete.json'
            if self.status(pid)['state'] == 'cancelling':
                self.update(pid, record['id'], state='cancelled', message='已取消，舊排版保持不變')
            elif path.exists():
                self.publish(pid, record['id'])
            else:
                self.update(pid, record['id'], state='failed', message='中斷的偵測未完整完成，已保留舊排版')
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.update(pid, record['id'], state='failed', message=str(exc))
        finally:
            if not await asyncio.to_thread(self.process_alive, record):
                self.gate.release(record['id'])

    async def stop(self):
        self._cleanup_stopping = True
        if self.cleanup_task is not None:
            await self.cleanup_task
            self.cleanup_task = None
        for pid in list(self.tasks):
            try:
                await self.cancel(pid)
            except Conflict:
                # Keep the task record recoverable if process inspection is unavailable.
                pass
        for task in self.tasks.values():
            if not task.done():
                task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks.values(), return_exceptions=True)

    def free_comfy(self):
        import json
        url = self.settings.comfy_url
        with urllib.request.urlopen(url + '/queue', timeout=5) as response:
            queue = json.load(response)
        if queue.get('queue_running') or queue.get('queue_pending'):
            raise Conflict('ComfyUI 有執行中或排隊工作')
        request = urllib.request.Request(url + '/free', data=b'{"unload_models":true,"free_memory":true}', headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10):
            pass
        with urllib.request.urlopen(url + '/queue', timeout=5) as response:
            queue = json.load(response)
        if queue.get('queue_running') or queue.get('queue_pending'):
            raise Conflict('ComfyUI 有新的工作，請稍後再試')

    async def submit(self, pid, options):
        if self.device not in ('cuda', 'mps'):
            raise ValueError('預排版設備只接受 cuda 或 mps；不自動降級 CPU')
        method = options.get('method', 'ocr_aligned')
        if method not in ('ocr_aligned', 'single_char', 'fixed'):
            raise ValueError('字級計算方法無效')
        base, step = options.get('font_size', 24), options.get('step', 2)
        if not isinstance(base, (float, int)) or not isinstance(step, (float, int)) or not 1 <= base <= 999 or not .1 <= step <= 100:
            raise ValueError('字級候選參數無效')
        availability = self.availability()
        if not availability['methods'][method]:
            raise ValueError(availability.get('ocr_error') if method == 'ocr_aligned' and availability.get('ocr_error')
                             else '尚未安裝對應模型／字表／字型或推理 Python，請依 README 準備')
        task_options = {'method': method, 'font_size': base, 'step': step}
        if options.get('bubble_centroid') is True:
            task_options['bubble_centroid'] = True
        if method == 'ocr_aligned':
            task_options.update(ocr_engine=self.ocr_engine,
                                ocr_device=availability.get('ocr_device') or configured_ocr_device(self.ocr_engine, self.device))
        with self.store.lock(pid):
            project = self.store.read(pid)
            if self.busy(pid):
                raise Conflict('此項目已有偵測任務')
            did = identifier('d')
            if not self.gate.claim(did):
                raise Conflict('GPU 忙碌，請等待目前任務完成')
            try:
                folder = self.store.directory(pid) / 'detections' / did
                folder.mkdir(parents=True)
                record = {'id': did, 'project_id': pid, 'state': 'queued', 'created_at': now(), 'device': self.device,
                          'cleanup_input_after_publish': True,
                          'options': task_options,
                          'pages': [{key: page[key] for key in ('id', 'name', 'width', 'height', 'sha256')} for page in project['pages']]}
                atomic_json(folder / 'task.json', record)
            except BaseException:
                self.gate.release(did)
                raise
        self.tasks[pid] = asyncio.create_task(self.run(pid, did))
        return record

    async def run(self, pid, did):
        process = None
        try:
            if self.status(pid)['state'] == 'cancelling':
                self.update(pid, did, state='cancelled', message='已取消')
                return
            device = self.status(pid).get('device', 'cuda')
            self.update(pid, did, state='validating', message=f'檢查 {device.upper()} 與模型環境')
            # Explicit local Apple GPU runs do not depend on a separate CUDA/ComfyUI service.
            # The process-wide reservation still serializes all application model jobs.
            if device == 'cuda':
                await asyncio.to_thread(self.free_comfy)
            if self.status(pid)['state'] == 'cancelling':
                self.update(pid, did, state='cancelled', message='已取消')
                return
            folder = self.task_path(pid, did).parent
            env = os.environ.copy()
            env['COMIC_PRELAYOUT_MODEL_ROOT'] = str(self.models)
            if device == 'mps':
                env['PYTORCH_ENABLE_MPS_FALLBACK'] = '0'
            env['PYTHONPATH'] = str(Path(__file__).resolve().parents[2])
            with (folder / 'worker.log').open('wb') as output:
                process = await asyncio.create_subprocess_exec(self.python, '-m', 'prelayout_core.worker', '--task', str(folder / 'task.json'), '--task-id', did,
                                                              '--images', str(self.store.directory(pid) / 'originals'), cwd=self.settings.app_root,
                                                              env=env, stdout=output, stderr=output, start_new_session=True)
                self.processes[pid] = process
                self.update(pid, did, pid=process.pid)
                if self.status(pid)['state'] == 'cancelling':
                    await self.terminate_group(self.status(pid), process)
                code = await process.wait()
            # The orchestrator can exit while a model child is still alive.
            # Finish that process group before publishing or releasing its GPU slot.
            await self.terminate_group(self.status(pid), process)
            if self.status(pid)['state'] == 'cancelling':
                self.update(pid, did, state='cancelled', message='已取消，原有排版已保留')
            elif code != 0:
                self.update(pid, did, state='failed', message='偵測程序失敗，請查看此項目 worker.log')
            else:
                self.publish(pid, did)
        except asyncio.CancelledError:
            self.update(pid, did, state='cancelled', message='服務停止，原有排版已保留')
        except Exception as exc:
            self.update(pid, did, state='failed', message=str(exc))
        finally:
            self.processes.pop(pid, None)
            try:
                if process:
                    await self.terminate_group(self.status(pid), process)
            except Exception as exc:
                record = self.update(pid, did, state='recovery_required', message=f'等待偵測程序退出：{exc}')
                self.tasks[pid] = asyncio.create_task(self._watch_recovered(pid, record))
            else:
                self.gate.release(did)

    def publish(self, pid, did, *, cleanup=True):
        with self.store.lock(pid):
            folder = self.task_path(pid, did).parent / 'output'
            complete = read_json((folder / 'complete.json').read_bytes())
            project = self.store.read(pid)
            if complete['pages'] != [p['name'] for p in project['pages']]:
                raise ValueError('偵測輸出頁面不完整')
            measure = validate_measure(read_json((folder / 'measure.json').read_bytes()), project['pages'])
            for page in project['pages']:
                page_measure = read_json((folder / 'page-measures' / f'{page["id"]}.json').read_bytes())
                if page_measure != measure['pages'][page['name']]:
                    raise ValueError('逐頁量測與正式量測不一致')
                validate_character_boxes(read_json((folder / 'page-characters' / f'{page["id"]}.json').read_bytes()), page)
            if complete.get('inpainted') is True:
                pending = []
                for page in project['pages']:
                    relative = f'detections/{did}/output/inpainted/{Path(page["name"]).stem}.npz'
                    overlay = self.store.directory(pid) / relative
                    with load_overlay(overlay, (page['width'], page['height'])):
                        pass
                    pending.append((page, relative))
            else:
                pending = []
            published = project.get('detection_id') == did and all(
                page.get('clean') == relative and page.get('clean_kind') == 'inpainted'
                for page, relative in pending)
            if not published:
                for page, relative in pending:
                    page.update(clean=relative, clean_kind='inpainted')
                for page in project['pages']:
                    page.pop('reviewed_revision', None)
                project['detection_id'] = did
                project['revision'] += 1
                self.store.write(project)
            self.update(pid, did, state='completed', message='偵測完成，可預覽匹配並選擇套用；原有文字未更動')
            if cleanup:
                self.cleanup_input(pid, did)

    def cleanup_input(self, pid, did):
        """Reclaim only a completed task's private input, never published assets."""
        with self.store.lock(pid):
            task_path = self.task_path(pid, did)
            record = read_json(task_path.read_bytes())
            if not record.get('cleanup_input_after_publish') or record['state'] != 'completed':
                return
            inputs = task_path.parent / 'input'
            try:
                if not record.get('input_cleanup_error') and not inputs.is_symlink() and not inputs.exists():
                    return
                try:
                    self.store.read(pid)
                except (KeyError, FileNotFoundError, ValueError):
                    return
                if self.process_alive(record):
                    return
                if inputs.is_symlink():
                    raise OSError('任務 input 不可為符號連結')
                if inputs.exists():
                    shutil.rmtree(inputs)
            except OSError as exc:
                # An optional cleanup failure must not invalidate a published result.
                self.update(pid, did, input_cleanup_error=str(exc))
            else:
                if record.get('input_cleanup_error'):
                    self.update(pid, did, input_cleanup_error=None)

    async def cancel(self, pid):
        record = self.status(pid)
        if not record or record['state'] not in ACTIVE:
            return record
        self.update(pid, record['id'], state='cancelling', message='正在安全停止')
        await self.terminate_group(record, self.processes.get(pid))
        return self.status(pid)
