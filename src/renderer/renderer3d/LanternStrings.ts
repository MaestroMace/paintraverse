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
import { getTerrainHeight } from './TerrainMesh'
import { BatchedMeshBuilder } from './BatchedMeshBuilder'
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

export interface LanternStringsResult {
  ropeMesh: THREE.Mesh | null
  lanternMesh: THREE.Mesh | null
  wallLanternMesh: THREE.Mesh | null
}

/**
 * Wall-mounted lanterns — a single small emissive sphere + iron bracket
 * jutting from the front wall of ~18% of eligible buildings at ~2.4m
 * height. Adds eye-level warm points along streets that complement the
 * overhead rope lanterns. Shares the _lanternMat so one
 * setLanternEmissiveIntensity() call drives both systems.
 */
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
    // Hash-based 18% pick so same seed → same lantern placements.
    const h = simpleHash(obj.id)
    if (h % 100 >= 18) continue
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

/** Simple string hash for obj.id → integer. */
function simpleHash(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) n = ((n << 5) - n + s.charCodeAt(i)) | 0
  return Math.abs(n)
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
  if (!structureLayer) return { ropeMesh: null, lanternMesh: null }

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
    })
  }
  if (centers.length < 2) return { ropeMesh: null, lanternMesh: null }

  // Pick pairs. Simple O(N²) scan with a distance filter; N is typically
  // ~150–200 so cost is a few tens of thousands of ops, cheap at load.
  // Each building can participate in at most 2 strings so we don't
  // pincushion any single roof with chains.
  interface StringSpec { ax: number; az: number; bx: number; bz: number; y: number }
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
      // Hang above the HIGHER of the two eaves so the rope spans the gap
      // overhead. Averaging ground heights (the old behaviour) ignored how
      // tall the buildings actually were.
      const y = Math.max(a.eaveY, b.eaveY) + EAVE_CLEARANCE
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
        y,
      })
      usage[i]++
      usage[j]++
      break
    }
    if (strings.length >= MAX_STRINGS) break
  }
  if (strings.length === 0) return { ropeMesh: null, lanternMesh: null }

  // Build rope segments as a batched mesh with baked colors. Lanterns go
  // into a separate batch — their material has emissive + vertex colors
  // don't help us because we want real emissive intensity modulation.
  const ropeBatch = new BatchedMeshBuilder()
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

  return { ropeMesh, lanternMesh, wallLanternMesh: null }
}

/** Minimal position-only merge — we don't need UVs or normals going in,
 *  computeVertexNormals handles normals post-merge. */
function mergeBufferGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let total = 0
  for (const g of geos) total += g.getAttribute('position').count
  const positions = new Float32Array(total * 3)
  let offset = 0
  for (const g of geos) {
    const p = g.getAttribute('position')
    const arr = p.array as Float32Array
    positions.set(arr, offset)
    offset += arr.length
  }
  const merged = new THREE.BufferGeometry()
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  return merged
}
