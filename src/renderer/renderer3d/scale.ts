/**
 * The horizontal tile → world factor for the 3D walkaround.
 *
 * ## Why this exists
 *
 * The 3D scene used to treat one map tile as one world unit. Combined with
 * `EYE_HEIGHT = 1.6`, that made one tile one metre — and since 60% of all
 * structures have a 1- or 2-tile footprint, the typical building was
 * 1m wide x 2m deep x ~7m tall. A 7:1 tower. Reported from the device as
 * "houses the size of cars with windows as big as inches", which is literally
 * true: a 1m-wide facade can only fit inch-wide windows.
 *
 * The measurement that matters: median building top was 6.96 units against a
 * 1.6 eye height — about 4.3x eye height, and a real two-storey house is
 * ~4.1x. **The heights were already right.** Only the horizontal was wrong.
 *
 * This is why raising FLOOR_HEIGHT 1.05 -> 1.8 (to cure "kaiju scale") did not
 * fix it: that treated a horizontal problem with a vertical lever. It stopped
 * buildings being squat and made them needles instead. Don't reach for
 * FLOOR_HEIGHT again.
 *
 * ## What it means
 *
 * One tile is TILE metres across. World units ARE metres — the player's eye is
 * at 1.6 of them. A 1x2 row house is now 3m x 6m x ~7m: narrow, as a terrace
 * should be, but a building rather than a phone box.
 *
 * ## The rule for using it
 *
 * Multiply by TILE when converting a **tile coordinate or a footprint extent**
 * into world space. Do NOT multiply anything already expressed in metres.
 * Nearly every hardcoded number in the geometry code — a 0.4m chimney, a 0.9m
 * door, a 0.08m doorstep lip — is already metric and correct. Those details
 * only ever looked wrong because the buildings around them were too small.
 *
 * Vertical is untouched: TERRAIN_WORLD_SCALE still maps raw height units to
 * world height, FLOOR_HEIGHT is still metres per storey.
 */
export const TILE = 3.0

/** Tile coordinate (or footprint extent) → world units. */
export function tileToWorld(tiles: number): number {
  return tiles * TILE
}

/** World units → tile coordinate. Inverse of tileToWorld. */
export function worldToTile(world: number): number {
  return world / TILE
}

/**
 * Floor-to-floor height, in metres. The ONE definition — Massing's
 * volumeFloors and BuildingFactory's FLOOR_HEIGHT both read it, because two
 * copies of "how tall is a storey" is how the facade ended up painting six
 * rows of windows onto a three-storey wall.
 *
 * ## Why 2.9 and not 1.8
 *
 * The human-scale audit (tools/humanscale.mjs) measured a median storey of
 * 1.91m against a 1.75m person: 59% of buildings had less head-to-ceiling
 * clearance than a person is tall, and 95% of painted doors were SHORTER than
 * a person. A real floor-to-floor is 2.6-3.2m.
 *
 * The old warning against raising this — that it turns buildings into needles
 * — was written when a building was one to three world units WIDE. It no
 * longer applies: at TILE = 3 a three-storey house is 8.7m of wall on a 6-9m
 * frontage, which is a townhouse. Check tools/humanscale.mjs after changing
 * it, not a screenshot.
 */
export const STOREY_HEIGHT = 2.9

/**
 * The narrowest wall a person could stand a room behind, in metres, and the
 * shortest habitable wall.
 *
 * Massing templates inset their volumes as a FRACTION of the footprint — a
 * jetty takes up to 54% off the lower floor, an L-wing is 55% of the frontage
 * — and then wealthScale can take another 22%. Compounded, a one-tile row
 * house came out with a 0.55m frontage and a 0.91m wall: a doghouse with a
 * 2m door painted on it. The audit calls that out as a 5.4x spread between the
 * 10th and 90th percentile building.
 *
 * Each template already had a floor for this (`Math.max(0.9, ...)`), but those
 * numbers were chosen when a tile was a world unit, so they meant 0.9 of a
 * TILE and now mean 0.9 of a metre. These are the honest replacements, and
 * they are enforced once at the end of massing rather than in twelve places.
 */
export const MIN_HABITABLE_W = 2.6
