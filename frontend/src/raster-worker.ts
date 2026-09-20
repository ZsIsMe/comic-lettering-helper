import { createRasterScheduler } from './raster-worker-scheduler'
import { RasterWorkerEngine } from './raster-worker-engine'
import type {
  RasterMetadata,
  RasterRenderFrame,
  RasterRenderPixels,
  RasterSnapshot,
  RasterSnapshotPixels,
  RasterWorkerRequest,
  RasterWorkerResponse,
} from './raster-worker-protocol'

interface RasterWorkerScope {
  onmessage: ((event: MessageEvent<RasterWorkerRequest>) => void) | null
  postMessage(message: RasterWorkerResponse, transfer?: Transferable[]): void
}

const scope = globalThis as unknown as RasterWorkerScope
const engine = new RasterWorkerEngine()

function canvasWithPixels(pixels: Uint8ClampedArray, width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Offscreen 2D canvas is unavailable')
  context.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
  return canvas
}

function frameFromPixels(value: RasterRenderPixels): RasterRenderFrame {
  return {
    revision: value.revision,
    history: value.history,
    hasRepairMask: value.hasRepairMask,
    width: value.width,
    height: value.height,
    rect: value.rect,
    baseRevision: value.baseRevision,
    left: canvasWithPixels(value.left, value.rect?.width ?? value.width, value.rect?.height ?? value.height).transferToImageBitmap(),
    magicLeft: value.magicLeft ? canvasWithPixels(value.magicLeft, value.width, value.height).transferToImageBitmap() : undefined,
    right: canvasWithPixels(value.right, value.rect?.width ?? value.width, value.rect?.height ?? value.height).transferToImageBitmap(),
    previewRequestId: value.previewRequestId,
    tag: value.tag,
  }
}

async function png(pixels: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  return canvasWithPixels(pixels, width, height).convertToBlob({ type: 'image/png' })
}

async function encodedSnapshot(value: RasterSnapshotPixels): Promise<RasterSnapshot> {
  const [overlay, other, edited] = await Promise.all([
    png(value.overlay, value.width, value.height),
    png(value.other, value.width, value.height),
    png(value.edited, value.width, value.height),
  ])
  return {
    revision: value.revision,
    history: value.history,
    hasRepairMask: value.hasRepairMask,
    overlay,
    other,
    edited,
    assignment: value.assignment,
  }
}

function metadataResponse(id: number, value: RasterMetadata): RasterWorkerResponse {
  return { id, ok: true, type: 'metadata', value }
}

async function handle(request: RasterWorkerRequest): Promise<{ response: RasterWorkerResponse; transfer?: Transferable[] }> {
  switch (request.type) {
    case 'cancelPreview':
      return { response: { id: request.id, ok: true, type: 'render', value: null } }
    case 'init':
      return { response: metadataResponse(request.id, engine.init(request.payload)) }
    case 'commit':
      return { response: metadataResponse(request.id, engine.commit(request.payload)) }
    case 'undo':
      return { response: metadataResponse(request.id, engine.undo()) }
    case 'redo':
      return { response: metadataResponse(request.id, engine.redo()) }
    case 'merge':
      return { response: metadataResponse(request.id, engine.merge(request.payload)) }
    case 'resetHistory':
      return { response: metadataResponse(request.id, engine.resetHistory()) }
    case 'render': {
      const value = frameFromPixels(engine.render(request.payload))
      return { response: { id: request.id, ok: true, type: 'render', value }, transfer: [value.left, value.right, ...(value.magicLeft ? [value.magicLeft] : [])] }
    }
    case 'snapshot': {
      const value = await encodedSnapshot(engine.snapshot())
      return { response: { id: request.id, ok: true, type: 'snapshot', value }, transfer: [value.assignment.buffer] }
    }
  }
}

async function respond(request: RasterWorkerRequest) {
  try {
    const { response, transfer } = await handle(request)
    scope.postMessage(response, transfer)
  } catch (error) {
    scope.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

// Each command, including async snapshot encoding, runs to completion before the next.
const enqueue = createRasterScheduler(respond, request => {
  scope.postMessage({ id: request.id, ok: true, type: 'render', value: null })
})
scope.onmessage = event => enqueue(event.data)
