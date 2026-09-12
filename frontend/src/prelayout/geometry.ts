import type { Item, Measure } from './types'

export type Selection = { page: string; ids: string[] }
export type PagePointer = { page: string; x: number; y: number }
export type VisibleRegion = { x: number; y: number; width: number; height: number }
export const color = (value: string) => value === 'black' ? '#000000' : value === 'white' ? '#ffffff' : value.startsWith('#') ? value : `#${value}`
export const transform = (item: Item) => `translate(-50%, -50%) rotate(${-item.rotation}deg)`
export function moved(item: Item, dx: number, dy: number, width: number, height: number): Item {
  return { ...item, x: item.x + dx / width, y: item.y + dy / height, match_status: 'manual',
    ...(item.xyxy_pixel ? { xyxy_pixel: item.xyxy_pixel.map((v, i) => v + (i % 2 ? dy : dx)) } : {}) }
}
export function resized(item: Item, dx: number, dy: number, width: number, height: number): Item {
  // The displayed item rotates by -rotation; invert that transform for handle deltas.
  const angle = item.rotation * Math.PI / 180
  const localX = dx * Math.cos(angle) - dy * Math.sin(angle)
  const localY = dx * Math.sin(angle) + dy * Math.cos(angle)
  const box = item.xyxy_pixel
  const w = Math.max(10, (box ? box[2] - box[0] : 60) + localX * 2)
  const h = Math.max(10, (box ? box[3] - box[1] : 60) + localY * 2)
  const x = item.x * width, y = item.y * height
  return { ...item, xyxy_pixel: [x - w / 2, y - h / 2, x + w / 2, y + h / 2], match_status: 'manual' }
}
export function measureStyle(measure: Measure, size: number): Partial<Item> {
  const textColor = color(measure.text_color || '#000000')
  const stroke = !!measure.text_has_stroke || !!measure.need_inpaint
  return { color: textColor, 'stroke-color': textColor.toLowerCase() === '#ffffff' ? '#000000' : '#ffffff',
    'stroke-weight': stroke ? Math.ceil(size / 8) : 0, need_inpaint: !!measure.need_inpaint,
    text_has_stroke: !!measure.text_has_stroke, match_source_block_index: measure.source_block_index }
}
