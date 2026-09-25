import { moved } from './geometry'
import { splitTextItem, splitTextParts } from './split-text'
import type { Item, PageData } from './types'

export type PrelayoutSet = Partial<Pick<Item, 'text' | 'x' | 'y' | 'font-size' | 'orientation' | 'rotation' | 'color' | 'stroke-color' | 'stroke-weight'>>
export type PrelayoutPatch = { item_id: string; set?: PrelayoutSet; center?: [number, number] }
export type PrelayoutSplit = { token: string; item_id: string; selection_start: number; selection_end: number }
export type PrelayoutHost = {
  inspect: () => Promise<unknown>
  patch: (args: { token: string; patches: PrelayoutPatch[] }) => Promise<unknown>
  split: (args: PrelayoutSplit) => Promise<unknown>
  compare: (args: { token: string; view: 'edited' | 'original' | 'before' | 'detail'; region?: number; includeOriginal?: boolean; padding?: number }) => Promise<unknown>
  undo: (args: { token: string }) => Promise<unknown>
  save: (args: { token: string; reviewed?: boolean; advance?: boolean }) => Promise<unknown>
  navigate: (args: { token: string; page_id: string }) => Promise<unknown>
  setView: (args: { token: string; comparison?: boolean; difference_highlight?: boolean; fullscreen?: boolean; zoom?: number }) => Promise<unknown>
}

type Schema = Record<string, unknown>
type Tool = {
  name: string; description: string; inputSchema: Schema; annotations: { readOnlyHint: boolean }
  execute: (args?: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>
}
type ModelContext = { registerTool: (tool: Tool) => void | Promise<void>; unregisterTool?: (name: string) => void | Promise<void> }

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false })
const token = { type: 'string', minLength: 1, description: 'Exact current-page token returned by prelayout_inspect_page or the latest tool result. The page host rejects stale tokens.' }
const patchSetSchema = object({
  text: { type: 'string' }, x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 },
  'font-size': { type: 'number', exclusiveMinimum: 0, maximum: 999 }, orientation: { type: 'string', enum: ['vertical', 'horizontal'] },
  rotation: { type: 'number', minimum: -180, maximum: 180 }, color: { type: 'string', pattern: '^(?:#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|black|white)$' },
  'stroke-color': { type: 'string', pattern: '^(?:#?(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|black|white)$' },
  'stroke-weight': { type: 'number', minimum: 0, maximum: 100 },
})
const patchSchema = object({
  item_id: { type: 'string', minLength: 1, description: 'Stable _id from prelayout_inspect_page. Never use list position or source block index.' },
  set: patchSetSchema,
  center: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: 'New center in original-image pixels. Cannot be combined with set.x or set.y.' },
}, ['item_id'])
const splitSchema = object({
  token,
  item_id: { type: 'string', minLength: 1, description: 'Stable _id from prelayout_inspect_page.' },
  selection_start: { type: 'integer', minimum: 0, description: 'Inclusive UTF-16 offset in the current item text.' },
  selection_end: { type: 'integer', minimum: 1, description: 'Exclusive UTF-16 offset in the current item text; must exceed selection_start.' },
}, ['token', 'item_id', 'selection_start', 'selection_end'])

const allowed = new Set(['text', 'x', 'y', 'font-size', 'orientation', 'rotation', 'color', 'stroke-color', 'stroke-weight'])
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const finite = (value: unknown, minimum: number, maximum: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} 必須是 ${minimum} 至 ${maximum} 的有限數值。`)
  return value
}
const validColor = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|black|white)$/.test(value)) throw new Error(`${label} 必須是十六進位顏色、black 或 white。`)
  return value
}

/** Validate a whole batch before returning a new page; the supplied page is never mutated. */
export function applyPagePatches(page: PageData, patches: PrelayoutPatch[]): PageData {
  if (!page || !Array.isArray(page.items)) throw new Error('頁面缺少文字項目。')
  const width = finite(page.width, Number.MIN_VALUE, Number.MAX_VALUE, '頁寬')
  const height = finite(page.height, Number.MIN_VALUE, Number.MAX_VALUE, '頁高')
  if (!Array.isArray(patches) || patches.length < 1) throw new Error('至少需要一項修改。')
  const ids = new Map<string, number>()
  page.items.forEach((item, index) => { ids.set(item._id, (ids.get(item._id) || 0) + 1); if (!item._id) throw new Error(`第 ${index + 1} 項缺少穩定 ID。`) })
  const changes = new Map<string, Item>()
  for (const patch of patches) {
    if (!patch || typeof patch !== 'object' || typeof patch.item_id !== 'string' || !patch.item_id) throw new Error('修改必須提供 item_id。')
    if (changes.has(patch.item_id)) throw new Error(`文字項目 ${patch.item_id} 在同一批修改中重複。`)
    if (ids.get(patch.item_id) !== 1) throw new Error(`文字項目 ${patch.item_id} 不存在或 ID 重複，請重新檢查頁面。`)
    if (Object.keys(patch).some(key => !['item_id', 'set', 'center'].includes(key))) throw new Error('修改包含不支援的欄位。')
    const set = patch.set === undefined ? {} : patch.set
    if (!set || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).some(key => !allowed.has(key))) throw new Error('set 包含不支援的欄位。')
    if (!patch.center && !Object.keys(set).length) throw new Error('修改必須提供 set 或 center。')
    if (patch.center && (own(set, 'x') || own(set, 'y'))) throw new Error('center 不可與 x 或 y 同時使用。')
    const original = page.items.find(item => item._id === patch.item_id)!
    let targetX = original.x, targetY = original.y
    let dx = 0, dy = 0
    if (patch.center) {
      if (!Array.isArray(patch.center) || patch.center.length !== 2) throw new Error('center 必須是兩個像素座標。')
      dx = finite(patch.center[0], 0, width, 'center.x') - original.x * width
      dy = finite(patch.center[1], 0, height, 'center.y') - original.y * height
      targetX = original.x + dx / width
      targetY = original.y + dy / height
    } else {
      if (own(set, 'x')) targetX = finite(set.x, 0, 1, 'x')
      if (own(set, 'y')) targetY = finite(set.y, 0, 1, 'y')
      dx = (targetX - original.x) * width
      dy = (targetY - original.y) * height
    }
    if ((targetX !== original.x || targetY !== original.y) && original.xyxy_pixel && (original.xyxy_pixel.length !== 4 || original.xyxy_pixel.some(value => typeof value !== 'number' || !Number.isFinite(value)))) throw new Error(`文字項目 ${patch.item_id} 的來源框無效。`)
    let updated = dx !== 0 || dy !== 0
      ? moved(original, dx, dy, width, height)
      : { ...original }
    if (own(set, 'text')) {
      if (typeof set.text !== 'string' || set.text.replaceAll('\n', '') !== original.text.replaceAll('\n', '')) throw new Error(`文字項目 ${patch.item_id} 只能修改換行，不能更改譯文。`)
      updated = { ...updated, text: set.text }
    }
    if (own(set, 'font-size')) updated = { ...updated, 'font-size': finite(set['font-size'], Number.MIN_VALUE, 999, 'font-size') }
    if (own(set, 'rotation')) updated = { ...updated, rotation: finite(set.rotation, -180, 180, 'rotation') }
    if (own(set, 'stroke-weight')) updated = { ...updated, 'stroke-weight': finite(set['stroke-weight'], 0, 100, 'stroke-weight') }
    if (own(set, 'orientation')) {
      if (set.orientation !== 'vertical' && set.orientation !== 'horizontal') throw new Error('orientation 必須是 vertical 或 horizontal。')
      updated = { ...updated, orientation: set.orientation }
    }
    if (own(set, 'color')) updated = { ...updated, color: validColor(set.color, 'color') }
    if (own(set, 'stroke-color')) updated = { ...updated, 'stroke-color': validColor(set['stroke-color'], 'stroke-color') }
    changes.set(patch.item_id, { ...updated, match_status: 'manual' })
  }
  return { ...page, items: page.items.map(item => changes.get(item._id) || item) }
}

/** Split through the same operation as the inline editor, without changing any text characters. */
export function applyPageSplit(page: PageData, itemId: string, start: number, end: number, makeId?: () => string) {
  if (!page || !Array.isArray(page.items) || typeof page.width !== 'number' || !Number.isFinite(page.width) || page.width <= 0) throw new Error('頁面缺少有效文字項目或頁寬。')
  if (typeof itemId !== 'string' || !itemId || page.items.filter(item => item._id === itemId).length !== 1) throw new Error('文字項目不存在或 ID 重複，請重新檢查頁面。')
  const original = page.items.find(item => item._id === itemId)!
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > original.text.length || start >= end) throw new Error('選取範圍必須是文字內非空的 UTF-16 起訖位置。')
  const parts = splitTextParts(original.text, start, end)
  if (!parts) throw new Error('選取必須包含文字，且原框須保留非空文字。')
  const result = splitTextItem(page.items, itemId, original.text, start, end, page.width, undefined, makeId)
  if (!result || !result.newId || page.items.some(item => item._id === result.newId)) throw new Error('分割無法建立唯一的新文字框。')
  const readingOrder = [
    { item_id: itemId, text: original.text.slice(0, parts.start) },
    { item_id: result.newId, text: parts.selectedText },
    { item_id: itemId, text: original.text.slice(parts.end) },
  ].filter(segment => segment.text.length)
  return {
    page: { ...page, items: result.items }, originalId: result.originalId, newId: result.newId,
    selectionStart: parts.start, selectionEnd: parts.end, readingOrder,
    itemOrder: result.items.map(item => item._id),
  }
}

export function prelayoutToolDefinitions(host: PrelayoutHost): Tool[] {
  const entries: [string, string, Schema, keyof PrelayoutHost, boolean][] = [
    ['prelayout_inspect_page', 'Read the current draft page, stable item IDs, geometry, saved status, and concurrency token.', object({}, []), 'inspect', true],
    ['prelayout_patch_page', 'Atomically edit current draft items by stable ID. Text may change line breaks only. The host validates the current token and saves through its normal editor state.', object({ token, patches: { type: 'array', items: patchSchema, minItems: 1 } }, ['token', 'patches']), 'patch', false],
    ['prelayout_split_item', 'Split a nonempty UTF-16 selection into a new text box using the editor split operation. Preserves all text characters and returns the actual reading-order segments.', splitSchema, 'split', false],
    ['prelayout_compare_page', 'Show the edited, original, before, or latest local before/after detail view for visual review.', object({ token, view: { type: 'string', enum: ['edited', 'original', 'before', 'detail'] }, region: { type: 'integer', minimum: 0 }, includeOriginal: { type: 'boolean' }, padding: { type: 'number', minimum: 16, maximum: 300 } }, ['token', 'view']), 'compare', false],
    ['prelayout_undo_page', 'Undo the latest draft edit on the current page.', object({ token }, ['token']), 'undo', false],
    ['prelayout_save_page', 'Save the current draft using the page editor. reviewed:true marks the page complete; reviewed:false clears completion; omitting reviewed only saves. advance:true saves, marks complete, then opens the next unfinished page in scope.', object({ token, reviewed: { type: 'boolean' }, advance: { type: 'boolean' } }, ['token']), 'save', false],
    ['prelayout_navigate_page', 'Save as required by the page editor and navigate to a page by its stable page ID.', object({ token, page_id: { type: 'string', minLength: 1 } }, ['token', 'page_id']), 'navigate', false],
    ['prelayout_set_view', 'Set original comparison, difference highlight, fullscreen, or zoom without changing page content.', object({ token, comparison: { type: 'boolean' }, difference_highlight: { type: 'boolean' }, fullscreen: { type: 'boolean' }, zoom: { type: 'number', minimum: 0.1, maximum: 8 } }, ['token']), 'setView', false],
  ]
  return entries.map(([name, description, inputSchema, method, readOnlyHint]) => ({
    name, description, inputSchema, annotations: { readOnlyHint },
    execute: async (args = {}) => {
      try {
        const result = method === 'inspect' ? await host.inspect() : await (host[method] as (input: Record<string, unknown>) => Promise<unknown>)(args)
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
      }
    },
  }))
}

export function registerPrelayoutTools(host: PrelayoutHost): () => void {
  const doc = typeof document === 'undefined' ? undefined : document as Document & { modelContext?: ModelContext }
  const nav = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { modelContext?: ModelContext }
  const context = doc?.modelContext?.registerTool ? doc.modelContext : nav?.modelContext?.registerTool ? nav.modelContext : undefined
  if (!context) return () => {}
  let disposed = false
  const registered: string[] = []
  for (const tool of prelayoutToolDefinitions(host)) {
    try {
      void Promise.resolve(context.registerTool(tool)).then(() => {
        if (disposed) void Promise.resolve(context.unregisterTool?.(tool.name)).catch(() => {})
        else registered.push(tool.name)
      }).catch(() => {})
    } catch { /* An unsupported or partial browser implementation leaves the editor usable. */ }
  }
  return () => {
    disposed = true
    for (const name of registered) void Promise.resolve(context.unregisterTool?.(name)).catch(() => {})
    registered.length = 0
  }
}
