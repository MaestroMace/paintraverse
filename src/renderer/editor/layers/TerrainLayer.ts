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
  7: 0xdcdcdc  // snow
}

export const TERRAIN_NAMES: Record<number, string> = {
  0: 'Grass',
  1: 'Dirt',
  2: 'Stone',
  3: 'Water',
  4: 'Sand',
  5: 'Dark Grass',
  6: 'Road',
  7: 'Snow'
}

export class TerrainLayer {
  container: Container
  private graphics: Graphics

  constructor() {
    this.container = new Container()
    this.graphics = new Graphics()
    this.container.addChild(this.graphics)
  }

  update(layer: MapLayer, tileSize: number): void {
    this.graphics.clear()

    if (!layer.terrainTiles) return

    for (let y = 0; y < layer.terrainTiles.length; y++) {
      const row = layer.terrainTiles[y]
      for (let x = 0; x < row.length; x++) {
        const tileId = row[x]
        const color = TERRAIN_COLORS[tileId] ?? TERRAIN_COLORS[0]
        this.graphics.rect(x * tileSize, y * tileSize, tileSize, tileSize)
        this.graphics.fill(color)
      }
    }
  }
}
