import { moved } from './geometry'
import { lineBreakOptions, normalizeLineBreaks, sameCharacters } from './line-breaks'
import { sourceLineCount } from './source-line-count'
import { splitTextItem, splitTextParts } from './split-text'
import type { Item, PageData } from './types'

export type PrelayoutSet = Partial<Pick<Item, 'text' | 'x' | 'y' | 'font-size' | 'orientation' | 'rotation' | 'color' | 'stroke-color' | 'stroke-weight'>>
export type PrelayoutPatch = { item_id: string; set?: PrelayoutSet; center?: [number, number] }
export type PrelayoutSplit = { token: string; item_id: string; selection_start: number; selection_end: number }
export type PrelayoutCandidate = { label: string; patches: PrelayoutPatch[] }
export type PrelayoutCandidateGroup = { label: string; region?: [number, number, number, number]; candidates: PrelayoutCandidate[] }
export type PrelayoutPreview = { token: string; groups: PrelayoutCandidateGroup[]; padding?: number }
export type PrelayoutHost = {
  inspect: () => Promise<unknown>
  getLineBreakOptions: (args: { token: string; item_ids: string[] }) => Promise<unknown>
  patch: (args: { token: string; patches: PrelayoutPatch[] }) => Promise<unknown>
  split: (args: PrelayoutSplit) => Promise<unknown>
  compare: (args: { token: string; view: 'edited' | 'original' | 'before' | 'detail'; region?: number; includeOriginal?: boolean; padding?: number }) => Promise<unknown>
  previewCandidates: (args: PrelayoutPreview) => Promise<unknown>
  undo: (args: { token: string }) => Promise<unknown>
  save: (args: { token: string; reviewed?: boolean; advance?: boolean; wait?: boolean; next_page_id?: string }) => Promise<unknown>
  navigate: (args: { token: string; page_id: string }) => Promise<unknown>
  setView: (args: { token: string; mode?: 'overlay' | 'original' | 'final'; comparison?: boolean; clean?: boolean; difference_highlight?: boolean; show_text?: boolean; difference_color?: string; difference_opacity?: number; fullscreen?: boolean; zoom?: number }) => Promise<unknown>
}

type Schema = Record<string, unknown>
type Tool = {
  name: string; description: string; inputSchema: Schema; annotations: { readOnlyHint: boolean }
  execute: (args?: Record<string, unknown>) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>
}
type ModelContext = { registerTool: (tool: Tool) => void | Promise<void>; unregisterTool?: (name: string) => void | Promise<void> }

const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false })
const token = { type: 'string', minLength: 1, description: 'Exact current-page token returned by prelayout_inspect_page or the latest tool result. The page host rejects stale tokens.' }
const lineBreakOptionsSchema = object({
  token,
  item_ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1 }, description: 'Stable current-page _id values from prelayout_inspect_page. Never use list positions or source block indices.' },
}, ['token', 'item_ids'])
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
const candidateSchema = object({
  label: { type: 'string', minLength: 1, maxLength: 80 },
  patches: { type: 'array', minItems: 1, maxItems: 20, items: patchSchema },
}, ['label', 'patches'])
const previewSchema = object({
  token,
  groups: { type: 'array', minItems: 1, maxItems: 4, items: object({
    label: { type: 'string', minLength: 1, maxLength: 80 },
    region: { type: 'array', items: { type: 'number', minimum: 0 }, minItems: 4, maxItems: 4, description: 'Optional source-image [left, top, right, bottom] context. Expanded to include all target text in every candidate.' },
    candidates: { type: 'array', minItems: 1, maxItems: 4, items: candidateSchema },
  }, ['label', 'candidates']) },
  padding: { type: 'number', minimum: 16, maximum: 300, default: 60 },
}, ['token', 'groups'])

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

/** Read only the same verified versions offered by the adjustment panel. */
export function pageLineBreakOptions(page: PageData, itemIds: string[]) {
  if (!Array.isArray(itemIds) || itemIds.length < 1 || itemIds.length > 20 || itemIds.some(id => typeof id !== 'string' || !id)) throw new Error('請提供 1 至 20 個目前頁面的文字項目 ID。')
  if (new Set(itemIds).size !== itemIds.length) throw new Error('文字項目 ID 不可重複。')
  return itemIds.map(id => {
    const matches = page.items.filter(item => item._id === id)
    if (matches.length !== 1) throw new Error(`文字項目 ${id} 不存在或 ID 重複，請重新檢查頁面。`)
    const item = matches[0], { options, notice } = lineBreakOptions(item, page)
    const suggestions = page.line_break_suggestions?.[id]
    const original = suggestions && options.some(option => option.text === suggestions.original_text) ? suggestions.original_text : undefined
    const measured = sourceLineCount(item, page)
    const count = original !== undefined ? suggestions?.source_line_count : null
    return {
      item_id: id, current_text: item.text,
      ...(original !== undefined ? { original_text: original } : {}),
      source_line_count: typeof count === 'number' && Number.isInteger(count) && count > 0 ? count
        : measured.source_line_count_source === 'ctd_lines' ? measured.source_line_count : null,
      options: options.map(option => ({ ...option, text: normalizeLineBreaks(option.text), is_current: normalizeLineBreaks(option.text) === normalizeLineBreaks(item.text) })), notice,
    }
  })
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
      if (typeof set.text !== 'string' || set.text.includes('\r') || !sameCharacters(original.text, set.text)) throw new Error(`文字項目 ${patch.item_id} 只能修改換行，不能更改譯文。`)
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

/** Build every trial from the same draft without touching the editor or its undo/save state. */
export function preparePreviewCandidates(page: PageData, groups: PrelayoutCandidateGroup[], padding = 60) {
  finite(padding, 16, 300, '留白範圍')
  if (!Array.isArray(groups) || !groups.length || groups.length > 4) throw new Error('每次預覽需要 1 至 4 組。')
  const label = (value: string) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 80) throw new Error('預覽名稱須為 1 至 80 字。')
    return value
  }
  const names = new Set<string>()
  return groups.map(group => {
    if (!group || typeof group !== 'object' || Object.keys(group).some(key => !['label', 'region', 'candidates'].includes(key))) throw new Error('預覽組包含不支援的欄位。')
    const name = label(group.label)
    if (names.has(name)) throw new Error('預覽組名稱不可重複。')
    names.add(name)
    if (!Array.isArray(group.candidates) || !group.candidates.length || group.candidates.length > 4) throw new Error('每組需要 1 至 4 個候選。')
    const region = group.region
    if (region !== undefined && (!Array.isArray(region) || region.length !== 4 || region.some(value => !Number.isFinite(value)) ||
      region[0] < 0 || region[1] < 0 || region[2] > page.width || region[3] > page.height || region[0] >= region[2] || region[1] >= region[3])) throw new Error('預覽區域須為原圖範圍內有效的左、上、右、下座標。')
    const candidateNames = new Set<string>()
    const itemIds = new Set<string>()
    const candidates = group.candidates.map(candidate => {
      if (!candidate || typeof candidate !== 'object' || Object.keys(candidate).some(key => !['label', 'patches'].includes(key))) throw new Error('候選包含不支援的欄位。')
      const name = label(candidate.label)
      if (candidateNames.has(name)) throw new Error('同組候選名稱不可重複。')
      candidateNames.add(name)
      if (!Array.isArray(candidate.patches) || !candidate.patches.length || candidate.patches.length > 20) throw new Error('每個候選需要 1 至 20 項修改。')
      const result = applyPagePatches(page, candidate.patches)
      candidate.patches.forEach(patch => itemIds.add(patch.item_id))
      return { label: name, page: result }
    })
    return { label: name, region, itemIds: [...itemIds], candidates }
  })
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
    ['prelayout_get_line_break_options', 'Read verified existing line-break versions for 1–20 current-page stable item IDs without changing content, selection, preview, undo, completion, or saves. Returns current_text, available original_text, source_line_count or null, options with label/text/is_current, and availability notices. Missing suggestions return no options. Preview returned texts with prelayout_preview_candidates and apply chosen text with prelayout_patch_page using this token.', lineBreakOptionsSchema, 'getLineBreakOptions', true],
    ['prelayout_patch_page', 'Atomically edit current draft items by stable ID. Text may change line breaks only. The host validates the current token and saves through its normal editor state.', object({ token, patches: { type: 'array', items: patchSchema, minItems: 1 } }, ['token', 'patches']), 'patch', false],
    ['prelayout_split_item', 'Split a nonempty UTF-16 selection into a new text box using the editor split operation. Preserves all text characters and returns the actual reading-order segments.', splitSchema, 'split', false],
    ['prelayout_compare_page', 'Show the edited, original, before, or latest local before/after detail view for visual review.', object({ token, view: { type: 'string', enum: ['edited', 'original', 'before', 'detail'] }, region: { type: 'integer', minimum: 0 }, includeOriginal: { type: 'boolean' }, padding: { type: 'number', minimum: 16, maximum: 300 } }, ['token', 'view']), 'compare', false],
    ['prelayout_preview_candidates', 'Render a contact sheet for up to 4 groups with 4 candidates each in one local preview. Every candidate starts from the same current draft and may adjust up to 20 boxes together. Each group shows original, current, and candidates at identical crop and scale. This preview leaves page content, undo, completion, and saves untouched. Inspect rendered and preview groups before capturing one screenshot. Apply the selected patches once with prelayout_patch_page and this token.', previewSchema, 'previewCandidates', true],
    ['prelayout_undo_page', 'Undo the latest draft edit on the current page.', object({ token }, ['token']), 'undo', false],
    ['prelayout_save_page', 'Save through the editor. wait defaults to true and joins all background saves and completion markers; the final page in scope must wait. wait:false registers a tracked background save and may open next_page_id without awaiting server success; returned pending is not saved. Inspect pending_saves/save_failures across pages. reviewed:true marks this exact draft complete, false clears completion; omitted only saves. Explicit saves retry transport failures; conflicts require UI resolution. next_page_id must exist within scope and cannot combine with advance. advance:true waits, marks complete, then opens the next unfinished page; forbidden with wait:false.', object({ token, reviewed: { type: 'boolean' }, advance: { type: 'boolean' }, wait: { type: 'boolean', default: true }, next_page_id: { type: 'string', minLength: 1 } }, ['token']), 'save', false],
    ['prelayout_navigate_page', 'Save as required by the page editor and navigate to a page by its stable page ID.', object({ token, page_id: { type: 'string', minLength: 1 } }, ['token', 'page_id']), 'navigate', false],
    ['prelayout_set_view', 'Switch overlay, original, or final review mode; optionally set visible text, background, highlight color/opacity, comparison, fullscreen, or zoom. Modes preserve comparison, zoom, and scroll geometry. No page content changes.', object({ token, mode: { type: 'string', enum: ['overlay', 'original', 'final'] }, comparison: { type: 'boolean' }, clean: { type: 'boolean' }, difference_highlight: { type: 'boolean' }, show_text: { type: 'boolean' }, difference_color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, difference_opacity: { type: 'number', minimum: 0, maximum: 1 }, fullscreen: { type: 'boolean' }, zoom: { type: 'number', minimum: 0.1, maximum: 8 } }, ['token']), 'setView', false],
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
