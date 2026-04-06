import { Container, Graphics, RenderTexture, Sprite } from 'pixi.js'
import type { MapLayer } from '../../core/types'
import type { Application } from 'pixi.js'

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

// Chunk size in tiles - render groups of tiles into a single texture
const CHUNK_SIZE = 16

export class TerrainLayer {
  container: Container
  private chunks: Map<string, { sprite: Sprite; texture: RenderTexture }> = new Map()
  private dirtyChunks: Set<string> = new Set()
  private lastTiles: number[][] | null = null
  private lastTileSize = 0
  private app: Application | null = null

  constructor() {
    this.container = new Container()
  }

  setApp(app: Application): void {
    this.app = app
  }

  update(layer: MapLayer, tileSize: number): void {
    if (!layer.terrainTiles || !this.app) return

    const tiles = layer.terrainTiles
    const gridH = tiles.length
    const gridW = gridH > 0 ? tiles[0].length : 0

    // If tileSize changed or first load, mark everything dirty
    if (tileSize !== this.lastTileSize || !this.lastTiles) {
      this.rebuildAll(tiles, tileSize, gridW, gridH)
      this.lastTiles = tiles
      this.lastTileSize = tileSize
      return
    }

    // Fast diff: only check rows whose reference changed (store only clones changed rows)
    for (let y = 0; y < gridH; y++) {
      if (tiles[y] !== this.lastTiles[y]) {
        for (let x = 0; x < gridW; x++) {
          if (tiles[y][x] !== this.lastTiles[y][x]) {
            const ck = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(y / CHUNK_SIZE)}`
            this.dirtyChunks.add(ck)
          }
        }
      }
    }

    // Only re-render dirty chunks
    for (const ck of this.dirtyChunks) {
      const [cx, cy] = ck.split(',').map(Number)
      this.renderChunk(cx, cy, tiles, tileSize, gridW, gridH)
    }
    this.dirtyChunks.clear()

    // Store reference (no cloning needed — store creates new row arrays for changes)
    this.lastTiles = tiles
  }

  private rebuildAll(tiles: number[][], tileSize: number, gridW: number, gridH: number): void {
    // Dispose old chunks
    for (const { sprite, texture } of this.chunks.values()) {
      this.container.removeChild(sprite)
      sprite.destroy()
      texture.destroy()
    }
    this.chunks.clear()

    const chunksX = Math.ceil(gridW / CHUNK_SIZE)
    const chunksY = Math.ceil(gridH / CHUNK_SIZE)

    for (let cy = 0; cy < chunksY; cy++) {
      for (let cx = 0; cx < chunksX; cx++) {
        this.renderChunk(cx, cy, tiles, tileSize, gridW, gridH)
      }
    }
  }

  private renderChunk(
    cx: number, cy: number,
    tiles: number[][], tileSize: number,
    gridW: number, gridH: number
  ): void {
    if (!this.app) return

    const key = `${cx},${cy}`
    const startX = cx * CHUNK_SIZE
    const startY = cy * CHUNK_SIZE
    const endX = Math.min(startX + CHUNK_SIZE, gridW)
    const endY = Math.min(startY + CHUNK_SIZE, gridH)
    const pixelW = (endX - startX) * tileSize
    const pixelH = (endY - startY) * tileSize

    // Draw tiles into a temporary Graphics
    const g = new Graphics()
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const tileId = tiles[y]?.[x] ?? 0
        const color = TERRAIN_COLORS[tileId] ?? TERRAIN_COLORS[0]
        g.rect((x - startX) * tileSize, (y - startY) * tileSize, tileSize, tileSize)
        g.fill(color)
      }
    }

    // Get or create render texture + sprite for this chunk
    let entry = this.chunks.get(key)
    if (entry) {
      // Reuse existing texture - re-render into it
      entry.texture.resize(pixelW, pixelH)
      this.app.renderer.render({ container: g, target: entry.texture, clear: true })
    } else {
      const texture = RenderTexture.create({ width: pixelW, height: pixelH })
      this.app.renderer.render({ container: g, target: texture, clear: true })
      const sprite = new Sprite(texture)
      sprite.x = startX * tileSize
      sprite.y = startY * tileSize
      this.container.addChild(sprite)
      entry = { sprite, texture }
      this.chunks.set(key, entry)
    }

    g.destroy()
  }

  markTileDirty(tileX: number, tileY: number): void {
    const ck = `${Math.floor(tileX / CHUNK_SIZE)},${Math.floor(tileY / CHUNK_SIZE)}`
    this.dirtyChunks.add(ck)
  }
}
