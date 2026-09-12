export type EditLayers = { overlay: Uint8ClampedArray; other: Uint8ClampedArray; edited: Uint8ClampedArray }
export type EditCategory = 'solid' | 'other'
export type EditRect = { x: number; y: number; width: number; height: number }
export function categoryMask(layers: EditLayers, category: EditCategory): Uint8Array {
  const result = new Uint8Array(layers.edited.length / 4)
  for (let n = 0; n < result.length; n++) result[n] = category === 'solid' ? +(layers.overlay[n * 4 + 3] > 0) : +(layers.other[n * 4] >= 128)
  return result
}
export function cloneLayers(layers: EditLayers): EditLayers {
  return { overlay: layers.overlay.slice(), other: layers.other.slice(), edited: layers.edited.slice() }
}
function write(layers: EditLayers, n: number, category: EditCategory, selected: boolean, color: readonly number[]) {
  const i = n * 4
  if (category === 'solid') {
    layers.overlay.set(selected ? [color[0], color[1], color[2], 255] : [0, 0, 0, 0], i)
    if (selected) layers.other.set([0, 0, 0, 255], i)
  } else {
    layers.other.set(selected ? [255, 255, 255, 255] : [0, 0, 0, 255], i)
    if (selected) layers.overlay.set([0, 0, 0, 0], i)
  }
  layers.edited.set([255, 255, 255, 255], i)
}
export function applyCategoryMask(layers: EditLayers, before: Uint8Array, after: Uint8Array, category: EditCategory, color: readonly number[], clip?: Uint8Array, paintSelection?: Uint8Array): EditLayers {
  const out = cloneLayers(layers)
  for (let n = 0; n < before.length; n++) if ((before[n] !== after[n] || (paintSelection?.[n] && after[n])) && (!clip || clip[n])) write(out, n, category, !!after[n], color)
  return out
}
export function applySpecialSelection(layers: EditLayers, selection: Uint8Array, action: 'clear' | 'transfer', category: EditCategory, color: readonly number[]): EditLayers {
  const out = cloneLayers(layers)
  for (let n = 0; n < selection.length; n++) {
    if (!selection[n]) continue
    const i = n * 4
    if (action === 'clear') {
      // Record the explicit exclusion even when no detected mask is present yet.
      out.overlay.set([0, 0, 0, 0], i); out.other.set([0, 0, 0, 255], i); out.edited.set([255, 255, 255, 255], i)
    } else if (category === 'solid' ? layers.other[i] >= 128 : layers.overlay[i + 3] > 0) write(out, n, category, true, color)
  }
  return out
}
export function mergeLayerRegion(original: EditLayers, draft: EditLayers, width: number, height: number, rect: EditRect): EditLayers {
  const out = cloneLayers(original)
  for (let y = Math.max(0, rect.y); y < Math.min(height, rect.y + rect.height); y++) {
    const start = (y * width + Math.max(0, rect.x)) * 4
    const end = (y * width + Math.min(width, rect.x + rect.width)) * 4
    for (const key of ['overlay', 'other', 'edited'] as const) out[key].set(draft[key].subarray(start, end), start)
  }
  return out
}
