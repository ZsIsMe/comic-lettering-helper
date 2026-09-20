import type { Item, Page } from './types'
import type { PagePointer } from './geometry'
import { copyFrame, normalizeClipboardText, readFrame, storeFrame, type FramePaste } from './frame-clipboard'

export type FrameClipboardOptions = {
  blocked: (event: KeyboardEvent) => boolean
  selectionCount: number
  selected: Item[]
  selectedPage?: Pick<Page, 'width' | 'height'>
  pointer: { current: PagePointer | null }
  paste: (capture: FramePaste, current: () => boolean) => Promise<void>
  notify: (message: string) => void
  readText?: () => Promise<string>
}

export function createFrameClipboardHandler(options: () => FrameClipboardOptions) {
  let alive = true
  let readPending = false
  let generation = 0
  const current = (request: number) => alive && request === generation

  const key = (event: KeyboardEvent) => {
    const value = options()
    if (value.blocked(event) || event.isComposing || event.keyCode === 229) return
    const command = event.metaKey || event.ctrlKey
    const letter = event.key.toLowerCase()
    if (!command || event.altKey || event.shiftKey || !['c', 'v', 'p'].includes(letter)) return
    event.preventDefault()

    if (letter === 'c') {
      if (event.repeat) return
      if (!value.selectionCount) { value.notify('請先選取一個文字框再複製'); return }
      if (value.selectionCount !== 1 || value.selected.length !== 1) { value.notify('一次只能複製一個文字框'); return }
      if (!value.selectedPage) { value.notify('無法取得所選文字框的頁面資料'); return }
      storeFrame(copyFrame(value.selected[0], value.selectedPage))
      value.notify('已複製文字框樣式與內容')
      return
    }

    if (event.repeat) return
    const frame = readFrame()
    if (!frame) { value.notify('尚未複製文字框，請先選取一個文字框並按 ⌘／Ctrl＋C'); return }
    const pointer = value.pointer.current ? { ...value.pointer.current } : null
    if (!pointer) { value.notify('請將滑鼠移到左側可編輯頁面後再貼上'); return }
    if (letter === 'p' && readPending) { value.notify('正在讀取系統剪貼簿，請稍候'); return }

    const request = ++generation
    const capture = { frame, pointer }
    if (letter === 'v') {
      void value.paste(capture, () => current(request)).catch(error => {
        if (current(request)) value.notify((error as Error).message || '貼上文字框失敗')
      })
      return
    }

    const readText = value.readText || (() => {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) throw new Error('瀏覽器無法讀取系統剪貼簿')
      return navigator.clipboard.readText()
    })
    readPending = true
    void Promise.resolve().then(readText).then(text => {
      if (!current(request)) return
      const normalized = normalizeClipboardText(text)
      if (!normalized) { value.notify('系統剪貼簿沒有文字'); return }
      return value.paste({ ...capture, text: normalized }, () => current(request))
    }).catch(error => {
      if (!current(request)) return
      const denied = typeof DOMException !== 'undefined' && error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      value.notify(denied ? '無法讀取系統剪貼簿，請允許剪貼簿權限後重試' : (error as Error).message || '無法讀取系統剪貼簿')
    }).finally(() => { readPending = false })
  }

  return { key, dispose: () => { alive = false; generation += 1 } }
}
