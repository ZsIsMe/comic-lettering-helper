import { readEditableText } from './editable-text'

type CaretKey = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'keyCode'>
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const boundaries = (text: string) => [...segmenter.segment(text)].map(part => part.index).concat(text.length)

export function verticalCaretAction(event: CaretKey) {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return null
  const movement = {
    ArrowLeft: { delta: 1, column: true }, ArrowRight: { delta: -1, column: true },
    ArrowUp: { delta: -1, column: false }, ArrowDown: { delta: 1, column: false },
  } as const
  return movement[event.key as keyof typeof movement] ?? null
}

export function verticalCaretTarget(text: string, offset: number, key: string, preferredRow?: number) {
  const columnMove = key === 'ArrowLeft' || key === 'ArrowRight'
  const delta = key === 'ArrowLeft' || key === 'ArrowDown' ? 1 : -1
  if (!columnMove) {
    const stops = boundaries(text)
    const next = delta > 0 ? stops.find(stop => stop > offset) : stops.filter(stop => stop < offset).at(-1)
    return { offset: next ?? offset, preferredRow: undefined }
  }
  const lines = text.split('\n')
  let column = 0, start = 0
  while (column < lines.length - 1 && offset > start + lines[column].length) start += lines[column++].length + 1
  const stops = boundaries(lines[column])
  const row = preferredRow ?? Math.max(0, stops.findIndex(stop => stop >= offset - start))
  const targetColumn = column + delta
  if (targetColumn < 0 || targetColumn >= lines.length) return { offset, preferredRow: row }
  const targetStops = boundaries(lines[targetColumn])
  const targetStart = targetColumn > column ? start + lines[column].length + 1 : start - lines[targetColumn].length - 1
  return { offset: targetStart + targetStops[Math.min(row, targetStops.length - 1)], preferredRow: row }
}

type Navigation = { text: string; node: Node; offset: number; row?: number }
const navigation = new WeakMap<HTMLElement, Navigation>()
export const resetVerticalCaret = (editor: HTMLElement) => { navigation.delete(editor) }

export function moveVerticalCaret(editor: HTMLElement, event: CaretKey): boolean {
  const action = verticalCaretAction(event)
  const selection = editor.ownerDocument.getSelection()
  if (!action) { resetVerticalCaret(editor); return false }
  if (!selection?.anchorNode || !selection.focusNode
    || !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return false
  const map = readEditableText(editor)
  const anchor = map.offsetAt(selection.anchorNode, selection.anchorOffset)
  const focus = map.offsetAt(selection.focusNode, selection.focusOffset)
  const previous = navigation.get(editor)
  const row = previous?.text === map.text && previous.node === selection.focusNode && previous.offset === selection.focusOffset ? previous.row : undefined
  // Without Shift, character movement collapses an existing selection first.
  const target = !event.shiftKey && !selection.isCollapsed && !action.column
    ? { offset: action.delta < 0 ? Math.min(anchor, focus) : Math.max(anchor, focus), preferredRow: undefined }
    : verticalCaretTarget(map.text, focus, event.key, row)
  const point = map.pointAt(target.offset)
  if (event.shiftKey) selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, point.node, point.offset)
  else selection.setPosition(point.node, point.offset)
  navigation.set(editor, { text: map.text, node: point.node, offset: point.offset, row: target.preferredRow })
  return true
}
