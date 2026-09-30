import { body, projectPath, request } from './api'
import type { Project } from './types'

export type ReplacementSummary = { pages: number; items: number; occurrences: number }
export type ReplacementMatch = {
  page_number: number; page_name: string; page_id: string; item_id: string;
  before: string; after: string; occurrences: number;
}
export type ReplacementPreview = { project_revision: number; matches: ReplacementMatch[]; summary: ReplacementSummary }
export type ReplacementOperation = { operation_id: string; summary: ReplacementSummary }
export type LatestReplacement = { operation: ReplacementOperation | null; can_undo: boolean }
export type ReplacementResult = { project: Project; summary: ReplacementSummary; operation?: ReplacementOperation | null }
type ApplyPayload = { find: string; replacement: string; expected_revision: number; selected: { page_id: string; item_id: string }[]; operation_id: string }
type UndoPayload = { operation_id: string; expected_revision: number; undo_operation_id: string }
export type ReplacementAttempt = { kind: 'apply'; payload: ApplyPayload } | { kind: 'undo'; payload: UndoPayload }

/** Retain the exact request across network failures and refreshes. Never retry with a new operation ID. */
export class TextReplacementClient {
  pending: ReplacementAttempt | null = null
  private readonly storageKey: string
  private readonly url: string
  constructor(project: string, private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage) {
    this.storageKey = `pl-text-replacement-attempt-${project}`
    this.url = `${projectPath(project)}/text-replacements`
    let saved: string | null = null
    try { saved = storage.getItem(this.storageKey) } catch { /* Reading storage must not prevent ordinary editing. */ }
    if (saved) {
      try {
        const value = JSON.parse(saved) as ReplacementAttempt
        const p = value?.payload
        if (!p || !Number.isInteger(p.expected_revision) || p.expected_revision < 0 || typeof p.operation_id !== 'string'
          || (value.kind === 'apply' ? typeof value.payload.find !== 'string' || !value.payload.find.length || typeof value.payload.replacement !== 'string'
            || !Array.isArray(value.payload.selected) || !value.payload.selected.every(x => typeof x.page_id === 'string' && typeof x.item_id === 'string')
            : value.kind !== 'undo' || typeof value.payload.undo_operation_id !== 'string')) throw new Error('Invalid saved request')
        this.pending = value
      } catch { try { storage.removeItem(this.storageKey) } catch { /* Saving is checked again before any mutation. */ } }
    }
  }
  preview(find: string, replacement: string) {
    if (this.pending) throw new Error('上次操作結果尚未確認，請先重試。')
    return request<ReplacementPreview>(`${this.url}/preview`, body({ find, replacement }))
  }
  latest() { return request<LatestReplacement>(`${this.url}/latest`) }
  apply(preview: ReplacementPreview, find: string, replacement: string, selected: ReplacementMatch[]) {
    if (this.pending) throw new Error('上次操作結果尚未確認，請先重試。')
    return this.send({ kind: 'apply', payload: { find, replacement, expected_revision: preview.project_revision,
      selected: selected.map(({ page_id, item_id }) => ({ page_id, item_id })), operation_id: crypto.randomUUID() } })
  }
  undo(operation: ReplacementOperation, revision: number) {
    if (this.pending) throw new Error('上次操作結果尚未確認，請先重試。')
    return this.send({ kind: 'undo', payload: { operation_id: operation.operation_id, expected_revision: revision, undo_operation_id: crypto.randomUUID() } })
  }
  retry() {
    if (!this.pending) throw new Error('沒有待重試的操作。')
    return this.send(this.pending)
  }
  private async send(attempt: ReplacementAttempt): Promise<ReplacementResult> {
    // Persist before sending, so refresh after an unknown outcome can recover the same operation.
    this.storage.setItem(this.storageKey, JSON.stringify(attempt))
    this.pending = attempt
    try {
      const result = await request<ReplacementResult>(`${this.url}/${attempt.kind}`, body(attempt.payload))
      this.storage.removeItem(this.storageKey); this.pending = null
      return result
    } catch (error) {
      const status = (error as Error & { status?: number }).status
      if (status === 400 || status === 404 || status === 409 || status === 422) {
        this.storage.removeItem(this.storageKey); this.pending = null
      }
      throw error
    }
  }
}
