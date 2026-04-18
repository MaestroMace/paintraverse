/**
 * Parametric architecture module — entry point.
 *
 * High-level flow (once composers are implemented in later commits):
 *   pickArchetypes(district, hash)  →  weighted archetype picks
 *   blendVectors(archetypeVectors, weights)  →  per-building StyleVector
 *   jitterVector(v, hashFn)  →  instance-unique perturbation
 *   composeBuilding(spec, roofBatch, ornamentBatch)  →  meshes
 */

export type { StyleVector, DistrictId, ContinuousAxis } from './StyleVector'
export { blendVectors, jitterVector, CONTINUOUS_AXES } from './StyleVector'
export { ARCHETYPES, ALL_ARCHETYPES } from './Archetypes'
export type { ArchetypeId } from './Archetypes'
export { DISTRICT_BIAS, pickArchetypes } from './DistrictWeights'
export type { ArchetypePick } from './DistrictWeights'

/**
 * Convenience: given a district and a deterministic hash, produce the
 * final blended + jittered style vector for a single building.
 */
import type { StyleVector, DistrictId } from './StyleVector'
import { ARCHETYPES } from './Archetypes'
import { pickArchetypes } from './DistrictWeights'
import { blendVectors, jitterVector } from './StyleVector'

export function buildingStyleVector(district: DistrictId, hash: number): StyleVector {
  const picks = pickArchetypes(district, hash)
  const blended = blendVectors(
    picks.map(p => ARCHETYPES[p.id]),
    picks.map(p => p.w),
  )
  return jitterVector(blended, (salt) => {
    const n = (hash * 2654435761 + salt * 1597334677) >>> 0
    return n / 0xffffffff
  }, 0.08)
}
