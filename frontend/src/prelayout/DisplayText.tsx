import type { Item } from './types'
import { displayRuns } from './display-runs'

export function DisplayText({ text, orientation }: Pick<Item, 'text' | 'orientation'>) {
  return <>{displayRuns(text, orientation).map((run, index) => run.upright
    ? <span key={index} style={{ textOrientation: 'upright' }}>{run.text}</span>
    : run.text)}</>
}
