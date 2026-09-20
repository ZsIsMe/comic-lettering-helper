import type { EditCategory, EditLayers, EditRect } from './mask-edit-core'
import type { SelectionOperation, SelectionPoint } from './selection-core'

export type RasterEditOperation = SelectionOperation | 'clear' | 'swap'

export type RasterSelectionSpec =
  | { kind: 'mask'; data: Uint8Array }
  | { kind: 'rectangle'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'polygon'; points: SelectionPoint[] }
  | { kind: 'brush'; points: SelectionPoint[]; size: number }
  | { kind: 'magic'; point: SelectionPoint; tolerance: number; expand: number }

export interface RasterCandidatePixels {
  code: number
  image: Uint8ClampedArray
  diff: Uint8ClampedArray
}

export interface RasterWorkerInit {
  width: number
  height: number
  base: Uint8ClampedArray
  overlay: Uint8ClampedArray
  other: Uint8ClampedArray
  edited: Uint8ClampedArray
  detectedText?: Uint8ClampedArray | null
  assignment?: Uint16Array
  candidates?: RasterCandidatePixels[]
}

export interface RasterEditCommand {
  selection: RasterSelectionSpec
  operation: RasterEditOperation
  category: EditCategory
  clipRect?: EditRect
  intersectOffset?: number
}

export interface RasterMergeCommand {
  layers: EditLayers
  rect: EditRect
}

export interface RasterMagicPreview {
  requestId: number
  point: SelectionPoint
  tolerance: number
  expand: number
  operation: SelectionOperation
  category: EditCategory
  clipRect?: EditRect
  intersectOffset?: number
}

export interface RasterRenderOptions {
  maskPercent: number
  maskColor: readonly number[]
  showOther: boolean
  otherPercent: number
  otherColor: readonly number[]
  /** Last document revision actually displayed; omit after display-option changes. */
  baseRevision?: number
  /** Preview requests are disposable and scheduled after document frames. */
  previewOnly?: boolean
  magicPreview?: RasterMagicPreview | null
  /** Opaque UI generation echoed on the frame so callers can associate it with submitted input. */
  tag?: number
}

export interface RasterHistoryState {
  undo: number
  redo: number
}

export interface RasterMetadata {
  revision: number
  history: RasterHistoryState
  hasRepairMask: boolean
}

export interface RasterRenderPixels extends RasterMetadata {
  width: number
  height: number
  left: Uint8ClampedArray
  magicLeft?: Uint8ClampedArray
  right: Uint8ClampedArray
  /** Packed patch location; width/height above remain the document dimensions. */
  rect?: EditRect
  baseRevision?: number
  previewRequestId?: number
  tag?: number
}

export interface RasterRenderFrame extends RasterMetadata {
  width: number
  height: number
  left: ImageBitmap
  magicLeft?: ImageBitmap
  right: ImageBitmap
  /** Packed patch location; width/height above remain the document dimensions. */
  rect?: EditRect
  baseRevision?: number
  previewRequestId?: number
  tag?: number
}

export interface RasterSnapshotPixels extends RasterMetadata {
  width: number
  height: number
  overlay: Uint8ClampedArray
  other: Uint8ClampedArray
  edited: Uint8ClampedArray
  assignment: Uint16Array
}

export interface RasterSnapshot extends RasterMetadata {
  overlay: Blob
  other: Blob
  edited: Blob
  assignment: Uint16Array
}

export type RasterWorkerRequest =
  | { id: number; type: 'init'; payload: RasterWorkerInit; copyInputs?: boolean }
  | { id: number; type: 'commit'; payload: RasterEditCommand }
  | { id: number; type: 'undo' }
  | { id: number; type: 'redo' }
  | { id: number; type: 'merge'; payload: RasterMergeCommand }
  | { id: number; type: 'resetHistory' }
  | { id: number; type: 'render'; payload: RasterRenderOptions }
  | { id: number; type: 'snapshot' }
  | { id: number; type: 'cancelPreview'; beforeId: number }

export type RasterWorkerSuccess =
  | { id: number; ok: true; type: 'metadata'; value: RasterMetadata }
  | { id: number; ok: true; type: 'render'; value: RasterRenderFrame | null }
  | { id: number; ok: true; type: 'snapshot'; value: RasterSnapshot }

export interface RasterWorkerFailure {
  id: number
  ok: false
  error: string
}

export type RasterWorkerResponse = RasterWorkerSuccess | RasterWorkerFailure
