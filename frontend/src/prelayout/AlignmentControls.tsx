import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from 'antd'
import { alignSelection, type AlignmentOperation } from './alignment'
import type { EditorState } from './editor-state'
import type { Selection } from './geometry'
import { measurePage } from './layout-review'

const alignment: [AlignmentOperation, string][] = [['left', '靠左'], ['center-x', '水平置中'], ['right', '靠右'], ['top', '靠上'], ['center-y', '垂直置中'], ['bottom', '靠下']]
const distribution: [AlignmentOperation, string][] = [['gap-x', '水平等間距'], ['gap-y', '垂直等間距'], ['centers-x', '水平中心等距'], ['centers-y', '垂直中心等距']]

export function AlignmentControls({ controller, selection, pageLabel, disabled = false, onApplied }: {
  controller: EditorState; selection: Selection; pageLabel: string; disabled?: boolean; onApplied?: () => void
}) {
  const [pending, setPending] = useState(false), [notice, setNotice] = useState('')
  const latest = useRef({ selection, disabled }), mounted = useRef(true)
  useLayoutEffect(() => { latest.current = { selection, disabled } }, [selection, disabled])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  async function run(operation: AlignmentOperation) {
    if (pending || disabled) return
    setPending(true); setNotice('')
    try {
      const result = await alignSelection(controller, () => latest.current.selection, operation, measurePage,
        () => mounted.current && !latest.current.disabled)
      if (!mounted.current) return
      if (result === 'applied') { onApplied?.(); setNotice('已套用，可撤銷。') }
      else setNotice(result === 'stale' ? '量測期間文字或選取已變更，請重新操作。' : '位置已符合設定。')
    } catch (error) { if (mounted.current) setNotice((error as Error).message) }
    finally { if (mounted.current) setPending(false) }
  }
  const buttons = (options: [AlignmentOperation, string][], minimum: number) => options.map(([operation, label]) => <Button key={operation} size="small"
    disabled={disabled || pending || selection.ids.length < minimum} title={`${label} · 至少 ${minimum} 框`}
    onMouseDown={event => event.preventDefault()} onClick={() => void run(operation)}>{label}</Button>)
  return <details open className="pl-alignment-controls"><summary>對齊／分佈</summary>
    <p className="pl-muted">僅作用於{pageLabel}所選 {selection.ids.length} 框；以選取外框為基準。</p>
    <div className="pl-alignment-grid">{buttons(alignment, 2)}</div>
    <p className="pl-muted">分佈至少 3 框，固定兩端。等間距：框間空隙相同；中心等距：中心距離相同。</p>
    <div className="pl-distribution-grid">{buttons(distribution, 3)}</div>
    <span className="pl-alignment-notice" role="status">{pending ? '正在量測文字框…' : notice}</span>
  </details>
}
