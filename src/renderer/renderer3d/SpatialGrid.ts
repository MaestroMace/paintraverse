// ═══════════════════════════════════════════════════════════════
// Spatial Grid: O(1) visible-object queries
// ═══════════════════════════════════════════════════════════════
// Instead of iterating ALL 800+ objects and checking tile range,
// divide the world into cells and only visit cells in the visible range.
// Reduces per-frame object iteration from ~800 to ~80.

import type { PlacedObject } from '../core/types'

const CELL_SIZE = 8 // tiles per cell

export class SpatialGrid {
  private cells = new Map<number, PlacedObject[]>()
  private gridW: number
  private gridH: number

  constructor(worldWidth: number, worldHeight: number) {
    this.gridW = Math.ceil(worldWidth / CELL_SIZE)
    this.gridH = Math.ceil(worldHeight / CELL_SIZE)
  }

  private cellKey(cx: number, cy: number): number {
    return cy * this.gridW + cx
  }

  clear(): void {
    this.cells.clear()
  }

  insert(obj: PlacedObject): void {
    const cx = Math.floor(obj.x / CELL_SIZE)
    const cy = Math.floor(obj.y / CELL_SIZE)
    const key = this.cellKey(
      Math.max(0, Math.min(cx, this.gridW - 1)),
      Math.max(0, Math.min(cy, this.gridH - 1))
    )
    let cell = this.cells.get(key)
    if (!cell) {
      cell = []
      this.cells.set(key, cell)
    }
    cell.push(obj)
  }

  insertAll(objects: PlacedObject[]): void {
    for (const obj of objects) this.insert(obj)
  }

  /** Query all objects in cells overlapping the given tile range */
  query(minTileX: number, minTileY: number, maxTileX: number, maxTileY: number): PlacedObject[] {
    const minCX = Math.max(0, Math.floor(minTileX / CELL_SIZE))
    const minCY = Math.max(0, Math.floor(minTileY / CELL_SIZE))
    const maxCX = Math.min(this.gridW - 1, Math.floor(maxTileX / CELL_SIZE))
    const maxCY = Math.min(this.gridH - 1, Math.floor(maxTileY / CELL_SIZE))

    const result: PlacedObject[] = []
    for (let cy = minCY; cy <= maxCY; cy++) {
      for (let cx = minCX; cx <= maxCX; cx++) {
        const cell = this.cells.get(this.cellKey(cx, cy))
        if (cell) {
          for (const obj of cell) result.push(obj)
        }
      }
    }
    return result
  }
}
