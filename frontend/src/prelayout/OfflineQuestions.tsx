import { useMemo, useRef } from 'react'
import { InlineQuestionRecord, type QuestionStore } from './InlineQuestionRecord'
import type { EditorState } from './editor-state'
import type { Selection } from './geometry'
import type { OfflineProject } from './offline-data'
import type { RecordsDocument } from './question-record-store'
import type { TextReference } from './question-references'

export function OfflineQuestions({ session, controller, selection, onChange, onNavigate, onDraftChange }: {
  session: OfflineProject; controller: EditorState; selection: Selection; onChange: () => void;
  onDraftChange?: (pending: boolean) => void; onNavigate?: (reference: TextReference) => void | Promise<void>;
}) {
  const changed = useRef(onChange)
  changed.current = onChange
  const store = useMemo<QuestionStore>(() => {
    function read(): RecordsDocument {
      const doc = session.meo.questionRecords
      if (doc === undefined) return { version: 0, records: [] }
      if (!doc || typeof doc !== 'object' || !('records' in doc) || !Array.isArray(doc.records) ||
          !('version' in doc) || !Number.isInteger(doc.version) || !doc.records.every(record =>
            record && typeof record.id === 'string' && typeof record.note === 'string' && Array.isArray(record.texts) &&
            record.texts.every((ref: TextReference) => ref && typeof ref.key === 'string'))) {
        throw new Error('此 JSON 的疑問記錄格式無法讀取。')
      }
      return doc as RecordsDocument
    }
    function write(change: (records: RecordsDocument['records']) => RecordsDocument['records']) {
      const current = read()
      const next = { ...current, version: current.version + 1, records: change(current.records) }
      session.meo.questionRecords = next
      changed.current()
      return next
    }
    return {
      readQuestionRecords: async () => read(),
      appendQuestionRecord: async (_, record) => write(records => [...records, record]),
      updateQuestionRecord: async (_, original, note, updatedAt) => write(records =>
        records.map(record => record.id === original.id ? { ...record, note, updatedAt } : record)),
      deleteQuestionRecord: async (_, original) => write(records => records.filter(record => record.id !== original.id)),
    }
  }, [session])
  return <InlineQuestionRecord project={{ id: controller.project, pages: session.pages, template: { page_summary: session.meo.page_summary } }}
    controller={controller} selection={selection} onSaved={() => {}} store={store} onDraftChange={onDraftChange} onNavigate={onNavigate} />
}
