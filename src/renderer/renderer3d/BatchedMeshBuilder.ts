/**
 * BatchedMeshBuilder: Collects individual geometries and merges them
 * into minimal draw calls using vertex colors.
 *
 * Usage:
 *   const batch = new BatchedMeshBuilder()
 *   batch.add(someBoxGeo, 0xff0000, new THREE.Vector3(10, 0, 5))
 *   batch.add(anotherGeo, 0x00ff00, new THREE.Vector3(20, 0, 8))
 *   const mesh = batch.build()  // single merged Mesh with vertex colors
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/**
 * Hash-derived [-strength, +strength] per-channel jitter. Same seed +
 * idx pair always returns the same triple, so re-rolling the same town
 * produces identical roof patches. Two channels biased darker than
 * brighter (skewed +0.4) so the noise reads as "weathered patches"
 * rather than "speckled paint."
 */
function perChannelJitter(seed: number, idx: number, strength: number): [number, number, number] {
  const a = ((seed * 2654435761) ^ (idx * 1597334677)) >>> 0
  const b = ((seed * 1597334677) ^ (idx * 2246822519)) >>> 0
  const c = ((seed * 374761393)  ^ (idx * 3266489917)) >>> 0
  // Map [0, 0xffffffff] → [-1, +1] then bias slightly darker.
  const j0 = (a / 0xffffffff) * 2 - 1.4
  const j1 = (b / 0xffffffff) * 2 - 1.4
  const j2 = (c / 0xffffffff) * 2 - 1.4
  return [j0 * strength * 0.5, j1 * strength * 0.5, j2 * strength * 0.5]
}

/**
 * Normalize a geometry to a uniform attribute set so it can merge with
 * any other normalized geometry. Three.js's mergeGeometries refuses to
 * merge inputs with mismatched attribute keys or different indexed-vs-
 * non-indexed states. Built-in primitives (Box/Cone/Sphere/Cylinder)
 * come with position+normal+uv plus an index; our hand-rolled prism
 * roofs only carry position. We unify by:
 *   1. Calling toNonIndexed() on indexed geometries so all inputs are
 *      non-indexed (the cleaner direction since our prism builders
 *      already produce non-indexed output).
 *   2. Stripping every attribute except position so the merged geom
 *      has exactly { position, color } — color is added by the caller
 *      with bakeVertexColor afterward, computeVertexNormals reruns on
 *      the merged result so we don't need per-input normals.
 *
 * This fixes the silent "merged mesh is null" bug that's been around
 * since prism roofs were introduced — hand-rolled prisms could never
 * merge with cone-roof spires in the same batch, and roofBatch.build()
 * would return null on any town that mixed both styles.
 */
function normalizeForMerge(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = geo.index !== null ? geo.toNonIndexed() : geo
  // Drop everything except position. computeVertexNormals() runs
  // post-merge so we don't need normals per-input.
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position') out.deleteAttribute(name)
  }
  return out
}

/** Bake a solid color into a geometry's vertex color attribute (modifies in place) */
function bakeVertexColor(geo: THREE.BufferGeometry, color: THREE.Color): void {
  const count = geo.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  const r = color.r, g = color.g, b = color.b
  for (let i = 0; i < count; i++) {
    colors[i * 3] = r
    colors[i * 3 + 1] = g
    colors[i * 3 + 2] = b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

// Shared material singletons (one per category)
let _lambertVC: THREE.MeshLambertMaterial | null = null
export function getSharedLambertVC(): THREE.MeshLambertMaterial {
  if (!_lambertVC) {
    _lambertVC = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })
  }
  return _lambertVC
}


// === Fragment size audit ===
// Ornament geometry is emitted as hundreds of small pieces. Anything whose
// smallest dimension is a couple of centimetres cannot resolve at the
// renderer's 0.4 internal scale beyond a few metres — it costs memory and
// aliases into speckle. Enable via setFragmentAudit(true) and read with
// getFragmentAudit(); off by default so normal builds pay nothing.
let _sizeAudit = false
interface FragBucket { count: number; verts: number; colors: Record<string, number> }
const _fragBuckets = new Map<string, FragBucket>()

export function setFragmentAudit(on: boolean): void {
  _sizeAudit = on
  if (on) _fragBuckets.clear()
}

export function getFragmentAudit(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of [..._fragBuckets.entries()].sort()) {
    const top = Object.entries(v.colors).sort((a, b) => b[1] - a[1]).slice(0, 4)
    out[k] = { count: v.count, verts: v.verts, topColors: top.map(([c, n]) => c + ':' + n) }
  }
  return out
}

function recordFragment(geo: THREE.BufferGeometry, colorHex: number): void {
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  if (!bb) return
  const dx = bb.max.x - bb.min.x, dy = bb.max.y - bb.min.y, dz = bb.max.z - bb.min.z
  // Bucket on the LARGEST dimension. A thin-but-long piece (a bargeboard is
  // 5cm x 2m) still reads as a line on screen; what cannot be seen is a
  // fragment that is small in every axis.
  const maxDim = Math.max(dx, dy, dz)
  const bucket =
    maxDim < 0.06 ? 'a_under6cm' :
    maxDim < 0.10 ? 'b_6to10cm' :
    maxDim < 0.16 ? 'c_10to16cm' :
    maxDim < 0.30 ? 'd_16to30cm' : 'e_over30cm'
  let e = _fragBuckets.get(bucket)
  if (!e) { e = { count: 0, verts: 0, colors: {} }; _fragBuckets.set(bucket, e) }
  e.count++
  e.verts += geo.getAttribute('position').count
  const key = '#' + colorHex.toString(16).padStart(6, '0')
  e.colors[key] = (e.colors[key] ?? 0) + 1
}


// === Oversize sliver audit ===
//
// The opposite question from the fragment audit above, and the one that was
// missing. A piece metres long in one axis and centimetres in the others is a
// BEAM, and a beam nobody meant to emit is the "giant floating accent timber"
// class of defect — reported repeatedly from the device and never once found
// by staring at screenshots, because a batched mesh gives you no way to ask
// which line drew a particular triangle.
//
// So this one captures a stack. That is far too expensive for a normal build,
// which is exactly why it is off by default: when you turn it on you get the
// emitting source line, not another guess.
let _sliverAudit = false
let _sliverMinLen = 4

/**
 * The envelope of the building currently being emitted, in world units.
 *
 * "Is this piece long and thin?" was the wrong question — a cornice on a 12m
 * hall is long and thin and entirely correct, so legitimate trim drowned the
 * signal. The question the screenshots actually pose is "is this sticking out
 * past the building it belongs to?", and only the factory knows where the
 * building ends. So it says, here, once per building.
 */
interface BuildEnvelope {
  minX: number; maxX: number
  minZ: number; maxZ: number
  minY: number; maxY: number
  label: string
}
let _envelope: BuildEnvelope | null = null
export function setBuildEnvelope(e: BuildEnvelope | null): void { _envelope = e }
interface SliverBucket {
  count: number
  maxLen: number
  /** World position of the longest example, so it can be flown to. */
  at: [number, number, number]
}
const _sliverBuckets = new Map<string, SliverBucket>()

export function setSliverAudit(on: boolean, minLen = 4): void {
  _sliverAudit = on
  _sliverMinLen = minLen
  if (on) _sliverBuckets.clear()
}

export function getSliverAudit(): Record<string, unknown> {
  const rows = [..._sliverBuckets.entries()].sort((a, b) => b[1].maxLen - a[1].maxLen)
  const out: Record<string, unknown> = {}
  for (const [site, v] of rows) {
    out[site] = {
      count: v.count,
      maxLen: +v.maxLen.toFixed(2),
      at: v.at.map((n) => +n.toFixed(1)),
    }
  }
  return out
}

/**
 * First stack frame outside this builder — the code that actually emitted the
 * piece. Filtering has to be by FUNCTION NAME, not by filename: in a bundled
 * build every module shares one `index-<hash>.js`, so a filename filter skips
 * nothing and you get this file's own line back. Rollup keeps top-level
 * function names even when minifying locals, so the names survive.
 */
const _builderFrames = /(recordSliver|recordFragment|callSite|addPositionedNoised|addPositioned|normalizeForMerge|bakeVertexColor)/
function callSite(): string {
  const lines = (new Error().stack ?? '').split('\n').slice(1)
  for (const l of lines) {
    if (_builderFrames.test(l)) continue
    // "    at buildRoof (file:///…/index-abc.js:1234:56)" → "buildRoof@1234"
    const fn = l.match(/at\s+(?:new\s+)?([\w$.<>]+)\s*\(/)
    const loc = l.match(/:(\d+):\d+\)?\s*$/)
    if (fn || loc) return `${fn ? fn[1] : 'anon'}@${loc ? loc[1] : '?'}`
  }
  return 'unknown'
}

/**
 * Raise a colour to a minimum LINEAR luma, keeping its hue and saturation.
 *
 * Scaling the sRGB channels toward white would wash the colour out; scaling
 * them multiplicatively keeps the ratios between them, which is what carries
 * hue. Anything already above the floor is returned untouched, so this can
 * only ever brighten the tail.
 */
function liftToFloor(hex: number, floor: number): number {
  if (floor <= 0) return hex
  const toLin = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  const r = ((hex >> 16) & 0xff) / 255, g = ((hex >> 8) & 0xff) / 255, b = (hex & 0xff) / 255
  const lum = 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b)
  if (lum >= floor) return hex
  // Work in sRGB space: a straight channel multiply keeps the hue, and the
  // gamma curve means a modest factor buys a lot of perceived lift.
  const k = Math.pow(floor / Math.max(lum, 1e-4), 1 / 2.4)
  const ch = (v: number): number => Math.min(255, Math.round(v * 255 * k))
  return (ch(r) << 16) | (ch(g) << 8) | ch(b)
}

function recordSliver(geo: THREE.BufferGeometry): void {
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  if (!bb) return
  // PROTRUSION, not length. How far does this piece reach past the envelope of
  // the building that is emitting it? Trim that hugs its building scores zero
  // however long it is; a beam hanging in the sky scores metres.
  // No envelope means nobody told us which building this belongs to, and
  // scoring it 0 is how this audit returned a confident "nothing found" while
  // metres-long beams were visible on screen. Attribute it explicitly instead.
  let over = 0
  if (!_envelope) {
    const e = _sliverBuckets.get('NO-ENVELOPE:' + callSite())
    if (e) { e.count++ } else {
      _sliverBuckets.set('NO-ENVELOPE:' + callSite(),
        { count: 1, maxLen: 0, at: [bb.min.x, bb.min.y, bb.min.z] })
    }
    return
  }
  {
    over = Math.max(
      _envelope.minX - bb.min.x, bb.max.x - _envelope.maxX,
      _envelope.minZ - bb.min.z, bb.max.z - _envelope.maxZ,
      _envelope.minY - bb.min.y, bb.max.y - _envelope.maxY,
    )
  }
  if (over < _sliverMinLen) return
  const site = callSite()
  const maxDim = over
  const cx = (bb.max.x + bb.min.x) / 2
  const cy = (bb.max.y + bb.min.y) / 2
  const cz = (bb.max.z + bb.min.z) / 2
  const e = _sliverBuckets.get(site)
  if (!e) {
    _sliverBuckets.set(site, { count: 1, maxLen: maxDim, at: [cx, cy, cz] })
  } else {
    e.count++
    if (maxDim > e.maxLen) { e.maxLen = maxDim; e.at = [cx, cy, cz] }
  }
}

/** True when a fragment is smaller than MIN_VISIBLE_SIZE in every axis. */
const MIN_VISIBLE_SIZE = 0.05
function isSubPixelFragment(geo: THREE.BufferGeometry): boolean {
  geo.computeBoundingBox()
  const bb = geo.boundingBox
  if (!bb) return false
  return (bb.max.x - bb.min.x) < MIN_VISIBLE_SIZE &&
         (bb.max.y - bb.min.y) < MIN_VISIBLE_SIZE &&
         (bb.max.z - bb.min.z) < MIN_VISIBLE_SIZE
}

export class BatchedMeshBuilder {
  private geos: THREE.BufferGeometry[] = []

  /** Add a geometry fragment at a world position with a solid color */
  add(geo: THREE.BufferGeometry, colorHex: number, x: number, y: number, z: number): void {
    const clone = normalizeForMerge(geo.clone())
    clone.translate(x, y, z)
    bakeVertexColor(clone, new THREE.Color(colorHex))
    if (_sizeAudit) recordFragment(clone, colorHex)
    if (_sliverAudit) recordSliver(clone)
    this.geos.push(clone)
  }

  /**
   * A TONE FLOOR FOR THIS BATCH — the darkest a colour in it may be authored.
   *
   * `eyeball.mjs` reports props as the darkest surface class in the town: 31%
   * of their pixels read effectively black, against 4% for walls and 10% for
   * roofs once the tone arc had lifted both. It is not a lighting bug — props
   * are Lambert with vertex colours and take the same ambient and hemisphere
   * every other surface does. It is the PALETTE: 25% of the authored prop
   * colours sit under 0.05 linear luma, with 0x1a1a1a and 0x222222 among them.
   * Paint that dark cannot be lit into visibility.
   *
   * Applied as a floor on the BATCH rather than by editing seventy-two call
   * sites, so it is one number to tune and one place to revert, and so a new
   * prop cannot reintroduce the problem by authoring another near-black. Hue
   * and saturation are preserved — an iron lamp post stays iron-coloured, it
   * just stops being a hole. Buildings do not set this: their tone was fixed
   * by lighting and their palette is already in range.
   */
  toneFloor = 0

  /** Add a geometry that's already positioned (e.g. from translate() calls) with a color */
  addPositioned(geo: THREE.BufferGeometry, colorHex: number): void {
    const clone = normalizeForMerge(geo.clone())
    bakeVertexColor(clone, new THREE.Color(liftToFloor(colorHex, this.toneFloor)))
    if (_sizeAudit) recordFragment(clone, colorHex)
    if (_sliverAudit) recordSliver(clone)
    // Drop detail too small to ever resolve. At the renderer's 0.4 internal
    // scale a feature subtends one pixel at roughly 340x its own size, so
    // anything under ~5cm in EVERY axis is gone by 17m and only contributes
    // shimmer. Nothing in the current town trips this — it is a standing
    // guard so future ornaments can't quietly add invisible geometry.
    if (isSubPixelFragment(clone)) return
    this.geos.push(clone)
  }

  /**
   * Like addPositioned, but with hash-deterministic per-TRIANGLE color jitter.
   * Used for roof tile patches: the triangulated roof surface gets every
   * three consecutive vertices treated as one triangle and assigned the
   * SAME color, with that color shifted by a small per-triangle offset
   * derived from `seed + triangleIdx`. The result reads as patches of
   * slightly darker / lighter tiles across the roof — the "old roof
   * with mossy / repaired sections" silhouette texture.
   *
   * Operates on NON-INDEXED geometry (every 3 vertices = one triangle,
   * which matches our roof prism / cone / dome / mansard outputs). For
   * indexed input it falls back to per-vertex (no per-triangle stamping).
   *
   * `strength` is the maximum +/- shift per channel in [0, 1] units —
   * 0.05 is barely perceptible, 0.10 reads clearly at distance, 0.18
   * starts to look painterly. Default chosen to read at distance without
   * looking like a quilt.
   */
  addPositionedNoised(
    geo: THREE.BufferGeometry,
    colorHex: number,
    seed: number,
    strength: number = 0.10,
  ): void {
    // normalizeForMerge converts indexed → non-indexed and strips
    // normal/uv, so after this call every 3 consecutive vertices form
    // exactly one triangle in the geometry.
    const clone = normalizeForMerge(geo.clone())
    const base = new THREE.Color(colorHex)
    const posCount = clone.getAttribute('position').count
    const colors = new Float32Array(posCount * 3)
    const triCount = Math.floor(posCount / 3)
    for (let t = 0; t < triCount; t++) {
      const j = perChannelJitter(seed, t, strength)
      const r = clamp01(base.r + j[0])
      const g = clamp01(base.g + j[1])
      const b = clamp01(base.b + j[2])
      for (let v = 0; v < 3; v++) {
        const idx = (t * 3 + v) * 3
        colors[idx + 0] = r
        colors[idx + 1] = g
        colors[idx + 2] = b
      }
    }
    clone.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    if (_sizeAudit) recordFragment(clone, colorHex)
    if (_sliverAudit) recordSliver(clone)
    this.geos.push(clone)
  }

  /** How many fragments have been collected */
  get count(): number { return this.geos.length }

  /**
   * World-space AABB of everything added since `from`, or null if nothing was.
   *
   * Exists so a caller can measure ONE logical object out of a merged batch.
   * A batch hides its authors by construction — that is the whole reason
   * slivers.mjs has to capture a stack — and "how big is a boulder" is
   * unanswerable from the finished mesh. Bracket the emission instead.
   */
  boundsSince(from: number): { min: THREE.Vector3; max: THREE.Vector3 } | null {
    if (from >= this.geos.length) return null
    const min = new THREE.Vector3(Infinity, Infinity, Infinity)
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity)
    for (let i = from; i < this.geos.length; i++) {
      const g = this.geos[i]
      g.computeBoundingBox()
      if (!g.boundingBox) continue
      min.min(g.boundingBox.min)
      max.max(g.boundingBox.max)
    }
    return Number.isFinite(min.x) ? { min, max } : null
  }

  /** Merge all collected fragments into a single Mesh. Returns null if empty. */
  build(): THREE.Mesh | null {
    if (this.geos.length === 0) return null
    const merged = mergeGeometries(this.geos, false)
    if (!merged) return null
    merged.computeVertexNormals()
    const mesh = new THREE.Mesh(merged, getSharedLambertVC())
    mesh.matrixAutoUpdate = false
    mesh.updateMatrix()
    return mesh
  }
}
