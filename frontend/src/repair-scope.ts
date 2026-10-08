export interface RepairRect { x: number; y: number; width: number; height: number }
export interface RepairGrid { verticalGuides: number[]; horizontalGuides: number[]; selectedCells: { column: number; row: number }[] }
export type RepairRegion = RepairRect | RepairGrid
export interface RepairScope { enabled: boolean; revision: number; pages: Record<string, RepairRegion> }
export type ScopeEdge = 'left' | 'right' | 'top' | 'bottom'
export interface ScopeUpdate { revision: number; enabled: boolean; rect: RepairRegion; apply_all: boolean }
export function repairGrid(region: RepairRegion): RepairGrid {
  if ('verticalGuides' in region) return region
  const xs = [region.x, region.x + region.width].filter(p => p > 0)
  const ys = [region.y, region.y + region.height].filter(p => p > 0)
  // The outside page edge is removed by fitRepairGrid below.
  return { verticalGuides: xs, horizontalGuides: ys, selectedCells: [{ column: region.x > 0 ? 1 : 0, row: region.y > 0 ? 1 : 0 }] }
}
export function fitRepairGrid(region: RepairRegion, width: number, height: number): RepairGrid {
  if (!('verticalGuides' in region)) {
    const x = Math.min(region.x, width - 1), y = Math.min(region.y, height - 1)
    const grid = repairGrid({ x, y, width: Math.min(region.width, width - x), height: Math.min(region.height, height - y) })
    return { ...grid, verticalGuides: grid.verticalGuides.filter(p => p < width), horizontalGuides: grid.horizontalGuides.filter(p => p < height) }
  }
  const grid = repairGrid(region)
  const verticalGuides = width > 1 ? [...new Set(grid.verticalGuides.map(p => Math.min(p, width - 1)))].sort((a, b) => a - b) : []
  const horizontalGuides = height > 1 ? [...new Set(grid.horizontalGuides.map(p => Math.min(p, height - 1)))].sort((a, b) => a - b) : []
  const columns = [0, ...grid.verticalGuides].map(start => verticalGuides.filter(p => p <= start).length)
  const rows = [0, ...grid.horizontalGuides].map(start => horizontalGuides.filter(p => p <= start).length)
  const cells = new Map<string, { column: number; row: number }>()
  for (const cell of grid.selectedCells) { const next = { column: columns[cell.column], row: rows[cell.row] }; cells.set(`${next.column}:${next.row}`, next) }
  return { verticalGuides, horizontalGuides, selectedCells: [...cells.values()].sort((a, b) => a.row - b.row || a.column - b.column) }
}
export function repairRectangles(region: RepairRegion, width: number, height: number): RepairRect[] {
  if (!('verticalGuides' in region)) return [region]
  const xs = [0, ...region.verticalGuides, width], ys = [0, ...region.horizontalGuides, height]
  return region.selectedCells.map(c => ({ x: xs[c.column], y: ys[c.row], width: xs[c.column + 1] - xs[c.column], height: ys[c.row + 1] - ys[c.row] }))
}
export function toggleRepairCell(grid: RepairGrid, x: number, y: number): RepairGrid {
  const column = grid.verticalGuides.filter(p => p <= x).length, row = grid.horizontalGuides.filter(p => p <= y).length
  const selected = grid.selectedCells.some(c => c.column === column && c.row === row)
  return { ...grid, selectedCells: selected ? grid.selectedCells.filter(c => c.column !== column || c.row !== row) : [...grid.selectedCells, { column, row }] }
}
export function fullRepairRect(width: number, height: number): RepairRect { return { x: 0, y: 0, width, height } }
export function defaultRepairRect(width: number, height: number): RepairRect {
  const x = Math.min(10, Math.floor((width - 1) / 2)), y = Math.min(10, Math.floor((height - 1) / 2))
  return { x, y, width: width - x * 2, height: height - y * 2 }
}
export function moveScopeEdge(rect: RepairRect, edge: ScopeEdge, position: number, width: number, height: number): RepairRect {
  const r = { ...rect }, p = Math.round(position)
  if (edge === 'left') { r.x = Math.max(0, Math.min(rect.x + rect.width - 1, p)); r.width = rect.x + rect.width - r.x }
  if (edge === 'right') r.width = Math.max(1, Math.min(width, p) - rect.x)
  if (edge === 'top') { r.y = Math.max(0, Math.min(rect.y + rect.height - 1, p)); r.height = rect.y + rect.height - r.y }
  if (edge === 'bottom') r.height = Math.max(1, Math.min(height, p) - rect.y)
  return r
}
