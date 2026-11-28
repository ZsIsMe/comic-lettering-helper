export type LocalPreview = {
  url: string; width: number; height: number; edge?: number;
  region?: { x: number; y: number; width: number; height: number };
}

/** The same original-space crop and longest-edge bound as server previews. */
export function localPreviewPlan(input: Omit<LocalPreview, 'url'>) {
  const region = input.region || { x: 0, y: 0, width: input.width, height: input.height }
  const { x, y, width, height } = region
  if (![input.width, input.height, width, height].every(value => Number.isInteger(value) && value > 0) ||
      ![x, y].every(value => Number.isInteger(value) && value >= 0) || x + width > input.width || y + height > input.height ||
      (input.edge !== undefined && (!Number.isFinite(input.edge) || input.edge < 1))) throw new Error('本機預覽尺寸或裁切範圍無效。')
  const ratio = input.edge === undefined ? 1 : Math.min(1, input.edge / Math.max(width, height))
  return { x, y, width, height, outputWidth: Math.max(1, Math.round(width * ratio)), outputHeight: Math.max(1, Math.round(height * ratio)) }
}

let pending = Promise.resolve()
/** Decode one source at a time; retain only the bounded result in the shared cache. */
export function localPreviewBlob(blob: Blob, input: LocalPreview, signal?: AbortSignal): Promise<Blob> {
  if (input.edge === undefined && !input.region) return Promise.resolve(blob)
  const operation = pending.then(async () => {
    if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
    const plan = localPreviewPlan(input)
    const bitmap = await createImageBitmap(blob, plan.x, plan.y, plan.width, plan.height, {
      resizeWidth: plan.outputWidth, resizeHeight: plan.outputHeight, resizeQuality: 'high',
    })
    const canvas = document.createElement('canvas')
    canvas.width = plan.outputWidth; canvas.height = plan.outputHeight
    try {
      if (signal?.aborted) throw new DOMException('cancelled', 'AbortError')
      const context = canvas.getContext('2d')
      if (!context) throw new Error('瀏覽器無法建立本機圖片預覽。')
      context.drawImage(bitmap, 0, 0)
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('本機圖片預覽編碼失敗。')), 'image/png'))
    } finally { bitmap.close(); canvas.width = canvas.height = 0 }
  })
  pending = operation.then(() => undefined, () => undefined)
  return operation
}
