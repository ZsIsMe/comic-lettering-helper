import type { Group } from './types'

export type ImportedGroup = { name: string; font?: string | null }
export type GroupImportResult = { names: string[]; fonts: Record<string, string | null>; applyFontGroups: string[] }
export type GroupConflict = 'overwrite' | 'keep'
export const maxGroupImportBytes = 5 * 1024 * 1024
export const groupNameKey = (name: string) => name.trim().toLowerCase()
const hasControls = (value: string) => Array.from(value).some(char => {
  const code = char.charCodeAt(0)
  return code < 32 || (code >= 127 && code <= 159)
})

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function validateGroups(value: unknown): ImportedGroup[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('分組必須是陣列，且不能超過 1000 個。')
  const names = new Set<string>()
  return value.map((entry: unknown, index) => {
    if (!object(entry) || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 80 || hasControls(entry.name)) {
      throw new Error(`第 ${index + 1} 個分組名稱無效：名稱須為 1–80 字，且不能包含控制字元。`)
    }
    const name = entry.name.trim(), key = groupNameKey(name)
    if (names.has(key)) throw new Error(`分組名稱重複：${name}`)
    names.add(key)
    const result: ImportedGroup = { name }
    if (Object.hasOwn(entry, 'font')) {
      if (entry.font !== null && (typeof entry.font !== 'string' || entry.font.length > 512 || hasControls(entry.font))) {
        throw new Error(`「${name}」的字體無效：須為 PostScript 名稱或空值，最多 512 字。`)
      }
      result.font = typeof entry.font === 'string' ? entry.font.trim() || null : null
    }
    return result
  })
}

// Read only group defaults; text, layout and other project data never enter the draft.
export function parseGroupImport(value: unknown): ImportedGroup[] {
  if (!object(value)) throw new Error('JSON 必須包含 groupList 分組資料。')
  const groups = Object.hasOwn(value, 'groupList') ? value.groupList : object(value.template) ? value.template.groupList : undefined
  if (groups === undefined) throw new Error('這份 JSON 沒有 groupList 分組資料。')
  return validateGroups(groups)
}

export function mergeGroupImport(current: Group[], source: ImportedGroup[], selectedIndices: number[], conflict: GroupConflict = 'overwrite', applyExisting = false): GroupImportResult {
  const existing = validateGroups(current), incoming = validateGroups(source)
  if (conflict !== 'overwrite' && conflict !== 'keep') throw new Error('同名分組處理方式無效。')
  if (selectedIndices.some(index => !Number.isInteger(index) || index < 0 || index >= incoming.length)) throw new Error('所選分組無效，請重新選取。')
  const selected = new Set(selectedIndices)
  // Existing display names and positions remain unchanged, including their original spacing.
  const names = current.map(group => group.name)
  const positions = new Map(existing.map((group, index) => [groupNameKey(group.name), index]))
  const fonts: GroupImportResult['fonts'] = {}, applyFontGroups: string[] = []
  incoming.forEach((group, sourceIndex) => {
    if (!selected.has(sourceIndex)) return
    const key = groupNameKey(group.name), found = positions.get(key)
    if (found !== undefined && conflict === 'keep') return
    const index = found ?? names.length
    if (found === undefined) { names.push(group.name); positions.set(key, index) }
    if (Object.hasOwn(group, 'font')) {
      fonts[String(index)] = group.font ?? null
      // Clearing a default does not clear individually assigned fonts.
      if (found !== undefined && applyExisting && group.font) applyFontGroups.push(String(index))
    }
  })
  if (names.length > 1000) throw new Error('匯入後分組超過 1000 個，請減少選取。')
  return { names, fonts, applyFontGroups }
}
