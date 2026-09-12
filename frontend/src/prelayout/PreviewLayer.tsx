import { memo, useEffect, useRef, useState } from 'react'
import { previewUrl } from './api'
import { usePreview } from './preview-cache'
import type { Page } from './types'
import type { VisibleRegion } from './geometry'

type Tile = { x: number; y: number; w: number; h: number; key: string }
function TileImage({ tile }: { tile: Tile }) {
  const image = usePreview(tile.key)
  return image.url ? <img className="pl-detail-tile" data-tile src={image.url} draggable={false} alt="" style={{ left: tile.x, top: tile.y, width: tile.w, height: tile.h }} /> : null
}
export const PreviewLayer = memo(function PreviewLayer({ project, page, edge, scale, clean, region, detailed, interacting }: {
  project: string; page: Page; edge: number; scale: number; clean: boolean; region: VisibleRegion | null; detailed: boolean; interacting: boolean;
}) {
  const [retry, setRetry] = useState(0)
  // Lock the current requests through a gesture. Decoding quality never controls text geometry.
  const snapshot = useRef({ key: '', tiles: [] as Tile[] })
  if (!interacting || !snapshot.current.key) {
    const ratio = Math.min(devicePixelRatio, 1.5)
    const tiles: Tile[] = []
    if (detailed && region && Math.max(page.width, page.height) * scale * ratio > 3072) {
      // Each tile decodes at most 768² pixels. Request only visible original-space rectangles.
      const size = Math.min(4096, Math.max(128, Math.round(768 / (scale * ratio) / 64) * 64))
      const right = Math.min(page.width, region.x + region.width), bottom = Math.min(page.height, region.y + region.height)
      for (let y = Math.max(0, Math.floor(region.y / size) * size); y < bottom; y += size) {
        for (let x = Math.max(0, Math.floor(region.x / size) * size); x < right; x += size) {
          const tx = Math.max(0, x - 2), ty = Math.max(0, y - 2)
          const w = Math.min(page.width - tx, size + 4), h = Math.min(page.height - ty, size + 4)
          tiles.push({ x: tx, y: ty, w, h, key: `${previewUrl(project, page, 768, clean)}&x=${tx}&y=${ty}&w=${w}&h=${h}&retry=${retry}` })
        }
      }
    }
    snapshot.current = { key: `${previewUrl(project, page, edge, clean)}&retry=${retry}`, tiles }
  }
  const image = usePreview(snapshot.current.key, interacting)
  const [started, setStarted] = useState(false)
  useEffect(() => { const timer = setTimeout(() => setStarted(true), 1000); return () => clearTimeout(timer) }, [])
  return <>
    {image.url && <img className="pl-background" src={image.url} draggable={false} alt={page.name} width={page.width} height={page.height} />}
    {snapshot.current.tiles.map(tile => <TileImage key={tile.key} tile={tile} />)}
    {(!image.url && (started || image.error)) && <div className="pl-image-error" style={{ transform: `scale(${1 / scale})`, transformOrigin: 'top left' }}>
      {image.error || '底圖載入中…'} {image.error && <button onClick={event => { event.stopPropagation(); setRetry(value => value + 1) }}>重試圖片</button>}
    </div>}
  </>
})
