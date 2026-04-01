import type { FederatedPointerEvent } from 'pixi.js'
import type { ITool } from './BaseTool'
import type { EditorViewport } from '../EditorViewport'
import { useAppStore } from '../../app/store'
import { createPaintTerrainCommand } from '../../core/commands'

export class BrushTool implements ITool {
  name = 'brush'
  cursor = 'crosshair'
  private viewport: EditorViewport | null = null
  private lastPaintedTile: string | null = null

  onActivate(viewport: EditorViewport): void {
    this.viewport = viewport
  }

  onTileClick(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    this.lastPaintedTile = null
    this.paintAt(tileX, tileY)
  }

  onTileDrag(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    const key = `${tileX},${tileY}`
    if (key === this.lastPaintedTile) return
    this.paintAt(tileX, tileY)
  }

  onTileUp(): void {
    this.lastPaintedTile = null
  }

  private paintAt(tileX: number, tileY: number): void {
    const store = useAppStore.getState()
    const terrainLayer = store.map.layers.find((l) => l.type === 'terrain')
    if (!terrainLayer || terrainLayer.locked || !terrainLayer.terrainTiles) return

    // Bounds check
    if (tileX < 0 || tileY < 0 || tileY >= terrainLayer.terrainTiles.length) return
    if (tileX >= terrainLayer.terrainTiles[0].length) return

    const oldTileId = terrainLayer.terrainTiles[tileY][tileX]
    const newTileId = store.brushTileId

    if (oldTileId === newTileId) return

    const cmd = createPaintTerrainCommand(
      terrainLayer.id,
      tileX,
      tileY,
      oldTileId,
      newTileId,
      store.paintTerrain
    )
    store.executeCommand(cmd)

    this.lastPaintedTile = `${tileX},${tileY}`
  }
}
