import { moved, type Selection } from './geometry'
import type { EditorState } from './editor-state'
import type { PageMeasurement, TextRect } from './layout-review'
import type { Item, PageData } from './types'

export type AlignmentOperation = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom'
  | 'gap-x' | 'gap-y' | 'centers-x' | 'centers-y'
export const isDistribution = (operation: AlignmentOperation) => operation.startsWith('gap-') || operation.startsWith('centers-')
const epsilon = 1e-6

/** Translate measured, painted AABBs in original pixels; retain all item styling. */
export function alignedItems(page: PageData, ids: readonly string[], rects: Record<string, TextRect>, operation: AlignmentOperation): Item[] {
  const selectedIds = new Set(ids)
  if (selectedIds.size < (isDistribution(operation) ? 3 : 2)) throw new Error(isDistribution(operation) ? '分佈需要同頁至少 3 個文字框。' : '對齊需要同頁至少 2 個文字框。')
  if (![page.width, page.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('頁面尺寸無效，無法對齊。')
  const selected = page.items.filter(item => selectedIds.has(item._id))
  if (selected.length !== selectedIds.size || new Set(selected.map(item => item._id)).size !== selected.length) throw new Error('選取的文字框已變更，請重新選取。')
  for (const item of selected) {
    const box = rects[item._id]
    if (!box || box.length !== 4 || box.some(value => !Number.isFinite(value)) || box[2] <= box[0] || box[3] <= box[1]
      || !Number.isFinite(item.x) || !Number.isFinite(item.y)) throw new Error('部分文字框無法量測，未套用任何修改。')
  }
  const horizontal = ['left', 'center-x', 'right', 'gap-x', 'centers-x'].includes(operation)
  const axis = horizontal ? 0 : 1, end = axis + 2
  const low = Math.min(...selected.map(item => rects[item._id][axis]))
  const high = Math.max(...selected.map(item => rects[item._id][end]))
  const center = (box: TextRect) => (box[axis] + box[end]) / 2
  const deltas = new Map<string, number>()
  if (isDistribution(operation)) {
    const byCenter = operation.startsWith('centers-')
    // Stable original order breaks ties deterministically without rearranging item data.
    const sorted = [...selected].sort((a, b) => (byCenter ? center(rects[a._id]) - center(rects[b._id]) : rects[a._id][axis] - rects[b._id][axis]))
    const first = rects[sorted[0]._id], last = rects[sorted.at(-1)!._id]
    const widths = sorted.map(item => rects[item._id][end] - rects[item._id][axis])
    const step = byCenter ? (center(last) - center(first)) / (sorted.length - 1)
      : (last[end] - first[axis] - widths.reduce((sum, value) => sum + value, 0)) / (sorted.length - 1)
    let position = byCenter ? center(first) : first[axis]
    sorted.forEach((item, index) => {
      const box = rects[item._id]
      // Always keep the two endpoint frames exactly fixed, including overlapping layouts.
      if (index > 0 && index < sorted.length - 1) deltas.set(item._id, position - (byCenter ? center(box) : box[axis]))
      position += byCenter ? step : widths[index] + step
    })
  } else {
    for (const item of selected) {
      const box = rects[item._id]
      const delta = operation === 'left' || operation === 'top' ? low - box[axis]
        : operation === 'right' || operation === 'bottom' ? high - box[end] : (low + high) / 2 - center(box)
      deltas.set(item._id, delta)
    }
  }
  let changed = false
  const items = page.items.map(item => {
    const delta = deltas.get(item._id) || 0
    if (Math.abs(delta) < epsilon) return item
    changed = true
    return moved(item, horizontal ? delta : 0, horizontal ? 0 : delta, page.width, page.height)
  })
  return changed ? items : page.items
}

/** Snapshot after committing inline edits, then reject any stale asynchronous measurement. */
export async function alignSelection(controller: EditorState, getSelection: () => Selection, operation: AlignmentOperation,
  measure: (page: PageData) => Promise<PageMeasurement>, isCurrent: () => boolean = () => true): Promise<'applied' | 'noop' | 'stale'> {
  controller.finishTextDraft()
  const selection = getSelection(), page = selection.page, ids = [...selection.ids]
  const state = controller.pages.get(page)
  if (!state) throw new Error('請先載入所選頁面。')
  const version = state.version, data = state.data
  const snapshot = structuredClone(data)
  // Only selected frames need measuring; avoid the whole-page overlap scan.
  const measurement = await measure({ ...snapshot, items: snapshot.items.filter(item => ids.includes(item._id)) })
  if (controller.editing || !isCurrent() || getSelection() !== selection || controller.pages.get(page) !== state || state.data !== data || state.version !== version) return 'stale'
  const items = alignedItems(snapshot, ids, measurement.rects, operation)
  if (items === snapshot.items) return 'noop'
  controller.edit(page, items)
  return 'applied'
}
