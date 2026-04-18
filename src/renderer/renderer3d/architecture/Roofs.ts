/**
 * Roof geometry builders, consolidated from BuildingFactory.
 *
 * Each builder returns a BufferGeometry with its base at y=0 rising to y=h,
 * centered at origin on the XZ plane. Callers translate to the volume's
 * top-of-wall position before batching.
 *
 * Geometry attributes: position only (no UVs, no pre-baked normals) so the
 * output merges cleanly with the shared vertex-color Lambert batch, which
 * calls computeVertexNormals() post-merge.
 */

import * as THREE from 'three'

export type RoofStyle =
  | 'flat' | 'none'
  | 'gabled' | 'hipped' | 'steep'
  | 'pointed' | 'spire'
  | 'dome'
  | 'mansard'

/** Ridge axis for gabled / hipped / mansard roofs. */
export type RoofAxis = 'x' | 'z'

export function buildRoof(
  w: number, d: number, h: number,
  style: RoofStyle,
  axis: RoofAxis = 'x',
): THREE.BufferGeometry | null {
  if (style === 'flat' || style === 'none' || h <= 0) return null

  if (style === 'pointed' || style === 'spire') {
    const r = Math.max(w, d) * (style === 'spire' ? 0.42 : 0.58)
    const geo = new THREE.ConeGeometry(r, h, 4)
    geo.rotateY(Math.PI / 4)
    geo.translate(0, h / 2, 0)
    return geo
  }

  if (style === 'dome') {
    const r = Math.max(w, d) * 0.5
    const geo = new THREE.SphereGeometry(r, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)
    geo.scale(1, h / r, 1)
    return geo
  }

  if (style === 'mansard') {
    return buildMansard(w, d, h, axis)
  }

  // gabled / hipped / steep all use the prism
  return buildGablePrism(w, d, h, axis, style === 'hipped')
}

/* ------------------------------------------------------------------ */
/* Gable / hip prism                                                  */
/* ------------------------------------------------------------------ */

function buildGablePrism(w: number, d: number, h: number, axis: RoofAxis, hipped: boolean): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2
  const ow = hw + 0.1, od = hd + 0.1

  let verts: number[]

  if (hipped) {
    const inset = Math.min(hw, hd) * 0.25
    // Ridge is a short segment at top; all four sides are sloped trapezoids.
    verts = [
      // North slope (large trapezoid, gable+1 end)
      -ow, 0, -od,  ow, 0, -od,  inset, h, -inset,
      -ow, 0, -od,  inset, h, -inset,  -inset, h, -inset,
      // South slope
       ow, 0,  od,  -ow, 0,  od,  -inset, h,  inset,
       ow, 0,  od,  -inset, h,  inset,   inset, h,  inset,
      // East slope
       ow, 0, -od,   ow, 0,  od,   inset, h,  inset,
       ow, 0, -od,   inset, h,  inset,   inset, h, -inset,
      // West slope
      -ow, 0,  od,  -ow, 0, -od,  -inset, h, -inset,
      -ow, 0,  od,  -inset, h, -inset,  -inset, h,  inset,
      // Top cap
      -inset, h, -inset,   inset, h, -inset,   inset, h,  inset,
      -inset, h, -inset,   inset, h,  inset,  -inset, h,  inset,
    ]
  } else {
    // Gabled: ridge runs full length along chosen axis, gable triangles on the other.
    if (axis === 'x') {
      // Ridge along X, gables face ±Z
      verts = [
        // +Z slope
        -ow, 0,  od,   ow, 0,  od,   ow, h, 0,
        -ow, 0,  od,   ow, h, 0,   -ow, h, 0,
        // -Z slope
         ow, 0, -od,  -ow, 0, -od,  -ow, h, 0,
         ow, 0, -od,  -ow, h, 0,    ow, h, 0,
        // +X gable
         ow, 0, -od,   ow, 0,  od,   ow, h, 0,
        // -X gable
        -ow, 0,  od,  -ow, 0, -od,  -ow, h, 0,
      ]
    } else {
      // Ridge along Z, gables face ±X
      verts = [
        // +X slope
         ow, 0, -od,   ow, 0,  od,   0, h,  od,
         ow, 0, -od,   0, h,  od,    0, h, -od,
        // -X slope
        -ow, 0,  od,  -ow, 0, -od,   0, h, -od,
        -ow, 0,  od,   0, h, -od,    0, h,  od,
        // +Z gable
        -ow, 0,  od,   ow, 0,  od,   0, h,  od,
        // -Z gable
         ow, 0, -od,  -ow, 0, -od,   0, h, -od,
      ]
    }
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
  return geo
}

/* ------------------------------------------------------------------ */
/* Mansard — two-pitch roof (steep lower, shallow upper)              */
/* ------------------------------------------------------------------ */

function buildMansard(w: number, d: number, h: number, axis: RoofAxis): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2
  const ow = hw + 0.1, od = hd + 0.1
  // Lower: 60% of h, steep 70° pitch ends at inset0
  // Upper: remaining 40% of h, shallow slope from inset0 to small flat top
  const h0 = h * 0.6
  const h1 = h - h0
  const inset0X = hw * 0.18
  const inset0Z = hd * 0.18
  const insetTopX = hw * 0.35
  const insetTopZ = hd * 0.35
  void axis
  // Four slopes of lower, four slopes of upper, flat top.
  const v: number[] = []
  const push = (...p: number[]) => v.push(...p)

  // Lower slopes — hipped-style, steep
  // North
  push(-ow, 0, -od,  ow, 0, -od,  hw - inset0X, h0, -hd + inset0Z)
  push(-ow, 0, -od,  hw - inset0X, h0, -hd + inset0Z,  -hw + inset0X, h0, -hd + inset0Z)
  // South
  push( ow, 0,  od, -ow, 0,  od, -hw + inset0X, h0,  hd - inset0Z)
  push( ow, 0,  od, -hw + inset0X, h0,  hd - inset0Z,   hw - inset0X, h0,  hd - inset0Z)
  // East
  push( ow, 0, -od,  ow, 0,  od,  hw - inset0X, h0,  hd - inset0Z)
  push( ow, 0, -od,  hw - inset0X, h0,  hd - inset0Z,   hw - inset0X, h0, -hd + inset0Z)
  // West
  push(-ow, 0,  od, -ow, 0, -od, -hw + inset0X, h0, -hd + inset0Z)
  push(-ow, 0,  od, -hw + inset0X, h0, -hd + inset0Z, -hw + inset0X, h0,  hd - inset0Z)

  // Upper slopes — shallow
  // North
  push(-hw + inset0X, h0, -hd + inset0Z,  hw - inset0X, h0, -hd + inset0Z,  hw - insetTopX, h, -hd + insetTopZ)
  push(-hw + inset0X, h0, -hd + inset0Z,  hw - insetTopX, h, -hd + insetTopZ, -hw + insetTopX, h, -hd + insetTopZ)
  // South
  push( hw - inset0X, h0,  hd - inset0Z, -hw + inset0X, h0,  hd - inset0Z, -hw + insetTopX, h,  hd - insetTopZ)
  push( hw - inset0X, h0,  hd - inset0Z, -hw + insetTopX, h,  hd - insetTopZ, hw - insetTopX, h,  hd - insetTopZ)
  // East
  push( hw - inset0X, h0, -hd + inset0Z,  hw - inset0X, h0,  hd - inset0Z,  hw - insetTopX, h,  hd - insetTopZ)
  push( hw - inset0X, h0, -hd + inset0Z,  hw - insetTopX, h,  hd - insetTopZ, hw - insetTopX, h, -hd + insetTopZ)
  // West
  push(-hw + inset0X, h0,  hd - inset0Z, -hw + inset0X, h0, -hd + inset0Z, -hw + insetTopX, h, -hd + insetTopZ)
  push(-hw + inset0X, h0,  hd - inset0Z, -hw + insetTopX, h, -hd + insetTopZ, -hw + insetTopX, h,  hd - insetTopZ)

  // Flat top
  push(-hw + insetTopX, h, -hd + insetTopZ,  hw - insetTopX, h, -hd + insetTopZ,  hw - insetTopX, h, hd - insetTopZ)
  push(-hw + insetTopX, h, -hd + insetTopZ,  hw - insetTopX, h,  hd - insetTopZ, -hw + insetTopX, h, hd - insetTopZ)

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3))
  return geo
}
