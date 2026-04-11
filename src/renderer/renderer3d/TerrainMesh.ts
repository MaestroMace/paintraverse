/**
 * Terrain Mesh v2: Terraced 3D landscape with retaining walls
 *
 * The height map creates stepped plateaus. Where elevation changes,
 * vertical retaining walls appear — creating the dramatic terraced
 * look of hillside Mediterranean/Japanese towns.
 *
 * Terrain is still ONE draw call (merged geometry) but now has Y variation.
 */

import * as THREE from 'three'
import { SimplexNoise } from '../generation/noise'

const TERRAIN_COLORS: Record<number, number> = {
  0: 0x2d5a27, 1: 0x8b7355, 2: 0x708090, 3: 0x4682b4,
  4: 0xf4e9c8, 5: 0x556b2f, 6: 0x3a6a30, 7: 0x8a8a7a,
  8: 0x6a6a68, 9: 0x4a4a48, 10: 0x6a7a5a, 11: 0x6a5a45,
  12: 0x2a5522, 13: 0x9a8a6a,
}

const WALL_COLOR = new THREE.Color(0x706860) // retaining wall stone

/** Regenerate height map from seed (deterministic) */
function generateHeightMap(w: number, h: number, seed: number): number[][] {
  const noise = new SimplexNoise(seed)
  const map: number[][] = []
  for (let y = 0; y < h; y++) {
    const row: number[] = []
    for (let x = 0; x < w; x++) {
      const n1 = noise.fbm(x * 0.03, y * 0.03, 2, 2, 0.5)
      const n2 = noise.fbm(x * 0.06 + 50, y * 0.06 + 50, 2, 2, 0.5)
      const raw = (n1 * 0.7 + n2 * 0.3 + 0.5) * 2.0
      const terraced = Math.round(raw * 2) / 2
      const blend = terraced * 0.7 + raw * 0.3
      row.push(Math.max(0, Math.min(blend, 2.5)))
    }
    map.push(row)
  }
  return map
}

/** Get the height at a tile position (with bounds checking) */
export function getTerrainHeight(heightMap: number[][], x: number, y: number): number {
  if (y < 0 || y >= heightMap.length || x < 0 || x >= (heightMap[0]?.length ?? 0)) return 0
  return heightMap[y][x] * 0.5 // scale: 1 height unit = 0.5 world units
}

export function buildTerrainMesh(
  tiles: number[][], gridWidth: number, gridHeight: number, seed: number = 0
): THREE.Group {
  const group = new THREE.Group()
  const heightMap = generateHeightMap(gridWidth, gridHeight, seed)

  group.add(buildGroundWithHeight(tiles, gridWidth, gridHeight, heightMap))
  group.add(buildRetainingWalls(tiles, gridWidth, gridHeight, heightMap))
  group.add(buildWaterMesh(tiles, gridWidth, gridHeight, heightMap))

  // Store height map on group for other systems to use
  ;(group as any)._heightMap = heightMap

  return group
}

function buildGroundWithHeight(
  tiles: number[][], gridWidth: number, gridHeight: number,
  heightMap: number[][]
): THREE.Mesh {
  const numTiles = gridWidth * gridHeight
  const positions = new Float32Array(numTiles * 6 * 3)
  const colors = new Float32Array(numTiles * 6 * 3)
  let vi = 0

  for (let ty = 0; ty < gridHeight; ty++) {
    for (let tx = 0; tx < gridWidth; tx++) {
      const tileId = tiles[ty]?.[tx] ?? 0
      if (tileId === 3) continue // water handled separately — don't advance vi

      const color = new THREE.Color(TERRAIN_COLORS[tileId] ?? 0x808080)
      const r = color.r, g = color.g, b = color.b

      const tileH = getTerrainHeight(heightMap, tx, ty)
      const y00 = tileH, y10 = tileH, y01 = tileH, y11 = tileH

      const x0 = tx, x1 = tx + 1, z0 = ty, z1 = ty + 1

      positions[vi] = x0; positions[vi+1] = y00; positions[vi+2] = z0
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3
      positions[vi] = x1; positions[vi+1] = y10; positions[vi+2] = z0
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3
      positions[vi] = x1; positions[vi+1] = y11; positions[vi+2] = z1
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3

      positions[vi] = x0; positions[vi+1] = y00; positions[vi+2] = z0
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3
      positions[vi] = x1; positions[vi+1] = y11; positions[vi+2] = z1
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3
      positions[vi] = x0; positions[vi+1] = y01; positions[vi+2] = z1
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions.slice(0, vi), 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors.slice(0, vi), 3))
  geo.computeVertexNormals()

  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0,
  }))
}

/** Build vertical retaining walls where terrain steps between elevation levels */
function buildRetainingWalls(
  tiles: number[][], gridWidth: number, gridHeight: number,
  heightMap: number[][]
): THREE.Mesh {
  const wallVerts: number[] = []
  const wallColors: number[] = []
  const wr = WALL_COLOR.r, wg = WALL_COLOR.g, wb = WALL_COLOR.b

  for (let ty = 0; ty < gridHeight; ty++) {
    for (let tx = 0; tx < gridWidth; tx++) {
      const h = getTerrainHeight(heightMap, tx, ty)

      // Check each neighbor — if lower, add a vertical wall face
      const neighbors: [number, number, number, number, number, number, number, number][] = [
        // [dx, dz, wall x0, wall z0, wall x1, wall z1, nx, nz] (wall edge + normal)
        [1, 0, tx + 1, ty, tx + 1, ty + 1, 1, 0],   // right neighbor
        [-1, 0, tx, ty + 1, tx, ty, -1, 0],           // left neighbor
        [0, 1, tx + 1, ty + 1, tx, ty + 1, 0, 1],    // bottom neighbor
        [0, -1, tx, ty, tx + 1, ty, 0, -1],           // top neighbor
      ]

      for (const [dx, dz, wx0, wz0, wx1, wz1] of neighbors) {
        const nh = getTerrainHeight(heightMap, tx + dx, ty + dz)
        if (nh >= h) continue // neighbor is same or higher — no wall needed

        const wallTop = h
        const wallBot = nh

        // Darken wall color based on facing (simple directional shading)
        const shade = (dx === 1 || dz === 1) ? 0.85 : 1.0
        const cr = wr * shade, cg = wg * shade, cb = wb * shade

        // Two triangles for the wall quad
        wallVerts.push(wx0, wallTop, wz0, wx1, wallTop, wz1, wx1, wallBot, wz1)
        wallVerts.push(wx0, wallTop, wz0, wx1, wallBot, wz1, wx0, wallBot, wz0)
        for (let i = 0; i < 6; i++) wallColors.push(cr, cg, cb)
      }
    }
  }

  if (wallVerts.length === 0) {
    return new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ visible: false }))
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wallVerts), 3))
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(wallColors), 3))
  geo.computeVertexNormals()

  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0,
  }))
}

function buildWaterMesh(
  tiles: number[][], gridWidth: number, gridHeight: number,
  heightMap: number[][]
): THREE.Mesh {
  const positions: number[] = []
  for (let ty = 0; ty < gridHeight; ty++) {
    for (let tx = 0; tx < gridWidth; tx++) {
      if (tiles[ty]?.[tx] !== 3) continue
      const x0 = tx, x1 = tx + 1, z0 = ty, z1 = ty + 1
      // Water sits at the lowest neighboring terrain height
      const h = Math.max(0, getTerrainHeight(heightMap, tx, ty) - 0.08)
      positions.push(x0, h, z0, x1, h, z0, x1, h, z1)
      positions.push(x0, h, z0, x1, h, z1, x0, h, z1)
    }
  }

  if (positions.length === 0) {
    return new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ visible: false }))
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geo.computeVertexNormals()

  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0x3070a0, transparent: true, opacity: 0.75,
    roughness: 0.1, metalness: 0.3, flatShading: true,
  }))
}
