// Native cursors follow the pointer without waiting for a canvas/Worker frame.
// The small cross marks the exact selection origin; the tool icon sits beside it.
function selectionCursor(icon: string) {
  const path = `M6 2v8M2 6h8 ${icon}`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${path}" stroke="white" stroke-width="4"/><path d="${path}" stroke="#151515" stroke-width="1.6"/></g></svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 6 6, crosshair`
}

const cursors: Record<string, string> = {
  rectangle: selectionCursor('M14 13h4m4 0h5v4m0 5v5h-5m-4 0h-4v-5m0-5v-4'),
  brush: selectionCursor('M17 22l9-12 3 3-10 11Z M17 22c-5-1-2 6-7 6 5 2 10 0 9-4'),
  magic: selectionCursor('M15 27l11-11 3 3-11 11Z M19 23l3 3 M18 10v5m-2.5-2.5h5 M27 4v6m-3-3h6'),
  lasso: selectionCursor('M16 24c-10-8 1-15 10-10 10 7-2 16-9 10-5-4-5 6 0 6'),
  local: selectionCursor('M14 18v-5h5m3 0h5v5m0 4v5h-5m-3 0h-5v-5'),
}

export function rasterCursor(tool: string) {
  return tool === 'pan' ? 'grab' : cursors[tool] || 'crosshair'
}
