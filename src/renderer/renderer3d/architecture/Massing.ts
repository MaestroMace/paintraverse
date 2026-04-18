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

export type VolumeRole =
  | 'mainBody' | 'tower' | 'wing' | 'upperFloor' | 'spire'
  | 'porch' | 'transept' | 'penthouse' | 'chimneyVol'

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

/** Ground floor slightly smaller than the jetty'd upper floor. */
function tmplJettiedUpper(ctx: MassingContext): Volume[] {
  const lowerH = ctx.wallH * 0.42
  const upperH = ctx.wallH - lowerH
  const jetty = 0.25 + ctx.sv.overhang * 0.35   // 0.25–0.6 tile overhang, dramatic
  const lowerInsetFrac = Math.min(0.35, jetty / Math.max(ctx.footW, ctx.footD) * 0.9)
  const lowerW = Math.max(1.2, ctx.footW * (1 - lowerInsetFrac))
  const lowerD = Math.max(1.2, ctx.footD * (1 - lowerInsetFrac * 0.7))
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
      textured: true, cornice: false,
      floors: 1,
    },
    {
      role: 'upperFloor',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: lowerH, height: upperH,
      roofStyle: upperRoof, roofHeight: roofHeightFor(upperRoof, upperH, ctx.sv),
      roofAxis: roofAxisFor(ctx.footW, ctx.footD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: ctx.sv.cornice > 0.25,
      floors: Math.max(1, ctx.floors - 1),
    },
  ]
}

/** Tall primary body + a smaller penthouse / tower room on top. */
function tmplStepBack(ctx: MassingContext): Volume[] {
  const mainH = ctx.wallH * 0.78
  const topH = ctx.wallH - mainH + ctx.wallH * 0.15
  const topW = ctx.footW * 0.62
  const topD = ctx.footD * 0.62
  const mainRoof: RoofStyle = 'flat'
  const topRoof = roofFromStyle(ctx.sv, ctx.hash, 3)
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
      floors: Math.max(1, ctx.floors - 1),
    },
    {
      role: 'penthouse',
      offsetX: (rand01(ctx.hash, 31) - 0.5) * (ctx.footW - topW) * 0.6,
      offsetZ: (rand01(ctx.hash, 33) - 0.5) * (ctx.footD - topD) * 0.6,
      width: topW, depth: topD,
      bottomY: mainH, height: topH,
      roofStyle: topRoof, roofHeight: roofHeightFor(topRoof, topH, ctx.sv),
      roofAxis: roofAxisFor(topW, topD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: 1,
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
  const towerH = ctx.wallH * (1.5 + ctx.sv.wealth * 0.5)
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
  const spireW = Math.max(0.9, Math.min(ctx.footW, ctx.footD) * 0.35)
  const spireH = ctx.wallH * (1.6 + ctx.sv.wealth * 0.6)
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

/** Small cottage body + large visible chimney volume. */
function tmplCottageSmall(ctx: MassingContext): Volume[] {
  const bodyH = ctx.wallH * 0.85
  const bodyRoof: RoofStyle = rand01(ctx.hash, 29) < 0.6 ? 'steep' : 'gabled'
  const chimW = 0.55, chimH = bodyH * 1.35
  const chimSide = rand01(ctx.hash, 31) < 0.5 ? -1 : 1
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: bodyH,
      roofStyle: bodyRoof,
      roofHeight: roofHeightFor(bodyRoof, bodyH, ctx.sv),
      roofAxis: roofAxisFor(ctx.footW, ctx.footD),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: Math.max(1, ctx.floors - (rand01(ctx.hash, 33) < 0.5 ? 1 : 0)),
    },
    {
      role: 'chimneyVol',
      offsetX: chimSide * (ctx.footW / 2 + chimW * 0.2),
      offsetZ: (rand01(ctx.hash, 35) - 0.5) * ctx.footD * 0.5,
      width: chimW, depth: chimW,
      bottomY: 0, height: chimH,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: 0x6b4a38, roofColor: 0x6b4a38,
      textured: false, cornice: false,
      floors: 1,
    },
  ]
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
  const towerH = ctx.wallH * 1.25
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
  const towerH = ctx.wallH * (1.3 + ctx.sv.wealth * 0.4)
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

/** Humble farmstead: tiny body + attached lean-to shed with mono-pitch roof. */
function tmplFarmstead(ctx: MassingContext): Volume[] {
  const bodyRoof: RoofStyle = rand01(ctx.hash, 101) < 0.5 ? 'steep' : 'gabled'
  const shedW = Math.max(0.9, ctx.footW * 0.5)
  const shedD = Math.max(0.9, ctx.footD * 0.45)
  const shedH = ctx.wallH * 0.55
  const shedSide = rand01(ctx.hash, 103) < 0.5 ? -1 : 1
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: -shedD * 0.25,
      width: ctx.footW, depth: ctx.footD * 0.9,
      bottomY: 0, height: ctx.wallH,
      roofStyle: bodyRoof, roofHeight: roofHeightFor(bodyRoof, ctx.wallH, ctx.sv),
      roofAxis: roofAxisFor(ctx.footW, ctx.footD * 0.9),
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: 1,
    },
    {
      role: 'wing',
      offsetX: shedSide * (ctx.footW / 2 - shedW / 2),
      offsetZ: ctx.footD / 2 - shedD / 2 + 0.05,
      width: shedW, depth: shedD,
      bottomY: 0, height: shedH,
      roofStyle: 'hipped', roofHeight: shedH * 0.3,
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: false, cornice: false,
      floors: 1,
    },
  ]
}

/** Body + dramatic centered tall tower (like a keep). */
function tmplStackedTower(ctx: MassingContext): Volume[] {
  const mainRoof: RoofStyle = 'flat'
  const towerW = Math.max(1.2, Math.min(ctx.footW, ctx.footD) * 0.55)
  const towerH = ctx.wallH * (1.8 + ctx.sv.wealth * 0.4)
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
  // Four cross arms — thin long boxes as sail representation at upper body.
  const armLen = diameter * 2.2
  const armT = 0.14
  const armY = bodyH * 0.88
  const arms: Array<[number, number, boolean]> = [
    [armLen / 2, 0, true], [-armLen / 2, 0, true],
    [0, armLen / 2, false], [0, -armLen / 2, false],
  ]
  for (const [ox, oz, isX] of arms) {
    volumes.push({
      role: 'wing',
      offsetX: ox, offsetZ: oz,
      width: isX ? armLen : armT,
      depth: isX ? armT : armLen,
      bottomY: armY, height: armT,
      roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
      wallColor: 0x5a4030, roofColor: 0x5a4030,
      textured: false, cornice: false,
      floors: 1,
    })
  }
  return volumes
}

/* ------------------------------------------------------------------ */
/* Template selection                                                 */
/* ------------------------------------------------------------------ */

type TemplateFn = (ctx: MassingContext) => Volume[]

const TEMPLATES_BY_ARCHETYPE: Record<ArchetypeId, TemplateFn[]> = {
  traverseCozy: [
    tmplSimpleBody, tmplStepBack, tmplJettiedUpper, tmplPorchFront,
    tmplTwinGables, tmplSideBay,
  ],
  nobleStone: [
    tmplCornerTower, tmplLShape, tmplStepBack, tmplStackedTower,
    tmplCrossPlan, tmplSideBay,
  ],
  halfTimberTudor: [
    tmplJettiedUpper, tmplJettiedUpper, tmplLShape, tmplTwinGables,
    tmplSideBay, tmplStepBack,
  ],
  medievalRustic: [
    tmplCottageSmall, tmplSimpleBody, tmplPorchFront, tmplFarmstead,
    tmplFarmstead, tmplTwinGables,
  ],
  mediterraneanStucco: [
    tmplLShape, tmplPorchFront, tmplSimpleBody, tmplStepBack,
    tmplCrossPlan, tmplSideBay,
  ],
  gothicStone: [
    tmplNaveTransept, tmplSpireEnd, tmplCornerTower,
    tmplAttachedChapel, tmplCrossPlan, tmplStackedTower,
  ],
}

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
  mansion: (ctx) => rand01(ctx.hash, 515) < 0.5 ? tmplCornerTower(ctx) : tmplLShape(ctx),
  guild_hall: (ctx) => rand01(ctx.hash, 517) < 0.5 ? tmplLShape(ctx) : tmplSideBay(ctx),
  inn: (ctx) => rand01(ctx.hash, 519) < 0.5 ? tmplSideBay(ctx) : tmplJettiedUpper(ctx),
  tavern: (ctx) => rand01(ctx.hash, 521) < 0.55 ? tmplSideBay(ctx) : tmplPorchFront(ctx),
  covered_market: (ctx) => tmplPorchFront(ctx),
  warehouse: (ctx) => tmplSimpleBody(ctx),
  stable: (ctx) => tmplFarmstead(ctx),
  mill: (ctx) => rand01(ctx.hash, 523) < 0.3 ? tmplWindmill(ctx) : tmplSimpleBody(ctx),
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
  } else {
    const options = TEMPLATES_BY_ARCHETYPE[input.dominantArchetype] ?? [tmplSimpleBody]
    const idx = Math.floor(rand01(input.hash, 301) * options.length)
    volumes = options[Math.min(idx, options.length - 1)](ctx)
  }

  return { volumes, primaryFace: 'z+' }
}
