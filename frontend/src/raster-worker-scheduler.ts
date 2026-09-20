import type { RasterWorkerRequest } from './raster-worker-protocol'

type RenderRequest = Extract<RasterWorkerRequest, { type: 'render' }>
/** Edits and snapshots are FIFO barriers; disposable renders never delay queued edits. */
export function createRasterScheduler(
  respond: (request: RasterWorkerRequest) => Promise<void>,
  cancel: (request: RenderRequest) => void,
) {
  const commands: RasterWorkerRequest[] = []
  let document: RenderRequest | undefined
  let preview: RenderRequest | undefined
  let running = false
  let scheduled = false

  function schedule() {
    if (running || scheduled) return
    scheduled = true
    // Yield to message delivery between jobs so queued clicks can overtake preview work.
    setTimeout(() => { scheduled = false; void drain() }, 0)
  }

  async function drain() {
    const request = commands.shift() || document || preview
    if (!request) return
    if (request === document) document = undefined
    if (request === preview) preview = undefined
    running = true
    try { await respond(request) }
    finally { running = false; if (commands.length || document || preview) schedule() }
  }

  return (request: RasterWorkerRequest) => {
    if (request.type === 'cancelPreview') {
      if (preview && preview.id <= request.beforeId) { cancel(preview); preview = undefined }
      return
    }
    if (request.type === 'render') {
      if (request.payload.previewOnly) {
        if (preview) cancel(preview)
        preview = request
      } else {
        if (document) cancel(document)
        document = request
      }
    } else {
      // A later edit invalidates renders queued against earlier UI versions.
      // Snapshots are read-only FIFO barriers, so they need not discard a frame.
      if (request.type !== 'snapshot') {
        if (document) cancel(document)
        if (preview) cancel(preview)
        document = preview = undefined
      }
      commands.push(request)
    }
    schedule()
  }
}
