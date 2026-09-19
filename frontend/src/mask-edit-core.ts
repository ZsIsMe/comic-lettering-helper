export type EditLayers = { overlay: Uint8ClampedArray; other: Uint8ClampedArray; edited: Uint8ClampedArray }
export type EditCategory = 'solid' | 'other'
export type EditRect = { x: number; y: number; width: number; height: number }
export type SolidSampleSource = {
  base: ArrayLike<number>
  width: number
  height: number
  exclude?: Uint8Array | null
}

const SAMPLE_RADII = [3, 6, 12, 24, 48]
const MIN_SAMPLE_PIXELS = 12

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
function dilateBox(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let n = 0; n < mask.length; n++) {
    if (!mask[n]) continue
    const x = n % width, y = (n / width) | 0
    const x0 = Math.max(0, x - radius), x1 = Math.min(width - 1, x + radius)
    const y0 = Math.max(0, y - radius), y1 = Math.min(height - 1, y + radius)
    for (let yy = y0; yy <= y1; yy++) out.fill(1, yy * width + x0, yy * width + x1 + 1)
  }
  return out
}
function medianChannel(hist: Uint32Array, total: number): number {
  if (!total) return 0
  let seen = 0
  const half = total / 2
  for (let value = 0; value < 256; value++) {
    seen += hist[value]
    if (seen >= half) return value
  }
  return 255
}
function sampledRgb(base: ArrayLike<number>, ring: Uint8Array): [number, number, number] | null {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  let total = 0
  for (let n = 0; n < ring.length; n++) {
    if (!ring[n]) continue
    const i = n * 4
    hist[0][base[i]]++
    hist[1][base[i + 1]]++
    hist[2][base[i + 2]]++
    total++
  }
  if (total < MIN_SAMPLE_PIXELS) return null
  return [medianChannel(hist[0], total), medianChannel(hist[1], total), medianChannel(hist[2], total)]
}
function sampleComponent(
  base: ArrayLike<number>,
  width: number,
  height: number,
  region: Uint8Array,
  exclude?: Uint8Array | null,
): [number, number, number] {
  const ring = new Uint8Array(region.length)
  for (const radius of SAMPLE_RADII) {
    const expanded = dilateBox(region, width, height, radius)
    ring.fill(0)
    for (let n = 0; n < region.length; n++) if (expanded[n] && !region[n] && !exclude?.[n]) ring[n] = 1
    const color = sampledRgb(base, ring)
    if (color) return color
  }
  ring.fill(0)
  for (let n = 0; n < region.length; n++) if (region[n] && !exclude?.[n]) ring[n] = 1
  return sampledRgb(base, ring) || sampledRgb(base, region) || [0, 0, 0]
}
/** Per-pixel RGB for each connected solid region, sampled from original pixels around that region. */
export function sampleSolidFills(
  base: ArrayLike<number>,
  width: number,
  height: number,
  region: Uint8Array,
  exclude?: Uint8Array | null,
): Uint8Array {
  const fills = new Uint8Array(region.length * 3)
  const seen = new Uint8Array(region.length)
  const stack: number[] = []
  const component = new Uint8Array(region.length)
  for (let start = 0; start < region.length; start++) {
    if (!region[start] || seen[start]) continue
    component.fill(0)
    stack.length = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const n = stack.pop()!
      component[n] = 1
      const x = n % width, y = (n / width) | 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
        const k = yy * width + xx
        if (region[k] && !seen[k]) { seen[k] = 1; stack.push(k) }
      }
    }
    const color = sampleComponent(base, width, height, component, exclude)
    for (let n = 0; n < component.length; n++) if (component[n]) {
      fills[n * 3] = color[0]
      fills[n * 3 + 1] = color[1]
      fills[n * 3 + 2] = color[2]
    }
  }
  return fills
}
function paintColor(n: number, fallback: readonly number[], fills?: Uint8Array | null): readonly number[] {
  return fills ? [fills[n * 3], fills[n * 3 + 1], fills[n * 3 + 2]] : fallback
}
function sampledFills(region: Uint8Array, sample?: SolidSampleSource): Uint8Array | null {
  return sample ? sampleSolidFills(sample.base, sample.width, sample.height, region, sample.exclude) : null
}
export function applyCategoryMask(layers: EditLayers, before: Uint8Array, after: Uint8Array, category: EditCategory, color: readonly number[], clip?: Uint8Array, paintSelection?: Uint8Array, sample?: SolidSampleSource): EditLayers {
  const out = cloneLayers(layers)
  const painted = new Uint8Array(after.length)
  for (let n = 0; n < before.length; n++) {
    if ((before[n] !== after[n] || (paintSelection?.[n] && after[n])) && (!clip || clip[n]) && after[n]) painted[n] = 1
  }
  const fills = category === 'solid' ? sampledFills(painted, sample) : null
  for (let n = 0; n < before.length; n++) if ((before[n] !== after[n] || (paintSelection?.[n] && after[n])) && (!clip || clip[n])) write(out, n, category, !!after[n], paintColor(n, color, fills))
  return out
}
/** Desktop repair footprint: text dilated by a 3px OpenCV ellipse. Null keeps imported masks usable. */
export function textRepairMask(text: Uint8ClampedArray | null | undefined, width: number, height: number): Uint8Array | null {
  if (!text || width <= 0 || height <= 0 || text.length !== width * height * 4) return null
  const result = new Uint8Array(width * height)
  let found = false
  for (let n = 0; n < result.length; n++) {
    if (!text[n * 4]) continue
    found = true
    const x = n % width, y = Math.floor(n / width)
    for (let dy = -3; dy <= 3; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= height) continue
      const span = Math.round(Math.sqrt(9 - dy * dy))
      result.fill(1, yy * width + Math.max(0, x - span), yy * width + Math.min(width, x + span + 1))
    }
  }
  return found ? result : null
}
export function applySpecialSelection(layers: EditLayers, selection: Uint8Array, action: 'clear' | 'swap', color: readonly number[], repairText?: Uint8Array | null, sample?: SolidSampleSource): EditLayers {
  const out = cloneLayers(layers)
  const toSolid = new Uint8Array(selection.length)
  if (action === 'swap') {
    for (let n = 0; n < selection.length; n++) if (selection[n] && layers.overlay[n * 4 + 3] === 0 && layers.other[n * 4] >= 128) toSolid[n] = 1
  }
  const fills = sampledFills(toSolid, sample)
  for (let n = 0; n < selection.length; n++) {
    if (!selection[n]) continue
    const i = n * 4
    if (action === 'clear') {
      // Record the explicit exclusion even when no detected mask is present yet.
      out.overlay.set([0, 0, 0, 0], i); out.other.set([0, 0, 0, 255], i); out.edited.set([255, 255, 255, 255], i)
    } else {
      // Read both categories from the original snapshot, so one gesture swaps once.
      if (layers.overlay[i + 3] > 0) {
        // Drop the selected bubble fill; only text margins and manual paint become repair.
        out.overlay.set([0, 0, 0, 0], i)
        write(out, n, 'other', !repairText || !!repairText[n] || layers.edited[i] > 0, color)
      }
      else if (layers.other[i] >= 128) write(out, n, 'solid', true, paintColor(n, color, fills))
      // Empty pixels, including their manual-edit flags, stay untouched.
    }
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
