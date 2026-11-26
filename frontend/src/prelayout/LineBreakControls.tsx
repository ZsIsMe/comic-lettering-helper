import { useId, useMemo, useState } from 'react'
import { Button, Space } from 'antd'
import type { EditorState } from './editor-state'
import type { Selection } from './geometry'
import { applyLineBreaks, createLineBreakPreview, lineBreakOptions, lineBreakSelectionNotice, normalizeLineBreaks, singleLineBreakItem, type LineBreakPreview } from './line-breaks'

export function LineBreakControls({ controller, selection, preview, disabled, disabledReason, onPreview, onApplied }: {
  controller: EditorState; selection: Selection; preview: LineBreakPreview | null; disabled: boolean;
  disabledReason?: string;
  onPreview: (preview: LineBreakPreview | null) => void; onApplied: () => void
}) {
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState(true)
  const panelId = useId()
  const selected = singleLineBreakItem(controller, selection)
  const item = selected?.item, suggestions = selected?.data.line_break_suggestions, measure = selected?.data.measure
  const { options, notice } = useMemo(() => item ? lineBreakOptions(item, { line_break_suggestions: suggestions, measure }) : { options: [], notice: '' }, [item, suggestions, measure])
  const currentText = item && normalizeLineBreaks(item.text)
  return <section className="pl-line-break-controls" aria-label="調整斷句">
    <Button className="pl-line-break-trigger" aria-label="調整斷句" type="primary" block aria-expanded={expanded} aria-controls={panelId} onClick={() => {
      onPreview(null); setError(''); setExpanded(value => !value)
    }}>調整斷句</Button>
    {expanded && <div id={panelId}>
    {options.length > 0 && <><p className="pl-muted">點選版本預覽，採用後才保存。</p>
      <div className="pl-line-break-options">{options.map(option => <button key={option.text} type="button" disabled={disabled || controller.editing} aria-pressed={preview ? preview.text === option.text : normalizeLineBreaks(option.text) === currentText}
        onClick={() => {
          try { onPreview(createLineBreakPreview(controller, selection, option.text)); setError('') }
          catch (error) { setError((error as Error).message) }
        }}><span>{option.label}</span>{normalizeLineBreaks(option.text) === currentText && <small className="pl-line-break-current">目前</small>}<pre>{option.text}</pre></button>)}</div>
      <Space wrap><Button size="small" type="primary" disabled={disabled || !preview || preview.text === selected?.item.text} onClick={() => {
        if (!preview) return
        try { if (applyLineBreaks(controller, selection, preview)) onApplied(); onPreview(null); setError('') }
        catch (error) { onPreview(null); setError((error as Error).message) }
      }}>採用此版</Button><Button size="small" disabled={!preview} onClick={() => { onPreview(null); setError('') }}>取消預覽</Button></Space>
    </>}
    <p className="pl-muted" role="status">{item ? notice : lineBreakSelectionNotice(controller, selection)}</p>
    {disabled && <p className="pl-muted">{disabledReason || '目前暫停候選預覽與採用，請待其他操作完成。'}</p>}
    {controller.editing && <p className="pl-muted">請先完成畫布文字編輯，再預覽斷句。</p>}
    {error && <p role="alert">{error}</p>}
    </div>}
  </section>
}
