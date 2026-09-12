import type { Item } from './types'
import { moved } from './geometry'

export type TextAdjustment = { kind: 'move'; dx: number; dy: number } | { kind: 'font' | 'rotate'; delta: number }
type ShortcutKey = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'isComposing' | 'defaultPrevented' | 'keyCode'>

export function textShortcut(event: ShortcutKey): TextAdjustment | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return null
  const command = event.metaKey || event.ctrlKey
  const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
  if (arrow && !event.altKey && (!command || event.shiftKey)) {
    const step = command ? 50 : event.shiftKey ? 10 : 1
    return { kind: 'move', dx: arrow[0] * step, dy: arrow[1] * step }
  }
  if (!command) return null
  // Option changes event.key on macOS; keep the desktop punctuation bindings
  // available by physical key, with key-value fallbacks for other layouts.
  if (['Equal', 'NumpadAdd'].includes(event.code) || ['+', '='].includes(event.key)) return { kind: 'font', delta: event.altKey ? 10 : 2 }
  if (['Minus', 'NumpadSubtract'].includes(event.code) || event.key === '-') return { kind: 'font', delta: event.altKey ? -10 : -2 }
  if (event.code === 'BracketLeft' || event.key === '[') return { kind: 'rotate', delta: event.altKey ? 5 : 1 }
  if (event.code === 'BracketRight' || event.key === ']') return { kind: 'rotate', delta: event.altKey ? -5 : -1 }
  return null
}

export function adjustedItems(items: Item[], ids: string[], adjustment: TextAdjustment, width: number, height: number): Item[] {
  const selected = new Set(ids)
  let changed = false
  const result = items.map(item => {
    if (!selected.has(item._id)) return item
    if (adjustment.kind === 'move') {
      if (!adjustment.dx && !adjustment.dy) return item
      changed = true
      return moved(item, adjustment.dx, adjustment.dy, width, height)
    }
    const property = adjustment.kind === 'font' ? 'font-size' : 'rotation'
    let value = item[property] + adjustment.delta
    if (property === 'font-size') value = Math.max(1, Math.min(999, value))
    else {
      // Match the source editor's (-180, 180] angle range, including wraparound.
      value = ((value + 180) % 360 + 360) % 360 - 180
      if (value === -180) value = 180
      value = Math.round(value * 100) / 100
    }
    if (value === item[property]) return item
    changed = true
    return { ...item, [property]: value, match_status: 'manual' }
  })
  return changed ? result : items
}

export const shortcutHelp = [
  ['移動文字', '方向鍵：1 px；Shift＋方向鍵：10 px；⌘／Ctrl＋Shift＋方向鍵：50 px'],
  ['放大／縮小文字', '⌘／Ctrl＋＋／－：2；再加 Option／Alt：10（＋也可直接按 =）'],
  ['旋轉文字', '⌘／Ctrl＋[：逆時針 1°；⌘／Ctrl＋]：順時針 1°；再加 Option／Alt：5°'],
  ['選框字級按鈕', '左上 −／右上 +：縮小／放大文字 2；Option／Alt 點擊：10'],
  ['選框旋轉按鈕', '左下 ↶／右下 ↷：每次 1°；Option／Alt 點擊：5°；框上方圓點可拖曳旋轉'],
  ['滑鼠調字級', '指標在漫畫頁面內，Option／Alt＋滾輪：上滾放大 2，下滾縮小 2'],
  ['捲動與畫面縮放', '普通滾輪上下捲動；⌘／Ctrl＋滾輪縮放畫面'],
  ['切換頁面／底圖', 'PageUp／PageDown：上一頁／下一頁；Q：切換去字底圖'],
  ['保存／撤銷／重做', '⌘／Ctrl＋S；⌘／Ctrl＋Z；⌘／Ctrl＋Shift＋Z'],
  ['多選／取消選取', 'Shift＋點選文字；Esc 取消選取'],
  ['複製與新增', '⌘／Ctrl＋D 複製；F1 暫存，F2 貼到指標位置；⌘／Ctrl＋N 新增'],
  ['刪除文字', 'Delete／Backspace'],
] as const
