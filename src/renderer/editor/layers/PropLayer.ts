import { Container, Sprite, Texture } from 'pixi.js'
import type { MapLayer, ObjectDefinition, PlacedObject } from '../../core/types'
import type { ObjectBounds } from './StructureLayer'

/**
 * PropLayer renders all props to a single Canvas2D texture.
 * Same approach as StructureLayer — avoids SwiftShader crash from too many draw calls.
 */
export class PropLayer {
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

      const px = obj.x * tileSize
      const py = obj.y * tileSize
      const w = def.footprint.w * tileSize
      const h = def.footprint.h * tileSize
      const color = def.color || '#808080'

      if (def.footprint.w === 1 && def.footprint.h === 1) {
        const cx = px + tileSize / 2
        const cy = py + tileSize / 2
        const r = tileSize * 0.32

        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.2)'
        ctx.beginPath()
        ctx.arc(cx + 1, cy + 1, r, 0, Math.PI * 2)
        ctx.fill()

        // Body
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.fill()

        ctx.strokeStyle = darkenCSS(color, 0.3)
        ctx.lineWidth = 1
        ctx.stroke()

        // Label (first letter)
        ctx.fillStyle = '#ffffff'
        ctx.font = `${Math.min(9, tileSize * 0.3)}px monospace`
        ctx.shadowColor = '#000000'
        ctx.shadowOffsetX = 1
        ctx.shadowOffsetY = 1
        ctx.fillText(def.name[0], px + tileSize * 0.33, py + tileSize * 0.55)
        ctx.shadowOffsetX = 0
        ctx.shadowOffsetY = 0
      } else {
        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.15)'
        roundRect(ctx, px + 3, py + 3, w - 4, h - 4, 4)
        ctx.fill()

        // Body
        ctx.fillStyle = color
        roundRect(ctx, px + 2, py + 2, w - 4, h - 4, 4)
        ctx.fill()

        ctx.strokeStyle = darkenCSS(color, 0.3)
        ctx.lineWidth = 1
        ctx.stroke()

        // Label
        ctx.fillStyle = '#ffffff'
        ctx.font = `${Math.min(10, tileSize * 0.3)}px monospace`
        ctx.shadowColor = '#000000'
        ctx.shadowOffsetX = 1
        ctx.shadowOffsetY = 1
        ctx.fillText(def.name, px + 3, py + Math.min(12, tileSize * 0.35))
        ctx.shadowOffsetX = 0
        ctx.shadowOffsetY = 0
      }

      this._bounds.push({ id: obj.id, layerId: this._layerId, x: px, y: py, width: w, height: h })
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arcTo(x + w, y, x + w, y + r, r)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.lineTo(x, y + r)
  ctx.arcTo(x, y, x + r, y, r)
  ctx.closePath()
}
