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
    const clone = geo.clone()
    clone.translate(x, y, z)
    bakeVertexColor(clone, new THREE.Color(colorHex))
    this.geos.push(clone)
  }

  /** Add a geometry that's already positioned (e.g. from translate() calls) with a color */
  addPositioned(geo: THREE.BufferGeometry, colorHex: number): void {
    const clone = geo.clone()
    bakeVertexColor(clone, new THREE.Color(colorHex))
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
