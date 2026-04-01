import type { FederatedPointerEvent } from 'pixi.js'
import type { ITool } from './BaseTool'
import type { EditorViewport } from '../EditorViewport'
import { useAppStore } from '../../app/store'
import { createDeleteObjectCommand } from '../../core/commands'

export class EraseTool implements ITool {
  name = 'erase'
  cursor = 'not-allowed'
  private viewport: EditorViewport | null = null

  onActivate(viewport: EditorViewport): void {
    this.viewport = viewport
  }

  onTileClick(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    this.eraseAt(tileX, tileY)
  }

  onTileDrag(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    this.eraseAt(tileX, tileY)
  }

  private eraseAt(tileX: number, tileY: number): void {
    const store = useAppStore.getState()
    const tileSize = store.map.tileSize
    const worldX = tileX * tileSize + tileSize / 2
    const worldY = tileY * tileSize + tileSize / 2

    for (const layer of store.map.layers) {
      if (layer.locked || layer.type === 'terrain') continue
      for (const obj of layer.objects) {
        const def = store.objectDefinitions.find((d) => d.id === obj.definitionId)
        if (!def) continue
        const objW = def.footprint.w * tileSize
        const objH = def.footprint.h * tileSize
        const objX = obj.x * tileSize
        const objY = obj.y * tileSize

        if (worldX >= objX && worldX <= objX + objW && worldY >= objY && worldY <= objY + objH) {
          const cmd = createDeleteObjectCommand(
            layer.id,
            obj,
            store.addObjectToLayer,
            store.removeObjectFromLayer
          )
          store.executeCommand(cmd)
          return // erase one at a time
        }
      }
    }
  }
}
