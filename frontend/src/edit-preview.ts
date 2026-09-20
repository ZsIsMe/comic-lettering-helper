import type { EditRect } from './mask-edit-core'

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

export interface EditPreviewRegion {
  rect: EditRect
  imageWidth: number
}

// Display-only buffers: preview controls never change the saved editing layers.
export function renderEditViews(layers: EditPreviewLayers, options: EditPreviewOptions, region?: EditPreviewRegion) {
  const { base, overlay, other, edited, detectedText } = layers
  const rect = region?.rect
  const imageWidth = region?.imageWidth || 0
  if (rect) {
    const imageHeight = imageWidth > 0 ? base.length / 4 / imageWidth : 0
    if (!Number.isSafeInteger(imageWidth) || imageWidth <= 0
      || !Number.isSafeInteger(imageHeight)
      || !Number.isSafeInteger(rect.x) || !Number.isSafeInteger(rect.y)
      || !Number.isSafeInteger(rect.width) || !Number.isSafeInteger(rect.height)
      || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
      || rect.x + rect.width > imageWidth || rect.y + rect.height > imageHeight) {
      throw new RangeError('Invalid edit preview region')
    }
  }
  const outputLength = rect ? rect.width * rect.height * 4 : base.length
  const left = new Uint8ClampedArray(outputLength)
  const right = new Uint8ClampedArray(outputLength)
  const mix = Math.max(0, Math.min(100, options.maskPercent)) / 100
  const otherMix = Math.max(0, Math.min(100, options.otherPercent)) / 100
  const leftOtherColor = [255, 110, 165]
  const rows = rect?.height || 1
  const columns = rect?.width || base.length / 4
  let output = 0
  for (let row = 0; row < rows; row++) {
    let source = rect ? ((rect.y + row) * imageWidth + rect.x) * 4 : 0
    for (let column = 0; column < columns; column++, source += 4, output += 4) {
      const fillAlpha = overlay[source + 3] / 255
      const text = fillAlpha > 0 && (!detectedText || detectedText[source] > 0 || edited[source] > 0)
      const repair = other[source] >= 128
      for (let channel = 0; channel < 3; channel++) {
        const maskPixel = text ? options.maskColor[channel] : 0
        const leftPixel = base[source + channel] * (1 - mix) + maskPixel * mix
        left[output + channel] = Math.round(repair ? leftPixel * (1 - mix) + leftOtherColor[channel] * mix : leftPixel)
        const filled = base[source + channel] * (1 - fillAlpha) + overlay[source + channel] * fillAlpha
        right[output + channel] = Math.round(repair && options.showOther
          ? filled * (1 - otherMix) + options.otherColor[channel] * otherMix
          : filled)
      }
      left[output + 3] = right[output + 3] = 255
    }
  }
  return { left, right }
}
