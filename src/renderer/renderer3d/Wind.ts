/**
 * THE WIND — one bearing, read by everything that measures it.
 *
 * This lived inside `Weathervanes.ts` for exactly one commit, which was
 * correct while the vanes were the only reader and wrong the moment the
 * banners became the second. A value two files must AGREE on belongs in a
 * neutral place — the argument `core/terrain.ts`, `core/types.ts`,
 * `Materials.ts` and `Beacons.ts` are all built on, and the one this repo has
 * paid for in three drifted terrain tables, a roof-cap table, a dwelling list
 * and a door palette.
 *
 * It is worth naming what made the move obvious: **a flag and a weathervane
 * disagreeing about the wind is worse than either being wrong alone.** One
 * arbitrary bearing reads as a decoration; two arbitrary bearings that
 * contradict each other read as a mistake. The instant there were two
 * consumers, the shared value had to stop being a private detail of one.
 *
 * AND THE TWO POINT OPPOSITE WAYS, WHICH IS THE PHYSICS AND NOT A BUG. A vane
 * points INTO the wind — that is what makes it an instrument — and a flag
 * streams AWAY from it. `windBearing()` is the direction the wind comes FROM,
 * so the vanes take it and the banners take it plus half a turn. Getting that
 * relationship right is most of what makes a skyline read as one weather
 * rather than as two effects.
 */

/** The direction the wind blows FROM, in radians about +Y. */
let _bearing = 0
/** The gust strength that produced it, so a reader can lag or lead. */
let _gust = 1
let _timePin: number | null = null

/**
 * Hold the wind's own clock, so a probe can freeze the WHOLE system.
 *
 * `pinGust` was not enough on its own and the foliage check is what proved
 * it: with the canopy isolated, the camera still and the foliage clock
 * pinned, two frames still differed — because the prevailing bearing keeps
 * turning on the real clock, so "the same phase twice" was never the same
 * scene. A static pair that does not read exactly zero invalidates every
 * figure measured against it, which is the property the sway gate and the
 * gust ladder both rest on.
 */
export function pinWindTime(v: number | null): void { _timePin = v }

/**
 * Advance the wind. `gust` is `hangingGust()`, ~0.5 to ~1.35, so the swing and
 * the hanging content's amplitude come from ONE envelope — a town whose
 * washing surges while its vanes hold still has two winds in it.
 *
 * THE PREVAILING DIRECTION TURNS VERY SLOWLY. Two incommensurate terms at
 * ~170s and ~270s, far below everything else in this town's frequency table
 * (window flicker 0.25-0.7 Hz, star twinkle 0.18-0.40, lantern sway
 * 0.09-0.13, wisp breath 0.11-0.19), because a wind that boxes the compass in
 * ten seconds reads as a broken hinge rather than as weather.
 */
export function tickWind(time: number, gust: number): void {
  const t = _timePin ?? time
  const base = 0.9 + 0.55 * Math.sin(t * 0.037) + 0.30 * Math.sin(t * 0.0231 + 2.1)
  // The gust leans the whole skyline the same way at the same moment, which
  // is the entire effect: one gust crosses the town and everything measuring
  // it moves together.
  _bearing = base + (gust - 0.95) * 0.55
  _gust = gust
}

export function windBearing(): number { return _bearing }
export function windGust(): number { return _gust }
