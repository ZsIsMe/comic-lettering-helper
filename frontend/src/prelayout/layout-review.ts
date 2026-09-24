import type { CSSProperties } from 'react'
import { color, transform } from './geometry'
import type { Item, PageData } from './types'

export type TextRect = [number, number, number, number]
export type PageMeasurement = { rects: Record<string, TextRect>; risks: string[] }

/** The same placement and paint properties used by the live .pl-text elements. */
export function textStyle(item: Item, page: Pick<PageData, 'width' | 'height'>): CSSProperties {
  return {
    left: item.x * page.width, top: item.y * page.height, transform: transform(item),
    fontSize: item['font-size'], writingMode: item.orientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
    color: color(item.color), WebkitTextStroke: `${item['stroke-weight']}px ${color(item['stroke-color'])}`,
  }
}

function intersects(a: TextRect, b: TextRect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

/** Measure actual browser text geometry, including writing mode, rotation, and stroke margin. */
export async function measurePage(page: PageData): Promise<PageMeasurement> {
  if (typeof document === 'undefined' || !document.body) throw new Error('文字測量需要瀏覽器頁面。')
  const root = document.createElement('div')
  root.className = 'pl-shell'
  Object.assign(root.style, { position: 'absolute', left: '-100000px', top: '0', width: `${page.width}px`, height: `${page.height}px`,
    visibility: 'hidden', pointerEvents: 'none', overflow: 'visible', margin: '0', padding: '0', border: '0', maxWidth: 'none', boxSizing: 'content-box' })
  const nodes = new Map<string, HTMLElement>()
  for (const item of page.items) {
    if (nodes.has(item._id)) throw new Error(`重複的文字項目 ID：${item._id}`)
    const node = document.createElement('div')
    node.className = 'pl-text'
    const style = textStyle(item, page)
    node.style.left = `${style.left}px`
    node.style.top = `${style.top}px`
    node.style.fontSize = `${style.fontSize}px`
    node.style.transform = String(style.transform)
    node.style.writingMode = String(style.writingMode)
    node.style.color = String(style.color)
    node.style.webkitTextStroke = String(style.WebkitTextStroke)
    node.textContent = item.text || '\u200b'
    root.appendChild(node)
    nodes.set(item._id, node)
  }
  document.body.appendChild(root)
  try {
    if (document.fonts?.ready) await document.fonts.ready
    const origin = root.getBoundingClientRect()
    const rects: Record<string, TextRect> = {}
    const risks: string[] = []
    for (const item of page.items) {
      const rect = nodes.get(item._id)!.getBoundingClientRect()
      // CSS text stroke paints outside the DOM box and is absent from getBoundingClientRect.
      const stroke = Math.max(0, Number(item['stroke-weight']) || 0) / 2
      const box: TextRect = [rect.left - origin.left - stroke, rect.top - origin.top - stroke, rect.right - origin.left + stroke, rect.bottom - origin.top + stroke]
      rects[item._id] = box
      if (box[0] < 0 || box[1] < 0 || box[2] > page.width || box[3] > page.height) risks.push(`outside:${item._id}`)
    }
    for (let i = 0; i < page.items.length; i++) {
      for (let j = i + 1; j < page.items.length; j++) {
        const first = page.items[i]._id, second = page.items[j]._id
        if (intersects(rects[first], rects[second])) risks.push(`overlap:${first}:${second}`)
      }
    }
    return { rects, risks }
  } finally {
    root.remove()
  }
}

/** Group nearby changed text bounds into local review crops in original image pixels. */
export function cropRegions(before: PageData, after: PageData, beforeRects: Record<string, TextRect>, afterRects: Record<string, TextRect>, changedIds: string[], padding: number): number[][] {
  const margin = Number.isFinite(padding) ? Math.max(0, Math.min(300, padding)) : 80
  const width = after.width || before.width, height = after.height || before.height
  const boxes: TextRect[] = []
  for (const id of new Set(changedIds)) {
    for (const rect of [beforeRects[id], afterRects[id]]) {
      if (!rect || rect.length !== 4 || rect.some(value => !Number.isFinite(value))) continue
      boxes.push([Math.max(0, Math.floor(rect[0] - margin)), Math.max(0, Math.floor(rect[1] - margin)),
        Math.min(width, Math.ceil(rect[2] + margin)), Math.min(height, Math.ceil(rect[3] + margin))])
    }
  }
  const regions = boxes.filter(box => box[2] > box[0] && box[3] > box[1])
  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length;) {
      if (intersects(regions[i], regions[j])) {
        regions[i] = [Math.min(regions[i][0], regions[j][0]), Math.min(regions[i][1], regions[j][1]), Math.max(regions[i][2], regions[j][2]), Math.max(regions[i][3], regions[j][3])]
        regions.splice(j, 1)
        i = -1
        break
      }
      j++
    }
  }
  return regions.sort((a, b) => a[1] - b[1] || a[0] - b[0])
}
