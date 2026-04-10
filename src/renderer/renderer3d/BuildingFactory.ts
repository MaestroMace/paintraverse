/**
 * Building Factory: converts PlacedObjects → Three.js meshes.
 * Each building = box body + roof geometry.
 * Uses merged geometry per palette for minimal draw calls.
 */

import * as THREE from 'three'
import type { ObjectDefinition, PlacedObject } from '../core/types'
import type { BuildingPalette } from '../inspiration/StyleMapper'

// Building heights in world units (1 unit = 1 tile)
const BUILDING_HEIGHTS: Record<string, number> = {
  building_small: 2.2, building_medium: 3.0, building_large: 3.8,
  tavern: 2.8, shop: 2.5, tower: 5.0, clock_tower: 6.5,
  balcony_house: 3.2, row_house: 2.8, corner_building: 3.0,
  archway: 3.2, staircase: 1.2, town_gate: 4.5,
  chapel: 4.5, guild_hall: 4.0, warehouse: 3.0,
  watchtower: 5.5, mansion: 3.5, bakery: 2.5,
  apothecary: 3.5, inn: 3.2, temple: 5.0,
  covered_market: 2.8, bell_tower: 7.0, half_timber: 3.0,
  narrow_house: 3.8, windmill: 3.5, cathedral: 7.5,
  lighthouse: 9, round_tower: 7, gatehouse: 6.5,
  stable: 3.0, mill: 5.0, bell_tower_tall: 10, aqueduct: 4.5,
}

// Roof styles
type RoofStyle = 'flat' | 'gabled' | 'hipped' | 'pointed' | 'steep' | 'dome' | 'none'
const ROOF_STYLE: Record<string, RoofStyle> = {
  building_small: 'gabled', building_medium: 'gabled', building_large: 'hipped',
  tavern: 'gabled', shop: 'steep', tower: 'pointed', clock_tower: 'pointed',
  balcony_house: 'gabled', row_house: 'steep', corner_building: 'hipped',
  archway: 'none', staircase: 'none', town_gate: 'flat',
  chapel: 'steep', guild_hall: 'hipped', warehouse: 'gabled',
  watchtower: 'pointed', mansion: 'hipped', bakery: 'gabled',
  apothecary: 'steep', inn: 'gabled', temple: 'dome',
  covered_market: 'gabled', bell_tower: 'pointed', half_timber: 'gabled',
  narrow_house: 'steep', windmill: 'pointed', cathedral: 'steep',
  lighthouse: 'dome', round_tower: 'pointed', gatehouse: 'flat',
  stable: 'gabled', mill: 'gabled', bell_tower_tall: 'pointed', aqueduct: 'none',
}

const FOOTPRINTS: Record<string, { w: number; h: number }> = {
  building_small: { w: 2, h: 2 }, building_medium: { w: 3, h: 3 },
  building_large: { w: 4, h: 3 }, tavern: { w: 4, h: 3 },
  shop: { w: 2, h: 3 }, tower: { w: 2, h: 2 },
  balcony_house: { w: 3, h: 2 }, row_house: { w: 1, h: 2 },
  corner_building: { w: 2, h: 2 }, archway: { w: 3, h: 1 },
  staircase: { w: 2, h: 3 }, town_gate: { w: 3, h: 1 },
  chapel: { w: 3, h: 4 }, guild_hall: { w: 4, h: 4 },
  warehouse: { w: 4, h: 3 }, watchtower: { w: 2, h: 2 },
  mansion: { w: 5, h: 4 }, bakery: { w: 2, h: 2 },
  apothecary: { w: 2, h: 3 }, inn: { w: 3, h: 3 },
  temple: { w: 5, h: 5 }, covered_market: { w: 4, h: 3 },
  bell_tower: { w: 2, h: 2 }, half_timber: { w: 3, h: 2 },
  narrow_house: { w: 1, h: 3 }, clock_tower: { w: 3, h: 3 },
  bridge: { w: 4, h: 2 }, cathedral: { w: 5, h: 6 },
  lighthouse: { w: 3, h: 3 }, round_tower: { w: 2, h: 2 },
  gatehouse: { w: 4, h: 2 }, stable: { w: 4, h: 3 },
  mill: { w: 3, h: 3 }, bell_tower_tall: { w: 2, h: 2 },
  aqueduct: { w: 5, h: 1 }, windmill: { w: 3, h: 3 },
}

function simpleHash(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function buildBuildingMeshes(
  objects: PlacedObject[],
  defMap: Map<string, ObjectDefinition>,
  palettes: { wall: number; roof: number; door: number }[]
): THREE.Object3D[] {
  const result: THREE.Object3D[] = []

  for (const obj of objects) {
    const def = defMap.get(obj.definitionId)
    if (!def) continue

    const fp = FOOTPRINTS[obj.definitionId] || { w: def.footprint.w, h: def.footprint.h }
    const baseH = BUILDING_HEIGHTS[obj.definitionId] ?? 2.0
    const hash = simpleHash(obj.id)
    const floors = (obj.properties.floors as number) || 1 + (hash % 2)
    const height = baseH + (hash % 3) * 0.15
    const roofStyle = ROOF_STYLE[obj.definitionId] || 'gabled'
    const palette = palettes[hash % palettes.length]

    const group = new THREE.Group()
    group.position.set(obj.x + fp.w / 2, obj.elevation || 0, obj.y + fp.h / 2)

    // Wall body
    const wallGeo = new THREE.BoxGeometry(fp.w, height, fp.h)
    wallGeo.translate(0, height / 2, 0)
    const wallMat = new THREE.MeshStandardMaterial({
      color: palette.wall,
      flatShading: true,
      roughness: 0.85,
      metalness: 0,
    })
    group.add(new THREE.Mesh(wallGeo, wallMat))

    // Roof
    const roofH = roofStyle === 'pointed' ? height * 0.6
      : roofStyle === 'steep' ? height * 0.45
      : roofStyle === 'dome' ? height * 0.35
      : (roofStyle === 'gabled' || roofStyle === 'hipped') ? height * 0.3
      : 0

    const roofMat = new THREE.MeshStandardMaterial({
      color: palette.roof,
      flatShading: true,
      roughness: 0.7,
      metalness: 0,
    })

    if (roofStyle === 'pointed') {
      const roofGeo = new THREE.ConeGeometry(Math.max(fp.w, fp.h) * 0.6, roofH, 4)
      roofGeo.rotateY(Math.PI / 4)
      roofGeo.translate(0, height + roofH / 2, 0)
      group.add(new THREE.Mesh(roofGeo, roofMat))
    } else if (roofStyle === 'dome') {
      const roofGeo = new THREE.SphereGeometry(Math.max(fp.w, fp.h) * 0.45, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2)
      roofGeo.translate(0, height, 0)
      group.add(new THREE.Mesh(roofGeo, roofMat))
    } else if (roofStyle === 'gabled' || roofStyle === 'steep' || roofStyle === 'hipped') {
      // Triangular prism: custom geometry
      const ridgeH = roofStyle === 'steep' ? roofH : roofH
      const geo = createGabledRoof(fp.w, fp.h, ridgeH, roofStyle === 'hipped')
      geo.translate(0, height, 0)
      group.add(new THREE.Mesh(geo, roofMat))
    }
    // 'flat' and 'none' = no additional roof geometry

    result.push(group)
  }

  return result
}

/** Create a gabled/hipped roof as BufferGeometry */
function createGabledRoof(w: number, d: number, h: number, hipped: boolean): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2

  if (hipped) {
    // Pyramid frustum (all 4 sides slope inward)
    const inset = Math.min(hw, hd) * 0.3
    const verts = new Float32Array([
      // Front face
      -hw, 0, -hd, hw, 0, -hd, inset, h, -inset,
      -hw, 0, -hd, inset, h, -inset, -inset, h, -inset,
      // Back face
      hw, 0, hd, -hw, 0, hd, -inset, h, inset,
      hw, 0, hd, -inset, h, inset, inset, h, inset,
      // Right face
      hw, 0, -hd, hw, 0, hd, inset, h, inset,
      hw, 0, -hd, inset, h, inset, inset, h, -inset,
      // Left face
      -hw, 0, hd, -hw, 0, -hd, -inset, h, -inset,
      -hw, 0, hd, -inset, h, -inset, -inset, h, inset,
      // Top (flat cap)
      -inset, h, -inset, inset, h, -inset, inset, h, inset,
      -inset, h, -inset, inset, h, inset, -inset, h, inset,
    ])
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geo.computeVertexNormals()
    return geo
  } else {
    // Gabled: ridge runs along the longer axis
    const ridgeAlongX = w >= d
    const verts = ridgeAlongX ? new Float32Array([
      // Front triangle
      -hw, 0, -hd, hw, 0, -hd, 0, h, -hd,
      // Back triangle
      hw, 0, hd, -hw, 0, hd, 0, h, hd,
      // Left slope
      -hw, 0, hd, -hw, 0, -hd, 0, h, -hd,
      -hw, 0, hd, 0, h, -hd, 0, h, hd,
      // Right slope
      hw, 0, -hd, hw, 0, hd, 0, h, hd,
      hw, 0, -hd, 0, h, hd, 0, h, -hd,
    ]) : new Float32Array([
      // Front triangle (gable faces)
      -hw, 0, -hd, hw, 0, -hd, hw, 0, -hd, // degenerate — use side gables
      // Ridge along Z
      -hw, 0, -hd, -hw, 0, hd, 0, h, 0, // Left triangle to ridge
      hw, 0, -hd, -hw, 0, -hd, 0, h, 0, // Front gable
      hw, 0, hd, hw, 0, -hd, 0, h, 0,  // Right slope
      -hw, 0, hd, hw, 0, hd, 0, h, 0,  // Back gable
    ])
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geo.computeVertexNormals()
    return geo
  }
}
