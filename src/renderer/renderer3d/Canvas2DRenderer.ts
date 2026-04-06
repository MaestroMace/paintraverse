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
  wagon: { body: 0x6b4a28 },
  well_grand: { body: 0x708090, accent: 0x4682b4 },
  fountain_grand: { body: 0x708090, accent: 0x4682b4 },
  double_lamp: { body: 0x2a2a2a, accent: 0xffdd44 },
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
}

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

  // Fill sky background
  ctx.fillStyle = hexToCSS(lighting.skyColor)
  ctx.fillRect(0, 0, W, H)

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
  const height = ts * (baseH + (hash % 3) * 0.15) // slight per-instance variation
  const x0 = obj.x * ts, z0 = obj.y * ts

  // 8 corners of the box
  const corners3D = [
    { x: x0, y: 0, z: z0 },           // 0: bottom-front-left
    { x: x0 + fw, y: 0, z: z0 },       // 1: bottom-front-right
    { x: x0 + fw, y: 0, z: z0 + fd },  // 2: bottom-back-right
    { x: x0, y: 0, z: z0 + fd },       // 3: bottom-back-left
    { x: x0, y: height, z: z0 },       // 4: top-front-left
    { x: x0 + fw, y: height, z: z0 },  // 5: top-front-right
    { x: x0 + fw, y: height, z: z0 + fd }, // 6: top-back-right
    { x: x0, y: height, z: z0 + fd },  // 7: top-back-left
  ]

  const projected = corners3D.map(c => project(c.x, c.y, c.z))
  if (projected.some(p => p === null)) return
  const pp = projected as Projected[]

  const centerX = x0 + fw / 2, centerZ = z0 + fd / 2
  const avgDepth = pp.reduce((s, p) => s + p.depth, 0) / 8

  // Determine which faces are visible from camera
  const showFront = camPos.z < centerZ  // camera is in front (smaller z)
  const showRight = camPos.x > centerX  // camera is to the right
  const showLeft = camPos.x < centerX
  const showBack = camPos.z > centerZ

  // Top face (always visible from above) — roof with ridge line
  const topColor = shadeFace(palette.roof, 0, 1, 0, lighting)
  const topFogged = applyFog(topColor, avgDepth, lighting)
  const ridgeColor = hexToCSS(darken(topFogged, 0.2))
  drawables.push({
    depth: avgDepth - 0.01,
    draw: (ctx) => {
      ctx.fillStyle = hexToCSS(topFogged)
      ctx.beginPath()
      ctx.moveTo(pp[4].sx, pp[4].sy)
      ctx.lineTo(pp[5].sx, pp[5].sy)
      ctx.lineTo(pp[6].sx, pp[6].sy)
      ctx.lineTo(pp[7].sx, pp[7].sy)
      ctx.closePath()
      ctx.fill()
      // Roof ridge line (front-to-back midpoint)
      const midFrontX = (pp[4].sx + pp[5].sx) / 2
      const midFrontY = (pp[4].sy + pp[5].sy) / 2
      const midBackX = (pp[7].sx + pp[6].sx) / 2
      const midBackY = (pp[7].sy + pp[6].sy) / 2
      ctx.strokeStyle = ridgeColor
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(midFrontX, midFrontY)
      ctx.lineTo(midBackX, midBackY)
      ctx.stroke()
    }
  })

  // Wall faces
  const wallFaces: { indices: number[]; nx: number; ny: number; nz: number }[] = []
  if (showFront) wallFaces.push({ indices: [0, 1, 5, 4], nx: 0, ny: 0, nz: -1 }) // front
  if (showBack) wallFaces.push({ indices: [2, 3, 7, 6], nx: 0, ny: 0, nz: 1 })   // back
  if (showRight) wallFaces.push({ indices: [1, 2, 6, 5], nx: 1, ny: 0, nz: 0 })   // right
  if (showLeft) wallFaces.push({ indices: [3, 0, 4, 7], nx: -1, ny: 0, nz: 0 })   // left

  for (const face of wallFaces) {
    const wallColor = shadeFace(palette.wall, face.nx, face.ny, face.nz, lighting)
    const wallFogged = applyFog(wallColor, avgDepth, lighting)
    const facePoints = face.indices.map(i => pp[i])
    drawables.push({
      depth: avgDepth,
      draw: (ctx) => {
        ctx.fillStyle = hexToCSS(wallFogged)
        ctx.beginPath()
        ctx.moveTo(facePoints[0].sx, facePoints[0].sy)
        for (let i = 1; i < facePoints.length; i++) ctx.lineTo(facePoints[i].sx, facePoints[i].sy)
        ctx.closePath()
        ctx.fill()

        // Draw windows on this face (2 rows of 2)
        const faceW = Math.abs(facePoints[1].sx - facePoints[0].sx)
        const faceH = Math.abs(facePoints[0].sy - facePoints[3].sy)
        if (faceW > 6 && faceH > 6) {
          const winW = faceW * 0.12
          const winH = faceH * 0.14
          const winColor = lighting.isNight || lighting.isDusk ? '#ffcc66' : hexToCSS(darken(wallFogged, 0.15))
          for (let row = 0; row < 2; row++) {
            for (let col = 0; col < 2; col++) {
              const t = 0.25 + col * 0.5
              const u = 0.25 + row * 0.35
              const wx = facePoints[0].sx + (facePoints[1].sx - facePoints[0].sx) * t
              const wy = facePoints[0].sy + (facePoints[3].sy - facePoints[0].sy) * u
              ctx.fillStyle = winColor
              ctx.fillRect(wx - winW / 2, wy - winH / 2, winW, winH)
            }
          }
        }
      }
    })
  }

  // Directional shadow — offset ground footprint in sun direction
  const shadowOffX = -lighting.sunDirX * height * 0.5
  const shadowOffZ = -lighting.sunDirZ * height * 0.5
  const s0 = project(x0 + shadowOffX, 0, z0 + shadowOffZ)
  const s1 = project(x0 + fw + shadowOffX, 0, z0 + shadowOffZ)
  const s2 = project(x0 + fw + shadowOffX, 0, z0 + fd + shadowOffZ)
  const s3 = project(x0 + shadowOffX, 0, z0 + fd + shadowOffZ)
  if (s0 && s1 && s2 && s3) {
    const shadowOpacity = lighting.isNight ? 0.15 : 0.35
    drawables.push({
      depth: avgDepth + 0.02,
      draw: (ctx) => {
        ctx.fillStyle = `rgba(0,0,0,${shadowOpacity})`
        ctx.beginPath()
        ctx.moveTo(s0.sx, s0.sy)
        ctx.lineTo(s1.sx, s1.sy)
        ctx.lineTo(s2.sx, s2.sy)
        ctx.lineTo(s3.sx, s3.sy)
        ctx.closePath()
        ctx.fill()
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
      }
    })
  } else {
    // Generic prop: colored rectangle with slight 3D effect
    const hw = Math.max(4, def.footprint.w * 5)
    const hh = Math.max(4, Math.abs(top.sy - base.sy) * 0.4 + 4)

    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
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
