import type { Item, Page } from './types'
import type { PagePointer } from './geometry'

export type FrameSnapshot = {
  item: Item
  source: { width: number; height: number }
}

export type FramePaste = {
  frame: FrameSnapshot
  pointer: PagePointer
  text?: string
}

// This buffer intentionally lives outside React so copied frames survive a project
// switch in the same tab. It never reads from or writes to the native clipboard.
let frameBuffer: FrameSnapshot | null = null

const clone = <T,>(value: T): T => structuredClone(value)

export function copyFrame(item: Item, page: Pick<Page, 'width' | 'height'>): FrameSnapshot {
  return { item: clone(item), source: { width: page.width, height: page.height } }
}

export function storeFrame(frame: FrameSnapshot) {
  frameBuffer = clone(frame)
}

export function readFrame(): FrameSnapshot | null {
  return frameBuffer ? clone(frameBuffer) : null
}

export function normalizeClipboardText(value: string) {
  return value.replace(/\r\n?/g, '\n')
}

export function pasteFrame(frame: FrameSnapshot, pointer: PagePointer, target: Pick<Page, 'width' | 'height'>, freshId: () => string, text?: string): Item {
  const item = clone(frame.item)
  item._id = freshId()
  item.x = pointer.x
  item.y = pointer.y
  item.match_status = 'manual'
  delete item.index
  delete item.match_source_block_index
  delete item.source_block_index
  if (text !== undefined) item.text = normalizeClipboardText(text)

  const box = frame.item.xyxy_pixel
  if (box?.length === 4 && frame.source.width > 0 && frame.source.height > 0) {
    // Font size and reference boxes are original-image pixels. Keep their pixel
    // size while rebasing the center through normalized page coordinates.
    const width = box[2] - box[0]
    const height = box[3] - box[1]
    const x = pointer.x * target.width, y = pointer.y * target.height
    item.xyxy_pixel = [x - width / 2, y - height / 2, x + width / 2, y + height / 2]
  } else {
    delete item.xyxy_pixel
  }
  return item
}
