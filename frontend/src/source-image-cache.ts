export interface SourceImageRequest {
  url: string
  width: number
  height: number
}

export interface SourceImageResource {
  source: CanvasImageSource
  width: number
  height: number
  close?: () => void
}

export interface SourceImageCacheStats {
  hits: number
  misses: number
  loads: number
  failures: number
  evictions: number
  entries: number
  decodedBytes: number
  queued: number
  preloading: boolean
}

export interface SourceImageCacheOptions {
  budgetBytes?: number
  decode?: (url: string) => Promise<SourceImageResource>
  extract?: (resource: SourceImageResource, width: number, height: number) => ImageData
  defer?: (task: () => void) => void
}

interface CacheEntry extends SourceImageRequest {
  key: string
  bytes: number
  lastUsed: number
  discarded: boolean
  counted: boolean
  foregroundWaiters: number
  resource?: SourceImageResource
  imageData?: ImageData
  pixels?: Promise<ImageData>
  decoded: Promise<CacheEntry>
}

const DEFAULT_BUDGET = 64 * 1024 * 1024

async function decodeSource(url: string): Promise<SourceImageResource> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Source image request failed (${response.status})`)
  const bitmap = await createImageBitmap(await response.blob())
  return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
}

function extractSource(resource: SourceImageResource, width: number, height: number): ImageData {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('Offscreen 2D canvas is unavailable')
    context.drawImage(resource.source, 0, 0, width, height)
    return context.getImageData(0, 0, width, height)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('2D canvas is unavailable')
  context.drawImage(resource.source, 0, 0, width, height)
  return context.getImageData(0, 0, width, height)
}

function validate(request: SourceImageRequest) {
  if (!request.url || !Number.isSafeInteger(request.width) || !Number.isSafeInteger(request.height) || request.width <= 0 || request.height <= 0) {
    throw new RangeError('Invalid source image request')
  }
  if (!Number.isSafeInteger(request.width * request.height * 4)) throw new RangeError('Source image is too large')
}

function keyOf(request: SourceImageRequest) {
  return `${request.width}x${request.height}:${request.url}`
}

/** Source-only decoded image cache. Revision layers must never be routed through it. */
export class SourceImageCache {
  private readonly budgetBytes: number
  private readonly decode: (url: string) => Promise<SourceImageResource>
  private readonly extract: (resource: SourceImageResource, width: number, height: number) => ImageData
  private readonly defer: (task: () => void) => void
  private readonly entries = new Map<string, CacheEntry>()
  private queue: SourceImageRequest[] = []
  private preloadActive: CacheEntry | null = null
  private pumpScheduled = false
  private generation = 0
  private clock = 0
  private decodedBytes = 0
  private counters = { hits: 0, misses: 0, loads: 0, failures: 0, evictions: 0 }

  constructor(options: SourceImageCacheOptions = {}) {
    this.budgetBytes = Math.max(0, Math.floor(options.budgetBytes ?? DEFAULT_BUDGET))
    this.decode = options.decode || decodeSource
    this.extract = options.extract || extractSource
    this.defer = options.defer || (task => { setTimeout(task, 0) })
  }

  async load(url: string, width: number, height: number): Promise<ImageData> {
    const request = { url, width, height }
    validate(request)
    const entry = this.getOrCreate(request)
    entry.foregroundWaiters++
    try {
      await entry.decoded
      const data = await this.materialize(entry)
      if (this.entries.get(entry.key) === entry) this.touch(entry)
      return data
    } finally {
      entry.foregroundWaiters--
      if (entry.discarded && entry.foregroundWaiters === 0) this.closeResource(entry)
      else this.evict()
    }
  }

  schedule(requests: readonly SourceImageRequest[]) {
    const seen = new Set<string>()
    this.queue = []
    for (const request of requests) {
      validate(request)
      const key = keyOf(request)
      if (seen.has(key)) continue
      seen.add(key)
      this.queue.push({ ...request })
    }
    this.requestPump()
  }

  clear() {
    this.generation++
    this.queue = []
    for (const entry of this.entries.values()) {
      entry.discarded = true
      entry.counted = false
      if (entry.foregroundWaiters === 0) this.closeResource(entry)
    }
    this.entries.clear()
    this.preloadActive = null
    this.pumpScheduled = false
    this.decodedBytes = 0
    this.clock = 0
    this.counters = { hits: 0, misses: 0, loads: 0, failures: 0, evictions: 0 }
  }

  stats(): Readonly<SourceImageCacheStats> {
    return Object.freeze({
      ...this.counters,
      entries: this.entries.size,
      decodedBytes: this.decodedBytes,
      queued: this.queue.length,
      preloading: this.preloadActive !== null,
    })
  }

  private getOrCreate(request: SourceImageRequest): CacheEntry {
    const key = keyOf(request)
    const existing = this.entries.get(key)
    if (existing) {
      this.counters.hits++
      this.touch(existing)
      return existing
    }
    this.counters.misses++
    this.counters.loads++
    const entry = {
      ...request,
      key,
      bytes: request.width * request.height * 4,
      lastUsed: ++this.clock,
      discarded: false,
      counted: false,
      foregroundWaiters: 0,
    } as CacheEntry
    entry.decoded = Promise.resolve().then(() => this.decode(request.url)).then(resource => {
      entry.resource = resource
      if (resource.width !== entry.width || resource.height !== entry.height) {
        throw new Error(`Source image dimensions ${resource.width}x${resource.height} do not match expected ${entry.width}x${entry.height}`)
      }
      if (entry.discarded || this.entries.get(key) !== entry) {
        if (entry.foregroundWaiters === 0) this.closeResource(entry)
        return entry
      }
      entry.counted = true
      this.decodedBytes += entry.bytes
      this.touch(entry)
      this.evict()
      return entry
    }).catch(error => {
      if (!entry.discarded) this.counters.failures++
      this.remove(entry)
      throw error
    })
    this.entries.set(key, entry)
    return entry
  }

  private materialize(entry: CacheEntry): Promise<ImageData> {
    if (entry.imageData) return Promise.resolve(entry.imageData)
    if (entry.pixels) return entry.pixels
    entry.pixels = Promise.resolve().then(() => {
      if (!entry.resource) throw new Error('Decoded source image is unavailable')
      const data = this.extract(entry.resource, entry.width, entry.height)
      this.closeResource(entry)
      entry.imageData = data
      return data
    }).catch(error => {
      if (!entry.discarded) this.counters.failures++
      this.remove(entry)
      throw error
    })
    return entry.pixels
  }

  private touch(entry: CacheEntry) {
    entry.lastUsed = ++this.clock
  }

  private remove(entry: CacheEntry, eviction = false) {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key)
    if (entry.counted) {
      this.decodedBytes = Math.max(0, this.decodedBytes - entry.bytes)
      entry.counted = false
    }
    entry.discarded = true
    if (entry.foregroundWaiters === 0) this.closeResource(entry)
    if (eviction) this.counters.evictions++
  }

  private closeResource(entry: CacheEntry) {
    if (!entry.resource) return
    entry.resource.close?.()
    entry.resource = undefined
  }

  private evict() {
    while (this.decodedBytes > this.budgetBytes) {
      let oldest: CacheEntry | undefined
      for (const entry of this.entries.values()) {
        if (!entry.counted || entry.foregroundWaiters > 0) continue
        if (!oldest || entry.lastUsed < oldest.lastUsed) oldest = entry
      }
      if (!oldest) return
      this.remove(oldest, true)
    }
  }

  private requestPump() {
    if (this.preloadActive || this.pumpScheduled || !this.queue.length) return
    const generation = this.generation
    this.pumpScheduled = true
    this.defer(() => {
      if (generation !== this.generation) return
      this.pumpScheduled = false
      this.pump()
    })
  }

  private pump() {
    if (this.preloadActive) return
    let request = this.queue.shift()
    while (request && request.width * request.height * 4 > this.budgetBytes) request = this.queue.shift()
    if (!request) return
    const entry = this.getOrCreate(request)
    this.preloadActive = entry
    void entry.decoded.catch(() => { /* A later schedule or foreground load may retry. */ }).finally(() => {
      if (this.preloadActive === entry) this.preloadActive = null
      this.requestPump()
    })
  }
}

const sourceImages = new SourceImageCache()

export const loadSourceImage = (url: string, width: number, height: number) => sourceImages.load(url, width, height)
export const scheduleSourceImagePreload = (requests: readonly SourceImageRequest[]) => sourceImages.schedule(requests)
export const clearSourceImageCache = () => sourceImages.clear()
export const getSourceImageCacheStats = () => sourceImages.stats()
