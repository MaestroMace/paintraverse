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
