/**
 * ROOF MATERIAL — one definition, read by both renderers.
 *
 * Every roof in this town came out of the same palette's `roof` slot, so the
 * largest surface on every building was one colour family and pillar 2's "the
 * eye should never be able to copy-paste one silhouette onto another" was
 * being fought with SHAPE alone. Thatch is the cheapest distinction available
 * because it changes the colour of the biggest thing on the building.
 *
 * IT LIVES HERE RATHER THAN IN BuildingFactory BECAUSE TWO RENDERERS DRAW
 * ROOFS. The 3D walkaround and the pixel-art export path each pick a palette
 * independently, and this repo has already paid for that arrangement three
 * times over — three copies of TERRAIN_COLORS that disagreed about what a
 * tile MEANS, a roof cap table that drifted inside one session, and three
 * dwelling sets that disagreed about what a house is. A value two files derive
 * independently is a value that drifts, and the drift is silent: the town
 * would grow thatched cottages in the walkaround and tiled ones in the export
 * and nothing would error.
 *
 * Both callers hand in `stableHash(obj)`, so a building's roof is the same
 * material in both paths and survives a regenerate.
 */

/** Deterministic 0..1 from an integer hash and a salt. */
function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

/**
 * WHICH TYPES CARRY A STRAW ROOF, and how often.
 *
 * Keyed by TYPE and not by district on purpose. Real towns banned thatch after
 * their first serious fire and it survived on the humble, the rural and the
 * outbuilding — so a cottage keeps it and a shop does not, and the eye reads
 * that as age and poverty without anyone explaining it. A district gate would
 * paint whole quarters uniformly, which is the WALLPAPER failure this repo
 * names: a rate that is the same everywhere differentiates nothing.
 *
 * None of these is 1.0. A terrace of five identical thatched cottages is
 * precisely the copy-paste pillar 2 exists to prevent.
 *
 * An id absent from this table gets 0 — a lookup with a default that is not
 * zero would silently thatch the next building type somebody adds, which is
 * the `getFootprint` defaulting to 1x1 failure one table over.
 */
export const THATCH_ODDS: Readonly<Record<string, number>> = {
  cottage: 0.62, lean_to: 0.7, potting_shed: 0.65, sexton_hut: 0.55,
  stable: 0.5, boathouse: 0.45, washhouse: 0.35, workshop: 0.25,
  // The ordinary small dwellings, at a low rate — a thatched roof every fifth
  // or sixth house on an outer lane, which is what makes a town read as having
  // grown rather than been laid out.
  row_house: 0.12, building_small: 0.14, narrow_house: 0.1,
  almshouse: 0.3,
}

/**
 * Weathered straw. Deliberately not gold: new thatch is a bright yellow that
 * reads as a cartoon, and every roof in this town is a decade old.
 *
 * All three sit well above the roof tone floor, which is a SIDE EFFECT of
 * thatch being genuinely pale and not the reason for the values. The moment
 * `roofBlackPct` starts choosing them the roofs go pale everywhere and
 * pillar 1's dark silhouettes go with them — the same discipline the roof
 * tone floor itself was chosen by: parity with the wall was the stopping
 * point, not whichever number moved the metric most.
 */
export const THATCH_COLORS: readonly number[] = [0x9c8a63, 0xa8946c, 0x8e7d59]

/** Does this building carry thatch? Deterministic in the building's hash. */
export function isThatched(defId: string, hash: number): boolean {
  const odds = THATCH_ODDS[defId] ?? 0
  return odds > 0 && rand01(hash, 1501) < odds
}

/**
 * The roof colour for a building: straw if it is thatched, otherwise whatever
 * its palette asked for. Callers pass their own palette colour so neither
 * renderer has to know about the other's palette table.
 */
export function roofColorFor(defId: string, hash: number, paletteRoof: number): number {
  if (!isThatched(defId, hash)) return paletteRoof
  return THATCH_COLORS[Math.floor(rand01(hash, 1503) * THATCH_COLORS.length)]
}
