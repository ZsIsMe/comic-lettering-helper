import { useEffect, useState } from 'react'
import { Alert, Button, Modal, Space, Typography } from 'antd'
import { api } from './workbench-api'

type Update = { current_version: string; latest_version: string | null; update_available: boolean | null; release_url: string | null; error: string | null }

export function UpdateChecker() {
  const [version, setVersion] = useState('')
  const [result, setResult] = useState<Update | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void api<{ current_version: string }>('/api/app/version').then(value => setVersion(value.current_version)).catch(() => {}) }, [])
  async function check() {
    setOpen(true); setBusy(true); setError(''); setResult(null)
    try { const value = await api<Update>('/api/app/updates'); setResult(value); setVersion(value.current_version) }
    catch { setError('無法連接更新服務，請稍後重試。') }
    finally { setBusy(false) }
  }
  return <>
    <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 24px', gap: 12, alignItems: 'center' }}>
      <Typography.Text type="secondary">{version ? `應用版本 ${version}` : '應用版本'}</Typography.Text>
      <Button size="small" loading={busy} onClick={() => void check()}>檢查更新</Button>
    </div>
    <Modal title="應用更新" open={open} onCancel={() => setOpen(false)} footer={<Space><Button loading={busy} onClick={() => void check()}>重新檢查</Button><Button onClick={() => setOpen(false)}>關閉</Button></Space>}>
      <p>目前版本：{version || '讀取中'}</p>
      {busy && <p>正在檢查可用版本…</p>}
      {(error || result?.error) && <Alert type="warning" showIcon message={error || result?.error} />}
      {result && !result.error && <>
        <Alert showIcon type={result.update_available ? 'info' : 'success'} message={result.update_available ? `有新版本 ${result.latest_version} 可升級` : '目前沒有較新的正式版本'} />
        {result.release_url && <p><a href={result.release_url} target="_blank" rel="noreferrer">查看正式版本 {result.latest_version}</a></p>}
        {result.update_available && <p>請由管理員在任務完成後升級應用。升級會保留項目與模型；此處檢查不會中斷工作。</p>}
      </>}
    </Modal>
  </>
}
