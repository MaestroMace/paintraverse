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

export class BatchedMeshBuilder {
  private geos: THREE.BufferGeometry[] = []

  /** Add a geometry fragment at a world position with a solid color */
  add(geo: THREE.BufferGeometry, colorHex: number, x: number, y: number, z: number): void {
    const clone = normalizeForMerge(geo.clone())
    clone.translate(x, y, z)
    bakeVertexColor(clone, new THREE.Color(colorHex))
    this.geos.push(clone)
  }

  /** Add a geometry that's already positioned (e.g. from translate() calls) with a color */
  addPositioned(geo: THREE.BufferGeometry, colorHex: number): void {
    const clone = normalizeForMerge(geo.clone())
    bakeVertexColor(clone, new THREE.Color(colorHex))
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
    this.geos.push(clone)
  }

  /** How many fragments have been collected */
  get count(): number { return this.geos.length }

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
