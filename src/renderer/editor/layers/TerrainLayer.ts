import { Container, Graphics } from 'pixi.js'
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

const CHUNK_SIZE = 16

export class TerrainLayer {
  container: Container
  private chunks: Map<string, Graphics> = new Map()
  private dirtyChunks: Set<string> = new Set()
  private lastTiles: number[][] | null = null
  private lastTileSize = 0

  constructor() {
    this.container = new Container()
  }

  // setApp no longer needed — we don't use RenderTexture
  setApp(_app: unknown): void { /* no-op for API compatibility */ }

  update(layer: MapLayer, tileSize: number): void {
    if (!layer.terrainTiles) return

    const tiles = layer.terrainTiles
    const gridH = tiles.length
    const gridW = gridH > 0 ? tiles[0].length : 0

    if (tileSize !== this.lastTileSize || !this.lastTiles) {
      this.rebuildAll(tiles, tileSize, gridW, gridH)
      this.lastTiles = tiles
      this.lastTileSize = tileSize
      return
    }

    // Fast diff: only check rows whose reference changed
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

    for (const ck of this.dirtyChunks) {
      const [cx, cy] = ck.split(',').map(Number)
      this.renderChunk(cx, cy, tiles, tileSize, gridW, gridH)
    }
    this.dirtyChunks.clear()

    this.lastTiles = tiles
  }

  private rebuildAll(tiles: number[][], tileSize: number, gridW: number, gridH: number): void {
    for (const g of this.chunks.values()) {
      this.container.removeChild(g)
      g.destroy()
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
    const key = `${cx},${cy}`
    const startX = cx * CHUNK_SIZE
    const startY = cy * CHUNK_SIZE
    const endX = Math.min(startX + CHUNK_SIZE, gridW)
    const endY = Math.min(startY + CHUNK_SIZE, gridH)

    // Draw tiles directly as Graphics — no RenderTexture needed.
    // RenderTexture calls PixiJS's WebGL renderer.render() which crashes
    // SwiftShader when many chunks are created at once (e.g. map generation).
    const g = new Graphics()
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const tileId = tiles[y]?.[x] ?? 0
        const color = TERRAIN_COLORS[tileId] ?? TERRAIN_COLORS[0]
        g.rect(x * tileSize, y * tileSize, tileSize, tileSize)
        g.fill(color)
      }
    }

    // Replace or create chunk
    const existing = this.chunks.get(key)
    if (existing) {
      this.container.removeChild(existing)
      existing.destroy()
    }
    this.container.addChild(g)
    this.chunks.set(key, g)
  }

  markTileDirty(tileX: number, tileY: number): void {
    const ck = `${Math.floor(tileX / CHUNK_SIZE)},${Math.floor(tileY / CHUNK_SIZE)}`
    this.dirtyChunks.add(ck)
  }
}
