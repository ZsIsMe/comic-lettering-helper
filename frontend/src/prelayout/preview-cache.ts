import { useEffect, useRef, useState } from 'react'
type Entry = { refs: number; size: number; used: number; url: string; image?: HTMLImageElement; abort: AbortController; ready: boolean; promise: Promise<string> }
const entries = new Map<string, Entry>()
const budget = 256 * 1024 * 1024
function dispose(key: string, entry: Entry) {
  entry.abort.abort()
  if (entry.url) URL.revokeObjectURL(entry.url)
  if (entry.image) entry.image.src = ''
  if (entries.get(key) === entry) entries.delete(key)
}
function trim() {
  let bytes = [...entries.values()].reduce((sum, entry) => sum + entry.size, 0)
  for (const [key, entry] of [...entries].sort((a, b) => a[1].used - b[1].used)) {
    if (entry.refs || (bytes <= budget && entries.size <= 40)) continue
    bytes -= entry.size; dispose(key, entry)
  }
}
function acquire(key: string) {
  let entry = entries.get(key)
  if (!entry) {
    const abort = new AbortController()
    entry = { refs: 0, size: 0, used: performance.now(), url: '', abort, ready: false, promise: Promise.resolve('') }
    const current = entry
    current.promise = (async () => {
      const response = await fetch(key, { signal: abort.signal })
      if (!response.ok) throw new Error('圖片載入失敗')
      const blob = await response.blob()
      if (abort.signal.aborted) throw new Error('cancelled')
      current.url = URL.createObjectURL(blob)
      const image = new Image(); current.image = image; image.src = current.url
      await image.decode()
      if (abort.signal.aborted) throw new Error('cancelled')
      current.size = image.naturalWidth * image.naturalHeight * 4
      trim()
      if ([...entries.values()].reduce((sum, item) => sum + item.size, 0) > budget) throw new Error('預覽快取已滿，保留較低解析度底圖')
      current.ready = true
      return current.url
    })().catch(error => { dispose(key, current); throw error })
    entries.set(key, current)
  }
  entry.refs += 1; entry.used = performance.now()
  return entry
}
function release(key: string, entry: Entry) {
  entry.refs -= 1
  if (!entry.refs && !entry.ready) dispose(key, entry)
  trim()
}
export function usePreview(key: string, frozen = false) {
  const [value, setValue] = useState({ url: '', error: '' })
  const displayed = useRef<{ key: string; entry: Entry } | null>(null)
  useEffect(() => {
    let live = true
    const entry = acquire(key)
    entry.promise.then(url => {
      if (!live || (frozen && displayed.current && displayed.current.entry !== entry)) return
      const old = displayed.current
      displayed.current = { key, entry }
      setValue({ url, error: '' })
      if (old) release(old.key, old.entry)
    }).catch(error => {
      if (live) setValue(previous => ({ ...previous, error: (error as Error).message }))
    })
    return () => {
      live = false
      if (displayed.current?.entry !== entry) release(key, entry)
    }
  }, [key, frozen])
  useEffect(() => () => {
    if (displayed.current) release(displayed.current.key, displayed.current.entry)
    displayed.current = null
  }, [])
  return value
}
export function cacheStats() {
  return { entries: entries.size, active: [...entries.values()].filter(entry => entry.refs > 0).length,
    decodedBytes: [...entries.values()].reduce((sum, entry) => sum + entry.size, 0), budget }
}
// Opt-in diagnostics for the reproducible browser acceptance script.
if (new URLSearchParams(location.search).has('prelayoutDiagnostics')) {
  Object.defineProperty(window, '__prelayoutCacheStats', { value: cacheStats, configurable: true })
}
