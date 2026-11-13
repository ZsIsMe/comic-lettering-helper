import { useEffect, useState, type CSSProperties } from 'react'
import type { LayerOptions } from './api'
import { useLayeredPreview } from './layered-preview'
import type { Page } from './types'

export function LayeredImage({ project, page, clean, options = {}, interacting = false, className = 'pl-background', style,
  errorScale = 1, tile = false }: { project: string; page: Page; clean: boolean; options?: LayerOptions; interacting?: boolean;
  className?: string; style?: CSSProperties; errorScale?: number; tile?: boolean }) {
  const [retry, setRetry] = useState(0)
  const layers = useLayeredPreview(project, page, clean, options, interacting, retry)
  const [started, setStarted] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setStarted(true), 1000); return () => clearTimeout(timer) }, [])
  return <>
    {!layers.ready && <span data-layer-pending hidden />}
    {layers.ready && <>
      <img className={className} data-layer="original" data-tile={tile || undefined} data-preview-ready="true" data-background-kind={layers.hasOverlay ? 'clean' : 'original'} src={layers.source.url} draggable={false} alt={page.name} width={page.width} height={page.height} style={style} />
      {layers.hasOverlay && <img className={`${className} pl-repair-layer`} data-layer="overlay" data-tile={tile || undefined} data-preview-ready="true" src={layers.overlay.url} draggable={false} alt="" width={page.width} height={page.height} style={style} />}
    </>}
    {(!layers.ready && (started || layers.error)) && <div className="pl-image-error" data-preview-ready="false" style={{ transform: `scale(${errorScale})`, transformOrigin: 'top left' }}>
      {layers.error || '圖片載入中…'} {layers.error && <button onClick={event => { event.stopPropagation(); setRetry(value => value + 1) }}>重試圖片</button>}
    </div>}
  </>
}
