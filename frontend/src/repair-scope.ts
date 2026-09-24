export interface RepairRect { x: number; y: number; width: number; height: number }
export interface RepairScope { enabled: boolean; revision: number; pages: Record<string, RepairRect> }
export type ScopeEdge = 'left' | 'right' | 'top' | 'bottom'
export interface ScopeUpdate { revision: number; enabled: boolean; rect: RepairRect; apply_all: boolean }
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
