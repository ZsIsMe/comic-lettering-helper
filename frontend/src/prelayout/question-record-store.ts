import { body, projectPath, request } from './api'
import type { TextReference } from './question-references'

export type QuestionRecord = { id: string; note: string; texts: TextReference[]; createdAt: string; updatedAt: string }
export type RecordsDocument = { version: number; records: QuestionRecord[] }

function recordsDocument(value: RecordsDocument): RecordsDocument {
  if (!value || !Number.isInteger(value.version) || value.version < 0 || !Array.isArray(value.records)) throw new Error('記錄回應格式無效，保存結果尚未確認，請重試。')
  return value
}

export async function readQuestionRecords(project: string): Promise<RecordsDocument> {
  return recordsDocument(await request(`${projectPath(project)}/question-records`))
}

async function changeRecords(project: string, change: (records: QuestionRecord[]) => QuestionRecord[] | null): Promise<RecordsDocument> {
  const path = `${projectPath(project)}/question-records`
  for (let attempt = 0; ; attempt++) {
    const current = await readQuestionRecords(project)
    const records = change(current.records)
    if (!records) return current
    try {
      const saved = await request<RecordsDocument>(path, body({ expected_version: current.version, records }, 'PUT'))
      return recordsDocument(saved)
    } catch (error) {
      if ((error as Error & { status?: number }).status !== 409 || attempt === 2) throw error
    }
  }
}

// The same ID is retained across retries after a lost append response.
export function appendQuestionRecord(project: string, record: QuestionRecord): Promise<RecordsDocument> {
  return changeRecords(project, records => records.some(value => value.id === record.id) ? null : [...records, record])
}

function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${fingerprint(child)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
function unchanged(current: QuestionRecord | undefined, original: QuestionRecord) {
  if (!current || fingerprint(current) !== fingerprint(original)) {
    throw Object.assign(new Error('這條記錄已被其他視窗修改或刪除，請重新載入後再修改。'), { status: 409 })
  }
}

/** Change only note/updatedAt, retaining the current immutable reference snapshots. */
export function updateQuestionRecord(project: string, original: QuestionRecord, note: string, updatedAt: string): Promise<RecordsDocument> {
  return changeRecords(project, records => {
    const current = records.find(record => record.id === original.id)
    if (current?.note === note && current.createdAt === original.createdAt && fingerprint(current.texts) === fingerprint(original.texts)) return null
    unchanged(current, original)
    return records.map(record => record.id === original.id ? { ...record, note, updatedAt } : record)
  })
}

export function deleteQuestionRecord(project: string, original: QuestionRecord): Promise<RecordsDocument> {
  return changeRecords(project, records => {
    const current = records.find(record => record.id === original.id)
    if (!current) return null
    unchanged(current, original)
    return records.filter(record => record.id !== original.id)
  })
}
