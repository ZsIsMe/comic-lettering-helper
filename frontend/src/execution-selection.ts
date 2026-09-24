/** A draft page selection, independent of workflow choices and generated results. */
export type ExecutionSelection = { mode: 'all' } | { mode: 'pages'; pageIds: string[] }

export function executionPageIds(selection: ExecutionSelection, allIds: readonly string[]): string[] {
  return selection.mode === 'all' ? [...allIds] : allIds.filter(id => selection.pageIds.includes(id))
}

export function selectionFromPages(ids: readonly string[], allIds: readonly string[]): ExecutionSelection {
  const selected = allIds.filter(id => ids.includes(id))
  return selected.length === allIds.length ? { mode: 'all' } : { mode: 'pages', pageIds: selected }
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
