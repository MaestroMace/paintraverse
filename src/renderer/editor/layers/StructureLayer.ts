import { Container, Graphics, Text } from 'pixi.js'
import type { MapLayer, ObjectDefinition } from '../../core/types'

export interface ObjectBounds {
  id: string
  layerId: string
  x: number
  y: number
  width: number
  height: number
}

export class StructureLayer {
  container: Container
  private objects: Map<string, { graphics: Graphics; label: Text }> = new Map()
  private _layerId = ''

  constructor() {
    this.container = new Container()
  }

  update(layer: MapLayer, tileSize: number, objectDefs: ObjectDefinition[]): void {
    this._layerId = layer.id
    // Clear old objects
    this.container.removeChildren()
    this.objects.clear()

    for (const obj of layer.objects) {
      const def = objectDefs.find((d) => d.id === obj.definitionId)
      if (!def) continue

      const g = new Graphics()
      const w = def.footprint.w * tileSize
      const h = def.footprint.h * tileSize

      // Draw building rectangle
      g.rect(0, 0, w, h)
      g.fill(parseInt(def.color.replace('#', ''), 16))
      g.setStrokeStyle({ width: 2, color: 0x000000 })
      g.rect(0, 0, w, h)
      g.stroke()

      g.x = obj.x * tileSize
      g.y = obj.y * tileSize

      // Label
      const label = new Text({
        text: def.name,
        style: {
          fontSize: Math.min(12, tileSize * 0.4),
          fill: 0xffffff,
          fontFamily: 'monospace'
        }
      })
      label.x = g.x + 2
      label.y = g.y + 2

      this.container.addChild(g)
      this.container.addChild(label)
      this.objects.set(obj.id, { graphics: g, label })
    }
  }

  getObjectBounds(): ObjectBounds[] {
    // Re-derive from the last update
    return Array.from(this.objects.entries()).map(([id, { graphics }]) => ({
      id,
      layerId: this._layerId,
      x: graphics.x,
      y: graphics.y,
      width: graphics.width,
      height: graphics.height
    }))
  }
}
