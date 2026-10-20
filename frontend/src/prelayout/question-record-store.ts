import { body, projectPath, request } from './api'
import type { TextReference } from './question-references'

export type QuestionRecord = { id: string; note: string; texts: TextReference[]; createdAt: string; updatedAt: string }
type RecordsDocument = { version: number; records: QuestionRecord[] }

// Read before appending so records added from another window are preserved.
// The caller retains the same record ID across retries after a lost response.
export async function appendQuestionRecord(project: string, record: QuestionRecord): Promise<void> {
  const path = `${projectPath(project)}/question-records`
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await request<RecordsDocument>(path)
    if (current.records.some(value => value.id === record.id)) return
    try {
      await request(path, body({ expected_version: current.version, records: [record, ...current.records] }, 'PUT'))
      return
    } catch (error) {
      if ((error as Error & { status?: number }).status !== 409 || attempt === 2) throw error
    }
  }
}
