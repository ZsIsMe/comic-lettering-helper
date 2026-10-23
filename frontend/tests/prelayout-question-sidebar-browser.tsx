import { createRoot } from 'react-dom/client'
import { useMemo, useState } from 'react'
import { InlineQuestionRecord } from '../src/prelayout/InlineQuestionRecord'
import type { EditorState } from '../src/prelayout/editor-state'
import type { Selection } from '../src/prelayout/geometry'
import type { TextReference } from '../src/prelayout/question-references'
import type { RecordsDocument } from '../src/prelayout/question-record-store'
import type { PageData, Project } from '../src/prelayout/types'
import '../src/prelayout/styles.css'

const page: PageData = { id: 'page-a', name: '001.png', width: 800, height: 1000, revision: 0, sha256: '', clean: null, measure: [], items: [
  { _id: 'a', text: '第一條譯文', x: .25, y: .3, 'font-size': 32, rotation: 0, orientation: 'horizontal', color: '#000', 'stroke-color': '#fff', 'stroke-weight': 0, ocr_text: '最初の原文' },
  { _id: 'b', text: '第二條譯文', x: .65, y: .6, 'font-size': 32, rotation: 0, orientation: 'vertical', color: '#000', 'stroke-color': '#fff', 'stroke-weight': 0 },
] }
const pageB: PageData = { ...page, id: 'page-b', name: '002.png', items: [{ ...page.items[0], _id: 'c', text: '跨頁第三條譯文' }] }
const reference = (source: PageData, ordinal: number): TextReference => ({ key: `${source.id}-${ordinal}`, pageId: source.id, pageNumber: source.id === 'page-a' ? 1 : 2,
  pageName: source.name, itemId: source.items[ordinal - 1]._id, itemNumber: ordinal, text: source.items[ordinal - 1].text, source: { ocr_text: `原文 ${ordinal}` } })
const original: RecordsDocument = { version: 2, records: [
  { id: 'q-a', note: '第一筆疑問：兩句的用詞是否一致？\n第二行仍只顯示一行摘要', texts: [reference(page, 2), reference(pageB, 1), reference(page, 1)], createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z' },
  { id: 'q-b', note: '第二筆疑問：稱呼的語氣', texts: [reference(page, 1)], createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T10:00:00Z' },
] }
let document = structuredClone(original), failRead = false, loseWriteResponse = false
let reads = 0, writes = 0
// This fixture intercepts only its synthetic project API and never reaches a backend.
window.fetch = async (input, options) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
  if (url !== '/api/prelayout/projects/offline-sidebar/question-records') throw new Error(`離線fixture拒絕其他請求：${url}`)
  if (!options?.method || options.method === 'GET') {
    reads++
    if (failRead) { failRead = false; return new Response(JSON.stringify({ detail: '離線模擬讀取失敗' }), { status: 503 }) }
    return Response.json(document)
  }
  const payload = JSON.parse(String(options.body))
  if (payload.expected_version !== document.version) return Response.json({ detail: '版本衝突' }, { status: 409 })
  document = { version: document.version + 1, records: structuredClone(payload.records) }; writes++
  if (loseWriteResponse) { loseWriteResponse = false; throw new Error('已保存，但回應中斷') }
  return Response.json(document)
}

// Standalone Vite browser fixture.
// eslint-disable-next-line react-refresh/only-export-components
function Fixture() {
  const project = useMemo<Project>(() => ({ id: 'offline-sidebar', name: '離線疑問側欄測試', pages: [page, pageB], updated_at: '', revision: 0, detection_id: null }), [])
  const controller = useMemo(() => ({ pages: new Map([[page.id, { data: page }], [pageB.id, { data: pageB }]]) }) as EditorState, [])
  const [selection, setSelection] = useState<Selection>({ page: page.id, ids: ['a'] })
  const [pending, setPending] = useState(false), [refresh, setRefresh] = useState(0), [navigation, setNavigation] = useState<TextReference | null>(null)
  const [notice, setNotice] = useState(''), [revision, setRevision] = useState(0)
  const navigate = (reference: TextReference) => { setNavigation(reference); setSelection({ page: reference.pageId, ids: [reference.itemId] }) }
  return <main className="pl-shell fixture"><h1>疑問管理側欄離線測試</h1>
    <p>右側疑問區塊固定展開。點摘要修改疑問；數字引用只定位，不切換編輯記錄。所有API均由此fixture攔截。</p>
    <div className="fixture-tools">
      <button onClick={() => setSelection({ page: page.id, ids: ['a', 'b'], byPage: { [pageB.id]: ['c'] } })}>選取 3 條跨頁文本</button>
      <button onClick={() => setSelection({ page: page.id, ids: [] })}>清除選取</button>
      <button onClick={() => { setRefresh(value => value + 1); setRevision(value => value + 1) }}>模擬主視窗關閉後刷新</button>
      <button onClick={() => { failRead = true; setRefresh(value => value + 1) }}>下一次列表讀取失敗</button>
      <button onClick={() => { loseWriteResponse = true; setNotice('下一次保存將已完成但回應中斷') }}>下一次保存回應中斷</button>
      <button onClick={() => { document.records[0] = { ...document.records[0], note: '其他視窗已修改此記錄', updatedAt: new Date().toISOString() }; document.version++; setNotice('第一筆被其他視窗修改；原草稿保存應拒絕覆蓋'); setRevision(value => value + 1) }}>其他視窗修改第一筆</button>
    </div>
    <div className="fixture-layout"><section><p role="status">{notice}</p><p>匯出狀態：<strong>{pending ? '禁止：保存結果待確認' : '允許'}</strong></p>
      <p>目前選取：{JSON.stringify(selection)}</p><p id="navigation-output">引用定位：{navigation ? `第 ${navigation.pageNumber} 頁第 ${navigation.itemNumber} 框 · ${navigation.text}` : '尚未定位'}</p>
      <button onClick={() => setRevision(value => value + 1)}>更新伺服器快照顯示</button>
      <output id="server-records" data-revision={revision}>{JSON.stringify({ reads, writes, ...document }, null, 2)}</output>
    </section><aside className="pl-inspector pl-compact-workspace">
      <InlineQuestionRecord project={project} controller={controller} selection={selection} refreshKey={refresh} onNavigate={navigate}
        onExportPendingChange={setPending} onSaved={() => { setNotice('新增成功，已清除選取'); setSelection({ page: page.id, ids: [] }); setRevision(value => value + 1) }} />
    </aside></div>
  </main>
}
createRoot(globalThis.document.querySelector('#root')!).render(<Fixture />)
