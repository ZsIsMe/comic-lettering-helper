import { findSnap, grayscale } from './guide-snap'
import type { SnapRequest } from './model'
let pixels: Uint8Array | null = null
let width = 0, height = 0, key = ''
self.onmessage = (event: MessageEvent<{ kind: string; key: string; id: number; width: number; height: number; rgba: ArrayBuffer; request: SnapRequest }>) => {
  const data = event.data
  try {
    if (data.kind === 'load') {
      pixels = grayscale(new Uint8ClampedArray(data.rgba)); width = data.width; height = data.height; key = data.key
      self.postMessage({ kind: 'ready', key })
    } else if (pixels && data.key === key) {
      const start = performance.now()
      self.postMessage({ kind: 'result', key, id: data.id, match: findSnap(pixels, width, height, data.request), elapsed: performance.now() - start })
    }
  } catch (error) { self.postMessage({ kind: 'error', key: data.key, id: data.id, message: String(error) }) }
}
