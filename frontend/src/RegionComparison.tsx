import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Button, Empty, Modal, Select } from 'antd'
import { comparisonRegions, type CompareRegion } from './comparison-regions'

interface Candidate { code: number; label: string; image: ImageData; diff: ImageData }
interface Props {
  layout: 'context' | 'cards'; base: ImageData; preview: ImageData | null
  candidates: Candidate[]; assignment: Uint16Array
  disabled: boolean; onAdopt: (region: CompareRegion, code: number) => void
}
function surface(image: ImageData) { const c = document.createElement('canvas'); c.width = image.width; c.height = image.height; c.getContext('2d')!.putImageData(image, 0, 0); return c }
function padding(r: CompareRegion, width: number, height: number): CompareRegion { const x = Math.max(0, r.x - 40), y = Math.max(0, r.y - 40); return { x, y, width: Math.min(width, r.x + r.width + 40) - x, height: Math.min(height, r.y + r.height + 40) - y } }
type FloatingPosition = { x: number; y: number }
function clampFloating(position: FloatingPosition, width = 280, height = 390): FloatingPosition {
  return { x: Math.max(8, Math.min(position.x, window.innerWidth - width - 8)), y: Math.max(8, Math.min(position.y, window.innerHeight - height - 8)) }
}
function initialFloating(): FloatingPosition {
  try {
    const saved = JSON.parse(localStorage.getItem('comic-comparison-floating-position') || 'null')
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return clampFloating(saved)
  } catch { /* Use the initial corner if storage is unavailable. */ }
  return clampFloating({ x: window.innerWidth - 304, y: 120 })
}
function ImageView({ image, crop, regions = [], selected = 0, onRegion, style }: { image: HTMLCanvasElement; crop?: CompareRegion; regions?: CompareRegion[]; selected?: number; onRegion?: (index: number) => void; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const paint = () => {
      const box = canvas.getBoundingClientRect(), ratio = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(box.width * ratio)); canvas.height = Math.max(1, Math.round(box.height * ratio))
      const r = crop || { x: 0, y: 0, width: image.width, height: image.height }, scale = Math.min(canvas.width / r.width, canvas.height / r.height)
      const ox = (canvas.width - r.width * scale) / 2, oy = (canvas.height - r.height * scale) / 2, ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#d7d2c8'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, r.x, r.y, r.width, r.height, ox, oy, r.width * scale, r.height * scale)
      if (!crop) regions.forEach((region, index) => { ctx.strokeStyle = index === selected ? '#df612b' : '#64877c'; ctx.lineWidth = (index === selected ? 3 : 1) * ratio; ctx.strokeRect(ox + region.x * scale, oy + region.y * scale, region.width * scale, region.height * scale) })
    }
    const observer = new ResizeObserver(paint); observer.observe(canvas); paint(); return () => observer.disconnect()
  }, [image, crop, regions, selected])
  return <canvas ref={ref} style={style} aria-label={crop ? '局部候選' : '合成結果'} onClick={event => {
    if (!onRegion || crop) return
    const box = event.currentTarget.getBoundingClientRect(), scale = Math.min(box.width / image.width, box.height / image.height)
    const x = (event.clientX - box.left - (box.width - image.width * scale) / 2) / scale, y = (event.clientY - box.top - (box.height - image.height * scale) / 2) / scale
    const i = regions.findIndex(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
    if (i >= 0) onRegion(i)
  }} />
}
export function RegionComparison({layout, base, preview, candidates, assignment, disabled, onAdopt}: Props) {
  const [index, setIndex] = useState(0), [expanded, setExpanded] = useState(false)
  const [overviewFit, setOverviewFit] = useState<'width' | 'page'>('width'), [overviewZoom, setOverviewZoom] = useState(1)
  const [floatingPosition, setFloatingPosition] = useState(initialFloating)
  const [floatingCollapsed, setFloatingCollapsed] = useState(false)
  const resultRef = useRef<HTMLDivElement>(null)
  const floatingDrag = useRef<FloatingPosition | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const overviewRef = useRef<HTMLDivElement>(null)
  const pan = useRef<{x:number;y:number} | null>(null)
  // Freeze grouping for the mounted page: adopting a source must not move cards.
  const [regions] = useState(() => comparisonRegions(base.width, base.height, candidates.map(c => c.diff.data), assignment))
  useEffect(() => {
    const view = overviewRef.current, region = regions[index]
    if (!view || !region || overviewFit !== 'width' || layout !== 'context') return
    const frame = requestAnimationFrame(() => { view.scrollTop = Math.max(0, (region.y + region.height / 2) * view.clientWidth * overviewZoom / base.width - view.clientHeight / 2) })
    return () => cancelAnimationFrame(frame)
  }, [index, overviewFit, overviewZoom, layout, regions, base.width])
  useEffect(() => {
    if (layout !== 'context') return
    const keydown = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target instanceof Element ? event.target : null
      if (disabled || expanded || !regions.length || !rootRef.current?.getClientRects().length || target?.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="dialog"], [role="slider"], [role="menu"], [role="listbox"]') || document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) return
      event.preventDefault()
      if (!event.repeat) setIndex(i => Math.max(0, Math.min(regions.length - 1, i + (event.key === 'ArrowRight' ? 1 : -1))))
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [layout, disabled, expanded, regions.length])
  useEffect(() => {
    if (layout !== 'cards') return
    const keepVisible = () => {
      const box = resultRef.current?.getBoundingClientRect()
      if (box?.width) setFloatingPosition(p => clampFloating(p, box.width, box.height))
    }
    const observer = new ResizeObserver(keepVisible)
    if (resultRef.current) observer.observe(resultRef.current)
    window.addEventListener('resize', keepVisible)
    return () => { observer.disconnect(); window.removeEventListener('resize', keepVisible) }
  }, [layout])
  useEffect(() => {
    try { localStorage.setItem('comic-comparison-floating-position', JSON.stringify(floatingPosition)) } catch { /* Optional preference. */ }
  }, [floatingPosition])
  function moveFloating(x: number, y: number) {
    const box = resultRef.current?.getBoundingClientRect()
    if (box) setFloatingPosition(clampFloating({ x, y }, box.width, box.height))
  }
  const sources = useMemo(() => [{code:1,label:'底圖',image:surface(base)}, ...candidates.map(c => ({code:c.code,label:c.label.startsWith('Flux')?'Flux':c.label.startsWith('FireRed')?'FireRed':c.label.startsWith('Qwen')?'Qwen':c.label,image:surface(c.image)}))], [base, candidates])
  const result = useMemo(() => {
    if (preview) return surface(preview)
    const image = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height)
    const byCode = new Map(candidates.map(c => [c.code,c.image.data]))
    for(let n=0;n<assignment.length;n++){const source=byCode.get(assignment[n]);if(source)for(let c=0;c<3;c++)image.data[n*4+c]=source[n*4+c]}
    return surface(image)
  }, [base, preview, candidates, assignment])
  function choice(region: CompareRegion) {
    const codes = new Set<number>()
    for(let y=region.y;y<region.y+region.height;y++)for(let x=region.x;x<region.x+region.width;x++){const n=y*base.width+x;if(assignment[n]>1 || candidates.some(c=>c.diff.data[n*4]>=128))codes.add(assignment[n]>1?assignment[n]:1)}
    return codes.size === 1 ? [...codes][0] : 0
  }
  function canAdopt(region: CompareRegion, code: number) {
    if(code===1)return true
    const mask=candidates.find(c=>c.code===code)?.diff.data
    if(!mask)return false
    for(let y=region.y;y<region.y+region.height;y++)for(let x=region.x;x<region.x+region.width;x++)if(mask[(y*base.width+x)*4]>=128)return true
    return false
  }
  function selectedSource(region: CompareRegion, code: number, chosen: number) {
    if (code === 1) return chosen === 1
    const mask = candidates.find(c => c.code === code)?.diff.data
    if (!mask) return false
    let count = 0
    for (let y=region.y;y<region.y+region.height;y++) for(let x=region.x;x<region.x+region.width;x++) { const n=y*base.width+x; if(mask[n*4]>=128) { if(assignment[n]!==code)return false; count++ } }
    return count > 0
  }
  function row(region: CompareRegion, i: number) {
    const chosen=choice(region)
    return <section className="region-row" key={i}>
      {<div className="region-row-title">區域 {i+1}<span>{chosen ? `目前採用：${sources.find(s=>s.code===chosen)?.label}` : '混合來源'} <Button size="small" onClick={()=>{setIndex(i);setExpanded(true)}}>查看位置</Button></span></div>}
      <div className="region-candidates" style={{gridTemplateColumns:`repeat(${sources.length}, minmax(0,1fr))`}}>{sources.map(source=>{ const selected=selectedSource(region,source.code,chosen); return <button key={source.code} className={`region-candidate${selected?' chosen':''}`} aria-pressed={selected} aria-label={`區域 ${i+1} 採用 ${source.label}`} disabled={disabled || !canAdopt(region,source.code)} onClick={()=>onAdopt(region,source.code)}>
        <span>{source.label}<small>{selected?'✓ 已採用':'點選採用'}</small></span><ImageView image={source.image} crop={padding(region,base.width,base.height)} />
      </button>})}</div>
    </section>
  }
  return <div ref={rootRef} className={`region-comparison ${layout}`}>
    <div ref={resultRef} className={`region-result${layout==='cards'?' floating-result':''}${floatingCollapsed && layout==='cards'?' collapsed':''}`} style={layout==='cards'?{left:floatingPosition.x,top:floatingPosition.y}:undefined} aria-label="合成結果預覽">
      <div className="region-result-heading" tabIndex={layout==='cards'?0:undefined} aria-label={layout==='cards'?'拖動合成結果視窗':undefined}
        onPointerDown={event=>{
          if (layout!=='cards' || event.button!==0 || (event.target as Element).closest('button')) return
          const box=resultRef.current!.getBoundingClientRect()
          floatingDrag.current={x:event.clientX-box.left,y:event.clientY-box.top}
          event.preventDefault();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event=>{if(floatingDrag.current)moveFloating(event.clientX-floatingDrag.current.x,event.clientY-floatingDrag.current.y)}}
        onPointerUp={()=>{floatingDrag.current=null}} onPointerCancel={()=>{floatingDrag.current=null}} onLostPointerCapture={()=>{floatingDrag.current=null}}
        onKeyDown={event=>{
          if(layout!=='cards' || event.target!==event.currentTarget || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return
          event.preventDefault();event.stopPropagation()
          moveFloating(floatingPosition.x+(event.key==='ArrowRight'?20:event.key==='ArrowLeft'?-20:0),floatingPosition.y+(event.key==='ArrowDown'?20:event.key==='ArrowUp'?-20:0))
        }}><strong>合成結果</strong><span className="result-status">{preview?'與輸出一致':'更新中…'}</span>{layout==='cards' ? <><span className="floating-drag-hint">拖動標題移動</span><Button size="small" onClick={()=>setExpanded(true)}>放大</Button><Button size="small" aria-label={floatingCollapsed?'展開合成結果':'收起合成結果'} onClick={()=>setFloatingCollapsed(v=>!v)}>{floatingCollapsed?'展開':'收起'}</Button></> : <><Button size="small" className="overview-fit-button" aria-pressed={overviewFit==='width'} type={overviewFit==='width'?'primary':'default'} onClick={()=>{setOverviewFit('width');setOverviewZoom(1)}}>適合寬度</Button><Button size="small" className="overview-fit-button" aria-pressed={overviewFit==='page'} type={overviewFit==='page'?'primary':'default'} onClick={()=>setOverviewFit('page')}>整頁</Button><Button size="small" aria-label="縮小整體圖" disabled={overviewZoom<=.5} onClick={()=>{setOverviewFit('width');setOverviewZoom(z=>Math.max(.5,z/1.25))}}>−</Button><Button size="small" aria-label="放大整體圖" disabled={overviewZoom>=3} onClick={()=>{setOverviewFit('width');setOverviewZoom(z=>Math.min(3,z*1.25))}}>＋</Button><span>滾輪上下移動 · Cmd／Ctrl＋拖動平移</span></>}</div>
      {layout==='context' ? <div className={`region-overview-scroll ${overviewFit}`} ref={overviewRef}
        onPointerDown={e=>{if(e.button===1 || e.button===0&&(e.metaKey||e.ctrlKey)){e.preventDefault();pan.current={x:e.clientX,y:e.clientY};e.currentTarget.setPointerCapture(e.pointerId)}}}
        onPointerMove={e=>{if(pan.current){e.currentTarget.scrollLeft-=e.clientX-pan.current.x;e.currentTarget.scrollTop-=e.clientY-pan.current.y;pan.current={x:e.clientX,y:e.clientY}}}}
        onPointerUp={()=>{pan.current=null}} onPointerCancel={()=>{pan.current=null}}>
        <ImageView image={result} regions={regions} selected={index} onRegion={setIndex} style={overviewFit==='width'?{width:`${overviewZoom*100}%`,height:'auto',aspectRatio:`${base.width}/${base.height}`,flexShrink:0}:{width:'100%',height:'100%'}}/>
      </div> : <ImageView image={result} regions={regions} selected={index} onRegion={setIndex}/>}</div>
    {!regions.length ? <Empty description="此頁沒有需要比較的修補區域，沿用目前成品" /> : layout==='context' ? <div className="region-dock"><div className="region-navigation"><Button size="large" aria-keyshortcuts="ArrowLeft" disabled={disabled || index===0} onClick={()=>setIndex(i=>i-1)}>← 上一區域</Button><Select aria-label="選擇修補區域" value={index} onChange={setIndex} options={regions.map((_,i)=>({value:i,label:`區域 ${i+1} / ${regions.length}`}))}/><Button size="large" type="primary" aria-keyshortcuts="ArrowRight" disabled={disabled || index===regions.length-1} onClick={()=>setIndex(i=>i+1)}>下一區域 →</Button><span className="region-help">← / → 切換區域 · PageUp / PageDown 換頁</span></div>{row(regions[index],index)}</div> : <div className="region-card-list">{regions.map(row)}</div>}
    <Modal open={expanded} title="整頁合成結果" footer={null} width="80vw" onCancel={()=>setExpanded(false)} destroyOnHidden><div className="region-modal-image"><ImageView image={result} regions={regions} selected={index} onRegion={setIndex}/></div></Modal>
  </div>
}
