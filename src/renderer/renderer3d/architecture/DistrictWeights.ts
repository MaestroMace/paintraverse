/**
 * District → archetype bias matrix. Each row is a probability distribution
 * over archetypes for buildings placed in that district. The per-building
 * archetype selection multiplies these biases by hash-seeded noise so the
 * same district still yields visual variety.
 */

import type { DistrictId } from './StyleVector'
import type { ArchetypeId } from './Archetypes'
import { ALL_ARCHETYPES } from './Archetypes'

type BiasRow = Partial<Record<ArchetypeId, number>>

export const DISTRICT_BIAS: Record<DistrictId, BiasRow> = {
  market:      { traverseCozy: 0.6, halfTimberTudor: 0.3, medievalRustic: 0.1 },
  residential: { traverseCozy: 0.5, medievalRustic: 0.3, halfTimberTudor: 0.2 },
  artisan:     { halfTimberTudor: 0.5, traverseCozy: 0.3, medievalRustic: 0.2 },
  noble:       { nobleStone: 0.6, gothicStone: 0.3, mediterraneanStucco: 0.1 },
  waterfront:  { medievalRustic: 0.4, halfTimberTudor: 0.4, traverseCozy: 0.2 },
  temple:      { gothicStone: 0.6, nobleStone: 0.4 },
  slum:        { medievalRustic: 0.6, halfTimberTudor: 0.3, traverseCozy: 0.1 },
  garden:      { mediterraneanStucco: 0.5, traverseCozy: 0.3, nobleStone: 0.2 },
  harbor:      { medievalRustic: 0.5, halfTimberTudor: 0.4, traverseCozy: 0.1 },
  fortress:    { nobleStone: 0.8, gothicStone: 0.2 },
  cemetery:    { gothicStone: 0.8, medievalRustic: 0.2 },
}

/** Deterministic 0..1 from integer hash + salt. */
function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

export interface ArchetypePick { id: ArchetypeId; w: number }

/**
 * Pick up to 3 archetypes for a building. Bias weights are multiplied by
 * hash-seeded noise (0.5–1.0) to create instance-level variety within a
 * district. Returns normalized weights summing to 1.
 */
export function pickArchetypes(district: DistrictId, hash: number): ArchetypePick[] {
  const bias = DISTRICT_BIAS[district] ?? DISTRICT_BIAS.residential

  const scored: ArchetypePick[] = []
  let salt = 101
  for (const id of ALL_ARCHETYPES) {
    const b = bias[id] ?? 0
    if (b <= 0) continue
    const noise = 0.5 + rand01(hash, salt++) * 0.5
    scored.push({ id, w: b * noise })
  }
  scored.sort((a, b) => b.w - a.w)
  const top = scored.slice(0, 3)

  let sum = 0
  for (const p of top) sum += p.w
  if (sum <= 0) return [{ id: 'traverseCozy', w: 1 }]
  return top.map(p => ({ id: p.id, w: p.w / sum }))
}
