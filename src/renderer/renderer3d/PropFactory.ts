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
        // Wine cask laid on its side with end hoops
        const body = new THREE.CylinderGeometry(0.26, 0.26, 0.55, 8)
        body.rotateZ(Math.PI / 2)
        body.translate(px, elev + 0.28, pz)
        batch.addPositioned(body, 0x7a5030)
        for (const ex of [-0.22, 0.22]) {
          const hoop = new THREE.TorusGeometry(0.26, 0.02, 3, 8)
          hoop.rotateY(Math.PI / 2)
          hoop.translate(px + ex, elev + 0.28, pz)
          batch.addPositioned(hoop, 0x2a2a2a)
        }
        // Small wooden chock beneath (stops it rolling)
        const chock = new THREE.BoxGeometry(0.35, 0.04, 0.2)
        chock.translate(px, elev + 0.02, pz)
        batch.addPositioned(chock, 0x5a3a20)
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
      // wooden backless with end arms.
      const bv = hash % 3
      if (bv === 0) {
        const seat = new THREE.BoxGeometry(0.9, 0.04, 0.3)
        seat.translate(px, elev + 0.35, pz)
        batch.addPositioned(seat, 0x6a4a28)
        const back = new THREE.BoxGeometry(0.9, 0.35, 0.03)
        back.translate(px, elev + 0.55, pz - 0.13)
        batch.addPositioned(back, 0x6a4a28)
        for (const lx of [-0.38, 0.38]) {
          const leg = new THREE.BoxGeometry(0.07, 0.33, 0.28)
          leg.translate(px + lx, elev + 0.17, pz)
          batch.addPositioned(leg, 0x5a3a1a)
        }
      } else if (bv === 1) {
        // Stone slab bench — two stone supports + thick slab
        const slab = new THREE.BoxGeometry(1.0, 0.1, 0.35)
        slab.translate(px, elev + 0.35, pz)
        batch.addPositioned(slab, 0x8a847a)
        for (const lx of [-0.38, 0.38]) {
          const leg = new THREE.BoxGeometry(0.18, 0.3, 0.3)
          leg.translate(px + lx, elev + 0.15, pz)
          batch.addPositioned(leg, 0x7a7468)
        }
      } else {
        // Wooden backless with end arm rests
        const seat = new THREE.BoxGeometry(0.9, 0.05, 0.3)
        seat.translate(px, elev + 0.4, pz)
        batch.addPositioned(seat, 0x7a5a30)
        for (const lx of [-0.43, 0.43]) {
          const arm = new THREE.BoxGeometry(0.06, 0.15, 0.32)
          arm.translate(px + lx, elev + 0.5, pz)
          batch.addPositioned(arm, 0x5a3a1a)
          const leg = new THREE.BoxGeometry(0.06, 0.4, 0.3)
          leg.translate(px + lx, elev + 0.2, pz)
          batch.addPositioned(leg, 0x5a3a1a)
        }
      }

    } else if (id === 'market_stall') {
      // Hash-pick one of four distinct stall silhouettes.
      const variant = hash % 4
      if (variant === 0) {
        // Classic canopy stall: counter + tall front poles + striped canopy
        const canopyColors = [0xcc3333, 0x3366aa, 0xcc9933, 0x339966]
        const table = new THREE.BoxGeometry(1.8, 0.08, 0.9)
        table.translate(px, elev + 0.8, pz)
        batch.addPositioned(table, 0x7a5a30)
        for (const [lx, lz] of [[-0.75, -0.35], [0.75, -0.35], [-0.75, 0.35], [0.75, 0.35]] as const) {
          const leg = new THREE.BoxGeometry(0.07, 0.8, 0.07)
          leg.translate(px + lx, elev + 0.4, pz + lz)
          batch.addPositioned(leg, 0x7a5a30)
        }
        for (const lx of [-0.8, 0.8]) {
          const pole = new THREE.CylinderGeometry(0.04, 0.04, 1.2, 4)
          pole.translate(px + lx, elev + 1.4, pz + 0.4)
          batch.addPositioned(pole, 0x7a5a30)
        }
        const canopy = new THREE.PlaneGeometry(2.0, 1.2)
        canopy.rotateX(-0.25)
        canopy.translate(px, elev + 1.9, pz + 0.1)
        batch.addPositioned(canopy, canopyColors[(hash >> 2) % canopyColors.length])
        // Stripe under the canopy for visual interest
        const stripe = new THREE.PlaneGeometry(2.0, 0.15)
        stripe.rotateX(-0.25)
        stripe.translate(px, elev + 1.62, pz + 0.1)
        batch.addPositioned(stripe, 0xf0f0e0)
      } else if (variant === 1) {
        // Fruit cart: long narrow cart on large wheels, produce piles on top
        const bed = new THREE.BoxGeometry(1.6, 0.12, 0.7)
        bed.translate(px, elev + 0.55, pz)
        batch.addPositioned(bed, 0x7a5030)
        // Sides (open crates)
        for (const sz of [-0.3, 0.3]) {
          const side = new THREE.BoxGeometry(1.6, 0.18, 0.04)
          side.translate(px, elev + 0.7, pz + sz)
          batch.addPositioned(side, 0x5a3820)
        }
        // Big cart wheels
        for (const wx of [-0.55, 0.55]) {
          const wheel = new THREE.CylinderGeometry(0.26, 0.26, 0.06, 8)
          wheel.rotateX(Math.PI / 2)
          wheel.translate(px + wx, elev + 0.26, pz + 0.35)
          batch.addPositioned(wheel, 0x3a2a1a)
          const wheel2 = new THREE.CylinderGeometry(0.26, 0.26, 0.06, 8)
          wheel2.rotateX(Math.PI / 2)
          wheel2.translate(px + wx, elev + 0.26, pz - 0.35)
          batch.addPositioned(wheel2, 0x3a2a1a)
        }
        // Produce mounds: three colored hemispheres
        const produceColors = [0xc04020, 0xb07030, 0xa09040, 0x805030]
        for (let pi = 0; pi < 3; pi++) {
          const mound = new THREE.SphereGeometry(0.18, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2)
          mound.translate(px - 0.5 + pi * 0.5, elev + 0.68, pz + ((hash >> pi) & 1) * 0.15 - 0.05)
          batch.addPositioned(mound, produceColors[(hash + pi) % produceColors.length])
        }
        // Handle bar at one end
        const handle = new THREE.BoxGeometry(0.05, 0.05, 0.9)
        handle.translate(px + 0.9, elev + 0.55, pz)
        batch.addPositioned(handle, 0x5a3820)
      } else if (variant === 2) {
        // Tool stall: anvil + iron rack behind a counter
        const counter = new THREE.BoxGeometry(1.5, 0.65, 0.6)
        counter.translate(px, elev + 0.33, pz)
        batch.addPositioned(counter, 0x6a4a2a)
        // Anvil on top
        const anvil = new THREE.BoxGeometry(0.45, 0.15, 0.2)
        anvil.translate(px - 0.3, elev + 0.73, pz)
        batch.addPositioned(anvil, 0x3a3a3a)
        const anvilTop = new THREE.BoxGeometry(0.6, 0.08, 0.22)
        anvilTop.translate(px - 0.3, elev + 0.83, pz)
        batch.addPositioned(anvilTop, 0x2a2a2a)
        // Iron tool rack: vertical posts + crossbar + hanging tool shapes
        for (const lx of [-0.6, 0.6]) {
          const post = new THREE.BoxGeometry(0.06, 1.6, 0.06)
          post.translate(px + lx, elev + 0.8, pz - 0.35)
          batch.addPositioned(post, 0x4a3a28)
        }
        const crossbar = new THREE.BoxGeometry(1.4, 0.06, 0.06)
        crossbar.translate(px, elev + 1.5, pz - 0.35)
        batch.addPositioned(crossbar, 0x4a3a28)
        for (let ti = 0; ti < 4; ti++) {
          const tool = new THREE.BoxGeometry(0.06, 0.45 + (ti % 2) * 0.15, 0.03)
          tool.translate(px - 0.55 + ti * 0.38, elev + 1.2, pz - 0.34)
          batch.addPositioned(tool, 0x2a2a2a)
        }
      } else {
        // Striped booth: tall narrow booth with a peaked roof
        const counter = new THREE.BoxGeometry(1.2, 0.6, 0.9)
        counter.translate(px, elev + 0.3, pz)
        batch.addPositioned(counter, 0x8a6a3a)
        for (const lx of [-0.55, 0.55]) {
          const post = new THREE.BoxGeometry(0.06, 1.8, 0.06)
          post.translate(px + lx, elev + 0.9, pz)
          batch.addPositioned(post, 0x5a3a20)
        }
        // Peaked roof — two tilted planes
        const roofColor = [0xa03030, 0x306aa0, 0x6a9a40][hash % 3]
        for (const side of [-1, 1]) {
          const slab = new THREE.PlaneGeometry(1.5, 0.8)
          slab.rotateX(0.4 * side)
          slab.translate(px, elev + 1.9, pz + side * 0.18)
          batch.addPositioned(slab, roofColor)
        }
        // Stripe band under the roof
        const band = new THREE.BoxGeometry(1.3, 0.12, 0.08)
        band.translate(px, elev + 1.65, pz)
        batch.addPositioned(band, 0xf0e8d0)
      }

    } else if (id === 'statue' || id === 'column' || id === 'monument') {
      // Five statue silhouettes chosen by id + hash.
      //   column     → columns (fluted column shape w/ capital + base)
      //   monument   → obelisk (tall pyramid-capped pillar)
      //   statue     → hash picks equestrian / figure / urn / orb
      if (id === 'column') {
        const base = new THREE.BoxGeometry(0.4, 0.12, 0.4)
        base.translate(px, elev + 0.06, pz)
        batch.addPositioned(base, 0xaaa29a)
        const shaft = new THREE.CylinderGeometry(0.09, 0.12, 1.6, 6)
        shaft.translate(px, elev + 0.92, pz)
        batch.addPositioned(shaft, 0xbab2aa)
        // Capital (wider block at top)
        const cap = new THREE.BoxGeometry(0.32, 0.12, 0.32)
        cap.translate(px, elev + 1.78, pz)
        batch.addPositioned(cap, 0xaaa29a)
        const capTop = new THREE.BoxGeometry(0.38, 0.06, 0.38)
        capTop.translate(px, elev + 1.87, pz)
        batch.addPositioned(capTop, 0xaaa29a)
      } else if (id === 'monument') {
        // Obelisk: square plinth → tall tapered column → pyramid cap
        const plinth = new THREE.BoxGeometry(0.7, 0.22, 0.7)
        plinth.translate(px, elev + 0.11, pz)
        batch.addPositioned(plinth, 0x9a9288)
        const shaft = new THREE.CylinderGeometry(0.12, 0.22, 2.0, 4)
        shaft.rotateY(Math.PI / 4)
        shaft.translate(px, elev + 1.22, pz)
        batch.addPositioned(shaft, 0xbab2a8)
        const pyramid = new THREE.ConeGeometry(0.2, 0.35, 4)
        pyramid.rotateY(Math.PI / 4)
        pyramid.translate(px, elev + 2.4, pz)
        batch.addPositioned(pyramid, 0xbab2a8)
      } else {
        const statueVariant = hash % 4
        const ped = new THREE.BoxGeometry(0.55, 0.55, 0.55)
        ped.translate(px, elev + 0.275, pz)
        batch.addPositioned(ped, 0x9a9288)
        if (statueVariant === 0) {
          // Equestrian: horse body + rider
          const horseBody = new THREE.BoxGeometry(0.55, 0.28, 0.2)
          horseBody.translate(px, elev + 0.75, pz)
          batch.addPositioned(horseBody, 0xbab2a8)
          const horseHead = new THREE.BoxGeometry(0.18, 0.24, 0.14)
          horseHead.translate(px + 0.25, elev + 0.95, pz)
          batch.addPositioned(horseHead, 0xbab2a8)
          // Legs (4 small blocks)
          for (const [lx, lz] of [[-0.22, -0.07], [0.22, -0.07], [-0.22, 0.07], [0.22, 0.07]] as const) {
            const leg = new THREE.BoxGeometry(0.06, 0.22, 0.06)
            leg.translate(px + lx, elev + 0.65, pz + lz)
            batch.addPositioned(leg, 0xbab2a8)
          }
          // Rider torso
          const torso = new THREE.BoxGeometry(0.18, 0.3, 0.15)
          torso.translate(px + 0.02, elev + 1.1, pz)
          batch.addPositioned(torso, 0xbab2a8)
          const head = new THREE.SphereGeometry(0.1, 6, 5)
          head.translate(px + 0.02, elev + 1.32, pz)
          batch.addPositioned(head, 0xbab2a8)
        } else if (statueVariant === 1) {
          // Standing figure: humanoid silhouette
          const torso = new THREE.BoxGeometry(0.24, 0.5, 0.18)
          torso.translate(px, elev + 0.85, pz)
          batch.addPositioned(torso, 0xbab2a8)
          const head = new THREE.SphereGeometry(0.11, 6, 5)
          head.translate(px, elev + 1.2, pz)
          batch.addPositioned(head, 0xbab2a8)
          // Arm hanging
          const arm = new THREE.BoxGeometry(0.08, 0.42, 0.08)
          arm.translate(px + 0.18, elev + 0.85, pz)
          batch.addPositioned(arm, 0xbab2a8)
          // Legs (two slim rectangles merged)
          const legs = new THREE.BoxGeometry(0.22, 0.2, 0.16)
          legs.translate(px, elev + 0.67, pz)
          batch.addPositioned(legs, 0xbab2a8)
        } else if (statueVariant === 2) {
          // Urn on pedestal
          const urnBase = new THREE.CylinderGeometry(0.12, 0.18, 0.15, 8)
          urnBase.translate(px, elev + 0.63, pz)
          batch.addPositioned(urnBase, 0xbab2a8)
          const urnBody = new THREE.SphereGeometry(0.22, 7, 6)
          urnBody.scale(1.0, 0.85, 1.0)
          urnBody.translate(px, elev + 0.88, pz)
          batch.addPositioned(urnBody, 0xbab2a8)
          const urnNeck = new THREE.CylinderGeometry(0.12, 0.16, 0.12, 8)
          urnNeck.translate(px, elev + 1.1, pz)
          batch.addPositioned(urnNeck, 0xbab2a8)
          const urnRim = new THREE.CylinderGeometry(0.18, 0.14, 0.05, 8)
          urnRim.translate(px, elev + 1.18, pz)
          batch.addPositioned(urnRim, 0xbab2a8)
        } else {
          // Orb on column
          const shaft = new THREE.CylinderGeometry(0.1, 0.13, 0.9, 6)
          shaft.translate(px, elev + 1.0, pz)
          batch.addPositioned(shaft, 0xbab2a8)
          const orb = new THREE.SphereGeometry(0.22, 7, 6)
          orb.translate(px, elev + 1.58, pz)
          batch.addPositioned(orb, 0xbab2a8)
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
        // Ornate hanging sign — bracket arm + two chains + swinging board + finial
        const arm = new THREE.BoxGeometry(0.5, 0.05, 0.05)
        arm.translate(px + 0.25, elev + 1.5, pz)
        batch.addPositioned(arm, 0x4a3a20)
        // Tiny finial curl at end of arm
        const finial = new THREE.SphereGeometry(0.05, 5, 4)
        finial.translate(px + 0.5, elev + 1.5, pz)
        batch.addPositioned(finial, 0x4a3a20)
        for (const cx of [0.15, 0.4]) {
          const chain = new THREE.BoxGeometry(0.02, 0.25, 0.02)
          chain.translate(px + cx, elev + 1.35, pz)
          batch.addPositioned(chain, 0x2a2a2a)
        }
        const board = new THREE.BoxGeometry(0.5, 0.35, 0.04)
        board.translate(px + 0.28, elev + 1.05, pz)
        batch.addPositioned(board, boardColor)
        // Board frame border (darker thin outline)
        const frame = new THREE.BoxGeometry(0.54, 0.39, 0.025)
        frame.translate(px + 0.28, elev + 1.05, pz - 0.01)
        batch.addPositioned(frame, 0x3a2818)
      } else if (sv === 1) {
        // Post-mounted shingle sign on two small posts
        for (const lx of [-0.22, 0.22]) {
          const post = new THREE.BoxGeometry(0.06, 1.3, 0.06)
          post.translate(px + lx, elev + 0.65, pz)
          batch.addPositioned(post, 0x5a4020)
        }
        const shingle = new THREE.BoxGeometry(0.6, 0.3, 0.04)
        shingle.translate(px, elev + 1.0, pz)
        batch.addPositioned(shingle, boardColor)
        // Decorative topper (small cone)
        const topper = new THREE.ConeGeometry(0.08, 0.12, 4)
        topper.translate(px, elev + 1.22, pz)
        batch.addPositioned(topper, 0x5a4020)
      } else {
        // A-frame chalkboard sign (two boards hinged)
        for (const side of [-1, 1]) {
          const board = new THREE.BoxGeometry(0.5, 0.7, 0.04)
          board.rotateX(side * 0.3)
          board.translate(px, elev + 0.4, pz + side * 0.1)
          batch.addPositioned(board, boardColor)
        }
        // Frame edge along the top ridge
        const ridge = new THREE.BoxGeometry(0.5, 0.04, 0.04)
        ridge.translate(px, elev + 0.7, pz)
        batch.addPositioned(ridge, 0x3a2818)
      }

    } else if (id === 'wagon' || id === 'cart') {
      // Three wagon variants: heavy market wagon, covered wagon, small cart.
      const wv = hash % 3
      if (wv === 0) {
        // Heavy market wagon — plank bed + 4 spoked wheels + side rails + load
        const bed = new THREE.BoxGeometry(1.4, 0.08, 0.7)
        bed.translate(px, elev + 0.42, pz)
        batch.addPositioned(bed, 0x6a5030)
        for (const sz of [-0.35, 0.35]) {
          const rail = new THREE.BoxGeometry(1.4, 0.25, 0.04)
          rail.translate(px, elev + 0.57, pz + sz)
          batch.addPositioned(rail, 0x6a5030)
        }
        for (const [wx, wz] of [[-0.5, -0.4], [0.5, -0.4], [-0.5, 0.4], [0.5, 0.4]] as const) {
          const wheel = new THREE.CylinderGeometry(0.24, 0.24, 0.06, 8)
          wheel.rotateX(Math.PI / 2)
          wheel.translate(px + wx, elev + 0.24, pz + wz)
          batch.addPositioned(wheel, 0x3a2818)
          // Spoke cross (two thin boxes as spokes)
          for (let sp = 0; sp < 2; sp++) {
            const spoke = new THREE.BoxGeometry(0.03, 0.42, 0.03)
            spoke.rotateZ(sp * Math.PI / 2)
            spoke.translate(px + wx, elev + 0.24, pz + wz)
            batch.addPositioned(spoke, 0x5a4028)
          }
        }
        // Crate/sack load on top
        const load = new THREE.BoxGeometry(0.8, 0.35, 0.5)
        load.translate(px, elev + 0.64, pz)
        batch.addPositioned(load, 0x8a6a3a)
      } else if (wv === 1) {
        // Covered wagon — wagon bed + arched cloth cover
        const bed = new THREE.BoxGeometry(1.3, 0.08, 0.65)
        bed.translate(px, elev + 0.38, pz)
        batch.addPositioned(bed, 0x6a5030)
        for (const [wx, wz] of [[-0.45, -0.35], [0.45, -0.35], [-0.45, 0.35], [0.45, 0.35]] as const) {
          const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 8)
          wheel.rotateX(Math.PI / 2)
          wheel.translate(px + wx, elev + 0.2, pz + wz)
          batch.addPositioned(wheel, 0x3a2818)
        }
        // Arched cover (simulated with a half-cylinder rotated)
        const cover = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 8, 1, false, 0, Math.PI)
        cover.rotateZ(Math.PI / 2)
        cover.translate(px, elev + 0.82, pz)
        batch.addPositioned(cover, 0xd8c8a0)
        // Cover ribs (thin bands for structure)
        for (let ri = 0; ri < 3; ri++) {
          const rib = new THREE.TorusGeometry(0.4, 0.02, 3, 8, Math.PI)
          rib.rotateZ(Math.PI / 2)
          rib.rotateY(Math.PI / 2)
          rib.translate(px + (ri - 1) * 0.45, elev + 0.82, pz)
          batch.addPositioned(rib, 0x8a7a50)
        }
      } else {
        // Small hand cart — 2 wheels, open bed, long handle
        const bed = new THREE.BoxGeometry(0.9, 0.08, 0.5)
        bed.translate(px, elev + 0.32, pz)
        batch.addPositioned(bed, 0x6a5030)
        for (const sz of [-0.27, 0.27]) {
          const rail = new THREE.BoxGeometry(0.9, 0.18, 0.03)
          rail.translate(px, elev + 0.45, pz + sz)
          batch.addPositioned(rail, 0x6a5030)
        }
        for (const wx of [-0.35, 0.35]) {
          const wheel = new THREE.CylinderGeometry(0.2, 0.2, 0.04, 8)
          wheel.rotateX(Math.PI / 2)
          wheel.translate(px + wx, elev + 0.2, pz + 0.3)
          batch.addPositioned(wheel, 0x3a2818)
        }
        // Long handle sticking out front
        const handle = new THREE.BoxGeometry(0.04, 0.04, 0.75)
        handle.translate(px, elev + 0.35, pz - 0.5)
        batch.addPositioned(handle, 0x5a3820)
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
      // Four gravestone silhouettes by hash so cemeteries feel varied.
      const gv = hash % 4
      const stoneColor = 0x747066
      if (gv === 0) {
        // Classic slab with rounded top (dome cap)
        const slab = new THREE.BoxGeometry(0.3, 0.5, 0.08)
        slab.translate(px, elev + 0.25, pz)
        batch.addPositioned(slab, stoneColor)
        const dome = new THREE.SphereGeometry(0.15, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2)
        dome.scale(1.0, 0.7, 0.55)
        dome.translate(px, elev + 0.5, pz)
        batch.addPositioned(dome, stoneColor)
      } else if (gv === 1) {
        // Stone cross
        const vert = new THREE.BoxGeometry(0.1, 0.7, 0.1)
        vert.translate(px, elev + 0.35, pz)
        batch.addPositioned(vert, stoneColor)
        const horiz = new THREE.BoxGeometry(0.36, 0.1, 0.1)
        horiz.translate(px, elev + 0.55, pz)
        batch.addPositioned(horiz, stoneColor)
        // Small plinth
        const base = new THREE.BoxGeometry(0.28, 0.08, 0.2)
        base.translate(px, elev + 0.04, pz)
        batch.addPositioned(base, stoneColor)
      } else if (gv === 2) {
        // Urn-topped pedestal
        const plinth = new THREE.BoxGeometry(0.28, 0.5, 0.24)
        plinth.translate(px, elev + 0.25, pz)
        batch.addPositioned(plinth, stoneColor)
        const urn = new THREE.SphereGeometry(0.14, 6, 5)
        urn.scale(1.0, 0.9, 1.0)
        urn.translate(px, elev + 0.6, pz)
        batch.addPositioned(urn, stoneColor)
      } else {
        // Leaning slab (tilted) — the disturbed grave
        const tiltSign = (hash >> 2) & 1 ? 1 : -1
        const slab = new THREE.BoxGeometry(0.3, 0.5, 0.08)
        slab.rotateZ(0.18 * tiltSign)
        slab.translate(px, elev + 0.22, pz)
        batch.addPositioned(slab, stoneColor)
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
