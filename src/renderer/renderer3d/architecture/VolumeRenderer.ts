/**
 * VolumeRenderer — emits the geometry for one Volume.
 *
 * Walls: one textured Mesh per volume (BoxGeometry or CylinderGeometry) that
 * goes into the wallMeshes array (not batched) so it can carry the facade
 * material with its emissive window map.
 *
 * Roof: one BufferGeometry per volume pushed into the shared roofBatch with
 * the volume's roofColor baked as vertex color.
 *
 * Cornice: emitted into the ornamentBatch when volume.cornice is true.
 */

import * as THREE from 'three'
import type { Volume } from './Massing'
import { buildRoof } from './Roofs'
import type { BatchedMeshBuilder } from '../BatchedMeshBuilder'
import { emitDormer } from './Ornaments'
import type { FacadeConfig } from '../FacadeTexture'
import { createFacadeTexture, createEmissiveTexture } from '../FacadeTexture'

function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

/** Shift a color's RGB components by a signed [-1,1] amount per channel. */
function shiftColor(color: number, dR: number, dG: number, dB: number): number {
  const r = Math.max(0, Math.min(255, ((color >> 16) & 0xff) + Math.round(dR * 255)))
  const g = Math.max(0, Math.min(255, ((color >> 8) & 0xff) + Math.round(dG * 255)))
  const b = Math.max(0, Math.min(255, (color & 0xff) + Math.round(dB * 255)))
  return (r << 16) | (g << 8) | b
}

/** Cached facade materials keyed by FacadeConfig tuple. */
const _wallMatCache = new Map<string, THREE.MeshLambertMaterial>()
const _plainMatCache = new Map<number, THREE.MeshLambertMaterial>()

function facadeKey(cfg: FacadeConfig): string {
  return `${cfg.floors}_${cfg.width}_${cfg.wallColor.toString(16)}_${cfg.hasTimber}_${cfg.hasShutters}_${cfg.hasFlowerBox}_${cfg.style}`
}

/** Per-material flicker phase so each building's windows flicker on its
 *  own schedule. Stored in userData so it survives cache lookups. */
interface FlickerState {
  flickerPhase: number
  flickerRate: number
}
function ensureFlickerState(mat: THREE.Material): FlickerState {
  const d = (mat.userData as Partial<FlickerState>)
  if (typeof d.flickerPhase !== 'number') {
    d.flickerPhase = Math.random() * Math.PI * 2
    // Slow flame-breath rate (0.25–0.7 Hz). The previous 2.2–4.4 Hz was
    // strobing visibly rather than reading as firelight.
    d.flickerRate = 0.25 + Math.random() * 0.45
  }
  return d as FlickerState
}

function getFacadeMat(cfg: FacadeConfig): THREE.MeshLambertMaterial {
  const key = facadeKey(cfg)
  let mat = _wallMatCache.get(key)
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({
      map: createFacadeTexture(cfg, 'front'),
      emissiveMap: createEmissiveTexture(cfg),
      emissive: 0xffffff,
      emissiveIntensity: 0,
      flatShading: true,
    })
    ensureFlickerState(mat)
    _wallMatCache.set(key, mat)
  }
  return mat
}

function getPlainMat(wallColor: number): THREE.MeshLambertMaterial {
  let mat = _plainMatCache.get(wallColor)
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({ color: wallColor, flatShading: true })
    _plainMatCache.set(wallColor, mat)
  }
  return mat
}

/** Current *base* intensity the updateLighting path wants. Actual material
 *  intensity = base * flickerMultiplier(time), applied per-frame from
 *  tickWallEmissive. Stored at module level so the tick function doesn't
 *  need a second argument every frame. */
let _wallEmissiveBase = 0
/** Dirty flag: set when base changes; cleared when we've zeroed all
 *  materials (i.e. no work left at noon). Saves the per-material loop
 *  during steady-state noon frames. */
let _wallEmissiveDirty = false

/** Set the base emissive intensity (0..2-ish). Called from updateLighting
 *  on time-of-day change. The per-frame tick multiplies this by a small
 *  per-material flicker oscillation. */
export function setWallEmissiveIntensity(intensity: number): void {
  if (intensity === _wallEmissiveBase) return
  _wallEmissiveBase = intensity
  _wallEmissiveDirty = true
  for (const mat of _wallMatCache.values()) {
    mat.emissiveIntensity = intensity
  }
}

/** Per-frame driver — applies a subtle candle-flicker oscillation to each
 *  facade material's emissive intensity. Time argument is the frame's
 *  seconds-since-start so phases advance continuously. Amplitude is
 *  deliberately small (±4%) so it reads as firelight breathing, not strobe. */
export function tickWallEmissive(time: number): void {
  if (_wallEmissiveBase <= 0) {
    // Noon / no-glow — only zero materials if the base JUST became 0
    // (i.e. the dirty flag is still set). Steady-state noon = zero work.
    if (_wallEmissiveDirty) {
      for (const mat of _wallMatCache.values()) mat.emissiveIntensity = 0
      _wallEmissiveDirty = false
    }
    return
  }
  for (const mat of _wallMatCache.values()) {
    const fs = ensureFlickerState(mat)
    const flicker = 1 + 0.04 * Math.sin(time * fs.flickerRate + fs.flickerPhase)
    mat.emissiveIntensity = _wallEmissiveBase * flicker
  }
}

export interface EmitVolumeContext {
  /** Building's placed world center (XZ). */
  centerX: number
  centerZ: number
  /** Building's base Y (terrain + elevation). */
  baseY: number
  /** Hash-seeded per-building texture options (timber/shutters/flower/style). */
  hasTimber: boolean
  hasShutters: boolean
  hasFlowerBox: boolean
  style: string
  palette: { wall: number; roof: number; door: number }
  /** Y-rotation of the building in radians. 0 = axis-aligned. Non-zero rotates
   *  the entire building around its XZ center; individual volumes stay defined
   *  in the building's local frame (offsetX/Z are the volume's position relative
   *  to building center before rotation). */
  rotationY: number
  /** Stable hash of the building id (for randomized ornament placement). */
  hash: number
  /** Style-vector weather in [0,1] — drives color darkening / mossy tint. */
  weather: number
  /** If true, suppress fancy roof ornaments (dormer/finial) for this volume. */
  skipRoofOrnaments?: boolean
}

/**
 * Position a geometry built at local origin into world space, applying
 * the building's Y rotation around its center:
 *   1. translate by (lx, ly, lz) — local offset from building center
 *   2. rotate around local origin (= building center) by rot radians
 *   3. translate by (wx, wy, wz) — building center in world
 * This is the standard transform for rotating the whole building as a unit
 * while each volume is still authored in the building's local frame.
 */
function localToWorld(
  geo: THREE.BufferGeometry,
  lx: number, ly: number, lz: number,
  rot: number,
  wx: number, wy: number, wz: number,
): void {
  geo.translate(lx, ly, lz)
  if (rot !== 0) geo.rotateY(rot)
  geo.translate(wx, wy, wz)
}

/**
 * Apply weathering to a color: darken by up to 25%, and at high weather
 * shift slightly toward a dim moss green for organic decay feel.
 */
function weatheredColor(color: number, weather: number): number {
  if (weather <= 0.05) return color
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  // Darken uniformly.
  const darken = 1 - Math.min(0.28, weather * 0.32)
  let nr = r * darken
  let ng = g * darken
  let nb = b * darken
  // High-weather mossy tint: bias g, pull b down slightly.
  if (weather > 0.55) {
    const t = (weather - 0.55) * 0.7
    ng = ng * (1 - t * 0.1) + 60 * t
    nb = nb * (1 - t * 0.15)
  }
  return ((Math.min(255, Math.max(0, Math.round(nr))) << 16) |
          (Math.min(255, Math.max(0, Math.round(ng))) << 8) |
          (Math.min(255, Math.max(0, Math.round(nb)))))
}

export function emitVolume(
  v: Volume,
  ctx: EmitVolumeContext,
  wallMeshes: THREE.Mesh[],
  roofBatch: BatchedMeshBuilder,
  ornamentBatch: BatchedMeshBuilder,
): void {
  const rot = ctx.rotationY ?? 0
  // Volume position in BUILDING LOCAL frame (offsets from building center):
  const lx = v.offsetX
  const lz = v.offsetZ
  const ly = v.bottomY + v.height / 2
  // World center for this building (all local coords get rotated then translated here):
  const cx = ctx.centerX, cy = ctx.baseY, cz = ctx.centerZ
  const floors = Math.max(1, v.floors ?? Math.max(1, Math.round(v.height / 0.9)))

  const applyWeather = v.role !== 'chimneyVol'
  const wallColor = applyWeather ? weatheredColor(v.wallColor, ctx.weather) : v.wallColor
  const roofColor = applyWeather ? weatheredColor(v.roofColor, ctx.weather) : v.roofColor

  // Rotate an (lx, lz) pair into world XZ (used for world-positioned
  // individual meshes like walls, where the mesh transform itself holds the
  // rotation rather than baking it into geometry).
  const cR = Math.cos(rot), sR = Math.sin(rot)
  const worldX = cx + lx * cR - lz * sR
  const worldZ = cz + lx * sR + lz * cR

  // --- Walls --- (individual meshes; use mesh.position + mesh.rotation.y)
  if (v.circular) {
    // Cylinders are rotationally symmetric around Y — no rotation needed.
    const r = v.width / 2
    const geo = new THREE.CylinderGeometry(r, r * 1.02, v.height, 10)
    const mesh = new THREE.Mesh(geo, getPlainMat(wallColor))
    mesh.position.set(worldX, cy + ly, worldZ)
    mesh.castShadow = true
    mesh.receiveShadow = true
    wallMeshes.push(mesh)
  } else {
    const geo = new THREE.BoxGeometry(v.width, v.height, v.depth)
    let mesh: THREE.Mesh
    if (v.textured) {
      const cfg: FacadeConfig = {
        floors,
        width: Math.max(1, Math.round(v.width)),
        wallColor: v.wallColor,
        roofColor: v.roofColor,
        doorColor: ctx.palette.door,
        hasTimber: ctx.hasTimber,
        hasAwning: false,
        hasShutters: ctx.hasShutters,
        hasFlowerBox: ctx.hasFlowerBox,
        style: ctx.style,
      }
      const facadeMat = getFacadeMat(cfg)
      const plainMat = getPlainMat(wallColor)
      const mats = [plainMat, plainMat, plainMat, plainMat, facadeMat, facadeMat]
      mesh = new THREE.Mesh(geo, mats)
    } else {
      mesh = new THREE.Mesh(geo, getPlainMat(wallColor))
    }
    mesh.position.set(worldX, cy + ly, worldZ)
    mesh.rotation.y = rot
    mesh.castShadow = true
    mesh.receiveShadow = true
    wallMeshes.push(mesh)
  }

  // --- Stone base course --- wraps the (rotated) volume perimeter.
  if (!v.circular && v.role !== 'chimneyVol' && v.height > 0.9) {
    const baseH = Math.min(0.28, v.height * 0.18)
    const baseProj = 0.08
    const baseColor = shiftColor(wallColor, -0.12, -0.1, -0.08)
    // Each band is positioned in LOCAL space (relative to this volume's
    // center in the building's local frame), then rotated + translated
    // to world using localToWorld().
    const volLocalY = v.bottomY + baseH / 2  // Y in local frame

    const bFront = new THREE.BoxGeometry(v.width + baseProj * 2, baseH, baseProj)
    localToWorld(bFront, lx, volLocalY, lz + v.depth / 2 + baseProj / 2, rot, cx, cy, cz)
    ornamentBatch.addPositioned(bFront, baseColor)
    const bBack = new THREE.BoxGeometry(v.width + baseProj * 2, baseH, baseProj)
    localToWorld(bBack, lx, volLocalY, lz - v.depth / 2 - baseProj / 2, rot, cx, cy, cz)
    ornamentBatch.addPositioned(bBack, baseColor)
    const bLeft = new THREE.BoxGeometry(baseProj, baseH, v.depth)
    localToWorld(bLeft, lx - v.width / 2 - baseProj / 2, volLocalY, lz, rot, cx, cy, cz)
    ornamentBatch.addPositioned(bLeft, baseColor)
    const bRight = new THREE.BoxGeometry(baseProj, baseH, v.depth)
    localToWorld(bRight, lx + v.width / 2 + baseProj / 2, volLocalY, lz, rot, cx, cy, cz)
    ornamentBatch.addPositioned(bRight, baseColor)
  }

  // --- Roof ---
  const roofGeo = buildRoof(v.width, v.depth, v.roofHeight, v.roofStyle, v.roofAxis)
  if (roofGeo) {
    localToWorld(roofGeo, lx, v.bottomY + v.height, lz, rot, cx, cy, cz)
    roofBatch.addPositioned(roofGeo, roofColor)
  }

  // --- Cornice --- wraps the volume's top perimeter (rotated).
  if (v.cornice && !v.circular) {
    const heavy = v.role === 'tower' || v.role === 'spire'
    const projection = heavy ? 0.14 : 0.08
    const bandH = heavy ? 0.20 : 0.10
    const localTopY = v.bottomY + v.height - bandH
    const corniceY = localTopY + bandH / 2
    const cBands: THREE.BufferGeometry[] = [
      (() => {
        const g = new THREE.BoxGeometry(v.width + projection * 2, bandH, projection)
        localToWorld(g, lx, corniceY, lz + v.depth / 2 + projection / 2, rot, cx, cy, cz)
        return g
      })(),
      (() => {
        const g = new THREE.BoxGeometry(v.width + projection * 2, bandH, projection)
        localToWorld(g, lx, corniceY, lz - v.depth / 2 - projection / 2, rot, cx, cy, cz)
        return g
      })(),
      (() => {
        const g = new THREE.BoxGeometry(projection, bandH, v.depth)
        localToWorld(g, lx - v.width / 2 - projection / 2, corniceY, lz, rot, cx, cy, cz)
        return g
      })(),
      (() => {
        const g = new THREE.BoxGeometry(projection, bandH, v.depth)
        localToWorld(g, lx + v.width / 2 + projection / 2, corniceY, lz, rot, cx, cy, cz)
        return g
      })(),
    ]
    for (const g of cBands) ornamentBatch.addPositioned(g, wallColor)
  }

  // --- Roof ornaments (dormers, finials, ridge knobs) ---
  // Dormers/trim depend on axis-aligned face normals ('x+'/'z+'). When the
  // building is rotated, those face helpers would place ornaments in the
  // wrong world orientation. For Phase 1 of continuous rotation, skip the
  // non-trivial roof ornaments on rotated buildings. Finial ball/cross
  // centered on the volume works regardless — emitted here directly.
  if (!ctx.skipRoofOrnaments && rot === 0) {
    emitRoofOrnaments(v, worldX, worldZ, cy, ctx, wallColor, roofColor, roofBatch, ornamentBatch)
  } else if (v.roofStyle === 'spire' || v.roofStyle === 'pointed') {
    // Rotation-safe finial: just a ball (+ optional cross for spires) at
    // the volume's roof peak. Axis-symmetric, so rotation doesn't affect it.
    const peakLocalY = v.bottomY + v.height + v.roofHeight
    const ball = new THREE.SphereGeometry(v.roofStyle === 'spire' ? 0.18 : 0.14, 6, 4)
    const extra = v.roofStyle === 'spire' ? 0.16 : 0.12
    localToWorld(ball, lx, peakLocalY + extra, lz, rot, cx, cy, cz)
    ornamentBatch.addPositioned(ball, 0xd4c070)
    if (v.roofStyle === 'spire') {
      const armH = 0.3, armW = 0.25, armT = 0.05
      const v1 = new THREE.BoxGeometry(armT, armH, armT)
      localToWorld(v1, lx, peakLocalY + 0.28 + armH / 2, lz, rot, cx, cy, cz)
      ornamentBatch.addPositioned(v1, 0xd4c070)
      const h1 = new THREE.BoxGeometry(armW, armT, armT)
      localToWorld(h1, lx, peakLocalY + 0.28 + armH * 0.7, lz, rot, cx, cy, cz)
      ornamentBatch.addPositioned(h1, 0xd4c070)
    }
  }
}

/**
 * Emit roof features that read at render resolution: dormers on wide
 * gabled/hipped roofs, finials on spires, ridge knobs on steep pointed roofs.
 */
function emitRoofOrnaments(
  v: Volume,
  wx: number, wz: number, wy: number,
  ctx: EmitVolumeContext,
  wallColor: number, roofColor: number,
  roofBatch: BatchedMeshBuilder,
  ornamentBatch: BatchedMeshBuilder,
): void {
  const topOfWall = wy + v.height
  const h = ctx.hash + (v.role === 'tower' ? 1001 : v.role === 'spire' ? 2003 : 3007)

  // --- Dormers on gabled / steep / hipped roofs with sufficient footprint ---
  if (
    (v.roofStyle === 'gabled' || v.roofStyle === 'steep' || v.roofStyle === 'hipped') &&
    v.roofHeight > 0.35 &&
    Math.min(v.width, v.depth) >= 2.4 &&
    !v.circular &&
    rand01(h, 7) < 0.55
  ) {
    const dormerW = Math.min(0.95, v.width * 0.3)
    const dormerD = 0.35
    const dormerWallH = Math.min(0.45, v.roofHeight * 0.55)
    const dormerGableH = Math.min(0.3, v.roofHeight * 0.38)
    // Which face of the roof gets a dormer — pick the one perpendicular to
    // the ridge axis so the dormer has a proper gable.
    const dormerOnZ = v.roofAxis === 'x'
    // Walk along the ridge-parallel axis and try up to 2 positions.
    const count = rand01(h, 9) < 0.45 ? 2 : 1
    for (let i = 0; i < count; i++) {
      const tNorm = (i + 0.5) / count - 0.5 // -0.25 / 0.25 for count=2, 0 for count=1
      const jitter = (rand01(h, 11 + i) - 0.5) * 0.3
      const tAlong = tNorm + jitter
      const sideSign = i % 2 === 0 ? 1 : -1
      if (dormerOnZ) {
        emitDormer(
          ornamentBatch, sideSign > 0 ? 'z+' : 'z-',
          wx + tAlong * v.width, wz + sideSign * (v.depth / 2 - 0.35),
          topOfWall - 0.02,
          dormerW, dormerD, dormerWallH, dormerGableH,
          wallColor, roofColor,
        )
      } else {
        emitDormer(
          ornamentBatch, sideSign > 0 ? 'x+' : 'x-',
          wx + sideSign * (v.width / 2 - 0.35), wz + tAlong * v.depth,
          topOfWall - 0.02,
          dormerW, dormerD, dormerWallH, dormerGableH,
          wallColor, roofColor,
        )
      }
    }
  }

  // --- Finial on spires (cross for gothic, ball otherwise) ---
  if (v.roofStyle === 'spire' || v.roofStyle === 'pointed') {
    const peakY = topOfWall + v.roofHeight
    const ball = new THREE.SphereGeometry(v.roofStyle === 'spire' ? 0.18 : 0.14, 6, 4)
    ball.translate(wx, peakY + (v.roofStyle === 'spire' ? 0.16 : 0.12), wz)
    ornamentBatch.addPositioned(ball, 0xd4c070) // brass-ish

    if (v.roofStyle === 'spire' && rand01(h, 13) < 0.65) {
      // A small cross on top: two thin bars
      const armH = 0.3, armW = 0.25, armT = 0.05
      const vertical = new THREE.BoxGeometry(armT, armH, armT)
      vertical.translate(wx, peakY + 0.28 + armH / 2, wz)
      ornamentBatch.addPositioned(vertical, 0xd4c070)
      const horiz = new THREE.BoxGeometry(armW, armT, armT)
      horiz.translate(wx, peakY + 0.28 + armH * 0.7, wz)
      ornamentBatch.addPositioned(horiz, 0xd4c070)
    }
  }

  // --- Ridge knobs on steep roofs (small decorative bumps along ridge) ---
  if (
    v.roofStyle === 'steep' &&
    v.roofHeight > 0.5 &&
    Math.max(v.width, v.depth) >= 3 &&
    rand01(h, 15) < 0.4
  ) {
    const ridgeOnX = v.roofAxis === 'x'
    const ridgeLen = ridgeOnX ? v.width : v.depth
    const count = Math.min(4, Math.max(2, Math.floor(ridgeLen / 1.1)))
    for (let i = 0; i < count; i++) {
      const tAlong = (i + 0.5) / count - 0.5
      const px = wx + (ridgeOnX ? tAlong * v.width : 0)
      const pz = wz + (ridgeOnX ? 0 : tAlong * v.depth)
      const knob = new THREE.ConeGeometry(0.08, 0.22, 4)
      knob.translate(px, topOfWall + v.roofHeight + 0.11, pz)
      ornamentBatch.addPositioned(knob, roofColor)
    }
  }
}

