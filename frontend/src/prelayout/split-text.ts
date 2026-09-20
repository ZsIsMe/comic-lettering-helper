import type { Item } from './types'
import { uid } from './types'

export type TextBounds = { width: number; height: number }
export type SplitMeasurements = { remainder: TextBounds; selected: TextBounds }

export function splitTextParts(text: string, start: number, end: number) {
  if (start === end) return null
  let left = Math.max(0, Math.min(start, end, text.length))
  let right = Math.max(0, Math.min(Math.max(start, end), text.length))
  if (left > 0 && /[\uD800-\uDBFF]/.test(text[left - 1]) && /[\uDC00-\uDFFF]/.test(text[left])) left--
  if (right > 0 && /[\uD800-\uDBFF]/.test(text[right - 1]) && /[\uDC00-\uDFFF]/.test(text[right])) right++
  const selectedText = text.slice(left, right)
  const remainder = text.slice(0, left) + text.slice(right)
  if (!selectedText.trim() || !remainder.length) return null
  return { start: left, end: right, selectedText, remainder }
}

export function estimateTextBounds(item: Item, text: string): TextBounds {
  const lines = text.split('\n')
  const longest = Math.max(0, ...lines.map(line => Array.from(line).length))
  const columns = Math.max(lines.length, 1)
  const size = item['font-size']
  const stroke = Math.max(0, item['stroke-weight']) * 2
  return item.orientation === 'vertical'
    ? { width: columns * size * 1.25 + stroke, height: longest * size + stroke }
    : { width: longest * size + stroke, height: columns * size * 1.25 + stroke }
}

function pageAxisWidth(bounds: TextBounds, rotation: number) {
  const radians = rotation * Math.PI / 180
  return Math.abs(Math.cos(radians)) * bounds.width + Math.abs(Math.sin(radians)) * bounds.height
}

export function splitTextItem(items: Item[], id: string, draft: string, start: number, end: number, pageWidth: number,
  measurements?: SplitMeasurements, makeId: () => string = uid) {
  const original = items.find(item => item._id === id)
  if (!original) return null
  const parts = splitTextParts(draft, start, end)
  if (!parts) return null
  const { selectedText, remainder } = parts
  const remainderBounds = measurements?.remainder || estimateTextBounds(original, remainder)
  const selectedBounds = measurements?.selected || estimateTextBounds(original, selectedText)
  const gap = Math.max(12, original['font-size'] * .35)
  const x = original.x + (pageAxisWidth(remainderBounds, original.rotation) + pageAxisWidth(selectedBounds, original.rotation)) / (2 * pageWidth) + gap / pageWidth
  const indices = items.map(item => item.index).filter((value): value is number => Number.isInteger(value) && value! > 0)
  const nextIndex = (indices.length ? Math.max(...indices) : items.length) + 1
  const fresh: Item = {
    _id: makeId(), index: nextIndex, text: selectedText, x, y: original.y,
    'font-size': original['font-size'], rotation: original.rotation, orientation: original.orientation,
    color: original.color, 'stroke-color': original['stroke-color'], 'stroke-weight': original['stroke-weight'],
    match_status: 'manual', ...(typeof original.groupId === 'number' ? { groupId: original.groupId } : {}),
  }
  const result = items.map(item => item._id === id ? { ...item, text: remainder, match_status: 'manual' } : item)
  result.push(fresh)
  return { items: result, originalId: id, newId: fresh._id, selectedText, remainder }
}
