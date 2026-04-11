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
      const species = (obj.properties.species as string) || 'oak'
      const trunkH = species === 'pine' ? 2.4 : species === 'willow' ? 1.5 : 1.8
      const trunkColor = species === 'birch' ? 0xd0c8b8 : 0x5a3a1a
      const canopyColor = species === 'pine' ? 0x1a4a1a : species === 'birch' ? 0x4a8a3a
        : species === 'willow' ? 0x3a6a2a : species === 'maple' ? 0x6a8a2a : 0x2d5a27

      // Trunk — scaled up 50%
      const trunk = geo.treeTrunk.clone()
      trunk.scale(1.4, trunkH / 1.2, 1.4)
      trunk.translate(px, elev + trunkH / 2, pz)
      batch.addPositioned(trunk, trunkColor)

      // Canopy
      if (species === 'pine') {
        for (let layer = 0; layer < 3; layer++) {
          const r = 0.9 - layer * 0.18
          const c = geo.pineCone.clone()
          c.scale(r / 0.6, 1.3, r / 0.6)
          c.translate(px, elev + trunkH + 0.3 + layer * 0.6 + 0.45, pz)
          batch.addPositioned(c, canopyColor)
        }
      } else if (species === 'willow') {
        const d = geo.willowDome.clone()
        d.scale(1.5, 0.9, 1.5)
        d.translate(px, elev + trunkH + 0.4, pz)
        batch.addPositioned(d, canopyColor)
      } else {
        // Oak/birch/maple — 3 overlapping lobes + top
        const baseY = elev + trunkH + 0.3
        const lobeR = species === 'birch' ? 0.8 : 1.0
        for (let li = 0; li < 3; li++) {
          const angle = (li / 3) * Math.PI * 2 + (hash * 0.7)
          const lobe = geo.treeCanopy.clone()
          lobe.scale(lobeR, lobeR, lobeR)
          lobe.translate(
            px + Math.cos(angle) * 0.4,
            baseY + Math.sin(li * 1.3) * 0.2,
            pz + Math.sin(angle) * 0.4
          )
          batch.addPositioned(lobe, li % 2 === 0 ? canopyColor : new THREE.Color(canopyColor).multiplyScalar(0.75).getHex())
        }
        const top = geo.treeCanopy.clone()
        top.scale(lobeR * 0.7, lobeR * 0.7, lobeR * 0.7)
        top.translate(px, baseY + lobeR * 0.5, pz)
        batch.addPositioned(top, canopyColor)
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
      const scale = id === 'fountain_grand' ? 1.5 : 1.0
      // Basin
      const basin = new THREE.CylinderGeometry(0.9 * scale, 1.0 * scale, 0.4, 8)
      basin.translate(px, elev + 0.2, pz)
      batch.addPositioned(basin, 0x909898)
      // Water
      const water = new THREE.CylinderGeometry(0.7 * scale, 0.7 * scale, 0.06, 8)
      water.translate(px, elev + 0.38, pz)
      batch.addPositioned(water, 0x5090c0)
      // Pillar
      const pillar = new THREE.CylinderGeometry(0.1, 0.14, 1.0 * scale, 6)
      pillar.translate(px, elev + 0.7 * scale, pz)
      batch.addPositioned(pillar, 0x909898)
      // Top orb
      const orb = new THREE.SphereGeometry(0.15 * scale, 6, 4)
      orb.translate(px, elev + 1.2 * scale, pz)
      batch.addPositioned(orb, 0x909898)

    } else if (id === 'well' || id === 'well_grand') {
      const ring = new THREE.TorusGeometry(0.35, 0.12, 6, 8)
      ring.rotateX(Math.PI / 2); ring.translate(px, elev + 0.4, pz)
      batch.addPositioned(ring, 0x707878)
      for (const sx of [-0.3, 0.3]) {
        const post = new THREE.BoxGeometry(0.06, 0.8, 0.06)
        post.translate(px + sx, elev + 0.8, pz)
        batch.addPositioned(post, 0x5a4020)
      }
      const roof = new THREE.BoxGeometry(0.8, 0.04, 0.4)
      roof.translate(px, elev + 1.22, pz)
      batch.addPositioned(roof, 0x5a4020)

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
