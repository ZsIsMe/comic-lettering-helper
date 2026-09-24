import { useState } from 'react'
import { Button, Input, InputNumber } from 'antd'
import type { Page } from './types'

export type PageRange = [number, number]

export function PageNavigation({ pages, current, range, onRange, onGo, reviewed, onReview, onFinishAndNext, busy, focus, onFocus }: {
  pages: Page[]; current: string; range: PageRange; onRange: (range: PageRange) => void; onGo: (id: string) => void;
  reviewed: (page: Page) => boolean; onReview: (reviewed: boolean) => void; onFinishAndNext: () => void;
  busy: boolean; focus: boolean; onFocus: (value: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false)
  const [search, setSearch] = useState('')
  const [jump, setJump] = useState<number | null>(null)
  const index = Math.max(0, pages.findIndex(page => page.id === current))
  const within = pages.slice(range[0] - 1, range[1])
  const complete = within.filter(reviewed).length
  const currentPage = pages[index]
  const currentReviewed = currentPage && reviewed(currentPage)
  const currentInRange = index + 1 >= range[0] && index + 1 <= range[1]
  const previousNumber = index + 1 > range[1] ? range[1] : index
  const nextNumber = index + 1 < range[0] ? range[0] : index + 2
  const visible = pages.map((page, pageIndex) => ({ page, number: pageIndex + 1 }))
    .filter(({ page, number }) => number >= range[0] && number <= range[1] && (!search || page.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) || String(number).includes(search)))
  const adjacent = (direction: -1 | 1) => {
    const number = direction < 0 ? previousNumber : nextNumber
    const target = pages[number - 1]
    if (target && number >= range[0] && number <= range[1]) onGo(target.id)
  }
  const changeStart = (value: number | null) => {
    if (value === null) return
    const start = Math.max(1, Math.min(pages.length, Math.round(value)))
    onRange([start, Math.max(start, range[1])])
  }
  const changeEnd = (value: number | null) => {
    if (value === null) return
    const end = Math.max(1, Math.min(pages.length, Math.round(value)))
    onRange([Math.min(range[0], end), end])
  }
  const goToNumber = () => {
    if (jump === null || !Number.isInteger(jump)) return
    const page = pages[jump - 1]
    if (page) onGo(page.id)
  }
  return <nav className="pl-page-navigation" aria-label="頁面導覽">
    <div className="pl-page-nav-main">
      <div className="pl-page-nav-position"><Button size="small" aria-label="上一頁" disabled={previousNumber < range[0]} onClick={() => adjacent(-1)}>上一頁</Button>
        <strong>{String(index + 1).padStart(2, '0')} / {pages.length}</strong>
        <Button size="small" aria-label="下一頁" disabled={nextNumber > range[1]} onClick={() => adjacent(1)}>下一頁</Button>
        <span className="pl-page-nav-name" title={currentPage?.name}>{currentPage?.name}</span>
      </div>
      <div className="pl-page-nav-actions"><span className="pl-page-nav-progress">範圍 {range[0]}–{range[1]} · 完成 {complete}/{within.length}</span>
        <Button size="small" disabled={busy || !currentPage || !currentInRange} onClick={() => onReview(!currentReviewed)}>{currentReviewed ? '取消完成' : '標記完成'}</Button>
        <Button size="small" type="primary" disabled={busy || !currentPage} onClick={onFinishAndNext}>保存並下一未完成</Button>
        <Button size="small" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '收起頁碼' : '頁碼與範圍'}</Button>
        <Button size="small" aria-pressed={focus} onClick={() => onFocus(!focus)}>{focus ? '退出專注' : '專注模式'}</Button>
      </div>
    </div>
    {expanded && <div className="pl-page-nav-expanded">
      <div className="pl-page-nav-controls">
        <label>從第 <InputNumber aria-label="範圍起始頁" min={1} max={pages.length} precision={0} value={range[0]} onChange={changeStart} /> 頁</label>
        <label>到第 <InputNumber aria-label="範圍結束頁" min={1} max={pages.length} precision={0} value={range[1]} onChange={changeEnd} /> 頁</label>
        <Button size="small" onClick={() => onRange([1, pages.length])}>全部頁面</Button>
        <label>跳至 <InputNumber aria-label="跳轉頁碼" min={1} max={pages.length} precision={0} value={jump} onChange={setJump} onPressEnter={goToNumber} /> 頁</label>
        <Button size="small" onClick={goToNumber}>跳轉</Button>
        <Input className="pl-page-nav-search" aria-label="搜尋頁碼或檔名" placeholder="搜尋頁碼或檔名" allowClear value={search} onChange={event => setSearch(event.target.value)} />
      </div>
      <div className="pl-page-nav-list">
        {visible.map(({ page, number }) => <button type="button" key={page.id} className={`${current === page.id ? 'active' : ''} ${reviewed(page) ? 'reviewed' : ''}`} aria-current={current === page.id ? 'page' : undefined} title={page.name} onClick={() => onGo(page.id)}><span>{String(number).padStart(2, '0')}</span><span>{page.name}</span><span aria-label={reviewed(page) ? '已完成' : '未完成'}>{reviewed(page) ? '✓' : '·'}</span></button>)}
        {!visible.length && <span className="pl-muted">沒有符合的頁面</span>}
      </div>
    </div>}
  </nav>
}
