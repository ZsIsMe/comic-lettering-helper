import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Empty, Input, Modal, Space, Table, Tag } from 'antd'
import { projectPath, request } from './api'
import type { EditorState } from './editor-state'
import type { Project } from './types'
import { TextReplacementClient, type LatestReplacement, type ReplacementMatch, type ReplacementPreview, type ReplacementResult, type ReplacementSummary } from './text-replacement'

const keyOf = (match: ReplacementMatch) => `${match.page_id}:${match.item_id}`
const describe = (summary: ReplacementSummary) => `${summary.pages} 頁 · ${summary.items} 個文字框 · ${summary.occurrences} 處`

export function TextReplacementModal({ open, project, controller, onClose, onBusyChange, onProject, onReviewPage }: {
  open: boolean; project: Project; controller: EditorState; onClose: () => void;
  onBusyChange: (busy: boolean) => void; onProject: (project: Project) => void; onReviewPage: (id: string) => void;
}) {
  const client = useMemo(() => new TextReplacementClient(project.id), [project.id])
  const [find, setFind] = useState(client.pending?.kind === 'apply' ? client.pending.payload.find : '')
  const [replacement, setReplacement] = useState(client.pending?.kind === 'apply' ? client.pending.payload.replacement : '')
  const [preview, setPreview] = useState<ReplacementPreview | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  const [latest, setLatest] = useState<LatestReplacement | null>(null)
  const [working, setWorking] = useState<'preview' | 'apply' | 'undo' | 'reload' | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(!!client.pending)
  const [syncRequired, setSyncRequired] = useState<{ result: ReplacementResult; kind: 'apply' | 'undo' } | null>(null)
  const [finished, setFinished] = useState<{ kind: 'apply' | 'undo'; summary: ReplacementSummary; pages: Project['pages'] } | null>(null)
  const latestRequest = useRef(0)
  const active = useRef(false)
  const locked = !!working || pending || !!syncRequired
  const selected = preview?.matches.filter(match => selectedKeys.includes(keyOf(match))) || []
  const selectedSummary = { pages: new Set(selected.map(match => match.page_id)).size, items: selected.length,
    occurrences: selected.reduce((total, match) => total + match.occurrences, 0) }

  useEffect(() => {
    if (!open) return
    const version = ++latestRequest.current
    let live = true
    void client.latest().then(value => { if (live && latestRequest.current === version) setLatest(value) })
      .catch(e => { if (live && latestRequest.current === version) setError((e as Error).message) })
    return () => { live = false }
  }, [open, client])

  async function refreshLatest() {
    const version = ++latestRequest.current
    const value = await client.latest()
    if (latestRequest.current === version) setLatest(value)
  }
  function clearPreview() { setPreview(null); setSelectedKeys([]); setFinished(null); setError('') }
  async function run(kind: NonNullable<typeof working>, action: () => Promise<void>) {
    if (active.current) return
    active.current = true; setWorking(kind); onBusyChange(true); setError('')
    try { await action() } catch (e) {
      setError((e as Error).message)
      if ((e as Error & { status?: number }).status === 409) { setPreview(null); setSelectedKeys([]) }
    } finally {
      setPending(!!client.pending); active.current = false; setWorking(null); onBusyChange(false)
    }
  }
  async function flush() {
    if (!await controller.flush()) throw new Error('文字尚未保存，請先處理保存錯誤或版本衝突。')
  }
  async function synchronize(result: ReplacementResult, kind: 'apply' | 'undo') {
    const changed = result.project.pages.filter(page => project.pages.find(old => old.id === page.id)?.revision !== page.revision)
    try {
      await controller.acceptTextReplacement(result.project)
      onProject(result.project); setPreview(null); setSelectedKeys([]); setSyncRequired(null)
      setFinished({ kind, summary: result.summary, pages: changed })
    } catch (e) {
      setSyncRequired({ result, kind })
      throw new Error(`操作已保存，但畫面未同步：${(e as Error).message}`)
    }
    await refreshLatest()
  }
  function previewMatches() {
    void run('preview', async () => {
      await flush()
      const value = await client.preview(find, replacement)
      setPreview(value); setSelectedKeys(value.matches.map(keyOf)); setFinished(null)
    })
  }
  function apply() {
    if (!preview || !selected.length) return
    void run('apply', async () => {
      await flush()
      await synchronize(await client.apply(preview, find, replacement, selected), 'apply')
    })
  }
  function undo() {
    if (!latest?.operation || !latest.can_undo) return
    const operation = latest.operation
    void run('undo', async () => {
      await flush()
      const fresh = await request<Project>(projectPath(project.id))
      await synchronize(await client.undo(operation, fresh.revision), 'undo')
    })
  }
  function retry() {
    const kind = client.pending?.kind
    if (!kind) return
    void run(kind, async () => { await flush(); await synchronize(await client.retry(), kind) })
  }

  return <Modal title="全項目批量替換" open={open} width={960} className="pl-text-replacement-modal"
    maskClosable={false} closable={!working} keyboard={!working} onCancel={() => { if (!working) onClose() }}
    footer={<Space wrap>
      <Button disabled={!!working} onClick={onClose}>關閉</Button>
      <Button disabled={locked || !latest?.can_undo} loading={working === 'undo'} onClick={undo}>撤銷上次替換</Button>
      <Button disabled={locked || !find.length} loading={working === 'preview'} onClick={previewMatches}>預覽替換</Button>
      {syncRequired ? <Button type="primary" loading={working === 'reload'} disabled={!!working} onClick={() => void run('reload', async () => {
        const fresh = await request<Project>(projectPath(project.id))
        await synchronize({ ...syncRequired.result, project: fresh }, syncRequired.kind)
      })}>重新載入結果</Button> : pending ? <Button type="primary" loading={!!working} disabled={!!working} onClick={retry}>重試上次操作</Button>
        : <Button type="primary" loading={working === 'apply'} disabled={!!working || !selected.length} onClick={apply}>替換選取的 {selected.length} 個框</Button>}
    </Space>}>
    <p className="pl-muted">範圍：全項目 {project.pages.length} 頁的全部譯文，包含未開啟的頁面。精確字面匹配；替換為空可刪除命中的字詞。</p>
    <div className="pl-replacement-inputs">
      <label>查找文字<Input aria-label="查找文字" value={find} maxLength={50000} disabled={locked} onChange={e => { setFind(e.target.value); clearPreview() }} onPressEnter={() => { if (!locked && find.length) previewMatches() }} /></label>
      <label>替換為<Input aria-label="替換為" value={replacement} maxLength={50000} disabled={locked} placeholder="留空表示刪除命中的字詞" onChange={e => { setReplacement(e.target.value); clearPreview() }} onPressEnter={() => { if (!locked && find.length) previewMatches() }} /></label>
    </div>
    {error && <Alert type="error" showIcon message={error} />}
    {pending && <Alert type="warning" showIcon message="上次操作結果尚未確認，請重試同一次操作。" />}
    {latest?.operation && <p className="pl-muted">上次批量替換：{describe(latest.operation.summary)}{!latest.can_undo && ' · 目前無法撤銷'}</p>}
    {finished && <Alert type="success" showIcon message={`${finished.kind === 'apply' ? '替換已保存' : '批量替換已撤銷'}：${describe(finished.summary)}`}
      description={<><p>受影響頁面已改為未完成，可點頁碼檢查排版。</p><Space wrap>{finished.pages.map(page => <Button size="small" key={page.id} onClick={() => { onReviewPage(page.id); onClose() }}>第 {project.pages.findIndex(p => p.id === page.id) + 1} 頁</Button>)}</Space></>} />}
    {preview && (preview.matches.length ? <>
      <div className="pl-replacement-summary"><Checkbox disabled={locked} checked={selectedKeys.length === preview.matches.length} indeterminate={!!selectedKeys.length && selectedKeys.length < preview.matches.length}
        onChange={e => setSelectedKeys(e.target.checked ? preview.matches.map(keyOf) : [])}>全選</Checkbox>
        <span>命中 {describe(preview.summary)}</span><Tag color="blue">將替換 {describe(selectedSummary)}</Tag>
      </div>
      <Table<ReplacementMatch> size="small" rowKey={keyOf} dataSource={preview.matches} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ y: 340 }}
        rowSelection={{ selectedRowKeys: selectedKeys, onChange: keys => setSelectedKeys(keys as string[]), getCheckboxProps: () => ({ disabled: locked }) }}
        columns={[
          { title: '頁碼', width: 115, render: (_, match) => <><strong>第 {match.page_number} 頁</strong><small className="pl-replacement-filename">{match.page_name}</small></> },
          { title: '替換前', render: (_, match) => <div className="pl-replacement-text">{match.before}</div> },
          { title: '替換後', render: (_, match) => <div className="pl-replacement-text">{match.after || <span className="pl-muted">（空文字）</span>}</div> },
          { title: '處數', dataIndex: 'occurrences', width: 60 },
        ]} />
    </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="沒有需要替換的文字" />)}
  </Modal>
}
