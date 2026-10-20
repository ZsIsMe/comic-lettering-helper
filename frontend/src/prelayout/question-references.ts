import type { PageData, Project } from './types'

export type TextReference = { key: string; pageId: string; pageNumber: number; pageName: string; itemId: string; itemNumber: number; text: string }

// The full source list stays in page order; selected snapshots follow selection order.
export function questionReferences(project: Pick<Project, 'pages'>, pages: ReadonlyMap<string, PageData>, selection?: Record<string, string[]>, order?: readonly { page: string; id: string }[]): TextReference[] {
  const references = project.pages.flatMap((page, pageIndex) => (pages.get(page.id)?.items || []).flatMap((item, itemIndex) => {
    if (selection && !selection[page.id]?.includes(item._id)) return []
    return [{ key: JSON.stringify([page.id, item._id]), pageId: page.id, pageNumber: pageIndex + 1, pageName: page.name,
      itemId: item._id, itemNumber: itemIndex + 1, text: item.text }]
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
