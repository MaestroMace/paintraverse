import { Container, Graphics, Text } from 'pixi.js'
import type { MapLayer, ObjectDefinition } from '../../core/types'
import type { ObjectBounds } from './StructureLayer'

export class PropLayer {
  container: Container
  private objects: Map<string, { graphics: Graphics; label: Text }> = new Map()
  private _layerId = ''

  constructor() {
    this.container = new Container()
  }

  update(layer: MapLayer, tileSize: number, objectDefs: ObjectDefinition[]): void {
    this._layerId = layer.id
    this.container.removeChildren()
    this.objects.clear()

    for (const obj of layer.objects) {
      const def = objectDefs.find((d) => d.id === obj.definitionId)
      if (!def) continue

      const g = new Graphics()
      const w = def.footprint.w * tileSize
      const h = def.footprint.h * tileSize

      // Draw prop as a rounded rectangle or circle for small items
      if (def.footprint.w === 1 && def.footprint.h === 1) {
        // Small props: draw as circle
        const radius = tileSize * 0.35
        g.circle(tileSize / 2, tileSize / 2, radius)
        g.fill(parseInt(def.color.replace('#', ''), 16))
        g.setStrokeStyle({ width: 1, color: 0x000000 })
        g.circle(tileSize / 2, tileSize / 2, radius)
        g.stroke()
      } else {
        // Larger props: rounded rectangle
        g.roundRect(2, 2, w - 4, h - 4, 4)
        g.fill(parseInt(def.color.replace('#', ''), 16))
        g.setStrokeStyle({ width: 1, color: 0x000000 })
        g.roundRect(2, 2, w - 4, h - 4, 4)
        g.stroke()
      }

      g.x = obj.x * tileSize
      g.y = obj.y * tileSize

      // Label (only for larger props)
      const label = new Text({
        text: def.footprint.w > 1 || def.footprint.h > 1 ? def.name : def.name[0],
        style: {
          fontSize: Math.min(10, tileSize * 0.35),
          fill: 0xffffff,
          fontFamily: 'monospace'
        }
      })
      label.x = g.x + 3
      label.y = g.y + (def.footprint.w === 1 && def.footprint.h === 1 ? tileSize * 0.3 : 2)

      this.container.addChild(g)
      this.container.addChild(label)
      this.objects.set(obj.id, { graphics: g, label })
    }
  }

  getObjectBounds(): ObjectBounds[] {
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
