import type { WorkflowId, WorkflowProgressMap } from './workflow-progress'
import type { RepairScope } from './repair-scope'

export type Workflow = WorkflowId
export const workflowOptions: { value: Workflow; label: string }[] = [
  { value: 'flux2klein_lanpaint', label: 'Flux2 Klein + LanPaint' },
  { value: 'firered', label: 'FireRed FP8' },
  { value: 'qwen2511_lanpaint', label: 'Qwen Image 2.1 INT8' },
]
export interface Page {
  id: string; stem: string; filename: string; width: number; height: number
  original: string; source: string; overlay: string | null; other: string | null; edited: string | null
  edit_revision: number; mask_ready?: boolean; has_repair_mask?: boolean
  thumbnail?: string
  detected_text?: string
}
export interface DetectionOptions {
  mask_dilate: number
  mask_mode: 'text_onomatopoeia' | 'text' | 'onomatopoeia' | 'all'
  bubble_enabled: boolean
  bubble_shrink_percent: number
}
export const defaultDetectionOptions: DetectionOptions = { mask_dilate: 2, mask_mode: 'text_onomatopoeia', bubble_enabled: true, bubble_shrink_percent: 2 }
export interface Project {
  repair_scope?: RepairScope
  id: string; name: string; revision: number; state: string; pages: Page[]
  runs: { id: string; snapshot_id: string; workflows: Workflow[]; created_at: string }[]
  current_run_id: string | null; created_at: string; updated_at: string; storage_bytes?: number
  detection_options?: DetectionOptions
  detection?: { id: string; state: string; message: string; error?: string | null } | null
}
export interface Run {
  created_at: string; updated_at: string; finished_at?: string | null
  id: string; name: string; state: string; message: string; error: string | null
  workflows: Workflow[]; pair_count: number; black_mask_count: number
  completed_total: number; total_runs: number; download_ready: boolean; partial_results_accepted?: boolean
  workflow_progress?: WorkflowProgressMap
  result_directory: string | null; archive_path: string | null
}
export interface CompositionPage {
  page_id: string; stem: string; width: number; height: number; confirmed: boolean; passthrough: boolean
  warnings: string[]; candidates: { workflow: Workflow; code: number; available: boolean; error?: string }[]
  base_url: string; preview_url: string; assignment_url: string
}
export interface Composition {
  revision: number; run_id: string; snapshot_id: string; workflow_codes: Record<string, number>
  settings: { threshold: number; min_area: number; expand_px: number; feather_px: number }
  pages: CompositionPage[]
}
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const payload = await response.json()
  if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail || '操作失敗'))
  return payload as T
}
export const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
export const projectUrl = (id: string) => `/api/projects/${encodeURIComponent(id)}`
export const assetUrl = (id: string, path: string | null) => path ? `${projectUrl(id)}/assets/${path.split('/').map(encodeURIComponent).join('/')}` : ''
export const active = (state: string) => ['queued', 'validating', 'running', 'packaging', 'abandoning'].includes(state)
export function selectedFiles(files: FileList | readonly File[] | null, mask = false): File[] {
  return Array.from(files || []).filter(file => !file.name.startsWith('._')
    && (!file.webkitRelativePath || file.webkitRelativePath.replace(/\\/g, '/').split('/').length <= 2)
    && (mask ? /\.png$/i : /\.(png|jpe?g)$/i).test(file.name))
}
