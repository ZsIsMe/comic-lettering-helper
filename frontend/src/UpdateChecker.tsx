import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal, Space, Typography } from 'antd'
import { api } from './workbench-api'

type Update = { current_version: string; latest_version: string | null; update_available: boolean | null; release_url: string | null; error: string | null }
type Installation = { state: string; message: string; version?: string }
const activeInstall = (state: string) => ['queued', 'downloading', 'validating', 'installing', 'restarting', 'rolling_back'].includes(state)

export function UpdateChecker({ beforeInstall }: { beforeInstall: () => Promise<boolean> }) {
  const [version, setVersion] = useState('')
  const [result, setResult] = useState<Update | null>(null)
  const [installation, setInstallation] = useState<Installation>({ state: 'idle', message: '' })
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  const [disconnected, setDisconnected] = useState(false)
  const initiated = useRef(false)
  const installing = activeInstall(installation.state)
  useEffect(() => {
    let live = true, polling = false
    const refresh = async () => {
      if (polling) return
      polling = true
      try {
        const state = await api<Installation>('/api/app/update-status')
        const value = await api<{ current_version: string }>('/api/app/version')
        if (!live) return
        setVersion(value.current_version); setInstallation(state); setDisconnected(false)
        if (activeInstall(state.state)) setOpen(true)
        if (initiated.current && state.state === 'completed' && value.current_version === state.version) {
          initiated.current = false
          window.location.reload()
        }
      } catch { if (live) setDisconnected(true) }
      finally { polling = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1500)
    return () => { live = false; clearInterval(timer) }
  }, [])
  async function check() {
    setOpen(true); setBusy(true); setError(''); setResult(null)
    try { const value = await api<Update>('/api/app/updates'); setResult(value); setVersion(value.current_version) }
    catch { setError('無法連接更新服務，請稍後重試。') }
    finally { setBusy(false) }
  }
  async function install() {
    if (!result?.latest_version) return
    setBusy(true); setError('')
    try {
      if (!await beforeInstall()) throw new Error('編輯尚未保存或操作仍在進行，請完成後再升級。')
      const state = await api<Installation>('/api/app/install-update', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Comic-Update': '1' },
        body: JSON.stringify({ version: result.latest_version }),
      })
      initiated.current = true; setInstallation(state); setConfirm(false)
    } catch (e) { setError((e as Error).message); setConfirm(false) }
    finally { setBusy(false) }
  }
  return <>
    <div className="app-status-group">
      <Typography.Text type="secondary">{version ? `應用版本 ${version}` : '應用版本'}</Typography.Text>
      <Button size="small" loading={busy || installing} onClick={() => installing ? setOpen(true) : void check()}>{installing ? '更新中' : '檢查更新'}</Button>
    </div>
    <Modal title="應用更新" open={open} closable={!installing && !busy} maskClosable={!installing && !busy} keyboard={!installing && !busy}
      onCancel={() => setOpen(false)} footer={installing ? null : <Space>
        <Button disabled={busy} onClick={() => void check()}>重新檢查</Button>
        {result?.update_available && <Button type="primary" disabled={busy} onClick={() => setConfirm(true)}>立即升級</Button>}
        <Button disabled={busy} onClick={() => setOpen(false)}>關閉</Button>
      </Space>}>
      <p>目前版本：{version || '讀取中'}</p>
      {busy && <p>正在處理…</p>}
      {installing && <Alert type="info" showIcon message={disconnected ? '網頁服務正在重啟，等待重新連線…' : installation.message} />}
      {!installing && installation.state !== 'idle' && <Alert showIcon type={installation.state === 'completed' ? 'success' : 'warning'} message={installation.message} />}
      {(error || result?.error) && <Alert type="warning" showIcon message={error || result?.error} />}
      {result && !result.error && !installing && <>
        <Alert showIcon type={result.update_available ? 'info' : 'success'} message={result.update_available ? `有新版本 ${result.latest_version} 可升級` : '目前沒有較新的正式版本'} />
        {result.release_url && <p><a href={result.release_url} target="_blank" rel="noreferrer">查看正式版本 {result.latest_version}</a></p>}
      </>}
    </Modal>
    <Modal title={`升級至 ${result?.latest_version || ''}？`} open={confirm} okText="保存並升級" cancelText="取消" confirmLoading={busy}
      onCancel={() => { if (!busy) setConfirm(false) }} onOk={() => void install()}>
      <p>將先保存編輯，下載並校驗更新包。網頁會短暫中斷，完成後自動重新載入。</p>
      <p>漫畫資料、模型和執行環境保留；新版啟動失敗時自動回復舊版。請先結束其他分頁的操作。</p>
    </Modal>
  </>
}
