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

export function buildPropMeshes(
  objects: PlacedObject[],
  defMap: Map<string, ObjectDefinition>
): THREE.Object3D[] {
  const result: THREE.Object3D[] = []
  const geo = getSharedGeo()

  for (const obj of objects) {
    const def = defMap.get(obj.definitionId)
    const id = obj.definitionId
    const colors = PROP_COLORS[id] || { body: 0x808080 }
    const h = PROP_HEIGHTS[id] ?? 0.6
    const fp = def?.footprint || { w: 1, h: 1 }
    const px = obj.x + fp.w / 2, pz = obj.y + fp.h / 2
    const elev = obj.elevation || 0

    if (id === 'tree' || id === 'orchard_tree') {
      const species = (obj.properties.species as string) || 'oak'
      const group = new THREE.Group()
      group.position.set(px, elev, pz)

      // Trunk
      const trunkMat = new THREE.MeshStandardMaterial({ color: colors.body, flatShading: true, roughness: 0.9 })
      const trunk = new THREE.Mesh(geo.treeTrunk, trunkMat)
      trunk.position.y = 0.6
      group.add(trunk)

      // Canopy
      const canopyColor = species === 'pine' ? 0x1a4a1a : species === 'birch' ? 0x4a8a3a : species === 'willow' ? 0x3a6a2a : 0x2d5a27
      const canopyMat = new THREE.MeshStandardMaterial({ color: canopyColor, flatShading: true, roughness: 0.8 })
      if (species === 'pine') {
        const canopy = new THREE.Mesh(geo.pineCanopy, canopyMat)
        canopy.position.y = 1.8
        group.add(canopy)
      } else {
        const canopy = new THREE.Mesh(geo.treeCanopy, canopyMat)
        canopy.position.y = 1.8
        if (species === 'willow') canopy.scale.set(1.3, 0.8, 1.3)
        group.add(canopy)
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
      // Point light for night illumination
      const light = new THREE.PointLight(0xffcc66, 0.8, 8, 1.5)
      light.position.y = h
      group.add(light)
      result.push(group)
    } else {
      // Generic prop: colored box scaled to footprint
      const mat = new THREE.MeshStandardMaterial({ color: colors.body, flatShading: true, roughness: 0.85 })
      const mesh = new THREE.Mesh(geo.boxGeo, mat)
      mesh.scale.set(fp.w * 0.8, h, fp.h * 0.8)
      mesh.position.set(px, elev + h / 2, pz)
      result.push(mesh)
    }
  }

  return result
}
