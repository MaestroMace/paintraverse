import { Container, Graphics, Text } from 'pixi.js'
import type { MapLayer, ObjectDefinition, PlacedObject } from '../../core/types'

export interface ObjectBounds {
  id: string
  layerId: string
  x: number
  y: number
  width: number
  height: number
}

interface CachedObject {
  graphics: Graphics
  label: Text
  objSnapshot: string // JSON of the PlacedObject for dirty check
}

export class StructureLayer {
  container: Container
  private cache: Map<string, CachedObject> = new Map()
  private _layerId = ''
  private _defMap: Map<string, ObjectDefinition> = new Map()

  constructor() {
    this.container = new Container()
  }

  update(layer: MapLayer, tileSize: number, objectDefs: ObjectDefinition[]): void {
    this._layerId = layer.id

    // Build def lookup map
    this._defMap.clear()
    for (const d of objectDefs) this._defMap.set(d.id, d)

    // Diff: find added, removed, changed objects
    const currentIds = new Set(layer.objects.map((o) => o.id))
    const cachedIds = new Set(this.cache.keys())

    // Remove objects no longer present
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

    // Add or update objects
    for (const obj of layer.objects) {
      const snap = `${obj.definitionId}|${obj.x}|${obj.y}|${obj.rotation}`
      const existing = this.cache.get(obj.id)

      if (existing && existing.objSnapshot === snap) {
        continue // unchanged, skip
      }

      // Remove old version if exists
      if (existing) {
        this.container.removeChild(existing.graphics)
        this.container.removeChild(existing.label)
        existing.graphics.destroy()
        existing.label.destroy()
      }

      // Create new
      const def = this._defMap.get(obj.definitionId)
      if (!def) continue

      const { graphics, label } = this.createObjectGraphics(obj, def, tileSize)
      this.container.addChild(graphics)
      this.container.addChild(label)
      this.cache.set(obj.id, { graphics, label, objSnapshot: snap })
    }
  }

  private createObjectGraphics(
    obj: PlacedObject, def: ObjectDefinition, tileSize: number
  ): { graphics: Graphics; label: Text } {
    const g = new Graphics()
    const w = def.footprint.w * tileSize
    const h = def.footprint.h * tileSize
    const color = parseInt(def.color.replace('#', ''), 16)

    // Building body with slight 3D effect
    g.rect(0, 0, w, h)
    g.fill(color)

    // Darker border
    g.setStrokeStyle({ width: 2, color: darkenHex(color, 0.3) })
    g.rect(0, 0, w, h)
    g.stroke()

    // Roof highlight (top edge)
    g.setStrokeStyle({ width: 1, color: lightenHex(color, 0.2) })
    g.moveTo(1, 1)
    g.lineTo(w - 1, 1)
    g.stroke()

    // Door indicator
    const doorW = Math.min(tileSize * 0.4, w * 0.3)
    const doorH = Math.min(tileSize * 0.6, h * 0.4)
    g.rect(w / 2 - doorW / 2, h - doorH, doorW, doorH)
    g.fill(darkenHex(color, 0.4))

    g.x = obj.x * tileSize
    g.y = obj.y * tileSize

    const label = new Text({
      text: def.name,
      style: {
        fontSize: Math.min(11, tileSize * 0.35),
        fill: 0xffffff,
        fontFamily: 'monospace',
        dropShadow: { color: 0x000000, distance: 1, blur: 0 }
      }
    })
    label.x = g.x + 3
    label.y = g.y + 2

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

function darkenHex(color: number, amount: number): number {
  const r = Math.max(0, ((color >> 16) & 0xff) * (1 - amount))
  const g = Math.max(0, ((color >> 8) & 0xff) * (1 - amount))
  const b = Math.max(0, (color & 0xff) * (1 - amount))
  return (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b)
}

function lightenHex(color: number, amount: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) * (1 + amount))
  const g = Math.min(255, ((color >> 8) & 0xff) * (1 + amount))
  const b = Math.min(255, (color & 0xff) * (1 + amount))
  return (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b)
}
