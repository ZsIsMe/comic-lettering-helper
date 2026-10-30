import { body, projectPath, request } from './api'
import { type Item, type PageData, type Project } from './types'

type Draft = { revision: number; items: Item[] }
type Batch = { pages: string[] }
type SaveTask = { page_id: string; version: number; reviewed?: boolean; status: 'pending' | 'saved' | 'failed'; error: string; promise: Promise<boolean> }
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
  private saveTasks = new Map<string, SaveTask>()
  private persistence = new Map<string, Promise<unknown>>()
  private groups = new Map<string, { key: string; time: number }>()
  // Keep ordinary item snapshots public for the before/after preview, with shared
  // transaction metadata only for snapshots that belong to a cross-page edit.
  private batches = new WeakMap<Item[], Batch>()
  private textDraft: { page: string; finish: () => void; changed: boolean } | null = null
  constructor(readonly project: string) {}
  finishTextDraft() { this.textDraft?.finish() }
  beginTextDraft(page: string, finish: () => void) {
    this.textDraft?.finish()
    const session = { page, finish, changed: false }
    this.textDraft = session
    return {
      change: (changed: boolean) => {
        if (this.textDraft !== session || session.changed === changed) return
        session.changed = changed; this.emit(page)
      },
      end: () => {
        if (this.textDraft !== session) return
        this.textDraft = null; this.emit(page)
      },
    }
  }
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
  edit(id: string, items: Item[], record = true, group?: string, continuing = false, undoSnapshot?: Item[]) {
    const state = this.pages.get(id)
    if (!state) return
    const previous = this.groups.get(id), time = performance.now()
    if (record && (!group || previous?.key !== group || (!continuing && time - previous.time > 350))) {
      this.invalidateRedo(id)
      state.undo.push(copy(undoSnapshot || state.data.items)); this.trimUndo(id)
    }
    if (group) this.groups.set(id, { key: group, time }); else this.groups.delete(id)
    this.applyItems(id, items); this.changed(id)
  }
  editBatch(changes: ReadonlyMap<string, Item[]>) {
    this.textDraft?.finish()
    const prepared = [...changes].map(([id, items]) => {
      const state = this.pages.get(id)
      if (!state) throw new Error('跨頁修改前請先載入所有選中頁面。')
      return { id, state, items: copy(items), before: copy(state.data.items) }
    }).filter(page => JSON.stringify(page.items) !== JSON.stringify(page.before))
    if (!prepared.length) return
    const batch: Batch = { pages: prepared.map(page => page.id) }
    for (const page of prepared) this.invalidateRedo(page.id)
    for (const page of prepared) {
      this.groups.delete(page.id)
      this.batches.set(page.before, batch); page.state.undo.push(page.before)
      this.applyItems(page.id, page.items)
    }
    // All pages reach the new state before any subscribers observe the batch.
    for (const page of prepared) this.trimUndo(page.id)
    for (const page of prepared) this.changed(page.id)
  }
  private applyItems(id: string, items: Item[]) {
    const state = this.pages.get(id)!
    state.data.items = copy(items); delete state.data.reviewed_revision; state.dirty = true; state.version += 1
  }
  private changed(id: string) { this.persist(id); this.emit(id); this.schedule(id) }
  private invalidateRedo(id: string, visited = new Set<string>()) {
    if (visited.has(id)) return
    visited.add(id)
    const state = this.pages.get(id)
    if (!state) return
    const discarded = state.redo; state.redo = []
    for (const snapshot of discarded) {
      for (const page of this.batches.get(snapshot)?.pages || []) this.invalidateRedo(page, visited)
    }
  }
  private discardUndo(id: string, count: number) {
    const state = this.pages.get(id)
    if (!state) return
    const discarded = state.undo.splice(0, count)
    for (const snapshot of discarded) {
      const batch = this.batches.get(snapshot)
      if (!batch) continue
      for (const page of batch.pages) {
        const index = this.pages.get(page)?.undo.findIndex(entry => this.batches.get(entry) === batch) ?? -1
        // A lost history entry is a barrier: older snapshots on another page
        // cannot jump over that transaction and silently restore stale text.
        if (index >= 0) this.discardUndo(page, index + 1)
      }
    }
  }
  private trimUndo(id: string) {
    const length = this.pages.get(id)!.undo.length
    if (length > 100) this.discardUndo(id, length - 100)
  }
  endGroup(id: string) { this.groups.delete(id) }
  undo(id: string, redo = false) {
    this.textDraft?.finish()
    const direction = redo ? 'redo' : 'undo', opposite = redo ? 'undo' : 'redo'
    let target = id
    const visited = new Set<string>()
    while (!visited.has(target)) {
      visited.add(target)
      const snapshot = this.pages.get(target)?.[direction].at(-1)
      if (!snapshot) return
      const batch = this.batches.get(snapshot), ids = batch?.pages || [target]
      const blocker = batch && ids.find(page => this.batches.get(this.pages.get(page)?.[direction].at(-1) || []) !== batch)
      // Preserve chronology: first undo/redo the intervening operation on the
      // other page, rather than replacing its more recent content wholesale.
      if (blocker) { target = blocker; continue }
      for (const page of ids) {
        const state = this.pages.get(page)!, items = state[direction].pop()!, current = copy(state.data.items)
        if (batch) this.batches.set(current, batch)
        state[opposite].push(current); this.groups.delete(page); this.applyItems(page, items)
      }
      for (const page of ids) this.changed(page)
      return
    }
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
    if (running) { if (!await running) return false; return this.save(id) }
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
    try { return await promise } finally { if (this.inflight.get(id) === promise) this.inflight.delete(id) }
  }
  /** Register before starting I/O so navigation and leave guards see the entire operation. */
  startSave(id: string, reviewed?: boolean): SaveTask {
    this.textDraft?.finish()
    const state = this.pages.get(id)
    if (!state) throw new Error('保存前請先載入頁面。')
    const previous = this.saveTasks.get(id)
    if (previous?.status === 'pending') {
      if (previous.version === state.version && (reviewed === undefined || previous.reviewed === reviewed)) return previous
      throw new Error('此頁仍在背景保存，請稍後重新檢查再保存。')
    }
    if (previous?.status === 'failed' && reviewed === undefined && previous.reviewed !== undefined) {
      if (previous.version !== state.version) throw new Error('文字版本已變更，請重新檢查並明確指定 reviewed 後再保存。')
      reviewed = previous.reviewed
    }
    const task: SaveTask = { page_id: id, version: state.version, reviewed, status: 'pending', error: '', promise: Promise.resolve(false) }
    this.saveTasks.set(id, task)
    task.promise = Promise.resolve().then(async () => {
      try {
        if (!await this.save(id)) throw new Error(state.error || '文字保存失敗。')
        if (reviewed !== undefined) await this.writeReview(id, reviewed, task.version)
        task.status = 'saved'; task.error = ''; state.error = ''
        return true
      } catch (error) {
        task.status = 'failed'; task.error = (error as Error).message; state.error = task.error
        if ((error as Error & { status?: number }).status === 409) state.conflict = true
        this.persist(id)
        return false
      } finally { state.saving = false; this.emit(id) }
    })
    state.saving = true; this.emit(id)
    return task
  }
  get saveStatus() {
    const tasks = [...this.saveTasks.values()].map(({ page_id, version, reviewed, status, error }) => ({ page_id, version, reviewed, status, error }))
    const pending_saves = tasks.filter(task => task.status === 'pending')
    const save_failures = tasks.filter(task => task.status === 'failed')
    return { status: save_failures.length ? 'failed' : pending_saves.length || this.dirty ? 'pending' : 'saved', pending_saves, save_failures }
  }
  /** Explicit save/leave actions retry transport errors; stale completion intents require a fresh review request. */
  retryFailedSaves() {
    for (const [id, task] of this.saveTasks) {
      if (task.status !== 'failed') continue
      const state = this.pages.get(id)!
      if (state.conflict || (task.reviewed !== undefined && task.version !== state.version)) continue
      this.startSave(id, task.reviewed)
    }
  }
  async flush() {
    this.textDraft?.finish()
    this.retryFailedSaves()
    // Re-scan after every await: edits and other-page background saves can arrive during I/O.
    while (true) {
      const pending = [...this.saveTasks.values()].filter(task => task.status === 'pending')
      if (pending.length) {
        const results = await Promise.all(pending.map(task => task.promise))
        if (results.some(saved => !saved)) return false
        continue
      }
      if ([...this.saveTasks.values()].some(task => task.status === 'failed')) return false
      const dirty = [...this.pages].find(([, state]) => state.dirty)
      if (!dirty) return !this.dirty
      if (!await this.save(dirty[0])) return false
    }
  }
  private async writeReview(id: string, reviewed: boolean, version: number) {
    const state = this.pages.get(id)!
    if (state.version !== version || state.dirty) {
      delete state.data.reviewed_revision; this.emit(id)
      throw new Error('保存期間文字已有修改，請重新檢查後標記完成。')
    }
    state.saving = true; this.emit(id)
    const data = await request<PageData>(`${projectPath(this.project)}/pages/${id}/review`, body({ expected_revision: state.data.revision, reviewed }, 'PUT'))
    if (state.version !== version || state.dirty) {
      // A concurrent local edit must never acquire the older revision's completion marker.
      delete state.data.reviewed_revision
      throw new Error('保存期間文字已有修改，請重新檢查後標記完成。')
    }
    state.data = data; state.server = copy(data); state.error = ''; this.persist(id, true); this.emit(id)
  }
  async markReviewed(id: string, reviewed: boolean) {
    this.textDraft?.finish()
    if (!this.pages.has(id)) await this.load(id)
    const task = this.startSave(id, reviewed)
    if (!await task.promise) throw new Error(task.error)
  }
  async resolve(id: string, keepLocal: boolean) {
    const state = this.pages.get(id)
    if (!state) return
    const saving = this.saveTasks.get(id)
    if (saving?.status === 'pending') await saving.promise
    const version = state.version
    const server = await request<PageData>(`${projectPath(this.project)}/pages/${id}`)
    if (state.version !== version) throw new Error('載入期間文字已有修改，請重新處理保存版本。')
    state.server = copy(server); state.data.revision = server.revision; state.version += 1; state.conflict = false; state.pending = undefined; state.error = ''
    this.saveTasks.delete(id)
    if (keepLocal) { state.dirty = true; await this.save(id) }
    else {
      this.invalidateRedo(id); this.groups.delete(id)
      state.undo.push(copy(state.data.items)); this.trimUndo(id)
      state.data = server; state.dirty = false; this.persist(id, true); this.emit(id)
    }
  }
  async reload() {
    if (this.dirty) throw new Error('尚有未保存的修改，請先保存再重新載入。')
    await Promise.all(this.persistence.values())
    const ids = [...this.pages.keys()]
    this.groups.clear(); this.batches = new WeakMap()
    for (const id of ids) { this.pages.delete(id); this.emit(id) }
    await Promise.all(ids.map(id => this.load(id)))
  }
  async acceptRemote() {
    for (const [id, state] of this.pages) {
      const data = await request<PageData>(`${projectPath(this.project)}/pages/${id}`)
      if (state.dirty) throw new Error('文字已有修改，請先處理保存版本。')
      if (JSON.stringify(data.items) !== JSON.stringify(state.data.items)) {
        this.invalidateRedo(id); this.groups.delete(id)
        state.undo.push(copy(state.data.items)); this.trimUndo(id)
      }
      state.data = data; state.version += 1; state.pending = undefined; state.error = ''; state.conflict = false
      this.persist(id, true); this.emit(id)
    }
  }
  async acceptTextReplacement(project: Project) {
    if (project.id !== this.project) throw new Error('替換結果不屬於目前項目。')
    if (this.dirty || this.editing) throw new Error('文字已有修改，請先保存再載入替換結果。')
    const changed = project.pages.flatMap(page => {
      const state = this.pages.get(page.id)
      return state && state.data.revision < page.revision ? [{ id: page.id, state, version: state.version }] : []
    })
    const data = await Promise.all(changed.map(page => request<PageData>(`${projectPath(this.project)}/pages/${page.id}`)))
    if (this.dirty || this.editing || changed.some(page => this.pages.get(page.id) !== page.state || page.state.version !== page.version)) {
      throw new Error('載入期間文字已有修改，請先處理草稿再重新載入。')
    }
    for (const [index, page] of changed.entries()) {
      const state = page.state
      clearTimeout(this.timers.get(page.id)); this.groups.delete(page.id)
      state.data = data[index]; state.server = copy(data[index]); state.version += 1
      // Earlier per-page snapshots must not silently reintroduce text from before a project-wide replacement.
      this.discardUndo(page.id, state.undo.length); this.invalidateRedo(page.id)
      state.pending = undefined; state.error = ''; state.conflict = false
      this.persist(page.id, true); this.emit(page.id)
    }
    await Promise.all(changed.map(page => this.persistence.get(page.id)))
  }
  get dirty() { return !!this.textDraft?.changed || [...this.pages.values()].some(state => state.dirty) || [...this.saveTasks.values()].some(task => task.status !== 'saved') }
  get editing() { return this.textDraft !== null }
  dispose() { this.timers.forEach(clearTimeout) }
}
