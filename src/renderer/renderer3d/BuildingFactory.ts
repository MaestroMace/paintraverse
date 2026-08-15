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
import { BatchedMeshBuilder, setBuildEnvelope } from './BatchedMeshBuilder'
import { buildingStyleVector, pickArchetypes } from './architecture'
import type { DistrictId } from './architecture'
import { pickMassing, volumeFloors } from './architecture/Massing'
import { gableMath } from './architecture/Roofs'
import { emitVolume, localToWorld, shiftColor, setWallEmissiveIntensity as setVolumeEmissiveIntensity } from './architecture/VolumeRenderer'
import { pickPaletteForStyle } from './architecture/PaletteBias'
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

function simpleHash(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0
  return Math.abs(h)
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
}

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
  /** Street-dressing features that are gated behind district/type rules. */
  featureCounts: Record<string, number>
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
  /** Painted opening sizes on the finished wall, world metres. */
  doorH: number
  doorW: number
  windowH: number
  windowW: number
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
  featureCounts: {},
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
  const roofStyles: Record<string, number> = {}
  const scaleSamples: BuildingScale[] = []
  const featureCounts: Record<string, number> = {}
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
  const roofBatch = new BatchedMeshBuilder()
  const detailBatch = new BatchedMeshBuilder()
  const ornamentBatch = new BatchedMeshBuilder()

  // Reset diagnostics for this run.
  const failures: BuildingDiagnostics['failures'] = []
  let attempted = 0, succeeded = 0, failed = 0

  for (const obj of objects) {
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
    const hash = simpleHash(obj.id)
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

    // Foundation plinth — emitted as per-tile stone columns so the foundation
    // STEPS with the terrain rather than sitting as one flat block. Each
    // footprint tile gets its own column from that tile's ground up to the
    // building's base (maxTH). Tiles already at maxTH get no column.
    // Columns overlap slightly (1.08 vs 1.0) so interior seams don't z-fight
    // and outer edges extend past the wall face, matching the old plinth's
    // +0.06 overhang on each side.
    if (getHeight && maxTH - minTH > 0.08) {
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
        }
      }
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
      wallColor: palette.wall, roofColor: palette.roof,
    })

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
        if (v.role === 'mainBody' || v.role === 'upperFloor') {
          v.height = Math.max(v.height, STOREY_HEIGHT)
        }
      }
    }

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

    const emitCtx = {
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
    let apexLocalY = 0
    for (const v of massing.volumes) {
      const t = v.bottomY + v.height + v.roofHeight
      if (t > apexLocalY) apexLocalY = t
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
      if (isFlatTop && !covered && v.height >= 2.0) flatToppedTallVolumes++
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
        doorH: 2.05,
        doorW: 0.95,
        windowH: 1.35,
        windowW: 1.0,
      })
    }

    tops.push({
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
          if (bays >= 2) {
            const step = (v.width - postT) / bays
            for (let b = 1; b < bays; b++) {
              const studX = v.offsetX - (v.width - postT) / 2 + b * step
              for (const sz of [-1, 1]) {
                const stud = new THREE.BoxGeometry(studT, postH, studDepth)
                stud.translate(0, postH / 2, 0)
                localToWorld(stud, studX, baseLocalY,
                  v.offsetZ + sz * seatZ(studDepth),
                  leanX, leanZ, rotationY, wx, wy, wz)
                ornamentBatch.addPositioned(stud, 0x3a2418)
              }
            }
          }

          // Head-plate beam across the front+back of this volume just below
          // the cornice. Skip if a heavy cornice will paint over it.
          const beamY = baseLocalY + postH - 0.08 - postT / 2
          const beamCovered = v.cornice && (v.role === 'tower' || v.role === 'spire')
          if (!beamCovered) {
            const beamProj = postT * 0.45
            for (const sz of [-1, 1]) {
              const beam = new THREE.BoxGeometry(v.width, 0.10, beamProj)
              localToWorld(beam, v.offsetX, beamY, v.offsetZ + sz * seatZ(beamProj),
                leanX, leanZ, rotationY, wx, wy, wz)
              ornamentBatch.addPositioned(beam, 0x3a2418)
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
            for (let f = 1; f < volFloors; f++) {
              const flBeamY = baseLocalY + f * floorH
              for (const sz of [-1, 1]) {
                const fl = new THREE.BoxGeometry(v.width, flBeamH, flBeamProj)
                localToWorld(fl, v.offsetX, flBeamY, v.offsetZ + sz * seatZ(flBeamProj),
                  leanX, leanZ, rotationY, wx, wy, wz)
                ornamentBatch.addPositioned(fl, 0x3a2418)
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

    // --- FLANK BUTTRESSES → batched ---
    // A tall stone flank wants visible support, and a pair of buttresses is
    // the cheapest thing that turns a blank side elevation into a rhythm of
    // light and shadow — which is what a flank actually lacks. Stone and
    // temple/noble buildings only; a timber row house would not have them.
    const buttressSides: number[] = []
    for (const s of [-1, 1]) if (sideRoom(s) >= 0.34) buttressSides.push(s)
    const wantsButtress = !mainVol.circular && buttressSides.length > 0 &&
      mainWallH > 5.2 && mainVol.depth >= 2.6 &&
      (district === 'temple' || district === 'noble' || district === 'fortress' ||
       isLandmark || styleVector.wealth > 0.72) &&
      rand01(hash, 1411) < 0.66
    if (wantsButtress) {
      tallyIn('buttress', district)
      const bColor = shiftColor(palette.wall, -0.08, -0.07, -0.06)
      for (const s of buttressSides) {
        // 0.06 of headroom, because the sloped cap below reaches further out
        // in X than the pier does once it is tilted.
        const proj = Math.min(0.38, sideRoom(s) - 0.06)
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
    // that list has already applied the buttress's STRICTER 0.34 test, so
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
      // Banner: a thin rectangle attached to the pole's upper portion,
      // angled out from the pole as if blowing in the wind. Build at
      // origin, translate so its inner edge is at the pole, rotate by a
      // hash-determined yaw so banners on different buildings flap in
      // different directions.
      const bannerW = 0.65, bannerH = 0.45, bannerT = 0.025
      const bannerYaw = rand01(hash, 1607) * Math.PI * 2
      const banner = new THREE.BoxGeometry(bannerW, bannerH, bannerT)
      banner.translate(bannerW / 2, 0, 0)              // inner edge at origin
      banner.rotateY(bannerYaw)
      // Banner color from a small heraldic palette: deep red, midnight blue,
      // forest green, royal purple, gold ochre.
      const bannerColors = [0x8e2424, 0x2a3a72, 0x2e5a32, 0x4a2a5e, 0xa07020]
      const bannerColor = bannerColors[hash % bannerColors.length]
      localToWorld(banner, poleLocalX, poleBaseY + poleH * 0.78, poleLocalZ,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(banner, bannerColor)
      // A small triangular tail at the banner's free edge — adds the
      // "split-tail" pennant silhouette. Approximated as a thin sliver.
      const tailW = 0.12
      const tail = new THREE.BoxGeometry(tailW, bannerH * 0.6, bannerT)
      tail.translate(bannerW + tailW / 2 - 0.02, 0, 0)
      tail.rotateY(bannerYaw)
      localToWorld(tail, poleLocalX, poleBaseY + poleH * 0.78, poleLocalZ,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(tail, bannerColor)
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
    if (fpT.w >= 2) {
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
    const wantsHitching = (obj.definitionId === 'tavern' || obj.definitionId === 'inn' ||
      obj.definitionId === 'stable') &&
      district !== 'market' &&
      rand01(hash, 1201) < 0.7 && fpT.w >= 3
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
    ) && !mainVol.circular && fpT.w >= 3 &&
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
      styleVector.weather > 0.55 &&
      rand01(hash, 1801) < 0.55
    if (wantsRoofMoss) {
      tallyIn('roofMoss', district)
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
    const isTradeBldg = (
      obj.definitionId === 'shop' || obj.definitionId === 'tavern' ||
      obj.definitionId === 'inn' || obj.definitionId === 'bakery' ||
      obj.definitionId === 'apothecary' || obj.definitionId === 'guild_hall' ||
      obj.definitionId === 'covered_market'
    )
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
      const awningY = Math.min(2.0, FLOOR_HEIGHT * 0.95)
      const awningW = Math.min(2.6, frontWallHalfW * 1.1)
      const awningD = 0.55
      // Front-edge dip so the awning slopes downward away from the wall.
      const slopeRot = -0.12  // ~7° down at front edge
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
        localToWorld(stripGeo, stripX, awningY, frontWallZ,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(stripGeo, stripColor)
      }
      // Two simple vertical posts at the front corners — implies tied-down canvas.
      // Post top must clear the awning's sloped underside at the post's Z. The
      // awning's local Z (relative to its translate) at the post is awningD-0.04
      // ≈ 0.51. After rotateX(slopeRot), that point's Y is z' * sin(-slopeRot)
      // below the awning's reference plane (slopeRot is negative so sin gives
      // a small positive drop). Subtract another half-thickness for the
      // bottom face, then ~3cm of headroom.
      const postZRel = awningD - 0.04
      const postZ = frontWallZ + postZRel
      const awningBottomDrop = postZRel * Math.sin(-slopeRot) + 0.02
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

    // === COLONNADE → batched ===
    // Pulled through localToWorld with leanX/Z=0 (landmark buildings opt
    // out of lean) but yaw applied so columns land on the rotated +Z face.
    if ((obj.definitionId === 'temple' || obj.definitionId === 'cathedral' || obj.definitionId === 'guild_hall') && fpT.w >= 4) {
      tallyIn('colonnade', district)
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
      }
      const bg = new THREE.BoxGeometry(mainVol.width + 0.2, 0.12, 0.25)
      localToWorld(bg, 0, colH + 0.06, frontWallZ + 0.25,
        0, 0, rotationY, wx, wy, wz)
      detailBatch.addPositioned(bg, 0xc0b8a8)
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
          hash: simpleHash(obj.id),
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
    scaleSamples,
    featureCounts,
  }
  if (failed > 0) {
    console.error(`[BuildingFactory] ${failed} of ${attempted} buildings failed to emit (succeeded=${succeeded}). See getBuildingDiagnostics() for details.`)
  }

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
