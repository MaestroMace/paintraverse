import { Container, Sprite, Texture } from 'pixi.js'
import type { MapLayer, ObjectDefinition } from '../../core/types'
// The RESERVED rectangle, not the definition's. The plan view drew every
// object at def.footprint, which agrees with the reservation only while
// nothing rotates a plot — and plot orientation swaps w/h. This is the file
// CLAUDE.md names in its list of ten independent footprint lookups.
import { footprintOf } from '../../core/types'
import type { ObjectBounds } from './StructureLayer'
import {
  darkenCSS, propTint, glyphFor, drawGlyph, fitLabel, drawOutlinedText,
} from './planStyle'

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
      const pfp = footprintOf(obj, def)
      maxX = Math.max(maxX, (obj.x + pfp.w) * tileSize)
      maxY = Math.max(maxY, (obj.y + pfp.h) * tileSize)
    }
    if (maxX === 0 || maxY === 0) return

    const canvas = document.createElement('canvas')
    canvas.width = maxX
    canvas.height = maxY
    const ctx = canvas.getContext('2d')!

    const fontSize = Math.max(8, Math.min(10, tileSize * 0.3))

    for (const obj of layer.objects) {
      const def = this._defMap.get(obj.definitionId)
      if (!def) continue

      const px = obj.x * tileSize
      const py = obj.y * tileSize
      const fp = footprintOf(obj, def)
      const w = fp.w * tileSize
      const h = fp.h * tileSize
      const color = propTint(def.color || '#808080', def.tags)

      if (fp.w === 1 && fp.h === 1) {
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

        ctx.strokeStyle = darkenCSS(color, 0.35)
        ctx.lineWidth = 1
        ctx.stroke()

        // Glyph instead of `def.name[0]`. The first letter collapsed barrel,
        // bench, bush, barrel_stack, bunting_pole and bakery-crate all onto
        // "B"; a shape at least tells you it is storage rather than planting.
        // Below ~14px the glyph is finer than the disc it sits on, so the
        // disc's colour carries it alone.
        if (tileSize >= 14) {
          ctx.strokeStyle = 'rgba(20,14,10,0.78)'
          ctx.lineWidth = Math.max(1, tileSize * 0.055)
          ctx.lineCap = 'round'
          drawGlyph(ctx, glyphFor(def.tags), cx, cy, r)
          ctx.lineCap = 'butt'
        }
      } else {
        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.15)'
        roundRect(ctx, px + 3, py + 3, w - 4, h - 4, 4)
        ctx.fill()

        // Body
        ctx.fillStyle = color
        roundRect(ctx, px + 2, py + 2, w - 4, h - 4, 4)
        ctx.fill()

        ctx.strokeStyle = darkenCSS(color, 0.35)
        ctx.lineWidth = 1
        ctx.stroke()

        // Glyph in the corner marks the class; the label names the instance
        // when there is room for it.
        const gr = Math.min(tileSize, w, h) * 0.28
        ctx.strokeStyle = 'rgba(20,14,10,0.7)'
        ctx.lineWidth = Math.max(1, tileSize * 0.05)
        ctx.lineCap = 'round'
        drawGlyph(ctx, glyphFor(def.tags), px + w - gr - 4, py + h - gr - 4, gr)
        ctx.lineCap = 'butt'

        ctx.font = `${fontSize}px monospace`
        const label = fitLabel(ctx, def.name, w - 8)
        if (label && h >= fontSize + 6) {
          ctx.save()
          ctx.beginPath()
          ctx.rect(px, py, w, h)
          ctx.clip()
          drawOutlinedText(ctx, label, px + 4, py + fontSize + 2)
          ctx.restore()
        }
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
