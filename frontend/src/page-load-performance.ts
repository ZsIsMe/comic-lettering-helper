/** Bounded, local diagnostics. Durations overlap where assets load concurrently. */
export interface PageLoadRecord {
  id: number
  pageId: string
  reason: string
  status: 'loading' | 'ready' | 'failed' | 'cancelled' | 'superseded'
  totalMs: number
  stages: Record<string, number>
  details: Record<string, string | number | boolean>
}
let nextId = 0
const records: PageLoadTrace[] = []
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) { try { listener() } catch { /* Diagnostics must not break editing. */ } } }
export class PageLoadTrace {
  private readonly started = performance.now()
  private readonly running = new Map<string, number>()
  private readonly record: PageLoadRecord
  constructor(pageId: string, reason: string) {
    this.record = { id: ++nextId, pageId, reason, status: 'loading', totalMs: 0, stages: {}, details: {} }
  }
  stage(name: string) {
    if (remember(this)) emit()
    const started = performance.now()
    this.running.set(name, started)
    return () => {
      if (this.record.status !== 'loading' || this.running.get(name) !== started) return
      this.record.stages[name] = performance.now() - started
      this.running.delete(name)
    }
  }
  async measure<T>(name: string, action: () => Promise<T>): Promise<T> {
    const end = this.stage(name)
    try { return await action() } finally { end() }
  }
  detail(name: string, value: string | number | boolean) { this.record.details[name] = value }
  finish(status: PageLoadRecord['status'] = 'ready') {
    if (this.record.status !== 'loading') return
    remember(this)
    this.record.status = status
    this.record.totalMs = performance.now() - this.started
    emit()
  }
  snapshot(): PageLoadRecord {
    return { ...this.record, stages: { ...this.record.stages }, details: { ...this.record.details } }
  }
}
function remember(trace: PageLoadTrace) {
  if (records.includes(trace)) return false
  records.push(trace)
  if (records.length > 20) records.shift()
  return true
}
export const startPageLoad = (pageId: string, reason: string) => new PageLoadTrace(pageId, reason)
export const getPageLoadRecords = () => records.map(trace => trace.snapshot())
export const clearPageLoadRecords = () => { records.length = 0; emit() }
export function subscribePageLoads(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export const measurePageStage = <T>(trace: PageLoadTrace | undefined, name: string, action: () => Promise<T>) => trace ? trace.measure(name, action) : action()
