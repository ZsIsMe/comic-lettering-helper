import { memo, useEffect, useRef, useState } from 'react'
import { baseLayerOptions, useLayeredPreview } from './layered-preview'
import { paintDifferencePixels } from './difference-mask'
import type { Page } from './types'

function drawMask(target: HTMLCanvasElement, mask: HTMLCanvasElement, color: string) {
  const output = target.getContext('2d')
  if (!output) return
  target.width = mask.width; target.height = mask.height
  output.drawImage(mask, 0, 0)
  output.globalCompositeOperation = 'source-in'
  output.fillStyle = color
  output.fillRect(0, 0, mask.width, mask.height)
  output.globalCompositeOperation = 'source-over'
}

export const DifferenceOverlay = memo(function DifferenceOverlay({ project, page, edge, interacting, color, opacity }: {
  project: string; page: Page; edge: number; interacting: boolean; color: string; opacity: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const completedMask = useRef<HTMLCanvasElement | null>(null)
  const completedMaskKey = useRef('')
  const [painted, setPainted] = useState({ key: '', color: '' })
  const latestColor = useRef(color); latestColor.current = color
  const layers = useLayeredPreview(project, page, true, baseLayerOptions(page, edge), interacting)
  const { source, overlay, key } = layers

  useEffect(() => {
    if (canvas.current && completedMask.current && completedMaskKey.current === key) {
      drawMask(canvas.current, completedMask.current, color)
      setPainted({ key, color })
    }
  }, [color, key])

  useEffect(() => {
    const target = canvas.current
    const before = source.image, patch = overlay.image
    if (!target || !before || !patch || !layers.ready) return
    let cancelled = false
    let frame = 0
    const ratio = Math.min(1, edge / Math.max(before.naturalWidth, before.naturalHeight))
    const width = Math.max(1, Math.round(before.naturalWidth * ratio)), height = Math.max(1, Math.round(before.naturalHeight * ratio)), rows = Math.min(128, height)
    const sourceCanvas = document.createElement('canvas'), cleanCanvas = document.createElement('canvas')
    sourceCanvas.width = cleanCanvas.width = width; sourceCanvas.height = cleanCanvas.height = height
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
    const cleanContext = cleanCanvas.getContext('2d', { willReadFrequently: true })
    if (!sourceContext || !cleanContext) return
    sourceContext.drawImage(before, 0, 0, width, height)
    cleanContext.drawImage(before, 0, 0, width, height)
    // Alpha is a coverage mask, not a change mask. Composite the patch first
    // so a fill matching the original never becomes a false highlight.
    cleanContext.drawImage(patch, 0, 0, width, height)
    let row = 0
    const paint = () => {
      if (cancelled) return
      const count = Math.min(rows, height - row)
      const sourcePixels = sourceContext.getImageData(0, row, width, count).data
      const cleanPixels = cleanContext.getImageData(0, row, width, count).data
      const mask = new ImageData(width, count)
      paintDifferencePixels(sourcePixels, cleanPixels, mask.data, 0, width * count)
      cleanContext.putImageData(mask, 0, row)
      row += count
      if (row < height) {
        frame = requestAnimationFrame(paint)
        return
      }
      // Keep the previous completed overlay visible while a new resolution is
      // calculated. Swap the finished canvas in one task so the user never sees
      // the transparent intermediate strips.
      if (!cancelled) {
        completedMask.current = cleanCanvas
        completedMaskKey.current = key
        drawMask(target, cleanCanvas, latestColor.current)
        setPainted({ key, color: latestColor.current })
        sourceCanvas.width = 0
      }
    }
    paint()
    return () => {
      cancelled = true; cancelAnimationFrame(frame)
      sourceCanvas.width = 0
      if (completedMask.current !== cleanCanvas) cleanCanvas.width = 0
    }
  }, [overlay.image, source.image, key, layers.ready, edge])

  return <canvas ref={canvas} className="pl-difference-overlay" data-ready={painted.key === key && painted.color === color && !!canvas.current?.width} data-color={painted.color} style={{ opacity }} role="img" aria-label="原圖與去字圖差異高亮，彩色區域為已修改像素" />
})
