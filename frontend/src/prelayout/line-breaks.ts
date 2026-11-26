import { selectionPages, type Selection } from './geometry'
import type { EditorState } from './editor-state'
import type { Item, PageData } from './types'

export type LineBreakOption = { label: string; text: string }
export type LineBreakPreview = { page: string; id: string; text: string; before: string; version: number }
export const normalizeLineBreaks = (text: string) => text.replace(/\r\n?|\n/g, '\n')
export const withoutLineBreaks = (text: string) => text.replace(/\r\n?|\n/g, '')
export const sameCharacters = (before: string, after: string) => withoutLineBreaks(before) === withoutLineBreaks(after)
const validText = (text: string) => [...text].length <= 50_000
type SuggestionData = Pick<PageData, 'line_break_suggestions'> & Partial<Pick<PageData, 'measure'>>

export function lineBreakSelectionNotice(controller: EditorState, selection: Selection): string {
  const entries = Object.entries(selectionPages(selection)).flatMap(([page, ids]) => ids.map(id => ({ page, id })))
  if (!entries.length) return '先在畫布選取一個文字框，即可查看斷句版本。'
  if (entries.length > 1) return `目前選取 ${entries.length} 框；請只保留一個文字框（含其他頁面的選取）。`
  return controller.pages.has(entries[0].page) ? '所選文字框已不存在，請重新選取。' : '所選頁面尚未載入，請稍候再試。'
}

function missingSuggestionsNotice(item: Item, data: SuggestionData): string {
  const measures = data.measure
  if (!measures) return '目前未提供此框的斷句候選資料。'
  if (!measures.length) return '此頁沒有偵測量測資料，尚無法依原文列／行數產生版本。'
  if (['duplicate', 'unmatched'].includes(item.match_status || '')) return '此框尚無可靠的原文匹配，無法確定應使用哪個原文列／行數。'
  const matched = typeof item.match_source_block_index === 'number' ? measures.find(measure => measure.source_block_index === item.match_source_block_index) : undefined
  if (matched?.source_line_count === 0) return '此框的原文列／行數目前未知（0），尚無法產生斷句版本。'
  const hasCount = (measure: PageData['measure'][number]) => typeof measure.source_line_count === 'number' && Number.isInteger(measure.source_line_count) && measure.source_line_count > 0
  if (matched && !hasCount(matched) || !matched && !measures.some(hasCount)) return '目前量測缺少可用的精確 CTD 列／行數；字框估算不能用來產生這些版本。'
  if (typeof item.match_source_block_index !== 'number') return '此框未提供可核對的原文匹配與斷句候選資料。'
  if (!matched) return '此框記錄的原文匹配未對應到目前量測，尚無可用斷句版本。'
  return '已記錄精確原文列／行數，但目前未提供此框的匯入原文與斷句候選；無法僅靠行數還原版本。'
}

export function singleLineBreakItem(controller: EditorState, selection: Selection): { page: string; item: Item; data: PageData; version: number } | null {
  const entries = Object.entries(selectionPages(selection)).flatMap(([page, ids]) => ids.map(id => ({ page, id })))
  if (entries.length !== 1) return null
  const { page, id } = entries[0], state = controller.pages.get(page)
  const item = state?.data.items.find(item => item._id === id)
  return state && item ? { page, item, data: state.data, version: state.version } : null
}

export function lineBreakOptions(item: Item, data: SuggestionData): { options: LineBreakOption[]; notice: string } {
  const suggestions = data.line_break_suggestions?.[item._id]
  if (!suggestions) return { options: [], notice: missingSuggestionsNotice(item, data) }
  if (!sameCharacters(suggestions.original_text, item.text)) return { options: [], notice: '文字已改動，舊斷句建議無法使用。' }
  const unit = item.orientation === 'vertical' ? '列' : '行'
  const options: LineBreakOption[] = [], seen = new Map<string, LineBreakOption>()
  const add = (label: string, text: string) => {
    if (!validText(text) || !sameCharacters(suggestions.original_text, text)) return
    const key = normalizeLineBreaks(text), existing = seen.get(key)
    if (existing) { if (!existing.label.split(' · ').includes(label)) existing.label += ` · ${label}`; return }
    const option = { label, text }; seen.set(key, option); options.push(option)
  }
  add('匯入原文', suggestions.original_text)
  for (const candidate of suggestions.candidates) {
    if (Number.isInteger(candidate.line_count) && candidate.line_count > 0) add(`${candidate.line_count}${unit}版`, candidate.text)
  }
  const notice = !options.length ? '此框暫無可用斷句，文字上限為 50,000 字。'
    : options.length === 1 ? suggestions.candidates.length ? '目前僅有這一種斷句；相同版本已合併。' : '目前只有匯入原文，未提供其他斷句候選。'
      : '已列出目前提供的版本；相同斷句會合併顯示。'
  return { options, notice }
}

export function createLineBreakPreview(controller: EditorState, selection: Selection, text: string): LineBreakPreview {
  if (controller.editing) throw new Error('請先完成畫布文字編輯。')
  const selected = singleLineBreakItem(controller, selection)
  if (!selected) throw new Error('請只選取一個文字框。')
  const { options } = lineBreakOptions(selected.item, selected.data)
  if (!options.some(option => option.text === text)) throw new Error('此斷句建議已失效，請重新選取。')
  return { page: selected.page, id: selected.item._id, before: selected.item.text, version: selected.version, text }
}

export function lineBreakPreviewMatches(controller: EditorState, selection: Selection, preview: LineBreakPreview): boolean {
  const selected = singleLineBreakItem(controller, selection)
  return !!selected && selected.page === preview.page && selected.item._id === preview.id && selected.item.text === preview.before && selected.version === preview.version
}

export function applyLineBreaks(controller: EditorState, selection: Selection, preview: LineBreakPreview): boolean {
  if (controller.editing) throw new Error('請先完成畫布文字編輯。')
  if (!lineBreakPreviewMatches(controller, selection, preview)) throw new Error('文字框已變更，請重新預覽。')
  const selected = singleLineBreakItem(controller, selection)!
  if (!lineBreakOptions(selected.item, selected.data).options.some(option => option.text === preview.text)) throw new Error('此斷句建議已失效，請重新選取。')
  if (preview.before === preview.text) return false
  controller.edit(preview.page, selected.data.items.map(item => item._id === preview.id ? { ...item, text: preview.text } : item))
  return true
}
