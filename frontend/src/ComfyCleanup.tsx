import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Checkbox, Image, Modal, Space, Table, Tag } from 'antd'
import { api, json } from './workbench-api'
import { cleanupPreviewUrl, cleanupQuery, formatStorage, type CleanupItem, type CleanupRoot } from './comfy-cleanup-core'

type RootSummary = {
  files: number; bytes: number
  web_safe: number; web_safe_bytes: number
  web_protected: number; web_protected_bytes: number
  unknown: number; unknown_bytes: number
}
type Inventory = { busy: boolean; summary: Record<CleanupRoot, RootSummary>; items: CleanupItem[] }
type PendingDelete = { scope: 'safe' | 'selected'; items: CleanupItem[]; files: number; bytes: number }
const rootLabel: Record<CleanupRoot, string> = { input: '輸入', output: '輸出', temp: '暫存' }

function CleanupPreview({ item }: { item: CleanupItem }) {
  const [source, setSource] = useState('')
  useEffect(() => {
    let live = true, objectUrl = ''
    void fetch(cleanupPreviewUrl(item), { headers: { 'X-Comic-Cleanup': '1' } })
      .then(response => { if (!response.ok) throw new Error('preview'); return response.blob() })
      .then(blob => { if (live) { objectUrl = URL.createObjectURL(blob); setSource(objectUrl) } })
      .catch(() => { if (live) setSource('') })
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [item])
  return source ? <Image width={58} height={58} style={{ objectFit: 'contain' }} src={source} /> : <span>無預覽</span>
}

export function ComfyCleanup() {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [after, setAfter] = useState('')
  const [before, setBefore] = useState('')
  const [error, setError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const key = (item: CleanupItem) => `${item.root}:${item.path}`
  const unknown = useMemo(() => inventory?.items.filter(item => item.category === 'unknown') || [], [inventory])
  const safe = inventory?.items.filter(item => item.category === 'web_safe') || []

  const scan = async (nextAfter = after, nextBefore = before) => {
    setLoading(true); setError('')
    try {
      const value = await api<Inventory>(cleanupQuery(nextAfter, nextBefore), { headers: { 'X-Comic-Cleanup': '1' } })
      setInventory(value); setSelected([])
    } catch (e) { setError(e instanceof Error ? e.message : '無法掃描 ComfyUI 圖片') }
    finally { setLoading(false) }
  }
  const remove = async (request: PendingDelete) => {
    setLoading(true); setError('')
    try {
      await api('/api/comfy-cleanup/delete', {
        ...json('POST', { confirm: true, scope: request.scope, items: request.items }),
        headers: { 'Content-Type': 'application/json', 'X-Comic-Cleanup': '1' },
      })
      setPendingDelete(null)
      await scan()
    } catch (e) { setError(e instanceof Error ? e.message : '清理失敗') }
    finally { setLoading(false) }
  }
  const total = inventory ? Object.values(inventory.summary).reduce((sum, item) => sum + item.bytes, 0) : 0
  const category = (name: 'web_safe' | 'web_protected' | 'unknown') => inventory ? Object.values(inventory.summary).reduce((value, item) => ({ files: value.files + item[name], bytes: value.bytes + item[`${name}_bytes`] }), { files: 0, bytes: 0 }) : { files: 0, bytes: 0 }
  const safeSummary = category('web_safe'), protectedSummary = category('web_protected'), unknownSummary = category('unknown')
  const safeBytes = safe.reduce((sum, item) => sum + item.bytes, 0)
  return <div style={{ padding: '0 16px 4px', textAlign: 'right' }}>
    <Button size="small" onClick={() => { setOpen(true); void scan() }}>清理 ComfyUI 圖片</Button>
    <Modal title="ComfyUI 圖片清理" width={960} open={open} footer={null} onCancel={() => { if (!loading) { setOpen(false); setPendingDelete(null) } }} closable={!loading} maskClosable={!loading} keyboard={!loading}>
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
      {inventory?.busy && <Alert type="warning" showIcon message="GPU 或修復佇列運行中，目前只能查看，不能刪除。" style={{ marginBottom: 12 }} />}
      <Space wrap style={{ marginBottom: 12 }}>
        {inventory && (Object.keys(inventory.summary) as CleanupRoot[]).map(root => <Tag key={root}>{rootLabel[root]}：{inventory.summary[root].files} 張 · {formatStorage(inventory.summary[root].bytes)}</Tag>)}
        {inventory && <Tag color="blue">合計 {formatStorage(total)}</Tag>}
      </Space>
      {inventory && <Space wrap style={{ marginBottom: 12 }}>
        <Tag color="green">可清理網頁副本：{safeSummary.files} 張 · {formatStorage(safeSummary.bytes)}</Tag>
        <Tag color="orange">受保護網頁副本：{protectedSummary.files} 張 · {formatStorage(protectedSummary.bytes)}</Tag>
        <Tag>手動／未知：{unknownSummary.files} 張 · {formatStorage(unknownSummary.bytes)}</Tag>
      </Space>}
      <Alert type="info" showIcon message={`可安全清理 ${safe.length} 張網頁任務副本；只包含已完成且成品已保存的任務。未完成或無法確認歸屬的圖片不會自動刪除。`} />
      <Space wrap style={{ margin: '12px 0' }}>
        <Button danger disabled={loading || !safe.length || !!inventory?.busy} loading={loading} onClick={() => setPendingDelete({ scope: 'safe', items: [...safe], files: safe.length, bytes: safeBytes })}>清理已保存的網頁副本</Button>
        <span>未知圖片日期：</span>
        <input aria-label="未知圖片起始日期" disabled={loading} type="date" value={after} onChange={event => setAfter(event.target.value)} />
        <span>至</span>
        <input aria-label="未知圖片結束日期" disabled={loading} type="date" value={before} onChange={event => setBefore(event.target.value)} />
        <Button loading={loading} onClick={() => void scan()}>重新掃描</Button>
      </Space>
      <Table<CleanupItem> size="small" loading={loading} rowKey={key} dataSource={unknown} pagination={{ pageSize: 10 }} columns={[
        { title: '', width: 42, render: (_, item) => <Checkbox disabled={loading} checked={selected.includes(key(item))} onChange={event => setSelected(current => event.target.checked ? [...current, key(item)] : current.filter(value => value !== key(item)))} /> },
        { title: '預覽', width: 84, render: (_, item) => <CleanupPreview item={item} /> },
        { title: '位置', width: 70, render: (_, item) => rootLabel[item.root] },
        { title: '檔案', dataIndex: 'path', ellipsis: true },
        { title: '大小', width: 90, render: (_, item) => formatStorage(item.bytes) },
        { title: '修改時間', width: 180, render: (_, item) => new Date(item.modified_at).toLocaleString() },
      ]} />
      <Space style={{ marginTop: 12 }}>
        <Button danger disabled={loading || !selected.length || !!inventory?.busy} onClick={() => {
          const items = unknown.filter(item => selected.includes(key(item)))
          setPendingDelete({ scope: 'selected', items, files: items.length, bytes: items.reduce((sum, item) => sum + item.bytes, 0) })
        }}>刪除選取的未知圖片</Button>
        <span>選擇後，後端會再次核對檔案是否曾被替換或修改。</span>
      </Space>
    </Modal>
    <Modal
      title={pendingDelete?.scope === 'safe' ? '刪除安全清理清單？' : '刪除選取的未知圖片？'}
      open={!!pendingDelete}
      confirmLoading={loading}
      okText={pendingDelete?.scope === 'safe' ? '確認刪除' : `刪除 ${pendingDelete?.files || 0} 張`}
      cancelText="取消"
      okButtonProps={{ danger: true }}
      cancelButtonProps={{ disabled: loading }}
      closable={!loading}
      maskClosable={!loading}
      keyboard={!loading}
      onCancel={() => { if (!loading) setPendingDelete(null) }}
      onOk={() => { if (pendingDelete) void remove(pendingDelete) }}
    >
      {pendingDelete?.scope === 'safe'
        ? <p>將刪除 {pendingDelete.files} 張已保存的網頁任務副本，可釋放 {formatStorage(pendingDelete.bytes)}。掃描後新增的圖片不會包含在這次清理。</p>
        : <p>這些圖片無法確認是否由網頁任務建立。將刪除 {pendingDelete?.files || 0} 張，可釋放 {formatStorage(pendingDelete?.bytes || 0)}；刪除後無法從工作台復原。</p>}
    </Modal>
  </div>
}
