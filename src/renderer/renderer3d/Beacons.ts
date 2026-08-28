/**
 * BEACONS — light emitted by the BUILDING path, drained by the PROP path.
 *
 * A module with ONE dependency, on purpose. The obvious place for this was
 * PropFactory, next to `emitGlow` and the emissive mesh it feeds — and putting
 * it there broke the app on boot with `Cannot access 'LAMP_POOL_TEX' before
 * initialization`.
 *
 * PropFactory and LanternStrings already import VALUES from each other
 * (`lampAnchors` one way, `LAMP_POOL_TEX` the other), which is a runtime cycle
 * that happened to work because of the order the entry point pulled them in.
 * Adding `BuildingFactory -> PropFactory` changed which module initialises
 * first and the cycle came apart at once. **An import is not a free action: it
 * re-orders module initialisation, and a pre-existing cycle that works by
 * luck will break the day a new edge changes the entry order.**
 *
 * So the shared array lives somewhere that cannot participate in a cycle — it
 * imports three and nothing else, and both factories import IT. Same argument
 * as `core/types.ts` and `core/terrain.ts`: a value two files must agree on
 * belongs in a neutral place, and here the neutrality is load-bearing rather
 * than merely tidy.
 */
import * as THREE from 'three'

const beaconGeos: THREE.BufferGeometry[] = []
/**
 * COLOURED LIGHT NEEDS A SECOND MATERIAL, and that is the whole reason this
 * map exists rather than a `color` attribute.
 *
 * `_lampEmissiveMat` is one Lambert with a fixed amber emissive and no
 * `vertexColors`, and everything in the town's single emissive mesh is merged
 * into it. Tinting per vertex would mean giving EVERY existing beacon a colour
 * attribute, because `mergeGeometries` refuses a set whose attributes disagree
 * — which is the same partial-attribute failure `mergeBufferGeos` already had
 * with UVs, and it would touch every lamp, bulb and dial in the file.
 *
 * Bucketing by tint instead costs one extra draw call per DISTINCT colour
 * town-wide (stained glass uses three), needs no change to anything already
 * emitting, and keeps the untinted path byte-identical.
 */
const tintedGeos = new Map<number, THREE.BufferGeometry[]>()

/**
 * Called by the building pass, which runs FIRST in loadMap.
 *
 * `tint` is an emissive colour for glass that is not lamp-amber. Omit it and
 * the geometry joins the shared amber mesh exactly as before.
 */
export function addBeacon(g: THREE.BufferGeometry, tint?: number): void {
  if (tint === undefined) { beaconGeos.push(g); return }
  const a = tintedGeos.get(tint)
  if (a) a.push(g)
  else tintedGeos.set(tint, [g])
}

/** Called by the prop pass, which owns the one emissive mesh in the town. */
export function takeBeacons(): THREE.BufferGeometry[] { return beaconGeos }

/** The tinted buckets, as [colour, geometries] — one mesh each. */
export function takeTintedBeacons(): [number, THREE.BufferGeometry[]][] {
  return [...tintedGeos]
}

/**
 * Cleared at the top of loadMap, for the reason `resetLampAnchors` is: a stale
 * global is worse than a missing one — `slivers.mjs` spent a session reporting
 * props 71 metres long because a build envelope was never cleared, and
 * leftover state walks straight past a guard written for absent state.
 */
export function resetBeacons(): void {
  beaconGeos.length = 0
  tintedGeos.clear()
}

/**
 * THE CAT'S EYES, and the tint is here rather than in BuildingFactory because
 * TWO files have to agree on it: the building path emits with it and the prop
 * path has to recognise that one bucket to give it a blink. A second copy of
 * the constant would separate the geometry from its animation the day either
 * moved, which is the terrain-table drift in a colour.
 */
export const CAT_EYE_TINT = 0x8fa32a

/**
 * A CAT THAT DOES NOT BLINK IS A PAIR OF LAMPS.
 *
 * The eyes were built as the feature — at RENDER_SCALE 0.4 a 30cm cat is four
 * pixels and two emissive specks are the only part of it that survives, which
 * is the argument this file already makes for the belfry's lit arch. But a
 * steady point of light is a LAMP, and there are hundreds of those in this
 * town; what separates a creature from a bulb is that a creature's light goes
 * out for a moment and comes back. The eye is extraordinarily good at noticing
 * a light that stops, and that single fact is doing all the work here — it
 * reads at any distance the specks resolve at, needs no new geometry, and
 * cannot be confused with a lantern.
 *
 * PHASED BY WORLD POSITION, WHICH IS THE SWAY'S TRICK AND IT IS LOAD-BEARING
 * HERE FOR A SECOND REASON. A town of cats blinking in lockstep is a metronome
 * — that is why every lantern gets its own sway phase — and the same smooth
 * `wp.x * a + wp.z * b` gives each cat its own without an attribute. The
 * second reason is the one that decided the form: the two eyes of ONE cat are
 * 6cm apart and MUST blink together, because a cat that winks one eye is a
 * defect a person notices instantly. A SMOOTH function of position separates
 * them by ~0.02 of a radian and separates two cats by about one, so it gets
 * both properties for free. A quantised phase — `floor(wp.x * k)` — would have
 * been the obvious way to give each cat one value and would have straddled a
 * cell boundary on roughly one cat in twenty-five, winking it forever.
 *
 * AND THE INTERVAL IS DELIBERATELY NOT A FREQUENCY. This file keeps a table:
 * window flicker 0.25-0.7 Hz, star twinkle 0.18-0.40, lantern sway 0.09-0.13,
 * wisp breath 0.11-0.19 — all chosen incommensurate so nothing beats against
 * anything. A blink is a GATE rather than an oscillation, so it cannot beat in
 * that sense, but a clean period would still read as a pulse. The jitter puts
 * each blink anywhere in its own slot, so consecutive gaps run from about two
 * seconds to about nine and there is no single rate to lock onto.
 */
const _catUniforms = { uCatTime: { value: 0 } }
let _catTimePin: number | null = null

export function tickCatBlink(time: number): void {
  _catUniforms.uCatTime.value = _catTimePin ?? time
}

/**
 * Hold the blink clock, so a probe can ask for an exact phase instead of
 * catching one by waiting — the argument `pinHangingTime` already makes, and
 * it is sharper here: the eyes are shut for about a fifth of a second in every
 * five or six, so a still taken at random misses the blink thirty times out of
 * thirty-one and "I never saw it" is indistinguishable from "it never fires".
 */
export function pinCatTime(v: number | null): void { _catTimePin = v }

/**
 * Compile the blink into ONE material — the cat-eye tint's, which is already
 * its own bucket and therefore its own mesh, so nothing else in the town is
 * touched.
 *
 * Applied at material creation, BEFORE `patchHeightFog` runs over the prop
 * group. That ordering is not incidental: the fog patch captures whatever hook
 * is present, chains it, and keys the program cache on its source — so a hook
 * added first is composed correctly, and one added afterwards would be thrown
 * away by the cached program. The same trap cost this repo a session when a
 * constant cache key silently discarded the sway.
 */
export function applyCatBlink(mat: THREE.Material): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCatTime = _catUniforms.uCatTime
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vCatPh;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 cwp = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vCatPh = cwp.x * 0.31 + cwp.z * 0.23;
        }`)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uCatTime;
        varying float vCatPh;`)
      // The emissive is the whole visible eye — the base colour is nearly
      // black on purpose, the same glow-dominant argument the stained glass
      // needed — so gating it is gating the cat.
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float T = uCatTime * 0.175 + vCatPh;
          float slot = floor(T);
          float j = fract(sin(slot * 12.9898 + vCatPh * 7.233) * 43758.5453);
          float d = abs(fract(T) - (0.12 + j * 0.76));
          totalEmissiveRadiance *= smoothstep(0.0, 0.028, d);
        }`)
  }
  mat.needsUpdate = true
}
