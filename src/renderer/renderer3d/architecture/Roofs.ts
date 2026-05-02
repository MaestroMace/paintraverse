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

/* ------------------------------------------------------------------ */
/* Eave / gable math — single source of truth for ornament alignment  */
/* ------------------------------------------------------------------ */

/**
 * Eave overhang projection (m past the wall plane) per roof style.
 * EVERY ornament that has to align with the gable triangle plane —
 * bargeboards, gable attic windows, peak finials, ridge cap, eave
 * brackets, roof moss patches — pulls these constants from here so
 * tweaking the overhang only requires changing one place.
 *
 * Hipped projects less because all four edges slope; a heavy overhang
 * on a hipped roof reads as a flat shelf rather than an eave.
 * Gabled/steep are the same — the "long eave" effect we want in town.
 * Mansard has its own value (slightly less than gabled because the
 * steep lower pitch already lands well past the wall face).
 * Other styles (flat/pointed/spire/cone/dome) have no straight eave,
 * so eave-aware ornaments skip them.
 */
export const EAVE_PROJ_GABLED = 0.26
export const EAVE_PROJ_HIPPED = 0.18
export const EAVE_PROJ_MANSARD = 0.20

/** Eave overhang for the given roof style, or 0 for styles without an eave. */
export function eaveProjFor(style: RoofStyle): number {
  switch (style) {
    case 'gabled':
    case 'steep':
      return EAVE_PROJ_GABLED
    case 'hipped':
      return EAVE_PROJ_HIPPED
    case 'mansard':
      return EAVE_PROJ_MANSARD
    default:
      return 0
  }
}

/**
 * Geometric values describing a prism roof's gable + slope, useful for
 * placing ornaments (bargeboards, attic windows, peak finials, moss
 * patches, ridge cap, etc) so they sit exactly on the visible roof
 * geometry rather than at the underlying wall plane.
 *
 *   gableExtent — distance along the RIDGE axis from volume center to
 *                 the gable triangle plane (= half-side + eave overhang).
 *   perpExtent  — distance along the PERP axis from volume center to
 *                 the eave edge (= half-other-side + eave overhang).
 *   slopeAngle  — angle of slope from horizontal: atan2(roofHeight, perpExtent).
 *   slopeLen    — Euclidean slope edge length, eave corner → ridge peak.
 *   ridgeOnX    — true if the ridge runs along X (gables face ±X).
 */
export interface GableMath {
  ridgeOnX: boolean
  gableExtent: number
  perpExtent: number
  slopeAngle: number
  slopeLen: number
}

export function gableMath(args: {
  width: number
  depth: number
  roofHeight: number
  roofStyle: RoofStyle
  roofAxis: RoofAxis
}): GableMath {
  const ridgeOnX = args.roofAxis === 'x'
  const eave = eaveProjFor(args.roofStyle)
  const gableExtent = (ridgeOnX ? args.width : args.depth) / 2 + eave
  const perpExtent = (ridgeOnX ? args.depth : args.width) / 2 + eave
  const slopeAngle = Math.atan2(args.roofHeight, perpExtent)
  const slopeLen = Math.sqrt(perpExtent * perpExtent + args.roofHeight * args.roofHeight)
  return { ridgeOnX, gableExtent, perpExtent, slopeAngle, slopeLen }
}


export function buildRoof(
  w: number, d: number, h: number,
  style: RoofStyle,
  axis: RoofAxis = 'x',
  /** Ridge sag (0..0.12 of h). Drops the ridge midpoint by sag*h. Only
   *  applied to gabled/steep prism roofs — hipped, mansard, cone, dome are
   *  unaffected. Pass via the optional roofSag context from Massing. */
  sag: number = 0,
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

  // gabled / hipped / steep all use the prism. Hipped never sags (different
  // topology — both X and Z slopes meet a short ridge). Steep & gabled get
  // the optional ridge sag.
  const hipped = style === 'hipped'
  return buildGablePrism(w, d, h, axis, hipped, hipped ? 0 : sag)
}

/* ------------------------------------------------------------------ */
/* Gable / hip prism                                                  */
/* ------------------------------------------------------------------ */

function buildGablePrism(w: number, d: number, h: number, axis: RoofAxis, hipped: boolean, sag: number = 0): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2
  // Eave projection — see EAVE_PROJ_* constants for rationale.
  const eaveProj = hipped ? EAVE_PROJ_HIPPED : EAVE_PROJ_GABLED
  const ow = hw + eaveProj, od = hd + eaveProj

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
  } else if (sag > 0.001) {
    // Subdivided gabled prism with a sagged ridge. Each slope splits into
    // two quads sharing a midpoint vertex on the ridge that has been
    // dropped by sag*h — the geometric signature of a beam that's settled
    // over centuries. Gable end triangles are unchanged because the ridge
    // peaks are at the gable corners, not in the middle.
    const my = h - sag * h     // sagged ridge midpoint Y
    if (axis === 'x') {
      // Ridge along X with midpoint M=(0, my, 0). Eave midpoints F=(0,0,od)
      // and B=(0,0,-od) split the slopes lengthwise.
      verts = [
        // +Z slope, left half quad: (-ow,0,od) → F → M → (-ow,h,0)
        -ow, 0,  od,   0, 0,  od,   0, my, 0,
        -ow, 0,  od,   0, my, 0,   -ow, h, 0,
        // +Z slope, right half quad: F → (ow,0,od) → (ow,h,0) → M
         0, 0,  od,    ow, 0,  od,   ow, h, 0,
         0, 0,  od,    ow, h, 0,    0, my, 0,
        // -Z slope, left half (from -Z view, x flipped): (ow,0,-od) → B → M → (ow,h,0)
         ow, 0, -od,   0, 0, -od,   0, my, 0,
         ow, 0, -od,   0, my, 0,    ow, h, 0,
        // -Z slope, right half: B → (-ow,0,-od) → (-ow,h,0) → M
         0, 0, -od,   -ow, 0, -od,  -ow, h, 0,
         0, 0, -od,   -ow, h, 0,    0, my, 0,
        // +X gable (peak unchanged, sits at full h)
         ow, 0, -od,   ow, 0,  od,   ow, h, 0,
        // -X gable
        -ow, 0,  od,  -ow, 0, -od,  -ow, h, 0,
      ]
    } else {
      // Ridge along Z with midpoint M=(0, my, 0). Eave midpoints F=(ow,0,0)
      // and B=(-ow,0,0) split the slopes.
      verts = [
        // +X slope, front half: (ow,0,-od) → F → M → (0,h,-od)
         ow, 0, -od,    ow, 0,  0,    0, my, 0,
         ow, 0, -od,    0, my, 0,    0, h, -od,
        // +X slope, back half: F → (ow,0,od) → (0,h,od) → M
         ow, 0,  0,     ow, 0,  od,   0, h,  od,
         ow, 0,  0,     0, h,  od,    0, my, 0,
        // -X slope, front half: (-ow,0,od) → B → M → (0,h,od)
        -ow, 0,  od,   -ow, 0,  0,    0, my, 0,
        -ow, 0,  od,    0, my, 0,    0, h,  od,
        // -X slope, back half: B → (-ow,0,-od) → (0,h,-od) → M
        -ow, 0,  0,    -ow, 0, -od,   0, h, -od,
        -ow, 0,  0,    0, h, -od,    0, my, 0,
        // +Z gable
        -ow, 0,  od,   ow, 0,  od,   0, h,  od,
        // -Z gable
         ow, 0, -od,  -ow, 0, -od,   0, h, -od,
      ]
    }
  } else {
    // Gabled (no sag): ridge runs full length along chosen axis, gable triangles on the other.
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
  const ow = hw + EAVE_PROJ_MANSARD, od = hd + EAVE_PROJ_MANSARD
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
