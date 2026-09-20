/** Display-only geometry. Never rasterize a mask on the input thread. */
export type InteractionPoint = { x: number; y: number }
export type InteractionShape =
  | { kind: 'rectangle'; start: InteractionPoint; end: InteractionPoint }
  | { kind: 'brush'; points: InteractionPoint[]; size: number }
  | { kind: 'polygon'; points: InteractionPoint[]; closed?: boolean }
  | { kind: 'magic'; point: InteractionPoint }
export interface InteractionOutline { shape: InteractionShape; color: string }
const ns = 'http://www.w3.org/2000/svg'
export function drawInteraction(svg: SVGSVGElement, outlines: InteractionOutline[], zoom: number,
  clip?: { x: number; y: number; width: number; height: number }, cursor?: { point: InteractionPoint; size: number }) {
  const nodes: SVGElement[] = []
  const path = (d: string, color: string, brush?: number) => {
    const node = document.createElementNS(ns, 'path')
    node.setAttribute('d', d); node.setAttribute('fill', 'none'); node.setAttribute('stroke', color)
    node.setAttribute('stroke-width', String(brush ?? 2 / zoom))
    node.setAttribute('stroke-linecap', 'round'); node.setAttribute('stroke-linejoin', 'round')
    if (brush) node.setAttribute('opacity', '.55')
    else node.setAttribute('stroke-dasharray', `${5 / zoom} ${4 / zoom}`)
    nodes.push(node)
  }
  if (clip) path(`M${clip.x},${clip.y}h${clip.width}v${clip.height}h${-clip.width}Z`, '#168cff')
  for (const { shape, color } of outlines) {
    if (shape.kind === 'rectangle') {
      path(`M${shape.start.x},${shape.start.y}L${shape.end.x},${shape.start.y}L${shape.end.x},${shape.end.y}L${shape.start.x},${shape.end.y}Z`, color)
    } else if (shape.kind === 'magic') {
      const { x, y } = shape.point, r = 7 / zoom
      path(`M${x-r},${y}h${2*r}M${x},${y-r}v${2*r}`, color)
    } else if (shape.points.length) {
      const d = shape.points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ')
      path(d + (shape.kind === 'polygon' && shape.closed ? 'Z' : shape.points.length === 1 ? 'l0.01,0' : ''), color, shape.kind === 'brush' ? shape.size : undefined)
    }
  }
  if (cursor) {
    const node = document.createElementNS(ns, 'circle')
    node.setAttribute('cx', String(cursor.point.x)); node.setAttribute('cy', String(cursor.point.y))
    node.setAttribute('r', String(cursor.size / 2)); node.setAttribute('fill', 'none')
    node.setAttribute('stroke', '#168cff'); node.setAttribute('stroke-width', String(1.5 / zoom)); nodes.push(node)
  }
  svg.replaceChildren(...nodes)
}
