import { workflowRoundName } from './execution-selection'
import type { CompositionPage, Project, RoundComposition, Workflow } from './workbench-api'

export function canConfirmRoundPage(page: CompositionPage | undefined): boolean {
  return !!page && (page.passthrough || page.candidates.some(candidate => candidate.available))
}

export function roundRows(composition: RoundComposition | null, runs: Project['runs']) {
  return (composition?.candidates || []).map(candidate => {
    const run = runs.find(item => item.id === candidate.run_id)
    return {
      ...candidate,
      label: run ? workflowRoundName(candidate.workflow, new Date(run.created_at)) : `${candidate.workflow} · ${candidate.run_id.slice(0, 8)}`,
      generatedCount: candidate.available_count ?? composition?.pages.filter(page => page.candidates.some(item => item.code === candidate.code && item.available)).length ?? 0,
      targetCount: candidate.target_count,
    }
  })
}

export function roundSelectionChanges(candidates: RoundComposition['candidates'], selectedCodes: readonly number[]) {
  const selected = new Set(selectedCodes)
  return candidates.filter(candidate => candidate.selected !== selected.has(candidate.code))
    .map(candidate => ({ code: candidate.code, selected: selected.has(candidate.code) }))
}

export function pageRoundView(baseUrl: string, pageId: string, revision: number, rows: ReturnType<typeof roundRows>,
  candidates: readonly { code: number; workflow: Workflow; available: boolean }[]) {
  const byCode = new Map(candidates.map(item => [item.code, item]))
  const selectedCodes = rows.filter(row => row.selected).map(row => row.code)
  return {
    selectedCodes,
    missing: rows.filter(row => row.selected && !byCode.get(row.code)?.available),
    // Decode every available candidate. A hidden candidate may still be assigned in saved output.
    options: candidates.filter(item => item.available).map(item => ({
      code: item.code,
      label: rows.find(row => row.code === item.code)?.label || item.workflow,
      url: `${baseUrl}/pages/${pageId}/image?source=candidate:${item.code}`,
      diffUrl: `${baseUrl}/pages/${pageId}/image?source=diff:${item.code}&revision=${revision}`,
    })),
  }
}
