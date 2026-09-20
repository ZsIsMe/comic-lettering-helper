export type CaretPoint = { node: Node; offset: number }
type TextMap = { text: string; points: CaretPoint[][] }

// Keep the browser's editable DOM (and native undo/IME) intact. Both saving and
// navigation must use the same treatment of DIV/P/BR and the final caret filler.
export function readEditableText(root: HTMLElement) {
  function read(node: Node): TextMap {
    const children = [...node.childNodes]
    const block = (child: Node) => ['DIV', 'P'].includes(child.nodeName)
    const result: TextMap = { text: '', points: [[{ node, offset: 0 }]] }
    children.forEach((child, index) => {
      const last = index === children.length - 1
      let part: TextMap
      if (child.nodeType === Node.TEXT_NODE) {
        let text = child.textContent || ''
        if (last || block(children[index + 1])) text = text.replace(/\n$/, '')
        part = { text, points: Array.from({ length: text.length + 1 }, (_, offset) => [{ node: child, offset }]) }
        // The extra newline only keeps a trailing empty column editable.
        if (text.length < (child.textContent || '').length) part.points.at(-1)!.push({ node: child, offset: text.length + 1 })
      } else if (child.nodeName === 'BR') {
        part = { text: last ? '' : '\n', points: [[{ node, offset: index }]] }
        if (!last) part.points.push([{ node, offset: index + 1 }])
      } else part = read(child)
      if (last && !part.text && (child.nodeType === Node.TEXT_NODE || child.nodeName === 'BR')) {
        result.points.at(-1)!.push(...part.points[0], { node, offset: index + 1 })
        return
      }
      if (index > 0 && (block(child) || block(children[index - 1]))) {
        result.text += '\n'
        result.points.push(part.points[0])
      } else {
        result.points[result.points.length - 1] = [...part.points[0], ...result.points.at(-1)!]
      }
      result.text += part.text
      result.points.push(...part.points.slice(1))
      result.points.at(-1)!.push({ node, offset: index + 1 })
    })
    return result
  }
  const map = read(root)
  // Normalize imported CRLF without losing the UTF-16 DOM offset mapping.
  for (let i = 0; i < map.text.length; i++) {
    if (map.text[i] !== '\r') continue
    const width = map.text[i + 1] === '\n' ? 2 : 1
    map.text = map.text.slice(0, i) + '\n' + map.text.slice(i + width)
    if (width === 2) map.points.splice(i + 1, 1)
  }
  const offsets = new Map<Node, Map<number, number>>()
  map.points.forEach((aliases, index) => aliases.forEach(({ node, offset }) => {
    if (!offsets.has(node)) offsets.set(node, new Map())
    offsets.get(node)!.set(offset, index)
  }))
  return {
    text: map.text,
    pointAt: (offset: number) => map.points[Math.max(0, Math.min(offset, map.text.length))][0],
    offsetAt(node: Node, offset: number) {
      const exact = offsets.get(node)?.get(offset)
      if (exact !== undefined) return exact
      // A browser may report an element boundary instead of a text-node offset.
      const range = root.ownerDocument.createRange()
      range.setStart(node, offset); range.collapse(true)
      let position = 0
      for (let i = 0; i < map.points.length; i++) {
        if (map.points[i].some(point => range.comparePoint(point.node, point.offset) <= 0)) position = i
      }
      return position
    },
  }
}
