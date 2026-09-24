import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { EditorState } from './editor-state'
import type { PageData, Project } from './types'
import { applyPagePatches, registerPrelayoutTools, type PrelayoutHost } from './webmcp'
import { cropRegions, measurePage } from './layout-review'
import { LayoutReview } from './LayoutReview'

type Options = {
  controller: EditorState; project: Project; current: string; busy: boolean; fontReady: boolean;
  interacting: RefObject<boolean>; range: [number, number]; compare: boolean; difference: boolean;
  zoom: number; focus: boolean; clean: boolean;
  refreshProject: () => Promise<void>; go: (id: string) => void; setCompare: (value: boolean) => void; setDifference: (value: boolean) => void;
  setZoom: (value: number) => void; setFocus: (value: boolean) => void;
}
type Review = { reviewId: string; before: PageData; after: PageData; regions: number[][]; view: 'edited' | 'original' | 'before' | 'detail'; region?: number; includeOriginal: boolean }
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 25))

export function usePrelayoutAgent(options: Options) {
  const latest = useRef(options)
  useLayoutEffect(() => { latest.current = options })
  const [review, setReview] = useState<Review | null>(null)
  const controller = options.controller
  const hostRef = useRef<PrelayoutHost | null>(null)
  useEffect(() => {
    let alive = true, locked = false
    const identities = new WeakMap<object, string>()
    const tokenFor = (state: object & { version: number; data: PageData }, id: string) => {
      if (!identities.has(state)) identities.set(state, crypto.randomUUID())
      return `${identities.get(state)}:${id}:${state.version}:${state.data.reviewed_revision ?? 'pending'}:${latest.current.range.join('-')}`
    }
    function available(write = false) {
      const o = latest.current
      if (!alive || window.location.hash !== '#/prelayout') throw new Error('預排版工作區未開啟。')
      if (o.busy || o.interacting.current || controller.editing) throw new Error('請先完成目前的編輯或拖曳。')
      if (!o.fontReady) throw new Error('預覽字型尚未就緒，請稍後重試。')
      const modal = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')].some(node => node.getClientRects().length && !node.querySelector('.pl-review-modal'))
      if (modal) throw new Error('請先關閉目前的對話框。')
      if (write && document.activeElement?.matches('input,textarea,[contenteditable="true"]')) throw new Error('請先結束輸入欄位的人工編輯。')
    }
    async function target(token?: string, write = false) {
      available(write)
      const id = latest.current.current, state = await controller.load(id)
      available(write)
      if (id !== latest.current.current) throw new Error('目前頁面已變更，請重新檢查。')
      if (state.conflict || state.error) throw new Error(state.error || '請先處理頁面保存衝突。')
      if (token !== undefined && token !== tokenFor(state, id)) throw new Error('頁面已變更，請重新執行 prelayout_inspect_page。')
      return { id, state }
    }
    async function checked(token: string, write = false) {
      if (typeof token !== 'string' || !token) throw new Error('請提供目前頁面的 token。')
      return target(token, write)
    }
    async function ready(id: string) {
      const until = Date.now() + 4000
      let signature = '', stableSince = 0
      await pause()
      while (alive && Date.now() < until) {
        const node = [...document.querySelectorAll<HTMLElement>('.pl-page[data-readonly="false"]')].find(node => node.dataset.page === id)
        const imgs = node ? [...node.querySelectorAll('img')] : []
        if (latest.current.current === id && node && imgs.length && imgs.every(img => img.complete && img.naturalWidth > 0)) {
          const rect = node.getBoundingClientRect(), o = latest.current
          const next = [rect.x, rect.y, rect.width, rect.height, o.compare, o.zoom, o.focus].join(':')
          if (signature !== next) { signature = next; stableSince = Date.now() }
          if (Date.now() - stableSince >= 200) {
            await Promise.all(imgs.map(img => img.decode().catch(() => {})))
            return latest.current.current === id
          }
        }
        await pause()
      }
      return false
    }
    async function inspect() {
      const { id, state } = await target()
      const version = tokenFor(state, id), page = structuredClone(state.data)
      const measurement = await measurePage(page)
      await target(version)
      const o = latest.current
      const pages = o.project.pages.map((p, index) => {
        const s = controller.pages.get(p.id), data = s?.data || p
        return { page_id: p.id, number: index + 1, name: p.name, reviewed: !s?.dirty && data.reviewed_revision === data.revision }
      })
      return {
        token: version, project_id: o.project.id, page_id: id, page_number: pages.find(p => p.page_id === id)?.number,
        width: page.width, height: page.height, revision: page.revision, dirty: state.dirty, saving: state.saving,
        reviewed: !state.dirty && page.reviewed_revision === page.revision, range: o.range, pages,
        view: { comparison: o.compare, difference_highlight: o.difference, zoom: o.zoom, fullscreen: o.focus },
        risks: measurement.risks, risk_note: '邊界框相交是提示，需看圖確認。',
        rule: '保持譯文字元；字級以原文為準；位置允許時，換行次數不要超過對應原文。來源行數未知時須看原圖確認。',
        items: page.items.map(item => {
          const lines = page.character_boxes?.filter(box => typeof item.match_source_block_index === 'number' && box.source_block_index === item.match_source_block_index).map(box => box.line_index)
          return { ...item, center: [item.x * page.width, item.y * page.height], rect: measurement.rects[item._id], line_count: item.text.split('\n').length, source_line_count: lines?.length ? new Set(lines).size : null }
        }),
      }
    }
    async function showReview(args: Parameters<PrelayoutHost['compare']>[0]) {
      const { state } = await checked(args.token)
      if (!['edited', 'original', 'before', 'detail'].includes(args.view)) throw new Error('對比方式無效。')
      if (args.padding !== undefined && (!Number.isFinite(args.padding) || args.padding < 16 || args.padding > 300)) throw new Error('留白範圍必須介於 16 與 300。')
      if (args.view === 'edited') { setReview(null); return }
      const after = structuredClone(state.data)
      const before = { ...after, items: structuredClone(state.undo.at(-1) || after.items) }
      if (args.view !== 'original' && !state.undo.length) throw new Error('本頁尚無可比較的修改。')
      const [a, b] = await Promise.all([measurePage(before), measurePage(after)])
      await checked(args.token)
      const changed = after.items.filter(item => JSON.stringify(item) !== JSON.stringify(before.items.find(old => old._id === item._id))).map(item => item._id)
      for (const old of before.items) if (!after.items.some(item => item._id === old._id)) changed.push(old._id)
      const regions = args.view === 'original' ? [[0, 0, after.width, after.height]] : cropRegions(before, after, a.rects, b.rects, changed, args.padding ?? 60)
      if (args.region !== undefined && (!Number.isInteger(args.region) || args.region < 0 || args.region >= regions.length)) throw new Error('局部區域序號無效。')
      const reviewId = crypto.randomUUID()
      setReview({ reviewId, before, after, regions, view: args.view, region: args.region, includeOriginal: args.includeOriginal !== false })
      return reviewId
    }
    const host: PrelayoutHost = {
      inspect,
      patch: async args => {
        const { id, state } = await checked(args.token, true)
        const before = structuredClone(state.data), after = applyPagePatches(before, args.patches)
        const [a, b] = await Promise.all([measurePage(before), measurePage(after)])
        await checked(args.token, true)
        const newRisks = b.risks.filter(risk => !a.risks.includes(risk))
        // Rotated bounding boxes may overlap without glyphs touching; return these for visual review.
        if (newRisks.some(risk => risk.startsWith('outside:') || risk.startsWith('invalid:'))) throw new Error(`修改會超出頁面或無法顯示：${newRisks.join('、')}`)
        controller.edit(id, after.items)
        setReview(null)
        const rendered = await ready(id)
        try { return { applied: true, rendered, new_risks: newRisks, ...await inspect() } }
        catch (error) { return { applied: true, rendered, new_risks: newRisks, warning: String(error), next: '請重新檢查頁面，勿重複套用。' } }
      },
      compare: async args => {
        const reviewId = await showReview(args)
        let rendered = args.view === 'edited'
        const until = Date.now() + 4000
        while (!rendered && alive && Date.now() < until) {
          await pause()
          const imgs = [...document.querySelectorAll<HTMLImageElement>(`.pl-review-${reviewId} img`)]
          rendered = imgs.length > 0 && imgs.every(img => img.complete && img.naturalWidth > 0)
          if (rendered) await Promise.all(imgs.map(img => img.decode().catch(() => {})))
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        return { ...await inspect(), comparison_view: args.view, rendered }
      },
      undo: async args => { const { id } = await checked(args.token, true); controller.undo(id); setReview(null); await ready(id); return inspect() },
      save: async args => {
        for (const value of [args.reviewed, args.advance]) if (value !== undefined && typeof value !== 'boolean') throw new Error('保存選項必須是布林值。')
        const { id } = await checked(args.token, true)
        if (!await controller.flush()) throw new Error('保存失敗，請處理頁面錯誤後重試。')
        await checked(args.token, true)
        if (args.reviewed !== undefined || args.advance) {
          const o = latest.current, number = o.project.pages.findIndex(page => page.id === id) + 1
          if (number < o.range[0] || number > o.range[1]) throw new Error('目前頁面不在校對範圍，請先跳至範圍內。')
          await controller.markReviewed(id, args.advance ? true : args.reviewed!)
          await o.refreshProject()
        }
        setReview(null)
        if (args.advance) {
          const o = latest.current, pages = o.project.pages.slice(o.range[0] - 1, o.range[1])
          const start = pages.findIndex(page => page.id === id)
          for (let offset = 1; offset <= pages.length; offset++) {
            const page = pages[(start + offset + pages.length) % pages.length], state = await controller.load(page.id)
            if (state.dirty || state.data.reviewed_revision !== state.data.revision) { o.go(page.id); await ready(page.id); break }
          }
        }
        return inspect()
      },
      navigate: async args => {
        await checked(args.token, true)
        if (!latest.current.project.pages.some(page => page.id === args.page_id)) throw new Error('找不到指定頁面。')
        if (!await controller.flush()) throw new Error('保存失敗，未切換頁面。')
        await controller.load(args.page_id); await checked(args.token, true); setReview(null); latest.current.go(args.page_id)
        const rendered = await ready(args.page_id)
        return { rendered, ...await inspect() }
      },
      setView: async args => {
        const { id } = await checked(args.token)
        const o = latest.current
        for (const value of [args.comparison, args.difference_highlight, args.fullscreen]) if (value !== undefined && typeof value !== 'boolean') throw new Error('顯示開關必須是布林值。')
        if (args.zoom !== undefined && (!Number.isFinite(args.zoom) || args.zoom < .1 || args.zoom > 8)) throw new Error('縮放必須介於 0.1 與 8。')
        if (args.comparison !== undefined) o.setCompare(args.comparison)
        if (args.difference_highlight !== undefined) o.setDifference(args.difference_highlight)
        if (args.fullscreen !== undefined) o.setFocus(args.fullscreen)
        if (args.zoom !== undefined) o.setZoom(args.zoom)
        setReview(null); await ready(id)
        return inspect()
      },
    }
    // Serialize tool calls without preventing the user's normal editor interactions.
    const wrapped = Object.fromEntries(Object.entries(host).map(([name, fn]) => [name, async (args: never) => {
      if (locked) throw new Error('另一項頁面操作仍在進行，請稍後重試。')
      locked = true
      try { return await fn(args) } finally { locked = false }
    }])) as PrelayoutHost
    hostRef.current = wrapped
    const unregister = registerPrelayoutTools(wrapped)
    return () => { alive = false; hostRef.current = null; unregister() }
  }, [controller])
  return {
    hasReview: !!controller.pages.get(options.current)?.undo.length,
    openReview: async () => {
      const host = hostRef.current
      if (!host) return
      const state = await host.inspect() as { token: string }
      await host.compare({ token: state.token, view: 'detail', includeOriginal: true })
    },
    review: review && <LayoutReview project={options.project.id} clean={options.clean} {...review} onClose={() => setReview(null)} />,
  }
}
