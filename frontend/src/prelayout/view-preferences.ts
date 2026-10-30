export type ViewPreferences = {
  zoom: number
  compare: boolean
  clean: boolean
  showText: boolean
  showMeasure: boolean
  difference: boolean
  differenceColor: string
  differenceOpacity: number
  focus: boolean
  showService: boolean
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

export const viewPreferencesKey = 'pl-view-preferences'
const defaults: Readonly<ViewPreferences> = {
  zoom: 1, compare: true, clean: true, showText: true, showMeasure: true,
  difference: false, differenceColor: '#ff288c', differenceOpacity: .4,
  focus: false, showService: false,
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalize(value: Record<string, unknown>): ViewPreferences {
  const result = { ...defaults }
  for (const key of ['compare', 'clean', 'showText', 'showMeasure', 'difference', 'focus', 'showService'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key]
  }
  if (typeof value.zoom === 'number' && Number.isFinite(value.zoom)) result.zoom = Math.max(.5, Math.min(3, value.zoom))
  if (typeof value.differenceColor === 'string' && /^#[0-9a-f]{6}$/i.test(value.differenceColor)) result.differenceColor = value.differenceColor.toLowerCase()
  if (typeof value.differenceOpacity === 'number' && Number.isFinite(value.differenceOpacity) && value.differenceOpacity >= 0 && value.differenceOpacity <= 1) result.differenceOpacity = value.differenceOpacity
  return result
}

function readRecord(storage: PreferenceStorage, key: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) || 'null')
    return record(value) ? value : null
  } catch { return null }
}

export function loadViewPreferences(projectId: string, storage?: PreferenceStorage): ViewPreferences {
  try {
    const target = storage ?? localStorage
    const saved = readRecord(target, viewPreferencesKey)
    if (saved?.version === 1) return normalize(saved)

    // Only seed the first global preference from this project's legacy settings.
    const legacy = readRecord(target, `pl-view-${projectId}`) || {}
    const style = readRecord(target, 'pl-difference-style') || {}
    return normalize({
      zoom: legacy.zoom, compare: legacy.compare, clean: legacy.clean,
      showText: legacy.showText, showMeasure: legacy.showMeasure, difference: legacy.difference,
      differenceColor: style.color, differenceOpacity: style.opacity,
    })
  } catch { return { ...defaults } }
}

export function saveViewPreferences(preferences: ViewPreferences, storage?: PreferenceStorage): void {
  try {
    const target = storage ?? localStorage
    target.setItem(viewPreferencesKey, JSON.stringify({ version: 1, ...normalize(preferences) }))
  } catch { /* View preferences are optional when browser storage is unavailable. */ }
}
