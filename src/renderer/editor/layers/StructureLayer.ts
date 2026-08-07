import { Container, Sprite, Texture } from 'pixi.js'
import type { MapLayer, ObjectDefinition } from '../../core/types'
import {
  darkenCSS, lightenCSS, structureTint, fitLabel, drawOutlinedText,
} from './planStyle'

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

    const fontSize = Math.max(8, Math.min(11, tileSize * 0.35))

    for (const obj of layer.objects) {
      const def = this._defMap.get(obj.definitionId)
      if (!def) continue

      const x = obj.x * tileSize
      const y = obj.y * tileSize
      const w = def.footprint.w * tileSize
      const h = def.footprint.h * tileSize
      // Tint toward the building's ROLE. Without this the 34 building types
      // occupy a 30-degree band of brown and the plan cannot be read at all.
      const color = structureTint(def.color || '#808080', def.tags)

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

      // Label — must fit inside its own footprint, and is clipped to it so
      // that it physically cannot bleed into the neighbouring building even
      // if the fitting ever gets it wrong.
      ctx.font = `${fontSize}px monospace`
      const label = fitLabel(ctx, def.name, w - 8)
      if (label && h >= fontSize + 6) {
        ctx.save()
        ctx.beginPath()
        ctx.rect(x, y, w, h)
        ctx.clip()
        drawOutlinedText(ctx, label, x + 4, y + fontSize + 2)
        ctx.restore()
      }

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
