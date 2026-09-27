/** A draft page selection, independent of workflow choices and generated results. */
export type ExecutionSelection = { mode: 'all' } | { mode: 'pages'; pageIds: string[] }

export function executionPageIds(selection: ExecutionSelection, allIds: readonly string[]): string[] {
  return selection.mode === 'all' ? [...allIds] : allIds.filter(id => selection.pageIds.includes(id))
}

export function selectionFromPages(ids: readonly string[], allIds: readonly string[]): ExecutionSelection {
  const selected = allIds.filter(id => ids.includes(id))
  return selected.length === allIds.length ? { mode: 'all' } : { mode: 'pages', pageIds: selected }
}

/** Resolve against the latest project so a stale selection cannot enter a job. */
export function executionPlan(pages: readonly { id: string; filename: string; mask_ready?: boolean }[], selection: ExecutionSelection) {
  const pageIds = executionPageIds(selection, pages.map(page => page.id))
  const chosen = pages.filter(page => pageIds.includes(page.id))
  return { pageIds, missingMasks: chosen.filter(page => !page.mask_ready).map(page => page.filename) }
}

export function executionJobRequest(pages: readonly { id: string; filename: string; mask_ready?: boolean }[], selection: ExecutionSelection,
  workflows: readonly string[], expectedRevision: number) {
  const plan = executionPlan(pages, selection)
  if (!plan.pageIds.length) throw new Error('請至少選擇一張執行圖片')
  if (plan.missingMasks.length) throw new Error(`所選圖片的 Mask 尚未備妥：${plan.missingMasks.join('、')}`)
  return { workflows: [...workflows], expected_revision: expectedRevision, page_ids: plan.pageIds }
}

export function addPageToNextRound(selection: ExecutionSelection, pageId: string, allIds: readonly string[]): ExecutionSelection {
  if (!allIds.includes(pageId)) return selection
  const selected = executionPageIds(selection, allIds)
  return selected.length === allIds.length
    ? { mode: 'pages', pageIds: [pageId] }
    : selectionFromPages([...selected, pageId], allIds)
}

export function workflowRoundName(workflow: string, date: Date): string {
  const label = ({ flux2klein_lanpaint: 'Flux', firered: 'FireRed', qwen2511_lanpaint: 'Qwen' })[workflow] || workflow
  const time = [date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => String(value).padStart(2, '0')).join('')
  return `${label}_${time}`
}
