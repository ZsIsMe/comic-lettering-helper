export interface LocalEditRect { x: number; y: number; width: number; height: number }

/** Clamp endpoints, preserving the part of the requested rectangle inside the page. */
export function clampLocalRect(rect: LocalEditRect, pageWidth: number, pageHeight: number): LocalEditRect {
  const integer = (value: number, fallback: number) => Number.isFinite(value) ? Math.round(value) : fallback
  const left = integer(rect.x, 0); const top = integer(rect.y, 0)
  const right = left + Math.max(1, integer(rect.width, 1))
  const bottom = top + Math.max(1, integer(rect.height, 1))
  const x = Math.max(0, Math.min(pageWidth - 1, left))
  const y = Math.max(0, Math.min(pageHeight - 1, top))
  return { x, y, width: Math.max(x + 1, Math.min(pageWidth, right)) - x,
    height: Math.max(y + 1, Math.min(pageHeight, bottom)) - y }
}

/** Match the desktop editor: shrink both axes equally without crossing any edge. */
export function offsetLocalRect(rect: LocalEditRect, amount: number, pageWidth: number, pageHeight: number): LocalEditRect {
  const delta = amount >= 0 ? amount : -Math.min(-amount,
    Math.max(0, Math.floor((rect.width - 1) / 2)), Math.max(0, Math.floor((rect.height - 1) / 2)))
  return clampLocalRect({ x: rect.x - delta, y: rect.y - delta,
    width: rect.width + delta * 2, height: rect.height + delta * 2 }, pageWidth, pageHeight)
}
