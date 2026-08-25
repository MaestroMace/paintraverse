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

/** Called by the building pass, which runs FIRST in loadMap. */
export function addBeacon(g: THREE.BufferGeometry): void { beaconGeos.push(g) }

/** Called by the prop pass, which owns the one emissive mesh in the town. */
export function takeBeacons(): THREE.BufferGeometry[] { return beaconGeos }

/**
 * Cleared at the top of loadMap, for the reason `resetLampAnchors` is: a stale
 * global is worse than a missing one — `slivers.mjs` spent a session reporting
 * props 71 metres long because a build envelope was never cleared, and
 * leftover state walks straight past a guard written for absent state.
 */
export function resetBeacons(): void { beaconGeos.length = 0 }
