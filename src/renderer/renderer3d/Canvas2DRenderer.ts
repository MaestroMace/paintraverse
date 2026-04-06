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
  { wall: 0x9e8b76, roof: 0x8b4513, door: 0x4a3520 },
  { wall: 0xa09080, roof: 0x6b3a2a, door: 0x3a2a1a },
  { wall: 0xb8a898, roof: 0x7a4a3a, door: 0x5a4030 },
  { wall: 0x8a7a6a, roof: 0x5a3020, door: 0x4a3020 },
  { wall: 0xc8b8a0, roof: 0x8a5a40, door: 0x6a4a30 },
  { wall: 0x7a8a7a, roof: 0x4a6a4a, door: 0x3a4a3a },
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
  const height = ts * (1.2 + (hash % 3) * 0.4) // 1.2 to 2.0 tiles tall
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

  // Top face (always visible from above)
  const topColor = shadeFace(palette.roof, 0, 1, 0, lighting)
  const topFogged = applyFog(topColor, avgDepth, lighting)
  drawables.push({
    depth: avgDepth - 0.01, // draw slightly after walls
    draw: (ctx) => {
      ctx.fillStyle = hexToCSS(topFogged)
      ctx.beginPath()
      ctx.moveTo(pp[4].sx, pp[4].sy)
      ctx.lineTo(pp[5].sx, pp[5].sy)
      ctx.lineTo(pp[6].sx, pp[6].sy)
      ctx.lineTo(pp[7].sx, pp[7].sy)
      ctx.closePath()
      ctx.fill()
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
        const isNight = lighting.skyColor === 0x0c0a20
        if (isNight) {
          const winColor = '#ffcc66'
          const winW = (facePoints[1].sx - facePoints[0].sx) * 0.12
          const winH = (facePoints[0].sy - facePoints[3].sy) * 0.12
          for (let row = 0; row < 2; row++) {
            for (let col = 0; col < 2; col++) {
              const t = 0.25 + col * 0.5
              const u = 0.3 + row * 0.35
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

  // Shadow on ground
  const shadowColor = 'rgba(0,0,0,0.12)'
  drawables.push({
    depth: avgDepth + 0.02,
    draw: (ctx) => {
      ctx.fillStyle = shadowColor
      ctx.beginPath()
      ctx.moveTo(pp[0].sx, pp[0].sy)
      ctx.lineTo(pp[1].sx, pp[1].sy)
      ctx.lineTo(pp[2].sx, pp[2].sy)
      ctx.lineTo(pp[3].sx, pp[3].sy)
      ctx.closePath()
      ctx.fill()
    }
  })
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
  } else if (def.id === 'lamppost' || def.id === 'double_lamp' || def.id === 'wall_lantern') {
    const lampTop = project(cx, ts * 1.1, cz)
    if (!lampTop) return
    const poleW = Math.max(1, 2)

    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - poleW / 2, lampTop.sy, poleW, base.sy - lampTop.sy)
        // Lamp glow
        const glowColor = applyFog(colors.accent || 0xffdd44, base.depth, lighting)
        ctx.fillStyle = hexToCSS(glowColor)
        const r = Math.max(3, Math.abs(lampTop.sy - base.sy) * 0.15)
        ctx.beginPath()
        ctx.arc(base.sx, lampTop.sy, r, 0, Math.PI * 2)
        ctx.fill()
      }
    })
  } else {
    // Generic prop: colored rectangle
    const hw = Math.max(3, Math.abs(top.sx - base.sx) * 0.3 + def.footprint.w * 4)
    const hh = Math.max(3, Math.abs(top.sy - base.sy) || 6)

    drawables.push({
      depth: base.depth,
      draw: (ctx) => {
        ctx.fillStyle = hexToCSS(foggedBody)
        ctx.fillRect(base.sx - hw / 2, base.sy - hh, hw, hh)
      }
    })
  }
}

// ── View matrix (camera look-at) ──

function buildViewMatrix(eye: Vec3, target: Vec3): number[] {
  // Forward direction (camera looks along -Z in camera space)
  let fx = target.x - eye.x, fy = target.y - eye.y, fz = target.z - eye.z
  const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1
  fx /= fLen; fy /= fLen; fz /= fLen

  // Right = forward × up (up = 0,1,0)
  let rx = fy * 0 - fz * 1 // simplified cross with (0,1,0)... wait
  // cross(forward, up) where up = (0,1,0)
  rx = fz; const ry = 0; let rz = -fx
  const rLen = Math.sqrt(rx * rx + rz * rz) || 1
  rx /= rLen; rz /= rLen

  // True up = right × forward
  const ux = ry * fz - rz * fy // simplified since ry=0
  const uy = rz * fx - rx * fz
  const uz = rx * fy - ry * fx

  // View matrix rows (transposed rotation)
  return [
    rx, ry, rz,   // right
    ux, uy, uz,   // up
    -fx, -fy, -fz // forward (negated because camera looks along -Z)
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
  const sdx = Math.cos(sunAngleRad), sdy = 0.7, sdz = Math.sin(sunAngleRad)
  const sdLen = Math.sqrt(sdx * sdx + sdy * sdy + sdz * sdz)

  const ar = ((ambientColor >> 16) & 0xff) / 255 * ambientIntensity
  const ag = ((ambientColor >> 8) & 0xff) / 255 * ambientIntensity
  const ab = (ambientColor & 0xff) / 255 * ambientIntensity

  const sr = ((sunColor >> 16) & 0xff) / 255 * sunIntensity
  const sg = ((sunColor >> 8) & 0xff) / 255 * sunIntensity
  const sb = (sunColor & 0xff) / 255 * sunIntensity

  const isNight = t < 5 || t >= 19
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
