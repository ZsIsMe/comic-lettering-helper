from app.schemas import WorkflowProgress, JobRecord
from app.workflow_progress import TimingReader, update_progress


def test_partial_json_lines_and_noise_are_not_lost(tmp_path):
    path = tmp_path / 'runner.log'
    path.write_bytes(b'warning\n{"stem":"a",')
    reader = TimingReader(path)
    assert reader.read() == []
    with path.open('ab') as handle:
        handle.write(b'"status":"completed"}\n')
    assert reader.read() == [{'stem': 'a', 'status': 'completed'}]
    assert reader.read() == []


def test_real_first_warm_mean_black_mask_and_eta():
    progress = WorkflowProgress(total=6)
    rows = [
        {'stem': 'black', 'status': 'completed', 'elapsed_seconds': 0.01, 'empty_mask_passthrough': True},
        {'stem': 'a', 'status': 'completed', 'elapsed_seconds': 90},
        {'stem': 'bad', 'status': 'failed', 'elapsed_seconds': 500},
        {'stem': 'b', 'status': 'completed', 'elapsed_seconds': 30},
        {'stem': 'c', 'status': 'completed', 'elapsed_seconds': 50},
        {'event': 'item_start', 'time': '2026-09-21T12:00:00+00:00'},
    ]
    update_progress(progress, rows, completed=4, passthrough=1, black_count=1,
                    elapsed=195, now='2026-09-21T12:00:10+00:00')
    assert progress.first_seconds == 90
    assert progress.warm_average_seconds == 40
    assert progress.generated == 3
    assert progress.passthrough == 1
    assert progress.remaining_seconds == 70
    assert progress.elapsed_seconds == 195
    # A repeated row on resume must not double-count an already finished image.
    update_progress(progress, rows[1:2], completed=4, passthrough=1, black_count=1,
                    elapsed=200, now='2026-09-21T12:00:15+00:00')
    assert progress.generated == 3
    assert progress.first_seconds == 90


def test_first_only_does_not_estimate_warm_speed():
    progress = WorkflowProgress(total=3)
    update_progress(progress, [{'stem': 'a', 'status': 'completed', 'elapsed_seconds': 100}],
                    completed=1, passthrough=0, black_count=0, elapsed=110, now='2026-09-21T12:00:00+00:00')
    assert progress.remaining_seconds is None
    assert progress.warm_average_seconds is None


def test_all_black_has_no_inference_duration():
    progress = WorkflowProgress(total=2)
    update_progress(progress, [], completed=2, passthrough=2, black_count=2,
                    elapsed=0.5, now='2026-09-21T12:00:00+00:00')
    assert progress.first_seconds is None
    assert progress.generated == 0
    assert progress.remaining_seconds == 0


def test_old_job_without_progress_is_compatible():
    record = JobRecord(id='old', name='old', workflows=['firered'], pair_count=1,
                       total_runs=1, created_at='old', updated_at='old')
    assert record.workflow_progress == {}
