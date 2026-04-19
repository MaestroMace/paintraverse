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

// How high above the higher endpoint's ground we hang the rope midpoint.
const HANG_HEIGHT = 3.2
// How far the rope's middle sags below a straight line between endpoints.
const SAG = 0.35
// Segments per string (more = smoother catenary).
const SEGMENTS = 10
// How many lanterns per string, evenly spaced along t ∈ (0,1).
const LANTERN_COUNT = 3
// Limit on total strings per map — performance bound.
const MAX_STRINGS = 25
// Pair filter: accept when building centers are this far apart in XZ.
const MIN_DIST = 2.6
const MAX_DIST = 5.0

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
}

export function buildLanternStrings(
  map: MapDocument,
  defMap: Map<string, ObjectDefinition>,
  heightMap: number[][] | null,
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
  const centers: Array<{ cx: number; cz: number; groundY: number }> = []
  for (const obj of structureLayer.objects) {
    if (EXCLUDE.has(obj.definitionId)) continue
    const def = defMap.get(obj.definitionId)
    const fp = def?.footprint ?? { w: 1, h: 1 }
    const cx = obj.x + fp.w / 2
    const cz = obj.y + fp.h / 2
    const groundY = heightMap ? getTerrainHeight(heightMap, cx, cz) : 0
    centers.push({ cx, cz, groundY })
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
      const y = (a.groundY + b.groundY) / 2 + HANG_HEIGHT
      strings.push({ ax: a.cx, az: a.cz, bx: b.cx, bz: b.cz, y })
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
    for (let k = 0; k <= SEGMENTS; k++) {
      const t = k / SEGMENTS
      const x = s.ax * (1 - t) + s.bx * t
      const z = s.az * (1 - t) + s.bz * t
      const sag = SAG * Math.sin(Math.PI * t)  // 0 at endpoints, max at t=0.5
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

  return { ropeMesh, lanternMesh }
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
