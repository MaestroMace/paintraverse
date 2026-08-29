/**
 * WEATHERVANES — the one ornament in this town whose entire meaning is that it
 * MOVES, built for a year as a fixed arrow welded at a random angle.
 *
 * A vane at a random bearing is not a vane, it is a decoration shaped like
 * one. Worse than that, ninety-odd of them at ninety-odd different random
 * bearings is a town where the wind blows a different way on every roof, which
 * is the one thing a skyline full of vanes can say and the one thing this
 * town's said wrongly.
 *
 * `hangingGust()` in LanternStrings has named this consumer since it was
 * written — "anything else that should agree with the wind — a weathervane, a
 * drifting leaf — reads `hangingGust()` instead of re-deriving an envelope
 * that would then drift out of step". This is that reader.
 *
 * THEY ALL POINT THE SAME WAY, AND THAT IS THE OPPOSITE RULE FROM THE SWAY.
 * Every lantern gets its own sway phase and every cat its own blink, because a
 * town moving in lockstep is a metronome. A vane is the exception and the
 * reason is physical: **the wind is a fact about the PLACE**, so the
 * instruments measuring it must agree, and a hundred roofs swinging together
 * as a gust crosses the town is the whole effect. The per-vane term is
 * turbulence — a few degrees of wobble and a slightly different lag — not an
 * independent direction.
 *
 * AN INSTANCED MESH, NOT A SHADER. Every arrow is the same geometry, so one
 * `InstancedMesh` draws all of them in one call and the rotation is ninety-odd
 * matrix composes on the CPU per frame, which is nothing. The cat blink needed
 * a shader because it rides a merged bucket it does not own; this owns its own
 * mesh, and reaching for a vertex attribute here would be the harder answer to
 * an easier question.
 *
 * The POLE, the cardinal arms and their ball marks stay in the shared ornament
 * batch, because those are bolted to the roof and do not turn. Only the arrow
 * moves, which is also what makes the motion legible: the arrow is 46cm long
 * and 6.5cm thick, so its silhouette swings between a full bar and a thin line
 * — a 7:1 change in apparent width, far more visible than the couple of
 * centimetres its tip actually travels at that distance.
 */
import * as THREE from 'three'
// ONE WIND. This module computed the bearing until the banners became a
// second reader; a value two files must agree on belongs somewhere neutral.
import { windBearing, windGust } from './Wind'

export interface VaneSite {
  /** World position of the pivot — the top of the pole. */
  x: number
  y: number
  z: number
  /** Per-vane turbulence phase, 0..1. */
  phase: number
}

const sites: VaneSite[] = []

/** Called by the roof-ornament pass as each vane is emitted. */
export function addVane(x: number, y: number, z: number, phase: number): void {
  sites.push({ x, y, z, phase })
}

/** Cleared at the top of loadMap — a stale global is worse than a missing one,
 *  which this repo has paid for once in the sliver audit's build envelope. */
export function resetVanes(): void {
  sites.length = 0
  _mesh = null
}

let _mesh: THREE.InstancedMesh | null = null
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)
const _up = new THREE.Vector3(0, 1, 0)

/**
 * Build the one mesh. Returns null when the town grew no vanes, which is a
 * legitimate outcome — they need a spire or a tower — rather than a failure.
 *
 * The arrow is authored pointing +X with its pivot at the ORIGIN, so the
 * instance matrix is a plain rotate-about-Y then translate. Baking it at world
 * position the way the static ornaments are would put the pivot somewhere
 * arbitrary and every vane would swing around the map instead of around its
 * own pole.
 */
export function buildVaneMesh(): THREE.InstancedMesh | null {
  if (!sites.length) return null
  const arrowLen = 0.46, arrowH = 0.095, arrowT = 0.065
  const headW = 0.10, headH = 0.16
  const bar = new THREE.BoxGeometry(arrowLen, arrowH, arrowT)
  const head = new THREE.BoxGeometry(headW, headH, arrowT * 1.2)
  head.translate(arrowLen / 2 - headW / 2, 0, 0)
  // The tail is what makes it a WEATHERVANE rather than an arrow: a real vane
  // has a broad fin behind the pivot, because that is the part the wind pushes
  // and it is why the point ends up upwind. Cheap, and it doubles the
  // silhouette change as the vane turns.
  const fin = new THREE.BoxGeometry(arrowLen * 0.30, arrowH * 2.2, arrowT * 0.7)
  fin.translate(-arrowLen / 2 + arrowLen * 0.15, 0, 0)
  const merged = mergeSimple([bar, head, fin])
  bar.dispose(); head.dispose(); fin.dispose()
  const mat = new THREE.MeshLambertMaterial({ color: 0x4a3a2a })
  const mesh = new THREE.InstancedMesh(merged, mat, sites.length)
  mesh.name = 'weatherVanes'
  mesh.castShadow = false
  mesh.receiveShadow = true
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  _mesh = mesh
  tickVanes(0)
  return mesh
}

/**
 * Concatenate a few small non-indexed-safe box geometries.
 *
 * NOT `mergeBufferGeos` from LanternStrings — that one dropped the INDEX and
 * rendered every box as eight triangles instead of twelve for the life of the
 * file, which is on the record here. `BoxGeometry` is indexed, so the index
 * has to be offset and carried.
 */
function mergeSimple(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry()
  let vTotal = 0, iTotal = 0
  for (const g of geos) {
    vTotal += g.getAttribute('position').count
    iTotal += g.getIndex()?.count ?? 0
  }
  const pos = new Float32Array(vTotal * 3)
  const nrm = new Float32Array(vTotal * 3)
  const idx = new Uint16Array(iTotal)
  let vo = 0, io = 0
  for (const g of geos) {
    const p = g.getAttribute('position'), nAttr = g.getAttribute('normal')
    const gi = g.getIndex()
    for (let i = 0; i < p.count; i++) {
      pos[(vo + i) * 3] = p.getX(i)
      pos[(vo + i) * 3 + 1] = p.getY(i)
      pos[(vo + i) * 3 + 2] = p.getZ(i)
      nrm[(vo + i) * 3] = nAttr.getX(i)
      nrm[(vo + i) * 3 + 1] = nAttr.getY(i)
      nrm[(vo + i) * 3 + 2] = nAttr.getZ(i)
    }
    if (gi) for (let i = 0; i < gi.count; i++) idx[io + i] = gi.getX(i) + vo
    vo += p.count
    io += gi?.count ?? 0
  }
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3))
  out.setIndex(new THREE.BufferAttribute(idx, 1))
  return out
}

/** Where every vane is pointing this frame, in radians. Exposed so a probe can
 *  ask the town rather than re-deriving the formula — the copy-drift rule. */
export function vaneBearing(): number { return windBearing() }

/**
 * Aim every vane. `gust` is `hangingGust()`, ~0.5 to ~1.35.
 *
 * THE DIRECTION IS SHARED AND THE WOBBLE IS NOT. The prevailing wind turns
 * very slowly — a ~170s period, far below anything else in this town's
 * frequency table, because a wind that boxes the compass in ten seconds reads
 * as a broken hinge. On top of it the gust term SWINGS the whole skyline
 * together, which is the effect: a gust crosses the town and a hundred arrows
 * lean with it.
 *
 * The per-vane term is turbulence and stays small on purpose. Making it large
 * would be the metronome fix applied to the one system where disagreement is
 * the defect.
 */
export function tickVanes(time: number): void {
  const mesh = _mesh
  if (!mesh) return
  // A VANE POINTS INTO THE WIND — that is what makes it an instrument rather
  // than a flag, and it is why this takes `windBearing()` unturned while the
  // banners take it plus half a turn.
  const bearing = windBearing()
  const lean = (windGust() - 0.95) * 0.55
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    const ph = s.phase * Math.PI * 2
    // Turbulence: small, per-vane, and slower than the sway so the roofline
    // does not shimmer. A vane that swung as freely as a flag would stop
    // reading as one wind, which is the whole point of the system.
    const wobble = 0.16 * Math.sin(time * 0.29 + ph) + 0.09 * Math.sin(time * 0.47 + ph * 1.7)
    // The per-vane share of the gust lean: some are stiffer than others.
    _q.setFromAxisAngle(_up, bearing + lean * (s.phase - 0.5) * 0.4 + wobble)
    _p.set(s.x, s.y, s.z)
    _m.compose(_p, _q, _s)
    mesh.setMatrixAt(i, _m)
  }
  mesh.instanceMatrix.needsUpdate = true
}

/** How many vanes the town grew — for the census, which is the only thing that
 *  notices an absence. */
export function vaneCount(): number { return sites.length }
