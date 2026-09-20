/** Binary, immutable selection operations matching the desktop editor's 8-connected masks. */
export type SelectionOperation = 'add' | 'subtract' | 'local_intersect' | 'selection_inner' | 'add_selection_inner'
export type SelectionPoint = { x: number; y: number }

function checkSize(width: number, height: number, ...lengths: number[]): number {
  const size = width * height
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0 || lengths.some(length => length !== size)) {
    throw new RangeError('Selection dimensions do not match the image')
  }
  return size
}

function visitNeighbors(index: number, width: number, height: number, visit: (next: number) => void) {
  const x = index % width, y = Math.floor(index / width)
  for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
    for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
      const next = yy * width + xx
      if (next !== index) visit(next)
    }
  }
}

function prefixOffsetMask(mask: Uint8Array, width: number, height: number, radius: number, dilate: boolean, preciseDisk: boolean): Uint8Array {
  const result = new Uint8Array(mask.length)
  if (!dilate) result.fill(1)
  const sums = new Uint32Array((width + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1)
    for (let x = 0; x < width; x++) sums[row + x + 1] = sums[row + x] + Number(mask[y * width + x] > 0)
  }
  for (let dy = -radius; dy <= radius; dy++) {
    const span = Math.sqrt(radius * radius - dy * dy)
    const half = preciseDisk ? Math.floor(span) : Math.round(span)
    for (let y = Math.max(0, -dy); y < Math.min(height, height - dy); y++) {
      const row = (y + dy) * (width + 1)
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (dilate ? result[i] : !result[i]) continue
        const left = Math.max(0, x - half), right = Math.min(width, x + half + 1)
        const count = sums[row + right] - sums[row + left]
        if (dilate ? count > 0 : count < right - left) result[i] = dilate ? 1 : 0
      }
    }
  }
  return result
}

/** OpenCV ellipse morphology. Outside pixels are neutral (the desktop's default border). */
function offsetMask(mask: Uint8Array, width: number, height: number, offset: number, preciseDisk = false): Uint8Array {
  const radius = Math.min(Math.max(width, height), Math.abs(Math.trunc(offset)))
  if (!radius || !mask.some(Boolean)) return mask.slice()
  const dilate = offset > 0
  // Alternating manga screentones can produce nearly one run per two pixels.
  // Difference-interval bookkeeping is slower than prefix queries at that density.
  const runLimit = Math.floor(mask.length / 3)
  let runs = 0
  for (let y = 0; y < height && runs <= runLimit; y++) {
    const row = y * width
    let inside = false
    for (let x = 0; x < width; x++) {
      const selected = dilate ? mask[row + x] > 0 : mask[row + x] === 0
      if (selected && !inside) runs++
      inside = selected
    }
  }
  if (runs > runLimit) return prefixOffsetMask(mask, width, height, radius, dilate, preciseDisk)
  // Each source-row run expands to one interval per ellipse row. Difference rows
  // union those intervals in O(pixels + runs * radius), instead of testing every
  // output pixel for every vertical kernel offset. Erosion is the complement of
  // dilating in-bounds zeroes, which preserves the desktop's neutral border.
  const stride = width + 1
  const differences = new Int32Array(stride * height)
  const halves = new Int32Array(radius * 2 + 1)
  for (let dy = -radius; dy <= radius; dy++) {
    const span = Math.sqrt(radius * radius - dy * dy)
    halves[dy + radius] = preciseDisk ? Math.floor(span) : Math.round(span)
  }
  for (let sourceY = 0; sourceY < height; sourceY++) {
    const sourceRow = sourceY * width
    let x = 0
    while (x < width) {
      while (x < width && (dilate ? mask[sourceRow + x] === 0 : mask[sourceRow + x] > 0)) x++
      if (x >= width) break
      const start = x++
      while (x < width && (dilate ? mask[sourceRow + x] > 0 : mask[sourceRow + x] === 0)) x++
      for (let dy = Math.max(-radius, sourceY - height + 1); dy <= Math.min(radius, sourceY); dy++) {
        const targetY = sourceY - dy
        const differenceRow = targetY * stride
        const half = halves[dy + radius]
        const left = Math.max(0, start - half)
        const right = Math.min(width, x + half)
        differences[differenceRow + left]++
        differences[differenceRow + right]--
      }
    }
  }
  const result = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    const differenceRow = y * stride, resultRow = y * width
    let active = 0
    for (let x = 0; x < width; x++) {
      active += differences[differenceRow + x]
      result[resultRow + x] = Number(dilate ? active > 0 : active === 0)
    }
  }
  return result
}

function selectionHoles(selection: Uint8Array, width: number, height: number): Uint8Array {
  const exterior = new Uint8Array(selection.length)
  const queue = new Int32Array(selection.length)
  let head = 0, tail = 0
  const enqueue = (i: number) => {
    if (!selection[i] && !exterior[i]) { exterior[i] = 1; queue[tail++] = i }
  }
  if (!width || !height) return exterior
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x) }
  for (let y = 1; y < height - 1; y++) { enqueue(y * width); enqueue(y * width + width - 1) }
  while (head < tail) visitNeighbors(queue[head++], width, height, enqueue)
  return selection.map((value, i) => Number(!value && !exterior[i]))
}

export function combineSelection(current: Uint8Array, selection: Uint8Array, width: number, height: number, op: SelectionOperation, offset = 0): Uint8Array {
  const size = checkSize(width, height, current.length, selection.length)
  const result = current.map(value => Number(value > 0))
  if (op === 'local_intersect') {
    const touched = new Uint8Array(size), queue = new Int32Array(size)
    let head = 0, tail = 0
    const enqueue = (i: number) => {
      if (current[i] && !touched[i]) { touched[i] = 1; queue[tail++] = i }
    }
    for (let i = 0; i < size; i++) if (current[i] && selection[i]) enqueue(i)
    while (head < tail) visitNeighbors(queue[head++], width, height, enqueue)
    const intersection = touched.map((value, i) => Number(value > 0 && selection[i] > 0))
    const local = offsetMask(intersection, width, height, offset)
    for (let i = 0; i < size; i++) result[i] = Number((result[i] && !touched[i]) || local[i])
  } else if (op === 'selection_inner' || op === 'add_selection_inner') {
    const holes = selectionHoles(selection, width, height)
    for (let i = 0; i < size; i++) if (holes[i] || (op === 'add_selection_inner' && selection[i])) result[i] = 1
  } else {
    for (let i = 0; i < size; i++) if (selection[i]) result[i] = op === 'subtract' ? 0 : 1
  }
  return result
}

/** Fixed seed colour range, not a drifting neighbour-to-neighbour colour range. Alpha is ignored. */
export function magicSelection(rgba: Uint8ClampedArray, width: number, height: number, x: number, y: number, tolerance: number, expand: number): Uint8Array {
  const size = checkSize(width, height, rgba.length / 4)
  const result = new Uint8Array(size)
  x = Math.floor(x); y = Math.floor(y)
  if (x < 0 || x >= width || y < 0 || y >= height || !Number.isFinite(x + y)) return result
  const seed = (y * width + x) * 4
  const limit = Math.max(0, Math.min(255, tolerance))
  if (Number.isNaN(limit)) return result
  const r0 = rgba[seed] - limit, r1 = rgba[seed] + limit
  const g0 = rgba[seed + 1] - limit, g1 = rgba[seed + 1] + limit
  const b0 = rgba[seed + 2] - limit, b1 = rgba[seed + 2] + limit
  const seen = new Uint8Array(size), queue = new Int32Array(size)
  let head = 0, tail = 0
  const start = y * width + x
  seen[start] = 1; result[start] = 1; queue[tail++] = start
  while (head < tail) {
    const current = queue[head++]
    const currentX = current % width, currentY = Math.floor(current / width)
    const left = Math.max(0, currentX - 1), right = Math.min(width - 1, currentX + 1)
    for (let yy = Math.max(0, currentY - 1); yy <= Math.min(height - 1, currentY + 1); yy++) {
      const row = yy * width
      for (let xx = left; xx <= right; xx++) {
        const next = row + xx
        if (seen[next]) continue
        seen[next] = 1
        const p = next * 4
        if (rgba[p] >= r0 && rgba[p] <= r1 && rgba[p + 1] >= g0 && rgba[p + 1] <= g1 && rgba[p + 2] >= b0 && rgba[p + 2] <= b1) {
          result[next] = 1
          queue[tail++] = next
        }
      }
    }
  }
  return expand > 0 ? offsetMask(result, width, height, expand, expand > 16) : result
}

/** Rectangle includes both endpoint pixels, including a one-pixel click. */
export function rectangleSelection(x1: number, y1: number, x2: number, y2: number, width: number, height: number): Uint8Array {
  const result = new Uint8Array(checkSize(width, height))
  if (![x1, y1, x2, y2].every(Number.isFinite)) return result
  const left = Math.max(0, Math.floor(Math.min(x1, x2))), right = Math.min(width - 1, Math.floor(Math.max(x1, x2)))
  const top = Math.max(0, Math.floor(Math.min(y1, y2))), bottom = Math.min(height - 1, Math.floor(Math.max(y1, y2)))
  if (left > right || top > bottom) return result
  for (let y = top; y <= bottom; y++) result.fill(1, y * width + left, y * width + right + 1)
  return result
}

/** Even/odd scanline fill with integer endpoint edges, analogous to the desktop's fillPoly. */
export function polygonSelection(points: SelectionPoint[], width: number, height: number): Uint8Array {
  const result = new Uint8Array(checkSize(width, height))
  if (points.length < 3 || points.some(p => !Number.isFinite(p.x + p.y))) return result
  const vertices = points.map(p => ({ x: Math.floor(p.x), y: Math.floor(p.y) }))
  const minY = Math.max(0, Math.min(...vertices.map(p => p.y))), maxY = Math.min(height - 1, Math.max(...vertices.map(p => p.y)))
  for (let y = minY; y <= maxY; y++) {
    const crossings: number[] = []
    for (let i = 0; i < vertices.length; i++) {
      const a = vertices[i], b = vertices[(i + 1) % vertices.length]
      if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) crossings.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y))
    }
    crossings.sort((a, b) => a - b)
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const left = Math.max(0, Math.ceil(crossings[i])), right = Math.min(width - 1, Math.floor(crossings[i + 1]))
      if (right >= left) result.fill(1, y * width + left, y * width + right + 1)
    }
  }
  for (let i = 0; i < vertices.length; i++) {
    const a = vertices[i], b = vertices[(i + 1) % vertices.length]
    let x = a.x, y = a.y
    const dx = Math.abs(b.x - x), dy = -Math.abs(b.y - y), sx = x < b.x ? 1 : -1, sy = y < b.y ? 1 : -1
    let error = dx + dy
    while (true) {
      if (x >= 0 && x < width && y >= 0 && y < height) result[y * width + x] = 1
      if (x === b.x && y === b.y) break
      const twice = 2 * error
      if (twice >= dy) { error += dy; x += sx }
      if (twice <= dx) { error += dx; y += sy }
    }
  }
  return result
}
