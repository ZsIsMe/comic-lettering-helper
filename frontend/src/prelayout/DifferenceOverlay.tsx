import { memo, useEffect, useRef } from 'react'
import { previewUrl } from './api'
import { usePreview } from './preview-cache'
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
  const latestColor = useRef(color); latestColor.current = color
  const source = usePreview(previewUrl(project, page, edge, false), interacting)
  const clean = usePreview(previewUrl(project, page, edge, true), interacting)

  useEffect(() => {
    if (canvas.current && completedMask.current) drawMask(canvas.current, completedMask.current, color)
  }, [color])

  useEffect(() => {
    const target = canvas.current
    const before = source.image, after = clean.image
    if (!target || !before || !after) return
    let cancelled = false
    let frame = 0
    if (before.naturalWidth !== after.naturalWidth || before.naturalHeight !== after.naturalHeight) return
    const width = before.naturalWidth, height = before.naturalHeight, rows = Math.min(128, height)
    const sourceCanvas = document.createElement('canvas'), cleanCanvas = document.createElement('canvas'), resultCanvas = document.createElement('canvas')
    sourceCanvas.width = cleanCanvas.width = width; sourceCanvas.height = cleanCanvas.height = rows
    resultCanvas.width = width; resultCanvas.height = height
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
    const cleanContext = cleanCanvas.getContext('2d', { willReadFrequently: true })
    const result = resultCanvas.getContext('2d')
    if (!sourceContext || !cleanContext || !result) return
    let row = 0
    const paint = () => {
      if (cancelled) return
      const count = Math.min(rows, height - row)
      sourceContext.clearRect(0, 0, width, rows); cleanContext.clearRect(0, 0, width, rows)
      sourceContext.drawImage(before, 0, row, width, count, 0, 0, width, count)
      cleanContext.drawImage(after, 0, row, width, count, 0, 0, width, count)
      const sourcePixels = sourceContext.getImageData(0, 0, width, count).data
      const cleanPixels = cleanContext.getImageData(0, 0, width, count).data
      const mask = new ImageData(width, count)
      paintDifferencePixels(sourcePixels, cleanPixels, mask.data, 0, width * count)
      result.putImageData(mask, 0, row)
      row += count
      if (row < height) {
        frame = requestAnimationFrame(paint)
        return
      }
      // Keep the previous completed overlay visible while a new resolution is
      // calculated. Swap the finished canvas in one task so the user never sees
      // the transparent intermediate strips.
      if (!cancelled) {
        completedMask.current = resultCanvas
        drawMask(target, resultCanvas, latestColor.current)
      }
    }
    paint()
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [clean.image, source.image])

  return <canvas ref={canvas} className="pl-difference-overlay" style={{ opacity }} role="img" aria-label="原圖與去字圖差異高亮，彩色區域為已修改像素" />
})
