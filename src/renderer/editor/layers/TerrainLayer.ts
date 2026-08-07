import { Container, Sprite, Texture } from 'pixi.js'
import type { MapLayer } from '../../core/types'

// The palette and names live in core/terrain.ts — this file used to own its
// own copy, which is how the editor ended up offering a "Road" swatch that
// painted grass and drawing the generator's rocky ground as snow. Re-exported
// because the texture browser imports them from here.
export { TERRAIN_COLORS, TERRAIN_NAMES } from '../../core/terrain'
import { TERRAIN_COLORS, TILE_WATER } from '../../core/terrain'
import { groundWash } from './planStyle'

/**
 * TerrainLayer renders the entire terrain as a single Sprite with a Canvas2D-generated texture.
 * This avoids flooding PixiJS/SwiftShader with thousands of Graphics draw calls.
 * A 48x48 map at 32px tiles = one 1536x1536 Canvas2D image → one PixiJS Sprite.
 */
export class TerrainLayer {
  container: Container
  private sprite: Sprite | null = null
  private lastTiles: number[][] | null = null
  private lastTileSize = 0

  constructor() {
    this.container = new Container()
  }

  setApp(_app: unknown): void { /* no-op for API compatibility */ }

  update(layer: MapLayer, tileSize: number): void {
    if (!layer.terrainTiles) return

    const tiles = layer.terrainTiles
    const gridH = tiles.length
    const gridW = gridH > 0 ? tiles[0].length : 0

    // Full rebuild if tileSize changed or first load
    if (tileSize !== this.lastTileSize || !this.lastTiles) {
      this.rebuildAll(tiles, tileSize, gridW, gridH)
      this.lastTiles = tiles
      this.lastTileSize = tileSize
      return
    }

    // Incremental: check if any tiles changed
    let dirty = false
    for (let y = 0; y < gridH && !dirty; y++) {
      if (tiles[y] !== this.lastTiles[y]) {
        for (let x = 0; x < gridW; x++) {
          if (tiles[y][x] !== this.lastTiles[y][x]) {
            dirty = true
            break
          }
        }
      }
    }

    if (dirty) {
      this.rebuildAll(tiles, tileSize, gridW, gridH)
    }

    this.lastTiles = tiles
  }

  private rebuildAll(tiles: number[][], tileSize: number, gridW: number, gridH: number): void {
    // Remove old sprite
    if (this.sprite) {
      this.container.removeChild(this.sprite)
      this.sprite.texture.destroy(true)
      this.sprite.destroy()
      this.sprite = null
    }

    if (gridW === 0 || gridH === 0) return

    // Draw terrain to an offscreen Canvas2D (pure CPU, no WebGL)
    const canvas = document.createElement('canvas')
    canvas.width = gridW * tileSize
    canvas.height = gridH * tileSize
    const ctx = canvas.getContext('2d')!

    for (let y = 0; y < gridH; y++) {
      for (let x = 0; x < gridW; x++) {
        const tileId = tiles[y]?.[x] ?? 0
        const color = TERRAIN_COLORS[tileId] ?? TERRAIN_COLORS[0]
        // Washed back so buildings and props read as figure against it.
        ctx.fillStyle = groundWash(color, tileId === TILE_WATER)
        ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize)
      }
    }

    // Create PixiJS texture from the canvas (uploads as a single GPU texture)
    const texture = Texture.from(canvas)
    this.sprite = new Sprite(texture)
    this.container.addChild(this.sprite)
  }

  markTileDirty(_tileX: number, _tileY: number): void {
    // Next update() call will detect the change via reference diff
  }
}
