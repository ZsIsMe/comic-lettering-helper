import { layerUrl, type LayerOptions } from './api'
import { usePreview } from './preview-cache'
import type { Page } from './types'
import type { VisibleRegion } from './geometry'

// Two native decoded layers occupy about 64 MB at this boundary. Larger
// pages keep the bounded base/detail strategy, applied to each layer.
export const NATIVE_LAYER_PIXELS = 8_000_000
export const baseLayerOptions = (page: Pick<Page, 'width' | 'height'>, edge: number, visible = true): LayerOptions =>
  !visible || page.width * page.height > NATIVE_LAYER_PIXELS ? { edge } : {}

export function layerTiles(page: Pick<Page, 'width' | 'height'>, scale: number, region: VisibleRegion | null, detailed: boolean, pixelRatio: number) {
  const tiles: { x: number; y: number; width: number; height: number; options: LayerOptions }[] = []
  const ratio = Math.min(pixelRatio, 1.5)
  if (page.width * page.height <= NATIVE_LAYER_PIXELS || !detailed || !region || Math.max(page.width, page.height) * scale * ratio <= 3072) return tiles
  const size = Math.min(4096, Math.max(128, Math.round(768 / (scale * ratio) / 64) * 64))
  const right = Math.min(page.width, region.x + region.width), bottom = Math.min(page.height, region.y + region.height)
  for (let y = Math.max(0, Math.floor(region.y / size) * size); y < bottom; y += size) {
    for (let x = Math.max(0, Math.floor(region.x / size) * size); x < right; x += size) {
      const tx = Math.max(0, x - 2), ty = Math.max(0, y - 2)
      const width = Math.min(page.width - tx, size + 4), height = Math.min(page.height - ty, size + 4)
      tiles.push({ x: tx, y: ty, width, height, options: { edge: 768, region: { x: tx, y: ty, width, height } } })
    }
  }
  return tiles
}

export type LayerSources = { original: string; overlay?: string }

export function useLayeredPreview(project: string, page: Page, clean: boolean, options: LayerOptions, frozen = false, retry = 0, sources?: LayerSources) {
  const hasOverlay = clean && !!page.clean
  const suffix = retry ? `&retry=${retry}` : ''
  const sourceUrl = sources ? sources.original : layerUrl(project, page, 'original', options) + suffix
  const overlayUrl = hasOverlay ? sources ? sources.overlay || sourceUrl : layerUrl(project, page, 'overlay', options) + suffix : sourceUrl
  const localOptions = sources ? { width: page.width, height: page.height, ...options } : undefined
  const sourceKey = localOptions ? `local:${JSON.stringify([sourceUrl, localOptions, retry])}` : sourceUrl
  const overlayKey = localOptions ? `local:${JSON.stringify([overlayUrl, localOptions, retry])}` : overlayUrl
  const source = usePreview(sourceKey, frozen, localOptions ? { url: sourceUrl, ...localOptions } : undefined)
  const overlay = usePreview(overlayKey, frozen, localOptions ? { url: overlayUrl, ...localOptions } : undefined)
  const sourceReady = source.key === sourceKey && !!source.image
  const overlayReady = overlay.key === overlayKey && !!overlay.image
  const sizesMatch = source.image?.naturalWidth === overlay.image?.naturalWidth && source.image?.naturalHeight === overlay.image?.naturalHeight
  return { source, overlay, sourceUrl, overlayUrl, hasOverlay,
    key: `${sourceKey}|${overlayKey}`, ready: sourceReady && overlayReady && sizesMatch,
    error: source.error || (hasOverlay ? overlay.error : '') || (sourceReady && overlayReady && !sizesMatch ? '圖片圖層尺寸不一致。' : '') }
}
