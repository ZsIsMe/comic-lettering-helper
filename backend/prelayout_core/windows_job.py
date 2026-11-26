"""UUID-scoped Windows process trees, using only the standard library.

No kill-on-close: workers must survive a Web process crash for recovery. A guard
keeps the name open while orphan children remain. Children inherit membership;
breakaway is deliberately never enabled.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
import re
import subprocess
import sys
import time


def job_name(task_id):
    if not isinstance(task_id, str) or not re.fullmatch(r'd_[0-9a-f]{32}', task_id):
        raise ValueError('Invalid prelayout task UUID')
    return 'Local\\ComicPrelayout-' + task_id


class WindowsJob:
    def __init__(self, handle):
        self.handle = handle

    @staticmethod
    def api():
        if os.name != 'nt':
            raise OSError('Windows Job Objects require Windows')
        api = ctypes.WinDLL('kernel32', use_last_error=True)
        api.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        api.CreateJobObjectW.restype = wintypes.HANDLE
        api.OpenJobObjectW.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR]
        api.OpenJobObjectW.restype = wintypes.HANDLE
        api.GetCurrentProcess.restype = wintypes.HANDLE
        api.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        api.IsProcessInJob.argtypes = [wintypes.HANDLE, wintypes.HANDLE, ctypes.POINTER(wintypes.BOOL)]
        api.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        api.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
        api.CloseHandle.argtypes = [wintypes.HANDLE]
        return api

    @classmethod
    def create(cls, task_id):
        api = cls.api()
        handle = api.CreateJobObjectW(None, job_name(task_id))
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        # Never adopt an existing unrelated object, even if a UUID collides.
        if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
            api.CloseHandle(handle)
            raise OSError('Prelayout job already exists')
        return cls(handle)

    @classmethod
    def open(cls, task_id):
        # JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE | JOB_OBJECT_ASSIGN_PROCESS.
        handle = cls.api().OpenJobObjectW(4 | 8 | 1, False, job_name(task_id))
        if not handle:
            error = ctypes.get_last_error()
            if error == 2:  # ERROR_FILE_NOT_FOUND is the only proof of absence.
                return None
            raise ctypes.WinError(error)
        return cls(handle)

    def assign_current(self):
        api = self.api()
        if not api.AssignProcessToJobObject(self.handle, api.GetCurrentProcess()):
            raise ctypes.WinError(ctypes.get_last_error())

    def contains_current(self):
        api = self.api()
        result = wintypes.BOOL()
        if not api.IsProcessInJob(api.GetCurrentProcess(), self.handle, ctypes.byref(result)):
            raise ctypes.WinError(ctypes.get_last_error())
        return bool(result.value)

    def active_count(self):
        class Accounting(ctypes.Structure):
            _fields_ = [('UserTime', ctypes.c_int64), ('KernelTime', ctypes.c_int64),
                        ('PeriodUserTime', ctypes.c_int64), ('PeriodKernelTime', ctypes.c_int64),
                        ('PageFaults', wintypes.DWORD), ('Total', wintypes.DWORD),
                        ('Active', wintypes.DWORD), ('Terminated', wintypes.DWORD)]
        info = Accounting()
        if not self.api().QueryInformationJobObject(self.handle, 1, ctypes.byref(info), ctypes.sizeof(info), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return info.Active

    def terminate(self):
        if not self.api().TerminateJobObject(self.handle, 1):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self):
        if self.handle:
            self.api().CloseHandle(self.handle)
            self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def start_guard(task_id):
    """Hold a named handle inside the job until every other member exits.

    A running job can outlive its last handle, but its NAME cannot be reopened
    after that last handle closes. The guard preserves recovery by name after
    both Web and worker exit while an orphan model child is still running.
    The parent already belongs to the job, so the guard inherits membership.
    """
    # A Windows venv redirector adds a second launcher process to the job. That
    # pair would keep ActiveProcesses >= 2 forever. The guard needs only stdlib;
    # bypass the redirector so it can identify itself as the last member.
    # DETACHED_PROCESS also avoids a private conhost.exe joining the job and
    # keeping that count above one. The guard has explicit pipe/file handles.
    process = subprocess.Popen([sys._base_executable, '-m', 'prelayout_core.windows_job', '--guard', task_id],
                               stdout=subprocess.PIPE, creationflags=subprocess.DETACHED_PROCESS)
    try:
        # No model starts before the guard confirms membership and an open handle.
        if process.stdout.readline().strip() != b'ready':
            raise RuntimeError('Windows prelayout guard did not become ready')
    finally:
        process.stdout.close()
    return process


def guard(task_id):
    job = WindowsJob.open(task_id)
    if job is None:
        raise RuntimeError('Windows prelayout job no longer exists')
    with job:
        if not job.contains_current():
            raise RuntimeError('Prelayout guard is outside its task job')
        print('ready', flush=True)
        while job.active_count() > 1:
            time.sleep(.1)


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--guard':
        raise SystemExit('Expected --guard TASK_UUID')
    guard(sys.argv[2])
