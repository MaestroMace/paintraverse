/**
 * BANNERS — the sibling sweep the weathervane fix demanded, and it found the
 * same defect one file over.
 *
 * The flag on a noble or temple roof was yawed by `rand01(hash, 1607) * 2PI`,
 * under a comment saying "so banners on different buildings flap in different
 * directions". That is exactly what the vanes said, and this repo's own rule
 * is that a bug in one instance is a bug in a PATTERN — `localToWorld`'s
 * doc-comment even lists "flag banners rotated to a hash-determined wind
 * angle" among the things it carries, four hundred lines from the code.
 *
 * AND AFTER THE VANE FIX IT WAS ACTIVELY WORSE THAN BEFORE. One arbitrary
 * bearing reads as a decoration nobody thinks about; a town whose vanes all
 * agree while its flags each fly somewhere else reads as a MISTAKE, because
 * the eye can now see there is a wind and see the flags ignoring it. **A
 * half-swept pattern is worse than an unswept one.**
 *
 * A FLAG STREAMS DOWNWIND AND A VANE POINTS UPWIND. `windBearing()` is the
 * direction the wind comes FROM, so this takes it plus half a turn while the
 * vanes take it unturned. Getting that opposition right is most of what makes
 * a skyline read as one weather rather than as two effects that happen to
 * move.
 *
 * ONE INSTANCED MESH WITH PER-INSTANCE COLOUR. Every banner is the same size —
 * the constants were already fixed — so nothing needs a per-instance scale,
 * and the five heraldic colours ride in `instanceColor` rather than forcing
 * five meshes. Same call as the vanes and the clock hands: these own their own
 * mesh, so a shader would be the harder answer to an easier question.
 */
import * as THREE from 'three'
import { windBearing, windGust } from './Wind'

interface BannerSite {
  /**
   * World position of the HOIST — the point on the pole the flag hangs from.
   *
   * A POSITION, NOT THE BUILDING'S FRAME, and that distinction was a real
   * defect for one run. The first cut kept the full local -> world matrix and
   * multiplied a yaw onto it, which meant every flag inherited its BUILDING'S
   * rotation on top of the wind — so a town whose houses face different
   * streets flew its flags in different directions, which is the exact defect
   * being fixed, re-entering through the transform. `vaneprobe` read
   * concentration R = 0.42 and named it immediately.
   *
   * A flag is gimballed on a true vertical, like a vane: the roof under it has
   * no say in which way the wind blows. So the instance is composed from a
   * world position and a world yaw, and nothing about the building survives.
   */
  x: number
  y: number
  z: number
  color: number
  /** Per-flag flutter phase, 0..1. */
  phase: number
}

const sites: BannerSite[] = []

export function addBanner(
  x: number, y: number, z: number, color: number, phase: number,
): void {
  sites.push({ x, y, z, color, phase })
}

/** Cleared at the top of loadMap — a stale global is worse than a missing one. */
export function resetBanners(): void {
  sites.length = 0
  _mesh = null
}

let _mesh: THREE.InstancedMesh | null = null
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3(1, 1, 1)
const _up = new THREE.Vector3(0, 1, 0)
const _col = new THREE.Color()

export function bannerCount(): number { return sites.length }

/**
 * Build the one mesh. The banner is authored with its INNER EDGE AT THE
 * ORIGIN pointing +X — which is what the baked version already did — so the
 * instance matrix is the pole's frame times a yaw, and the flag pivots on its
 * hoist the way a real one does rather than about its own middle.
 */
export function buildBannerMesh(): THREE.InstancedMesh | null {
  if (!sites.length) return null
  const bannerW = 0.65, bannerH = 0.45, bannerT = 0.025
  const tailW = 0.12
  const cloth = new THREE.BoxGeometry(bannerW, bannerH, bannerT)
  cloth.translate(bannerW / 2, 0, 0)
  // The split tail is the pennant silhouette, and it is also what makes the
  // flutter legible: it is the part furthest from the hoist, so it travels
  // furthest for a given swing.
  const tail = new THREE.BoxGeometry(tailW, bannerH * 0.6, bannerT)
  tail.translate(bannerW + tailW / 2 - 0.02, 0, 0)
  const merged = mergeIndexed([cloth, tail])
  cloth.dispose(); tail.dispose()
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff })
  const mesh = new THREE.InstancedMesh(merged, mat, sites.length)
  mesh.name = 'banners'
  mesh.castShadow = false
  mesh.receiveShadow = true
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  for (let i = 0; i < sites.length; i++) {
    _col.setHex(sites[i].color)
    mesh.setColorAt(i, _col)
  }
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  _mesh = mesh
  tickBanners(0)
  return mesh
}

/**
 * Carry the INDEX. `mergeBufferGeos` in LanternStrings concatenated positions
 * and threw the index away, so every merged box rendered as eight triangles
 * instead of twelve for the life of that file — on the record here, and not a
 * mistake to make twice.
 */
function mergeIndexed(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
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

/**
 * Fly every flag.
 *
 * THE FLUTTER IS LARGER THAN THE VANE'S WOBBLE, ON PURPOSE. A vane is a
 * balanced instrument on a bearing and a flag is a rag on a rope: giving them
 * the same tolerance would make the flags look welded. It is still small
 * enough that the shared direction dominates, because the moment the flags
 * disagree with each other the skyline stops reading as one wind — which is
 * the defect this file exists to have fixed.
 *
 * And the flutter RATE rides the gust, because a flag in a lull hangs and a
 * flag in a gust snaps. That is one more thing the shared envelope buys for
 * nothing.
 */
export function tickBanners(time: number): void {
  const mesh = _mesh
  if (!mesh) return
  // DOWNWIND. `windBearing()` is where the wind comes FROM; a vane points into
  // it and a flag streams away from it.
  const bearing = windBearing() + Math.PI
  const g = windGust()
  for (let i = 0; i < sites.length; i++) {
    const s = sites[i]
    const ph = s.phase * Math.PI * 2
    const flutter = (0.30 * Math.sin(time * (0.55 + 0.35 * g) + ph)
      + 0.17 * Math.sin(time * (0.91 + 0.5 * g) + ph * 1.7)) * (0.55 + 0.6 * g)
    _q.setFromAxisAngle(_up, bearing + flutter)
    _p.set(s.x, s.y, s.z)
    _m.compose(_p, _q, _s)
    mesh.setMatrixAt(i, _m)
  }
  mesh.instanceMatrix.needsUpdate = true
}
