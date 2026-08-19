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
import { clampRoofHeight, ensureRoofPitch, riseForSpan, clampRoofToWall } from './Roofs'
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
  /**
   * A SURFACE THE PLAYER CAN STAND ON.
   *
   * `sampleGroundY` reads the terrain height map and nothing else, so until
   * this existed NO structure was ever a floor — not a bridge, not a stair,
   * not an elevated walkway. A previous session read the `passage` tag and
   * cleared the collision MASK over crossings, which lets you walk onto the
   * tile, and then the ground-follow put you on the river bed underneath.
   * Two authors of one floor. tools/traverse.mjs measured 58% of a town
   * reachable on foot because of it.
   *
   * Declared per VOLUME rather than inferred from a role or a tag, for the
   * reason `habitable` exists: `passage` means "a way through here" and is
   * true of a bridge you walk OVER and an archway you walk UNDER, so it
   * cannot answer this question. Only the template knows which of its pieces
   * is the deck.
   */
  walkable?: boolean
  /**
   * MASONRY, NOT A ROOM. Default (undefined) means the habitability rules
   * below apply by role — a `mainBody` is somewhere a person stands, so it is
   * floored at MIN_HABITABLE_W wide and STOREY_HEIGHT tall, and it grows a
   * roof rather than sit open to the sky.
   *
   * Every one of those is wrong for a bridge pier, a footbridge trestle or a
   * boundary wall, and all four of those templates used `mainBody` because it
   * is also how BuildingFactory finds the principal volume. So the role was
   * carrying two meanings and only one of them was true, which built:
   *
   *   authored              built
   *   0.22m trestle    ->   2.60m block
   *   0.70m pier       ->   2.60m block, 2.90m tall, with a HIPPED ROOF
   *   1.45m precinct   ->   2.90m tall, roofed  (CLAUDE.md still says 1.45)
   *   1.60m curtain    ->   2.60m thick
   *
   * A bridge came out as six roofed pavilions with a slab across them, which
   * is what the phone kept photographing and calling planks.
   */
  habitable?: boolean
}

/** Stamp a template's volumes as masonry — see Volume.habitable. */
function masonry(vols: Volume[]): Volume[] {
  for (const v of vols) v.habitable = false
  return vols
}

export interface MassingResult {
  volumes: Volume[]
  primaryFace: 'x+' | 'x-' | 'z+' | 'z-'
  /** Key for the geometry trace — see massingTrace. */
  traceId: number
}

// === GEOMETRY PROVENANCE ===
//
// A template declares a bridge pier 0.70m wide and the scene contains a 2.60m
// block. Between those two facts sit nine mutation passes — two flat-top roof
// repairs, an overhang clip, a z-fight nudge, the habitable minimum in THREE
// places, wealthScale, and two roof clamps — and until this existed, nothing
// anywhere could say which one did it, or that anything had.
//
// That is the root cause of a whole class of defect I could not see. Every
// audit in this repo grades a MODEL: footprints, tile ids, adjacency, prop
// bounds against a table I wrote by hand from the id (which was wrong three
// times). None of them asks the one question that has no judgement in it —
// **is the geometry in the world the geometry the code asked for?** The five
// defects found by photograph this session (2.6m piers, roofed piers, a 2.9m
// precinct wall, 2.6m footbridge trestles, merlons fused into a slab) were all
// that same question, and all five would have fallen out of one run of this.
//
// Snapshot the volume array at each named stage; the tool diffs consecutive
// snapshots, so attribution is exact rather than inferred. Off by default: it
// costs an array copy per building per stage.
export interface TracedVolume {
  role: string; w: number; d: number; h: number; rh: number
  /** Offsets too, because SIZE is only half the question: the habitable
   *  minimum grows a volume about its own centre without touching its offset,
   *  so a 0.7m bay window pinned 0.35m proud of the wall becomes a 2.6m room
   *  sticking 1.55m into the street — outside the box the overhang clip
   *  enforced two passes earlier. A size audit cannot see that. */
  ox: number; oz: number
  /** Needed to know which cap applies to the roof — see MAX_ROOF_SPAN_RATIO. */
  rs: string
}
export interface TraceRow {
  id: number; def: string; stage: string
  /** The footprint the placer reserved, in world metres. */
  fw: number; fd: number
  vols: TracedVolume[]
}
export const massingTrace: { on: boolean; rows: TraceRow[]; next: number } =
  { on: false, rows: [], next: 0 }

export function setMassingTrace(on: boolean): void {
  massingTrace.on = on
  massingTrace.rows = []
  massingTrace.next = 0
}

export function traceStage(
  id: number, def: string, stage: string, vols: Volume[], fw = 0, fd = 0,
): void {
  if (!massingTrace.on) return
  massingTrace.rows.push({
    id, def, stage, fw, fd,
    vols: vols.map((v) => ({
      role: v.role,
      w: +v.width.toFixed(3), d: +v.depth.toFixed(3),
      h: +v.height.toFixed(3), rh: +v.roofHeight.toFixed(3),
      ox: +v.offsetX.toFixed(3), oz: +v.offsetZ.toFixed(3),
      rs: v.roofStyle,
    })),
  })
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
export const MAX_OVERHANG = 0.6

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
export const MAX_TOWER_ASPECT = 4
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
  /**
   * HOW FAR THE GROUND FALLS ACROSS THIS FOOTPRINT, in world metres.
   *
   * `wy` — the Y a building is placed at — is the MAX terrain height over its
   * footprint, so it sits on the highest ground it covers and a stair-step
   * plinth fills in under the rest. That is right for a house on a slope and
   * exactly wrong for a span across a channel: the highest tile a bridge
   * covers is the BANK, so the whole assembly starts at bank level, the piers
   * never reach the water, and the deck is stacked on top of that.
   *
   * Measured on seed 31337 before the fix, all six bridges: decks 2.2-2.4m
   * above the bank (over a 1.6m eye height — you would climb over your own
   * head to board one), piers stopping 1.0-2.3m short of the bed, and ELEVEN
   * plinth columns per bridge filling the channel from bed to bank. Not a
   * bridge: a dam with an unreachable walkway on it.
   *
   * A template that spans a gap needs to know how deep the gap is. This is
   * maxTH - minTH, the same pair BuildingFactory already computes to size the
   * plinth — the value existed and simply never reached the templates.
   */
  groundDrop: number
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
      // TEXTURED, because this is the GROUND FLOOR, not a hidden plinth.
      // It was authored false on the reasoning that the body under a jetty is
      // structural and hidden. The jetty overhangs it, it does not conceal it:
      // this is the storey at eye level, the one a person walking the street
      // looks straight at, and on a shop it is the shopfront. odd.mjs ranked
      // it as the town's largest anomaly class — 36 of 42 findings, up to
      // 109m2 of flat colour against a peer median of zero, on shops,
      // bakeries and row houses reading "2 volumes, 1 textured".
      textured: true, cornice: false,
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
      floors: Math.max(ctx.floors + 1, Math.round(towerH / STOREY_HEIGHT)),
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
      floors: Math.max(3, Math.round(spireH / STOREY_HEIGHT)),
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
    floors: Math.max(3, Math.round(ctx.wallH / STOREY_HEIGHT)),
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
      floors: Math.max(2, Math.round(towerH / STOREY_HEIGHT)),
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
      floors: Math.max(2, Math.round(towerH / STOREY_HEIGHT)),
    },
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: Math.max(0.8, passageW), depth: ctx.footD,
      bottomY: passageH * 0.4, height: passageH * 0.6,
      roofStyle: passageRoof, roofHeight: 0,
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      // The chamber OVER the archway — a room between two towers, so it takes
      // a facade. Only the bridge, footbridge and boundary-wall templates are
      // genuinely masonry, and those declare habitable: false as well.
      textured: true, cornice: true,
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
      floors: Math.max(3, Math.round(towerH / STOREY_HEIGHT)),
    },
  ]
}

/** Body with a full-height projecting bay on one long side. */
function tmplSideBay(ctx: MassingContext): Volume[] {
  const mainRoof = roofFromStyle(ctx.sv, ctx.hash, 91)
  const bayW = Math.max(1.2, ctx.footW * 0.45)
  // A bay window projects about 0.7m. That is a PHYSICAL declaration, not a
  // fraction that might compound into a sliver, and the habitable minimum —
  // which exists for the compounding case — was turning it into a 2.6m room
  // bolted to the side of the house. Same argument as PropFactory's
  // `physical(m, span)`: pin a thing with an intrinsic size to a number.
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
      habitable: false,
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

/**
 * A COTTAGE IS A LOW WALL UNDER A BIG ROOF, and that ratio is the whole type.
 *
 * A row house in this town has a median wall of 7.5m and a roof at 41% of it.
 * Invert that — a wall of about a storey and a half, a roof taller than the
 * wall it sits on — and the silhouette is unmistakable from across a street
 * without a single new texture. It is also the one place in this repo where a
 * high roof-to-wall ratio is CORRECT rather than the black-triangle defect
 * `eyeball.mjs` reports, which is why the rise is asked for explicitly here
 * instead of being left to `roofHeightFor`.
 *
 * The dormer is a real volume rather than painted, because it has to break
 * the roofline: a cottage reads as a cottage from the roof down.
 */
function tmplCottage(ctx: MassingContext): Volume[] {
  // A STOREY AND A HALF, AS AN ABSOLUTE HEIGHT.
  //
  // The first cut wrote `max(STOREY_HEIGHT * 1.15, ctx.wallH * 0.55)`, and
  // `ctx.wallH` is whatever the generic building height would have been — so
  // on a tall plot the "low wall" came out at 7.7m and the roof, asked for as
  // `max(wallH * 1.05, ...)`, came out bigger still. asset.mjs reported the
  // result as `4 floors` and photographed a two-storey house under an
  // eight-metre black triangle: the exact defect eyeball.mjs tracks, written
  // deliberately into a new template.
  //
  // A cottage's height is INTRINSIC. It does not scale with what the plot
  // would otherwise have carried, any more than a door does — this is the
  // same rule MAX_OVERHANG and PropFactory's `physical()` already follow.
  const wallH = STOREY_HEIGHT * (1.35 + rand01(ctx.hash, 617) * 0.3)
  // GABLED ONLY, and the reason is a measurement rather than a preference.
  // Half of these were authored `steep`, and provenance reported that
  // population as p10 = med = p90 = 0.71 of span with `roofClamp` raising the
  // ask from 2.78m to 4.26m — `ensureRoofPitch` floors a steep roof at a
  // pitch far above what this template wants, so every steep cottage came out
  // at an identical 109% roof-to-wall while the gabled ones honoured the ask
  // (p10 0.47, med 0.52, p90 0.57, 0% at the cap).
  //
  // That is the documented pathology: a clamp a whole population sits exactly
  // on is not a clamp, it is the design, and the template's variation is
  // computed and thrown away. Asking for the style whose floor is BELOW the
  // range you want is what keeps the variation you wrote.
  const roofStyle: RoofStyle = 'gabled'
  const span = (ctx.footW + ctx.footD) / 2
  // Off the SPAN alone. Keying any part of the rise to the wall guarantees a
  // roof taller than the house, which is the thing this type is supposed to
  // demonstrate the good version of.
  const rise = span * (0.46 + rand01(ctx.hash, 619) * 0.12)
  const body: Volume = {
    role: 'mainBody',
    offsetX: 0, offsetZ: 0,
    width: ctx.footW, depth: ctx.footD,
    bottomY: 0, height: wallH,
    roofStyle, roofHeight: rise,
    roofAxis: ctx.footW >= ctx.footD ? 'x' : 'z',
    wallColor: ctx.wallColor, roofColor: ctx.roofColor,
    textured: true, cornice: false,
    floors: 1,
  }
  const out = [body]
  if (rand01(ctx.hash, 613) < 0.7) {
    const dw = Math.max(0.9, ctx.footW * 0.32)
    out.push({
      role: 'trim',
      offsetX: (rand01(ctx.hash, 615) - 0.5) * (ctx.footW - dw) * 0.6,
      offsetZ: ctx.footD * 0.22,
      width: dw, depth: Math.max(0.7, ctx.footD * 0.3),
      bottomY: wallH, height: rise * 0.42,
      roofStyle: 'gabled', roofHeight: rise * 0.3,
      roofAxis: 'z',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      // A dormer carries a window, so it must be painted, not a blank lump —
      // the largest anomaly class this repo ever found was a volume authored
      // `textured: false` on the reasoning that something else covered it.
      textured: true, cornice: false,
      habitable: false,
      floors: 1,
    })
  }
  return out
}

/**
 * A WASH HOUSE IS A ROOF ON POSTS WITH A VENT ON TOP.
 *
 * The communal lavoir: one low room, a wide hipped roof to throw the rain
 * clear of whoever is working under it, and a louvred lantern at the ridge to
 * let the steam out. That last piece is the recognisable bit and it is 40cm
 * of geometry — the same argument as the net loft's hoist jetty. Without it
 * this is a shed.
 */
function tmplWashhouse(ctx: MassingContext): Volume[] {
  // Absolute, for the reason spelled out in tmplCottage above: a fraction of
  // `ctx.wallH` is a fraction of a number that has nothing to do with what
  // this building is. One tall room.
  const wallH = STOREY_HEIGHT * (1.0 + rand01(ctx.hash, 621) * 0.2)
  const span = (ctx.footW + ctx.footD) / 2
  const rise = span * (0.34 + rand01(ctx.hash, 623) * 0.1)
  const ventW = Math.max(0.6, Math.min(ctx.footW, ctx.footD) * 0.3)
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: wallH,
      roofStyle: 'hipped', roofHeight: rise,
      roofAxis: ctx.footW >= ctx.footD ? 'x' : 'z',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: 1,
    },
    {
      role: 'trim',
      offsetX: 0, offsetZ: 0,
      width: ventW, depth: ventW,
      // ON the ridge, not in it. The comment here said "sits ON the ridge" and
      // the number said `rise * 0.72`, which on a hipped roof is well inside
      // the cone — the photograph came back with a plain apex and the one
      // feature that distinguishes a wash house from a shed was buried in its
      // own roof. 0.9 seats it just under the peak so it still meets solid
      // geometry, with the rest standing proud.
      bottomY: wallH + rise * 0.9, height: Math.max(0.5, rise * 0.28),
      roofStyle: 'hipped', roofHeight: Math.max(0.25, rise * 0.16),
      roofAxis: 'x',
      wallColor: ctx.roofColor, roofColor: ctx.roofColor,
      textured: false, cornice: false,
      // Not a room: 40cm of louvre must not be widened to MIN_HABITABLE_W,
      // which is the trap four templates fell into by using role 'mainBody'
      // for the two different things it used to mean.
      habitable: false,
      floors: 1,
    },
  ]
}

/**
 * A KILN IS THE ONE SILHOUETTE HERE THAT IS NEITHER A HOUSE NOR A SPIRE.
 *
 * A squat brick cone with a stack. Every other small building in this town is
 * a box with a pitched roof, so a truncated cone reads as "something is made
 * here" from across a quarter, which is exactly what the artisan quarter had
 * no way of saying — measured 8% and 0% distinctive, its top three types
 * building_small, row_house and corner_building.
 *
 * `circular: true` is what buys it: rotateVolume leaves circular volumes
 * alone, and `pointed` on a round base is a cone rather than a hip. The
 * stoke-hole shed against the flank stops it reading as a silo.
 *
 * Sized absolutely. A kiln is an installation with an intrinsic size — the
 * lesson the cottage template had to learn twice — so nothing here is a
 * fraction of `ctx.wallH`.
 */
function tmplKiln(ctx: MassingContext): Volume[] {
  // PROPORTIONED AGAINST ITS OWN DRUM, NOT AGAINST A STOREY.
  //
  // The first cut took `bodyH` from STOREY_HEIGHT and the cone at 1.15x that,
  // which on a 1.86m drum is a 4:1 needle — photographed as a slender turret
  // with a gold finial on the point, i.e. a false landmark on the skyline,
  // which is worse than no kiln at all. Exactly the cottage's mistake in a new
  // template: a thing with an intrinsic SHAPE cannot take its height from a
  // storey.
  //
  // A kiln is roughly as wide as it is tall. Everything below is a multiple of
  // the drum, so the proportion holds at any footprint, and the ornament pass's
  // finial then reads as the vent cap a bottle kiln actually has.
  const drum = Math.min(ctx.footW, ctx.footD) * 0.85
  const bodyH = drum * (0.72 + rand01(ctx.hash, 631) * 0.16)
  const shedW = Math.max(0.9, drum * 0.5)
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: drum, depth: drum,
      bottomY: 0, height: bodyH,
      // A tall cone on a short drum: the rise is most of the object, which is
      // what makes the profile read at distance.
      // HIPPED, NOT POINTED. `pointed` is in SPAN_PITCH and `ensureRoofPitch`
      // floors it at 1.3-2.35x the span because it is a spire style, so a
      // 2.17m cone came back 4.93m — provenance named the pass. On a circular
      // volume a hipped roof degenerates to a cone anyway, and hipped is not
      // in that table, so the rise the template asks for is the rise it gets.
      // Third time this session a style's own pitch floor overrode a
      // deliberately squat ask; check SPAN_PITCH before choosing a style.
      roofStyle: 'hipped', roofHeight: drum * 0.85,
      roofAxis: 'x',
      circular: true,
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: false, cornice: false,
      // AN OVEN IS NOT A ROOM. Without this the drum takes both habitable
      // floors — MIN_HABITABLE_W on the width and STOREY_HEIGHT on the height
      // — and provenance measured exactly that: `H 1.90 -> 2.90`, with 100% of
      // kiln bodies sitting on the storey floor. A 1.9m firing chamber raised
      // to a full storey and topped with a spire is the turret this
      // photographed as.
      habitable: false,
      floors: 1,
    },
    {
      role: 'wing',
      // On the LONG axis. A 1x2 plot is 3m across and 6m deep, so a shed
      // offset in x is half outside the footprint and gets clipped away.
      offsetX: 0, offsetZ: drum * 0.55,
      width: drum * 0.8, depth: shedW,
      bottomY: 0, height: bodyH * 0.55,
      roofStyle: 'gabled', roofHeight: bodyH * 0.3,
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      // A stoke hole is not a room. Without this the habitable minimum widens
      // it to 2.6m and the kiln comes back as two boxes.
      habitable: false,
      floors: 1,
    },
  ]
}

/**
 * A WORKSHOP IS A DWELLING WITH ITS GROUND FLOOR GIVEN OVER TO WORK.
 *
 * Living above, the trade below, and a canopy thrown out across the front so
 * the work spills into the street — which is the whole reason a craft quarter
 * feels different to walk through. The canopy is the recognisable piece and
 * it is 20cm of geometry, the same argument as the wash house's roof louvre.
 *
 * It hangs off `frontWallZ`-style geometry rather than the footprint edge:
 * `depth * 0.5` is the volume's own front face, and the volume is the thing
 * the canopy has to touch. Anchoring to the FOOTPRINT rectangle is the
 * documented family of bugs that put every sign and awning in this town some
 * nonzero distance in front of its wall.
 */
function tmplWorkshop(ctx: MassingContext): Volume[] {
  const wallH = STOREY_HEIGHT * (1.9 + rand01(ctx.hash, 633) * 0.5)
  const span = (ctx.footW + ctx.footD) / 2
  const body: Volume = {
    role: 'mainBody',
    offsetX: 0, offsetZ: 0,
    width: ctx.footW, depth: ctx.footD,
    bottomY: 0, height: wallH,
    roofStyle: 'gabled', roofHeight: span * (0.42 + rand01(ctx.hash, 635) * 0.1),
    roofAxis: ctx.footW >= ctx.footD ? 'x' : 'z',
    wallColor: ctx.wallColor, roofColor: ctx.roofColor,
    textured: true, cornice: false,
    floors: 2,
  }
  const canopyD = 0.85
  return [
    body,
    {
      role: 'trim',
      offsetX: 0,
      // Just proud of the volume's own front face, not the footprint's.
      offsetZ: ctx.footD / 2 + canopyD / 2 - 0.05,
      width: ctx.footW * 0.9, depth: canopyD,
      // Head height, so you can stand under it — a canopy you have to duck
      // for is the head-clearance failure the washing lines already taught.
      bottomY: STOREY_HEIGHT * 0.92, height: 0.2,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: ctx.roofColor, roofColor: ctx.roofColor,
      textured: false, cornice: false,
      habitable: false,
      floors: 1,
    },
  ]
}

/**
 * A SMOKEHOUSE IS A CHIMNEY YOU CAN WALK INTO.
 *
 * Tall, narrow and steep, with a louvred vent along the whole ridge instead of
 * a single cap — the draught is the building's entire purpose, so the vent is
 * the silhouette rather than an ornament on it. Nothing else in town is this
 * proportion: a 3m footprint carrying a 6m wall reads as a stack even before
 * the roof starts.
 *
 * Absolute heights, for the reason the cottage had to learn twice: a type
 * with an intrinsic shape cannot take its wall from `ctx.wallH`, which is
 * whatever the plot would otherwise have carried.
 */
function tmplSmokehouse(ctx: MassingContext): Volume[] {
  const wallH = STOREY_HEIGHT * (1.95 + rand01(ctx.hash, 641) * 0.35)
  const span = (ctx.footW + ctx.footD) / 2
  // `gabled`, not `steep`: steep is in SPAN_PITCH and ensureRoofPitch floors
  // it far above a deliberate ask, which pinned every steep cottage roof to
  // an identical 0.71 of span. Check that table before choosing a style.
  const rise = span * (0.6 + rand01(ctx.hash, 643) * 0.14)
  const ridgeAxis: 'x' | 'z' = ctx.footW >= ctx.footD ? 'x' : 'z'
  const ventLen = (ridgeAxis === 'x' ? ctx.footW : ctx.footD) * 0.66
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: wallH,
      roofStyle: 'gabled', roofHeight: rise,
      roofAxis: ridgeAxis,
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: 2,
    },
    {
      role: 'trim',
      offsetX: 0, offsetZ: 0,
      width: ridgeAxis === 'x' ? ventLen : 0.5,
      depth: ridgeAxis === 'x' ? 0.5 : ventLen,
      // ON the ridge. The wash house's louvre was authored at 0.72 of the
      // rise under a comment saying "on the ridge" and came back buried
      // inside its own roof; 0.9 seats it just under the peak with the rest
      // standing proud.
      bottomY: wallH + rise * 0.9, height: 0.42,
      roofStyle: 'gabled', roofHeight: 0.26,
      roofAxis: ridgeAxis,
      wallColor: ctx.roofColor, roofColor: ctx.roofColor,
      textured: false, cornice: false,
      // A louvre is not a room — without this both habitable floors widen it
      // to MIN_HABITABLE_W and raise it to a full storey, which is how the
      // kiln became a turret.
      habitable: false,
      floors: 1,
    },
  ]
}

/**
 * A BOATHOUSE IS A ROOF OVER A HOLE IN THE BANK.
 *
 * Low and wide with the gable turned to face the water, so the opening reads
 * end-on. Deliberately the opposite proportion to the smokehouse beside it:
 * the waterfront's problem was that everything in it looked like everything
 * else, so its two new types are as unlike each other as they are unlike a
 * row house.
 */
function tmplBoathouse(ctx: MassingContext): Volume[] {
  const wallH = STOREY_HEIGHT * (0.95 + rand01(ctx.hash, 645) * 0.2)
  const span = (ctx.footW + ctx.footD) / 2
  // Gable to the front, so the opening is under the point of the roof.
  const ridgeAxis: 'x' | 'z' = ctx.footW >= ctx.footD ? 'z' : 'x'
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: wallH,
      roofStyle: 'gabled', roofHeight: span * (0.5 + rand01(ctx.hash, 647) * 0.12),
      roofAxis: ridgeAxis,
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: 1,
    },
    {
      // A slipway lip at the front — the giveaway that boats come out here.
      role: 'trim',
      offsetX: 0, offsetZ: ctx.footD * 0.5 + 0.25,
      width: ctx.footW * 0.7, depth: 0.5,
      bottomY: 0, height: 0.18,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: ctx.roofColor, roofColor: ctx.roofColor,
      textured: false, cornice: false,
      habitable: false,
      floors: 1,
    },
  ]
}

/**
 * A CHANDLERY IS A SHOP WITH A HOIST OVER THE STREET.
 *
 * Ship's chandler: rope, tar, canvas and lanterns below, a loft above, and a
 * cat-head beam projecting from the gable so a bale can be swung up off a
 * cart. That beam is the entire silhouette — a horizontal stick poking out
 * of a gable end at four metres is unlike anything else in the town, and it
 * reads at the 100ft distance where a door or a window does not.
 *
 * Tall and narrow on a 1x2, because a harbour street is a wall of them.
 */
function tmplChandlery(ctx: MassingContext): Volume[] {
  const wallH = STOREY_HEIGHT * (2.0 + rand01(ctx.hash, 1401) * 0.45)
  const span = (ctx.footW + ctx.footD) / 2
  // `gabled`, never `steep` — steep is in SPAN_PITCH and ensureRoofPitch
  // floors it far above a deliberate ask.
  const rise = span * (0.5 + rand01(ctx.hash, 1403) * 0.14)
  const ridgeAxis: 'x' | 'z' = ctx.footW >= ctx.footD ? 'x' : 'z'
  // THE BEAM PROJECTS FROM THE GABLE END, WHICH IS PERPENDICULAR TO THE
  // RIDGE, and the first cut had that inverted. `roofAxis` names the axis the
  // ridge RUNS ALONG — settle it against tmplSmokehouse, whose vent runs the
  // length of the ridge and is `width: ridgeAxis === 'x' ? ventLen : 0.5`,
  // rather than by reasoning about it. So a ridge along Z has its gables on
  // ±Z, and the beam must project in Z too.
  //
  // On a 1x2 the ridge runs along the long axis, which is the depth, so the
  // gable is the 3m-wide face that meets the street. That is the whole point
  // of the type: a harbour street is a wall of narrow gables.
  //
  // AND IT HAS TO FIT THE OVERHANG BUDGET. A 1.05m stick centred half a
  // length past the wall reaches 0.42m beyond MAX_OVERHANG, so the clip would
  // have shaved it even on the right face. Sized so the OUTER end lands just
  // inside the budget and the inner end is buried in the wall — which is also
  // how a real cat-head is built, as the end of a beam running back into the
  // roof frame rather than a stick nailed on the outside.
  //
  // Both failures agreed on "invisible", which is why the photograph was
  // needed: a count of volumes emitted would have said the beam was there.
  const alongZ = ridgeAxis === 'z'
  const beamLen = 1.0
  const gableHalf = (alongZ ? ctx.footD : ctx.footW) / 2
  const beamCtr = gableHalf + (MAX_OVERHANG - 0.05) - beamLen / 2
  const outX = alongZ ? 0 : beamCtr
  const outZ = alongZ ? beamCtr : 0
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: wallH,
      roofStyle: 'gabled', roofHeight: rise,
      roofAxis: ridgeAxis,
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: 2,
    },
    {
      // The cat-head. Sits just under the eave so the block hangs clear of
      // the wall below it, which is what makes the hoist legible.
      role: 'trim',
      offsetX: outX, offsetZ: outZ,
      width: alongZ ? 0.16 : beamLen,
      depth: alongZ ? beamLen : 0.16,
      bottomY: wallH - 0.34, height: 0.18,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: 0x5f4d38, roofColor: 0x5f4d38,
      textured: false, cornice: false,
      // A beam is not a room. Without this the habitable minimum widens it to
      // MIN_HABITABLE_W and it comes out a 2.6m block bolted to the gable —
      // the failure that made a bridge pier a roofed pavilion.
      habitable: false,
      floors: 1,
    },
  ]
}

/**
 * A CUSTOMS HOUSE IS THE ONE CIVIC BUILDING ON THE QUAY.
 *
 * Arcaded ground floor — you shelter under it while your cargo is assessed —
 * a squat hipped roof, and a lantern cupola on the ridge so the harbourmaster
 * can see the roads. The cupola is the point: it is the only vertical accent
 * in a quarter otherwise made of long low warehouses, so it terminates a view
 * down the quay the way a bell tower terminates a street inland.
 *
 * Capped at one per quarter in MAX_PER_DISTRICT. An institution repeated is
 * not an institution, which the sexton's hut taught expensively.
 */
function tmplCustomsHouse(ctx: MassingContext): Volume[] {
  const wallH = STOREY_HEIGHT * (1.85 + rand01(ctx.hash, 1411) * 0.3)
  const span = (ctx.footW + ctx.footD) / 2
  const rise = span * (0.36 + rand01(ctx.hash, 1413) * 0.08)
  const stone = 0xb0a58c
  const vols: Volume[] = [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: wallH,
      roofStyle: 'hipped', roofHeight: rise,
      roofAxis: ctx.footW >= ctx.footD ? 'x' : 'z',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: 2,
    },
    {
      // Lantern cupola, ON the hip rather than in it: a hipped roof is a
      // truncated pyramid, so 0.9 of the rise is just under the peak. The
      // wash house's louvre was authored at 0.72 and came back buried inside
      // its own roof, which is the same arithmetic getting the same answer.
      role: 'trim',
      offsetX: 0, offsetZ: 0,
      width: Math.min(1.15, ctx.footW * 0.32),
      depth: Math.min(1.15, ctx.footD * 0.32),
      bottomY: wallH + rise * 0.9, height: 0.85,
      roofStyle: 'pointed', roofHeight: 0.7,
      roofAxis: 'x',
      wallColor: stone, roofColor: ctx.roofColor,
      textured: false, cornice: false,
      habitable: false,
      floors: 1,
    },
  ]
  // Arcade piers along the street face. Four short posts under a lintel read
  // as an arcade at this scale; a real arch ring does not survive RENDER_SCALE.
  const front = ctx.footD / 2
  const pierT = 0.26
  const arcW = ctx.footW * 0.88
  for (let i = 0; i < 4; i++) {
    vols.push({
      role: 'trim',
      offsetX: -arcW / 2 + (arcW * i) / 3, offsetZ: front + 0.42,
      width: pierT, depth: pierT,
      bottomY: 0, height: STOREY_HEIGHT * 0.98,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: stone, roofColor: stone,
      textured: false, cornice: false,
      habitable: false,
      floors: 1,
    })
  }
  vols.push({
    role: 'trim',
    offsetX: 0, offsetZ: front + 0.42,
    width: arcW + pierT, depth: 0.9,
    bottomY: STOREY_HEIGHT * 0.98, height: 0.3,
    roofStyle: 'flat', roofHeight: 0,
    roofAxis: 'x',
    wallColor: stone, roofColor: stone,
    textured: false, cornice: false,
    habitable: false,
    floors: 1,
  })
  return vols
}

/**
 * A GUARDHOUSE IS A FLAT ROOF YOU CAN STAND ON.
 *
 * One low storey, a parapet round the top instead of a pitch, and a sentry
 * box at one corner. Every other building in a fortress quarter is a tower,
 * so the thing that distinguishes this one is that it has no roof at all: a
 * flat, crenellated line at four metres beside four pointed cones is a
 * silhouette no other quarter in the town produces.
 */
function tmplGuardhouse(ctx: MassingContext): Volume[] {
  const wallH = STOREY_HEIGHT * (1.15 + rand01(ctx.hash, 1421) * 0.25)
  const stone = 0x9a978f
  const vols: Volume[] = [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: wallH,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: 1,
    },
  ]
  // Parapet: four thin walls standing on the roof edge. Emitted as a ring
  // rather than one box, so you read the walk behind it.
  const pT = 0.2, pH = 0.55
  for (const [dx, dz, w, d] of [
    [0, ctx.footD / 2 - pT / 2, ctx.footW, pT],
    [0, -(ctx.footD / 2 - pT / 2), ctx.footW, pT],
    [ctx.footW / 2 - pT / 2, 0, pT, ctx.footD - pT * 2],
    [-(ctx.footW / 2 - pT / 2), 0, pT, ctx.footD - pT * 2],
  ] as const) {
    vols.push({
      role: 'trim',
      offsetX: dx, offsetZ: dz,
      width: w, depth: d,
      bottomY: wallH, height: pH,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: stone, roofColor: stone,
      textured: false, cornice: false,
      habitable: false,
      floors: 1,
    })
  }
  // Sentry box in one corner, roofed, so the flat top has one thing on it.
  const boxW = Math.min(0.85, ctx.footW * 0.42)
  const cs = rand01(ctx.hash, 1423) < 0.5 ? 1 : -1
  vols.push({
    role: 'trim',
    offsetX: cs * (ctx.footW / 2 - boxW / 2 - pT),
    offsetZ: ctx.footD / 2 - boxW / 2 - pT,
    width: boxW, depth: boxW,
    bottomY: wallH, height: 1.35,
    roofStyle: 'pointed', roofHeight: 0.55,
    roofAxis: 'x',
    wallColor: stone, roofColor: ctx.roofColor,
    textured: false, cornice: false,
    habitable: false,
    floors: 1,
  })
  return vols
}

/**
 * AN ARMOURY IS THICK WALLS AND SMALL HIGH WINDOWS.
 *
 * Squat, wide-eaved, hipped, with a buttress on each flank. Deliberately the
 * opposite proportion to the guardhouse standing next to it — the fortress
 * quarter's failure was that everything in it was a tower, so its two new
 * types have to be unlike each other as well as unlike a tower.
 */
function tmplArmory(ctx: MassingContext): Volume[] {
  const wallH = STOREY_HEIGHT * (1.45 + rand01(ctx.hash, 1431) * 0.25)
  const span = (ctx.footW + ctx.footD) / 2
  const stone = 0x8b8a86
  const vols: Volume[] = [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: wallH,
      roofStyle: 'hipped', roofHeight: span * (0.4 + rand01(ctx.hash, 1433) * 0.1),
      roofAxis: ctx.footW >= ctx.footD ? 'x' : 'z',
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: true,
      floors: 1,
    },
  ]
  // A buttress on each flank — battered, so it is wider at the foot. Two
  // stacked boxes rather than a taper, because the batter has to survive
  // RENDER_SCALE and a 4cm slope does not.
  for (const s of [-1, 1]) {
    vols.push({
      role: 'trim',
      offsetX: s * (ctx.footW / 2 + 0.16), offsetZ: 0,
      width: 0.42, depth: Math.min(1.0, ctx.footD * 0.34),
      bottomY: 0, height: wallH * 0.55,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: stone, roofColor: stone,
      textured: false, cornice: false,
      habitable: false,
      floors: 1,
    })
    vols.push({
      role: 'trim',
      offsetX: s * (ctx.footW / 2 + 0.09), offsetZ: 0,
      width: 0.28, depth: Math.min(0.8, ctx.footD * 0.28),
      bottomY: wallH * 0.55, height: wallH * 0.4,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: stone, roofColor: stone,
      textured: false, cornice: false,
      habitable: false,
      floors: 1,
    })
  }
  return vols
}

/**
 * THE SHAMBLES — a jetty deep enough to be the whole point.
 *
 * The butchers' row. Its upper floors lean out over the lane until the eaves
 * of facing houses nearly meet, because the ground floor is an open stall
 * counter and the overhang keeps the sun off the meat. York's Shambles is the
 * reference; it is one of the most photographed streets in England and the
 * only reason is this proportion.
 *
 * `tmplJettiedUpper` exists and is NOT reused, deliberately: its overhang is
 * a polite 0.25m and the character here is an impolite one. It also jetties
 * one face; this jetties the street face hard and both flanks a little, which
 * is what makes a ROW of them close over the lane.
 */
function tmplShambles(ctx: MassingContext): Volume[] {
  const lowerH = STOREY_HEIGHT * (1.0 + rand01(ctx.hash, 1441) * 0.12)
  const upperH = STOREY_HEIGHT * (1.15 + rand01(ctx.hash, 1443) * 0.25)
  // MAX_OVERHANG is 0.6m and clipToFootprint enforces it per side against
  // whichever neighbours actually exist, so ask for the full budget and let
  // the clip decide. Asking for less would make a terrace of these look
  // ordinary on precisely the tiles where the overhang would have read.
  const jut = MAX_OVERHANG
  const span = (ctx.footW + ctx.footD) / 2
  const ridgeAxis: 'x' | 'z' = ctx.footW >= ctx.footD ? 'x' : 'z'
  return [
    {
      role: 'mainBody',
      offsetX: 0, offsetZ: 0,
      width: ctx.footW, depth: ctx.footD,
      bottomY: 0, height: lowerH,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: ridgeAxis,
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      // TEXTURED. The ground floor under a jetty was authored blank on the
      // reasoning that it is hidden, and it is not — the jetty OVERHANGS it.
      // That single call was the largest anomaly class in the town: 36
      // findings over z=3, up to 109m² of flat colour at eye level. On a
      // shambles it is the shopfront.
      textured: true, cornice: false,
      floors: 1,
    },
    {
      role: 'upperFloor',
      offsetX: 0, offsetZ: jut * 0.5,
      width: ctx.footW + jut * 0.5, depth: ctx.footD + jut,
      bottomY: lowerH, height: upperH,
      roofStyle: 'gabled', roofHeight: span * (0.52 + rand01(ctx.hash, 1445) * 0.12),
      roofAxis: ridgeAxis,
      wallColor: ctx.wallColor, roofColor: ctx.roofColor,
      textured: true, cornice: false,
      floors: 1,
    },
    {
      // The stall counter: a board on the street face at waist height, which
      // is what the ground floor is FOR. 0.95m — hip height on a 1.6m eye,
      // and the one dimension here that is a real-world measurement rather
      // than a fraction.
      role: 'trim',
      offsetX: 0, offsetZ: ctx.footD / 2 + 0.22,
      width: ctx.footW * 0.82, depth: 0.44,
      bottomY: 0.95, height: 0.12,
      roofStyle: 'flat', roofHeight: 0,
      roofAxis: 'x',
      wallColor: 0x8a6f4e, roofColor: 0x8a6f4e,
      textured: false, cornice: false,
      habitable: false,
      floors: 1,
    },
  ]
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
      floors: Math.max(3, Math.round(towerH / STOREY_HEIGHT)),
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
  // SAME DEFECT AS THE STONE BRIDGE, and found by the sibling sweep rather
  // than by a second measurement: `deckY = 1.15` measured UP from a placement
  // base that is the highest ground the footprint covers — the bank — with
  // trestles starting there instead of at the bed. A bug in one template is a
  // bug in the PATTERN; the two crossings are the pattern.
  const CAMBER = 0.16
  const deckT = 0.16
  const drop = Math.min(6, Math.max(0.6, ctx.groundDrop))
  const deckY = drop + CAMBER - deckT   // trestle top, measured from the BED
  const span = Math.max(ctx.footW, 2.4)
  const wood = 0x7a6244
  const vols: Volume[] = []
  // Two trestles down into the bed.
  for (const s of [-1, 1]) {
    vols.push({
      role: 'mainBody',
      offsetX: s * (span * 0.32), offsetZ: 0,
      width: 0.22, depth: 0.22,
      bottomY: -drop, height: deckY,
      roofStyle: 'none', roofHeight: 0, roofAxis: 'x',
      wallColor: 0x5a4a34, roofColor: 0x5a4a34,
      textured: false, cornice: false, floors: 1,
    })
  }
  // The deck itself, a touch proud of the tile so consecutive tiles read as
  // one continuous run rather than a dotted line of separate planks.
  vols.push({
    role: 'trim',
    walkable: true,
    offsetX: 0, offsetZ: 0,
    width: span + 0.12, depth: ctx.footD + 0.12,
    bottomY: CAMBER - deckT, height: deckT,
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
      bottomY: CAMBER, height: 0.62,
      roofStyle: 'none', roofHeight: 0, roofAxis: 'x',
      wallColor: 0x6a5640, roofColor: 0x6a5640,
      textured: false, cornice: false, floors: 1,
    })
  }
  return masonry(vols)
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
  // THE DECK MEETS THE BANK; THE PIERS GO DOWN TO THE BED.
  //
  // This used to read `const deckY = 1.85` — "clear of the waterline with
  // headroom for a skiff underneath" — measured UP from the placement base.
  // But the base is the highest ground the footprint covers, which for a
  // crossing is the bank, so the deck ended up 2.2-2.4m above the ground you
  // walk in from and the piers hung 1-2.3m above the water they are supposed
  // to stand in. The headroom the old constant was buying is real and it
  // belongs BELOW the deck, not above the bank.
  //
  // So the deck lands a short camber above the bank — a real bridge rises
  // slightly to its crown, and a step you can take is the whole point — and
  // the piers are as tall as the drop to the bed plus that camber.
  const CAMBER = 0.22
  const deckT = 0.34
  // Clamped so a crossing on nearly flat ground still reads as a bridge rather
  // than a kerb, and a freak drop does not build a viaduct.
  const drop = Math.min(6, Math.max(0.8, ctx.groundDrop))
  const deckY = drop + CAMBER - deckT   // pier top, measured from the BED
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
      // NEGATIVE, because the placement base is the bank and the bed is below
      // it. Nothing else in the massing library descends; a bridge is the one
      // thing that has to.
      bottomY: -drop, height: deckY,
      roofStyle: 'none', roofHeight: 0, roofAxis: 'x',
      wallColor: stone, roofColor: stone,
      textured: false, cornice: false, floors: 1,
    })
  }
  // The deck, slightly over-long so consecutive bridge tiles read as one run
  // rather than a dotted line — the same trick the footbridge uses.
  vols.push({
    role: 'trim',
    walkable: true,
    offsetX: 0, offsetZ: 0,
    width: (longAxisX ? span : wide) + 0.14,
    depth: (longAxisX ? wide : span) + 0.14,
    bottomY: CAMBER - deckT, height: deckT,
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
      bottomY: CAMBER, height: 0.78,
      roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
      wallColor: parapet, roofColor: parapet,
      textured: false, cornice: false, floors: 1,
    })
  }
  return masonry(vols)
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
  return masonry(volumes)
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
  // Masonry, and the MERLONS need it as much as the curtain does: they are
  // `penthouse`, which is in HABITABLE, so each 1.0m block was floored to
  // 2.6m against a 1.2m pitch — every merlon overlapped its neighbours and
  // the crenellation rendered as one solid slab.
  return masonry(volumes)
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
    floors: Math.max(3, Math.round(bodyH / STOREY_HEIGHT)),
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
  // Horizontal blade and vertical blade, crossing at the hub. A SAIL is 16cm
  // of timber lattice — habitable: false, or the room-width minimum builds it
  // as a 2.6m slab, which tools/provenance.mjs measured at x16 the authored
  // depth. The windmill has been blamed four times in CLAUDE.md for defects it
  // had nothing to do with; this one is real and it was never visible because
  // no audit compared the built sail against the declared one.
  volumes.push({
    role: 'wing',
    offsetX: 0, offsetZ: faceZ,
    width: armLen, depth: armT,
    bottomY: hubY - armT / 2, height: armT,
    roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
    wallColor: 0x5a4030, roofColor: 0x5a4030,
    textured: false, cornice: false, floors: 1, habitable: false,
  })
  volumes.push({
    role: 'wing',
    offsetX: 0, offsetZ: faceZ,
    width: armT, depth: armT,
    bottomY: hubY - armLen / 2, height: armLen,
    roofStyle: 'flat', roofHeight: 0, roofAxis: 'x',
    wallColor: 0x5a4030, roofColor: 0x5a4030,
    textured: false, cornice: false, floors: 1, habitable: false,
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
  // The ordinary quarter's pair. Both invert the town's usual proportion — a
  // low wall under a big roof — which is a silhouette no other type here has
  // and costs nothing but the massing.
  cottage: (ctx) => tmplCottage(ctx),
  washhouse: (ctx) => tmplWashhouse(ctx),
  // The craft quarter's pair — a cone and a canopy, neither of which any
  // other type in the town produces.
  kiln: (ctx) => tmplKiln(ctx),
  workshop: (ctx) => tmplWorkshop(ctx),
  // The waterfront's pair, deliberately opposite proportions to each other.
  smokehouse: (ctx) => tmplSmokehouse(ctx),
  boathouse: (ctx) => tmplBoathouse(ctx),
  // Harbor's pair: the ordinary building of the quarter and its institution.
  chandlery: (ctx) => tmplChandlery(ctx),
  customs_house: (ctx) => tmplCustomsHouse(ctx),
  // Fortress's pair, and the same rule applies — a flat parapeted block and a
  // squat buttressed one, so the quarter is not four towers and a warehouse.
  guardhouse: (ctx) => tmplGuardhouse(ctx),
  armory: (ctx) => tmplArmory(ctx),
  shambles: (ctx) => tmplShambles(ctx),
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
  /** Ground fall across the footprint — see MassingContext.groundDrop. */
  groundDrop?: number
}


/**
 * Clip every volume back inside the footprint the placer reserved, plus
 * MAX_OVERHANG. The hard invariant of the massing pipeline, and therefore the
 * LAST thing that may touch an extent — see the note at its call site.
 */
/**
 * Per-side overhang allowance, in METRES, in the building's LOCAL frame.
 *
 * MAX_OVERHANG is a per-building budget and the gap between two buildings is
 * SHARED, so two neighbours each spending 0.6m toward each other produce 1.2m
 * of interpenetrating geometry — and tools/clash.mjs says every one of the 97
 * deep overlaps in a town is exactly that: a pair whose reserved footprints
 * touch. The cap was never wrong about one building; it had no way to know
 * anyone was on the other side.
 *
 * A jetty overhangs the STREET. Where a neighbour stands, the wall stops at
 * the plot line, which is what a party wall is.
 */
export interface OverhangAllowance { nx: number; px: number; nz: number; pz: number }

export function clipToFootprint(
  volumes: Volume[], footW: number, footD: number, definitionId: string,
  allow?: OverhangAllowance,
): void {
  const axLo = allow?.nx ?? MAX_OVERHANG, axHi = allow?.px ?? MAX_OVERHANG
  const azLo = allow?.nz ?? MAX_OVERHANG, azHi = allow?.pz ?? MAX_OVERHANG
  const loX = -footW / 2 - axLo, hiX = footW / 2 + axHi
  const loZ = -footD / 2 - azLo, hiZ = footD / 2 + azHi
  for (const v of volumes) {
    // chimneyVol is anchored to a roof slope and is small by construction.
    if (v.role === 'chimneyVol') continue
    // SLIDE BEFORE YOU SHAVE.
    //
    // The clip must run last — that ordering is what took 39 volumes-outside-
    // the-box to 0 — but "last" only decides WHEN, not HOW, and shaving was
    // the wrong how. A volume hanging off one edge lost everything past it,
    // floored at 0.1m, so a 2.6m wing pushed out by wealthScale came back as a
    // 1.20m x 10.49m splinter: an aspect of nearly 9:1, standing on an
    // ordinary row house. tools/facade.mjs found them sideways, as a window
    // painted corner to corner on a wall too narrow to hold one.
    //
    // A volume that FITS in the box and merely sits in the wrong place does
    // not need to lose anything; it needs to move. Sliding is also a
    // restoration rather than a distortion here, because the templates author
    // a wing flush inside the footprint and it is wealthScale — which
    // multiplies offsets as well as extents — that walks it out. Shaving is
    // kept for the case it was written for: a volume genuinely WIDER than the
    // box, where there is nowhere to slide to.
    let vLoX = v.offsetX - v.width / 2, vHiX = v.offsetX + v.width / 2
    let vLoZ = v.offsetZ - v.depth / 2, vHiZ = v.offsetZ + v.depth / 2
    if (v.width <= hiX - loX) {
      const slide = Math.max(0, loX - vLoX) - Math.max(0, vHiX - hiX)
      vLoX += slide; vHiX += slide
    }
    if (v.depth <= hiZ - loZ) {
      const slide = Math.max(0, loZ - vLoZ) - Math.max(0, vHiZ - hiZ)
      vLoZ += slide; vHiZ += slide
    }
    v.offsetX = (vLoX + vHiX) / 2
    v.offsetZ = (vLoZ + vHiZ) / 2
    // CLIP to the allowed box rather than shrinking symmetrically. Shrinking
    // width by the overhang pulls BOTH edges in, which walks a wing away from
    // the wall it is attached to and leaves it floating. Recomputing the
    // extents and the offset from them moves only the edge that was outside.
    const nLoX = Math.max(vLoX, loX), nHiX = Math.min(vHiX, hiX)
    const nLoZ = Math.max(vLoZ, loZ), nHiZ = Math.min(vHiZ, hiZ)
    if (nLoX > vLoX || nHiX < vHiX || nLoZ > vLoZ || nHiZ < vHiZ) {
      const key = `${definitionId}:${v.role}`
      overhangClamps[key] = (overhangClamps[key] ?? 0) + 1
      v.width = Math.max(0.1, nHiX - nLoX)
      v.offsetX = (nLoX + nHiX) / 2
      v.depth = Math.max(0.1, nHiZ - nLoZ)
      v.offsetZ = (nLoZ + nHiZ) / 2
    }
  }

}

export function pickMassing(input: PickMassingInput): MassingResult {
  const ctx: MassingContext = {
    sv: input.sv, hash: input.hash,
    footW: input.footW, footD: input.footD,
    wallH: input.wallH, floors: input.floors,
    wallColor: input.wallColor, roofColor: input.roofColor,
    groundDrop: Math.max(0, input.groundDrop ?? 0),
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
  const traceId = massingTrace.next++
  traceStage(traceId, input.definitionId, 'template', volumes, ctx.footW, ctx.footD)

  // A flat volume with nothing stacked on top of it is an open box against
  // the sky — it reads as a half-built house. roofFromStyle returns 'flat' for
  // 65% of low-pitch styles, and while most flats are structural and hidden
  // (the body under a jetty, the block beneath a step-back penthouse), 14-16
  // per town were exposed. Give those a real roof, staying low-pitch so the
  // building keeps the character its style vector asked for.
  // NOTE: there is a second, near-identical pass at "NO OPEN BOXES AGAINST THE
  // SKY" below, with different constants. Both are live and both need every
  // guard — this one sees the AUTHORED heights and that one sees the heights
  // after the habitable minimum has raised them, which is how a 1.85m pier
  // slipped past the 2.0m threshold here and was roofed down there.
  for (const v of volumes) {
    if (v.role === 'chimneyVol') continue // a chimney is meant to be open-topped
    if (v.habitable === false) continue   // a pier and a parapet end in sky
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

  traceStage(traceId, input.definitionId, 'roofRepair', volumes, ctx.footW, ctx.footD)


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
    if (!HABITABLE.has(v.role) || v.habitable === false) continue
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

  traceStage(traceId, input.definitionId, 'minHabitable', volumes, ctx.footW, ctx.footD)

  // === THE CLIP RUNS LAST, AND THAT IS THE WHOLE POINT ===
  //
  // It used to run BEFORE the habitable minimum, which is two passes before
  // the thing that undoes it. The minimum grows a volume about its own centre
  // and never touches the offset, so `tmplSideBay`'s 0.7m projecting bay —
  // pinned 0.35m proud of the wall, as a bay window is — came out 2.6m deep
  // and reaching 1.55m into the street. 39 volumes a town ended up outside the
  // box this clip exists to enforce, all of them wings, up to 1.5m proud.
  //
  // Nothing caught it because the existing instruments count the clip FIRING
  // (overhangClamps) rather than the final state, and the comment above the
  // minimum reasoned that bounding the SIZE by footprint + MAX_OVERHANG made
  // it safe — true only for a volume centred on the origin, which an attached
  // one never is. tools/provenance.mjs measures the extent after the last
  // pass, which is the only version of the question that cannot be argued
  // with. A clamp that is not last is not a clamp.
  //
  // BuildingFactory calls this again after wealthScale, which scales offsets
  // as well as extents and so walks an edge volume straight back out. Same
  // function, not a second copy: the habitable minimum lives in three places
  // and that is exactly how a bridge pier survived two of them.
  clipToFootprint(volumes, ctx.footW, ctx.footD, input.definitionId)

  traceStage(traceId, input.definitionId, 'overhangClip', volumes, ctx.footW, ctx.footD)

  // === NO OPEN BOXES AGAINST THE SKY ===
  //
  // A flat top is a legitimate style when something sits on it. Exposed, it
  // reads as a building someone stopped working on — the other thing "half
  // built roofs" can mean. tools/roofcheck.mjs counts these; raising the
  // habitable minimum above pushed 50-odd per town past its 2m reporting
  // threshold, which did not create them, only revealed them.
  for (const v of volumes) {
    // A flat top is only a defect on something that was supposed to be
    // enclosed. A pier, a parapet and a curtain wall are MEANT to end in sky.
    if (v.habitable === false) continue
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

  traceStage(traceId, input.definitionId, 'openBoxRepair', volumes, ctx.footW, ctx.footD)

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
  for (let i = 0; i < volumes.length; i++) {
    const v = volumes[i]
    // ASK IN THE RIGHT UNITS FIRST, for the styles whose rise is dominated by
    // their span. roofHeightFor derives every rise from wallH, and for spire
    // and pointed that ask is always 2-3x what the span cap allows, so the cap
    // decided the shape: 96% of spires came out at EXACTLY 3.0x their span,
    // which is one silhouette repeated across the whole town. Deriving the
    // rise from the span puts the style vector back in charge and leaves the
    // cap as the backstop it was written to be. See Roofs.riseForSpan.
    const spanRise = riseForSpan(
      v.width, v.depth, v.roofStyle, ctx.sv.roofPitch,
      // A little per-volume jitter so two buildings that happen to share a
      // style vector still differ, and a building with two spires does not
      // grow a matched pair.
      (rand01(input.hash, 941 + i * 7) - 0.5) * 0.24,
    )
    if (spanRise !== null) v.roofHeight = spanRise
    // Floor first (pitch for the span), ceiling second (span cap). The
    // minimum is strictly below the maximum for every style, so ordering
    // them this way cannot produce a roof that violates either.
    v.roofHeight = ensureRoofPitch(v.width, v.depth, v.roofHeight, v.roofStyle)
    v.roofHeight = clampRoofHeight(v.width, v.depth, v.roofHeight, v.roofStyle)
    // Proportion last. Both clamps above are against the SPAN, which is why a
    // 2.9m wall could carry a 12m roof and still pass every check.
    v.roofHeight = clampRoofToWall(v.height, v.roofHeight, v.roofStyle)
  }

  traceStage(traceId, input.definitionId, 'roofClamp', volumes, ctx.footW, ctx.footD)
  return { volumes, primaryFace: 'z+', traceId }
}
