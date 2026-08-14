/**
 * Massing — the main overhaul. Each building is a composition of Volumes,
 * not a single box. A noble house becomes a body + corner tower; a gothic
 * temple becomes a nave with transepts and a spire; a tudor cottage becomes
 * a jettied upper floor over a narrower ground floor.
 *
 * pickMassing() chooses a template function per building (by definitionId
 * overrides + archetype bias + hash) and runs it to produce Volume[].
 */

import type { StyleVector } from './StyleVector'
import type { ArchetypeId } from './Archetypes'
import type { RoofStyle, RoofAxis } from './Roofs'
import { clampRoofHeight, ensureRoofPitch } from './Roofs'
import { STOREY_HEIGHT, MIN_HABITABLE_W } from '../scale'

export type VolumeRole =
  | 'mainBody' | 'tower' | 'wing' | 'upperFloor' | 'spire'
  | 'porch' | 'transept' | 'penthouse' | 'chimneyVol'
  // Non-habitable detail carried as a volume: a footbridge deck and its
  // handrails, a wall's coping course. Three templates had been emitting
  // this for a while and it was never in the union — nothing caught it,
  // because `npm run typecheck` was pointed at a solution file with
  // "files": [] and had been checking zero source files.
  | 'trim'

export interface Volume {
  role: VolumeRole
  /** XZ offset from the building's placed center. */
  offsetX: number
  offsetZ: number
  /** Horizontal extents. For circular volumes width is used as diameter. */
  width: number
  depth: number
  /** Y offset from the building's base (for stacked volumes). */
  bottomY: number
  /** Vertical wall extent. */
  height: number
  /** Roof style + shape. */
  roofStyle: RoofStyle
  roofHeight: number
  roofAxis: RoofAxis
  /** Appearance. */
  wallColor: number
  roofColor: number
  textured: boolean
  cornice: boolean
  /** Cylinder walls instead of box (width acts as diameter). */
  circular?: boolean
  /** Integer floors for facade texture; defaults to derived from height. */
  floors?: number
}

export interface MassingResult {
  volumes: Volume[]
  primaryFace: 'x+' | 'x-' | 'z+' | 'z-'
}

function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

/**
 * Floor count for a volume — uses the explicit Volume.floors if set,
 * otherwise estimates from height (1 floor ≈ 0.9 wall units in the
 * massing's local scale). Single source of truth so VolumeRenderer
 * (window grid, base course logic) and BuildingFactory (mid-floor
 * timber beams) agree on the same floor count for the same volume.
 */
export function volumeFloors(v: Volume): number {
  // STOREY_HEIGHT, not a local 0.9. That literal was left over from when a
  // storey was about a world unit, and it survived every rescale — so a 5.4m
  // volume reported SIX floors, and FacadeTexture dutifully painted six rows
  // of windows a third of a metre tall onto a three-storey wall.
  const byHeight = Math.max(1, Math.round(v.height / STOREY_HEIGHT))
  if (v.floors === undefined) return byHeight
  // The explicit count is the BUILDING's floor count, and templates hand it to
  // every volume they make — including a jetty's squat lower floor, which is
  // 32% of the wall carrying a label saying "three storeys". That produced
  // 0.8m storeys, and a facade laid out per storey then drew windows that
  // could not fit. Trust the explicit count only while it implies a storey a
  // person could stand up in.
  return (v.height / v.floors) < 2.2 ? byHeight : Math.max(1, v.floors)
}

/** Choose a roof style from the style vector + some randomness. */
function roofFromStyle(sv: StyleVector, hash: number, salt: number, forceSpire = false): RoofStyle {
  if (forceSpire) return rand01(hash, salt) < 0.7 ? 'spire' : 'pointed'
  const p = sv.roofPitch
  const r = rand01(hash, salt)
  if (p < 0.22) return r < 0.35 ? 'mansard' : 'flat'
  if (p < 0.45) return r < 0.55 ? 'hipped' : 'gabled'
  if (p < 0.70) return r < 0.5 ? 'gabled' : 'hipped'
  if (p < 0.88) return r < 0.55 ? 'steep' : 'pointed'
  return r < 0.4 ? 'spire' : 'pointed'
}

function roofHeightFor(style: RoofStyle, wallH: number, sv: StyleVector): number {
  switch (style) {
    case 'flat': case 'none': return 0
    case 'hipped': return wallH * (0.22 + sv.roofPitch * 0.15)
    case 'gabled': return wallH * (0.32 + sv.roofPitch * 0.2)
    case 'steep': return wallH * (0.55 + sv.roofPitch * 0.25)
    case 'pointed': return wallH * (0.7 + sv.roofPitch * 0.3)
    case 'spire': return wallH * (1.1 + sv.roofPitch * 0.9)
    case 'dome': return wallH * (0.35 + sv.roofPitch * 0.2)
    case 'mansard': return wallH * (0.28 + sv.roofPitch * 0.15)
  }
}

function roofAxisFor(w: number, d: number): RoofAxis {
  return w >= d ? 'x' : 'z'
}

/**
 * Cap a tower/spire BODY height against its own width.
 *
 * These volumes are sized as a multiple of wallH, which already compounds
 * floors x FLOOR_HEIGHT x HEIGHT_MULT (up to 3.0 on landmarks), while being
 * only a fraction of the footprint wide. The raw product reached 30:1 — the
 * black needles that stabbed out of the skyline. Real towers run about 6-9:1,
 * so clamp there; ordinary buildings never approach the cap.
 * (buildRoof applies the matching cap to the roof cone on top.)
 */
/** How far, in METRES, a volume may extend beyond its building's footprint.
 *
 *  This was 0.9 back when footW arrived in tiles and a tile was one unit, so
 *  it meant 0.9 of a tile. footW is now in world units (see scale.ts), and a
 *  proportional translation would be 2.7m — which is not a jetty, it is the
 *  three-tile sail this cap exists to prevent, and it is what got reported
 *  from the device as crossed timbers jutting out of houses.
 *
 *  So it is pinned to a physical number instead: a real jettied upper storey
 *  overhangs 0.3-0.6m. Small and medium buildings keep their full jetty
 *  (footW * 1.15 only exceeds this above ~8m frontage); only the large ones
 *  get trimmed, which is where the sails came from anyway. */
const MAX_OVERHANG = 0.6

/** How many volumes the overhang cap has trimmed since the last reset, by
 *  template role. Exposed through the debug bridge: if a template starts
 *  throwing geometry through the neighbours, this is where it shows up as a
 *  number instead of as something you happen to notice in a screenshot. */
export const overhangClamps: Record<string, number> = {}
export function resetOverhangClamps(): void {
  for (const k of Object.keys(overhangClamps)) delete overhangClamps[k]
}

/** Height:width ceiling for tower bodies — the guard that stopped spires
 *  reaching 74m needles. It was 9 when `width` was a tile count; width is now
 *  world units and 3x larger, which silently made the guard 3x weaker. 4 is
 *  the faithful translation with headroom: the tallest legitimate tower here
 *  (a 3-tile lighthouse at 4 floors) sits at 2.75. */
const MAX_TOWER_ASPECT = 4
function towerHeightFor(raw: number, width: number): number {
  return Math.min(raw, width * MAX_TOWER_ASPECT)
}

interface MassingContext {
  sv: StyleVector
  hash: number
  footW: number
  footD: number
  wallH: number
  floors: number
  wallColor: number
  roofColor: number
}

/* ------------------------------------------------------------------ */
/* Template library — each returns Volume[]                           */
/* ------------------------------------------------------------------ */

function tmplSimpleBody(ctx: MassingContext): Volume[] {
  const roofStyle = roofFromStyle(ctx.sv, ctx.hash, 1)
  return [{
    role: 'mainBody',
    offsetX: 0, offsetZ: 0,
    width: ctx.footW, depth: ctx.footD,
    bottomY: 0, height: ctx.wallH,
    roofStyle, roofHeight: roofHeightFor(roofStyle, ctx.wallH, ctx.sv),
    roofAxis: roofAxisFor(ctx.footW, ctx.footD),
    wallColor: ctx.wallColor, roofColor: ctx.roofColor,
    textured: true, cornice: ctx.sv.cornice > 0.2,
    floors: ctx.floors,
  }]
}

/** Dramatic jetty — squat ground floor, tall upper floor with a HUGE overhang.
 *  Upper footprint is expanded beyond the nominal building footprint for
 *  maximum silhouette impact. The lower floor shrinks aggressively. */
function tmplJettiedUpper(ctx: MassingContext): Volume[] {
  const lowerH = ctx.wallH * 0.32
  const upperH = ctx.wallH - lowerH + ctx.wallH * 0.08 // upper is ~76% of total
  const jettyFrac = 0.32 + ctx.sv.overhang * 0.22   // 0.32–0.54 of footprint
  const lowerW = Math.max(0.9, ctx.footW * (1 - jettyFrac))
  const lowerD = Math.max(0.9, ctx.footD * (1 - jettyFrac * 0.7))
  const upperW = ctx.footW * 1.15 // upper is WIDER than nominal
  const upperD = ctx.footD * 1.08
  const upperRoof = roofFromStyle(ctx.sv, ctx.hash, 2)
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: lowerW, depth: lowerD,
      bottomY: 0, height: lowerH,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: false, cornice: false,
      floors: 1,
    },
    {
      role: 'upperFloor',
      offsetX: 0, offsetZ: 0,
      width: upperW, depth: upperD,
      bottomY: lowerH, height: upperH,
      roofStyle: upperRoof, roofHeight: roofHeightFor(upperRoof, upperH, ctx.sv),
      roofAxis: roofAxisFor(upperW, upperD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.25,
      floors: Math.max(2, ctx.floors),
    },
  ]
}

/** Tall primary body + a dramatically-tall penthouse on top — 55%/55% split
 *  (total height = 110% of nominal wallH), penthouse uses ~55% of main's
 *  footprint, placed with a deliberate asymmetric offset so the step is
 *  visually lopsided rather than centred. */
function tmplStepBack(ctx: MassingContext): Volume[] {
  const mainH = ctx.wallH * 0.55
  const topH = ctx.wallH * 0.55
  const topW = ctx.footW * 0.55
  const topD = ctx.footD * 0.55
  const mainRoof: RoofStyle = 'flat'
  const topRoof = roofFromStyle(ctx.sv, ctx.hash, 3)
  // Strong asymmetric offset so the step is obvious from any angle.
  const sideX = rand01(ctx.hash, 31) < 0.5 ? -1 : 1
  const sideZ = rand01(ctx.hash, 33) < 0.5 ? -1 : 1
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: mainH,
      roofStyle: mainRoof, roofHeight: 0,
      roofAxis: roofAxisFor(ctx.footW, ctx.footD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.2,
      floors: Math.max(2, ctx.floors - 1),
    },
    {
      role: 'penthouse',
      offsetX: sideX * (ctx.footW - topW) * 0.35,
      offsetZ: sideZ * (ctx.footD - topD) * 0.35,
      width: topW, depth: topD,
      bottomY: mainH, height: topH,
      roofStyle: topRoof, roofHeight: roofHeightFor(topRoof, topH, ctx.sv),
      roofAxis: roofAxisFor(topW, topD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: Math.max(1, Math.round(topH / 1.0)),
    },
  ]
}

/** L-shaped: main body + perpendicular wing. */
function tmplLShape(ctx: MassingContext): Volume[] {
  const mainRoof = roofFromStyle(ctx.sv, ctx.hash, 5)
  const wingRoof = roofFromStyle(ctx.sv, ctx.hash, 6)
  // Main along x+, wing along z+
  const mainW = ctx.footW, mainD = Math.max(1.4, ctx.footD * 0.65)
  const wingW = Math.max(1.4, ctx.footW * 0.55), wingD = ctx.footD
  const wingSide = rand01(ctx.hash, 7) < 0.5 ? -1 : 1
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: -(ctx.footD - mainD) / 2,
      width: mainW, depth: mainD,
      bottomY: 0, height: ctx.wallH,
      roofStyle: mainRoof, roofHeight: roofHeightFor(mainRoof, ctx.wallH, ctx.sv),
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.2,
      floors: ctx.floors,
    },
    {
      role: 'wing',
      offsetX: wingSide * (ctx.footW / 2 - wingW / 2),
      offsetZ: (ctx.footD - wingD) / 2 + mainD * 0.1,
      width: wingW, depth: wingD,
      bottomY: 0, height: ctx.wallH * 0.92,
      roofStyle: wingRoof, roofHeight: roofHeightFor(wingRoof, ctx.wallH * 0.92, ctx.sv),
      roofAxis: 'z',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.3,
      floors: Math.max(1, ctx.floors - (rand01(ctx.hash, 9) < 0.4 ? 1 : 0)),
    },
  ]
}

/** Main body + a dramatically tall square corner tower. */
function tmplCornerTower(ctx: MassingContext): Volume[] {
  const mainRoof = roofFromStyle(ctx.sv, ctx.hash, 11)
  const towerW = Math.max(1.2, Math.min(ctx.footW, ctx.footD) * 0.45)
  const towerH = towerHeightFor(ctx.wallH * (1.5 + ctx.sv.wealth * 0.5), towerW)
  const cornerX = (rand01(ctx.hash, 13) < 0.5 ? -1 : 1) * (ctx.footW / 2 - towerW / 2)
  const cornerZ = (rand01(ctx.hash, 15) < 0.5 ? -1 : 1) * (ctx.footD / 2 - towerW / 2)
  const towerRoof: RoofStyle = rand01(ctx.hash, 17) < 0.55 ? 'pointed' : 'spire'
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: ctx.wallH,
      roofStyle: mainRoof, roofHeight: roofHeightFor(mainRoof, ctx.wallH, ctx.sv),
      roofAxis: roofAxisFor(ctx.footW, ctx.footD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.25,
      floors: ctx.floors,
    },
    {
      role: 'tower',
      offsetX: cornerX, offsetZ: cornerZ,
      width: towerW, depth: towerW,
      bottomY: 0, height: towerH,
      roofStyle: towerRoof, roofHeight: roofHeightFor(towerRoof, towerH, ctx.sv),
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.25,
      circular: rand01(ctx.hash, 19) < 0.35,
      floors: Math.max(ctx.floors + 1, Math.round(towerH / 0.9)),
    },
  ]
}

/** Gothic-style: body + tall slim spire tower at one end. */
function tmplSpireEnd(ctx: MassingContext): Volume[] {
  const mainRoof = roofFromStyle(ctx.sv, ctx.hash, 21)
  const spireW = Math.max(1.1, Math.min(ctx.footW, ctx.footD) * 0.45)
  const spireH = towerHeightFor(ctx.wallH * (1.6 + ctx.sv.wealth * 0.6), spireW)
  const endSide = rand01(ctx.hash, 23) < 0.5 ? -1 : 1
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: ctx.wallH,
      roofStyle: mainRoof, roofHeight: roofHeightFor(mainRoof, ctx.wallH, ctx.sv),
      roofAxis: roofAxisFor(ctx.footW, ctx.footD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.25,
      floors: ctx.floors,
    },
    {
      role: 'spire',
      offsetX: endSide * (ctx.footW / 2 - spireW / 2),
      offsetZ: (rand01(ctx.hash, 25) - 0.5) * (ctx.footD - spireW) * 0.4,
      width: spireW, depth: spireW,
      bottomY: 0, height: spireH,
      roofStyle: 'spire',
      roofHeight: roofHeightFor('spire', spireH, ctx.sv),
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: Math.max(3, Math.round(spireH / 0.9)),
    },
  ]
}

/** Cathedral-like cross: long nave + perpendicular transepts. */
function tmplNaveTransept(ctx: MassingContext): Volume[] {
  const naveLong = Math.max(ctx.footW, ctx.footD)
  const naveShort = Math.min(ctx.footW, ctx.footD)
  const longAxisZ = ctx.footD >= ctx.footW
  const naveW = longAxisZ ? naveShort * 0.62 : naveLong
  const naveD = longAxisZ ? naveLong : naveShort * 0.62
  const transeptW = longAxisZ ? naveLong : naveShort
  const transeptD = longAxisZ ? naveShort * 0.5 : naveLong
  // Actually simpler: transept is perpendicular slab crossing the nave.
  const transW = longAxisZ ? naveLong : naveShort * 0.6
  const transD = longAxisZ ? naveShort * 0.6 : naveLong
  const naveRoofStyle: RoofStyle = rand01(ctx.hash, 27) < 0.5 ? 'steep' : 'gabled'
  const transRoofStyle: RoofStyle = naveRoofStyle
  const apseH = ctx.wallH * 1.05
  void transeptW; void transeptD
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: naveW, depth: naveD,
      bottomY: 0, height: apseH,
      roofStyle: naveRoofStyle,
      roofHeight: roofHeightFor(naveRoofStyle, apseH, ctx.sv),
      roofAxis: longAxisZ ? 'z' : 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: ctx.floors,
    },
    {
      role: 'transept',
      offsetX: 0, offsetZ: 0,
      width: transW, depth: transD,
      bottomY: 0, height: ctx.wallH * 0.9,
      roofStyle: transRoofStyle,
      roofHeight: roofHeightFor(transRoofStyle, ctx.wallH * 0.9, ctx.sv),
      roofAxis: longAxisZ ? 'x' : 'z',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: ctx.floors,
    },
  ]
}

/** Steep-gable house: tall narrow body with a VERY steep gable roof
 *  (1:1 gable-height-to-wall-height), optional side shed. Produces the
 *  quintessential medieval "tall narrow townhouse" silhouette. */
function tmplSteepGable(ctx: MassingContext): Volume[] {
  const bodyH = ctx.wallH * 1.1
  const roofH = bodyH * 0.85 // gable height ~85% of wall height — VERY steep
  const hasShed = rand01(ctx.hash, 201) < 0.45
  const shedSide = rand01(ctx.hash, 203) < 0.5 ? -1 : 1
  const volumes: Volume[] = [{
    role: 'mainBody',
    offsetX: 0, offsetZ: 0,
    width: ctx.footW, depth: ctx.footD,
    bottomY: 0, height: bodyH,
    roofStyle: 'steep', roofHeight: roofH,
    roofAxis: roofAxisFor(ctx.footW, ctx.footD),
    wallColor: ctx.wallColor, roofColor: ctx.roofColor,
    textured: true, cornice: false,
    floors: ctx.floors,
  }]
  if (hasShed) {
    const shedW = Math.max(0.9, ctx.footW * 0.48)
    const shedD = Math.max(0.9, ctx.footD * 0.45)
    const shedH = bodyH * 0.55
    volumes.push({
      role: 'wing',
      offsetX: shedSide * (ctx.footW / 2 + shedW / 2 - 0.1),
      offsetZ: (rand01(ctx.hash, 205) - 0.5) * (ctx.footD - shedD) * 0.5,
      width: shedW, depth: shedD,
      bottomY: 0, height: shedH,
      roofStyle: 'gabled', roofHeight: shedH * 0.35,
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: false, cornice: false,
      floors: 1,
    })
  }
  return volumes
}

/** Body + forward porch (smaller, lower) with shed roof. */
function tmplPorchFront(ctx: MassingContext): Volume[] {
  const bodyRoof = roofFromStyle(ctx.sv, ctx.hash, 41)
  const porchW = ctx.footW * 0.8
  const porchD = Math.min(1.0, ctx.footD * 0.4)
  const porchH = ctx.wallH * 0.55
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: -porchD / 3,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: ctx.wallH,
      roofStyle: bodyRoof,
      roofHeight: roofHeightFor(bodyRoof, ctx.wallH, ctx.sv),
      roofAxis: roofAxisFor(ctx.footW, ctx.footD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.25,
      floors: ctx.floors,
    },
    {
      role: 'porch',
      offsetX: 0, offsetZ: ctx.footD / 2 + porchD / 2 - porchD / 3,
      width: porchW, depth: porchD,
      bottomY: 0, height: porchH,
      roofStyle: 'hipped',
      roofHeight: porchH * 0.25,
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: false, cornice: false,
      floors: 1,
    },
  ]
}

/** Tall circular tower (used for tower/watchtower/round_tower/lighthouse). */
function tmplCircularTower(ctx: MassingContext, lighthouse: boolean): Volume[] {
  const roofStyle: RoofStyle = lighthouse ? 'dome' : 'pointed'
  const diameter = Math.max(1.4, Math.min(ctx.footW, ctx.footD) * 0.95)
  return [{
    role: 'tower',
    offsetX: 0, offsetZ: 0,
    width: diameter, depth: diameter,
    bottomY: 0, height: ctx.wallH,
    roofStyle, roofHeight: roofHeightFor(roofStyle, ctx.wallH, ctx.sv),
    roofAxis: 'x',
    wallColor: ctx.wallColor, roofColor: ctx.roofColor,
    textured: true, cornice: true,
    circular: true,
    floors: Math.max(3, Math.round(ctx.wallH / 0.9)),
  }]
}

/** Gate: two flanking towers with a lower passage block between them. */
function tmplGatehouse(ctx: MassingContext): Volume[] {
  const towerW = Math.max(1.2, ctx.footW * 0.28)
  const towerH = towerHeightFor(ctx.wallH * 1.25, towerW)
  const passageH = ctx.wallH * 0.78
  const passageW = ctx.footW - towerW * 2
  const passageRoof: RoofStyle = 'flat'
  const towerRoof: RoofStyle = 'pointed'
  return [
    {
      role: 'tower',
      offsetX: -(ctx.footW / 2 - towerW / 2),
      offsetZ: 0,
      width: towerW, depth: ctx.footD,
      bottomY: 0, height: towerH,
      roofStyle: towerRoof, roofHeight: roofHeightFor(towerRoof, towerH, ctx.sv),
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: Math.max(2, Math.round(towerH / 0.9)),
    },
    {
      role: 'tower',
      offsetX: (ctx.footW / 2 - towerW / 2),
      offsetZ: 0,
      width: towerW, depth: ctx.footD,
      bottomY: 0, height: towerH,
      roofStyle: towerRoof, roofHeight: roofHeightFor(towerRoof, towerH, ctx.sv),
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: Math.max(2, Math.round(towerH / 0.9)),
    },
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: Math.max(0.8, passageW), depth: ctx.footD,
      bottomY: passageH * 0.4, height: passageH * 0.6,
      roofStyle: passageRoof, roofHeight: 0,
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: false, cornice: true,
      floors: 1,
    },
  ]
}

/** Two parallel tall narrow gabled bodies joined side-by-side (rowhouse pair). */
function tmplTwinGables(ctx: MassingContext): Volume[] {
  const splitAxisZ = ctx.footW >= ctx.footD
  const halfW = splitAxisZ ? ctx.footW / 2 : ctx.footW
  const halfD = splitAxisZ ? ctx.footD : ctx.footD / 2
  const leftRoof = roofFromStyle(ctx.sv, ctx.hash, 61)
  const rightRoof = roofFromStyle(ctx.sv, ctx.hash, 63)
  // Slight height difference so roofline isn't symmetric
  const leftH = ctx.wallH * (0.92 + rand01(ctx.hash, 65) * 0.12)
  const rightH = ctx.wallH * (0.92 + rand01(ctx.hash, 67) * 0.12)
  return [
    {
      role: 'mainBody',
      offsetX: splitAxisZ ? -halfW / 2 : 0,
      offsetZ: splitAxisZ ? 0 : -halfD / 2,
      width: halfW * 0.98, depth: halfD * 0.98,
      bottomY: 0, height: leftH,
      roofStyle: leftRoof, roofHeight: roofHeightFor(leftRoof, leftH, ctx.sv),
      roofAxis: splitAxisZ ? 'z' : 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.25,
      floors: ctx.floors,
    },
    {
      role: 'wing',
      offsetX: splitAxisZ ? halfW / 2 : 0,
      offsetZ: splitAxisZ ? 0 : halfD / 2,
      width: halfW * 0.98, depth: halfD * 0.98,
      bottomY: 0, height: rightH,
      roofStyle: rightRoof, roofHeight: roofHeightFor(rightRoof, rightH, ctx.sv),
      roofAxis: splitAxisZ ? 'z' : 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.25,
      floors: ctx.floors,
    },
  ]
}

/** Main body + small side chapel with its own pointed roof (gothic). */
function tmplAttachedChapel(ctx: MassingContext): Volume[] {
  const mainRoof = roofFromStyle(ctx.sv, ctx.hash, 71)
  const chapW = Math.max(1.3, ctx.footW * 0.42)
  const chapD = Math.max(1.3, ctx.footD * 0.55)
  const chapSide = rand01(ctx.hash, 73) < 0.5 ? -1 : 1
  const chapRoof: RoofStyle = rand01(ctx.hash, 75) < 0.55 ? 'steep' : 'pointed'
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: ctx.wallH,
      roofStyle: mainRoof, roofHeight: roofHeightFor(mainRoof, ctx.wallH, ctx.sv),
      roofAxis: roofAxisFor(ctx.footW, ctx.footD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: ctx.floors,
    },
    {
      role: 'wing',
      offsetX: chapSide * (ctx.footW / 2 + chapW / 2 - 0.15),
      offsetZ: (rand01(ctx.hash, 77) - 0.5) * (ctx.footD - chapD) * 0.4,
      width: chapW, depth: chapD,
      bottomY: 0, height: ctx.wallH * 0.82,
      roofStyle: chapRoof, roofHeight: roofHeightFor(chapRoof, ctx.wallH * 0.82, ctx.sv),
      roofAxis: chapW >= chapD ? 'x' : 'z',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.3,
      floors: Math.max(1, ctx.floors - 1),
    },
  ]
}

/** Cross-plan: main body + perpendicular wing + central tower at intersection. */
function tmplCrossPlan(ctx: MassingContext): Volume[] {
  const mainRoof = roofFromStyle(ctx.sv, ctx.hash, 81)
  const wingRoof = roofFromStyle(ctx.sv, ctx.hash, 82)
  const armW = ctx.footW, armD = Math.max(1.4, ctx.footD * 0.55)
  const armW2 = Math.max(1.4, ctx.footW * 0.55), armD2 = ctx.footD
  const towerW = Math.max(1.2, Math.min(armD, armW2) * 0.85)
  const towerH = towerHeightFor(ctx.wallH * (1.3 + ctx.sv.wealth * 0.4), towerW)
  const towerRoof: RoofStyle = rand01(ctx.hash, 84) < 0.55 ? 'pointed' : 'spire'
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: armW, depth: armD,
      bottomY: 0, height: ctx.wallH,
      roofStyle: mainRoof, roofHeight: roofHeightFor(mainRoof, ctx.wallH, ctx.sv),
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: ctx.floors,
    },
    {
      role: 'transept',
      offsetX: 0, offsetZ: 0,
      width: armW2, depth: armD2,
      bottomY: 0, height: ctx.wallH * 0.95,
      roofStyle: wingRoof, roofHeight: roofHeightFor(wingRoof, ctx.wallH * 0.95, ctx.sv),
      roofAxis: 'z',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: ctx.floors,
    },
    {
      role: 'tower',
      offsetX: 0, offsetZ: 0,
      width: towerW, depth: towerW,
      bottomY: 0, height: towerH,
      roofStyle: towerRoof, roofHeight: roofHeightFor(towerRoof, towerH, ctx.sv),
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: Math.max(3, Math.round(towerH / 0.9)),
    },
  ]
}

/** Body with a full-height projecting bay on one long side. */
function tmplSideBay(ctx: MassingContext): Volume[] {
  const mainRoof = roofFromStyle(ctx.sv, ctx.hash, 91)
  const bayW = Math.max(1.2, ctx.footW * 0.45)
  const bayD = 0.7
  const bayH = ctx.wallH * 0.92
  const baySide = rand01(ctx.hash, 93) < 0.5 ? -1 : 1
  const bayRoof: RoofStyle = rand01(ctx.hash, 95) < 0.55 ? 'hipped' : 'gabled'
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: ctx.wallH,
      roofStyle: mainRoof, roofHeight: roofHeightFor(mainRoof, ctx.wallH, ctx.sv),
      roofAxis: roofAxisFor(ctx.footW, ctx.footD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.25,
      floors: ctx.floors,
    },
    {
      role: 'wing',
      offsetX: (rand01(ctx.hash, 97) - 0.5) * (ctx.footW - bayW) * 0.6,
      offsetZ: baySide * (ctx.footD / 2 + bayD / 2 - 0.1),
      width: bayW, depth: bayD,
      bottomY: 0, height: bayH,
      roofStyle: bayRoof, roofHeight: roofHeightFor(bayRoof, bayH, ctx.sv),
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.3,
      floors: ctx.floors,
    },
  ]
}

/** Farmstead: cottage + full-size barn. The barn is ~70% of the nominal
 *  footprint with its own gabled roof at a perpendicular axis — reads as
 *  a distinct second building joined at one corner. */
function tmplFarmstead(ctx: MassingContext): Volume[] {
  const cottageW = Math.max(1.0, ctx.footW * 0.55)
  const cottageD = Math.max(1.0, ctx.footD * 0.55)
  const cottageH = ctx.wallH * 0.95
  const cottageRoof: RoofStyle = rand01(ctx.hash, 101) < 0.5 ? 'steep' : 'gabled'
  const barnW = Math.max(1.4, ctx.footW * 0.72)
  const barnD = Math.max(1.4, ctx.footD * 0.65)
  const barnH = ctx.wallH * 0.8
  // Arrange cottage NW, barn SE (or mirrored).
  const swap = rand01(ctx.hash, 103) < 0.5 ? -1 : 1
  return [
    {
      role: 'mainBody',
      offsetX: swap * (ctx.footW / 2 - cottageW / 2),
      offsetZ: -(ctx.footD / 2 - cottageD / 2),
      width: cottageW, depth: cottageD,
      bottomY: 0, height: cottageH,
      roofStyle: cottageRoof, roofHeight: roofHeightFor(cottageRoof, cottageH, ctx.sv),
      roofAxis: roofAxisFor(cottageW, cottageD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: 1,
    },
    {
      role: 'wing',
      offsetX: -swap * (ctx.footW / 2 - barnW / 2),
      offsetZ: (ctx.footD / 2 - barnD / 2),
      width: barnW, depth: barnD,
      bottomY: 0, height: barnH,
      // Barn ridge runs perpendicular to cottage
      roofStyle: 'gabled', roofHeight: barnH * 0.6,
      roofAxis: roofAxisFor(cottageW, cottageD) === 'x' ? 'z' : 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: 1,
    },
  ]
}

/** Tall narrow tower-house — footprint shrinks to square, height explodes
 *  to 2.4× nominal. The Traverse Town signature silhouette: a tall narrow
 *  house crowned by a steep pointed roof. Used by landmark promotion. */
function tmplTallTowerHouse(ctx: MassingContext): Volume[] {
  const baseW = Math.max(1.1, Math.min(ctx.footW, ctx.footD) * 0.75)
  // CAP IT AGAINST ITS OWN WIDTH, like every other tower here.
  //
  // Five templates run their height through towerHeightFor and this one did
  // not, which is a bug in a PATTERN rather than in a line: the landmark
  // promotion hands 28% of ALL buildings a dramatic template regardless of
  // type, so an uncapped `wallH * 2.2` produced a 37.5m coach house and a
  // 24.9m row house — the tower-block silhouette MAX_TOWER_ASPECT exists to
  // prevent. Grep the siblings of any gate you fix.
  const tallH = towerHeightFor(ctx.wallH * 2.2, baseW)
  const roofStyle: RoofStyle = rand01(ctx.hash, 221) < 0.55 ? 'steep' : 'pointed'
  return [{
    role: 'tower',
    offsetX: 0, offsetZ: 0,
    width: baseW, depth: baseW,
    bottomY: 0, height: tallH,
    roofStyle, roofHeight: roofHeightFor(roofStyle, tallH, ctx.sv),
    roofAxis: 'x',
    wallColor: ctx.wallColor, roofColor: ctx.roofColor,
    textured: true, cornice: ctx.sv.cornice > 0.15,
    // STOREY_HEIGHT, not a 1.05 left over from an earlier scale. volumeFloors
    // guards against the resulting nonsense so nothing was drawn wrong, but
    // the count goes into scaleSamples — and a diagnostic reporting a
    // thirteen-storey bakery sends the next person after the wrong bug.
    floors: Math.max(2, Math.round(tallH / STOREY_HEIGHT)),
  }]
}

/**
 * A TENEMENT: the same plot as a row house, carrying twice the people.
 *
 * Deliberately NOT the tower-house template, which insets to a freestanding
 * square and would throw away the party wall. A tenement is a terraced block —
 * it fills its footprint so it can share both flanks — and its whole
 * difference from the row house beside it is that it goes UP. The top storey
 * is jettied a little into the street, which is the historical way of getting
 * another room out of a plot you cannot widen, and it gives the quarter a
 * ragged roofline nothing else in town has.
 */
function tmplTenement(ctx: MassingContext): Volume[] {
  const totalH = ctx.wallH * (1.55 + rand01(ctx.hash, 227) * 0.5)
  const topH = Math.max(STOREY_HEIGHT, totalH * 0.28)
  const bodyH = totalH - topH
  const roofStyle: RoofStyle = rand01(ctx.hash, 229) < 0.6 ? 'steep' : 'gabled'
  // Inside MAX_OVERHANG, and taken off the front only — the flanks stay flush
  // so the terrace still closes up.
  const jetty = 0.22 + rand01(ctx.hash, 231) * 0.16
  const axis = roofAxisFor(ctx.footW, ctx.footD)
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: bodyH,
      roofStyle: 'flat', roofHeight: 0, roofAxis: axis,
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: Math.max(2, Math.round(bodyH / STOREY_HEIGHT)),
    },
    {
      role: 'upperFloor',
      offsetX: 0, offsetZ: jetty / 2,
      width: ctx.footW, depth: ctx.footD + jetty,
      bottomY: bodyH - 0.04,
      height: topH + 0.04,
      roofStyle, roofHeight: roofHeightFor(roofStyle, topH, ctx.sv), roofAxis: axis,
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.3,
      floors: Math.max(1, Math.round(topH / STOREY_HEIGHT)),
    },
  ]
}

/**
 * A LEAN-TO: the shed somebody ended up living in.
 *
 * There is no mono-pitch roof primitive and a gable would make this a small
 * cottage, which is the opposite of the point. It is built as a stepped pair
 * of flat-topped boxes — tall side against the neighbour, low side to the
 * yard — which reads as a slope from any distance and as improvised from
 * close up. The 4cm overlap is the same trick pickMassing uses: two exactly
 * coincident faces are a depth-buffer tie whether or not the geometry is
 * "correct".
 */
function tmplLeanTo(ctx: MassingContext): Volume[] {
  const hiH = Math.max(STOREY_HEIGHT * 0.95, ctx.wallH * 0.5)
  const loH = hiH * 0.7
  const along = ctx.footW >= ctx.footD
  const w = along ? ctx.footW / 2 + 0.02 : ctx.footW
  const d = along ? ctx.footD : ctx.footD / 2 + 0.02
  const off = (along ? ctx.footW : ctx.footD) / 4
  const mk = (role: VolumeRole, sign: number, height: number): Volume => ({
    role,
    offsetX: along ? sign * off : 0,
    offsetZ: along ? 0 : sign * off,
    width: w, depth: d,
    bottomY: 0, height,
    roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
    wallColor: ctx.wallColor, roofColor: ctx.roofColor,
    textured: true, cornice: false,
    floors: 1,
  })
  return [mk('mainBody', -1, hiH), mk('wing', 1, loH)]
}

/** Body + dramatic centered tall tower (like a keep). */
function tmplStackedTower(ctx: MassingContext): Volume[] {
  const mainRoof: RoofStyle = 'flat'
  const towerW = Math.max(1.2, Math.min(ctx.footW, ctx.footD) * 0.55)
  const towerH = towerHeightFor(ctx.wallH * (1.8 + ctx.sv.wealth * 0.4), towerW)
  const towerRoof: RoofStyle = rand01(ctx.hash, 113) < 0.5 ? 'pointed' : 'hipped'
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: ctx.wallH,
      roofStyle: mainRoof, roofHeight: 0,
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: Math.max(1, ctx.floors - 1),
    },
    {
      role: 'tower',
      offsetX: (rand01(ctx.hash, 115) - 0.5) * (ctx.footW - towerW) * 0.4,
      offsetZ: (rand01(ctx.hash, 117) - 0.5) * (ctx.footD - towerW) * 0.4,
      width: towerW, depth: towerW,
      bottomY: 0, height: towerH,
      roofStyle: towerRoof, roofHeight: roofHeightFor(towerRoof, towerH, ctx.sv),
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: Math.max(3, Math.round(towerH / 0.9)),
    },
  ]
}

/** Crenellated wall segment — tall fortification with battlement merlons.
 *  Footprint orientation (w vs d) determines wall orientation: the wall
 *  runs along the LONGER axis. Height is fixed (2.2 world units) so the
 *  wall reads as an actual fortification, not a garden wall. */
/**
 * A PRECINCT WALL — the low boundary round a churchyard, graveyard or garden.
 *
 * Not a small town wall. A town wall is 6.5m and defends; this is chest-to-
 * head height and merely says "this side is not the street", which is the
 * whole point: a cathedral close, a burial ground and a garden quarter are
 * not defined by building walls at all, they are defined by a boundary. Sitte
 * and Alexander #106 both make enclosure the thing that turns leftover space
 * into a place, and neither requires the enclosing thing to be a house.
 *
 * It exists because giving the sparse quarters their own building vocabulary
 * correctly made them sparse, and sparse quarters push facades apart:
 * facade-to-facade street width went 12m -> 15m against a 4-10m target. The
 * answer is not to build houses in the graveyard again — it is to give the
 * graveyard an edge.
 *
 * Deliberately below eye level at 1.45m: you see OVER it into the precinct,
 * which is what makes a churchyard read as a churchyard rather than a yard.
 */
/**
 * A FOOTBRIDGE DECK — one tile of plank deck on trestles, with rails.
 *
 * It has to stand ON TRESTLES rather than lie flat, because a bridge tile is
 * placed over water and the terrain there is the river BED — which the river
 * carve deliberately puts ~0.8m below the waterline. A deck drawn at local
 * ground height would therefore be underwater. The piers lift it clear.
 */
function tmplFootbridge(ctx: MassingContext): Volume[] {
  const deckY = 1.15
  const span = Math.max(ctx.footW, 2.4)
  const wood = 0x7a6244
  const vols: Volume[] = []
  // Two trestles down into the bed.
  for (const s of [-1, 1]) {
    vols.push({
      role: 'mainBody',
      offsetX: s * (span * 0.32), offsetZ: 0,
      width: 0.22, depth: 0.22,
      bottomY: 0, height: deckY,
      roofStyle: 'none', roofHeight: 0, roofAxis: 'x',
      wallColor: 0x5a4a34, roofColor: 0x5a4a34,
      textured: false, cornice: false, floors: 1,
    })
  }
  // The deck itself, a touch proud of the tile so consecutive tiles read as
  // one continuous run rather than a dotted line of separate planks.
  vols.push({
    role: 'trim',
    offsetX: 0, offsetZ: 0,
    width: span + 0.12, depth: ctx.footD + 0.12,
    bottomY: deckY, height: 0.16,
    roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
    wallColor: wood, roofColor: wood,
    textured: false, cornice: false, floors: 1,
  })
  // Hand rails, so it reads as a bridge from the bank and not as a raft.
  for (const s of [-1, 1]) {
    vols.push({
      role: 'trim',
      offsetX: 0, offsetZ: s * (ctx.footD / 2),
      width: span + 0.12, depth: 0.08,
      bottomY: deckY + 0.16, height: 0.62,
      roofStyle: 'none', roofHeight: 0, roofAxis: 'x',
      wallColor: 0x6a5640, roofColor: 0x6a5640,
      textured: false, cornice: false, floors: 1,
    })
  }
  return vols
}

/**
 * A STONE BRIDGE — piers standing in the bed, a deck across them, parapets.
 *
 * Reported as "there are essentially no bridges", and 20 of every 23 placed
 * were `bridge`. The arched-bridge geometry exists and is good — piers, deck,
 * parapet walls, arch bands — but it lives in PropFactory, and `bridge` is
 * placed into the STRUCTURE layer, which BuildingFactory draws. `bridge`
 * appears nowhere in BuildingFactory and nowhere in the massing overrides, so
 * every one of them fell through to the generic archetype and was built as an
 * ordinary house standing in the river. Content with no way in, again: the
 * geometry was never wrong, nothing routed to it.
 *
 * Rebuilt here rather than reached for across the layer boundary, because the
 * object genuinely belongs to the structure layer — it blocks, it carries a
 * `passage` tag for collision, and the audit reads its footprint.
 *
 * Like the footbridge, it stands on PIERS: a bridge tile sits over water and
 * the terrain under it is the river BED, which the carve puts well below the
 * waterline, so a deck at local ground height would be submerged.
 */
function tmplStoneBridge(ctx: MassingContext): Volume[] {
  const longAxisX = ctx.footW >= ctx.footD
  const span = longAxisX ? ctx.footW : ctx.footD
  const wide = longAxisX ? ctx.footD : ctx.footW
  // Clear of the waterline with headroom for a skiff underneath.
  const deckY = 1.85
  const deckT = 0.34
  const stone = 0x8a8478
  const parapet = 0x7b7466
  const vols: Volume[] = []

  // Piers, one every ~3m of span, down into the bed.
  const piers = Math.max(2, Math.round(span / 3))
  for (let i = 0; i < piers; i++) {
    const t = piers === 1 ? 0 : (i / (piers - 1) - 0.5)
    const off = t * span * 0.78
    vols.push({
      role: 'mainBody',
      offsetX: longAxisX ? off : 0,
      offsetZ: longAxisX ? 0 : off,
      width: longAxisX ? 0.7 : wide * 0.72,
      depth: longAxisX ? wide * 0.72 : 0.7,
      bottomY: 0, height: deckY,
      roofStyle: 'none', roofHeight: 0, roofAxis: 'x',
      wallColor: stone, roofColor: stone,
      textured: false, cornice: false, floors: 1,
    })
  }
  // The deck, slightly over-long so consecutive bridge tiles read as one run
  // rather than a dotted line — the same trick the footbridge uses.
  vols.push({
    role: 'trim',
    offsetX: 0, offsetZ: 0,
    width: (longAxisX ? span : wide) + 0.14,
    depth: (longAxisX ? wide : span) + 0.14,
    bottomY: deckY, height: deckT,
    roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
    wallColor: stone, roofColor: stone,
    textured: false, cornice: false, floors: 1,
  })
  // Parapets. Without them a deck is a raft, and from the bank the parapet is
  // most of what says "bridge" at all.
  for (const sgn of [-1, 1]) {
    vols.push({
      role: 'trim',
      offsetX: longAxisX ? 0 : sgn * (wide / 2 - 0.16),
      offsetZ: longAxisX ? sgn * (wide / 2 - 0.16) : 0,
      width: longAxisX ? span + 0.14 : 0.32,
      depth: longAxisX ? 0.32 : span + 0.14,
      bottomY: deckY + deckT, height: 0.78,
      roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
      wallColor: parapet, roofColor: parapet,
      textured: false, cornice: false, floors: 1,
    })
  }
  return vols
}

function tmplLowWall(ctx: MassingContext, alongX: boolean): Volume[] {
  const wallH = 1.45
  const thickness = 0.5
  // The axis comes from the TYPE, not from the footprint. Both precinct wall
  // variants are 1x1 so they can follow an irregular quarter boundary tile by
  // tile, and a square footprint cannot imply a direction — the town wall gets
  // away with `footW >= footD` only because its segments are 2x1 and 1x2.
  const longAxisX = alongX
  const wallW = longAxisX ? ctx.footW : thickness
  const wallD = longAxisX ? thickness : ctx.footD
  const stoneColor = 0x8d8478
  const volumes: Volume[] = [{
    role: 'mainBody',
    offsetX: 0, offsetZ: 0,
    width: wallW, depth: wallD,
    bottomY: 0, height: wallH,
    roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
    wallColor: stoneColor, roofColor: stoneColor,
    textured: false, cornice: false,
    floors: 1,
  }]
  // A coping course: a slightly wider, paler slab along the top. It is the
  // one detail that separates a wall from an extruded box at a distance, and
  // it costs a single volume.
  volumes.push({
    role: 'trim',
    offsetX: 0, offsetZ: 0,
    width: wallW + (longAxisX ? 0 : 0.14), depth: wallD + (longAxisX ? 0.14 : 0),
    bottomY: wallH, height: 0.12,
    roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
    wallColor: 0xa8a094, roofColor: 0xa8a094,
    textured: false, cornice: false,
    floors: 1,
  })
  return volumes
}

function tmplWallSegment(ctx: MassingContext): Volume[] {
  // A town wall in METRES. This was 2.2, which is shorter than a single
  // storey (2.9) and shorter than every house it is supposed to defend — the
  // same scale-coupling bug as the rest of that arc: a constant tuned when a
  // building was one to three world units WIDE, left behind when TILE became
  // 3.0 and a storey became 2.9.
  //
  // It matters beyond looking wrong. Lynch's EDGE is one of the five elements
  // a place is legible by, and a boundary you can see over is not a boundary
  // — from inside the town the wall read as a garden fence with spires behind
  // it. Carcassonne runs about 8m and York about 4m on a rampart; 6.5m reads
  // as a fortification from the street without walling the town off from the
  // approach view.
  const wallH = 6.5
  // A curtain wall is 1.5-2.5m thick. 0.55 is a partition, and at 6.5m tall
  // it would read as a sheet of card standing on edge.
  const thickness = 1.6
  const longAxisX = ctx.footW >= ctx.footD
  const wallW = longAxisX ? ctx.footW : thickness
  const wallD = longAxisX ? thickness : ctx.footD
  const stoneColor = 0x8a8478
  const volumes: Volume[] = [{
    role: 'mainBody',
    offsetX: 0, offsetZ: 0,
    width: wallW, depth: wallD,
    bottomY: 0, height: wallH,
    roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
    wallColor: stoneColor, roofColor: stoneColor,
    textured: false, cornice: false,
    floors: 1,
  }]
  // Crenellated merlons: alternating blocks along the wall's top edge.
  const runLen = longAxisX ? wallW : wallD
  // Merlons are ~0.6-1m of stone with a similar gap. At a 0.4m pitch a 6m
  // wall grew 31 of them, each 19cm wide — which past a few metres is not
  // crenellation, it is a fuzzy line, and it was 31 extra volumes per segment
  // on a mesh budget that cares.
  const merlonPitch = 1.5
  const merlonCount = Math.max(5, Math.floor(runLen / merlonPitch) * 2 + 1)
  for (let m = 0; m < merlonCount; m++) {
    if (m % 2 === 0) continue // gaps between merlons
    const t = (m + 0.5) / merlonCount - 0.5
    const merlonW = runLen / merlonCount * 0.85
    volumes.push({
      role: 'penthouse',
      offsetX: longAxisX ? t * runLen : 0,
      offsetZ: longAxisX ? 0 : t * runLen,
      width: longAxisX ? merlonW : thickness,
      depth: longAxisX ? thickness : merlonW,
      bottomY: wallH, height: 0.9,
      roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
      wallColor: stoneColor, roofColor: stoneColor,
      textured: false, cornice: false,
      floors: 1,
    })
  }
  return volumes
}

/** Windmill: narrow circular tower + conical cap + four cross-arm sails. */
function tmplWindmill(ctx: MassingContext): Volume[] {
  const diameter = Math.max(1.2, Math.min(ctx.footW, ctx.footD) * 0.7)
  const bodyH = ctx.wallH * 1.5
  const volumes: Volume[] = [{
    role: 'tower',
    offsetX: 0, offsetZ: 0,
    width: diameter, depth: diameter,
    bottomY: 0, height: bodyH,
    roofStyle: 'pointed', roofHeight: bodyH * 0.55,
    roofAxis: 'x',
    wallColor: ctx.wallColor, roofColor: ctx.roofColor,
    textured: false, cornice: true,
    circular: true,
    floors: Math.max(3, Math.round(bodyH / 0.9)),
  }]
  // Sails.
  //
  // These used to be four HORIZONTAL bars, each `armLen` long and offset by
  // half its own length, so the cross spanned 2 x armLen = diameter x 4.4 —
  // over nine tiles on a three-tile building. Flat, at roof height, radiating
  // three tiles past the walls in every direction and straight through the
  // neighbours: the "crossed timbers jutting out of houses" in the reports.
  // It was not even the right shape; a windmill's sails stand in a VERTICAL
  // plane on the front face, they do not lie flat like a weather vane.
  //
  // Now a vertical cross on the front face, sized off the tower rather than
  // an arbitrary multiple, so the silhouette reads as a windmill and stays
  // near its own footprint.
  const armLen = Math.min(diameter * 1.6, bodyH * 0.75)
  const armT = 0.16
  const hubY = bodyH * 0.82
  const faceZ = -(diameter / 2 + armT)
  // Horizontal blade and vertical blade, crossing at the hub.
  volumes.push({
    role: 'wing',
    offsetX: 0, offsetZ: faceZ,
    width: armLen, depth: armT,
    bottomY: hubY - armT / 2, height: armT,
    roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
    wallColor: 0x5a4030, roofColor: 0x5a4030,
    textured: false, cornice: false, floors: 1,
  })
  volumes.push({
    role: 'wing',
    offsetX: 0, offsetZ: faceZ,
    width: armT, depth: armT,
    bottomY: hubY - armLen / 2, height: armLen,
    roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
    wallColor: 0x5a4030, roofColor: 0x5a4030,
    textured: false, cornice: false, floors: 1,
  })
  return volumes
}

/* ------------------------------------------------------------------ */
/* Template selection                                                 */
/* ------------------------------------------------------------------ */

type TemplateFn = (ctx: MassingContext) => Volume[]

// Archetype template pools. IMPORTANT: tmplSimpleBody is deliberately
// excluded from every pool — a single textured box is the silhouette we're
// trying to eliminate. It only appears as the emergency fallback in
// pickMassing. Each pool now produces dramatic multi-volume compositions.
const TEMPLATES_BY_ARCHETYPE: Record<ArchetypeId, TemplateFn[]> = {
  traverseCozy: [
    tmplStepBack, tmplJettiedUpper, tmplJettiedUpper, tmplSteepGable,
    tmplTwinGables, tmplSideBay, tmplTallTowerHouse,
  ],
  nobleStone: [
    tmplCornerTower, tmplLShape, tmplStepBack, tmplStackedTower,
    tmplCrossPlan, tmplSideBay, tmplTallTowerHouse,
  ],
  halfTimberTudor: [
    tmplJettiedUpper, tmplJettiedUpper, tmplJettiedUpper, tmplLShape,
    tmplTwinGables, tmplSideBay, tmplStepBack, tmplSteepGable,
  ],
  medievalRustic: [
    tmplSteepGable, tmplSteepGable, tmplFarmstead, tmplFarmstead,
    tmplTwinGables, tmplPorchFront,
  ],
  mediterraneanStucco: [
    tmplLShape, tmplPorchFront, tmplStepBack, tmplStepBack,
    tmplCrossPlan, tmplSideBay,
  ],
  gothicStone: [
    tmplNaveTransept, tmplSpireEnd, tmplCornerTower,
    tmplAttachedChapel, tmplCrossPlan, tmplStackedTower,
    tmplTallTowerHouse,
  ],
}

// Landmark promotion: any generic building has this chance of being
// promoted to a dramatic silhouette template, regardless of archetype.
// Guarantees ~25% of buildings anywhere in town have an unmistakable
// vertical presence (tower, spire, keep, tall narrow house).
const LANDMARK_PROMOTION_CHANCE = 0.28
const DRAMATIC_POOL: TemplateFn[] = [
  tmplTallTowerHouse, tmplTallTowerHouse,
  tmplCornerTower, tmplStackedTower, tmplSpireEnd, tmplCrossPlan,
]

/** Definition-ID overrides for specialty buildings. Some fork probabilistically
 *  so e.g. half of cathedrals get a central spire tower (crossPlan) and half
 *  get a plain nave+transept cross. */
const DEF_OVERRIDE: Record<string, (ctx: MassingContext) => Volume[]> = {
  tower: (ctx) => tmplCircularTower(ctx, false),
  watchtower: (ctx) => tmplCircularTower(ctx, false),
  round_tower: (ctx) => tmplCircularTower(ctx, false),
  lighthouse: (ctx) => tmplCircularTower(ctx, true),
  bell_tower: (ctx) => rand01(ctx.hash, 503) < 0.5 ? tmplStackedTower(ctx) : tmplCornerTower(ctx),
  bell_tower_tall: (ctx) => rand01(ctx.hash, 505) < 0.6 ? tmplSpireEnd(ctx) : tmplStackedTower(ctx),
  clock_tower: (ctx) => rand01(ctx.hash, 507) < 0.55 ? tmplStackedTower(ctx) : tmplCornerTower(ctx),
  cathedral: (ctx) => rand01(ctx.hash, 509) < 0.6 ? tmplCrossPlan(ctx) : tmplNaveTransept(ctx),
  temple: (ctx) => rand01(ctx.hash, 511) < 0.5 ? tmplCrossPlan(ctx) : tmplNaveTransept(ctx),
  chapel: (ctx) => rand01(ctx.hash, 513) < 0.7 ? tmplSpireEnd(ctx) : tmplAttachedChapel(ctx),
  archway: (ctx) => tmplGatehouse(ctx),
  town_gate: (ctx) => tmplGatehouse(ctx),
  gatehouse: (ctx) => tmplGatehouse(ctx),
  windmill: (ctx) => tmplWindmill(ctx),
  stone_wall: (ctx) => tmplWallSegment(ctx),
  footbridge: (ctx) => tmplFootbridge(ctx),
  bridge: (ctx) => tmplStoneBridge(ctx),
  stone_bridge: (ctx) => tmplStoneBridge(ctx),
  arched_bridge: (ctx) => tmplStoneBridge(ctx),
  aqueduct: (ctx) => tmplStoneBridge(ctx),
  precinct_wall: (ctx) => tmplLowWall(ctx, true),
  precinct_wall_v: (ctx) => tmplLowWall(ctx, false),
  stone_wall_v: (ctx) => tmplWallSegment(ctx),
  crenellated_wall: (ctx) => tmplWallSegment(ctx),
  mansion: (ctx) => rand01(ctx.hash, 515) < 0.5 ? tmplCornerTower(ctx) : tmplLShape(ctx),
  guild_hall: (ctx) => rand01(ctx.hash, 517) < 0.5 ? tmplLShape(ctx) : tmplSideBay(ctx),
  inn: (ctx) => rand01(ctx.hash, 519) < 0.5 ? tmplSideBay(ctx) : tmplJettiedUpper(ctx),
  tavern: (ctx) => rand01(ctx.hash, 521) < 0.55 ? tmplSideBay(ctx) : tmplPorchFront(ctx),
  covered_market: (ctx) => tmplPorchFront(ctx),
  // A net loft is a tall store with its upper floor jettied out over the
  // quay, so a hoist can drop straight to a boat. A weigh house is an
  // arcaded public building you walk under. Both need a SILHOUETTE that is
  // not a row house, or they are wallpaper with a new name.
  net_loft: (ctx) => tmplJettiedUpper(ctx),
  weigh_house: (ctx) => tmplPorchFront(ctx),
  // The slum's pair. A tenement is a tall narrow stack — the tower-house
  // silhouette is exactly right and MAX_TOWER_ASPECT already stops it
  // needling. A lean-to is the only mono-pitch thing in town.
  tenement: (ctx) => tmplTenement(ctx),
  lean_to: (ctx) => tmplLeanTo(ctx),
  warehouse: (ctx) => tmplStepBack(ctx),
  stable: (ctx) => tmplFarmstead(ctx),
  mill: (ctx) => rand01(ctx.hash, 523) < 0.3 ? tmplWindmill(ctx) : tmplFarmstead(ctx),
}

/**
 * Rotate a Volume around the building's local origin by steps * 90°.
 * Swaps width↔depth, rotates offsetX/Z, and flips the roof ridge axis.
 * Circular volumes are unchanged. Use 0..3 for steps; other integers are
 * normalized mod 4.
 */
export function rotateVolume(v: Volume, steps: number): Volume {
  const n = ((steps % 4) + 4) % 4
  if (n === 0 || v.circular) return v
  let ox = v.offsetX, oz = v.offsetZ
  let w = v.width, d = v.depth
  let axis = v.roofAxis
  for (let i = 0; i < n; i++) {
    const nOx = -oz; const nOz = ox
    ox = nOx; oz = nOz
    const tmp = w; w = d; d = tmp
    axis = axis === 'x' ? 'z' : 'x'
  }
  return { ...v, offsetX: ox, offsetZ: oz, width: w, depth: d, roofAxis: axis }
}

export interface PickMassingInput {
  definitionId: string
  dominantArchetype: ArchetypeId
  sv: StyleVector
  hash: number
  footW: number
  footD: number
  wallH: number
  floors: number
  wallColor: number
  roofColor: number
}

export function pickMassing(input: PickMassingInput): MassingResult {
  const ctx: MassingContext = {
    sv: input.sv, hash: input.hash,
    footW: input.footW, footD: input.footD,
    wallH: input.wallH, floors: input.floors,
    wallColor: input.wallColor, roofColor: input.roofColor,
  }

  const override = DEF_OVERRIDE[input.definitionId]
  let volumes: Volume[]
  if (override) {
    volumes = override(ctx)
  } else if (rand01(input.hash, 901) < LANDMARK_PROMOTION_CHANCE) {
    // Landmark promotion — skip the archetype pool and pick a dramatic
    // vertical silhouette. Guarantees ~28% of generic buildings read as
    // towers, spires, keeps, or tall narrow houses.
    const idx = Math.floor(rand01(input.hash, 903) * DRAMATIC_POOL.length)
    volumes = DRAMATIC_POOL[Math.min(idx, DRAMATIC_POOL.length - 1)](ctx)
  } else {
    const options = TEMPLATES_BY_ARCHETYPE[input.dominantArchetype] ?? [tmplStepBack]
    const idx = Math.floor(rand01(input.hash, 301) * options.length)
    volumes = options[Math.min(idx, options.length - 1)](ctx)
  }

  // A flat volume with nothing stacked on top of it is an open box against
  // the sky — it reads as a half-built house. roofFromStyle returns 'flat' for
  // 65% of low-pitch styles, and while most flats are structural and hidden
  // (the body under a jetty, the block beneath a step-back penthouse), 14-16
  // per town were exposed. Give those a real roof, staying low-pitch so the
  // building keeps the character its style vector asked for.
  for (const v of volumes) {
    if (v.role === 'chimneyVol') continue // a chimney is meant to be open-topped
    const isFlat = v.roofStyle === 'flat' || v.roofStyle === 'none' || v.roofHeight <= 0
    if (!isFlat || v.height < 2.0) continue
    const covered = volumes.some(o =>
      o !== v && o.bottomY >= v.bottomY + v.height - 0.05 &&
      Math.abs(o.offsetX - v.offsetX) < (o.width + v.width) / 2 &&
      Math.abs(o.offsetZ - v.offsetZ) < (o.depth + v.depth) / 2)
    if (covered) continue
    const style: RoofStyle = rand01(input.hash, 907) < 0.5 ? 'hipped' : 'mansard'
    v.roofStyle = style
    v.roofHeight = roofHeightFor(style, v.height, ctx.sv)
    v.roofAxis = roofAxisFor(v.width, v.depth)
  }

  // Nothing may hang far outside the footprint the placer reserved.
  //
  // The audit checks FOOTPRINTS, so a building can pass every placement
  // invariant and still throw geometry through its neighbour — which is
  // exactly what the windmill's sails did for as long as they existed, at
  // three tiles of overhang per side. Jetties and eaves legitimately
  // overhang, so this is a generous ceiling meant to catch the runaway case,
  // not to tighten the style. Same idea as MAX_ROOF_SPAN_RATIO and
  // MAX_TOWER_ASPECT: cap a derived dimension against the thing it belongs to.
  const halfW = ctx.footW / 2 + MAX_OVERHANG
  const halfD = ctx.footD / 2 + MAX_OVERHANG
  for (const v of volumes) {
    // chimneyVol is anchored to a roof slope and is small by construction.
    if (v.role === 'chimneyVol') continue
    const loX = v.offsetX - v.width / 2, hiX = v.offsetX + v.width / 2
    const loZ = v.offsetZ - v.depth / 2, hiZ = v.offsetZ + v.depth / 2
    // CLIP to the allowed box rather than shrinking symmetrically. Shrinking
    // width by the overhang pulls BOTH edges in, which walks a wing away from
    // the wall it is attached to and leaves it floating. Recomputing the
    // extents and the offset from them moves only the edge that was outside.
    const nLoX = Math.max(loX, -halfW), nHiX = Math.min(hiX, halfW)
    const nLoZ = Math.max(loZ, -halfD), nHiZ = Math.min(hiZ, halfD)
    if (nLoX > loX || nHiX < hiX || nLoZ > loZ || nHiZ < hiZ) {
      const key = `${input.definitionId}:${v.role}`
      overhangClamps[key] = (overhangClamps[key] ?? 0) + 1
      v.width = Math.max(0.1, nHiX - nLoX)
      v.offsetX = (nLoX + nHiX) / 2
      v.depth = Math.max(0.1, nHiZ - nLoZ)
      v.offsetZ = (nLoZ + nHiZ) / 2
    }
  }

  // === COINCIDENT FACES ===
  //
  // Several templates put a volume's side face EXACTLY on the main body's:
  // the corner tower sits at `footW/2 - towerW/2`, the L-shape wing at
  // `wingSide * (footW/2 - wingW/2)`. Both make the outer face land on
  // footW/2 — the same plane as the main body's outer face. Two coplanar,
  // overlapping, same-facing quads is a depth-buffer tie, and it resolves
  // differently per pixel and per frame: the flickering overlapping textures
  // reported from the device.
  //
  // Nudging the attached volume OUTWARD by a couple of centimetres breaks the
  // tie. Outward rather than inward because these volumes are meant to read as
  // attached — pulling one in opens a visible seam, pushing it out just makes
  // it very slightly proud, well under the overhang cap it was clipped to.
  const ZFIGHT_EPS = 0.02
  for (const v of volumes) {
    if (v.role === 'mainBody') continue
    for (const o of volumes) {
      if (o === v) continue
      // Only a real tie if the two actually share vertical range; volumes
      // stacked on top of each other meet edge-on and cull cleanly.
      const vTop = v.bottomY + v.height, oTop = o.bottomY + o.height
      if (vTop <= o.bottomY + 0.01 || oTop <= v.bottomY + 0.01) continue
      for (const s of [-1, 1]) {
        if (Math.abs((v.offsetX + s * v.width / 2) - (o.offsetX + s * o.width / 2)) < ZFIGHT_EPS) {
          v.offsetX += s * ZFIGHT_EPS
        }
        if (Math.abs((v.offsetZ + s * v.depth / 2) - (o.offsetZ + s * o.depth / 2)) < ZFIGHT_EPS) {
          v.offsetZ += s * ZFIGHT_EPS
        }
      }
    }
  }

  // === HUMAN MINIMUMS ===
  //
  // Templates inset their volumes as a fraction of the footprint, and those
  // fractions compound: a jetty takes up to 54% off the lower floor, an L-wing
  // is 55% of the frontage, wealthScale takes another 22%. The result was
  // habitable volumes 0.55m across and 0.91m tall — a doghouse with a
  // full-size door painted on it, which is the "some buildings are tiny" half
  // of the scale complaint.
  //
  // Growing a volume is allowed to reach the same box the overhang clip just
  // enforced (footprint + MAX_OVERHANG) and no further, so this cannot undo
  // that clip or push geometry into a neighbour.
  const HABITABLE = new Set<VolumeRole>([
    'mainBody', 'wing', 'upperFloor', 'tower', 'penthouse', 'transept',
  ])
  for (const v of volumes) {
    if (!HABITABLE.has(v.role)) continue
    const maxW = ctx.footW + MAX_OVERHANG * 2
    const maxD = ctx.footD + MAX_OVERHANG * 2
    v.width = Math.min(maxW, Math.max(v.width, Math.min(MIN_HABITABLE_W, maxW)))
    v.depth = Math.min(maxD, Math.max(v.depth, Math.min(MIN_HABITABLE_W, maxD)))
    // A habitable storey has to clear a person's head. Towers and spires are
    // sized by their own rules and are never the short case.
    if (v.role === 'mainBody' || v.role === 'upperFloor') {
      v.height = Math.max(v.height, STOREY_HEIGHT)
    }
  }

  // === NO OPEN BOXES AGAINST THE SKY ===
  //
  // A flat top is a legitimate style when something sits on it. Exposed, it
  // reads as a building someone stopped working on — the other thing "half
  // built roofs" can mean. tools/roofcheck.mjs counts these; raising the
  // habitable minimum above pushed 50-odd per town past its 2m reporting
  // threshold, which did not create them, only revealed them.
  for (const v of volumes) {
    const isFlatTop = v.roofStyle === 'flat' || v.roofStyle === 'none' || v.roofHeight <= 0
    if (!isFlatTop || v.height < 2.0) continue
    const covered = volumes.some((o) =>
      o !== v && o.bottomY >= v.bottomY + v.height - 0.05 &&
      Math.abs(o.offsetX - v.offsetX) < (o.width + v.width) / 2 &&
      Math.abs(o.offsetZ - v.offsetZ) < (o.depth + v.depth) / 2)
    if (covered) continue
    // A shallow hip keeps the low-pitch look the style vector asked for while
    // closing the box. ensureRoofPitch below gives it a real rise.
    v.roofStyle = 'hipped'
    v.roofHeight = Math.min(v.width, v.depth) * 0.35
    v.roofAxis = roofAxisFor(v.width, v.depth)
  }

  // Roof heights are derived from wall height, so a slim volume could carry a
  // roof many times its own width. Clamp on the Volume itself — not just at
  // draw time — so every consumer of v.roofHeight (ridge caps, finials,
  // weather vanes, dormers, attic windows) positions against the roof that is
  // actually rendered instead of floating above a clipped cone.
  //
  // This runs AFTER the overhang clip, and the order is the whole point. It
  // used to run before, so a volume that got clipped narrower kept the roof
  // height computed for its original span. buildRoof re-clamps against the
  // real width and draws a shorter cone, while the finial still sits at the
  // old apex — which is why spires had ornaments hanging in the air above
  // their tips. clampRoofHeight is idempotent, so doing it last is safe.
  for (const v of volumes) {
    // Floor first (pitch for the span), ceiling second (span cap). The
    // minimum is strictly below the maximum for every style, so ordering
    // them this way cannot produce a roof that violates either.
    v.roofHeight = ensureRoofPitch(v.width, v.depth, v.roofHeight, v.roofStyle)
    v.roofHeight = clampRoofHeight(v.width, v.depth, v.roofHeight, v.roofStyle)
  }

  return { volumes, primaryFace: 'z+' }
}
