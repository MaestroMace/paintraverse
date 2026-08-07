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
