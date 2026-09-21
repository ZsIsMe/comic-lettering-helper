export type WorkflowId = 'firered' | 'qwen2511_lanpaint' | 'flux2klein_lanpaint'

export type WorkflowProgressState = 'waiting' | 'preparing' | 'running' | 'completed' | 'failed' | 'abandoned'

export interface WorkflowProgressRecord {
  state: WorkflowProgressState
  completed: number
  total: number
  generated: number
  passthrough: number
  first_seconds: number | null
  warm_average_seconds: number | null
  elapsed_seconds: number
  remaining_seconds: number | null
  started_at: string | null
  finished_at: string | null
}

export type WorkflowProgressMap = Partial<Record<WorkflowId, WorkflowProgressRecord>>

export const workflowDisplayNames: Record<WorkflowId, string> = {
  qwen2511_lanpaint: 'Qwen Image 2.1 INT8',
  firered: 'FireRed FP8',
  flux2klein_lanpaint: 'Flux2 Klein + LanPaint',
}

const workflowStateLabels: Record<WorkflowProgressState, string> = {
  waiting: '等待執行',
  preparing: '準備中',
  running: '運行中',
  completed: '已完成',
  failed: '失敗',
  abandoned: '已放棄',
}

export function workflowName(workflow: WorkflowId): string {
  return workflowDisplayNames[workflow]
}

export function workflowStateLabel(state: WorkflowProgressState): string {
  return workflowStateLabels[state]
}

export function formatWorkflowSeconds(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '未記錄'
  const rounded = Math.max(0, Math.round(seconds))
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainder = rounded % 60
  if (hours) return `${hours} 小時 ${minutes} 分 ${remainder} 秒`
  if (minutes) return `${minutes} 分 ${remainder} 秒`
  return `${remainder} 秒`
}

const activeStates = new Set<WorkflowProgressState>(['waiting', 'preparing', 'running'])
const terminalStates = new Set<WorkflowProgressState>(['completed', 'failed', 'abandoned'])

export function firstTimingText(progress: WorkflowProgressRecord): string {
  if (progress.first_seconds !== null) return formatWorkflowSeconds(progress.first_seconds)
  if (activeStates.has(progress.state)) return '待完成'
  if (progress.state === 'completed' && progress.completed === progress.passthrough) return '不需生成'
  return '未記錄'
}

export function warmTimingText(progress: WorkflowProgressRecord): string {
  if (progress.warm_average_seconds !== null) return `${formatWorkflowSeconds(progress.warm_average_seconds)}／張`
  if (activeStates.has(progress.state)) return '待完成'
  if (Math.max(0, progress.completed - progress.passthrough) <= 1) return '—'
  return '未記錄'
}

export function remainingTimingText(progress: WorkflowProgressRecord): string {
  if (terminalStates.has(progress.state)) return '—'
  if (progress.remaining_seconds !== null) return formatWorkflowSeconds(progress.remaining_seconds)
  if (progress.state === 'running') return '估算中'
  if (progress.state === 'waiting' || progress.state === 'preparing') return '待估算'
  return '—'
}

export function friendlyWorkflowText(text: string): string {
  return text
    .replaceAll('qwen2511_lanpaint', workflowDisplayNames.qwen2511_lanpaint)
    .replaceAll('flux2klein_lanpaint', workflowDisplayNames.flux2klein_lanpaint)
    .replaceAll('firered', workflowDisplayNames.firered)
}
