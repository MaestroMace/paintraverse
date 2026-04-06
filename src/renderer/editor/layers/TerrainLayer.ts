import { Container, Sprite, Texture } from 'pixi.js'
import type { MapLayer } from '../../core/types'

// Terrain tile colors
const TERRAIN_COLORS: Record<number, number> = {
  0: 0x2d5a27, // grass (default)
  1: 0x8b7355, // dirt
  2: 0x708090, // stone
  3: 0x4682b4, // water
  4: 0xf4e9c8, // sand
  5: 0x556b2f, // dark grass
  6: 0x3a3a3a, // road/paved
  7: 0xdcdcdc, // snow
  8: 0x6a6a68, // cobblestone
  9: 0x4a4a48  // dark cobblestone
}

export const TERRAIN_NAMES: Record<number, string> = {
  0: 'Grass',
  1: 'Dirt',
  2: 'Stone',
  3: 'Water',
  4: 'Sand',
  5: 'Dark Grass',
  6: 'Road',
  7: 'Snow',
  8: 'Cobblestone',
  9: 'Dark Cobble'
}

function hexToRGB(hex: number): string {
  return '#' + ((hex >> 16) & 0xff).toString(16).padStart(2, '0')
    + ((hex >> 8) & 0xff).toString(16).padStart(2, '0')
    + (hex & 0xff).toString(16).padStart(2, '0')
}

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
        ctx.fillStyle = hexToRGB(color)
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
