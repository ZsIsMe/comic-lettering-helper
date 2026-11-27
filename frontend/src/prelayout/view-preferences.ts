export type ViewPreferences = {
  zoom: number
  compare: boolean
  clean: boolean
  backgroundOpacity: number
  showText: boolean
  showMeasure: boolean
  difference: boolean
  differenceColor: string
  differenceOpacity: number
  focus: boolean
  showService: boolean
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

type PrelayoutTheme = 'light' | 'dark'
const themeKey = 'pl-color-theme'

export function loadPrelayoutTheme(storage?: PreferenceStorage): PrelayoutTheme {
  try {
    return (storage ?? localStorage).getItem(themeKey) === 'dark' ? 'dark' : 'light'
  } catch { return 'light' }
}

export function savePrelayoutTheme(theme: PrelayoutTheme, storage?: PreferenceStorage): void {
  try { (storage ?? localStorage).setItem(themeKey, theme) } catch { /* The selected theme still works for this session. */ }
}

export const viewPreferencesKey = 'pl-view-preferences'
const defaults: Readonly<ViewPreferences> = {
  zoom: 1, compare: true, clean: true, backgroundOpacity: 1, showText: true, showMeasure: true,
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
  for (const key of ['backgroundOpacity', 'differenceOpacity'] as const) {
    const opacity = value[key]
    if (typeof opacity === 'number' && opacity >= 0 && opacity <= 1) result[key] = opacity
  }
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
