import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Spin } from 'antd'
import ProjectWorkbench from './ProjectWorkbench'
import { UpdateChecker } from './UpdateChecker'
import { ComfyService } from './ComfyService'
import { ComfyCleanup } from './ComfyCleanup'

const EdgeWhitePage = lazy(() => import('./EdgeWhitePage'))
const PrelayoutWorkbench = lazy(() => import('./prelayout/PrelayoutWorkbench'))
type Guard = () => Promise<boolean>
const allow: Guard = async () => true
function readRoute() { return window.location.hash.slice(1) || '/repair' }
function moduleFor(route: string) {
  if (/^\/edgewhite(?:\/[0-9a-f]{32})?\/?$/.test(route)) return 'edgewhite'
  return route === '/prelayout' ? 'prelayout' : 'repair'
}

export default function WorkspaceRouter() {
  const [route, setRoute] = useState(readRoute)
  const [error, setError] = useState('')
  const current = useRef(route), token = useRef(0)
  const guards = useRef<Record<string, Guard>>({ repair: allow, prelayout: allow, edgewhite: allow })
  const registerRepair = useCallback((guard: Guard) => { guards.current.repair = guard }, [])
  const registerPrelayout = useCallback((guard: Guard) => { guards.current.prelayout = guard }, [])
  const registerEdgewhite = useCallback((guard: Guard) => {
    guards.current.edgewhite = guard
    return () => { if (guards.current.edgewhite === guard) guards.current.edgewhite = allow }
  }, [])
  useEffect(() => {
    let live = true
    const navigate = async () => {
      const next = readRoute(), request = ++token.current
      if (next === current.current) return
      let allowed = false
      try { allowed = await guards.current[moduleFor(current.current)]() } catch { /* Keep the active editor on a failed save. */ }
      if (!live || request !== token.current) return
      if (allowed) { current.current = next; setRoute(next); setError('') }
      else {
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${current.current}`)
        setError('目前操作尚未完成或修改未能保存，請完成後再切換。')
      }
    }
    window.addEventListener('hashchange', navigate)
    return () => { live = false; window.removeEventListener('hashchange', navigate) }
  }, [])
  const module = moduleFor(route)
  const edge = route.match(/^\/edgewhite(?:\/([0-9a-f]{32}))?\/?$/)
  return <>
    <UpdateChecker beforeInstall={async () => {
      for (const guard of Object.values(guards.current)) if (!await guard()) return false
      return true
    }} />
    <ComfyService />
    <ComfyCleanup />
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    {/* Preserve repair page, step and edits across optional module visits. Inert blocks hidden-editor input. */}
    <div hidden={module !== 'repair'} inert={module !== 'repair'}><ProjectWorkbench onReadyToLeave={registerRepair} /></div>
    <Suspense fallback={<Spin />}>
      {module === 'edgewhite' && <EdgeWhitePage key={edge?.[1] || 'list'} id={edge?.[1] || ''} registerGuard={registerEdgewhite} />}
      {module === 'prelayout' && <PrelayoutWorkbench onReadyToLeave={registerPrelayout} onExit={() => { window.location.hash = '/repair' }} />}
    </Suspense>
  </>
}
