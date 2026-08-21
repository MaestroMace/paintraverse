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

/**
 * HOW MANY STARS, from the `Star Density` slider that has existed in the
 * Environment panel since the app did and has never been read by anything.
 *
 * `moonPhase` and `starDensity` are declared in `EnvironmentState`, defaulted
 * in the store AND in the generator, and wired to two sliders that report a
 * percentage — and NOTHING CONSUMED EITHER. That is the ghost failure with a
 * user interface, which is worse than a plain ghost: the label is a promise,
 * so a person drags the control, sees the number change and concludes the
 * feature exists and is subtle. Nobody notices absent content; everybody
 * mis-attributes a control that lies. Census the CONTROLS, not only the
 * gates.
 *
 * Returns the hash threshold above which a sky cell carries a star, so it
 * runs the opposite way to the slider. The default 0.5 returns exactly the
 * 0.958 both renderers were hardcoding, which is deliberate: a fix to a dead
 * control must not silently restyle every existing scene, and it keeps the
 * board's night frames byte-identical so the change is provably free.
 */
export function starThresholdFor(density: number): number {
  const d = Math.max(0, Math.min(1, density))
  return 1 - d * 0.084
}

/**
 * The direction the sun lies in FROM the moon, for a given phase — which is
 * the whole of a moon phase, because a moon is a sphere and a phase is just
 * which part of it is lit.
 *
 * 0 is new (the lit side faces away, so the disc is dark), 0.5 is a quarter
 * (half lit, terminator straight down the middle) and 1 is full. That is the
 * standard convention and it is what the slider's own label already claims.
 *
 * `toViewer` is the unit direction from the moon toward the observer and
 * `side` any unit vector perpendicular to it — the terminator sweeps from one
 * to the other, which puts the shadow across the visible face rather than
 * around the back where nobody can see it.
 */
export function moonPhaseDir(
  phase: number,
  toViewer: readonly [number, number, number],
  side: readonly [number, number, number],
): [number, number, number] {
  const p = Math.max(0, Math.min(1, phase))
  const along = 2 * p - 1
  const across = Math.sqrt(Math.max(0, 1 - along * along))
  return [
    toViewer[0] * along + side[0] * across,
    toViewer[1] * along + side[1] * across,
    toViewer[2] * along + side[2] * across,
  ]
}

/**
 * WHAT THE WEATHER DOES TO THE AIR — one table, read by both renderers.
 *
 * `weather` and `weatherIntensity` are in `EnvironmentState`, five buttons and
 * a slider in the Environment panel, defaulted by the generator, and read by
 * NOTHING. Same census as `moonPhase` and `starDensity` one section up, and
 * six more controls: a person can press Rain and watch the intensity slider
 * appear, which is a complete and specific promise that nothing anywhere
 * keeps.
 *
 * The response is expressed as MULTIPLIERS on what the hour already decided,
 * never as absolute values. Every branch of `updateLighting` has spent a
 * session being tuned and dusk is the hour the whole design is graded at; a
 * weather table that set fog density outright would silently overwrite that
 * work, and 'clear' returning exact identity is what makes wiring these up
 * provably free.
 *
 * Intensity 0 is identity for every weather, so the slider spans "nothing" to
 * the values below rather than snapping the moment a button is pressed.
 */
export type WeatherKind = 'clear' | 'rain' | 'fog' | 'snow' | 'storm'

export interface WeatherAir {
  /** Multiplies the hour's fog density. */
  fogScale: number
  /** How far to pull the fog colour toward the sky's own, 0..1 — overcast
   *  air takes its colour from the cloud deck rather than the horizon. */
  fogToSky: number
  /** Multiplies the sun's intensity. Cloud is the whole of weather's effect
   *  on a shadow: less direct light, and what is left is softer. */
  sunScale: number
  /** Multiplies the hemisphere (skylight) term. Cloud REDISTRIBUTES light
   *  rather than removing it — an overcast sky is a huge soft source — so
   *  this goes UP as the sun goes down, which is why they are separate. */
  skyScale: number
  /** Multiplies the sky dome's cloud term. */
  cloudScale: number
  /**
   * How far to DESATURATE the sky toward its own luminance, 0..1 — cloud
   * takes the colour out of a sky, it does not impose one.
   *
   * This was a lerp toward a fixed grey and that was a real defect, found by
   * crossing the four lighting arms with the five weathers in `hours.mjs`.
   * An absolute target is DARKER than a clear noon sky (0.419 against 0.665)
   * and BRIGHTER than a night one, so it dimmed the day and lifted the night
   * — and combined with `skyScale` raising the walls it INVERTED the
   * silhouette on seven of twenty combinations, which is the one thing
   * pillar 1 cannot survive. Every other term in this table is a multiplier
   * on what the hour already decided; this one was not, and it is the only
   * one that broke.
   */
  desat: number
  /**
   * Multiplies the sky's brightness — and it is NEAR 1 for everything except
   * a storm, which is the correction the hour-weather matrix forced.
   *
   * The instinct is that weather darkens the sky. It does not: an overcast
   * sky is a vast bright source, brighter near the horizon than a clear blue
   * one, and only a thunderhead is genuinely dark. Dimming it while
   * `skyScale` raised the walls pushed the two toward each other from both
   * sides and crossed them at golden hour, which has the least headroom of
   * the four arms (sky/wall 1.27 clear, against 2.43 at dusk).
   */
  skyDim: number
  /** Multiplies the star field. Cloud is what hides stars, and a rain shower
   *  under a clear starry sky is the single most obviously wrong thing a
   *  weather system can draw. */
  starScale: number
  /** What falls, and how hard. `rate` is 0..1 and feeds the particle count. */
  precip: 'rain' | 'snow' | null
  rate: number
}

/**
 * PRECIPITATION COMES OUT OF CLOUD, and forgetting that is the most obviously
 * wrong thing a weather system can draw.
 *
 * The first cut wired fog, sun and skylight and left the SKY DOME alone, and
 * the photograph settled it in one frame: rain falling through a clear orange
 * dusk with stars visible in it. The sky is the largest surface in any street
 * view here — pillar 1 is built on it — so a weather that does not reach it
 * has changed the air and not the day. The machinery was already there:
 * `uCloud` has been a uniform on that dome the whole time.
 *
 * `overcast` is deliberately partial even at full storm. Flattening the dusk
 * palette to grey would take the warm horizon the whole design is written
 * against, and a real overcast sunset keeps a band of colour under the deck.
 */
const WEATHER_AIR: Readonly<Record<WeatherKind, Omit<WeatherAir, 'rate'>>> = {
  clear: {
    fogScale: 1, fogToSky: 0, sunScale: 1, skyScale: 1,
    cloudScale: 1, desat: 0, skyDim: 1, starScale: 1, precip: null,
  },
  // Rain: a modest haze, the sun knocked well down, skylight up a little,
  // most of the stars gone.
  rain: {
    fogScale: 2.2, fogToSky: 0.45, sunScale: 0.45, skyScale: 1.15,
    cloudScale: 2.0, desat: 0.6, skyDim: 0.95, starScale: 0.15, precip: 'rain',
  },
  // Fog is the one that is ALL air and no precipitation, so it is the only
  // entry allowed a large fogScale — 6x a dusk 0.004 is a 40m visibility,
  // which hides the far side of the town and not the street you stand in.
  // Its sky is barely touched, because fog is BELOW the cloud deck and a
  // foggy night with stars over it is a real and lovely thing.
  fog: {
    // Fog SCATTERS the light that is there rather than adding any, so its
    // skylight lift is the smallest of the four — 1.2 was a daytime-cloud
    // number on a ground-level phenomenon.
    fogScale: 6.0, fogToSky: 0.8, sunScale: 0.5, skyScale: 1.05,
    cloudScale: 1.2, desat: 0.3, skyDim: 1.0, starScale: 0.6, precip: null,
  },
  // Snow BRIGHTENS. The sky is overcast but the air and the ground are both
  // throwing light back, so this is the one weather whose sky barely dims.
  snow: {
    fogScale: 2.6, fogToSky: 0.6, sunScale: 0.6, skyScale: 1.2,
    cloudScale: 2.2, desat: 0.7, skyDim: 1.02, starScale: 0.1, precip: 'snow',
  },
  // The only weather whose sky is genuinely DARK. Everything else is
  // overcast, and an overcast sky is a huge bright source — see skyDim.
  storm: {
    fogScale: 3.4, fogToSky: 0.55, sunScale: 0.22, skyScale: 0.95,
    cloudScale: 3.0, desat: 0.85, skyDim: 0.68, starScale: 0, precip: 'rain',
  },
}


/** The air at this weather and intensity. `clear`, or intensity 0, is exact
 *  identity — a fix to a dead control must not restyle every existing scene. */
export function weatherAir(kind: string, intensity: number): WeatherAir {
  const k = (WEATHER_AIR as Record<string, Omit<WeatherAir, 'rate'>>)[kind]
  const t = Math.max(0, Math.min(1, intensity))
  if (!k || t <= 0) return { ...WEATHER_AIR.clear, rate: 0 }
  const lerp = (a: number, b: number) => a + (b - a) * t
  return {
    fogScale: lerp(1, k.fogScale),
    fogToSky: lerp(0, k.fogToSky),
    sunScale: lerp(1, k.sunScale),
    skyScale: lerp(1, k.skyScale),
    cloudScale: lerp(1, k.cloudScale),
    desat: lerp(0, k.desat),
    skyDim: lerp(1, k.skyDim),
    starScale: lerp(1, k.starScale),
    precip: k.precip,
    // Storm falls harder than rain at the same slider position, which is the
    // only thing separating the two beyond the light.
    rate: k.precip ? t * (kind === 'storm' ? 1 : 0.7) : 0,
  }
}
