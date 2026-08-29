/**
 * Building Factory v3: Batched Architecture
 *
 * All non-textured geometry (roofs, chimneys, foundations, doorsteps,
 * archways, colonnades, balconies, towers) is merged into a handful
 * of batched meshes using vertex colors. Only textured wall bodies
 * remain as individual meshes (one draw call each, not six).
 *
 * ~8,300 draw calls → ~405
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { ObjectDefinition, PlacedObject } from '../core/types'
import { stableHash, DWELLING_TYPES } from '../core/types'
import { BatchedMeshBuilder, setBuildEnvelope } from './BatchedMeshBuilder'
import { buildingStyleVector, pickArchetypes } from './architecture'
import type { DistrictId } from './architecture'
import { pickMassing, volumeFloors, traceStage, clipToFootprint, MAX_OVERHANG as MAX_OVERHANG_M } from './architecture/Massing'
import { addBeacon, CAT_EYE_TINT } from './Beacons'
import { buildVaneMesh } from './Weathervanes'
import { addClockHand, buildClockMesh } from './Clocks'
import { addBanner, buildBannerMesh } from './Banners'
import { facadeOpenings, quantizeWallM } from './FacadeTexture'
import { gableMath, clampRoofHeight, clampRoofToWall, eaveProjFor } from './architecture/Roofs'
import { emitVolume, localToWorld, localToWorldMatrix, shiftColor, setWallEmissiveIntensity as setVolumeEmissiveIntensity } from './architecture/VolumeRenderer'
import { pickPaletteForStyle } from './architecture/PaletteBias'
import { isThatched, roofColorFor } from './Materials'
import { TILE, STOREY_HEIGHT, MIN_HABITABLE_W } from './scale'

/** Re-export so ThreeRenderer can keep importing from BuildingFactory. */
export const setWallEmissiveIntensity = setVolumeEmissiveIntensity

const VALID_DISTRICTS: Set<string> = new Set([
  'market', 'residential', 'artisan', 'noble', 'waterfront',
  'temple', 'slum', 'garden', 'harbor', 'fortress', 'cemetery',
])

// Floor-to-floor. Re-exported from scale.ts so there is exactly one number
// for "how tall is a storey" — see STOREY_HEIGHT there for why it is 2.9 and
// what measurement moved it off 1.8.
export const FLOOR_HEIGHT = STOREY_HEIGHT

// Districts where buildings should read as urban — taller floor counts.
const URBAN_DISTRICTS = new Set<string>([
  'residential', 'market', 'artisan', 'noble',
])

const FOOTPRINTS: Record<string, { w: number; h: number }> = {
  // Small district-specific houses — see store.ts.
  net_loft: { w: 2, h: 2 }, weigh_house: { w: 2, h: 2 },
  tenement: { w: 1, h: 2 }, lean_to: { w: 1, h: 2 },
  clergy_house: { w: 2, h: 2 },
  almshouse: { w: 1, h: 3 },
  sexton_hut: { w: 1, h: 2 },
  mausoleum: { w: 2, h: 2 },
  coach_house: { w: 2, h: 2 },
  potting_shed: { w: 1, h: 2 },
  building_small: { w: 2, h: 2 }, building_medium: { w: 3, h: 3 },
  building_large: { w: 4, h: 3 }, tavern: { w: 4, h: 3 },
  shop: { w: 2, h: 3 }, tower: { w: 2, h: 2 },
  balcony_house: { w: 3, h: 2 }, row_house: { w: 1, h: 2 },
  cottage: { w: 2, h: 2 }, washhouse: { w: 2, h: 2 },
  kiln: { w: 1, h: 2 }, workshop: { w: 1, h: 2 },
  smokehouse: { w: 1, h: 2 }, boathouse: { w: 2, h: 2 },
  chandlery: { w: 1, h: 2 }, customs_house: { w: 2, h: 2 },
  sail_loft: { w: 1, h: 2 }, cookshop: { w: 1, h: 2 },
  gate_lodge: { w: 1, h: 2 }, orangery: { w: 3, h: 2 }, dovecote: { w: 1, h: 1 },
  guardhouse: { w: 1, h: 2 }, armory: { w: 2, h: 2 },
  shambles: { w: 1, h: 2 },
  corner_building: { w: 2, h: 2 }, archway: { w: 3, h: 1 },
  staircase: { w: 2, h: 3 }, town_gate: { w: 3, h: 1 },
  chapel: { w: 3, h: 4 }, guild_hall: { w: 4, h: 4 },
  warehouse: { w: 4, h: 3 }, watchtower: { w: 2, h: 2 },
  mansion: { w: 5, h: 4 }, bakery: { w: 2, h: 2 },
  apothecary: { w: 2, h: 3 }, inn: { w: 3, h: 3 },
  temple: { w: 5, h: 5 }, covered_market: { w: 4, h: 3 },
  bell_tower: { w: 2, h: 2 }, half_timber: { w: 3, h: 2 },
  narrow_house: { w: 1, h: 3 }, clock_tower: { w: 3, h: 3 },
  cathedral: { w: 5, h: 6 }, lighthouse: { w: 3, h: 3 },
  round_tower: { w: 2, h: 2 }, gatehouse: { w: 4, h: 2 },
  stable: { w: 4, h: 3 }, mill: { w: 3, h: 3 },
  // 2x2 to match store.objectDefinitions and TownGenerator.getFootprint —
  // rendering it 3x3 drew a building larger than the space reserved for it,
  // so it clipped into its neighbours.
  bell_tower_tall: { w: 2, h: 2 }, aqueduct: { w: 5, h: 1 },
  windmill: { w: 3, h: 3 },
  // Town-wall variants: horizontal runs 2x1, vertical runs 1x2.
  stone_wall: { w: 2, h: 1 }, stone_wall_v: { w: 1, h: 2 },
  precinct_wall: { w: 1, h: 1 }, precinct_wall_v: { w: 1, h: 1 },
  footbridge: { w: 1, h: 1 },
  // The building draw path owns bridges because the STRUCTURE layer does.
  // Absent from here, `bridge` took the fallback footprint and the generic
  // house archetype, and 20 of every 23 bridges in a town were a cottage
  // standing in the river.
  bridge: { w: 4, h: 2 }, stone_bridge: { w: 4, h: 2 }, arched_bridge: { w: 4, h: 2 },
  crenellated_wall: { w: 2, h: 1 },
}

// Height multipliers tuned so towers read as chunky landmarks rather than
// flagpoles. Anything over ~3.0 with a 2x2 footprint rendered as a stick.
const HEIGHT_MULT: Record<string, number> = {
  tower: 2.0, clock_tower: 2.4, bell_tower: 2.6, bell_tower_tall: 3.0,
  watchtower: 2.2, cathedral: 2.0, lighthouse: 3.0, chapel: 1.5,
  temple: 1.5, town_gate: 1.8, archway: 1.5, round_tower: 2.4,
}

/** Deterministic 0..1 pseudo-random from an integer hash and a salt. */
function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

// Big, grid-aligned, flat-roofed types stay on the grid so they still
// interlock cleanly — archways, walls, gates, staircases.
const NO_JITTER = new Set<string>([
  'archway', 'town_gate', 'gatehouse', 'staircase', 'aqueduct',
  'stone_wall', 'stone_wall_v', 'crenellated_wall',
])

/**
 * Shared palette for painted commercial signage — shop signs (perpendicular
 * hanging boards) and name placards (horizontal frontage signs) draw from
 * the same 6 colors so the same building's signs feel like a coordinated
 * commercial identity. Earthy reds + muted earths + a deep forest + an
 * indigo + an ochre.
 */
// Shutter paint. Deliberately saturated and cool-leaning: the walls are warm
// stone and timber, so a shutter reads as a PAINTED thing rather than more
// masonry, which is the whole point of putting one on a wall.
const SHUTTER_COLORS = [
  0x4a5d6b, 0x5b6e4a, 0x7a4a42, 0x46566b, 0x6b5a3a, 0x3f5a52,
]
/**
 * STAINED GLASS — the sacred types, and only them.
 *
 * A cathedral is the one building in the town whose whole point at dusk is
 * that it glows a different colour from everything around it, and `odd.mjs`
 * has had this one on the record for a long time: 0.26x the detail density of
 * an ordinary building, a plain grey box forty metres tall. The painted
 * openings on it already light, in the same amber as every cottage — so the
 * building with the most window area in town is also the one saying the least
 * with it.
 *
 * Keyed by type rather than by district, for the reason `THATCH_ODDS` is: a
 * district gate paints whole quarters uniformly, and a clergy house is not a
 * cathedral. A chapel gets it because a chapel has glass; a bell tower does
 * not, because a belfry is an opening with a bell in it.
 */
/**
 * A CAT IN THE WINDOW — coats, and the one colour that is not a coat.
 *
 * The eyes are EMISSIVE and everything else is not, which is the whole reason
 * this works at `RENDER_SCALE = 0.4`. A 30cm cat is four pixels at any
 * distance a person actually stands, and a dark shape four pixels across on a
 * dark wall at dusk is nothing at all — but two lit specks read, because the
 * eye finds a point of light long after it has lost a silhouette. That is the
 * same argument the belfry's lit arch is built on, at a twentieth of the size.
 */
const CAT_COATS = [0x8a5228, 0x241f1e, 0x5a5854, 0xb0a897, 0x50372a, 0x6e4426]
/**
 * Yellow-green, so a cat is not mistaken for one more amber window.
 *
 * IN `Beacons.ts` BECAUSE TWO PATHS HAVE TO AGREE ON IT. The building path
 * emits with this tint and the prop path recognises that one bucket to give
 * it a blink; a private copy here would separate the geometry from its
 * animation the day either moved.
 */
const CAT_EYE = CAT_EYE_TINT
const STAINED_GLASS_TYPES = new Set(['cathedral', 'temple', 'chapel'])
/**
 * DARK ON PURPOSE, AND THE FIRST SET WAS NOT DARK ENOUGH BY A LONG WAY.
 *
 * These go on a Lambert whose `emissive` is the tint AND whose `color` is the
 * tint, so the hue is counted twice and 0x9c2a3a came out as flat magenta —
 * a traffic light, which is precisely what the first version of this comment
 * said to avoid. Photographed, the panes read as poster paint on a wall.
 *
 * Glass lit from behind is GLOW-DOMINANT: the surface itself is nearly black
 * and what you see is the light coming through it. So the base is dark, the
 * emissive carries the colour, and the intensity is well under a lamp's.
 */
const GLASS_TINTS = [0x5e1622, 0x16305e, 0x6e4a12, 0x14472e, 0x3b1a4a]
/**
 * Buildings that trade, wherever they stand — they carry a hanging sign on
 * their own account rather than because of the street they are on.
 *
 * Kept as a Set precisely so the next person adding a shop type has one place
 * to put it. It was seven inline `===` comparisons and every district type
 * added since — chandlery, shambles, weigh_house, workshop, net_loft,
 * smokehouse, customs_house — was missing from it.
 */
const TRADE_BUILDINGS = new Set([
  'shop', 'tavern', 'inn', 'bakery', 'apothecary', 'guild_hall',
  'covered_market', 'market_stall',
  // The district-exclusive trades. A chandlery and a shambles are shopfronts
  // in the plainest sense; a weigh house and a customs house are civic but
  // both hang a board saying what they are.
  'chandlery', 'shambles', 'weigh_house', 'customs_house', 'workshop',
  'sail_loft', 'cookshop',
  'net_loft', 'smokehouse', 'boathouse', 'mill',
])
const PAINTED_SIGN_COLORS = [
  0x6b3a1f,  // burnt sienna
  0x5a2818,  // oxblood
  0x7a4830,  // tan-clay
  0x3a4a2a,  // forest
  0x4a3a55,  // indigo
  0x6a5028,  // mustard ochre
]

/**
 * Where a finished building actually ends up vertically.
 *
 * ThreeRenderer used to re-derive this (floors x FLOOR_HEIGHT x HEIGHT_MULT x
 * hScale, plus a roof fraction) to hang chimney smoke and circling birds off
 * buildings. That duplicate is how a stale 1.05 floor height survived long
 * after the real one became 1.8, and it silently drifts again every time
 * massing changes — the roof/tower clamps made it over-shoot immediately.
 * Reporting the real numbers from the one place that computes them keeps the
 * particle systems attached to the geometry.
 */
export interface BuildingTop {
  id: string
  /** Highest point of any volume (world Y) — spire/roof apex. */
  apexY: number
  /** Top of the main body's walls (world Y) — where a chimney starts. */
  mainWallTopY: number
  /** Main body's roof height (0 when flat). */
  mainRoofH: number
  /** World-space centre of the MAIN BODY — not the footprint centre. */
  centerX: number
  centerZ: number
  /** Main body's half-extents in world units, before yaw. */
  halfW: number
  halfD: number
  /** The building's placement origin (world) — volume offsets are from here. */
  originX: number
  originZ: number
  /** Half-extents of ALL volumes together, about the ORIGIN: the structure's
   *  own envelope, as opposed to the main body's. */
  spanHalfW: number
  spanHalfD: number
  /** Yaw applied to the whole building, radians. */
  rotationY: number

  /**
   * Where smoke leaves this building, in WORLD units, when a volume declared
   * itself a vent. Absent when none did.
   *
   * ThreeRenderer used to vent every always-smoking type from the footprint
   * CENTRE at the roof apex, which is right for a smokehouse's ridge louvre
   * and a kiln's cone and wrong for anything whose flue is not central — the
   * cookshop's whole silhouette is a stack up one FLANK, 1.55m off centre,
   * and smoke rising beside it rather than out of it is worse than no smoke.
   *
   * Reported here for the same reason `BuildingTop` reports heights and
   * `frontWallZ` reports the wall: the alternative is a second copy of the
   * template's arithmetic in the renderer, and every copy of massing
   * arithmetic in this repo has drifted. When a whole category of work keeps
   * not happening, look for the handle it would need.
   */
  ventX?: number
  ventY?: number
  ventZ?: number

  // === FEATURES FOR tools/odd.mjs ===
  // Cheap aggregates recorded where the massing is in scope, so the outlier
  // hunt can ask "is this building unlike its peers" without re-deriving
  // anything. See the tool: the point is a feature vector per structure that
  // needs no target table, because the comparison is against the population.
  definitionId: string
  district: string
  /** Ground level under the origin, so height is height and not altitude. */
  baseY: number
  volumeCount: number
  /** How many volumes carry a painted facade. A tall shaft of bare colour is
   *  the defect no geometry audit can see — it is legal in every dimension. */
  texturedVolumes: number
  /** Total wall AREA, and how much of it is textured. Counting VOLUMES lets a
   *  60m untextured shaft hide behind two small textured outbuildings. */
  wallArea: number
  texturedArea: number
  roofStyles: string[]
}

/**
 * ONE THING ON A FACADE, in WALL-LOCAL METRES.
 *
 * The class the harness could not see. Every instrument so far works on
 * volumes or on pixels at a distance; nothing knew where the PAINTED openings
 * are, so nothing could tell that a timber stud runs straight across a window.
 * Reported from the device as "lumber beams crossing over window and door
 * textures", and true: the studs sit at a 1.7m bay pitch while the openings
 * sit at facadeOpenings' ~2.4m column pitch, so the two grids beat against
 * each other and a full-height stud crosses a window row on most walls.
 *
 * FacadeTexture's own comment already says the 3D window TRIM must quantise
 * identically to the texture or the lintels land on the wrong columns — and
 * VolumeRenderer does exactly that. The timber frame is the sibling that never
 * got the same treatment. A bug in a gate is a bug in a pattern.
 *
 * x is metres from the wall's horizontal centre, y is metres above the wall's
 * base, so an opening and a member are directly comparable.
 */
export interface FacadePart {
  id: string; def: string; vol: string; kind: string
  x0: number; x1: number; y0: number; y1: number
  /**
   * MEASURED SIDE PROFILE, for members that project from the wall.
   *
   * The wall-local rectangle above is a front elevation and a front elevation
   * cannot see a slope. `tools/facade.mjs` printed "slope and post reach are
   * checked in the geometry itself; see the note in this file" and checked
   * NOTHING — it pointed at a comment. That is a gate whose verdict cannot
   * fire, which this repo has already shipped once (a FAIL line reachable only
   * by a ratio bounded above by 1) and which is worse than having no check,
   * because the line reads as a clean result.
   *
   * `drop` is how far the projecting edge sits BELOW the wall edge, in metres,
   * positive downward; `proj` is how far it reaches out. Both are read off the
   * BUILT vertices after the rotation, not recomputed from the angle that
   * produced them — recomputing would be a proxy agreeing with itself, and an
   * inverted sign is precisely the failure being tested for.
   */
  drop?: number; proj?: number
}
export const facadeParts: FacadePart[] = []
function recordPart(
  id: string, def: string, vol: string, kind: string,
  cx: number, cy: number, w: number, h: number,
  profile?: { drop: number; proj: number },
): void {
  facadeParts.push({
    id, def, vol, kind,
    x0: +(cx - w / 2).toFixed(3), x1: +(cx + w / 2).toFixed(3),
    y0: +(cy - h / 2).toFixed(3), y1: +(cy + h / 2).toFixed(3),
    ...(profile ? { drop: +profile.drop.toFixed(4), proj: +profile.proj.toFixed(4) } : {}),
  })
}

/**
 * The side profile of a projecting member, read off its BUILT vertices.
 *
 * Takes the geometry AFTER whatever rotation was applied and before it is
 * moved into world space, finds the vertex nearest the wall and the vertex
 * furthest from it, and reports how far the far edge has fallen. An inverted
 * rotation sign shows up here as a NEGATIVE drop — the awning tilting its
 * front edge skyward, which is what "the angles for the main piece is wrong"
 * turned out to be.
 */
function sideProfile(geo: THREE.BufferGeometry): { drop: number; proj: number } {
  const pos = geo.getAttribute('position')
  let nearZ = Infinity, farZ = -Infinity
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i)
    if (z < nearZ) nearZ = z
    if (z > farZ) farZ = z
  }
  // TAKE THE MIDLINE OF EACH END, not one arbitrary corner. A box has four
  // vertices at each extreme, half on the top face and half on the bottom, and
  // picking whichever the loop met first put the canvas THICKNESS into the
  // answer: 4cm over a 51cm reach is 4.5 degrees, which is most of the ~7 the
  // slope is supposed to be. An instrument whose noise is the size of its
  // signal reports nothing, confidently.
  const eps = Math.max(1e-4, (farZ - nearZ) * 0.01)
  let nearSum = 0, nearN = 0, farSum = 0, farN = 0
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i), y = pos.getY(i)
    if (z <= nearZ + eps) { nearSum += y; nearN++ }
    if (z >= farZ - eps) { farSum += y; farN++ }
  }
  return {
    drop: (nearN ? nearSum / nearN : 0) - (farN ? farSum / farN : 0),
    proj: farZ - nearZ,
  }
}

/**
 * WHICH WALL A PART IS NAILED TO — and why a part needs to say so.
 *
 * The frame above is wall-local: x from the wall's centre, y above the wall's
 * base. That frame belongs to a VOLUME, and a building has several. The audit
 * keyed parts by `obj.id` alone and therefore cross-multiplied every opening
 * of every volume against every member of every other one — so a tower's
 * full-width head plate "covered 100%" of a window painted on the main body
 * two metres away and on a different wall plane.
 *
 * The tell was that BuildingFactory's own `_clearsOpenings` guard and the
 * audit DISAGREED. That guard is a strict AABB test with no reveal tolerance,
 * so it is strictly harsher than the audit's glass test; a member it passes
 * cannot fail the audit. Two checks of the same thing where the stricter one
 * says clean and the looser one says dirty is arithmetic telling you they are
 * not looking at the same thing.
 *
 * Same lesson as the phantom door — a tool's two halves must count the same
 * population — one level further down: there the population was the wrong
 * BUILDINGS, here it is the wrong WALLS within one building. Keyed by the
 * geometry that defines the frame rather than by an index, so it stays stable
 * across passes that reorder the volume array.
 */
function volKey(v: {
  role: string; offsetX: number; offsetZ: number; width: number; bottomY: number
}): string {
  return `${v.role}@${v.offsetX.toFixed(2)},${v.offsetZ.toFixed(2)}` +
    `,${v.width.toFixed(2)},${v.bottomY.toFixed(2)}`
}

/** One built volume's world box — see the note at the push site. */
export interface VolumeBox {
  id: string; def: string; role: string; habitable: boolean
  /**
   * The AXIS-ALIGNED hull, kept for cheap broad-phase bucketing only.
   *
   * It is NOT the volume. `hx = (w/2)|cos| + (d/2)|sin|` is the axis-aligned
   * box AROUND a rotated rectangle, and 55% of buildings carry an off-axis
   * wobble (+-3 deg where a road aligns them, +-12 deg where none does). A 6m
   * volume at 12 deg inflates its hull by 1.25m, so an AABB-vs-AABB test
   * reports overlap between two buildings whose actual walls are nowhere near
   * each other. tools/clash.mjs read ~124 deep interpenetrations all session
   * on exactly that basis.
   */
  x0: number; x1: number; z0: number; z1: number; y0: number; y1: number
  /** The ORIENTED box — centre, half-extents and yaw. Use this to test. */
  cx: number; cz: number; hw: number; hd: number; yaw: number
  /**
   * The massing deliberately sent this volume BELOW the placement base.
   *
   * Only a span does it — a bridge pier reaching the bed, and at the ends an
   * abutment founded into the bank. `clash.mjs` grades the lowest volume of
   * each building against the ground under it and calls anything more than
   * 1.2m down BURIED, which is the right question for a house sunk into a
   * hillside and the wrong one for a foundation that declares itself. Same
   * derived rule the plinth uses: a volume that descends has taken
   * responsibility for the drop.
   *
   * Reported separately rather than dropped, so exempting a class cannot make
   * it go quiet — a green board that stopped looking is the failure this
   * harness exists to prevent.
   */
  descends: boolean
  /** The template declared this a surface a player can stand on — a deck. */
  walkable: boolean
  groundY: number
}
export const volumeBoxes: VolumeBox[] = []

export interface BuildingBatchResult {
  wallMeshes: THREE.Mesh[]       // individual (textured, emissive)
  batched: THREE.Mesh[]          // merged roof/detail/feature meshes
  /** Per-building vertical extents, keyed by PlacedObject id. */
  tops: BuildingTop[]
}

/**
 * Diagnostics captured during the most recent buildBuildingMeshes() call.
 * Surfaced via ThreeRenderer.getDebugInfo() so debug-dump exports include
 * any per-building errors, plus stats on what got built vs. skipped.
 */
export interface BuildingDiagnostics {
  attempted: number
  succeeded: number
  failed: number
  /** Up to FAILURE_LOG_CAP per-building error records. */
  failures: Array<{
    objectId: string
    definitionId: string
    district: string
    hash: number
    message: string
    stack?: string
  }>
  /** Build counts of each batched mesh after merge — null means merge
   *  returned null (typically a mismatch in the input geometries). */
  batchedMeshCounts: { roof: number | null; detail: number | null; ornament: number | null }
  /** Number of wall meshes BEFORE coalesceWalls. */
  wallMeshesBeforeCoalesce: number
  /** Number of wall meshes AFTER coalesceWalls. */
  wallMeshesAfterCoalesce: number
  /** Wall-clock ms spent in buildBuildingMeshes. */
  totalMs: number
  /** Total ornament emit count (sum of batch.count just before build()). */
  ornamentFragments: number
  /** How many volumes ended up with each roof style, and how many of those
   *  are tall enough to read as a tower. A flat-topped tower looks like an
   *  unfinished building, so this makes that measurable. */
  roofStyles: Record<string, number>
  flatToppedTallVolumes: number
  /** WHICH type and WHICH volume role produced each open box, `defId:role`.
   *  A counting metric buys you guesses and an explaining one buys you the
   *  answer — two changes went on "233 tiles where the wall placer did not
   *  build" before that tool was asked to classify by cause, and this count
   *  went 6 -> 22 across a content arc with nothing able to say which of the
   *  ten new types did it. */
  flatTopBy: Record<string, number>
  /** Street-dressing features that are gated behind district/type rules. */
  featureCounts: Record<string, number>
  /**
   * WHERE a named feature actually IS, so a camera can be pointed at one.
   *
   * `featureCounts` says a feature fired twelve times and cannot say where,
   * which is the hole `slivers.mjs` filled for batched geometry: a batch hides
   * its authors, so make it name them. It cost a whole camera hunt on the
   * buttress — 12 instances in ~840 structures is 1.4%, so photographing any
   * given building has almost no chance of containing one, and the magenta
   * probe came back empty in a way that reads exactly like "your geometry does
   * not exist". Every rare feature has that problem and always will.
   *
   * Capped per key, because this is a debug aid and not a spatial index: a
   * handful of sites is all a camera needs, and an uncapped array on a feature
   * that fires on every building would be thousands of Vector3s a generate.
   */
  featureSites: Record<string, {
    x: number; y: number; z: number
    /** Extent, when the emitter knows it — see siteOf. */
    w?: number; h?: number; d?: number
  }[]>
  /** Per-building human-scale samples — see BuildingScale. */
  scaleSamples: BuildingScale[]
}

/**
 * One building's dimensions, in METRES, for the human-scale audit.
 *
 * The point of this record is that "is the scale right?" is not answerable by
 * looking at a screenshot and it is not answerable by a single median either.
 * The complaint from the device was "some buildings are tiny and others are
 * huge, and the tiny ones have tiny doors and windows" — that is a statement
 * about a DISTRIBUTION and about whether details track the building or stay
 * human-sized. So every building reports what a person standing next to it
 * would actually measure, and tools/humanscale.mjs prints the spread.
 *
 * The door and window figures are DERIVED, not guessed: FacadeTexture lays the
 * facade out in texture units — the texture is `width` units across and
 * `floors + 0.5` tall — and that image is then stretched over the wall. So a
 * feature's real size is its texture fraction times the wall's world size, and
 * that is what these fields compute.
 */
export interface BuildingScale {
  definitionId: string
  /** Main body, world metres. */
  wallW: number
  wallD: number
  wallH: number
  /** Whole building including roof and any spire. */
  totalH: number
  floors: number
  /** wallH / floors — a real storey is 2.6-3.2m. */
  storeyH: number
  /**
   * HOW FAR OUT OF PLUMB THE TOP IS, in world metres — tan(lean) x totalH.
   *
   * The lean is an ANGLE, so it is correctly scale-free and survived the tile
   * rescale untouched. What did not survive is the OPT-OUT: towers, cathedrals
   * and gates are excused by `definitionId`, on the reasoning that a leaning
   * landmark reads as broken rather than as charming-old. That was a proxy for
   * "is this thing tall", and landmark PROMOTION broke it — 28% of ordinary
   * buildings are handed a dramatic vertical template while keeping their id,
   * so a `row_house` can be a 25m tower and still leans, at which point 2 deg
   * is most of a metre at the parapet.
   *
   * The displacement is the honest quantity: an angle says nothing about what
   * you see, and a settled medieval house is 10-30cm out at the eaves. Report
   * the metres and the target writes itself.
   */
  outOfPlumb: number
  /** Painted opening sizes on the finished wall, world metres. */
  doorH: number
  doorW: number
  windowH: number
  windowW: number
  /**
   * False for masonry — a bridge pier, a boundary wall. humanscale.mjs grades
   * a storey against what a ROOM measures, and once the habitable minimum
   * stopped inflating walls to 2.9m the audit turned red on 59 of 307
   * buildings: exactly the 53 precinct walls and 6 bridges, now correctly
   * 1.6m and being counted as storeys under head height. The tool's two
   * halves have to count the same population — same lesson as the 182%
   * doorstep rate, and as urbanform reporting boundary walls on their own
   * line rather than as buildings.
   */
  habitable: boolean
}

const FAILURE_LOG_CAP = 30

let _lastDiagnostics: BuildingDiagnostics = {
  attempted: 0, succeeded: 0, failed: 0, failures: [],
  batchedMeshCounts: { roof: null, detail: null, ornament: null },
  wallMeshesBeforeCoalesce: 0,
  wallMeshesAfterCoalesce: 0,
  totalMs: 0,
  ornamentFragments: 0,
  roofStyles: {},
  flatToppedTallVolumes: 0,
  flatTopBy: {},
  featureCounts: {},
  featureSites: {},
  scaleSamples: [],
}

export function getBuildingDiagnostics(): BuildingDiagnostics {
  return _lastDiagnostics
}

export function buildBuildingMeshes(
  objects: PlacedObject[],
  defMap: Map<string, ObjectDefinition>,
  palettes: { wall: number; roof: number; door: number }[],
  getHeight?: (x: number, z: number) => number
): BuildingBatchResult {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now())
  const wallMeshes: THREE.Mesh[] = []
  const tops: BuildingTop[] = []
  volumeBoxes.length = 0
  facadeParts.length = 0
  const roofStyles: Record<string, number> = {}
  const scaleSamples: BuildingScale[] = []
  const featureCounts: Record<string, number> = {}
  const featureSites: Record<string, {
    x: number; y: number; z: number; w?: number; h?: number; d?: number
  }[]> = {}
  /** Record WHERE one instance of a feature is. Capped — see featureSites. */
  const SITES_PER_FEATURE = 12
  /**
   * EXTENT IS OPTIONAL AND MATTERS FOR ANYTHING BIGGER THAN A ROOM. A bare
   * point makes `featureshot` frame a fixed 3.2m box, and for the lighthouse's
   * lantern room — a drum several metres across, ringed by its own astragals —
   * every ray to the centre was blocked by the subject's own frame sitting
   * outside that box. A buttress needs no extent; a landmark does.
   */
  const siteOf = (
    k: string, x: number, y: number, z: number,
    w?: number, h?: number, d?: number,
  ): void => {
    const a = featureSites[k] ?? (featureSites[k] = [])
    if (a.length < SITES_PER_FEATURE) a.push({ x, y, z, w, h, d })
  }
  const tally = (k: string) => { featureCounts[k] = (featureCounts[k] ?? 0) + 1 }
  /** Tally a gated feature BY DISTRICT as well as in total.
   *
   *  A global count cannot answer the question these features exist to serve.
   *  Shop signs read 16% of buildings town-wide, which sounds like a
   *  reasonable amount of signage and is actually the symptom: it was 16%
   *  EVERYWHERE, cemetery included, because the gate had no district test.
   *  What matters is the split, so record it. */
  const tallyIn = (k: string, d: string) => { tally(k); tally(`${k}@${d}`) }
  let flatToppedTallVolumes = 0
  const flatTopBy: Record<string, number> = {}
  // THE ROOF BATCH WAS THE ONLY BATCH IN THE RENDERER WITH NO TONE FLOOR.
  //
  // Props carry 0.12 and the laundry 0.30, and roofs carried nothing, so at
  // dusk `eyeball` read 66% of all roof pixels as effectively black — two
  // thirds of the largest surface in a street view, against walls at 0.075
  // and mid-grey at 0.22. A steep pitch gets neither the direct sun a flat
  // roof gets nor the sideways skylight a wall gets, which this file has
  // listed as the remaining tone outlier for some time.
  //
  // THE VALUE IS CHOSEN BY A PRINCIPLE, NOT BY TASTE. DESIGN.md pillar 1 is
  // warm windows against DARK silhouettes, so a roof is supposed to be dark —
  // the defect is that it was BLACKER THAN THE WALL BENEATH IT, which reads
  // as a hole rather than a surface. So the stopping point is parity with the
  // wall, and the tone table says where that is:
  //
  //     floor   roof med / black     wall med / black
  //     0       —          66%       0.046      59%
  //     0.18    —          61%       0.046      59%   <- parity
  //     0.25    0.060      49%       0.046      59%   <- roofs now BRIGHTER
  //
  // 0.055 was tried first and moved nothing at all, because the roof palette
  // already sits above it; the response is very non-linear and the useful
  // range is narrow. `liftToFloor` only touches colours already below the
  // floor and multiplies channels, so hue survives and a red roof stays red.
  //
  // AND THAT PARITY HAS SINCE DRIFTED, WHICH IS WHY THE 0.046 IS WRITTEN DOWN.
  // A CONSTANT CHOSEN FOR PARITY WITH A MEASURED QUANTITY IS AT PARITY ONLY ON
  // THE DAY YOU SET IT. The dusk arm of `updateLighting` was later found still
  // carrying pre-tone-arc numbers and was raised; the wall went 0.046 -> 0.105
  // and this floor stayed where it was. `tools/hours.mjs` now reads dusk at
  // roof 0.089 against wall 0.105 and both are on the board on one line, which
  // is the durable fix — the constant will drift again and now it is watched.
  //
  // IT IS DELIBERATELY NOT BEING RAISED TO CLOSE THAT 15%, and the palette is
  // the reason. The eight roof colours run 0.097 to 0.290 linear luma against
  // walls at 0.224 to 0.812 — roofing is INTRINSICALLY about three times
  // darker than masonry, which is what a clay tile is. 0.18 already lifts five
  // of the eight; 0.25 lifts seven and squeezes the whole palette into
  // 0.25-0.29, trading terracotta, slate, verdigris and shingle for one flat
  // tone. That is pillar 2 spent to buy a tenth of pillar 1, and a floor is a
  // clamp on the LOW end of a palette — pushed past the palette's own median
  // it stops being a floor and becomes the colour.
  const roofBatch = Object.assign(new BatchedMeshBuilder(), { toneFloor: 0.18 })
  const detailBatch = new BatchedMeshBuilder()
  const ornamentBatch = new BatchedMeshBuilder()

  // WHICH TILES ARE SPOKEN FOR, so the overhang can tell a street from a
  // neighbour. MAX_OVERHANG is a per-building budget and the gap between two
  // buildings is SHARED: tools/clash.mjs classified every one of the 97 deep
  // interpenetrations in a town as a pair whose reserved footprints TOUCH, two
  // neighbours each spending 0.6m into the same space. Built once here rather
  // than per building, because it is O(objects) and the loop is O(objects).
  const occupied = new Set<string>()
  for (const o of objects) {
    const d = defMap.get(o.definitionId)
    const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
    for (let dy = 0; dy < Math.max(1, f.h); dy++) {
      for (let dx = 0; dx < Math.max(1, f.w); dx++) occupied.add(`${o.x + dx},${o.y + dy}`)
    }
  }
  /** Is any tile along one side of this rectangle claimed by someone else? */
  const sideTaken = (
    ox: number, oy: number, w: number, h: number, dx: number, dy: number,
  ): boolean => {
    for (let i = 0; i < (dx !== 0 ? h : w); i++) {
      const tx = dx !== 0 ? (dx < 0 ? ox - 1 : ox + w) : ox + i
      const ty = dy !== 0 ? (dy < 0 ? oy - 1 : oy + h) : oy + i
      if (occupied.has(`${tx},${ty}`)) return true
    }
    return false
  }

  // Reset diagnostics for this run.
  const failures: BuildingDiagnostics['failures'] = []
  let attempted = 0, succeeded = 0, failed = 0

  for (const obj of objects) {
    // Clear FIRST. The envelope is a module global and this loop only sets it
    // a few hundred lines down, so anything emitted before then was being
    // scored against the PREVIOUS building's box — and after the loop, every
    // prop in town was. That stale state is what made slivers.mjs report
    // props protruding 71m when propscale measures the same geometry at 3.6m
    // at its largest. recordSliver already has a NO-ENVELOPE bucket for
    // unattributed geometry; a leftover envelope walks straight past it and
    // answers confidently instead of admitting it does not know.
    setBuildEnvelope(null)
    const def = defMap.get(obj.definitionId)
    if (!def) continue
    attempted++
    try {

    // TWO footprints, and the distinction matters everywhere below.
    //   fpT — the footprint in TILES, as the generator reserved it. Use for
    //         anything that indexes the map: terrain sampling, per-tile loops,
    //         and the "is this building big enough for a stoop?" gates.
    //   fp  — the same footprint in WORLD units. Use for every geometry
    //         dimension and local offset, which is nearly all of them.
    // See scale.ts for why one tile is not one metre.
    // The rectangle the PLACER reserved wins. FOOTPRINTS is the renderer's own
    // table and only existed because nothing else carried the truth; it is now
    // a fallback for hand-authored objects that predate obj.footprint.
    const fpRaw = obj.footprint ?? FOOTPRINTS[obj.definitionId] ??
      { w: def.footprint.w, h: def.footprint.h }
    // A plot the generator turned a quarter turn occupies h x w. Swap here so
    // the mesh fills the rectangle that was actually reserved; the base
    // rotation below turns the building to match, so its door still faces the
    // street it was oriented to.
    const plotRotated = !!obj.properties.plotRotated
    const fpT = plotRotated ? { w: fpRaw.h, h: fpRaw.w } : fpRaw
    const fp = { w: fpT.w * TILE, h: fpT.h * TILE }
    const hash = stableHash(obj)
    const style = (obj.properties.style as string) || 'standard'
    const district = (obj.properties.district as string) || 'residential'

    // Style vector + archetype + palette — hoisted to the TOP of the loop
    // so any decision below (floors / lean / chimneys / signs / etc) can
    // read styleVector.* without hitting a TDZ. Previously these lived
    // mid-loop and the lean computation referenced styleVector.weather
    // before declaration, which caused 20+ buildings per town to throw
    // "Cannot access 'styleVector' before initialization" and get
    // dropped from the render. The diagnostics surfaced this in the
    // very next debug dump.
    const districtId: DistrictId = VALID_DISTRICTS.has(district)
      ? (district as DistrictId) : 'residential'
    const styleVector = buildingStyleVector(districtId, hash)
    const picks = pickArchetypes(districtId, hash)
    const dominantArchetype = picks[0]?.id ?? 'traverseCozy'
    const palette = pickPaletteForStyle(palettes, styleVector, hash)

    // THATCH — the one roof material this town does not have, and the reason
    // its roofs are all one colour family.
    //
    // Every roof in the town comes out of the same palette's `roof` slot, so
    // pillar 2's "the eye should never be able to copy-paste one silhouette
    // onto another" is being fought with SHAPE alone while the largest surface
    // in a street view stays a single material. A straw roof beside a tiled
    // one is the strongest cheap distinction available: it changes the colour
    // of the biggest thing on the building.
    //
    // BY TYPE, NOT BY DISTRICT, and the history is the reason. Real towns
    // banned thatch after their first fire and kept it on the humble and the
    // rural — so a cottage, a lean-to, a shed and a stable carry it and a
    // tenement, a shop and a townhouse do not, which is a distinction the eye
    // reads as age and poverty without being told. Gating on district instead
    // would paint whole quarters uniformly, which is the wallpaper failure.
    //
    // PROBABILISTIC, because a terrace of five identical thatched cottages is
    // the copy-paste this exists to prevent. And the colour is what thatch
    // actually is — pale weathered straw — chosen by the object rather than
    // by what moves `roofBlackPct`, which is a composition descriptor and not
    // a gate. It happens to lift that number; that is a side effect, not the
    // reason, and the moment it becomes the reason the roofs go pale
    // everywhere and pillar 1's dark silhouettes go with them.
    // THE ODDS AND THE STRAW LIVE IN Materials.ts BECAUSE TWO RENDERERS DRAW
    // ROOFS. Canvas2DRenderer picks its own palette from the same
    // `stableHash`, so a copy here would give the walkaround thatched
    // cottages and the pixel-art export tiled ones with nothing erroring —
    // the terrain-table drift, one surface over.
    if (isThatched(obj.definitionId, hash)) tallyIn('thatch', district)
    const roofColor = roofColorFor(obj.definitionId, hash, palette.roof)

    // Floor count: generator-provided value wins, but otherwise bias urban
    // districts taller (2–4) and rural/fringe shorter (1–2). narrow_house is
    // always tall regardless of district (it's meant to read as a Traverse-
    // Town-style tall-narrow house). This is the biggest lever for aspect
    // ratio — a 2×2×3-floor building stops looking like a cube.
    let floors: number
    if (typeof obj.properties.floors === 'number') {
      floors = obj.properties.floors as number
    } else if (obj.definitionId === 'narrow_house') {
      floors = 3 + (hash % 2) // 3 or 4
    } else if (URBAN_DISTRICTS.has(district)) {
      floors = 2 + (hash % 3) // 2, 3, or 4
    } else {
      floors = 1 + (hash % 2) // 1 or 2
    }

    const heightMult = HEIGHT_MULT[obj.definitionId] ?? 1.0

    // Per-instance jitter so the town stops reading as a grid. Keyed off
    // the object id hash, so regenerating the same seed is stable.
    const jitter = !NO_JITTER.has(obj.definitionId)
    const hScale = jitter ? 0.85 + rand01(hash, 1) * 0.3 : 1.0          // 0.85–1.15
    // Positional jitter, in TILES. Cut from +/-0.175 (half a metre of slide at
    // TILE = 3) to +/-0.05, about 15cm. A terrace steps back and forward a
    // little; it does not slide sideways out of its own row. Same reasoning as
    // the rotation above — the variety has to come from the buildings, not
    // from scattering them.
    const jitterDX = jitter ? (rand01(hash, 2) - 0.5) * 0.10 : 0
    const jitterDZ = jitter ? (rand01(hash, 3) - 0.5) * 0.10 : 0

    const wallH = floors * FLOOR_HEIGHT * heightMult * hScale

    // World position of building center. Sample terrain height across
    // EVERY footprint tile and use the max so the building sits on the
    // highest ground covered; the min is used to size a foundation plinth
    // that fills the gap over lower tiles. Fixes "hovering over low tiles"
    // for multi-tile buildings.
    //
    // We *ignore* obj.elevation when getHeight is available: the generator
    // stored elevation in raw heightMap units (0..2.5) whereas terrainH is
    // in scaled world units, so adding them double-counts the terrain.
    const centerTileX = obj.x + fpT.w / 2
    const centerTileZ = obj.y + fpT.h / 2
    let maxTH = 0, minTH = Infinity
    if (getHeight) {
      for (let fy = 0; fy <= fpT.h; fy++) {
        for (let fx = 0; fx <= fpT.w; fx++) {
          const th = getHeight(obj.x + fx, obj.y + fy)
          if (th > maxTH) maxTH = th
          if (th < minTH) minTH = th
        }
      }
    } else {
      minTH = 0
    }
    if (!isFinite(minTH)) minTH = 0
    // Tile centre and jitter are both in tiles; one multiply takes the pair
    // into world space. Y is already in world units — getHeight returns
    // terrain height scaled, and never passes through TILE.
    const wx = (centerTileX + jitterDX) * TILE
    const wy = getHeight ? maxTH : (obj.elevation || 0)
    const wz = (centerTileZ + jitterDZ) * TILE

    // Continuous Y rotation per building — computed once and applied to
    // the plinth, chimneys, and all volumes so they rotate as a unit.
    //
    // BASE rotation: align the building's painted-door front face to the road.
    // Massing's primaryFace is 'z+' (door painted on the +Z wall). If the
    // generator marked a roadSide, we rotate so +Z points toward that side:
    //   roadSide 'S' (road south of building, world +Z): rot = 0
    //   roadSide 'N' (world -Z): rot = π
    //   roadSide 'E' (world +X): rot = π/2
    //   roadSide 'W' (world -X): rot = -π/2
    //
    // JITTER: small ±15° wobble around the base rotation so rows aren't
    // grid-locked. Capped tighter than before since we now have meaningful
    // base alignment to preserve.
    let rotationY = 0
    if (!NO_JITTER.has(obj.definitionId)) {
      const roadSide = obj.properties.roadSide as 'N' | 'S' | 'E' | 'W' | undefined
      // Apply E/W base rotation ONLY for square-ish footprints. Rotating a
      // 1×3 building by ±π/2 would swap its world-axis dimensions and the
      // rotated bounding box would overflow the tile rectangle the generator
      // reserved, colliding with neighboring buildings or punching into roads.
      // N/S rotation (π) is safe for any footprint — the rotated bounding box
      // is unchanged.
      const isSquareish = Math.abs(fpT.w - fpT.h) <= 1
      let baseRot = 0
      if (roadSide === 'N') baseRot = Math.PI
      else if (roadSide === 'E' && isSquareish) baseRot = Math.PI / 2
      else if (roadSide === 'W' && isSquareish) baseRot = -Math.PI / 2
      // 'S', unspecified, or non-square E/W → 0
      const aspect = Math.min(fpT.w, fpT.h) / Math.max(fpT.w, fpT.h)
      // Wobble amplitude: smaller when we have a known road alignment to
      // preserve, larger when we don't (preserves the old behaviour for
      // buildings the generator didn't tag).
      const hasAlignment = roadSide && (roadSide === 'N' || roadSide === 'S' ||
        ((roadSide === 'E' || roadSide === 'W') && isSquareish))
      // === STREET WALL ===
      //
      // A building that knows which street it fronts should be SQUARE to that
      // street. This was +/-15 degrees for aligned buildings and +/-28 for the
      // rest, and a row of terraced houses each turned fifteen degrees from
      // its neighbour cannot read as a street — it reads as assets dropped on
      // the ground, which is exactly how it was described.
      //
      // Character does not come from rotation. It comes from varied heights,
      // frontages, roof styles, colours and the organic lean below. Those all
      // survive; only the spin goes. 3 degrees is enough that the row is not
      // machined, and small enough that the eye still reads one continuous
      // frontage. Buildings with no known road keep more freedom, since there
      // is no street for them to be square to.
      const maxWobble = hasAlignment ? 0.05 * aspect : 0.21 * aspect  // ~3° vs ~12°
      const wobble = (rand01(hash, 6) - 0.5) * 2 * maxWobble
      rotationY = baseRot + wobble
      if (rand01(hash, 7) < 0.45) rotationY = baseRot           // 45% dead square
    }

    // Organic lean — small tilts that pivot around the building base, so
    // a 4-story house leans forward up to ~12cm at the cornice. Pisa-style
    // is a bug; medieval-settled is the goal. Amplitude scales with weather
    // and is gated to ~22% of buildings so the average street isn't tilted
    // — just enough that the eye finds a few lopsided neighbors per block.
    // Towers/walls/gates stay vertical (NO_JITTER) — they'd read as broken
    // landmarks rather than charming-old. Cathedrals & towers also opt out
    // because the silhouette is meant to read as authoritative.
    let leanX = 0, leanZ = 0
    const isLandmark =
      obj.definitionId === 'cathedral' || obj.definitionId === 'temple' ||
      obj.definitionId === 'bell_tower' || obj.definitionId === 'bell_tower_tall' ||
      obj.definitionId === 'clock_tower' || obj.definitionId === 'lighthouse' ||
      obj.definitionId === 'tower' || obj.definitionId === 'watchtower' ||
      obj.definitionId === 'round_tower' || obj.definitionId === 'windmill'
    if (!NO_JITTER.has(obj.definitionId) && !isLandmark && rand01(hash, 401) < 0.22) {
      // Bias forward (toward the street, +Z in local frame) — that's the
      // silhouette reading. Sideways component is smaller. Max ~3.4° forward,
      // ~2° sideways. Weather scales it up; pristine wealthy buildings stay
      // upright more often.
      const weather = styleVector.weather
      const ageScale = 0.35 + weather * 0.65                   // 0.35..1.0
      // leanX rotates around X — so a positive leanX tips the building's TOP
      // forward toward +Z. That's the "bowed toward the street" look.
      leanX = (rand01(hash, 403) * 0.4 + 0.2) * 0.06 * ageScale  // 0.012..0.036 rad
      // Sideways tilt smaller and either direction.
      leanZ = (rand01(hash, 405) - 0.5) * 0.07 * ageScale        // ±0.024 rad
      // Half the leaners tip *away* from the street instead, so the row
      // doesn't all bow forward in unison.
      if (rand01(hash, 407) < 0.5) leanX = -leanX
    }


    // === PARAMETRIC MASSING ===
    // styleVector / dominantArchetype / palette were already computed at
    // the TOP of the loop so all per-decision code below has access to
    // them. pickMassing turns the style vector into a Volume[] composition.
    const massing = pickMassing({
      definitionId: obj.definitionId,
      dominantArchetype,
      sv: styleVector,
      hash,
      footW: fp.w, footD: fp.h,
      wallH, floors,
      wallColor: palette.wall, roofColor,
      // The gap a span has to cross — see MassingContext.groundDrop.
      groundDrop: getHeight ? maxTH - minTH : 0,
      // Which way it crosses — see MassingContext.spanAlongX. Only the placer
      // knows, and a square footprint cannot be asked.
      spanAlongX: typeof obj.properties?.spanAlongX === 'boolean'
        ? obj.properties.spanAlongX as boolean
        : undefined,
    })

    // THE PLINTH IS EMITTED HERE, AFTER THE MASSING, AND THAT ORDER IS THE
    // POINT. It used to run before it, so it could not ask the one question
    // that decides whether it should exist at all: has the massing already
    // taken responsibility for the drop? Only a span does, and the plinth was
    // damming every river in the town under every bridge.
    // Foundation plinth — emitted as per-tile stone columns so the foundation
    // STEPS with the terrain rather than sitting as one flat block. Each
    // footprint tile gets its own column from that tile's ground up to the
    // building's base (maxTH). Tiles already at maxTH get no column.
    // Columns overlap slightly (1.08 vs 1.0) so interior seams don't z-fight
    // and outer edges extend past the wall face, matching the old plinth's
    // +0.06 overhang on each side.
    // A PLINTH FILLS A GAP. A BRIDGE SPANS ONE.
    //
    // This gate was `maxTH - minTH > 0.08` and nothing else, so every bridge
    // got ELEVEN stone columns running from the river bed up to bank height —
    // the channel dammed solid, with the piers standing on the dam. Measured
    // on seed 31337, and it is most of why bridges have never read as bridges.
    //
    // Derived rather than a type list, which is this repo's rule: if the
    // massing already sends something BELOW the placement base, it has taken
    // responsibility for the drop and does not want stonework poured under it.
    // Only the bridge templates descend, so only they are exempt — and any
    // future template that reaches down gets the same treatment for free.
    const massingDescends = massing.volumes.some((v) => v.bottomY < -0.05)
    if (getHeight && maxTH - minTH > 0.08 && !massingDescends) {
      const cos = Math.cos(rotationY), sin = Math.sin(rotationY)
      for (let fy = 0; fy < fpT.h; fy++) {
        for (let fx = 0; fx < fpT.w; fx++) {
          const tileGround = getHeight(obj.x + fx, obj.y + fy)
          const colH = maxTH - tileGround
          if (colH < 0.08) continue
          // Tile-local offset from building center, taken into world units
          // before the rotation so the column lands under its own tile.
          const lx = (fx - fpT.w / 2 + 0.5) * TILE
          const lz = (fy - fpT.h / 2 + 0.5) * TILE
          const rx = lx * cos - lz * sin
          const rz = lx * sin + lz * cos
          // One tile square plus the 8% overlap that keeps interior seams
          // from z-fighting and pushes the outer edge past the wall face.
          const col = new THREE.BoxGeometry(TILE * 1.08, colH, TILE * 1.08)
          if (rotationY !== 0) col.rotateY(rotationY)
          col.translate(
            centerTileX * TILE + rx,
            tileGround + colH / 2,
            centerTileZ * TILE + rz,
          )
          detailBatch.addPositioned(col, 0x6a5a48) // stone foundation
          // Record it, because tools/clash.mjs asked "is this building
          // standing on anything" and got 32 false positives: the plinth is
          // not one of massing.volumes, so a test over the volume array cannot
          // see the very thing that exists to close that gap. A building is
          // deliberately placed at the HIGHEST corner of its footprint, so on
          // any slope the massing bottom IS above the ground and the plinth
          // steps down to meet it.
          const ph = (TILE * 1.08) / 2
          volumeBoxes.push({
            id: obj.id, def: obj.definitionId, role: 'plinth', habitable: false,
            x0: +(centerTileX * TILE + rx - ph).toFixed(3),
            x1: +(centerTileX * TILE + rx + ph).toFixed(3),
            z0: +(centerTileZ * TILE + rz - ph).toFixed(3),
            z1: +(centerTileZ * TILE + rz + ph).toFixed(3),
            // A plinth column is emitted per TILE and never rotated, so its
            // oriented box is its axis-aligned one.
            cx: +(centerTileX * TILE + rx).toFixed(3),
            cz: +(centerTileZ * TILE + rz).toFixed(3),
            hw: +ph.toFixed(3), hd: +ph.toFixed(3), yaw: 0, descends: false,
            walkable: false,
            y0: +tileGround.toFixed(3), y1: +(tileGround + colH).toFixed(3),
            groundY: +tileGround.toFixed(3),
          })
        }
      }
    }

    // (rotationY already computed above — before plinth emission — so
    // the plinth rotates with the building. Reused here for the volume
    // loop and emitCtx below.)

    // Wealth-driven size scaling — slums shrink to 0.78x, palatial buildings
    // grow to 1.22x. Signature landmark buildings ALSO get a flat +25–40%
    // scale bump on top so they visibly dominate their districts. Applied to
    // every volume in place (width, depth, height, offsets, roofHeight,
    // bottomY). Slight inter-tile overlap is fine; it actually helps the town
    // feel less like a checkerboard.
    const wealthScale = 0.78 + styleVector.wealth * 0.44
    const landmarkScale =
      obj.definitionId === 'cathedral' ? 1.35 :
      obj.definitionId === 'temple' ? 1.3 :
      obj.definitionId === 'bell_tower_tall' ? 1.25 :
      obj.definitionId === 'bell_tower' ? 1.2 :
      obj.definitionId === 'clock_tower' ? 1.2 :
      obj.definitionId === 'lighthouse' ? 1.2 :
      obj.definitionId === 'mansion' ? 1.18 :
      obj.definitionId === 'guild_hall' ? 1.15 :
      obj.definitionId === 'watchtower' ? 1.15 :
      1.0
    const sizeScale = wealthScale * landmarkScale
    if (Math.abs(sizeScale - 1.0) > 0.02 && !NO_JITTER.has(obj.definitionId)) {
      // WHAT THE TEMPLATE ASKED FOR, kept so the re-floor below can restore
      // the scale without OVERRULING the template. See the storey floor.
      const authored = massing.volumes.map((v) => v.height)
      massing.volumes = massing.volumes.map(v => ({
        ...v,
        width: v.width * sizeScale,
        depth: v.depth * sizeScale,
        offsetX: v.offsetX * sizeScale,
        offsetZ: v.offsetZ * sizeScale,
        height: v.height * sizeScale,
        roofHeight: v.roofHeight * sizeScale,
        bottomY: v.bottomY * sizeScale,
      }))
      // wealthScale runs AFTER massing, so it can pull a volume back under the
      // human minimum that pickMassing just enforced — a slum multiplier of
      // 0.78 on a 2.6m wall is 2.0m. Re-floor here, bounded by the footprint
      // plus the overhang allowance so this cannot reintroduce a sail.
      //
      // This is the THIRD copy of the habitable minimum (pickMassing has two),
      // and it was the dominant one: it skips only three roles, so it also
      // widened every piece of `trim` — a bridge parapet, a footbridge's 8cm
      // handrail, a wall's coping — to 2.6m. Marking the masonry templates
      // non-habitable fixed the other two copies and changed nothing on
      // screen until this one learned the same word. A rule applied in two
      // places out of three is not applied.
      const maxW = fp.w + 1.2, maxD = fp.h + 1.2
      for (const v of massing.volumes) {
        if (v.role === 'chimneyVol' || v.role === 'porch' || v.role === 'spire') continue
        if (v.habitable === false) continue
        v.width = Math.min(maxW, Math.max(v.width, Math.min(MIN_HABITABLE_W, maxW)))
        v.depth = Math.min(maxD, Math.max(v.depth, Math.min(MIN_HABITABLE_W, maxD)))
      }
      // AND THE VERTICAL HALF OF THAT FLOOR HAS TO CARRY WHAT IS STANDING ON
      // IT. Raising a storey's height in place, which is what this used to do
      // in the loop above, moves its ceiling up THROUGH whatever was resting
      // on the old one: `tmplJettiedUpper` authors a deliberately squat 0.32
      // ground floor, a slum multiplier of 0.78 takes it under STOREY_HEIGHT,
      // the floor pushed it back to 2.9m and the jetty's underside stayed
      // where it was. `roofcheck` counted every one as an open box — 18 over
      // two seeds, and turning this one line off read 0 — while `clash` was
      // carrying the interpenetration it created.
      //
      // TWO AUTHORS OF ONE QUANTITY, the same shape as the bridge deck and
      // the terrain, and the fix is the same: whoever moves the surface tells
      // the things standing on it. Ascending order, so a lift propagates up
      // through a stack rather than stopping at the first storey.
      // A FLOOR THAT UNDOES A SCALE MUST NOT OVERRULE THE THING IT RESTORES.
      // This floored every mainBody at STOREY_HEIGHT flat, so any template
      // asking for LESS was silently overridden — and several intrinsic-size
      // types do: a potting shed asks for 2.32-3.07m and came out at exactly
      // 2.9 every time, which `variety.mjs` found as four identical sheds in
      // a row, all "4.5m tall", the largest near-twin cluster in the town.
      // The purpose here is to undo wealthScale's shrinkage, and the honest
      // target is therefore the AUTHORED height capped at a storey: a slum
      // multiplier can no longer crush a house, and a garden shed is allowed
      // to be a garden shed.
      const authoredOf = new Map<(typeof massing.volumes)[number], number>()
      massing.volumes.forEach((v, i) => authoredOf.set(v, authored[i] ?? STOREY_HEIGHT))
      for (const v of [...massing.volumes].sort((a, b) => a.bottomY - b.bottomY)) {
        if (v.role !== 'mainBody' && v.role !== 'upperFloor') continue
        if (v.habitable === false) continue
        const target = Math.min(STOREY_HEIGHT, authoredOf.get(v) ?? STOREY_HEIGHT)
        if (v.height >= target) continue
        const oldTop = v.bottomY + v.height
        v.height = target
        const lift = v.bottomY + v.height - oldTop
        for (const o of massing.volumes) {
          // RESTING ON IT, not merely above it: the 0.06 window is the seam
          // tolerance templates already use (tmplTenement seats its upper
          // floor 0.04 low on purpose so the join does not show), and the
          // plan overlap is what stops a chimney breast beside the body from
          // being dragged along with it.
          if (o === v || Math.abs(o.bottomY - oldTop) > 0.06) continue
          if (Math.abs(o.offsetX - v.offsetX) >= (o.width + v.width) / 2) continue
          if (Math.abs(o.offsetZ - v.offsetZ) >= (o.depth + v.depth) / 2) continue
          o.bottomY += lift
        }
      }
    }
    // wealthScale multiplies OFFSETS as well as extents, and the footprint it
    // has to fit in does not scale — so a volume already at the edge walks
    // straight back out, and the habitable re-floor above pushes it further.
    // Re-clip, with the same function pickMassing uses. This is the last thing
    // in the pipeline that may touch an extent, which is what makes the
    // invariant hold instead of merely being intended.
    // A JETTY OVERHANGS THE STREET, NOT NEXT DOOR.
    //
    // Per-side now: full MAX_OVERHANG where the adjacent tiles are free, and
    // nothing where a neighbour has reserved them — a wall that stops at the
    // plot line IS a party wall, which is what 93% of this town has. Applied
    // only on this final clip, which is the last thing to touch an extent and
    // therefore the one that governs; pickMassing cannot do it because it
    // sizes one building with no knowledge of the street.
    //
    // The LOCAL frame is what the clip works in, and rotationY maps it to the
    // world. baseRot is 0, PI or +-PI/2, and the +-PI/2 case is already
    // restricted to square-ish footprints precisely so a rotation cannot swap
    // the reserved rectangle's axes — so rounding to the nearest quarter turn
    // is exact for the base and off by only the wobble (+-3 deg where a road
    // aligns the building, which is 55% of them).
    // Kept for the FLANK FEATURES further down. A buttress is precisely the
    // masonry that may stand proud of the footprint and no further, and this
    // is the only place that knows how far that is on each side — full where
    // the adjacent tiles are free, zero where a neighbour has reserved them.
    let allowNX = 0, allowPX = 0
    {
      const q = ((Math.round(rotationY / (Math.PI / 2)) % 4) + 4) % 4
      // World sides, in the order local -X, +X, -Z, +Z after q quarter-turns.
      const worldFree = [
        !sideTaken(obj.x, obj.y, fpT.w, fpT.h, -1, 0),
        !sideTaken(obj.x, obj.y, fpT.w, fpT.h, 1, 0),
        !sideTaken(obj.x, obj.y, fpT.w, fpT.h, 0, -1),
        !sideTaken(obj.x, obj.y, fpT.w, fpT.h, 0, 1),
      ]
      // q=0: (-X,+X,-Z,+Z)  q=1: local -X is world -Z ... rotate the mapping.
      const order = [[0, 1, 2, 3], [2, 3, 1, 0], [1, 0, 3, 2], [3, 2, 0, 1]][q]
      const A = MAX_OVERHANG_M
      clipToFootprint(massing.volumes, fp.w, fp.h, obj.definitionId, {
        nx: worldFree[order[0]] ? A : 0,
        px: worldFree[order[1]] ? A : 0,
        nz: worldFree[order[2]] ? A : 0,
        pz: worldFree[order[3]] ? A : 0,
      })
      allowNX = worldFree[order[0]] ? A : 0
      allowPX = worldFree[order[1]] ? A : 0
    }
    // And re-cap the roofs, because the clip may have narrowed a volume and a
    // roof sized for the original span is the floating-finial bug this repo
    // already fixed once by ordering: buildRoof re-clamps against the real
    // width and draws a shorter cone while the ornaments stay at the old apex.
    // clampRoofHeight is idempotent, so last is safe.
    for (const v of massing.volumes) {
      v.roofHeight = clampRoofHeight(v.width, v.depth, v.roofHeight, v.roofStyle)
      v.roofHeight = clampRoofToWall(v.height, v.roofHeight, v.roofStyle)
    }
    traceStage(massing.traceId, obj.definitionId, 'wealthScale', massing.volumes, fp.w, fp.h)

    // Short 1-story buildings don't contribute meaningfully to the dusk
    // silhouette shadows — their 1.8m shadow is quickly lost under
    // neighboring props and ground shading. Exclude them from shadow
    // casting to halve the caster count in the shadow frustum (biggest
    // single draw-call sink was the shadow pass iterating every wall).
    const castsShadow = floors >= 2
    const stoneBased = styleVector.stone > 0.55 ||
      dominantArchetype === 'nobleStone' || dominantArchetype === 'gothicStone' ||
      district === 'noble' || district === 'temple'

    // Ground-floor material contrast — half-timber / commercial / Tudor
    // buildings often had a stone or stucco shop floor under a timber/
    // plaster upper structure. Triggers on ~40% of textured buildings,
    // skewed toward Tudor (always), commercial (often), and stone (rare —
    // stone buildings already use stone walls all the way up). Picks from
    // a small palette of contrasting tones so the cache stays bounded.
    // CAP THE LEAN BY WHAT YOU CAN SEE, NOT BY WHAT TYPE IT IS.
    //
    // The tilt above is an ANGLE, which is the right scale-free way to author
    // it. The opt-out is not: towers, cathedrals and gates are excused by
    // `definitionId`, on the reasoning that a leaning landmark reads as broken
    // rather than as charming-old — and that is a PROXY for "is this thing
    // tall". Landmark promotion hands 28% of ordinary buildings a dramatic
    // vertical template while leaving the id alone, so a `row_house` can come
    // out 25m and still lean. A proxy agrees with its target right up until
    // you change the target.
    //
    // Measured before fixing, and the measurement shrank the claim: 17% of
    // buildings lean, median 0.31m out of plumb, which is a settled house and
    // exactly right. Only FOUR exceeded 0.45m (max 0.64m on a 24.8m
    // almshouse). So this is a tail, not a systemic defect — worth a clamp,
    // not worth a redesign, and it does not explain anything else.
    //
    // Pinned to a physical displacement for the same reason MAX_OVERHANG is:
    // the quantity a person sees is metres at the parapet, not radians.
    {
      const MAX_OUT_OF_PLUMB = 0.40
      let apex = 0
      for (const v of massing.volumes) {
        apex = Math.max(apex, v.bottomY + v.height + v.roofHeight)
      }
      const out = Math.hypot(Math.tan(leanX), Math.tan(leanZ)) * apex
      if (out > MAX_OUT_OF_PLUMB && apex > 0.01) {
        const k = MAX_OUT_OF_PLUMB / out
        leanX *= k
        leanZ *= k
      }
    }

    let groundFloorColor: number | undefined
    const wantsGfBand =
      dominantArchetype === 'halfTimberTudor' ||
      ((district === 'market' || district === 'artisan') && rand01(hash, 1051) < 0.55) ||
      (!stoneBased && rand01(hash, 1051) < 0.30)
    if (wantsGfBand) {
      // Pick a complementary stone tone. Light walls get darker stone;
      // dark walls get lighter limestone. Variant chosen by hash.
      const wallR = (palette.wall >> 16) & 0xff
      const lightWall = wallR > 165
      const lightStones = [0xb8a888, 0xa89878, 0xc8b89a, 0x9c8a72]   // dark stones
      const darkStones  = [0xd0c2a4, 0xc0b094, 0xb8aa90, 0xa89880]   // light stones
      const palette_ = lightWall ? lightStones : darkStones
      groundFloorColor = palette_[hash % palette_.length]
    }

    // Tell the batch builder where this building ends, so any piece that
    // reaches past it is measurable instead of merely noticeable. Generous by
    // design — footprint plus a metre, apex plus a metre — because the point
    // is to catch geometry in the SKY, not to police a cornice.
    //
    // The apex is derived from the volumes right here rather than from
    // apexLocalY, which is declared further down: reaching forward to it threw
    // a TDZ error on every building, and since the per-building try/catch
    // swallows it the only symptom was a town with one house in it.
    {
      // The envelope is the union of the actual VOLUMES, not the footprint.
      // Footprint + 1m was far too loose to be useful: a 3-tile building got
      // an 11m-wide box, so a 5m beam radiating off its roof scored zero and
      // the audit reported "nothing found" while the beams were plainly
      // visible on screen. Volumes + a small trim allowance is the envelope
      // that actually asks "is this attached to the building?".
      const TRIM = 0.45
      let eMinX = Infinity, eMaxX = -Infinity
      let eMinZ = Infinity, eMaxZ = -Infinity, envApex = 0
      for (const v of massing.volumes) {
        // Volumes are in the building's local frame; yaw can swing a corner
        // out to the diagonal, so bound by the half-diagonal.
        const r = Math.hypot(v.width, v.depth) / 2
        eMinX = Math.min(eMinX, v.offsetX - r); eMaxX = Math.max(eMaxX, v.offsetX + r)
        eMinZ = Math.min(eMinZ, v.offsetZ - r); eMaxZ = Math.max(eMaxZ, v.offsetZ + r)
        envApex = Math.max(envApex, v.bottomY + v.height + v.roofHeight)
      }
      setBuildEnvelope({
        minX: wx + eMinX - TRIM, maxX: wx + eMaxX + TRIM,
        minZ: wz + eMinZ - TRIM, maxZ: wz + eMaxZ + TRIM,
        minY: wy - TRIM, maxY: wy + envApex + TRIM,
        label: obj.definitionId,
      })
    }

    const ornamentSeen = new Set<string>()
    /** The building's apex, hoisted so the ornament-site callback below can
     *  read it — see the note on tallyOrnament. Assigned once the massing is
     *  final; zero here just aims a site at the building's base, which is
     *  still a usable camera target and never throws. */
    let apexForSite = 0
    const emitCtx = {
      // Roof ornaments are owned by VolumeRenderer and were never tallied, so
      // dormers, finials, spire crosses, weather vanes and the new copper cap
      // were invisible to features.mjs — four pieces of vocabulary that could
      // have been firing at zero with no way to find out. Same shape as the
      // `featureCounts` array that had no consumer.
      //
      // ONCE PER BUILDING, not once per volume. The first cut tallied on every
      // volume and the census came back with dormer at 115% of a district and
      // finial at 125% — a building with two spires counted twice against a
      // denominator that counts it once. A rate above 100% is a free bug
      // report about the measurement, and this is the second time this exact
      // one has appeared (doorstep read 182% for the same reason). The wall
      // features are per-building, so these have to be as well or the two
      // halves of one census answer different questions.
      // Declared BEFORE the callback that reads it. `apexLocalY` is computed
      // a hundred lines below this object literal, so referencing it from
      // inside the closure is a temporal-dead-zone throw at call time — and
      // because `tallyIn` runs FIRST in that callback, the count still
      // incremented while everything after the throw silently stopped. dormer
      // read 102 with zero recorded sites and the buttress vanished entirely.
      // A counter that rises while the work it labels is aborted is the worst
      // shape of all: it reads as proof the code ran.
      tallyOrnament: (kind: string) => {
        if (ornamentSeen.has(kind)) return
        ornamentSeen.add(kind)
        tallyIn(kind, district)
        // AND WHERE IT IS. VolumeRenderer draws in the volume's local frame
        // and does not know its world position, but this callback runs while
        // BuildingFactory is processing one specific building — so the
        // closure already has it and no signature has to change. Aimed at the
        // apex, because every ornament this callback reports (dormer, finial,
        // copperCap, spireCross, weatherVane) is on the roof.
        siteOf(kind, wx, wy + apexForSite * 0.85, wz)
      },
      centerX: wx,
      centerZ: wz,
      baseY: wy,
      hasTimber: !!obj.properties.hasTimber || hash % 3 === 0,
      hasShutters: !!obj.properties.hasShutters || hash % 4 !== 0,
      hasFlowerBox: !!obj.properties.hasFlowerBox,
      style,
      palette,
      rotationY,
      leanX,
      leanZ,
      hash,
      weather: styleVector.weather,
      stoneBased,
      groundFloorColor,
      castsShadow,
    }
    for (const vol of massing.volumes) {
      emitVolume(vol, emitCtx, wallMeshes, roofBatch, ornamentBatch)
    }

    // Approximate mainBody roof top for chimney + ornament placement.
    // Prefer the first 'mainBody' volume so chimneys don't float above
    // a tiny corner-tower sub-volume when the massing template puts
    // the body second. Massing templates are required to return at
    // least one volume; if a future template ever returns an empty
    // array, this throws and the catch handler downgrades it to a
    // logged failure rather than crashing the whole pass.
    if (massing.volumes.length === 0) {
      throw new Error(`Massing returned 0 volumes for ${obj.definitionId}`)
    }
    const mainVol = massing.volumes.find(v => v.role === 'mainBody') ?? massing.volumes[0]
    const mainLocalTopY = mainVol.bottomY + mainVol.height
    const mainRoofH = mainVol.roofHeight

    // === WHERE THE FRONT WALL ACTUALLY IS ===
    //
    // Every front-attached detail — shop sign, awning, stoop, bench, doorstep,
    // hitching post, colonnade, balcony — used to hang off `fp.h / 2`: the edge
    // of the footprint RECTANGLE. That is not the wall. The massing volume is
    // inset inside its footprint and then multiplied by wealthScale (0.78-1.22)
    // and landmarkScale, so the gap between the footprint edge and the actual
    // wall face is both nonzero and different for every building.
    //
    // That gap is what "signs floating" was: a bracket drawn from the footprint
    // edge outward, starting in mid-air some distance in FRONT of the wall it
    // was supposed to be bolted to. It was already wrong at one-unit tiles and
    // scaled straight up with the tile factor.
    //
    // So: one anchor pair, derived from the volume that actually carries the
    // front face, and everything hangs off these instead.
    const frontWallZ = mainVol.offsetZ + mainVol.depth / 2
    const frontWallHalfW = mainVol.width / 2

    // === AND WHERE THE OTHER THREE WALLS ARE ===
    //
    // There was no equivalent of the pair above for the back or the flanks,
    // and that absence IS the "every other angle looks like a back alley"
    // report: a feature can only be attached where there is an anchor to
    // attach it to, so every piece of dressing in this file went on the one
    // wall that had one. The fix is not more dressing, it is the missing
    // anchors — the same move that `PlacedObject.footprint` was for placement.
    //
    // `*Room` is how far a rear or flank feature may project before it leaves
    // the building's own reserved footprint. The massing volume is inset
    // inside that footprint (and then scaled by wealth), so this gap is real,
    // nonzero and different for every building — it is the same gap that used
    // to leave front-attached signs floating in mid-air, read the other way
    // round. Clamping to it means a lean-to or a buttress can never reach
    // into a neighbour, which is the invariant tools/audit.mjs enforces and
    // tools/overhang.mjs counts.
    const backWallZ = mainVol.offsetZ - mainVol.depth / 2
    const backRoom = Math.max(0, backWallZ - (-fp.h / 2))
    const sideWallX = (s: number): number => mainVol.offsetX + s * mainVol.width / 2
    const sideRoom = (s: number): number => Math.max(0, fp.w / 2 - s * sideWallX(s))
    const mainWallH = mainVol.height

    // Record where this building really ends up so particle systems can hang
    // off it without re-deriving its height (see BuildingTop).
    apexForSite = 0
    let apexLocalY = 0
    // AND THE TOP OF THE TALLEST SHAFT, which is a different question from the
    // apex and is the one a belfry light needs: the apex is the tip of the
    // SPIRE, and a lamp placed there is inside a solid cone. See the beacon.
    let towerTopY = 0, towerVol: (typeof massing.volumes)[number] | null = null
    for (const v of massing.volumes) {
      const t = v.bottomY + v.height + v.roofHeight
      if (t > apexLocalY) apexLocalY = t
      const wallTop = v.bottomY + v.height
      if (wallTop > towerTopY) { towerTopY = wallTop; towerVol = v }
    }
    // And the WHOLE structure's horizontal extent, over every volume. The main
    // body is the right anchor for a chimney and the wrong one for a camera:
    // a bridge's `mainBody` is a single 70cm pier, so a tool asking "frame this
    // structure" got a shot of one pier from two metres and no bridge in it.
    let spanHalfW = 0, spanHalfD = 0
    for (const v of massing.volumes) {
      spanHalfW = Math.max(spanHalfW, Math.abs(v.offsetX) + v.width / 2)
      spanHalfD = Math.max(spanHalfD, Math.abs(v.offsetZ) + v.depth / 2)
    }
    // Roof-style census. A volume taller than ~4m with no roof reads as an
    // unfinished building from the street, so count those separately.
    for (const v of massing.volumes) {
      if (v.role === 'chimneyVol') continue
      roofStyles[v.roofStyle] = (roofStyles[v.roofStyle] ?? 0) + 1
      // Most flat volumes are structural and hidden — the lower body under a
      // jetty, the main block under a step-back penthouse. What reads as an
      // unfinished building is a flat volume that is the TOP of its building
      // with nothing stacked above it.
      const isFlatTop = v.roofStyle === 'flat' || v.roofStyle === 'none' || v.roofHeight <= 0
      // "Nothing stacked on THIS volume" — not "is the building's apex". A
      // flat-topped tower on a building that has a taller spire elsewhere is
      // still an open box against the sky.
      const covered = massing.volumes.some(o =>
        o !== v && o.bottomY >= v.bottomY + v.height - 0.05 &&
        Math.abs(o.offsetX - v.offsetX) < (o.width + v.width) / 2 &&
        Math.abs(o.offsetZ - v.offsetZ) < (o.depth + v.depth) / 2)
      // MASONRY IS MEANT TO END IN SKY. A parapet, a curtain wall and a bridge
      // pier are flat-topped by design, and once `habitable: false` stopped
      // the repair pass roofing them this count went 15 -> 23 on the same
      // three seeds — a tool grading correct geometry as a defect. Exactly the
      // category error humanscale made counting a 1.6m wall as a storey under
      // head height. A tool's two halves have to count the same population.
      if (v.habitable === false) continue
      if (isFlatTop && !covered && v.height >= 2.0) {
        flatToppedTallVolumes++
        // ROOF STYLE IN THE KEY, because `isFlatTop` is a disjunction and its
        // two arms want opposite fixes: a volume AUTHORED `flat`/`none` is a
        // template decision, and one whose roofHeight COLLAPSED to zero under
        // a clamp is a bug in the clamp. A count cannot tell them apart and
        // the first run of this attribution could not either.
        // AND WHY COVERAGE FAILED. Every offender came back `mainBody` and
        // authored flat, which in each candidate template is the LOWER BODY
        // OF A JETTY — a volume that is supposed to have an upper floor on
        // top of it. So the question is no longer "which template" but
        // "where did the thing that covers it go", and there are only two
        // answers: nothing overlaps it in plan, or something does and sits
        // too low. They want opposite fixes.
        const overlapsInPlan = massing.volumes.some(o =>
          o !== v &&
          Math.abs(o.offsetX - v.offsetX) < (o.width + v.width) / 2 &&
          Math.abs(o.offsetZ - v.offsetZ) < (o.depth + v.depth) / 2)
        const why = overlapsInPlan ? 'sitsTooLow' : 'nothingAbove'
        const k = `${obj.definitionId}:${v.role}:${v.roofStyle}${v.roofHeight <= 0 ? '/rise0' : ''}:${why}`
        flatTopBy[k] = (flatTopBy[k] ?? 0) + 1
      }
    }
    // Horizontal extents travel with the vertical ones for the same reason
    // BuildingTop exists at all: anything hanging off a wall — lanterns,
    // signs, awnings — otherwise re-derives the wall position from the
    // footprint rectangle, and the footprint is not where the wall is.
    // === HUMAN-SCALE SAMPLE ===
    // FacadeTexture builds the facade in texture units: the image is
    // `fpT.w` units across and `floors + 0.5` tall, and it is then stretched
    // over the wall. So an opening's real size is its texture fraction times
    // the wall's world size. Recording it here — where both the texture config
    // and the finished volume are in scope — is the only place the two can be
    // multiplied without re-deriving either.
    {
      const sFloors = volumeFloors(mainVol)
      // FacadeTexture is metric in both axes now — one texture unit is one
      // metre — so an opening drawn at N units lands on the wall at N metres
      // and these are simply the constants it draws with. When they stop
      // matching, this audit is the thing that says so.
      scaleSamples.push({
        definitionId: obj.definitionId,
        wallW: +mainVol.width.toFixed(2),
        wallD: +mainVol.depth.toFixed(2),
        wallH: +mainVol.height.toFixed(2),
        totalH: +(apexLocalY).toFixed(2),
        floors: sFloors,
        storeyH: +(mainVol.height / sFloors).toFixed(2),
        // Both tilts combined, at the apex. tan is right rather than the small
        // angle itself, because the whole point is the metres you can see.
        outOfPlumb: +(Math.hypot(Math.tan(leanX), Math.tan(leanZ)) * apexLocalY).toFixed(3),
        doorH: 2.05,
        doorW: 0.95,
        windowH: 1.35,
        windowW: 1.0,
        habitable: mainVol.habitable !== false,
      })
    }

    // === WORLD BOXES, FOR THE CLASH AUDIT ===
    //
    // The placement audit checks FOOTPRINTS — tile rectangles — and a footprint
    // invariant is not a geometry invariant: two buildings can own disjoint
    // tiles and still have a wing driven through each other's walls, which is
    // "buildings colliding" as reported from the device. Nothing has ever
    // compared the built solids. Record each volume's yaw-aligned world box
    // here, where the transform is already in scope, so tools/clash.mjs can.
    for (const v of massing.volumes) {
      const c = Math.abs(Math.cos(rotationY)), sn = Math.abs(Math.sin(rotationY))
      const hx = (v.width / 2) * c + (v.depth / 2) * sn
      const hz = (v.width / 2) * sn + (v.depth / 2) * c
      const cx = wx + (v.offsetX * Math.cos(rotationY) - v.offsetZ * Math.sin(rotationY))
      const cz = wz + (v.offsetX * Math.sin(rotationY) + v.offsetZ * Math.cos(rotationY))
      volumeBoxes.push({
        id: obj.id, def: obj.definitionId, role: v.role,
        habitable: v.habitable !== false,
        x0: +(cx - hx).toFixed(3), x1: +(cx + hx).toFixed(3),
        z0: +(cz - hz).toFixed(3), z1: +(cz + hz).toFixed(3),
        // ...and the box as it actually stands, so a test can be exact.
        cx: +cx.toFixed(3), cz: +cz.toFixed(3),
        hw: +(v.width / 2).toFixed(3), hd: +(v.depth / 2).toFixed(3),
        yaw: +rotationY.toFixed(5), descends: v.bottomY < -0.05,
        walkable: v.walkable === true,
        y0: +(wy + v.bottomY).toFixed(3),
        y1: +(wy + v.bottomY + v.height + v.roofHeight).toFixed(3),
        // Ground under this volume's own centre, so "is it standing on
        // anything" is answerable without re-sampling the height map.
        // getHeight speaks TILES, the boxes are in metres — see scale.ts. This
        // exact confusion has silently sampled the height map at a third of
        // the intended place before now.
        groundY: +(getHeight ? getHeight(cx / TILE, cz / TILE) : wy).toFixed(3),
      })
    }

    // WHERE THE SMOKE LEAVES, if a template declared a flue. Computed in the
    // same frame as everything else on BuildingTop and for the same reason:
    // ThreeRenderer used to vent from the footprint centre, which is a second
    // copy of the massing's arithmetic and wrong for any building whose flue
    // is not central. See Volume.vent.
    let ventX: number | undefined, ventY: number | undefined, ventZ: number | undefined
    for (const v of massing.volumes) {
      if (!v.vent) continue
      ventX = wx + (v.offsetX * Math.cos(rotationY) - v.offsetZ * Math.sin(rotationY))
      ventZ = wz + (v.offsetX * Math.sin(rotationY) + v.offsetZ * Math.cos(rotationY))
      ventY = wy + v.bottomY + v.height + v.roofHeight
      break
    }

    let volTexArea = 0, volArea = 0, volTex = 0
    const volStyles: string[] = []
    for (const v of massing.volumes) {
      if (v.role === 'chimneyVol') continue
      const a = 2 * (v.width + v.depth) * v.height
      volArea += a
      if (v.textured) { volTex++; volTexArea += a }
      if (v.roofHeight > 0) volStyles.push(v.roofStyle)
    }
    tops.push({
      definitionId: obj.definitionId,
      district: String(obj.properties?.district ?? '?'),
      baseY: wy,
      volumeCount: massing.volumes.length,
      texturedVolumes: volTex,
      wallArea: +volArea.toFixed(2),
      texturedArea: +volTexArea.toFixed(2),
      roofStyles: volStyles,
      centerX: wx + (mainVol.offsetX * Math.cos(rotationY) - mainVol.offsetZ * Math.sin(rotationY)),
      centerZ: wz + (mainVol.offsetX * Math.sin(rotationY) + mainVol.offsetZ * Math.cos(rotationY)),
      halfW: mainVol.width / 2,
      halfD: mainVol.depth / 2,
      originX: wx,
      originZ: wz,
      spanHalfW,
      spanHalfD,
      rotationY,
      id: obj.id,
      apexY: wy + apexLocalY,
      mainWallTopY: wy + mainLocalTopY,
      mainRoofH,
      ventX, ventY, ventZ,
    })
    // Does massing already include a chimney volume? (cottageSmall does.)
    const massingHasChimney = massing.volumes.some(v => v.role === 'chimneyVol')

    // === CHIMNEYS → batched ===
    // Skip entirely if massing already supplies a chimney volume.
    // Big/tall buildings (floors >= 3 or wealth archetype) get two chimneys.
    if (!massingHasChimney && hash % 5 < 2 && mainRoofH > 0) {
      tallyIn('chimney', district)
      // Chimney stacks with deliberate whimsical variety — brick stacks on
      // small houses, the occasional tall crooked flue, the rare copper-top
      // or double-stack. Hash picks the variant so regenerating the seed
      // gives the same silhouette.
      // Variant 0,1,2 — stocky single; 3 — double stack; 4 — tall whimsy;
      // 5 — copper-top; 6 — wide short.
      // Tall whimsy (variant 4) is reserved for floors >= 3 — on a 1-story
      // cottage a 2.0m chimney stack overshadows the building itself, which
      // was the "features extending beyond their boundaries" reading on
      // the most recent debug screenshot. Buildings under 3 floors that
      // would have rolled variant 4 fall back to variant 0 (stocky single).
      let variant = hash % 7
      if (variant === 4 && floors < 3) variant = 0
      const chimCount = (floors >= 3 || styleVector.wealth > 0.6) ? 2
                      : variant === 3 ? 2
                      : 1
      // Height/width — capped so a chimney can never be more than ~50% of
      // the building's wallH. Without this clamp a 1-story house with
      // FLOOR_HEIGHT=1.8 (1.8m wall) could end up with a 0.85m chimney
      // stack + 0.22m pot = 1.07m of chimney structure, ~60% of the wall.
      const wallHforCap = floors * FLOOR_HEIGHT * (HEIGHT_MULT[obj.definitionId] ?? 1.0)
      const heightCap = wallHforCap * 0.50
      const baseHraw = variant === 4 ? 1.2 + rand01(hash, 701) * 0.8     // 1.2–2.0 (tall whimsy, floors >= 3 only)
                     : variant === 6 ? 0.35 + rand01(hash, 701) * 0.1    // short chubby
                     : 0.5 + rand01(hash, 701) * 0.35                    // default 0.5–0.85
      const baseH = Math.min(baseHraw, heightCap)
      const chimW = variant === 6 ? 0.7 : variant === 4 ? 0.42 : 0.5
      const capColor = variant === 5 ? 0x4a7870 /* verdigris copper */ : 0x5a3020
      // Local Y of chimney base (above the mainBody roof base). Building lean
      // pivots around (wx, wy, wz), so anchoring at this local Y means the
      // chimney follows the leaning building correctly.
      const chimBaseLocalY = mainLocalTopY + mainRoofH * 0.4
      for (let c = 0; c < chimCount; c++) {
        const chimSide = c === 0
          ? ((obj.properties.chimneyPos === 'left') ? -1 : 1)
          : (((obj.properties.chimneyPos === 'left') ? 1 : -1))
        const chimH = baseH * (c === 0 ? 1.0 : 0.75 + rand01(hash, 711 + c) * 0.15)
        // Relative to the ROOF it stands on — mainVol — not the footprint
        // rectangle. A chimney offset by a fraction of the footprint can clear
        // the roof edge entirely and stand on air beside the building, which is
        // exactly the class of defect reported as things hovering.
        const localX = mainVol.offsetX + chimSide * mainVol.width * 0.32
        const localZ = mainVol.offsetZ + (c === 0
          ? (rand01(hash, 703) - 0.5) * mainVol.depth * 0.25
          : (rand01(hash, 600 + c) - 0.5) * mainVol.depth * 0.4)
        // Small Z-tilt on the tall whimsy variant — crooked flue look.
        const flueLeanZ = variant === 4 ? (rand01(hash, 719) - 0.5) * 0.25 : 0
        const stack = new THREE.BoxGeometry(chimW, chimH, chimW)
        if (flueLeanZ !== 0) stack.rotateZ(flueLeanZ)
        stack.translate(0, chimH / 2, 0)
        localToWorld(stack, localX, chimBaseLocalY, localZ, leanX, leanZ, rotationY, wx, wy, wz)
        detailBatch.addPositioned(stack, 0x704030)
        const capW = variant === 6 ? 0.85 : chimW + 0.12
        const cap = new THREE.BoxGeometry(capW, 0.12, capW)
        localToWorld(cap, localX, chimBaseLocalY + chimH + 0.06, localZ, leanX, leanZ, rotationY, wx, wy, wz)
        detailBatch.addPositioned(cap, capColor)
        // Chimney pot — a small clay cylinder rising above the cap. Iconic
        // medieval-rooftop silhouette piece. Variant 5 keeps its copper cap
        // bare (no pot would clash). Variant 6 gets two narrow pots flanking
        // (the wide-short stack reads as a multi-flue chimney). Otherwise a
        // single centered pot.
        if (variant !== 5) {
          const potH = 0.22, potR = 0.07
          const potColor = 0xa0532a       // terracotta
          if (variant === 6) {
            for (const off of [-0.18, 0.18]) {
              const pot = new THREE.CylinderGeometry(potR, potR * 0.95, potH, 7)
              localToWorld(pot, localX + off, chimBaseLocalY + chimH + 0.12 + potH / 2, localZ,
                leanX, leanZ, rotationY, wx, wy, wz)
              detailBatch.addPositioned(pot, potColor)
            }
          } else {
            const pot = new THREE.CylinderGeometry(potR, potR * 0.95, potH, 7)
            localToWorld(pot, localX, chimBaseLocalY + chimH + 0.12 + potH / 2, localZ,
              leanX, leanZ, rotationY, wx, wy, wz)
            detailBatch.addPositioned(pot, potColor)
            // Tall whimsy variant gets an EXTRA tier — a thinner second pot
            // stacked on top, the "I added a flue, then another, then a third"
            // look. Tudor-cottage signature. Reserved for floors >= 3 since
            // variant 4 itself is now floors-gated; this is a defensive
            // re-check that also ensures the 2nd-tier pot only appears
            // where it has visual room.
            if (variant === 4 && floors >= 3) {
              const pot2 = new THREE.CylinderGeometry(potR * 0.85, potR * 0.85, potH * 0.7, 7)
              localToWorld(pot2, localX, chimBaseLocalY + chimH + 0.12 + potH + (potH * 0.7) / 2, localZ,
                leanX, leanZ, rotationY, wx, wy, wz)
              detailBatch.addPositioned(pot2, potColor)
            }
          }
        }
      }
    }

    // === CORNER TIMBER POSTS / QUOINS → ornament-batched ===
    // Vertical wood posts at corners on tudor/half-timber buildings, OR
    // alternating corner stones on stone-dominated noble/gothic buildings.
    // Mutually exclusive (a building reads as either timber-framed OR stone,
    // not both). Both detail types iterate over EVERY body volume — so an
    // L-shape gets posts on the wing, a jettied upper floor gets posts at
    // its corners floating above the lower wall (iconic Tudor), and a
    // step-back penthouse gets quoins on its smaller upper block.
    //
    // Roles to detail: mainBody, wing, upperFloor, transept, penthouse, tower
    //   — not spire (too narrow), porch (3-walled), chimneyVol.
    const wantsTimberPosts = (
      dominantArchetype === 'halfTimberTudor' ||
      styleVector.timber > 0.55
    ) && !NO_JITTER.has(obj.definitionId)
    const wantsQuoins = !wantsTimberPosts &&
      (styleVector.stone > 0.6 || dominantArchetype === 'nobleStone' || dominantArchetype === 'gothicStone') &&
      !NO_JITTER.has(obj.definitionId)
    const cornerableRoles = new Set(['mainBody', 'wing', 'upperFloor', 'transept', 'penthouse', 'tower'])

    if (wantsTimberPosts || wantsQuoins) {
      tallyIn('timberPosts', district)
      // Member thickness grows a little with the building so a 12m guild hall
      // is not framed in the same matchsticks as a 3m cottage — but stays
      // pinned near a real timber section, not scaled proportionally.
      const postT = 0.13
      const quoinW = 0.22, quoinH = 0.34, quoinProj = 0.05

      for (const v of massing.volumes) {
        if (v.circular) continue
        if (!cornerableRoles.has(v.role)) continue
        // Tower-role can be very tall; quoins still look right on stone towers.
        // But timber posts on a 6m tower would read as a giant pole, so skip.
        if (wantsTimberPosts && v.role === 'tower') continue
        if (wantsTimberPosts && v.height < 1.4) continue
        if (wantsQuoins && v.height < 1.6) continue

        const halfW = v.width / 2
        const halfD = v.depth / 2
        const baseLocalY = v.bottomY

        // WHERE THE PAINTED OPENINGS ARE. Same call the texture, the emissive
        // map and VolumeRenderer's window trim all make, so the frame is
        // finally looking at the same grid everything else uses instead of an
        // independent bay pitch.
        //
        // RECORDED FOR EVERY WALL, NOT ONLY THE TIMBERED ONES. This sat inside
        // `if (wantsTimberPosts)` and so did the audit's entire view of the
        // town: a quoined stone elevation painted its openings through exactly
        // the same function and nothing ever looked at them. That is the
        // "measured a fifth of the frame" mistake — which took the collision
        // count 118 -> 550 members when it was fixed for the members — sitting
        // unnoticed on the OPENINGS half of the same tool.
        //
        // Every part below is in THIS volume's wall frame — see volKey.
        const _vk = volKey(v)
        const _openW = quantizeWallM(v.width, 'front')
        const _openCells = facadeOpenings(
          volumeFloors(v), _openW, quantizeWallM(v.height, 'front', 1.5),
          'front', v.wallColor)
        // The wall itself, so the audit can ask the one question that needs no
        // threshold at all: is what we painted actually ON it? Both defects
        // this pass fixed — a window as wide as its wall, and a window whose
        // head sits 0.80m above its own roofline — are containment failures,
        // and neither is a collision, so a collision count could never have
        // reported either. An exact test beats a heuristic proxy.
        recordPart(obj.id, obj.definitionId, _vk, 'wall', 0, v.height / 2, v.width, v.height)
        for (const c of _openCells) {
          recordPart(obj.id, obj.definitionId, _vk, 'window',
            (c.u - 0.5) * v.width, c.vCenter * v.height,
            c.uW * v.width, c.vH * v.height)
        }
        // The door: FacadeTexture centres a 0.95 x 2.05m opening on the
        // front wall's base. Hardcoded there, so hardcoded here — and if
        // that ever drifts, tools/facade.mjs is what will say so.
        //
        // ONLY THE MAIN BODY HAS ONE. The first cut recorded a door for
        // every framed volume, so a tower's four corner posts each "crossed"
        // a door that is not painted on it — 50 phantom collisions on a
        // single building. A tool's two halves have to count the same
        // population, and this half was inventing members of it.
        const _hasDoor = v.role === 'mainBody' && v.habitable !== false
        if (_hasDoor) {
          recordPart(obj.id, obj.definitionId, _vk, 'door', 0, 2.05 / 2, 0.95, 2.05)
        }

        if (wantsTimberPosts) {
          // === EXPOSED TIMBER FRAME ===
          //
          // This is the "giant floating accent timbers" reported from the
          // device, and it was two separate mistakes compounding.
          //
          // 1. FLOATING. Every horizontal member was pushed out by `projOut`,
          //    which is the POST's outward shift — a post is postT (13cm)
          //    deep, so it needs 5.9cm to rest its inner face on the wall. But
          //    the beams are only 4.5cm deep, so the same shift left them
          //    hanging with a ~6cm slit of daylight behind. Invisible on a 2m
          //    wall; unmistakable on a 12m one silhouetted against a dusk sky,
          //    which is exactly the shot it was reported from.
          //
          // 2. TOO LONG TO BE A FRAME. The members are sized in metres and
          //    LENGTHED by the volume, which tripled. A head plate spanning
          //    `v.width + postT * 2` used to be a 2m beam between two corner
          //    posts and is now a 12m stick with nothing under it. Real
          //    framing subdivides: posts every bay, not just at the corners.
          //
          // So each member now seats its own inner face on the wall, and a
          // wide wall gets studs at a real bay pitch plus corner braces. The
          // wider the building, the more frame it grows.
          const postH = v.height
          // Members sit with their inner face ON the wall plane, 1cm proud so
          // they never tie with the wall's own quad in the depth buffer.
          const SEAT = 0.01
          const seatZ = (memberDepth: number) => halfD + memberDepth / 2 + SEAT
          const seatX = (memberDepth: number) => halfW + memberDepth / 2 + SEAT

          // Corner posts, aligned so their outer edge meets the wall corner
          // rather than hanging past it.
          const cornerX = halfW - postT / 2
          for (const sx of [-1, 1]) {
            for (const sz of [-1, 1]) {
              const post = new THREE.BoxGeometry(postT, postH, postT)
              post.translate(0, postH / 2, 0)
              localToWorld(post, v.offsetX + sx * cornerX, baseLocalY,
                v.offsetZ + sz * seatZ(postT) - sz * postT / 2,
                leanX, leanZ, rotationY, wx, wy, wz)
              ornamentBatch.addPositioned(post, 0x3a2418) // dark oak
              if (sz === 1) {
                recordPart(obj.id, obj.definitionId, _vk, 'post',
                  sx * cornerX, postH / 2, postT, postH)
              }
            }
          }

          // Intermediate studs on the street-facing pair of walls, at a bay
          // pitch a carpenter would recognise. This is what turns one long
          // beam into a framed facade — and it scales itself, so a wider
          // building simply gets more bays instead of a longer stick.
          const BAY = 1.7
          const studT = postT * 0.62
          const bays = Math.max(1, Math.round((v.width - postT) / BAY))
          const studDepth = studT
          // === STUDS GO BETWEEN THE OPENINGS, NOT ON A GRID OF THEIR OWN ===
          //
          // Reported as "lumber beams crossing over window and door
          // textures", and measured at 285 crossings on 31 of 66 framed
          // buildings. The frame nailed studs at a 1.7m bay pitch while
          // FacadeTexture paints openings on a ~2.4m column pitch: two grids
          // that do not divide each other, so they beat, and a full-height
          // stud walks across a window on most walls.
          //
          // FacadeTexture's own note says the 3D window TRIM must quantise
          // IDENTICALLY to the texture, and VolumeRenderer obeys it by calling
          // facadeOpenings. The frame is the sibling that never did. Derive
          // the bays from the openings instead: take the wall minus every
          // opening, and stand a stud in the middle of each surviving gap.
          const _blocked = _openCells
            .map((c) => {
              const cx = (c.u - 0.5) * v.width
              const half = (c.uW * v.width) / 2 + studT / 2 + 0.04
              return [cx - half, cx + half]
            })
            .concat(_hasDoor
              ? [[-0.95 / 2 - studT / 2 - 0.04, 0.95 / 2 + studT / 2 + 0.04]]
              : [])
            .sort((a, b) => a[0] - b[0])
          // The vertical bands the openings occupy, merged. The horizontal
          // gap logic below has a twin here because the FLOOR BEAMS span the
          // full width at every floor line, and `floorH = v.height / floors`
          // is not the same quantity facadeOpenings lays its rows out on — so
          // the two grids beat vertically exactly as the studs and columns
          // beat horizontally. 96 beams a town were crossing a window.
          const _rowsRaw: Array<[number, number]> = _openCells
            .map((c) => [(c.vCenter - c.vH / 2) * v.height,
                         (c.vCenter + c.vH / 2) * v.height] as [number, number])
            .concat(_hasDoor ? [[0, 2.05] as [number, number]] : [])   // the door
            .sort((a, b) => a[0] - b[0])
          const _rows: Array<[number, number]> = []
          for (const r of _rowsRaw) {
            const last = _rows[_rows.length - 1]
            if (last && r[0] <= last[1] + 0.06) last[1] = Math.max(last[1], r[1])
            else _rows.push([r[0], r[1]])
          }
          /** Does a wall-local rectangle clear every painted opening? */
          const _clearsOpenings = (
            cx: number, cy: number, mw: number, mh: number,
          ): boolean => {
            const x0 = cx - mw / 2, x1 = cx + mw / 2
            const y0 = cy - mh / 2, y1 = cy + mh / 2
            for (const c of _openCells) {
              const ox = (c.u - 0.5) * v.width, ow = c.uW * v.width
              const oy = c.vCenter * v.height, oh = c.vH * v.height
              if (x1 > ox - ow / 2 && x0 < ox + ow / 2 &&
                  y1 > oy - oh / 2 && y0 < oy + oh / 2) return false
            }
            // ...and the door, which FacadeTexture centres on the wall base.
            if (_hasDoor && x1 > -0.95 / 2 && x0 < 0.95 / 2 && y1 > 0 && y0 < 2.05) return false
            return true
          }

          const _gaps: Array<[number, number]> = []
          {
            let cursor = -(v.width - postT) / 2
            const end = (v.width - postT) / 2
            for (const [b0, b1] of _blocked) {
              if (b0 > cursor) _gaps.push([cursor, Math.min(b0, end)])
              cursor = Math.max(cursor, b1)
            }
            if (cursor < end) _gaps.push([cursor, end])
          }
          // Widest gaps first, so a wide wall still gets its frame subdivided
          // and a narrow one does not grow a stud in a 5cm sliver.
          const _studXs = _gaps
            .filter(([g0, g1]) => g1 - g0 > studT + 0.25)
            .sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))
            .slice(0, Math.max(0, bays - 1))
            .map(([g0, g1]) => v.offsetX + (g0 + g1) / 2)
          if (_studXs.length) {
            for (const studX of _studXs) {
              for (const sz of [-1, 1]) {
                const stud = new THREE.BoxGeometry(studT, postH, studDepth)
                stud.translate(0, postH / 2, 0)
                localToWorld(stud, studX, baseLocalY,
                  v.offsetZ + sz * seatZ(studDepth),
                  leanX, leanZ, rotationY, wx, wy, wz)
                ornamentBatch.addPositioned(stud, 0x3a2418)
                if (sz === 1) {
                  recordPart(obj.id, obj.definitionId, _vk, 'stud',
                    studX - v.offsetX, postH / 2, studT, postH)
                }
              }
            }
          }

          // Head-plate beam across the front+back of this volume just below
          // the cornice. Skip if a heavy cornice will paint over it.
          // Clear of the topmost opening row. At postH - 0.08 - postT/2 the
          // plate landed straight across the top-floor windows on 7 buildings,
          // covering one of them entirely — the same two-grids failure as the
          // studs and the floor beams, at the head of the wall.
          let beamY = baseLocalY + postH - 0.08 - postT / 2
          if (!_clearsOpenings(0, beamY - baseLocalY, v.width, 0.10)) {
            const topRow = _rows.length ? _rows[_rows.length - 1][1] : 0
            const lift = Math.min(postH - 0.06, topRow + 0.14)
            if (_clearsOpenings(0, lift, v.width, 0.10)) beamY = baseLocalY + lift
          }
          const beamCovered = (v.cornice && (v.role === 'tower' || v.role === 'spire')) ||
            !_clearsOpenings(0, beamY - baseLocalY, v.width, 0.10)
          if (!beamCovered) {
            const beamProj = postT * 0.45
            for (const sz of [-1, 1]) {
              const beam = new THREE.BoxGeometry(v.width, 0.10, beamProj)
              localToWorld(beam, v.offsetX, beamY, v.offsetZ + sz * seatZ(beamProj),
                leanX, leanZ, rotationY, wx, wy, wz)
              ornamentBatch.addPositioned(beam, 0x3a2418)
              if (sz === 1) {
                recordPart(obj.id, obj.definitionId, _vk, 'headPlate',
                  0, beamY - baseLocalY, v.width, 0.10)
              }
            }
            // Return the plate along the side walls so the frame closes at the
            // corners instead of stopping dead — the gap read as two beams
            // stuck on a box rather than a frame wrapping a building.
            for (const sx of [-1, 1]) {
              const ret = new THREE.BoxGeometry(beamProj, 0.10, v.depth)
              localToWorld(ret, v.offsetX + sx * seatX(beamProj), beamY, v.offsetZ,
                leanX, leanZ, rotationY, wx, wy, wz)
              ornamentBatch.addPositioned(ret, 0x3a2418)
            }
          }

          // Mid-floor floor-line beams — the frame's floor-joist headers.
          const volFloors = volumeFloors(v)
          const floorH = v.height / Math.max(1, volFloors)
          if (volFloors >= 2) {
            const flBeamH = 0.08
            const flBeamProj = postT * 0.38
            // Beam heights come from the gaps BETWEEN opening rows, so a
            // floor line lands where the facade already has blank plaster.
            // Falls back to the old even division when a wall has no openings
            // at all, which is the case the grid was always right for.
            const _beamYs: number[] = []
            for (let r = 1; r < _rows.length; r++) {
              const mid = (_rows[r - 1][1] + _rows[r][0]) / 2
              if (_rows[r][0] - _rows[r - 1][1] > flBeamH + 0.12) _beamYs.push(mid)
            }
            if (!_beamYs.length) {
              for (let f = 1; f < volFloors; f++) {
                const y = f * floorH
                if (_clearsOpenings(0, y, v.width, flBeamH)) _beamYs.push(y)
              }
            }
            for (const _by of _beamYs) {
              const flBeamY = baseLocalY + _by
              for (const sz of [-1, 1]) {
                const fl = new THREE.BoxGeometry(v.width, flBeamH, flBeamProj)
                localToWorld(fl, v.offsetX, flBeamY, v.offsetZ + sz * seatZ(flBeamProj),
                  leanX, leanZ, rotationY, wx, wy, wz)
                ornamentBatch.addPositioned(fl, 0x3a2418)
                if (sz === 1) {
                  recordPart(obj.id, obj.definitionId, _vk, 'floorBeam',
                    0, flBeamY - baseLocalY, v.width, flBeamH)
                }
              }
            }
          }

          // Corner braces — the diagonal that makes a frame read as Tudor
          // rather than as a grid. One per end bay of the ground storey, angled
          // up and inward from the corner post.
          if (bays >= 2 && floorH > 1.2) {
            const braceT = studT * 0.9
            const braceRun = Math.min((v.width - postT) / bays, floorH * 0.8)
            const braceLen = Math.hypot(braceRun, braceRun)
            for (const sx of [-1, 1]) {
              // A 45-degree brace sweeps a big square of wall, and it was the
              // worst offender of the lot — 146 across windows and 86 across
              // doors a town, some covering an opening entirely. It is pure
              // decoration, so when it cannot clear the glass it simply does
              // not get nailed on.
              if (!_clearsOpenings(
                sx * (cornerX - braceRun / 2), floorH - braceRun / 2,
                braceRun + braceT, braceRun + braceT)) continue
              for (const sz of [-1, 1]) {
                const brace = new THREE.BoxGeometry(braceLen, braceT, braceT)
                // Rotate in the wall plane: 45 degrees, leaning toward the
                // centre of the wall so both ends read as one A-brace pair.
                brace.rotateZ(sx * Math.PI / 4)
                localToWorld(
                  brace,
                  v.offsetX + sx * (cornerX - braceRun / 2),
                  baseLocalY + floorH - braceRun / 2,
                  v.offsetZ + sz * seatZ(braceT),
                  leanX, leanZ, rotationY, wx, wy, wz)
                ornamentBatch.addPositioned(brace, 0x3a2418)
                if (sz === 1) {
                  // A 45-degree member's wall-local AABB is its run in both
                  // axes. Approximating a diagonal by its box over-reports a
                  // little and under-reports nothing, which is the right way
                  // round for an audit.
                  recordPart(obj.id, obj.definitionId, _vk, 'brace',
                    sx * (cornerX - braceRun / 2), floorH - braceRun / 2,
                    braceRun + braceT, braceRun + braceT)
                }
              }
            }
          }
        } else {
          // Quoins
          const wallR = (v.wallColor >> 16) & 0xff
          const lighten = wallR < 180
          const quoinColor = lighten ? 0xc8b89a : 0x6a5a48
          const corners: Array<[number, number]> = [
            [v.offsetX + halfW, v.offsetZ + halfD],
            [v.offsetX + halfW, v.offsetZ - halfD],
            [v.offsetX - halfW, v.offsetZ + halfD],
            [v.offsetX - halfW, v.offsetZ - halfD],
          ]
          // Quoins were the single largest consumer of batched geometry:
          // 4 corners x up to 7 courses on every eligible volume came to
          // ~2,400 boxes and ~87k verts, a quarter of ALL building geometry.
          // Five courses read identically — the alternating in/out rhythm is
          // what sells a quoined corner, not the exact course count.
          const stackCount = Math.min(5, Math.max(3, Math.floor(v.height / 0.7)))
          const stackPitch = (v.height * 0.86) / stackCount
          for (const [cornerX, cornerZ] of corners) {
            const xSign = Math.sign(cornerX - v.offsetX) || 1
            const zSign = Math.sign(cornerZ - v.offsetZ) || 1
            for (let s = 0; s < stackCount; s++) {
              const centerLy = baseLocalY + 0.05 + s * stackPitch + quoinH / 2
              const onX = s % 2 === 0
              const q = onX
                ? new THREE.BoxGeometry(quoinW + quoinProj, quoinH, quoinW)
                : new THREE.BoxGeometry(quoinW, quoinH, quoinW + quoinProj)
              const lx = onX ? cornerX + xSign * quoinProj / 2 : cornerX
              const lz = onX ? cornerZ : cornerZ + zSign * quoinProj / 2
              localToWorld(q, lx, centerLy, lz, leanX, leanZ, rotationY, wx, wy, wz)
              ornamentBatch.addPositioned(q, quoinColor)
            }
          }
        }
      }
    }

    // === DRAINPIPE → batched ===
    // Thin vertical cylinder running from near the eave down to the ground
    // at one corner of the mainBody. Major "lived-in" cue at distance —
    // every old town has these dark iron/copper streaks against pale walls.
    // Skip on landmarks (cathedrals, towers) and on timber-post buildings
    // (the post would clash with the pipe).
    const wantsDrainpipe = !isLandmark && !wantsTimberPosts &&
      !mainVol.circular && !NO_JITTER.has(obj.definitionId) &&
      mainVol.height > 1.8 && rand01(hash, 901) < 0.32
    if (wantsDrainpipe) {
      tallyIn('drainpipe', district)
      const pipeR = 0.04
      const baseLocalY = mainVol.bottomY
      // Run from ~12cm below cornice to the ground.
      const pipeTop = baseLocalY + mainVol.height - 0.12
      const pipeBottom = 0  // building base
      const pipeH = pipeTop - pipeBottom
      if (pipeH > 1.0) {
        // Pick one corner — biased toward the BACK (-Z). This used to be 65%
        // FRONT, with the reasoning "that's where the player most often sees
        // the building", which is the assumption this whole arc is about: a
        // player in a walkaround sees every side, and putting the detail
        // where they are assumed to be looking is what leaves the other three
        // walls bare. A downpipe also belongs at the back on the merits —
        // rainwater goes to the yard, not over the front step.
        //
        // Unlike ivy (4% of buildings, below what allsides.mjs can resolve at
        // n=30) this fires on 21%, so the move is actually gradeable.
        const xSide = rand01(hash, 903) < 0.5 ? -1 : 1
        const zSide = rand01(hash, 905) < 0.72 ? -1 : 1   // 72% back
        const cornerX = mainVol.offsetX + xSide * (mainVol.width / 2 + pipeR * 0.6)
        const cornerZ = mainVol.offsetZ + zSide * (mainVol.depth / 2 + pipeR * 0.6)
        const pipe = new THREE.CylinderGeometry(pipeR, pipeR, pipeH, 6)
        pipe.translate(0, pipeH / 2, 0)
        localToWorld(pipe, cornerX, pipeBottom, cornerZ,
          leanX, leanZ, rotationY, wx, wy, wz)
        // Verdigris copper or dark iron — pick from style.
        const pipeColor = styleVector.wealth > 0.5 ? 0x4a6a5a : 0x2a241e
        detailBatch.addPositioned(pipe, pipeColor)
        // Small horizontal collar near the top — implies a gutter elbow.
        const collar = new THREE.BoxGeometry(pipeR * 3.2, 0.06, pipeR * 1.5)
        // Project the collar slightly toward the wall edge (against zSide).
        localToWorld(collar, cornerX - xSide * pipeR * 0.6, pipeTop - 0.04, cornerZ - zSide * pipeR * 0.4,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(collar, pipeColor)
      }
    }

    // ========================================================================
    // === THE BACK OF THE BUILDING ===========================================
    // ========================================================================
    //
    // CITYPLAN item 7. Everything above this line attaches to `frontWallZ`;
    // what follows attaches to `backWallZ` and `sideWallX`, and it is the
    // only dressing in this file that does.
    //
    // The rule these all obey, and the reason they are safe: each clamps its
    // projection to `backRoom` / `sideRoom`, the gap between the massing
    // volume and the building's own reserved footprint. A rear feature can
    // therefore never reach into a neighbour, whatever the wealth scale did
    // to the volume — which is the invariant tools/audit.mjs enforces and the
    // failure mode tools/overhang.mjs exists to count.
    //
    // These are deliberately SILHOUETTE features rather than surface ones.
    // The facade texture now finishes all four walls; what a back still
    // lacked was depth — something that breaks the outline when you walk
    // round the corner. A theme park's backstage is hidden completely; a
    // walkaround has no backstage, so the back has to be built.

    // --- REAR OUTSHOT (lean-to) → batched ---
    // The single-storey scullery / washhouse / privy tacked onto the back of
    // almost every pre-modern town house. A low mono-pitch box against the
    // rear wall: it breaks the silhouette, casts a shadow onto the yard, and
    // instantly reads as a building that has been LIVED IN rather than
    // placed. Needs enough room behind the wall to be a room at all.
    // The 0.18 is eave clearance, not slack: the mono-pitch slab below is
    // longer than the box it covers (a slope is longer than its run) and
    // overhangs the back face by ~13cm. Sizing the BODY to the footprint and
    // forgetting the ROOF is precisely how MAX_OVERHANG got written.
    //
    // OUTSHOT_REACH is the one place a rear feature is allowed past the
    // footprint, and it is deliberate. Clamping strictly to `backRoom`
    // starved the feature: the gate counters below reported noRoomBehind on
    // 55% of eligible buildings, because the inset between volume and
    // footprint is a few tens of centimetres, not a yard. But a scullery does
    // not stand on the building's footprint — it stands in the BACK YARD,
    // which `softenBackOfBlock` has already unpaved into garden. Projecting
    // there is correct; it just has to be bounded. 0.45 sits under the
    // MAX_OVERHANG = 0.6 budget the massing templates already spend, so this
    // introduces no reach the project had not already sanctioned, and both
    // tools/audit.mjs and tools/overhang.mjs grade the result.
    const OUTSHOT_REACH = 0.45
    const outshotDepth = Math.min(1.35, backRoom + OUTSHOT_REACH - 0.18)
    const outshotEligible = !isLandmark && !mainVol.circular &&
      !NO_JITTER.has(obj.definitionId) &&
      (district === 'residential' || district === 'artisan' || district === 'market' ||
       district === 'garden' || district === 'docks')
    const wantsOutshot = outshotEligible &&
      mainWallH > 3.4 && mainVol.width >= 2.4 && outshotDepth >= 0.7 &&
      rand01(hash, 1401) < 0.42
    // WHY a gate did not fire, not just how often it did. The census reported
    // this feature at 6% of buildings, which is below what allsides.mjs can
    // resolve — but a rate alone cannot say whether that is the dice, the
    // district, or the geometry, and guessing at it is what CLAUDE.md means by
    // "make the tool explain itself". These counters cost nothing and turn one
    // census run into the answer.
    if (outshotEligible) {
      if (mainWallH <= 3.4) tallyIn('rearOutshot~tooShort', district)
      else if (mainVol.width < 2.4) tallyIn('rearOutshot~tooNarrow', district)
      else if (outshotDepth < 0.7) tallyIn('rearOutshot~noRoomBehind', district)
      else if (!wantsOutshot) tallyIn('rearOutshot~lostTheDice', district)
    } else {
      tallyIn('rearOutshot~wrongKind', district)
    }
    if (wantsOutshot) {
      tallyIn('rearOutshot', district)
      // Narrower than the wall it leans on, and offset to one side — a full
      // width outshot reads as the building being deeper, not as an addition.
      const outW = mainVol.width * (0.42 + rand01(hash, 1403) * 0.26)
      const outX = mainVol.offsetX + (rand01(hash, 1405) - 0.5) * (mainVol.width - outW)
      const outH = 1.9 + rand01(hash, 1407) * 0.5     // one low storey
      const outZ = backWallZ - outshotDepth / 2
      const outColor = shiftColor(palette.wall, -0.05, -0.04, -0.03)
      const body = new THREE.BoxGeometry(outW, outH, outshotDepth)
      localToWorld(body, outX, outH / 2, outZ, leanX, leanZ, rotationY, wx, wy, wz)
      detailBatch.addPositioned(body, outColor)
      // Mono-pitch roof: a thin slab tilted so it sheds AWAY from the house.
      // Rotating about X tips the far edge down, which is the correct way for
      // water to run off into the yard rather than against the main wall.
      const slabT = 0.09
      const rise = outshotDepth * 0.30
      const slopeLen = Math.sqrt(outshotDepth * outshotDepth + rise * rise)
      const slab = new THREE.BoxGeometry(outW + 0.14, slabT, slopeLen + 0.10)
      slab.rotateX(-Math.atan2(rise, outshotDepth))
      localToWorld(slab, outX, outH + rise / 2 + slabT / 2, outZ,
        leanX, leanZ, rotationY, wx, wy, wz)
      roofBatch.addPositioned(slab, palette.roof)
      // A small high window on the outshot's own end wall, so the addition
      // is not itself a blank box — the same mistake one level down.
      if (outW > 1.5) {
        const oWin = new THREE.BoxGeometry(0.52, 0.44, 0.05)
        localToWorld(oWin, outX, outH * 0.62, outZ - outshotDepth / 2 - 0.02,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(oWin, 0x3c4450)
      }
    }

    /**
     * === THE BEACON — a lit top on the things you navigate by ===
     *
     * The Imagineering WEENIE is a visual magnet that terminates a vista and
     * pulls you toward it, and `vistas.mjs` says 29% of long views end on a
     * landmark — but every one of those landmarks is DARK ABOVE THE WINDOW
     * LINE at dusk, which is the hour DESIGN.md is written against. A magnet
     * you cannot see from the far end of the street is not a magnet.
     *
     * KEYED BY REASON, NOT BY HEIGHT. "Tall things glow" is a fairground, and
     * it is the WALLPAPER failure this repo keeps catching — a rate identical
     * everywhere reads as healthy and tells the player nothing. Each of these
     * carries a light because of what it IS: a lighthouse is a lantern room, a
     * clock face is lit so it can be read, a belfry is lit for the ringers,
     * and a town gate is lit because that is where you are challenged. A
     * generic tower has no such reason and stays dark.
     *
     * Same argument as `LANTERN_BY_TYPE`, one scale up.
     */
    const BEACON_BY_TYPE: Record<string, number> = {
      lighthouse: 1.30, clock_tower: 0.95, bell_tower_tall: 0.85,
      bell_tower: 0.85, town_gate: 0.70, gatehouse: 0.70,
    }
    const beaconSize = BEACON_BY_TYPE[obj.definitionId]
    if (beaconSize !== undefined && towerVol && towerTopY > 3) {
      /**
       * A LANTERN CROWN, NOT A LAMP STUCK ON A BOX.
       *
       * The first cut put a glowing cube on each face of the shaft and it was
       * correctly called out: a light pasted onto a rectangular prism is a
       * lamp, and a weenie is an ATTRACTION. What makes one work is not
       * brightness, it is SILHOUETTE — Cinderella Castle and a Gion belfry are
       * both recognisable as a black shape against a sky, before any light is
       * involved. A cube on a wall does not change the tower's outline at all,
       * so from the far end of a street there is nothing new to see.
       *
       * What a belfry actually IS, and every part here earns its place:
       *
       *   GALLERY    a corbelled ring projecting past the shaft, which breaks
       *              the vertical line — this is the part that changes the
       *              silhouette and it is why the shape reads at 100ft.
       *   PIERS      four corner posts with OPEN AIR between them. The arcade
       *              is the point: masonry framing a void.
       *   CORE       the glow, INSIDE, seen between the piers. Contained light
       *              reads as a lantern room; the same light unhoused reads as
       *              a bright rectangle, which is what it was.
       *   CAP        a small pyramid closing the top, so the crown is a
       *              finished object rather than an open box against the sky —
       *              the open-topped-volume defect this repo already fixed 22
       *              of.
       *
       * All masonry, all untextured, no new drawing code — the same argument
       * that gave the curtain wall its plinth and string course. Relief is
       * what makes a big plain surface read, and it casts its own shadow.
       */
      const shaftW = towerVol.width, shaftD = towerVol.depth
      const ox0 = towerVol.offsetX ?? 0, oz0 = towerVol.offsetZ ?? 0
      const stone = shiftColor(palette.wall, -0.05, -0.04, -0.03)
      // Weathered bell bronze. Warm and mid-toned at noon, and at dusk it
      // falls to a dark shape against the sky, which is the read this whole
      // feature is built for.
      const bronze = 0x8f7340
      const push = (g: THREE.BufferGeometry, lx: number, ly: number,
        lz: number, col: number): void => {
        localToWorld(g, lx, ly, lz, leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(g, col)
      }
      /**
       * A LIT GALLERY — and the shape has to do the work, not the light.
       *
       * Two cuts before this one failed for the same reason in opposite ways.
       * The first stuck a glowing cube on the shaft face: a lamp on a
       * rectangular prism, which does not change the tower's OUTLINE, so from
       * the far end of a street there is nothing new to see. The second built
       * an arcade of piers with the glow inside — and a belfry's arcade is a
       * VOID, while this shaft is a solid massing volume, so the piers sat on
       * a wall that was still there and the light was buried in masonry.
       * Photographed, the tower looked untouched both times.
       *
       * What works against a solid shaft is a BALCONY. Every part earns its
       * place and two of them are silhouette rather than light:
       *
       *   GALLERY     projects 0.55m on a 0.30m slab — far enough to cast a
       *               shadow across the shaft and to break the vertical line.
       *               This is the part you recognise at 100ft.
       *   BALUSTRADE  posts around the gallery edge with gaps between them,
       *               which is an OPEN parapet read against the sky. A solid
       *               ring would just be a thicker tower.
       *   LAMPS       standing ON the gallery, outside the wall, so they are
       *               visible from any bearing — and now FRAMED by the posts
       *               and the slab instead of pasted on a flat face.
       *   CORBELS     under the slab, because a balcony that projects 0.55m
       *               with nothing holding it up reads as a floating shelf.
       *
       * All masonry, all untextured, one extra emissive volume per face. Same
       * argument that gave the curtain wall its plinth: relief is what makes a
       * big plain surface read, because it casts its own shadow.
       */
      /**
       * A BELFRY'S CROWN STOREY HAS TO BE TALL ENOUGH TO HANG A BELL IN.
       *
       * The shared crown is `beaconSize * 1.9` — 1.6m, of which the gallery
       * slab takes 0.38, leaving 1.2m of open air. A great bell is over a
       * metre from canon to mouth, so on the shared figure there was
       * physically nowhere to put one and the belfry would have got a token.
       * The stage is a fraction of the SHAFT for these two types, capped so a
       * tall campanile does not end up all crown.
       */
      const isBelfry = obj.definitionId === 'bell_tower' ||
        obj.definitionId === 'bell_tower_tall'
      const shaftH = towerTopY - towerVol.bottomY
      const crownH = isBelfry
        ? Math.max(1.5, Math.min(3.1, shaftH * 0.32))
        : Math.max(1.5, beaconSize * 1.9)
      const galY = towerTopY - crownH
      // BIG ENOUGH TO BE A SILHOUETTE. The first gallery projected 0.5m on a
      // 4m shaft — 12%, which photographed as a dark line and nothing more.
      // A belfry gallery on a tower this size projects a metre or more, and
      // the whole argument for building one is that you recognise it from
      // the far end of a street.
      // A BELFRY'S GALLERY IS WIDER, AND THE BELL IS WHY. The shelf's
      // projection is the only thing bounding how big a bell can hang on it,
      // and at 0.95m the biggest bell that fits is 0.84m across — which, hung
      // in a stage tall enough to swing in, comes out half again taller than
      // it is wide. That reads as a CONE however the profile is drawn, and no
      // amount of shaping fixes a proportion. A real bell is about as wide as
      // it is tall, so the shelf has to give it the width.
      const galOut = isBelfry
        ? Math.max(1.30, beaconSize * 1.5)
        : Math.max(0.95, beaconSize * 1.05)
      const galT = 0.38
      push(new THREE.BoxGeometry(shaftW + galOut * 2, galT, shaftD + galOut * 2),
        ox0, galY + galT / 2, oz0, stone)
      // CORBELS — under the slab, one per face plus the corners.
      const corbT = 0.22
      for (const [cx, cz] of [
        [shaftW / 2 + galOut * 0.5, 0], [-(shaftW / 2 + galOut * 0.5), 0],
        [0, shaftD / 2 + galOut * 0.5], [0, -(shaftD / 2 + galOut * 0.5)],
      ] as const) {
        push(new THREE.BoxGeometry(cx === 0 ? corbT * 3 : galOut, 0.34,
          cz === 0 ? corbT * 3 : galOut),
        ox0 + cx, galY - 0.17, oz0 + cz, stone)
      }
      /**
       * A LIGHTHOUSE IS ITS LIGHT — so it gets a LANTERN ROOM, not a balcony.
       *
       * Every beacon type shared one crown, which meant the one building in
       * the town whose entire identity is a light looked like a gate lodge
       * with a lamp on it. A lighthouse's lantern room is a GLAZED DRUM: a
       * ring of glass held by thin astragals, ringed top and bottom, with the
       * source inside — you read a bright cylinder in a dark cage, at the top
       * of a tower, from across the water. That silhouette is the whole
       * building, and no amount of lamps on a parapet substitutes for it.
       *
       * It fills the crown storey the balustrade would otherwise occupy, so
       * it sits under the shaft's existing roof rather than stacking a second
       * one — the mistake the first crown made with its cone.
       */
      const isLantern = obj.definitionId === 'lighthouse'
      if (isLantern) {
        // WIDER THAN THE SHAFT, because that is what a lantern room IS — it
        // stands ON the gallery, oversailing the tower below it, which is why
        // a lighthouse has that top-heavy silhouette.
        //
        // The first cut used `min(shaftW, shaftD) * 0.46`, which is INSIDE the
        // tower's own half-width, so the drum was buried in solid masonry and
        // photographed as a dark octagon. That is the third time this session
        // a light has been put inside the thing it was meant to sit on — the
        // beacon cube, the arcade piers, and now this. THE TEST IS ALWAYS THE
        // SAME: is the emitter outside every solid the building already has?
        const drumR = Math.min(shaftW, shaftD) / 2 + galOut * 0.45
        const drumH = Math.max(1.2, towerTopY - galY - galT - 0.25)
        const drumY = galY + galT + drumH / 2
        // The glass: an octagon, because a drum of four faces is a box and a
        // drum of thirty-two is a sphere at this scale.
        const glass = new THREE.CylinderGeometry(drumR, drumR, drumH, 8)
        localToWorld(glass, ox0, drumY, oz0, leanX, leanZ, rotationY, wx, wy, wz)
        // RECORD THE DRUM, WITH ITS EXTENT. The first cut recorded a point on
        // the gallery's outer edge, so `featureshot` framed a 3.2m box at the
        // parapet and the lantern room — the entire subject — was above the
        // crop. A site is only useful if it is ON the thing and big enough to
        // contain it, which is why prop sites carry w/h/d.
        glass.computeBoundingBox()
        const gbb = glass.boundingBox
        if (gbb) {
          siteOf('lanternRoom', (gbb.min.x + gbb.max.x) / 2,
            (gbb.min.y + gbb.max.y) / 2, (gbb.min.z + gbb.max.z) / 2,
            gbb.max.x - gbb.min.x, gbb.max.y - gbb.min.y, gbb.max.z - gbb.min.z)
        }
        addBeacon(glass)
        // ASTRAGALS — the thin bars that make it read as GLAZED rather than
        // as a glowing barrel. Eight, on the octagon's own corners.
        for (let a = 0; a < 8; a++) {
          const th = (a / 8) * Math.PI * 2
          const bar = new THREE.BoxGeometry(0.10, drumH, 0.10)
          push(bar, ox0 + Math.cos(th) * drumR, drumY, oz0 + Math.sin(th) * drumR, stone)
        }
        // Rings top and bottom, which is what holds glass in a frame.
        for (const ry of [galY + galT + 0.06, galY + galT + drumH - 0.06]) {
          const ring = new THREE.CylinderGeometry(drumR + 0.10, drumR + 0.10, 0.13, 8)
          push(ring, ox0, ry, oz0, stone)
        }
      }
      /**
       * === THE BELLS — and WHY THEY HANG WHERE THEY DO ===
       *
       * A bell tower is named after a thing nobody could see. The crown got a
       * gallery and four lamps like every other beacon type, which is a lit
       * balcony: correct, and it says nothing about what the building IS.
       *
       * THE HARD CONSTRAINT IS THAT THE SHAFT IS SOLID. A real belfry hangs
       * its bell in the middle of an open stage and you read it through arched
       * openings on all four faces — but the centre of this stage is a massing
       * volume, and this session has already put a light inside its own host
       * three times (the beacon cube, the arcade piers, the lantern drum). So
       * the bell cannot go where a bell goes.
       *
       * WHAT DECIDES IT IS THE SILHOUETTE, and that is pure plan arithmetic.
       * At every height below `towerTopY` the shaft is behind everything, so
       * the only place with SKY behind it is beyond the shaft's outline IN
       * PLAN. Looking along -Z at the +Z face, screen-x is world-x: the bells
       * on the +X and -X faces sit at |x| = shaftW/2 + 0.5, which projects
       * half a metre past each edge of the tower. So from any cardinal street
       * view two of the four bells hang against open sky and the other two
       * hang in front of masonry — which is exactly what a campanile looks
       * like, and it is the same reason the gallery lamps read while a lamp
       * flush on the wall did not.
       *
       * The rest is what makes it a bell stage rather than four bells stuck
       * on a shelf:
       *
       *   PIERS      four, at the gallery corners, OUTSIDE the shaft. The void
       *              between pier and shaft is genuine open air.
       *   CORNICE    a slab closing the top, oversailing — so the tower gains
       *              a capital and does not end in an open box against the sky.
       *   HEADSTOCK  the beam each bell hangs from, spanning between its two
       *              piers. A bell floating with nothing above it is a balloon.
       *
       * All of it sits inside the gallery's own footprint, so it claims no
       * extent the balcony had not already claimed.
       */
      const belfry = isBelfry && crownH >= 2.5
      if (isBelfry && !belfry) tallyIn('bell~stageTooShort', district)
      const cornT = 0.30
      const cornY = towerTopY - cornT
      const pierT = 0.34
      if (belfry) {
        const sy = galY + galT
        const voidH = cornY - sy
        const px = shaftW / 2 + galOut - pierT / 2 - 0.05
        const pz = shaftD / 2 + galOut - pierT / 2 - 0.05
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            push(new THREE.BoxGeometry(pierT, voidH, pierT),
              ox0 + sx * px, sy + voidH / 2, oz0 + sz * pz, stone)
          }
        }
        push(new THREE.BoxGeometry(shaftW + galOut * 2, cornT, shaftD + galOut * 2),
          ox0, cornY + cornT / 2, oz0, stone)
        // A BELL IS A FLARED SHELL, NOT A CONE. Waist, shoulder and canon:
        // three pieces, because a single taper reads as a hat.
        //
        // The radius and the offset are one decision. `bellR` at 0.44 of the
        // gallery's projection, hung at half of it, leaves the mouth 6cm clear
        // of the shaft wall on the inside and 6cm inside the balcony edge on
        // the outside — a bell that grazes either is back to being buried.
        // HEIGHT DERIVED FROM WIDTH, not from the space available. A bell's
        // proportion is a fact about bells (roughly as tall as its mouth is
        // wide); the void only gets to say whether one fits at all.
        const bellR = Math.min(0.60, galOut * 0.44)
        const bellH = Math.min(bellR * 1.62, voidH - 0.80)
        const beamY = cornY - 0.14
        let bellLogged = false
        for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const bxs = nx * (shaftW / 2 + galOut * 0.54)
          const bzs = nz * (shaftD / 2 + galOut * 0.54)
          // THE FOUR HEADSTOCKS CROSS AT THE CORNERS, so they are staggered in
          // height rather than shortened. Two beams meeting in the same plane
          // is a depth-buffer tie — the "flickering overlapping textures"
          // defect — and shortening them would leave each one floating short
          // of the pier it is supposed to be seated on. Staggering is also
          // what a real bell frame does: a ring is hung at two levels.
          const bY = beamY - (nx ? 0 : 0.22)
          const beamLen = (nx ? pz : px) * 2
          push(new THREE.BoxGeometry(nx ? 0.20 : beamLen, 0.20, nz ? 0.20 : beamLen),
            ox0 + bxs, bY, oz0 + bzs, stone)
          /**
           * A DOWNLIGHT OVER EACH BELL, tucked under the cornice.
           *
           * The stage reads as a shape from the street and reads as a DARK
           * shape, which is half of what a weenie needs — pillar 1 wants the
           * silhouette and pillar 5 wants somewhere for the warm light to
           * come from. The corner lamps light the parapet and leave the bells
           * unlit, and there is nowhere behind a bell to put a source: the
           * shaft wall is 8cm from its inner lip.
           *
           * Above it, there is room. A strip under the cornice throws the
           * light DOWN past the bell, which is both what a floodlit campanile
           * looks like and the one arrangement that makes a bronze shell
           * read as a bell rather than as a hole in the frame.
           *
           * Deliberately narrow. `addBeacon` is additive and unlit, so area
           * is brightness: a band the full depth of the shelf is fifteen
           * square metres of light per tower, which is the uniform pale wash
           * the lamp-pool comment already records as the worst of both
           * pillars.
           */
          // OVER THE BELL, NOT ACROSS THE FACE. At 0.72 of the headstock it is
          // three and a half metres of unbroken glow, which photographed as a
          // strip light — and once the lit arch behind the bell existed it was
          // also doing the same job twice. Keyed to the bell it lights.
          const litLen = bellR * 2.4
          const strip = new THREE.BoxGeometry(
            nx ? 0.20 : litLen, 0.09, nz ? 0.20 : litLen)
          localToWorld(strip, ox0 + bxs, cornY - 0.06, oz0 + bzs,
            leanX, leanZ, rotationY, wx, wy, wz)
          addBeacon(strip)
          const mouthY = bY - 0.26 - bellH
          /**
           * A LIT ARCH BEHIND THE BELL — and nothing else could have worked.
           *
           * `addBeacon` geometry is additive and unlit: it does not
           * illuminate anything, it only glows. So a lamp beside a bell can
           * never make the bell visible — a bronze shell in shadow stays a
           * dark blob whatever is next to it, which is exactly what the first
           * street photograph showed. The only way a dark object reads is
           * AGAINST something brighter, which means the light has to be
           * BEHIND it.
           *
           * There is one surface behind a bell and it is the shaft wall,
           * 13cm away. That is enough for a 6cm panel — and it is also the
           * architecturally true answer, because what you see through a
           * belfry opening at night IS the lit chamber behind the bell.
           *
           * ROUND-HEADED, because a bare glowing rectangle on a wall is the
           * failure this file already records ("contained light reads as a
           * lantern room; the same light unhoused reads as a bright
           * rectangle"). A box plus a disc at the springing is an arch for
           * two primitives and no new drawing code.
           */
          const archW = bellR * 1.9
          const archH = bellH * 0.80
          const panel = new THREE.BoxGeometry(
            nx ? 0.06 : archW, archH, nz ? 0.06 : archW)
          localToWorld(panel, ox0 + nx * (shaftW / 2 + 0.05), mouthY + archH / 2,
            oz0 + nz * (shaftD / 2 + 0.05), leanX, leanZ, rotationY, wx, wy, wz)
          addBeacon(panel)
          const head = new THREE.CylinderGeometry(archW / 2, archW / 2, 0.06, 12)
          if (nx) head.rotateZ(Math.PI / 2)
          else head.rotateX(Math.PI / 2)
          localToWorld(head, ox0 + nx * (shaftW / 2 + 0.05), mouthY + archH,
            oz0 + nz * (shaftD / 2 + 0.05), leanX, leanZ, rotationY, wx, wy, wz)
          addBeacon(head)
          // THE PROFILE IS THE WHOLE RECOGNITION, and the first cut got it
          // wrong in the way that is easiest to miss: a single taper from
          // shoulder to mouth is geometrically a bell-ish shape and reads as a
          // CONE — a lampshade on a stick. What names a bell at a distance is
          // the SOUNDBOW, the near-vertical thickened band at the mouth, and
          // then a waist that pulls in slowly before the shoulder pulls in
          // fast. Four stacked frusta, bottom to top, and only the first two
          // matter for the silhouette.
          for (const [r0, r1, y0, y1] of [
            [1.00, 0.95, 0.00, 0.14],   // soundbow — almost straight
            [0.95, 0.70, 0.14, 0.48],   // waist
            [0.70, 0.46, 0.48, 0.80],   // shoulder
            [0.46, 0.26, 0.80, 1.00],   // crown
          ] as const) {
            push(new THREE.CylinderGeometry(bellR * r1, bellR * r0,
              bellH * (y1 - y0), 14),
            ox0 + bxs, mouthY + bellH * (y0 + y1) / 2, oz0 + bzs, bronze)
          }
          // The canon — the strap that carries the bell on its headstock.
          push(new THREE.BoxGeometry(nx ? 0.09 : 0.22, 0.30, nz ? 0.09 : 0.22),
            ox0 + bxs, bY - 0.13, oz0 + bzs, bronze)
          if (!bellLogged) {
            // WITH ITS EXTENT, through the transform. A bare point on a tower
            // had `featureshot` framing a 3.2m box at the parapet with the
            // subject above the crop — see the lantern room.
            const bm = new THREE.BoxGeometry(bellR * 2, bellH, bellR * 2)
            localToWorld(bm, ox0 + bxs, mouthY + bellH * 0.5, oz0 + bzs,
              leanX, leanZ, rotationY, wx, wy, wz)
            bm.computeBoundingBox()
            const bb = bm.boundingBox
            if (bb) {
              siteOf('bell', (bb.min.x + bb.max.x) / 2,
                (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2,
                bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z)
            }
            bm.dispose()
            bellLogged = true
          }
        }
        tallyIn('bell', district)
      }
      // BALUSTRADE — posts with GAPS, so the parapet reads as open sky.
      // A lighthouse has its lantern room here instead; a rail around the
      // glass would only hide it, and a belfry drops to the same low rail so
      // the posts do not stand in front of the bells.
      const postH = isLantern || belfry ? 0.34 : Math.max(0.78, beaconSize * 0.85)
      const postT = 0.24
      const bx = shaftW / 2 + galOut - postT / 2, bz = shaftD / 2 + galOut - postT / 2
      // A BELFRY SKIPS THE CORNER AND MID-FACE POSTS, because the corners are
      // where its piers stand and the mid-face is where its bells hang. Two
      // solids in one place is a depth-buffer tie, which this repo has already
      // chased once as "flickering overlapping textures".
      for (const i of belfry ? [-1, 1] : [-2, -1, 0, 1, 2]) {
        const fx = (i / 2) * bx, fz = (i / 2) * bz
        for (const s2 of [-1, 1]) {
          push(new THREE.BoxGeometry(postT, postH, postT),
            ox0 + fx, galY + galT + postH / 2, oz0 + s2 * bz, stone)
          push(new THREE.BoxGeometry(postT, postH, postT),
            ox0 + s2 * bx, galY + galT + postH / 2, oz0 + fz, stone)
        }
      }
      // LAMPS — on the gallery, clear of the shaft wall, one per face. The
      // lighthouse has its drum instead and does not want four more sources
      // competing with it.
      // ITS OWN SITE KEY, recorded above from the drum. `featureSites` caps at
      // 12 per feature and a town has more gates than lighthouses, so the one
      // lantern room was crowded out of `beacon` by twelve gate lamps and
      // `featureshot` reported no site on a town that has one. A cap is a
      // sampling rule and a rare member of a common bucket loses every time.
      let beaconLogged = isLantern
      const lampH = Math.max(0.72, beaconSize * 0.85)
      const lampY = galY + galT + lampH / 2
      const lx0 = shaftW / 2 + galOut * 0.52, lz0 = shaftD / 2 + galOut * 0.52
      // A BELFRY MOVES ITS LAMPS TO THE CORNERS, because the mid-face is now
      // occupied by a bell and the two would interpenetrate. The corner is
      // also the better place for them: on the diagonal, all four are visible
      // from every bearing at once, and they light the stage the bells hang in
      // rather than standing beside it.
      const kx0 = shaftW / 2 + galOut * 0.32, kz0 = shaftD / 2 + galOut * 0.32
      const lampSpots: ReadonlyArray<readonly [number, number]> = isLantern
        ? []
        : belfry
          ? [[kx0, kz0], [kx0, -kz0], [-kx0, kz0], [-kx0, -kz0]]
          : [[lx0, 0], [-lx0, 0], [0, lz0], [0, -lz0]]
      for (const [mx, mz] of lampSpots) {
        const lamp = new THREE.BoxGeometry(
          mx === 0 ? lampH * 1.15 : lampH * 0.6, lampH,
          mz === 0 ? lampH * 1.15 : lampH * 0.6)
        localToWorld(lamp, ox0 + mx, lampY, oz0 + mz,
          leanX, leanZ, rotationY, wx, wy, wz)
        addBeacon(lamp)
        if (!beaconLogged) {
          lamp.computeBoundingBox()
          const cb = lamp.boundingBox
          if (cb) {
            // A lamp's own transformed box — on the OUTSIDE of the gallery, so
            // a camera can actually reach it. Aiming at the shaft centre had
            // featureshot photographing the inside of a roof.
            siteOf('beacon', (cb.min.x + cb.max.x) / 2,
              (cb.min.y + cb.max.y) / 2, (cb.min.z + cb.max.z) / 2)
            beaconLogged = true
          }
        }
      }
      tallyIn('beacon', district)

      /**
       * === THE GREAT CLOCK — a landmark, not a trim detail ===
       *
       * The gallery above is correct architecture and it barely changed the
       * skyline, which was the fair criticism of the whole approach: a metre
       * of moulding on a thirty-metre tower is a DETAIL, and a weenie is an
       * ATTRACTION. Traverse Town, Diagon Alley and Main Street all work the
       * same way — one object much bigger and much brighter than everything
       * around it, that you navigate by without being told to.
       *
       * So this is deliberately out of scale: a dial at 0.84 of the shaft's
       * width, which on a four-metre tower is a clock face over three metres
       * across — as big as a room, lit from behind, readable from the far side
       * of the town. That is the scale surprise the references are built on,
       * and it is what a clock tower IS: the one civic object everybody looks
       * at from a distance.
       *
       * Three parts, and only the dial is light. The RIM is what stops it
       * reading as a glowing sticker — a dark ring gives the disc an edge and
       * its own shadow, the same relief argument as the curtain wall. The
       * HANDS are what make it a clock rather than a porthole, and they are
       * set at a fixed hour per building from `stableHash` so a town's clocks
       * differ without ever animating.
       */
      if (obj.definitionId === 'clock_tower') {
        // A CLOCK FACE MUST FIT THE WALL IT IS ON — and the first cut did not.
        //
        // `dialR = min(shaftW, shaftD) * 0.42` plus a rim of `dialR * 0.22`
        // gives an OUTER diameter of 1.28 x the shaft, so on the narrow tower
        // this seed puts a clock on, the rim was wider than the tower carrying
        // it. Mounted on a side face and standing half a metre proud, it hung
        // in mid-air over the neighbouring roof — a disc floating beside the
        // building rather than a clock on it, which is what the photograph
        // showed and what a triangle count could never have said.
        //
        // Sized per FACE, because a face is not square: the wall you see when
        // looking along +X is `shaftD` wide, not `shaftW`. And bounded by the
        // available WALL HEIGHT too, since a dial that fits the width can
        // still run off the top into the gallery or down through the eaves.
        // Containment, with nothing to tune.
        const wallBase = towerVol.bottomY
        const availH = Math.max(0, galY - wallBase - 0.5)
        const outerFor = (faceW: number): number =>
          Math.min(faceW, availH) * 0.5 * 0.86
        // PROUD OF THE WALL, NOT FLUSH WITH IT. The first cut mounted the disc
        // at `shaftW/2 + rimT*0.5` and made it `rimT*0.9` thick — about 15cm
        // out and 14cm deep, which is a disc embedded in its own wall. The
        // triangle count proved 608 triangles of clock were being emitted and
        // no camera could find them, because a flush disc on a shaded wall
        // seen at any angle is the wall. The lamps on the gallery ARE visible
        // and they stand off by half a metre; this matches them.

        const dark = shiftColor(palette.wall, -0.32, -0.30, -0.26)
        // Two faces, not four: a clock tower reads along the street it faces,
        // and four dials on a 1x1 shaft is a lantern rather than a clock.
        let clockLogged = false, clockSiteY = galY
        for (const [nx, nz] of [[1, 0], [0, 1]] as const) {
          // The wall you look at along this normal, and the dial that fits it.
          const outerR = outerFor(nx ? shaftD : shaftW)
          const rimT = Math.max(0.16, outerR * 0.16)
          const dialR = outerR - rimT
          // Too small to read as a clock is not a clock. A face that cannot
          // carry one simply does not get one, rather than getting a smudge.
          if (dialR < 0.55) continue
          const dialY = wallBase + 0.5 + availH * 0.62
          const standOff = Math.max(0.18, rimT * 0.8)
          for (const sgn of [-1, 1]) {
            const mx = nx * sgn * (shaftW / 2 + standOff)
            const mz = nz * sgn * (shaftD / 2 + standOff)
            // A disc facing outward: a cylinder's axis is Y, so lay it down
            // about Z for an X-facing dial and about X for a Z-facing one.
            const rim = new THREE.CylinderGeometry(dialR + rimT, dialR + rimT, rimT, 16)
            const dial = new THREE.CylinderGeometry(dialR, dialR, rimT * 0.8, 16)
            for (const g of [rim, dial]) {
              if (nx) g.rotateZ(Math.PI / 2)
              else g.rotateX(Math.PI / 2)
            }
            push(rim, ox0 + mx, dialY, oz0 + mz, dark)
            const dialG = dial.clone()
            dial.dispose()
            if (!clockLogged) {
              clockSiteY = dialY
              clockLogged = true
            }
            localToWorld(dialG, ox0 + mx + nx * sgn * 0.06, dialY,
              oz0 + mz + nz * sgn * 0.06,
              leanX, leanZ, rotationY, wx, wy, wz)
            addBeacon(dialG)
            /**
             * HANDS — instanced, and they TELL THE TIME.
             *
             * They were `(hash % 12) / 12` — a fixed random hour per building
             * — under a comment saying "so a town's clocks disagree the way
             * real ones do, with nothing to tick". Disagreeing is right and
             * the amount was not: a real town clock is a few MINUTES out, not
             * seven hours, and `timeOfDay` is a labelled control that the sky,
             * the lighting, the lanterns, the stars, the moon, the mist and
             * the meteors all read. The one object whose whole job is to
             * display it did not.
             *
             * CLEAR OF THE DIAL'S OWN FACE. The dial is centred 0.06 proud and
             * is rimT*0.8 thick, so its outer surface is at 0.06 + rimT*0.4 —
             * hands at a flat 0.14 were inside the glass on any dial bigger
             * than a dinner plate, which is every one of them.
             */
            const handOut = 0.06 + rimT * 0.4 + 0.05
            const frame = localToWorldMatrix(
              ox0 + mx + nx * sgn * handOut, dialY, oz0 + mz + nz * sgn * handOut,
              leanX, leanZ, rotationY, wx, wy, wz)
            // A few minutes out, per building — the charming half of the
            // original intent, kept.
            const offsetMin = ((hash >> 7) % 9) - 4
            for (const [kind, len, thick] of [
              ['hour', dialR * 0.52, rimT * 0.5],
              ['minute', dialR * 0.82, rimT * 0.34],
            ] as const) {
              addClockHand({
                frame: frame.clone(),
                turnY: nx === 1,
                // SEEN FROM OUTSIDE a -Z or -X dial the viewer's right has
                // flipped, so the baked `-ang` ran those two faces of every
                // four ANTICLOCKWISE. Invisible while the hour was random.
                spin: sgn,
                len, thick, kind, offsetMin,
              })
            }
          }
        }
        // ONLY IF ONE WAS ACTUALLY BUILT. Every face can be too narrow, and a
        // census that counts the attempt rather than the emission is the
        // counter-before-the-work failure this file already records.
        if (clockLogged) {
        tallyIn('greatClock', district)
        // THROUGH THE TRANSFORM, NOT BY ADDING LOCAL TO WORLD. The first cut
        // wrote `wx + (ox0 + shaftW/2 + 1)`, which mixes a LOCAL offset into a
        // world position and skips the rotation entirely — so the camera was
        // aimed at a point the dial is not, and photographed a different
        // building. Every other placement in this file goes through
        // localToWorld for exactly this reason.
        const cm = new THREE.BoxGeometry(0.1, 0.1, 0.1)
        localToWorld(cm, ox0 + shaftW / 2 + 1.2, clockSiteY, oz0,
          leanX, leanZ, rotationY, wx, wy, wz)
        cm.computeBoundingBox()
        const cmb = cm.boundingBox
        if (cmb) {
          siteOf('greatClock', (cmb.min.x + cmb.max.x) / 2,
            (cmb.min.y + cmb.max.y) / 2, (cmb.min.z + cmb.max.z) / 2)
        }
        cm.dispose()
        }
      }
    }

    // --- FLANK BUTTRESSES → batched ---
    // A tall stone flank wants visible support, and a pair of buttresses is
    // the cheapest thing that turns a blank side elevation into a rhythm of
    // light and shadow — which is what a flank actually lacks. Stone and
    // temple/noble buildings only; a timber row house would not have them.
    // 0.22, NOT 0.34 — AND THE SIBLING ALREADY KNEW.
    //
    // The chimney breast forty lines below carries the whole argument in its
    // own comment: MIN_HABITABLE_W forces a volume to 2.6m inside a 1-tile
    // (3.0m) footprint, so an ordinary building has exactly 0.20m beside it.
    // A threshold of 0.34 is therefore ABOVE what a standard plot physically
    // leaves, and the counters say so with nothing left over — `noRoomBeside`
    // killed 52 of the 53 buildings that reached it, 98%, and the dice below
    // was never rolled once across three towns.
    //
    // The breast was moved to 0.14 for exactly this reason and the buttress,
    // in the same file, was not. A bug in a gate is a bug in a PATTERN and
    // this is the sibling that did not get swept.
    //
    // NOT dropped to 0.14 as well, because the two are deliberately different
    // populations — the breast exists "for the buildings the buttress pass
    // skips, so the two together cover most tall flanks rather than doubling
    // up on the same wealthy few". 0.22 keeps that division and clears the
    // 0.20m cliff: it yields at least a 0.16m projection, which is well above
    // the ~5cm that RENDER_SCALE 0.4 makes invisible at street distance.
    //
    // Safe by construction rather than by measurement: `sideRoom` is the gap
    // to the building's OWN footprint edge, so anything inside it cannot
    // reach a neighbour, which is the invariant audit.mjs enforces.
    /**
     * A BUTTRESS MAY STAND PROUD OF THE FOOTPRINT — that is what a buttress is.
     *
     * `sideRoom` is the gap to the building's OWN plot edge, and the census
     * said it is under 1cm on 51 of the 52 buildings that reach this gate.
     * Not tight — NONE. The clause that makes a building eligible is what
     * removes the room: a buttress is for temple, noble, fortress, landmark or
     * wealth > 0.72, and a wealthy building is scaled up until
     * `clipToFootprint` clamps it flush at its own edge. Two rules that each
     * sound sensible composing into a filter that admits nobody.
     *
     * So no threshold above zero could ever have helped, and lowering it
     * 0.34 -> 0.22 moved the count by exactly zero, which is what said so.
     *
     * The right quantity is the one the per-side overhang clip already
     * computes for every side: full MAX_OVERHANG where the adjacent tiles are
     * free, ZERO where a neighbour has reserved them. That machinery took
     * `deepClash` 124 -> 15, so projecting into it is safe by the same
     * construction rather than by a new guard — and a pier that stops at the
     * plot line is exactly the real-world rule.
     */
    const sideOut = (s: number): number => sideRoom(s) + (s < 0 ? allowNX : allowPX)
    const buttressSides: number[] = []
    for (const s of [-1, 1]) if (sideOut(s) >= 0.22) buttressSides.push(s)
    const wantsButtress = !mainVol.circular && buttressSides.length > 0 &&
      mainWallH > 5.2 && mainVol.depth >= 2.6 &&
      (district === 'temple' || district === 'noble' || district === 'fortress' ||
       isLandmark || styleVector.wealth > 0.72) &&
      rand01(hash, 1411) < 0.66
    // WHY A BUTTRESS DID NOT HAPPEN — six clauses and no way to tell which.
    //
    // The census reads ONE buttress across three towns, which is a ghost: a
    // pier and a weathered cap are finished geometry that essentially never
    // appears. A rate cannot say whether that is the district list, the
    // height, the depth, the side clearance or the dice, and the last two
    // times this repo guessed at a starved gate it spent two changes before
    // asking. `rearOutshot` gained exactly these counters and they closed it
    // in one run — noRoomBehind on 55% of eligible buildings.
    //
    // Ordered from the outside in, so each counter names the FIRST thing that
    // failed rather than every thing that did.
    if (mainVol.circular) tallyIn('buttress~circular', district)
    else if (!(district === 'temple' || district === 'noble' || district === 'fortress' ||
      isLandmark || styleVector.wealth > 0.72)) tallyIn('buttress~wrongKind', district)
    else if (mainWallH <= 5.2) tallyIn('buttress~tooShort', district)
    else if (mainVol.depth < 2.6) tallyIn('buttress~tooShallow', district)
    else if (buttressSides.length === 0) {
      tallyIn('buttress~noRoomBeside', district)
      // LEAVE THE HISTOGRAM IN — the threshold is the only number in this
      // gate that cannot be derived, so the distribution it cuts has to stay
      // visible or the next person tunes it blind. Lowering the gate 0.34 ->
      // 0.22 moved the count by ZERO, which says the room is not merely tight,
      // and a count cannot tell "just under the line" from "there is none".
      const room = Math.max(sideOut(-1), sideOut(1))
      tallyIn(room < 0.01 ? 'buttress~roomNone'
        : room < 0.10 ? 'buttress~roomUnder10'
        : room < 0.20 ? 'buttress~roomUnder20'
        : 'buttress~roomUnder22', district)
    }
    else if (!wantsButtress) tallyIn('buttress~lostTheDice', district)
    if (wantsButtress) {
      tallyIn('buttress', district)
      siteOf('buttress', wx, wy + mainWallH * 0.5, wz)
      const bColor = shiftColor(palette.wall, -0.08, -0.07, -0.06)
      for (const s of buttressSides) {
        // 0.06 of headroom, because the sloped cap below reaches further out
        // in X than the pier does once it is tilted.
        const proj = Math.min(0.38, sideOut(s) - 0.06)
        // Two along the depth, set in from the corners so they read as
        // structure rather than as the wall being thicker.
        const count = mainVol.depth >= 5.5 ? 3 : 2
        for (let i = 0; i < count; i++) {
          const t = (i + 1) / (count + 1)
          const bz = mainVol.offsetZ + (t - 0.5) * mainVol.depth * 0.82
          const bh = mainWallH * (0.62 + rand01(hash, 1413 + i * 7) * 0.14)
          const bw = 0.46
          const pier = new THREE.BoxGeometry(proj, bh, bw)
          localToWorld(pier, sideWallX(s) + s * proj / 2, mainVol.bottomY + bh / 2, bz,
            leanX, leanZ, rotationY, wx, wy, wz)
          detailBatch.addPositioned(pier, bColor)
          // Weathered stone cap, sloped away from the wall so it sheds.
          const cap = new THREE.BoxGeometry(proj * 0.98, 0.12, bw + 0.06)
          cap.rotateZ(-s * 0.22)
          localToWorld(cap, sideWallX(s) + s * proj / 2,
            mainVol.bottomY + bh + 0.05, bz,
            leanX, leanZ, rotationY, wx, wy, wz)
          ornamentBatch.addPositioned(cap, shiftColor(bColor, 0.06, 0.05, 0.04))
        }
      }
    }

    // --- FLANK CHIMNEY BREAST → batched ---
    // The stack carried down the OUTSIDE of a gable wall as a tapering
    // pilaster. This is the signature back-of-a-terrace silhouette and it
    // costs two boxes. Deliberately for the buildings the buttress pass
    // skips, so the two together cover most tall flanks rather than
    // doubling up on the same wealthy few.
    // Computed from sideRoom directly, NOT filtered out of buttressSides —
    // that list has already applied the buttress's STRICTER 0.22 test, so
    // filtering it at 0.22 could only ever narrow the set further and the
    // looser threshold this feature is supposed to have could never take
    // effect. A gate derived from another gate inherits its constraints
    // silently; this one cost the feature most of its population.
    // 0.14, not 0.22, and the difference is most of the town. MIN_HABITABLE_W
    // forces a volume to 2.6m inside a 1-tile (3.0m) footprint, so an ordinary
    // row house has exactly 0.20m beside it — the gate counters put 74% of
    // eligible buildings under the old threshold, and they were nearly all
    // sitting just below it. A 0.18m pilaster is also what a chimney breast on
    // a tight urban plot actually is; the previous number was not modest, it
    // was wrong.
    const breastSides: number[] = []
    for (const s of [-1, 1]) if (sideRoom(s) >= 0.14) breastSides.push(s)
    const wantsBreast = !wantsButtress && !isLandmark && !mainVol.circular &&
      !NO_JITTER.has(obj.definitionId) &&
      breastSides.length > 0 && mainWallH > 4.2 && mainVol.depth >= 1.8 &&
      rand01(hash, 1421) < 0.40
    if (!wantsButtress && !isLandmark && !mainVol.circular &&
        !NO_JITTER.has(obj.definitionId)) {
      if (breastSides.length === 0) tallyIn('chimneyBreast~noRoomBeside', district)
      else if (mainWallH <= 4.2) tallyIn('chimneyBreast~tooShort', district)
      else if (mainVol.depth < 1.8) tallyIn('chimneyBreast~tooShallow', district)
      else if (!wantsBreast) tallyIn('chimneyBreast~lostTheDice', district)
    }
    if (wantsBreast) {
      tallyIn('chimneyBreast', district)
      const s = breastSides[hash % breastSides.length]
      const proj = Math.min(0.30, sideRoom(s) - 0.015)
      const breastW = Math.min(1.25, mainVol.depth * 0.42)
      const bz = mainVol.offsetZ + (rand01(hash, 1423) - 0.5) * (mainVol.depth - breastW)
      const lowH = mainWallH * 0.72
      const lower = new THREE.BoxGeometry(proj, lowH, breastW)
      localToWorld(lower, sideWallX(s) + s * proj / 2, mainVol.bottomY + lowH / 2, bz,
        leanX, leanZ, rotationY, wx, wy, wz)
      detailBatch.addPositioned(lower, shiftColor(palette.wall, -0.10, -0.09, -0.07))
      // The taper: a narrower section carrying on up past the eaves.
      const upH = mainWallH - lowH + 0.55
      const upper = new THREE.BoxGeometry(proj * 0.72, upH, breastW * 0.66)
      localToWorld(upper, sideWallX(s) + s * proj * 0.36,
        mainVol.bottomY + lowH + upH / 2, bz,
        leanX, leanZ, rotationY, wx, wy, wz)
      detailBatch.addPositioned(upper, shiftColor(palette.wall, -0.12, -0.11, -0.09))
    }

    // === FOUNDATION → batched ===
    // Goes through localToWorld so it follows yaw (lean intentionally not
    // applied — the foundation slab is a ground feature; if the building
    // tips, the slab stays planted on the terrain). leanX/leanZ = 0 here.
    if (district === 'noble' || district === 'temple' || style === 'ornate') {
      tallyIn('foundation', district)
      const geo = new THREE.BoxGeometry(fp.w + 0.1, 0.08, fp.h + 0.1)
      localToWorld(geo, 0, 0.04, 0, 0, 0, rotationY, wx, wy, wz)
      detailBatch.addPositioned(geo, 0x606060)
    }

    // === FLAG POLE + BANNER → ornament-batched ===
    // Noble / temple / wealthy buildings get a flag pole rising from the
    // mainBody roof peak, with a small triangular banner attached at the
    // upper portion. Reads as "this is the count's house" / "the temple"
    // from the skyline. Banner color picks from a small heraldic palette
    // by hash so each noble household has its own livery.
    const wantsFlagPole = !mainVol.circular &&
      (district === 'noble' || district === 'temple' ||
       obj.definitionId === 'mansion' || obj.definitionId === 'guild_hall' ||
       styleVector.wealth > 0.7) &&
      !NO_JITTER.has(obj.definitionId) &&
      mainRoofH > 0.3 &&
      rand01(hash, 1601) < 0.55
    if (wantsFlagPole) {
      tallyIn('flagPole', district)
      // Pole anchors near the front edge of the ridge so the banner is
      // visible from the street rather than tucked behind chimneys at the
      // back. For prism roofs the ridge runs along an axis; offset the pole
      // 30% toward the front face along the perpendicular axis.
      const ridgeOnX = mainVol.roofAxis === 'x'
      const poleH = 1.6
      const poleR = 0.04
      const poleLocalX = mainVol.offsetX + (ridgeOnX ? 0 : mainVol.depth * 0.25)
      const poleLocalZ = mainVol.offsetZ + (ridgeOnX ? mainVol.depth * 0.25 : 0)
      const poleBaseY = mainLocalTopY + mainRoofH + 0.05
      const pole = new THREE.CylinderGeometry(poleR, poleR, poleH, 6)
      localToWorld(pole, poleLocalX, poleBaseY + poleH / 2, poleLocalZ,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(pole, 0x4a3a2a)
      // Pole finial cap (small ball).
      const cap = new THREE.SphereGeometry(0.07, 5, 4)
      localToWorld(cap, poleLocalX, poleBaseY + poleH + 0.04, poleLocalZ,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(cap, 0xb89858)         // brass
      /**
       * BANNER — instanced, and it flies DOWNWIND.
       *
       * Its yaw was `rand01(hash, 1607) * 2PI` under a comment saying "so
       * banners on different buildings flap in different directions", which
       * is word for word what the weathervanes said. A bug in one instance is
       * a bug in a PATTERN, and `localToWorld`'s own doc-comment lists "flag
       * banners rotated to a hash-determined wind angle" four hundred lines
       * above this.
       *
       * After the vane fix it was actively worse than before: a town whose
       * vanes all agree while its flags each fly somewhere else reads as a
       * mistake rather than as a decoration, because the eye can now see there
       * IS a wind and see the flags ignoring it. A half-swept pattern is worse
       * than an unswept one.
       */
      const bannerColors = [0x8e2424, 0x2a3a72, 0x2e5a32, 0x4a2a5e, 0xa07020]
      // The HOIST POSITION only. A flag is gimballed on a true vertical, so
      // the building's own yaw has no say in which way the wind blows it —
      // passing the whole frame let every flag inherit its building's
      // rotation and scattered the skyline all over again.
      const bf = localToWorldMatrix(poleLocalX, poleBaseY + poleH * 0.78,
        poleLocalZ, leanX, leanZ, rotationY, wx, wy, wz).elements
      addBanner(bf[12], bf[13], bf[14],
        bannerColors[hash % bannerColors.length], rand01(hash, 1607))
    }

    // === IVY PATCHES → ornament-batched ===
    // Small dark-green geometric patches climbing the front-facing wall
    // on weathered residential / garden / cottage buildings. Reads as
    // ivy / climbing roses from any distance. Skipped on landmarks
    // (their architecture is meant to read clean) and on stoneBased
    // buildings (those tend to have caretakers who keep walls clear).
    const wantsIvy = !isLandmark && !mainVol.circular && !stoneBased &&
      (district === 'residential' || district === 'garden' ||
       district === 'slum' || district === 'artisan') &&
      styleVector.weather > 0.45 &&
      mainVol.height > 1.6 &&
      !NO_JITTER.has(obj.definitionId) &&
      rand01(hash, 1701) < 0.32
    if (wantsIvy) {
      tallyIn('ivy', district)
      // IVY GOES ON THE BACK AND THE SIDES, not the street front.
      //
      // This used to read "pick the front face (+Z) since that's the
      // player-visible wall", which is the one-direction-of-visibility
      // assumption stated out loud — and in a WALKAROUND it is simply false,
      // because the player walks round the back of things. Measured, the far
      // side of a building carries about half the visual detail of its road
      // side, and every front-attached feature in this file (signs, awnings,
      // stoops, doorsteps, benches, balconies) makes that worse. Ivy is one
      // of the few that can be moved at no cost.
      //
      // It is also more truthful. Ivy takes the shaded, damp, unswept wall —
      // the back of the block and the gap between neighbours — not the face
      // the householder sweeps every morning.
      const halfW = mainVol.width / 2
      const patchCount = 3 + (hash % 3)               // 3..5
      // 0 = back (-Z), 1 = left (-X), 2 = right (+X). Never the street face.
      const ivyFace = hash % 3
      const backLocalZ = mainVol.offsetZ - mainVol.depth / 2
      const halfD = mainVol.depth / 2
      for (let p = 0; p < patchCount; p++) {
        // Patch dimensions vary per patch.
        const pW = 0.28 + rand01(hash, 1711 + p) * 0.34   // 0.28..0.62
        const pH = 0.4 + rand01(hash, 1721 + p) * 0.65    // 0.40..1.05
        const pT = 0.04
        // X position: spread across the wall, avoiding the door area.
        const xRange = halfW * 0.9
        const localX = mainVol.offsetX + (rand01(hash, 1731 + p) - 0.5) * 2 * xRange
        // Avoid the door zone on the FRONT only. There is no door on the back
        // or the side walls, so skipping patches there just thinned the one
        // face this feature is now for.
        if (ivyFace === 0 && Math.abs(localX - mainVol.offsetX) < 0.4 && pH < 1.5) continue
        // Y position: bias toward the lower 60%. Patch center range
        // [pH/2, mainVol.height * 0.6 - pH/2].
        const yMin = mainVol.bottomY + pH / 2 + 0.05
        const yMax = mainVol.bottomY + mainVol.height * 0.6 + pH / 2
        const localY = yMin + rand01(hash, 1741 + p) * Math.max(0.1, yMax - yMin)
        // Lay the patch onto whichever wall this building's ivy claimed. A
        // side patch is thin in X and spread in Z, so its box swaps axes.
        let ivyGeo: THREE.BufferGeometry
        let gx: number, gz: number
        if (ivyFace === 0) {
          ivyGeo = new THREE.BoxGeometry(pW, pH, pT)
          gx = localX
          gz = backLocalZ - pT / 2
        } else {
          const sideSign = ivyFace === 1 ? -1 : 1
          ivyGeo = new THREE.BoxGeometry(pT, pH, pW)
          gx = mainVol.offsetX + sideSign * (mainVol.width / 2 + pT / 2)
          // Reuse the same spread value along the DEPTH of the side wall.
          gz = mainVol.offsetZ + (rand01(hash, 1731 + p) - 0.5) * 2 * (halfD * 0.9)
        }
        localToWorld(ivyGeo, gx, localY, gz,
          leanX, leanZ, rotationY, wx, wy, wz)
        // Ivy palette: a few dark mossy greens. Pick by hash + p so each
        // patch on a building can be slightly different.
        const ivyColors = [0x2a3818, 0x344524, 0x2c3a1e, 0x405038, 0x3a4a26]
        const ivyColor = ivyColors[(hash + p) % ivyColors.length]
        ornamentBatch.addPositioned(ivyGeo, ivyColor)
      }
    }

    // === DOORSTEP → batched ===
    // Front-face doorstep — also a ground feature, no lean (a building tips
    // but its threshold stays flat) but does follow yaw so the step lands on
    // the rotated +Z face. Noble/temple/wealthy buildings get a 2- or
    // 3-step approach instead of a single threshold; everyone else gets
    // the simple single step. Multi-step entries narrow as they go up
    // (the bottom step is widest) so the silhouette reads as a stone
    // approach rather than a stack.
    // GATED ON THE WALL, NOT ON A TILE COUNT IN ONE AXIS.
    //
    // `fpT.w >= 2` excluded every 1-wide type — row_house, tenement, lean_to,
    // workshop, narrow_house — which between them are most of the town, and a
    // row house obviously has a door and wants a step in front of it. It is
    // also orientation-blind: a 1x3 narrow_house presenting its long side to
    // the street has plenty of frontage and still failed.
    //
    // This is the THIRD instance of the same gate bug in this file. The shop
    // sign's `fp.w >= 2` was fixed to `max(w, h) >= 2`, stoopBench's
    // `fpT.w >= 3` after that, and the pattern was never swept. The right
    // test is not a better tile expression at all: these features attach to
    // the FRONT WALL, `frontWallHalfW` is that wall in metres, and asking the
    // wall directly is exact where a footprint is a proxy.
    const stepW0 = 0.85
    // AND ONLY ON SOMETHING WITH A DOOR. Widening the gate above immediately
    // put a step in front of every precinct wall and bridge: the census read
    // 820 doorsteps against ~614 actual buildings, and a count exceeding its
    // own population is a free bug report. `fpT.w >= 2` had been excluding
    // them by ACCIDENT — a precinct wall is 1x1 — which is the worst kind of
    // correct, because the moment the gate is fixed for the right reason the
    // barriers walk through it.
    //
    // `mainVol.habitable !== false` is the same declaration FacadeConfig.hasDoor
    // reads, and it exists because `role: 'mainBody'` was carrying two
    // meanings. A wall does not get a threshold because a wall has no door.
    if (mainVol.habitable !== false && frontWallHalfW * 2 >= stepW0 + 0.4) {
      tallyIn('doorstep', district)
      const wantsStepUp = (district === 'noble' || district === 'temple' ||
        styleVector.wealth > 0.65 || obj.definitionId === 'mansion' ||
        obj.definitionId === 'cathedral' || obj.definitionId === 'guild_hall')
      if (wantsStepUp) {
        const stepCount = (district === 'temple' || obj.definitionId === 'cathedral') ? 3 : 2
        const stepH = 0.07
        for (let s = 0; s < stepCount; s++) {
          const stepW = 0.85 - s * 0.10                  // narrower as we go up
          const stepD = 0.18 - s * 0.02
          const stepZ = frontWallZ + (stepCount - s) * 0.13
          const geo = new THREE.BoxGeometry(stepW, stepH, stepD)
          localToWorld(geo, 0, stepH / 2 + s * stepH, stepZ, 0, 0, rotationY, wx, wy, wz)
          detailBatch.addPositioned(geo, 0x9c9890)        // limestone steps
        }
      } else {
        const geo = new THREE.BoxGeometry(0.5, 0.05, 0.15)
        localToWorld(geo, 0, 0.025, frontWallZ + 0.08, 0, 0, rotationY, wx, wy, wz)
        detailBatch.addPositioned(geo, 0x808080)
      }
    }

    // === EXTERNAL STAIR TO AN UPPER DOOR → batched ===
    //
    // A timber flight running up the front to a first-floor entrance. This is
    // a Traverse Town signature and the town had none: DESIGN.md names four
    // references and two of them — Traverse Town and Diagon Alley — are full
    // of doors you reach by going UP outside the building. It is also the
    // only front-attached feature here with real vertical extent, so it
    // breaks the flat run of a terrace in a way no amount of ground clutter
    // does.
    //
    // Gated on the WALL, not a tile count, for the reason placard and
    // doorstep just were. It needs a wall wide enough to carry a 0.9m flight
    // beside the ground-floor door without covering it, and a building tall
    // enough to have an upstairs at all.
    const stairRun = 2.0, stairW = 0.9
    const wantsStair = !isLandmark && !mainVol.circular &&
      mainVol.habitable !== false &&
      frontWallHalfW * 2 >= stairW + 1.5 &&
      mainWallH >= STOREY_HEIGHT * 1.85 &&
      (district === 'residential' || district === 'slum' || district === 'artisan' ||
       district === 'waterfront' || district === 'harbor' || district === 'market') &&
      rand01(hash, 1431) < 0.26
    if (wantsStair) {
      tallyIn('externalStair', district)
      const landY = STOREY_HEIGHT * 1.05
      const side = rand01(hash, 1433) < 0.5 ? -1 : 1
      // Hard against one end of the wall so it never sits over the door.
      const baseX = side * (frontWallHalfW - stairW * 0.5 - 0.12)
      const treads = 8
      const timber = 0x6f5330, rail = 0x5e4529
      for (let i = 0; i < treads; i++) {
        const t = (i + 0.5) / treads
        const tread = new THREE.BoxGeometry(stairW, 0.06, stairRun / treads + 0.02)
        localToWorld(tread, baseX, landY * t, frontWallZ + stairRun * (1 - t) - 0.1,
          0, 0, rotationY, wx, wy, wz)
        detailBatch.addPositioned(tread, timber)
      }
      /**
       * THE RAKE, AND ITS SIGN WAS INVERTED — reported from the device as "a
       * staircase handrail mirrored along vertical from the position it
       * should be", and the stringers underneath had the identical error.
       *
       * The treads rise as Z DECREASES: t=0 sits at `frontWallZ + stairRun`
       * and t=1 at `frontWallZ`, because the flight climbs back toward the
       * wall it is bolted to. So the rake direction is (0, +landY, -stairRun).
       *
       * `rotateX(a)` sends a Z-long box to (0, -sin a, cos a). With
       * a = -atan2(landY, stairRun) that is (0, +landY, +stairRun)/L — the
       * MIRROR of the flight, sloping the opposite way from the steps it is
       * supposed to follow. The correct angle is the positive one, which
       * gives (0, -landY, +stairRun)/L: the same LINE, since a box is
       * symmetric about its centre, and therefore the rake of the stair.
       *
       * A bug in one member is a bug in the PATTERN — the rail below had it
       * too, and both are fixed here rather than one now and one later.
       */
      const rake = Math.atan2(landY, stairRun)
      // Stringers under the treads, so it is a stair and not floating slats.
      for (const sx of [-1, 1]) {
        const stringer = new THREE.BoxGeometry(0.07, 0.16, Math.hypot(stairRun, landY))
        stringer.rotateX(rake)
        localToWorld(stringer, baseX + sx * stairW * 0.5, landY * 0.5,
          frontWallZ + stairRun * 0.5 - 0.1, 0, 0, rotationY, wx, wy, wz)
        detailBatch.addPositioned(stringer, timber)
      }
      // Landing at the top, tight to the wall.
      const landing = new THREE.BoxGeometry(stairW + 0.3, 0.08, 0.55)
      localToWorld(landing, baseX, landY, frontWallZ + 0.24, 0, 0, rotationY, wx, wy, wz)
      detailBatch.addPositioned(landing, timber)
      // Handrail on the open side only — against the wall it would be silly.
      const railPosts = 3
      for (let i = 0; i <= railPosts; i++) {
        const t = i / railPosts
        const post = new THREE.BoxGeometry(0.06, 0.62, 0.06)
        localToWorld(post, baseX - side * stairW * 0.5, landY * t + 0.31,
          frontWallZ + stairRun * (1 - t) - 0.1, 0, 0, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(post, rail)
      }
      const handrail = new THREE.BoxGeometry(0.05, 0.05, Math.hypot(stairRun, landY))
      handrail.rotateX(rake)
      localToWorld(handrail, baseX - side * stairW * 0.5, landY * 0.5 + 0.6,
        frontWallZ + stairRun * 0.5 - 0.1, 0, 0, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(handrail, rail)
    }

    // === WINDOW SHUTTERS → batched ===
    //
    // Pairs of boards flanking the ground-floor openings. Cheap, and it is the
    // one piece of dressing that lands ON the part of the wall a player at
    // eye level is actually looking at — the openings are PAINTED, so until
    // now nothing on the ground floor had any relief at all except the door
    // surround.
    //
    // Positions come from `facadeOpenings`, the same function FacadeTexture
    // lays the paint out with. That is not a convenience: this file already
    // records the timber frame beating against the window grid because the
    // studs used a 1.7m bay pitch while the paint used a 2.4m column pitch,
    // 315 collisions on 31 buildings. Asking the same function is the only
    // way two authors of one wall agree.
    const wantsShutters = !isLandmark && !mainVol.circular &&
      mainVol.habitable !== false && !wantsTimberPosts &&
      (district === 'residential' || district === 'noble' || district === 'garden' ||
       district === 'artisan' || district === 'slum') &&
      rand01(hash, 1437) < 0.42
    if (wantsShutters) {
      // Exactly the arguments VolumeRenderer passes, so the columns are the
      // painted columns. WinCell carries FRACTIONS of the wall (u, vCenter,
      // uW, vH), not metres — multiply by the volume's own extents.
      const cells = facadeOpenings(
        volumeFloors(mainVol), quantizeWallM(mainVol.width, 'front'),
        quantizeWallM(mainVol.height, 'front', 1.5), 'front', mainVol.wallColor)
      if (cells.length) {
        tallyIn('shutters', district)
        const shColor = SHUTTER_COLORS[hash % SHUTTER_COLORS.length]
        for (const c of cells) {
          const cy = c.vCenter * mainVol.height
          if (cy > STOREY_HEIGHT * 2.3) continue        // ground and first only
          const cw = c.uW * mainVol.width
          const ch = c.vH * mainVol.height
          const cx = (c.u - 0.5) * mainVol.width
          const shW = Math.max(0.16, cw * 0.42)
          // Must not run off the end of its own wall — the containment check
          // facade.mjs added after 44 painted doors turned out to be off the
          // walls carrying them.
          if (Math.abs(cx) + cw * 0.5 + shW + 0.04 > frontWallHalfW) continue
          const shH = Math.min(ch * 0.98, 1.3)
          for (const sx of [-1, 1]) {
            const leafX = cx + sx * (cw * 0.5 + shW * 0.5 + 0.02)
            // CLEAR THE DOOR. `facadeOpenings` returns windows and knows
            // nothing about the door, which FacadeTexture centres separately
            // at x=0, 0.95 x 2.05m — so a window column near the middle of
            // the wall put a shutter straight across it, measured at 2 hits
            // covering 44%. Found the moment the part was recorded, which is
            // the argument for recording it.
            if (Math.abs(leafX) < 0.475 + shW * 0.5 + 0.03 &&
                cy - shH * 0.5 < 2.05) continue
            const leaf = new THREE.BoxGeometry(shW, shH, 0.045)
            localToWorld(leaf, leafX, cy, frontWallZ + 0.03, 0, 0, rotationY, wx, wy, wz)
            detailBatch.addPositioned(leaf, shColor)
            // RECORDED, so facade.mjs can grade it. A shutter sits beside its
            // opening by construction and so "cannot" cross the glass — which
            // is exactly what the timber frame assumed before it was measured
            // at 315 collisions. A kind that is never recorded and a kind with
            // no collisions read identically in that census, and this file
            // already documents the colonnade going missing that way.
            recordPart(obj.id, obj.definitionId, volKey(mainVol), 'shutter',
              leafX, cy, shW, shH)
          }
        }
      }
    }

    // === STOOP BENCH → batched ===
    // Stone bench beside the front door, on residential/market streets.
    // The "neighbours sit out at dusk" reading. Side picked by hash so
    // benches don't all align on one side of every door. Skip on
    // landmarks (their architecture doesn't want sidewalks of stone) and
    // tiny buildings where it'd push past the wall edge.
    // max(w, h) >= 2, not w >= 3. This is the SAME bug the shop sign already
    // had fixed and nobody propagated: a row_house is 1x2, so gating a
    // front-attached feature on fpT.w alone excludes the type the ordinary
    // town is mostly made of, and w >= 3 excludes almost everything else too.
    // Measured, this fired on 4 buildings in 525.
    const wantsStoop = !isLandmark && !mainVol.circular &&
      Math.max(fpT.w, fpT.h) >= 2 &&
      !NO_JITTER.has(obj.definitionId) &&
      (district === 'residential' || district === 'market' || district === 'artisan' ||
       district === 'garden') &&
      rand01(hash, 1101) < 0.30
    if (wantsStoop) {
      tallyIn('stoopBench', district)
      const benchW = 0.85, benchH = 0.40, benchD = 0.32
      const benchSide = rand01(hash, 1103) < 0.5 ? -1 : 1
      const benchX = benchSide * (0.45 + benchW / 2)        // beside the door area
      const benchZ = frontWallZ + benchD / 2 - 0.04
      const bench = new THREE.BoxGeometry(benchW, benchH, benchD)
      localToWorld(bench, benchX, benchH / 2, benchZ, 0, 0, rotationY, wx, wy, wz)
      detailBatch.addPositioned(bench, 0x7a7068)             // weathered stone
      // Two small support legs at the ends, slightly inset, so the bench
      // reads as a slab on legs rather than a block. Tiny ornaments.
      for (const off of [-benchW * 0.35, benchW * 0.35]) {
        const leg = new THREE.BoxGeometry(0.10, benchH - 0.06, 0.10)
        localToWorld(leg, benchX + off, (benchH - 0.06) / 2, benchZ, 0, 0, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(leg, 0x5a544a)
      }
    }

    // === HITCHING POST → batched ===
    // Wooden post with a horizontal crossbar at the top — for tying horses.
    // Only at tavern/inn fronts; medieval signature for "the alehouse on
    // the corner". Two posts spaced apart, just past the front face.
    // Skip on market-district taverns — they get an awning, whose front
    // posts land near the same XZ as the hitching posts and the two would
    // read as a confusing double-post.
    // `coach_house` belongs here and was missing: it is literally where the
    // horses and the carriage live, it is the noble quarter's own small type
    // at weight 3, and it places 7-8 a quarter — several times the tavern and
    // inn put together. At 2x2 it would also have failed the `fpT.w >= 3`
    // below, which is the same one-axis proxy fixed for placard and doorstep,
    // so the wall answers instead: two posts 1.2m apart plus their timber
    // needs about 1.6m of frontage and nothing more.
    const wantsHitching = (obj.definitionId === 'tavern' || obj.definitionId === 'inn' ||
      obj.definitionId === 'stable' || obj.definitionId === 'coach_house') &&
      district !== 'market' &&
      rand01(hash, 1201) < 0.7 && frontWallHalfW * 2 >= 1.6
    if (wantsHitching) {
      tallyIn('hitchingPost', district)
      const postH = 0.88, postT = 0.09
      const postZ = frontWallZ + 0.55
      for (const xOff of [-0.6, 0.6]) {
        const post = new THREE.BoxGeometry(postT, postH, postT)
        localToWorld(post, xOff, postH / 2, postZ, 0, 0, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(post, 0x4a3422)         // dark oak
        // Small ball cap on each post.
        const cap = new THREE.SphereGeometry(0.08, 5, 4)
        localToWorld(cap, xOff, postH + 0.04, postZ, 0, 0, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(cap, 0x4a3422)
      }
      // Crossbar tying the two posts.
      const cross = new THREE.BoxGeometry(1.2 + postT, 0.08, 0.06)
      localToWorld(cross, 0, postH - 0.10, postZ, 0, 0, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(cross, 0x4a3422)
    }

    // === CELLAR DOOR → ornament-batched ===
    // Slanted wood double-door at ground level, set against a SIDE face
    // (±X) of larger commercial / residential buildings. The 35° tilt is
    // the giveaway silhouette — flat doors read as "wall" but tilted ones
    // read as "cellar entrance" instantly. Door splits visually into two
    // leaves with a thin gap line down the middle.
    const wantsCellar = !isLandmark && !mainVol.circular &&
      mainVol.width >= 2.4 && mainVol.depth >= 1.6 &&
      !NO_JITTER.has(obj.definitionId) &&
      (district === 'market' || district === 'artisan' || district === 'residential' ||
       obj.definitionId === 'tavern' || obj.definitionId === 'inn') &&
      rand01(hash, 1301) < 0.18
    if (wantsCellar) {
      tallyIn('cellarDoor', district)
      const cellarSide = rand01(hash, 1303) < 0.5 ? -1 : 1
      const halfW = mainVol.width / 2
      const wallLocalX = mainVol.offsetX + cellarSide * halfW
      // Place toward the back-half of the side wall so it doesn't compete
      // with the front-door area visually.
      const cellarLocalZ = mainVol.offsetZ + (rand01(hash, 1305) - 0.5) * mainVol.depth * 0.5
      const doorLen = 1.10        // along-the-wall dimension (Z in local)
      const doorReach = 0.85      // along-the-slope dimension
      const slope = 35 * Math.PI / 180
      const cosS = Math.cos(slope), sinS = Math.sin(slope)
      // The door slants from a low OUTER edge (at ground, away from wall)
      // up to a higher INNER edge (against the wall, raised by reach*sin).
      // Geometry origin sits at the OUTER edge so we can rotate around it.
      // For cellarSide=+1 the door extends toward +X (its +X end goes to the
      // wall). For -1 it extends toward -X. Translate accordingly so the
      // outer edge lands at the geometry origin in either case.
      const innerEdgeXOffset = cellarSide * doorReach * cosS
      // cellarOuterX = world X of the door's outer edge. Door covers
      // [cellarOuterX, cellarOuterX + innerEdgeXOffset] in world X. Set so
      // the inner edge ends at the wall.
      const cellarOuterX = wallLocalX - innerEdgeXOffset
      const cellarColor = 0x5a3a22                    // weathered red-brown wood
      const door = new THREE.BoxGeometry(doorReach, 0.05, doorLen)
      // Translate so origin sits at the outer-edge end of the slope.
      door.translate(cellarSide * doorReach / 2, 0, 0)
      // Rotate around the outer edge so the inner edge tilts UP toward the wall.
      door.rotateZ(cellarSide * slope)
      localToWorld(door, cellarOuterX, 0.04, cellarLocalZ, 0, 0, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(door, cellarColor)
      // Two iron straps across the door at 25%/70% along its length.
      for (const tFrac of [0.25, 0.7]) {
        const strap = new THREE.BoxGeometry(doorReach * 0.95, 0.06, 0.05)
        strap.translate(cellarSide * doorReach / 2, 0.025, 0)
        strap.rotateZ(cellarSide * slope)
        const strapZ = cellarLocalZ - doorLen / 2 + tFrac * doorLen
        localToWorld(strap, cellarOuterX, 0.04, strapZ, 0, 0, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(strap, 0x2a201a)   // black iron
      }
    }

    // === BUILDING NAME PLACARD → ornament-batched ===
    // Horizontal painted wood sign across the front face above the door,
    // for inns / taverns / guild halls / specialized shops. The "Crossed
    // Swords Inn" / "The Apothecary" reading. Mounted high on the front
    // face so it's visible from across the plaza, not down at door height.
    // Skipped if a frontage shop sign already projects from this wall
    // (those are perpendicular signs at eye level and the placard would
    // visually compete).
    const wantsPlacard = (
      obj.definitionId === 'inn' || obj.definitionId === 'tavern' ||
      obj.definitionId === 'guild_hall' || obj.definitionId === 'apothecary' ||
      obj.definitionId === 'bakery' || obj.definitionId === 'shop'
    ) && !mainVol.circular &&
      // Was `fpT.w >= 3`, which of the six eligible types above admitted only
      // inn, tavern and guild_hall — apothecary (2x3), shop (2x3) and bakery
      // (2x2) could never carry a placard, and `shop` is much the commonest
      // of the six. The placard is 2.4m of painted board, so the honest
      // question is whether the wall can hold it.
      frontWallHalfW * 2 >= 2.4 + 0.5 &&
      !NO_JITTER.has(obj.definitionId) &&
      mainVol.height > 2.4
    if (wantsPlacard) {
      tallyIn('placard', district)
      const placardW = Math.min(2.4, frontWallHalfW * 0.9)
      const placardH = 0.32
      const placardT = 0.06
      // Mount it above the door zone. Ground floor is roughly the lower
      // FLOOR_HEIGHT of the wall; place placard just above that with a
      // cap so it never hits the cornice on short buildings.
      const targetY = Math.min(mainVol.height - 0.40, FLOOR_HEIGHT + 0.30)
      const placardY = mainVol.bottomY + targetY
      const frontLocalZ = mainVol.offsetZ + mainVol.depth / 2
      // Backing board (dark wood)
      const back = new THREE.BoxGeometry(placardW + 0.12, placardH + 0.08, placardT * 0.6)
      localToWorld(back, mainVol.offsetX, placardY, frontLocalZ + (placardT * 0.6) / 2,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(back, 0x3a2418)        // dark oak backing
      // Painted face (a brighter colored panel mounted on the backing)
      // Color picked from a small painted-sign palette by hash so each
      // shop/inn has its own livery. Same palette as shop signs to keep
      // a coherent commercial-color scheme across town.
      const placardColor = PAINTED_SIGN_COLORS[hash % PAINTED_SIGN_COLORS.length]
      const face = new THREE.BoxGeometry(placardW, placardH, placardT)
      localToWorld(face, mainVol.offsetX, placardY,
        frontLocalZ + placardT * 0.6 + placardT / 2,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(face, placardColor)
      // Two small iron mounting brackets at the placard's left/right edges,
      // implying the placard is bolted to the wall.
      for (const xSide of [-1, 1] as const) {
        const bracket = new THREE.BoxGeometry(0.06, placardH * 0.7, placardT * 0.5)
        localToWorld(bracket,
          mainVol.offsetX + xSide * (placardW / 2 - 0.04),
          placardY,
          frontLocalZ + placardT * 0.3,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(bracket, 0x2a201a)   // black iron
      }
    }

    // === ROOF MOSS PATCHES → ornament-batched ===
    // Small green tile patches scattered on the slopes of weathered
    // gabled/steep prism roofs, projecting just above the roof surface.
    // Complements the per-triangle color noise on the roof itself: noise
    // gives flat-shaded variation, these add actual geometric clusters
    // that read as MOSS / lichen growing in the seams. Skipped on
    // pristine roofs and on cathedral / temple landmarks (mossy temples
    // would read as "abandoned" rather than "old").
    const wantsRoofMoss = !isLandmark && !mainVol.circular &&
      (mainVol.roofStyle === 'gabled' || mainVol.roofStyle === 'steep') &&
      mainVol.roofHeight > 0.4 &&
      Math.min(mainVol.width, mainVol.depth) >= 1.6 &&
      // 0.50, NOT 0.55 — AND THE HISTOGRAM IS WHY.
      //
      // `styleVector.weather` clusters hard just under the old line: of the
      // 243 buildings this clause rejected, 154 sat in 0.45-0.55 and only 12%
      // of everything reaching it was above 0.55 at all. So "weathered" meant
      // the top EIGHTH rather than the worn half, and moss — a stated patina
      // feature — reached 1% of buildings. Same shape as the chimney breast,
      // whose own note records 74% of eligible buildings sitting just below
      // its threshold.
      //
      // Moving the line to the middle of the distribution it is cutting is
      // the principle; the exact value is the distribution's, not mine.
      // Cumulatively the buckets read 12 / 32 / 89 / 211 of the 275 buildings
      // that reach this clause, so the MEDIAN weather among moss-eligible
      // roofs is ~0.47 and that is where the line goes. It also buys tonal
      // variety on the largest dark surface class in the town, which is the
      // one thing roofs are short of.
      styleVector.weather > 0.47 &&
      rand01(hash, 1801) < 0.55
    // WHY A ROOF HAS NO MOSS — six clauses, same treatment as the buttress.
    // Patina is a stated pillar and this reads 1% of buildings, which is
    // either a correct rarity or a gate starving it; a count cannot tell.
    // Ordered outside-in so each counter names the FIRST thing that failed.
    if (isLandmark) tallyIn('roofMoss~landmark', district)
    else if (mainVol.circular) tallyIn('roofMoss~circular', district)
    else if (!(mainVol.roofStyle === 'gabled' || mainVol.roofStyle === 'steep')) {
      tallyIn('roofMoss~wrongRoof', district)
    } else if (mainVol.roofHeight <= 0.4) tallyIn('roofMoss~roofTooFlat', district)
    else if (Math.min(mainVol.width, mainVol.depth) < 1.6) tallyIn('roofMoss~tooNarrow', district)
    else if (styleVector.weather <= 0.47) {
      tallyIn('roofMoss~tooPristine', district)
      // LEAVE THE HISTOGRAM IN — 0.55 is the only number in this gate that
      // cannot be derived, so the distribution it cuts has to stay visible or
      // the next person tunes it blind. The buttress taught this the hard way:
      // a threshold change there moved the count by zero because the quantity
      // being cut was not near the line at all, and only a histogram said so.
      const wv = styleVector.weather
      tallyIn(wv < 0.2 ? 'roofMoss~wx0-20' : wv < 0.35 ? 'roofMoss~wx20-35'
        : wv < 0.45 ? 'roofMoss~wx35-45' : 'roofMoss~wx45-50', district)
    }
    else if (!wantsRoofMoss) tallyIn('roofMoss~lostTheDice', district)
    if (wantsRoofMoss) {
      tallyIn('roofMoss', district)
      siteOf('roofMoss', wx, wy + mainWallH, wz)
      const patchCount = 2 + (hash % 3)               // 2..4
      // Shared gable math — keeps moss patch positions aligned with
      // bargeboards / attic windows / ridge cap on the same volume.
      const { ridgeOnX, perpExtent, slopeAngle } = gableMath(mainVol)
      const wallTopY = mainVol.bottomY + mainVol.height
      const mossColors = [0x405028, 0x506838, 0x344518, 0x3a4a26, 0x2c3818]
      for (let p = 0; p < patchCount; p++) {
        const patchW = 0.20 + rand01(hash, 1811 + p) * 0.22   // along the ridge
        const patchD = 0.18 + rand01(hash, 1821 + p) * 0.20   // along the slope
        const patchT = 0.04
        const slopeSign = rand01(hash, 1831 + p) < 0.5 ? -1 : 1
        const tAlong = (rand01(hash, 1841 + p) - 0.5) * 0.85   // -0.425..+0.425
        const tPerp = 0.4 + rand01(hash, 1851 + p) * 0.55      // 0.4..0.95 (toward eave)
        const slopeY = wallTopY + (1 - tPerp) * mainVol.roofHeight + 0.02
        const localX = ridgeOnX ? mainVol.offsetX + tAlong * mainVol.width
                                : mainVol.offsetX + slopeSign * tPerp * perpExtent
        const localZ = ridgeOnX ? mainVol.offsetZ + slopeSign * tPerp * perpExtent
                                : mainVol.offsetZ + tAlong * mainVol.depth
        // Box: long-along-ridge × thin × across-slope. The thin axis
        // becomes the slope normal after rotation.
        const patchGeo = ridgeOnX
          ? new THREE.BoxGeometry(patchW, patchT, patchD)
          : new THREE.BoxGeometry(patchD, patchT, patchW)
        // Rotate so the patch lies flat on the slope surface. For axis='x'
        // gabled: outward normal of the +Z slope is (0, cos θ, +sin θ),
        // achieved by rotateX(+slopeAngle); -Z slope by rotateX(-slopeAngle).
        // For axis='z': +X slope outward (sin θ, cos θ, 0) → rotateZ(-θ),
        // -X slope rotateZ(+θ).
        if (ridgeOnX) {
          patchGeo.rotateX(slopeSign * slopeAngle)
        } else {
          patchGeo.rotateZ(-slopeSign * slopeAngle)
        }
        const patchColor = mossColors[(hash + p) % mossColors.length]
        localToWorld(patchGeo, localX, slopeY, localZ,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(patchGeo, patchColor)
      }
    }

    // === CORNER WHEEL GUARDS → batched ===
    // Stone bumpers at the building's street-facing corners — protected
    // the corner masonry from cart wheels in tight medieval streets.
    // Reads as "the locals know to swing wide here." Only on sides facing
    // a road (per roadSide) and only when there isn't already a corner
    // post / quoin emitted at that corner (those would clash visually).
    const wantsWheelGuard = !isLandmark && !wantsTimberPosts && !wantsQuoins &&
      !mainVol.circular && fpT.w >= 2 &&
      !NO_JITTER.has(obj.definitionId) &&
      (styleVector.wealth > 0.4 || district === 'market' || district === 'noble') &&
      rand01(hash, 1401) < 0.40
    if (wantsWheelGuard) {
      tallyIn('wheelGuard', district)
      const guardR = 0.13
      const guardH = 0.42
      const halfW = mainVol.width / 2
      const halfD = mainVol.depth / 2
      // Pick the two FRONT corners (toward the street, in the building's
      // local +Z direction since the building has been rotated to face the
      // road via roadSide).
      const corners: Array<[number, number]> = [
        [mainVol.offsetX + halfW + guardR * 0.6, mainVol.offsetZ + halfD + guardR * 0.6],
        [mainVol.offsetX - halfW - guardR * 0.6, mainVol.offsetZ + halfD + guardR * 0.6],
      ]
      for (const [gx, gz] of corners) {
        // Cylindrical bumper with a small dome cap on top.
        const guard = new THREE.CylinderGeometry(guardR, guardR * 1.05, guardH, 8)
        localToWorld(guard, gx, guardH / 2, gz, 0, 0, rotationY, wx, wy, wz)
        detailBatch.addPositioned(guard, 0x6e645a)        // weathered limestone
        const dome = new THREE.SphereGeometry(guardR, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2)
        localToWorld(dome, gx, guardH, gz, 0, 0, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(dome, 0x6e645a)
      }
    }

    // === DOORWAY SURROUND → ornament-batched ===
    // Stone frame (lintel + two jambs) projecting from the front (+Z) face
    // around the painted door on the FacadeTexture. The door rectangle on
    // the texture is 0.25 world units wide and ~0.22*wallH tall, centered
    // horizontally and anchored at the wall base. Wrapping it with a stone
    // surround gives the door real depth at human walking distance —
    // without it, doors read flat against the wall texture even at
    // close range. Skip on landmarks (their architecture is grand) and
    // narrow buildings where the door would dominate the front face.
    // Only emit when the mainBody volume actually carries the building's
    // front face — for L-shapes/porch templates, mainVol's front face is
    // inset and a surround there would land on an interior surface.
    // This used to ask "is the main body flush with the footprint edge?", with
    // a fixed 0.4 tolerance. But the main body is ALWAYS inset inside its
    // footprint by some template- and wealth-dependent amount, so that test was
    // really measuring the inset — and a fixed metric tolerance against a
    // footprint-sized quantity stops meaning anything the moment tiles are not
    // one unit. Ask the question the comment above actually describes instead:
    // is anything sticking out in front of the main body? That is scale-free.
    const mainFrontZ = mainVol.offsetZ + mainVol.depth / 2
    const frontmostZ = Math.max(...massing.volumes.map(v => v.offsetZ + v.depth / 2))
    const frontMatches = mainFrontZ >= frontmostZ - 0.25
    const wantsSurround = !isLandmark && !mainVol.circular && frontMatches &&
      !NO_JITTER.has(obj.definitionId) && fpT.w >= 2 && mainVol.width >= 1.4 &&
      (styleVector.stone > 0.5 || styleVector.cornice > 0.4 ||
       district === 'noble' || district === 'temple' ||
       rand01(hash, 951) < 0.4)
    if (wantsSurround && mainVol.height > 1.5) {
      tallyIn('doorwaySurround', district)
      const doorW = 0.32
      const doorH = Math.min(mainVol.height * 0.55, 1.4)
      const baseLocalY = mainVol.bottomY
      const frontLocalZ = mainVol.offsetZ + mainVol.depth / 2
      const proj = 0.06          // how far the frame stands proud of the wall
      const jambW = 0.10
      const lintelH = 0.14
      // Color: warm limestone for darker walls, dark stone for pale walls.
      const wallR = (mainVol.wallColor >> 16) & 0xff
      const surroundColor = wallR < 180 ? 0xb8a888 : 0x6a5a48
      // Lintel
      const lintel = new THREE.BoxGeometry(doorW + jambW * 2 + 0.08, lintelH, proj)
      localToWorld(lintel, mainVol.offsetX, baseLocalY + doorH + lintelH / 2,
        frontLocalZ + proj / 2,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(lintel, surroundColor)
      // Jambs (sides)
      for (const xSide of [-1, 1]) {
        const jamb = new THREE.BoxGeometry(jambW, doorH, proj)
        localToWorld(jamb,
          mainVol.offsetX + xSide * (doorW / 2 + jambW / 2),
          baseLocalY + doorH / 2,
          frontLocalZ + proj / 2,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(jamb, surroundColor)
      }
      // Keystone — small bump at top center of lintel for noble/temple/wealth.
      if (styleVector.wealth > 0.55 || district === 'noble' || district === 'temple') {
        const keystone = new THREE.BoxGeometry(0.18, lintelH + 0.06, proj + 0.02)
        localToWorld(keystone, mainVol.offsetX, baseLocalY + doorH + (lintelH + 0.06) / 2,
          frontLocalZ + (proj + 0.02) / 2,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(keystone, surroundColor)
      }
      // Date plaque — small carved-stone block above the lintel with
      // subtle relief lines suggesting carved numerals. The "1487"
      // date stone you see above old doorways. Only emitted on a
      // subset of surround buildings so not every door has one.
      if (rand01(hash, 1551) < 0.35) {
        const plaqueW = 0.42, plaqueH = 0.22
        const plaqueProj = proj + 0.015
        const plaqueY = baseLocalY + doorH + lintelH + plaqueH / 2 + 0.08
        const plaqueColor = shiftColor(surroundColor, 0.04, 0.04, 0.03)
        const plaque = new THREE.BoxGeometry(plaqueW, plaqueH, plaqueProj)
        localToWorld(plaque, mainVol.offsetX, plaqueY,
          frontLocalZ + plaqueProj / 2,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(plaque, plaqueColor)
        // Faux-carved relief: 4 thin recessed lines (numerals) spanning
        // the plaque's center band. Drawn DARKER (opposite of "carved
        // out and shadow-filled") — at distance reads as date carving.
        const reliefColor = shiftColor(surroundColor, -0.10, -0.10, -0.08)
        const numW = 0.06, numH = 0.10, numProj = 0.012
        const numSpacing = plaqueW / 5
        for (let n = 0; n < 4; n++) {
          const numX = mainVol.offsetX - plaqueW / 2 + numSpacing * (n + 1)
          const num = new THREE.BoxGeometry(numW, numH, numProj)
          localToWorld(num, numX, plaqueY,
            frontLocalZ + plaqueProj + numProj / 2,
            leanX, leanZ, rotationY, wx, wy, wz)
          ornamentBatch.addPositioned(num, reliefColor)
        }
      }
    }

    // === SHOP SIGN → ornament-batched ===
    // Perpendicular wood sign hanging from a bracket on the front (+Z) face.
    // The medieval-Diagon-Alley signature: a row of mid-height projecting
    // signs reads as "this street has shops" the moment you turn into it.
    // Gated on commercial district + commercial building + hash. Follows the
    // building's lean+yaw via localToWorld so it stays attached visually.
    // A tavern is a tavern wherever it stands, so the sign is driven by the
    // BUILDING first and the district second. Requiring both a commercial
    // district AND a commercial type produced 4 signs on one 154-building
    // town and zero on another — the "row of projecting signs" that is
    // supposed to announce a shopping street never actually appeared.
    const isCommercialDistrict = district === 'market' || district === 'artisan' ||
      district === 'harbor' || district === 'waterfront'
    // A SET, AND SWEPT. This was seven hand-written `===` comparisons and it
    // had not been revisited since any of the twelve district-exclusive types
    // were added — so a chandlery, a shambles and a weigh house, which are
    // three of the most obviously commercial buildings in the town, could not
    // carry a hanging sign. The market's butchers' row was the one street in
    // the town guaranteed to have a sign over every door and had none.
    //
    // Same shape as the shop sign's own `fp.w >= 2` bug and `stoopBench`'s
    // after it: a gate written against the vocabulary that existed when it
    // was written, and never swept when the vocabulary grew. Grep the PATTERN
    // the same day — a list of literal ids IS the pattern.
    const isTradeBldg = TRADE_BUILDINGS.has(obj.definitionId)
    // Generic houses only get a sign when they sit on a trading street.
    const isShopfrontHouse = isCommercialDistrict && (
      obj.definitionId === 'building_small' || obj.definitionId === 'building_medium' ||
      obj.definitionId === 'half_timber' || obj.definitionId === 'corner_building' ||
      obj.definitionId === 'row_house'
    )
    // WHERE a building stands decides whether it is a shop.
    //
    // This was a flat 0.85 for a trade building and 0.45 for any ordinary
    // house, with no district test at all — so a row house in the CEMETERY
    // carried a shop sign as readily as one on the market square. Measured,
    // 16% of buildings town-wide had a sign and 13% an awning, spread evenly,
    // which is the exact opposite of what a market quarter is. Dressing that
    // appears everywhere differentiates nothing, and it was the whole of the
    // town's trade vocabulary.
    //
    // The district test had been REMOVED deliberately, because keying on the
    // single 'market' district left seeds where no eligible building stood in
    // it. That was a real problem and this is the fix for it: a graded weight
    // per district rather than a boolean, so trading streets are dense with
    // signage, ordinary streets carry the occasional one, and a temple or
    // cemetery carries none — without any seed ending up with zero.
    const tradeWeight = (d: string): number => {
      switch (d) {
        case 'market': return 1.0
        case 'harbor': case 'waterfront': return 0.8
        case 'artisan': return 0.7
        case 'slum': return 0.35
        case 'residential': return 0.28
        case 'noble': return 0.2
        case 'fortress': return 0.15
        case 'temple': case 'cemetery': case 'garden': return 0.06
        default: return 0.3
      }
    }
    // A tavern is a tavern wherever it stands, so a trade BUILDING keeps a
    // high floor; an ordinary house is a shop only because of its street.
    const tw = tradeWeight(district)
    const signChance = isTradeBldg
      ? Math.max(0.5, 0.85 * (0.55 + 0.45 * tw))
      : 0.85 * tw
    if (
      // Width gate is max(w,h), not w: a row_house is 1x2, and terraced row
      // houses are the ONE type a shopping street is mostly made of. Keying
      // on fp.w alone excluded every one of them, so market streets had no
      // signs on the very buildings that should carry them.
      (isTradeBldg || isShopfrontHouse) && Math.max(fpT.w, fpT.h) >= 2 &&
      !NO_JITTER.has(obj.definitionId) &&
      wallH > 2.4 && rand01(hash, 811) < signChance
    ) {
      // Sign at ground-floor top, ~2.3m above base — eye level for a
      // 1.6m-tall player so it reads as "shop sign" not "high banner".
      tallyIn('shopSign', district)
      siteOf('shopSign', wx, wy + 2.3, wz)
      const signY = Math.min(2.3, FLOOR_HEIGHT * 1.05)
      const signW = 0.5 + rand01(hash, 813) * 0.25      // 0.5..0.75
      const signH = 0.32 + rand01(hash, 815) * 0.16     // 0.32..0.48
      const signProj = 0.55                              // distance from wall to sign center
      const signSide = rand01(hash, 817) < 0.5 ? -1 : 1  // along front face
      const signLocalX = signSide * frontWallHalfW * 0.36
      const signLocalZ = frontWallZ + signProj
      // Bracket: thin bar along Z from wall (lz=fp.h/2) to sign center (signLocalZ).
      const bracketLen = signProj - 0.05
      const bracket = new THREE.BoxGeometry(0.05, 0.06, bracketLen)
      // Bracket centered between wall (fp.h/2 + 0.025) and sign (signLocalZ - 0.025)
      const bracketLocalZ = frontWallZ + bracketLen / 2 + 0.025
      localToWorld(bracket, signLocalX, signY + signH * 0.4, bracketLocalZ,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(bracket, 0x3a2418)  // dark wood
      // Sign plank itself — vertical, perpendicular to the wall (long axis = X
      // in local frame, so the BROAD face is visible from passers-by walking
      // along the building's front).
      const sign = new THREE.BoxGeometry(0.04, signH, signW)
      localToWorld(sign, signLocalX, signY, signLocalZ,
        leanX, leanZ, rotationY, wx, wy, wz)
      // Pick from a small palette so signs feel painted / individual.
      const signColor = PAINTED_SIGN_COLORS[hash % PAINTED_SIGN_COLORS.length]
      ornamentBatch.addPositioned(sign, signColor)
      // Two short chains rendered as thin vertical bars (we don't have line
      // primitives in the ornament batch). They connect the bracket bottom to
      // the sign top, suggesting the sign hangs rather than rigidly attaches.
      const chainH = signH * 0.18
      const chainY = signY + signH / 2 + chainH / 2
      for (const chOff of [-signW * 0.35, signW * 0.35]) {
        const chain = new THREE.BoxGeometry(0.025, chainH, 0.025)
        localToWorld(chain, signLocalX, chainY, signLocalZ + chOff,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(chain, 0x2a2018)
      }
    }

    // === AWNING → ornament-batched ===
    // Canvas slab over the front door of market-district buildings.
    // Sits at the top of the ground-floor band, projecting 0.55m forward.
    // Slightly thinner at the front than back so it reads as a sloped awning,
    // not a flat shelf.
    // Same reasoning as the shop sign: keyed off trade buildings and trading
    // streets rather than the single 'market' district, which on some seeds
    // contained no eligible building at all.
    if (
      (isTradeBldg || isShopfrontHouse) && Math.max(fpT.w, fpT.h) >= 2 &&
      !NO_JITTER.has(obj.definitionId) &&
      wallH > 1.8 && rand01(hash, 821) <
        (isTradeBldg ? Math.max(0.35, 0.6 * (0.55 + 0.45 * tw)) : 0.7 * tw)
    ) {
      tallyIn('awning', district)
      // HANG IT ABOVE THE DOOR HEAD. This was 2.0m against a door that
      // FacadeTexture paints 2.05m tall, so the canvas sliced the top off the
      // doorway and crossed the ground-floor glazing — 30 awning-over-window
      // crossings a town before tools/facade.mjs put a number on it. An awning
      // goes over a shopfront, not through it.
      const awningY = Math.min(2.6, Math.max(2.35, FLOOR_HEIGHT * 0.9))
      const awningW = Math.min(2.6, frontWallHalfW * 1.1)
      const awningD = 0.55
      // Front-edge dip so the awning slopes downward away from the wall.
      //
      // THE SIGN WAS INVERTED. rotateX(t) sends (y,z) -> (y cos t - z sin t,
      // ...), so a strip translated to +Z and rotated by a NEGATIVE angle has
      // y' = -z sin(t) = +6.6cm: the front edge went UP. The comment right
      // here said "~7 deg down at front edge" and the geometry did the
      // opposite, which is what "the angles for the main piece is wrong" was.
      const slopeRot = 0.12  // ~7° down at the front edge
      // Striped canvas — emit the awning as 5 vertical strips alternating
      // between two colors. Reads unambiguously as a market awning at any
      // distance, where a solid block reads as a shelf. Two-color picks
      // (a primary + a contrasting accent) selected from the warm palette
      // by hash so each shop's canvas has its own colorway.
      const awnPrimaries = [0xc25a3a, 0xc8924a, 0xa84030, 0xb86a4a, 0x8b7038]
      const awnAccents   = [0xf2d8a8, 0xece2cc, 0xd6c7a3, 0xefe1c0, 0xeacb99]
      const awnPrimary = awnPrimaries[(hash >> 4) % awnPrimaries.length]
      const awnAccent  = awnAccents[(hash >> 6) % awnAccents.length]
      const stripCount = 5
      const stripW = awningW / stripCount
      for (let s = 0; s < stripCount; s++) {
        const stripGeo = new THREE.BoxGeometry(stripW * 0.98, 0.04, awningD)
        // Pivot slope around the wall edge: same as before, but per-strip.
        stripGeo.translate(0, 0, awningD / 2)
        stripGeo.rotateX(slopeRot)
        const stripX = -awningW / 2 + (s + 0.5) * stripW
        const stripColor = s % 2 === 0 ? awnPrimary : awnAccent
        // MEASURE BEFORE IT LEAVES WALL-LOCAL SPACE. The first cut took the
        // profile after localToWorld, which applies rotationY — so on a
        // building facing east the awning projects along world X and the
        // "near/far Z" pair straddled its WIDTH instead of its reach. It read
        // a median 2.0 degrees with ten awnings apparently tilting up, and the
        // geometry was fine. A scan has to know what it is scanning.
        const prof = sideProfile(stripGeo)
        localToWorld(stripGeo, stripX, awningY, frontWallZ,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(stripGeo, stripColor)
        if (s === 0) {
          recordPart(obj.id, obj.definitionId, volKey(mainVol), 'awning',
            0, awningY - mainVol.bottomY, awningW, 0.04, prof)
        }
      }
      // Two simple vertical posts at the front corners — implies tied-down canvas.
      // Post top must clear the awning's sloped underside at the post's Z. The
      // awning's local Z (relative to its translate) at the post is awningD-0.04
      // ≈ 0.51. rotateX(t) sends (y,z) -> (y cos t - z sin t, ...), so with the
      // sign now POSITIVE a point at +Z drops by z * sin(t). Subtract another
      // half-thickness for the bottom face, then ~3cm of headroom.
      //
      // The two sentences this replaces still described the pre-fix world —
      // "slopeRot is negative so sin gives a small positive drop" — which is
      // the arithmetic that made the posts fall short. A comment left behind
      // by a fix is the next person's evidence.
      const postZRel = awningD - 0.04
      const postZ = frontWallZ + postZRel
      // ...and the post height inherited the same sign error, subtracting a
      // drop that never happened, so the posts fell ~16cm short of the canvas
      // they are supposed to hold up. A second piece of code derived from a
      // wrong assumption is how a sign error becomes two visible defects.
      const awningBottomDrop = postZRel * Math.sin(slopeRot) + 0.02
      const postH = Math.max(0.5, awningY - awningBottomDrop - 0.03)
      for (const px of [-awningW * 0.42, awningW * 0.42]) {
        const post = new THREE.BoxGeometry(0.04, postH, 0.04)
        post.translate(0, postH / 2, 0)
        localToWorld(post, px, 0, postZ,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(post, 0x3a2418)
      }
    }

    // Circular tower, bay window, and archway specialty blocks moved to
    // architecture/Massing.ts (tmplCircularTower / tmplGatehouse /
    // tmplStepBack-and-friends produce the projecting bays).

    /**
     * === A CAT IN THE WINDOW ===
     *
     * Every content change in this arc so far lands on ONE building a town —
     * a cathedral, a belfry. That is what a landmark is for, and it is the
     * wrong shape for whimsy: a delight you meet once is a set piece, and a
     * delight you keep meeting is a place with something living in it. So this
     * goes on ordinary houses, and the gate carries the meaning — a cat sits
     * where somebody LIVES, never on a warehouse or a town gate, and more
     * often in the quiet quarters than in the market.
     *
     * ON A SILL THAT ALREADY EXISTS. `facadeOpenings` is the same function
     * FacadeTexture paints from and VolumeRenderer hangs its projecting sills
     * on, so the ledge under the cat is real geometry and the position is
     * exact rather than guessed — the same containment argument as the glass.
     */
    const CAT_ODDS: Record<string, number> = {
      residential: 0.22, garden: 0.24, slum: 0.20, noble: 0.16, artisan: 0.14,
    }
    if (DWELLING_TYPES.has(obj.definitionId) && !isLandmark &&
        mainVol.habitable !== false &&
        rand01(hash, 2311) < (CAT_ODDS[district] ?? 0.08)) {
      const catCells = facadeOpenings(
        volumeFloors(mainVol), quantizeWallM(mainVol.width, 'front'),
        quantizeWallM(mainVol.height, 'front', 1.5), 'front', mainVol.wallColor)
      // A cat sits where it can be SEEN and where it could plausibly have got
      // to: the lower two storeys, and never a bricked-up opening, which has
      // no sill to sit on and no room behind it.
      // FILTER FIRST, THEN CHOOSE — the constraints decide the POPULATION, not
      // the pick. The first cut took one sill by hash and then tested it, and
      // the tally said `~atDoor` on 43 against 20 built: most of this town is
      // one bay wide, so its only ground-floor opening sits over the door, and
      // a cat that could perfectly well have used the sill upstairs was simply
      // dropped. Selecting from the valid set is the same fix the vignette
      // anchor needed — a criterion must measure the population it serves.
      const sills = catCells.filter((c) => {
        if (c.blocked) return false
        const cy = c.vCenter * mainVol.height
        if (cy >= STOREY_HEIGHT * 2.4) return false
        const cw = c.uW * mainVol.width
        const cx = (c.u - 0.5) * mainVol.width
        const sy = mainVol.bottomY + (c.vCenter - c.vH / 2) * mainVol.height
        // ON THE WALL IT SITS ON, and clear of the door — the same two
        // clauses the shutters and the glass need, for the same reasons.
        if (Math.abs(cx) + cw * 0.5 > frontWallHalfW) return false
        if (Math.abs(cx) < 0.475 + cw * 0.5 && sy < 2.05) return false
        return true
      })
      if (!sills.length) tallyIn('windowCat~noSill', district)
      else {
        const c = sills[hash % sills.length]
        const cw = c.uW * mainVol.width
        const cx = (c.u - 0.5) * mainVol.width
        const sillY = mainVol.bottomY + (c.vCenter - c.vH / 2) * mainVol.height
        {
          const coat = CAT_COATS[(hash >> 5) % CAT_COATS.length]
          const dark = shiftColor(coat, -0.06, -0.05, -0.04)
          // Facing out of the window, with a little yaw so a street of cats
          // is not a row of identical ornaments — pillar 2 at the smallest
          // scale this town has.
          const look = (rand01(hash, 2317) - 0.5) * 0.9
          const cz = frontWallZ + 0.15
          const cpush = (g: THREE.BufferGeometry, dx: number, dy: number,
            dz: number, col: number): void => {
            g.rotateY(look)
            localToWorld(g, cx + dx, sillY + dy, cz + dz,
              leanX, leanZ, rotationY, wx, wy, wz)
            detailBatch.addPositioned(g, col)
          }
          // A SITTING CAT IS A LOAF WITH A HEAD ON IT. Two spheres, two ears
          // and a tail curled round the front paws — any more at four pixels
          // is geometry nobody can see, which is this file's standing rule
          // about anything under ~5cm.
          const body = new THREE.SphereGeometry(0.105, 7, 5)
          body.scale(1.0, 0.92, 1.22)
          cpush(body, 0, 0.097, 0, coat)
          const head = new THREE.SphereGeometry(0.072, 7, 5)
          head.scale(1.0, 0.94, 0.96)
          cpush(head, 0, 0.235, 0.035, coat)
          for (const es of [-1, 1]) {
            const ear = new THREE.ConeGeometry(0.030, 0.058, 4)
            cpush(ear, es * 0.042, 0.296, 0.020, dark)
          }
          // The tail comes round the side and lies along the sill.
          const tailSide = (hash & 1) ? 1 : -1
          const tail = new THREE.BoxGeometry(0.038, 0.036, 0.20)
          cpush(tail, tailSide * 0.093, 0.032, 0.045, dark)
          // THE EYES ARE THE FEATURE. Tinted beacons, so they ride the same
          // path the stained glass does and cost one shared draw call.
          let catLogged = false
          /**
           * THE BLINK PHASE IS AN ATTRIBUTE, AND IT HAS TO BE.
           *
           * The first cut derived it in the shader from world position — the
           * sway's trick, which is right for a rope and wrong here. A varying
           * is INTERPOLATED, so every fragment of one eye got a slightly
           * different phase and therefore its own blink moment: the eye never
           * went dark, a random scatter of its pixels did, and the probe read
           * an 8% dip where a blink is a 100% one. That reads exactly like a
           * feature that nearly works.
           *
           * A per-cat constant fixes three things at once. The eye goes dark
           * ALL AT ONCE because every vertex carries the same number; the two
           * eyes cannot wink out of step because they carry the SAME number,
           * rather than merely a similar one; and the value stays in [0,1)
           * instead of reaching 78 at the far corner of the map, which is what
           * a `fract(sin(x) * 43758)` hash needs to stay a hash at all.
           *
           * Safe to merge because the cat tint is its OWN bucket: every
           * geometry in it comes from here and every one carries `aBlink`.
           * `mergeGeometries` refuses a set whose attributes disagree, so a
           * future feature reusing this tint without the attribute fails
           * loudly rather than silently — which is the right way round.
           */
          const blinkPh = rand01(hash, 8821)
          for (const es of [-1, 1]) {
            const eye = new THREE.SphereGeometry(0.0235, 5, 4)
            eye.rotateY(look)
            localToWorld(eye, cx + es * 0.030, sillY + 0.246, cz + 0.098,
              leanX, leanZ, rotationY, wx, wy, wz)
            const nv = eye.getAttribute('position').count
            eye.setAttribute('aBlink',
              new THREE.BufferAttribute(new Float32Array(nv).fill(blinkPh), 1))
            addBeacon(eye, CAT_EYE)
            if (!catLogged) {
              eye.computeBoundingBox()
              const eb = eye.boundingBox
              if (eb) {
                siteOf('windowCat', (eb.min.x + eb.max.x) / 2,
                  (eb.min.y + eb.max.y) / 2 - 0.10, (eb.min.z + eb.max.z) / 2,
                  0.55, 0.55, 0.55)
              }
              catLogged = true
            }
          }
          tallyIn('windowCat', district)
        }
      }
    }

    /**
     * === STAINED GLASS — coloured light through the openings that exist ===
     *
     * THE PLACEMENT IS THE WHOLE DESIGN DECISION, and the first plan was a
     * great rose window on the west front. The arithmetic killed it before a
     * line was written: `facadeOpenings` lays storeys from the ground up at
     * their true height, so on a twelve-metre nave wall the top row's head
     * sits at about eleven metres and the clear band above it is under a
     * metre. There is nowhere on that wall to put a three-metre disc that is
     * not ON TOP of painted windows — which is the two-authors-of-one-wall
     * defect this file spent a whole arc removing, in a new hat.
     *
     * So the light goes THROUGH the openings rather than over them. That is
     * exact by construction — the pane IS the cell — and it needs no
     * threshold, no clearance test and nothing to tune, which is the same
     * reason the timber studs were rewritten to take the wall minus its
     * openings. It is also the truer picture: a cathedral at dusk is a dark
     * mass with coloured light coming out of it.
     */
    if (STAINED_GLASS_TYPES.has(obj.definitionId)) {
      /**
       * ALL FOUR WALLS, because a cathedral is walked AROUND.
       *
       * Every piece of dressing in this file went on the front for years, for
       * the reason already written down forty lines above `frontWallZ`: there
       * was no anchor for the other three. There is now, and the glass is the
       * one feature where the flanks matter most — the nave clerestory is
       * where a cathedral's glass actually is, and `allsides` grades the flank
       * against the front as a tracked metric.
       *
       * The face table mirrors VolumeRenderer's own, exactly: the same union,
       * the same `acrossZ` span, the same quantised arguments. Two authors of
       * one wall is the defect this file has now paid for three times, and the
       * only defence is asking the same function with the same numbers.
       */
      /**
       * ONE DOMINANT HUE PER BUILDING, WITH AN ACCENT — not a tint per pane.
       *
       * Rolling a colour for every opening independently gives a chequerboard
       * of red, blue, gold, green and purple windows, which reads as a circus
       * and not as glass. Real glazing reads as one hue at a distance with
       * jewels in it, and the town-scale argument is the same one that keeps
       * `THATCH_ODDS` off 1.0: the differentiation wanted here is BETWEEN
       * buildings, so it belongs on the building's own hash.
       */
      // Darker than the wall it is set into, so the tracery reads as a
      // shadow line rather than as a lighter grid on top of it.
      const glassStone = shiftColor(palette.wall, -0.30, -0.28, -0.24)
      const domTint = GLASS_TINTS[hash % GLASS_TINTS.length]
      const accTint = GLASS_TINTS[(hash + 2) % GLASS_TINTS.length]
      let glassed = 0
      for (const { face, nx, nz } of [
        { face: 'front' as const, nx: 0, nz: 1 },
        { face: 'back' as const, nx: 0, nz: -1 },
        { face: 'side' as const, nx: 1, nz: 0 },
        { face: 'side' as const, nx: -1, nz: 0 },
      ]) {
        const acrossZ = nz !== 0
        const spanWorld = acrossZ ? mainVol.width : mainVol.depth
        const cells = facadeOpenings(
          volumeFloors(mainVol), quantizeWallM(spanWorld, face),
          quantizeWallM(mainVol.height, face, 1.5), face, mainVol.wallColor)
        let facePaned = false
        for (const c of cells) {
          // A bricked-up opening has no glass in it — that is what bricked up
          // MEANS, and lighting one would undo the only cue a flank has that
          // the building has a history. On a flank the whole ground storey is
          // deliberately blind, so this clause carries most of the rejections
          // and that is correct rather than a shortfall.
          if (c.blocked) { tallyIn('stainedGlass~blocked', district); continue }
          const cw = c.uW * spanWorld, ch = c.vH * mainVol.height
          const along = (c.u - 0.5) * spanWorld
          // FROM THE VOLUME'S OWN BASE, NOT FROM THE GROUND. `WinCell.vCenter`
          // is a fraction UP THE WALL, so the world height is the wall's base
          // plus that — and the shutter block one screen down writes it
          // without `bottomY` and is correct, because a shutter only ever goes
          // on an ordinary dwelling whose main body starts at zero. A
          // cathedral's nave does not, and the first cut hung every pane that
          // far below its own wall: photographed, deep-red windows floating in
          // mid-air with trees visible behind them.
          const cy = mainVol.bottomY + c.vCenter * mainVol.height
          // ON THE WALL IT IS PAINTED ON. `uW` is a fraction with no ceiling
          // and has already produced a window as wide as its whole wall; the
          // containment test costs one line and has no tolerance in it.
          if (Math.abs(along) + cw * 0.5 > spanWorld / 2) {
            tallyIn('stainedGlass~offWall', district); continue
          }
          // CLEAR THE DOOR, which `facadeOpenings` knows nothing about —
          // FacadeTexture centres it separately at x=0, 0.95 x 2.05m, and
          // only on the front. The shutters found this at 44% coverage.
          if (face === 'front' && Math.abs(along) < 0.475 + cw * 0.5 &&
              cy - ch * 0.5 < 2.05) {
            tallyIn('stainedGlass~atDoor', district); continue
          }
          const tint = (c.floor * 3 + c.col) % 4 === 0 ? accTint : domTint
          const px = acrossZ ? mainVol.offsetX + along
            : sideWallX(nx) + nx * 0.05
          const pz = acrossZ ? mainVol.offsetZ + nz * (mainVol.depth / 2 + 0.05)
            : mainVol.offsetZ + along
          // Inset inside its own aperture, so the painted reveal, lintel and
          // sill still frame it. A pane filling the opening edge to edge is a
          // coloured rectangle; a pane inside a frame is a window.
          const pw = cw * 0.78, ph = ch * 0.84
          const pane = new THREE.BoxGeometry(
            acrossZ ? pw : 0.05, ph, acrossZ ? 0.05 : pw)
          localToWorld(pane, px, cy, pz, leanX, leanZ, rotationY, wx, wy, wz)
          addBeacon(pane, tint)
          /**
           * TRACERY — a surround and a cross bar, and this is what turns a
           * coloured rectangle into a WINDOW.
           *
           * The first cut relied on the painted reveal showing around the
           * pane at 78% of its aperture, and the photograph came back with
           * flat colour running edge to edge — a slab, which is the "bare
           * glowing rectangle on a wall" failure already on the record for
           * the first beacon. Real geometry casting a real shadow is the
           * same fix the curtain wall needed: relief is what makes a big
           * plain surface read.
           *
           * A mullion only where there is width for one. Two panes 20cm
           * apart is a window; two panes 8cm apart is a smear at 40% render
           * scale, which is this repo's standing rule about anything under
           * ~5cm.
           */
          const fr = 0.075
          const bars: [number, number, number, number][] = [
            [0, ph / 2 + fr / 2, pw + fr * 2, fr],
            [0, -ph / 2 - fr / 2, pw + fr * 2, fr],
            [-pw / 2 - fr / 2, 0, fr, ph],
            [pw / 2 + fr / 2, 0, fr, ph],
            [0, 0, pw, fr],
          ]
          if (pw > 0.62) bars.push([0, 0, fr, ph])
          for (const [bx2, by2, bw2, bh2] of bars) {
            const bar = new THREE.BoxGeometry(
              acrossZ ? bw2 : 0.09, bh2, acrossZ ? 0.09 : bw2)
            localToWorld(bar,
              px + (acrossZ ? bx2 : 0), cy + by2, pz + (acrossZ ? 0 : bx2),
              leanX, leanZ, rotationY, wx, wy, wz)
            ornamentBatch.addPositioned(bar, glassStone)
          }
          if (!facePaned) {
            pane.computeBoundingBox()
            const pb = pane.boundingBox
            if (pb) {
              siteOf('stainedGlass', (pb.min.x + pb.max.x) / 2,
                (pb.min.y + pb.max.y) / 2, (pb.min.z + pb.max.z) / 2,
                pb.max.x - pb.min.x, pb.max.y - pb.min.y, pb.max.z - pb.min.z)
            }
            facePaned = true
          }
          glassed++
        }
      }
      // ONLY IF ONE WAS ACTUALLY BUILT — a census that counts the attempt is
      // the counter-before-the-work failure already on the record here.
      if (glassed) tallyIn('stainedGlass', district)
      else tallyIn('stainedGlass~noOpenings', district)
    }

    /**
     * === THE GREAT ROSE WINDOW — on the GABLE, which is where it fits ===
     *
     * The stained glass above records why this could not go on the nave WALL:
     * `facadeOpenings` lays storeys from the ground up at their true height,
     * so the clear band above the top row is under a metre and a three-metre
     * disc could only sit on top of painted windows. The note ended "if it is
     * wanted, it needs the GABLE above the eaves", and that turns out to be
     * both true and free.
     *
     * `roofAxisFor` returns 'x' whenever w >= d, and a cathedral is DEEPER
     * than it is wide — so its ridge runs along Z and its gable ends are the
     * +Z and -Z faces. The front of the building is a gable end. That is the
     * west front, which is exactly where a rose window goes, and nothing had
     * to be arranged for it: the massing already produces the shape.
     *
     * THE SIZE IS BOUNDED BY THE TRIANGLE AND NOTHING ELSE. At height y up a
     * gable of half-base b and height h, the available half-width is
     * b*(1 - y/h) — so the disc is inscribed rather than guessed, and the
     * binding constraint at mid-height is the EAVE below it rather than the
     * slopes beside it. That is containment with nothing to tune, the same
     * discipline that sized the great clock per face.
     */
    if (STAINED_GLASS_TYPES.has(obj.definitionId) &&
        (mainVol.roofStyle === 'gabled' || mainVol.roofStyle === 'steep')) {
      const eaveP = eaveProjFor(mainVol.roofStyle)
      const alongX = mainVol.roofAxis === 'x'
      // The gable ends are at +/-(halfExtent + eaveProj) ALONG THE RIDGE —
      // `buildGablePrism` puts the ridge endpoints there, which is the one
      // place this is stated unambiguously. Reasoning about it got the
      // chandlery's hoist beam onto the wrong face once already.
      const halfAlong = (alongX ? mainVol.width : mainVol.depth) / 2 + eaveP
      const b = (alongX ? mainVol.depth : mainVol.width) / 2 + eaveP
      const h = mainVol.roofHeight
      const baseY = mainVol.bottomY + mainVol.height
      const cy = baseY + h * 0.50
      // Inscribed: the slopes on either side, and the eave below.
      const outer = Math.min(b * 0.50 * 0.85, h * 0.40)
      if (outer < 0.80) tallyIn('roseWindow~gableTooSmall', district)
      else {
        const rimT = Math.max(0.14, outer * 0.13)
        const dark = shiftColor(palette.wall, -0.32, -0.30, -0.26)
        const tint = GLASS_TINTS[hash % GLASS_TINTS.length]
        const push = (g: THREE.BufferGeometry, lx: number, ly: number,
          lz: number, col: number): void => {
          localToWorld(g, lx, ly, lz, leanX, leanZ, rotationY, wx, wy, wz)
          ornamentBatch.addPositioned(g, col)
        }
        let roseLogged = false
        for (const sgn of [1, -1]) {
          const px = alongX ? sgn * halfAlong : mainVol.offsetX
          const pz = alongX ? mainVol.offsetZ : sgn * halfAlong
          const out = (o: number): [number, number] => alongX
            ? [px + sgn * o, pz] : [px, pz + sgn * o]
          const face = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
            if (alongX) g.rotateZ(Math.PI / 2)
            else g.rotateX(Math.PI / 2)
            return g
          }
          // RIM — a dark ring, so the disc has an edge and its own shadow.
          // A glowing circle with no surround is the bare-rectangle failure
          // in the round.
          const [rx, rz] = out(0.10)
          push(face(new THREE.CylinderGeometry(outer, outer, rimT, 20)),
            rx, cy, rz, dark)
          // GLASS — proud of the rim's outer face, for the reason the clock
          // dial is: a disc embedded in its own surround is the surround.
          const [gx, gz] = out(0.10 + rimT * 0.55)
          const glass = face(new THREE.CylinderGeometry(
            outer - rimT, outer - rimT, 0.07, 20))
          localToWorld(glass, gx, cy, gz, leanX, leanZ, rotationY, wx, wy, wz)
          addBeacon(glass, tint)
          // TRACERY — eight radial bars and a boss. This is what makes it a
          // ROSE rather than a porthole, and it is the same argument as the
          // clock's hands: the division is the recognition.
          // SHORT OF THE GLASS EDGE, AND BARELY PROUD OF IT. At 1.95 of the
          // radius the bars reach the rim, and because they stand a few
          // centimetres in front of the disc, an oblique view — which is
          // every street view of a gable — projects their ends OUTSIDE its
          // silhouette and they read as spikes round the wheel. Stopping them
          // at 1.68 leaves a ring of plain glass the tracery dies into, which
          // is what a real wheel window has.
          const [tx, tz] = out(0.10 + rimT * 0.55 + 0.02)
          for (let k = 0; k < 8; k++) {
            const ang = (k / 8) * Math.PI
            const bar = new THREE.BoxGeometry(0.09, (outer - rimT) * 1.68, 0.07)
            if (alongX) { bar.rotateX(ang); bar.rotateZ(Math.PI / 2) }
            else { bar.rotateZ(ang) }
            push(bar, tx, cy, tz, dark)
          }
          push(face(new THREE.CylinderGeometry(outer * 0.17, outer * 0.17, 0.09, 10)),
            tx, cy, tz, dark)
          if (!roseLogged) {
            const rm = new THREE.BoxGeometry(outer * 2, outer * 2, outer * 2)
            localToWorld(rm, gx, cy, gz, leanX, leanZ, rotationY, wx, wy, wz)
            rm.computeBoundingBox()
            const rb = rm.boundingBox
            if (rb) {
              siteOf('roseWindow', (rb.min.x + rb.max.x) / 2,
                (rb.min.y + rb.max.y) / 2, (rb.min.z + rb.max.z) / 2,
                rb.max.x - rb.min.x, rb.max.y - rb.min.y, rb.max.z - rb.min.z)
            }
            rm.dispose()
            roseLogged = true
          }
        }
        tallyIn('roseWindow', district)
      }
    }

    // === COLONNADE → batched ===
    // Pulled through localToWorld with leanX/Z=0 (landmark buildings opt
    // out of lean) but yaw applied so columns land on the rotated +Z face.
    if ((obj.definitionId === 'temple' || obj.definitionId === 'cathedral' || obj.definitionId === 'guild_hall') && fpT.w >= 4) {
      tallyIn('colonnade', district)
      siteOf('colonnade', wx, wy + 2.0, wz)
      const colH = wallH * 0.85
      // Clamped to a portico's worth. Spacing off the real wall width means a
      // 15m temple facade would otherwise take twelve columns at 1.2m centres,
      // which is a fence, not a colonnade — and twelve cylinders per landmark
      // is real geometry for something nobody reads as more detailed.
      const numCols = Math.max(3, Math.min(8, Math.round(mainVol.width / 1.9)))
      const spacing = mainVol.width / (numCols + 1)
      // Column girth follows the order rather than staying at a fixed 17cm,
      // which reads as scaffolding poles once the facade is metres wide.
      const colR = Math.min(0.34, Math.max(0.12, spacing * 0.22))
      for (let ci = 1; ci <= numCols; ci++) {
        const cg = new THREE.CylinderGeometry(colR * 0.85, colR, colH, 7)
        const colLocalX = -frontWallHalfW + ci * spacing
        localToWorld(cg, colLocalX, colH / 2, frontWallZ + 0.25,
          0, 0, rotationY, wx, wy, wz)
        detailBatch.addPositioned(cg, 0xc0b8a8)
        // A THIRD GRID ON THE SAME WALL. Columns sit at mainVol.width /
        // (numCols + 1) — about a 1.9m pitch — while facadeOpenings paints on
        // ~2.4m, so the colonnade beats against the windows exactly as the
        // studs did, and a column is 24-68cm thick against a stud's 8cm.
        recordPart(obj.id, obj.definitionId, volKey(mainVol), 'column',
          colLocalX - mainVol.offsetX, colH / 2 - mainVol.bottomY,
          colR * 2, colH)
      }
      const bg = new THREE.BoxGeometry(mainVol.width + 0.2, 0.12, 0.25)
      localToWorld(bg, 0, colH + 0.06, frontWallZ + 0.25,
        0, 0, rotationY, wx, wy, wz)
      detailBatch.addPositioned(bg, 0xc0b8a8)
      recordPart(obj.id, obj.definitionId, volKey(mainVol), 'entablature',
        -mainVol.offsetX, colH + 0.06 - mainVol.bottomY, mainVol.width + 0.2, 0.12)
    }

    // === BALCONY → batched ===
    // Lean+yaw transformed via localToWorld so the balcony stays attached to
    // the (possibly leaning) wall.
    // A balcony belongs to a STREET as much as to a building type. Gated on
    // balcony_house and inn alone it fired ONCE in 525 buildings — a feature
    // with a building type named after it that essentially never appeared.
    // DESIGN.md asks for exactly this: the Lisbon/Porto "500 years of organic
    // growth" read, and pillar 2's rule that the eye should never be able to
    // copy-paste one silhouette onto another. Balconies are one of the
    // cheapest ways to break a terrace up.
    const wantsBalcony = floors >= 2 && !isLandmark && !mainVol.circular &&
      !NO_JITTER.has(obj.definitionId) && (
        obj.definitionId === 'balcony_house' || obj.definitionId === 'inn' ||
        ((district === 'noble' || district === 'market' || district === 'residential' ||
          district === 'waterfront' || district === 'harbor') &&
         rand01(hash, 1487) < (district === 'noble' ? 0.34 : 0.16)))
    if (wantsBalcony) {
      tallyIn('balcony', district)
      const balcW = mainVol.width * 0.5, balcD = 0.4
      const balcY = FLOOR_HEIGHT * 1.1 * heightMult
      const pg = new THREE.BoxGeometry(balcW, 0.06, balcD)
      localToWorld(pg, 0, balcY, frontWallZ + balcD / 2,
        leanX, leanZ, rotationY, wx, wy, wz)
      detailBatch.addPositioned(pg, 0x705a40)
      // balcY is FLOOR_HEIGHT * 1.1 * heightMult, and heightMult is not a
      // quantity facadeOpenings knows about — so the slab and its rail can
      // land across the first-floor glazing on a building whose multiplier
      // runs high. Recorded as one band, slab through rail top.
      recordPart(obj.id, obj.definitionId, volKey(mainVol), 'balcony',
        -mainVol.offsetX, balcY + 0.11 - mainVol.bottomY, balcW, 0.34)
      const rg = new THREE.BoxGeometry(balcW, 0.25, 0.04)
      localToWorld(rg, 0, balcY + 0.15, frontWallZ + balcD,
        leanX, leanZ, rotationY, wx, wy, wz)
      detailBatch.addPositioned(rg, 0x705a40)
      for (const side of [-balcW * 0.35, balcW * 0.35]) {
        const bg = new THREE.BoxGeometry(0.06, 0.2, balcD * 0.7)
        localToWorld(bg, side, balcY - 0.1, frontWallZ + balcD * 0.4,
          leanX, leanZ, rotationY, wx, wy, wz)
        detailBatch.addPositioned(bg, 0x705a40)
      }
    }

    // (Per-volume cornice is emitted inside emitVolume; nothing further
    // needed here. Style-driven roof dormers and window trim are deferred
    // until camera angle / render scale let them read visibly.)
      succeeded++
    } catch (err) {
      // Capture per-building errors so a single bad building doesn't
      // prevent the rest of the town from rendering. Surface them via
      // diagnostics so debug-dump exports include them.
      failed++
      if (failures.length < FAILURE_LOG_CAP) {
        const e = err as { message?: string; stack?: string }
        const dist = (obj.properties.district as string) || 'unknown'
        failures.push({
          objectId: obj.id,
          definitionId: obj.definitionId,
          district: dist,
          hash: stableHash(obj),
          message: e?.message || String(err),
          stack: e?.stack,
        })
        // eslint-disable-next-line no-console
        console.error(`[BuildingFactory] Skipped building ${obj.id} (${obj.definitionId}, ${dist}): ${e?.message || err}`)
      } else if (failures.length === FAILURE_LOG_CAP) {
        // Marker entry once we hit the cap so the dump shows we stopped collecting.
        failures.push({
          objectId: '<truncated>',
          definitionId: '<truncated>',
          district: '<truncated>',
          hash: 0,
          message: `Reached cap of ${FAILURE_LOG_CAP}; further per-building errors suppressed.`,
        })
      }
    }
  }

  // Build batched meshes — track which merges returned null (typically
  // means input geometries had inconsistent indexed/non-indexed status).
  const ornamentFragments = roofBatch.count + detailBatch.count + ornamentBatch.count
  const batched: THREE.Mesh[] = []
  const roofMesh = roofBatch.build()
  if (roofMesh) batched.push(roofMesh)
  const detailMesh = detailBatch.build()
  if (detailMesh) batched.push(detailMesh)
  // ONE INSTANCED DRAW FOR EVERY VANE IN TOWN. Built here rather than in the
  // prop pass because the vanes are emitted by the roof-ornament code and this
  // is where that pass is drained.
  const vaneMesh = buildVaneMesh()
  if (vaneMesh) batched.push(vaneMesh)
  const clockMesh = buildClockMesh()
  if (clockMesh) batched.push(clockMesh)
  const bannerMesh = buildBannerMesh()
  if (bannerMesh) batched.push(bannerMesh)
  const ornamentMesh = ornamentBatch.build()
  if (ornamentMesh) {
    // Ornaments are thin geometry — self-shadowing acne under CSM looks
    // worse than the silhouette-depth gain, so disable casting. Still receive.
    ornamentMesh.castShadow = false
    ornamentMesh.receiveShadow = true
    batched.push(ornamentMesh)
  }
  if (!roofMesh && roofBatch.count > 0) {
    console.error(`[BuildingFactory] roofBatch.build() returned null with ${roofBatch.count} fragments — likely mixed indexed/non-indexed geometries.`)
  }
  if (!ornamentMesh && ornamentBatch.count > 0) {
    console.error(`[BuildingFactory] ornamentBatch.build() returned null with ${ornamentBatch.count} fragments.`)
  }
  if (!detailMesh && detailBatch.count > 0) {
    console.error(`[BuildingFactory] detailBatch.build() returned null with ${detailBatch.count} fragments.`)
  }

  const wallsBefore = wallMeshes.length
  // Coalesce walls sharing the same material array into merged meshes.
  // Most walls land in a small number of material groups (because
  // _wallMatCache returns the same instance for same-config buildings),
  // so we can collapse 200+ individual wall meshes into ~30-50 merged
  // meshes — one per unique material array. Huge draw-call win,
  // especially in the shadow pass.
  const mergedWalls = coalesceWalls(wallMeshes)
  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now())

  _lastDiagnostics = {
    attempted, succeeded, failed, failures,
    batchedMeshCounts: {
      roof: roofMesh ? 1 : (roofBatch.count > 0 ? null : 0),
      detail: detailMesh ? 1 : (detailBatch.count > 0 ? null : 0),
      ornament: ornamentMesh ? 1 : (ornamentBatch.count > 0 ? null : 0),
    },
    wallMeshesBeforeCoalesce: wallsBefore,
    wallMeshesAfterCoalesce: mergedWalls.length,
    totalMs: t1 - t0,
    ornamentFragments,
    roofStyles,
    flatToppedTallVolumes,
    flatTopBy,
    scaleSamples,
    featureCounts,
    featureSites,
  }
  if (failed > 0) {
    console.error(`[BuildingFactory] ${failed} of ${attempted} buildings failed to emit (succeeded=${succeeded}). See getBuildingDiagnostics() for details.`)
  }

  setBuildEnvelope(null)
  return { wallMeshes: mergedWalls, batched, tops }
}

/**
 * Merge wall meshes that share the same material array into single meshes
 * with baked world transforms. BoxGeometry-based walls merge cleanly
 * (same group layout: 6 groups, one per face). Cylinder-based (circular
 * tower) walls stay separate since they use a different geometry topology.
 */
function coalesceWalls(wallMeshes: THREE.Mesh[]): THREE.Mesh[] {
  type Key = THREE.Material | THREE.Material[] | null
  // Bucket by (material, castShadow): walls that differ on castShadow must
  // stay separate because castShadow is a per-mesh flag. If we merged them
  // the combined mesh would inherit only one setting and either bloat the
  // shadow pass (merge downcast to "true") or lose wanted silhouettes
  // (merge downcast to "false").
  const groups = new Map<string, { key: Key; casts: boolean; meshes: THREE.Mesh[] }>()
  const loose: THREE.Mesh[] = []
  const keyOf = (m: THREE.Material | THREE.Material[], casts: boolean): string => {
    const mat = Array.isArray(m) ? m.map(x => x.uuid).join('|') : m.uuid
    return `${mat}#${casts ? 1 : 0}`
  }
  for (const mesh of wallMeshes) {
    // Only merge BoxGeometry walls — cylinders use different topology.
    if (!(mesh.geometry instanceof THREE.BoxGeometry)) { loose.push(mesh); continue }
    const casts = mesh.castShadow
    const k = keyOf(mesh.material as THREE.Material | THREE.Material[], casts)
    let bucket = groups.get(k)
    if (!bucket) {
      bucket = { key: mesh.material as Key, casts, meshes: [] }
      groups.set(k, bucket)
    }
    bucket.meshes.push(mesh)
  }
  const result: THREE.Mesh[] = []
  // Loose meshes (cylinder walls + singleton boxes that couldn't merge)
  // get matrixAutoUpdate=false so Three.js doesn't recompute their world
  // matrix every frame. Their geometry is pre-baked at world position via
  // localToWorld in emitVolume; the mesh transform is identity. Avoiding
  // per-frame matrix recomputation on hundreds of static wall meshes is
  // a free perf win.
  for (const m of loose) {
    m.matrixAutoUpdate = false
    m.updateMatrix()
    result.push(m)
  }
  for (const { key, casts, meshes } of groups.values()) {
    // Even 2-mesh groups are worth merging — one less draw call each,
    // and the shadow pass benefits too. Only singletons stay loose.
    if (meshes.length < 2) {
      for (const m of meshes) {
        m.matrixAutoUpdate = false
        m.updateMatrix()
        result.push(m)
      }
      continue
    }
    // Bake each mesh's world transform into its geometry, then merge.
    // All geometries have the same group layout since they're all BoxGeometry
    // so mergeGeometries can combine them preserving per-face material indices.
    const geos: THREE.BufferGeometry[] = []
    for (const m of meshes) {
      m.updateMatrix()
      const g = m.geometry.clone()
      g.applyMatrix4(m.matrix)
      geos.push(g)
    }
    const merged = mergeGeometries(geos, true)
    if (!merged) { result.push(...meshes); continue }
    const out = new THREE.Mesh(merged, key as THREE.Material | THREE.Material[])
    out.matrixAutoUpdate = false
    out.updateMatrix()
    out.castShadow = casts
    out.receiveShadow = true
    // Dispose the cloned geometries; the source meshes will be dropped.
    for (const g of geos) g.dispose()
    for (const m of meshes) m.geometry.dispose()
    result.push(out)
  }
  return result
}
