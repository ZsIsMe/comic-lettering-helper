import { useEffect, useState } from 'react'
import { Modal } from 'antd'
import { previewUrl } from './api'
import { textStyle } from './layout-review'
import type { Item, PageData } from './types'
import './layout-review.css'

type View = 'before' | 'original' | 'edited' | 'detail'
type Props = {
  reviewId?: string; project: string; before: PageData; after: PageData; regions: number[][]; view: View
  includeOriginal: boolean; region?: number; clean?: boolean; onClose: () => void
}

function ReviewPanel({ project, page, region, scale, mode, cleanBackground }: { project: string; page: PageData; region: number[]; scale: number; mode: Exclude<View, 'detail'>; cleanBackground: boolean }) {
  const [x1, y1, x2, y2] = region
  const width = x2 - x1, height = y2 - y1
  const clean = mode !== 'original' && cleanBackground && !!page.clean
  const src = `${previewUrl(project, page, 3072, clean)}&x=${x1}&y=${y1}&w=${width}&h=${height}`
  const label = mode === 'before' ? '修改前' : mode === 'edited' ? '修改後' : '原圖'
  return <section className="pl-review-panel" aria-label={label}>
    <h3>{label}</h3>
    <div className="pl-review-crop" style={{ width: width * scale, height: height * scale }}>
      <div className="pl-review-scene pl-shell" style={{ width, height, transform: `scale(${scale})` }}>
        <img className="pl-review-image" src={src} width={width} height={height} alt={`${page.name} ${label}`} draggable={false} />
        {mode !== 'original' && page.items.map((item: Item) => <div key={item._id} className="pl-text pl-review-text" style={{ ...textStyle(item, page), left: item.x * page.width - x1, top: item.y * page.height - y1 }}>{item.text || '\u200b'}</div>)}
      </div>
    </div>
    <p>{x1}, {y1} → {x2}, {y2} · 原圖像素</p>
  </section>
}

export function LayoutReview({ reviewId, project, before, after, regions, view, includeOriginal, region = 0, clean = true, onClose }: Props) {
  const [selected, setSelected] = useState(region)
  useEffect(() => setSelected(region), [region, regions])
  const modes: Exclude<View, 'detail'>[] = view === 'detail' ? includeOriginal ? ['original', 'before', 'edited'] : ['before', 'edited'] : [view]
  const raw = regions[Math.max(0, Math.min(selected, regions.length - 1))]
  const box = raw && [Math.max(0, Math.floor(raw[0])), Math.max(0, Math.floor(raw[1])), Math.min(after.width, Math.ceil(raw[2])), Math.min(after.height, Math.ceil(raw[3]))]
  const valid = box && box.length === 4 && box.every(Number.isFinite) && box[2] > box[0] && box[3] > box[1]
  const width = valid ? box[2] - box[0] : 1, height = valid ? box[3] - box[1] : 1
  const availableWidth = typeof window === 'undefined' ? 1000 : Math.min(window.innerWidth * .92, 1400)
  const availableHeight = typeof window === 'undefined' ? 700 : window.innerHeight * .68
  const scale = Math.min(1.5, Math.max(.1, (availableWidth - modes.length * 32 - 48) / modes.length / width), Math.max(.1, availableHeight / height))
  return <Modal className={`pl-review-modal pl-review-${reviewId}`} open onCancel={onClose} footer={null} width="min(96vw, 1480px)" title="局部排版對比" destroyOnHidden>
    {regions.length > 1 && <div className="pl-review-nav">
      <button type="button" disabled={selected <= 0} onClick={() => setSelected(value => value - 1)}>上一區</button>
      <span>區域 {selected + 1}／{regions.length}</span>
      <button type="button" disabled={selected >= regions.length - 1} onClick={() => setSelected(value => value + 1)}>下一區</button>
    </div>}
    {valid ? <div className="pl-review-panels">{modes.map(mode => <ReviewPanel key={mode} project={project} page={mode === 'before' ? before : after} region={box} scale={scale} mode={mode} cleanBackground={clean} />)}</div> : <p>目前沒有可對比的修改區域。</p>}
  </Modal>
}
