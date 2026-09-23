export const DIFFERENCE_THRESHOLD = 24

export function paintDifferencePixels(
  source: Uint8ClampedArray,
  clean: Uint8ClampedArray,
  output: Uint8ClampedArray,
  startPixel: number,
  endPixel: number,
  threshold = DIFFERENCE_THRESHOLD,
) {
  if (source.length !== clean.length || output.length !== source.length) throw new RangeError('差異圖片尺寸不一致')
  const start = Math.max(0, Math.trunc(startPixel)) * 4
  const end = Math.min(source.length / 4, Math.trunc(endPixel)) * 4
  for (let offset = start; offset < end; offset += 4) {
    const red = Math.abs(source[offset] - clean[offset])
    const green = Math.abs(source[offset + 1] - clean[offset + 1])
    const blue = Math.abs(source[offset + 2] - clean[offset + 2])
    const delta = Math.max(red, green, blue)
    // Keep the calculated result as a neutral alpha mask. The display color is
    // composited later, so changing color never compares the two images again.
    output[offset] = 255
    output[offset + 1] = 255
    output[offset + 2] = 255
    output[offset + 3] = delta >= threshold ? Math.min(210, Math.round(70 + (delta - threshold) * 2.2)) : 0
  }
}
