/**
 * LanternStrings — the iconic Traverse Town overhead chains of small
 * glowing lanterns strung between buildings above the street. Runs after
 * building placement in ThreeRenderer.loadMap, picks pairs of close
 * buildings, emits a sagging rope between their midpoints + a few warm
 * lanterns hanging from the rope.
 *
 * The rope + lantern materials are module-level singletons so a single
 * setLanternEmissiveIntensity() call can dim or brighten every lantern
 * in the scene — same day/night modulation as the window emissive.
 */

import * as THREE from 'three'
import type { MapDocument, ObjectDefinition } from '../core/types'
import { stableHash, DWELLING_TYPES } from '../core/types'
import { getTerrainHeight } from './TerrainMesh'
import { BatchedMeshBuilder } from './BatchedMeshBuilder'
import { buildLampPoolTexture } from './PropFactory'
import type { BuildingTop } from './BuildingFactory'
import { TILE } from './scale'

// Fallback hang height above ground, used only when a building's real roof
// height isn't available. Buildings are 2-4 floors at 1.8m, so a fixed 3.2m
// above the GROUND sat below most rooflines — the ropes ran straight through
// the buildings they were strung between and poked out of the walls as stray
// dark planks. Real eave heights are passed in now; see buildLanternStrings.
const HANG_HEIGHT = 3.2
// Clearance above the higher of the two eaves, so the rope crosses the gap
// overhead instead of intersecting either roof.
const EAVE_CLEARANCE = 0.55
// How far the rope's middle sags below a straight line between endpoints.
const SAG = 0.35
// Segments per string (more = smoother catenary).
const SEGMENTS = 10
// How many lanterns per string, evenly spaced along t ∈ (0,1).
const LANTERN_COUNT = 3
// Limit on total strings per map — performance bound.
const MAX_STRINGS = 25
// Pair filter: accept when building centers are this far apart in XZ. The
// centres are world positions, so these are metres — the tuned values were
// 2.6-5.0 TILES, which is what the factor preserves. Without it the filter
// would only ever match buildings closer than two tiles and no string would
// span a street, which is the entire point of them.
const MIN_DIST = 2.6 * TILE
const MAX_DIST = 5.0 * TILE
// Rope sag and lantern drop scale with the span, not with a fixed number of
// world units, or a 15m string hangs as taut as a 8m one.
const SAG_FRACTION = 0.045

// === WASHING STRUNG BETWEEN UPPER WINDOWS ===================================
//
// A second payload on the SAME pairing pass rather than a second pass. The
// pairing is the expensive and delicate part of this file — distance filter,
// per-building usage budget, and the endpoint pull-in that stops a rope being
// buried inside the two buildings it connects — and duplicating it for a
// visually different string is precisely how the three terrain tables and the
// three dwelling sets came to disagree. One loop, one usage budget, two
// payloads.
//
// Three of DESIGN.md's four visual references put this in frame: Gion's
// alleys, Diagon Alley's lived-in terraces, and the Marais/Lisbon "500 years
// of organic growth" read. It is also the cheapest possible answer to the
// open note that ground-level life is thin, because it fills the volume of
// air over the street, which nothing currently occupies below the lantern
// ropes and above the props.
//
// A washing line hangs BELOW the eaves, between upper-storey windows, where a
// lantern chain hangs above them — that inversion is most of what makes it
// read as laundry rather than as bunting.
// PINNED TO THE WINDOW, NOT SUBTRACTED FROM THE EAVE.
//
// The first cut hung the line a fixed 1.7m below the lower eave and then
// required head clearance, and the pair of rules quietly became a HEIGHT
// FILTER: `min(eave) - 1.7 >= ground + 4.2` can only be satisfied by
// buildings almost six metres tall, so the washing selected the tallest pairs
// in town and measured out at 8-17m — above most of the rooflines it was
// meant to hang between. A test that rejects the short case does not adapt to
// it, and the same arithmetic that makes it clear the street makes it climb.
//
// A washing line is at the upper-storey window, which is a physical height: a
// 2.9m storey plus a 0.95m sill plus most of a 1.35m window. So measure UP
// from the ground and clamp DOWN to the eave, rather than the reverse.
const LAUNDRY_HEIGHT = 5.0
// Kept below the eaves so the line is between windows and not draped over the
// gutter.
const LAUNDRY_EAVE_GAP = 0.6
// Nothing may hang into head height. Measured from the HIGHER of the two
// grounds, because the street between two buildings on a slope is only as
// generous as its high end.
const LAUNDRY_MIN_CLEAR = 4.2
// Garment spacing along the line, and the cap that keeps a long span from
// turning into a solid curtain.
const GARMENT_PITCH = 0.8
const MAX_GARMENTS = 14
// Sun-faded domestic cloth. Deliberately light: at dusk these are seen
// against a warm sky and the whole point is the silhouette gap they punch in
// a dark roofline. Nothing here is emissive — a glowing bedsheet reads as a
// bug, and pillar 5's three light layers are already accounted for.
const CLOTH_COLORS = [0xe8e2d4, 0xc9d6df, 0xc78d7c, 0xb9b5ac, 0xd9c48f, 0xa8b79c]

const _lanternMat = new THREE.MeshLambertMaterial({
  color: 0xffcc44,
  emissive: 0xffa040,
  emissiveIntensity: 0,
  flatShading: true,
})
const _ropeMat = new THREE.MeshLambertMaterial({
  color: 0x2a1f16,
  flatShading: true,
})

/** Base intensity set by updateLighting on time-of-day change. Per-frame
 *  flicker multiplies this in tickLanternEmissive(). */
let _lanternBase = 0
export function setLanternEmissiveIntensity(intensity: number): void {
  _lanternBase = intensity
  _lanternMat.emissiveIntensity = intensity
}
/** Per-frame lantern flicker — slower + gentler than window flicker so
 *  lanterns read as a steadier outdoor light source. Single phase for
 *  the whole shared material (all lanterns pulse together subtly,
 *  rather than buzzing independently). */
export function tickLanternEmissive(time: number): void {
  if (_lanternBase <= 0) {
    _lanternMat.emissiveIntensity = 0
    return
  }
  const flicker = 1 + 0.05 * Math.sin(time * 1.7)
  _lanternMat.emissiveIntensity = _lanternBase * flicker
}

/**
 * WHERE THE LANTERNS ARE, so something can be drawn to them.
 *
 * A flame at dusk gathers moths, and nothing could put one anywhere near a
 * lantern because no caller knew where a lantern IS: both builders here
 * merge their bulbs straight into one batched mesh and return the mesh,
 * which is the right thing for drawing and useless for attaching. That is
 * the anchor failure this repo keeps paying for — `PlacedObject.footprint`
 * unblocked four failed plot attempts, `BuildingTop` unblocked the particle
 * systems, `frontWallZ` unblocked every front-attached detail. When a whole
 * category of work keeps not happening, look for the handle it would need.
 *
 * The three families are collected TOGETHER on purpose. There are three
 * kinds of lantern in this town — a lamppost bulb at ~3.2m, a wall bracket
 * at 2.4m and a rope lantern overhead — and a feature aimed at "the
 * lanterns" that reaches one of them is the ghost with a type signature.
 * PropFactory pushes the lamppost family in; these two push their own.
 *
 * `r` is how far the moths may wander from the flame, which differs by
 * family: a rope lantern hangs in open air over a street and a wall
 * bracket has a wall immediately behind it.
 */
export type LampFamily = 'lamppost' | 'wall' | 'rope'
export interface LampAnchor {
  x: number; y: number; z: number
  r: number
  /** WHICH OF THE THREE, stated rather than inferred. `particles.mjs`
   *  censuses the families so a feature aimed at "the lanterns" that reaches
   *  two of three cannot read as healthy, and bucketing them by their radius
   *  would be a proxy that agrees with the families exactly until somebody
   *  retunes a radius. Prefer the exact test. */
  kind: LampFamily
}
export const lampAnchors: LampAnchor[] = []

/** Clear before a rebuild. Called by ThreeRenderer BEFORE any of the three
 *  producers run — at the top of the thing being rebuilt, not in the middle
 *  of it, which is the placeStats trap. */
export function resetLampAnchors(): void { lampAnchors.length = 0 }

/**
 * LIGHT SPILLING OUT OF THE WINDOWS ONTO THE STREET — pillar 5's fourth
 * layer, and the one that was missing.
 *
 * DESIGN.md names three layers of warm light and every one of them is a
 * SOURCE: a ground pool under a lamppost, a chain of lanterns overhead, a
 * bracket at eye level. What no layer did was let a lit window affect
 * anything outside itself. A row of warm rectangles floating on a wall that
 * receives none of their light is the tell, and it is why a near facade at
 * night reads as a black slab two metres from a glowing window — measured
 * while grading the moths and filed as "a large featureless black mass",
 * which turned out not to be a prop or a bug but exactly this.
 *
 * A BAND, NOT A DISC. A lamppost is a point source and pools in a circle; a
 * lit elevation is a LINE of windows and throws a strip along the foot of
 * its own wall, wide as the frontage and shallow away from it. Same radial
 * alpha, scaled unevenly — which is also why the texture is shared from
 * PropFactory rather than copied, since what a pool of light looks like is
 * one decision.
 *
 * Merged into ONE mesh over the whole town, like the lamp pools and for the
 * same reason: a couple of hundred additive quads is a couple of hundred
 * draw calls otherwise, and the phone is the machine that cares.
 */
const _spillTex = buildLampPoolTexture()
const _spillMat = new THREE.MeshBasicMaterial({
  color: 0xffc98a,
  // BOTH `map` AND `alphaMap`, which is what makes it a pool rather than a
  // painted rectangle. The first cut set the colour and forgot the texture
  // entirely — the export was added for exactly this and then not used — and
  // the photograph showed hard-edged pale quadrilaterals lying on the
  // cobbles, which is a decal and not light. The lamp pools have carried the
  // same pair since they stopped being teepees.
  map: _spillTex,
  alphaMap: _spillTex,
  transparent: true,
  opacity: 0,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
})

/** Driven from updateLighting off the SAME term as the window emissive, so
 *  the spill cannot outlive the light that casts it. A pool of warm light on
 *  the cobbles under dark windows at noon is worse than no pool at all. */
export function setWindowSpillOpacity(opacity: number): void {
  _spillMat.opacity = opacity
}

export function buildWindowSpill(
  tops: Map<string, BuildingTop>,
  groundYAtWorld: (x: number, z: number) => number,
): THREE.Mesh | null {
  const geos: THREE.BufferGeometry[] = []
  for (const t of tops.values()) {
    // Only a painted elevation has windows to spill from. `texturedVolumes`
    // is the same declaration `odd.mjs` reads for bare-wall area, so a
    // boundary wall, a bridge and a plain masonry shaft are excluded by the
    // fact rather than by a type list that would drift.
    if (!t.texturedVolumes) continue
    const sin = Math.sin(t.rotationY), cos = Math.cos(t.rotationY)
    // The front wall's outward normal is the building's local +Z.
    const out = t.halfD + 1.0
    const cx = t.centerX + sin * out
    const cz = t.centerZ + cos * out
    // Wide along the frontage, shallow away from it. Capped, because a long
    // warehouse elevation is not lit end to end and the alpha falls off
    // anyway — past about eight metres the band stops reading as spill and
    // starts reading as a painted stripe.
    const wide = Math.min(7.0, t.halfW * 2 + 1.4)
    const deep = 2.5
    const g = new THREE.PlaneGeometry(wide, deep)
    g.rotateX(-Math.PI / 2)
    g.rotateY(t.rotationY)
    // Hover clear of the paving by the same margin the lamp pools use, or it
    // z-fights the cobbles it is supposed to be lying on.
    g.translate(cx, groundYAtWorld(cx, cz) + 0.055, cz)
    geos.push(g)
  }
  if (!geos.length) return null
  const merged = mergeBufferGeos(geos)
  for (const g of geos) g.dispose()
  const mesh = new THREE.Mesh(merged, _spillMat)
  mesh.name = 'windowSpill'
  mesh.renderOrder = 2
  return mesh
}

export interface LanternStringsResult {
  ropeMesh: THREE.Mesh | null
  lanternMesh: THREE.Mesh | null
  wallLanternMesh: THREE.Mesh | null
  /**
   * Washing strung between upper windows. OPTIONAL on purpose: this interface
   * has four `return` sites and a previous session added a required field to
   * it and broke three of them, which is on the record in CLAUDE.md as a
   * typecheck failure that shipped. An optional field cannot repeat that, and
   * the consumer guards it anyway.
   */
  laundryMesh?: THREE.Mesh | null
}

/**
 * Wall-mounted lanterns — a single small emissive sphere + iron bracket
 * jutting from the front wall of ~18% of eligible buildings at ~2.4m
 * height. Adds eye-level warm points along streets that complement the
 * overhead rope lanterns. Shares the _lanternMat so one
 * setLanternEmissiveIntensity() call drives both systems.
 */
/**
 * How likely a building is to carry a lantern over its door.
 *
 * A lantern is ADVERTISING before it is lighting. An inn that is open says so
 * with a light; a shop trading after dark does the same; a gate lodge marks
 * the entrance it exists to mark; a chapel keeps a lamp at its door. A house
 * does it occasionally, because somebody is expected home.
 *
 * A flat rate across every type is the WALLPAPER failure — a number that
 * looks healthy and differentiates nothing — and this was 18% on everything.
 * The weighted rates below land within a point of that town-wide, so it is a
 * redistribution rather than more light.
 *
 * An id absent from the table gets DEFAULT, which is the house rate. That is
 * the safe direction for a missing entry: a new type gets an occasional
 * lantern rather than one on every instance.
 */
const LANTERN_DEFAULT = 0.12
const LANTERN_BY_TYPE: Readonly<Record<string, number>> = {
  // The light IS the trade sign.
  tavern: 0.9, inn: 0.9,
  // Shopfronts that trade into the evening.
  shop: 0.5, bakery: 0.5, apothecary: 0.5, cookshop: 0.6, shambles: 0.45,
  chandlery: 0.5, weigh_house: 0.45, covered_market: 0.5, market_stall: 0.4,
  workshop: 0.35, net_loft: 0.3, sail_loft: 0.3, smokehouse: 0.3,
  // Civic and threshold buildings: the lantern says "this is the way in".
  customs_house: 0.7, guild_hall: 0.6, gate_lodge: 0.85, guardhouse: 0.7,
  armory: 0.4, orangery: 0.3,
  // A lamp at a shrine or a churchyard door.
  chapel: 0.35, temple: 0.35, clergy_house: 0.3, mausoleum: 0.2,
  almshouse: 0.25, washhouse: 0.2,
  // Grand houses light their own doors more than a terrace does.
  mansion: 0.4, balcony_house: 0.2, coach_house: 0.25, building_large: 0.2,
}
const LANTERN_ODDS = (defId: string): number =>
  LANTERN_BY_TYPE[defId] ?? LANTERN_DEFAULT

export function buildWallLanterns(
  map: MapDocument,
  defMap: Map<string, ObjectDefinition>,
  heightMap: number[][] | null,
  /** Real per-building extents from BuildingFactory, keyed by object id.
   *  These carry where the WALL is; the footprint only says which tiles the
   *  generator reserved. */
  tops?: Map<string, BuildingTop>,
): THREE.Mesh | null {
  const structureLayer = map.layers.find(l => l.type === 'structure')
  if (!structureLayer) return null
  const EXCLUDE = new Set([
    'stone_wall', 'stone_wall_v', 'crenellated_wall',
    'archway', 'town_gate', 'gatehouse', 'staircase', 'aqueduct',
    'watchtower', 'cathedral', 'bell_tower', 'bell_tower_tall',
    'lighthouse', 'windmill',
  ])
  const lanternGeos: THREE.BufferGeometry[] = []
  for (const obj of structureLayer.objects) {
    if (EXCLUDE.has(obj.definitionId)) continue
    // A LANTERN GOES WHERE THERE IS A REASON FOR ONE.
    //
    // This was a flat 18% of every building, which is WALLPAPER by this
    // repo's own definition: a rate that is identical everywhere tells the
    // player nothing, reads as a healthy number, and differentiates no part
    // of the town from any other. DESIGN.md pillar 5 asks for three layers of
    // warm light; it does not ask for them to be sprinkled.
    //
    // A lantern over a door is ADVERTISING before it is lighting — an inn
    // that is open says so with a light, which is most of what an inn sign
    // meant before literacy was general. A shop does it when it trades late.
    // A gate lodge marks the entrance it exists to mark. A house does it
    // occasionally, because somebody is expected home.
    //
    // The town-wide rate lands within a point of the old 18%, so this is a
    // redistribution and not more light: the same lanterns, on the buildings
    // that have a reason for one.
    const h = stableHash(obj)
    if (h % 100 >= LANTERN_ODDS(obj.definitionId) * 100) continue
    const def = defMap.get(obj.definitionId)
    const fpT = def?.footprint ?? { w: 1, h: 1 }
    const ctx = obj.x + fpT.w / 2
    const ctz = obj.y + fpT.h / 2
    const groundY = heightMap ? getTerrainHeight(heightMap, ctx, ctz) : 0
    const mountY = groundY + 2.4

    // Where the wall IS, from the building that built it — not the footprint
    // rectangle, which is a reservation the massing sits inside. Hanging a
    // bracket off the footprint edge left the lantern floating in the gap;
    // at 3m tiles that gap is metres wide. Fall back to the footprint only
    // when the building failed to emit (it is then absent from `tops`).
    const top = tops?.get(obj.id)
    const cx = top ? top.centerX : ctx * TILE
    const cz = top ? top.centerZ : ctz * TILE
    const halfW = top ? top.halfW : (fpT.w * TILE) / 2
    const halfD = top ? top.halfD : (fpT.h * TILE) / 2
    const yaw = top ? top.rotationY : 0

    // Pick a wall side deterministically, step out to that wall face in the
    // building's own frame, then rotate into world so the lantern lands on
    // the wall even when the building is turned.
    const side = h % 4
    const offset = 0.18
    let lx = 0, lz = 0
    if (side === 0) lz = -(halfD + offset)        // north wall
    else if (side === 1) lz = halfD + offset      // south wall
    else if (side === 2) lx = -(halfW + offset)   // west wall
    else lx = halfW + offset                      // east wall
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw)
    const px = cx + lx * cosY - lz * sinY
    const pz = cz + lx * sinY + lz * cosY

    // Bracket — a dark thin box from the wall to the lantern.
    const bdx = side === 2 ? 0.2 : side === 3 ? -0.2 : 0
    const bdz = side === 0 ? 0.2 : side === 1 ? -0.2 : 0
    const bracketDx = bdx * cosY - bdz * sinY
    const bracketDz = bdx * sinY + bdz * cosY
    const bracketLen = 0.3
    const bracket = new THREE.BoxGeometry(
      (side === 0 || side === 1) ? 0.03 : bracketLen,
      0.03,
      (side === 2 || side === 3) ? 0.03 : bracketLen,
    )
    bracket.translate(px + bracketDx, mountY, pz + bracketDz)
    lanternGeos.push(bracket)
    // Lantern bulb — small warm sphere (uses the shared _lanternMat so
    // emissive flickers/dims together with the rope lanterns).
    const bulb = new THREE.SphereGeometry(0.12, 6, 5)
    bulb.translate(px, mountY - 0.06, pz)
    lanternGeos.push(bulb)
    // A wall bracket has a wall behind it, so this family gets the tightest
    // orbit of the three — but not a tight one. See the radius note on the
    // rope family below: sub-half-metre put every moth inside the lantern's
    // own screen footprint, where a pale speck is invisible by construction.
    lampAnchors.push({ x: px, y: mountY - 0.06, z: pz, r: 0.58, kind: 'wall' })
  }
  if (lanternGeos.length === 0) return null
  const merged = mergeBufferGeos(lanternGeos)
  merged.computeVertexNormals()
  const mesh = new THREE.Mesh(merged, _lanternMat)
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.matrixAutoUpdate = false
  mesh.updateMatrix()
  return mesh
}

/**
 * How far a building's footprint reaches from its centre along a direction —
 * the exact support function of a yawed box, `hw*|ux| + hd*|uz|` measured in
 * the box's own frame. Used to stop lantern ropes at the wall.
 */
function supportRadius(
  b: { halfW: number; halfD: number; yaw: number }, ux: number, uz: number
): number {
  const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw)
  const lx = ux * c - uz * s
  const lz = ux * s + uz * c
  return b.halfW * Math.abs(lx) + b.halfD * Math.abs(lz)
}

export function buildLanternStrings(
  map: MapDocument,
  defMap: Map<string, ObjectDefinition>,
  heightMap: number[][] | null,
  /** Real per-building tops from BuildingFactory, keyed by object id. Without
   *  these the rope falls back to a fixed height above the ground and cuts
   *  through the buildings it connects. */
  tops?: Map<string, BuildingTop>,
): LanternStringsResult {
  const structureLayer = map.layers.find(l => l.type === 'structure')
  if (!structureLayer) return { ropeMesh: null, lanternMesh: null, wallLanternMesh: null }

  // Gather eligible building centers. Filter out NO-signature types
  // (walls, gates, staircases) so we don't string lanterns across
  // perimeter walls or archways.
  const EXCLUDE = new Set([
    'stone_wall', 'stone_wall_v', 'crenellated_wall',
    'archway', 'town_gate', 'gatehouse', 'staircase', 'aqueduct',
    'watchtower',
  ])
  // halfW/halfD/yaw ride along so the rope can stop AT each building instead
  // of at its centre — see the endpoint pull-in below.
  const centers: Array<{
    cx: number; cz: number; groundY: number; eaveY: number
    halfW: number; halfD: number; yaw: number
    /** Somewhere a household lives — decides whether this pair may carry
     *  washing rather than lanterns. Read from the shared DWELLING_TYPES so
     *  the renderer cannot disagree with the placer about what a home is. */
    home: boolean
    /** Stable architectural seed, so which garments hang on which line is the
     *  same on every run. `obj.id` is a UUID minted per generate. */
    seed: number
  }> = []
  for (const obj of structureLayer.objects) {
    if (EXCLUDE.has(obj.definitionId)) continue
    const def = defMap.get(obj.definitionId)
    const fpT = def?.footprint ?? { w: 1, h: 1 }
    const ctx = obj.x + fpT.w / 2
    const ctz = obj.y + fpT.h / 2
    const groundY = heightMap ? getTerrainHeight(heightMap, ctx, ctz) : 0
    // Top of this building's walls — where a rope can actually be tied.
    const t = tops?.get(obj.id)
    const eaveY = t?.mainWallTopY ?? (groundY + HANG_HEIGHT)
    centers.push({
      cx: t ? t.centerX : ctx * TILE,
      cz: t ? t.centerZ : ctz * TILE,
      groundY, eaveY,
      halfW: t ? t.halfW : (fpT.w * TILE) / 2,
      halfD: t ? t.halfD : (fpT.h * TILE) / 2,
      yaw: t ? t.rotationY : 0,
      home: DWELLING_TYPES.has(obj.definitionId),
      seed: stableHash(obj),
    })
  }
  if (centers.length < 2) return { ropeMesh: null, lanternMesh: null, wallLanternMesh: null }

  // Pick pairs. Simple O(N²) scan with a distance filter; N is typically
  // ~150–200 so cost is a few tens of thousands of ops, cheap at load.
  // Each building can participate in at most 2 strings so we don't
  // pincushion any single roof with chains.
  interface StringSpec {
    ax: number; az: number; bx: number; bz: number; y: number
    kind: 'lantern' | 'laundry'; seed: number
  }
  const strings: StringSpec[] = []
  const usage = new Uint8Array(centers.length)
  for (let i = 0; i < centers.length; i++) {
    if (usage[i] >= 2) continue
    for (let j = i + 1; j < centers.length; j++) {
      if (usage[j] >= 2) continue
      if (strings.length >= MAX_STRINGS) break
      const a = centers[i], b = centers[j]
      const dx = a.cx - b.cx, dz = a.cz - b.cz
      const d = Math.hypot(dx, dz)
      if (d < MIN_DIST || d > MAX_DIST) continue
      // WHICH KIND OF STRING IS THIS.
      //
      // Washing goes between two HOMES and nowhere else — a line of shirts
      // across a market square or a churchyard is the wallpaper failure this
      // repo keeps catching, content that fires at the same rate everywhere
      // and so differentiates nothing. Two households facing each other over
      // a back lane is the whole picture.
      //
      // It hangs BELOW the lower eave rather than above the higher one, and
      // then only if there is genuinely room: it must clear head height over
      // the HIGHER of the two grounds, because the street between buildings
      // on a slope is only as generous as its high end. A pair with no such
      // window simply carries lanterns instead, which is why this is a choice
      // inside one loop and not a second pass with its own budget.
      const bothHome = a.home && b.home
      const groundMax = Math.max(a.groundY, b.groundY)
      const ceilY = Math.min(a.eaveY, b.eaveY) - LAUNDRY_EAVE_GAP
      const laundryY = Math.min(groundMax + LAUNDRY_HEIGHT, ceilY)
      const floorY = groundMax + LAUNDRY_MIN_CLEAR
      // Alternate rather than always preferring washing, so a terrace of
      // identical houses does not become a laundry district. The seed is
      // positional, so the choice is stable across runs.
      const wantsLaundry = bothHome && laundryY >= floorY &&
        ((a.seed ^ b.seed) & 3) !== 0
      const kind: 'lantern' | 'laundry' = wantsLaundry ? 'laundry' : 'lantern'
      // Hang above the HIGHER of the two eaves so the rope spans the gap
      // overhead. Averaging ground heights (the old behaviour) ignored how
      // tall the buildings actually were.
      const y = wantsLaundry ? laundryY : Math.max(a.eaveY, b.eaveY) + EAVE_CLEARANCE
      // Tie the rope off at each building's WALL, not its centre. Spanning
      // centre to centre buried most of the rope inside the two buildings it
      // connected and left it poking out of their far sides — invisible when
      // buildings were a metre wide, obvious once they are ten.
      const ux = -dx / d, uz = -dz / d          // unit vector a -> b
      const inA = supportRadius(a, ux, uz)
      const inB = supportRadius(b, -ux, -uz)
      // Nothing left to span once both buildings are pulled in: skip rather
      // than emit a backwards rope.
      if (inA + inB >= d - 0.5) continue
      strings.push({
        ax: a.cx + ux * inA, az: a.cz + uz * inA,
        bx: b.cx - ux * inB, bz: b.cz - uz * inB,
        y, kind, seed: (a.seed ^ (b.seed * 31)) >>> 0,
      })
      usage[i]++
      usage[j]++
      break
    }
    if (strings.length >= MAX_STRINGS) break
  }
  if (strings.length === 0) return { ropeMesh: null, lanternMesh: null, wallLanternMesh: null }

  // Build rope segments as a batched mesh with baked colors. Lanterns go
  // into a separate batch — their material has emissive + vertex colors
  // don't help us because we want real emissive intensity modulation.
  const ropeBatch = Object.assign(new BatchedMeshBuilder(), { toneFloor: 0.12 })
  // Cloth gets its OWN batch and its own name. Both kinds could share the
  // rope batch and draw identically, and then nothing could answer "is that
  // pale shape a bedsheet or a bug?" without reading source — which is the
  // precise reason the rope mesh was named in the first place, recorded four
  // lines below. A higher tone floor than the rope's because unlit hanging
  // cloth at dusk is the one thing here that must not go black: its whole job
  // is to punch a light gap in a dark roofline.
  const laundryBatch = Object.assign(new BatchedMeshBuilder(), { toneFloor: 0.30 })
  const lanternGeos: THREE.BufferGeometry[] = []

  for (const s of strings) {
    // Sample the catenary (simple sagged lerp) at SEGMENTS+1 points.
    const points: Array<[number, number, number]> = []
    const span = Math.hypot(s.bx - s.ax, s.bz - s.az)
    const sagDepth = Math.max(SAG, span * SAG_FRACTION)
    for (let k = 0; k <= SEGMENTS; k++) {
      const t = k / SEGMENTS
      const x = s.ax * (1 - t) + s.bx * t
      const z = s.az * (1 - t) + s.bz * t
      const sag = sagDepth * Math.sin(Math.PI * t)  // 0 at endpoints, max at t=0.5
      points.push([x, s.y - sag, z])
    }
    // Rope segments: a thin box from each point to the next.
    for (let k = 0; k < SEGMENTS; k++) {
      const [x0, y0, z0] = points[k]
      const [x1, y1, z1] = points[k + 1]
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0
      const len = Math.hypot(dx, dy, dz)
      if (len < 0.001) continue
      const seg = new THREE.BoxGeometry(0.035, 0.035, len)
      // Rotate from +Z (box long-axis) to (dx, dy, dz).
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(dx / len, dy / len, dz / len),
      )
      seg.applyQuaternion(q)
      seg.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2)
      ropeBatch.addPositioned(seg, 0x2a1f16)
    }
    if (s.kind === 'laundry') {
      // GARMENTS HANG FROM THE LINE, not from a fixed set of t-values. A
      // count spaces three shirts evenly whatever the span, so a 14m line
      // looks emptier than an 8m one — the same ratio-to-the-wrong-quantity
      // mistake that flattened every roof pitch when the span tripled. Pitch
      // is a physical distance and the count follows from it.
      const n = Math.max(2, Math.min(MAX_GARMENTS, Math.round(span / GARMENT_PITCH)))
      // Perpendicular to the line in plan, so a garment hangs ACROSS the rope
      // the way cloth folded over a line actually does, instead of edge-on to
      // the street it is meant to be seen from.
      const rx = -(s.bz - s.az) / span, rz = (s.bx - s.ax) / span
      for (let gi = 0; gi < n; gi++) {
        const t = (gi + 0.5) / n
        const idx = Math.round(t * SEGMENTS)
        const [gx, gy, gz] = points[idx]
        const r = (salt: number): number => {
          const v = Math.sin((s.seed % 9973) * 0.0137 + gi * 1.7 + salt * 4.3) * 43758.5453
          return v - Math.floor(v)
        }
        // A washing line carries sheets and shirts, not one repeated cloth.
        // The spread is deliberately wide: pillar 2 asks that the eye never
        // copy-paste one thing onto another, and a row of identical rectangles
        // is that failure at its most obvious.
        const gw = 0.34 + r(0) * 0.62
        const gl = 0.55 + r(1) * 0.85
        const col = CLOTH_COLORS[Math.floor(r(2) * CLOTH_COLORS.length) % CLOTH_COLORS.length]
        // Cloth is thin, but not so thin it becomes a sliver: under about 2cm
        // it aliases to nothing at RENDER_SCALE 0.4 and tools/slivers.mjs
        // would be right to flag it.
        const cloth = new THREE.BoxGeometry(0.025, gl, gw)
        // Lean each piece a little so they are not a row of coplanar cards,
        // and let the lean vary — wind and weight. Done BEFORE the yaw, so it
        // is a lean about the garment's own axis; `geometry.rotateZ` acts on
        // world Z whatever the vertices currently are, so applying it second
        // would tilt every garment the same way in world space regardless of
        // which way its line runs.
        cloth.rotateZ((r(3) - 0.5) * 0.22)
        // THE THIN AXIS MUST POINT ALONG THE PERPENDICULAR — a shirt hangs
        // with the line through its shoulders, so its width lies ALONG the
        // rope and you see it face-on from the side of the street.
        //
        // `rotateY(t)` maps +X to (cos t, 0, -sin t), so `atan2(rz, rx)` sends
        // the thickness axis to (rx, -rz): the perpendicular with its z
        // component flipped, which is only perpendicular at all when the line
        // happens to run along an axis. Every diagonal line in town was
        // hanging its washing skew. The sign belongs inside the atan2.
        cloth.rotateY(Math.atan2(-rz, rx))
        cloth.translate(gx, gy - gl / 2 - 0.03, gz)
        laundryBatch.addPositioned(cloth, col)
      }
      continue
    }
    // Lanterns at interpolated t-values along the rope.
    for (let li = 1; li <= LANTERN_COUNT; li++) {
      const tL = li / (LANTERN_COUNT + 1)
      const idx = Math.round(tL * SEGMENTS)
      const [lx, ly, lz] = points[idx]
      // Lantern body — box w/ slight taper, hanging 0.12 below the rope.
      const body = new THREE.BoxGeometry(0.14, 0.18, 0.14)
      body.translate(lx, ly - 0.15, lz)
      lanternGeos.push(body)
      // Tiny top cap so the silhouette isn't a plain cube against sky.
      const cap = new THREE.ConeGeometry(0.1, 0.06, 4)
      cap.translate(lx, ly - 0.04, lz)
      lanternGeos.push(cap)
      // A rope lantern hangs in open air over the middle of a street, so
      // this is the family with the most room to circle.
      //
      // THE RADII WERE SET BY WHAT LOOKS PHYSICALLY RIGHT AND MEASURED AS
      // INVISIBLE. At 0.34-0.55m every moth stays inside the lantern's own
      // screen footprint at any standoff a person would stand at, and the
      // one surface in frame a pale speck cannot be seen against is the
      // flame. `mothshot.mjs`'s A/B triple is what said so: the isolate
      // frame showed four crisp 5px moths and the composite showed ONE,
      // because the other three were over the bulb. Widened until the orbit
      // carries them out into the dark air, which is also closer to what a
      // moth cloud at a lamp actually occupies — half a metre is a moth
      // sitting on the glass, not one circling it.
      lampAnchors.push({ x: lx, y: ly - 0.15, z: lz, r: 1.05, kind: 'rope' })
    }
  }

  const ropeMesh = ropeBatch.build()
  if (ropeMesh) {
    // Named so a tool can single it out at runtime. tools/anomaly.mjs flags
    // long thin dark shapes against the sky, and "is that a rope or a stray
    // beam?" is answerable in one run by hiding a named mesh — but only if it
    // has a name. An unnamed mesh in a merged batch is anonymous by
    // construction, which is the same problem tools/slivers.mjs exists for.
    ropeMesh.name = 'lanternRopes'
    ropeMesh.castShadow = false
    ropeMesh.receiveShadow = false
  }

  let lanternMesh: THREE.Mesh | null = null
  if (lanternGeos.length) {
    // Merge manually without vertex colors — we want the material-level
    // emissive to drive their glow, not baked colors.
    const merged = mergeBufferGeos(lanternGeos)
    merged.computeVertexNormals()
    lanternMesh = new THREE.Mesh(merged, _lanternMat)
    lanternMesh.castShadow = false
    lanternMesh.receiveShadow = false
    lanternMesh.matrixAutoUpdate = false
    lanternMesh.updateMatrix()
  }

  const laundryMesh = laundryBatch.build()
  if (laundryMesh) {
    laundryMesh.name = 'laundryLines'
    // Cloth does not cast — a garment is thin enough that its shadow is a
    // hard black stripe on the paving at a 512 shadow map, and hanging
    // washing over a lit street reads better as a silhouette than as a
    // stencil. It DOES receive, so a line in shadow is not brighter than the
    // wall behind it.
    laundryMesh.castShadow = false
    laundryMesh.receiveShadow = true
  }

  return { ropeMesh, lanternMesh, wallLanternMesh: null, laundryMesh }
}

/** Minimal position-only merge — we don't need UVs or normals going in,
 *  computeVertexNormals handles normals post-merge. */
/**
 * DE-INDEX FIRST, AND CARRY THE UVs.
 *
 * This concatenated the POSITION arrays of indexed geometries and threw the
 * index away, which does not merge them — it draws whatever the vertex list
 * happens to spell. A `BoxGeometry` is 24 positions and 36 indices, so every
 * merged box in this file has been rendering as EIGHT triangles where it
 * needs twelve, since the function was written. It survived because a lantern
 * bulb is 12cm across and a garbled blob at 12cm still reads as a small
 * glowing lump: the defect is real, longstanding, and below the resolution of
 * anything that was looking.
 *
 * What found it was a 8.5m plane. `PlaneGeometry` is 4 positions and 6
 * indices, so a window-spill quad came out as ONE triangle — a hard-edged
 * wedge lying on the cobbles, which is what a screenshot of a supposedly
 * soft pool of light showed. **Scale is what made an old bug visible, not a
 * new bug**, and the same shape has caught this repo before: content authored
 * small hid an error that the moment something large used the same path put
 * on screen.
 *
 * UVs come along for the same reason: the spill needs the radial alpha map
 * that makes it a pool rather than a decal, and a merge that silently drops
 * them would have produced a second wrong picture with nothing erroring.
 */
function mergeBufferGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g))
  let total = 0
  for (const g of flat) total += g.getAttribute('position').count
  const positions = new Float32Array(total * 3)
  // Only emit UVs if EVERY input has them — a partial uv attribute silently
  // maps the geometries that lack it to a single texel, which is the kind of
  // half-correct output this function was already producing.
  const withUv = flat.every((g) => !!g.getAttribute('uv'))
  const uvs = withUv ? new Float32Array(total * 2) : null
  let po = 0, uo = 0
  for (const g of flat) {
    const arr = g.getAttribute('position').array as Float32Array
    positions.set(arr, po)
    po += arr.length
    if (uvs) {
      const u = g.getAttribute('uv').array as Float32Array
      uvs.set(u, uo)
      uo += u.length
    }
  }
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (uvs) merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  merged.computeVertexNormals()
  for (let i = 0; i < flat.length; i++) if (flat[i] !== geos[i]) flat[i].dispose()
  return merged
}
