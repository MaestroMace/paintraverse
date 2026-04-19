/**
 * Prop Factory v3: Batched Props
 *
 * All props are merged into batched meshes by color.
 * Only lampposts remain individual (emissive material + point lights).
 * ~1,900 draw calls → ~20
 */

import * as THREE from 'three'
import type { ObjectDefinition, PlacedObject } from '../core/types'
import { BatchedMeshBuilder } from './BatchedMeshBuilder'

const PROP_HEIGHTS: Record<string, number> = {
  tree: 2.5, bush: 0.8, lamppost: 2.2, bench: 0.5, fountain: 1.5,
  fence: 0.6, well: 1.0, barrel: 0.7, crate: 0.5, market_stall: 1.8,
  statue: 2.0, potted_plant: 0.6, wagon: 1.0, stone_wall: 1.2,
  gravestone: 0.7, windmill: 3.5, bridge: 0.8,
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
function buildLampPoolTexture(): THREE.CanvasTexture {
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

const _lampPoolTex = buildLampPoolTexture()
const _lampPoolMat = new THREE.SpriteMaterial({
  color: 0xffb060,
  map: _lampPoolTex,
  transparent: true,
  opacity: 0,
  fog: false,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
})
export function setLampPoolOpacity(opacity: number): void {
  _lampPoolMat.opacity = opacity
}

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

function simpleHash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Deterministic 0..1 pseudo-random from an integer hash and a salt. */
function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
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
  const batch = new BatchedMeshBuilder()
  const lampposts: THREE.Object3D[] = []
  let pointLightCount = 0

  for (const obj of objects) {
    const def = defMap.get(obj.definitionId)
    const id = obj.definitionId
    const h = PROP_HEIGHTS[id] ?? 0.6
    const fp = def?.footprint || { w: 1, h: 1 }
    const px = obj.x + fp.w / 2, pz = obj.y + fp.h / 2
    // Sample terrain across all footprint tiles; use the max so props on
    // sloped ground sit at the highest point they cover. Ignore
    // obj.elevation when getHeight is available (generator stored it in raw
    // heightMap units, not world units, and adding them double-counts).
    let terrainH = 0
    if (getHeight) {
      for (let fy = 0; fy < fp.h; fy++) {
        for (let fx = 0; fx < fp.w; fx++) {
          const th = getHeight(obj.x + fx, obj.y + fy)
          if (th > terrainH) terrainH = th
        }
      }
    }
    const elev = getHeight ? terrainH : (obj.elevation || 0)
    const hash = simpleHash(obj.id)

    // Per-prop Y rotation. The generator can set obj.properties.facingY
    // (radians) to give the prop a *meaningful* orientation — face the
    // plaza fountain, run perpendicular to the adjacent road, turn its
    // back to the building behind it. When that hint is missing we
    // fall back to a hash-random angle so unfacing-aware prop streams
    // (countryside scatter, etc.) still don't all point at world +Z.
    // Y-symmetric props (fountains, wells) always pin to 0.
    const isSingleTile = fp.w === 1 && fp.h === 1
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
    const emitRot = (g: THREE.BufferGeometry, dx: number, dy: number, dz: number, color: number) => {
      g.translate(dx, dy, dz)
      if (propRot !== 0) g.rotateY(propRot)
      g.translate(px, elev, pz)
      batch.addPositioned(g, color)
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
      const heightJitter = 0.85 + ((hash >> 3) % 30) / 100  // 0.85–1.15
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

    } else if (id === 'bush' || id === 'hedge') {
      const b = geo.bushGeo.clone()
      b.scale(1.3, 1.3, 1.3)
      b.translate(px, elev + 0.4, pz)
      batch.addPositioned(b, 0x3a7a33)

    } else if (id === 'lamppost' || id === 'wall_lantern' || id === 'street_lamp_double' || id === 'double_lamp') {
      // Lampposts stay individual — emissive material + point lights.
      // Four silhouette variants by id + hash:
      //   - 'street_lamp_double'/'double_lamp': ornate tall post with
      //     two side arms, each carrying a lamp
      //   - 'wall_lantern': hanging lantern with small decorative top
      //   - 'lamppost' with hash%3===0: ornate ceremonial pillar with
      //     wider stepped base + faceted lamp housing on top
      //   - 'lamppost' default: classic tall thin pole with round lamp
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const poleMat = new THREE.MeshLambertMaterial({ color: 0x222222, flatShading: true })
      const lampMat = new THREE.MeshLambertMaterial({
        color: 0xffcc44, emissive: 0xffaa22, emissiveIntensity: 0.8,
      })

      if (id === 'street_lamp_double' || id === 'double_lamp') {
        // Central tall pole + crossbar + two hanging lamps
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.055, 0.08, h + 0.25, 5), poleMat,
        )
        pole.position.y = (h + 0.25) / 2
        group.add(pole)
        const crossbar = new THREE.Mesh(
          new THREE.BoxGeometry(0.65, 0.05, 0.05), poleMat,
        )
        crossbar.position.y = h + 0.15
        group.add(crossbar)
        for (const side of [-1, 1]) {
          const hang = new THREE.Mesh(
            new THREE.CylinderGeometry(0.02, 0.02, 0.12, 4), poleMat,
          )
          hang.position.set(side * 0.3, h + 0.04, 0)
          group.add(hang)
          const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.22, 0.18), lampMat)
          lamp.position.set(side * 0.3, h - 0.1, 0)
          group.add(lamp)
          if (pointLightCount < MAX_POINT_LIGHTS) {
            const light = new THREE.PointLight(0xffcc66, 0.6, 7, 1.5)
            light.position.set(side * 0.3, h - 0.1, 0)
            group.add(light)
            pointLightCount++
          }
        }
      } else if (id === 'wall_lantern') {
        // Bracket from wall + small boxy lantern with peaked top
        const bracket = new THREE.Mesh(
          new THREE.BoxGeometry(0.35, 0.04, 0.05), poleMat,
        )
        bracket.position.set(0.17, h * 0.9, 0)
        group.add(bracket)
        const lantern = new THREE.Mesh(
          new THREE.BoxGeometry(0.16, 0.22, 0.16), lampMat,
        )
        lantern.position.set(0.32, h * 0.9 - 0.1, 0)
        group.add(lantern)
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.1, 4), poleMat)
        cap.position.set(0.32, h * 0.9 + 0.06, 0)
        group.add(cap)
        if (pointLightCount < MAX_POINT_LIGHTS) {
          const light = new THREE.PointLight(0xffcc66, 0.7, 6, 1.5)
          light.position.set(0.32, h * 0.9 - 0.1, 0)
          group.add(light)
          pointLightCount++
        }
      } else if (hash % 3 === 0) {
        // Ornate ceremonial — stepped stone base + pole + faceted lamp housing
        const baseLo = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.15, 0.35), poleMat)
        baseLo.position.y = 0.075
        group.add(baseLo)
        const baseHi = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.1, 0.25), poleMat)
        baseHi.position.y = 0.2
        group.add(baseHi)
        const pole = new THREE.Mesh(
          new THREE.CylinderGeometry(0.06, 0.08, h - 0.25, 6), poleMat,
        )
        pole.position.y = 0.25 + (h - 0.25) / 2
        group.add(pole)
        const housing = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.15, 0.28, 6), lampMat,
        )
        housing.position.y = h + 0.05
        group.add(housing)
        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.18, 6), poleMat)
        cap.position.y = h + 0.28
        group.add(cap)
        if (pointLightCount < MAX_POINT_LIGHTS) {
          const light = new THREE.PointLight(0xffcc66, 0.9, 9, 1.5)
          light.position.y = h + 0.05
          group.add(light)
          pointLightCount++
        }
      } else {
        // Classic simple lamppost
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, h, 4), poleMat)
        pole.position.y = h / 2
        group.add(pole)
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 4), lampMat)
        lamp.position.y = h
        group.add(lamp)
        if (pointLightCount < MAX_POINT_LIGHTS) {
          const light = new THREE.PointLight(0xffcc66, 0.8, 8, 1.5)
          light.position.y = h
          group.add(light)
          pointLightCount++
        }
      }

      // Soft lamp pool: a billboard sprite with a radial-gradient alpha map.
      // Always faces the camera so the silhouette is a circle (never a
      // visible cone shape). Shared SpriteMaterial so setLampPoolOpacity()
      // dims or lights every pool at once from updateLighting.
      const pool = new THREE.Sprite(_lampPoolMat)
      pool.scale.set(2.2, 2.2, 1)
      pool.position.y = 0.6
      pool.renderOrder = -0.5 // render before opaque geometry so fog blend is fine
      group.add(pool)

      // Rotate the lamppost group so ornate / double-arm / wall-lantern
      // variants face non-axial directions. Simple single-sphere lamps
      // are rotationally symmetric so this is a no-op for them visually.
      group.rotation.y = propRot
      group.traverse(c => { c.matrixAutoUpdate = false; c.updateMatrix() })
      lampposts.push(group)

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
        const body = new THREE.CylinderGeometry(0.2, 0.22, 0.5, 8)
        body.translate(px, elev + 0.25, pz)
        batch.addPositioned(body, 0x6a4a28)
        for (const hy of [0.08, 0.42]) {
          const hoop = new THREE.TorusGeometry(0.22, 0.015, 3, 8)
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
      const num = id === 'crate_stack' ? 3 : 1
      for (let ci = 0; ci < num; ci++) {
        const s = 0.35 - ci * 0.03
        const c = new THREE.BoxGeometry(s, s, s)
        c.translate(px + (ci % 2) * 0.1, elev + ci * 0.33 + s / 2, pz + (ci % 2) * 0.05)
        batch.addPositioned(c, 0x8a7050)
      }

    } else if (id === 'bench') {
      // Three bench variants by hash: wooden with backrest, stone slab,
      // wooden backless with end arms. All rotate with propRot.
      const bv = hash % 3
      if (bv === 0) {
        emitRot(new THREE.BoxGeometry(0.9, 0.04, 0.3), 0, 0.35, 0, 0x6a4a28)
        emitRot(new THREE.BoxGeometry(0.9, 0.35, 0.03), 0, 0.55, -0.13, 0x6a4a28)
        for (const lx of [-0.38, 0.38]) {
          emitRot(new THREE.BoxGeometry(0.07, 0.33, 0.28), lx, 0.17, 0, 0x5a3a1a)
        }
      } else if (bv === 1) {
        emitRot(new THREE.BoxGeometry(1.0, 0.1, 0.35), 0, 0.35, 0, 0x8a847a)
        for (const lx of [-0.38, 0.38]) {
          emitRot(new THREE.BoxGeometry(0.18, 0.3, 0.3), lx, 0.15, 0, 0x7a7468)
        }
      } else {
        emitRot(new THREE.BoxGeometry(0.9, 0.05, 0.3), 0, 0.4, 0, 0x7a5a30)
        for (const lx of [-0.43, 0.43]) {
          emitRot(new THREE.BoxGeometry(0.06, 0.15, 0.32), lx, 0.5, 0, 0x5a3a1a)
          emitRot(new THREE.BoxGeometry(0.06, 0.4, 0.3), lx, 0.2, 0, 0x5a3a1a)
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
        emitRot(new THREE.BoxGeometry(0.55, 0.55, 0.55), 0, 0.275, 0, 0x9a9288)
        if (statueVariant === 0) {
          // Equestrian — the horse faces the propRot direction
          emitRot(new THREE.BoxGeometry(0.55, 0.28, 0.2), 0, 0.75, 0, 0xbab2a8)
          emitRot(new THREE.BoxGeometry(0.18, 0.24, 0.14), 0.25, 0.95, 0, 0xbab2a8)
          for (const [lx, lz] of [[-0.22, -0.07], [0.22, -0.07], [-0.22, 0.07], [0.22, 0.07]] as const) {
            emitRot(new THREE.BoxGeometry(0.06, 0.22, 0.06), lx, 0.65, lz, 0xbab2a8)
          }
          emitRot(new THREE.BoxGeometry(0.18, 0.3, 0.15), 0.02, 1.1, 0, 0xbab2a8)
          emitRot(new THREE.SphereGeometry(0.1, 6, 5), 0.02, 1.32, 0, 0xbab2a8)
        } else if (statueVariant === 1) {
          emitRot(new THREE.BoxGeometry(0.24, 0.5, 0.18), 0, 0.85, 0, 0xbab2a8)
          emitRot(new THREE.SphereGeometry(0.11, 6, 5), 0, 1.2, 0, 0xbab2a8)
          emitRot(new THREE.BoxGeometry(0.08, 0.42, 0.08), 0.18, 0.85, 0, 0xbab2a8)
          emitRot(new THREE.BoxGeometry(0.22, 0.2, 0.16), 0, 0.67, 0, 0xbab2a8)
        } else if (statueVariant === 2) {
          emitRot(new THREE.CylinderGeometry(0.12, 0.18, 0.15, 8), 0, 0.63, 0, 0xbab2a8)
          const urnBody = new THREE.SphereGeometry(0.22, 7, 6)
          urnBody.scale(1.0, 0.85, 1.0)
          emitRot(urnBody, 0, 0.88, 0, 0xbab2a8)
          emitRot(new THREE.CylinderGeometry(0.12, 0.16, 0.12, 8), 0, 1.1, 0, 0xbab2a8)
          emitRot(new THREE.CylinderGeometry(0.18, 0.14, 0.05, 8), 0, 1.18, 0, 0xbab2a8)
        } else {
          emitRot(new THREE.CylinderGeometry(0.1, 0.13, 0.9, 6), 0, 1.0, 0, 0xbab2a8)
          emitRot(new THREE.SphereGeometry(0.22, 7, 6), 0, 1.58, 0, 0xbab2a8)
        }
      }

    } else if (id === 'fence' || id === 'iron_fence' || id === 'stone_wall' || id === 'crenellated_wall' || id === 'picket_fence') {
      const crenellated = id === 'crenellated_wall' || (id === 'stone_wall' && (hash % 3 === 0))
      if (crenellated) {
        // Low crenellated stone wall — body + merlons along the top.
        const body = new THREE.BoxGeometry(fp.w * 0.9, 0.65, 0.22)
        body.translate(px, elev + 0.325, pz)
        batch.addPositioned(body, 0x787268)
        const merlonCount = Math.max(3, Math.floor(fp.w * 2))
        for (let mi = 0; mi < merlonCount; mi++) {
          if (mi % 2 === 0) continue // gaps form the battlement pattern
          const mx = -fp.w * 0.42 + mi * (fp.w * 0.84 / (merlonCount - 1))
          const merlon = new THREE.BoxGeometry(fp.w * 0.84 / (merlonCount - 1) * 0.8, 0.2, 0.22)
          merlon.translate(px + mx, elev + 0.75, pz)
          batch.addPositioned(merlon, 0x787268)
        }
      } else if (id === 'stone_wall') {
        // Stacked rough-stone wall — body + stone course band (darker)
        const body = new THREE.BoxGeometry(fp.w * 0.9, 0.65, 0.22)
        body.translate(px, elev + 0.325, pz)
        batch.addPositioned(body, 0x807a70)
        const cap = new THREE.BoxGeometry(fp.w * 0.95, 0.08, 0.28)
        cap.translate(px, elev + 0.69, pz)
        batch.addPositioned(cap, 0x6a6458)
      } else if (id === 'iron_fence') {
        // Ornate iron fence with posts, rails, finials on posts
        const rail1 = new THREE.BoxGeometry(fp.w * 0.9, 0.04, 0.04)
        rail1.translate(px, elev + 0.15, pz)
        batch.addPositioned(rail1, 0x1a1a1a)
        const rail2 = new THREE.BoxGeometry(fp.w * 0.9, 0.04, 0.04)
        rail2.translate(px, elev + 0.72, pz)
        batch.addPositioned(rail2, 0x1a1a1a)
        const numBars = Math.max(3, Math.floor(fp.w * 3))
        for (let bi = 0; bi < numBars; bi++) {
          const bx = -fp.w * 0.4 + bi * (fp.w * 0.8 / Math.max(1, numBars - 1))
          const bar = new THREE.CylinderGeometry(0.015, 0.015, 0.7, 3)
          bar.translate(px + bx, elev + 0.43, pz)
          batch.addPositioned(bar, 0x1a1a1a)
          // Point finials on every third bar
          if (bi % 3 === 0) {
            const finial = new THREE.ConeGeometry(0.03, 0.1, 4)
            finial.translate(px + bx, elev + 0.82, pz)
            batch.addPositioned(finial, 0x1a1a1a)
          }
        }
        // Posts at the ends (taller, thicker)
        for (const pxSide of [-fp.w * 0.45, fp.w * 0.45]) {
          const post = new THREE.BoxGeometry(0.08, 0.95, 0.08)
          post.translate(px + pxSide, elev + 0.47, pz)
          batch.addPositioned(post, 0x1a1a1a)
          const ball = new THREE.SphereGeometry(0.06, 5, 4)
          ball.translate(px + pxSide, elev + 0.97, pz)
          batch.addPositioned(ball, 0x1a1a1a)
        }
      } else if (id === 'picket_fence') {
        // Picket fence — pointed-top slats with a rail behind them.
        const rail = new THREE.BoxGeometry(fp.w * 0.92, 0.04, 0.04)
        rail.translate(px, elev + 0.35, pz - 0.02)
        batch.addPositioned(rail, 0xd8c8a8)
        const slatCount = Math.max(4, Math.floor(fp.w * 3))
        for (let si = 0; si < slatCount; si++) {
          const sx = -fp.w * 0.42 + si * (fp.w * 0.84 / Math.max(1, slatCount - 1))
          const slat = new THREE.BoxGeometry(0.06, 0.55, 0.03)
          slat.translate(px + sx, elev + 0.275, pz)
          batch.addPositioned(slat, 0xe8d8b8)
          // Pointed cap
          const cap = new THREE.ConeGeometry(0.04, 0.08, 4)
          cap.translate(px + sx, elev + 0.58, pz)
          batch.addPositioned(cap, 0xe8d8b8)
        }
      } else {
        // Classic wooden fence (2 rails + 3 posts)
        for (const ry of [0.2, 0.45]) {
          const r = new THREE.BoxGeometry(fp.w * 0.9, 0.04, 0.03)
          r.translate(px, elev + ry, pz)
          batch.addPositioned(r, 0x6a4a28)
        }
        for (const fx of [-fp.w * 0.4, 0, fp.w * 0.4]) {
          const post = new THREE.BoxGeometry(0.06, 0.55, 0.06)
          post.translate(px + fx, elev + 0.275, pz)
          batch.addPositioned(post, 0x6a4a28)
        }
      }

    } else if (id === 'cafe_table') {
      const top = new THREE.CylinderGeometry(0.3, 0.3, 0.03, 8)
      top.translate(px, elev + 0.55, pz)
      batch.addPositioned(top, 0x8a7a5a)
      const leg = new THREE.CylinderGeometry(0.03, 0.05, 0.55, 4)
      leg.translate(px, elev + 0.275, pz)
      batch.addPositioned(leg, 0x8a7a5a)

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
      // Three wagon variants: heavy market wagon, covered wagon, small cart.
      const wv = hash % 3
      if (wv === 0) {
        emitRot(new THREE.BoxGeometry(1.4, 0.08, 0.7), 0, 0.42, 0, 0x6a5030)
        for (const sz of [-0.35, 0.35]) {
          emitRot(new THREE.BoxGeometry(1.4, 0.25, 0.04), 0, 0.57, sz, 0x6a5030)
        }
        for (const [wx, wz] of [[-0.5, -0.4], [0.5, -0.4], [-0.5, 0.4], [0.5, 0.4]] as const) {
          const wheel = new THREE.CylinderGeometry(0.24, 0.24, 0.06, 8)
          wheel.rotateX(Math.PI / 2)
          emitRot(wheel, wx, 0.24, wz, 0x3a2818)
          for (let sp = 0; sp < 2; sp++) {
            const spoke = new THREE.BoxGeometry(0.03, 0.42, 0.03)
            spoke.rotateZ(sp * Math.PI / 2)
            emitRot(spoke, wx, 0.24, wz, 0x5a4028)
          }
        }
        emitRot(new THREE.BoxGeometry(0.8, 0.35, 0.5), 0, 0.64, 0, 0x8a6a3a)
      } else if (wv === 1) {
        emitRot(new THREE.BoxGeometry(1.3, 0.08, 0.65), 0, 0.38, 0, 0x6a5030)
        for (const [wx, wz] of [[-0.45, -0.35], [0.45, -0.35], [-0.45, 0.35], [0.45, 0.35]] as const) {
          const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 8)
          wheel.rotateX(Math.PI / 2)
          emitRot(wheel, wx, 0.2, wz, 0x3a2818)
        }
        const cover = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 8, 1, false, 0, Math.PI)
        cover.rotateZ(Math.PI / 2)
        emitRot(cover, 0, 0.82, 0, 0xd8c8a0)
        for (let ri = 0; ri < 3; ri++) {
          const rib = new THREE.TorusGeometry(0.4, 0.02, 3, 8, Math.PI)
          rib.rotateZ(Math.PI / 2)
          rib.rotateY(Math.PI / 2)
          emitRot(rib, (ri - 1) * 0.45, 0.82, 0, 0x8a7a50)
        }
      } else {
        emitRot(new THREE.BoxGeometry(0.9, 0.08, 0.5), 0, 0.32, 0, 0x6a5030)
        for (const sz of [-0.27, 0.27]) {
          emitRot(new THREE.BoxGeometry(0.9, 0.18, 0.03), 0, 0.45, sz, 0x6a5030)
        }
        for (const wx of [-0.35, 0.35]) {
          const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.04, 8)
          wheel.rotateX(Math.PI / 2)
          emitRot(wheel, wx, 0.2, 0.3, 0x3a2818)
        }
        emitRot(new THREE.BoxGeometry(0.04, 0.04, 0.75), 0, 0.35, -0.5, 0x5a3820)
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
      const L = longAxisX ? fp.w * 0.85 : fp.h * 0.85
      const W = longAxisX ? fp.h * 0.55 : fp.w * 0.55
      const hullColor = 0x6a4a28
      const plankColor = 0x5a3a20
      const hull = new THREE.BoxGeometry(longAxisX ? L : W, 0.22, longAxisX ? W : L)
      hull.translate(px, elev + 0.15, pz)
      batch.addPositioned(hull, hullColor)
      // Tilted prow plank (front)
      const prow = new THREE.BoxGeometry(longAxisX ? 0.2 : W, 0.3, longAxisX ? W : 0.2)
      prow.rotateZ(longAxisX ? 0.4 : 0)
      prow.rotateX(longAxisX ? 0 : 0.4)
      prow.translate(
        px + (longAxisX ? L / 2 + 0.05 : 0),
        elev + 0.25,
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
          elev + 0.28,
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

    } else if (id === 'tent' || id === 'pavilion') {
      // Peaked cloth tent — pyramidal cone on a square base platform
      const base = new THREE.BoxGeometry(fp.w * 0.85, 0.08, fp.h * 0.85)
      base.translate(px, elev + 0.04, pz)
      batch.addPositioned(base, 0x6a5030)
      // Cone tent top
      const r = Math.max(fp.w, fp.h) * 0.55
      const tent = new THREE.ConeGeometry(r, 1.4, 4)
      tent.rotateY(Math.PI / 4)
      tent.translate(px, elev + 0.78, pz)
      const tentColors = [0xc04040, 0x404080, 0x60803a, 0x805020]
      batch.addPositioned(tent, tentColors[hash % tentColors.length])
      // Flag at the peak
      const flagpole = new THREE.BoxGeometry(0.03, 0.35, 0.03)
      flagpole.translate(px, elev + 1.6, pz)
      batch.addPositioned(flagpole, 0x3a2818)
      const flag = new THREE.PlaneGeometry(0.3, 0.15)
      flag.translate(px + 0.15, elev + 1.7, pz)
      batch.addPositioned(flag, 0xe0e0e0)

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
      const baseSize = Math.max(fp.w, fp.h)
      if (id === 'standing_stone') {
        const stone = new THREE.BoxGeometry(
          baseSize * 0.25, baseSize * 1.4, baseSize * 0.2,
        )
        stone.rotateZ(0.08 * (((hash >> 1) & 1) ? 1 : -1))
        stone.translate(px, elev + baseSize * 0.7, pz)
        batch.addPositioned(stone, 0x7a746a)
      } else {
        // Cluster of 3 boulders at varied positions and heights
        for (let bi = 0; bi < 3; bi++) {
          const angle = (bi / 3) * Math.PI * 2 + hash * 0.3
          const r = baseSize * 0.18
          const boulder = new THREE.SphereGeometry(
            baseSize * (0.22 + ((hash >> (bi * 2)) & 3) * 0.04), 5, 4,
          )
          boulder.scale(1.0, 0.75, 1.0)
          boulder.translate(
            px + Math.cos(angle) * r,
            elev + baseSize * 0.18,
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
      const embers = 0xe04020
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
      emitRot(ember, 0, 0.64, 0, embers)
      // A couple of glow dots on top for floaters/sparks frozen in stone
      for (let i = 0; i < 3; i++) {
        const ang = (i / 3) * Math.PI * 2 + hash
        const glow = new THREE.SphereGeometry(0.05, 5, 4)
        emitRot(glow, Math.cos(ang) * 0.1, 0.72 + i * 0.02, Math.sin(ang) * 0.1, 0xffb060)
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
      const L = longAxisX ? fp.w * 0.9 : fp.h * 0.9
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
  }

  // Build the single merged mesh
  const batched: THREE.Mesh[] = []
  const merged = batch.build()
  if (merged) batched.push(merged)

  return { batched, lampposts }
}
