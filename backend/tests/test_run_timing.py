from app.repository import JobRepository
from app.schemas import JobRecord, JobState


def test_terminal_timestamp_is_saved_once_and_survives_later_writes(tmp_path, monkeypatch):
    repo=JobRepository(tmp_path)
    record=JobRecord(id='test',name='timer',workflows=['firered'],pair_count=1,total_runs=1,
                     created_at='2026-09-13T00:00:00Z',updated_at='2026-09-13T00:00:00Z')
    monkeypatch.setattr('app.repository.now_iso',lambda:'2026-09-13T00:00:10Z')
    repo.write(record)
    assert repo.read('test').finished_at is None
    record.state=JobState.completed
    repo.write(record)
    assert repo.read('test').finished_at=='2026-09-13T00:00:10Z'
    monkeypatch.setattr('app.repository.now_iso',lambda:'2026-09-13T00:01:00Z')
    repo.write(repo.read('test'))
    assert repo.read('test').finished_at=='2026-09-13T00:00:10Z'
