import { useEffect, useRef, useState } from 'react'
import { Alert, Button, InputNumber, Modal, Space } from 'antd'
import { RasterEditor, type RasterHandle, type RasterSave } from './RasterEditor'
import { clampLocalRect, offsetLocalRect, type LocalEditRect } from './local-edit-roi'
import './local-edit-window.css'

interface Props {
  open: boolean
  width: number; height: number
  initialRect: LocalEditRect
  initialCategory?: 'solid' | 'other'; initialColor?: string
  baseUrl: string; overlayUrl?: string; otherUrl?: string; editedUrl?: string; detectedTextUrl?: string
  onApply: (data: RasterSave, rect: LocalEditRect) => Promise<void>
  onCancel: () => void
}

/** Closing unmounts the whole draft, including its independent undo and save state. */
export function LocalEditWindow(props: Props) {
  return props.open ? <LocalEditSession {...props} /> : null
}

function LocalEditSession(props: Props) {
  const { width, height, initialRect, onApply, onCancel } = props
  const [rect, setRect] = useState(() => clampLocalRect(initialRect, width, height))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const applying = useRef(false)
  const editor = useRef<RasterHandle>(null)
  const draft = useRef<RasterSave | null>(null)

  useEffect(() => {
    // The child saves into this in-memory draft, not the project on the server.
    // Its own unsaved guard ends after flush, but the draft still needs applying.
    const warn = (event: BeforeUnloadEvent) => {
      if (draft.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  function changeRect(next: LocalEditRect) {
    if (!applying.current) setRect(clampLocalRect(next, width, height))
  }
  function cancel() { if (!applying.current) onCancel() }
  async function apply() {
    if (applying.current) return
    applying.current = true; setBusy(true); setError('')
    try {
      if (!editor.current || !await editor.current.flush()) throw new Error('局部修改尚未準備好，請稍後重試。')
      if (draft.current) { await onApply(draft.current, rect); draft.current = null }
      else onCancel()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '套用失敗，局部修改已保留，請重試。')
    } finally {
      applying.current = false; setBusy(false)
    }
  }

  return <Modal open title="局部視窗" className="local-edit-window"
    width="min(1440px, calc(100vw - 32px))" style={{ top: 24 }}
    modalRender={node => <div onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>{node}</div>}
    maskClosable={false} keyboard={false} closable={!busy} onCancel={cancel}
    footer={<Space><Button disabled={busy} onClick={cancel}>取消</Button>
      <Button type="primary" loading={busy} onClick={() => void apply()}>套用</Button></Space>}>
    <div className="local-edit-range">
      <strong>編輯範圍</strong>
      <Space wrap>
        {(['x', 'y', 'width', 'height'] as const).map((key, index) => <label key={key}>
          {['X', 'Y', '寬', '高'][index]}
          <InputNumber aria-label={`局部範圍${['X', 'Y', '寬', '高'][index]}`} precision={0}
            disabled={busy} value={rect[key]} min={index < 2 ? 0 : 1}
            max={key === 'x' ? width - 1 : key === 'y' ? height - 1 : key === 'width' ? width - rect.x : height - rect.y}
            onChange={value => { if (value !== null) changeRect({ ...rect, [key]: value }) }} />
        </label>)}
        <Button disabled={busy} onClick={() => changeRect(offsetLocalRect(rect, 32, width, height))}>外擴 32px</Button>
        <Button disabled={busy} onClick={() => changeRect(offsetLocalRect(rect, -32, width, height))}>內縮 32px</Button>
        <Button disabled={busy} onClick={() => changeRect(initialRect)}>重設範圍</Button>
      </Space>
    </div>
    <p className="local-edit-hint">只編輯藍框內的範圍。選擇「調整邊框」可拖動四邊；按「套用」才會回寫主頁，取消會放棄局部修改。</p>
    {error && <Alert type="error" showIcon message={error} />}
    <RasterEditor ref={editor} mode="edit" local disabled={busy} width={width} height={height}
      initialCategory={props.initialCategory} initialColor={props.initialColor}
      clipRect={rect} onClipRectChange={changeRect} baseUrl={props.baseUrl} overlayUrl={props.overlayUrl}
      otherUrl={props.otherUrl} editedUrl={props.editedUrl} detectedTextUrl={props.detectedTextUrl}
      onSave={async data => { draft.current = data }} />
  </Modal>
}
