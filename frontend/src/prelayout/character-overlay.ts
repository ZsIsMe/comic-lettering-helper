import type { CharacterBox } from './types'

export function characterLabel(item: CharacterBox): string {
  const size = item.estimated_font_size ?? item.calculated_font_size
  return `W${Math.round(item.width)}H${Math.round(item.height)}${size && size > 0 ? `FS${size.toFixed(1)}` : ''}`
}

export function characterAt(items: CharacterBox[], x: number, y: number): number | null {
  let result: number | null = null, smallest = Infinity
  items.forEach((item, index) => {
    const [x1, y1, x2, y2] = item.bbox
    const area = (x2 - x1) * (y2 - y1)
    if (area > 0 && area < smallest && x >= x1 && x <= x2 && y >= y1 && y <= y2) { result = index; smallest = area }
  })
  return result
}

export function characterPath(items: CharacterBox[]): string {
  return items.map(({ bbox: [x1, y1, x2, y2] }) => `M${x1},${y1}h${x2 - x1}v${y2 - y1}h${x1 - x2}Z`).join('')
}
