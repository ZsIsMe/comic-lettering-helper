export interface EditPreviewLayers {
  base: Uint8ClampedArray
  overlay: Uint8ClampedArray
  other: Uint8ClampedArray
  edited: Uint8ClampedArray
  detectedText?: Uint8ClampedArray
}
export interface EditPreviewOptions {
  maskPercent: number
  maskColor: readonly number[]
  showOther: boolean
  otherPercent: number
  otherColor: readonly number[]
}

// Display-only buffers: preview controls never change the saved editing layers.
export function renderEditViews(layers: EditPreviewLayers, options: EditPreviewOptions) {
  const { base, overlay, other, edited, detectedText } = layers
  const left = new Uint8ClampedArray(base.length)
  const right = new Uint8ClampedArray(base.length)
  const mix = Math.max(0, Math.min(100, options.maskPercent)) / 100
  const otherMix = Math.max(0, Math.min(100, options.otherPercent)) / 100
  const leftOtherColor = [255, 110, 165]
  for (let i = 0; i < base.length; i += 4) {
    const fillAlpha = overlay[i + 3] / 255
    const text = fillAlpha > 0 && (!detectedText || detectedText[i] > 0 || edited[i] > 0)
    const repair = other[i] >= 128
    for (let c = 0; c < 3; c++) {
      const maskPixel = text ? options.maskColor[c] : 0
      const leftPixel = base[i + c] * (1 - mix) + maskPixel * mix
      left[i + c] = Math.round(repair ? leftPixel * (1 - mix) + leftOtherColor[c] * mix : leftPixel)
      const filled = base[i + c] * (1 - fillAlpha) + overlay[i + c] * fillAlpha
      right[i + c] = Math.round(repair && options.showOther ? filled * (1 - otherMix) + options.otherColor[c] * otherMix : filled)
    }
    left[i + 3] = right[i + 3] = 255
  }
  return { left, right }
}
