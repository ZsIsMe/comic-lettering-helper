import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Dropdown, Empty, Input, Modal, Select, Space, Spin, Tag, Typography } from 'antd'
import { GuideCanvas, type GuideHandle } from './edgewhite/GuideCanvas'
import { api, collectionUrl, inputFiles } from './edgewhite/api'
import { readDroppedRoots, type DropEntry, type RootSelection } from './edgewhite/file-selection'
import type { Collection } from './edgewhite/model'
import './edgewhite/styles.css'

const { Title, Text } = Typography
export type LeaveGuard = (callback: () => Promise<boolean>) => () => void
export default function EdgeWhitePage({ id, registerGuard }: { id: string; registerGuard: LeaveGuard }) {
  const [modal, modalHolder] = Modal.useModal()
  const [collections, setCollections] = useState<Collection[]>([]), [current, setCurrent] = useState<Collection | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [gpuBusy, setGpuBusy] = useState(false), [createOpen, setCreateOpen] = useState(false)
  const [files, setFiles] = useState<File[]>([]), [name, setName] = useState('')
  const [selectionNote, setSelectionNote] = useState(''), [picking, setPicking] = useState(false), [pickError, setPickError] = useState('')
  const imageInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null)
  const reload = useCallback(async () => {
    if (id) setCurrent(await api<Collection>(collectionUrl(id)))
    else { setCurrent(null); setCollections(await api<Collection[]>('/api/edgewhite')) }
  }, [id])
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    void reload().catch(err => { if (live) setError(String(err)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [reload])
  useEffect(() => {
    let live = true
    const check = () => void api<{ gpu_owner: string | null; active_job_id: string | null }>('/api/health').then(h => { if (live) setGpuBusy(!!(h.gpu_owner || h.active_job_id)) }).catch(() => { if (live) setGpuBusy(true) })
    check(); const timer = setInterval(check, 3000)
    return () => { live = false; clearInterval(timer) }
  }, [])
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('')
    try { await action() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  function accept(selection: RootSelection) {
    setFiles(selection.files); setPickError('')
    setSelectionNote(selection.name ? `只匯入「${selection.name}」第一層；略過 ${selection.ignoredDirectories} 個子資料夾。` : '已選擇指定圖片。')
    if (!name && selection.name) setName(selection.name)
  }
  function choose(value: FileList | null, folder = false) {
    if (!value?.length) return
    try {
      const all = Array.from(value)
      const folderName = folder ? all[0].webkitRelativePath.split('/')[0] : ''
      const ignoredDirectories = new Set(all.filter(f => f.webkitRelativePath.split('/').length > 2).map(f => f.webkitRelativePath.split('/')[1])).size
      const selected = inputFiles(value)
      accept({ files: selected, name: folderName, ignoredDirectories })
      if (!selected.length) setPickError('資料夾第一層沒有 PNG／JPG／JPEG 圖片')
    } catch (err) { setFiles([]); setSelectionNote(''); setPickError(String(err)) }
  }
  function drop(event: React.DragEvent) {
    event.preventDefault()
    if (busy || picking || gpuBusy) return
    // Capture entries synchronously while the drop event's data store is accessible.
    const entries = Array.from(event.dataTransfer.items).filter(item => item.kind === 'file').map(item => typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() as DropEntry | null : null)
    if (entries.some(entry => !entry)) { setPickError('瀏覽器沒有提供目錄結構，請使用多選圖片；不會展開子資料夾。'); setFiles([]); return }
    setPicking(true); setPickError(''); setFiles([])
    void readDroppedRoots(entries as DropEntry[]).then(accept).catch(err => setPickError(String(err))).finally(() => setPicking(false))
  }
  const hasCurrent = id && current?.id === id && !loading
  return <main className="app-shell ew-shell">
    {modalHolder}
    <header className="ew-header"><div><Text className="eyebrow">COMIC WORKSPACE / EDGE WHITE</Text><Title level={2}>邊緣塗白</Title><Text>用參考線尋找空白分界，逐格清理圖片邊緣。</Text></div>
      <Space><Button onClick={() => { window.location.hash = id ? '/edgewhite' : '' }}>{id ? '← 項目列表' : '← 漫畫工作台'}</Button>{!id && <Button type="primary" disabled={gpuBusy || busy} onClick={() => setCreateOpen(true)}>新建項目</Button>}</Space>
    </header>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    {gpuBusy && <Alert type="info" message="GPU 處理中或狀態暫不可用：暫停新增上傳與整批下載，已載入圖片仍可編輯與保存。" />}
    {loading ? <div className="ew-loading"><Spin tip="載入項目"><div style={{ height: 80 }} /></Spin></div> : hasCurrent ? <CollectionEditor key={id} initial={current} gpuBusy={gpuBusy} registerGuard={registerGuard} /> : !id && (
      collections.length ? <div className="ew-collections">{collections.map(c => <Card key={c.id} title={c.name} extra={<Tag>{c.pages.length} 頁</Tag>}>
        <p>{new Date(c.updated_at).toLocaleString()} · {c.pages.filter(p => p.revision !== p.output_revision).length} 頁輸出待更新</p>
        <Space><Button type="primary" onClick={() => { window.location.hash = `/edgewhite/${c.id}` }}>繼續編輯</Button><Button danger disabled={busy} onClick={() => modal.confirm({ title: `刪除「${c.name}」？`, content: '刪除此項目的原圖、線位、草稿與輸出，無法復原。', okText: '刪除', cancelText: '保留', onOk: () => run(async () => { await api(`${collectionUrl(c.id)}?confirm=true`, { method: 'DELETE' }); await reload() }) })}>刪除</Button></Space>
      </Card>)}</div> : <Empty description="上傳一組漫畫圖片，開始校準邊界" />
    )}
    <Modal open={createOpen} title="新建邊緣塗白項目" onCancel={() => { if (!busy && !picking) setCreateOpen(false) }} okText="載入圖片" cancelText="取消" confirmLoading={busy} okButtonProps={{ disabled: !files.length || gpuBusy || picking }} onOk={() => void run(async () => {
      const body = new FormData(); body.append('name', name)
      for (const file of files) body.append('source_files', file, file.name)
      const created = await api<Collection>('/api/edgewhite', { method: 'POST', body })
      setCreateOpen(false); setFiles([]); setName(''); window.location.hash = `/edgewhite/${created.id}`
    })}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}><Input value={name} maxLength={80} placeholder="項目名稱" onChange={e => setName(e.target.value)} />
        <input ref={imageInput} hidden type="file" multiple accept=".png,.jpg,.jpeg" disabled={busy || picking || gpuBusy} onChange={e => { choose(e.target.files); e.target.value = '' }} />
        <input ref={folderInput} hidden type="file" multiple {...{ webkitdirectory: '' }} disabled={busy || picking || gpuBusy} onChange={e => { choose(e.target.files, true); e.target.value = '' }} />
        <div className="ew-folder-drop" onDragOver={event => event.preventDefault()} onDrop={drop}>
          <Dropdown trigger={['click']} disabled={busy || picking || gpuBusy} menu={{ items: [{ key: 'images', label: '選擇多張圖片' }, { key: 'folder', label: '選擇單個資料夾' }], onClick: ({ key }) => { if (key === 'folder') folderInput.current?.click(); else imageInput.current?.click() } }}>
          <button type="button" className="ew-import-main" disabled={busy || picking || gpuBusy}>
            <strong>{picking ? '正在整理圖片…' : '拖入圖片或資料夾，或點擊選取'}</strong>
            <span>支援一次多選 · PNG／JPG／JPEG</span>
          </button>
          </Dropdown>
        </div>
        {pickError && <Alert type="error" showIcon message={pickError} />}
        {selectionNote && <Text>{selectionNote}</Text>}
        <Text>已選 {files.length} 張 · PNG／JPG／JPEG</Text>
        <Text type="secondary">每次選擇整批取代。原圖保留，輸出為同尺寸 PNG；圖片含旋轉資訊時請先整理方向。</Text>
      </Space>
    </Modal>
  </main>
}

function CollectionEditor({ initial, gpuBusy, registerGuard }: { initial: Collection; gpuBusy: boolean; registerGuard: LeaveGuard }) {
  const [modal, modalHolder] = Modal.useModal()
  const [collection, setCollection] = useState(initial)
  const [index, setIndex] = useState(() => Math.max(0, initial.pages.findIndex(p => p.id === localStorage.getItem(`edgewhite-page-${initial.id}`))))
  const [epoch, setEpoch] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const editor = useRef<GuideHandle>(null), latest = useRef(collection); latest.current = collection
  const working = useRef(false), page = collection.pages[index]
  useEffect(() => registerGuard(async () => !working.current && (await editor.current?.flush() ?? true)), [registerGuard])
  async function action(callback: () => Promise<void>) {
    if (working.current) return
    working.current = true; setBusy(true); setError('')
    try { await callback() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { working.current = false; setBusy(false) }
  }
  async function navigate(next: number) {
    await action(async () => {
      if (next < 0 || next >= collection.pages.length || !await editor.current?.flush()) return
      const fresh = await api<Collection>(collectionUrl(collection.id))
      setCollection(fresh); setIndex(next); localStorage.setItem(`edgewhite-page-${collection.id}`, fresh.pages[next].id)
    })
  }
  async function download(path: string, filename: string) {
    if (!await editor.current?.flush()) return
    const response = await fetch(path)
    if (!response.ok) { const body = await response.json(); throw new Error(body.detail || '下載失敗') }
    const blob = await response.blob(), url = URL.createObjectURL(blob), a = document.createElement('a')
    a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 10000)
  }
  async function importGuides(file: File) {
    if (file.size > 16 * 1024 * 1024) { setError('線位 JSON 超過 16 MB'); return }
    const confirmed = await modal.confirm({ title: '匯入桌面線位？', content: '依完整檔名替換 JSON 中各頁的參考線與選區。舊線位檔沒有圖片雜湊，請確認來源相同；未列出的頁面保持不變。', okText: '匯入線位', cancelText: '取消' })
    if (!confirmed) return
    await action(async () => {
      if (!await editor.current?.flush()) throw new Error('請先完成草稿保存')
      const body = new FormData(); body.append('revision', String(latest.current.revision)); body.append('workspace_file', file, file.name)
      const c = await api<Collection>(`${collectionUrl(collection.id)}/guides`, { method: 'POST', body })
      latest.current = c; setCollection(c); setEpoch(n => n + 1)
    })
  }

  const pending = collection.pages.filter(p => p.revision !== p.output_revision)
  return <>
    {modalHolder}
    {error && <Alert message={error} type="error" showIcon closable onClose={() => setError('')} />}
    <div className="ew-pagebar"><Space wrap><strong>{collection.name}</strong><Button disabled={busy || index === 0} onClick={() => void navigate(index - 1)}>上一頁</Button>
      <Select aria-label="選擇圖片" value={page.id} style={{ minWidth: 210 }} disabled={busy} options={collection.pages.map((p, i) => ({ value: p.id, label: `${i + 1}. ${p.filename}${p.revision !== p.output_revision ? ' · 待保存圖片' : ''}` }))} onChange={id => void navigate(collection.pages.findIndex(p => p.id === id))} />
      <span>{index + 1} / {collection.pages.length}</span><Button disabled={busy || index === collection.pages.length - 1} onClick={() => void navigate(index + 1)}>下一頁</Button></Space>
      <Space wrap><Button loading={busy} type="primary" onClick={() => void action(async () => {
        if (!await editor.current?.flush(true)) return
        if (index < collection.pages.length - 1) { setIndex(index + 1); localStorage.setItem(`edgewhite-page-${collection.id}`, collection.pages[index + 1].id) }
      })}>保存並下一頁</Button>
        <Button disabled={busy || gpuBusy} onClick={() => void action(() => download(`${collectionUrl(collection.id)}/download`, `${collection.name}-邊緣塗白.zip`))}>下載整批結果</Button>
      </Space></div>
    <GuideCanvas key={`${page.id}:${epoch}`} cid={collection.id} page={page} ref={editor} onSaved={next => { latest.current = next; setCollection(next) }} onNext={() => void navigate(index + 1)} onPrevious={() => void navigate(index - 1)} />
    <div className="ew-jsonbar"><Space wrap><label className={`file-picker ${gpuBusy || busy ? 'disabled' : ''}`}>匯入線位 JSON<input disabled={gpuBusy || busy} type="file" accept=".json" onChange={e => { const file = e.target.files?.[0]; if (file) void importGuides(file); e.target.value = '' }} /></label>
      <Button disabled={busy} onClick={() => void action(() => download(`${collectionUrl(collection.id)}/guides`, 'edgewhite_guides.json'))}>導出線位 JSON</Button></Space>
      <span>{pending.length ? `${pending.length} 頁有已保存草稿、但輸出尚未更新。請逐頁確認後保存圖片。` : '未編輯的頁面也會包含在結果包中。'}</span>
    </div>
  </>
}
