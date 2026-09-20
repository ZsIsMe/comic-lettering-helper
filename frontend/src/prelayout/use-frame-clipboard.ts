import { useEffect, useRef } from 'react'
import { createFrameClipboardHandler, type FrameClipboardOptions } from './frame-clipboard-shortcut'

export function useFrameClipboard(options: FrameClipboardOptions) {
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    const handler = createFrameClipboardHandler(() => latest.current)
    window.addEventListener('keydown', handler.key)
    return () => { handler.dispose(); window.removeEventListener('keydown', handler.key) }
  }, [])
}
