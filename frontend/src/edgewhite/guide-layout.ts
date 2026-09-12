import type { ActiveGuide, Axis, Edit } from './model'
export function positions(edit: Edit, axis: Axis) { return axis === 'vertical' ? edit.verticalGuides : edit.horizontalGuides }
export function moveGuide(edit: Edit, active: ActiveGuide, position: number, width: number, height: number): Edit {
  const values = [...positions(edit, active.axis)]
  if (values[active.index] === undefined) return edit
  const dimension = active.axis === 'vertical' ? width : height
  const lower = active.index > 0 ? values[active.index - 1] + 1 : 1
  const upper = active.index + 1 < values.length ? values[active.index + 1] - 1 : dimension - 1
  values[active.index] = Math.min(upper, Math.max(lower, Math.round(position)))
  return { ...edit, [active.axis === 'vertical' ? 'verticalGuides' : 'horizontalGuides']: values }
}
export function addGuide(edit: Edit, axis: Axis, position: number, dimension: number): { edit: Edit; active: ActiveGuide } | null {
  const values = [...positions(edit, axis)]
  if (dimension <= 2 || values.length >= 128) return null
  const occupied = new Set(values), base = Math.min(dimension - 1, Math.max(1, Math.round(position)))
  let found: number | undefined
  for (let d = 0; d < dimension && found === undefined; d++) {
    if (base - d >= 1 && !occupied.has(base - d)) found = base - d
    else if (base + d < dimension && !occupied.has(base + d)) found = base + d
  }
  if (found === undefined) return null
  values.push(found); values.sort((a, b) => a - b)
  return { edit: { ...edit, [axis === 'vertical' ? 'verticalGuides' : 'horizontalGuides']: values, selectedCells: [] }, active: { axis, index: values.indexOf(found) } }
}
export function removeGuide(edit: Edit, active: ActiveGuide): Edit {
  return { ...edit, [active.axis === 'vertical' ? 'verticalGuides' : 'horizontalGuides']: positions(edit, active.axis).filter((_, i) => i !== active.index), selectedCells: [] }
}
export function rectangles(edit: Edit, width: number, height: number) {
  const xs = [0, ...edit.verticalGuides, width], ys = [0, ...edit.horizontalGuides, height]
  return edit.selectedCells.map(c => ({ x: xs[c.column], y: ys[c.row], width: xs[c.column + 1] - xs[c.column], height: ys[c.row + 1] - ys[c.row] }))
}
export function toggleCell(edit: Edit, x: number, y: number): Edit {
  if (!edit.verticalGuides.length && !edit.horizontalGuides.length) return edit
  const column = edit.verticalGuides.filter(p => p <= x).length, row = edit.horizontalGuides.filter(p => p <= y).length
  const selected = edit.selectedCells.some(c => c.column === column && c.row === row)
  return { ...edit, selectedCells: selected ? edit.selectedCells.filter(c => c.column !== column || c.row !== row) : [...edit.selectedCells, { column, row }] }
}
