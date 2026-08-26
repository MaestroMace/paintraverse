/**
 * Prop Factory v3: Batched Props
 *
 * All props are merged into batched meshes by color.
 * Only lampposts remain individual (emissive material + point lights).
 * ~1,900 draw calls → ~20
 */

import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { ObjectDefinition, PlacedObject } from '../core/types'
import { stableHash, footprintOf } from '../core/types'
import { BatchedMeshBuilder, setBuildEnvelope } from './BatchedMeshBuilder'
import { lampAnchors } from './LanternStrings'
import { takeBeacons } from './Beacons'
import { TILE } from './scale'

// Heights tuned for FLOOR_HEIGHT=1.8. A 2-story building = 3.6m eaves,
// so lampposts at 3.2m sit just under eaves (classic streetlamp height).
// Trees bumped to 4.0m so they read as real trees next to buildings, not
// shrubs. Market stalls bumped to 2.4m.
const PROP_HEIGHTS: Record<string, number> = {
  tree: 4.0, bush: 0.9, lamppost: 3.2, bench: 0.5, fountain: 1.6,
  fence: 0.8, well: 1.2, barrel: 0.8, crate: 0.6, market_stall: 2.4,
  statue: 2.4, potted_plant: 0.7, wagon: 1.2, stone_wall: 1.6,
  gravestone: 0.8, windmill: 5.5, bridge: 0.8,
}

const MAX_POINT_LIGHTS = 16

/**
 * Shared translucent-cone material for the volumetric "pool of light"
 * rendered under each lamppost at dusk/night. Additive so overlapping
 * pools brighten each other the way real light bleeds overlap, fog
 * disabled so the pool doesn't get eaten by the scene fog, depthWrite
 * off so it doesn't punch through geometry behind it. Opacity is driven
 * by ThreeRenderer.updateLighting via setLampPoolOpacity().
 */
// A small radial-gradient canvas texture — warm center fading to black
// at the edge. Used as an alphaMap so the lamp-pool sprite has soft
// edges instead of a hard silhouette.
/**
 * The radial falloff every warm ground pool in this town uses.
 *
 * EXPORTED because a second warm patch on the cobbles — the light a lit
 * window throws down onto the street — needs exactly this and a second copy
 * would be the terrain table again in alpha. One gradient, one texture
 * object, one place to change what a pool of light looks like.
 */
export function buildLampPoolTexture(): THREE.CanvasTexture {
  const size = 64
  const canvas = document.createElement('canvas')
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0.0, 'rgba(255,255,255,1)')
  g.addColorStop(0.4, 'rgba(255,255,255,0.5)')
  g.addColorStop(1.0, 'rgba(0,0,0,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.needsUpdate = true
  return tex
}

/** THE shared instance. `buildLampPoolTexture` is the builder and calling it
 *  twice allocates a second identical 64x64 — one decision, one texture. */
export const LAMP_POOL_TEX = buildLampPoolTexture()
const _lampPoolTex = LAMP_POOL_TEX
// A flat horizontal disc lit with the radial-gradient alpha map reads as
// a proper ground light pool — elongated ellipse at oblique angles, circle
// when looked straight down. Sprites (previous approach) always faced the
// camera, so they rendered as a vertical circle suspended in the air; that
// looked wrong from above. MeshBasicMaterial + PlaneGeometry rotated to
// horizontal fixes this.
const _lampPoolMat = new THREE.MeshBasicMaterial({
  color: 0xffb060,
  map: _lampPoolTex,
  alphaMap: _lampPoolTex,
  transparent: true,
  opacity: 0,
  fog: false,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  side: THREE.DoubleSide,
})
export function setLampPoolOpacity(opacity: number): void {
  _lampPoolMat.opacity = opacity
}

// Shared lamppost materials. Previously each lamppost allocated its own
// MeshLambertMaterial, which blocked batching and made the pole/bulb render
// as a separate draw call per part. With shared instances, we can merge all
// non-emissive parts into the existing tree/bush batch and all emissive
// bulbs into one mesh.
// 0x222222 was 0.016 linear luma — paint no amount of light rescues, on the
// one prop that stands at eye level in every street. Lifted to the same floor
// the prop batch applies (BatchedMeshBuilder.toneFloor), warm rather than
// neutral so it reads as iron and not as plastic. This material is NOT in the
// batch, so the floor could not reach it: a dedicated material is exactly
// where a palette fix goes quietly missing.
const _lampPoleMat = new THREE.MeshLambertMaterial({ color: 0x4a4642, flatShading: true })
const _lampEmissiveMat = new THREE.MeshLambertMaterial({
  color: 0xffcc44, emissive: 0xffaa22, emissiveIntensity: 0.8,
})
// Disc geometry — radius 1.6 world units, lying in the XZ plane (rotateX
// by -90° at instantiation). The radial alpha map makes the edges fade;
// center is brightest right under the lamp.
const _lampPoolGeo = (() => {
  const g = new THREE.PlaneGeometry(3.2, 3.2)
  g.rotateX(-Math.PI / 2)
  return g
})()

// Shared geometries (created once)
let _geo: {
  treeTrunk: THREE.CylinderGeometry
  treeCanopy: THREE.SphereGeometry
  pineCone: THREE.ConeGeometry
  willowDome: THREE.SphereGeometry
  bushGeo: THREE.SphereGeometry
  boxGeo: THREE.BoxGeometry
} | null = null

function getGeo() {
  if (!_geo) {
    _geo = {
      treeTrunk: new THREE.CylinderGeometry(0.08, 0.14, 1.2, 5),
      treeCanopy: new THREE.SphereGeometry(0.8, 6, 5),
      pineCone: new THREE.ConeGeometry(0.6, 0.7, 6),
      willowDome: new THREE.SphereGeometry(1.1, 7, 5),
      bushGeo: new THREE.SphereGeometry(0.5, 5, 4),
      boxGeo: new THREE.BoxGeometry(1, 1, 1),
    }
  }
  return _geo
}

/** Deterministic 0..1 pseudo-random from an integer hash and a salt. */
function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

/**
 * Per-type prop dimensions in METRES, accumulated as the town is built and
 * read by tools/propscale.mjs. Keyed by definition id; widest/tallest as well
 * as median, because a type that is right on average and monstrous on a 2x2
 * plot is exactly the failure this exists to catch.
 */
export const propSizes: Record<string, { n: number; w: number[]; h: number[]; d: number[] }> = {}

/**
 * PER-INSTANCE prop records, for tools/odd.mjs.
 *
 * propSizes aggregates by type, and an aggregate cannot point at the ONE
 * barrel that came out three metres across or the one lamppost floating 40cm
 * off the ground — a median hides both. This keeps each instance's emitted
 * box and where its base sits relative to the ground under it, which is the
 * pair of facts that "is this prop correctly placed" reduces to.
 */
export interface PropInstance {
  id: string
  /** World centre of the emitted geometry. */
  x: number; y: number; z: number
  w: number; h: number; d: number
  /** Emitted lowest point minus the sampled ground: + floats, - buried. */
  gap: number
}
export const propInstances: PropInstance[] = []

function recordPropSize(
  id: string, bb: { min: THREE.Vector3; max: THREE.Vector3 } | null,
  groundY = 0,
): void {
  if (!bb) return
  const e = (propSizes[id] ??= { n: 0, w: [], h: [], d: [] })
  e.n++
  e.w.push(bb.max.x - bb.min.x)
  e.h.push(bb.max.y - bb.min.y)
  e.d.push(bb.max.z - bb.min.z)
  propInstances.push({
    id,
    x: +((bb.max.x + bb.min.x) / 2).toFixed(2),
    y: +((bb.max.y + bb.min.y) / 2).toFixed(2),
    z: +((bb.max.z + bb.min.z) / 2).toFixed(2),
    w: +(bb.max.x - bb.min.x).toFixed(3),
    h: +(bb.max.y - bb.min.y).toFixed(3),
    d: +(bb.max.z - bb.min.z).toFixed(3),
    gap: +(bb.min.y - groundY).toFixed(3),
  })
}
/** Cleared at the top of each batch — otherwise a re-generate accumulates
 *  every town this session and the median drifts toward nothing in
 *  particular. Same trap as placeStats being reset in the middle of the
 *  pipeline. */
export function resetPropSizes(): void {
  for (const k of Object.keys(propSizes)) delete propSizes[k]
  propInstances.length = 0
}

export interface PropBatchResult {
  batched: THREE.Mesh[]          // merged geometry meshes
  lampposts: THREE.Object3D[]    // individual (emissive + lights)
}

export function buildPropMeshes(
  objects: PlacedObject[],
  defMap: Map<string, ObjectDefinition>,
  getHeight?: (x: number, z: number) => number
): PropBatchResult {
  const geo = getGeo()
  resetPropSizes()
  const batch = new BatchedMeshBuilder()
  // NOTHING IN THE STREET IS ALLOWED TO BE A BLACK HOLE. eyeball.mjs reads
  // props as the darkest surface class in the town — 31% of their pixels
  // effectively black against 4% for walls — and the cause is the palette,
  // not the light: a quarter of the authored prop colours are under 0.05
  // linear luma. See BatchedMeshBuilder.toneFloor. 0.055 is a dark object
  // that still reads as an object; below that a barrel is a silhouette.
  //
  // AND IT STAYS AT 0.12, MEASURED. CLAUDE.md carried "props read 88% black
  // at dusk" as an open item for a long time, off eyeball's `other` row —
  // which is every sample no building volume owns and is not horizontal, so
  // river-bank cuts and grazing water were in it with the barrels. eyeball
  // has a real prop MASK now (propGroup, asked before the orientation
  // fallback) and the honest figures at dusk are:
  //
  //     prop   353 samples   med 0.065   47% black
  //     wall  6530 samples   med 0.075   31% black
  //     other  318 samples   med 0.025   76% black   <- the old number
  //
  // So props are 13% darker than the walls they stand against, not invisible,
  // and the filed claim was overstated by roughly double. Raising the floor
  // to 0.18 moved the row by ZERO — the palette already sits above it — and
  // 0.45, tried purely to prove the floor still reaches these meshes, takes
  // props to 0.133, nearly twice the wall. A barrel brighter than the house
  // behind it is not a fix, it is pillar 1 flattened. Wood and iron against
  // plaster ARE darker; the item is closed by measurement, not by a change.
  batch.toneFloor = 0.12
  const lampposts: THREE.Object3D[] = []
  // Geometry for emissive lamp bulbs, accumulated per-lamppost with lamppost
  // position+rotation baked in. Merged into one mesh at the end.
  const lampEmissiveGeos: THREE.BufferGeometry[] = []
  const lampPoolGeos: THREE.BufferGeometry[] = []
  let pointLightCount = 0

  for (const obj of objects) {
    const def = defMap.get(obj.definitionId)
    const id = obj.definitionId
    const h = PROP_HEIGHTS[id] ?? 0.6
    // Tiles vs world, same split as BuildingFactory: fpT indexes the map,
    // fp is a geometry extent. See scale.ts.
    // THE RESERVED RECTANGLE, not the definition's. `footprintOf` is the one
    // way to ask a PlacedObject this — reading `def.footprint` directly is
    // exactly what the enabling refactor exists to prevent, and CLAUDE.md
    // says so in as many words. It cost a 5.52m picket fence standing on a
    // one-tile reservation: the placer reserved a tile and PropFactory drew
    // the definition's two, straight through the neighbour.
    const fpT = footprintOf(obj, def)
    const fp = { w: fpT.w * TILE, h: fpT.h * TILE }
    const ptx = obj.x + fpT.w / 2, ptz = obj.y + fpT.h / 2
    const px = ptx * TILE, pz = ptz * TILE
    // Plant the prop on the actual ground surface directly under its render
    // center. getHeight now interpolates the sloped mesh, so sampling (px,pz)
    // — the exact spot the prop is drawn — sits the base on the visible ground
    // instead of snapping to the tile corner, which left props floating or
    // half-buried on any slope. Ignore obj.elevation when getHeight is
    // available (the generator stored it in raw heightMap units, which would
    // double-count the terrain).
    const elev = getHeight ? getHeight(ptx, ptz) : (obj.elevation || 0)
    const hash = stableHash(obj)
    const _auditFrom = batch.count
    // TELL THE SLIVER AUDIT WHOSE GEOMETRY THIS IS.
    //
    // Nothing here ever set an envelope, so every prop was measured against
    // whatever BUILDING happened to run last — and `over` came out as the
    // distance across town to that building. slivers.mjs was confidently
    // reporting props protruding 71 metres, none of which exists: propscale
    // measures the same geometry at 3.6m at its largest.
    //
    // A stale envelope is worse than a missing one. recordSliver already
    // guards the null case with its own NO-ENVELOPE bucket, precisely because
    // scoring unattributed geometry 0 once produced a confident "nothing
    // found" while beams hung in the sky — and then the leftover-state case
    // walked straight past that guard and produced the opposite lie.
    //
    // The allowance is generous on purpose: a lamppost's ground pool is a
    // ~3m disc on a 1x1 tile and a tree crown oversails its trunk, so this is
    // here to catch a prop sprawling across the map, not to police an eave.
    setBuildEnvelope({
      minX: px - fp.w / 2 - 3, maxX: px + fp.w / 2 + 3,
      minZ: pz - fp.h / 2 - 3, maxZ: pz + fp.h / 2 + 3,
      minY: elev - 2, maxY: elev + 14,
      label: id,
    })

    // Per-prop Y rotation. The generator can set obj.properties.facingY
    // (radians) to give the prop a *meaningful* orientation — face the
    // plaza fountain, run perpendicular to the adjacent road, turn its
    // back to the building behind it. When that hint is missing we
    // fall back to a hash-random angle so unfacing-aware prop streams
    // (countryside scatter, etc.) still don't all point at world +Z.
    // Y-symmetric props (fountains, wells) always pin to 0.
    const isSingleTile = fpT.w === 1 && fpT.h === 1
    const maxPropRot = isSingleTile ? Math.PI : Math.PI * 0.2
    const propRot = (id === 'fountain' || id === 'fountain_grand' || id === 'well' || id === 'well_grand')
      ? 0
      : (typeof obj.properties.facingY === 'number'
          ? obj.properties.facingY as number
          : (rand01(hash, 17) - 0.5) * 2 * maxPropRot)

    // Emit a geometry at local offset (dx, dy, dz) from the prop center,
    // rotated by propRot around that center, then translated to world.
    // Every batch.addPositioned call below that wants rotation should use
    // this helper instead of baking world coords into .translate(px+dx, ...).
    /**
     * An object with an INTRINSIC real-world size takes it, clamped so it can
     * never overflow the plot it was given.
     *
     * `fp` is in metres and used to be in tiles, so anything that sized itself
     * as a fraction of its footprint tripled at the rescale while the absolute
     * constants beside it did not. That produced a rowboat 5.3m long and 39cm
     * tall — a pancake — and boulders wider than a row house. A boat is a
     * boat's size wherever you put it; only things that genuinely FILL their
     * plot (a fence, a dock, a bridge) should span the footprint.
     */
    const physical = (metres: number, span: number) => Math.min(metres, span * 0.92)

    const emitRot = (g: THREE.BufferGeometry, dx: number, dy: number, dz: number, color: number) => {
      g.translate(dx, dy, dz)
      if (propRot !== 0) g.rotateY(propRot)
      g.translate(px, elev, pz)
      batch.addPositioned(g, color)
    }
    /**
     * Same placement, but into the EMISSIVE mesh rather than the lit batch.
     *
     * `lampEmissiveGeos` had exactly one producer — the lamppost — so a
     * lamppost was the only thing in the entire town that glowed. The brazier's
     * own comment claims its embers "share the lantern emissive driver ... so
     * forges light up with the rest of the town" and they did not: the glow was
     * an orange dot painted into the ordinary vertex-coloured Lambert batch,
     * which at dusk is a dark orange dot.
     *
     * That matters more than it sounds. DESIGN.md's test view is dusk — "can
     * the player stand in this town at dusk and feel like they're somewhere" —
     * and pillar 5 asks for three layers of warm light. A prop that reads at
     * noon and vanishes at the hour the design is graded on is content that
     * fails where it is measured.
     */
    const emitGlow = (g: THREE.BufferGeometry, dx: number, dy: number, dz: number) => {
      g.translate(dx, dy, dz)
      if (propRot !== 0) g.rotateY(propRot)
      g.translate(px, elev, pz)
      lampEmissiveGeos.push(g)
    }

    if (id === 'tree' || id === 'orchard_tree') {
      // If no species set, hash-pick one so tree clusters aren't all identical.
      let species = (obj.properties.species as string) || ''
      if (!species) {
        const pool = id === 'orchard_tree'
          ? ['apple', 'pear', 'oak']
          : ['oak', 'pine', 'birch', 'maple', 'willow', 'poplar', 'oak']
        species = pool[hash % pool.length]
      }
      // A street tree is 6-12m, and these were coming out at 3.4m — shorter
      // than the ground floor of the houses they stand against. Same absolute
      // constants left behind by the rescale as the benches and crates.
      const TREE_SCALE = 1.75
      const heightJitter = (0.85 + ((hash >> 3) % 30) / 100) * TREE_SCALE
      const trunkH =
        species === 'pine' ? 2.8 * heightJitter :
        species === 'poplar' ? 3.0 * heightJitter :
        species === 'birch' ? 2.4 * heightJitter :
        species === 'willow' ? 1.4 * heightJitter :
        species === 'apple' || species === 'pear' ? 1.3 * heightJitter :
        1.9 * heightJitter
      const trunkColor = species === 'birch' ? 0xd0c8b8
        : species === 'willow' ? 0x503820
        : species === 'poplar' ? 0x6a4a2a
        : 0x5a3a1a
      const canopyColor =
        species === 'pine' ? 0x1a4a1a :
        species === 'birch' ? 0x6ba64a :
        species === 'willow' ? 0x4a7a3a :
        species === 'maple' ? 0xaa5a30 :
        species === 'poplar' ? 0x3a7a33 :
        species === 'apple' ? 0x4a8a3a :
        species === 'pear' ? 0x6a9a4a :
        0x2d5a27

      // Trunk — thicker for oak/maple, thin for birch/poplar
      const trunkThick = species === 'oak' || species === 'maple' ? 1.5
        : species === 'birch' || species === 'poplar' ? 0.85 : 1.2
      const trunk = geo.treeTrunk.clone()
      trunk.scale(trunkThick, trunkH / 1.2, trunkThick)
      trunk.translate(px, elev + trunkH / 2, pz)
      batch.addPositioned(trunk, trunkColor)

      // Canopy
      if (species === 'pine') {
        // Taller, narrower layered pine
        for (let layer = 0; layer < 4; layer++) {
          const r = 1.05 - layer * 0.2
          const c = geo.pineCone.clone()
          c.scale(r / 0.6, 1.6, r / 0.6)
          c.translate(px, elev + trunkH + 0.2 + layer * 0.55, pz)
          batch.addPositioned(c, canopyColor)
        }
      } else if (species === 'poplar') {
        // Narrow columnar poplar — 3 tall stacked ellipsoids
        for (let layer = 0; layer < 3; layer++) {
          const c = geo.treeCanopy.clone()
          c.scale(0.55, 1.4, 0.55)
          c.translate(px, elev + trunkH + 0.4 + layer * 1.1, pz)
          batch.addPositioned(c, layer === 1 ? canopyColor
            : new THREE.Color(canopyColor).multiplyScalar(0.8).getHex())
        }
      } else if (species === 'willow') {
        // Wider, drooping skirt — a dome + two lower trailing lobes
        const d = geo.willowDome.clone()
        d.scale(1.9, 0.85, 1.9)
        d.translate(px, elev + trunkH + 0.35, pz)
        batch.addPositioned(d, canopyColor)
        for (let li = 0; li < 5; li++) {
          const angle = (li / 5) * Math.PI * 2
          const lobe = geo.treeCanopy.clone()
          lobe.scale(0.55, 0.45, 0.55)
          lobe.translate(
            px + Math.cos(angle) * 1.2,
            elev + trunkH + 0.05,
            pz + Math.sin(angle) * 1.2,
          )
          batch.addPositioned(lobe, new THREE.Color(canopyColor).multiplyScalar(0.85).getHex())
        }
      } else if (species === 'birch') {
        // Airy, narrow lobes
        const baseY = elev + trunkH + 0.35
        for (let li = 0; li < 4; li++) {
          const angle = (li / 4) * Math.PI * 2 + hash * 0.5
          const lobe = geo.treeCanopy.clone()
          lobe.scale(0.55, 0.65, 0.55)
          lobe.translate(
            px + Math.cos(angle) * 0.32,
            baseY + Math.sin(li * 1.1) * 0.25,
            pz + Math.sin(angle) * 0.32,
          )
          batch.addPositioned(lobe, li % 2 === 0 ? canopyColor
            : new THREE.Color(canopyColor).multiplyScalar(0.8).getHex())
        }
      } else {
        // Oak / maple / apple / pear — 3 big overlapping lobes + top
        const baseY = elev + trunkH + 0.3
        const lobeR = species === 'oak' ? 1.2 : species === 'maple' ? 1.1
          : 0.85   // apple / pear smaller
        for (let li = 0; li < 3; li++) {
          const angle = (li / 3) * Math.PI * 2 + hash * 0.7
          const lobe = geo.treeCanopy.clone()
          lobe.scale(lobeR, lobeR * 0.9, lobeR)
          lobe.translate(
            px + Math.cos(angle) * 0.5,
            baseY + Math.sin(li * 1.3) * 0.25,
            pz + Math.sin(angle) * 0.5,
          )
          batch.addPositioned(lobe, li % 2 === 0 ? canopyColor
            : new THREE.Color(canopyColor).multiplyScalar(0.78).getHex())
        }
        const top = geo.treeCanopy.clone()
        top.scale(lobeR * 0.75, lobeR * 0.75, lobeR * 0.75)
        top.translate(px, baseY + lobeR * 0.55, pz)
        batch.addPositioned(top, canopyColor)

        // Fruit dots on apple/pear — 4 tiny red/yellow spheres
        if (species === 'apple' || species === 'pear') {
          const fruitColor = species === 'apple' ? 0xa02810 : 0xc0a030
          for (let fi = 0; fi < 4; fi++) {
            const ang = (fi / 4) * Math.PI * 2 + hash
            const fruit = geo.treeCanopy.clone()
            fruit.scale(0.11, 0.11, 0.11)
            fruit.translate(
              px + Math.cos(ang) * lobeR * 0.7,
              baseY + 0.1,
              pz + Math.sin(ang) * lobeR * 0.7,
            )
            batch.addPositioned(fruit, fruitColor)
          }
        }
      }

    } else if (id === 'water_steps') {
      // A flight cut DOWN the quay wall into the river. This is the detail
      // that says a wall is a built thing people use rather than a retaining
      // edge: you land a boat, you fetch water, you wash. It only became
      // possible when the urban bank stopped being a slope — you cannot cut
      // steps into mud.
      //
      // Drawn descending from the tile's own ground height, because a prop is
      // placed on the quay TOP and the water is below it.
      const STEPS = 6
      const rise = 0.26, tread = 0.30, wide = 1.5
      for (let k = 0; k < STEPS; k++) {
        const g = new THREE.BoxGeometry(wide, rise, tread)
        g.translate(px, elev - rise * (k + 0.5), pz + tread * (k + 0.5))
        batch.addPositioned(g, k % 2 === 0 ? 0x9a948a : 0x8e8880)
      }
      // Low cheek walls either side, so the flight reads as masonry rather
      // than as boxes stacked on a bank.
      for (const sx of [-1, 1]) {
        const cheek = new THREE.BoxGeometry(0.16, 0.5, tread * STEPS)
        cheek.translate(px + sx * (wide / 2 + 0.06),
          elev - rise * STEPS * 0.42, pz + tread * STEPS * 0.5)
        batch.addPositioned(cheek, 0x877f76)
      }
    } else if (id === 'mooring_ring') {
      // A squat stone bollard with an iron ring. The vocabulary had no
      // bollard, so dressWaterfront was tying boats to a HORSE POST.
      const post = new THREE.CylinderGeometry(0.16, 0.20, 0.52, 8)
      post.translate(px, elev + 0.26, pz)
      batch.addPositioned(post, 0x6e6862)
      const cap = new THREE.SphereGeometry(0.17, 8, 5)
      cap.scale(1, 0.55, 1)
      cap.translate(px, elev + 0.52, pz)
      batch.addPositioned(cap, 0x625c56)
      const ring = new THREE.TorusGeometry(0.13, 0.032, 5, 10)
      ring.rotateY(Math.PI / 2)
      ring.translate(px, elev + 0.36, pz + 0.17)
      batch.addPositioned(ring, 0x2a2622)
    } else if (id === 'reeds') {
      // A clump of thin blades leaning off vertical. The one thing a river
      // bank needed that nothing in the vocabulary could stand in for —
      // everything natural here was a tree, a bush or a stone, and none of
      // them says "waterline". Deliberately sparse and tall rather than dense:
      // reeds read by their SILHOUETTE against the water, so a handful of
      // blades that break the shoreline beats a solid mass that reads as a
      // bush standing in a puddle.
      const blades = 7 + (hash % 5)
      for (let b = 0; b < blades; b++) {
        const a = rand01(hash, 4100 + b * 7) * Math.PI * 2
        const rad = rand01(hash, 4200 + b * 7) * 0.34
        const bh = 0.55 + rand01(hash, 4300 + b * 7) * 0.55
        const lean = 0.10 + rand01(hash, 4400 + b * 7) * 0.16
        const g = new THREE.BoxGeometry(0.035, bh, 0.035)
        g.translate(0, bh / 2, 0)
        g.rotateZ(Math.cos(a) * lean)
        g.rotateX(Math.sin(a) * lean)
        g.translate(px + Math.cos(a) * rad, elev, pz + Math.sin(a) * rad)
        batch.addPositioned(g, b % 3 === 0 ? 0x7d8a4e : 0x63713c)
      }
    } else if (id === 'bush' || id === 'hedge') {
      const b = geo.bushGeo.clone()
      b.scale(1.3, 1.3, 1.3)
      b.translate(px, elev + 0.4, pz)
      batch.addPositioned(b, 0x3a7a33)

    } else if (id === 'lamppost' || id === 'wall_lantern' || id === 'street_lamp_double' || id === 'double_lamp') {
      // Four silhouette variants by id + hash:
      //   - 'street_lamp_double'/'double_lamp': ornate tall post with
      //     two side arms, each carrying a lamp
      //   - 'wall_lantern': hanging lantern with small decorative top
      //   - 'lamppost' with hash%3===0: ornate ceremonial pillar with
      //     wider stepped base + faceted lamp housing on top
      //   - 'lamppost' default: classic tall thin pole with round lamp
      //
      // Non-emissive parts (pole, crossbar, bracket, cap, base, hangs)
      // go into the shared `batch` so they render with every other
      // dark prop in one draw call. Emissive bulbs accumulate into
      // `lampEmissiveGeos` and merge once at the end — a single mesh
      // for every lamp bulb in the town. The ground light pool and the
      // point light stay per-lamppost: the pool is transparent (separate
      // render stream) and point lights aren't meshes.

      // Bake a local-frame (lampPost-relative) geometry into world space
      // using this lamppost's propRot + (px, elev, pz) origin.
      const poleEmit = (g: THREE.BufferGeometry, lx: number, ly: number, lz: number) => {
        g.translate(lx, ly, lz)
        if (propRot !== 0) g.rotateY(propRot)
        g.translate(px, elev, pz)
        batch.addPositioned(g, 0x222222)
      }
      const emissiveEmit = (g: THREE.BufferGeometry, lx: number, ly: number, lz: number) => {
        g.translate(lx, ly, lz)
        if (propRot !== 0) g.rotateY(propRot)
        g.translate(px, elev, pz)
        lampEmissiveGeos.push(g)
        // RECORD THE ANCHOR HERE, not per variant. There are four lamppost
        // silhouettes below and the double carries TWO bulbs; a census
        // written against the variants would have to enumerate all five
        // sites and would silently miss the sixth the day somebody adds it.
        // This is the one funnel every bulb already goes through, which is
        // the same argument as auditing roof winding off a compiler-checked
        // Record rather than a hand-written style list.
        const c = propRot === 0 ? 1 : Math.cos(propRot)
        const s = propRot === 0 ? 0 : Math.sin(propRot)
        lampAnchors.push({
          x: px + lx * c + lz * s,
          y: elev + ly,
          z: pz - lx * s + lz * c,
          // A post in the open street; see the radius note in
          // LanternStrings for why this is not the 0.42 that looked right.
          r: 0.9,
          kind: 'lamppost',
        })
      }

      const lampGroup = new THREE.Group()
      lampGroup.position.set(px, elev, pz)
      lampGroup.rotation.y = propRot

      if (id === 'street_lamp_double' || id === 'double_lamp') {
        poleEmit(new THREE.CylinderGeometry(0.055, 0.08, h + 0.25, 5), 0, (h + 0.25) / 2, 0)
        poleEmit(new THREE.BoxGeometry(0.65, 0.05, 0.05), 0, h + 0.15, 0)
        for (const side of [-1, 1]) {
          poleEmit(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 4), side * 0.3, h + 0.04, 0)
          emissiveEmit(new THREE.BoxGeometry(0.18, 0.22, 0.18), side * 0.3, h - 0.1, 0)
          if (pointLightCount < MAX_POINT_LIGHTS) {
            const light = new THREE.PointLight(0xffcc66, 0.6, 7, 1.5)
            light.position.set(side * 0.3, h - 0.1, 0)
            lampGroup.add(light)
            pointLightCount++
          }
        }
      } else if (id === 'wall_lantern') {
        poleEmit(new THREE.BoxGeometry(0.35, 0.04, 0.05), 0.17, h * 0.9, 0)
        emissiveEmit(new THREE.BoxGeometry(0.16, 0.22, 0.16), 0.32, h * 0.9 - 0.1, 0)
        poleEmit(new THREE.ConeGeometry(0.12, 0.1, 4), 0.32, h * 0.9 + 0.06, 0)
        if (pointLightCount < MAX_POINT_LIGHTS) {
          const light = new THREE.PointLight(0xffcc66, 0.7, 6, 1.5)
          light.position.set(0.32, h * 0.9 - 0.1, 0)
          lampGroup.add(light)
          pointLightCount++
        }
      } else if (hash % 3 === 0) {
        // Ornate ceremonial — stepped stone base + pole + faceted lamp housing
        poleEmit(new THREE.BoxGeometry(0.35, 0.15, 0.35), 0, 0.075, 0)
        poleEmit(new THREE.BoxGeometry(0.25, 0.1, 0.25), 0, 0.2, 0)
        poleEmit(new THREE.CylinderGeometry(0.06, 0.08, h - 0.25, 6), 0, 0.25 + (h - 0.25) / 2, 0)
        emissiveEmit(new THREE.CylinderGeometry(0.13, 0.15, 0.28, 6), 0, h + 0.05, 0)
        poleEmit(new THREE.ConeGeometry(0.14, 0.18, 6), 0, h + 0.28, 0)
        if (pointLightCount < MAX_POINT_LIGHTS) {
          const light = new THREE.PointLight(0xffcc66, 0.9, 9, 1.5)
          light.position.y = h + 0.05
          lampGroup.add(light)
          pointLightCount++
        }
      } else {
        // Classic simple lamppost
        poleEmit(new THREE.CylinderGeometry(0.05, 0.06, h, 4), 0, h / 2, 0)
        emissiveEmit(new THREE.SphereGeometry(0.15, 6, 4), 0, h, 0)
        if (pointLightCount < MAX_POINT_LIGHTS) {
          const light = new THREE.PointLight(0xffcc66, 0.8, 8, 1.5)
          light.position.y = h
          lampGroup.add(light)
          pointLightCount++
        }
      }

      // Soft lamp pool: horizontal disc on the ground with a radial-gradient
      // alpha map. The disc lies flat so from an oblique angle it reads as
      // an elongated ellipse of warm light on the cobblestones — the classic
      // streetlamp ground pool. Shared material + geometry singletons so
      // setLampPoolOpacity() dims every pool at once from updateLighting.
      // Ground light pool. Collected and merged into ONE mesh at the end
      // instead of one mesh per lamp — with lamps now placed along every
      // street that would otherwise have been a draw call each.
      const poolGeo = _lampPoolGeo.clone()
      poolGeo.translate(px, elev + 0.06, pz) // hover so it doesn't z-fight
      lampPoolGeos.push(poolGeo)

      lampGroup.traverse(c => { c.matrixAutoUpdate = false; c.updateMatrix() })
      lampposts.push(lampGroup)

    } else if (id === 'fountain' || id === 'fountain_grand') {
      const grand = id === 'fountain_grand'
      const scale = grand ? 1.8 : 1.15
      const stone = 0x989890
      const stoneDark = 0x707070
      const water = 0x5090c0

      // Octagonal base step (stone plinth) — wider than basin
      const step = new THREE.CylinderGeometry(1.15 * scale, 1.2 * scale, 0.18, 8)
      step.translate(px, elev + 0.09, pz)
      batch.addPositioned(step, stoneDark)

      // Lower basin
      const basin = new THREE.CylinderGeometry(0.95 * scale, 1.05 * scale, 0.42, 8)
      basin.translate(px, elev + 0.39, pz)
      batch.addPositioned(basin, stone)

      // Water surface in lower basin
      const waterL = new THREE.CylinderGeometry(0.78 * scale, 0.78 * scale, 0.06, 8)
      waterL.translate(px, elev + 0.58, pz)
      batch.addPositioned(waterL, water)

      // Central pillar (stepped — thicker bottom, thinner top)
      const pillarLower = new THREE.CylinderGeometry(0.18 * scale, 0.22 * scale, 0.55 * scale, 6)
      pillarLower.translate(px, elev + 0.61 + 0.28 * scale, pz)
      batch.addPositioned(pillarLower, stone)
      const pillarUpper = new THREE.CylinderGeometry(0.12 * scale, 0.16 * scale, 0.6 * scale, 6)
      pillarUpper.translate(px, elev + 0.61 + 0.56 * scale + 0.3 * scale, pz)
      batch.addPositioned(pillarUpper, stone)

      // Upper tier — smaller basin catching falling water (grand only)
      if (grand) {
        const upperBasin = new THREE.CylinderGeometry(0.42 * scale, 0.52 * scale, 0.18, 8)
        upperBasin.translate(px, elev + 0.61 + 1.18 * scale, pz)
        batch.addPositioned(upperBasin, stone)
        const upperWater = new THREE.CylinderGeometry(0.32 * scale, 0.32 * scale, 0.05, 8)
        upperWater.translate(px, elev + 0.61 + 1.3 * scale, pz)
        batch.addPositioned(upperWater, water)
      }

      // Top ornament — stepped finial (ball + crown + small ball)
      const capY = grand ? elev + 0.61 + 1.45 * scale : elev + 0.61 + 1.2 * scale
      const ballL = new THREE.SphereGeometry(0.18 * scale, 7, 5)
      ballL.translate(px, capY, pz)
      batch.addPositioned(ballL, stone)
      const neck = new THREE.CylinderGeometry(0.06 * scale, 0.08 * scale, 0.15 * scale, 6)
      neck.translate(px, capY + 0.18 * scale, pz)
      batch.addPositioned(neck, stone)
      const ballT = new THREE.SphereGeometry(0.1 * scale, 6, 4)
      ballT.translate(px, capY + 0.28 * scale, pz)
      batch.addPositioned(ballT, stone)

      // Four small water jets around the pillar — tiny blue cylinders
      for (let j = 0; j < 4; j++) {
        const ang = (j / 4) * Math.PI * 2
        const jetR = 0.32 * scale
        const jet = new THREE.CylinderGeometry(0.035, 0.035, 0.28 * scale, 4)
        jet.translate(
          px + Math.cos(ang) * jetR,
          elev + 0.72 + 0.14 * scale,
          pz + Math.sin(ang) * jetR,
        )
        batch.addPositioned(jet, water)
      }

    } else if (id === 'great_lantern') {
      /**
       * THE GREAT LANTERN — a market cross carrying a lamp.
       *
       * This town's skyline is a field of small warm windows with nothing
       * dominant in it, and DESIGN.md's references all work the other way: one
       * object much brighter than everything around it, standing where the
       * streets converge, that you navigate by without being told to. Nine main
       * streets meet at the market square, so a light here terminates every one
       * of them.
       *
       * A market cross is the real civic object this is — a stepped plinth, a
       * shaft, and a lamp on top — which is why it can be tall without reading
       * as a fairground pole. Height is what makes it a landmark rather than
       * street furniture: at 6.4m it clears the crowd, the stalls and the
       * ground-floor eaves, so it is visible down a street rather than only in
       * the square.
       *
       * PHYSICAL, not a fraction of the footprint. A centrepiece has an
       * intrinsic size; scaling it to its plot is the class of bug this repo
       * records for boulders, rowboats and the 9m bench.
       */
      const stepR = 1.05, shaftH = 4.3, lampH = 1.35
      // Stepped base — three courses, because a plinth is what stops a
      // vertical object looking like it was pushed into the ground.
      for (let k = 0; k < 3; k++) {
        const r = stepR - k * 0.24
        const step = new THREE.BoxGeometry(r * 2, 0.22, r * 2)
        emitRot(step, 0, 0.11 + k * 0.22, 0, 0x8d8578)
      }
      // Shaft — tapered, so it reads as carved stone and not a post.
      const shaft = new THREE.CylinderGeometry(0.17, 0.24, shaftH, 8)
      emitRot(shaft, 0, 0.66 + shaftH / 2, 0, 0x9a9184)
      // Corbelled head under the lamp: the same relief argument as the
      // curtain wall, and it gives the lantern something to stand on.
      const head = new THREE.BoxGeometry(0.62, 0.20, 0.62)
      emitRot(head, 0, 0.66 + shaftH + 0.10, 0, 0x8d8578)
      // The lantern housing — a dark frame with the GLOW inside it, so what
      // you see is a bright core held in a dark cage. An unhoused bulb reads
      // as a floating rectangle, which is what the tower beacon did first.
      const lampY = 0.66 + shaftH + 0.20 + lampH / 2
      for (const [cx, cz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const post = new THREE.BoxGeometry(0.09, lampH, 0.09)
        emitRot(post, cx * 0.30, lampY, cz * 0.30, 0x33291f)
      }
      const capL = new THREE.ConeGeometry(0.62, 0.46, 4)
      capL.rotateY(Math.PI / 4)
      emitRot(capL, 0, lampY + lampH / 2 + 0.23, 0, 0x33291f)
      const finial = new THREE.ConeGeometry(0.09, 0.30, 6)
      emitRot(finial, 0, lampY + lampH / 2 + 0.46 + 0.15, 0, 0x33291f)
      // The light itself, inside the cage, seen between the four posts.
      const glass = new THREE.BoxGeometry(0.50, lampH * 0.86, 0.50)
      emitGlow(glass, 0, lampY, 0)
    } else if (id === 'well' || id === 'well_grand') {
      const grand = id === 'well_grand'
      const scale = grand ? 1.25 : 1.0
      const stone = 0x8a8478
      const darkStone = 0x6a6458
      const wood = 0x5a4020

      // Octagonal stone base (slightly wider than the ring)
      const base = new THREE.CylinderGeometry(0.48 * scale, 0.54 * scale, 0.22, 8)
      base.translate(px, elev + 0.11, pz)
      batch.addPositioned(base, darkStone)

      // Ring wall around the well opening
      const ring = new THREE.TorusGeometry(0.38 * scale, 0.12 * scale, 6, 10)
      ring.rotateX(Math.PI / 2); ring.translate(px, elev + 0.42, pz)
      batch.addPositioned(ring, stone)
      // Dark water circle inside
      const wellWater = new THREE.CylinderGeometry(0.24 * scale, 0.24 * scale, 0.04, 8)
      wellWater.translate(px, elev + 0.3, pz)
      batch.addPositioned(wellWater, 0x203040)

      // Twin posts supporting a roof over the well
      for (const sx of [-0.34 * scale, 0.34 * scale]) {
        const post = new THREE.BoxGeometry(0.08, 0.9 * scale, 0.08)
        post.translate(px + sx, elev + 0.55 + 0.45 * scale, pz)
        batch.addPositioned(post, wood)
      }

      // Crossbeam
      const crossbeam = new THREE.BoxGeometry(0.9 * scale, 0.08, 0.08)
      crossbeam.translate(px, elev + 0.55 + 0.9 * scale + 0.04, pz)
      batch.addPositioned(crossbeam, wood)

      // Gabled roof (two slanted slabs meeting at a ridge)
      const roofY = elev + 0.55 + 0.9 * scale + 0.22
      for (const side of [-1, 1]) {
        const slab = new THREE.BoxGeometry(0.95 * scale, 0.05, 0.55 * scale)
        slab.rotateX(0.5 * side)
        slab.translate(px, roofY, pz + side * 0.14 * scale)
        batch.addPositioned(slab, 0x5a3a28)
      }

      // Bucket hanging from a tiny horizontal rod under the crossbeam
      const bucketY = elev + 0.75
      const bucket = new THREE.CylinderGeometry(0.1, 0.09, 0.18, 6)
      bucket.translate(px, bucketY, pz)
      batch.addPositioned(bucket, 0x6a4a2a)
      const rope = new THREE.BoxGeometry(0.02, 0.9 * scale * 0.55, 0.02)
      rope.translate(px, elev + 0.55 + 0.9 * scale - 0.3 * scale, pz)
      batch.addPositioned(rope, 0x3a2818)

    } else if (id === 'barrel' || id === 'rain_barrel') {
      // Three barrel variants: classic wooden, wide wine/beer cask on side,
      // tall rain barrel with metal hoops.
      const bv = id === 'rain_barrel' ? 2 : (hash % 3)
      if (bv === 0) {
        // Classic standing barrel with two visible hoops
        // A cask is ~60cm across and 90 tall. Was 40x50.
        const body = new THREE.CylinderGeometry(0.28, 0.31, 0.88, 8)
        body.translate(px, elev + 0.44, pz)
        batch.addPositioned(body, 0x6a4a28)
        for (const hy of [0.15, 0.73]) {
          const hoop = new THREE.TorusGeometry(0.31, 0.022, 3, 8)
          hoop.rotateX(Math.PI / 2)
          hoop.translate(px, elev + hy, pz)
          batch.addPositioned(hoop, 0x3a3a3a)
        }
        // Lid (slightly darker disc on top)
        const lid = new THREE.CylinderGeometry(0.2, 0.2, 0.02, 8)
        lid.translate(px, elev + 0.51, pz)
        batch.addPositioned(lid, 0x5a3a18)
      } else if (bv === 1) {
        // Wine cask laid on its side — rotates with propRot so casks line
        // up at varied angles, not all along world X.
        const body = new THREE.CylinderGeometry(0.26, 0.26, 0.55, 8)
        body.rotateZ(Math.PI / 2)
        emitRot(body, 0, 0.28, 0, 0x7a5030)
        for (const ex of [-0.22, 0.22]) {
          const hoop = new THREE.TorusGeometry(0.26, 0.02, 3, 8)
          hoop.rotateY(Math.PI / 2)
          emitRot(hoop, ex, 0.28, 0, 0x2a2a2a)
        }
        emitRot(new THREE.BoxGeometry(0.35, 0.04, 0.2), 0, 0.02, 0, 0x5a3a20)
      } else {
        // Tall rain barrel with many metal hoops
        const body = new THREE.CylinderGeometry(0.22, 0.24, 0.7, 8)
        body.translate(px, elev + 0.35, pz)
        batch.addPositioned(body, 0x5a3820)
        for (let hi = 0; hi < 4; hi++) {
          const hy = 0.08 + hi * 0.2
          const hoop = new THREE.TorusGeometry(0.24, 0.015, 3, 8)
          hoop.rotateX(Math.PI / 2)
          hoop.translate(px, elev + hy, pz)
          batch.addPositioned(hoop, 0x2a2a2a)
        }
        // Water surface (dark circle at the top)
        const water = new THREE.CylinderGeometry(0.2, 0.2, 0.02, 8)
        water.translate(px, elev + 0.71, pz)
        batch.addPositioned(water, 0x3a5068)
      }

    } else if (id === 'barrel_stack') {
      for (const [bx, bz, by] of [[0, -0.15, 0], [0.25, 0.15, 0], [-0.25, 0.15, 0], [0, 0, 0.45]] as const) {
        const b = new THREE.CylinderGeometry(0.18, 0.2, 0.45, 7)
        b.translate(px + bx, elev + (by as number) + 0.22, pz + bz)
        batch.addPositioned(b, 0x5a3a18)
      }

    } else if (id === 'crate' || id === 'crate_stack') {
      // A packing crate is 60-70cm on a side. These were 35cm — a shoebox —
      // which is the other half of the scale-coupling story: props sized by
      // ABSOLUTE constants were tuned when a house was one to three world
      // units wide, and unlike the footprint-derived ones they got no free
      // multiplier when TILE became 3. Same rescale, opposite direction.
      const num = id === 'crate_stack' ? 3 : 1
      for (let ci = 0; ci < num; ci++) {
        const s = 0.64 - ci * 0.055
        const c = new THREE.BoxGeometry(s, s, s)
        c.translate(px + (ci % 2) * 0.16, elev + ci * 0.60 + s / 2, pz + (ci % 2) * 0.09)
        batch.addPositioned(c, 0x8a7050)
      }

    } else if (id === 'bench') {
      // Three bench variants by hash: wooden with backrest, stone slab,
      // wooden backless with end arms. All rotate with propRot.
      const bv = hash % 3
      // A two-seater bench is 1.6m long with the seat at 45cm. These were
      // 90cm long and 35 high, which is a child's bench.
      if (bv === 0) {
        emitRot(new THREE.BoxGeometry(1.6, 0.06, 0.46), 0, 0.45, 0, 0x6a4a28)
        emitRot(new THREE.BoxGeometry(1.6, 0.5, 0.05), 0, 0.72, -0.2, 0x6a4a28)
        for (const lx of [-0.68, 0.68]) {
          emitRot(new THREE.BoxGeometry(0.1, 0.43, 0.42), lx, 0.22, 0, 0x5a3a1a)
        }
      } else if (bv === 1) {
        emitRot(new THREE.BoxGeometry(1.7, 0.14, 0.5), 0, 0.45, 0, 0x8a847a)
        for (const lx of [-0.62, 0.62]) {
          emitRot(new THREE.BoxGeometry(0.26, 0.38, 0.44), lx, 0.19, 0, 0x7a7468)
        }
      } else {
        emitRot(new THREE.BoxGeometry(1.55, 0.07, 0.44), 0, 0.46, 0, 0x7a5a30)
        for (const lx of [-0.66, 0.66]) {
          emitRot(new THREE.BoxGeometry(0.08, 0.2, 0.46), lx, 0.58, 0, 0x5a3a1a)
          emitRot(new THREE.BoxGeometry(0.08, 0.46, 0.42), lx, 0.23, 0, 0x5a3a1a)
        }
      }

    } else if (id === 'market_stall') {
      // Four stall silhouettes; each rotates with propRot so canopies
      // point different directions from stall to stall.
      const variant = hash % 4
      if (variant === 0) {
        const canopyColors = [0xcc3333, 0x3366aa, 0xcc9933, 0x339966]
        emitRot(new THREE.BoxGeometry(1.8, 0.08, 0.9), 0, 0.8, 0, 0x7a5a30)
        for (const [lx, lz] of [[-0.75, -0.35], [0.75, -0.35], [-0.75, 0.35], [0.75, 0.35]] as const) {
          emitRot(new THREE.BoxGeometry(0.07, 0.8, 0.07), lx, 0.4, lz, 0x7a5a30)
        }
        for (const lx of [-0.8, 0.8]) {
          emitRot(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 4), lx, 1.4, 0.4, 0x7a5a30)
        }
        const canopy = new THREE.PlaneGeometry(2.0, 1.2)
        canopy.rotateX(-0.25)
        emitRot(canopy, 0, 1.9, 0.1, canopyColors[(hash >> 2) % canopyColors.length])
        const stripe = new THREE.PlaneGeometry(2.0, 0.15)
        stripe.rotateX(-0.25)
        emitRot(stripe, 0, 1.62, 0.1, 0xf0f0e0)
      } else if (variant === 1) {
        emitRot(new THREE.BoxGeometry(1.6, 0.12, 0.7), 0, 0.55, 0, 0x7a5030)
        for (const sz of [-0.3, 0.3]) {
          emitRot(new THREE.BoxGeometry(1.6, 0.18, 0.04), 0, 0.7, sz, 0x5a3820)
        }
        for (const wx of [-0.55, 0.55]) {
          const wheel = new THREE.CylinderGeometry(0.26, 0.26, 0.06, 8)
          wheel.rotateX(Math.PI / 2)
          emitRot(wheel, wx, 0.26, 0.35, 0x3a2a1a)
          const wheel2 = new THREE.CylinderGeometry(0.26, 0.26, 0.06, 8)
          wheel2.rotateX(Math.PI / 2)
          emitRot(wheel2, wx, 0.26, -0.35, 0x3a2a1a)
        }
        const produceColors = [0xc04020, 0xb07030, 0xa09040, 0x805030]
        for (let pi = 0; pi < 3; pi++) {
          const mound = new THREE.SphereGeometry(0.18, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2)
          emitRot(mound, -0.5 + pi * 0.5, 0.68, ((hash >> pi) & 1) * 0.15 - 0.05,
            produceColors[(hash + pi) % produceColors.length])
        }
        emitRot(new THREE.BoxGeometry(0.05, 0.05, 0.9), 0.9, 0.55, 0, 0x5a3820)
      } else if (variant === 2) {
        emitRot(new THREE.BoxGeometry(1.5, 0.65, 0.6), 0, 0.33, 0, 0x6a4a2a)
        emitRot(new THREE.BoxGeometry(0.45, 0.15, 0.2), -0.3, 0.73, 0, 0x3a3a3a)
        emitRot(new THREE.BoxGeometry(0.6, 0.08, 0.22), -0.3, 0.83, 0, 0x2a2a2a)
        for (const lx of [-0.6, 0.6]) {
          emitRot(new THREE.BoxGeometry(0.06, 1.6, 0.06), lx, 0.8, -0.35, 0x4a3a28)
        }
        emitRot(new THREE.BoxGeometry(1.4, 0.06, 0.06), 0, 1.5, -0.35, 0x4a3a28)
        for (let ti = 0; ti < 4; ti++) {
          emitRot(new THREE.BoxGeometry(0.06, 0.45 + (ti % 2) * 0.15, 0.03),
            -0.55 + ti * 0.38, 1.2, -0.34, 0x2a2a2a)
        }
      } else {
        emitRot(new THREE.BoxGeometry(1.2, 0.6, 0.9), 0, 0.3, 0, 0x8a6a3a)
        for (const lx of [-0.55, 0.55]) {
          emitRot(new THREE.BoxGeometry(0.06, 1.8, 0.06), lx, 0.9, 0, 0x5a3a20)
        }
        const roofColor = [0xa03030, 0x306aa0, 0x6a9a40][hash % 3]
        for (const side of [-1, 1]) {
          const slab = new THREE.PlaneGeometry(1.5, 0.8)
          slab.rotateX(0.4 * side)
          emitRot(slab, 0, 1.9, side * 0.18, roofColor)
        }
        emitRot(new THREE.BoxGeometry(1.3, 0.12, 0.08), 0, 1.65, 0, 0xf0e8d0)
      }

    } else if (id === 'statue' || id === 'column' || id === 'monument') {
      // Five statue silhouettes chosen by id + hash.
      //   column     → columns (fluted column shape w/ capital + base)
      //   monument   → obelisk (tall pyramid-capped pillar)
      //   statue     → hash picks equestrian / figure / urn / orb
      if (id === 'column') {
        emitRot(new THREE.BoxGeometry(0.4, 0.12, 0.4), 0, 0.06, 0, 0xaaa29a)
        emitRot(new THREE.CylinderGeometry(0.09, 0.12, 1.6, 6), 0, 0.92, 0, 0xbab2aa)
        emitRot(new THREE.BoxGeometry(0.32, 0.12, 0.32), 0, 1.78, 0, 0xaaa29a)
        emitRot(new THREE.BoxGeometry(0.38, 0.06, 0.38), 0, 1.87, 0, 0xaaa29a)
      } else if (id === 'monument') {
        emitRot(new THREE.BoxGeometry(0.7, 0.22, 0.7), 0, 0.11, 0, 0x9a9288)
        const shaft = new THREE.CylinderGeometry(0.12, 0.22, 2.0, 4)
        shaft.rotateY(Math.PI / 4)
        emitRot(shaft, 0, 1.22, 0, 0xbab2a8)
        const pyramid = new THREE.ConeGeometry(0.2, 0.35, 4)
        pyramid.rotateY(Math.PI / 4)
        emitRot(pyramid, 0, 2.4, 0, 0xbab2a8)
      } else {
        const statueVariant = hash % 4
        // A CIVIC STATUE IS TALLER THAN A PERSON, plinth included, and this
        // drew 1.42m against a 1.8-5m target — a garden ornament on the main
        // square. Ungraded until the plaza pass started placing them, which
        // is the propscale pattern exactly: content nobody could see was
        // content nobody had measured. A pedestal you look UP at, and every
        // figure offset raised with it through one helper rather than
        // twenty-three edited numbers.
        const PLINTH = 1.05
        const sEmit = (g: THREE.BufferGeometry, dx: number, dy: number, dz: number, c: number) =>
          emitRot(g, dx, dy + (PLINTH - 0.55), dz, c)
        emitRot(new THREE.BoxGeometry(0.62, PLINTH, 0.62), 0, PLINTH / 2, 0, 0x9a9288)
        if (statueVariant === 0) {
          // Equestrian — the horse faces the propRot direction
          sEmit(new THREE.BoxGeometry(0.55, 0.28, 0.2), 0, 0.75, 0, 0xbab2a8)
          sEmit(new THREE.BoxGeometry(0.18, 0.24, 0.14), 0.25, 0.95, 0, 0xbab2a8)
          for (const [lx, lz] of [[-0.22, -0.07], [0.22, -0.07], [-0.22, 0.07], [0.22, 0.07]] as const) {
            sEmit(new THREE.BoxGeometry(0.06, 0.22, 0.06), lx, 0.65, lz, 0xbab2a8)
          }
          sEmit(new THREE.BoxGeometry(0.18, 0.3, 0.15), 0.02, 1.1, 0, 0xbab2a8)
          sEmit(new THREE.SphereGeometry(0.1, 6, 5), 0.02, 1.32, 0, 0xbab2a8)
        } else if (statueVariant === 1) {
          sEmit(new THREE.BoxGeometry(0.24, 0.5, 0.18), 0, 0.85, 0, 0xbab2a8)
          sEmit(new THREE.SphereGeometry(0.11, 6, 5), 0, 1.2, 0, 0xbab2a8)
          sEmit(new THREE.BoxGeometry(0.08, 0.42, 0.08), 0.18, 0.85, 0, 0xbab2a8)
          sEmit(new THREE.BoxGeometry(0.22, 0.2, 0.16), 0, 0.67, 0, 0xbab2a8)
        } else if (statueVariant === 2) {
          sEmit(new THREE.CylinderGeometry(0.12, 0.18, 0.15, 8), 0, 0.63, 0, 0xbab2a8)
          const urnBody = new THREE.SphereGeometry(0.22, 7, 6)
          urnBody.scale(1.0, 0.85, 1.0)
          sEmit(urnBody, 0, 0.88, 0, 0xbab2a8)
          sEmit(new THREE.CylinderGeometry(0.12, 0.16, 0.12, 8), 0, 1.1, 0, 0xbab2a8)
          sEmit(new THREE.CylinderGeometry(0.18, 0.14, 0.05, 8), 0, 1.18, 0, 0xbab2a8)
        } else {
          sEmit(new THREE.CylinderGeometry(0.1, 0.13, 0.9, 6), 0, 1.0, 0, 0xbab2a8)
          sEmit(new THREE.SphereGeometry(0.22, 7, 6), 0, 1.58, 0, 0xbab2a8)
        }
      }

    } else if (id === 'fence' || id === 'iron_fence' || id === 'stone_wall' || id === 'crenellated_wall' || id === 'picket_fence') {
      // EVERY FENCE IN TOWN RAN EAST-WEST. This whole branch baked world
      // coordinates straight into `.translate(px + dx, ..., pz)` and never
      // touched `propRot`, which is precisely what the comment above emitRot
      // warns against — so a boundary meant to run north-south was drawn
      // across its own street. It affected `fence`, `iron_fence`, `stone_wall`
      // and `crenellated_wall`, all of which are placed today, and it is why
      // `picket_fence` could not simply be switched on.
      //
      // A fence's facing is DECIDED, not rolled: propRot falls back to a
      // random angle up to a half turn on a 1x1 prop, which is right for a
      // barrel and meaningless for a boundary, so the placer sets `facingY`
      // from the side the street is on.
      const crenellated = id === 'crenellated_wall' || (id === 'stone_wall' && (hash % 3 === 0))
      if (crenellated) {
        // Low crenellated stone wall — body + merlons along the top.
        emitRot(new THREE.BoxGeometry(fp.w * 0.9, 0.65, 0.22), 0, 0.325, 0, 0x787268)
        const merlonCount = Math.max(3, Math.floor(fp.w * 2))
        for (let mi = 0; mi < merlonCount; mi++) {
          if (mi % 2 === 0) continue // gaps form the battlement pattern
          const mx = -fp.w * 0.42 + mi * (fp.w * 0.84 / (merlonCount - 1))
          emitRot(new THREE.BoxGeometry(fp.w * 0.84 / (merlonCount - 1) * 0.8, 0.2, 0.22),
            mx, 0.75, 0, 0x787268)
        }
      } else if (id === 'stone_wall') {
        // Stacked rough-stone wall — body + stone course band (darker)
        emitRot(new THREE.BoxGeometry(fp.w * 0.9, 0.65, 0.22), 0, 0.325, 0, 0x807a70)
        emitRot(new THREE.BoxGeometry(fp.w * 0.95, 0.08, 0.28), 0, 0.69, 0, 0x6a6458)
      } else if (id === 'iron_fence') {
        // Ornate iron fence with posts, rails, finials on posts
        emitRot(new THREE.BoxGeometry(fp.w * 0.9, 0.04, 0.04), 0, 0.15, 0, 0x1a1a1a)
        emitRot(new THREE.BoxGeometry(fp.w * 0.9, 0.04, 0.04), 0, 0.72, 0, 0x1a1a1a)
        const numBars = Math.max(3, Math.floor(fp.w * 3))
        for (let bi = 0; bi < numBars; bi++) {
          const bx = -fp.w * 0.4 + bi * (fp.w * 0.8 / Math.max(1, numBars - 1))
          emitRot(new THREE.CylinderGeometry(0.015, 0.015, 0.7, 3), bx, 0.43, 0, 0x1a1a1a)
          // Point finials on every third bar
          if (bi % 3 === 0) emitRot(new THREE.ConeGeometry(0.03, 0.1, 4), bx, 0.82, 0, 0x1a1a1a)
        }
        // Posts at the ends (taller, thicker)
        for (const pxSide of [-fp.w * 0.45, fp.w * 0.45]) {
          emitRot(new THREE.BoxGeometry(0.08, 0.95, 0.08), pxSide, 0.47, 0, 0x1a1a1a)
          emitRot(new THREE.SphereGeometry(0.06, 5, 4), pxSide, 0.97, 0, 0x1a1a1a)
        }
      } else if (id === 'picket_fence') {
        // Picket fence — pointed-top slats with a rail behind them.
        // WAIST HIGH, which is what a picket fence is for: you see the garden
        // OVER it. It drew at 0.62m — knee height, a border edging rather than
        // a boundary — and `propscale.mjs` had no target for it, so nothing
        // said so. Two rails now, because one rail on a 0.9m slat sags.
        const SLAT_H = 0.88
        emitRot(new THREE.BoxGeometry(fp.w * 0.92, 0.045, 0.04), 0, 0.24, -0.025, 0xd8c8a8)
        emitRot(new THREE.BoxGeometry(fp.w * 0.92, 0.045, 0.04), 0, 0.70, -0.025, 0xd8c8a8)
        const slatCount = Math.max(4, Math.floor(fp.w * 3))
        for (let si = 0; si < slatCount; si++) {
          const sx = -fp.w * 0.42 + si * (fp.w * 0.84 / Math.max(1, slatCount - 1))
          emitRot(new THREE.BoxGeometry(0.07, SLAT_H, 0.035), sx, SLAT_H / 2, 0, 0xe8d8b8)
          // Pointed cap
          emitRot(new THREE.ConeGeometry(0.05, 0.11, 4), sx, SLAT_H + 0.05, 0, 0xe8d8b8)
        }
      } else {
        // Classic wooden fence (2 rails + 3 posts)
        for (const ry of [0.2, 0.45]) {
          emitRot(new THREE.BoxGeometry(fp.w * 0.9, 0.04, 0.03), 0, ry, 0, 0x6a4a28)
        }
        for (const fx of [-fp.w * 0.4, 0, fp.w * 0.4]) {
          emitRot(new THREE.BoxGeometry(0.06, 0.55, 0.06), fx, 0.275, 0, 0x6a4a28)
        }
      }

    } else if (id === 'cafe_table') {
      // 0.74m is table height. It drew 0.57 — you would eat off it kneeling.
      emitRot(new THREE.CylinderGeometry(0.32, 0.32, 0.035, 8), 0, 0.72, 0, 0x8a7a5a)
      emitRot(new THREE.CylinderGeometry(0.035, 0.06, 0.72, 4), 0, 0.36, 0, 0x8a7a5a)

    } else if (id === 'hanging_sign' || id === 'sign') {
      // Three sign variants by hash: hanging tavern sign on bracket,
      // wooden shop shingle on posts, and two-sided A-frame sign board.
      const sv = hash % 3
      const signColors = [0xb89050, 0x905040, 0x406050, 0x504080, 0xa05030]
      const boardColor = signColors[hash % signColors.length]
      if (sv === 0 && id === 'hanging_sign') {
        emitRot(new THREE.BoxGeometry(0.5, 0.05, 0.05), 0.25, 1.5, 0, 0x4a3a20)
        emitRot(new THREE.SphereGeometry(0.05, 5, 4), 0.5, 1.5, 0, 0x4a3a20)
        for (const cx of [0.15, 0.4]) {
          emitRot(new THREE.BoxGeometry(0.02, 0.25, 0.02), cx, 1.35, 0, 0x2a2a2a)
        }
        emitRot(new THREE.BoxGeometry(0.5, 0.35, 0.04), 0.28, 1.05, 0, boardColor)
        emitRot(new THREE.BoxGeometry(0.54, 0.39, 0.025), 0.28, 1.05, -0.01, 0x3a2818)
      } else if (sv === 1) {
        for (const lx of [-0.22, 0.22]) {
          emitRot(new THREE.BoxGeometry(0.06, 1.3, 0.06), lx, 0.65, 0, 0x5a4020)
        }
        emitRot(new THREE.BoxGeometry(0.6, 0.3, 0.04), 0, 1.0, 0, boardColor)
        emitRot(new THREE.ConeGeometry(0.08, 0.12, 4), 0, 1.22, 0, 0x5a4020)
      } else {
        for (const side of [-1, 1]) {
          const board = new THREE.BoxGeometry(0.5, 0.7, 0.04)
          board.rotateX(side * 0.3)
          emitRot(board, 0, 0.4, side * 0.1, boardColor)
        }
        emitRot(new THREE.BoxGeometry(0.5, 0.04, 0.04), 0, 0.7, 0, 0x3a2818)
      }

    } else if (id === 'wagon' || id === 'cart') {
      // A WAGON IS BIGGER THAN A CART, and both were drawn at the same size.
      // Measured at 1.65m long and 0.82m tall against a 1.6-3.2 / 1.2-2.6
      // target — a cart, which is what `cart` is for. Two ids sharing a draw
      // path is fine; two ids sharing a SIZE is the pair not meaning anything.
      // The wagon scales as a whole through one helper, so its wheels, bed
      // and sides keep their proportions to each other.
      const wagonScale = id === 'wagon' ? 1.55 : 1.0
      const wEmit = (g: THREE.BufferGeometry, dx: number, dy: number, dz: number, c: number) => {
        if (wagonScale !== 1) g.scale(wagonScale, wagonScale, wagonScale)
        emitRot(g, dx * wagonScale, dy * wagonScale, dz * wagonScale, c)
      }
      // Three wagon variants: heavy market wagon, covered wagon, small cart.
      const wv = hash % 3
      if (wv === 0) {
        wEmit(new THREE.BoxGeometry(1.4, 0.08, 0.7), 0, 0.42, 0, 0x6a5030)
        for (const sz of [-0.35, 0.35]) {
          wEmit(new THREE.BoxGeometry(1.4, 0.25, 0.04), 0, 0.57, sz, 0x6a5030)
        }
        for (const [wx, wz] of [[-0.5, -0.4], [0.5, -0.4], [-0.5, 0.4], [0.5, 0.4]] as const) {
          const wheel = new THREE.CylinderGeometry(0.24, 0.24, 0.06, 8)
          wheel.rotateX(Math.PI / 2)
          wEmit(wheel, wx, 0.24, wz, 0x3a2818)
          for (let sp = 0; sp < 2; sp++) {
            const spoke = new THREE.BoxGeometry(0.03, 0.42, 0.03)
            spoke.rotateZ(sp * Math.PI / 2)
            wEmit(spoke, wx, 0.24, wz, 0x5a4028)
          }
        }
        wEmit(new THREE.BoxGeometry(0.8, 0.35, 0.5), 0, 0.64, 0, 0x8a6a3a)
      } else if (wv === 1) {
        wEmit(new THREE.BoxGeometry(1.3, 0.08, 0.65), 0, 0.38, 0, 0x6a5030)
        for (const [wx, wz] of [[-0.45, -0.35], [0.45, -0.35], [-0.45, 0.35], [0.45, 0.35]] as const) {
          const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 8)
          wheel.rotateX(Math.PI / 2)
          wEmit(wheel, wx, 0.2, wz, 0x3a2818)
        }
        const cover = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 8, 1, false, 0, Math.PI)
        cover.rotateZ(Math.PI / 2)
        wEmit(cover, 0, 0.82, 0, 0xd8c8a0)
        for (let ri = 0; ri < 3; ri++) {
          const rib = new THREE.TorusGeometry(0.4, 0.02, 3, 8, Math.PI)
          rib.rotateZ(Math.PI / 2)
          rib.rotateY(Math.PI / 2)
          wEmit(rib, (ri - 1) * 0.45, 0.82, 0, 0x8a7a50)
        }
      } else {
        wEmit(new THREE.BoxGeometry(0.9, 0.08, 0.5), 0, 0.32, 0, 0x6a5030)
        for (const sz of [-0.27, 0.27]) {
          wEmit(new THREE.BoxGeometry(0.9, 0.18, 0.03), 0, 0.45, sz, 0x6a5030)
        }
        for (const wx of [-0.35, 0.35]) {
          const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.04, 8)
          wheel.rotateX(Math.PI / 2)
          wEmit(wheel, wx, 0.2, 0.3, 0x3a2818)
        }
        wEmit(new THREE.BoxGeometry(0.04, 0.04, 0.75), 0, 0.35, -0.5, 0x5a3820)
      }

    } else if (id === 'potted_plant' || id === 'flower_box' || id === 'planter_box') {
      // Four variants — tall urn with trailing flowers, wide box, stone
      // bowl, and classic terracotta pot.
      const pv = hash % 4
      const flowerColors = [0xc04040, 0xc08040, 0xe0c040, 0x9050c0, 0xe08090]
      const flowerColor = flowerColors[(hash >> 2) % flowerColors.length]
      if (id === 'planter_box' || id === 'flower_box') {
        const box = new THREE.BoxGeometry(0.8, 0.3, 0.3)
        box.translate(px, elev + 0.15, pz)
        batch.addPositioned(box, 0x8a5a30)
        // Trim strip along the top
        const trim = new THREE.BoxGeometry(0.85, 0.04, 0.33)
        trim.translate(px, elev + 0.32, pz)
        batch.addPositioned(trim, 0x6a4028)
        // Four plants across
        for (let pi = 0; pi < 4; pi++) {
          const p = geo.bushGeo.clone()
          p.scale(0.2, 0.22, 0.2)
          p.translate(px - 0.3 + pi * 0.2, elev + 0.42, pz)
          batch.addPositioned(p, 0x3a8a3a)
          // A flower bud on two of them
          if (pi % 2 === 0) {
            const bud = new THREE.SphereGeometry(0.06, 5, 4)
            bud.translate(px - 0.3 + pi * 0.2, elev + 0.52, pz)
            batch.addPositioned(bud, flowerColor)
          }
        }
      } else if (pv === 0) {
        // Tall urn with trailing flowers (Mediterranean vibe)
        const base = new THREE.CylinderGeometry(0.1, 0.14, 0.15, 6)
        base.translate(px, elev + 0.08, pz)
        batch.addPositioned(base, 0x8a5a30)
        const body = new THREE.CylinderGeometry(0.18, 0.12, 0.45, 6)
        body.translate(px, elev + 0.38, pz)
        batch.addPositioned(body, 0x8a5a30)
        // Plant on top
        const leafy = geo.bushGeo.clone()
        leafy.scale(0.4, 0.3, 0.4)
        leafy.translate(px, elev + 0.66, pz)
        batch.addPositioned(leafy, 0x3a8a3a)
        // Three flower buds peeking out
        for (let fi = 0; fi < 3; fi++) {
          const ang = (fi / 3) * Math.PI * 2
          const bud = new THREE.SphereGeometry(0.05, 5, 4)
          bud.translate(px + Math.cos(ang) * 0.18, elev + 0.78, pz + Math.sin(ang) * 0.18)
          batch.addPositioned(bud, flowerColor)
        }
      } else if (pv === 1) {
        // Stone bowl with plant
        const bowl = new THREE.CylinderGeometry(0.25, 0.16, 0.18, 8)
        bowl.translate(px, elev + 0.09, pz)
        batch.addPositioned(bowl, 0x908878)
        const plant = geo.bushGeo.clone()
        plant.scale(0.35, 0.3, 0.35)
        plant.translate(px, elev + 0.32, pz)
        batch.addPositioned(plant, 0x3a8a3a)
      } else {
        // Terracotta pot with flowering plant
        const pot = new THREE.CylinderGeometry(0.15, 0.12, 0.28, 6)
        pot.translate(px, elev + 0.14, pz)
        batch.addPositioned(pot, 0xa05830)
        const plant = geo.bushGeo.clone()
        plant.scale(0.42, 0.42, 0.42)
        plant.translate(px, elev + 0.45, pz)
        batch.addPositioned(plant, 0x3a8a3a)
        // A single flower on top
        const bud = new THREE.SphereGeometry(0.07, 5, 4)
        bud.translate(px, elev + 0.58, pz)
        batch.addPositioned(bud, flowerColor)
      }

    } else if (id === 'gravestone') {
      const gv = hash % 4
      const stoneColor = 0x747066
      if (gv === 0) {
        emitRot(new THREE.BoxGeometry(0.3, 0.5, 0.08), 0, 0.25, 0, stoneColor)
        const dome = new THREE.SphereGeometry(0.15, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2)
        dome.scale(1.0, 0.7, 0.55)
        emitRot(dome, 0, 0.5, 0, stoneColor)
      } else if (gv === 1) {
        emitRot(new THREE.BoxGeometry(0.1, 0.7, 0.1), 0, 0.35, 0, stoneColor)
        emitRot(new THREE.BoxGeometry(0.36, 0.1, 0.1), 0, 0.55, 0, stoneColor)
        emitRot(new THREE.BoxGeometry(0.28, 0.08, 0.2), 0, 0.04, 0, stoneColor)
      } else if (gv === 2) {
        emitRot(new THREE.BoxGeometry(0.28, 0.5, 0.24), 0, 0.25, 0, stoneColor)
        const urn = new THREE.SphereGeometry(0.14, 6, 5)
        urn.scale(1.0, 0.9, 1.0)
        emitRot(urn, 0, 0.6, 0, stoneColor)
      } else {
        const tiltSign = (hash >> 2) & 1 ? 1 : -1
        const slab = new THREE.BoxGeometry(0.3, 0.5, 0.08)
        slab.rotateZ(0.18 * tiltSign)
        emitRot(slab, 0, 0.22, 0, stoneColor)
      }

    } else if (id === 'garden_arch') {
      for (const sx of [-0.4, 0.4]) {
        const post = new THREE.BoxGeometry(0.06, 1.6, 0.06)
        post.translate(px + sx, elev + 0.8, pz)
        batch.addPositioned(post, 0x5a4a30)
      }
      const arch = new THREE.TorusGeometry(0.4, 0.03, 4, 8, Math.PI)
      arch.rotateZ(Math.PI)
      arch.translate(px, elev + 1.6, pz)
      batch.addPositioned(arch, 0x5a4a30)

    } else if (id === 'bridge' || id === 'stone_bridge' || id === 'arched_bridge') {
      // Arched stone bridge: 2–3 stone piers + deck + parapet walls + arched
      // cut-outs underneath (implied by stacked piers with gaps). Long axis
      // runs along the longer footprint dimension.
      const longAxisX = fp.w >= fp.h
      const L = longAxisX ? fp.w : fp.h
      const W = longAxisX ? fp.h : fp.w
      const deckThick = 0.2
      const deckY = elev + 0.6
      const stoneColor = 0x8a8478
      const parapetColor = 0x706a5c

      // Deck slab
      const deck = new THREE.BoxGeometry(
        longAxisX ? L * 0.95 : W * 0.85,
        deckThick,
        longAxisX ? W * 0.85 : L * 0.95,
      )
      deck.translate(px, deckY, pz)
      batch.addPositioned(deck, stoneColor)

      // Parapet walls (low walls on both sides of the deck)
      for (const side of [-1, 1]) {
        const parapet = new THREE.BoxGeometry(
          longAxisX ? L * 0.95 : 0.12,
          0.3,
          longAxisX ? 0.12 : L * 0.95,
        )
        parapet.translate(
          px + (longAxisX ? 0 : side * (W * 0.42)),
          deckY + 0.25,
          pz + (longAxisX ? side * (W * 0.42) : 0),
        )
        batch.addPositioned(parapet, parapetColor)
      }

      // Piers under the deck with a visible arch profile (half-cylinder)
      const pierCount = L > 4 ? 3 : 2
      for (let i = 0; i < pierCount; i++) {
        const t = (i + 1) / (pierCount + 1)
        const pierPos = (t - 0.5) * L * 0.92
        const pier = new THREE.BoxGeometry(
          longAxisX ? 0.28 : W * 0.7,
          0.5,
          longAxisX ? W * 0.7 : 0.28,
        )
        pier.translate(
          px + (longAxisX ? pierPos : 0),
          elev + 0.25,
          pz + (longAxisX ? 0 : pierPos),
        )
        batch.addPositioned(pier, stoneColor)
      }

      // Arch bands on the sides (Torus half, facing outward)
      for (let i = 0; i <= pierCount; i++) {
        const archT = (i) / (pierCount + 1) + 1 / (pierCount + 1) / 2
        const archPos = (archT - 0.5) * L * 0.92
        for (const faceSide of [-1, 1]) {
          const archGeo = new THREE.TorusGeometry(0.28, 0.06, 4, 8, Math.PI)
          archGeo.rotateZ(Math.PI)
          if (longAxisX) {
            // Arches face ±Z (the side of the bridge)
            archGeo.rotateY(Math.PI / 2)
            archGeo.translate(px + archPos, elev + 0.48, pz + faceSide * W * 0.42)
          } else {
            archGeo.translate(px + faceSide * W * 0.42, elev + 0.48, pz + archPos)
          }
          batch.addPositioned(archGeo, stoneColor)
        }
      }

    } else if (id === 'fishing_boat' || id === 'rowboat' || id === 'skiff') {
      // Hull: long narrow box with tilted end planks to suggest prow/stern
      const longAxisX = fp.w >= fp.h
      // A hull is a hull. These were fp.w * 0.85, which after the rescale made
      // every rowboat 5.3m long against a 22cm hull and a 30cm prow — a plank
      // floating on the river rather than a boat.
      const hullLen = id === 'fishing_boat' ? 5.4 : id === 'skiff' ? 4.0 : 3.4
      const hullBeam = id === 'fishing_boat' ? 1.9 : 1.3
      const L = physical(hullLen, longAxisX ? fp.w : fp.h)
      const W = physical(hullBeam, longAxisX ? fp.h : fp.w)
      // The freeboard has to grow with the hull or the pancake comes back.
      const hullH = L * 0.16
      const hullColor = 0x6a4a28
      const plankColor = 0x5a3a20
      const hull = new THREE.BoxGeometry(longAxisX ? L : W, hullH, longAxisX ? W : L)
      hull.translate(px, elev + hullH * 0.5, pz)
      batch.addPositioned(hull, hullColor)
      // Tilted prow plank (front)
      const prow = new THREE.BoxGeometry(longAxisX ? 0.2 : W, hullH * 1.5, longAxisX ? W : 0.2)
      prow.rotateZ(longAxisX ? 0.4 : 0)
      prow.rotateX(longAxisX ? 0 : 0.4)
      prow.translate(
        px + (longAxisX ? L / 2 + 0.05 : 0),
        elev + hullH * 0.8,
        pz + (longAxisX ? 0 : L / 2 + 0.05),
      )
      batch.addPositioned(prow, plankColor)
      // Bench seats inside (two thin cross-planks)
      for (let si = 0; si < 2; si++) {
        const seat = new THREE.BoxGeometry(
          longAxisX ? 0.1 : W * 0.9,
          0.04,
          longAxisX ? W * 0.9 : 0.1,
        )
        const t = (si === 0 ? -0.2 : 0.2) * L
        seat.translate(
          px + (longAxisX ? t : 0),
          elev + hullH * 0.95,
          pz + (longAxisX ? 0 : t),
        )
        batch.addPositioned(seat, plankColor)
      }
      // Oar (single) on one side for rowboat/skiff
      if (id !== 'fishing_boat') {
        const oar = new THREE.BoxGeometry(longAxisX ? 0.03 : 0.7, 0.03, longAxisX ? 0.7 : 0.03)
        oar.rotateY(longAxisX ? 0.3 : -0.3)
        oar.translate(
          px + (longAxisX ? 0 : W * 0.3),
          elev + 0.32,
          pz + (longAxisX ? W * 0.3 : 0),
        )
        batch.addPositioned(oar, plankColor)
      } else {
        // Fishing net: thin plane draped over the side of a fishing boat
        const net = new THREE.BoxGeometry(
          longAxisX ? L * 0.4 : 0.05,
          0.02,
          longAxisX ? 0.05 : L * 0.4,
        )
        net.translate(
          px + (longAxisX ? L * 0.2 : W * 0.35),
          elev + 0.32,
          pz + (longAxisX ? W * 0.35 : L * 0.2),
        )
        batch.addPositioned(net, 0x8a7850)
      }

    } else if (id === 'crane' || id === 'port_crane') {
      // Tall wooden crane — vertical post + angled jib + pulley + hanging rope
      const post = new THREE.BoxGeometry(0.22, 2.2, 0.22)
      post.translate(px, elev + 1.1, pz)
      batch.addPositioned(post, 0x6a4a28)
      // Angled jib (diagonal)
      const jib = new THREE.BoxGeometry(0.14, 1.6, 0.14)
      jib.rotateZ(-0.65)
      jib.translate(px + 0.55, elev + 2.0, pz)
      batch.addPositioned(jib, 0x6a4a28)
      // Counter-weight at the bottom of the jib
      const cw = new THREE.BoxGeometry(0.3, 0.2, 0.3)
      cw.translate(px - 0.35, elev + 1.55, pz)
      batch.addPositioned(cw, 0x3a2a18)
      // Pulley block at end of jib
      const pulley = new THREE.BoxGeometry(0.15, 0.15, 0.15)
      pulley.translate(px + 1.08, elev + 2.5, pz)
      batch.addPositioned(pulley, 0x4a3a20)
      // Rope hanging from pulley
      const rope = new THREE.BoxGeometry(0.03, 1.6, 0.03)
      rope.translate(px + 1.08, elev + 1.7, pz)
      batch.addPositioned(rope, 0x3a2818)
      // Hook/crate at rope end
      const hook = new THREE.BoxGeometry(0.35, 0.3, 0.35)
      hook.translate(px + 1.08, elev + 0.75, pz)
      batch.addPositioned(hook, 0x5a3a20)

    } else if (id === 'horse_post' || id === 'hitching_post') {
      // Thick post with a horizontal rail + small hooked top
      const post = new THREE.BoxGeometry(0.14, 1.0, 0.14)
      post.translate(px, elev + 0.5, pz)
      batch.addPositioned(post, 0x5a3a20)
      const rail = new THREE.BoxGeometry(0.8, 0.08, 0.08)
      rail.translate(px, elev + 0.85, pz)
      batch.addPositioned(rail, 0x5a3a20)
      // Small metal ring at one end (torus)
      const ring = new THREE.TorusGeometry(0.06, 0.015, 4, 8)
      ring.rotateY(Math.PI / 2)
      ring.translate(px + 0.35, elev + 0.85, pz + 0.09)
      batch.addPositioned(ring, 0x2a2a2a)

    } else if (id === 'cloth_line' || id === 'clothesline') {
      // Two posts + a line + a few hanging cloth squares
      for (const side of [-1, 1]) {
        const post = new THREE.BoxGeometry(0.08, 1.4, 0.08)
        post.translate(px + side * fp.w * 0.4, elev + 0.7, pz)
        batch.addPositioned(post, 0x5a3a20)
      }
      const line = new THREE.BoxGeometry(fp.w * 0.8, 0.02, 0.02)
      line.translate(px, elev + 1.35, pz)
      batch.addPositioned(line, 0x3a2818)
      // 4 cloth squares dangling
      const clothColors = [0xe0c8a0, 0xc0a0a0, 0x90b0c0, 0xa0c0a0]
      for (let ci = 0; ci < 4; ci++) {
        const cx = -fp.w * 0.3 + ci * (fp.w * 0.6 / 3)
        const cloth = new THREE.BoxGeometry(0.2, 0.3, 0.02)
        cloth.translate(px + cx, elev + 1.17, pz)
        batch.addPositioned(cloth, clothColors[(hash + ci) % clothColors.length])
      }

    } else if (id === 'road_marker' || id === 'milestone') {
      // Small rounded stone with a darker top cap (mile marker)
      const stone = new THREE.BoxGeometry(0.28, 0.55, 0.18)
      stone.translate(px, elev + 0.275, pz)
      batch.addPositioned(stone, 0x8a847a)
      const cap = new THREE.SphereGeometry(0.14, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2)
      cap.scale(1.0, 0.6, 0.5)
      cap.translate(px, elev + 0.55, pz)
      batch.addPositioned(cap, 0x6a6458)

    } else if (id === 'farm_field') {
      // Flat tilled ground patch — rectangular low slab with rows suggested
      // by alternating stripes of tilled earth / crop green.
      const earthColor = 0x6a4a28
      const cropColor = 0x4a7a28
      const base = new THREE.BoxGeometry(fp.w * 0.95, 0.04, fp.h * 0.95)
      base.translate(px, elev + 0.02, pz)
      batch.addPositioned(base, earthColor)
      // Crop rows running along the long axis
      const longAxisX = fp.w >= fp.h
      const L = longAxisX ? fp.w * 0.9 : fp.h * 0.9
      const W = longAxisX ? fp.h * 0.9 : fp.w * 0.9
      const rowCount = Math.max(3, Math.floor(W * 2.5))
      for (let r = 0; r < rowCount; r++) {
        const t = (r + 0.5) / rowCount - 0.5
        const row = new THREE.BoxGeometry(
          longAxisX ? L : 0.08,
          0.1,
          longAxisX ? 0.08 : L,
        )
        row.translate(
          px + (longAxisX ? 0 : t * W),
          elev + 0.08,
          pz + (longAxisX ? t * W : 0),
        )
        batch.addPositioned(row, cropColor)
      }

    } else if (id === 'haystack' || id === 'hay_bale') {
      // Haystack: mounded golden cone (single) or round bale (short cylinder).
      if (id === 'hay_bale') {
        const bale = new THREE.CylinderGeometry(0.38, 0.38, 0.5, 8)
        bale.rotateZ(Math.PI / 2)
        bale.translate(px, elev + 0.38, pz)
        batch.addPositioned(bale, 0xd4b060)
      } else {
        const mound = new THREE.ConeGeometry(0.6, 0.9, 8)
        mound.translate(px, elev + 0.45, pz)
        batch.addPositioned(mound, 0xd4b060)
        // Cap (smaller cone on top for the "hat")
        const cap = new THREE.ConeGeometry(0.3, 0.35, 7)
        cap.translate(px, elev + 1.05, pz)
        batch.addPositioned(cap, 0xc0a050)
      }

    } else if (id === 'handcart') {
      // A TWO-WHEEL BARROW LEFT WHERE SOMEBODY STOPPED PUSHING IT.
      // Tipped forward onto its nose with the shafts in the air, which is how
      // a handcart is actually parked and reads as "in use" rather than
      // "stored". Real barrow size: 1.3m bed, 0.28m wheels.
      const bedL = 1.3, bedW = 0.62, wheelR = 0.28
      const cartWood = 0x7a5a34, cartIron = 0x3c3630
      const bed = new THREE.BoxGeometry(bedW, 0.1, bedL)
      bed.rotateX(-0.22)
      emitRot(bed, 0, wheelR + 0.14, 0, cartWood)
      for (const side of [-1, 1]) {
        const sideBoard = new THREE.BoxGeometry(0.05, 0.26, bedL * 0.85)
        sideBoard.rotateX(-0.22)
        emitRot(sideBoard, side * bedW * 0.5, wheelR + 0.3, 0, cartWood)
        const wheel = new THREE.CylinderGeometry(wheelR, wheelR, 0.07, 10)
        wheel.rotateZ(Math.PI / 2)
        emitRot(wheel, side * (bedW * 0.5 + 0.05), wheelR, 0.05, cartIron)
        // Shafts angled up off the ground — the giveaway silhouette.
        const shaft = new THREE.BoxGeometry(0.06, 0.06, 0.95)
        shaft.rotateX(-0.5)
        emitRot(shaft, side * bedW * 0.32, wheelR + 0.5, -bedL * 0.62, cartWood)
      }
    } else if (id === 'ladder') {
      // Left leaning where the work stopped. `facingY` already points away
      // from the owning wall, so leaning about X puts the top back toward it.
      const ladLen = 2.9, ladW = 0.34, lean = 0.28
      const ladWood = 0x8a6a3c
      for (const side of [-1, 1]) {
        const rail = new THREE.BoxGeometry(0.055, ladLen, 0.055)
        rail.rotateX(lean)
        emitRot(rail, side * ladW * 0.5, Math.cos(lean) * ladLen * 0.5, 0, ladWood)
      }
      for (let i = 1; i < 7; i++) {
        const t = i / 7
        const bar = new THREE.BoxGeometry(ladW, 0.04, 0.04)
        bar.rotateX(lean)
        emitRot(bar, 0, Math.cos(lean) * ladLen * t,
          -Math.sin(lean) * ladLen * (t - 0.5), ladWood)
      }
    } else if (id === 'water_trough') {
      // Stone trough, for the horse tied to the hitching posts that now stand
      // at taverns, inns, stables and coach houses. The pair reads as a
      // working frontage where either alone reads as a stray object.
      const trL = 1.5, trW = 0.5, trH = 0.42
      const trStone = 0x827c72, trWater = 0x3f5a63
      const walls: Array<[number, number, number, number]> = [
        [trL, 0.09, 0, trW * 0.5], [trL, 0.09, 0, -trW * 0.5],
        [0.09, trW, trL * 0.5, 0], [0.09, trW, -trL * 0.5, 0],
      ]
      for (const [w, d, ox, oz] of walls) {
        emitRot(new THREE.BoxGeometry(w, trH, d), ox, trH * 0.5, oz, trStone)
      }
      emitRot(new THREE.BoxGeometry(trL, 0.1, trW), 0, 0.05, 0, trStone)
      emitRot(new THREE.BoxGeometry(trL - 0.16, 0.02, trW - 0.16),
        0, trH * 0.72, 0, trWater)
    } else if (id === 'sack_pile') {
      // Grain sacks. The town's clutter is currently crates and barrels and
      // nothing else, so every pile reads as joinery; a squashed sphere reads
      // as cloth and costs seven segments.
      const sackCloth = [0xa89a72, 0x9c8f68, 0xb0a37c]
      const sackLay: Array<[number, number, number]> = [
        [0, 0, 0], [0.34, 0, 0.06], [0.17, 0.3, -0.04], [-0.28, 0, -0.1],
      ]
      sackLay.forEach((o, i) => {
        const r = 0.24 - (o[1] > 0 ? 0.03 : 0)
        const sack = new THREE.SphereGeometry(r, 7, 5)
        sack.scale(1.0, 0.78, 0.85)
        emitRot(sack, o[0], r * 0.78 + o[1], o[2], sackCloth[i % sackCloth.length])
      })
    } else if (id === 'mounting_block') {
      // Two stone steps beside a door for getting onto a horse. The smallest
      // possible piece of "somebody rides from here", and real streets are
      // full of them.
      const mbStone = 0x8c867a
      for (let i = 0; i < 2; i++) {
        const w = 0.62 - i * 0.14, h = 0.19
        emitRot(new THREE.BoxGeometry(w, h, 0.44 - i * 0.12),
          0, h * 0.5 + i * h, i * 0.06, mbStone)
      }
    } else if (id === 'beehive') {
      // A straw skep — stacked tapering rings under a cap. Garden quarters and
      // the countryside; small, domestic, and unlike anything else out there.
      const skepStraw = 0xc0a86a
      const bands = 4
      for (let i = 0; i < bands; i++) {
        const t = i / bands
        const r = 0.28 * (1 - t * 0.55)
        const band = new THREE.CylinderGeometry(r * 0.9, r, 0.11, 9)
        emitRot(band, 0, 0.055 + i * 0.105, 0, skepStraw)
      }
      const cap = new THREE.SphereGeometry(0.13, 8, 5)
      cap.scale(1, 0.7, 1)
      emitRot(cap, 0, bands * 0.105 + 0.03, 0, skepStraw)
    } else if (id === 'woodpile') {
      // Stacked logs: horizontal cylinders in two rows, offset second row
      const logColor = 0x7a5a30
      for (let row = 0; row < 2; row++) {
        const count = 4 - row
        for (let i = 0; i < count; i++) {
          const log = new THREE.CylinderGeometry(0.1, 0.1, 0.8, 6)
          log.rotateZ(Math.PI / 2)
          log.translate(
            px + (i - (count - 1) / 2) * 0.21 + row * 0.1,
            elev + 0.1 + row * 0.21,
            pz,
          )
          batch.addPositioned(log, logColor)
        }
      }
      // End caps (darker circles at pile ends)
      for (const endX of [-0.4, 0.4]) {
        const endCap = new THREE.CylinderGeometry(0.12, 0.12, 0.02, 6)
        endCap.rotateZ(Math.PI / 2)
        endCap.translate(px + endX, elev + 0.2, pz)
        batch.addPositioned(endCap, 0x5a3a18)
      }

    } else if (id === 'tent' || id === 'pavilion' || id === 'market_tent') {
      // A TENT YOU CAN STAND UNDER. This drew 1.78m to the tip of its flag —
      // a cone sitting almost on the ground, which is a tent for a doll. It
      // had never been measured because it had never been PLACED: the plaza
      // pass that puts it out was asking roadMap whether the square was free
      // and roadMap calls the square a road, so `propscale.mjs`'s never-placed
      // census found it absent from five towns in a row. Content with no way
      // in arrives at whatever scale it was authored at, which is this file's
      // own lesson from the riverbank boulders.
      //
      // A market marquee: corner posts at head height, the cloth above them.
      const EAVE = 2.05
      emitRot(new THREE.BoxGeometry(fp.w * 0.85, 0.08, fp.h * 0.85), 0, 0.04, 0, 0x6a5030)
      const halfW = fp.w * 0.40, halfD = fp.h * 0.40
      for (const [cx2, cz2] of [[-halfW, -halfD], [halfW, -halfD], [-halfW, halfD], [halfW, halfD]] as const) {
        emitRot(new THREE.BoxGeometry(0.08, EAVE, 0.08), cx2, EAVE / 2, cz2, 0x6a5030)
      }
      const r = Math.max(fp.w, fp.h) * 0.58
      const tent = new THREE.ConeGeometry(r, 1.15, 4)
      tent.rotateY(Math.PI / 4)
      const tentColors = [0xc04040, 0x404080, 0x60803a, 0x805020]
      emitRot(tent, 0, EAVE + 0.52, 0, tentColors[hash % tentColors.length])
      // Flag at the peak
      emitRot(new THREE.BoxGeometry(0.035, 0.4, 0.035), 0, EAVE + 1.3, 0, 0x3a2818)
      emitRot(new THREE.PlaneGeometry(0.34, 0.17), 0.17, EAVE + 1.42, 0, 0xe0e0e0)

    } else if (id === 'dock' || id === 'pier') {
      // Wooden pier: long plank deck supported by visible posts sticking into water
      const longAxisX = fp.w >= fp.h
      const L = longAxisX ? fp.w : fp.h
      const W = longAxisX ? fp.h : fp.w
      const deck = new THREE.BoxGeometry(
        longAxisX ? L * 0.92 : W * 0.7,
        0.12,
        longAxisX ? W * 0.7 : L * 0.92,
      )
      deck.translate(px, elev + 0.4, pz)
      batch.addPositioned(deck, 0x8a6a40)
      // Plank grooves suggestion: thin darker stripes along the deck
      for (let pi = 0; pi < 5; pi++) {
        const groove = new THREE.BoxGeometry(
          longAxisX ? L * 0.92 : 0.02,
          0.01,
          longAxisX ? 0.02 : L * 0.92,
        )
        const t = pi / 4 - 0.5
        groove.translate(
          px + (longAxisX ? 0 : t * W * 0.7),
          elev + 0.47,
          pz + (longAxisX ? t * W * 0.7 : 0),
        )
        batch.addPositioned(groove, 0x5a3a20)
      }
      // Support posts (stick into water below the deck)
      const postCount = Math.max(4, Math.floor(L * 0.8))
      for (let pi = 0; pi < postCount; pi++) {
        const t = (pi + 0.5) / postCount - 0.5
        for (const side of [-1, 1]) {
          const post = new THREE.BoxGeometry(0.08, 0.8, 0.08)
          post.translate(
            px + (longAxisX ? t * L * 0.88 : side * W * 0.3),
            elev,
            pz + (longAxisX ? side * W * 0.3 : t * L * 0.88),
          )
          batch.addPositioned(post, 0x5a3a20)
        }
      }

    } else if (id === 'rock' || id === 'boulder' || id === 'standing_stone' || id === 'rocky_outcrop') {
      // Natural stone feature: cluster of tilted boulders with slightly
      // varied colors. Standing stones are taller singletons.
      // Stones have their OWN size. Deriving it from the footprint made a
      // boulder 2.7m across and a standing stone 4.3m tall — the faceted lump
      // that filled a third of the frame in every riverbank photograph. A
      // rocky outcrop legitimately spreads, so it gets the largest budget.
      const stoneSize = id === 'rocky_outcrop' ? 2.2 : id === 'boulder' ? 1.5 : 0.9
      const baseSize = physical(stoneSize, Math.max(fp.w, fp.h))
      if (id === 'standing_stone') {
        // A menhir is tall and slim: ~2.4m of it, not 1.4x whatever plot it
        // happened to land on.
        const stone = new THREE.BoxGeometry(
          physical(0.55, fp.w), 2.4, physical(0.4, fp.h),
        )
        stone.rotateZ(0.08 * (((hash >> 1) & 1) ? 1 : -1))
        stone.translate(px, elev + 1.2, pz)
        batch.addPositioned(stone, 0x7a746a)
      } else {
        // Cluster of 3 boulders at varied positions and heights
        for (let bi = 0; bi < 3; bi++) {
          const angle = (bi / 3) * Math.PI * 2 + hash * 0.3
          const r = baseSize * 0.3
          const boulder = new THREE.SphereGeometry(
            baseSize * (0.30 + ((hash >> (bi * 2)) & 3) * 0.055), 5, 4,
          )
          boulder.scale(1.0, 0.75, 1.0)
          boulder.translate(
            px + Math.cos(angle) * r,
            elev + baseSize * 0.16,
            pz + Math.sin(angle) * r,
          )
          batch.addPositioned(boulder, [0x7a746a, 0x84796a, 0x6a6460][bi % 3])
        }
      }

    } else if (id === 'forge_brazier') {
      // Artisan / forge district — cylindrical stone brazier with an
      // ember-glow core. The glow material shares the lantern emissive
      // driver (reused via a constant emissive that bloom picks up at
      // dusk) so forges light up with the rest of the town.
      const stone = 0x605850
      // Tripod legs
      for (let li = 0; li < 3; li++) {
        const ang = (li / 3) * Math.PI * 2
        const leg = new THREE.BoxGeometry(0.06, 0.45, 0.06)
        leg.rotateZ(ang > Math.PI ? -0.25 : 0.25)
        emitRot(leg, Math.cos(ang) * 0.2, 0.22, Math.sin(ang) * 0.2, stone)
      }
      // Bowl
      const bowl = new THREE.CylinderGeometry(0.3, 0.22, 0.22, 8)
      emitRot(bowl, 0, 0.55, 0, stone)
      // Rim ring (slightly wider)
      const rim = new THREE.CylinderGeometry(0.34, 0.3, 0.05, 8)
      emitRot(rim, 0, 0.67, 0, 0x4a4238)
      // Ember core — small hot orange cylinder visible inside the bowl
      const ember = new THREE.CylinderGeometry(0.18, 0.14, 0.08, 6)
      emitGlow(ember, 0, 0.64, 0)
      // A couple of glow dots on top for floaters/sparks frozen in stone
      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2 + hash
        const glow = new THREE.SphereGeometry(0.05, 5, 4)
        emitGlow(glow, Math.cos(ang) * 0.1, 0.72 + i * 0.02, Math.sin(ang) * 0.1)
      }

    } else if (id === 'rubble_pile') {
      // Slum / cemetery / ruin prop — pile of 4–6 broken stone blocks at
      // varied angles + a few small chip spheres nearby. Reads as decay.
      const stones = [0x7a746a, 0x8a8478, 0x6a6458, 0x706860]
      const count = 4 + (hash % 3)
      for (let bi = 0; bi < count; bi++) {
        const ang = (bi / count) * Math.PI * 2 + hash * 0.31
        const r = 0.1 + (hash >> bi) % 10 / 40
        const sz = 0.14 + ((hash >> (bi * 2)) & 3) * 0.04
        const block = new THREE.BoxGeometry(sz, sz * 0.7, sz * 0.85)
        block.rotateY(ang + 0.3 * bi)
        block.rotateZ(0.2 * Math.sin(bi + hash))
        emitRot(block, Math.cos(ang) * r, sz * 0.35 + ((hash >> bi) & 3) * 0.03, Math.sin(ang) * r, stones[bi % stones.length])
      }
      // A few small chip spheres
      for (let ci = 0; ci < 3; ci++) {
        const ang = (ci / 3) * Math.PI * 2 + 0.7
        const chip = new THREE.SphereGeometry(0.05, 5, 4)
        emitRot(chip, Math.cos(ang) * 0.28, 0.06, Math.sin(ang) * 0.28, stones[ci % stones.length])
      }

    } else if (id === 'prayer_flags') {
      // Temple prop — two thin poles with a horizontal rope between and
      // 7 small rectangular cloth flags dangling. Muted spiritual palette
      // (earth red, saffron, ivory, deep teal, tan) — reads as sacred
      // rather than festival even though the geometry rhymes with bunting.
      const postColor = 0x4a3a20
      for (const sx of [-0.5, 0.5]) {
        emitRot(new THREE.BoxGeometry(0.05, 1.8, 0.05), sx, 0.9, 0, postColor)
      }
      emitRot(new THREE.BoxGeometry(1.0, 0.025, 0.025), 0, 1.75, 0, 0x3a2a18)
      const flagColors = [0xa03028, 0xe0b030, 0xeae0cc, 0x306a80, 0x8c6438]
      for (let fi = 0; fi < 7; fi++) {
        const t = (fi + 0.5) / 7 - 0.5
        const flag = new THREE.BoxGeometry(0.11, 0.22, 0.02)
        emitRot(flag, t * 0.95, 1.65, 0, flagColors[(fi + hash) % flagColors.length])
      }

    } else if (id === 'cemetery_cross') {
      // Cemetery centerpiece — ornate Celtic-style stone cross on a
      // plinth, distinct from the flat gravestones. Adds verticality to
      // cemeteries that otherwise look like rows of stubby slabs.
      const stone = 0x6a6458
      const stoneDark = 0x5a5448
      emitRot(new THREE.BoxGeometry(0.5, 0.22, 0.5), 0, 0.11, 0, stoneDark)
      emitRot(new THREE.BoxGeometry(0.18, 1.6, 0.18), 0, 1.02, 0, stone)
      emitRot(new THREE.BoxGeometry(0.8, 0.2, 0.18), 0, 1.55, 0, stone)
      const ring = new THREE.TorusGeometry(0.28, 0.055, 5, 12)
      emitRot(ring, 0, 1.55, 0, stone)
      emitRot(new THREE.SphereGeometry(0.09, 6, 5), 0, 1.88, 0, stone)

    } else if (id === 'bunting_pole') {
      // Market festival prop — tall pole with a droopy string of colored
      // triangle pennants trailing off one side toward an "implied" next
      // pole. Reads as festival day from any angle.
      emitRot(new THREE.BoxGeometry(0.08, 2.0, 0.08), 0, 1.0, 0, 0x5a3a20)
      emitRot(new THREE.SphereGeometry(0.09, 6, 4), 0, 2.05, 0, 0x3a2818)
      const pennantColors = [0xc02040, 0xe0a030, 0x30a050, 0x3060c0, 0xa040c0, 0xe0e040]
      // 6 pennants along a shallow catenary-ish line going sideways
      for (let fi = 0; fi < 6; fi++) {
        const t = fi / 5
        const lateral = 0.15 + t * 0.9
        const drop = 1.85 - Math.sin(Math.PI * t) * 0.25
        const pennant = new THREE.BoxGeometry(0.14, 0.18, 0.02)
        pennant.rotateZ((fi % 2 === 0 ? 0.15 : -0.15))
        emitRot(pennant, lateral, drop - 0.1, 0, pennantColors[(fi + hash) % pennantColors.length])
      }

    } else if (id === 'heraldic_banner') {
      // Noble / gate ceremonial — tall pole, horizontal crossbar, vertical
      // cloth banner with a contrasting inset square motif. Hash chooses
      // per-instance banner color + motif color so rival houses look
      // distinct.
      const poleColor = 0x3a2818
      emitRot(new THREE.BoxGeometry(0.08, 2.2, 0.08), 0, 1.1, 0, poleColor)
      // Horizontal top piece supporting the banner
      emitRot(new THREE.BoxGeometry(0.5, 0.06, 0.04), 0.22, 2.0, 0, poleColor)
      // Small finial at pole top
      emitRot(new THREE.ConeGeometry(0.08, 0.16, 4), 0, 2.28, 0, 0xd4b060)
      const palette = [0xa02030, 0x304080, 0x306040, 0x804020, 0x604080, 0xa07030, 0xcc9030]
      const bannerColor = palette[hash % palette.length]
      const motifColor = palette[(hash + 3) % palette.length]
      // Main banner cloth hanging from the crossbar
      emitRot(new THREE.BoxGeometry(0.45, 1.1, 0.02), 0.22, 1.45, 0, bannerColor)
      // Heraldic motif — contrast-color square inset
      emitRot(new THREE.BoxGeometry(0.22, 0.22, 0.025), 0.22, 1.6, 0, motifColor)
      // Small decorative ball at each of three hanging slots bottom
      for (const sx of [-0.15, 0, 0.15]) {
        emitRot(new THREE.SphereGeometry(0.035, 5, 4), 0.22 + sx, 0.87, 0, 0xd4b060)
      }

    } else if (id === 'fish_rack') {
      // Harbor prop — 3 vertical stakes + 2 crossbars + 5 hanging fish
      // silhouettes. fp 2×1, oriented along the longer axis.
      const longAxisX = fp.w >= fp.h
      // A drying rack is about 2.5m of crossbar. Spanning the footprint made
      // it 5.5m — a fence with fish on it.
      const L = physical(2.5, longAxisX ? fp.w : fp.h)
      const postColor = 0x5a3a20
      const fishColor = 0x8a7060
      for (let si = 0; si < 3; si++) {
        const t = (si / 2) * L - L / 2
        const dx = longAxisX ? t : 0
        const dz = longAxisX ? 0 : t
        emitRot(new THREE.BoxGeometry(0.08, 1.4, 0.08), dx, 0.7, dz, postColor)
      }
      for (const cy of [1.15, 0.75]) {
        const crossW = longAxisX ? L : 0.06
        const crossD = longAxisX ? 0.06 : L
        emitRot(new THREE.BoxGeometry(crossW, 0.05, crossD), 0, cy, 0, postColor)
      }
      // Fish: small flat slabs hanging from crossbars
      for (let fi = 0; fi < 5; fi++) {
        const t = (fi + 0.5) / 5 - 0.5
        const dx = longAxisX ? t * L : 0
        const dz = longAxisX ? 0 : t * L
        const fish = new THREE.BoxGeometry(0.18, 0.06, 0.04)
        // Tilt each fish a tiny bit so they read as dangling not perfectly flat
        fish.rotateZ((fi % 2 === 0 ? 0.15 : -0.15))
        emitRot(fish, dx, 1.0, dz, fishColor)
      }

    } else if (id === 'rope_coil') {
      // Coiled rope on the dock — stacked torii of decreasing radius.
      const ropeColor = 0x8a6a40
      for (let ri = 0; ri < 3; ri++) {
        const r = 0.32 - ri * 0.08
        const t = new THREE.TorusGeometry(r, 0.045, 4, 10)
        t.rotateX(Math.PI / 2)
        emitRot(t, 0, 0.04 + ri * 0.065, 0, ropeColor)
      }

    } else if (id === 'trellis_arch') {
      // Garden prop — taller + more decorative than plain garden_arch.
      // 2 stout posts, arching top with chevron crosspieces, climbing
      // vine sphere hiding the peak.
      const postColor = 0x5a4028
      const vineColor = 0x3a7a2a
      const flowerColor = [0xc04080, 0xe0b040, 0xe080a0][hash % 3]
      for (const sx of [-0.45, 0.45]) {
        emitRot(new THREE.BoxGeometry(0.1, 1.8, 0.1), sx, 0.9, 0, postColor)
      }
      // Arched crown: half-torus on its side
      const arch = new THREE.TorusGeometry(0.45, 0.05, 4, 10, Math.PI)
      arch.rotateZ(Math.PI)
      emitRot(arch, 0, 1.8, 0, postColor)
      // Chevron lattice: 3 diagonal crossbars left + right
      for (let ci = 0; ci < 3; ci++) {
        const y = 0.4 + ci * 0.35
        const bar = new THREE.BoxGeometry(1.0, 0.03, 0.03)
        bar.rotateZ(0.25 * (ci % 2 === 0 ? 1 : -1))
        emitRot(bar, 0, y, 0, postColor)
      }
      // Vine canopy: flattened sphere over the arch
      const vine = new THREE.SphereGeometry(0.5, 7, 5)
      vine.scale(1.2, 0.55, 0.6)
      emitRot(vine, 0, 1.95, 0, vineColor)
      // Small flower dots on the vine
      for (let fi = 0; fi < 5; fi++) {
        const ang = (fi / 5) * Math.PI * 2
        const flower = new THREE.SphereGeometry(0.07, 5, 4)
        emitRot(flower, Math.cos(ang) * 0.45, 1.98 + Math.sin(fi * 1.3) * 0.08, Math.sin(ang) * 0.25, flowerColor)
      }

    } else if (id === 'flower_bed') {
      // Garden prop — wide low planter filled with multi-colored flowers
      // and small mounded foliage. fp 2×1 typical.
      const boxW = fp.w * 0.9
      const boxD = fp.h * 0.9
      emitRot(new THREE.BoxGeometry(boxW, 0.22, boxD), 0, 0.11, 0, 0x6a4a28)
      // Dirt top
      emitRot(new THREE.BoxGeometry(boxW * 0.95, 0.03, boxD * 0.95), 0, 0.22, 0, 0x5a3828)
      // Foliage mounds + flower dots in a grid
      const flowerColors = [0xc03050, 0xe0a030, 0xe070b0, 0x8040b0, 0xe0e060]
      const cols = Math.max(3, Math.floor(boxW * 2.5))
      const rows = Math.max(1, Math.floor(boxD * 1.8))
      for (let ri = 0; ri < rows; ri++) {
        for (let ci = 0; ci < cols; ci++) {
          const dx = ((ci + 0.5) / cols - 0.5) * boxW * 0.85
          const dz = ((ri + 0.5) / rows - 0.5) * boxD * 0.85
          const foliage = new THREE.SphereGeometry(0.11, 5, 4)
          foliage.scale(1, 0.7, 1)
          emitRot(foliage, dx, 0.28, dz, 0x3a7a2a)
          // Alternating flower buds on top
          if ((ri * cols + ci + hash) % 2 === 0) {
            const bud = new THREE.SphereGeometry(0.06, 5, 4)
            emitRot(bud, dx, 0.36, dz, flowerColors[(ri * cols + ci + hash) % flowerColors.length])
          }
        }
      }

    } else {
      // Fallback — colored box
      const color = id === 'bridge' ? 0x8b7355 : 0x808080
      const b = geo.boxGeo.clone()
      b.scale(fp.w * 0.8, h, fp.h * 0.8)
      b.translate(px, elev + h / 2, pz)
      batch.addPositioned(b, color)
    }

    // HOW BIG DID THAT ACTUALLY COME OUT?
    //
    // Nothing measured props. humanscale.mjs grades buildings against what a
    // building measures in the real world; a boulder had no such check, and
    // the ones dressWaterfront started placing came out five metres across —
    // wider than a row house — because their geometry sizes itself off the
    // FOOTPRINT, which is in metres now and was in tiles when they were
    // written. They had never been drawn before, so the rescale swept past
    // them: content with no way in cannot be caught by looking at the screen.
    recordPropSize(id, batch.boundsSince(_auditFrom), elev)
    setBuildEnvelope(null)
  }

  setBuildEnvelope(null)
  // Build the single merged mesh
  const batched: THREE.Mesh[] = []
  const merged = batch.build()
  if (merged) batched.push(merged)

  // Merge all emissive lamp-bulb geometries into a single mesh sharing
  // _lampEmissiveMat — one draw call for every bulb in the town instead
  // of one per bulb. Receives/casts no shadows (emissive, thin, and tiny).
  // Beacons emitted by the BUILDING pass this load — see Beacons.ts for why
  // that array does not live in this file.
  lampEmissiveGeos.push(...takeBeacons())
  if (lampEmissiveGeos.length > 0) {
    let mergedEm: THREE.BufferGeometry | null
    if (lampEmissiveGeos.length === 1) {
      mergedEm = lampEmissiveGeos[0]
    } else {
      mergedEm = mergeGeometries(lampEmissiveGeos, false)
      // mergeGeometries copies attribute data; the inputs are no longer
      // referenced by anything, so free their GPU buffers.
      for (const g of lampEmissiveGeos) g.dispose()
    }
    if (mergedEm) {
      mergedEm.computeVertexNormals()
      const bulbs = new THREE.Mesh(mergedEm, _lampEmissiveMat)
      bulbs.matrixAutoUpdate = false
      bulbs.updateMatrix()
      bulbs.castShadow = false
      bulbs.receiveShadow = false
      batched.push(bulbs)
    }
  }

  // All ground light pools as a single mesh sharing _lampPoolMat, so
  // setLampPoolOpacity still dims every pool at once from updateLighting
  // but the whole town's pools cost one draw call rather than one each.
  if (lampPoolGeos.length > 0) {
    const mergedPools = lampPoolGeos.length === 1
      ? lampPoolGeos[0]
      : mergeGeometries(lampPoolGeos, false)
    if (lampPoolGeos.length > 1) for (const g of lampPoolGeos) g.dispose()
    if (mergedPools) {
      const pools = new THREE.Mesh(mergedPools, _lampPoolMat)
      pools.matrixAutoUpdate = false
      pools.updateMatrix()
      pools.castShadow = false
      pools.receiveShadow = false
      pools.renderOrder = 2 // after opaque ground so the additive blend shows
      batched.push(pools)
    }
  }

  return { batched, lampposts }
}
