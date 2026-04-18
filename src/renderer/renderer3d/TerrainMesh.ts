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

// Tile palette — deliberately punchy so districts read as distinct zones.
// Cobblestone (8) shifted to warm orange-grey so it visually differs from
// the blue-grey noble-district stone (2). Alley (9) pushed warmer-darker.
const TERRAIN_COLORS: Record<number, number> = {
  0: 0x4a8a3a,  // grass — vivid spring green
  1: 0xa88868,  // dirt — warm earthy tan
  2: 0xc8c0a8,  // stone — pale warm sandstone (was cool blue-grey)
  3: 0x4682b4,  // water — handled separately
  4: 0xe8d090,  // sand — warm light yellow
  5: 0x3a7a28,  // dark grass — forest green
  6: 0x5aae4a,  // light grass — more saturated vivid green
  7: 0xb0a898,  // gravel — warm light grey
  8: 0xb09878,  // cobblestone road — warm orange-grey (distinct from alley)
  9: 0x584838,  // dark cobblestone alley — deep warm brown
  10: 0x70a060, // garden — green-ish
  11: 0x7a5c3a, // mud — saturated brown
  12: 0x78b040, // wildflower — bright apple green
  13: 0xd8c490, // gravel/path — warm sandy
}

const WALL_COLOR = new THREE.Color(0x887868) // retaining wall stone — warm sandstone

/** Regenerate height map from seed (deterministic). Values 0..5.5 in raw
 *  units; world-unit scale applied in getTerrainHeight. Three-octave noise
 *  plus light terracing so plateaus are visible but not mechanical. */
function generateHeightMap(w: number, h: number, seed: number): number[][] {
  const noise = new SimplexNoise(seed)
  const map: number[][] = []
  for (let y = 0; y < h; y++) {
    const row: number[] = []
    for (let x = 0; x < w; x++) {
      // Broad primary hill shape + mid-scale detail. Low primary freq
      // (0.022) means ~1–2 hill humps across a 48-tile map, which reads
      // as real topography instead of noise texture.
      const n1 = noise.fbm(x * 0.022, y * 0.022, 3, 2, 0.5)
      const n2 = noise.fbm(x * 0.055 + 50, y * 0.055 + 50, 2, 2, 0.5)
      const n3 = noise.fbm(x * 0.11 + 120, y * 0.11 + 120, 1, 2, 0.5) * 0.4
      // Raw range expanded to 0..5.5 (was 0..4).
      const raw = (n1 * 0.6 + n2 * 0.3 + n3 * 0.1 + 0.5) * 4.4
      // Terrace at 0.5-unit steps, then 60/40 blend with raw so there are
      // clear plateaus but slopes between them are smooth.
      const terraced = Math.round(raw * 2) / 2
      const blend = terraced * 0.6 + raw * 0.4
      row.push(Math.max(0, Math.min(blend, 5.5)))
    }
    map.push(row)
  }
  return map
}

/** World height scale: one raw height unit equals this many world units. */
const TERRAIN_WORLD_SCALE = 1.8

/** Get the height at a tile position (with bounds checking) in world units. */
export function getTerrainHeight(heightMap: number[][], x: number, y: number): number {
  if (y < 0 || y >= heightMap.length || x < 0 || x >= (heightMap[0]?.length ?? 0)) return 0
  return heightMap[y][x] * TERRAIN_WORLD_SCALE
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
      const tileH = getTerrainHeight(heightMap, tx, ty)

      // Elevation-based color shift: high ground gets a grey/rocky bias,
      // low ground stays saturated. Only applied to natural tiles (grass,
      // dirt, gravel, garden, wildflower); roads/cobblestone keep their
      // designed color.
      const isNatural = tileId === 0 || tileId === 1 || tileId === 4 ||
        tileId === 5 || tileId === 6 || tileId === 7 || tileId === 10 ||
        tileId === 11 || tileId === 12 || tileId === 13
      let r = color.r, g = color.g, b = color.b
      if (isNatural) {
        const normH = Math.min(1, tileH / 6) // 0 at valley, ~1 at peak
        // Bias toward rocky grey (0.55, 0.52, 0.48) as elevation rises.
        const rockMix = Math.max(0, (normH - 0.35) * 1.2)
        const rR = 0.55, rG = 0.52, rB = 0.48
        r = r * (1 - rockMix) + rR * rockMix
        g = g * (1 - rockMix) + rG * rockMix
        b = b * (1 - rockMix) + rB * rockMix
        // Darken lowlands slightly — valley = wetter / shaded.
        const shadowMix = Math.max(0, (0.25 - normH) * 0.8)
        r *= (1 - shadowMix * 0.3)
        g *= (1 - shadowMix * 0.25)
        b *= (1 - shadowMix * 0.2)
      }

      const x0 = tx, x1 = tx + 1, z0 = ty, z1 = ty + 1

      // Triangle 1: CCW winding when viewed from above → normal points UP (+Y)
      positions[vi] = x0; positions[vi+1] = tileH; positions[vi+2] = z0
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3
      positions[vi] = x1; positions[vi+1] = tileH; positions[vi+2] = z1
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3
      positions[vi] = x1; positions[vi+1] = tileH; positions[vi+2] = z0
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3

      // Triangle 2: CCW winding when viewed from above → normal points UP (+Y)
      positions[vi] = x0; positions[vi+1] = tileH; positions[vi+2] = z0
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3
      positions[vi] = x0; positions[vi+1] = tileH; positions[vi+2] = z1
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3
      positions[vi] = x1; positions[vi+1] = tileH; positions[vi+2] = z1
      colors[vi] = r; colors[vi+1] = g; colors[vi+2] = b; vi += 3
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(positions.slice(0, vi), 3))
  geo.setAttribute('color', new THREE.BufferAttribute(colors.slice(0, vi), 3))
  geo.computeVertexNormals()

  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true,
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

  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    vertexColors: true, flatShading: true,
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
      // CCW winding for upward-facing normals (same fix as ground tiles)
      positions.push(x0, h, z0, x1, h, z1, x1, h, z0)
      positions.push(x0, h, z0, x0, h, z1, x1, h, z1)
    }
  }

  if (positions.length === 0) {
    return new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ visible: false }))
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geo.computeVertexNormals()

  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
    color: 0x3070a0, transparent: true, opacity: 0.75, flatShading: true,
  }))
}
