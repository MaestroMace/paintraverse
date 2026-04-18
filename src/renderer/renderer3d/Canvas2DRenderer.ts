/**
 * Canvas2D Software Renderer — replaces Three.js WebGL to avoid SwiftShader crashes.
 * Renders the 3D scene using perspective projection and Canvas2D drawing primitives.
 * Output feeds into the existing post-processing pipeline (color grading, bloom, quantization).
 */

import type { MapDocument, ObjectDefinition, PlacedObject, RenderCamera, EnvironmentState } from '../core/types'
import type { BuildingPalette } from '../inspiration/StyleMapper'
import { SpatialGrid } from './SpatialGrid'

// ── Spatial grids for fast object culling (built once per map, reused across frames) ──
let _structureGrid: SpatialGrid | null = null
let _propGrid: SpatialGrid | null = null
let _gridMapVersion = -1

// ── Color constants ──

const TERRAIN_COLORS: Record<number, number> = {
  0: 0x2d5a27, 1: 0x8b7355, 2: 0x708090, 3: 0x4682b4,
  4: 0xf4e9c8, 5: 0x556b2f, 6: 0x3a6a30, 7: 0x8a8a7a,
  8: 0x6a6a68, 9: 0x4a4a48,
  10: 0x6a7a5a, // mossy stone (old courtyards)
  11: 0x6a5a45, // mud (near ponds)
  12: 0x2a5522, // wildflower meadow base (painted over with dots)
  13: 0x9a8a6a, // gravel path
}

const DEFAULT_BUILDING_PALETTES = [
  // Timber-framed (warm)
  { wall: 0xd8c8a8, roof: 0x8b4513, door: 0x4a3520 },
  { wall: 0xc8b898, roof: 0x6b3a2a, door: 0x3a2a1a },
  // Stone (cool grey)
  { wall: 0x9a9a9a, roof: 0x5a5a6a, door: 0x4a4a50 },
  { wall: 0x8a8a8a, roof: 0x484858, door: 0x3a3a42 },
  // Plaster (white/cream)
  { wall: 0xe8e0d0, roof: 0x8a5a40, door: 0x5a4030 },
  { wall: 0xf0e8d8, roof: 0x7a4a3a, door: 0x6a4a30 },
  // Red brick
  { wall: 0xb06040, roof: 0x5a3020, door: 0x4a3020 },
  { wall: 0xa05838, roof: 0x6a3828, door: 0x3a2218 },
  // Dark timber (poor quarter)
  { wall: 0x6a5a48, roof: 0x4a3a28, door: 0x3a2a1a },
  { wall: 0x5a4a38, roof: 0x3a2a20, door: 0x2a1a10 },
  // Noble (light stone, copper roof)
  { wall: 0xc8c0b0, roof: 0x5a8a6a, door: 0x4a6a5a },
  { wall: 0xd0c8b8, roof: 0x4a7a5a, door: 0x3a5a4a },
]

const PROP_COLORS: Record<string, { body: number; accent?: number }> = {
  tree: { body: 0x5a3a1a, accent: 0x2d5a27 },
  bush: { body: 0x3a7a33 },
  lamppost: { body: 0x2a2a2a, accent: 0xffdd44 },
  bench: { body: 0x6b4a28 },
  fountain: { body: 0x708090, accent: 0x4682b4 },
  fence: { body: 0x6b4a28 },
  well: { body: 0x708090 },
  barrel: { body: 0x6b4a28 },
  crate: { body: 0x8b7355 },
  sign_post: { body: 0x6b4a28 },
  market_stall: { body: 0x8b7355, accent: 0xc8b8a0 },
  wall_lantern: { body: 0x2a2a2a, accent: 0xffdd44 },
  hedge: { body: 0x2e6a28 },
  flower_bed: { body: 0x556b2f, accent: 0xff6688 },
  wagon: { body: 0x6b4a28, accent: 0x8a7a5a },
  well_grand: { body: 0x708090, accent: 0x4682b4 },
  fountain_grand: { body: 0x708090, accent: 0x4682b4 },
  double_lamp: { body: 0x2a2a2a, accent: 0xffdd44 },
  statue: { body: 0x8a8a88, accent: 0x6a6a68 },
  potted_plant: { body: 0x6a4a2a, accent: 0x3a8a3a },
  planter_box: { body: 0x6a4a2a, accent: 0x4a8a3a },
  hanging_sign: { body: 0x6a4a28, accent: 0xb89050 },
  cafe_table: { body: 0x8a7a60, accent: 0xc0b090 },
  sign: { body: 0x6a4a28, accent: 0xc8a060 },
  barrel_stack: { body: 0x5a3a1a, accent: 0x3a2a10 },
  crate_stack: { body: 0x7a6a50, accent: 0x5a4a30 },
  horse_post: { body: 0x5a4a30, accent: 0x3a3a3a },
  flower_box: { body: 0x7a5a3a, accent: 0xff6688 },
  rain_barrel: { body: 0x4a3a28, accent: 0x4682b4 },
  woodpile: { body: 0x7a5a30, accent: 0x5a4020 },
  cart: { body: 0x6a5030, accent: 0x8a7a5a },
  column: { body: 0xa0a098, accent: 0x8a8a80 },
  monument: { body: 0x8a8a80, accent: 0x708090 },
  garden_arch: { body: 0x5a4a30, accent: 0x3a7a2a },
  cloth_line: { body: 0x8a7a60, accent: 0xd0c8b0 },
  hay_bale: { body: 0xc8a850, accent: 0xa88830 },
  dock: { body: 0x6a5030, accent: 0x5a4020 },
  crane: { body: 0x4a4a4a, accent: 0x8a7a5a },
  pier: { body: 0x5a4a30, accent: 0x4a3a20 },
  fishing_boat: { body: 0x6a5030, accent: 0xc8b898 },
  gravestone: { body: 0x8a8a80, accent: 0x6a6a60 },
  iron_fence: { body: 0x3a3a3a, accent: 0x2a2a2a },
  windmill: { body: 0xc8b898, accent: 0x6a5a40 },
  farm_field: { body: 0x8a7a40, accent: 0x4a7a2a },
  orchard_tree: { body: 0x5a3a1a, accent: 0x2d7a27 },
  road_marker: { body: 0x8a8a80 },
}

// ── Types ──

interface Vec3 { x: number; y: number; z: number }
interface Projected { sx: number; sy: number; depth: number }
interface Lighting {
  ambientR: number; ambientG: number; ambientB: number
  sunDirX: number; sunDirY: number; sunDirZ: number
  sunR: number; sunG: number; sunB: number
  skyColor: number
  fogDensity: number
  isNight: boolean
  isDusk: boolean
}

// Building heights by definition ID (in tile units)
const BUILDING_HEIGHTS: Record<string, number> = {
  building_small: 2.2, building_medium: 3.0, building_large: 3.8,
  tavern: 2.8, shop: 2.5, tower: 5.0, clock_tower: 6.5,
  balcony_house: 3.2, row_house: 2.8, corner_building: 3.0,
  archway: 3.2, staircase: 1.2, town_gate: 4.5,
  chapel: 4.5, guild_hall: 4.0, warehouse: 3.0,
  watchtower: 5.5, mansion: 3.5, bakery: 2.5,
  apothecary: 3.5, inn: 3.2, temple: 5.0,
  covered_market: 2.8, bell_tower: 7.0, half_timber: 3.0,
  narrow_house: 3.8, windmill: 3.5,
}

// Windmill gets a special roof style


// Per-type roof style: how buildings get their silhouette
type RoofStyle = 'flat' | 'gabled' | 'hipped' | 'pointed' | 'steep' | 'dome' | 'none'
const BUILDING_ROOF_STYLE: Record<string, RoofStyle> = {
  building_small: 'gabled', building_medium: 'gabled', building_large: 'hipped',
  tavern: 'gabled', shop: 'steep', tower: 'pointed', clock_tower: 'pointed',
  balcony_house: 'gabled', row_house: 'steep', corner_building: 'hipped',
  archway: 'none', staircase: 'none', town_gate: 'flat',
  chapel: 'steep', guild_hall: 'hipped', warehouse: 'gabled',
  watchtower: 'pointed', mansion: 'hipped', bakery: 'gabled',
  apothecary: 'steep', inn: 'gabled', temple: 'dome',
  covered_market: 'gabled', bell_tower: 'pointed', half_timber: 'gabled',
  narrow_house: 'steep',
  windmill: 'pointed',
}

// Which buildings have timber framing on walls
const HAS_TIMBER_FRAME: Set<string> = new Set([
  'building_small', 'building_medium', 'tavern', 'balcony_house',
  'row_house', 'half_timber', 'inn', 'bakery',
])

// Which buildings have awnings on the ground floor
const HAS_AWNING: Set<string> = new Set([
  'shop', 'bakery', 'corner_building', 'apothecary', 'covered_market',
])

// Which buildings have a chimney
const HAS_CHIMNEY: Set<string> = new Set([
  'building_small', 'building_medium', 'building_large', 'tavern',
  'bakery', 'inn', 'half_timber', 'mansion',
])

// Buildings with jettied (overhanging) upper floors — classic medieval
const HAS_JETTY = new Set([
  'row_house', 'narrow_house', 'balcony_house', 'tavern', 'inn', 'building_medium',
])

// Buildings that get dormers on their roof
const HAS_DORMER = new Set([
  'mansion', 'guild_hall', 'building_large', 'inn', 'row_house', 'balcony_house',
])

// Buildings with stepped gables (Dutch/Flemish style)
const HAS_STEPPED_GABLE = new Set([
  'guild_hall', 'warehouse', 'corner_building',
])

// Buildings with turret/round corner tower
const HAS_TURRET = new Set([
  'mansion', 'town_gate', 'watchtower',
])

interface Drawable {
  depth: number
  draw: (ctx: CanvasRenderingContext2D) => void
}

// ── Light source tracking for light map ──

export interface LightSource {
  sx: number; sy: number   // screen position
  radius: number           // influence radius in pixels
  color: number            // warm color (hex)
  intensity: number        // 0-1
}

export interface SceneResult {
  imageData: ImageData
  lights: LightSource[]
  waterMask: Uint8Array    // 1 = water pixel, 0 = not
}

// ── Weather particle system (persistent across frames) ──

interface WeatherParticle {
  x: number; y: number
  vx: number; vy: number
  life: number
  size: number
}

const MAX_PARTICLES = 400
let weatherParticles: WeatherParticle[] = []
let lastWeather = ''
let lastTime = 0
// Pre-allocated bucket arrays for batched particle drawing (avoid per-frame allocation)
const _snowBuckets: WeatherParticle[][] = Array.from({ length: 7 }, () => [])
const _fogBuckets: WeatherParticle[][] = Array.from({ length: 4 }, () => [])

// Cached render canvas to avoid allocating new one every frame
let _renderCanvas: HTMLCanvasElement | null = null
let _renderCtx: CanvasRenderingContext2D | null = null
// Empty water mask for preview mode (avoids allocation)
const _emptyWaterMask = new Uint8Array(0)
// Scene cache: use a separate canvas (GPU→GPU copy via drawImage is ~0.1ms
// vs putImageData's ~5-10ms CPU→GPU copy of 1.2MB)
let _sceneCache: HTMLCanvasElement | null = null
let _sceneCacheCtx: CanvasRenderingContext2D | null = null
let _sceneCacheKey = ''
let _sceneCacheLights: LightSource[] = []
let _sceneCacheWaterMask: Uint8Array = _emptyWaterMask
let _sceneCacheLighting: Lighting | null = null

// ── Fast preview: returns canvas directly, ZERO ImageData extraction ──
// This is the hot path for animation playback. It never calls getImageData
// (which forces a GPU→CPU readback costing ~10ms). Instead it keeps
// everything on the GPU side: canvas → drawImage → screen.

export function renderPreviewToCanvas(
  map: MapDocument,
  camera: RenderCamera,
  objectDefs: ObjectDefinition[],
  buildingPalettes?: BuildingPalette[] | null,
  time: number = 0
): HTMLCanvasElement {
  const { outputWidth: W, outputHeight: H } = camera

  if (!_renderCanvas || _renderCanvas.width !== W || _renderCanvas.height !== H) {
    _renderCanvas = document.createElement('canvas')
    _renderCanvas.width = W
    _renderCanvas.height = H
    _renderCtx = _renderCanvas.getContext('2d')!
    _sceneCache = null
  }
  const ctx = _renderCtx!

  const cacheKey = `${camera.worldX},${camera.worldY},${camera.lookAtX},${camera.lookAtY},${camera.elevation},${camera.fov},${W},${H},${map.version},${map.environment.timeOfDay}`

  if (_sceneCache && _sceneCacheKey === cacheKey) {
    // Cache HIT: restore from canvas cache with drawImage (GPU→GPU, ~0.1ms)
    // This is 50-100x faster than putImageData which does CPU→GPU copy
    ctx.drawImage(_sceneCache, 0, 0)
  } else {
    // Cache MISS: full render (skip weather — we draw it separately below)
    renderCanvas2D(map, camera, objectDefs, buildingPalettes, time, true, true)
    // Cache the clean scene (no weather) to a separate canvas
    if (!_sceneCache || _sceneCache.width !== W || _sceneCache.height !== H) {
      _sceneCache = document.createElement('canvas')
      _sceneCache.width = W
      _sceneCache.height = H
      _sceneCacheCtx = _sceneCache.getContext('2d')!
    }
    _sceneCacheCtx!.drawImage(_renderCanvas, 0, 0) // GPU→GPU copy to cache
    _sceneCacheKey = cacheKey
    _sceneCacheLighting = computeLighting(map.environment)
  }

  // Weather particles drawn ONCE per frame on top of cached/rendered scene
  const dt = time > lastTime ? time - lastTime : 0.016
  lastTime = time
  const lighting = _sceneCacheLighting ?? computeLighting(map.environment)
  updateWeatherParticles(map.environment.weather, map.environment.weatherIntensity, W, H, dt, time)
  drawWeatherParticles(ctx, map.environment.weather, lighting)

  return _renderCanvas
}

// ── Main render function (final quality — returns ImageData for post-processing) ──

export function renderCanvas2D(
  map: MapDocument,
  camera: RenderCamera,
  objectDefs: ObjectDefinition[],
  buildingPalettes?: BuildingPalette[] | null,
  time: number = 0,
  isPreview: boolean = false,
  skipWeather: boolean = false
): SceneResult {
  const { outputWidth: W, outputHeight: H } = camera
  const ts = map.tileSize

  if (!_renderCanvas || _renderCanvas.width !== W || _renderCanvas.height !== H) {
    _renderCanvas = document.createElement('canvas')
    _renderCanvas.width = W
    _renderCanvas.height = H
    _renderCtx = _renderCanvas.getContext('2d')!
    _sceneCache = null
  }
  const canvas = _renderCanvas
  const ctx = _renderCtx!

  const lights: LightSource[] = []
  const waterMask = isPreview ? _emptyWaterMask : new Uint8Array(W * H)
  ctx.clearRect(0, 0, W, H)

  // Build view matrix
  const camPos: Vec3 = {
    x: camera.worldX * ts,
    y: camera.elevation * ts,
    z: camera.worldY * ts
  }
  const lookAt: Vec3 = { x: camera.lookAtX * ts, y: 0, z: camera.lookAtY * ts }
  const viewMatrix = buildViewMatrix(camPos, lookAt)
  const focalLength = (W / 2) / Math.tan((camera.fov * Math.PI / 180) / 2)

  // Compute lighting
  const lighting = computeLighting(map.environment)

  // Fill sky background with gradient
  const horizonY = Math.floor(H * 0.75)
  const zenithCSS = hexToCSS(darken(lighting.skyColor, 0.25))
  const skyCSS = hexToCSS(lighting.skyColor)
  const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY)
  skyGrad.addColorStop(0, zenithCSS)
  skyGrad.addColorStop(0.7, skyCSS)
  if (lighting.isDusk) {
    skyGrad.addColorStop(0.92, skyCSS)
    skyGrad.addColorStop(1.0, hexToCSS(lerpColor(lighting.skyColor, 0xff8844, 0.4)))
  } else if (!lighting.isNight) {
    skyGrad.addColorStop(0.95, skyCSS)
    skyGrad.addColorStop(1.0, hexToCSS(lerpColor(lighting.skyColor, 0xffeedd, 0.15)))
  } else {
    skyGrad.addColorStop(1.0, skyCSS)
  }
  ctx.fillStyle = skyGrad
  ctx.fillRect(0, 0, W, horizonY)
  // Below horizon: slightly darker blend
  ctx.fillStyle = hexToCSS(darken(lighting.skyColor, 0.1))
  ctx.fillRect(0, horizonY, W, H - horizonY)

  // Collect all drawables
  const drawables: Drawable[] = []

  // Project helper — clamps near plane instead of returning null
  // so objects partially behind camera get clipped rather than vanishing
  const NEAR_CLIP = 1.0
  const project = (wx: number, wy: number, wz: number): Projected | null => {
    const dx = wx - camPos.x, dy = wy - camPos.y, dz = wz - camPos.z
    const rx = viewMatrix[0] * dx + viewMatrix[1] * dy + viewMatrix[2] * dz
    const ry = viewMatrix[3] * dx + viewMatrix[4] * dy + viewMatrix[5] * dz
    let rz = viewMatrix[6] * dx + viewMatrix[7] * dy + viewMatrix[8] * dz
    if (rz <= 0) return null // truly behind camera
    if (rz < NEAR_CLIP) rz = NEAR_CLIP // clamp to near plane
    const scale = focalLength / rz
    return { sx: W / 2 + rx * scale, sy: H / 2 - ry * scale, depth: rz }
  }

  // Helper: draw filled polygon from projected points
  const drawPoly = (ctx: CanvasRenderingContext2D, points: Projected[], color: string) => {
    if (points.length < 3) return
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(points[0].sx, points[0].sy)
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].sx, points[i].sy)
    ctx.closePath()
    ctx.fill()
  }

  const palettes = buildingPalettes || DEFAULT_BUILDING_PALETTES
  const defMap = new Map(objectDefs.map(d => [d.id, d]))

  // ── Frustum cull helper ──
  const margin = 30 // pixel margin beyond screen edge
  const inScreen = (p: Projected): boolean =>
    p.sx >= -margin && p.sx <= W + margin && p.sy >= -margin && p.sy <= H + margin

  // ── Compute visible tile range (shared by terrain + figures) ──
  const terrainLayer = map.layers.find(l => l.type === 'terrain')
  const camTileX = camPos.x / ts, camTileZ = camPos.z / ts
  const viewDist = camera.elevation * 2.5 + 15
  const lookDirX = (camera.lookAtX - camera.worldX) || 0.01
  const lookDirZ = (camera.lookAtY - camera.worldY) || 0.01
  const lookLen = Math.sqrt(lookDirX * lookDirX + lookDirZ * lookDirZ) || 1
  const ldx = lookDirX / lookLen, ldz = lookDirZ / lookLen
  const rangeCenterX = camTileX + ldx * viewDist * 0.3
  const rangeCenterZ = camTileZ + ldz * viewDist * 0.3
  const halfRange = viewDist * 0.8
  const gridH = terrainLayer?.terrainTiles?.length ?? map.gridHeight
  const gridW = terrainLayer?.terrainTiles?.[0]?.length ?? map.gridWidth
  const tyMin = Math.max(0, Math.floor(rangeCenterZ - halfRange))
  const tyMax = Math.min(gridH - 1, Math.ceil(rangeCenterZ + halfRange))
  const txMin = Math.max(0, Math.floor(rangeCenterX - halfRange))
  const txMax = Math.min(gridW - 1, Math.ceil(rangeCenterX + halfRange))

  // ── Terrain tiles — projection grid + batched drawing ──
  if (terrainLayer?.terrainTiles) {
    const tiles = terrainLayer.terrainTiles

    // Pre-compute projection grid: shared corners between adjacent tiles
    // 20×20 tile range = 21×21 corner grid = 441 projections (was 1600)
    const pgW = txMax - txMin + 2 // +2 because corners = tiles + 1
    const pgH = tyMax - tyMin + 2
    const projGrid: (Projected | null)[] = new Array(pgW * pgH)
    for (let gy = 0; gy < pgH; gy++) {
      for (let gx = 0; gx < pgW; gx++) {
        projGrid[gy * pgW + gx] = project((txMin + gx) * ts, 0, (tyMin + gy) * ts)
      }
    }

    // Batch tiles by type for fewer fill() calls
    // Instead of one drawable per tile (400 closures + 400 fill calls),
    // group tiles by tileId and draw all tiles of same type in one path
    interface TileBatch {
      tileId: number
      color: string
      tiles: { c0: Projected; c1: Projected; c2: Projected; c3: Projected; depth: number; tx: number; ty: number }[]
    }
    const batches = new Map<number, TileBatch>()

    for (let ty = tyMin; ty <= tyMax; ty++) {
      for (let tx = txMin; tx <= txMax; tx++) {
        const tileId = tiles[ty][tx]
        const gx = tx - txMin, gy = ty - tyMin
        const c0 = projGrid[gy * pgW + gx]
        const c1 = projGrid[gy * pgW + gx + 1]
        const c2 = projGrid[(gy + 1) * pgW + gx + 1]
        const c3 = projGrid[(gy + 1) * pgW + gx]
        if (!c0 || !c1 || !c2 || !c3) continue
        if (!inScreen(c0) && !inScreen(c1) && !inScreen(c2) && !inScreen(c3)) continue

        const avgDepth = (c0.depth + c1.depth + c2.depth + c3.depth) * 0.25
        const litColor = shadeFace(TERRAIN_COLORS[tileId] ?? 0x808080, 0, 1, 0, lighting)
        const foggedColor = applyFog(litColor, avgDepth, lighting)
        const colorCSS = hexToCSS(foggedColor)

        let batch = batches.get(tileId)
        if (!batch) {
          batch = { tileId, color: colorCSS, tiles: [] }
          batches.set(tileId, batch)
        }
        batch.tiles.push({ c0, c1, c2, c3, depth: avgDepth, tx, ty })
      }
    }

    // Draw each batch as a single drawable (one per tile type)
    for (const [tileId, batch] of batches) {
      // Use median depth for draw ordering
      const medianDepth = batch.tiles.length > 0
        ? batch.tiles[Math.floor(batch.tiles.length / 2)].depth
        : 0

      drawables.push({
        depth: medianDepth,
        draw: (ctx) => {
          // Base fill: batch all polygons of same type into one path
          ctx.fillStyle = batch.color
          ctx.beginPath()
          for (const t of batch.tiles) {
            ctx.moveTo(t.c0.sx, t.c0.sy)
            ctx.lineTo(t.c1.sx, t.c1.sy)
            ctx.lineTo(t.c2.sx, t.c2.sy)
            ctx.lineTo(t.c3.sx, t.c3.sy)
            ctx.closePath()
          }
          ctx.fill()

          // Texture details (per-tile, only for close tiles)
          for (const t of batch.tiles) {
            const tileScreenW = Math.abs(t.c1.sx - t.c0.sx)
            if (tileScreenW < 4) continue

            if (tileId === 8 || tileId === 9) {
              ctx.strokeStyle = 'rgba(0,0,0,0.06)'
              ctx.lineWidth = 0.3
              const tileW = tileScreenW
              const tileH2 = Math.abs(t.c0.sy - t.c3.sy)
              if (tileW > 3 && tileH2 > 2) {
                const cx2 = (t.c0.sx + t.c2.sx) * 0.5
                const cy2 = (t.c0.sy + t.c2.sy) * 0.5
                ctx.beginPath()
                ctx.moveTo(cx2, t.c0.sy); ctx.lineTo(cx2, t.c3.sy); ctx.stroke()
                ctx.beginPath()
                ctx.moveTo(t.c0.sx, cy2); ctx.lineTo(t.c1.sx, cy2); ctx.stroke()
              }
            }

            if ((tileId === 8 || tileId === 9) && ((t.tx * 7 + t.ty * 13) % 5 === 0)) {
              ctx.fillStyle = 'rgba(45,90,39,0.12)'
              const mx = (t.c0.sx + t.c2.sx) * 0.5
              const my = (t.c0.sy + t.c2.sy) * 0.5
              ctx.beginPath(); ctx.arc(mx, my, 2, 0, Math.PI * 2); ctx.fill()
              ctx.fillStyle = batch.color // restore
            }

            if (tileId === 12 && tileScreenW > 5) {
              const flowerColors = ['rgba(220,80,100,0.5)', 'rgba(240,200,60,0.45)', 'rgba(180,120,220,0.4)', 'rgba(255,160,80,0.4)', 'rgba(255,255,180,0.35)']
              const fHash = t.tx * 31 + t.ty * 17
              for (let fi = 0; fi < 4; fi++) {
                const fx = t.c0.sx + ((fHash + fi * 37) % 7) / 7 * tileScreenW
                const fy = t.c3.sy + ((fHash + fi * 23) % 5) / 5 * Math.abs(t.c0.sy - t.c3.sy)
                ctx.fillStyle = flowerColors[(fHash + fi) % flowerColors.length]
                ctx.beginPath(); ctx.arc(fx, fy, 0.6 + (fi % 2) * 0.3, 0, Math.PI * 2); ctx.fill()
              }
            }

            if (tileId === 7 && tileScreenW > 4) {
              ctx.fillStyle = 'rgba(100,100,90,0.15)'
              const rHash = t.tx * 41 + t.ty * 29
              for (let ri = 0; ri < 3; ri++) {
                const rx = t.c0.sx + ((rHash + ri * 19) % 9) / 9 * tileScreenW
                const ry = t.c3.sy + ((rHash + ri * 13) % 7) / 7 * Math.abs(t.c0.sy - t.c3.sy)
                ctx.beginPath(); ctx.ellipse(rx, ry, 1.2, 0.7, (rHash + ri) * 0.5, 0, Math.PI * 2); ctx.fill()
              }
            }

            if (tileId === 10) {
              ctx.fillStyle = 'rgba(60,100,40,0.18)'
              const mx = (t.c0.sx + t.c2.sx) * 0.5
              const my = (t.c0.sy + t.c2.sy) * 0.5
              ctx.beginPath(); ctx.arc(mx, my, 2.5, 0, Math.PI * 2); ctx.fill()
            }

            if (tileId === 13 && tileScreenW > 3) {
              ctx.fillStyle = 'rgba(80,70,55,0.1)'
              const gHash = t.tx * 47 + t.ty * 31
              for (let gi = 0; gi < 5; gi++) {
                const gx = t.c0.sx + ((gHash + gi * 11) % 11) / 11 * tileScreenW
                const gy = t.c3.sy + ((gHash + gi * 7) % 9) / 9 * Math.abs(t.c0.sy - t.c3.sy)
                ctx.fillRect(gx, gy, 0.5, 0.5)
              }
            }

            // Water shimmer
            if (tileId === 3) {
              const shimX = t.c0.sx + ((time * 5 + t.tx * 3) % 8)
              const shimY = (t.c0.sy + t.c2.sy) * 0.5
              ctx.fillStyle = 'rgba(255,255,255,0.06)'
              ctx.fillRect(shimX, shimY, 3, 0.5)
              if (waterMask.length > 0) {
                const minX2 = Math.max(0, Math.floor(Math.min(t.c0.sx, t.c3.sx)))
                const maxX2 = Math.min(W - 1, Math.ceil(Math.max(t.c1.sx, t.c2.sx)))
                const minY2 = Math.max(0, Math.floor(Math.min(t.c2.sy, t.c3.sy)))
                const maxY2 = Math.min(H - 1, Math.ceil(Math.max(t.c0.sy, t.c1.sy)))
                for (let py = minY2; py <= maxY2; py++) {
                  for (let px = minX2; px <= maxX2; px++) {
                    waterMask[py * W + px] = 1
                  }
                }
              }
            }
          }
        }
      })
    }
  }

  // ── Build spatial grids once per map version (reuse across frames) ──
  const structureLayer = map.layers.find(l => l.type === 'structure')
  const propLayer = map.layers.find(l => l.type === 'prop')
  if (map.version !== _gridMapVersion) {
    _structureGrid = new SpatialGrid(map.gridWidth, map.gridHeight)
    _propGrid = new SpatialGrid(map.gridWidth, map.gridHeight)
    if (structureLayer) _structureGrid.insertAll(structureLayer.objects)
    if (propLayer) _propGrid.insertAll(propLayer.objects)
    _gridMapVersion = map.version
  }

  // ── Buildings — spatial grid query + frustum cull ──
  if (_structureGrid) {
    const visibleStructures = _structureGrid.query(txMin - 5, tyMin - 5, txMax + 5, tyMax + 5)
    for (const obj of visibleStructures) {
      const def = defMap.get(obj.definitionId)
      if (!def) continue
      const bcx = (obj.x + def.footprint.w / 2) * ts
      const bcz = (obj.y + def.footprint.h / 2) * ts
      const bc = project(bcx, ts, bcz)
      if (bc && !inScreen(bc)) continue
      addBuildingDrawables(drawables, obj, def, ts, palettes, camPos, project, lighting, time, lights)
    }
  }

  // ── Props — spatial grid query + frustum cull ──
  if (_propGrid) {
    const visibleProps = _propGrid.query(txMin - 3, tyMin - 3, txMax + 3, tyMax + 3)
    for (const obj of visibleProps) {
      const def = defMap.get(obj.definitionId)
      if (!def) continue
      const pc = project((obj.x + 0.5) * ts, 0, (obj.y + 0.5) * ts)
      if (pc && !inScreen(pc)) continue
      addPropDrawables(drawables, obj, def, ts, project, lighting, time, lights)
    }
  }

  // ── Tiny figure silhouettes on streets ── (use same tile range)
  if (terrainLayer?.terrainTiles) {
    const tiles = terrainLayer.terrainTiles
    for (let ty = Math.max(2, tyMin); ty <= Math.min(tyMax, tiles.length - 3); ty += 3) {
      for (let tx = Math.max(2, txMin); tx <= Math.min(txMax, (tiles[ty]?.length ?? 0) - 3); tx += 3) {
        const tileId = tiles[ty]?.[tx]
        if (tileId !== 8 && tileId !== 9) continue // only on cobblestone/roads
        const figHash = (tx * 31 + ty * 17) & 0xffff
        if (figHash % 30 > 0) continue // ~3% chance
        const fx = (tx + 0.5) * ts, fz = (ty + 0.5) * ts
        const figBase = project(fx + Math.sin(time * 0.3 + figHash) * 2, 0, fz)
        if (!figBase) continue
        drawables.push({
          depth: figBase.depth - 0.001,
          draw: (ctx) => {
            const figType = figHash % 5
            const shade = `rgba(${40 + figHash % 30},${25 + figHash % 20},${15 + figHash % 15},0.55)`
            ctx.fillStyle = shade
            if (figType === 0) {
              // Cloaked figure (wider body)
              ctx.beginPath()
              ctx.moveTo(figBase.sx - 1.2, figBase.sy)
              ctx.lineTo(figBase.sx - 0.8, figBase.sy - 3)
              ctx.lineTo(figBase.sx + 0.8, figBase.sy - 3)
              ctx.lineTo(figBase.sx + 1.2, figBase.sy)
              ctx.closePath(); ctx.fill()
              ctx.fillRect(figBase.sx - 0.5, figBase.sy - 4, 1, 1)
            } else if (figType === 1) {
              // Figure with hat
              ctx.fillRect(figBase.sx - 0.5, figBase.sy - 3, 1, 2)
              ctx.fillRect(figBase.sx - 0.5, figBase.sy - 4, 1, 1)
              ctx.fillRect(figBase.sx - 1, figBase.sy - 4.5, 2, 0.5) // brim
            } else if (figType === 2) {
              // Figure carrying something
              ctx.fillRect(figBase.sx - 0.5, figBase.sy - 3, 1, 2)
              ctx.fillRect(figBase.sx - 0.5, figBase.sy - 4, 1, 1)
              ctx.fillRect(figBase.sx + 0.5, figBase.sy - 3, 1.5, 1) // bundle
              ctx.fillStyle = `rgba(120,90,50,0.4)`
              ctx.fillRect(figBase.sx + 0.5, figBase.sy - 3, 1.5, 1)
            } else if (figType === 3) {
              // Two figures (pair walking)
              ctx.fillRect(figBase.sx - 0.5, figBase.sy - 3, 1, 2)
              ctx.fillRect(figBase.sx - 0.5, figBase.sy - 4, 1, 1)
              ctx.fillRect(figBase.sx + 1.5, figBase.sy - 2.5, 0.8, 1.5)
              ctx.fillRect(figBase.sx + 1.5, figBase.sy - 3.3, 0.8, 0.8)
            } else {
              // Basic figure
              ctx.fillRect(figBase.sx - 0.5, figBase.sy - 3, 1, 2)
              ctx.fillRect(figBase.sx - 0.5, figBase.sy - 4, 1, 1)
            }
            // Legs (all types)
            ctx.fillRect(figBase.sx - 0.5, figBase.sy - 1, 0.4, 1)
            ctx.fillRect(figBase.sx + 0.1, figBase.sy - 1, 0.4, 1)
          }
        })
      }
    }
  }

  // Sort back-to-front (painter's algorithm)
  // Insertion sort: O(n) for nearly-sorted data (objects are added roughly in depth order)
  // V8's Array.sort uses TimSort which is also good for nearly-sorted but insertion sort
  // avoids the overhead of the comparator function call per comparison
  for (let i = 1; i < drawables.length; i++) {
    const key = drawables[i]
    const keyDepth = key.depth
    let j = i - 1
    while (j >= 0 && drawables[j].depth < keyDepth) {
      drawables[j + 1] = drawables[j]
      j--
    }
    drawables[j + 1] = key
  }

  // Draw all
  for (const d of drawables) d.draw(ctx)

  // ── Weather particles (screen-space, drawn after scene) ──
  if (!skipWeather) {
    const dt = time > lastTime ? time - lastTime : 0.016
    lastTime = time
    updateWeatherParticles(map.environment.weather, map.environment.weatherIntensity, W, H, dt, time)
    drawWeatherParticles(ctx, map.environment.weather, lighting)
  }

  return { imageData: ctx.getImageData(0, 0, W, H), lights, waterMask }
}

// ── Weather particle functions ──

function updateWeatherParticles(
  weather: string, intensity: number, W: number, H: number, dt: number, time: number
): void {
  if (weather !== lastWeather) { weatherParticles = []; lastWeather = weather }
  if (weather === 'clear') { weatherParticles = []; return }
  if (dt <= 0 || dt > 1) return // skip bad dt

  const spawnRate = weather === 'rain' ? 15 : weather === 'snow' ? 5 :
                    weather === 'storm' ? 25 : weather === 'fog' ? 1 : 0
  const toSpawn = Math.min(20, Math.floor(spawnRate * Math.max(0.3, intensity) * dt * 60))

  for (let i = 0; i < toSpawn && weatherParticles.length < MAX_PARTICLES; i++) {
    if (weather === 'rain' || weather === 'storm') {
      weatherParticles.push({
        x: Math.random() * (W + 40) - 20, y: -5,
        vx: -1.5 - Math.random() * 0.5, vy: 6 + Math.random() * 4,
        life: 1, size: 1
      })
    } else if (weather === 'snow') {
      weatherParticles.push({
        x: Math.random() * W, y: -3,
        vx: Math.sin(time + Math.random() * 6) * 0.4,
        vy: 0.4 + Math.random() * 0.6,
        life: 1, size: 0.8 + Math.random() * 0.8
      })
    }
  }

  // Update + swap-and-pop removal (O(1) per removal instead of O(n) splice)
  const lifeDrain = weather === 'snow' ? 0.2 : 0.6
  let len = weatherParticles.length
  for (let i = len - 1; i >= 0; i--) {
    const p = weatherParticles[i]
    p.x += p.vx; p.y += p.vy
    p.life -= dt * lifeDrain
    if (weather === 'snow') p.vx = Math.sin(time + i) * 0.3
    if (p.life <= 0 || p.y > H + 5 || p.x < -20 || p.x > W + 20) {
      weatherParticles[i] = weatherParticles[--len]
    }
  }
  weatherParticles.length = len
}

function drawWeatherParticles(
  ctx: CanvasRenderingContext2D, weather: string, _lighting: Lighting
): void {
  if (weatherParticles.length === 0) return

  if (weather === 'rain' || weather === 'storm') {
    // Batch all rain streaks into a single path for performance
    ctx.strokeStyle = 'rgba(180,200,230,0.35)'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    for (const p of weatherParticles) {
      ctx.moveTo(p.x, p.y)
      ctx.lineTo(p.x + p.vx * 1.5, p.y + p.vy * 1.5)
    }
    ctx.stroke()
    // Ground splash dots — batch into single path
    ctx.fillStyle = 'rgba(180,200,230,0.2)'
    ctx.beginPath()
    for (const p of weatherParticles) {
      if (p.life < 0.15) {
        ctx.moveTo(p.x + 1.2, p.y)
        ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2)
      }
    }
    ctx.fill()
    // Lightning flash for storms
    if (weather === 'storm' && Math.random() < 0.004) {
      ctx.fillStyle = 'rgba(255,255,240,0.25)'
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    }
  } else if (weather === 'snow') {
    // Quantize alpha to 7 buckets to reduce string allocations (was 1 per particle)
    for (let b = 0; b < 7; b++) _snowBuckets[b].length = 0
    for (const p of weatherParticles) {
      const ai = Math.min(6, Math.floor(Math.min(0.7, p.life) * 10))
      _snowBuckets[ai].push(p)
    }
    for (let bi = 0; bi < 7; bi++) {
      if (_snowBuckets[bi].length === 0) continue
      ctx.fillStyle = `rgba(240,240,255,${(bi * 0.1).toFixed(1)})`
      ctx.beginPath()
      for (const p of _snowBuckets[bi]) {
        ctx.moveTo(p.x + p.size * 0.6, p.y)
        ctx.arc(p.x, p.y, p.size * 0.6, 0, Math.PI * 2)
      }
      ctx.fill()
    }
  } else if (weather === 'fog') {
    // Quantize fog alpha similarly
    for (let b = 0; b < 4; b++) _fogBuckets[b].length = 0
    for (const p of weatherParticles) {
      const ai = Math.min(3, Math.floor(p.life * 4))
      _fogBuckets[ai].push(p)
    }
    for (let bi = 0; bi < 4; bi++) {
      if (_fogBuckets[bi].length === 0) continue
      ctx.fillStyle = `rgba(200,200,210,${(bi * 0.015 + 0.005).toFixed(3)})`
      for (const p of _fogBuckets[bi]) {
        ctx.beginPath()
        ctx.ellipse(p.x, p.y, 15 + p.size * 10, 4 + p.size * 3, 0, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
}

// ── Building drawing ──

function addBuildingDrawables(
  drawables: Drawable[], obj: PlacedObject, def: ObjectDefinition,
  ts: number, palettes: { wall: number; roof: number; door: number }[],
  camPos: Vec3,
  project: (x: number, y: number, z: number) => Projected | null,
  lighting: Lighting, time: number, lights: LightSource[]
) {
  const hash = simpleHash(obj.id)
  const palette = palettes[hash % palettes.length]

  // ── BLUEPRINT BUILDINGS — use 3D primitive composition ──
  if (BLUEPRINTS[def.id]) {
    const ox = obj.x * ts, oz = obj.y * ts
    renderBlueprint(drawables, BLUEPRINTS[def.id], ox, 0, oz, ts, palette, project, camPos, lighting)

    // Blueprint-specific animated details
    addBlueprintDetails(drawables, def.id, ox, oz, ts, palette, project, camPos, lighting, time, hash)

    // Shadow for blueprint buildings
    const bpH = (BLUEPRINT_HEIGHTS[def.id] ?? 3) * ts
    const fw2 = def.footprint.w * ts, fd2 = def.footprint.h * ts
    const shadowOffX = -lighting.sunDirX * bpH * 0.5
    const shadowOffZ = -lighting.sunDirZ * bpH * 0.5
    const s0 = project(ox + shadowOffX, 0, oz + shadowOffZ)
    const s1 = project(ox + fw2 + shadowOffX, 0, oz + shadowOffZ)
    const s2 = project(ox + fw2 + shadowOffX, 0, oz + fd2 + shadowOffZ)
    const s3 = project(ox + shadowOffX, 0, oz + fd2 + shadowOffZ)
    if (s0 && s1 && s2 && s3) {
      const avgD = (s0.depth + s1.depth + s2.depth + s3.depth) / 4
      drawables.push({
        depth: avgD + 0.02,
        draw: (ctx) => {
          ctx.fillStyle = `rgba(0,0,0,${lighting.isNight ? 0.15 : 0.35})`
          ctx.beginPath()
          ctx.moveTo(s0.sx, s0.sy); ctx.lineTo(s1.sx, s1.sy)
          ctx.lineTo(s2.sx, s2.sy); ctx.lineTo(s3.sx, s3.sy)
          ctx.closePath(); ctx.fill()
        }
      })
    }
    return
  }

  const fw = def.footprint.w * ts
  const fd = def.footprint.h * ts
  const baseH = BUILDING_HEIGHTS[def.id] ?? 1.8
  const height = ts * (baseH + (hash % 3) * 0.15)
  const x0 = obj.x * ts, z0 = obj.y * ts
  const roofStyle = BUILDING_ROOF_STYLE[def.id] || 'gabled'
  const roofHeight = roofStyle === 'pointed' ? height * 0.6
    : roofStyle === 'steep' ? height * 0.45
    : roofStyle === 'dome' ? height * 0.35
    : roofStyle === 'gabled' || roofStyle === 'hipped' ? height * 0.3
    : 0

  // Wall box corners
  const pp: (Projected | null)[] = [
    project(x0, 0, z0), project(x0 + fw, 0, z0),
    project(x0 + fw, 0, z0 + fd), project(x0, 0, z0 + fd),
    project(x0, height, z0), project(x0 + fw, height, z0),
    project(x0 + fw, height, z0 + fd), project(x0, height, z0 + fd),
  ]
  if (pp.some(p => p === null)) return
  const p = pp as Projected[]

  const centerX = x0 + fw / 2, centerZ = z0 + fd / 2
  const avgDepth = p.reduce((s, v) => s + v.depth, 0) / 8
  // LOD: skip fine details when building is small on screen
  const screenH = Math.abs(p[0].sy - p[4].sy)
  const isDistant = screenH < 8
  const showFront = camPos.z < centerZ
  const showRight = camPos.x > centerX
  const showLeft = camPos.x < centerX
  const showBack = camPos.z > centerZ

  // Collect building window lights for light map (night/dusk only)
  if ((lighting.isNight || lighting.isDusk) && screenH > 3) {
    // Approximate: one light per visible face, centered at window height
    const windowY = height * 0.5
    const lightR = 15 + screenH * 0.6
    const lightI = lighting.isNight ? 0.5 : 0.3
    if (showFront) {
      const fp = project(x0 + fw / 2, windowY, z0)
      if (fp) lights.push({ sx: fp.sx, sy: fp.sy, radius: lightR, color: 0xffcc66, intensity: lightI })
    }
    if (showBack) {
      const bp = project(x0 + fw / 2, windowY, z0 + fd)
      if (bp) lights.push({ sx: bp.sx, sy: bp.sy, radius: lightR, color: 0xffcc66, intensity: lightI })
    }
    if (showLeft) {
      const lp = project(x0, windowY, z0 + fd / 2)
      if (lp) lights.push({ sx: lp.sx, sy: lp.sy, radius: lightR, color: 0xffcc66, intensity: lightI })
    }
    if (showRight) {
      const rp = project(x0 + fw, windowY, z0 + fd / 2)
      if (rp) lights.push({ sx: rp.sx, sy: rp.sy, radius: lightR, color: 0xffcc66, intensity: lightI })
    }
  }

  // Roof ridge/peak points for gabled/pointed roofs
  const ridgeFront = project(x0 + fw / 2, height + roofHeight, z0)
  const ridgeBack = project(x0 + fw / 2, height + roofHeight, z0 + fd)
  const ridgeCenter = project(x0 + fw / 2, height + roofHeight, z0 + fd / 2)

  // ── ROOF ──
  const roofColor = shadeFace(palette.roof, 0, 1, 0, lighting)
  const roofFogged = applyFog(roofColor, avgDepth, lighting)
  const roofDark = hexToCSS(darken(roofFogged, 0.15))
  const roofCSS = hexToCSS(roofFogged)

  if (roofStyle === 'gabled' && ridgeFront && ridgeBack) {
    // Gabled roof: two sloped planes meeting at a ridge
    drawables.push({
      depth: avgDepth - 0.02,
      draw: (ctx) => {
        // Left slope
        if (showLeft || !showRight) {
          ctx.fillStyle = roofCSS
          ctx.beginPath()
          ctx.moveTo(p[7].sx, p[7].sy); ctx.lineTo(p[4].sx, p[4].sy)
          ctx.lineTo(ridgeFront.sx, ridgeFront.sy); ctx.lineTo(ridgeBack.sx, ridgeBack.sy)
          ctx.closePath(); ctx.fill()
        }
        // Right slope
        if (showRight || !showLeft) {
          ctx.fillStyle = roofDark
          ctx.beginPath()
          ctx.moveTo(p[5].sx, p[5].sy); ctx.lineTo(p[6].sx, p[6].sy)
          ctx.lineTo(ridgeBack.sx, ridgeBack.sy); ctx.lineTo(ridgeFront.sx, ridgeFront.sy)
          ctx.closePath(); ctx.fill()
        }
        // Front gable triangle
        if (showFront) {
          ctx.fillStyle = hexToCSS(applyFog(shadeFace(palette.wall, 0, 0, -1, lighting), avgDepth, lighting))
          ctx.beginPath()
          ctx.moveTo(p[4].sx, p[4].sy); ctx.lineTo(p[5].sx, p[5].sy)
          ctx.lineTo(ridgeFront.sx, ridgeFront.sy)
          ctx.closePath(); ctx.fill()
        }
        // Back gable
        if (showBack) {
          ctx.fillStyle = hexToCSS(applyFog(shadeFace(palette.wall, 0, 0, 1, lighting), avgDepth, lighting))
          ctx.beginPath()
          ctx.moveTo(p[6].sx, p[6].sy); ctx.lineTo(p[7].sx, p[7].sy)
          ctx.lineTo(ridgeBack.sx, ridgeBack.sy)
          ctx.closePath(); ctx.fill()
        }
        // Roof tile texture lines
        ctx.strokeStyle = hexToCSS(darken(roofFogged, 0.08))
        ctx.lineWidth = 0.3
        for (let t = 0.2; t < 0.9; t += 0.2) {
          const ly = p[4].sy + (ridgeFront.sy - p[4].sy) * t
          const lx1 = p[4].sx + (ridgeFront.sx - p[4].sx) * t * 0.3
          const lx2 = p[5].sx + (ridgeFront.sx - p[5].sx) * t * 0.3
          ctx.beginPath(); ctx.moveTo(lx1, ly); ctx.lineTo(lx2, ly); ctx.stroke()
        }
      }
    })
  } else if ((roofStyle === 'pointed' || roofStyle === 'steep') && ridgeCenter) {
    // Pointed/spire roof: four triangular faces meeting at apex
    drawables.push({
      depth: avgDepth - 0.02,
      draw: (ctx) => {
        if (showFront) {
          ctx.fillStyle = roofCSS
          ctx.beginPath()
          ctx.moveTo(p[4].sx, p[4].sy); ctx.lineTo(p[5].sx, p[5].sy)
          ctx.lineTo(ridgeCenter.sx, ridgeCenter.sy); ctx.closePath(); ctx.fill()
        }
        if (showBack) {
          ctx.fillStyle = roofCSS
          ctx.beginPath()
          ctx.moveTo(p[6].sx, p[6].sy); ctx.lineTo(p[7].sx, p[7].sy)
          ctx.lineTo(ridgeCenter.sx, ridgeCenter.sy); ctx.closePath(); ctx.fill()
        }
        if (showRight) {
          ctx.fillStyle = roofDark
          ctx.beginPath()
          ctx.moveTo(p[5].sx, p[5].sy); ctx.lineTo(p[6].sx, p[6].sy)
          ctx.lineTo(ridgeCenter.sx, ridgeCenter.sy); ctx.closePath(); ctx.fill()
        }
        if (showLeft) {
          ctx.fillStyle = roofDark
          ctx.beginPath()
          ctx.moveTo(p[7].sx, p[7].sy); ctx.lineTo(p[4].sx, p[4].sy)
          ctx.lineTo(ridgeCenter.sx, ridgeCenter.sy); ctx.closePath(); ctx.fill()
        }
        // Weather vane on pointed/steep roofs
        if (def.id === 'clock_tower' || def.id === 'tower' || def.id === 'chapel' || hash % 4 === 0) {
          ctx.strokeStyle = hexToCSS(darken(roofFogged, 0.4))
          ctx.lineWidth = 0.6
          // Pole
          ctx.beginPath()
          ctx.moveTo(ridgeCenter.sx, ridgeCenter.sy)
          ctx.lineTo(ridgeCenter.sx, ridgeCenter.sy - 4)
          ctx.stroke()
          // Arrow
          ctx.beginPath()
          ctx.moveTo(ridgeCenter.sx - 2, ridgeCenter.sy - 3.5)
          ctx.lineTo(ridgeCenter.sx + 2, ridgeCenter.sy - 3.5)
          ctx.stroke()
          // Arrow tip
          ctx.beginPath()
          ctx.moveTo(ridgeCenter.sx + 2, ridgeCenter.sy - 4.2)
          ctx.lineTo(ridgeCenter.sx + 3, ridgeCenter.sy - 3.5)
          ctx.lineTo(ridgeCenter.sx + 2, ridgeCenter.sy - 2.8)
          ctx.closePath(); ctx.fill()
        }
      }
    })
  } else if (roofStyle === 'hipped' && ridgeFront && ridgeBack) {
    // Hipped roof: ridge doesn't extend to edges, four sloped faces
    const inset = fw * 0.25
    const hipFront = project(x0 + inset, height + roofHeight * 0.9, z0)
    const hipBack = project(x0 + fw - inset, height + roofHeight * 0.9, z0 + fd)
    const hipFrontR = project(x0 + fw - inset, height + roofHeight * 0.9, z0)
    const hipBackL = project(x0 + inset, height + roofHeight * 0.9, z0 + fd)
    if (hipFront && hipBack && hipFrontR && hipBackL) {
      drawables.push({
        depth: avgDepth - 0.02,
        draw: (ctx) => {
          // Front face
          if (showFront) {
            ctx.fillStyle = roofCSS
            ctx.beginPath()
            ctx.moveTo(p[4].sx, p[4].sy); ctx.lineTo(p[5].sx, p[5].sy)
            ctx.lineTo(hipFrontR.sx, hipFrontR.sy); ctx.lineTo(hipFront.sx, hipFront.sy)
            ctx.closePath(); ctx.fill()
          }
          if (showBack) {
            ctx.fillStyle = roofCSS
            ctx.beginPath()
            ctx.moveTo(p[6].sx, p[6].sy); ctx.lineTo(p[7].sx, p[7].sy)
            ctx.lineTo(hipBackL.sx, hipBackL.sy); ctx.lineTo(hipBack.sx, hipBack.sy)
            ctx.closePath(); ctx.fill()
          }
          if (showRight) {
            ctx.fillStyle = roofDark
            ctx.beginPath()
            ctx.moveTo(p[5].sx, p[5].sy); ctx.lineTo(p[6].sx, p[6].sy)
            ctx.lineTo(hipBack.sx, hipBack.sy); ctx.lineTo(hipFrontR.sx, hipFrontR.sy)
            ctx.closePath(); ctx.fill()
          }
          if (showLeft) {
            ctx.fillStyle = roofDark
            ctx.beginPath()
            ctx.moveTo(p[7].sx, p[7].sy); ctx.lineTo(p[4].sx, p[4].sy)
            ctx.lineTo(hipFront.sx, hipFront.sy); ctx.lineTo(hipBackL.sx, hipBackL.sy)
            ctx.closePath(); ctx.fill()
          }
          // Top ridge
          ctx.strokeStyle = hexToCSS(darken(roofFogged, 0.25))
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(hipFront.sx, hipFront.sy); ctx.lineTo(hipBack.sx, hipBack.sy)
          ctx.stroke()
        }
      })
    }
  } else if (roofStyle === 'dome' && ridgeCenter) {
    // Dome roof: curved top surface
    drawables.push({
      depth: avgDepth - 0.02,
      draw: (ctx) => {
        const cx = (p[4].sx + p[5].sx + p[6].sx + p[7].sx) / 4
        const cy = (p[4].sy + p[5].sy + p[6].sy + p[7].sy) / 4
        const rx = Math.abs(p[5].sx - p[4].sx) / 2 * 1.1
        const ry = Math.abs(ridgeCenter.sy - cy) + 2
        // Dome ellipse
        ctx.fillStyle = roofCSS
        ctx.beginPath()
        ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, 0)
        ctx.closePath(); ctx.fill()
        // Dome shading — lit left, dark right
        ctx.fillStyle = hexToCSS(lighten(roofFogged, 0.06))
        ctx.beginPath()
        ctx.ellipse(cx - rx * 0.25, cy - ry * 0.2, rx * 0.4, ry * 0.5, -0.3, Math.PI, 0)
        ctx.closePath(); ctx.fill()
        // Dome ribs
        ctx.strokeStyle = hexToCSS(darken(roofFogged, 0.08))
        ctx.lineWidth = 0.3
        for (let ri = 0; ri < 3; ri++) {
          const ribX = cx - rx * 0.3 + ri * rx * 0.3
          ctx.beginPath()
          ctx.moveTo(ribX, cy)
          ctx.quadraticCurveTo(ribX + (ri - 1) * 0.5, cy - ry * 0.7, cx, cy - ry)
          ctx.stroke()
        }
        // Base of dome
        ctx.fillStyle = roofDark
        ctx.beginPath()
        ctx.ellipse(cx, cy, rx, ry * 0.3, 0, 0, Math.PI)
        ctx.closePath(); ctx.fill()
      }
    })
  } else if (roofStyle === 'flat' || roofStyle === 'none') {
    // Flat roof or no roof — simple top face
    if (roofStyle !== 'none') {
      drawables.push({
        depth: avgDepth - 0.01,
        draw: (ctx) => {
          ctx.fillStyle = roofCSS
          ctx.beginPath()
          ctx.moveTo(p[4].sx, p[4].sy); ctx.lineTo(p[5].sx, p[5].sy)
          ctx.lineTo(p[6].sx, p[6].sy); ctx.lineTo(p[7].sx, p[7].sy)
          ctx.closePath(); ctx.fill()
          // Battlement crenellations for gate/tower
          if (def.id === 'town_gate' || def.id === 'watchtower') {
            const crenW = Math.abs(p[5].sx - p[4].sx) / 8
            const crenH = Math.abs(p[4].sy - p[0].sy) * 0.06
            ctx.fillStyle = hexToCSS(darken(roofFogged, 0.1))
            for (let i = 0; i < 4; i++) {
              const t = (i * 2 + 1) / 8
              const cx = p[4].sx + (p[5].sx - p[4].sx) * t
              const cy2 = p[4].sy
              ctx.fillRect(cx - crenW / 2, cy2 - crenH, crenW, crenH)
            }
          }
        }
      })
    }
  }

  // ── CHIMNEY ──
  if (HAS_CHIMNEY.has(def.id)) {
    const chimX = x0 + fw * (hash % 2 === 0 ? 0.2 : 0.8)
    const chimZ = z0 + fd * 0.3
    const chimBot = project(chimX, height - ts * 0.1, chimZ)
    const chimTop = project(chimX, height + roofHeight * 0.7, chimZ)
    if (chimBot && chimTop) {
      drawables.push({
        depth: avgDepth - 0.03,
        draw: (ctx) => {
          const cw = Math.max(2, Math.abs(chimTop.sx - chimBot.sx) * 0.3 + 2)
          ctx.fillStyle = hexToCSS(darken(applyFog(palette.wall, avgDepth, lighting), 0.2))
          ctx.fillRect(chimTop.sx - cw / 2, chimTop.sy, cw, chimBot.sy - chimTop.sy)
          // Chimney cap
          ctx.fillStyle = hexToCSS(darken(roofFogged, 0.3))
          ctx.fillRect(chimTop.sx - cw * 0.7, chimTop.sy - 1, cw * 1.4, 2)
          // Soot stain on roof below chimney
          ctx.fillStyle = 'rgba(30,25,20,0.12)'
          ctx.beginPath()
          ctx.ellipse(chimTop.sx, chimBot.sy + 1, cw * 1.5, 2, 0, 0, Math.PI * 2)
          ctx.fill()
          // Chimney smoke puffs
          for (let si = 0; si < 4; si++) {
            const smokeY = chimTop.sy - 3 - si * 3 - ((time * 2 + hash * 0.1) % 4)
            const smokeX = chimTop.sx + Math.sin(time * 0.5 + hash + si * 1.5) * (1 + si * 0.5)
            const smokeA = Math.max(0, 0.14 - si * 0.03)
            ctx.fillStyle = `rgba(180,170,160,${smokeA})`
            ctx.beginPath()
            ctx.arc(smokeX, smokeY, 1.2 + si * 0.5, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      })
    }
  }

  // ── WINDMILL BLADES ── (always draw — silhouette element)
  if (def.id === 'windmill' && ridgeCenter) {
    drawables.push({
      depth: avgDepth - 0.035,
      draw: (ctx) => {
        const bladeLen = Math.abs(ridgeCenter.sy - p[0].sy) * 0.6
        const hubX = ridgeCenter.sx
        const hubY = ridgeCenter.sy - 2
        const bladeAngle = time * 0.8 + hash * 0.5
        ctx.strokeStyle = hexToCSS(darken(applyFog(palette.wall, avgDepth, lighting), 0.2))
        ctx.lineWidth = 1.2
        for (let bi = 0; bi < 4; bi++) {
          const a = bladeAngle + bi * Math.PI / 2
          const bx = hubX + Math.cos(a) * bladeLen
          const by = hubY + Math.sin(a) * bladeLen * 0.5 // perspective squash
          ctx.beginPath(); ctx.moveTo(hubX, hubY); ctx.lineTo(bx, by); ctx.stroke()
          // Blade sail (thin parallelogram)
          const perpX = Math.cos(a + Math.PI / 2) * bladeLen * 0.08
          const perpY = Math.sin(a + Math.PI / 2) * bladeLen * 0.04
          ctx.fillStyle = hexToCSS(applyFog(0xd8d0c0, avgDepth, lighting))
          ctx.beginPath()
          ctx.moveTo(hubX + Math.cos(a) * bladeLen * 0.2, hubY + Math.sin(a) * bladeLen * 0.1)
          ctx.lineTo(hubX + Math.cos(a) * bladeLen * 0.2 + perpX, hubY + Math.sin(a) * bladeLen * 0.1 + perpY)
          ctx.lineTo(bx + perpX, by + perpY)
          ctx.lineTo(bx, by)
          ctx.closePath(); ctx.fill()
        }
        // Hub
        ctx.fillStyle = hexToCSS(darken(applyFog(palette.wall, avgDepth, lighting), 0.15))
        ctx.beginPath(); ctx.arc(hubX, hubY, 2, 0, Math.PI * 2); ctx.fill()
      }
    })
  }

  // ── DORMERS (small windowed projections on roof) ── (LOD skip when distant)
  if (!isDistant && HAS_DORMER.has(def.id) && (roofStyle === 'gabled' || roofStyle === 'hipped' || roofStyle === 'steep') && ridgeFront) {
    const numDormers = 1 + hash % 2
    for (let di = 0; di < numDormers; di++) {
      const dt = (di + 1) / (numDormers + 1) // spread evenly
      const dormX = x0 + fw * dt
      const dormZ = z0 + fd * 0.3
      const dormBase = project(dormX, height + roofHeight * 0.15, dormZ)
      const dormTop = project(dormX, height + roofHeight * 0.5, dormZ)
      if (dormBase && dormTop) {
        const dormW2 = Math.max(3, fw * 0.12)
        const dormH2 = Math.abs(dormTop.sy - dormBase.sy)
        drawables.push({
          depth: avgDepth - 0.025,
          draw: (ctx) => {
            // Dormer front wall
            ctx.fillStyle = hexToCSS(applyFog(palette.wall, avgDepth, lighting))
            ctx.fillRect(dormBase.sx - dormW2 / 2, dormTop.sy, dormW2, dormH2)
            // Dormer roof peak
            ctx.fillStyle = roofDark
            ctx.beginPath()
            ctx.moveTo(dormBase.sx - dormW2 * 0.7, dormTop.sy)
            ctx.lineTo(dormBase.sx, dormTop.sy - dormH2 * 0.5)
            ctx.lineTo(dormBase.sx + dormW2 * 0.7, dormTop.sy)
            ctx.closePath(); ctx.fill()
            // Dormer window
            const isLit = lighting.isNight || lighting.isDusk
            ctx.fillStyle = isLit ? '#ffcc66' : hexToCSS(darken(applyFog(palette.wall, avgDepth, lighting), 0.18))
            ctx.fillRect(dormBase.sx - dormW2 * 0.25, dormTop.sy + dormH2 * 0.15, dormW2 * 0.5, dormH2 * 0.6)
          }
        })
      }
    }
  }

  // ── TURRET (round corner tower) ── (LOD skip when distant)
  if (!isDistant && HAS_TURRET.has(def.id)) {
    const turX = hash % 2 === 0 ? x0 : x0 + fw
    const turZ = z0
    const turBase = project(turX, 0, turZ)
    const turTop = project(turX, height + roofHeight * 0.4, turZ)
    const turPeak = project(turX, height + roofHeight * 0.9, turZ)
    if (turBase && turTop && turPeak) {
      const turR = Math.max(2.5, fw * 0.1)
      drawables.push({
        depth: avgDepth - 0.015,
        draw: (ctx) => {
          // Cylindrical shaft
          ctx.fillStyle = hexToCSS(applyFog(darken(palette.wall, 0.05), avgDepth, lighting))
          ctx.fillRect(turBase.sx - turR, turTop.sy, turR * 2, turBase.sy - turTop.sy)
          // Round top
          ctx.beginPath()
          ctx.arc(turBase.sx, turTop.sy, turR, Math.PI, 0)
          ctx.fill()
          // Conical cap
          ctx.fillStyle = roofDark
          ctx.beginPath()
          ctx.moveTo(turBase.sx - turR * 1.2, turTop.sy)
          ctx.lineTo(turBase.sx, turPeak.sy)
          ctx.lineTo(turBase.sx + turR * 1.2, turTop.sy)
          ctx.closePath(); ctx.fill()
          // Arrow slit
          ctx.fillStyle = hexToCSS(darken(applyFog(palette.wall, avgDepth, lighting), 0.3))
          const slitY = turTop.sy + (turBase.sy - turTop.sy) * 0.4
          ctx.fillRect(turBase.sx - 0.3, slitY - 2, 0.6, 4)
        }
      })
    }
  }

  // ── BIRDS ON ROOFTOPS ── (LOD skip when distant)
  if (!isDistant && hash % 7 === 0 && ridgeCenter) { // ~15% of buildings
    const numBirds = 1 + hash % 2
    for (let bi = 0; bi < numBirds; bi++) {
      const birdX = ridgeCenter.sx + (bi * 6 - 3) + Math.sin(time * 0.5 + hash + bi) * 0.5
      const birdY = ridgeCenter.sy - 2 - bi * 2
      drawables.push({
        depth: avgDepth - 0.04,
        draw: (ctx) => {
          ctx.strokeStyle = 'rgba(30,25,20,0.7)'
          ctx.lineWidth = 0.8
          ctx.beginPath()
          ctx.moveTo(birdX - 1.5, birdY + 0.5)
          ctx.lineTo(birdX, birdY)
          ctx.lineTo(birdX + 1.5, birdY + 0.5)
          ctx.stroke()
        }
      })
    }
  }

  // ── WALL FACES with architectural detail ──
  const wallFaces: { indices: number[]; nx: number; ny: number; nz: number; isFront: boolean }[] = []
  if (showFront) wallFaces.push({ indices: [0, 1, 5, 4], nx: 0, ny: 0, nz: -1, isFront: true })
  if (showBack) wallFaces.push({ indices: [2, 3, 7, 6], nx: 0, ny: 0, nz: 1, isFront: false })
  if (showRight) wallFaces.push({ indices: [1, 2, 6, 5], nx: 1, ny: 0, nz: 0, isFront: false })
  if (showLeft) wallFaces.push({ indices: [3, 0, 4, 7], nx: -1, ny: 0, nz: 0, isFront: false })

  const hasTimber = HAS_TIMBER_FRAME.has(def.id)
  const hasAwning = HAS_AWNING.has(def.id)

  for (const face of wallFaces) {
    const wallColor = shadeFace(palette.wall, face.nx, face.ny, face.nz, lighting)
    const wallFogged = applyFog(wallColor, avgDepth, lighting)
    const fp = face.indices.map(i => p[i])
    const faceW = Math.abs(fp[1].sx - fp[0].sx)
    const faceH = Math.abs(fp[0].sy - fp[3].sy)

    drawables.push({
      depth: avgDepth,
      draw: (ctx) => {
        // Base wall fill
        ctx.fillStyle = hexToCSS(wallFogged)
        ctx.beginPath()
        ctx.moveTo(fp[0].sx, fp[0].sy)
        for (let i = 1; i < fp.length; i++) ctx.lineTo(fp[i].sx, fp[i].sy)
        ctx.closePath(); ctx.fill()

        // Shadow pool at building base
        ctx.fillStyle = 'rgba(0,0,0,0.08)'
        ctx.fillRect(Math.min(fp[0].sx, fp[1].sx), fp[0].sy - 1, faceW, 2)

        // Surface texture (LOD: only when close enough to see)
        if (!isDistant && faceW > 5 && faceH > 5) {
          const material = BUILDING_MATERIAL[def.id] || (hash % 3 === 0 ? 'stone' : hash % 3 === 1 ? 'brick' : 'plaster')
          if (material === 'stone') drawStoneTexture(ctx, fp, faceW, faceH, wallFogged, hash)
          else if (material === 'wood') drawWoodTexture(ctx, fp, faceW, faceH, wallFogged, hash)
          else if (material === 'brick') drawBrickTexture(ctx, fp, faceW, faceH, wallFogged, hash)
          else if (material === 'plaster') drawPlasterTexture(ctx, fp, faceW, faceH, wallFogged, hash)
        }

        // Roof eave overhang shadow (darkened strip at top of wall)
        if (roofStyle !== 'none' && roofStyle !== 'flat' && faceH > 6) {
          ctx.fillStyle = 'rgba(0,0,0,0.1)'
          ctx.fillRect(Math.min(fp[0].sx, fp[1].sx) - 1, fp[3].sy, faceW + 2, 2)
        }

        // Exposed brick patches on older buildings
        if ((def.id === 'building_small' || def.id === 'row_house' || def.id === 'warehouse' || def.id === 'half_timber') && faceW > 8) {
          const patchHash = (hash * 7 + face.nx * 3) & 0xffff
          if (patchHash % 4 === 0) {
            const px = fp[0].sx + faceW * (0.3 + (patchHash % 30) / 100)
            const py = fp[0].sy - faceH * (0.2 + (patchHash % 20) / 100)
            const pw = faceW * 0.15, ph = faceH * 0.12
            ctx.fillStyle = hexToCSS(applyFog(0x8a5a3a, avgDepth, lighting))
            ctx.fillRect(px, py, pw, ph)
            // Brick mortar lines
            ctx.strokeStyle = hexToCSS(darken(applyFog(0x8a5a3a, avgDepth, lighting), 0.15))
            ctx.lineWidth = 0.2
            for (let by = 0; by < 3; by++) {
              const bly = py + ph * (by + 0.5) / 3
              ctx.beginPath(); ctx.moveTo(px, bly); ctx.lineTo(px + pw, bly); ctx.stroke()
            }
          }
        }

        // Ivy climbing on side walls
        if (hash % 6 === 0 && !face.isFront && faceH > 8) {
          const ivyX = fp[0].sx + faceW * (0.1 + (hash % 30) / 50)
          const ivyBot = fp[0].sy
          const ivyH = faceH * (0.3 + (hash % 20) / 50)
          // Vine stem
          ctx.strokeStyle = 'rgba(40,80,30,0.3)'
          ctx.lineWidth = 0.5
          ctx.beginPath()
          ctx.moveTo(ivyX, ivyBot)
          ctx.quadraticCurveTo(ivyX + 2, ivyBot - ivyH * 0.5, ivyX - 1, ivyBot - ivyH)
          ctx.stroke()
          // Leaf clusters
          const ivyGreen = applyFog(0x3a7a2a, avgDepth, lighting)
          ctx.fillStyle = hexToCSS(ivyGreen)
          for (let li = 0; li < 5; li++) {
            const lx = ivyX + Math.sin(li * 1.8) * 1.5
            const ly = ivyBot - ivyH * (li / 5) - 1
            ctx.beginPath(); ctx.arc(lx, ly, 1.2 + (li % 2) * 0.4, 0, Math.PI * 2); ctx.fill()
          }
        }

        // Cornice molding bands on noble buildings
        if ((def.id === 'mansion' || def.id === 'guild_hall' || def.id === 'building_large') && faceH > 10) {
          ctx.fillStyle = hexToCSS(darken(wallFogged, 0.15))
          const corniceY1 = fp[0].sy + (fp[3].sy - fp[0].sy) * 0.15
          const corniceY2 = fp[0].sy + (fp[3].sy - fp[0].sy) * 0.55
          ctx.fillRect(Math.min(fp[0].sx, fp[1].sx), corniceY1, faceW, 1.5)
          ctx.fillRect(Math.min(fp[0].sx, fp[1].sx), corniceY2, faceW, 1)
        }

        // Clock face on clock_tower
        if (def.id === 'clock_tower' && face.isFront && faceH > 8) {
          const clockR = Math.min(faceW, faceH) * 0.12
          const clockX2 = (fp[0].sx + fp[1].sx) / 2
          const clockY2 = fp[0].sy - faceH * 0.65
          // Clock circle
          ctx.fillStyle = hexToCSS(applyFog(0xf0e8d0, avgDepth, lighting))
          ctx.beginPath(); ctx.arc(clockX2, clockY2, clockR, 0, Math.PI * 2); ctx.fill()
          ctx.strokeStyle = hexToCSS(darken(wallFogged, 0.3))
          ctx.lineWidth = 0.6
          ctx.beginPath(); ctx.arc(clockX2, clockY2, clockR, 0, Math.PI * 2); ctx.stroke()
          // Clock hands
          ctx.strokeStyle = hexToCSS(darken(wallFogged, 0.4))
          ctx.lineWidth = 0.5
          ctx.beginPath(); ctx.moveTo(clockX2, clockY2); ctx.lineTo(clockX2, clockY2 - clockR * 0.7); ctx.stroke()
          ctx.beginPath(); ctx.moveTo(clockX2, clockY2); ctx.lineTo(clockX2 + clockR * 0.5, clockY2 + clockR * 0.2); ctx.stroke()
        }

        // Ground floor differentiation (darker base for shops)
        if (hasAwning && faceH > 8) {
          const shopH = faceH * 0.35
          ctx.fillStyle = hexToCSS(darken(wallFogged, 0.12))
          const sy = fp[0].sy - shopH
          ctx.fillRect(Math.min(fp[0].sx, fp[1].sx), sy, faceW, shopH)
        }

        // Timber framing (half-timbered)
        if (hasTimber && faceW > 8 && faceH > 8) {
          ctx.strokeStyle = hexToCSS(darken(wallFogged, 0.35))
          ctx.lineWidth = 1
          // Horizontal beams
          for (let row = 0; row < 3; row++) {
            const u = 0.3 + row * 0.25
            const by = fp[0].sy + (fp[3].sy - fp[0].sy) * u
            ctx.beginPath()
            ctx.moveTo(fp[0].sx, by); ctx.lineTo(fp[1].sx, by); ctx.stroke()
          }
          // Vertical beams
          for (let col = 0; col < 3; col++) {
            const t = 0.2 + col * 0.3
            const bx = fp[0].sx + (fp[1].sx - fp[0].sx) * t
            ctx.beginPath()
            ctx.moveTo(bx, fp[3].sy); ctx.lineTo(bx, fp[0].sy); ctx.stroke()
          }
          // Diagonal cross braces (heritage cross-framing)
          if (faceW > 12) {
            ctx.beginPath()
            const qx1 = fp[0].sx + faceW * 0.2, qx2 = fp[0].sx + faceW * 0.5
            const qy1 = fp[0].sy - faceH * 0.3, qy2 = fp[0].sy - faceH * 0.7
            ctx.moveTo(qx1, qy1); ctx.lineTo(qx2, qy2); ctx.stroke()
            ctx.moveTo(qx2, qy1); ctx.lineTo(qx1, qy2); ctx.stroke()
          }
        }

        // Windows — more varied per floor
        if (faceW > 6 && faceH > 6) {
          const floors = Math.max(1, Math.min(3, Math.floor(faceH / 10) + 1))
          const cols = Math.max(1, Math.min(4, Math.floor(faceW / 8)))
          const winW = faceW * 0.1
          const winH = faceH * (0.1 / floors)
          const isLit = lighting.isNight || lighting.isDusk
          const winColor = isLit ? '#ffcc66' : hexToCSS(darken(wallFogged, 0.18))
          const shutterColor = hexToCSS(darken(wallFogged, 0.25))

          for (let row = 0; row < floors; row++) {
            for (let col = 0; col < cols; col++) {
              // Skip door position (center-bottom on front face)
              if (face.isFront && row === floors - 1 && col === Math.floor(cols / 2)) continue
              const t = (col + 0.5) / cols
              const u = 0.2 + row * (0.6 / floors)
              const wx = fp[0].sx + (fp[1].sx - fp[0].sx) * t
              const wy = fp[0].sy + (fp[3].sy - fp[0].sy) * u
              ctx.fillStyle = winColor
              // Arched windows for sacred buildings
              const isSacred = def.id === 'chapel' || def.id === 'temple' || def.id === 'bell_tower'
              if (isSacred) {
                ctx.beginPath()
                ctx.moveTo(wx - winW / 2, wy + winH / 2)
                ctx.lineTo(wx - winW / 2, wy - winH / 4)
                ctx.arc(wx, wy - winH / 4, winW / 2, Math.PI, 0)
                ctx.lineTo(wx + winW / 2, wy + winH / 2)
                ctx.closePath(); ctx.fill()
                // Mullion divider
                ctx.strokeStyle = hexToCSS(darken(wallFogged, 0.2))
                ctx.lineWidth = 0.3
                ctx.beginPath(); ctx.moveTo(wx, wy + winH / 2); ctx.lineTo(wx, wy - winH / 2); ctx.stroke()
              } else {
                ctx.fillRect(wx - winW / 2, wy - winH / 2, winW, winH)
              }
              // Window flower box
              if (obj.properties?.hasFlowerBox && row === 0 && !isSacred) {
                ctx.fillStyle = hexToCSS(darken(wallFogged, 0.2))
                ctx.fillRect(wx - winW * 0.6, wy + winH / 2, winW * 1.2, 1.5)
                ctx.fillStyle = hexToCSS(applyFog(0xff6688, avgDepth, lighting))
                ctx.beginPath(); ctx.arc(wx - winW * 0.2, wy + winH / 2 + 0.5, 0.8, 0, Math.PI * 2); ctx.fill()
                ctx.fillStyle = hexToCSS(applyFog(0xffaa44, avgDepth, lighting))
                ctx.beginPath(); ctx.arc(wx + winW * 0.3, wy + winH / 2 + 0.3, 0.6, 0, Math.PI * 2); ctx.fill()
              }
              // Window frame / shutters
              if (!isLit && faceW > 10 && !isSacred) {
                ctx.fillStyle = shutterColor
                ctx.fillRect(wx - winW / 2 - winW * 0.4, wy - winH / 2, winW * 0.35, winH)
                ctx.fillRect(wx + winW / 2 + winW * 0.05, wy - winH / 2, winW * 0.35, winH)
              }
              // Window glow pool at night
              if (isLit && row < floors - 1) {
                ctx.fillStyle = 'rgba(255,200,100,0.04)'
                ctx.beginPath()
                ctx.ellipse(wx, wy + winH, winW * 2, winH * 1.5, 0, 0, Math.PI * 2)
                ctx.fill()
              }
            }
          }

          // Door on front face
          if (face.isFront) {
            const doorW = faceW * 0.14
            const doorH = faceH * 0.22
            const doorX = fp[0].sx + faceW * 0.5
            const doorY = fp[0].sy
            const doorColor = applyFog(shadeFace(palette.door, face.nx, face.ny, face.nz, lighting), avgDepth, lighting)
            ctx.fillStyle = hexToCSS(doorColor)
            // Arched door top for larger buildings
            const isArchedDoor = def.id === 'chapel' || def.id === 'guild_hall' || def.id === 'mansion' || def.id === 'town_gate' || def.id === 'archway'
            if (isArchedDoor) {
              ctx.beginPath()
              ctx.moveTo(doorX - doorW / 2, doorY)
              ctx.lineTo(doorX - doorW / 2, doorY - doorH * 0.6)
              ctx.arc(doorX, doorY - doorH * 0.6, doorW / 2, Math.PI, 0)
              ctx.lineTo(doorX + doorW / 2, doorY)
              ctx.closePath(); ctx.fill()
            } else {
              ctx.fillRect(doorX - doorW / 2, doorY - doorH, doorW, doorH)
            }
            // Door frame
            ctx.strokeStyle = hexToCSS(darken(doorColor, 0.2))
            ctx.lineWidth = 0.5
            ctx.strokeRect(doorX - doorW / 2, doorY - doorH, doorW, doorH)
            // Doorknob
            ctx.fillStyle = hexToCSS(darken(doorColor, 0.3))
            ctx.beginPath()
            ctx.arc(doorX + doorW * 0.25, doorY - doorH * 0.4, 0.8, 0, Math.PI * 2)
            ctx.fill()
          }
        }

        // Awning over ground floor (shop-style)
        if (hasAwning && face.isFront && faceH > 8) {
          const awningH = faceH * 0.08
          const awningY = fp[0].sy - faceH * 0.32
          const awningColor = hash % 3 === 0 ? 0xaa3333 : hash % 3 === 1 ? 0x336633 : 0x334466
          ctx.fillStyle = hexToCSS(applyFog(awningColor, avgDepth, lighting))
          ctx.beginPath()
          ctx.moveTo(fp[0].sx, awningY)
          ctx.lineTo(fp[1].sx, awningY)
          ctx.lineTo(fp[1].sx + faceW * 0.05, awningY + awningH)
          ctx.lineTo(fp[0].sx - faceW * 0.05, awningY + awningH)
          ctx.closePath(); ctx.fill()
        }

        // Jettied upper floor (overhanging second story)
        if (HAS_JETTY.has(def.id) && faceH > 10) {
          const jettyY = fp[0].sy - faceH * 0.45
          const overhang = faceW * 0.04
          // Overhang floor plate
          ctx.fillStyle = hexToCSS(darken(wallFogged, 0.12))
          ctx.fillRect(Math.min(fp[0].sx, fp[1].sx) - overhang, jettyY - 1, faceW + overhang * 2, 2)
          // Upper floor slightly wider (jetty)
          ctx.fillStyle = hexToCSS(wallFogged)
          ctx.fillRect(Math.min(fp[0].sx, fp[1].sx) - overhang, fp[3].sy, faceW + overhang * 2, jettyY - fp[3].sy + 1)
          // Support bracket corbels
          ctx.fillStyle = hexToCSS(darken(wallFogged, 0.2))
          const numBrackets = Math.max(2, Math.floor(faceW / 8))
          for (let bi = 0; bi < numBrackets; bi++) {
            const bx = fp[0].sx + faceW * ((bi + 0.5) / numBrackets)
            ctx.beginPath()
            ctx.moveTo(bx - 1, jettyY)
            ctx.lineTo(bx, jettyY + 2)
            ctx.lineTo(bx + 1, jettyY)
            ctx.closePath(); ctx.fill()
          }
        }

        // Stepped gable on gable-facing walls
        if (HAS_STEPPED_GABLE.has(def.id) && !face.isFront && faceH > 10 && (roofStyle === 'gabled' || roofStyle === 'steep')) {
          const steps = 3 + hash % 2
          const stepW = faceW * 0.1
          const stepH = faceH * 0.06
          ctx.fillStyle = hexToCSS(wallFogged)
          for (let si = 0; si < steps; si++) {
            const sx2 = fp[0].sx + faceW * 0.5 + (si + 1) * stepW * 0.5
            const sy2 = fp[3].sy + si * stepH
            ctx.fillRect(sx2 - stepW / 2, sy2, stepW, stepH)
            // Mirror on left side
            const sx3 = fp[0].sx + faceW * 0.5 - (si + 1) * stepW * 0.5
            ctx.fillRect(sx3 - stepW / 2, sy2, stepW, stepH)
          }
        }

        // Bay window (protruding windowed box on upper floor)
        if ((def.id === 'mansion' || def.id === 'building_large' || def.id === 'guild_hall' || def.id === 'corner_building') && face.isFront && faceH > 12 && faceW > 10) {
          const bayW = faceW * 0.25
          const bayH = faceH * 0.2
          const bayX = fp[0].sx + faceW * (hash % 2 === 0 ? 0.25 : 0.65)
          const bayY = fp[0].sy - faceH * 0.5
          const bayDepth = 2 // protrusion in pixels
          // Front face of bay
          ctx.fillStyle = hexToCSS(wallFogged)
          ctx.fillRect(bayX - bayW / 2, bayY - bayH / 2, bayW, bayH)
          // Side panels (trapezoid suggesting depth)
          ctx.fillStyle = hexToCSS(darken(wallFogged, 0.1))
          ctx.beginPath()
          ctx.moveTo(bayX - bayW / 2, bayY - bayH / 2)
          ctx.lineTo(bayX - bayW / 2 - bayDepth, bayY - bayH / 2 + 1)
          ctx.lineTo(bayX - bayW / 2 - bayDepth, bayY + bayH / 2 - 1)
          ctx.lineTo(bayX - bayW / 2, bayY + bayH / 2)
          ctx.closePath(); ctx.fill()
          // Bay window glass
          const isLit2 = lighting.isNight || lighting.isDusk
          ctx.fillStyle = isLit2 ? '#ffcc66' : hexToCSS(darken(wallFogged, 0.18))
          ctx.fillRect(bayX - bayW * 0.35, bayY - bayH * 0.3, bayW * 0.3, bayH * 0.5)
          ctx.fillRect(bayX + bayW * 0.05, bayY - bayH * 0.3, bayW * 0.3, bayH * 0.5)
          // Bay top ledge
          ctx.fillStyle = hexToCSS(darken(wallFogged, 0.12))
          ctx.fillRect(bayX - bayW / 2 - bayDepth, bayY - bayH / 2 - 1, bayW + bayDepth * 2, 1.5)
          // Bay bottom support
          ctx.fillRect(bayX - bayW / 2 - 1, bayY + bayH / 2, bayW + 2, 1)
        }

        // Door step (raised stone threshold)
        if (face.isFront && faceW > 6) {
          const stepW = faceW * 0.2
          const doorX2 = fp[0].sx + faceW * 0.5
          ctx.fillStyle = hexToCSS(darken(wallFogged, 0.15))
          ctx.fillRect(doorX2 - stepW / 2, fp[0].sy, stepW, 1.5)
        }

        // Balcony projection (balcony_house, mansion, inn)
        if ((def.id === 'balcony_house' || def.id === 'mansion' || def.id === 'inn') && face.isFront && faceH > 10) {
          const balY = fp[0].sy - faceH * 0.55
          const balW = faceW * 0.6
          const balH = 2
          ctx.fillStyle = hexToCSS(darken(wallFogged, 0.1))
          ctx.fillRect(fp[0].sx + faceW * 0.2, balY, balW, balH)
          // Railing
          ctx.strokeStyle = hexToCSS(darken(wallFogged, 0.3))
          ctx.lineWidth = 0.5
          const railH = faceH * 0.08
          ctx.strokeRect(fp[0].sx + faceW * 0.2, balY - railH, balW, railH)
        }
      }
    })
  }

  // ── SHADOW ──
  const shadowOffX = -lighting.sunDirX * height * 0.5
  const shadowOffZ = -lighting.sunDirZ * height * 0.5
  const s0 = project(x0 + shadowOffX, 0, z0 + shadowOffZ)
  const s1 = project(x0 + fw + shadowOffX, 0, z0 + shadowOffZ)
  const s2 = project(x0 + fw + shadowOffX, 0, z0 + fd + shadowOffZ)
  const s3 = project(x0 + shadowOffX, 0, z0 + fd + shadowOffZ)
  if (s0 && s1 && s2 && s3) {
    drawables.push({
      depth: avgDepth + 0.02,
      draw: (ctx) => {
        ctx.fillStyle = `rgba(0,0,0,${lighting.isNight ? 0.15 : 0.35})`
        ctx.beginPath()
        ctx.moveTo(s0.sx, s0.sy); ctx.lineTo(s1.sx, s1.sy)
        ctx.lineTo(s2.sx, s2.sy); ctx.lineTo(s3.sx, s3.sy)
        ctx.closePath(); ctx.fill()
      }
    })
  }
}

// ── Prop drawing ──

const PROP_HEIGHTS: Record<string, number> = {
  tree: 1.4, fountain: 1.5, market_stall: 1.0,
  well: 0.8, bench: 0.4, barrel: 0.5,
  crate: 0.5, sign_post: 1.0, lamp_post: 1.3,
  grave: 0.5, statue: 1.8, flower_bed: 0.3,
  hay_bale: 0.6, wagon: 0.8, road_marker: 0.4,
}

function addPropDrawables(
  drawables: Drawable[], obj: PlacedObject, def: ObjectDefinition,
  ts: number,
  project: (x: number, y: number, z: number) => Projected | null,
  lighting: Lighting, time: number, lights: LightSource[]
) {
  const cx = (obj.x + def.footprint.w / 2) * ts
  const cz = (obj.y + def.footprint.h / 2) * ts
  const colors = PROP_COLORS[def.id] || { body: parseInt(def.color.replace('#', ''), 16) || 0x808080 }

  const propH = (PROP_HEIGHTS[def.id] ?? 0.6) * ts
  const base = project(cx, 0, cz)
  const top = project(cx, propH, cz)
  if (!base || !top) return

  // LOD: skip props that are smaller than 2px on screen
  const screenH = Math.abs(top.sy - base.sy)
  if (screenH < 2) return

  const bodyColor = shadeFace(colors.body, 0, 1, 0, lighting)
  const foggedBody = applyFog(bodyColor, base.depth, lighting)

  if (def.id === 'tree') {
    const species = (obj.properties.species as string) || 'oak'
    const heightMul = species === 'pine' ? 1.5 : species === 'birch' ? 1.3 : species === 'willow' ? 0.9 : 1.0
    const trunkTop = project(cx, ts * 0.5 * heightMul, cz)
    const canopyTop = project(cx, ts * 1.2 * heightMul, cz)
    if (!trunkTop || !canopyTop) return

    const accentColor = shadeFace(colors.accent!, 0, 1, 0, lighting)
    const foggedAccent = applyFog(accentColor, base.depth, lighting)
    const treeHash = simpleHash(obj.id)
    // Species-specific canopy colors
    const canopyHue = species === 'birch' ? lighten(foggedAccent, 0.06) :
      species === 'pine' ? darken(foggedAccent, 0.08) :
      species === 'maple' ? applyFog(shadeFace(0x8a6030, 0, 1, 0, lighting), base.depth, lighting) :
      foggedAccent
    const trunkW = Math.max(2, (trunkTop.sx - base.sx) * 0.05 + (species === 'pine' ? 2 : 3))

    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Trunk
        ctx.fillStyle = hexToCSS(species === 'birch' ? lighten(foggedBody, 0.2) : foggedBody)
        const tw = trunkW * 0.7
        ctx.beginPath()
        ctx.moveTo(base.sx - trunkW / 2, base.sy)
        ctx.lineTo(base.sx - tw / 2, trunkTop.sy)
        ctx.lineTo(base.sx + tw / 2, trunkTop.sy)
        ctx.lineTo(base.sx + trunkW / 2, base.sy)
        ctx.closePath(); ctx.fill()
        // Birch: horizontal bark marks
        if (species === 'birch') {
          ctx.strokeStyle = 'rgba(0,0,0,0.12)'
          ctx.lineWidth = 0.3
          const h = Math.abs(base.sy - trunkTop.sy)
          for (let bi = 0; bi < 4; bi++) {
            const by = base.sy - h * (0.2 + bi * 0.2)
            ctx.beginPath(); ctx.moveTo(base.sx - tw * 0.3, by); ctx.lineTo(base.sx + tw * 0.3, by); ctx.stroke()
          }
        }

        const r = Math.max(4, Math.abs(canopyTop.sy - trunkTop.sy) * 0.7)

        if (species === 'pine') {
          // Conical canopy — triangle layers
          for (let layer = 0; layer < 3; layer++) {
            const layerY = trunkTop.sy - r * (0.1 + layer * 0.35)
            const layerW = r * (0.9 - layer * 0.2)
            const layerH = r * 0.45
            ctx.fillStyle = layer % 2 === 0 ? hexToCSS(canopyHue) : hexToCSS(darken(canopyHue, 0.06))
            ctx.beginPath()
            ctx.moveTo(trunkTop.sx, layerY - layerH)
            ctx.lineTo(trunkTop.sx - layerW, layerY)
            ctx.lineTo(trunkTop.sx + layerW, layerY)
            ctx.closePath(); ctx.fill()
          }
        } else if (species === 'willow') {
          // Weeping canopy — wide dome + hanging fronds
          ctx.fillStyle = hexToCSS(darken(canopyHue, 0.08))
          ctx.beginPath()
          ctx.ellipse(trunkTop.sx, trunkTop.sy - r * 0.3, r * 1.1, r * 0.6, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = hexToCSS(canopyHue)
          ctx.beginPath()
          ctx.ellipse(trunkTop.sx, trunkTop.sy - r * 0.35, r * 0.9, r * 0.5, 0, 0, Math.PI * 2)
          ctx.fill()
          // Hanging fronds
          ctx.strokeStyle = hexToCSS(darken(canopyHue, 0.05))
          ctx.lineWidth = 0.5
          for (let fi = 0; fi < 7; fi++) {
            const fAngle = -Math.PI * 0.8 + fi * Math.PI * 1.6 / 6
            const fx = trunkTop.sx + Math.cos(fAngle) * r * 0.8
            const fy = trunkTop.sy - r * 0.1
            ctx.beginPath()
            ctx.moveTo(trunkTop.sx + Math.cos(fAngle) * r * 0.5, trunkTop.sy - r * 0.3)
            ctx.quadraticCurveTo(fx, trunkTop.sy, fx + Math.cos(fAngle) * 2, fy + r * 0.4)
            ctx.stroke()
          }
        } else if (species === 'birch') {
          // Airy, scattered canopy — small irregular clusters
          for (let ci = 0; ci < 5; ci++) {
            const cAngle = (ci / 5) * Math.PI * 2 + treeHash * 0.4
            const cx2 = trunkTop.sx + Math.cos(cAngle) * r * 0.3
            const cy2 = trunkTop.sy - r * 0.4 + Math.sin(cAngle) * r * 0.2
            const cr = r * (0.35 + (treeHash + ci) % 3 * 0.06)
            ctx.fillStyle = ci % 2 === 0 ? hexToCSS(canopyHue) : hexToCSS(lighten(canopyHue, 0.05))
            ctx.beginPath()
            ctx.arc(cx2, cy2, cr, 0, Math.PI * 2)
            ctx.fill()
          }
        } else {
          // Oak/default: multi-lobe canopy (original style)
          const lobes = 3 + (treeHash % 2)
          ctx.fillStyle = hexToCSS(darken(canopyHue, 0.12))
          ctx.beginPath()
          ctx.arc(trunkTop.sx + 1, trunkTop.sy - r * 0.15, r * 0.9, 0, Math.PI * 2)
          ctx.fill()
          for (let li = 0; li < lobes; li++) {
            const angle = (li / lobes) * Math.PI * 2 + treeHash * 0.3
            const lx = trunkTop.sx + Math.cos(angle) * r * 0.35
            const ly = trunkTop.sy - r * 0.3 + Math.sin(angle) * r * 0.25
            const lr = r * (0.55 + (treeHash + li) % 3 * 0.08)
            ctx.fillStyle = li % 2 === 0 ? hexToCSS(canopyHue) : hexToCSS(darken(canopyHue, 0.06))
            ctx.beginPath()
            ctx.arc(lx, ly, lr, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.fillStyle = hexToCSS(lighten(canopyHue, 0.08))
          ctx.beginPath()
          ctx.arc(trunkTop.sx - r * 0.2, trunkTop.sy - r * 0.5, r * 0.35, 0, Math.PI * 2)
          ctx.fill()
        }

        // Undergrowth at base (all species) — small tufts of grass/ferns
        if (r > 5) {
          for (let ui = 0; ui < 3; ui++) {
            const ux = base.sx + (treeHash + ui * 17) % 7 - 3
            const uy = base.sy - 0.5
            ctx.fillStyle = `rgba(45,90,39,${(0.2 + ui * 0.05).toFixed(2)})`
            ctx.beginPath()
            ctx.ellipse(ux, uy, 1.5, 0.8, 0, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
    })
  } else if (def.id === 'bush' || def.id === 'hedge') {
    const bushR = Math.max(3, Math.abs(top.sy - base.sy) * 0.5 + 3)
    const bushHash = simpleHash(obj.id)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.15)'
        ctx.beginPath()
        ctx.ellipse(base.sx + 1, base.sy, bushR, bushR * 0.4, 0, 0, Math.PI * 2)
        ctx.fill()
        if (def.id === 'hedge') {
          // Rectangular hedge with rounded top
          ctx.fillStyle = hexToCSS(foggedBody)
          const hw = bushR * 1.5, hh = bushR * 0.8
          ctx.beginPath()
          ctx.moveTo(base.sx - hw, base.sy)
          ctx.lineTo(base.sx - hw, base.sy - hh * 0.6)
          ctx.quadraticCurveTo(base.sx - hw, base.sy - hh, base.sx - hw * 0.5, base.sy - hh)
          ctx.lineTo(base.sx + hw * 0.5, base.sy - hh)
          ctx.quadraticCurveTo(base.sx + hw, base.sy - hh, base.sx + hw, base.sy - hh * 0.6)
          ctx.lineTo(base.sx + hw, base.sy)
          ctx.closePath(); ctx.fill()
          // Trim line
          ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.1))
          ctx.lineWidth = 0.3
          ctx.beginPath()
          ctx.moveTo(base.sx - hw, base.sy - hh * 0.5)
          ctx.lineTo(base.sx + hw, base.sy - hh * 0.5)
          ctx.stroke()
        } else {
          // Multi-blob organic bush
          const numBlobs = 2 + bushHash % 2
          for (let bi = 0; bi < numBlobs; bi++) {
            const bx = base.sx + (bi - numBlobs * 0.5 + 0.5) * bushR * 0.6
            const by = base.sy - bushR * 0.35
            const br = bushR * (0.5 + (bushHash + bi) % 3 * 0.1)
            ctx.fillStyle = bi % 2 === 0 ? hexToCSS(foggedBody) : hexToCSS(darken(foggedBody, 0.05))
            ctx.beginPath()
            ctx.arc(bx, by, br, 0, Math.PI * 2)
            ctx.fill()
          }
          // Highlight on top
          ctx.fillStyle = hexToCSS(lighten(foggedBody, 0.06))
          ctx.beginPath()
          ctx.arc(base.sx - bushR * 0.15, base.sy - bushR * 0.55, bushR * 0.3, 0, Math.PI * 2)
          ctx.fill()
          // Flower dots (occasional)
          if (bushHash % 4 === 0) {
            const flowerColors = [0xff6688, 0xffaa44, 0xdd88dd]
            for (let fi = 0; fi < 2; fi++) {
              ctx.fillStyle = hexToCSS(applyFog(flowerColors[(bushHash + fi) % 3], base.depth, lighting))
              ctx.beginPath()
              ctx.arc(base.sx + (fi * 2 - 1) * bushR * 0.3, base.sy - bushR * 0.4 - fi, 0.8, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
      }
    })
  } else if (def.id === 'lamppost' || def.id === 'double_lamp' || def.id === 'wall_lantern') {
    const lampTop = project(cx, ts * 1.1, cz)
    if (!lampTop) return
    const poleW = Math.max(1, 2)

    // Collect light source for light map
    if (lighting.isNight || lighting.isDusk) {
      lights.push({
        sx: base.sx, sy: lampTop.sy,
        radius: 25 + Math.abs(lampTop.sy - base.sy) * 0.8,
        color: 0xffcc66, intensity: lighting.isNight ? 0.7 : 0.4
      })
    }

    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - poleW / 2, lampTop.sy, poleW, base.sy - lampTop.sy)
        // Lamp glow — larger and brighter at night
        const isLit = lighting.isNight || lighting.isDusk
        const glowColor = applyFog(colors.accent || 0xffdd44, base.depth, lighting)
        ctx.fillStyle = hexToCSS(glowColor)
        const flickerMod = 1 + Math.sin(time * 3 + simpleHash(obj.id) * 0.1) * 0.15
        const r = (isLit ? Math.max(5, Math.abs(lampTop.sy - base.sy) * 0.25) : Math.max(2, Math.abs(lampTop.sy - base.sy) * 0.1)) * flickerMod
        ctx.beginPath()
        ctx.arc(base.sx, lampTop.sy, r, 0, Math.PI * 2)
        ctx.fill()
        // Ground glow pool at night
        if (isLit) {
          ctx.fillStyle = 'rgba(255,200,80,0.08)'
          ctx.beginPath()
          ctx.ellipse(base.sx, base.sy, r * 3, r * 1.5, 0, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    })
  } else if (def.id === 'fountain' || def.id === 'fountain_grand' || def.id === 'well' || def.id === 'well_grand') {
    const topH = project(cx, propH, cz)
    if (!topH) return
    const rBase = Math.max(4, def.footprint.w * 5)
    const accentColor = colors.accent ? applyFog(shadeFace(colors.accent, 0, 1, 0, lighting), base.depth, lighting) : foggedBody
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Stone base
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.beginPath()
        ctx.ellipse(base.sx, base.sy, rBase, rBase * 0.4, 0, 0, Math.PI * 2)
        ctx.fill()
        // Water/interior
        ctx.fillStyle = hexToCSS(accentColor)
        ctx.beginPath()
        ctx.ellipse(base.sx, base.sy - 1, rBase * 0.7, rBase * 0.28, 0, 0, Math.PI * 2)
        ctx.fill()
        // Pillar
        const pillarH = Math.abs(topH.sy - base.sy) * 0.5
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - 1, base.sy - pillarH, 2, pillarH)
        // Well: bucket and rope
        if (def.id === 'well' || def.id === 'well_grand') {
          // Roof crossbeam
          ctx.fillStyle = hexToCSS(darken(foggedBody, 0.15))
          ctx.fillRect(base.sx - rBase * 0.5, base.sy - pillarH, rBase, 1)
          // Rope
          ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.25))
          ctx.lineWidth = 0.4
          ctx.beginPath()
          ctx.moveTo(base.sx + rBase * 0.2, base.sy - pillarH)
          ctx.lineTo(base.sx + rBase * 0.2, base.sy - pillarH * 0.3)
          ctx.stroke()
          // Bucket
          ctx.fillStyle = hexToCSS(darken(foggedBody, 0.3))
          ctx.fillRect(base.sx + rBase * 0.2 - 1, base.sy - pillarH * 0.3, 2, 2)
          // Crank handle
          ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.2))
          ctx.lineWidth = 0.6
          ctx.beginPath()
          ctx.moveTo(base.sx + 1, base.sy - pillarH)
          ctx.lineTo(base.sx + 2.5, base.sy - pillarH - 1.5)
          ctx.stroke()
        }
        // Fountain spray particles
        if (def.id === 'fountain' || def.id === 'fountain_grand') {
          for (let si = 0; si < 4; si++) {
            const sprayX = base.sx + Math.sin(time * 2 + si * 1.5) * 2
            const sprayY = base.sy - pillarH - 2 - si * 1.5 - ((time * 3 + si) % 3)
            ctx.fillStyle = `rgba(180,210,240,${0.2 - si * 0.04})`
            ctx.beginPath(); ctx.arc(sprayX, sprayY, 0.8, 0, Math.PI * 2); ctx.fill()
          }
          // Water ripples
          for (let ri = 0; ri < 3; ri++) {
            const ripR = 2 + ((time * 1.5 + ri * 2) % 5)
            ctx.strokeStyle = `rgba(150,200,255,${0.15 - ripR * 0.02})`
            ctx.lineWidth = 0.3
            ctx.beginPath()
            ctx.ellipse(base.sx, base.sy - 1, ripR, ripR * 0.35, 0, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
      }
    })
  } else if (def.id === 'barrel' || def.id === 'crate') {
    const objH = Math.max(4, Math.abs(top.sy - base.sy) * 0.6 + 3)
    const objW = Math.max(4, def.footprint.w * 5)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        if (def.id === 'barrel') {
          // Rounded barrel shape
          ctx.fillStyle = hexToCSS(foggedBody)
          ctx.beginPath()
          ctx.ellipse(base.sx, base.sy - objH / 2, objW / 2, objH / 2, 0, 0, Math.PI * 2)
          ctx.fill()
          // Metal band
          ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.3))
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.ellipse(base.sx, base.sy - objH / 2, objW / 2 - 1, objH * 0.15, 0, 0, Math.PI * 2)
          ctx.stroke()
        } else {
          // Box crate
          ctx.fillStyle = hexToCSS(foggedBody)
          ctx.fillRect(base.sx - objW / 2, base.sy - objH, objW, objH)
          ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.25))
          ctx.lineWidth = 1
          ctx.strokeRect(base.sx - objW / 2, base.sy - objH, objW, objH)
        }
      }
    })
  } else if (def.id === 'fence' || def.id === 'stone_wall') {
    const fenceH = Math.max(3, Math.abs(top.sy - base.sy) * 0.3 + 2)
    const fenceW = Math.max(6, def.footprint.w * ts * 0.3)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - fenceW / 2, base.sy - fenceH, fenceW, fenceH)
        // Stone wall: mortar lines
        if (def.id === 'stone_wall') {
          ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.15))
          ctx.lineWidth = 0.5
          for (let i = 0; i < 3; i++) {
            const ly = base.sy - fenceH * (0.3 + i * 0.25)
            ctx.beginPath(); ctx.moveTo(base.sx - fenceW / 2, ly); ctx.lineTo(base.sx + fenceW / 2, ly); ctx.stroke()
          }
        } else {
          // Fence: vertical pickets
          ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.2))
          ctx.lineWidth = 0.8
          const pickets = Math.max(2, Math.floor(fenceW / 3))
          for (let i = 0; i <= pickets; i++) {
            const px = base.sx - fenceW / 2 + (fenceW * i / pickets)
            ctx.beginPath(); ctx.moveTo(px, base.sy); ctx.lineTo(px, base.sy - fenceH); ctx.stroke()
          }
        }
        // Cat sitting on wall (~20% chance)
        if (simpleHash(obj.id) % 5 === 0) {
          const catX = base.sx + (simpleHash(obj.id) % 3 - 1) * 2
          const catY = base.sy - fenceH - 1
          ctx.fillStyle = simpleHash(obj.id) % 2 === 0 ? 'rgba(40,30,20,0.7)' : 'rgba(180,120,40,0.7)'
          ctx.fillRect(catX - 1, catY - 1, 2, 1.5) // body
          ctx.fillRect(catX - 1.5, catY - 2, 1, 1) // head
          ctx.fillRect(catX + 1, catY - 1.5, 1.5, 0.5) // tail
        }
      }
    })
  } else if (def.id === 'statue' || def.id === 'column') {
    const sH = Math.max(6, Math.abs(top.sy - base.sy) * 0.8 + 4)
    const sW = Math.max(3, sH * 0.25)
    const accentColor = colors.accent ? applyFog(shadeFace(colors.accent, 0, 1, 0, lighting), base.depth, lighting) : foggedBody
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Pedestal
        ctx.fillStyle = hexToCSS(darken(foggedBody, 0.1))
        ctx.fillRect(base.sx - sW * 0.8, base.sy - sH * 0.15, sW * 1.6, sH * 0.15)
        // Body/shaft
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - sW / 2, base.sy - sH, sW, sH * 0.85)
        if (def.id === 'statue') {
          // Head
          ctx.beginPath()
          ctx.arc(base.sx, base.sy - sH - 1, sW * 0.6, 0, Math.PI * 2)
          ctx.fill()
        } else {
          // Column capital
          ctx.fillStyle = hexToCSS(accentColor)
          ctx.fillRect(base.sx - sW * 0.7, base.sy - sH - 1, sW * 1.4, 2)
        }
      }
    })
  } else if (def.id === 'monument') {
    const mH = Math.max(8, Math.abs(top.sy - base.sy) * 1.2)
    const mW = Math.max(6, def.footprint.w * 5)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Wide pedestal
        ctx.fillStyle = hexToCSS(darken(foggedBody, 0.1))
        ctx.fillRect(base.sx - mW / 2, base.sy - mH * 0.2, mW, mH * 0.2)
        // Obelisk/column
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.beginPath()
        ctx.moveTo(base.sx - mW * 0.2, base.sy - mH * 0.2)
        ctx.lineTo(base.sx + mW * 0.2, base.sy - mH * 0.2)
        ctx.lineTo(base.sx + mW * 0.1, base.sy - mH)
        ctx.lineTo(base.sx - mW * 0.1, base.sy - mH)
        ctx.closePath(); ctx.fill()
        // Tip
        ctx.fillStyle = hexToCSS(darken(foggedBody, 0.2))
        ctx.beginPath()
        ctx.moveTo(base.sx, base.sy - mH - 2)
        ctx.lineTo(base.sx - mW * 0.1, base.sy - mH)
        ctx.lineTo(base.sx + mW * 0.1, base.sy - mH)
        ctx.closePath(); ctx.fill()
      }
    })
  } else if (def.id === 'hanging_sign') {
    const signH = Math.max(6, Math.abs(top.sy - base.sy) * 0.5)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Bracket
        ctx.strokeStyle = hexToCSS(foggedBody)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(base.sx, base.sy - signH * 1.2)
        ctx.lineTo(base.sx + 4, base.sy - signH * 1.2)
        ctx.stroke()
        // Sign board
        const accentFogged = colors.accent ? applyFog(colors.accent, base.depth, lighting) : foggedBody
        ctx.fillStyle = hexToCSS(accentFogged)
        ctx.fillRect(base.sx + 1, base.sy - signH * 1.1, 6, signH * 0.5)
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.3))
        ctx.lineWidth = 0.5
        ctx.strokeRect(base.sx + 1, base.sy - signH * 1.1, 6, signH * 0.5)
        // Sign icon (varied per hash)
        const signType = simpleHash(obj.id) % 4
        const iconX = base.sx + 4, iconY = base.sy - signH * 0.9
        ctx.fillStyle = hexToCSS(darken(accentFogged, 0.4))
        if (signType === 0) {
          // Tankard (tavern)
          ctx.fillRect(iconX - 1, iconY - 1, 2, 2.5)
          ctx.fillRect(iconX + 1, iconY, 0.8, 1.5)
        } else if (signType === 1) {
          // Key (inn)
          ctx.beginPath(); ctx.arc(iconX, iconY - 0.5, 1, 0, Math.PI * 2); ctx.fill()
          ctx.fillRect(iconX - 0.3, iconY + 0.5, 0.6, 2)
        } else if (signType === 2) {
          // Star shape
          ctx.beginPath()
          for (let si = 0; si < 5; si++) {
            const a = (si / 5) * Math.PI * 2 - Math.PI / 2
            const r2 = si % 2 === 0 ? 1.5 : 0.7
            const method = si === 0 ? 'moveTo' : 'lineTo'
            ctx[method](iconX + Math.cos(a) * r2, iconY + Math.sin(a) * r2)
          }
          ctx.closePath(); ctx.fill()
        } else {
          // Crossed tools (smithy)
          ctx.lineWidth = 0.6
          ctx.strokeStyle = hexToCSS(darken(accentFogged, 0.4))
          ctx.beginPath(); ctx.moveTo(iconX - 1.5, iconY - 1.5); ctx.lineTo(iconX + 1.5, iconY + 1.5); ctx.stroke()
          ctx.beginPath(); ctx.moveTo(iconX + 1.5, iconY - 1.5); ctx.lineTo(iconX - 1.5, iconY + 1.5); ctx.stroke()
        }
      }
    })
  } else if (def.id === 'cafe_table') {
    const tH = Math.max(4, Math.abs(top.sy - base.sy) * 0.3 + 2)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Table leg
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - 0.5, base.sy - tH, 1, tH)
        // Table top (elliptical)
        const accentFogged = colors.accent ? applyFog(colors.accent, base.depth, lighting) : foggedBody
        ctx.fillStyle = hexToCSS(accentFogged)
        ctx.beginPath()
        ctx.ellipse(base.sx, base.sy - tH, 4, 2, 0, 0, Math.PI * 2)
        ctx.fill()
      }
    })
  } else if (def.id === 'potted_plant' || def.id === 'flower_box') {
    const pH = Math.max(4, Math.abs(top.sy - base.sy) * 0.4 + 3)
    const accentFogged = colors.accent ? applyFog(colors.accent, base.depth, lighting) : foggedBody
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Pot
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - 2, base.sy - pH * 0.4, 4, pH * 0.4)
        // Foliage
        ctx.fillStyle = hexToCSS(accentFogged)
        ctx.beginPath()
        ctx.arc(base.sx, base.sy - pH * 0.6, 3, 0, Math.PI * 2)
        ctx.fill()
        // Flowers on flower_box
        if (def.id === 'flower_box') {
          ctx.fillStyle = hexToCSS(applyFog(0xff6688, base.depth, lighting))
          ctx.beginPath(); ctx.arc(base.sx - 1, base.sy - pH * 0.7, 1.2, 0, Math.PI * 2); ctx.fill()
          ctx.fillStyle = hexToCSS(applyFog(0xffaa44, base.depth, lighting))
          ctx.beginPath(); ctx.arc(base.sx + 1.5, base.sy - pH * 0.65, 1, 0, Math.PI * 2); ctx.fill()
        }
      }
    })
  } else if (def.id === 'wagon' || def.id === 'cart') {
    const wH = Math.max(5, Math.abs(top.sy - base.sy) * 0.4 + 3)
    const wW = Math.max(8, def.footprint.w * 5)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Wheels
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.3))
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.arc(base.sx - wW * 0.3, base.sy - 2, 2.5, 0, Math.PI * 2); ctx.stroke()
        ctx.beginPath(); ctx.arc(base.sx + wW * 0.3, base.sy - 2, 2.5, 0, Math.PI * 2); ctx.stroke()
        // Bed
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - wW / 2, base.sy - wH, wW, wH * 0.6)
        // Sides
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.2))
        ctx.lineWidth = 0.5
        ctx.strokeRect(base.sx - wW / 2, base.sy - wH, wW, wH * 0.6)
        // Handle/tongue
        ctx.fillStyle = hexToCSS(darken(foggedBody, 0.15))
        ctx.fillRect(base.sx + wW / 2, base.sy - wH * 0.7, wW * 0.2, 1.5)
        // Cargo on wagon (varied)
        const cargoType = simpleHash(obj.id) % 3
        if (cargoType === 0) {
          // Hay/grain sacks
          ctx.fillStyle = hexToCSS(applyFog(0xc8a850, base.depth, lighting))
          ctx.beginPath()
          ctx.ellipse(base.sx, base.sy - wH * 0.85, wW * 0.3, wH * 0.2, 0, 0, Math.PI * 2)
          ctx.fill()
        } else if (cargoType === 1) {
          // Barrels
          ctx.fillStyle = hexToCSS(applyFog(0x8a6a3a, base.depth, lighting))
          ctx.beginPath(); ctx.ellipse(base.sx - wW * 0.15, base.sy - wH * 0.8, 2, 2.5, 0, 0, Math.PI * 2); ctx.fill()
          ctx.beginPath(); ctx.ellipse(base.sx + wW * 0.15, base.sy - wH * 0.8, 2, 2.5, 0, 0, Math.PI * 2); ctx.fill()
        } else {
          // Crates stacked
          ctx.fillStyle = hexToCSS(applyFog(0x7a6a4a, base.depth, lighting))
          ctx.fillRect(base.sx - wW * 0.25, base.sy - wH * 1.0, wW * 0.5, wH * 0.35)
          ctx.strokeStyle = hexToCSS(darken(applyFog(0x7a6a4a, base.depth, lighting), 0.2))
          ctx.lineWidth = 0.3
          ctx.strokeRect(base.sx - wW * 0.25, base.sy - wH * 1.0, wW * 0.5, wH * 0.35)
        }
      }
    })
  } else if (def.id === 'barrel_stack' || def.id === 'crate_stack') {
    const sH = Math.max(6, Math.abs(top.sy - base.sy) * 0.7 + 4)
    const sW = Math.max(5, 6)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        if (def.id === 'barrel_stack') {
          // Two barrels stacked
          ctx.fillStyle = hexToCSS(foggedBody)
          ctx.beginPath(); ctx.ellipse(base.sx - 1, base.sy - sH * 0.25, sW / 2.2, sH * 0.25, 0, 0, Math.PI * 2); ctx.fill()
          ctx.beginPath(); ctx.ellipse(base.sx + 1, base.sy - sH * 0.6, sW / 2.5, sH * 0.2, 0, 0, Math.PI * 2); ctx.fill()
          // Bands
          ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.3))
          ctx.lineWidth = 0.5
          ctx.beginPath(); ctx.ellipse(base.sx - 1, base.sy - sH * 0.25, sW / 2.5, sH * 0.08, 0, 0, Math.PI * 2); ctx.stroke()
        } else {
          // Stacked crates
          ctx.fillStyle = hexToCSS(foggedBody)
          ctx.fillRect(base.sx - sW / 2, base.sy - sH * 0.45, sW, sH * 0.45)
          const accentFogged = colors.accent ? applyFog(colors.accent, base.depth, lighting) : darken(foggedBody, 0.1)
          ctx.fillStyle = hexToCSS(accentFogged)
          ctx.fillRect(base.sx - sW / 2 + 1, base.sy - sH * 0.8, sW - 2, sH * 0.35)
          ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.25))
          ctx.lineWidth = 0.5
          ctx.strokeRect(base.sx - sW / 2, base.sy - sH * 0.45, sW, sH * 0.45)
          ctx.strokeRect(base.sx - sW / 2 + 1, base.sy - sH * 0.8, sW - 2, sH * 0.35)
        }
      }
    })
  } else if (def.id === 'market_stall') {
    const msH = Math.max(6, Math.abs(top.sy - base.sy) * 0.6 + 4)
    const msW = Math.max(8, def.footprint.w * 5)
    const accentFogged = colors.accent ? applyFog(colors.accent, base.depth, lighting) : foggedBody
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Counter
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - msW / 2, base.sy - msH * 0.35, msW, msH * 0.35)
        // Canopy (angled fabric)
        const canopyColor = applyFog([0xaa3333, 0x336633, 0x334466, 0xaa6633][simpleHash(obj.id) % 4], base.depth, lighting)
        ctx.fillStyle = hexToCSS(canopyColor)
        ctx.beginPath()
        ctx.moveTo(base.sx - msW / 2 - 1, base.sy - msH * 0.5)
        ctx.lineTo(base.sx + msW / 2 + 1, base.sy - msH * 0.5)
        ctx.lineTo(base.sx + msW / 2 + 2, base.sy - msH * 0.85)
        ctx.lineTo(base.sx - msW / 2, base.sy - msH * 0.9)
        ctx.closePath(); ctx.fill()
        // Poles
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.3))
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(base.sx - msW / 2, base.sy); ctx.lineTo(base.sx - msW / 2, base.sy - msH * 0.9); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(base.sx + msW / 2, base.sy); ctx.lineTo(base.sx + msW / 2, base.sy - msH * 0.85); ctx.stroke()
        // Goods on counter — varied per stall
        const stallType = simpleHash(obj.id) % 4
        if (stallType === 0) {
          // Fruit/vegetable stall
          const fruitColors = [0xcc3333, 0xffaa22, 0x44aa33]
          for (let i = 0; i < 4; i++) {
            ctx.fillStyle = hexToCSS(applyFog(fruitColors[i % 3], base.depth, lighting))
            ctx.beginPath()
            ctx.arc(base.sx - msW * 0.3 + i * msW * 0.18, base.sy - msH * 0.42, 1.3, 0, Math.PI * 2)
            ctx.fill()
          }
        } else if (stallType === 1) {
          // Bread/bakery stall
          ctx.fillStyle = hexToCSS(applyFog(0xc8a050, base.depth, lighting))
          for (let i = 0; i < 3; i++) {
            ctx.beginPath()
            ctx.ellipse(base.sx - msW * 0.25 + i * msW * 0.22, base.sy - msH * 0.41, 1.8, 1, 0, 0, Math.PI * 2)
            ctx.fill()
          }
        } else if (stallType === 2) {
          // Cloth/fabric stall — colored rolls
          const clothColors = [0x3355aa, 0xaa3344, 0x44aa66]
          for (let i = 0; i < 3; i++) {
            ctx.fillStyle = hexToCSS(applyFog(clothColors[i], base.depth, lighting))
            ctx.fillRect(base.sx - msW * 0.3 + i * msW * 0.2, base.sy - msH * 0.48, msW * 0.12, msH * 0.13)
          }
        } else {
          // Pottery/crafts
          ctx.fillStyle = hexToCSS(applyFog(0xa07050, base.depth, lighting))
          for (let i = 0; i < 3; i++) {
            const px = base.sx - msW * 0.25 + i * msW * 0.2
            ctx.beginPath()
            ctx.moveTo(px - 1, base.sy - msH * 0.38)
            ctx.quadraticCurveTo(px, base.sy - msH * 0.5, px + 1, base.sy - msH * 0.38)
            ctx.closePath(); ctx.fill()
          }
        }
      }
    })
  } else if (def.id === 'garden_arch') {
    const aH = Math.max(6, Math.abs(top.sy - base.sy) * 0.7)
    const accentFogged = colors.accent ? applyFog(colors.accent, base.depth, lighting) : foggedBody
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Wooden arch
        ctx.strokeStyle = hexToCSS(foggedBody)
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(base.sx, base.sy - aH * 0.5, aH * 0.4, Math.PI, 0); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(base.sx - aH * 0.4, base.sy); ctx.lineTo(base.sx - aH * 0.4, base.sy - aH * 0.5); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(base.sx + aH * 0.4, base.sy); ctx.lineTo(base.sx + aH * 0.4, base.sy - aH * 0.5); ctx.stroke()
        // Vine foliage
        ctx.fillStyle = hexToCSS(accentFogged)
        ctx.beginPath(); ctx.arc(base.sx - aH * 0.3, base.sy - aH * 0.7, 2, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.arc(base.sx + aH * 0.2, base.sy - aH * 0.8, 1.5, 0, Math.PI * 2); ctx.fill()
        ctx.beginPath(); ctx.arc(base.sx, base.sy - aH * 0.9, 2, 0, Math.PI * 2); ctx.fill()
      }
    })
  } else if (def.id === 'woodpile' || def.id === 'hay_bale') {
    const pH = Math.max(4, Math.abs(top.sy - base.sy) * 0.4 + 3)
    const pW = Math.max(5, 6)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        ctx.fillStyle = hexToCSS(foggedBody)
        if (def.id === 'hay_bale') {
          ctx.beginPath()
          ctx.ellipse(base.sx, base.sy - pH / 2, pW / 2, pH / 2, 0, 0, Math.PI * 2)
          ctx.fill()
          // Twine band
          ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.2))
          ctx.lineWidth = 0.5
          ctx.beginPath(); ctx.moveTo(base.sx - 1, base.sy - pH); ctx.lineTo(base.sx - 1, base.sy); ctx.stroke()
          ctx.beginPath(); ctx.moveTo(base.sx + 1, base.sy - pH); ctx.lineTo(base.sx + 1, base.sy); ctx.stroke()
        } else {
          // Log stack
          ctx.fillRect(base.sx - pW / 2, base.sy - pH, pW, pH)
          // Log end circles
          const accentFogged2 = colors.accent ? applyFog(colors.accent, base.depth, lighting) : darken(foggedBody, 0.15)
          ctx.fillStyle = hexToCSS(accentFogged2)
          for (let r = 0; r < 2; r++) {
            for (let c = 0; c < 3; c++) {
              ctx.beginPath()
              ctx.arc(base.sx - pW * 0.3 + c * pW * 0.3, base.sy - pH * 0.3 - r * pH * 0.35, 1.2, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
      }
    })
  } else if (def.id === 'cloth_line') {
    const clW = Math.max(8, def.footprint.w * 6)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        const lineY = base.sy - Math.abs(top.sy - base.sy) * 0.6
        // Poles
        ctx.strokeStyle = hexToCSS(foggedBody)
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(base.sx - clW / 2, base.sy); ctx.lineTo(base.sx - clW / 2, lineY); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(base.sx + clW / 2, base.sy); ctx.lineTo(base.sx + clW / 2, lineY); ctx.stroke()
        // Line (slight sag)
        ctx.beginPath()
        ctx.moveTo(base.sx - clW / 2, lineY)
        ctx.quadraticCurveTo(base.sx, lineY + 2, base.sx + clW / 2, lineY)
        ctx.stroke()
        // Hanging clothes
        const clothColors = [0xd0c8b0, 0xc0a880, 0xa0b0c0]
        for (let i = 0; i < 3; i++) {
          const cx = base.sx - clW * 0.3 + i * clW * 0.25
          ctx.fillStyle = hexToCSS(applyFog(clothColors[i % 3], base.depth, lighting))
          const flutter = Math.sin(time * 2 + i * 1.3) * 0.8
          ctx.fillRect(cx - 1.5 + flutter, lineY + 1, 3, 3 + i * 0.5 + Math.abs(flutter) * 0.3)
        }
      }
    })
  } else if (def.id === 'bench') {
    const bW = Math.max(6, def.footprint.w * 5)
    const bH = Math.max(3, Math.abs(top.sy - base.sy) * 0.2 + 2)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Legs
        ctx.fillStyle = hexToCSS(darken(foggedBody, 0.2))
        ctx.fillRect(base.sx - bW / 2 + 1, base.sy - bH + 1, 1, bH - 1)
        ctx.fillRect(base.sx + bW / 2 - 2, base.sy - bH + 1, 1, bH - 1)
        // Seat
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - bW / 2, base.sy - bH, bW, 2)
        // Back
        ctx.fillRect(base.sx - bW / 2, base.sy - bH - 2, bW, 1)
      }
    })
  } else if (def.id === 'planter_box') {
    const pbW = Math.max(6, def.footprint.w * 5)
    const pbH = Math.max(4, Math.abs(top.sy - base.sy) * 0.3 + 2)
    const accentFogged = colors.accent ? applyFog(colors.accent, base.depth, lighting) : foggedBody
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Box
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - pbW / 2, base.sy - pbH, pbW, pbH)
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.2))
        ctx.lineWidth = 0.5
        ctx.strokeRect(base.sx - pbW / 2, base.sy - pbH, pbW, pbH)
        // Plants growing out
        ctx.fillStyle = hexToCSS(accentFogged)
        for (let i = 0; i < 4; i++) {
          const px = base.sx - pbW * 0.3 + i * pbW * 0.2
          ctx.beginPath(); ctx.arc(px, base.sy - pbH - 1.5, 1.5, 0, Math.PI * 2); ctx.fill()
        }
      }
    })
  } else if (def.id === 'horse_post') {
    const hpH = Math.max(5, Math.abs(top.sy - base.sy) * 0.5)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Post
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - 0.5, base.sy - hpH, 1.5, hpH)
        // Cross bar
        ctx.fillRect(base.sx - 2, base.sy - hpH, 4, 1)
        // Horse silhouette next to post
        const hx = base.sx + 4, hy = base.sy
        ctx.fillStyle = 'rgba(100,70,40,0.65)'
        // Body
        ctx.fillRect(hx - 3, hy - 5, 6, 3)
        // Head + neck
        ctx.fillRect(hx + 2, hy - 7, 2, 3)
        ctx.fillRect(hx + 3, hy - 8, 2, 1.5)
        // Legs
        ctx.fillRect(hx - 2, hy - 2, 1, 2)
        ctx.fillRect(hx + 2, hy - 2, 1, 2)
      }
    })
  } else if (def.id === 'rain_barrel') {
    const rbH = Math.max(5, Math.abs(top.sy - base.sy) * 0.5 + 3)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.beginPath(); ctx.ellipse(base.sx, base.sy - rbH / 2, 3, rbH / 2, 0, 0, Math.PI * 2); ctx.fill()
        // Water surface
        const accentFogged2 = colors.accent ? applyFog(colors.accent, base.depth, lighting) : foggedBody
        ctx.fillStyle = hexToCSS(accentFogged2)
        ctx.beginPath(); ctx.ellipse(base.sx, base.sy - rbH * 0.7, 2.2, 1, 0, 0, Math.PI * 2); ctx.fill()
        // Bands
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.3))
        ctx.lineWidth = 0.5
        ctx.beginPath(); ctx.ellipse(base.sx, base.sy - rbH * 0.3, 3.2, 0.8, 0, 0, Math.PI * 2); ctx.stroke()
      }
    })
  } else if (def.id === 'dock' || def.id === 'pier') {
    const dW = Math.max(10, def.footprint.w * 6)
    const dH = Math.max(3, Math.abs(top.sy - base.sy) * 0.2 + 2)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Wooden planks
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - dW / 2, base.sy - dH, dW, dH)
        // Plank lines
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.2))
        ctx.lineWidth = 0.3
        for (let pi = 0; pi < 4; pi++) {
          const px = base.sx - dW / 2 + dW * (pi + 0.5) / 4
          ctx.beginPath(); ctx.moveTo(px, base.sy - dH); ctx.lineTo(px, base.sy); ctx.stroke()
        }
        // Support posts
        const postColor = hexToCSS(darken(foggedBody, 0.25))
        ctx.fillStyle = postColor
        ctx.fillRect(base.sx - dW / 2 + 1, base.sy, 1.5, 3)
        ctx.fillRect(base.sx + dW / 2 - 2.5, base.sy, 1.5, 3)
      }
    })
  } else if (def.id === 'crane') {
    const crH = Math.max(10, Math.abs(top.sy - base.sy) * 1.2)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Vertical mast
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - 1, base.sy - crH, 2, crH)
        // Angled arm
        ctx.strokeStyle = hexToCSS(foggedBody)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.moveTo(base.sx, base.sy - crH)
        ctx.lineTo(base.sx + crH * 0.6, base.sy - crH * 0.7)
        ctx.stroke()
        // Hanging rope
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.2))
        ctx.lineWidth = 0.5
        ctx.beginPath()
        ctx.moveTo(base.sx + crH * 0.5, base.sy - crH * 0.72)
        ctx.lineTo(base.sx + crH * 0.5, base.sy - crH * 0.3)
        ctx.stroke()
        // Base
        ctx.fillStyle = hexToCSS(darken(foggedBody, 0.15))
        ctx.fillRect(base.sx - 3, base.sy - 1, 6, 2)
      }
    })
  } else if (def.id === 'fishing_boat') {
    const bW = Math.max(8, def.footprint.w * 5)
    const bH = Math.max(4, Math.abs(top.sy - base.sy) * 0.3 + 3)
    const accentFogged = colors.accent ? applyFog(colors.accent, base.depth, lighting) : foggedBody
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Hull arc
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.beginPath()
        ctx.arc(base.sx, base.sy - bH * 0.3, bW / 2, Math.PI, 0)
        ctx.closePath(); ctx.fill()
        // Mast
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.3))
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(base.sx, base.sy - bH * 0.3); ctx.lineTo(base.sx, base.sy - bH * 2); ctx.stroke()
        // Small sail triangle
        ctx.fillStyle = hexToCSS(accentFogged)
        ctx.beginPath()
        ctx.moveTo(base.sx, base.sy - bH * 1.8)
        ctx.lineTo(base.sx + bW * 0.25, base.sy - bH * 0.8)
        ctx.lineTo(base.sx, base.sy - bH * 0.6)
        ctx.closePath(); ctx.fill()
      }
    })
  } else if (def.id === 'gravestone') {
    const gsH = Math.max(4, Math.abs(top.sy - base.sy) * 0.4 + 3)
    const gsW = Math.max(3, 3.5)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Stone body
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - gsW / 2, base.sy - gsH, gsW, gsH)
        // Rounded top
        ctx.beginPath()
        ctx.arc(base.sx, base.sy - gsH, gsW / 2, Math.PI, 0)
        ctx.fill()
        // Cross or inscription line
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.15))
        ctx.lineWidth = 0.3
        ctx.beginPath(); ctx.moveTo(base.sx, base.sy - gsH * 0.8); ctx.lineTo(base.sx, base.sy - gsH * 0.4); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(base.sx - gsW * 0.2, base.sy - gsH * 0.65); ctx.lineTo(base.sx + gsW * 0.2, base.sy - gsH * 0.65); ctx.stroke()
      }
    })
  } else if (def.id === 'iron_fence') {
    const ifH = Math.max(5, Math.abs(top.sy - base.sy) * 0.4 + 3)
    const ifW = Math.max(8, def.footprint.w * 5)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Horizontal rail
        ctx.strokeStyle = hexToCSS(foggedBody)
        ctx.lineWidth = 0.8
        ctx.beginPath(); ctx.moveTo(base.sx - ifW / 2, base.sy - ifH * 0.7); ctx.lineTo(base.sx + ifW / 2, base.sy - ifH * 0.7); ctx.stroke()
        // Vertical bars with pointed tops
        const bars = Math.max(3, Math.floor(ifW / 2.5))
        for (let bi = 0; bi <= bars; bi++) {
          const bx = base.sx - ifW / 2 + (ifW * bi / bars)
          ctx.beginPath(); ctx.moveTo(bx, base.sy); ctx.lineTo(bx, base.sy - ifH); ctx.stroke()
          // Pointed finial
          ctx.fillStyle = hexToCSS(foggedBody)
          ctx.beginPath()
          ctx.moveTo(bx - 0.8, base.sy - ifH)
          ctx.lineTo(bx, base.sy - ifH - 1.5)
          ctx.lineTo(bx + 0.8, base.sy - ifH)
          ctx.closePath(); ctx.fill()
        }
      }
    })
  } else if (def.id === 'farm_field') {
    const ffW = Math.max(12, def.footprint.w * 5)
    const ffH = Math.max(8, def.footprint.h * 4)
    const accentFogged = colors.accent ? applyFog(colors.accent, base.depth, lighting) : foggedBody
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Alternating crop rows
        const rows = 6
        for (let ri = 0; ri < rows; ri++) {
          const ry = base.sy - ffH + (ffH * ri / rows)
          ctx.fillStyle = ri % 2 === 0 ? hexToCSS(foggedBody) : hexToCSS(accentFogged)
          ctx.fillRect(base.sx - ffW / 2, ry, ffW, ffH / rows - 0.5)
        }
        // Border
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.2))
        ctx.lineWidth = 0.3
        ctx.strokeRect(base.sx - ffW / 2, base.sy - ffH, ffW, ffH)
      }
    })
  } else if (def.id === 'orchard_tree') {
    // Smaller tree with fruit dots
    const trunkTop = project(cx, ts * 0.35, cz)
    const canopyTop = project(cx, ts * 0.9, cz)
    if (trunkTop && canopyTop) {
      drawables.push({
        depth: base.depth,
        draw: (ctx) => {
          // Trunk
          ctx.fillStyle = hexToCSS(foggedBody)
          ctx.fillRect(base.sx - 1, trunkTop.sy, 2, base.sy - trunkTop.sy)
          // Smaller canopy
          const accentFogged2 = colors.accent ? applyFog(colors.accent, base.depth, lighting) : foggedBody
          const r = Math.max(3, Math.abs(canopyTop.sy - trunkTop.sy) * 0.5)
          ctx.fillStyle = hexToCSS(accentFogged2)
          ctx.beginPath(); ctx.arc(trunkTop.sx, trunkTop.sy - r * 0.2, r, 0, Math.PI * 2); ctx.fill()
          // Fruit dots (red/orange)
          const fruitColor = applyFog(0xcc3333, base.depth, lighting)
          ctx.fillStyle = hexToCSS(fruitColor)
          for (let fi = 0; fi < 3; fi++) {
            const fa = (fi / 3) * Math.PI * 2 + simpleHash(obj.id) * 0.5
            ctx.beginPath()
            ctx.arc(trunkTop.sx + Math.cos(fa) * r * 0.5, trunkTop.sy - r * 0.2 + Math.sin(fa) * r * 0.4, 0.7, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      })
    } else {
      // fallback
      drawables.push({ depth: base.depth, draw: (ctx) => {
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.beginPath(); ctx.arc(base.sx, base.sy - 4, 3, 0, Math.PI * 2); ctx.fill()
      }})
    }
  } else if (def.id === 'road_marker') {
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - 1, base.sy - 4, 2, 4)
        ctx.fillRect(base.sx - 1.5, base.sy - 4.5, 3, 1)
      }
    })
  } else {
    // Generic prop: colored shape with border
    const hw = Math.max(4, def.footprint.w * 5)
    const hh = Math.max(4, Math.abs(top.sy - base.sy) * 0.4 + 4)

    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.1)'
        ctx.beginPath()
        ctx.ellipse(base.sx + 1, base.sy, hw / 2, hw / 4, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - hw / 2, base.sy - hh, hw, hh)
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.2))
        ctx.lineWidth = 0.5
        ctx.strokeRect(base.sx - hw / 2, base.sy - hh, hw, hh)
      }
    })
  }
}

// ══════════════════════════════════════════════════════════════════
// ══ PROCEDURAL SURFACE TEXTURES ═════════════════════════════════
// ══════════════════════════════════════════════════════════════════

type WallMaterial = 'stone' | 'wood' | 'plaster' | 'brick' | 'plain'

const BUILDING_MATERIAL: Record<string, WallMaterial> = {
  chapel: 'stone', cathedral: 'stone', guild_hall: 'stone',
  tower: 'stone', watchtower: 'stone', town_gate: 'stone',
  round_tower: 'stone', gatehouse: 'stone', aqueduct: 'stone',
  building_large: 'stone', mansion: 'stone', bell_tower: 'stone',
  bell_tower_tall: 'stone',
  tavern: 'wood', half_timber: 'wood', stable: 'wood', mill: 'wood',
  windmill: 'plaster',
  building_small: 'plaster', building_medium: 'plaster',
  inn: 'plaster', apothecary: 'plaster', narrow_house: 'plaster',
  row_house: 'brick', warehouse: 'brick', bakery: 'brick',
  corner_building: 'brick', covered_market: 'brick',
}

/** Stone block pattern — irregular grid of mortar lines with slight offset. */
function drawStoneTexture(
  ctx: CanvasRenderingContext2D,
  fp: Projected[], faceW: number, faceH: number,
  baseColor: number, hash: number
): void {
  if (faceW < 6 || faceH < 6) return
  const mortarColor = `rgba(0,0,0,0.15)`
  ctx.strokeStyle = mortarColor
  ctx.lineWidth = 0.7
  // Horizontal mortar lines
  const rows = Math.max(2, Math.floor(faceH / 4))
  for (let r = 1; r < rows; r++) {
    const u = r / rows
    const ly = fp[0].sy + (fp[3].sy - fp[0].sy) * u
    ctx.beginPath()
    ctx.moveTo(fp[0].sx, ly)
    ctx.lineTo(fp[1].sx, ly)
    ctx.stroke()
  }
  // Vertical mortar lines (staggered per row — running bond)
  const cols = Math.max(2, Math.floor(faceW / 5))
  for (let r = 0; r < rows; r++) {
    const u1 = r / rows, u2 = (r + 1) / rows
    const y1 = fp[0].sy + (fp[3].sy - fp[0].sy) * u1
    const y2 = fp[0].sy + (fp[3].sy - fp[0].sy) * u2
    const offset = (r % 2 === 0) ? 0 : 0.5 / cols
    for (let c = 1; c < cols; c++) {
      const t = c / cols + offset
      if (t >= 1) continue
      const vx = fp[0].sx + (fp[1].sx - fp[0].sx) * t
      ctx.beginPath()
      ctx.moveTo(vx, y1)
      ctx.lineTo(vx, y2)
      ctx.stroke()
    }
  }
}

/** Wood plank pattern — horizontal lines with knot dots. */
function drawWoodTexture(
  ctx: CanvasRenderingContext2D,
  fp: Projected[], faceW: number, faceH: number,
  baseColor: number, hash: number
): void {
  if (faceW < 5 || faceH < 5) return
  ctx.strokeStyle = `rgba(0,0,0,0.12)`
  ctx.lineWidth = 0.5
  // Horizontal plank lines
  const planks = Math.max(3, Math.floor(faceH / 3))
  for (let p = 1; p < planks; p++) {
    const u = p / planks
    const ly = fp[0].sy + (fp[3].sy - fp[0].sy) * u
    ctx.beginPath()
    ctx.moveTo(fp[0].sx, ly)
    ctx.lineTo(fp[1].sx, ly)
    ctx.stroke()
  }
  // Knot dots (sparse)
  ctx.fillStyle = `rgba(0,0,0,0.14)`
  for (let k = 0; k < 2; k++) {
    const kx = fp[0].sx + faceW * (0.2 + ((hash + k * 7) % 10) / 15)
    const ky = fp[0].sy + (fp[3].sy - fp[0].sy) * (0.3 + ((hash + k * 3) % 5) / 10)
    ctx.beginPath()
    ctx.arc(kx, ky, 0.8, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Plaster/stucco texture — subtle noise dots. */
function drawPlasterTexture(
  ctx: CanvasRenderingContext2D,
  fp: Projected[], faceW: number, faceH: number,
  baseColor: number, hash: number
): void {
  if (faceW < 6 || faceH < 6) return
  // Scattered subtle dots
  const dots = Math.min(8, Math.floor(faceW * faceH / 20))
  for (let d = 0; d < dots; d++) {
    const dx = fp[0].sx + faceW * ((hash * 3 + d * 17) % 100) / 100
    const dy = fp[0].sy + (fp[3].sy - fp[0].sy) * ((hash * 7 + d * 13) % 100) / 100
    ctx.fillStyle = d % 2 === 0 ? `rgba(255,255,255,0.10)` : `rgba(0,0,0,0.08)`
    ctx.fillRect(dx, dy, 1.5, 1.5)
  }
}

/** Brick running bond pattern. */
function drawBrickTexture(
  ctx: CanvasRenderingContext2D,
  fp: Projected[], faceW: number, faceH: number,
  baseColor: number, hash: number
): void {
  if (faceW < 5 || faceH < 5) return
  ctx.strokeStyle = `rgba(0,0,0,0.15)`
  ctx.lineWidth = 0.6
  // Horizontal mortar
  const courses = Math.max(3, Math.floor(faceH / 2.5))
  for (let r = 1; r < courses; r++) {
    const u = r / courses
    const ly = fp[0].sy + (fp[3].sy - fp[0].sy) * u
    ctx.beginPath()
    ctx.moveTo(fp[0].sx, ly)
    ctx.lineTo(fp[1].sx, ly)
    ctx.stroke()
  }
  // Vertical mortar — running bond (stagger by half each row)
  const bricksPerRow = Math.max(3, Math.floor(faceW / 3))
  for (let r = 0; r < courses; r++) {
    const u1 = r / courses, u2 = (r + 1) / courses
    const y1 = fp[0].sy + (fp[3].sy - fp[0].sy) * u1
    const y2 = fp[0].sy + (fp[3].sy - fp[0].sy) * u2
    const offset = r % 2 === 0 ? 0 : 0.5 / bricksPerRow
    for (let c = 1; c < bricksPerRow; c++) {
      const t = c / bricksPerRow + offset
      if (t >= 1) continue
      const vx = fp[0].sx + (fp[1].sx - fp[0].sx) * t
      ctx.beginPath()
      ctx.moveTo(vx, y1)
      ctx.lineTo(vx, y2)
      ctx.stroke()
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ══ REUSABLE 3D SHAPE PRIMITIVES ════════════════════════════════
// ══════════════════════════════════════════════════════════════════

type ProjectFn = (x: number, y: number, z: number) => Projected | null

/** Draw a 3D axis-aligned box with up to 3 visible shaded faces. */
function drawBox3D(
  drawables: Drawable[],
  project: ProjectFn,
  camPos: Vec3,
  x: number, y: number, z: number,
  w: number, h: number, d: number,
  color: number, lighting: Lighting,
  depthBias: number = 0
): void {
  const corners = [
    project(x, y, z), project(x + w, y, z),
    project(x + w, y, z + d), project(x, y, z + d),
    project(x, y + h, z), project(x + w, y + h, z),
    project(x + w, y + h, z + d), project(x, y + h, z + d),
  ]
  if (corners.some(c => c === null)) return
  const p = corners as Projected[]
  const avgDepth = p.reduce((s, v) => s + v.depth, 0) / 8 + depthBias
  const cx2 = x + w / 2, cz2 = z + d / 2

  const faces: { idx: number[]; nx: number; ny: number; nz: number }[] = []
  if (camPos.z < cz2) faces.push({ idx: [0, 1, 5, 4], nx: 0, ny: 0, nz: -1 })
  if (camPos.z > cz2) faces.push({ idx: [2, 3, 7, 6], nx: 0, ny: 0, nz: 1 })
  if (camPos.x > cx2) faces.push({ idx: [1, 2, 6, 5], nx: 1, ny: 0, nz: 0 })
  if (camPos.x < cx2) faces.push({ idx: [3, 0, 4, 7], nx: -1, ny: 0, nz: 0 })
  // Top face
  faces.push({ idx: [4, 5, 6, 7], nx: 0, ny: 1, nz: 0 })

  drawables.push({
    depth: avgDepth,
    draw: (ctx) => {
      for (const f of faces) {
        const fc = f.idx.map(i => p[i])
        const litColor = shadeFace(color, f.nx, f.ny, f.nz, lighting)
        const foggedColor = applyFog(litColor, avgDepth, lighting)
        ctx.fillStyle = hexToCSS(foggedColor)
        ctx.beginPath()
        ctx.moveTo(fc[0].sx, fc[0].sy)
        for (let i = 1; i < fc.length; i++) ctx.lineTo(fc[i].sx, fc[i].sy)
        ctx.closePath(); ctx.fill()
      }
    }
  })
}

/** Draw a 3D cylinder approximated as N flat-shaded quads. */
function drawCylinder3D(
  drawables: Drawable[],
  project: ProjectFn,
  camPos: Vec3,
  cx: number, y0: number, cz: number,
  radius: number, height: number, segments: number,
  color: number, lighting: Lighting,
  depthBias: number = 0
): void {
  const bottomPts: (Projected | null)[] = []
  const topPts: (Projected | null)[] = []
  const angles: number[] = []

  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    angles.push(a)
    const px = cx + Math.cos(a) * radius
    const pz = cz + Math.sin(a) * radius
    bottomPts.push(project(px, y0, pz))
    topPts.push(project(px, y0 + height, pz))
  }

  if (bottomPts.some(p => p === null) || topPts.some(p => p === null)) return
  const bp = bottomPts as Projected[]
  const tp = topPts as Projected[]
  const avgDepth = bp.reduce((s, v) => s + v.depth, 0) / segments + depthBias

  drawables.push({
    depth: avgDepth,
    draw: (ctx) => {
      // Side faces — only draw faces facing camera
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments
        const midA = (angles[i] + angles[j]) / 2
        const nx = Math.cos(midA), nz = Math.sin(midA)
        // Dot product with camera direction to check visibility
        const toCamX = camPos.x - cx, toCamZ = camPos.z - cz
        if (nx * toCamX + nz * toCamZ <= 0) continue

        const litColor = shadeFace(color, nx, 0, nz, lighting)
        const foggedColor = applyFog(litColor, avgDepth, lighting)
        ctx.fillStyle = hexToCSS(foggedColor)
        ctx.beginPath()
        ctx.moveTo(bp[i].sx, bp[i].sy)
        ctx.lineTo(bp[j].sx, bp[j].sy)
        ctx.lineTo(tp[j].sx, tp[j].sy)
        ctx.lineTo(tp[i].sx, tp[i].sy)
        ctx.closePath(); ctx.fill()
      }
      // Top cap
      const topColor = applyFog(shadeFace(color, 0, 1, 0, lighting), avgDepth, lighting)
      ctx.fillStyle = hexToCSS(topColor)
      ctx.beginPath()
      ctx.moveTo(tp[0].sx, tp[0].sy)
      for (let i = 1; i < segments; i++) ctx.lineTo(tp[i].sx, tp[i].sy)
      ctx.closePath(); ctx.fill()
    }
  })
}

/** Draw a tapered cylinder (truncated cone) — steeples, chimneys, lighthouse. */
function drawTaper3D(
  drawables: Drawable[],
  project: ProjectFn,
  camPos: Vec3,
  cx: number, y0: number, cz: number,
  baseRadius: number, topRadius: number, height: number, segments: number,
  color: number, lighting: Lighting,
  depthBias: number = 0
): void {
  const bottomPts: (Projected | null)[] = []
  const topPts: (Projected | null)[] = []
  const angles: number[] = []

  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2
    angles.push(a)
    bottomPts.push(project(cx + Math.cos(a) * baseRadius, y0, cz + Math.sin(a) * baseRadius))
    topPts.push(project(cx + Math.cos(a) * topRadius, y0 + height, cz + Math.sin(a) * topRadius))
  }

  if (bottomPts.some(p => p === null) || topPts.some(p => p === null)) return
  const bp = bottomPts as Projected[]
  const tp = topPts as Projected[]
  const avgDepth = bp.reduce((s, v) => s + v.depth, 0) / segments + depthBias

  drawables.push({
    depth: avgDepth,
    draw: (ctx) => {
      for (let i = 0; i < segments; i++) {
        const j = (i + 1) % segments
        const midA = (angles[i] + angles[j]) / 2
        const nx = Math.cos(midA), nz = Math.sin(midA)
        const toCamX = camPos.x - cx, toCamZ = camPos.z - cz
        if (nx * toCamX + nz * toCamZ <= 0) continue

        const litColor = shadeFace(color, nx, 0.3, nz, lighting)
        const foggedColor = applyFog(litColor, avgDepth, lighting)
        ctx.fillStyle = hexToCSS(foggedColor)
        ctx.beginPath()
        ctx.moveTo(bp[i].sx, bp[i].sy)
        ctx.lineTo(bp[j].sx, bp[j].sy)
        ctx.lineTo(tp[j].sx, tp[j].sy)
        ctx.lineTo(tp[i].sx, tp[i].sy)
        ctx.closePath(); ctx.fill()
      }
      // Top cap (if topRadius > 0)
      if (topRadius > 0.05) {
        const topColor = applyFog(shadeFace(color, 0, 1, 0, lighting), avgDepth, lighting)
        ctx.fillStyle = hexToCSS(topColor)
        ctx.beginPath()
        ctx.moveTo(tp[0].sx, tp[0].sy)
        for (let i = 1; i < segments; i++) ctx.lineTo(tp[i].sx, tp[i].sy)
        ctx.closePath(); ctx.fill()
      }
    }
  })
}

/** Draw extruded arbitrary polygon (prism) — L-shapes, hexagons, buttresses. */
function drawPrism3D(
  drawables: Drawable[],
  project: ProjectFn,
  camPos: Vec3,
  basePoints: { x: number; z: number }[],
  y0: number, height: number,
  color: number, lighting: Lighting,
  depthBias: number = 0
): void {
  const n = basePoints.length
  const bottomPts: (Projected | null)[] = []
  const topPts: (Projected | null)[] = []

  for (const pt of basePoints) {
    bottomPts.push(project(pt.x, y0, pt.z))
    topPts.push(project(pt.x, y0 + height, pt.z))
  }

  if (bottomPts.some(p => p === null) || topPts.some(p => p === null)) return
  const bp = bottomPts as Projected[]
  const tp = topPts as Projected[]
  const avgDepth = bp.reduce((s, v) => s + v.depth, 0) / n + depthBias

  // Compute centroid for face visibility
  const centX = basePoints.reduce((s, p) => s + p.x, 0) / n
  const centZ = basePoints.reduce((s, p) => s + p.z, 0) / n

  drawables.push({
    depth: avgDepth,
    draw: (ctx) => {
      // Side faces
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        const edgeX = basePoints[j].x - basePoints[i].x
        const edgeZ = basePoints[j].z - basePoints[i].z
        // Outward normal (perpendicular to edge, pointing away from centroid)
        let nx = -edgeZ, nz = edgeX
        const len = Math.sqrt(nx * nx + nz * nz) || 1
        nx /= len; nz /= len
        // Check outward direction
        const midX = (basePoints[i].x + basePoints[j].x) / 2 - centX
        const midZ = (basePoints[i].z + basePoints[j].z) / 2 - centZ
        if (nx * midX + nz * midZ < 0) { nx = -nx; nz = -nz }
        // Visibility check
        const toCamX = camPos.x - centX, toCamZ = camPos.z - centZ
        if (nx * toCamX + nz * toCamZ <= 0) continue

        const litColor = shadeFace(color, nx, 0, nz, lighting)
        const foggedColor = applyFog(litColor, avgDepth, lighting)
        ctx.fillStyle = hexToCSS(foggedColor)
        ctx.beginPath()
        ctx.moveTo(bp[i].sx, bp[i].sy)
        ctx.lineTo(bp[j].sx, bp[j].sy)
        ctx.lineTo(tp[j].sx, tp[j].sy)
        ctx.lineTo(tp[i].sx, tp[i].sy)
        ctx.closePath(); ctx.fill()
      }
      // Top face
      const topColor = applyFog(shadeFace(color, 0, 1, 0, lighting), avgDepth, lighting)
      ctx.fillStyle = hexToCSS(topColor)
      ctx.beginPath()
      ctx.moveTo(tp[0].sx, tp[0].sy)
      for (let i = 1; i < n; i++) ctx.lineTo(tp[i].sx, tp[i].sy)
      ctx.closePath(); ctx.fill()
    }
  })
}

/**
 * Draw a generic 3D roof from base polygon to ridge/apex.
 * - 1 ridgePoint = pointed (pyramid)
 * - 2 ridgePoints = gabled (saddle ridge)
 * - basePoints at wall-top height, ridge points above that.
 */
function drawRoof3D(
  drawables: Drawable[],
  project: ProjectFn,
  basePoints: { x: number; y: number; z: number }[],
  ridgePoints: { x: number; y: number; z: number }[],
  color: number, lighting: Lighting,
  depthBias: number = 0
): void {
  const baseProjArr = basePoints.map(p => project(p.x, p.y, p.z))
  const ridgeProjArr = ridgePoints.map(p => project(p.x, p.y, p.z))
  if (baseProjArr.some(p => p === null) || ridgeProjArr.some(p => p === null)) return
  const bp = baseProjArr as Projected[]
  const rp = ridgeProjArr as Projected[]

  const allPts = [...bp, ...rp]
  const avgDepth = allPts.reduce((s, v) => s + v.depth, 0) / allPts.length + depthBias

  if (ridgePoints.length === 1) {
    // Pointed/pyramid roof — triangles from each base edge to apex
    drawables.push({
      depth: avgDepth,
      draw: (ctx) => {
        for (let i = 0; i < bp.length; i++) {
          const j = (i + 1) % bp.length
          const edgeX = basePoints[j].x - basePoints[i].x
          const edgeZ = basePoints[j].z - basePoints[i].z
          // Approximate face brightness by angle
          const nx = -edgeZ, nz = edgeX
          const litColor = shadeFace(color, nx * 0.5, 0.8, nz * 0.5, lighting)
          const foggedColor = applyFog(litColor, avgDepth, lighting)
          ctx.fillStyle = hexToCSS(foggedColor)
          ctx.beginPath()
          ctx.moveTo(bp[i].sx, bp[i].sy)
          ctx.lineTo(bp[j].sx, bp[j].sy)
          ctx.lineTo(rp[0].sx, rp[0].sy)
          ctx.closePath(); ctx.fill()
        }
      }
    })
  } else if (ridgePoints.length === 2) {
    // Gabled roof — two slope planes + two gable triangles
    // Assumes 4-point base: [front-left, front-right, back-right, back-left]
    drawables.push({
      depth: avgDepth,
      draw: (ctx) => {
        // Left slope: basePoints[3]→[0] → ridge[0]→ridge[1]
        const leftColor = applyFog(shadeFace(color, -0.5, 0.7, 0, lighting), avgDepth, lighting)
        ctx.fillStyle = hexToCSS(leftColor)
        ctx.beginPath()
        ctx.moveTo(bp[3].sx, bp[3].sy); ctx.lineTo(bp[0].sx, bp[0].sy)
        ctx.lineTo(rp[0].sx, rp[0].sy); ctx.lineTo(rp[1].sx, rp[1].sy)
        ctx.closePath(); ctx.fill()

        // Right slope: basePoints[1]→[2] → ridge[1]→ridge[0]
        const rightColor = applyFog(shadeFace(color, 0.5, 0.7, 0, lighting), avgDepth, lighting)
        ctx.fillStyle = hexToCSS(rightColor)
        ctx.beginPath()
        ctx.moveTo(bp[1].sx, bp[1].sy); ctx.lineTo(bp[2].sx, bp[2].sy)
        ctx.lineTo(rp[1].sx, rp[1].sy); ctx.lineTo(rp[0].sx, rp[0].sy)
        ctx.closePath(); ctx.fill()

        // Front gable: basePoints[0]→[1] → ridge[0]
        const frontColor = applyFog(shadeFace(color, 0, 0.3, -0.9, lighting), avgDepth, lighting)
        ctx.fillStyle = hexToCSS(frontColor)
        ctx.beginPath()
        ctx.moveTo(bp[0].sx, bp[0].sy); ctx.lineTo(bp[1].sx, bp[1].sy)
        ctx.lineTo(rp[0].sx, rp[0].sy)
        ctx.closePath(); ctx.fill()

        // Back gable: basePoints[2]→[3] → ridge[1]
        const backColor = applyFog(shadeFace(color, 0, 0.3, 0.9, lighting), avgDepth, lighting)
        ctx.fillStyle = hexToCSS(backColor)
        ctx.beginPath()
        ctx.moveTo(bp[2].sx, bp[2].sy); ctx.lineTo(bp[3].sx, bp[3].sy)
        ctx.lineTo(rp[1].sx, rp[1].sy)
        ctx.closePath(); ctx.fill()
      }
    })
  }
}

/** Draw a semicircular arch in screen-space between two projected points. */
function drawArch3D(
  ctx: CanvasRenderingContext2D,
  left: Projected, right: Projected, archHeight: number,
  color: string, fillMode: boolean = true
): void {
  const midX = (left.sx + right.sx) / 2
  const midY = (left.sy + right.sy) / 2
  const halfW = Math.abs(right.sx - left.sx) / 2

  if (fillMode) {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(left.sx, left.sy)
    ctx.lineTo(left.sx, midY - archHeight * 0.4)
    ctx.arc(midX, midY - archHeight * 0.4, halfW, Math.PI, 0)
    ctx.lineTo(right.sx, right.sy)
    ctx.closePath()
    ctx.fill()
  } else {
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(left.sx, left.sy)
    ctx.lineTo(left.sx, midY - archHeight * 0.4)
    ctx.arc(midX, midY - archHeight * 0.4, halfW, Math.PI, 0)
    ctx.lineTo(right.sx, right.sy)
    ctx.stroke()
  }
}

// ══════════════════════════════════════════════════════════════════
// ══ BUILDING BLUEPRINT SYSTEM ═══════════════════════════════════
// ══════════════════════════════════════════════════════════════════

interface ShapeDesc {
  type: 'box' | 'cylinder' | 'taper' | 'prism'
  offset: { x: number; y: number; z: number }
  params: Record<string, number>
  colorKey: 'wall' | 'roof' | 'door' | 'accent'
}

interface RoofDesc {
  type: 'roof'
  baseOffsets: { x: number; y: number; z: number }[]  // 4 corner offsets from building origin
  ridgeOffsets: { x: number; y: number; z: number }[] // 1 (pointed) or 2 (gabled)
  colorKey: 'roof'
}

interface DetailDesc {
  type: 'arch_door' | 'windows' | 'rose_window' | 'arrow_slits' | 'banner' | 'clock'
  face: 'front' | 'back' | 'left' | 'right'
  position: { u: number; v: number }
  params?: Record<string, number>
}

type BlueprintElement = ShapeDesc | RoofDesc | DetailDesc
type BuildingBlueprint = BlueprintElement[]

/** Render a building from a blueprint — composing 3D primitives. */
function renderBlueprint(
  drawables: Drawable[],
  blueprint: BuildingBlueprint,
  ox: number, oy: number, oz: number, // building origin in world units
  ts: number,
  palette: { wall: number; roof: number; door: number },
  project: ProjectFn,
  camPos: Vec3,
  lighting: Lighting,
  depthBias: number = 0
): void {
  for (const elem of blueprint) {
    if (elem.type === 'roof') {
      const roofElem = elem as RoofDesc
      const basePts = roofElem.baseOffsets.map(o => ({
        x: ox + o.x * ts, y: oy + o.y * ts, z: oz + o.z * ts
      }))
      const ridgePts = roofElem.ridgeOffsets.map(o => ({
        x: ox + o.x * ts, y: oy + o.y * ts, z: oz + o.z * ts
      }))
      drawRoof3D(drawables, project, basePts, ridgePts, palette.roof, lighting, depthBias - 0.02)
      continue
    }

    if (elem.type === 'arch_door' || elem.type === 'windows' || elem.type === 'rose_window' ||
        elem.type === 'arrow_slits' || elem.type === 'banner' || elem.type === 'clock') {
      // Detail pass — handled separately after shapes
      continue
    }

    const shape = elem as ShapeDesc
    const color = shape.colorKey === 'wall' ? palette.wall
      : shape.colorKey === 'roof' ? palette.roof
      : shape.colorKey === 'door' ? palette.door
      : palette.wall
    const sx = ox + shape.offset.x * ts
    const sy = oy + shape.offset.y * ts
    const sz = oz + shape.offset.z * ts

    if (shape.type === 'box') {
      drawBox3D(drawables, project, camPos,
        sx, sy, sz,
        shape.params.w * ts, shape.params.h * ts, shape.params.d * ts,
        color, lighting, depthBias)
    } else if (shape.type === 'cylinder') {
      drawCylinder3D(drawables, project, camPos,
        sx, sy, sz,
        shape.params.r * ts, shape.params.h * ts, shape.params.seg || 8,
        color, lighting, depthBias)
    } else if (shape.type === 'taper') {
      drawTaper3D(drawables, project, camPos,
        sx, sy, sz,
        shape.params.rBot * ts, shape.params.rTop * ts, shape.params.h * ts,
        shape.params.seg || 8,
        color, lighting, depthBias)
    }
  }

  // Detail pass — render decorations on faces
  for (const elem of blueprint) {
    if (elem.type !== 'arch_door' && elem.type !== 'windows' && elem.type !== 'rose_window' &&
        elem.type !== 'arrow_slits' && elem.type !== 'banner' && elem.type !== 'clock') continue
    const detail = elem as DetailDesc
    renderDetail(drawables, detail, ox, oy, oz, ts, palette, project, camPos, lighting, depthBias)
  }
}

/** Render a face detail decoration. */
function renderDetail(
  drawables: Drawable[],
  detail: DetailDesc,
  ox: number, oy: number, oz: number,
  ts: number,
  palette: { wall: number; roof: number; door: number },
  project: ProjectFn,
  camPos: Vec3,
  lighting: Lighting,
  depthBias: number
): void {
  // Placeholder — will be filled in Phase 4.
  // For now, details are drawn inline by blueprint-specific render overrides.
}

/** Add per-building-type animated details and decorations for blueprint buildings. */
function addBlueprintDetails(
  drawables: Drawable[],
  buildingId: string,
  ox: number, oz: number, ts: number,
  palette: { wall: number; roof: number; door: number },
  project: ProjectFn,
  camPos: Vec3,
  lighting: Lighting,
  time: number,
  hash: number
): void {
  if (buildingId === 'mill') {
    // Animated waterwheel on left side
    const wheelCenter = project(ox - 0.5 * ts, 1 * ts, oz + 1.5 * ts)
    if (wheelCenter) {
      drawables.push({
        depth: wheelCenter.depth - 0.01,
        draw: (ctx) => {
          const wr = ts * 0.8
          const wheelAngle = time * 1.2
          // Wheel rim
          ctx.strokeStyle = hexToCSS(applyFog(darken(palette.wall, 0.3), wheelCenter.depth, lighting))
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(wheelCenter.sx, wheelCenter.sy, wr, 0, Math.PI * 2)
          ctx.stroke()
          // Spokes
          ctx.lineWidth = 0.8
          for (let si = 0; si < 8; si++) {
            const a = wheelAngle + si * Math.PI / 4
            ctx.beginPath()
            ctx.moveTo(wheelCenter.sx, wheelCenter.sy)
            ctx.lineTo(wheelCenter.sx + Math.cos(a) * wr, wheelCenter.sy + Math.sin(a) * wr * 0.6)
            ctx.stroke()
          }
          // Hub
          ctx.fillStyle = hexToCSS(applyFog(darken(palette.wall, 0.2), wheelCenter.depth, lighting))
          ctx.beginPath()
          ctx.arc(wheelCenter.sx, wheelCenter.sy, wr * 0.15, 0, Math.PI * 2)
          ctx.fill()
          // Water splash below
          for (let wi = 0; wi < 3; wi++) {
            const wx = wheelCenter.sx + Math.sin(time * 3 + wi * 2) * 2
            const wy = wheelCenter.sy + wr + 1 + wi * 0.5
            ctx.fillStyle = `rgba(120,180,220,${0.15 - wi * 0.04})`
            ctx.beginPath(); ctx.arc(wx, wy, 0.8, 0, Math.PI * 2); ctx.fill()
          }
        }
      })
    }
  }

  if (buildingId === 'lighthouse') {
    // Beacon glow at top
    const beacon = project(ox + 1.5 * ts, 5.6 * ts, oz + 1.5 * ts)
    if (beacon) {
      drawables.push({
        depth: beacon.depth - 0.03,
        draw: (ctx) => {
          const isLit = lighting.isNight || lighting.isDusk
          const beaconR = isLit ? 6 + Math.sin(time * 2) * 2 : 3
          const beaconAlpha = isLit ? 0.6 : 0.2
          ctx.fillStyle = `rgba(255,240,180,${beaconAlpha})`
          ctx.beginPath()
          ctx.arc(beacon.sx, beacon.sy, beaconR, 0, Math.PI * 2)
          ctx.fill()
          // Beam sweep at night
          if (isLit) {
            const beamAngle = time * 0.5
            ctx.strokeStyle = `rgba(255,240,180,0.12)`
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.moveTo(beacon.sx, beacon.sy)
            ctx.lineTo(beacon.sx + Math.cos(beamAngle) * 40, beacon.sy + Math.sin(beamAngle) * 15)
            ctx.stroke()
          }
        }
      })
    }
    // Horizontal stripes (red/white lighthouse pattern)
    const stripeCount = 4
    for (let si = 0; si < stripeCount; si++) {
      const stripeY = (si + 0.5) / stripeCount * 4.5
      const stripeR = 1.3 - (stripeY / 5) * 0.5 // taper
      const stripeBot = project(ox + 1.5 * ts, stripeY * ts, oz + 1.5 * ts - stripeR * ts)
      if (stripeBot && si % 2 === 0) {
        drawables.push({
          depth: stripeBot.depth - 0.005,
          draw: (ctx) => {
            ctx.fillStyle = hexToCSS(applyFog(0xcc3333, stripeBot.depth, lighting))
            ctx.fillRect(stripeBot.sx - stripeR * ts * 0.5, stripeBot.sy - ts * 0.3, stripeR * ts, ts * 0.5)
          }
        })
      }
    }
  }

  if (buildingId === 'cathedral') {
    // Rose window on front face (large circular stained glass)
    const roseCenter = project(ox + 1.5 * ts, 2.5 * ts, oz - 0.01 * ts)
    if (roseCenter && camPos.z < oz + 3 * ts) {
      drawables.push({
        depth: roseCenter.depth - 0.005,
        draw: (ctx) => {
          const rr = ts * 0.5
          // Window circle
          const isLit = lighting.isNight || lighting.isDusk
          ctx.fillStyle = isLit
            ? hexToCSS(applyFog(0xdd8844, roseCenter.depth, lighting))
            : hexToCSS(applyFog(0x4466aa, roseCenter.depth, lighting))
          ctx.beginPath()
          ctx.arc(roseCenter.sx, roseCenter.sy, rr, 0, Math.PI * 2)
          ctx.fill()
          // Tracery (spoke pattern)
          ctx.strokeStyle = hexToCSS(applyFog(darken(palette.wall, 0.1), roseCenter.depth, lighting))
          ctx.lineWidth = 0.4
          for (let ti = 0; ti < 8; ti++) {
            const ta = (ti / 8) * Math.PI * 2
            ctx.beginPath()
            ctx.moveTo(roseCenter.sx, roseCenter.sy)
            ctx.lineTo(roseCenter.sx + Math.cos(ta) * rr, roseCenter.sy + Math.sin(ta) * rr)
            ctx.stroke()
          }
          // Inner circle
          ctx.beginPath()
          ctx.arc(roseCenter.sx, roseCenter.sy, rr * 0.5, 0, Math.PI * 2)
          ctx.stroke()
          // Outer rim
          ctx.lineWidth = 0.6
          ctx.beginPath()
          ctx.arc(roseCenter.sx, roseCenter.sy, rr, 0, Math.PI * 2)
          ctx.stroke()
        }
      })
    }
    // Cross at top of bell tower steeple
    const crossBase = project(ox + 0.1 * ts, 7 * ts, oz + 0.1 * ts)
    if (crossBase) {
      drawables.push({
        depth: crossBase.depth - 0.04,
        draw: (ctx) => {
          ctx.strokeStyle = hexToCSS(applyFog(darken(palette.wall, 0.2), crossBase.depth, lighting))
          ctx.lineWidth = 0.8
          ctx.beginPath(); ctx.moveTo(crossBase.sx, crossBase.sy); ctx.lineTo(crossBase.sx, crossBase.sy - 3); ctx.stroke()
          ctx.beginPath(); ctx.moveTo(crossBase.sx - 1.5, crossBase.sy - 2); ctx.lineTo(crossBase.sx + 1.5, crossBase.sy - 2); ctx.stroke()
        }
      })
    }
  }

  if (buildingId === 'gatehouse') {
    // Archway opening on front face
    const archLeft = project(ox + 1 * ts, 0, oz)
    const archRight = project(ox + 2 * ts, 0, oz)
    const archTop = project(ox + 1.5 * ts, 2.2 * ts, oz)
    if (archLeft && archRight && archTop && camPos.z < oz + 0.5 * ts) {
      drawables.push({
        depth: archLeft.depth - 0.005,
        draw: (ctx) => {
          // Dark archway opening
          ctx.fillStyle = 'rgba(15,12,10,0.7)'
          drawArch3D(ctx, archLeft, archRight, Math.abs(archTop.sy - archLeft.sy), 'rgba(15,12,10,0.7)', true)
          // Portcullis grid
          ctx.strokeStyle = hexToCSS(applyFog(0x4a4a4a, archLeft.depth, lighting))
          ctx.lineWidth = 0.5
          const aW = Math.abs(archRight.sx - archLeft.sx)
          const aH = Math.abs(archTop.sy - archLeft.sy)
          for (let gi = 1; gi < 4; gi++) {
            const gx = archLeft.sx + aW * gi / 4
            ctx.beginPath(); ctx.moveTo(gx, archLeft.sy); ctx.lineTo(gx, archLeft.sy - aH * 0.7); ctx.stroke()
          }
          for (let gi = 1; gi < 3; gi++) {
            const gy = archLeft.sy - aH * gi / 4
            ctx.beginPath(); ctx.moveTo(archLeft.sx, gy); ctx.lineTo(archRight.sx, gy); ctx.stroke()
          }
        }
      })
    }
  }

  if (buildingId === 'bell_tower_tall') {
    // Open belfry arches (dark openings suggesting depth)
    const belfryFront = project(ox + 0.3 * ts, 4.8 * ts, oz)
    const belfryFrontR = project(ox + 1.7 * ts, 4.8 * ts, oz)
    if (belfryFront && belfryFrontR && camPos.z < oz + ts) {
      drawables.push({
        depth: belfryFront.depth - 0.005,
        draw: (ctx) => {
          ctx.fillStyle = 'rgba(20,15,10,0.5)'
          drawArch3D(ctx, belfryFront, belfryFrontR, ts * 0.8, 'rgba(20,15,10,0.5)', true)
          // Bell silhouette
          ctx.fillStyle = hexToCSS(applyFog(0x8a7a50, belfryFront.depth, lighting))
          const bellX = (belfryFront.sx + belfryFrontR.sx) / 2
          const bellY = (belfryFront.sy + belfryFrontR.sy) / 2 - ts * 0.2
          ctx.beginPath()
          ctx.arc(bellX, bellY, ts * 0.2, Math.PI, 0)
          ctx.lineTo(bellX + ts * 0.25, bellY + ts * 0.15)
          ctx.lineTo(bellX - ts * 0.25, bellY + ts * 0.15)
          ctx.closePath(); ctx.fill()
        }
      })
    }
  }

  if (buildingId === 'aqueduct') {
    // Arch openings between pillars
    for (let ai = 0; ai < 2; ai++) {
      const aLeft = project(ox + (ai * 2 + 0.5) * ts, 0, oz + 0.25 * ts)
      const aRight = project(ox + (ai * 2 + 2) * ts, 0, oz + 0.25 * ts)
      if (aLeft && aRight && camPos.z < oz + 0.5 * ts) {
        drawables.push({
          depth: aLeft.depth - 0.003,
          draw: (ctx) => {
            drawArch3D(ctx, aLeft, aRight, ts * 1.8, 'rgba(20,15,10,0.4)', true)
          }
        })
      }
    }
    // Water channel highlight on top
    const chanLeft = project(ox + 0.1 * ts, 3.1 * ts, oz + 0.15 * ts)
    const chanRight = project(ox + 4.4 * ts, 3.1 * ts, oz + 0.15 * ts)
    if (chanLeft && chanRight) {
      drawables.push({
        depth: chanLeft.depth - 0.01,
        draw: (ctx) => {
          ctx.fillStyle = hexToCSS(applyFog(0x4682b4, chanLeft.depth, lighting))
          ctx.fillRect(chanLeft.sx, chanLeft.sy - 1, chanRight.sx - chanLeft.sx, 2)
        }
      })
    }
  }
}

// ── BLUEPRINT DEFINITIONS ──

const BLUEPRINTS: Record<string, BuildingBlueprint> = {
  cathedral: [
    // Main nave
    { type: 'box', offset: { x: 0, y: 0, z: 0 }, params: { w: 3, h: 3.5, d: 5 }, colorKey: 'wall' },
    // Side aisles (lower flanking naves)
    { type: 'box', offset: { x: -1, y: 0, z: 0.5 }, params: { w: 1, h: 2.2, d: 4 }, colorKey: 'wall' },
    { type: 'box', offset: { x: 3, y: 0, z: 0.5 }, params: { w: 1, h: 2.2, d: 4 }, colorKey: 'wall' },
    // Apse (rounded back)
    { type: 'cylinder', offset: { x: 1.5, y: 0, z: 5 }, params: { r: 1.2, h: 3, seg: 8 }, colorKey: 'wall' },
    // Bell tower (front left)
    { type: 'box', offset: { x: -0.5, y: 0, z: -0.5 }, params: { w: 1.2, h: 5, d: 1.2 }, colorKey: 'wall' },
    // Tower steeple
    { type: 'taper', offset: { x: 0.1, y: 5, z: 0.1 }, params: { rBot: 0.7, rTop: 0.05, h: 2, seg: 6 }, colorKey: 'roof' },
    // Nave roof (gabled)
    { type: 'roof',
      baseOffsets: [
        { x: 0, y: 3.5, z: 0 }, { x: 3, y: 3.5, z: 0 },
        { x: 3, y: 3.5, z: 5 }, { x: 0, y: 3.5, z: 5 },
      ],
      ridgeOffsets: [
        { x: 1.5, y: 5.2, z: 0 }, { x: 1.5, y: 5.2, z: 5 },
      ],
      colorKey: 'roof'
    },
    // Side aisle roofs (lower gabled)
    { type: 'roof',
      baseOffsets: [
        { x: -1, y: 2.2, z: 0.5 }, { x: 0, y: 2.2, z: 0.5 },
        { x: 0, y: 2.2, z: 4.5 }, { x: -1, y: 2.2, z: 4.5 },
      ],
      ridgeOffsets: [
        { x: -0.5, y: 3, z: 0.5 }, { x: -0.5, y: 3, z: 4.5 },
      ],
      colorKey: 'roof'
    },
    { type: 'roof',
      baseOffsets: [
        { x: 3, y: 2.2, z: 0.5 }, { x: 4, y: 2.2, z: 0.5 },
        { x: 4, y: 2.2, z: 4.5 }, { x: 3, y: 2.2, z: 4.5 },
      ],
      ridgeOffsets: [
        { x: 3.5, y: 3, z: 0.5 }, { x: 3.5, y: 3, z: 4.5 },
      ],
      colorKey: 'roof'
    },
    // Flying buttresses (left side) — small prisms connecting aisle to nave
    { type: 'box', offset: { x: -0.3, y: 1.8, z: 1.2 }, params: { w: 0.3, h: 0.4, d: 0.3 }, colorKey: 'wall' },
    { type: 'box', offset: { x: -0.3, y: 1.8, z: 2.8 }, params: { w: 0.3, h: 0.4, d: 0.3 }, colorKey: 'wall' },
    // Flying buttresses (right side)
    { type: 'box', offset: { x: 3, y: 1.8, z: 1.2 }, params: { w: 0.3, h: 0.4, d: 0.3 }, colorKey: 'wall' },
    { type: 'box', offset: { x: 3, y: 1.8, z: 2.8 }, params: { w: 0.3, h: 0.4, d: 0.3 }, colorKey: 'wall' },
  ],

  lighthouse: [
    // Tapered tower body
    { type: 'taper', offset: { x: 1.5, y: 0, z: 1.5 }, params: { rBot: 1.3, rTop: 0.8, h: 5, seg: 10 }, colorKey: 'wall' },
    // Glass lantern room
    { type: 'cylinder', offset: { x: 1.5, y: 5, z: 1.5 }, params: { r: 0.9, h: 1.2, seg: 10 }, colorKey: 'accent' },
    // Dome cap
    { type: 'taper', offset: { x: 1.5, y: 6.2, z: 1.5 }, params: { rBot: 0.9, rTop: 0.1, h: 0.8, seg: 10 }, colorKey: 'roof' },
    // Base platform
    { type: 'cylinder', offset: { x: 1.5, y: 0, z: 1.5 }, params: { r: 1.6, h: 0.3, seg: 10 }, colorKey: 'wall' },
  ],

  round_tower: [
    // Cylindrical body
    { type: 'cylinder', offset: { x: 1, y: 0, z: 1 }, params: { r: 1, h: 3.5, seg: 10 }, colorKey: 'wall' },
    // Conical roof
    { type: 'taper', offset: { x: 1, y: 3.5, z: 1 }, params: { rBot: 1.1, rTop: 0.05, h: 1.8, seg: 10 }, colorKey: 'roof' },
  ],

  gatehouse: [
    // Left tower
    { type: 'cylinder', offset: { x: 0, y: 0, z: 0.5 }, params: { r: 0.8, h: 3.5, seg: 8 }, colorKey: 'wall' },
    // Right tower
    { type: 'cylinder', offset: { x: 3, y: 0, z: 0.5 }, params: { r: 0.8, h: 3.5, seg: 8 }, colorKey: 'wall' },
    // Connecting wall/passage
    { type: 'box', offset: { x: 0.5, y: 0, z: 0 }, params: { w: 2, h: 3, d: 1 }, colorKey: 'wall' },
    // Left tower roof
    { type: 'taper', offset: { x: 0, y: 3.5, z: 0.5 }, params: { rBot: 0.9, rTop: 0.05, h: 1.3, seg: 8 }, colorKey: 'roof' },
    // Right tower roof
    { type: 'taper', offset: { x: 3, y: 3.5, z: 0.5 }, params: { rBot: 0.9, rTop: 0.05, h: 1.3, seg: 8 }, colorKey: 'roof' },
    // Battlement on connecting wall
    { type: 'box', offset: { x: 0.5, y: 3, z: 0 }, params: { w: 2, h: 0.4, d: 1 }, colorKey: 'wall' },
  ],

  stable: [
    // Main body — wide and low
    { type: 'box', offset: { x: 0, y: 0, z: 0 }, params: { w: 4, h: 1.5, d: 3 }, colorKey: 'wall' },
    // Roof (low-pitched gable)
    { type: 'roof',
      baseOffsets: [
        { x: 0, y: 1.5, z: 0 }, { x: 4, y: 1.5, z: 0 },
        { x: 4, y: 1.5, z: 3 }, { x: 0, y: 1.5, z: 3 },
      ],
      ridgeOffsets: [
        { x: 2, y: 2.2, z: 0 }, { x: 2, y: 2.2, z: 3 },
      ],
      colorKey: 'roof'
    },
    // Stall dividers (visible from front)
    { type: 'box', offset: { x: 1.3, y: 0, z: 0.1 }, params: { w: 0.1, h: 1, d: 2 }, colorKey: 'wall' },
    { type: 'box', offset: { x: 2.6, y: 0, z: 0.1 }, params: { w: 0.1, h: 1, d: 2 }, colorKey: 'wall' },
  ],

  mill: [
    // Main building
    { type: 'box', offset: { x: 0, y: 0, z: 0 }, params: { w: 3, h: 2.5, d: 3 }, colorKey: 'wall' },
    // Roof
    { type: 'roof',
      baseOffsets: [
        { x: 0, y: 2.5, z: 0 }, { x: 3, y: 2.5, z: 0 },
        { x: 3, y: 2.5, z: 3 }, { x: 0, y: 2.5, z: 3 },
      ],
      ridgeOffsets: [
        { x: 1.5, y: 3.5, z: 0 }, { x: 1.5, y: 3.5, z: 3 },
      ],
      colorKey: 'roof'
    },
    // Waterwheel housing (side bump)
    { type: 'box', offset: { x: -0.5, y: 0, z: 0.5 }, params: { w: 0.5, h: 2, d: 2 }, colorKey: 'wall' },
  ],

  bell_tower_tall: [
    // Tall narrow shaft
    { type: 'box', offset: { x: 0, y: 0, z: 0 }, params: { w: 2, h: 4.5, d: 2 }, colorKey: 'wall' },
    // Open belfry (slightly wider, shorter)
    { type: 'box', offset: { x: -0.15, y: 4.5, z: -0.15 }, params: { w: 2.3, h: 1.2, d: 2.3 }, colorKey: 'wall' },
    // Pointed roof
    { type: 'roof',
      baseOffsets: [
        { x: -0.15, y: 5.7, z: -0.15 }, { x: 2.15, y: 5.7, z: -0.15 },
        { x: 2.15, y: 5.7, z: 2.15 }, { x: -0.15, y: 5.7, z: 2.15 },
      ],
      ridgeOffsets: [
        { x: 1, y: 7.5, z: 1 },
      ],
      colorKey: 'roof'
    },
  ],

  aqueduct: [
    // Series of pillars with arches
    { type: 'box', offset: { x: 0, y: 0, z: 0 }, params: { w: 0.5, h: 3, d: 0.5 }, colorKey: 'wall' },
    { type: 'box', offset: { x: 2, y: 0, z: 0 }, params: { w: 0.5, h: 3, d: 0.5 }, colorKey: 'wall' },
    { type: 'box', offset: { x: 4, y: 0, z: 0 }, params: { w: 0.5, h: 3, d: 0.5 }, colorKey: 'wall' },
    // Channel on top
    { type: 'box', offset: { x: 0, y: 2.8, z: 0 }, params: { w: 4.5, h: 0.4, d: 0.5 }, colorKey: 'wall' },
    // Arch keystones (decorative boxes bridging pillars)
    { type: 'box', offset: { x: 0.5, y: 2.2, z: 0.05 }, params: { w: 1.5, h: 0.3, d: 0.4 }, colorKey: 'wall' },
    { type: 'box', offset: { x: 2.5, y: 2.2, z: 0.05 }, params: { w: 1.5, h: 0.3, d: 0.4 }, colorKey: 'wall' },
  ],
}

// ── BLUEPRINT BUILDING HEIGHTS (for shadow casting etc.) ──
const BLUEPRINT_HEIGHTS: Record<string, number> = {
  cathedral: 7.5, lighthouse: 9, round_tower: 7, gatehouse: 6.5,
  stable: 3.0, mill: 5.0, bell_tower_tall: 10, aqueduct: 4.5,
}

// ══════════════════════════════════════════════════════════════════

// ── View matrix (camera look-at) ──

function buildViewMatrix(eye: Vec3, target: Vec3): number[] {
  // Forward direction (eye → target)
  let fx = target.x - eye.x, fy = target.y - eye.y, fz = target.z - eye.z
  const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1
  fx /= fLen; fy /= fLen; fz /= fLen

  // Right = up × forward, where up = (0, 1, 0)
  // cross(up, forward) = (1*fz - 0*fy, 0*fx - 0*fz, 0*fy - 1*fx) = (fz, 0, -fx)
  let rx = fz, rz = -fx
  const rLen = Math.sqrt(rx * rx + rz * rz) || 1
  rx /= rLen; rz /= rLen
  const ry = 0

  // True up = forward × right
  const ux = fy * rz - fz * ry
  const uy = fz * rx - fx * rz
  const uz = fx * ry - fy * rx

  // View matrix rows (transposed rotation)
  // Positive rz = in front of camera
  return [
    rx, ry, rz,   // right
    ux, uy, uz,   // up
    fx, fy, fz    // forward
  ]
}

// ── Lighting computation ──

function computeLighting(env: EnvironmentState): Lighting {
  const t = env.timeOfDay
  let ambientColor: number, ambientIntensity: number
  let sunColor: number, sunIntensity: number
  let skyColor: number

  if (t >= 5 && t < 7) {
    const p = (t - 5) / 2
    ambientColor = lerpColor(0x1a1a3a, 0xffccaa, p)
    ambientIntensity = 0.2 + p * 0.3
    sunColor = 0xff8844
    sunIntensity = p * 0.8
    skyColor = lerpColor(0x1a1030, 0xffaa66, p)
  } else if (t >= 7 && t < 17) {
    const dayP = (t - 7) / 10
    ambientColor = 0xffffff
    ambientIntensity = 0.4 + Math.sin(dayP * Math.PI) * 0.3
    sunColor = 0xfff8e8
    sunIntensity = 0.6 + Math.sin(dayP * Math.PI) * 0.6
    skyColor = 0x6eb5e8
  } else if (t >= 17 && t < 19) {
    const p = (t - 17) / 2
    ambientColor = lerpColor(0xffccaa, 0x1a1a3a, p)
    ambientIntensity = 0.5 - p * 0.3
    sunColor = 0xff6633
    sunIntensity = (1 - p) * 0.7
    skyColor = lerpColor(0xff8844, 0x0c0a20, p)
  } else {
    ambientColor = 0x1a1840
    ambientIntensity = 0.35
    sunColor = 0x4466cc
    sunIntensity = 0.15
    skyColor = 0x0c0a20
  }

  const sunAngleRad = (env.celestial.sunAngle * Math.PI) / 180
  // Sun Y component varies by time: low at dawn/dusk (long shadows), high at noon
  let sunElevation: number
  if (t >= 7 && t < 17) {
    const dayP = (t - 7) / 10
    sunElevation = 0.3 + Math.sin(dayP * Math.PI) * 0.5 // 0.3 at edges, 0.8 at noon
  } else if (t >= 5 && t < 7) {
    sunElevation = 0.15 + ((t - 5) / 2) * 0.15 // dawn: very low
  } else if (t >= 17 && t < 19) {
    sunElevation = 0.3 - ((t - 17) / 2) * 0.15 // dusk: dropping low
  } else {
    sunElevation = 0.2 // night: moonlight from moderate angle
  }
  const sdx = Math.cos(sunAngleRad), sdy = sunElevation, sdz = Math.sin(sunAngleRad)
  const sdLen = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz)

  const ar = ((ambientColor >> 16) & 0xff) / 255 * ambientIntensity
  const ag = ((ambientColor >> 8) & 0xff) / 255 * ambientIntensity
  const ab = (ambientColor & 0xff) / 255 * ambientIntensity

  const sr = ((sunColor >> 16) & 0xff) / 255 * sunIntensity
  const sg = ((sunColor >> 8) & 0xff) / 255 * sunIntensity
  const sb = (sunColor & 0xff) / 255 * sunIntensity

  const isNight = t < 5 || t >= 19
  const isDusk = t >= 17 && t < 19
  let fogDensity = 0
  if (env.weather === 'fog') fogDensity = 0.0015 + env.weatherIntensity * 0.004
  else if (env.weather === 'rain' || env.weather === 'storm') fogDensity = 0.0008 + env.weatherIntensity * 0.002
  else if (isNight) fogDensity = 0.0005

  return {
    ambientR: ar, ambientG: ag, ambientB: ab,
    sunDirX: sdx / sdLen, sunDirY: sdy / sdLen, sunDirZ: sdz / sdLen,
    sunR: sr, sunG: sg, sunB: sb,
    skyColor,
    fogDensity,
    isNight,
    isDusk,
  }
}

// ── Shading ──

function shadeFace(baseColor: number, nx: number, ny: number, nz: number, lighting: Lighting): number {
  const br = ((baseColor >> 16) & 0xff) / 255
  const bg = ((baseColor >> 8) & 0xff) / 255
  const bb = (baseColor & 0xff) / 255

  // Lambertian diffuse
  const dot = Math.max(0, nx * lighting.sunDirX + ny * lighting.sunDirY + nz * lighting.sunDirZ)

  const r = Math.min(1, br * (lighting.ambientR + lighting.sunR * dot))
  const g = Math.min(1, bg * (lighting.ambientG + lighting.sunG * dot))
  const b = Math.min(1, bb * (lighting.ambientB + lighting.sunB * dot))

  return (Math.floor(r * 255) << 16) | (Math.floor(g * 255) << 8) | Math.floor(b * 255)
}

function applyFog(color: number, depth: number, lighting: Lighting): number {
  if (lighting.fogDensity <= 0) return color
  const fogFactor = 1 - Math.exp(-lighting.fogDensity * depth)
  return lerpColor(color, lighting.skyColor, Math.min(fogFactor, 0.85))
}

// ── Utilities ──

function darken(color: number, amount: number): number {
  const r = Math.max(0, ((color >> 16) & 0xff) * (1 - amount))
  const g = Math.max(0, ((color >> 8) & 0xff) * (1 - amount))
  const b = Math.max(0, (color & 0xff) * (1 - amount))
  return (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b)
}

function lighten(color: number, amount: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) * (1 + amount) + 255 * amount * 0.3)
  const g = Math.min(255, ((color >> 8) & 0xff) * (1 + amount) + 255 * amount * 0.3)
  const b = Math.min(255, (color & 0xff) * (1 + amount) + 255 * amount * 0.3)
  return (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b)
}

const _cssCache = new Map<number, string>()
function hexToCSS(color: number): string {
  let s = _cssCache.get(color)
  if (s !== undefined) return s
  s = '#' + ((color >> 16) & 0xff).toString(16).padStart(2, '0')
    + ((color >> 8) & 0xff).toString(16).padStart(2, '0')
    + (color & 0xff).toString(16).padStart(2, '0')
  _cssCache.set(color, s)
  return s
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff
  const br2 = (b >> 16) & 0xff, bg2 = (b >> 8) & 0xff, bb2 = b & 0xff
  const r = Math.floor(ar + (br2 - ar) * t)
  const g = Math.floor(ag + (bg2 - ag) * t)
  const bl = Math.floor(ab + (bb2 - ab) * t)
  return (r << 16) | (g << 8) | bl
}

function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}
