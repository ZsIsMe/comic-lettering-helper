import { memo, useRef } from 'react'
import { LayeredImage } from './LayeredImage'
import { baseLayerOptions, layerTiles } from './layered-preview'
import type { Page } from './types'
import type { VisibleRegion } from './geometry'

export const PreviewLayer = memo(function PreviewLayer({ project, page, edge, scale, clean, region, detailed, interacting }: {
  project: string; page: Page; edge: number; scale: number; clean: boolean; region: VisibleRegion | null; detailed: boolean; interacting: boolean;
}) {
  // Native layers are reused through zooms. Large-page detail requests stay
  // fixed through a gesture, just as text geometry does.
  const snapshot = useRef({ options: baseLayerOptions(page, edge, !!region), tiles: layerTiles(page, scale, region, detailed, devicePixelRatio) })
  if (!interacting) snapshot.current = { options: baseLayerOptions(page, edge, !!region), tiles: layerTiles(page, scale, region, detailed, devicePixelRatio) }
  return <>
    <LayeredImage project={project} page={page} clean={clean} options={snapshot.current.options} interacting={interacting} errorScale={1 / scale} />
    {snapshot.current.tiles.map(tile => <LayeredImage key={`${tile.x}:${tile.y}:${tile.width}:${tile.height}`} project={project} page={page} clean={clean} options={tile.options} interacting={interacting} className="pl-detail-tile" tile errorScale={1 / scale} style={{ left: tile.x, top: tile.y, width: tile.width, height: tile.height }} />)}
  </>
})
