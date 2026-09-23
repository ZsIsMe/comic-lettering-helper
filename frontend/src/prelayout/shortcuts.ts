import type { Item } from './types'
import { moved } from './geometry'

export type TextAdjustment = { kind: 'move'; dx: number; dy: number } | { kind: 'font' | 'rotate'; delta: number }
  | { kind: 'color' } | { kind: 'stroke' } | { kind: 'orientation' }
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
    if (adjustment.kind === 'color') {
      const nextColor = isBlack(item.color) ? '#ffffff' : '#000000'
      changed = true
      return { ...item, color: nextColor, 'stroke-color': strokeColor(nextColor), match_status: 'manual' }
    }
    if (adjustment.kind === 'stroke') {
      const nextWeight = item['stroke-weight'] > 0 ? 0 : 4
      const nextColor = strokeColor(item.color)
      if (nextWeight === item['stroke-weight'] && nextColor === item['stroke-color']) return item
      changed = true
      return { ...item, 'stroke-weight': nextWeight, 'stroke-color': nextColor, match_status: 'manual' }
    }
    if (adjustment.kind === 'orientation') {
      changed = true
      const orientation: Item['orientation'] = item.orientation === 'horizontal' ? 'vertical' : 'horizontal'
      return { ...item, orientation, match_status: 'manual' }
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

export function isBlack(value: string): boolean {
  const normalized = value.trim().toLowerCase().replaceAll(' ', '')
  return ['black', '#000', '000', '#000000', '000000', 'rgb(0,0,0)', 'rgba(0,0,0,1)'].includes(normalized)
}

export const strokeColor = (textColor: string) => isBlack(textColor) ? '#ffffff' : '#000000'

export type ShortcutHelpItem = readonly [action: string, keys: string]

export const shortcutHelpGroups = [
  {
    title: '一般操作',
    items: [
      ['保存／撤銷／重做', '⌘／Ctrl＋S；⌘／Ctrl＋Z；⌘／Ctrl＋Shift＋Z'],
      ['切換頁面／底圖／差異', 'PageUp／PageDown：上一頁／下一頁；Q：切換去字底圖；H：切換差異高亮'],
      ['多選／取消選取', 'Shift＋點選文字：加入多選；Esc：取消選取'],
      ['刪除文字', 'Delete／Backspace：刪除所選文字框'],
      ['複製所選文字', '⌘／Ctrl＋D：複製所選文字框，並向右下偏移 16 原圖像素'],
      ['新增文字', '⌘／Ctrl＋N：在漫畫頁面內最後的指標位置新增；雙擊空白處也可新增'],
      ['暫存樣式文字框', 'F1：暫存單一所選文字框；F2：以相同文字與樣式貼到漫畫頁面內最後的指標位置'],
      ['複製完整文字框', '⌘／Ctrl＋C：暫存單一所選文字框的文字與完整樣式，不覆寫作業系統剪貼簿'],
      ['貼上完整文字框', '⌘／Ctrl＋V：將暫存框完整貼到左側編輯畫布的指標中心；未暫存或指標無效時顯示提示'],
      ['以剪貼簿純文字貼上', '⌘／Ctrl＋P：讀取作業系統剪貼簿純文字，保留換行並套用暫存框樣式，貼到左側編輯畫布的指標中心'],
    ] satisfies readonly ShortcutHelpItem[],
  },
  {
    title: '文字編輯',
    items: [
      ['進入原位編輯', '雙擊文字；Mac 也可用 ⌘＋單擊文字'],
      ['換行／完成編輯', 'Enter：換行；⌘／Ctrl＋Enter 或 ⌘／Ctrl＋S：保存並完成；Esc 或點擊框外：保存並結束'],
      ['直排文字游標', '編輯中 ←／→ 換欄，↑／↓ 逐字移動；加 Shift 延伸選字'],
      ['編輯中的剪貼簿', '原位編輯時，⌘／Ctrl＋C／V 沿用瀏覽器原生文字複製貼上；⌘／Ctrl＋P 不攔截'],
      ['分割部分文字', '原位編輯時選取部分文字，再點「分割」；選取內容繼承樣式另建文字框'],
      ['移動文字', '方向鍵：1 px；Shift＋方向鍵：10 px；⌘／Ctrl＋Shift＋方向鍵：50 px'],
      ['放大／縮小文字', '⌘／Ctrl＋＋／－：2；再加 Option／Alt：10（＋也可直接按 =）'],
      ['旋轉文字', '⌘／Ctrl＋[：逆時針 1°；⌘／Ctrl＋]：順時針 1°；再加 Option／Alt：5°'],
      ['快速切換樣式', '框旁按鈕會顯示下一個狀態：切換黑／白色文字、添加／關閉描邊、文字橫排／豎排'],
    ] satisfies readonly ShortcutHelpItem[],
  },
  {
    title: '畫面與滑鼠',
    items: [
      ['捲動與畫面縮放', '普通滾輪：上下捲動；⌘／Ctrl＋滾輪：縮放畫面'],
      ['滑鼠調字級', '指標在漫畫頁面內，Option／Alt＋滾輪：上滾放大 2，下滾縮小 2'],
      ['選框字級按鈕', '左上 −／右上 +：縮小／放大文字 2；Option／Alt 點擊：10'],
      ['選框旋轉按鈕', '左下 ↶／右下 ↷：每次 1°；Option／Alt 點擊：5°；框上方圓點可拖曳旋轉'],
    ] satisfies readonly ShortcutHelpItem[],
  },
] as const

// Keep the original flat export for the existing modal and external callers.
export const shortcutHelp: readonly ShortcutHelpItem[] = shortcutHelpGroups.flatMap(group => group.items)
