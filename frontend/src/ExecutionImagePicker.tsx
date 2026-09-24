import { useState } from 'react'
import { Button, Empty, Input, Modal, Space, Tag } from 'antd'
import { CheckOutlined, SearchOutlined } from '@ant-design/icons'
import { executionPageIds, selectionFromPages, type ExecutionSelection } from './execution-selection'
import './execution-image-picker.css'

export interface ExecutionPage {
  id: string; filename: string; maskPreviewUrl: string; maskReady: boolean
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
        <img src={page.maskPreviewUrl} alt={`${page.filename} 原圖與粉紅 Mask`} loading="lazy" />
        <span className="execution-page-caption"><strong>{page.filename}</strong>{!page.maskReady && <Tag color="orange">Mask 未備妥</Tag>}</span>
      </button>)}
    </div>
    {!visible.length && <Empty description="沒有符合的圖片" />}
  </Modal>
}
