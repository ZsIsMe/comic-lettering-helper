import type { SnapRequest, SnapMatch } from './model'

/** Port of EdgeWhite bdfbe8b8 GuideSnapAnalyzer. Scores complete segments, not ink coverage. */
export function findSnap(gray: Uint8Array, width: number, height: number, r: SnapRequest): SnapMatch | null {
  const distance = r.distance ?? 64
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
    || gray.length !== width * height || Math.abs(r.step) !== 1 || !Number.isInteger(distance) || distance < 0
    || !Number.isInteger(r.position) || !Number.isInteger(r.whiteTolerance)
    || [...r.parallel, ...r.perpendicular].some(p => !Number.isInteger(p))) return null
  const depth = r.horizontal ? height : width, span = r.horizontal ? width : height
  const lower = Math.max(1, Math.max(0, ...r.parallel.filter(p => p < r.position)) + 1)
  const upper = Math.min(depth - 1, Math.min(depth, ...r.parallel.filter(p => p > r.position)) - 1)
  if (lower > upper || r.position < lower || r.position > upper) return null
  const bounds = [0, ...[...new Set(r.perpendicular.filter(p => p > 0 && p < span))].sort((a, b) => a - b), span]
  const threshold = 255 - Math.max(0, Math.min(255, r.whiteTolerance))
  let best: SnapMatch | null = null
  for (let offset = 0; offset <= Math.min(distance, depth); offset++) {
    const p = r.position + r.step * offset
    if (p < lower || p > upper) break
    let passingCount = 0
    for (let segment = 0; segment < bounds.length - 1; segment++) {
      let pass = true
      for (let u = bounds[segment]; u < bounds[segment + 1]; u++) {
        if (gray[r.horizontal ? p * width + u : u * width + p] < threshold) { pass = false; break }
      }
      if (pass) passingCount++
    }
    if (passingCount > (best?.passingCount ?? 0)) {
      best = { position: p, passingCount, total: bounds.length - 1 }
      if (passingCount === bounds.length - 1) return best
    }
  }
  return best
}

export function grayscale(rgba: Uint8ClampedArray): Uint8Array {
  const gray = new Uint8Array(rgba.length / 4)
  for (let n = 0; n < gray.length; n++) {
    const i = n * 4, alpha = rgba[i + 3] / 255
    const r = Math.round(rgba[i] * alpha + 255 * (1 - alpha))
    const g = Math.round(rgba[i + 1] * alpha + 255 * (1 - alpha))
    const b = Math.round(rgba[i + 2] * alpha + 255 * (1 - alpha))
    gray[n] = Math.floor((299 * r + 587 * g + 114 * b) / 1000)
  }
  return gray
}
