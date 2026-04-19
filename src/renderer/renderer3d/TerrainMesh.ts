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
import { BatchedMeshBuilder } from './BatchedMeshBuilder'
import { createCobbleTexture } from './CobbleTexture'

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
      const raw = (n1 * 0.6 + n2 * 0.3 + n3 * 0.1 + 0.5) * 4.4
      // Mostly smooth terrain (90% raw) with a light terrace pull (10%)
      // so plateaus still hint in the data but don't dominate. Traverse
      // Town / Kyoto / Paris-style streets gently slope; discrete 1-tile
      // steps read as a staircase map bug rather than topography. Any
      // real stairs are emitted by the staircase prop generator.
      const terraced = Math.round(raw * 1.2) / 1.2
      const blend = terraced * 0.1 + raw * 0.9
      row.push(Math.max(0, Math.min(blend, 5.5)))
    }
    map.push(row)
  }
  return map
}

/** World height scale: one raw height unit equals this many world units. */
const TERRAIN_WORLD_SCALE = 1.8

/** Get the height at a tile position (with bounds checking) in world units.
 *  Floors x/y internally so callers can safely pass fractional world coords
 *  (e.g. the FPS camera's x/z) without crashing into `heightMap[14.3]` →
 *  undefined → NaN, which is what bricked the walkaround. */
export function getTerrainHeight(heightMap: number[][], x: number, y: number): number {
  const ix = Math.floor(x), iy = Math.floor(y)
  if (iy < 0 || iy >= heightMap.length || ix < 0 || ix >= (heightMap[0]?.length ?? 0)) return 0
  return heightMap[iy][ix] * TERRAIN_WORLD_SCALE
}

/**
 * Per-vertex (corner) Y micro-jitter so the ground isn't perfectly flat
 * tile-quads. Deterministic from integer corner coordinates — 4 tiles
 * sharing a corner all sample the same value, so no cracks. Amplitude is
 * ±0.06 world units; below the threshold where building plinths / wall
 * meshes sit visibly above the terrain.
 */
function cornerHeightNoise(cx: number, cy: number): number {
  const n = ((cx * 374761393 + cy * 668265263) ^ 0x9e3779b1) >>> 0
  return ((n / 0xffffffff) - 0.5) * 0.12
}

export function buildTerrainMesh(
  tiles: number[][], gridWidth: number, gridHeight: number, seed: number = 0
): THREE.Group {
  const group = new THREE.Group()
  const heightMap = generateHeightMap(gridWidth, gridHeight, seed)

  group.add(buildGroundWithHeight(tiles, gridWidth, gridHeight, heightMap))
  group.add(buildRetainingWalls(tiles, gridWidth, gridHeight, heightMap))
  group.add(buildWaterMesh(tiles, gridWidth, gridHeight, heightMap))
  // Road surfaces: a separate textured mesh overlaid on the ground tiles,
  // kills the tile-grid appearance by showing a continuous cobble pattern
  // across adjacent road tiles. Pucks are gone — the texture alone sells
  // the cobble look; geometric pucks read as alien disks on top.
  const roads = buildRoadSurface(tiles, gridWidth, gridHeight, heightMap, false)
  if (roads) group.add(roads)
  const alleys = buildRoadSurface(tiles, gridWidth, gridHeight, heightMap, true)
  if (alleys) group.add(alleys)

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
      // Per-tile color noise so the ground doesn't read as a checkerboard
      // of uniform squares. Deterministic from tile coordinate.
      const tileNoise = ((((tx * 73856093) ^ (ty * 19349663)) >>> 0) / 0xffffffff - 0.5)
      const isRoad = tileId === 8 || tileId === 9
      const noiseAmt = isNatural ? 0.12 : isRoad ? 0.16 : 0.04
      const jitter = tileNoise * noiseAmt
      r = Math.max(0, Math.min(1, r * (1 + jitter)))
      g = Math.max(0, Math.min(1, g * (1 + jitter)))
      b = Math.max(0, Math.min(1, b * (1 + jitter)))

      const x0 = tx, x1 = tx + 1, z0 = ty, z1 = ty + 1
      // Corner-shared heights: each vertex uses the heightmap value AT the
      // corner cell, not the tile-center's height. Because adjacent tiles
      // now share the same Y at shared corners, slopes flow continuously
      // across tile boundaries instead of stair-stepping. Out-of-bounds
      // falls back to the current tile's height for graceful edges.
      const cornerH = (cx: number, cz: number): number => {
        const ix = Math.max(0, Math.min(gridWidth - 1, cx))
        const iz = Math.max(0, Math.min(gridHeight - 1, cz))
        return (heightMap[iz]?.[ix] ?? 0) * TERRAIN_WORLD_SCALE
      }
      const y00 = cornerH(x0, z0) + cornerHeightNoise(x0, z0)
      const y10 = cornerH(x1, z0) + cornerHeightNoise(x1, z0)
      const y01 = cornerH(x0, z1) + cornerHeightNoise(x0, z1)
      const y11 = cornerH(x1, z1) + cornerHeightNoise(x1, z1)

      // Per-corner COLOR jitter for road tiles — breaks the flat-tile
      // checkerboard by giving each corner its own tint. Shared across
      // adjacent tiles via the hashed corner coord so seams are clean.
      const cornerColor = (cx: number, cz: number): [number, number, number] => {
        if (!isRoad) return [r, g, b]
        const cn = ((cx * 374761393 + cz * 668265263) ^ 0x9e3779b1) >>> 0
        const k = 1 + ((cn / 0xffffffff) - 0.5) * 0.22
        return [Math.max(0, Math.min(1, r * k)),
                Math.max(0, Math.min(1, g * k)),
                Math.max(0, Math.min(1, b * k))]
      }
      const c00 = cornerColor(x0, z0)
      const c10 = cornerColor(x1, z0)
      const c01 = cornerColor(x0, z1)
      const c11 = cornerColor(x1, z1)

      // Triangle 1: CCW winding when viewed from above → normal points UP (+Y)
      positions[vi] = x0; positions[vi+1] = y00; positions[vi+2] = z0
      colors[vi] = c00[0]; colors[vi+1] = c00[1]; colors[vi+2] = c00[2]; vi += 3
      positions[vi] = x1; positions[vi+1] = y11; positions[vi+2] = z1
      colors[vi] = c11[0]; colors[vi+1] = c11[1]; colors[vi+2] = c11[2]; vi += 3
      positions[vi] = x1; positions[vi+1] = y10; positions[vi+2] = z0
      colors[vi] = c10[0]; colors[vi+1] = c10[1]; colors[vi+2] = c10[2]; vi += 3

      // Triangle 2
      positions[vi] = x0; positions[vi+1] = y00; positions[vi+2] = z0
      colors[vi] = c00[0]; colors[vi+1] = c00[1]; colors[vi+2] = c00[2]; vi += 3
      positions[vi] = x0; positions[vi+1] = y01; positions[vi+2] = z1
      colors[vi] = c01[0]; colors[vi+1] = c01[1]; colors[vi+2] = c01[2]; vi += 3
      positions[vi] = x1; positions[vi+1] = y11; positions[vi+2] = z1
      colors[vi] = c11[0]; colors[vi+1] = c11[1]; colors[vi+2] = c11[2]; vi += 3
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
        if (nh >= h) continue
        // Only emit a retaining wall for a significant drop (≥ 0.6 world
        // units). Below that we accept the slope as a gentle grade —
        // Traverse Town / Kyoto / Paris streets flow between buildings
        // without a small retaining wall under every tile-to-tile step.
        if (h - nh < 0.6) continue

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

/** Shared water material — module singleton so ThreeRenderer can tick
 *  its color over time for the shimmer effect without having to find
 *  the water mesh each frame. */
const _waterMat = new THREE.MeshLambertMaterial({
  color: 0x3070a0, transparent: true, opacity: 0.75, flatShading: true,
})
const _waterBaseColor = new THREE.Color(0x3070a0)
const _waterTint = new THREE.Color(0x50a0c0)

/** Called every frame from ThreeRenderer — nudges the water color with
 *  a low-frequency sine wobble so the surface appears to shimmer. Also
 *  varies opacity slightly for the sparkle feel. */
export function tickWater(time: number): void {
  const wobble = Math.sin(time * 0.9) * 0.5 + 0.5
  _waterMat.color.copy(_waterBaseColor).lerp(_waterTint, wobble * 0.25)
  _waterMat.opacity = 0.7 + Math.sin(time * 1.3) * 0.06
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

  return new THREE.Mesh(geo, _waterMat)
}

/**
 * Road surface mesh: a horizontal plane hugging each road/alley tile,
 * textured with the procedural cobble pattern from CobbleTexture. Sits
 * just above the ground mesh (+0.01) to avoid z-fighting. One mesh per
 * road-type (road=8, alley=9) — two draw calls total for the entire road
 * network, regardless of map size. UVs are laid out so the cobble pattern
 * is continuous across adjacent tiles — no tile-grid seam visible.
 */
function buildRoadSurface(
  tiles: number[][], gridWidth: number, gridHeight: number,
  heightMap: number[][], alley: boolean,
): THREE.Mesh | null {
  const targetId = alley ? 9 : 8
  const positions: number[] = []
  const uvs: number[] = []
  let anyFound = false

  // Each tile contributes two triangles. UVs use the world (tx, ty)
  // coordinates so cobbles are continuous: adjacent road tiles see
  // adjacent UVs, pattern flows through.
  const UV_SCALE = 0.35 // how many texture repeats per world unit; tweak for stone size
  for (let ty = 0; ty < gridHeight; ty++) {
    for (let tx = 0; tx < gridWidth; tx++) {
      if (tiles[ty]?.[tx] !== targetId) continue
      anyFound = true
      const x0 = tx, x1 = tx + 1, z0 = ty, z1 = ty + 1
      const tileH = getTerrainHeight(heightMap, tx, ty) + 0.01
      const u0 = tx * UV_SCALE, u1 = (tx + 1) * UV_SCALE
      const v0 = ty * UV_SCALE, v1 = (ty + 1) * UV_SCALE
      // Triangle 1 (CCW from above → normal +Y)
      positions.push(x0, tileH, z0, x1, tileH, z1, x1, tileH, z0)
      uvs.push(u0, v0, u1, v1, u1, v0)
      // Triangle 2
      positions.push(x0, tileH, z0, x0, tileH, z1, x1, tileH, z1)
      uvs.push(u0, v0, u0, v1, u1, v1)
    }
  }
  if (!anyFound) return null

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2))
  geo.computeVertexNormals()

  const baseColor = TERRAIN_COLORS[targetId]
  const tex = createCobbleTexture(baseColor, alley ? 0.18 : 0.0)
  const mat = new THREE.MeshLambertMaterial({ map: tex, flatShading: true })
  return new THREE.Mesh(geo, mat)
}

/**
 * Cobblestone accent pucks — now just 1 raised stone per ~3 road tiles
 * (not every tile) to add occasional underfoot relief above the textured
 * road surface. The main cobble read is now the CobbleTexture applied in
 * buildRoadSurface; pucks are supplementary.
 */
function buildCobblestones(
  tiles: number[][], gridWidth: number, gridHeight: number,
  heightMap: number[][],
): THREE.Mesh | null {
  const puckBig = new THREE.CylinderGeometry(0.2, 0.2, 0.06, 7)
  const batch = new BatchedMeshBuilder()

  for (let ty = 0; ty < gridHeight; ty++) {
    for (let tx = 0; tx < gridWidth; tx++) {
      const tileId = tiles[ty]?.[tx] ?? 0
      if (tileId !== 8 && tileId !== 9) continue
      const h1 = (((tx * 73856093) ^ (ty * 19349663)) >>> 0) / 0xffffffff
      const h2 = (((tx * 9754321) ^ (ty * 6563423)) >>> 0) / 0xffffffff
      const h3 = (((tx * 1234567) ^ (ty * 7654321)) >>> 0) / 0xffffffff
      // Only ~1 in 3 tiles gets an accent stone. The main cobble read
      // comes from the CobbleTexture on buildRoadSurface; these are
      // supplementary raised-stone detail.
      if (h3 > 0.35) continue
      const baseColor = new THREE.Color(TERRAIN_COLORS[tileId])
      const groundY = getTerrainHeight(heightMap, tx, ty)
      const darken = tileId === 9 ? 0.82 : 0.95
      const jitter = (h3 - 0.25) * 0.35
      const r = Math.max(0, Math.min(1, baseColor.r * (1 + jitter) * darken))
      const g = Math.max(0, Math.min(1, baseColor.g * (1 + jitter) * darken))
      const b = Math.max(0, Math.min(1, baseColor.b * (1 + jitter) * darken))
      const colorHex = (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255)
      batch.add(puckBig, colorHex, tx + 0.25 + h1 * 0.5, groundY + 0.03, ty + 0.25 + h2 * 0.5)
    }
  }

  const mesh = batch.build()
  if (mesh) mesh.receiveShadow = true
  return mesh
}
