import type { Item } from './types'
import { isBlack } from './shortcuts'

export type QuickControlKind = 'color' | 'stroke' | 'orientation'

export const fontLabel = (size?: number) =>
  typeof size === 'number' && Number.isFinite(size) && size > 0 ? String(Math.round(size * 100) / 100) : '—'

export function quickControlLabel(item: Item, kind: QuickControlKind) {
  if (kind === 'color') return isBlack(item.color) ? '切換白色文字' : '切換黑色文字'
  if (kind === 'stroke') return item['stroke-weight'] > 0 ? '關閉描邊' : '添加描邊'
  return item.orientation === 'vertical' ? '文字橫排' : '文字豎排'
}

export function textInfoLabel(item: Item, groupNames: readonly string[]) {
  const group = typeof item.groupId === 'number' ? groupNames[item.groupId] : undefined
  return `${group || '未分組'}，${fontLabel(item['font-size'])}`
}
