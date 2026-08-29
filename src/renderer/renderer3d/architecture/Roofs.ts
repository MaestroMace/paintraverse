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
  // A SINGLE SLOPE. The one primitive this library did not have, and its
  // absence was load-bearing: `tmplLeanTo`'s comment says in as many words
  // that it builds a stepped pair of flat boxes "because there is no
  // mono-pitch roof primitive and a gable would make this a small cottage,
  // which is the opposite of the point" — and then the open-box repair pass
  // put a HIPPED roof on both halves, so every lean-to in the slum was two
  // small cottages after all. A template working around a missing primitive
  // is a request for the primitive.
  | 'shed'

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
    case 'shed':
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
 *   ridgeHalf   — half the length of the RIDGE LINE itself (see ridgeHalfLen).
 */
export interface GableMath {
  ridgeOnX: boolean
  gableExtent: number
  perpExtent: number
  slopeAngle: number
  slopeLen: number
  ridgeHalf: number
}

/**
 * HALF-LENGTH OF THE RIDGE LINE at the peak, measured along the roof's axis.
 *
 * A gabled prism's ridge runs the whole way out to both gable faces, so this
 * is just the gable extent. **A HIP'S RIDGE IS SHORTER, and by exactly how
 * much is not a taste decision**: the hip end rakes back so it slopes at the
 * same pitch as the two sides, which puts each ridge end one half-DEPTH in
 * from the eave. On a square plan that reaches zero and the roof becomes a
 * pyramid, which is what a hip on a square plan is.
 *
 * Exported because `buildGablePrism` and every ornament that sits on the ridge
 * have to agree about where the ridge ENDS, and they did not: the cap restated
 * the prism's inset as `min(w,d)/2 * 0.25` — a fair copy of a value that was
 * never the ridge at all, because the old hip topped out in a flat SQUARE
 * plateau of that half-side. A 6m building therefore carried a 5.25m cap over
 * a 0.75m plateau: a board at peak height, jutting two metres past each end
 * into the air over the hip slopes, on every hipped roof in the town.
 */
export function ridgeHalfLen(alongExtent: number, perpExtent: number, hipped: boolean): number {
  return hipped ? Math.max(0, alongExtent - perpExtent) : alongExtent
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
  const ridgeHalf = ridgeHalfLen(gableExtent, perpExtent, args.roofStyle === 'hipped')
  return { ridgeOnX, gableExtent, perpExtent, slopeAngle, slopeLen, ridgeHalf }
}


/**
 * Maximum roof height as a multiple of the roof's OWN base span.
 *
 * Roof heights are derived from wall height (see Massing.roofHeightFor), which
 * already compounds floors x FLOOR_HEIGHT x HEIGHT_MULT. On a slim volume —
 * a spire tower is ~0.35 of the building's short side — that produced roofs
 * tens of metres tall on a ~1m base: 45:1 needles stabbing out of the town.
 * A roof taller than a few times its own footprint stops reading as a roof,
 * so clamp here, the one place the base dimensions are actually known (every
 * template and any future caller routes through buildRoof).
 */
export const MAX_ROOF_SPAN_RATIO: Record<RoofStyle, number> = {
  none: 0, flat: 0,
  hipped: 1.3, gabled: 1.4, mansard: 1.2, dome: 1.3,
  // A real Gothic spire runs 5-7x its base width (Salisbury ~6.7, Freiburg
  // ~5); 3.0 was chosen when the ask was a runaway multiple of wallH and the
  // cap was the only thing standing between the skyline and a 74m needle.
  // With riseForSpan below deriving the ask from the span, the cap goes back
  // to being a backstop and can sit where the architecture is.
  steep: 1.9, pointed: 2.4, spire: 3.8,
  // A shed roof is a lean-to's whole silhouette and it is SHALLOW — a single
  // slope steeper than about 30 degrees stops reading as a lean-to and starts
  // reading as half a gable that lost its other half.
  shed: 0.75,
}

/**
 * THE RISE A TALL ROOF SHOULD HAVE, FROM ITS OWN SPAN.
 *
 * roofHeightFor() in Massing derives every rise from wallH — a VERTICAL
 * quantity — and clampRoofHeight caps against the volume's own width, a
 * HORIZONTAL one. For the shallow styles the two happen to land in the same
 * range and the cap catches a tail. For the tall ones they never agree, so the
 * cap always won:
 *
 *     spire    n=25   p10 3.00  med 3.00  p90 3.00   96% at the cap
 *     pointed  n=85   p10 1.05  med 2.16  p90 2.40   48% at the cap
 *
 * Every spire in a 300-building town was EXACTLY 3.0x its span — one shape,
 * repeated, and no aggregate could see it because a perfectly uniform value
 * has a perfectly healthy median. The template's variation was being computed
 * and then thrown away.
 *
 * A pitch is a rise over a SPAN. Ask for it that way and the style vector
 * produces real variation, under the cap by construction rather than at it.
 * Same shape as ensureRoofPitch, which fixed the opposite failure — a rise too
 * SMALL for a span that had tripled.
 */
const SPAN_PITCH: Partial<Record<RoofStyle, [number, number]>> = {
  spire: [2.15, 3.7],
  pointed: [1.3, 2.35],
}

/**
 * AND A CEILING AGAINST THE WALL IT SITS ON.
 *
 * MAX_ROOF_SPAN_RATIO caps the rise against the volume's SPAN, so a wide
 * building is permitted an enormous roof however short its walls are — and
 * riseForSpan above, which fixed the spire uniformity, derives the ask from
 * the span too. Nothing ever compared the roof to the building under it:
 *
 *     ROOF as a fraction of the WALL, before this
 *       p10 32%   med 74%   p90 313%   max 412%
 *       42% of dwellings carried a roof as tall as the house or taller
 *
 * A real gable on a two- or three-storey house rises 30-50% of its wall. One
 * dwelling in ten had a roof THREE TIMES the height of the building under it,
 * and at dusk that is a black triangle with a cottage beneath it. Every part
 * was individually legal and the proportion was nobody's job.
 *
 * Generous on purpose: a barn legitimately carries a roof taller than its
 * walls, and the tall styles are supposed to be tall. This is here to cut the
 * tail, not to flatten the town — the median barely moves.
 */
const MAX_ROOF_WALL_RATIO: Record<RoofStyle, number> = {
  none: 0, flat: 0,
  hipped: 0.85, gabled: 0.95, mansard: 0.80, dome: 0.90,
  steep: 1.25, pointed: 1.70, spire: 2.60,
  // A shed on a low wall is the one case where a big roof-to-wall ratio is
  // the type rather than the defect — but only just; a lean-to is mostly wall.
  shed: 0.70,
}

/**
 * Cap a roof against the wall under it. Applied LAST, after the span floor and
 * the span cap, because it is the one that knows about proportion — and a
 * clamp that is not last is not a clamp. Floored at 0.6m so cutting a runaway
 * can never produce a flat slab, which is the opposite defect.
 */
export function clampRoofToWall(wallH: number, h: number, style: RoofStyle): number {
  const cap = wallH * MAX_ROOF_WALL_RATIO[style]
  return cap > 0 && h > cap ? Math.max(0.6, cap) : h
}

/** Rise for a span-dominated style, or null if this style is not one. */
export function riseForSpan(
  w: number, d: number, style: RoofStyle, roofPitch: number, jitter = 0,
): number | null {
  const range = SPAN_PITCH[style]
  if (!range) return null
  const span = (w + d) / 2
  const t = Math.max(0, Math.min(1, roofPitch + jitter))
  return span * (range[0] + t * (range[1] - range[0]))
}

/**
 * The other half of the same question: how SHALLOW may a roof get?
 *
 * roofHeightFor() in Massing derives the rise from wallH alone. That was fine
 * while a roof spanned one or two world units, and stopped being fine the
 * moment a tile became three metres: the rise stayed put while the span it
 * crosses tripled, so every pitch in the town flattened by roughly a third. A
 * 40-degree gable became a 23-degree one, and a shallow slab on a wide
 * building does not read as a roof — it reads as a building someone stopped
 * working on. That is the "half built roofs" in the reports.
 *
 * These are rise / half-span, i.e. tan(pitch), expressed against the span the
 * roof actually crosses so they cannot drift with the tile factor again:
 *   hipped 35 deg · gabled 40 · steep 55 · pointed 63 · spire 72
 */
const MIN_ROOF_SPAN_RATIO: Record<RoofStyle, number> = {
  none: 0, flat: 0,
  hipped: 0.35, gabled: 0.42, mansard: 0.32, dome: 0.40,
  steep: 0.71, pointed: 0.98, spire: 1.54,
  // Floor and ceiling deliberately close together: the pitch of a lean-to is
  // not a style choice, it is whatever sheds the rain off the back of the
  // building it leans on.
  shed: 0.30,
}

/**
 * Raise a roof to at least an architectural pitch for its span. Always applied
 * BEFORE clampRoofHeight, which owns the ceiling — the minimum is strictly
 * below the maximum for every style, so the two can never fight.
 */
export function ensureRoofPitch(
  w: number, d: number, h: number, style: RoofStyle
): number {
  const ratio = MIN_ROOF_SPAN_RATIO[style]
  if (ratio <= 0) return h
  // A prism roof crosses its SHORT dimension; using the short side for the
  // symmetric styles too just makes this conservative rather than wrong.
  const span = Math.min(w, d)
  return Math.max(h, span * ratio)
}

/**
 * Clamp a roof height to stay proportional to its own base span. Applied to
 * the Volume in pickMassing so that ridge caps, finials, weather vanes,
 * dormers and attic windows — all of which position against v.roofHeight —
 * agree with the roof that actually gets drawn. Idempotent, so buildRoof
 * re-applies it as a safety net for any caller that bypasses massing.
 */
export function clampRoofHeight(
  w: number, d: number, h: number, style: RoofStyle
): number {
  const cap = ((w + d) / 2) * MAX_ROOF_SPAN_RATIO[style]
  return cap > 0 && h > cap ? cap : h
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

  h = clampRoofHeight(w, d, h, style)

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

  if (style === 'shed') {
    return buildShed(w, d, h, axis)
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


/**
 * Force every triangle in a CONVEX solid to face outward.
 *
 * Roof vertex lists are written by hand, and hand-written winding has been
 * wrong in this file four separate times — the gable ends for one axis, the
 * slopes for the other, all four hipped slopes plus its top cap, and every
 * triangle of the mansard. Each one is invisible rather than merely mis-lit,
 * because the batched material is FrontSide, and each survived review because
 * you cannot see a face that is not drawn.
 *
 * So winding stops being something a person maintains. For a convex solid the
 * outward direction at a triangle is simply "away from the solid's centroid",
 * which is exactly the test tools/roofwinding.mjs applies — running the same
 * test as a repair means the audit cannot fail on anything that goes through
 * here. Every roof shape in this file is convex.
 */
function enforceOutwardWinding(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const src = geo.index ? geo.toNonIndexed() : geo
  const pos = src.getAttribute('position') as THREE.BufferAttribute
  const a = pos.array as Float32Array
  let gx = 0, gy = 0, gz = 0
  for (let i = 0; i < pos.count; i++) { gx += a[i * 3]; gy += a[i * 3 + 1]; gz += a[i * 3 + 2] }
  gx /= pos.count; gy /= pos.count; gz /= pos.count
  for (let t = 0; t + 2 < pos.count; t += 3) {
    const o = t * 3
    const ax = a[o], ay = a[o + 1], az = a[o + 2]
    const bx = a[o + 3], by = a[o + 4], bz = a[o + 5]
    const cx = a[o + 6], cy = a[o + 7], cz = a[o + 8]
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az
    const nx = e1y * e2z - e1z * e2y
    const ny = e1z * e2x - e1x * e2z
    const nz = e1x * e2y - e1y * e2x
    const dx = (ax + bx + cx) / 3 - gx
    const dy = (ay + by + cy) / 3 - gy
    const dz = (az + bz + cz) / 3 - gz
    if (nx * dx + ny * dy + nz * dz < 0) {
      // Swap the last two vertices — the minimal edit that reverses a winding.
      a[o + 3] = cx; a[o + 4] = cy; a[o + 5] = cz
      a[o + 6] = bx; a[o + 7] = by; a[o + 8] = bz
    }
  }
  pos.needsUpdate = true
  return src
}

function buildGablePrism(w: number, d: number, h: number, axis: RoofAxis, hipped: boolean, sag: number = 0): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2
  // Eave projection — see EAVE_PROJ_* constants for rationale.
  const eaveProj = hipped ? EAVE_PROJ_HIPPED : EAVE_PROJ_GABLED
  const ow = hw + eaveProj, od = hd + eaveProj

  let verts: number[]

  if (hipped) {
    // A REAL HIP HAS A RIDGE LINE, running along `axis`, ending one half-depth
    // in from each eave so the hip end slopes at the same pitch as the sides.
    // See ridgeHalfLen — this used to top out in a flat SQUARE plateau of side
    // 2*min(hw,hd)*0.25, which is a truncated pyramid rather than a hip, and
    // it is why the ridge cap read as a plank floating over the roof.
    //
    // Two eave corners plus the nearer ridge END make each face. When the plan
    // is square the ridge collapses to a point and all four faces become the
    // triangles of a pyramid, which is correct. Winding is not maintained by
    // hand — `enforceOutwardWinding` repairs it — so only the topology matters.
    const rh = ridgeHalfLen(axis === 'x' ? ow : od, axis === 'x' ? od : ow, true)
    const rA: [number, number, number] = axis === 'x' ? [-rh, h, 0] : [0, h, -rh]
    const rB: [number, number, number] = axis === 'x' ? [rh, h, 0] : [0, h, rh]
    // Eave corners, named by compass so the faces below read.
    const NW: [number, number, number] = [-ow, 0, -od]
    const NE: [number, number, number] = [ow, 0, -od]
    const SE: [number, number, number] = [ow, 0, od]
    const SW: [number, number, number] = [-ow, 0, od]
    verts = []
    /** One face: an eave edge rising to one or two ridge points. */
    const face = (a: number[], b: number[], p: number[], q: number[]) => {
      verts.push(...a, ...b, ...q)
      // Degenerate when the ridge collapses (pyramid) or the face is a hip end.
      if (p[0] !== q[0] || p[2] !== q[2]) verts.push(...a, ...q, ...p)
    }
    if (axis === 'x') {
      face(SW, SE, rA, rB)      // +Z side, long
      face(NE, NW, rB, rA)      // -Z side, long
      face(SE, NE, rB, rB)      // +X hip end
      face(NW, SW, rA, rA)      // -X hip end
    } else {
      face(SE, NE, rB, rA)      // +X side, long
      face(NW, SW, rA, rB)      // -X side, long
      face(SW, SE, rB, rB)      // +Z hip end
      face(NE, NW, rA, rA)      // -Z hip end
    }
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
        // +X gable (peak unchanged, sits at full h). Winding runs
        // (0,od)->(0,-od)->peak so the normal points OUT along +X; the
        // reverse order left the triangle facing into the roof cavity,
        // which culls it and lets you see the sky through the gable.
         ow, 0,  od,   ow, 0, -od,   ow, h, 0,
        // -X gable
        -ow, 0, -od,  -ow, 0,  od,  -ow, h, 0,
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
        // +X gable — outward normal must be +X, so the base edge runs
        // +od -> -od before the peak. See the note on the sagged variant.
         ow, 0,  od,   ow, 0, -od,   ow, h, 0,
        // -X gable
        -ow, 0, -od,  -ow, 0,  od,  -ow, h, 0,
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

  // SOFFIT — the roof's underside, closing the prism into a solid.
  //
  // Without it the roof is an open shell: two slopes and two gable ends. That
  // is invisible from above, and from the street it is the defect, because the
  // eave PROJECTS past the wall. Standing under a 4m eave and looking up, the
  // slopes' undersides are backfaces and get culled, so you see straight
  // through the roof to the sky — and the only thing left drawn is the trim,
  // which is closed boxes and so survives as a set of dark lines hanging in
  // mid-air. That is what "floating accent timbers" looked like once the
  // gables stopped covering for it.
  //
  // Wound to face -Y so it is the outside of the solid, not the inside.
  verts.push(
    -ow, 0, -od,   ow, 0, -od,   ow, 0,  od,
    -ow, 0, -od,   ow, 0,  od,  -ow, 0,  od,
  )

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3))
  return enforceOutwardWinding(geo)
}

/* ------------------------------------------------------------------ */
/* Mansard — two-pitch roof (steep lower, shallow upper)              */
/* ------------------------------------------------------------------ */

/**
 * A MONO-PITCH — one plane falling from a high eave to a low one.
 *
 * A convex wedge, so `enforceOutwardWinding` can repair it the same way it
 * repairs the prism and the mansard: winding has been wrong by hand in this
 * file four separate times, and the only reason it is safe to add a fifth
 * solid is that nothing here maintains it by hand any more.
 *
 * `axis` names the direction the HIGH EAVE RUNS ALONG, matching the prism's
 * convention that the axis is the ridge — a shed's high edge is its ridge with
 * nothing on the other side of it. The slope therefore falls across the
 * perpendicular, which for a 1x2 footprint is the short way, which is what a
 * lean-to against a party wall actually does.
 */
function buildShed(w: number, d: number, h: number, axis: RoofAxis): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2
  const e = EAVE_PROJ_GABLED
  const ow = hw + e, od = hd + e
  // Corners of the sloped plane, named by where they sit: HI is the tall eave.
  // Written for axis 'x' (high edge running along X at -Z) and mirrored into
  // the other axis by swapping the two horizontal components, rather than by
  // a second hand-written vertex list — the second list is where the four
  // historical winding bugs lived.
  const P = (u: number, y: number, v: number): [number, number, number] =>
    axis === 'x' ? [u, y, v] : [v, y, u]
  const hiL = P(-ow, h, -od), hiR = P(ow, h, -od)
  const loL = P(-ow, 0, od), loR = P(ow, 0, od)
  const btL = P(-ow, 0, -od), btR = P(ow, 0, -od)
  const tri = (a: number[], b: number[], c: number[]): number[] => [...a, ...b, ...c]
  const verts = [
    // The slope itself
    ...tri(hiL, hiR, loR), ...tri(hiL, loR, loL),
    // The tall end wall under the high eave
    ...tri(btL, btR, hiR), ...tri(btL, hiR, hiL),
    // Two triangular flanks
    ...tri(btR, loR, hiR), ...tri(btL, hiL, loL),
    // Underside, so the roof is not an open shell seen from the street below
    ...tri(btL, loL, loR), ...tri(btL, loR, btR),
  ]
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3))
  geo.computeVertexNormals()
  return enforceOutwardWinding(geo)
}

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

  // Mansard had every one of its 18 triangles wound inward, so the whole roof
  // was invisible. Same enforcement as the prism — it also needs a soffit,
  // since like the prism it is an open shell whose eave projects.
  v.push(
    -hw, 0, -hd,   hw, 0, -hd,   hw, 0,  hd,
    -hw, 0, -hd,   hw, 0,  hd,  -hw, 0,  hd,
  )
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3))
  return enforceOutwardWinding(geo)
}

/* ------------------------------------------------------------------ */
/* Winding audit                                                      */
/* ------------------------------------------------------------------ */

/**
 * Exhaustive check that every roof triangle faces OUTWARD.
 *
 * The batched material is FrontSide, so a triangle wound the wrong way is not
 * merely mis-lit — it is deleted. "Half the roof is invisible from every
 * angle" is exactly what a set of inward-facing triangles looks like, and no
 * screenshot can tell you which ones they are: you cannot photograph a face
 * that is not drawn. Camera-based verification already produced one confident
 * false negative here.
 *
 * So this asks the question directly and without a camera. For each roof shape
 * it builds the geometry, then for every triangle compares the face normal
 * against the direction from the solid's centroid out to that triangle. On a
 * convex solid — which every one of these is — outward faces score positive.
 * Anything negative is a face the player can never see.
 */
export function auditRoofWinding(): Array<{
  style: RoofStyle; axis: RoofAxis; sag: number
  triangles: number; inward: number; inwardCentroids: string[]
}> {
  const out: ReturnType<typeof auditRoofWinding> = []
  // ENUMERATED FROM A COMPILER-CHECKED TABLE, not restated. This was a
  // hand-written list, so adding `shed` to RoofStyle would have added a solid
  // that the one audit standing between this file and invisible roofs never
  // looked at — the ghost failure with a type signature, in the tool built to
  // catch it. `MAX_ROOF_SPAN_RATIO` is a `Record<RoofStyle, number>`, so the
  // compiler refuses to let a style exist without an entry, and the audit now
  // inherits that guarantee. The flat styles build nothing and drop out on
  // their own via the null return below.
  const styles = Object.keys(MAX_ROOF_SPAN_RATIO) as RoofStyle[]
  for (const style of styles) {
    for (const axis of ['x', 'z'] as RoofAxis[]) {
      for (const sag of [0, 0.08]) {
        // Deliberately asymmetric w/d so an axis mix-up cannot cancel out.
        const geo = buildRoof(7, 4.5, 3.2, style, axis, sag)
        if (!geo) continue
        const src = geo.index ? geo.toNonIndexed() : geo
        const pos = src.getAttribute('position')
        const n = pos.count / 3
        // Solid centroid: mean of all vertices. Good enough for a convex prism
        // or cone, and it is the reference the sign test needs.
        let gx = 0, gy = 0, gz = 0
        for (let i = 0; i < pos.count; i++) { gx += pos.getX(i); gy += pos.getY(i); gz += pos.getZ(i) }
        gx /= pos.count; gy /= pos.count; gz /= pos.count
        let inward = 0
        const bad: string[] = []
        for (let t = 0; t < n; t++) {
          const i0 = t * 3, i1 = i0 + 1, i2 = i0 + 2
          const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0)
          const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1)
          const cx2 = pos.getX(i2), cy2 = pos.getY(i2), cz2 = pos.getZ(i2)
          const e1x = bx - ax, e1y = by - ay, e1z = bz - az
          const e2x = cx2 - ax, e2y = cy2 - ay, e2z = cz2 - az
          const nx = e1y * e2z - e1z * e2y
          const ny = e1z * e2x - e1x * e2z
          const nz = e1x * e2y - e1y * e2x
          const tcx = (ax + bx + cx2) / 3 - gx
          const tcy = (ay + by + cy2) / 3 - gy
          const tcz = (az + bz + cz2) / 3 - gz
          const dot = nx * tcx + ny * tcy + nz * tcz
          // Degenerate triangles have a zero normal and no facing at all.
          if (nx * nx + ny * ny + nz * nz < 1e-12) continue
          if (dot < 0) {
            inward++
            if (bad.length < 4) {
              bad.push(`(${tcx.toFixed(1)},${tcy.toFixed(1)},${tcz.toFixed(1)})`)
            }
          }
        }
        out.push({ style, axis, sag, triangles: n, inward, inwardCentroids: bad })
      }
    }
  }
  return out
}
