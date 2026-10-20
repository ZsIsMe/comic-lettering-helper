import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Select } from 'antd'
import { getFontCatalogue, refreshFontCatalogue, subscribeFontCatalogue } from './font-catalogue'
import { fontName, loadLocalFont, fontFamilies, fontStyleLabel, selectedFontFamily, familyFace } from './local-fonts'

export function LocalFontPicker({ value, mixed, values, selectionKey, onChange, disabled = false, onLoadingChange, compact = false }: { value: unknown; mixed: boolean; values: unknown[]; selectionKey: string; disabled?: boolean; compact?: boolean; onLoadingChange?: (loading: boolean) => void; onChange: (name: string) => void }) {
  const catalogue = useSyncExternalStore(subscribeFontCatalogue, getFontCatalogue)
  const fonts = catalogue.fonts
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState('')
  const action = useRef(0)
  const loadingChange = useRef(onLoadingChange); loadingChange.current = onLoadingChange
  useEffect(() => {
    loadingChange.current?.(busy)
    return () => { loadingChange.current?.(false) }
  }, [busy])
  const name = fontName(value)
  useEffect(() => {
    let live = true
    if (name) void loadLocalFont(name).then(() => { if (live) setMissing('') }).catch(() => { if (live) setMissing(name) })
    return () => { live = false }
  }, [name])
  // Selection may change while an asynchronous font load is pending.
  useEffect(() => { const state = action; state.current++; return () => { state.current++ } }, [value, mixed, selectionKey])
  async function list() {
    setBusy(true); setError('')
    try {
      await refreshFontCatalogue()
    } catch (e) { setError(e instanceof Error ? e.message : '無法讀取本機字體。') }
    finally { setBusy(false) }
  }
  async function choose(next: string) {
    const token = ++action.current
    setError(''); setBusy(true)
    try {
      await loadLocalFont(next, true)
      if (token === action.current) { onChange(next); setMissing('') }
    } catch { if (token === action.current) setError('此字體無法在瀏覽器載入，尚未套用；請確認字體已安裝並可供瀏覽器使用。') }
    finally { setBusy(false) }
  }
  const families = fontFamilies(fonts)
  const current = fonts.find(font => font.postscriptName === name)
  const familyName = selectedFontFamily(fonts, values)
  const family = families.find(group => group.name === familyName)
  const familyOptions = families.map(group => ({ value: group.name, label: group.label, search: `${group.label} ${group.search}` }))
  if (name && !mixed && !current) familyOptions.unshift({ value: name, label: name, search: name })
  const styleOptions = family?.faces.map(font => ({ value: font.postscriptName, label: fontStyleLabel(font), search: `${fontStyleLabel(font)} ${font.style} ${font.postscriptName}` })) || []
  return <div className={`pl-local-font ${compact ? 'pl-local-font--compact' : ''}`}>{!compact && <div className="pl-local-font-heading"><span>字體／字重</span><Button title={catalogue.updatedAt ? '已使用本地快取；點擊才重新讀取已安裝字體。' : undefined} size="small" loading={busy} disabled={disabled} onClick={() => void list()}>{catalogue.updatedAt ? '更新字體列表' : '讀取本機字體'}</Button></div>}
    <div className="pl-local-font-fields"><Select size={compact ? 'small' : undefined} title={name || undefined} aria-label="本機字體" showSearch optionFilterProp="search" disabled={busy || disabled} value={familyName || (!mixed && name ? name : undefined)} placeholder={mixed ? '混合字體' : compact ? '未設定字體' : '預設預覽字體'} options={familyOptions} onChange={next => {
      const group = families.find(group => group.name === next)
      if (group) void choose(familyFace(group, mixed ? undefined : current).postscriptName)
    }} />
    <Select size={compact ? 'small' : undefined} aria-label="字重" showSearch optionFilterProp="search" disabled={busy || disabled || !family} value={mixed ? undefined : current?.postscriptName} placeholder={mixed && family ? '混合字重' : '字重'} options={styleOptions} onChange={next => void choose(next)} /></div>
    {!compact && name && !mixed && <small title={name}>{name}</small>}
    {missing === name && name && <small role="status">此字體暫不可用，使用預覽字體；原 font 保留。</small>}
    {error && <small role="alert">{error}</small>}
  </div>
}
