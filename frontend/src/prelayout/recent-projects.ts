export const recentProjectsKey = 'pl-recent-projects'
type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>

export function loadRecentProjectIds(storage?: HistoryStorage): string[] {
  try {
    const raw = (storage ?? localStorage).getItem(recentProjectsKey)
    if (raw === null) return []
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value)) {
      return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 3)
    }
  } catch { /* History is optional when browser storage is unavailable. */ }
  return []
}

export function rememberProjectOpen(id: string, history: string[], storage?: HistoryStorage): string[] {
  const next = [id, ...history.filter(previous => previous !== id)].slice(0, 3)
  try { (storage ?? localStorage).setItem(recentProjectsKey, JSON.stringify(next)) } catch { /* Keep session history. */ }
  return next
}
