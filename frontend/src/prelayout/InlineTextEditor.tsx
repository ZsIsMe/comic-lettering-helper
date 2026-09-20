import { useLayoutEffect, useRef, useState } from 'react'
import type { Item } from './types'
import type { EditorState } from './editor-state'
import { moveVerticalCaret, resetVerticalCaret } from './caret-navigation'
import { readEditableText } from './editable-text'
import { splitTextItem, splitTextParts, type TextBounds } from './split-text'

// The browser owns this DOM while typing, including its selection and IME range.
// Never reconcile editable children on React renders or during composition.
export function InlineTextEditor({ item, page, controller, point, onFinish, pageWidth, scale, onSplit }: {
  item: Item; page: string; controller: EditorState;
  point: { x: number; y: number }; onFinish: () => void; pageWidth: number; scale: number;
  onSplit: (ids: string[]) => void;
}) {
  const element = useRef<HTMLDivElement>(null)
  const initial = useRef({ item, point, onFinish, pageWidth, onSplit })
  const composing = useRef(false)
  const lifetime = useRef({ generation: 0 })
  const finish = useRef<(cancel?: boolean, focusPage?: boolean) => void>(() => {})
  const changed = useRef<() => void>(() => {})
  const split = useRef<() => void>(() => {})
  const savedSelection = useRef<[number, number] | null>(null)
  const [canSplit, setCanSplit] = useState(false)

  useLayoutEffect(() => {
    const node = element.current!
    const token = lifetime.current
    const currentGeneration = ++token.generation
    const { item: original, point, onFinish } = initial.current
    const read = () => readEditableText(node).text
    const selectionOffsets = (): [number, number] | null => {
      const selection = window.getSelection()
      if (!selection?.anchorNode || !selection.focusNode || !node.contains(selection.anchorNode) || !node.contains(selection.focusNode)) return null
      const map = readEditableText(node)
      return [map.offsetAt(selection.anchorNode, selection.anchorOffset), map.offsetAt(selection.focusNode, selection.focusOffset)]
    }
    const validSelection = (offsets: [number, number] | null) => {
      if (!offsets) return false
      const text = read(), start = Math.min(...offsets), end = Math.max(...offsets)
      return start !== end && !!text.slice(start, end).trim() && text.slice(0, start).length + text.slice(end).length > 0
    }
    const inspectSelection = () => setCanSplit(!composing.current && validSelection(selectionOffsets()))
    document.addEventListener('selectionchange', inspectSelection)
    let ended = false
    let lastText = original.text
    node.textContent = original.text + (original.text.endsWith('\n') ? '\n' : '')
    const session = controller.beginTextDraft(page, () => finish.current())
    finish.current = (cancel = false, focusPage = false) => {
      if (ended) return
      ended = true
      const text = node.isConnected ? read() : lastText
      session.end()
      const state = controller.pages.get(page)
      if (!cancel && text !== original.text && state?.data.items.some(value => value._id === original._id)) {
        controller.edit(page, state.data.items.map(value => value._id === original._id ? { ...value, text, match_status: 'manual' } : value))
      }
      if (focusPage) node.closest<HTMLElement>('.pl-viewport')?.focus({ preventScroll: true })
      onFinish()
    }
    changed.current = () => { lastText = read(); session.change(lastText !== original.text) }
    const measure = (text: string): TextBounds => {
      const probe = node.cloneNode(false) as HTMLElement
      const computed = getComputedStyle(node)
      probe.removeAttribute('contenteditable'); probe.removeAttribute('role'); probe.removeAttribute('aria-label')
      probe.textContent = text
      Object.assign(probe.style, {
        position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none', transform: 'none',
        width: 'max-content', height: 'max-content', font: computed.font, fontFamily: computed.fontFamily,
        fontSize: computed.fontSize, fontWeight: computed.fontWeight, lineHeight: computed.lineHeight,
        letterSpacing: computed.letterSpacing, writingMode: computed.writingMode, whiteSpace: 'pre',
      })
      document.body.append(probe)
      const bounds = probe.getBoundingClientRect()
      probe.remove()
      const stroke = Math.max(0, original['stroke-weight']) * 2
      return { width: bounds.width + stroke, height: bounds.height + stroke }
    }
    split.current = () => {
      if (ended || composing.current) return
      const offsets = savedSelection.current || selectionOffsets()
      savedSelection.current = null
      if (!validSelection(offsets)) return
      const text = read(), start = Math.min(...offsets!), end = Math.max(...offsets!)
      const parts = splitTextParts(text, start, end)
      if (!parts) return
      const state = controller.pages.get(page)
      if (!state) return
      const result = splitTextItem(state.data.items, original._id, text, start, end, initial.current.pageWidth, {
        remainder: measure(parts.remainder), selected: measure(parts.selectedText),
      })
      if (!result) return
      ended = true; session.end()
      const draftItems = state.data.items.map(value => value._id === original._id ? { ...value, text, match_status: 'manual' } : value)
      controller.edit(page, result.items, true, undefined, false, draftItems)
      initial.current.onSplit([result.originalId, result.newId])
      node.closest<HTMLElement>('.pl-viewport')?.focus({ preventScroll: true })
      onFinish()
    }
    node.focus({ preventScroll: true })
    // Native hit testing also handles vertical text, scene scaling and rotation.
    const documentWithCaret = document as Document & {
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    }
    const position = documentWithCaret.caretPositionFromPoint?.(point.x, point.y)
    const hit = document.caretRangeFromPoint?.(point.x, point.y)
    const range = document.createRange()
    if (position && node.contains(position.offsetNode)) range.setStart(position.offsetNode, position.offset)
    else if (hit && node.contains(hit.startContainer)) range.setStart(hit.startContainer, hit.startOffset)
    else { range.selectNodeContents(node); range.collapse(false) }
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges(); selection?.addRange(range)
    const finishSession = finish.current
    return () => {
      document.removeEventListener('selectionchange', inspectSelection)
      session.end()
      // React StrictMode replays effects without leaving the editor.
      queueMicrotask(() => { if (token.generation === currentGeneration) finishSession() })
    }
  }, [controller, page])

  return <><div ref={element} className="pl-inline-editor" contentEditable="plaintext-only" suppressContentEditableWarning
    role="textbox" aria-label="原位編輯文字" aria-multiline="true" spellCheck={false}
    onPointerDown={event => { event.stopPropagation(); resetVerticalCaret(event.currentTarget) }} onDoubleClick={event => event.stopPropagation()}
    onInput={event => { resetVerticalCaret(event.currentTarget); changed.current() }}
    onCompositionStart={() => { composing.current = true; setCanSplit(false) }}
    onCompositionEnd={() => { composing.current = false; changed.current() }}
    onBlur={() => finish.current()}
    onKeyDown={event => {
      event.stopPropagation()
      if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
      if (item.orientation === 'vertical' && moveVerticalCaret(event.currentTarget, event.nativeEvent)) {
        event.preventDefault()
        return
      }
      if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && (event.key === 'Enter' || event.key.toLowerCase() === 's'))) {
        event.preventDefault(); finish.current(false, true)
        void controller.flush()
      }
    }} />
    <button type="button" className="pl-split-text" disabled={!canSplit} aria-label="分割" style={{
      fontSize: 12 / scale, padding: `${3 / scale}px ${7 / scale}px`, borderWidth: 1 / scale,
      right: -9 / scale, top: '50%', transform: `translate(100%, -50%) rotate(${item.rotation}deg)`,
    }} onPointerDown={event => {
      event.stopPropagation(); event.preventDefault()
      const selection = window.getSelection(), node = element.current
      if (selection?.anchorNode && selection.focusNode && node?.contains(selection.anchorNode) && node.contains(selection.focusNode)) {
        const map = readEditableText(node)
        savedSelection.current = [map.offsetAt(selection.anchorNode, selection.anchorOffset), map.offsetAt(selection.focusNode, selection.focusOffset)]
      }
    }} onClick={event => { event.stopPropagation(); split.current() }}>分割</button>
  </>
}
