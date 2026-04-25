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
  /** Lean angles (radians) — small (±0.06 max) tilts that pivot the entire
   *  building around its base. leanX rotates around the X axis (tipping the
   *  roofline forward/back along Z); leanZ rotates around the Z axis (tipping
   *  along X). Together they read as a building that has settled with age
   *  rather than the perfect-vertical "developer cube" silhouette. Applied
   *  BEFORE yaw so a leaning building still rotates cleanly. */
  leanX: number
  leanZ: number
  /** Stable hash of the building id (for randomized ornament placement). */
  hash: number
  /** Style-vector weather in [0,1] — drives color darkening / mossy tint. */
  weather: number
  /** If true, this is a stone-dominated building (noble/gothic/high stone
   *  axis). Drives the heavier two-tier base course at the wall foot. */
  stoneBased?: boolean
  /** If set, paint the ground floor band of textured walls in this color
   *  (instead of wallColor) — simulates a stone shop / foundation level
   *  under a timber/plaster upper structure. Only affects mainBody-class
   *  volumes that touch the ground (bottomY === 0). */
  groundFloorColor?: number
  /** If true, suppress fancy roof ornaments (dormer/finial) for this volume. */
  skipRoofOrnaments?: boolean
  /** Should this volume's wall meshes cast sun shadows. Defaults true if
   *  omitted. Short buildings opt out so they don't bloat the shadow pass
   *  with barely-visible contributions. */
  castsShadow?: boolean
}

/**
 * Position a geometry built at local origin into world space:
 *   1. translate by (lx, ly, lz) — local position from building base center
 *   2. rotate around local origin (= building base center) by leanX, leanZ —
 *      organic-age tilt; pivot is at ground level so the base stays planted
 *   3. rotate by rotY around local origin (yaw)
 *   4. translate by (wx, wy, wz) — building base center in world
 *
 * Leans pivot around the BASE not the volume center, so upper floors tip
 * more than lower floors — the geometric signature of a settled building.
 * Yaw is applied after lean; for the small leans we use (≤ ~3.4°) the
 * non-commutativity is invisible.
 */
export function localToWorld(
  geo: THREE.BufferGeometry,
  lx: number, ly: number, lz: number,
  leanX: number, leanZ: number, rotY: number,
  wx: number, wy: number, wz: number,
): void {
  geo.translate(lx, ly, lz)
  if (leanX !== 0) geo.rotateX(leanX)
  if (leanZ !== 0) geo.rotateZ(leanZ)
  if (rotY !== 0) geo.rotateY(rotY)
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
  const leanX = ctx.leanX ?? 0
  const leanZ = ctx.leanZ ?? 0
  // Volume position in BUILDING LOCAL frame (offsets from building base center):
  const lx = v.offsetX
  const lz = v.offsetZ
  // World center for this building's BASE (lean pivots around (cx, cy, cz)):
  const cx = ctx.centerX, cy = ctx.baseY, cz = ctx.centerZ
  const floors = Math.max(1, v.floors ?? Math.max(1, Math.round(v.height / 0.9)))

  const applyWeather = v.role !== 'chimneyVol'
  const wallColor = applyWeather ? weatheredColor(v.wallColor, ctx.weather) : v.wallColor
  const roofColor = applyWeather ? weatheredColor(v.roofColor, ctx.weather) : v.roofColor

  // --- Walls --- All transforms (lean, yaw, world position) baked into
  // geometry so coalesceWalls can merge cleanly and lean pivots around the
  // building base. Geometry is built at origin, then lifted so its base is at
  // local Y=0, then translated to (lx, bottomY, lz) before lean+yaw apply.
  if (v.circular) {
    const r = v.width / 2
    const geo = new THREE.CylinderGeometry(r, r * 1.02, v.height, 10)
    geo.translate(0, v.height / 2, 0)
    localToWorld(geo, lx, v.bottomY, lz, leanX, leanZ, rot, cx, cy, cz)
    const mesh = new THREE.Mesh(geo, getPlainMat(wallColor))
    mesh.castShadow = ctx.castsShadow !== false
    mesh.receiveShadow = true
    wallMeshes.push(mesh)
  } else {
    const geo = new THREE.BoxGeometry(v.width, v.height, v.depth)
    geo.translate(0, v.height / 2, 0)
    localToWorld(geo, lx, v.bottomY, lz, leanX, leanZ, rot, cx, cy, cz)
    let mesh: THREE.Mesh
    if (v.textured) {
      // Apply the contrasting ground-floor band only on volumes whose base
      // sits on the ground (bottomY ≈ 0). For stacked massing pieces (like
      // a step-back penthouse or a jettied upper floor), the volume's base
      // is mid-air — painting a "ground floor" band there would float
      // visually wrong.
      const groundFloorColor = ctx.groundFloorColor !== undefined && Math.abs(v.bottomY) < 0.1
        ? ctx.groundFloorColor
        : undefined
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
        groundFloorColor,
      }
      const facadeMat = getFacadeMat(cfg)
      const plainMat = getPlainMat(wallColor)
      const mats = [plainMat, plainMat, plainMat, plainMat, facadeMat, facadeMat]
      mesh = new THREE.Mesh(geo, mats)
    } else {
      mesh = new THREE.Mesh(geo, getPlainMat(wallColor))
    }
    mesh.castShadow = ctx.castsShadow !== false
    mesh.receiveShadow = true
    wallMeshes.push(mesh)
  }

  // --- Stone base course --- wraps the volume perimeter (lean+yaw applied).
  // Stone-dominated buildings get a heavier TWO-TIER base: a thicker, more
  // projecting plinth band at the bottom, then a slightly less-projecting
  // band on top — the classic "step-out" reading you see on noble town
  // halls and any building meant to read as monumental. Other buildings
  // keep the simple single band.
  if (!v.circular && v.role !== 'chimneyVol' && v.height > 0.9) {
    const wantsHeavyBase = !!ctx.stoneBased &&
      (v.role === 'mainBody' || v.role === 'tower' || v.role === 'transept') &&
      v.height > 1.6
    const baseH = wantsHeavyBase
      ? Math.min(0.36, v.height * 0.15)
      : Math.min(0.28, v.height * 0.18)
    const baseProj = wantsHeavyBase ? 0.16 : 0.08
    const baseColor = shiftColor(wallColor, -0.12, -0.1, -0.08)
    const volLocalY = v.bottomY + baseH / 2

    const bFront = new THREE.BoxGeometry(v.width + baseProj * 2, baseH, baseProj)
    localToWorld(bFront, lx, volLocalY, lz + v.depth / 2 + baseProj / 2, leanX, leanZ, rot, cx, cy, cz)
    ornamentBatch.addPositioned(bFront, baseColor)
    const bBack = new THREE.BoxGeometry(v.width + baseProj * 2, baseH, baseProj)
    localToWorld(bBack, lx, volLocalY, lz - v.depth / 2 - baseProj / 2, leanX, leanZ, rot, cx, cy, cz)
    ornamentBatch.addPositioned(bBack, baseColor)
    const bLeft = new THREE.BoxGeometry(baseProj, baseH, v.depth)
    localToWorld(bLeft, lx - v.width / 2 - baseProj / 2, volLocalY, lz, leanX, leanZ, rot, cx, cy, cz)
    ornamentBatch.addPositioned(bLeft, baseColor)
    const bRight = new THREE.BoxGeometry(baseProj, baseH, v.depth)
    localToWorld(bRight, lx + v.width / 2 + baseProj / 2, volLocalY, lz, leanX, leanZ, rot, cx, cy, cz)
    ornamentBatch.addPositioned(bRight, baseColor)

    // Second tier on stone buildings — sits ON the lower band, projects less,
    // creates the step-out silhouette.
    if (wantsHeavyBase) {
      const upperH = Math.min(0.22, v.height * 0.10)
      const upperProj = 0.09       // less than baseProj so we step IN
      const upperY = v.bottomY + baseH + upperH / 2
      const upperColor = shiftColor(wallColor, -0.07, -0.06, -0.05)
      const uFront = new THREE.BoxGeometry(v.width + upperProj * 2, upperH, upperProj)
      localToWorld(uFront, lx, upperY, lz + v.depth / 2 + upperProj / 2, leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(uFront, upperColor)
      const uBack = new THREE.BoxGeometry(v.width + upperProj * 2, upperH, upperProj)
      localToWorld(uBack, lx, upperY, lz - v.depth / 2 - upperProj / 2, leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(uBack, upperColor)
      const uLeft = new THREE.BoxGeometry(upperProj, upperH, v.depth)
      localToWorld(uLeft, lx - v.width / 2 - upperProj / 2, upperY, lz, leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(uLeft, upperColor)
      const uRight = new THREE.BoxGeometry(upperProj, upperH, v.depth)
      localToWorld(uRight, lx + v.width / 2 + upperProj / 2, upperY, lz, leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(uRight, upperColor)
    }
  }

  // --- Roof ---
  // Ridge sag on weathered gabled/steep roofs — the centuries-old beam that
  // settled in the middle. Only kicks in past weather=0.4; at weather=1.0
  // the ridge midpoint drops 8% of the roof height. Hipped/mansard/cone
  // styles ignore sag (different topology). Skipped on tall narrow towers
  // and tiny volumes where the sag would read as a manufacturing defect
  // rather than character.
  let roofSag = 0
  if ((v.roofStyle === 'gabled' || v.roofStyle === 'steep') &&
      ctx.weather > 0.4 && v.role !== 'spire' && v.role !== 'tower' &&
      Math.min(v.width, v.depth) >= 1.6 && v.roofHeight > 0.4) {
    roofSag = (ctx.weather - 0.4) * 0.13      // 0..0.078 of h
  }
  const roofGeo = buildRoof(v.width, v.depth, v.roofHeight, v.roofStyle, v.roofAxis, roofSag)
  if (roofGeo) {
    localToWorld(roofGeo, lx, v.bottomY + v.height, lz, leanX, leanZ, rot, cx, cy, cz)
    roofBatch.addPositioned(roofGeo, roofColor)
  }

  // --- Ridge cap --- thin clay band capping the roof ridge on prism-class
  // roofs. A subtle but UNIVERSAL silhouette tightener — every gabled or
  // hipped roof in a Traverse-Town reference shot has this. Color picks a
  // warm terracotta tinted by the roof color so each town has a coherent
  // ridge-cap palette without clashing.
  const isRidged = v.roofStyle === 'gabled' || v.roofStyle === 'steep' || v.roofStyle === 'hipped'
  if (isRidged && v.roofHeight > 0.3 && Math.min(v.width, v.depth) >= 1.2) {
    const ridgeOnX = v.roofAxis === 'x'
    let ridgeLen: number
    if (v.roofStyle === 'hipped') {
      // Hipped roof's ridge runs only between the two interior apex points.
      // Inset is min(hw, hd) * 0.25 (matches Roofs.ts buildGablePrism).
      const inset = Math.min(v.width, v.depth) / 2 * 0.25
      ridgeLen = (ridgeOnX ? v.width : v.depth) - 2 * inset
    } else {
      // Gabled/steep ridge spans the full eave-aligned length plus the eave
      // overhang on both ends.
      ridgeLen = (ridgeOnX ? v.width : v.depth) + 0.26 * 2
    }
    if (ridgeLen > 0.2) {
      const capH = 0.10, capW = 0.18
      // Tint: shift roof color toward warm terracotta. Picks up the local
      // palette so a slate-roofed temple gets a slate ridge cap and a
      // warm-tile cottage gets a warmer cap.
      const capColor = shiftColor(roofColor, 0.06, 0.02, -0.04)
      const ridgeY = v.bottomY + v.height + v.roofHeight + capH / 2 - 0.02
      const cap = ridgeOnX
        ? new THREE.BoxGeometry(ridgeLen, capH, capW)
        : new THREE.BoxGeometry(capW, capH, ridgeLen)
      localToWorld(cap, lx, ridgeY, lz, leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(cap, capColor)
    }
  }

  // --- Bargeboards --- decorative wood/stone trim along the gable edges
  // (the sloped edges where the gable wall meets the roof slope on a
  // gabled or steep roof). Reads as the painted edge-board on Tudor and
  // Traverse-Town gables. Two boards per gable end: one along each slope
  // edge from the eave corner up to the ridge peak. Placed slightly past
  // the gable face so they cap the roof's overhang at the gable end.
  if ((v.roofStyle === 'gabled' || v.roofStyle === 'steep') &&
      !v.circular && v.role !== 'chimneyVol' &&
      Math.min(v.width, v.depth) >= 1.4 && v.roofHeight > 0.4) {
    const ridgeOnX = v.roofAxis === 'x'
    // Gable ends sit at ±gableExtent along the ridge axis. The slope drops
    // from the ridge peak (height = h, mid of perp axis) down to the eave
    // corner (height = 0, perp = ±perpExtent + eave overhang).
    const gableExtent = (ridgeOnX ? v.width : v.depth) / 2
    const perpExtent = (ridgeOnX ? v.depth : v.width) / 2
    const eaveProj = 0.26
    const slopeRunPerp = perpExtent + eaveProj
    const slopeRiseY = v.roofHeight
    const slopeLen = Math.sqrt(slopeRunPerp * slopeRunPerp + slopeRiseY * slopeRiseY)
    const slopeAngle = Math.atan2(slopeRiseY, slopeRunPerp)  // angle from horizontal
    const boardThk = 0.05
    const boardW = 0.14
    const boardColor = 0x3a2818           // dark oak / weathered wood
    const wallTopY = v.bottomY + v.height
    // Place each gable end's two slope boards (one per slope side: +perp, -perp)
    for (const gableSign of [-1, 1] as const) {
      // Board sits just past the gable face — gableSign * (gableExtent + small).
      const gableLocalAxisVal = gableSign * (gableExtent + boardThk * 0.5)
      for (const slopeSign of [-1, 1] as const) {
        // Endpoints of this slope edge in local frame:
        //   eave corner: (gableLocalAxisVal, wallTopY, slopeSign * (perpExtent + eaveProj))   [if ridgeOnX]
        //   ridge peak:  (gableLocalAxisVal, wallTopY + slopeRiseY, 0)
        // Mid of slope:
        const midPerp = slopeSign * slopeRunPerp / 2
        const midY = wallTopY + slopeRiseY / 2
        // Build a thin board: Y axis is the board's "long" axis. We'll make
        // a box of (thickness, slopeLen, width) and rotate it around X (when
        // ridgeOnX) so it lies along the slope.
        // For ridgeOnX (slope is in YZ plane, varying perp=Z):
        //   Rotation about X by angle so that the box's local Y points along
        //   the slope direction. slope direction at slopeSign=+1: from
        //   (0, 0, perpExtent+eaveProj) to (0, slopeRiseY, 0). That's the
        //   vector (0, slopeRiseY, -(perpExtent+eaveProj)) after centering.
        //   The angle from +Y axis is +slopeAngle going toward -Z when
        //   slopeSign=+1, and toward +Z when slopeSign=-1.
        //   So rotateX by -slopeAngle * slopeSign.
        const board = new THREE.BoxGeometry(boardThk, slopeLen, boardW)
        if (ridgeOnX) {
          board.rotateX(-slopeAngle * slopeSign)
          // After rotation, the box's center sits at origin and its long
          // axis is tilted in YZ. Translate to the slope midpoint.
          localToWorld(board, lx + gableLocalAxisVal, midY, lz + midPerp,
            leanX, leanZ, rot, cx, cy, cz)
        } else {
          // ridgeOnZ: slope varies with X. Rotate around Z so the board's
          // long axis (Y) tilts in XY plane. slopeSign=+1 means slope goes
          // from (perpExtent+eaveProj, 0, 0) to (0, slopeRiseY, 0); angle
          // from +Y goes toward -X. rotateZ(+slopeAngle * slopeSign).
          board.rotateZ(slopeAngle * slopeSign)
          localToWorld(board, lx + midPerp, midY, lz + gableLocalAxisVal,
            leanX, leanZ, rot, cx, cy, cz)
        }
        ornamentBatch.addPositioned(board, boardColor)
      }
    }
  }

  // --- Eave brackets --- small wood pieces tucked under the eave overhang
  // along the LONG sides of gabled/steep prism roofs (the slope-eaves, not
  // the gable ends). Sells the 0.26m overhang as a structurally-supported
  // feature rather than a floating shelf. Hipped is excluded — its eaves
  // run on all four sides and our axis-pair emission would cover only two,
  // reading as an asymmetric defect. Mansard, pointed, dome, and spire
  // roofs skip — they have no straight eave run.
  const isBracketed = v.roofStyle === 'gabled' || v.roofStyle === 'steep'
  if (isBracketed && !v.circular && v.role !== 'chimneyVol' && v.height > 1.2) {
    const eaveProj = 0.26
    // Brackets along the eave-facing edges (perpendicular to the ridge).
    // For axis='x' gable, ridge runs along X — the eaves are at z=±depth/2.
    // For axis='z' gable, eaves are at x=±width/2.
    const ridgeOnX = v.roofAxis === 'x'
    const eaveLen = ridgeOnX ? v.width : v.depth
    if (eaveLen >= 1.6) {
      const brackPitch = 1.05                          // ~1m between brackets
      const brackCount = Math.max(2, Math.min(6, Math.floor(eaveLen / brackPitch)))
      const eaveTopY = v.bottomY + v.height           // brackets attach just below
      const brackH = 0.18, brackW = 0.06, brackD = eaveProj * 0.85
      // Color: dark wood for timber-ish styles, weathered stone for stone.
      const brackColor = ctx.stoneBased ? shiftColor(wallColor, -0.12, -0.10, -0.08) : 0x3a2418
      for (let i = 0; i < brackCount; i++) {
        const t = (i + 0.5) / brackCount - 0.5        // -0.5 .. +0.5
        for (const sideSign of [-1, 1] as const) {
          // Box dims: thin along the wall (brackW), tall (brackH), deep
          // perpendicular to wall (brackD). When ridge runs along Z the
          // long axis flips so brackD lands along X instead.
          const boxW = ridgeOnX ? brackW : brackD
          const boxD = ridgeOnX ? brackD : brackW
          const localX = ridgeOnX ? lx + t * eaveLen : lx + sideSign * (v.width / 2 + brackD / 2)
          const localZ = ridgeOnX ? lz + sideSign * (v.depth / 2 + brackD / 2) : lz + t * eaveLen
          const brackGeo = new THREE.BoxGeometry(boxW, brackH, boxD)
          localToWorld(brackGeo, localX, eaveTopY - brackH / 2 - 0.02, localZ,
            leanX, leanZ, rot, cx, cy, cz)
          ornamentBatch.addPositioned(brackGeo, brackColor)
        }
      }
    }
  }

  // --- Cornice --- wraps the volume's top perimeter (lean+yaw applied).
  if (v.cornice && !v.circular) {
    const heavy = v.role === 'tower' || v.role === 'spire'
    const projection = heavy ? 0.14 : 0.08
    const bandH = heavy ? 0.20 : 0.10
    const localTopY = v.bottomY + v.height - bandH
    const corniceY = localTopY + bandH / 2
    const cBands: THREE.BufferGeometry[] = [
      (() => {
        const g = new THREE.BoxGeometry(v.width + projection * 2, bandH, projection)
        localToWorld(g, lx, corniceY, lz + v.depth / 2 + projection / 2, leanX, leanZ, rot, cx, cy, cz)
        return g
      })(),
      (() => {
        const g = new THREE.BoxGeometry(v.width + projection * 2, bandH, projection)
        localToWorld(g, lx, corniceY, lz - v.depth / 2 - projection / 2, leanX, leanZ, rot, cx, cy, cz)
        return g
      })(),
      (() => {
        const g = new THREE.BoxGeometry(projection, bandH, v.depth)
        localToWorld(g, lx - v.width / 2 - projection / 2, corniceY, lz, leanX, leanZ, rot, cx, cy, cz)
        return g
      })(),
      (() => {
        const g = new THREE.BoxGeometry(projection, bandH, v.depth)
        localToWorld(g, lx + v.width / 2 + projection / 2, corniceY, lz, leanX, leanZ, rot, cx, cy, cz)
        return g
      })(),
    ]
    for (const g of cBands) ornamentBatch.addPositioned(g, wallColor)
  }

  // --- Window trim --- lintels + sills as actual geometry around the painted
  // windows on the FacadeTexture. The window grid here MIRRORS the layout in
  // FacadeTexture.createFacadeTexture: cols = max(1, floor(textureWidth*1.5)),
  // floor rows at 64px-pitch on a (floors*64+32)px-tall canvas. We compute
  // each window's local-frame position from those same parameters and project
  // a small lintel/sill from the wall.
  //
  // Gated to ground floor + front (+Z) face only. Every window trimmed on
  // every floor of every textured volume on both faces would be hundreds of
  // boxes per building — the merge build cost dominates. Ground-floor +Z is
  // the band the player sees walking past, where trim payoff is highest.
  if (
    v.textured && !v.circular &&
    v.role !== 'chimneyVol' &&
    v.width >= 1.4 && v.height >= 1.4 &&
    floors >= 1
  ) {
    const textureWidth = Math.max(1, Math.round(v.width))
    const cols = Math.max(1, Math.floor(textureWidth * 1.5))
    const canvasH = floors * 64 + 32
    // Window dimensions in canvas px → world:
    const winWworld = (v.width / textureWidth) * 0.22  // ≈ 0.22m for unit width
    const winHworld = (22.4 / canvasH) * v.height
    // Trim sizing
    const trimExtra = 0.10
    const lintelH = 0.06
    const sillH = 0.05
    const lintelProj = 0.05
    const sillProj = 0.08
    // Color: shifted lighter than wall (limestone trim over warmer wall).
    const trimColor = shiftColor(wallColor, 0.07, 0.06, 0.04)

    // Ground-floor window centers in canvas px:
    const floor = 0
    const floorYpx = canvasH - (floor + 1) * 64
    const winCenterCanvasY = floorYpx + 16 + 22.4 / 2  // 27.2 px below floor top
    const winLocalY = v.bottomY + v.height * (1 - winCenterCanvasY / canvasH)

    // Flowerbox dimensions (used per-window when hasFlowerBox + col is even).
    // These match the FacadeTexture's painted flowerbox at the bottom-edge of
    // ground-floor windows: a wood trough wider than the window with painted
    // flowers above. Geometry version projects forward and reads as a real
    // box from any angle.
    const fbW = winWworld + 0.16
    const fbH = 0.08
    const fbProj = 0.13
    const fbColor = 0x6a4a2a   // weathered wood

    for (let col = 0; col < cols; col++) {
      const winLocalX = lx + ((col + 1) / (cols + 1) - 0.5) * v.width
      // Front (+Z) face only.
      const faceLocalZ = lz + v.depth / 2
      // Lintel (above window)
      const lintelGeo = new THREE.BoxGeometry(winWworld + trimExtra, lintelH, lintelProj)
      localToWorld(lintelGeo,
        winLocalX,
        winLocalY + winHworld / 2 + lintelH / 2,
        faceLocalZ + lintelProj / 2,
        leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(lintelGeo, trimColor)
      // Sill (below window) — projects more than the lintel.
      const sillGeo = new THREE.BoxGeometry(winWworld + trimExtra * 1.2, sillH, sillProj)
      localToWorld(sillGeo,
        winLocalX,
        winLocalY - winHworld / 2 - sillH / 2,
        faceLocalZ + sillProj / 2,
        leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(sillGeo, trimColor)

      // Flowerbox below the window when the building's painted-flowerbox
      // flag is set. Same gating as FacadeTexture: every other column.
      // Sits just under the sill so they read as one unit.
      if (ctx.hasFlowerBox && col % 2 === 0) {
        const fbCenterY = winLocalY - winHworld / 2 - sillH - fbH / 2
        const fb = new THREE.BoxGeometry(fbW, fbH, fbProj)
        localToWorld(fb,
          winLocalX,
          fbCenterY,
          faceLocalZ + fbProj / 2,
          leanX, leanZ, rot, cx, cy, cz)
        ornamentBatch.addPositioned(fb, fbColor)
        // Three small flower clusters as tiny spheres along the front edge.
        // Picks deterministically from a warm flower palette via hash + col.
        const flowerColors = [0xc25a78, 0xd99744, 0xa074bc, 0xd44848, 0xb8c454]
        for (let fi = 0; fi < 3; fi++) {
          const fx = winLocalX + (fi - 1) * (fbW * 0.28)
          const fy = fbCenterY + fbH / 2 + 0.04
          const fz = faceLocalZ + fbProj * 0.85
          const flower = new THREE.SphereGeometry(0.05, 4, 3)
          localToWorld(flower, fx, fy, fz, leanX, leanZ, rot, cx, cy, cz)
          const fc = flowerColors[(ctx.hash + col * 7 + fi * 3) % flowerColors.length]
          ornamentBatch.addPositioned(flower, fc)
        }
      }
    }
  }

  // --- Roof ornaments (dormers, finials, ridge knobs) ---
  // Dormers/trim depend on axis-aligned face normals ('x+'/'z+'). When the
  // building is rotated/leaned, those face helpers would place ornaments in
  // the wrong world orientation. Skip the non-trivial roof ornaments on
  // rotated/leaned buildings. Finial ball/cross at the peak still works.
  const isAxisAligned = rot === 0 && leanX === 0 && leanZ === 0
  if (!ctx.skipRoofOrnaments && isAxisAligned) {
    emitRoofOrnaments(v, cx + lx, cz + lz, cy, ctx, wallColor, roofColor, roofBatch, ornamentBatch)
  } else if (v.roofStyle === 'spire' || v.roofStyle === 'pointed') {
    // Rotation+lean-safe finial: ball (+ optional cross) at the volume's
    // roof peak. Axis-symmetric, so transforms don't affect its appearance.
    const peakLocalY = v.bottomY + v.height + v.roofHeight
    const ball = new THREE.SphereGeometry(v.roofStyle === 'spire' ? 0.18 : 0.14, 6, 4)
    const extra = v.roofStyle === 'spire' ? 0.16 : 0.12
    localToWorld(ball, lx, peakLocalY + extra, lz, leanX, leanZ, rot, cx, cy, cz)
    ornamentBatch.addPositioned(ball, 0xd4c070)
    if (v.roofStyle === 'spire') {
      const armH = 0.3, armW = 0.25, armT = 0.05
      const v1 = new THREE.BoxGeometry(armT, armH, armT)
      localToWorld(v1, lx, peakLocalY + 0.28 + armH / 2, lz, leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(v1, 0xd4c070)
      const h1 = new THREE.BoxGeometry(armW, armT, armT)
      localToWorld(h1, lx, peakLocalY + 0.28 + armH * 0.7, lz, leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(h1, 0xd4c070)
    }
    // Weather vane — silhouette punch at the very top of the skyline.
    // Always on spires; sometimes on tall pointed towers.
    const vaneRoll = ((ctx.hash * 2654435761 + 1313 * 1597334677) >>> 0) / 0xffffffff
    const wantsVane = v.roofStyle === 'spire' ||
      (v.role === 'tower' && v.roofHeight > 1.0 && vaneRoll < 0.5)
    if (wantsVane) {
      // Vane sits above the cross/ball. Pole + arrow body + compass cross-arms.
      const vaneBaseY = peakLocalY + (v.roofStyle === 'spire' ? 0.65 : 0.30)
      const poleH = 0.42, poleT = 0.035
      const pole = new THREE.BoxGeometry(poleT, poleH, poleT)
      localToWorld(pole, lx, vaneBaseY + poleH / 2, lz, leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(pole, 0xb89858)         // brass
      // Compass cross-arms: four thin horizontal boxes at the lower-mid of the
      // pole, pointing N/S (x) and E/W (z). Tiny balls at the ends.
      const armY = vaneBaseY + poleH * 0.45
      const armLen = 0.34, armT2 = 0.025
      // North-South arm
      const armNS = new THREE.BoxGeometry(armT2, armT2, armLen)
      localToWorld(armNS, lx, armY, lz, leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(armNS, 0xb89858)
      // East-West arm
      const armEW = new THREE.BoxGeometry(armLen, armT2, armT2)
      localToWorld(armEW, lx, armY, lz, leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(armEW, 0xb89858)
      // Cardinal point balls — tiny spheres at the four ends.
      for (const [dx, dz] of [[armLen / 2, 0], [-armLen / 2, 0], [0, armLen / 2], [0, -armLen / 2]] as const) {
        const ballMark = new THREE.SphereGeometry(0.045, 4, 3)
        localToWorld(ballMark, lx + dx, armY, lz + dz, leanX, leanZ, rot, cx, cy, cz)
        ornamentBatch.addPositioned(ballMark, 0xb89858)
      }
      // Arrow body — long horizontal box at the TOP of the pole, oriented
      // by the hash so each spire's arrow points at a different "wind."
      const arrowAngle = vaneRoll * Math.PI * 2
      const arrowLen = 0.55, arrowH = 0.06, arrowT = 0.04
      const arrow = new THREE.BoxGeometry(arrowLen, arrowH, arrowT)
      arrow.rotateY(arrowAngle)
      localToWorld(arrow, lx, vaneBaseY + poleH + arrowH / 2, lz,
        leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(arrow, 0x4a3a2a)        // dark iron
      // Arrowhead — a small flat triangle / plate at one end of the arrow.
      // Simulate with a slightly wider thin box at the +X end of the arrow
      // (post-rotation it's wherever the arrow points).
      const headW = 0.10, headH = 0.16
      const head = new THREE.BoxGeometry(headW, headH, arrowT * 1.2)
      head.translate(arrowLen / 2 - headW / 2, 0, 0)
      head.rotateY(arrowAngle)
      localToWorld(head, lx, vaneBaseY + poleH + arrowH / 2, lz,
        leanX, leanZ, rot, cx, cy, cz)
      ornamentBatch.addPositioned(head, 0x4a3a2a)
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

    // Weather vane atop the cross/ball — silhouette punch at the skyline.
    const vaneRoll = rand01(h, 1313)
    const wantsVane = v.roofStyle === 'spire' ||
      (v.role === 'tower' && v.roofHeight > 1.0 && vaneRoll < 0.5)
    if (wantsVane) {
      const vaneBaseY = peakY + (v.roofStyle === 'spire' ? 0.65 : 0.30)
      const poleH = 0.42, poleT = 0.035
      const pole = new THREE.BoxGeometry(poleT, poleH, poleT)
      pole.translate(wx, vaneBaseY + poleH / 2, wz)
      ornamentBatch.addPositioned(pole, 0xb89858)
      const armY = vaneBaseY + poleH * 0.45
      const armLen = 0.34, armT2 = 0.025
      const armNS = new THREE.BoxGeometry(armT2, armT2, armLen)
      armNS.translate(wx, armY, wz)
      ornamentBatch.addPositioned(armNS, 0xb89858)
      const armEW = new THREE.BoxGeometry(armLen, armT2, armT2)
      armEW.translate(wx, armY, wz)
      ornamentBatch.addPositioned(armEW, 0xb89858)
      for (const [dx, dz] of [[armLen / 2, 0], [-armLen / 2, 0], [0, armLen / 2], [0, -armLen / 2]] as const) {
        const ballMark = new THREE.SphereGeometry(0.045, 4, 3)
        ballMark.translate(wx + dx, armY, wz + dz)
        ornamentBatch.addPositioned(ballMark, 0xb89858)
      }
      const arrowAngle = vaneRoll * Math.PI * 2
      const arrowLen = 0.55, arrowH = 0.06, arrowT = 0.04
      const arrow = new THREE.BoxGeometry(arrowLen, arrowH, arrowT)
      arrow.rotateY(arrowAngle)
      arrow.translate(wx, vaneBaseY + poleH + arrowH / 2, wz)
      ornamentBatch.addPositioned(arrow, 0x4a3a2a)
      const headW = 0.10, headH = 0.16
      const head = new THREE.BoxGeometry(headW, headH, arrowT * 1.2)
      head.translate(arrowLen / 2 - headW / 2, 0, 0)
      head.rotateY(arrowAngle)
      head.translate(wx, vaneBaseY + poleH + arrowH / 2, wz)
      ornamentBatch.addPositioned(head, 0x4a3a2a)
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

