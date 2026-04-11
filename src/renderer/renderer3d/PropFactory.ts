/**
 * Prop Factory: converts props/vegetation → simple Three.js geometry.
 * Trees = trunk cylinder + canopy sphere/cone.
 * Small props = colored boxes.
 */

import * as THREE from 'three'
import type { ObjectDefinition, PlacedObject } from '../core/types'

const PROP_COLORS: Record<string, { body: number; accent?: number }> = {
  tree: { body: 0x5a3a1a, accent: 0x2d5a27 },
  bush: { body: 0x3a7a33 },
  lamppost: { body: 0x2a2a2a, accent: 0xffdd44 },
  bench: { body: 0x6b4a28 },
  fountain: { body: 0x708090, accent: 0x4682b4 },
  fence: { body: 0x6b4a28 },
  well: { body: 0x708090 },
  barrel: { body: 0x6b4a28 },
  crate: { body: 0x8b7355 },
  market_stall: { body: 0x8b7355, accent: 0xc8b8a0 },
  statue: { body: 0x8a8a88 },
  potted_plant: { body: 0x6a4a2a, accent: 0x3a8a3a },
  wagon: { body: 0x6b4a28 },
  stone_wall: { body: 0x808080 },
  gravestone: { body: 0x707070 },
  windmill: { body: 0xc8b898 },
  bridge: { body: 0x8b7355 },
}

const PROP_HEIGHTS: Record<string, number> = {
  tree: 2.5, bush: 0.8, lamppost: 2.2, bench: 0.5, fountain: 1.5,
  fence: 0.6, well: 1.0, barrel: 0.7, crate: 0.5, market_stall: 1.8,
  statue: 2.0, potted_plant: 0.6, wagon: 1.0, stone_wall: 1.2,
  gravestone: 0.7, windmill: 3.5, bridge: 0.8,
}

// Shared geometries (created once, instanced many times)
let _treeCanopy: THREE.SphereGeometry | null = null
let _treeTrunk: THREE.CylinderGeometry | null = null
let _pineCanopy: THREE.ConeGeometry | null = null
let _bushGeo: THREE.SphereGeometry | null = null
let _boxGeo: THREE.BoxGeometry | null = null

function getSharedGeo() {
  if (!_treeCanopy) {
    _treeCanopy = new THREE.SphereGeometry(0.8, 6, 5)
    _treeTrunk = new THREE.CylinderGeometry(0.1, 0.15, 1.2, 5)
    _pineCanopy = new THREE.ConeGeometry(0.7, 1.8, 6)
    _bushGeo = new THREE.SphereGeometry(0.5, 5, 4)
    _boxGeo = new THREE.BoxGeometry(1, 1, 1)
  }
  return { treeCanopy: _treeCanopy!, treeTrunk: _treeTrunk!, pineCanopy: _pineCanopy!, bushGeo: _bushGeo!, boxGeo: _boxGeo! }
}

const MAX_POINT_LIGHTS = 8 // cap to avoid per-fragment shader explosion

export function buildPropMeshes(
  objects: PlacedObject[],
  defMap: Map<string, ObjectDefinition>
): THREE.Object3D[] {
  const result: THREE.Object3D[] = []
  const geo = getSharedGeo()
  let pointLightCount = 0

  for (const obj of objects) {
    const def = defMap.get(obj.definitionId)
    const id = obj.definitionId
    const colors = PROP_COLORS[id] || { body: 0x808080 }
    const h = PROP_HEIGHTS[id] ?? 0.6
    const fp = def?.footprint || { w: 1, h: 1 }
    const px = obj.x + fp.w / 2, pz = obj.y + fp.h / 2
    const elev = obj.elevation || 0
    let hash = 0
    for (let i = 0; i < obj.id.length; i++) hash = ((hash << 5) - hash + obj.id.charCodeAt(i)) | 0
    hash = Math.abs(hash)

    if (id === 'tree' || id === 'orchard_tree') {
      const species = (obj.properties.species as string) || 'oak'
      const group = new THREE.Group()
      group.position.set(px, elev, pz)

      // Trunk — slightly tapered cylinder
      const trunkH = species === 'pine' ? 1.6 : species === 'willow' ? 1.0 : 1.2
      const trunkMat = new THREE.MeshStandardMaterial({
        color: species === 'birch' ? 0xd0c8b8 : 0x5a3a1a, flatShading: true, roughness: 0.9,
      })
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.14, trunkH, 5), trunkMat)
      trunk.position.y = trunkH / 2
      group.add(trunk)

      // Canopy — species-specific shapes
      const canopyColor = species === 'pine' ? 0x1a4a1a : species === 'birch' ? 0x4a8a3a
        : species === 'willow' ? 0x3a6a2a : species === 'maple' ? 0x6a8a2a : 0x2d5a27
      const canopyMat = new THREE.MeshStandardMaterial({ color: canopyColor, flatShading: true, roughness: 0.8 })
      const canopyDark = new THREE.MeshStandardMaterial({
        color: new THREE.Color(canopyColor).multiplyScalar(0.75).getHex(),
        flatShading: true, roughness: 0.8,
      })

      if (species === 'pine') {
        // Layered cones
        for (let layer = 0; layer < 3; layer++) {
          const r = 0.6 - layer * 0.12
          const ch = 0.7
          const cone = new THREE.Mesh(
            new THREE.ConeGeometry(r, ch, 6),
            layer % 2 === 0 ? canopyMat : canopyDark
          )
          cone.position.y = trunkH + 0.2 + layer * 0.45
          group.add(cone)
        }
      } else if (species === 'willow') {
        // Wide dome
        const dome = new THREE.Mesh(new THREE.SphereGeometry(1.1, 7, 5), canopyMat)
        dome.scale.set(1, 0.65, 1)
        dome.position.y = trunkH + 0.3
        group.add(dome)
      } else {
        // Oak/birch/maple: multi-sphere canopy (3 overlapping spheres)
        const baseY = trunkH + 0.2
        const lobeR = species === 'birch' ? 0.55 : 0.7
        for (let li = 0; li < 3; li++) {
          const angle = (li / 3) * Math.PI * 2 + (hash * 0.7)
          const lobe = new THREE.Mesh(
            geo.treeCanopy,
            li % 2 === 0 ? canopyMat : canopyDark
          )
          lobe.scale.setScalar(lobeR)
          lobe.position.set(
            Math.cos(angle) * 0.25,
            baseY + Math.sin(li * 1.3) * 0.15,
            Math.sin(angle) * 0.25
          )
          group.add(lobe)
        }
        // Top highlight lobe
        const topLobe = new THREE.Mesh(geo.treeCanopy, canopyMat)
        topLobe.scale.setScalar(lobeR * 0.6)
        topLobe.position.set(0, baseY + 0.4, 0)
        group.add(topLobe)
      }

      result.push(group)
    } else if (id === 'bush' || id === 'hedge') {
      const mat = new THREE.MeshStandardMaterial({ color: colors.body, flatShading: true, roughness: 0.85 })
      const mesh = new THREE.Mesh(geo.bushGeo, mat)
      mesh.position.set(px, elev + 0.3, pz)
      result.push(mesh)
    } else if (id === 'lamppost' || id === 'wall_lantern' || id === 'street_lamp_double' || id === 'double_lamp') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      // Pole
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, flatShading: true })
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, h, 4), poleMat)
      pole.position.y = h / 2
      group.add(pole)
      // Lamp glow (emissive sphere)
      const lampMat = new THREE.MeshStandardMaterial({ color: 0xffcc44, emissive: 0xffaa22, emissiveIntensity: 0.8 })
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.15, 6, 4), lampMat)
      lamp.position.y = h
      group.add(lamp)
      // Point light for night illumination (capped for performance)
      if (pointLightCount < MAX_POINT_LIGHTS) {
        const light = new THREE.PointLight(0xffcc66, 0.8, 8, 1.5)
        light.position.y = h
        group.add(light)
        pointLightCount++
      }
      result.push(group)

    } else if (id === 'fountain' || id === 'fountain_grand') {
      // Stone basin + water column
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x808888, flatShading: true, roughness: 0.8 })
      // Octagonal basin (cylinder with 8 sides)
      const basinGeo = new THREE.CylinderGeometry(0.7, 0.8, 0.35, 8)
      basinGeo.translate(0, 0.18, 0)
      group.add(new THREE.Mesh(basinGeo, stoneMat))
      // Inner water
      const waterMat = new THREE.MeshStandardMaterial({ color: 0x4080b0, roughness: 0.1, metalness: 0.3 })
      const waterGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.05, 8)
      waterGeo.translate(0, 0.33, 0)
      group.add(new THREE.Mesh(waterGeo, waterMat))
      // Central pillar
      const pillarGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.7, 6)
      pillarGeo.translate(0, 0.55, 0)
      group.add(new THREE.Mesh(pillarGeo, stoneMat))
      // Top orb
      const orbGeo = new THREE.SphereGeometry(0.12, 6, 4)
      orbGeo.translate(0, 0.95, 0)
      group.add(new THREE.Mesh(orbGeo, stoneMat))
      result.push(group)

    } else if (id === 'well' || id === 'well_grand') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x707878, flatShading: true, roughness: 0.9 })
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a4020, flatShading: true, roughness: 0.85 })
      // Stone ring
      const ringGeo = new THREE.TorusGeometry(0.35, 0.12, 6, 8)
      ringGeo.rotateX(Math.PI / 2)
      ringGeo.translate(0, 0.4, 0)
      group.add(new THREE.Mesh(ringGeo, stoneMat))
      // Inner darkness
      const innerGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.1, 8)
      const innerMat = new THREE.MeshStandardMaterial({ color: 0x101020, roughness: 1 })
      innerGeo.translate(0, 0.35, 0)
      group.add(new THREE.Mesh(innerGeo, innerMat))
      // Roof posts
      for (const sx of [-0.3, 0.3]) {
        const postGeo = new THREE.BoxGeometry(0.06, 0.8, 0.06)
        postGeo.translate(sx, 0.8, 0)
        group.add(new THREE.Mesh(postGeo, woodMat))
      }
      // Roof beam + small peaked roof
      const roofGeo = new THREE.BoxGeometry(0.8, 0.04, 0.4)
      roofGeo.translate(0, 1.22, 0)
      group.add(new THREE.Mesh(roofGeo, woodMat))
      result.push(group)

    } else if (id === 'barrel' || id === 'rain_barrel') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x6a4a28, flatShading: true, roughness: 0.85 })
      const bandMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, flatShading: true, roughness: 0.7 })
      const barrelGeo = new THREE.CylinderGeometry(0.2, 0.22, 0.5, 8)
      barrelGeo.translate(0, 0.25, 0)
      group.add(new THREE.Mesh(barrelGeo, woodMat))
      // Metal bands
      for (const by of [0.1, 0.4]) {
        const bandGeo = new THREE.TorusGeometry(0.21, 0.015, 4, 8)
        bandGeo.rotateX(Math.PI / 2)
        bandGeo.translate(0, by, 0)
        group.add(new THREE.Mesh(bandGeo, bandMat))
      }
      result.push(group)

    } else if (id === 'barrel_stack') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a3a18, flatShading: true, roughness: 0.85 })
      // 3 barrels in pyramid
      for (const [bx, bz, by] of [[0, -0.15, 0], [0.25, 0.15, 0], [-0.25, 0.15, 0], [0, 0, 0.45]] as const) {
        const barrelGeo = new THREE.CylinderGeometry(0.18, 0.2, 0.45, 7)
        barrelGeo.translate(bx, by + 0.22, bz)
        group.add(new THREE.Mesh(barrelGeo, woodMat))
      }
      result.push(group)

    } else if (id === 'crate' || id === 'crate_stack') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a7050, flatShading: true, roughness: 0.9 })
      const numCrates = id === 'crate_stack' ? 3 : 1
      for (let ci = 0; ci < numCrates; ci++) {
        const s = 0.35 - ci * 0.03
        const crateGeo = new THREE.BoxGeometry(s, s, s)
        crateGeo.translate((ci % 2) * 0.1, ci * 0.33 + s / 2, (ci % 2) * 0.05)
        group.add(new THREE.Mesh(crateGeo, woodMat))
      }
      result.push(group)

    } else if (id === 'bench') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x6a4a28, flatShading: true, roughness: 0.85 })
      // Seat
      const seatGeo = new THREE.BoxGeometry(0.9, 0.04, 0.3)
      seatGeo.translate(0, 0.35, 0)
      group.add(new THREE.Mesh(seatGeo, woodMat))
      // Back rest
      const backGeo = new THREE.BoxGeometry(0.9, 0.35, 0.03)
      backGeo.translate(0, 0.55, -0.13)
      group.add(new THREE.Mesh(backGeo, woodMat))
      // Legs
      for (const lx of [-0.35, 0.35]) {
        const legGeo = new THREE.BoxGeometry(0.04, 0.35, 0.25)
        legGeo.translate(lx, 0.175, 0)
        group.add(new THREE.Mesh(legGeo, woodMat))
      }
      result.push(group)

    } else if (id === 'market_stall') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x7a5a30, flatShading: true, roughness: 0.85 })
      // Counter table
      const tableGeo = new THREE.BoxGeometry(1.4, 0.06, 0.7)
      tableGeo.translate(0, 0.7, 0)
      group.add(new THREE.Mesh(tableGeo, woodMat))
      // Legs (4 posts)
      for (const [lx, lz] of [[-0.6, -0.25], [0.6, -0.25], [-0.6, 0.25], [0.6, 0.25]] as const) {
        const legGeo = new THREE.BoxGeometry(0.06, 0.7, 0.06)
        legGeo.translate(lx, 0.35, lz)
        group.add(new THREE.Mesh(legGeo, woodMat))
      }
      // Canopy (angled cloth)
      const canopyColors = [0xcc3333, 0x3366aa, 0xcc9933, 0x339966]
      const canopyMat = new THREE.MeshStandardMaterial({
        color: canopyColors[hash % canopyColors.length],
        flatShading: true, roughness: 0.95, side: THREE.DoubleSide,
      })
      // Front poles (taller)
      for (const lx of [-0.65, 0.65]) {
        const poleGeo = new THREE.CylinderGeometry(0.03, 0.03, 0.9, 4)
        poleGeo.translate(lx, 1.15, 0.3)
        group.add(new THREE.Mesh(poleGeo, woodMat))
      }
      // Angled canopy (tilted plane)
      const canopyGeo = new THREE.PlaneGeometry(1.5, 0.9)
      canopyGeo.rotateX(-0.3) // tilt backward
      canopyGeo.translate(0, 1.55, 0.05)
      group.add(new THREE.Mesh(canopyGeo, canopyMat))
      result.push(group)

    } else if (id === 'statue' || id === 'column' || id === 'monument') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x9a9a90, flatShading: true, roughness: 0.75 })
      if (id === 'column') {
        // Classical column: base + shaft + capital
        const baseGeo = new THREE.BoxGeometry(0.35, 0.1, 0.35)
        baseGeo.translate(0, 0.05, 0)
        group.add(new THREE.Mesh(baseGeo, stoneMat))
        const shaftGeo = new THREE.CylinderGeometry(0.1, 0.12, 1.5, 6)
        shaftGeo.translate(0, 0.85, 0)
        group.add(new THREE.Mesh(shaftGeo, stoneMat))
        const capitalGeo = new THREE.BoxGeometry(0.3, 0.1, 0.3)
        capitalGeo.translate(0, 1.65, 0)
        group.add(new THREE.Mesh(capitalGeo, stoneMat))
      } else if (id === 'monument') {
        // Obelisk on pedestal
        const pedestalGeo = new THREE.BoxGeometry(0.8, 0.3, 0.8)
        pedestalGeo.translate(0, 0.15, 0)
        group.add(new THREE.Mesh(pedestalGeo, stoneMat))
        const obeliskGeo = new THREE.CylinderGeometry(0.05, 0.2, 1.5, 4)
        obeliskGeo.translate(0, 1.05, 0)
        group.add(new THREE.Mesh(obeliskGeo, stoneMat))
      } else {
        // Statue: pedestal + figure silhouette (simple)
        const pedestalGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5)
        pedestalGeo.translate(0, 0.25, 0)
        group.add(new THREE.Mesh(pedestalGeo, stoneMat))
        // Figure (rough humanoid shape)
        const bodyGeo = new THREE.CylinderGeometry(0.12, 0.15, 0.8, 5)
        bodyGeo.translate(0, 0.9, 0)
        group.add(new THREE.Mesh(bodyGeo, stoneMat))
        const headGeo = new THREE.SphereGeometry(0.1, 5, 4)
        headGeo.translate(0, 1.4, 0)
        group.add(new THREE.Mesh(headGeo, stoneMat))
      }
      result.push(group)

    } else if (id === 'fence' || id === 'iron_fence' || id === 'stone_wall') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      if (id === 'stone_wall') {
        const wallMat = new THREE.MeshStandardMaterial({ color: 0x707070, flatShading: true, roughness: 0.9 })
        const wallGeo = new THREE.BoxGeometry(fp.w * 0.9, 0.8, 0.2)
        wallGeo.translate(0, 0.4, 0)
        group.add(new THREE.Mesh(wallGeo, wallMat))
        // Capstones
        const capGeo = new THREE.BoxGeometry(fp.w * 0.95, 0.06, 0.25)
        capGeo.translate(0, 0.83, 0)
        group.add(new THREE.Mesh(capGeo, wallMat))
      } else if (id === 'iron_fence') {
        const ironMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, flatShading: true, roughness: 0.6, metalness: 0.4 })
        // Horizontal rail
        const railGeo = new THREE.BoxGeometry(fp.w * 0.9, 0.03, 0.03)
        railGeo.translate(0, 0.5, 0)
        group.add(new THREE.Mesh(railGeo, ironMat))
        // Vertical bars with pointed tops
        const numBars = Math.max(3, Math.floor(fp.w * 3))
        for (let bi = 0; bi < numBars; bi++) {
          const bx = -fp.w * 0.4 + bi * (fp.w * 0.8 / (numBars - 1))
          const barGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.6, 3)
          barGeo.translate(bx, 0.3, 0)
          group.add(new THREE.Mesh(barGeo, ironMat))
          // Pointed finial
          const finGeo = new THREE.ConeGeometry(0.02, 0.06, 3)
          finGeo.translate(bx, 0.63, 0)
          group.add(new THREE.Mesh(finGeo, ironMat))
        }
      } else {
        const woodMat = new THREE.MeshStandardMaterial({ color: 0x6a4a28, flatShading: true, roughness: 0.85 })
        // Wooden fence: horizontal rails + posts
        for (const ry of [0.2, 0.45]) {
          const railGeo = new THREE.BoxGeometry(fp.w * 0.9, 0.04, 0.03)
          railGeo.translate(0, ry, 0)
          group.add(new THREE.Mesh(railGeo, woodMat))
        }
        for (const fx of [-fp.w * 0.4, 0, fp.w * 0.4]) {
          const postGeo = new THREE.BoxGeometry(0.06, 0.55, 0.06)
          postGeo.translate(fx, 0.275, 0)
          group.add(new THREE.Mesh(postGeo, woodMat))
        }
      }
      result.push(group)

    } else if (id === 'cafe_table') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a7a5a, flatShading: true, roughness: 0.8 })
      // Round table top
      const topGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.03, 8)
      topGeo.translate(0, 0.55, 0)
      group.add(new THREE.Mesh(topGeo, woodMat))
      // Central leg
      const legGeo = new THREE.CylinderGeometry(0.03, 0.05, 0.55, 4)
      legGeo.translate(0, 0.275, 0)
      group.add(new THREE.Mesh(legGeo, woodMat))
      // Two small chairs (simplified)
      for (const [cx, cz] of [[0.35, 0], [-0.35, 0]] as const) {
        const seatGeo = new THREE.BoxGeometry(0.2, 0.02, 0.2)
        seatGeo.translate(cx, 0.35, cz)
        group.add(new THREE.Mesh(seatGeo, woodMat))
        const chairBackGeo = new THREE.BoxGeometry(0.2, 0.25, 0.02)
        chairBackGeo.translate(cx, 0.5, cz + (cz >= 0 ? 0.1 : -0.1))
        group.add(new THREE.Mesh(chairBackGeo, woodMat))
      }
      result.push(group)

    } else if (id === 'hanging_sign' || id === 'sign') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a4020, flatShading: true, roughness: 0.85 })
      const signColors = [0xb89050, 0x905040, 0x406050, 0x504080]
      const signMat = new THREE.MeshStandardMaterial({ color: signColors[hash % signColors.length], flatShading: true })
      // Bracket arm
      const bracketGeo = new THREE.BoxGeometry(0.5, 0.04, 0.04)
      bracketGeo.translate(0.25, 1.2, 0)
      group.add(new THREE.Mesh(bracketGeo, woodMat))
      // Sign board
      const boardGeo = new THREE.BoxGeometry(0.4, 0.25, 0.03)
      boardGeo.translate(0.35, 0.95, 0)
      group.add(new THREE.Mesh(boardGeo, signMat))
      result.push(group)

    } else if (id === 'wagon' || id === 'cart') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x6a5030, flatShading: true, roughness: 0.85 })
      // Bed
      const bedGeo = new THREE.BoxGeometry(1.2, 0.06, 0.6)
      bedGeo.translate(0, 0.35, 0)
      group.add(new THREE.Mesh(bedGeo, woodMat))
      // Side rails
      for (const sz of [-0.3, 0.3]) {
        const railGeo = new THREE.BoxGeometry(1.2, 0.2, 0.03)
        railGeo.translate(0, 0.48, sz)
        group.add(new THREE.Mesh(railGeo, woodMat))
      }
      // Wheels (4 cylinders)
      const wheelMat = new THREE.MeshStandardMaterial({ color: 0x3a3020, flatShading: true })
      for (const [wx, wz] of [[-0.4, -0.35], [0.4, -0.35], [-0.4, 0.35], [0.4, 0.35]] as const) {
        const wheelGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.04, 8)
        wheelGeo.rotateX(Math.PI / 2)
        wheelGeo.translate(wx, 0.18, wz)
        group.add(new THREE.Mesh(wheelGeo, wheelMat))
      }
      result.push(group)

    } else if (id === 'potted_plant' || id === 'flower_box' || id === 'planter_box') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const potMat = new THREE.MeshStandardMaterial({ color: 0x8a5a30, flatShading: true, roughness: 0.9 })
      const plantMat = new THREE.MeshStandardMaterial({ color: 0x3a8a3a, flatShading: true, roughness: 0.85 })
      if (id === 'planter_box' || id === 'flower_box') {
        const boxGeo = new THREE.BoxGeometry(0.7, 0.25, 0.25)
        boxGeo.translate(0, 0.12, 0)
        group.add(new THREE.Mesh(boxGeo, potMat))
        // Plants poking out
        for (let pi = 0; pi < 3; pi++) {
          const pGeo = new THREE.SphereGeometry(0.12, 5, 4)
          pGeo.translate(-0.2 + pi * 0.2, 0.35, 0)
          group.add(new THREE.Mesh(pGeo, plantMat))
        }
        // Flowers
        const flowerColors = [0xff6688, 0xffaa44, 0xdd88dd]
        for (let fi = 0; fi < 2; fi++) {
          const fMat = new THREE.MeshStandardMaterial({ color: flowerColors[(hash + fi) % 3], flatShading: true })
          const fGeo = new THREE.SphereGeometry(0.06, 4, 3)
          fGeo.translate(-0.15 + fi * 0.3, 0.42, 0.05)
          group.add(new THREE.Mesh(fGeo, fMat))
        }
      } else {
        // Pot
        const potGeo = new THREE.CylinderGeometry(0.15, 0.12, 0.25, 6)
        potGeo.translate(0, 0.12, 0)
        group.add(new THREE.Mesh(potGeo, potMat))
        // Plant
        const pGeo = new THREE.SphereGeometry(0.2, 5, 4)
        pGeo.translate(0, 0.4, 0)
        group.add(new THREE.Mesh(pGeo, plantMat))
      }
      result.push(group)

    } else if (id === 'gravestone') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const stoneMat = new THREE.MeshStandardMaterial({ color: 0x707070, flatShading: true, roughness: 0.9 })
      const stoneGeo = new THREE.BoxGeometry(0.25, 0.5, 0.08)
      stoneGeo.translate(0, 0.25, 0)
      group.add(new THREE.Mesh(stoneGeo, stoneMat))
      // Rounded top
      const topGeo = new THREE.SphereGeometry(0.125, 6, 4, 0, Math.PI * 2, 0, Math.PI / 2)
      topGeo.rotateX(Math.PI)
      topGeo.scale(1, 0.5, 0.3)
      topGeo.translate(0, 0.5, 0)
      group.add(new THREE.Mesh(topGeo, stoneMat))
      result.push(group)

    } else if (id === 'garden_arch') {
      const group = new THREE.Group()
      group.position.set(px, elev, pz)
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x5a4a30, flatShading: true, roughness: 0.85 })
      const vineMat = new THREE.MeshStandardMaterial({ color: 0x3a7a2a, flatShading: true, roughness: 0.85 })
      // Two posts
      for (const sx of [-0.4, 0.4]) {
        const postGeo = new THREE.BoxGeometry(0.06, 1.6, 0.06)
        postGeo.translate(sx, 0.8, 0)
        group.add(new THREE.Mesh(postGeo, woodMat))
      }
      // Arch top (half torus)
      const archGeo = new THREE.TorusGeometry(0.4, 0.03, 4, 8, Math.PI)
      archGeo.rotateZ(Math.PI)
      archGeo.translate(0, 1.6, 0)
      group.add(new THREE.Mesh(archGeo, woodMat))
      // Vine clusters
      for (let vi = 0; vi < 4; vi++) {
        const angle = vi * 0.7
        const vineGeo = new THREE.SphereGeometry(0.1, 4, 3)
        vineGeo.translate(Math.cos(angle) * 0.35, 1.4 + Math.sin(angle) * 0.2, 0)
        group.add(new THREE.Mesh(vineGeo, vineMat))
      }
      result.push(group)

    } else {
      // Fallback: colored box
      const mat = new THREE.MeshStandardMaterial({ color: colors.body, flatShading: true, roughness: 0.85 })
      const mesh = new THREE.Mesh(geo.boxGeo, mat)
      mesh.scale.set(fp.w * 0.8, h, fp.h * 0.8)
      mesh.position.set(px, elev + h / 2, pz)
      result.push(mesh)
    }
  }

  return result
}
