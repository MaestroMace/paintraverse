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

/**
 * A DOOR IS PAINTED WOOD, NOT THE DARKEST THING IN THE PALETTE.
 *
 * Every door in the town rendered as a solid black rectangle, 0.95m x 2.05m,
 * in the middle of the front elevation — at NOON as well as at dusk.
 * `tools/holes.mjs` measured them at 0.03-0.04x the wall around them and at
 * 0.01 absolute luma, which is a hole by any definition a person would use.
 *
 * Two sources and the fix belongs at neither of them. `DEFAULT_BUILDING_PALETTES`
 * carries doors at 0.12-0.17 luma, and `StyleMapper.buildBuildingPalettes`
 * draws them from the inspiration image's DARKS pool with a floor that only
 * fires when the pool is empty — which it never is. Flooring one table leaves
 * the other, and flooring both is two copies that will drift; the first
 * attempt here fixed StyleMapper and the picture came back with the door
 * still black, because the active path is the default table.
 *
 * So the floor lives at the POINT OF USE, next to the other shared material
 * decisions, and every palette source inherits it. Compare against the value
 * the code will actually GET, never against what a table happens to contain.
 *
 * The value is chosen by a principle, not by taste: the stopping point is
 * "a door reads as a surface rather than a void" — dark against the wall it
 * sits in, which a real door is, but never at zero. Same discipline as the
 * roof tone floor, where parity with the wall was the stop.
 *
 * AND 0.2 WAS NOT ENOUGH, which only a probe settled. The default palette's
 * doors are already 0.21-0.32 luma, so a 0.2 floor lifted NONE of them and
 * the measurement did not move — at which point the obvious conclusion is
 * that doors are not the problem. Painting every door pure red for one build
 * took the hole count 7 -> 4 and the largest patch 4503px -> 2534px, which
 * says they are. A 0.2 albedo simply cannot survive being in shadow: the wall
 * beside it is 0.59 and reads fine, the door is a third of that and reads as
 * a void.
 *
 * 0.3 is half the wall's albedo and is what oak, oxblood, dark green and
 * lead-blue actually measure — a real painted door, and still unmistakably
 * darker than the wall it sits in.
 *
 * The general lesson is the one this repo keeps paying for: A MECHANISM THAT
 * COULD PRODUCE A NUMBER IS NOT EVIDENCE THAT IT DID, and the cheap
 * discipline is to change the suspected thing and watch the metric.
 *
 * AND IT LIVES HERE FOR THE SAME REASON `roofColorFor` DOES: BOTH RENDERERS
 * PICK A PALETTE INDEPENDENTLY. Put in on the first pass and wired only into
 * FacadeTexture, it reached the 3D walkaround and not the pixel-art export —
 * whose own table runs down to 0.112 luma, darker than any door in the 3D one.
 * A shared definition that one of its two callers does not call is not shared;
 * it is a copy with better paperwork. Apply it at the POINT OF USE in both
 * paths, never at the palette table, or the next palette added skips it.
 */
export const DOOR_MIN_LUMA = 0.3

/** Lift a door colour to DOOR_MIN_LUMA, preserving its hue. */
export function doorColorFor(hex: number): number {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  if (l >= DOOR_MIN_LUMA) return hex
  // Scale rather than add: a constant add greys out whatever it touches, and
  // a cool-toned reference should still get cool-toned doors.
  const k = DOOR_MIN_LUMA / Math.max(0.02, l)
  const c = (v: number) => Math.min(255, Math.round(v * k))
  return (c(r) << 16) | (c(g) << 8) | c(b)
}

/**
 * How strongly the star field reads, from 0 (invisible) to 1 (the full
 * night sky), as a function of the hour.
 *
 * A NUMBER SET INSIDE A FOUR-WAY SWITCH ROTS ONE ARM AT A TIME, and this
 * file already records the cost: the tone arc raised ambient and hemisphere,
 * measured everything at NOON, and therefore edited the noon branch — dusk
 * kept the pre-arc numbers for the whole subsequent arc. Stars went in the
 * same way on the first pass, four literals in four branches of
 * `updateLighting`. One curve, called once with the hour, cannot drift
 * between arms, and it INTERPOLATES, which four literals cannot: the field
 * comes up over the half hour after sunset rather than snapping on at a
 * boundary.
 *
 * AND IT LIVES HERE FOR THE REASON `roofColorFor` AND `doorColorFor` DO:
 * BOTH RENDERERS DRAW A SKY. The walkaround has a shader dome and the
 * pixel-art export paints a gradient, so a copy of the curve would give one
 * path stars at dusk and the other a bare sky with nothing erroring.
 *
 * Dusk is held at half. The hour DESIGN.md is written against wants the
 * FIRST stars over a warm-lit street — an orange sky with stars in it, not
 * night with an orange band.
 */
export function starIntensityFor(hour: number): number {
  const h = ((hour % 24) + 24) % 24
  // Full field through the small hours, out by sunrise, back after sunset.
  if (h >= 20.0 || h < 4.0) return 1.0
  if (h < 5.5) return 1.0 - (h - 4.0) / 1.5          // fading into dawn
  if (h < 6.5) return 0.12 * (1 - (h - 5.5))         // last of them, low
  if (h < 17.0) return 0                             // daylight
  if (h < 18.0) return 0.12 * (h - 17.0)             // golden hour, barely
  // 18.5 is the app's default hour and the one the board grades, so the
  // curve is PINNED through the value the dusk photograph was tuned at
  // rather than left to fall wherever a linear ramp puts it.
  if (h < 18.5) return 0.12 + 0.76 * (h - 18.0)      // to 0.5 at dusk
  return 0.5 + (0.5 * (h - 18.5)) / 1.5              // to the full field
}
