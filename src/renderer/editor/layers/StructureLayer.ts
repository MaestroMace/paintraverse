import { Container, Sprite, Texture } from 'pixi.js'
import type { MapLayer, ObjectDefinition, PlacedObject } from '../../core/types'

export interface ObjectBounds {
  id: string
  layerId: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * StructureLayer renders all buildings to a single Canvas2D texture.
 * This avoids flooding SwiftShader with hundreds of PixiJS Graphics draw calls.
 */
export class StructureLayer {
  container: Container
  private sprite: Sprite | null = null
  private _layerId = ''
  private _defMap: Map<string, ObjectDefinition> = new Map()
  private _bounds: ObjectBounds[] = []
  private _lastSnap = ''

  constructor() {
    this.container = new Container()
  }

  update(layer: MapLayer, tileSize: number, objectDefs: ObjectDefinition[]): void {
    this._layerId = layer.id
    this._defMap.clear()
    for (const d of objectDefs) this._defMap.set(d.id, d)

    // Quick dirty check: stringify object ids+positions
    const snap = layer.objects.map(o => `${o.id}|${o.definitionId}|${o.x}|${o.y}`).join(';')
    if (snap === this._lastSnap) return
    this._lastSnap = snap

    this.rebuildAll(layer, tileSize)
  }

  private rebuildAll(layer: MapLayer, tileSize: number): void {
    if (this.sprite) {
      this.container.removeChild(this.sprite)
      this.sprite.texture.destroy(true)
      this.sprite.destroy()
      this.sprite = null
    }
    this._bounds = []

    if (layer.objects.length === 0) return

    // Find bounding box of all objects
    let maxX = 0, maxY = 0
    for (const obj of layer.objects) {
      const def = this._defMap.get(obj.definitionId)
      if (!def) continue
      maxX = Math.max(maxX, (obj.x + def.footprint.w) * tileSize)
      maxY = Math.max(maxY, (obj.y + def.footprint.h) * tileSize)
    }
    if (maxX === 0 || maxY === 0) return

    const canvas = document.createElement('canvas')
    canvas.width = maxX
    canvas.height = maxY
    const ctx = canvas.getContext('2d')!

    for (const obj of layer.objects) {
      const def = this._defMap.get(obj.definitionId)
      if (!def) continue

      const x = obj.x * tileSize
      const y = obj.y * tileSize
      const w = def.footprint.w * tileSize
      const h = def.footprint.h * tileSize
      const color = def.color || '#808080'

      // Building body
      ctx.fillStyle = color
      ctx.fillRect(x, y, w, h)

      // Border
      ctx.strokeStyle = darkenCSS(color, 0.3)
      ctx.lineWidth = 2
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2)

      // Roof highlight
      ctx.strokeStyle = lightenCSS(color, 0.2)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x + 2, y + 2)
      ctx.lineTo(x + w - 2, y + 2)
      ctx.stroke()

      // Door
      const doorW = Math.min(tileSize * 0.4, w * 0.3)
      const doorH = Math.min(tileSize * 0.6, h * 0.4)
      ctx.fillStyle = darkenCSS(color, 0.4)
      ctx.fillRect(x + w / 2 - doorW / 2, y + h - doorH, doorW, doorH)

      // Label
      ctx.fillStyle = '#ffffff'
      ctx.font = `${Math.min(11, tileSize * 0.35)}px monospace`
      ctx.shadowColor = '#000000'
      ctx.shadowOffsetX = 1
      ctx.shadowOffsetY = 1
      ctx.fillText(def.name, x + 3, y + Math.min(13, tileSize * 0.4))
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0

      this._bounds.push({ id: obj.id, layerId: this._layerId, x, y, width: w, height: h })
    }

    const texture = Texture.from(canvas)
    this.sprite = new Sprite(texture)
    this.container.addChild(this.sprite)
  }

  getObjectBounds(): ObjectBounds[] {
    return this._bounds
  }
}

function darkenCSS(hex: string, amount: number): string {
  const c = parseInt(hex.replace('#', ''), 16)
  const r = Math.max(0, Math.floor(((c >> 16) & 0xff) * (1 - amount)))
  const g = Math.max(0, Math.floor(((c >> 8) & 0xff) * (1 - amount)))
  const b = Math.max(0, Math.floor((c & 0xff) * (1 - amount)))
  return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0')
}

function lightenCSS(hex: string, amount: number): string {
  const c = parseInt(hex.replace('#', ''), 16)
  const r = Math.min(255, Math.floor(((c >> 16) & 0xff) * (1 + amount)))
  const g = Math.min(255, Math.floor(((c >> 8) & 0xff) * (1 + amount)))
  const b = Math.min(255, Math.floor((c & 0xff) * (1 + amount)))
  return '#' + r.toString(16).padStart(2, '0') + g.toString(16).padStart(2, '0') + b.toString(16).padStart(2, '0')
}
