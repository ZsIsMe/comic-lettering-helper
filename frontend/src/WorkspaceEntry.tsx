import { lazy, Suspense, useCallback, useRef, useState } from 'react'
import { Spin } from 'antd'
import ProjectWorkbench from './ProjectWorkbench'
import './prelayout/styles.css'
const PrelayoutWorkbench = lazy(() => import('./prelayout/PrelayoutWorkbench'))

export default function WorkspaceEntry() {
  const [prelayout, setPrelayout] = useState(location.hash.startsWith('#/prelayout'))
  const beforeLeave = useRef<() => Promise<boolean>>(async () => true)
  const register = useCallback((handler: () => Promise<boolean>) => { beforeLeave.current = handler }, [])
  const [switching, setSwitching] = useState(false)
  function change(value: boolean) {
    setPrelayout(value)
    history.replaceState(null, '', value ? '#/prelayout' : '#/repair')
  }
  // Keep the existing repair workspace mounted so its in-memory edits survive module switching.
  return <>
    <div hidden={prelayout}><ProjectWorkbench onReadyToLeave={register} /><button className="workspace-module-link" disabled={switching} onClick={async () => {
      setSwitching(true)
      try { if (await beforeLeave.current()) change(true) } finally { setSwitching(false) }
    }}>開啟預排版</button></div>
    {prelayout && <Suspense fallback={<Spin />}><PrelayoutWorkbench onExit={() => change(false)} /></Suspense>}
  </>
}
