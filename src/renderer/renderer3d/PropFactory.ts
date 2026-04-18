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
    const terrainH = getHeight ? getHeight(Math.floor(px), Math.floor(pz)) : 0
    const elev = (obj.elevation || 0) + terrainH
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
      // Lampposts stay individual — emissive material + point lights
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const poleMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a, flatShading: true })
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, h, 4), poleMat)
      pole.position.y = h / 2
      group.add(pole)
      const lampMat = new THREE.MeshLambertMaterial({ color: 0xffcc44, emissive: 0xffaa22, emissiveIntensity: 0.8 })
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 4), lampMat)
      lamp.position.y = h
      group.add(lamp)
      if (pointLightCount < MAX_POINT_LIGHTS) {
        const light = new THREE.PointLight(0xffcc66, 0.8, 8, 1.5)
        light.position.y = h
        group.add(light)
        pointLightCount++
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
      const b = new THREE.CylinderGeometry(0.2, 0.22, 0.5, 8)
      b.translate(px, elev + 0.25, pz)
      batch.addPositioned(b, 0x6a4a28)

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
      const seat = new THREE.BoxGeometry(0.9, 0.04, 0.3)
      seat.translate(px, elev + 0.35, pz)
      batch.addPositioned(seat, 0x6a4a28)
      const back = new THREE.BoxGeometry(0.9, 0.35, 0.03)
      back.translate(px, elev + 0.55, pz - 0.13)
      batch.addPositioned(back, 0x6a4a28)

    } else if (id === 'market_stall') {
      // Counter — larger
      const table = new THREE.BoxGeometry(1.8, 0.08, 0.9)
      table.translate(px, elev + 0.8, pz)
      batch.addPositioned(table, 0x7a5a30)
      // Legs
      for (const [lx, lz] of [[-0.75, -0.35], [0.75, -0.35], [-0.75, 0.35], [0.75, 0.35]] as const) {
        const leg = new THREE.BoxGeometry(0.07, 0.8, 0.07)
        leg.translate(px + lx, elev + 0.4, pz + lz)
        batch.addPositioned(leg, 0x7a5a30)
      }
      // Front poles — taller
      for (const lx of [-0.8, 0.8]) {
        const pole = new THREE.CylinderGeometry(0.04, 0.04, 1.2, 4)
        pole.translate(px + lx, elev + 1.4, pz + 0.4)
        batch.addPositioned(pole, 0x7a5a30)
      }
      // Canopy — bigger, more visible
      const canopyColors = [0xcc3333, 0x3366aa, 0xcc9933, 0x339966]
      const canopy = new THREE.PlaneGeometry(2.0, 1.2)
      canopy.rotateX(-0.25)
      canopy.translate(px, elev + 1.9, pz + 0.1)
      batch.addPositioned(canopy, canopyColors[hash % canopyColors.length])

    } else if (id === 'statue' || id === 'column' || id === 'monument') {
      if (id === 'column') {
        const base = new THREE.BoxGeometry(0.35, 0.1, 0.35)
        base.translate(px, elev + 0.05, pz)
        batch.addPositioned(base, 0x9a9a90)
        const shaft = new THREE.CylinderGeometry(0.1, 0.12, 1.5, 6)
        shaft.translate(px, elev + 0.85, pz)
        batch.addPositioned(shaft, 0x9a9a90)
      } else if (id === 'monument') {
        const ped = new THREE.BoxGeometry(0.8, 0.3, 0.8)
        ped.translate(px, elev + 0.15, pz)
        batch.addPositioned(ped, 0x9a9a90)
        const ob = new THREE.CylinderGeometry(0.05, 0.2, 1.5, 4)
        ob.translate(px, elev + 1.05, pz)
        batch.addPositioned(ob, 0x9a9a90)
      } else {
        const ped = new THREE.BoxGeometry(0.5, 0.5, 0.5)
        ped.translate(px, elev + 0.25, pz)
        batch.addPositioned(ped, 0x9a9a90)
        const body = new THREE.CylinderGeometry(0.12, 0.15, 0.8, 5)
        body.translate(px, elev + 0.9, pz)
        batch.addPositioned(body, 0x9a9a90)
      }

    } else if (id === 'fence' || id === 'iron_fence' || id === 'stone_wall') {
      if (id === 'stone_wall') {
        const w = new THREE.BoxGeometry(fp.w * 0.9, 0.8, 0.2)
        w.translate(px, elev + 0.4, pz)
        batch.addPositioned(w, 0x707070)
      } else if (id === 'iron_fence') {
        const rail = new THREE.BoxGeometry(fp.w * 0.9, 0.03, 0.03)
        rail.translate(px, elev + 0.5, pz)
        batch.addPositioned(rail, 0x2a2a2a)
        const numBars = Math.max(3, Math.floor(fp.w * 3))
        for (let bi = 0; bi < numBars; bi++) {
          const bx = -fp.w * 0.4 + bi * (fp.w * 0.8 / (numBars - 1))
          const bar = new THREE.CylinderGeometry(0.012, 0.012, 0.6, 3)
          bar.translate(px + bx, elev + 0.3, pz)
          batch.addPositioned(bar, 0x2a2a2a)
        }
      } else {
        for (const ry of [0.2, 0.45]) {
          const rail = new THREE.BoxGeometry(fp.w * 0.9, 0.04, 0.03)
          rail.translate(px, elev + ry, pz)
          batch.addPositioned(rail, 0x6a4a28)
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
      const bracket = new THREE.BoxGeometry(0.5, 0.04, 0.04)
      bracket.translate(px + 0.25, elev + 1.2, pz)
      batch.addPositioned(bracket, 0x5a4020)
      const signColors = [0xb89050, 0x905040, 0x406050, 0x504080]
      const board = new THREE.BoxGeometry(0.4, 0.25, 0.03)
      board.translate(px + 0.35, elev + 0.95, pz)
      batch.addPositioned(board, signColors[hash % signColors.length])

    } else if (id === 'wagon' || id === 'cart') {
      const bed = new THREE.BoxGeometry(1.2, 0.06, 0.6)
      bed.translate(px, elev + 0.35, pz)
      batch.addPositioned(bed, 0x6a5030)
      for (const sz of [-0.3, 0.3]) {
        const rail = new THREE.BoxGeometry(1.2, 0.2, 0.03)
        rail.translate(px, elev + 0.48, pz + sz)
        batch.addPositioned(rail, 0x6a5030)
      }
      for (const [wx, wz] of [[-0.4, -0.35], [0.4, -0.35], [-0.4, 0.35], [0.4, 0.35]] as const) {
        const wheel = new THREE.CylinderGeometry(0.18, 0.18, 0.04, 8)
        wheel.rotateX(Math.PI / 2)
        wheel.translate(px + wx, elev + 0.18, pz + wz)
        batch.addPositioned(wheel, 0x3a3020)
      }

    } else if (id === 'potted_plant' || id === 'flower_box' || id === 'planter_box') {
      if (id === 'planter_box' || id === 'flower_box') {
        const box = new THREE.BoxGeometry(0.7, 0.25, 0.25)
        box.translate(px, elev + 0.12, pz)
        batch.addPositioned(box, 0x8a5a30)
        for (let pi = 0; pi < 3; pi++) {
          const p = geo.bushGeo.clone()
          p.scale(0.24, 0.24, 0.24)
          p.translate(px - 0.2 + pi * 0.2, elev + 0.35, pz)
          batch.addPositioned(p, 0x3a8a3a)
        }
      } else {
        const pot = new THREE.CylinderGeometry(0.15, 0.12, 0.25, 6)
        pot.translate(px, elev + 0.12, pz)
        batch.addPositioned(pot, 0x8a5a30)
        const plant = geo.bushGeo.clone()
        plant.scale(0.4, 0.4, 0.4)
        plant.translate(px, elev + 0.4, pz)
        batch.addPositioned(plant, 0x3a8a3a)
      }

    } else if (id === 'gravestone') {
      const stone = new THREE.BoxGeometry(0.25, 0.5, 0.08)
      stone.translate(px, elev + 0.25, pz)
      batch.addPositioned(stone, 0x707070)

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
