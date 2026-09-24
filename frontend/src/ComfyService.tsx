import { useEffect, useState } from 'react'
import { Alert, Button, Modal, Space, Tag } from 'antd'
import { api } from './workbench-api'

type Status = { state: string; message: string }
type Health = { comfy_ready: boolean; gpu_name: string | null; gpu_owner: string | null; active_job_id: string | null }

export function ComfyService() {
  const [status, setStatus] = useState<Status>({ state: 'idle', message: '' })
  const [health, setHealth] = useState<Health | null>(null)
  const [open, setOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const restarting = sending || status.state === 'restarting'
  useEffect(() => {
    let live = true, polling = false
    const refresh = async () => {
      if (polling) return
      polling = true
      try {
        const [s, h] = await Promise.all([api<Status>('/api/app/comfy/status'), api<Health>('/api/health')])
        if (live) { setStatus(s); setHealth(h) }
      } catch { if (live) setHealth(null) }
      finally { polling = false }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => { live = false; window.clearInterval(timer) }
  }, [])
  const restart = async () => {
    setSending(true); setError('')
    try {
      setStatus(await api<Status>('/api/app/comfy/restart', { method: 'POST', headers: { 'X-Comic-Service': '1' } }))
      setOpen(false)
    } catch (e) { setError(e instanceof Error ? e.message : '無法重啟 ComfyUI') }
    finally { setSending(false) }
  }
  const busy = Boolean(health?.active_job_id || health?.gpu_owner)
  return <div className="app-status-group">
    <Space>
      <Tag color={health?.comfy_ready ? 'green' : 'orange'}>{restarting ? 'ComfyUI 重啟中' : health?.comfy_ready ? 'ComfyUI 可用' : 'ComfyUI 未就緒'}</Tag>
      <Button size="small" loading={restarting} disabled={!health?.gpu_name || busy} onClick={() => { setError(''); setOpen(true) }}>重啟 ComfyUI</Button>
      {!health?.gpu_name && <span>需要有卡開機</span>}
      {busy && !restarting && <span>請先停止任務再重啟</span>}
    </Space>
    {status.message && <Alert className="app-service-message" type={status.state === 'failed' ? 'error' : 'info'} message={<span title={status.message}>{status.message}</span>} />}
    <Modal title="重啟 ComfyUI" open={open} onCancel={() => setOpen(false)} onOk={() => void restart()} confirmLoading={sending} okText="重啟" cancelText="取消">
      <p>重新啟動圖片生成服務。網頁、已保存圖片和歷史會保留；失敗任務需要你重新提交。</p>
      {error && <Alert type="error" message={error} />}
    </Modal>
  </div>
}
