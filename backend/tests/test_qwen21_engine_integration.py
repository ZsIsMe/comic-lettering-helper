from app.config import Settings
from app.engine import JobManager
from app.repository import JobRepository


def test_qwen_compatible_key_selects_native_runner_and_app_template(tmp_path):
    settings = Settings(app_root=tmp_path / 'app', comfy_root=tmp_path / 'comfy', data_root=tmp_path / 'data')
    manager = JobManager(settings, JobRepository(settings.jobs_root))
    command, _ = manager._command_for('qwen2511_lanpaint', 'web_0123456789ab', 'web_0123456789ab_qwen_')
    assert command[1] == str(settings.tools_root / 'run_qwen21_batch.py')
    assert command[command.index('--workflow') + 1] == str(settings.app_root / 'workflows/Qwen-Image-2.1-INT8-Manga.api.json')
    assert command[command.index('--input-root') + 1] == 'web_0123456789ab'
    assert '--skip' in command
    assert 'qwenlanpaint' not in command
    flux, _ = manager._command_for('flux2klein_lanpaint', 'web_0123456789ab', 'web_0123456789ab_flux_')
    assert flux[flux.index('--model') + 1] == 'flux2lanpaint'
