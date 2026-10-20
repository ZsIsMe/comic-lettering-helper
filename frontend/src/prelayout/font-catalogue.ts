import { base, request } from './api'
import { browserFonts, fontName, normalizeFonts, type LocalFont } from './local-fonts'

type Catalogue = { fonts: LocalFont[]; updatedAt: number }
const cacheKey = 'pl-local-font-catalogue-v1'
let catalogue: Catalogue = { fonts: [], updatedAt: 0 }
let hydrated = false
let pending: Promise<void> | undefined
const listeners = new Set<() => void>()

function parse(raw: string | null): Catalogue | undefined {
  try {
    if (!raw || raw.length > 4000000) return
    const value = JSON.parse(raw)
    if (value.version !== 1 || !Array.isArray(value.fonts) || value.fonts.length > 10000 || !Number.isFinite(value.updatedAt) || value.updatedAt <= 0) return
    const fonts: LocalFont[] = []
    for (const item of value.fonts) {
      if (!item || typeof item !== 'object' || !fontName(item.postscriptName)) return
      const font: LocalFont = { postscriptName: item.postscriptName, family: '', fullName: '', style: '' }
      for (const key of ['family', 'fullName', 'style', 'localizedFamily', 'localizedFullName', 'localizedStyle'] as const) {
        if (item[key] !== undefined && (typeof item[key] !== 'string' || item[key].length > 512)) return
        if (item[key] !== undefined) font[key] = item[key]
      }
      fonts.push(font)
    }
    return { fonts: normalizeFonts(fonts), updatedAt: value.updatedAt }
  } catch { /* A malformed or unavailable local cache must not block editing. */ }
}
export function getFontCatalogue(): Catalogue {
  if (!hydrated) {
    hydrated = true
    try { catalogue = parse(localStorage.getItem(cacheKey)) || catalogue } catch { /* Optional persistence. */ }
  }
  return catalogue
}
export const getCachedFonts = () => getFontCatalogue().fonts
const emit = () => { for (const listener of listeners) listener() }
function storageChanged(event: StorageEvent) {
  if (event.key !== cacheKey) return
  const next = parse(event.newValue)
  catalogue = next || { fonts: [], updatedAt: 0 }; hydrated = true; emit()
}
export function subscribeFontCatalogue(listener: () => void) {
  if (!listeners.size) window.addEventListener('storage', storageChanged)
  listeners.add(listener)
  return () => { listeners.delete(listener); if (!listeners.size) window.removeEventListener('storage', storageChanged) }
}
export function refreshFontCatalogue(): Promise<void> {
  if (pending) return pending
  pending = (async () => {
    let fonts: LocalFont[] | null = null
    try {
      const result = await request<{ available: boolean; fonts: LocalFont[] }>(`${base}/local-fonts?refresh=true`)
      if (result.available) fonts = result.fonts
    } catch { /* An older or remote server can still use browser permission. */ }
    const available = normalizeFonts(fonts ?? await browserFonts())
    const next = parse(JSON.stringify({ version: 1, fonts: available, updatedAt: Date.now() }))
    if (!next) throw new Error('字體列表格式無效，已保留原快取。')
    catalogue = next; hydrated = true
    try { localStorage.setItem(cacheKey, JSON.stringify({ version: 1, ...next })) } catch { /* Still usable in memory if browser storage is full. */ }
    emit()
  })().finally(() => { pending = undefined })
  return pending
}
