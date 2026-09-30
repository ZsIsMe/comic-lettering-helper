import type { Item } from './types'
import { displayText } from './display-text'

type DisplayRun = { text: string; upright: boolean }

/** Keep ordinary text together so font shaping and ligatures cross character boundaries. */
export function displayRuns(text: string, orientation: Item['orientation']): DisplayRun[] {
  const displayed = displayText(text) || '\u200b'
  if (orientation !== 'vertical') return [{ text: displayed, upright: false }]
  return displayed.split(/([“”]+)/).filter(Boolean).map(text => ({ text, upright: /^[“”]+$/.test(text) }))
}

/** Shared by hidden measurements; no transformed text is written back to items. */
export function setDisplayText(node: HTMLElement, text: string, orientation: Item['orientation']) {
  const runs = displayRuns(text, orientation)
  if (!runs.some(run => run.upright)) { node.textContent = runs[0].text; return }
  node.textContent = ''
  for (const run of runs) {
    if (!run.upright) node.appendChild(document.createTextNode(run.text))
    else {
      const span = document.createElement('span')
      span.style.textOrientation = 'upright'
      span.textContent = run.text
      node.appendChild(span)
    }
  }
}
