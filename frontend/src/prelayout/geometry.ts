import type { Item, Measure } from './types'

export type Selection = { page: string; ids: string[]; byPage?: Record<string, string[]>; order?: { page: string; id: string }[] }
export function selectionPages(selection: Selection): Record<string, string[]> {
  return Object.fromEntries(Object.entries({ ...selection.byPage, [selection.page]: selection.ids }).filter(([, ids]) => ids.length))
}
export function selectionIds(selection: Selection, page: string): string[] {
  return page === selection.page ? selection.ids : selection.byPage?.[page] || []
}
export function selectionOrder(selection: Selection): { page: string; id: string }[] {
  const pages = selectionPages(selection), seen = new Set<string>()
  return [...(selection.order || []), ...Object.entries(pages).flatMap(([page, ids]) => ids.map(id => ({ page, id })))].filter(value => {
    const key = JSON.stringify([value.page, value.id])
    if (!pages[value.page]?.includes(value.id) || seen.has(key)) return false
    seen.add(key); return true
  })
}
export function selectTextItem(selection: Selection, page: string, id: string, additive: boolean): Selection {
  const pages = selectionPages(selection), existing = pages[page] || []
  const order = selectionOrder(selection).filter(value => !(additive && existing.includes(id) && value.page === page && value.id === id))
  if (additive && !existing.includes(id)) order.push({ page, id })
  if (!additive && !existing.includes(id)) return { page, ids: [id] }
  const ids = additive ? existing.includes(id) ? existing.filter(value => value !== id) : [...existing, id] : existing
  pages[page] = ids
  const entries = Object.entries(pages).filter(([, values]) => values.length)
  if (!entries.length) return { page, ids: [] }
  const active = ids.length ? page : entries[entries.length - 1][0]
  return { page: active, ids: pages[active], byPage: Object.fromEntries(entries), order }
}
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
