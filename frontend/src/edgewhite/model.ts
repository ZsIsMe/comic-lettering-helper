export type Axis = 'vertical' | 'horizontal'
export type Direction = 'left' | 'right' | 'up' | 'down'
export interface ActiveGuide { axis: Axis; index: number }
export interface Cell { column: number; row: number }
export interface Edit { verticalGuides: number[]; horizontalGuides: number[]; selectedCells: Cell[] }
export interface Page {
  id: string; filename: string; stem: string; width: number; height: number
  source_sha256: string; original_sha256: string; revision: number; output_revision: number; edit: Edit
}
export interface Collection { id: string; name: string; revision: number; created_at: string; updated_at: string; pages: Page[] }
export interface SnapRequest {
  horizontal: boolean; position: number; step: number; parallel: number[]; perpendicular: number[]
  whiteTolerance: number; distance?: number
}
export interface SnapMatch { position: number; passingCount: number; total: number }
