import { renderEditViews } from './edit-preview'
import {
  applyCategoryMask,
  applySpecialSelection,
  categoryMask,
  cloneLayers,
  mergeLayerRegion,
  textRepairMask,
  type EditLayers,
  type EditRect,
  type SolidSampleSource,
} from './mask-edit-core'
import { combineSelection, magicSelection, polygonSelection, rectangleSelection } from './selection-core'
import type {
  RasterEditCommand,
  RasterMagicPreview,
  RasterMergeCommand,
  RasterMetadata,
  RasterRenderOptions,
  RasterRenderPixels,
  RasterSelectionSpec,
  RasterSnapshotPixels,
  RasterWorkerInit,
} from './raster-worker-protocol'

const HISTORY_BYTES = 96 * 1024 * 1024
const DIRTY_HISTORY_LIMIT = 64

type MagicEditCommand = RasterEditCommand & { selection: Extract<RasterSelectionSpec, { kind: 'magic' }> }
type MagicCache = { revision: number; command: MagicEditCommand; selection: Uint8Array; next: EditLayers }
type DirtyTransition = { revision: number; rect: EditRect | null }
export type RasterWorkerEngineInitOptions = { copyInputs?: boolean }

function validateRgba(name: string, data: ArrayLike<number>, size: number) {
  if (data.length !== size * 4) throw new RangeError(`${name} dimensions do not match the image`)
}

function brushSelection(points: readonly { x: number; y: number }[], size: number, width: number, height: number): Uint8Array {
  const result = new Uint8Array(width * height)
  const radius = Math.max(0, size) / 2
  const stroke = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)))
    for (let step = 0; step <= steps; step++) {
      const x = a.x + (b.x - a.x) * step / steps
      const y = a.y + (b.y - a.y) * step / steps
      for (let yy = Math.max(0, Math.floor(y - radius)); yy <= Math.min(height - 1, y + radius); yy++) {
        for (let xx = Math.max(0, Math.floor(x - radius)); xx <= Math.min(width - 1, x + radius); xx++) {
          if ((xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2) result[yy * width + xx] = 1
        }
      }
    }
  }
  if (points.length) stroke(points[0], points[0])
  for (let index = 1; index < points.length; index++) stroke(points[index - 1], points[index])
  return result
}

/** Pure state engine used by the worker and by parity tests. It does not depend on canvas APIs. */
export class RasterWorkerEngine {
  private width = 0
  private height = 0
  private base: Uint8ClampedArray = new Uint8ClampedArray()
  private layers: EditLayers = {
    overlay: new Uint8ClampedArray(),
    other: new Uint8ClampedArray(),
    edited: new Uint8ClampedArray(),
  }
  private detectedText: Uint8ClampedArray | null = null
  private repairText: Uint8Array | null = null
  private sampleExclude: Uint8Array | null = null
  private assignment: Uint16Array = new Uint16Array()
  private candidates = new Map<number, { image: Uint8ClampedArray; diff: Uint8ClampedArray }>()
  private history: EditLayers[] = []
  private future: EditLayers[] = []
  private revision = 0
  private dirtyTransitions: DirtyTransition[] = []
  private initialized = false
  private magicCache: MagicCache | null = null

  init(input: RasterWorkerInit, options: RasterWorkerEngineInitOptions = { copyInputs: true }): RasterMetadata {
    const { width, height } = input
    const size = width * height
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0 || !Number.isSafeInteger(size)) {
      throw new RangeError('Invalid raster dimensions')
    }
    validateRgba('base', input.base, size)
    validateRgba('overlay', input.overlay, size)
    validateRgba('other', input.other, size)
    validateRgba('edited', input.edited, size)
    if (input.detectedText) validateRgba('detectedText', input.detectedText, size)
    if (input.assignment && input.assignment.length !== size) throw new RangeError('assignment dimensions do not match the image')
    for (const candidate of input.candidates || []) {
      validateRgba(`candidate ${candidate.code}`, candidate.image, size)
      validateRgba(`candidate diff ${candidate.code}`, candidate.diff, size)
    }

    const owned = <T extends Uint8ClampedArray | Uint16Array>(value: T): T => options.copyInputs === false ? value : value.slice() as T
    this.width = width
    this.height = height
    this.base = owned(input.base)
    this.layers = { overlay: owned(input.overlay), other: owned(input.other), edited: owned(input.edited) }
    this.detectedText = input.detectedText ? owned(input.detectedText) : null
    this.repairText = textRepairMask(this.detectedText, width, height)
    this.sampleExclude = this.detectedText ? new Uint8Array(size) : null
    if (this.detectedText && this.sampleExclude) {
      for (let n = 0; n < size; n++) if (this.detectedText[n * 4] > 0) this.sampleExclude[n] = 1
    }
    this.assignment = input.assignment ? owned(input.assignment) : new Uint16Array(size)
    this.candidates = new Map((input.candidates || []).map(candidate => [candidate.code, {
      image: owned(candidate.image),
      diff: owned(candidate.diff),
    }]))
    this.history = []
    this.future = []
    this.revision = 0
    this.dirtyTransitions = []
    this.magicCache = null
    this.initialized = true
    return this.metadata()
  }

  metadata(): RasterMetadata {
    this.assertInitialized()
    let hasRepairMask = false
    for (let index = 0; index < this.layers.other.length; index += 4) {
      if (this.layers.other[index] >= 128) { hasRepairMask = true; break }
    }
    return {
      revision: this.revision,
      history: { undo: this.history.length, redo: this.future.length },
      hasRepairMask,
    }
  }

  commit(command: RasterEditCommand): RasterMetadata {
    this.assertInitialized()
    const before = this.layers
    const cached = command.selection.kind === 'magic' ? this.cachedMagic(command as MagicEditCommand) : null
    if (cached) this.layers = cached.next
    else {
      const selection = this.selection(command.selection, command.clipRect)
      this.layers = this.apply(before, selection, command)
    }
    this.pushHistory(before)
    this.future = []
    this.recordTransition(before)
    this.magicCache = null
    return this.metadata()
  }

  undo(): RasterMetadata {
    this.assertInitialized()
    const previous = this.history.pop()
    if (previous) {
      const before = this.layers
      this.future.push(cloneLayers(this.layers))
      this.layers = previous
      this.recordTransition(before)
      this.magicCache = null
    }
    return this.metadata()
  }

  redo(): RasterMetadata {
    this.assertInitialized()
    const next = this.future.pop()
    if (next) {
      const before = this.layers
      this.pushHistory(this.layers)
      this.layers = next
      this.recordTransition(before)
      this.magicCache = null
    }
    return this.metadata()
  }

  merge(command: RasterMergeCommand): RasterMetadata {
    this.assertInitialized()
    this.validateLayers(command.layers)
    const before = this.layers
    this.layers = mergeLayerRegion(before, command.layers, this.width, this.height, command.rect)
    this.pushHistory(before)
    this.future = []
    this.recordTransition(before)
    this.magicCache = null
    return this.metadata()
  }

  resetHistory(): RasterMetadata {
    this.assertInitialized()
    this.history = []
    this.future = []
    return this.metadata()
  }

  render(options: RasterRenderOptions): RasterRenderPixels {
    this.assertInitialized()
    const layers = {
      base: this.base,
      overlay: this.layers.overlay,
      other: this.layers.other,
      edited: this.layers.edited,
      detectedText: this.detectedText || undefined,
    }
    const dirty = options.baseRevision === undefined ? undefined : this.dirtySince(options.baseRevision)
    const rect = dirty === null && this.width > 0 && this.height > 0
      ? { x: 0, y: 0, width: 1, height: 1 }
      : dirty
    const patchRect = rect && rect !== undefined ? rect : undefined
    const views = renderEditViews(layers, options,
      patchRect ? { rect: patchRect, imageWidth: this.width } : undefined)
    const magicBase = options.magicPreview && patchRect
      ? renderEditViews(layers, options).left
      : views.left
    const magicLeft = options.magicPreview ? magicBase.slice() : undefined
    if (options.magicPreview && magicLeft) this.tintMagicPreview(magicLeft, options.magicPreview)
    return {
      ...this.metadata(),
      width: this.width,
      height: this.height,
      left: views.left,
      right: views.right,
      magicLeft,
      ...(patchRect ? { rect: patchRect, baseRevision: options.baseRevision } : {}),
      previewRequestId: options.magicPreview?.requestId,
      tag: options.tag,
    }
  }

  snapshot(): RasterSnapshotPixels {
    this.assertInitialized()
    return {
      ...this.metadata(),
      width: this.width,
      height: this.height,
      overlay: this.layers.overlay.slice(),
      other: this.layers.other.slice(),
      edited: this.layers.edited.slice(),
      assignment: this.assignment.slice(),
    }
  }

  private assertInitialized() {
    if (!this.initialized) throw new Error('Raster worker is not initialized')
  }

  private validateLayers(layers: EditLayers) {
    const size = this.width * this.height
    validateRgba('overlay', layers.overlay, size)
    validateRgba('other', layers.other, size)
    validateRgba('edited', layers.edited, size)
  }

  private pushHistory(layers: EditLayers) {
    this.history.push(cloneLayers(layers))
    // Keep the desktop editor's cap calculation, including its 2-byte assignment estimate.
    const limit = Math.max(1, Math.min(20, Math.floor(HISTORY_BYTES / (this.width * this.height * 14))))
    while (this.history.length > limit) this.history.shift()
  }

  private recordTransition(before: EditLayers) {
    this.revision++
    this.dirtyTransitions.push({
      revision: this.revision,
      rect: this.layerDiffBounds(before, this.layers),
    })
    while (this.dirtyTransitions.length > DIRTY_HISTORY_LIMIT) this.dirtyTransitions.shift()
  }

  /** Returns undefined when the requested basis is not traceable, and null when it is unchanged. */
  private dirtySince(baseRevision: number): EditRect | null | undefined {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0 || baseRevision > this.revision) return undefined
    if (baseRevision === this.revision) return null
    const count = this.revision - baseRevision
    if (count > this.dirtyTransitions.length) return undefined
    const transitions = this.dirtyTransitions.slice(-count)
    if (transitions[0]?.revision !== baseRevision + 1
      || transitions[transitions.length - 1]?.revision !== this.revision) return undefined
    let union: EditRect | null = null
    for (let index = 0; index < transitions.length; index++) {
      if (transitions[index].revision !== baseRevision + index + 1) return undefined
      const rect = transitions[index].rect
      if (!rect) continue
      if (!union) union = { ...rect }
      else {
        const right = Math.max(union.x + union.width, rect.x + rect.width)
        const bottom = Math.max(union.y + union.height, rect.y + rect.height)
        union.x = Math.min(union.x, rect.x)
        union.y = Math.min(union.y, rect.y)
        union.width = right - union.x
        union.height = bottom - union.y
      }
    }
    return union
  }

  private layerDiffBounds(before: EditLayers, after: EditLayers): EditRect | null {
    let minX = this.width
    let minY = this.height
    let maxX = -1
    let maxY = -1
    // Internal layers are owned RGBA buffers, so aligned 32-bit equality covers all four channels at once.
    const beforeLayers = [before.overlay, before.other, before.edited]
      .map(layer => new Uint32Array(layer.buffer, layer.byteOffset, layer.byteLength / 4))
    const afterLayers = [after.overlay, after.other, after.edited]
      .map(layer => new Uint32Array(layer.buffer, layer.byteOffset, layer.byteLength / 4))
    const pixels = this.width * this.height
    for (let pixel = 0; pixel < pixels; pixel++) {
      const changed = beforeLayers[0][pixel] !== afterLayers[0][pixel]
        || beforeLayers[1][pixel] !== afterLayers[1][pixel]
        || beforeLayers[2][pixel] !== afterLayers[2][pixel]
      if (!changed) continue
      const x = pixel % this.width
      const y = Math.floor(pixel / this.width)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
  }

  private sample(): SolidSampleSource {
    return { base: this.base, width: this.width, height: this.height, exclude: this.sampleExclude }
  }

  private clip(selection: Uint8Array, rect?: EditRect): Uint8Array {
    if (!rect) return selection
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) selection[y * this.width + x] = 0
      }
    }
    return selection
  }

  private clipMask(rect?: EditRect): Uint8Array | undefined {
    return rect ? this.clip(new Uint8Array(this.width * this.height).fill(1), rect) : undefined
  }

  private magic(spec: Extract<RasterSelectionSpec, { kind: 'magic' }>, rect?: EditRect): Uint8Array {
    const { x, y } = spec.point
    if (rect && (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height)) {
      return new Uint8Array(this.width * this.height)
    }
    if (!rect) return magicSelection(this.base, this.width, this.height, x, y, spec.tolerance, spec.expand)
    const crop = new Uint8ClampedArray(rect.width * rect.height * 4)
    for (let row = 0; row < rect.height; row++) {
      const start = ((rect.y + row) * this.width + rect.x) * 4
      crop.set(this.base.subarray(start, start + rect.width * 4), row * rect.width * 4)
    }
    const selected = magicSelection(crop, rect.width, rect.height, x - rect.x, y - rect.y, spec.tolerance, spec.expand)
    const result = new Uint8Array(this.width * this.height)
    for (let row = 0; row < rect.height; row++) {
      result.set(selected.subarray(row * rect.width, (row + 1) * rect.width), (rect.y + row) * this.width + rect.x)
    }
    return result
  }

  private selection(spec: RasterSelectionSpec, rect?: EditRect): Uint8Array {
    let result: Uint8Array
    if (spec.kind === 'mask') {
      if (spec.data.length !== this.width * this.height) throw new RangeError('Selection dimensions do not match the image')
      result = spec.data.slice()
    } else if (spec.kind === 'rectangle') {
      result = rectangleSelection(spec.x1, spec.y1, spec.x2, spec.y2, this.width, this.height)
    } else if (spec.kind === 'polygon') {
      result = polygonSelection(spec.points, this.width, this.height)
    } else if (spec.kind === 'brush') {
      result = brushSelection(spec.points, spec.size, this.width, this.height)
    } else {
      result = this.magic(spec, rect)
    }
    return this.clip(result, rect)
  }

  private apply(before: EditLayers, selection: Uint8Array, command: Omit<RasterEditCommand, 'selection'>): EditLayers {
    if (command.operation === 'clear' || command.operation === 'swap') {
      return applySpecialSelection(before, selection, command.operation, [0, 0, 0], this.repairText, this.sample())
    }
    const current = categoryMask(before, command.category)
    const next = combineSelection(current, selection, this.width, this.height, command.operation, command.intersectOffset || 0)
    const paint = ['add', 'selection_inner', 'add_selection_inner'].includes(command.operation)
      ? combineSelection(new Uint8Array(this.width * this.height), selection, this.width, this.height, command.operation)
      : undefined
    return applyCategoryMask(before, current, next, command.category, [0, 0, 0], this.clipMask(command.clipRect), paint, this.sample())
  }

  private sameMagicCommand(a: MagicEditCommand, b: MagicEditCommand): boolean {
    const aRect = a.clipRect, bRect = b.clipRect
    return a.selection.point.x === b.selection.point.x
      && a.selection.point.y === b.selection.point.y
      && a.selection.tolerance === b.selection.tolerance
      && a.selection.expand === b.selection.expand
      && a.operation === b.operation
      && a.category === b.category
      && a.intersectOffset === b.intersectOffset
      && (!aRect && !bRect || !!aRect && !!bRect
        && aRect.x === bRect.x && aRect.y === bRect.y
        && aRect.width === bRect.width && aRect.height === bRect.height)
  }

  private cachedMagic(command: MagicEditCommand): MagicCache | null {
    const cached = this.magicCache
    return cached && cached.revision === this.revision && this.sameMagicCommand(cached.command, command) ? cached : null
  }

  private cacheMagic(command: MagicEditCommand): MagicCache {
    const cached = this.cachedMagic(command)
    if (cached) return cached
    const selection = this.selection(command.selection, command.clipRect)
    const next = this.apply(this.layers, selection, command)
    const stored: MagicCache = {
      revision: this.revision,
      command: {
        ...command,
        selection: { ...command.selection, point: { ...command.selection.point } },
        clipRect: command.clipRect ? { ...command.clipRect } : undefined,
      },
      selection,
      next,
    }
    this.magicCache = stored
    return stored
  }

  private tintMagicPreview(left: Uint8ClampedArray, preview: RasterMagicPreview) {
    const before = this.layers
    const command: MagicEditCommand = {
      selection: {
        kind: 'magic',
        point: preview.point,
        tolerance: preview.tolerance,
        expand: preview.expand,
      },
      operation: preview.operation,
      category: preview.category,
      clipRect: preview.clipRect,
      intersectOffset: preview.intersectOffset,
    }
    const { next } = this.cacheMagic(command)
    const currentMask = categoryMask(before, preview.category)
    const nextMask = categoryMask(next, preview.category)
    for (let n = 0; n < currentMask.length; n++) {
      const recolored = preview.category === 'solid' && !!nextMask[n]
        && [0, 1, 2].some(channel => before.overlay[n * 4 + channel] !== next.overlay[n * 4 + channel])
      const add = (!currentMask[n] && !!nextMask[n]) || recolored
      const remove = !!currentMask[n] && !nextMask[n]
      const tint = remove ? [245, 70, 70] : add ? [25, 210, 150] : null
      if (tint) {
        for (let channel = 0; channel < 3; channel++) {
          left[n * 4 + channel] = Math.round(left[n * 4 + channel] * .4 + tint[channel] * .6)
        }
      }
    }
  }
}
