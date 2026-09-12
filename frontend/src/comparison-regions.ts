export interface CompareRegion { x: number; y: number; width: number; height: number }

// Coarse connected components group nearby repair pixels without scanning empty
// full-resolution neighbourhoods. Only the exact candidate masks authorize edits.
export function comparisonRegions(width: number, height: number, masks: Uint8ClampedArray[], assignment: Uint16Array): CompareRegion[] {
  const tile = 24, cols = Math.ceil(width / tile), rows = Math.ceil(height / tile)
  const occupied = new Uint8Array(cols * rows)
  for (let n = 0; n < width * height; n++) if (assignment[n] > 1 || masks.some(mask => mask[n * 4] >= 128)) occupied[Math.floor(n / width / tile) * cols + Math.floor(n % width / tile)] = 1
  const regions: CompareRegion[] = []
  for (let start = 0; start < occupied.length; start++) {
    if (!occupied[start]) continue
    const queue = [start]; occupied[start] = 0
    let x0 = cols, y0 = rows, x1 = 0, y1 = 0
    for (let head = 0; head < queue.length; head++) {
      const at = queue[head], x = at % cols, y = Math.floor(at / cols)
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, next = ny * cols + nx
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows && occupied[next]) { occupied[next] = 0; queue.push(next) }
      }
    }
    regions.push({ x: x0 * tile, y: y0 * tile, width: Math.min(width, (x1 + 1) * tile) - x0 * tile, height: Math.min(height, (y1 + 1) * tile) - y0 * tile })
  }
  // Merge overlapping bounding boxes, so one region cannot silently edit another.
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i], b = regions[j]
    if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y)
      regions[i] = { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y }
      regions.splice(j, 1); i = -1; break
    }
  }
  return regions.sort((a,b) => a.y - b.y || a.x - b.x)
}

export function adoptComparisonRegion(current: Uint16Array, width: number, height: number, region: CompareRegion, code: number, masks: Map<number, Uint8ClampedArray>): Uint16Array {
  const next = current.slice(), allowed = masks.get(code)
  for (let y = Math.max(0, region.y); y < Math.min(height, region.y + region.height); y++) for (let x = Math.max(0, region.x); x < Math.min(width, region.x + region.width); x++) {
    const n = y * width + x
    if (code === 1 ? current[n] > 1 || [...masks.values()].some(mask => mask[n * 4] >= 128) : allowed && allowed[n * 4] >= 128) next[n] = code
  }
  return next
}
