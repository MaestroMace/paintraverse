/**
 * THE GREAT CLOCK — the one object in this town whose entire job is to display
 * a value the app already has, and it was showing a random number.
 *
 * `timeOfDay` is a labelled control on the Environment panel. The sky reads
 * it, the lighting reads it in four branches, the lanterns, the stars, the
 * moon, the mist and the meteors all read it. **The clock did not.** Its hands
 * were `(hash % 12) / 12` — a fixed random hour per building — under a comment
 * saying "so a town's clocks disagree the way real ones do, with nothing to
 * tick".
 *
 * Disagreeing is right and the amount is not: a real town clock is a few
 * MINUTES out, not seven hours. So the hands read the hour with a small
 * per-building offset, which is the charming half of the original intent kept
 * and the broken half discarded. Drag the sun across the sky and the clocks
 * follow, which is a coherence you cannot get from any amount of new geometry.
 *
 * AN INSTANCED MESH, for the reason the weathervanes are one: every hand is
 * the same box and there are four dials on a tower and one or two towers in a
 * town, so the whole set is one draw call and a handful of matrix composes
 * whenever the hour changes. Nothing here needs a shader.
 *
 * AND THE FRAME IS MEASURED FROM `localToWorld`, NEVER RESTATED. An instance
 * matrix needs the same local -> world transform the baked geometry gets, and
 * writing that product out a second time is the copy this repo has paid for in
 * three terrain tables and a roof-cap table. `localToWorldMatrix` runs a
 * four-point probe THROUGH the real function and reads the basis back, so the
 * two cannot drift even if the transform's order changes.
 */
import * as THREE from 'three'

export type HandKind = 'hour' | 'minute'

interface HandSite {
  /** The full local -> world transform of the dial's hand origin. */
  frame: THREE.Matrix4
  /** The pre-rotation the baked version applied: a quarter turn for a dial on
   *  the X axis, identity for one on Z. */
  turnY: boolean
  /**
   * WHICH WAY ROUND THE FACE RUNS, and it was wrong on half of them.
   *
   * The baked hands rotated by `-ang` on every dial. Seen from OUTSIDE a dial
   * whose normal is +Z or +X that is clockwise; seen from outside one whose
   * normal is -Z or -X the viewer's right-hand direction has flipped, so the
   * same rotation runs ANTICLOCKWISE. Two of every four faces were backwards.
   *
   * **A random value hides a sign error.** Nobody could see it while the hour
   * was `hash % 12`, because a backwards clock at a meaningless time is just a
   * clock at a different meaningless time. It becomes glaring the moment the
   * hands mean something — which is a reason to prefer real values over
   * plausible ones even where the fake one "looks fine".
   */
  spin: number
  len: number
  thick: number
  kind: HandKind
  /** Minutes this clock is out by. A real town clock is a few minutes off. */
  offsetMin: number
}

const sites: HandSite[] = []

export function addClockHand(s: HandSite): void { sites.push(s) }

/** Cleared at the top of loadMap — a stale global is worse than a missing one. */
export function resetClocks(): void {
  sites.length = 0
  _mesh = null
  _reading = null
}

let _mesh: THREE.InstancedMesh | null = null
let _reading: number | null = null
const _m = new THREE.Matrix4()
const _spinM = new THREE.Matrix4()
const _turnM = new THREE.Matrix4().makeRotationY(Math.PI / 2)
const _scaleM = new THREE.Matrix4()

/** How many hands the town grew, and what the first dial currently reads in
 *  hours. Exposed so a probe asks the town rather than re-deriving — the same
 *  argument as `vaneBearing`. */
export function clockCount(): number { return sites.length }
export function clockReading(): number | null { return _reading }

/**
 * Build the one mesh. Null when the town grew no clock tower, which is an
 * ordinary outcome rather than a failure.
 *
 * The hand is authored as a unit bar along +Y with its PIVOT AT THE ORIGIN, so
 * the instance matrix is frame x turn x spin x scale and the per-hand length
 * and thickness ride in the scale. Baking each hand at its own size would need
 * one geometry per hand and defeat the instancing.
 */
export function buildClockMesh(): THREE.InstancedMesh | null {
  if (!sites.length) return null
  const bar = new THREE.BoxGeometry(1, 1, 1)
  bar.translate(0, 0.5, 0)
  const mat = new THREE.MeshLambertMaterial({ color: 0x1a1512 })
  const mesh = new THREE.InstancedMesh(bar, mat, sites.length)
  mesh.name = 'clockHands'
  mesh.castShadow = false
  mesh.receiveShadow = true
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  _mesh = mesh
  tickClocks(_reading ?? 10.1)
  return mesh
}

/**
 * Point every hand at `hours` (0..24).
 *
 * Called from `updateLighting` rather than from the frame loop, because the
 * hands only change when the hour does and that is the one place that knows
 * the hour changed — the same reason `setWaterSky` is read back there instead
 * of in four branches.
 */
export function tickClocks(hours: number): void {
  _reading = hours
  const mesh = _mesh
  if (!mesh) return
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    const h = hours + s.offsetMin / 60
    // A 12-hour dial, and a minute hand that comes from the same quantity so
    // the two can never disagree — an analogue clock showing 3:50 with the
    // hour hand on 3 is a clock nobody wound.
    const ang = s.kind === 'hour'
      ? ((h % 12) / 12) * Math.PI * 2
      : (((h * 60) % 60) / 60) * Math.PI * 2
    _spinM.makeRotationZ(-ang * s.spin)
    _scaleM.makeScale(s.thick, s.len, s.thick * 0.8)
    _m.copy(s.frame)
    if (s.turnY) _m.multiply(_turnM)
    _m.multiply(_spinM).multiply(_scaleM)
    mesh.setMatrixAt(i, _m)
  }
  mesh.instanceMatrix.needsUpdate = true
}
