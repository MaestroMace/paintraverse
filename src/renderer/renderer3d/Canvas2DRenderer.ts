/**
 * Canvas2D Software Renderer — replaces Three.js WebGL to avoid SwiftShader crashes.
 * Renders the 3D scene using perspective projection and Canvas2D drawing primitives.
 * Output feeds into the existing post-processing pipeline (color grading, bloom, quantization).
 */

import type { MapDocument, ObjectDefinition, PlacedObject, RenderCamera, EnvironmentState } from '../core/types'
import type { BuildingPalette } from '../inspiration/StyleMapper'

// ── Color constants (mirrored from SceneBuilder.ts) ──

const TERRAIN_COLORS: Record<number, number> = {
  0: 0x2d5a27, 1: 0x8b7355, 2: 0x708090, 3: 0x4682b4,
  4: 0xf4e9c8, 5: 0x556b2f, 6: 0x5a5a5a, 7: 0xdcdcdc,
  8: 0x6a6a68, 9: 0x4a4a48
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
  cart: { body: 0x6b4a28 },
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
  building_small: 1.6, building_medium: 2.2, building_large: 2.8,
  tavern: 2.0, shop: 1.8, tower: 3.5, clock_tower: 4.5,
  balcony_house: 2.4, row_house: 2.0, corner_building: 2.2,
  archway: 2.5, staircase: 1.0, town_gate: 3.0,
  chapel: 3.2, guild_hall: 2.8, warehouse: 2.2,
  watchtower: 4.0, mansion: 2.6, bakery: 1.8,
  apothecary: 2.6, inn: 2.4, temple: 3.5,
  covered_market: 2.0, bell_tower: 5.0, half_timber: 2.2,
  narrow_house: 2.8,
}

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

interface Drawable {
  depth: number
  draw: (ctx: CanvasRenderingContext2D) => void
}

// ── Main render function ──

export function renderCanvas2D(
  map: MapDocument,
  camera: RenderCamera,
  objectDefs: ObjectDefinition[],
  buildingPalettes?: BuildingPalette[] | null
): ImageData {
  const { outputWidth: W, outputHeight: H } = camera
  const ts = map.tileSize

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

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

  // Project helper
  const project = (wx: number, wy: number, wz: number): Projected | null => {
    const dx = wx - camPos.x, dy = wy - camPos.y, dz = wz - camPos.z
    const rx = viewMatrix[0] * dx + viewMatrix[1] * dy + viewMatrix[2] * dz
    const ry = viewMatrix[3] * dx + viewMatrix[4] * dy + viewMatrix[5] * dz
    const rz = viewMatrix[6] * dx + viewMatrix[7] * dy + viewMatrix[8] * dz
    if (rz <= 0.1) return null
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

  // ── Terrain tiles ──
  const terrainLayer = map.layers.find(l => l.type === 'terrain')
  if (terrainLayer?.terrainTiles) {
    const tiles = terrainLayer.terrainTiles
    for (let ty = 0; ty < tiles.length; ty++) {
      for (let tx = 0; tx < tiles[ty].length; tx++) {
        const tileId = tiles[ty][tx]
        const baseColor = TERRAIN_COLORS[tileId] ?? 0x808080
        const x0 = tx * ts, z0 = ty * ts
        const corners = [
          project(x0, 0, z0),
          project(x0 + ts, 0, z0),
          project(x0 + ts, 0, z0 + ts),
          project(x0, 0, z0 + ts),
        ]
        if (corners.some(c => c === null)) continue
        const validCorners = corners as Projected[]
        const avgDepth = validCorners.reduce((s, c) => s + c.depth, 0) / 4
        const litColor = shadeFace(baseColor, 0, 1, 0, lighting)
        const foggedColor = applyFog(litColor, avgDepth, lighting)

        drawables.push({
          depth: avgDepth,
          draw: (ctx) => drawPoly(ctx, validCorners, hexToCSS(foggedColor))
        })
      }
    }
  }

  // ── Buildings (structures) ──
  const structureLayer = map.layers.find(l => l.type === 'structure')
  if (structureLayer) {
    for (const obj of structureLayer.objects) {
      const def = defMap.get(obj.definitionId)
      if (!def) continue
      addBuildingDrawables(drawables, obj, def, ts, palettes, camPos, project, lighting)
    }
  }

  // ── Props ──
  const propLayer = map.layers.find(l => l.type === 'prop')
  if (propLayer) {
    for (const obj of propLayer.objects) {
      const def = defMap.get(obj.definitionId)
      if (!def) continue
      addPropDrawables(drawables, obj, def, ts, project, lighting)
    }
  }

  // Sort back-to-front (painter's algorithm)
  drawables.sort((a, b) => b.depth - a.depth)

  // Draw all
  for (const d of drawables) d.draw(ctx)

  return ctx.getImageData(0, 0, W, H)
}

// ── Building drawing ──

function addBuildingDrawables(
  drawables: Drawable[], obj: PlacedObject, def: ObjectDefinition,
  ts: number, palettes: { wall: number; roof: number; door: number }[],
  camPos: Vec3,
  project: (x: number, y: number, z: number) => Projected | null,
  lighting: Lighting
) {
  const hash = simpleHash(obj.id)
  const palette = palettes[hash % palettes.length]
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
  const showFront = camPos.z < centerZ
  const showRight = camPos.x > centerX
  const showLeft = camPos.x < centerX
  const showBack = camPos.z > centerZ

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
              ctx.fillRect(wx - winW / 2, wy - winH / 2, winW, winH)
              // Window frame / shutters
              if (!isLit && faceW > 10) {
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
            ctx.fillRect(doorX - doorW / 2, doorY - doorH, doorW, doorH)
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

function addPropDrawables(
  drawables: Drawable[], obj: PlacedObject, def: ObjectDefinition,
  ts: number,
  project: (x: number, y: number, z: number) => Projected | null,
  lighting: Lighting
) {
  const cx = (obj.x + def.footprint.w / 2) * ts
  const cz = (obj.y + def.footprint.h / 2) * ts
  const colors = PROP_COLORS[def.id] || { body: parseInt(def.color.replace('#', ''), 16) || 0x808080 }

  const base = project(cx, 0, cz)
  const top = project(cx, ts * 0.6, cz)
  if (!base || !top) return

  const bodyColor = shadeFace(colors.body, 0, 1, 0, lighting)
  const foggedBody = applyFog(bodyColor, base.depth, lighting)

  if (def.id === 'tree') {
    const trunkTop = project(cx, ts * 0.5, cz)
    const canopyTop = project(cx, ts * 1.2, cz)
    if (!trunkTop || !canopyTop) return

    // Trunk
    const accentColor = shadeFace(colors.accent!, 0, 1, 0, lighting)
    const foggedAccent = applyFog(accentColor, base.depth, lighting)
    const trunkW = Math.max(2, (trunkTop.sx - base.sx) * 0.05 + 3)

    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - trunkW / 2, trunkTop.sy, trunkW, base.sy - trunkTop.sy)
        // Canopy circle
        const r = Math.max(4, Math.abs(canopyTop.sy - trunkTop.sy) * 0.7)
        ctx.fillStyle = hexToCSS(foggedAccent)
        ctx.beginPath()
        ctx.arc(trunkTop.sx, trunkTop.sy - r * 0.3, r, 0, Math.PI * 2)
        ctx.fill()
      }
    })
  } else if (def.id === 'bush' || def.id === 'hedge') {
    const bushR = Math.max(3, Math.abs(top.sy - base.sy) * 0.5 + 3)
    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.15)'
        ctx.beginPath()
        ctx.ellipse(base.sx + 1, base.sy, bushR, bushR * 0.4, 0, 0, Math.PI * 2)
        ctx.fill()
        // Bush body
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.beginPath()
        ctx.ellipse(base.sx, base.sy - bushR * 0.3, bushR, bushR * 0.7, 0, 0, Math.PI * 2)
        ctx.fill()
      }
    })
  } else if (def.id === 'lamppost' || def.id === 'double_lamp' || def.id === 'wall_lantern') {
    const lampTop = project(cx, ts * 1.1, cz)
    if (!lampTop) return
    const poleW = Math.max(1, 2)

    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - poleW / 2, lampTop.sy, poleW, base.sy - lampTop.sy)
        // Lamp glow — larger and brighter at night
        const isLit = lighting.isNight || lighting.isDusk
        const glowColor = applyFog(colors.accent || 0xffdd44, base.depth, lighting)
        ctx.fillStyle = hexToCSS(glowColor)
        const r = isLit ? Math.max(5, Math.abs(lampTop.sy - base.sy) * 0.25) : Math.max(2, Math.abs(lampTop.sy - base.sy) * 0.1)
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
    const topH = project(cx, ts * 0.5, cz)
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
        ctx.fillRect(base.sx + 1, base.sy - signH * 1.1, 5, signH * 0.5)
        ctx.strokeStyle = hexToCSS(darken(foggedBody, 0.3))
        ctx.lineWidth = 0.5
        ctx.strokeRect(base.sx + 1, base.sy - signH * 1.1, 5, signH * 0.5)
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
        // Goods on counter
        ctx.fillStyle = hexToCSS(accentFogged)
        for (let i = 0; i < 3; i++) {
          ctx.fillRect(base.sx - msW * 0.3 + i * msW * 0.2, base.sy - msH * 0.42, msW * 0.12, msH * 0.07)
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
          ctx.fillRect(cx - 1.5, lineY + 1, 3, 3 + i * 0.5)
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

// ── View matrix (camera look-at) ──

function buildViewMatrix(eye: Vec3, target: Vec3): number[] {
  // Forward direction
  let fx = target.x - eye.x, fy = target.y - eye.y, fz = target.z - eye.z
  const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1
  fx /= fLen; fy /= fLen; fz /= fLen

  // Right = forward × up, where up = (0, 1, 0)
  // cross(f, u) = (fy*0 - fz*1, fz*0 - fx*0, fx*1 - fy*0) = (-fz, 0, fx)
  let rx = -fz, rz = fx
  const rLen = Math.sqrt(rx * rx + rz * rz) || 1
  rx /= rLen; rz /= rLen
  const ry = 0

  // True up = right × forward
  const ux = ry * fz - rz * fy
  const uy = rz * fx - rx * fz
  const uz = rx * fy - ry * fx

  // View matrix rows (transposed rotation)
  return [
    rx, ry, rz,   // right
    ux, uy, uz,   // up
    -fx, -fy, -fz // forward (negated — camera looks along -Z)
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

function hexToCSS(color: number): string {
  return '#' + ((color >> 16) & 0xff).toString(16).padStart(2, '0')
    + ((color >> 8) & 0xff).toString(16).padStart(2, '0')
    + (color & 0xff).toString(16).padStart(2, '0')
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
