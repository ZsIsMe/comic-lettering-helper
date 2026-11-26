import type { Item, PageData } from './types'

export function sourceLineCount(item: Item, page: Pick<PageData, 'measure' | 'character_boxes'>) {
  const index = item.match_source_block_index
  if (typeof index !== 'number') return { source_line_count: null, source_line_count_source: 'unknown' }
  const measure = page.measure.find(measure => measure.source_block_index === index)
  if (measure && Object.hasOwn(measure, 'source_line_count')) {
    const count = measure.source_line_count
    return typeof count === 'number' && Number.isInteger(count) && count >= 0
      ? { source_line_count: count, source_line_count_source: count ? 'ctd_lines' : 'unknown' }
      : { source_line_count: null, source_line_count_source: 'unknown' }
  }
  const lines = page.character_boxes?.filter(box => box.source_block_index === index).map(box => box.line_index)
  return lines?.length
    ? { source_line_count: new Set(lines).size, source_line_count_source: 'character_boxes_estimate' }
    : { source_line_count: null, source_line_count_source: 'unknown' }
}
