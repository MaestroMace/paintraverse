import { v4 as uuid } from 'uuid'
import type { FederatedPointerEvent } from 'pixi.js'
import type { ITool } from './BaseTool'
import type { EditorViewport } from '../EditorViewport'
import { useAppStore } from '../../app/store'
import { createPlaceObjectCommand } from '../../core/commands'
import type { PlacedObject } from '../../core/types'

export class PlaceTool implements ITool {
  name = 'place'
  cursor = 'crosshair'
  private viewport: EditorViewport | null = null

  onActivate(viewport: EditorViewport): void {
    this.viewport = viewport
  }

  onTileClick(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    this.placeAt(tileX, tileY)
  }

  onTileDrag(tileX: number, tileY: number, _event: FederatedPointerEvent): void {
    // Allow drag-placing for single-tile objects
    const store = useAppStore.getState()
    const defId = store.selectedDefinitionId
    if (!defId) return
    const def = store.objectDefinitions.find((d) => d.id === defId)
    if (!def || def.footprint.w > 1 || def.footprint.h > 1) return
    this.placeAt(tileX, tileY)
  }

  private placeAt(tileX: number, tileY: number): void {
    const store = useAppStore.getState()
    const defId = store.selectedDefinitionId
    if (!defId) return

    const def = store.objectDefinitions.find((d) => d.id === defId)
    if (!def) return

    // Determine target layer based on object category
    const layerType = def.category === 'building' ? 'structure' : 'prop'
    const layer = store.map.layers.find((l) => l.type === layerType)
    if (!layer || layer.locked) return

    // Check bounds
    if (
      tileX < 0 || tileY < 0 ||
      tileX + def.footprint.w > store.map.gridWidth ||
      tileY + def.footprint.h > store.map.gridHeight
    ) return

    // Check for overlap with existing objects in this layer
    const overlaps = layer.objects.some((o) => {
      const oDef = store.objectDefinitions.find((d) => d.id === o.definitionId)
      if (!oDef) return false
      return !(
        tileX + def.footprint.w <= o.x ||
        tileX >= o.x + oDef.footprint.w ||
        tileY + def.footprint.h <= o.y ||
        tileY >= o.y + oDef.footprint.h
      )
    })
    if (overlaps) return

    const newObj: PlacedObject = {
      id: uuid(),
      definitionId: defId,
      x: tileX,
      y: tileY,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      elevation: 0,
      properties: {}
    }

    const cmd = createPlaceObjectCommand(
      layer.id,
      newObj,
      store.addObjectToLayer,
      store.removeObjectFromLayer
    )
    store.executeCommand(cmd)
  }
}
