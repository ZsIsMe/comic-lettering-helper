import { useLayoutEffect, useRef } from 'react'
import type { Item } from './types'
import type { EditorState } from './editor-state'
import { moveVerticalCaret, resetVerticalCaret } from './caret-navigation'
import { readEditableText } from './editable-text'

// The browser owns this DOM while typing, including its selection and IME range.
// Never reconcile editable children on React renders or during composition.
export function InlineTextEditor({ item, page, controller, point, onFinish }: {
  item: Item; page: string; controller: EditorState;
  point: { x: number; y: number }; onFinish: () => void;
}) {
  const element = useRef<HTMLDivElement>(null)
  const initial = useRef({ item, point, onFinish })
  const composing = useRef(false)
  const lifetime = useRef({ generation: 0 })
  const finish = useRef<(cancel?: boolean, focusPage?: boolean) => void>(() => {})
  const changed = useRef<() => void>(() => {})

  useLayoutEffect(() => {
    const node = element.current!
    const token = lifetime.current
    const currentGeneration = ++token.generation
    const { item: original, point, onFinish } = initial.current
    const read = () => readEditableText(node).text
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
      session.end()
      // React StrictMode replays effects without leaving the editor.
      queueMicrotask(() => { if (token.generation === currentGeneration) finishSession() })
    }
  }, [controller, page])

  return <div ref={element} className="pl-inline-editor" contentEditable="plaintext-only" suppressContentEditableWarning
    role="textbox" aria-label="原位編輯文字" aria-multiline="true" spellCheck={false}
    onPointerDown={event => { event.stopPropagation(); resetVerticalCaret(event.currentTarget) }} onDoubleClick={event => event.stopPropagation()}
    onInput={event => { resetVerticalCaret(event.currentTarget); changed.current() }}
    onCompositionStart={() => { composing.current = true }}
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
}
