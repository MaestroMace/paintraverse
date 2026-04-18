/**
 * Style vector — the "column" of the matrix of equations that produces a
 * unique parametric facade. Each archetype is a fixed column, each building
 * is a weighted sum of a handful of archetypes plus per-instance jitter.
 *
 * Continuous axes live in [0, 1]. Discrete fields (floors, footprint,
 * district) are decided by the dominant archetype, not averaged.
 */

export type DistrictId =
  | 'market' | 'residential' | 'artisan' | 'noble' | 'waterfront'
  | 'temple' | 'slum' | 'garden' | 'harbor' | 'fortress' | 'cemetery'

export const CONTINUOUS_AXES = [
  'roofPitch', 'overhang', 'windowDensity', 'windowRecess',
  'cornice', 'timber', 'stone', 'ornament',
  'wealth', 'weather', 'warmth', 'windowArch',
] as const
export type ContinuousAxis = typeof CONTINUOUS_AXES[number]

export interface StyleVector {
  // Continuous, blendable via weighted mean
  roofPitch: number       // 0 flat → 1 steep spire
  overhang: number        // 0 flush → 1 deep jetty
  windowDensity: number   // 0 sparse → 1 many per floor
  windowRecess: number    // 0 flush → 1 deeply set
  cornice: number         // 0 none → 1 heavy projecting molding
  timber: number          // 0 smooth → 1 dense tudor framing
  stone: number           // 0 wood/plaster → 1 ashlar masonry
  ornament: number        // 0 plain → 1 heavily decorated
  wealth: number          // 0 humble → 1 palatial
  weather: number         // 0 pristine → 1 worn
  warmth: number          // 0 cool stone → 1 warm brick
  windowArch: number      // 0 square → 1 pointed arch

  // Discrete — come from the dominant archetype, not averaged
  floors: number
  footW: number
  footD: number
  district: DistrictId
}

/**
 * Weighted sum of style vectors. Continuous axes linearly averaged;
 * discrete fields (floors, footprint, district) taken from the dominant
 * (highest-weight) input.
 */
export function blendVectors(vs: StyleVector[], weights: number[]): StyleVector {
  if (vs.length === 0) throw new Error('blendVectors: empty input')
  if (vs.length !== weights.length) throw new Error('blendVectors: length mismatch')

  let sum = 0
  for (const w of weights) sum += w
  if (sum <= 0) sum = 1
  const nw = weights.map(w => w / sum)

  let topIdx = 0
  for (let i = 1; i < nw.length; i++) if (nw[i] > nw[topIdx]) topIdx = i

  const out = {} as StyleVector
  for (const axis of CONTINUOUS_AXES) {
    let acc = 0
    for (let i = 0; i < vs.length; i++) acc += vs[i][axis] * nw[i]
    out[axis] = acc
  }
  out.floors = vs[topIdx].floors
  out.footW = vs[topIdx].footW
  out.footD = vs[topIdx].footD
  out.district = vs[topIdx].district
  return out
}

/** Add ±amount to each continuous axis for per-instance variety. */
export function jitterVector(v: StyleVector, hashFn: (salt: number) => number, amount = 0.1): StyleVector {
  const out: StyleVector = { ...v }
  let salt = 1
  for (const axis of CONTINUOUS_AXES) {
    const j = (hashFn(salt++) - 0.5) * 2 * amount
    out[axis] = Math.max(0, Math.min(1, v[axis] + j))
  }
  return out
}
