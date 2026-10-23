import type { PageData, Project } from './types'

export type TextReference = {
  key: string; pageId: string; pageNumber: number; pageName: string; itemId: string; itemNumber: number; text: string;
  source?: Record<string, unknown>; pageSummary?: unknown;
}

// Keep source annotations extensible while excluding editable layout and match state.
const itemStateFields = new Set([
  '_id', 'index', 'text', 'groupId', 'x', 'y', 'rotation', 'orientation', 'font-size', 'font_size',
  'color', 'stroke-color', 'stroke-weight', 'xyxy_pixel', 'need_inpaint', 'max_break', 'text-direction',
  'bbox', 'center_normalized', 'font', 'text_has_stroke',
])

// Older projects may retain .jpg summary keys for .png page images.
function summaryFor(summaries: unknown, name: string): unknown {
  if (!summaries || typeof summaries !== 'object' || Array.isArray(summaries)) return undefined
  if (Object.hasOwn(summaries, name)) return (summaries as Record<string, unknown>)[name]
  const stem = (value: string) => value.replace(/\.[^.]*$/, '').toLocaleLowerCase()
  const matches = Object.entries(summaries).filter(([key]) => stem(key) === stem(name))
  return matches.length === 1 ? matches[0][1] : undefined
}

// The full source list stays in page order; selected snapshots follow selection order.
export function questionReferences(project: Pick<Project, 'pages' | 'template'>, pages: ReadonlyMap<string, PageData>, selection?: Record<string, string[]>, order?: readonly { page: string; id: string }[]): TextReference[] {
  const summaries = project.template?.page_summary
  const references = project.pages.flatMap((page, pageIndex) => (pages.get(page.id)?.items || []).flatMap((item, itemIndex) => {
    if (selection && !selection[page.id]?.includes(item._id)) return []
    const source = Object.fromEntries(Object.entries(item).filter(([key, value]) => !itemStateFields.has(key) && !key.startsWith('match_') && value !== undefined))
    const summary = summaryFor(summaries, page.name)
    return [{ key: JSON.stringify([page.id, item._id]), pageId: page.id, pageNumber: pageIndex + 1, pageName: page.name,
      itemId: item._id, itemNumber: itemIndex + 1, text: item.text,
      ...(Object.keys(source).length ? { source: structuredClone(source) } : {}),
      ...(summary !== undefined ? { pageSummary: structuredClone(summary) } : {}),
    }]
  }))
  if (!order) return references
  const byKey = new Map(references.map(text => [text.key, text]))
  const result: TextReference[] = []
  for (const value of order) {
    const key = JSON.stringify([value.page, value.id]), text = byKey.get(key)
    if (text) { result.push(text); byKey.delete(key) }
  }
  return [...result, ...byKey.values()]
}
