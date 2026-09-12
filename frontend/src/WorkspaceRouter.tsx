import { useCallback, useEffect, useRef, useState } from 'react'
import ProjectWorkbench from './ProjectWorkbench'
import EdgeWhitePage from './EdgeWhitePage'

export default function WorkspaceRouter() {
  const [route, setRoute] = useState(() => window.location.hash.slice(1))
  const current = useRef(route), guard = useRef<(() => Promise<boolean>) | null>(null), token = useRef(0)
  const registerGuard = useCallback((callback: () => Promise<boolean>) => {
    guard.current = callback
    return () => { if (guard.current === callback) guard.current = null }
  }, [])
  useEffect(() => {
    const navigate = async () => {
      const next = window.location.hash.slice(1), request = ++token.current
      if (next === current.current) return
      const allowed = !guard.current || await guard.current()
      if (request !== token.current) return
      if (allowed) { current.current = next; setRoute(next) }
      else history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${current.current}`)
    }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  const match = route.match(/^\/edgewhite(?:\/([0-9a-f]{32}))?\/?$/)
  if (match) return <EdgeWhitePage key={match[1] || 'list'} id={match[1] || ''} registerGuard={registerGuard} />
  return <ProjectWorkbench />
}
