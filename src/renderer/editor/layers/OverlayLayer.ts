import { Container, Graphics } from 'pixi.js'
import type { ObjectBounds } from './StructureLayer'
import type { RenderCamera } from '../../core/types'

export class OverlayLayer {
  container: Container
  private selectionGraphics: Graphics
  private previewGraphics: Graphics
  private hoverGraphics: Graphics
  private cameraGraphics: Graphics

  constructor() {
    this.container = new Container()
    this.hoverGraphics = new Graphics()
    this.selectionGraphics = new Graphics()
    this.previewGraphics = new Graphics()
    this.cameraGraphics = new Graphics()
    this.container.addChild(this.cameraGraphics)
    this.container.addChild(this.hoverGraphics)
    this.container.addChild(this.selectionGraphics)
    this.container.addChild(this.previewGraphics)
  }

  updateSelection(
    selectedIds: string[],
    hoveredId: string | null,
    _tileSize: number,
    allObjects: ObjectBounds[]
  ): void {
    this.selectionGraphics.clear()
    this.hoverGraphics.clear()

    if (hoveredId && !selectedIds.includes(hoveredId)) {
      const obj = allObjects.find((o) => o.id === hoveredId)
      if (obj) {
        this.hoverGraphics.setStrokeStyle({ width: 3, color: 0x66aaff, alpha: 0.4 })
        this.hoverGraphics.rect(obj.x - 3, obj.y - 3, obj.width + 6, obj.height + 6)
        this.hoverGraphics.stroke()
        this.hoverGraphics.setStrokeStyle({ width: 1.5, color: 0x66aaff })
        this.hoverGraphics.rect(obj.x - 1, obj.y - 1, obj.width + 2, obj.height + 2)
        this.hoverGraphics.stroke()
      }
    }

    for (const id of selectedIds) {
      const obj = allObjects.find((o) => o.id === id)
      if (!obj) continue

      this.selectionGraphics.setStrokeStyle({ width: 3, color: 0xffaa00, alpha: 0.3 })
      this.selectionGraphics.rect(obj.x - 3, obj.y - 3, obj.width + 6, obj.height + 6)
      this.selectionGraphics.stroke()
      this.selectionGraphics.setStrokeStyle({ width: 1.5, color: 0xffcc33 })
      this.selectionGraphics.rect(obj.x - 1, obj.y - 1, obj.width + 2, obj.height + 2)
      this.selectionGraphics.stroke()

      const hs = 5
      const corners = [
        [obj.x - hs / 2, obj.y - hs / 2],
        [obj.x + obj.width - hs / 2, obj.y - hs / 2],
        [obj.x - hs / 2, obj.y + obj.height - hs / 2],
        [obj.x + obj.width - hs / 2, obj.y + obj.height - hs / 2]
      ]
      for (const [cx, cy] of corners) {
        this.selectionGraphics.rect(cx, cy, hs, hs)
        this.selectionGraphics.fill(0xffcc33)
        this.selectionGraphics.setStrokeStyle({ width: 1, color: 0x000000 })
        this.selectionGraphics.rect(cx, cy, hs, hs)
        this.selectionGraphics.stroke()
      }
    }
  }

  showCameraFrustum(camera: RenderCamera, tileSize: number): void {
    this.cameraGraphics.clear()

    const cx = camera.worldX * tileSize + tileSize / 2
    const cy = camera.worldY * tileSize + tileSize / 2
    const lx = camera.lookAtX * tileSize + tileSize / 2
    const ly = camera.lookAtY * tileSize + tileSize / 2

    // Direction vector from camera to lookAt
    const dx = lx - cx
    const dy = ly - cy
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < 1) return

    const ndx = dx / dist
    const ndy = dy / dist

    // Perpendicular vector
    const px = -ndy
    const py = ndx

    // Frustum visualization: show a cone/trapezoid from camera toward lookAt
    const fovRad = (camera.fov * Math.PI) / 180
    const nearDist = tileSize * 2
    const farDist = Math.max(dist * 1.2, tileSize * 8)
    const nearHalf = Math.tan(fovRad / 2) * nearDist
    const farHalf = Math.tan(fovRad / 2) * farDist

    // Frustum corner points
    const nearL_x = cx + ndx * nearDist + px * nearHalf
    const nearL_y = cy + ndy * nearDist + py * nearHalf
    const nearR_x = cx + ndx * nearDist - px * nearHalf
    const nearR_y = cy + ndy * nearDist - py * nearHalf
    const farL_x = cx + ndx * farDist + px * farHalf
    const farL_y = cy + ndy * farDist + py * farHalf
    const farR_x = cx + ndx * farDist - px * farHalf
    const farR_y = cy + ndy * farDist + py * farHalf

    // Fill frustum area
    this.cameraGraphics.moveTo(cx, cy)
    this.cameraGraphics.lineTo(farL_x, farL_y)
    this.cameraGraphics.lineTo(farR_x, farR_y)
    this.cameraGraphics.lineTo(cx, cy)
    this.cameraGraphics.fill({ color: 0x44aaff, alpha: 0.08 })

    // Frustum outline
    this.cameraGraphics.setStrokeStyle({ width: 1.5, color: 0x44aaff, alpha: 0.5 })
    this.cameraGraphics.moveTo(cx, cy)
    this.cameraGraphics.lineTo(farL_x, farL_y)
    this.cameraGraphics.lineTo(farR_x, farR_y)
    this.cameraGraphics.lineTo(cx, cy)
    this.cameraGraphics.stroke()

    // Near plane line
    this.cameraGraphics.setStrokeStyle({ width: 1, color: 0x44aaff, alpha: 0.3 })
    this.cameraGraphics.moveTo(nearL_x, nearL_y)
    this.cameraGraphics.lineTo(nearR_x, nearR_y)
    this.cameraGraphics.stroke()

    // Direction line from camera to lookAt
    this.cameraGraphics.setStrokeStyle({ width: 2, color: 0xff6644, alpha: 0.7 })
    this.cameraGraphics.moveTo(cx, cy)
    this.cameraGraphics.lineTo(lx, ly)
    this.cameraGraphics.stroke()

    // LookAt target crosshair
    const chSize = tileSize * 0.4
    this.cameraGraphics.setStrokeStyle({ width: 2, color: 0xff6644, alpha: 0.8 })
    this.cameraGraphics.moveTo(lx - chSize, ly)
    this.cameraGraphics.lineTo(lx + chSize, ly)
    this.cameraGraphics.moveTo(lx, ly - chSize)
    this.cameraGraphics.lineTo(lx, ly + chSize)
    this.cameraGraphics.stroke()
    this.cameraGraphics.circle(lx, ly, chSize * 0.6)
    this.cameraGraphics.stroke()

    // Camera icon (filled triangle pointing in look direction)
    const iconSize = tileSize * 0.5
    const tipX = cx + ndx * iconSize
    const tipY = cy + ndy * iconSize
    const baseL_x = cx + px * iconSize * 0.5
    const baseL_y = cy + py * iconSize * 0.5
    const baseR_x = cx - px * iconSize * 0.5
    const baseR_y = cy - py * iconSize * 0.5

    this.cameraGraphics.moveTo(tipX, tipY)
    this.cameraGraphics.lineTo(baseL_x, baseL_y)
    this.cameraGraphics.lineTo(baseR_x, baseR_y)
    this.cameraGraphics.lineTo(tipX, tipY)
    this.cameraGraphics.fill(0x44aaff)

    // Camera body circle
    this.cameraGraphics.circle(cx, cy, iconSize * 0.35)
    this.cameraGraphics.fill(0x2266aa)
    this.cameraGraphics.setStrokeStyle({ width: 2, color: 0x44aaff })
    this.cameraGraphics.circle(cx, cy, iconSize * 0.35)
    this.cameraGraphics.stroke()

    // Height label
    // (text rendering would need Text object, skip for now - the camera icon + frustum is clear enough)
  }

  clearCamera(): void {
    this.cameraGraphics.clear()
  }

  showPlacementPreview(
    tileX: number, tileY: number,
    width: number, height: number,
    tileSize: number,
    valid: boolean
  ): void {
    this.previewGraphics.clear()
    const px = tileX * tileSize
    const py = tileY * tileSize
    const pw = width * tileSize
    const ph = height * tileSize
    const color = valid ? 0x66aaff : 0xff4444

    this.previewGraphics.rect(px, py, pw, ph)
    this.previewGraphics.fill({ color, alpha: 0.2 })
    this.previewGraphics.setStrokeStyle({ width: 2, color, alpha: 0.8 })
    this.previewGraphics.rect(px, py, pw, ph)
    this.previewGraphics.stroke()

    const cx = px + pw / 2
    const cy = py + ph / 2
    this.previewGraphics.setStrokeStyle({ width: 1, color, alpha: 0.5 })
    this.previewGraphics.moveTo(cx - 6, cy)
    this.previewGraphics.lineTo(cx + 6, cy)
    this.previewGraphics.moveTo(cx, cy - 6)
    this.previewGraphics.lineTo(cx, cy + 6)
    this.previewGraphics.stroke()
  }

  showTileHighlight(tileX: number, tileY: number, tileSize: number): void {
    this.previewGraphics.clear()
    this.previewGraphics.rect(tileX * tileSize, tileY * tileSize, tileSize, tileSize)
    this.previewGraphics.fill({ color: 0xffffff, alpha: 0.1 })
    this.previewGraphics.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.3 })
    this.previewGraphics.rect(tileX * tileSize, tileY * tileSize, tileSize, tileSize)
    this.previewGraphics.stroke()
  }

  clearPreview(): void {
    this.previewGraphics.clear()
  }
}
