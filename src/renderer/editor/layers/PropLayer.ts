import { Container, Graphics, Text } from 'pixi.js'
import type { MapLayer, ObjectDefinition, PlacedObject } from '../../core/types'
import type { ObjectBounds } from './StructureLayer'

interface CachedProp {
  graphics: Graphics
  label: Text
  objSnapshot: string
}

export class PropLayer {
  container: Container
  private cache: Map<string, CachedProp> = new Map()
  private _layerId = ''
  private _defMap: Map<string, ObjectDefinition> = new Map()

  constructor() {
    this.container = new Container()
  }

  update(layer: MapLayer, tileSize: number, objectDefs: ObjectDefinition[]): void {
    this._layerId = layer.id

    this._defMap.clear()
    for (const d of objectDefs) this._defMap.set(d.id, d)

    const currentIds = new Set(layer.objects.map((o) => o.id))
    const cachedIds = new Set(this.cache.keys())

    // Remove deleted
    for (const id of cachedIds) {
      if (!currentIds.has(id)) {
        const entry = this.cache.get(id)!
        this.container.removeChild(entry.graphics)
        this.container.removeChild(entry.label)
        entry.graphics.destroy()
        entry.label.destroy()
        this.cache.delete(id)
      }
    }

    // Add or update
    for (const obj of layer.objects) {
      const snap = `${obj.definitionId}|${obj.x}|${obj.y}|${obj.rotation}`
      const existing = this.cache.get(obj.id)

      if (existing && existing.objSnapshot === snap) continue

      if (existing) {
        this.container.removeChild(existing.graphics)
        this.container.removeChild(existing.label)
        existing.graphics.destroy()
        existing.label.destroy()
      }

      const def = this._defMap.get(obj.definitionId)
      if (!def) continue

      const { graphics, label } = this.createPropGraphics(obj, def, tileSize)
      this.container.addChild(graphics)
      this.container.addChild(label)
      this.cache.set(obj.id, { graphics, label, objSnapshot: snap })
    }
  }

  private createPropGraphics(
    obj: PlacedObject, def: ObjectDefinition, tileSize: number
  ): { graphics: Graphics; label: Text } {
    const g = new Graphics()
    const w = def.footprint.w * tileSize
    const h = def.footprint.h * tileSize
    const color = parseInt(def.color.replace('#', ''), 16)

    if (def.footprint.w === 1 && def.footprint.h === 1) {
      // Small props: draw as diamond/circle with shadow
      const cx = tileSize / 2
      const cy = tileSize / 2
      const radius = tileSize * 0.32

      // Shadow
      g.circle(cx + 1, cy + 1, radius)
      g.fill({ color: 0x000000, alpha: 0.2 })

      // Body
      g.circle(cx, cy, radius)
      g.fill(color)
      g.setStrokeStyle({ width: 1, color: darkenColor(color, 0.3) })
      g.circle(cx, cy, radius)
      g.stroke()
    } else {
      // Larger props: rounded rectangle with shadow
      g.roundRect(3, 3, w - 4, h - 4, 4)
      g.fill({ color: 0x000000, alpha: 0.15 })
      g.roundRect(2, 2, w - 4, h - 4, 4)
      g.fill(color)
      g.setStrokeStyle({ width: 1, color: darkenColor(color, 0.3) })
      g.roundRect(2, 2, w - 4, h - 4, 4)
      g.stroke()
    }

    g.x = obj.x * tileSize
    g.y = obj.y * tileSize

    const isSmall = def.footprint.w === 1 && def.footprint.h === 1
    const label = new Text({
      text: isSmall ? def.name[0] : def.name,
      style: {
        fontSize: Math.min(isSmall ? 9 : 10, tileSize * 0.3),
        fill: 0xffffff,
        fontFamily: 'monospace',
        dropShadow: { color: 0x000000, distance: 1, blur: 0 }
      }
    })
    label.x = g.x + (isSmall ? tileSize * 0.33 : 3)
    label.y = g.y + (isSmall ? tileSize * 0.33 : 2)

    return { graphics: g, label }
  }

  getObjectBounds(): ObjectBounds[] {
    const bounds: ObjectBounds[] = []
    for (const [id, entry] of this.cache) {
      bounds.push({
        id,
        layerId: this._layerId,
        x: entry.graphics.x,
        y: entry.graphics.y,
        width: entry.graphics.width,
        height: entry.graphics.height
      })
    }
    return bounds
  }
}

function darkenColor(color: number, amount: number): number {
  const r = Math.max(0, ((color >> 16) & 0xff) * (1 - amount))
  const g = Math.max(0, ((color >> 8) & 0xff) * (1 - amount))
  const b = Math.max(0, (color & 0xff) * (1 - amount))
  return (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b)
}
