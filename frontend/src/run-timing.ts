type TimedRun = { state: string; created_at?: string; updated_at?: string; finished_at?: string | null }
const terminal = new Set(['completed', 'failed', 'abandoned', 'cancelled'])

export function runTiming(run: TimedRun, now: number) {
  const ended = terminal.has(run.state)
  const start = Date.parse(run.created_at || '')
  const stop = ended ? Date.parse(run.finished_at || run.updated_at || '') : now
  const seconds = Number.isFinite(start) && Number.isFinite(stop) ? Math.max(0, Math.floor((stop - start) / 1000)) : null
  if (seconds === null) return { ended, text: '耗時資料不可用' }
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), remainder = seconds % 60
  const duration = hours ? `${hours} 小時 ${minutes} 分 ${remainder} 秒` : minutes ? `${minutes} 分 ${remainder} 秒` : `${remainder} 秒`
  return { ended, text: `${ended ? '總耗時' : '已運行'} ${duration}` }
}
