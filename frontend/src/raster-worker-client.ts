import type {
  RasterEditCommand,
  RasterMergeCommand,
  RasterMetadata,
  RasterRenderFrame,
  RasterRenderOptions,
  RasterSnapshot,
  RasterWorkerInit,
  RasterWorkerRequest,
  RasterWorkerResponse,
} from './raster-worker-protocol'

export type {
  RasterCandidatePixels,
  RasterEditCommand,
  RasterEditOperation,
  RasterHistoryState,
  RasterMagicPreview,
  RasterMergeCommand,
  RasterMetadata,
  RasterRenderFrame,
  RasterRenderOptions,
  RasterSelectionSpec,
  RasterSnapshot,
  RasterWorkerInit,
} from './raster-worker-protocol'

type ResponseType = 'metadata' | 'render' | 'snapshot'
type ResponseValue = RasterMetadata | RasterRenderFrame | RasterSnapshot | null

export interface RasterWorkerPort {
  postMessage(message: RasterWorkerRequest, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent<RasterWorkerResponse>) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<RasterWorkerResponse>) => void): void
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void
  terminate?(): void
}

export interface RasterWorkerClientOptions {
  /** Injection point for deterministic delayed/out-of-order transport tests. */
  workerFactory?: () => RasterWorkerPort
}

export interface RasterWorkerInitOptions {
  /** Transfer disposable edit-layer inputs. The cached base buffer is always retained by the caller. */
  transferOwned?: boolean
  /** DEV A/B switch that asks the worker engine to retain the legacy second copy. */
  copyInputs?: boolean
}

interface Pending {
  expected: ResponseType
  resolve(value: ResponseValue): void
  reject(error: Error): void
}

function defaultWorker(): RasterWorkerPort {
  return new Worker(new URL('./raster-worker.ts', import.meta.url), { type: 'module', name: 'comic-raster-editor' })
}

function closeFrame(frame: RasterRenderFrame) {
  frame.left.close()
  frame.right.close()
  frame.magicLeft?.close()
}

export class RasterWorkerClient {
  private readonly worker: RasterWorkerPort
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private latestRenderToken = 0
  private latestPreviewToken = 0
  private disposed = false
  private terminalError: Error | null = null

  constructor(options: RasterWorkerClientOptions = {}) {
    this.worker = (options.workerFactory || defaultWorker)()
    this.worker.addEventListener('message', this.onMessage)
    this.worker.addEventListener('error', this.onWorkerError)
    this.worker.addEventListener('messageerror', this.onWorkerError)
  }

  get usable(): boolean {
    return !this.disposed && !this.terminalError
  }

  init(payload: RasterWorkerInit, options: RasterWorkerInitOptions = {}): Promise<RasterMetadata> {
    // Frames from the previous document must be closed even when they arrive after this init reply.
    this.latestRenderToken++
    this.latestPreviewToken++
    const transfer = options.transferOwned ? this.ownedInitTransfers(payload) : undefined
    return this.send('init', 'metadata', payload, transfer, options.copyInputs)
  }

  commit(payload: RasterEditCommand): Promise<RasterMetadata> {
    return this.send('commit', 'metadata', payload)
  }

  undo(): Promise<RasterMetadata> {
    return this.send('undo', 'metadata')
  }

  redo(): Promise<RasterMetadata> {
    return this.send('redo', 'metadata')
  }

  merge(payload: RasterMergeCommand): Promise<RasterMetadata> {
    return this.send('merge', 'metadata', payload)
  }

  resetHistory(): Promise<RasterMetadata> {
    return this.send('resetHistory', 'metadata')
  }

  async render(payload: RasterRenderOptions): Promise<RasterRenderFrame | null> {
    const token = payload.previewOnly ? ++this.latestPreviewToken : ++this.latestRenderToken
    const frame = await this.send('render', 'render', payload)
    if (!frame) return null
    if (this.disposed || token !== (payload.previewOnly ? this.latestPreviewToken : this.latestRenderToken)) {
      closeFrame(frame)
      return null
    }
    return frame
  }

  cancelPreview() {
    this.latestPreviewToken++
    if (!this.disposed && !this.terminalError) this.worker.postMessage({ id: 0, type: 'cancelPreview', beforeId: this.nextId - 1 })
  }

  snapshot(): Promise<RasterSnapshot> {
    return this.send('snapshot', 'snapshot')
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.latestRenderToken++
    this.worker.removeEventListener('message', this.onMessage)
    this.worker.removeEventListener('error', this.onWorkerError)
    this.worker.removeEventListener('messageerror', this.onWorkerError)
    this.worker.terminate?.()
    const error = new Error('Raster worker client was disposed')
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private send(type: 'init', expected: 'metadata', payload: RasterWorkerInit, transfer?: Transferable[], copyInputs?: boolean): Promise<RasterMetadata>
  private send(type: 'commit', expected: 'metadata', payload: RasterEditCommand): Promise<RasterMetadata>
  private send(type: 'undo' | 'redo' | 'resetHistory', expected: 'metadata'): Promise<RasterMetadata>
  private send(type: 'merge', expected: 'metadata', payload: RasterMergeCommand): Promise<RasterMetadata>
  private send(type: 'render', expected: 'render', payload: RasterRenderOptions): Promise<RasterRenderFrame | null>
  private send(type: 'snapshot', expected: 'snapshot'): Promise<RasterSnapshot>
  private send(type: RasterWorkerRequest['type'], expected: ResponseType, payload?: unknown, transfer?: Transferable[], copyInputs?: boolean): Promise<ResponseValue> {
    if (this.disposed) return Promise.reject(new Error('Raster worker client was disposed'))
    if (this.terminalError) return Promise.reject(this.terminalError)
    const id = this.nextId++
    const request = (payload === undefined ? { id, type } : { id, type, payload, ...(type === 'init' && copyInputs !== undefined ? { copyInputs } : {}) }) as RasterWorkerRequest
    return new Promise<ResponseValue>((resolve, reject) => {
      this.pending.set(id, { expected, resolve, reject })
      try {
        this.worker.postMessage(request, transfer)
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private ownedInitTransfers(payload: RasterWorkerInit): Transferable[] {
    const retained = payload.base.buffer
    const buffers = new Set<ArrayBuffer>()
    for (const pixels of [payload.overlay, payload.other, payload.edited, payload.detectedText]) {
      const buffer = pixels?.buffer
      if (buffer instanceof ArrayBuffer && buffer !== retained) buffers.add(buffer)
    }
    return [...buffers]
  }

  private onMessage = (event: MessageEvent<RasterWorkerResponse>) => {
    const response = event.data
    const pending = this.pending.get(response.id)
    if (!pending) {
      if (response.ok && response.type === 'render' && response.value) closeFrame(response.value)
      return
    }
    this.pending.delete(response.id)
    if (!response.ok) {
      pending.reject(new Error(response.error))
      return
    }
    if (response.type !== pending.expected) {
      if (response.type === 'render' && response.value) closeFrame(response.value)
      pending.reject(new Error(`Unexpected raster worker response: ${response.type}`))
      return
    }
    pending.resolve(response.value)
  }

  private onWorkerError = (event: Event) => {
    if (this.terminalError || this.disposed) return
    const message = event instanceof ErrorEvent && event.message ? event.message : 'Raster worker failed'
    this.terminalError = new Error(message)
    this.worker.terminate?.()
    for (const pending of this.pending.values()) pending.reject(this.terminalError)
    this.pending.clear()
  }
}

export function createRasterWorkerClient(options?: RasterWorkerClientOptions): RasterWorkerClient {
  return new RasterWorkerClient(options)
}
