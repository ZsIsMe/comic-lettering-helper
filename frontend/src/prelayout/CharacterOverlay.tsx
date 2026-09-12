import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import type { CharacterBox } from './types'
import type { VisibleRegion } from './geometry'
import { characterAt, characterLabel, characterPath } from './character-overlay'

export type CharacterOverlayHandle = { probe: (x: number, y: number) => void; clear: () => void }

export const CharacterOverlay = memo(function CharacterOverlay({ ref, characters, width, height, scale, region, disabled }: {
  ref: Ref<CharacterOverlayHandle>; characters: CharacterBox[]; width: number; height: number; scale: number; region: VisibleRegion | null; disabled: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null)
  const frame = useRef(0), point = useRef([0, 0])
  const path = useMemo(() => characterPath(characters), [characters])
  const clear = useCallback(() => { cancelAnimationFrame(frame.current); frame.current = 0; setHover(null) }, [])
  const probe = useCallback((x: number, y: number) => {
    if (disabled) return
    point.current = [x, y]
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0
      setHover(characterAt(characters, point.current[0], point.current[1]))
    })
  }, [characters, disabled])
  useImperativeHandle(ref, () => ({ probe, clear }), [probe, clear])
  useEffect(() => { clear() }, [clear, characters, scale, disabled, region?.x, region?.y, region?.width, region?.height])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  const item = hover === null || disabled ? null : characters[hover]
  const label = item ? characterLabel(item) : ''
  const pad = 7 / scale, fontSize = 14 / scale, tipWidth = (label.length * 8.6 + 14) / scale, tipHeight = 28 / scale
  const left = item ? Math.max(0, Math.min(width - tipWidth, (item.bbox[0] + item.bbox[2] - tipWidth) / 2)) : 0
  const top = item ? Math.max(0, Math.min(height - tipHeight, item.bbox[1] >= tipHeight + pad ? item.bbox[1] - tipHeight - pad : item.bbox[3] + pad)) : 0
  if (!region || !characters.length) return null
  return <svg className="pl-character-layer" width={width} height={height} aria-label={`${characters.length} 個單字偵測框`}>
    <path d={path} fill="#f5aa2318" stroke="#d58a16" strokeWidth={1 / scale} />
    {item && <>
      <rect x={item.bbox[0]} y={item.bbox[1]} width={item.bbox[2] - item.bbox[0]} height={item.bbox[3] - item.bbox[1]} fill="none" stroke="#ed2875" strokeWidth={2 / scale} />
      <g role="tooltip"><rect x={left} y={top} width={tipWidth} height={tipHeight} rx={4 / scale} fill="#fffff5" stroke="#544b3e" strokeWidth={1 / scale} />
        <text x={left + pad} y={top + tipHeight / 2} dominantBaseline="central" fontFamily="monospace" fontSize={fontSize} fontWeight="600" fill="#25231f">{label}</text>
      </g>
    </>}
  </svg>
})
