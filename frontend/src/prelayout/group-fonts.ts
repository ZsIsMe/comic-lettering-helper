import type { Group, Item } from './types'
import { fontName } from './local-fonts'

// A group preset applies on assignment only; later direct font edits remain independent.
export function groupFontChanges(changes: Partial<Item>, groups: Group[]): Partial<Item> {
  if (!Object.hasOwn(changes, 'groupId') || Object.hasOwn(changes, 'font')) return changes
  const id = changes.groupId
  const font = typeof id === 'number' ? fontName(groups[id]?.font) : ''
  return font ? { ...changes, font } : changes
}
