import { body, projectPath, request } from './api'
import { type Item, type PageData } from './types'

type Draft = { revision: number; items: Item[] }
type State = { data: PageData; undo: Item[][]; redo: Item[][]; dirty: boolean; version: number; error: string; saving: boolean; conflict: boolean;
  pending?: { revision: number; items: Item[]; operation_id: string; version: number }; server?: PageData }
const copy = <T,>(value: T): T => structuredClone(value)
const draftsDB = new Promise<IDBDatabase>((resolve, reject) => {
  const open = indexedDB.open('comic-prelayout-drafts', 1)
  open.onupgradeneeded = () => open.result.createObjectStore('pages')
  open.onsuccess = () => resolve(open.result)
  open.onerror = () => reject(open.error)
})
async function draft(key: string, value?: Draft | null): Promise<Draft | undefined> {
  const db = await draftsDB
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pages', value === undefined ? 'readonly' : 'readwrite')
    const store = tx.objectStore('pages')
    const operation = value === undefined ? store.get(key) : value === null ? store.delete(key) : store.put(value, key)
    tx.oncomplete = () => resolve(operation.result as Draft | undefined)
    tx.onerror = () => reject(tx.error)
  })
}

export class EditorState {
  readonly pages = new Map<string, State>()
  private loads = new Map<string, Promise<State>>()
  private listeners = new Map<string, Set<() => void>>()
  private ticks = new Map<string, number>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private inflight = new Map<string, Promise<boolean>>()
  private persistence = new Map<string, Promise<unknown>>()
  private groups = new Map<string, { key: string; time: number }>()
  constructor(readonly project: string) {}
  subscribe = (id: string, listener: () => void) => {
    const listeners = this.listeners.get(id) || new Set()
    listeners.add(listener); this.listeners.set(id, listeners)
    return () => { listeners.delete(listener) }
  }
  tick = (id: string) => this.ticks.get(id) || 0
  private emit(id: string) {
    for (const key of [id, '*']) {
      this.ticks.set(key, this.tick(key) + 1)
      this.listeners.get(key)?.forEach(listener => listener())
    }
  }
  async load(id: string) {
    const cached = this.pages.get(id)
    if (cached) return cached
    const loading = this.loads.get(id)
    if (loading) return loading
    const promise = (async () => {
      const data = await request<PageData>(`${projectPath(this.project)}/pages/${id}`)
      const state: State = { data, undo: [], redo: [], dirty: false, version: 0, error: '', saving: false, conflict: false }
      try {
        const local = await draft(`${this.project}/${id}`)
        if (local) {
          state.server = copy(data); state.data = { ...data, items: local.items }; state.dirty = true
          state.conflict = local.revision !== data.revision
          if (state.conflict) state.error = '瀏覽器草稿與伺服器版本不同，請選擇保留草稿或載入伺服器版。'
        }
      } catch { state.error = '瀏覽器草稿儲存不可用；請留意伺服器保存狀態。' }
      this.pages.set(id, state); this.emit(id)
      if (state.dirty && !state.conflict) this.schedule(id)
      return state
    })()
    this.loads.set(id, promise)
    try { return await promise } finally { this.loads.delete(id) }
  }
  edit(id: string, items: Item[], record = true, group?: string, continuing = false) {
    const state = this.pages.get(id)
    if (!state) return
    const previous = this.groups.get(id), time = performance.now()
    if (record && (!group || previous?.key !== group || (!continuing && time - previous.time > 350))) { state.undo.push(copy(state.data.items)); state.undo = state.undo.slice(-100); state.redo = [] }
    if (group) this.groups.set(id, { key: group, time }); else this.groups.delete(id)
    state.data.items = copy(items); state.dirty = true; state.version += 1
    this.persist(id); this.emit(id); this.schedule(id)
  }
  endGroup(id: string) { this.groups.delete(id) }
  undo(id: string, redo = false) {
    const state = this.pages.get(id)
    if (!state) return
    const from = redo ? state.redo : state.undo, to = redo ? state.undo : state.redo
    const items = from.pop()
    if (!items) return
    to.push(copy(state.data.items)); this.edit(id, items, false)
  }
  private persist(id: string, clear = false) {
    const state = this.pages.get(id)
    if (!state) return
    const value = clear ? null : { revision: state.data.revision, items: copy(state.data.items) }
    const chain = (this.persistence.get(id) || Promise.resolve()).then(() => draft(`${this.project}/${id}`, value))
      .catch(() => { state.error = '瀏覽器草稿保存失敗，請使用保存按鈕同步到伺服器。'; this.emit(id) })
    this.persistence.set(id, chain)
  }
  private schedule(id: string) {
    clearTimeout(this.timers.get(id))
    this.timers.set(id, setTimeout(() => { void this.save(id) }, 700))
  }
  async save(id: string): Promise<boolean> {
    clearTimeout(this.timers.get(id))
    const running = this.inflight.get(id)
    if (running) { await running; return this.save(id) }
    const state = this.pages.get(id)
    if (!state?.dirty) return true
    if (state.conflict) return false
    const pending = state.pending || { revision: state.data.revision, items: copy(state.data.items), operation_id: crypto.randomUUID(), version: state.version }
    state.pending = pending; state.saving = true; this.emit(id)
    const promise = (async () => {
      try {
        const data = await request<PageData>(`${projectPath(this.project)}/pages/${id}/text`, body({ expected_revision: pending.revision, items: pending.items, operation_id: pending.operation_id }, 'PATCH'))
        state.data.revision = data.revision; state.pending = undefined; state.error = ''; state.server = copy(data)
        if (state.version === pending.version) { state.data = data; state.dirty = false; this.persist(id, true) }
        else { this.persist(id); this.schedule(id) }
        return true
      } catch (error) {
        state.error = (error as Error).message
        if ((error as Error & { status?: number }).status === 409) state.conflict = true
        this.persist(id)
        return false
      } finally { state.saving = false; this.emit(id) }
    })()
    this.inflight.set(id, promise)
    try { return await promise } finally { this.inflight.delete(id) }
  }
  async flush() {
    for (const [id] of this.pages) {
      if (!await this.save(id)) return false
      if (this.pages.get(id)?.dirty && !await this.save(id)) return false
    }
    return !this.dirty
  }
  async resolve(id: string, keepLocal: boolean) {
    const state = this.pages.get(id)
    if (!state) return
    const server = await request<PageData>(`${projectPath(this.project)}/pages/${id}`)
    state.server = copy(server); state.data.revision = server.revision; state.conflict = false; state.pending = undefined; state.error = ''
    if (keepLocal) { state.dirty = true; await this.save(id) }
    else { state.undo.push(copy(state.data.items)); state.data = server; state.dirty = false; this.persist(id, true); this.emit(id) }
  }
  async reload() {
    if (this.dirty) throw new Error('尚有未保存的修改，請先保存再重新載入。')
    await Promise.all(this.persistence.values())
    const ids = [...this.pages.keys()]
    for (const id of ids) { this.pages.delete(id); this.emit(id) }
    await Promise.all(ids.map(id => this.load(id)))
  }
  async acceptRemote() {
    for (const [id, state] of this.pages) {
      const data = await request<PageData>(`${projectPath(this.project)}/pages/${id}`)
      if (state.dirty) throw new Error('文字已有修改，請先處理保存版本。')
      if (JSON.stringify(data.items) !== JSON.stringify(state.data.items)) {
        state.undo.push(copy(state.data.items)); state.undo = state.undo.slice(-100); state.redo = []
      }
      state.data = data; state.pending = undefined; state.error = ''; state.conflict = false
      this.persist(id, true); this.emit(id)
    }
  }
  get dirty() { return [...this.pages.values()].some(state => state.dirty) }
  dispose() { this.timers.forEach(clearTimeout) }
}
