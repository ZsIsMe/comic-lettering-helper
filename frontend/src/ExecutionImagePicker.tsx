import { useEffect, useRef, useState } from 'react'
import { Button, Empty, Input, Modal, Space, Tag } from 'antd'
import { CheckOutlined, SearchOutlined } from '@ant-design/icons'
import { executionPageIds, selectionFromPages, type ExecutionSelection } from './execution-selection'
import { repairRectangles, type RepairRegion } from './repair-scope'
import './execution-image-picker.css'

export interface ExecutionPage {
  id: string; filename: string; maskPreviewUrl?: string; maskReady: boolean
  sourceUrl?: string; overlayUrl?: string; maskUrl?: string
  scopeRect?: RepairRegion
}

function PagePreview({ page }: { page: ExecutionPage }) {
  const container = useRef<HTMLSpanElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (page.maskPreviewUrl || visible || !container.current) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '160px' })
    observer.observe(container.current)
    return () => observer.disconnect()
  }, [page.maskPreviewUrl, visible])
  useEffect(() => {
    if (!visible || page.maskPreviewUrl || !page.sourceUrl || !page.overlayUrl || !page.maskUrl) return
    let cancelled = false
    const load = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('圖片預覽載入失敗'))
      image.src = url
    })
    void Promise.all([load(page.sourceUrl), load(page.overlayUrl), load(page.maskUrl)]).then(([source, overlay, mask]) => {
      if (cancelled || !canvas.current) return
      const scale = Math.min(180 / source.naturalWidth, 240 / source.naturalHeight, 1)
      const width = Math.max(1, Math.round(source.naturalWidth * scale))
      const height = Math.max(1, Math.round(source.naturalHeight * scale))
      const element = canvas.current
      element.width = width; element.height = height
      const context = element.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('Canvas 不可用')
      context.drawImage(mask, 0, 0, width, height)
      const tint = context.getImageData(0, 0, width, height)
      for (let index = 0; index < tint.data.length; index += 4) {
        const strength = tint.data[index] // Current other-mask is an opaque grayscale PNG.
        tint.data[index] = 255; tint.data[index + 1] = 80; tint.data[index + 2] = 148
        tint.data[index + 3] = Math.round(strength * 0.55)
      }
      const tintCanvas = document.createElement('canvas')
      tintCanvas.width = width; tintCanvas.height = height
      tintCanvas.getContext('2d')?.putImageData(tint, 0, 0)
      context.clearRect(0, 0, width, height)
      context.drawImage(source, 0, 0, width, height)
      context.drawImage(overlay, 0, 0, width, height)
      if (page.scopeRect) {
        context.save()
        context.beginPath()
        for (const rect of repairRectangles(page.scopeRect, source.naturalWidth, source.naturalHeight)) context.rect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale)
        context.clip()
      }
      context.drawImage(tintCanvas, 0, 0)
      if (page.scopeRect) context.restore()
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [visible, page.sourceUrl, page.overlayUrl, page.maskUrl, page.maskPreviewUrl, page.scopeRect])
  if (page.maskPreviewUrl) return <img src={page.maskPreviewUrl} alt={`${page.filename} 原圖與粉紅 Mask`} loading="lazy" />
  return <span ref={container} className="execution-page-preview">{failed ? <span role="status">預覽載入失敗</span> : <canvas ref={canvas} role="img" aria-label={`${page.filename} 原圖與粉紅 Mask`} />}</span>
}

/** Mount when opened so cancel always discards the modal's draft. */
export function ExecutionImagePicker({ pages, value, onApply, onCancel }: {
  pages: ExecutionPage[]; value: ExecutionSelection
  onApply: (selection: ExecutionSelection) => void; onCancel: () => void
}) {
  const allIds = pages.map(page => page.id)
  const [selected, setSelected] = useState(() => executionPageIds(value, allIds))
  const [query, setQuery] = useState('')
  const visible = pages.filter(page => page.filename.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
  return <Modal open title="選擇執行圖片" width={1100} onCancel={onCancel} className="execution-picker"
    footer={<div className="execution-picker-footer"><span>已選 <strong>{selected.length}</strong> / {pages.length} 張</span><Space>
      <Button onClick={onCancel}>取消</Button><Button type="primary" disabled={!selected.length} onClick={() => onApply(selectionFromPages(selected, allIds))}>套用選擇</Button>
    </Space></div>}>
    <p className="execution-picker-help"><span className="execution-mask-swatch" />粉紅色為當前 Mask；此處僅選圖片，生成時使用項目最新的底圖與 Mask。</p>
    <div className="execution-picker-tools"><Space><Button onClick={() => setSelected(allIds)}>全選</Button><Button onClick={() => setSelected([])}>取消全選</Button></Space>
      <Input prefix={<SearchOutlined />} allowClear placeholder="搜尋檔名" aria-label="搜尋執行圖片" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="execution-picker-grid">
      {visible.map(page => <button key={page.id} type="button" role="checkbox" aria-checked={selected.includes(page.id)} aria-label={`執行 ${page.filename}`}
        className={`execution-page${selected.includes(page.id) ? ' selected' : ''}`}
        onClick={() => setSelected(ids => ids.includes(page.id) ? ids.filter(id => id !== page.id) : [...ids, page.id])}>
        <span className="execution-check">{selected.includes(page.id) && <CheckOutlined />}</span>
        <PagePreview page={page} />
        <span className="execution-page-caption"><strong>{page.filename}</strong>{!page.maskReady && <Tag color="orange">Mask 未備妥</Tag>}</span>
      </button>)}
    </div>
    {!visible.length && <Empty description="沒有符合的圖片" />}
  </Modal>
}
