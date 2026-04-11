/**
 * Building Factory v2: Stylized Low-Poly Architecture
 *
 * Design principles:
 * - 1 tile = ~4 meters (a building_small at 2×2 tiles = 8×8m, realistic)
 * - Each floor = 3m (0.75 tile units) in height
 * - Roofs add 30-60% of wall height
 * - Buildings have chimneys, overhanging upper floors, stepped foundations
 * - Architecture varies by district and style
 */

import * as THREE from 'three'
import type { ObjectDefinition, PlacedObject } from '../core/types'
import type { BuildingPalette } from '../inspiration/StyleMapper'
import { createFacadeTexture, createFacadeConfig, createEmissiveTexture } from './FacadeTexture'

// Floor height in tile units (1 tile ≈ 4 meters, 1 floor ≈ 3m)
const FLOOR_HEIGHT = 0.75
// Roof height as fraction of wall height
const ROOF_FRACTION: Record<string, number> = {
  flat: 0, gabled: 0.35, hipped: 0.3, pointed: 0.7, steep: 0.5, dome: 0.4, none: 0,
}

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
  cathedral: { w: 5, h: 6 }, lighthouse: { w: 3, h: 3 },
  round_tower: { w: 2, h: 2 }, gatehouse: { w: 4, h: 2 },
  stable: { w: 4, h: 3 }, mill: { w: 3, h: 3 },
  bell_tower_tall: { w: 2, h: 2 }, aqueduct: { w: 5, h: 1 },
  windmill: { w: 3, h: 3 },
}

// Special buildings that get extra height multiplier
const HEIGHT_MULT: Record<string, number> = {
  tower: 2.5, clock_tower: 3.0, bell_tower: 3.5, bell_tower_tall: 4.5,
  watchtower: 2.8, cathedral: 2.0, lighthouse: 4.0, chapel: 1.5,
  temple: 1.5, town_gate: 1.8, archway: 1.5, round_tower: 3.0,
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
    const hash = simpleHash(obj.id)
    const floors = (obj.properties.floors as number) || 1 + (hash % 2)
    const heightMult = HEIGHT_MULT[obj.definitionId] ?? 1.0
    const wallH = floors * FLOOR_HEIGHT * heightMult
    const roofStyle = ROOF_STYLE[obj.definitionId] || 'gabled'
    const roofFrac = ROOF_FRACTION[roofStyle] ?? 0.3
    const roofH = wallH * roofFrac
    const palette = palettes[hash % palettes.length]
    const style = (obj.properties.style as string) || 'standard'
    const district = (obj.properties.district as string) || 'residential'

    const group = new THREE.Group()
    group.position.set(obj.x + fp.w / 2, obj.elevation || 0, obj.y + fp.h / 2)

    // === WALL BODY (with facade textures + emissive glow maps) ===
    const facadeConfig = createFacadeConfig(obj, fp.w, palette, hash)
    const frontTex = createFacadeTexture(facadeConfig, 'front')
    const sideTex = createFacadeTexture(facadeConfig, 'side')
    const emissiveTex = createEmissiveTexture(facadeConfig)
    const plainMat = new THREE.MeshStandardMaterial({
      color: palette.wall, flatShading: true, roughness: 0.85,
    })
    const frontMat = new THREE.MeshStandardMaterial({
      map: frontTex, flatShading: true, roughness: 0.85,
      emissive: 0xffcc66, emissiveMap: emissiveTex, emissiveIntensity: 0,
    })
    const sideMat = new THREE.MeshStandardMaterial({
      map: sideTex, flatShading: true, roughness: 0.85,
      emissive: 0xffcc66, emissiveMap: emissiveTex, emissiveIntensity: 0,
    })

    // Slight inward taper for upper floors (medieval jettying / overhang)
    const hasOverhang = style === 'ornate' || obj.definitionId === 'half_timber' || obj.definitionId === 'balcony_house'
    if (hasOverhang && floors >= 2) {
      // Ground floor: slightly narrower
      const groundH = FLOOR_HEIGHT * heightMult
      const groundGeo = new THREE.BoxGeometry(fp.w * 0.95, groundH, fp.h * 0.95)
      groundGeo.translate(0, groundH / 2, 0)
      group.add(new THREE.Mesh(groundGeo, [sideMat, sideMat, plainMat, plainMat, frontMat, frontMat]))

      // Upper floors: overhang outward
      const upperH = wallH - groundH
      const upperGeo = new THREE.BoxGeometry(fp.w * 1.02, upperH, fp.h * 1.02)
      upperGeo.translate(0, groundH + upperH / 2, 0)
      group.add(new THREE.Mesh(upperGeo, [sideMat, sideMat, plainMat, plainMat, frontMat, frontMat]))
    } else {
      const wallGeo = new THREE.BoxGeometry(fp.w, wallH, fp.h)
      wallGeo.translate(0, wallH / 2, 0)
      group.add(new THREE.Mesh(wallGeo, [sideMat, sideMat, plainMat, plainMat, frontMat, frontMat]))
    }

    // === ROOF ===
    const roofMat = new THREE.MeshStandardMaterial({
      color: palette.roof, flatShading: true, roughness: 0.7,
    })

    if (roofStyle === 'pointed') {
      const r = Math.max(fp.w, fp.h) * 0.55
      const geo = new THREE.ConeGeometry(r, roofH, 4)
      geo.rotateY(Math.PI / 4)
      geo.translate(0, wallH + roofH / 2, 0)
      group.add(new THREE.Mesh(geo, roofMat))
    } else if (roofStyle === 'dome') {
      const r = Math.max(fp.w, fp.h) * 0.45
      const geo = new THREE.SphereGeometry(r, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2)
      geo.scale(1, roofH / r, 1)
      geo.translate(0, wallH, 0)
      group.add(new THREE.Mesh(geo, roofMat))
    } else if (roofStyle === 'gabled' || roofStyle === 'steep' || roofStyle === 'hipped') {
      const geo = createGabledRoof(fp.w, fp.h, roofH, roofStyle === 'hipped')
      geo.translate(0, wallH, 0)
      group.add(new THREE.Mesh(geo, roofMat))
    }

    // === CHIMNEY (40% of buildings) ===
    if (hash % 5 < 2 && roofH > 0) {
      const chimSide = (obj.properties.chimneyPos === 'left') ? -1 : 1
      const chimW = 0.2, chimD = 0.2, chimH = roofH * 0.8
      const chimGeo = new THREE.BoxGeometry(chimW, chimH, chimD)
      const chimMat = new THREE.MeshStandardMaterial({ color: 0x704030, flatShading: true, roughness: 0.9 })
      chimGeo.translate(chimSide * fp.w * 0.3, wallH + roofH * 0.3 + chimH / 2, 0)
      group.add(new THREE.Mesh(chimGeo, chimMat))
    }

    // === STONE FOUNDATION (visible step at base) ===
    if (district === 'noble' || district === 'temple' || style === 'ornate') {
      const foundH = 0.08
      const foundGeo = new THREE.BoxGeometry(fp.w + 0.1, foundH, fp.h + 0.1)
      const foundMat = new THREE.MeshStandardMaterial({ color: 0x606060, flatShading: true, roughness: 0.95 })
      foundGeo.translate(0, foundH / 2, 0)
      group.add(new THREE.Mesh(foundGeo, foundMat))
    }

    // === DOORSTEP ===
    if (fp.w >= 2) {
      const stepGeo = new THREE.BoxGeometry(0.5, 0.05, 0.15)
      const stepMat = new THREE.MeshStandardMaterial({ color: 0x808080, flatShading: true })
      stepGeo.translate(0, 0.025, fp.h / 2 + 0.08)
      group.add(new THREE.Mesh(stepGeo, stepMat))
    }

    // === CIRCULAR TOWER CORNER (towers, watchtowers, round_tower) ===
    if (obj.definitionId === 'tower' || obj.definitionId === 'watchtower' || obj.definitionId === 'round_tower') {
      // Replace box with cylinder for these types
      const cylGeo = new THREE.CylinderGeometry(
        fp.w * 0.45, fp.w * 0.48, wallH, 8
      )
      cylGeo.translate(0, wallH / 2, 0)
      const cylMat = new THREE.MeshStandardMaterial({
        color: palette.wall, flatShading: true, roughness: 0.85,
      })
      group.add(new THREE.Mesh(cylGeo, cylMat))
    }

    // === BAY WINDOW (mansion, guild_hall, balcony_house) ===
    if ((obj.definitionId === 'mansion' || obj.definitionId === 'guild_hall' || obj.definitionId === 'balcony_house') && floors >= 2) {
      const bayW = fp.w * 0.25, bayH = FLOOR_HEIGHT * 0.6, bayD = 0.3
      const bayY = FLOOR_HEIGHT * 1.3 * heightMult
      const bayMat = new THREE.MeshStandardMaterial({ color: palette.wall, flatShading: true, roughness: 0.8 })
      // Front bay window
      const bayGeo = new THREE.BoxGeometry(bayW, bayH, bayD)
      bayGeo.translate(fp.w * 0.2, bayY, fp.h / 2 + bayD / 2)
      group.add(new THREE.Mesh(bayGeo, bayMat))
      // Bay window glass
      const glassGeo = new THREE.BoxGeometry(bayW * 0.8, bayH * 0.7, 0.02)
      const glassMat = new THREE.MeshStandardMaterial({ color: 0x405060, flatShading: true, roughness: 0.2, metalness: 0.3 })
      glassGeo.translate(fp.w * 0.2, bayY, fp.h / 2 + bayD + 0.01)
      group.add(new THREE.Mesh(glassGeo, glassMat))
    }

    // === ARCHWAY (archway, town_gate buildings get a passage through) ===
    if (obj.definitionId === 'archway' || obj.definitionId === 'town_gate' || obj.definitionId === 'gatehouse') {
      // Cut out a passage arch — add pillars on sides + arch top
      const pillarW = 0.3, archH = wallH * 0.7, archW = fp.w * 0.5
      const pillarMat = new THREE.MeshStandardMaterial({ color: palette.wall, flatShading: true, roughness: 0.85 })
      // Left pillar
      const lPillarGeo = new THREE.BoxGeometry(pillarW, archH, fp.h)
      lPillarGeo.translate(-archW / 2 - pillarW / 2, archH / 2, 0)
      group.add(new THREE.Mesh(lPillarGeo, pillarMat))
      // Right pillar
      const rPillarGeo = new THREE.BoxGeometry(pillarW, archH, fp.h)
      rPillarGeo.translate(archW / 2 + pillarW / 2, archH / 2, 0)
      group.add(new THREE.Mesh(rPillarGeo, pillarMat))
      // Arch top (half-cylinder)
      const archTopGeo = new THREE.CylinderGeometry(archW / 2, archW / 2, fp.h, 8, 1, false, 0, Math.PI)
      archTopGeo.rotateX(Math.PI / 2)
      archTopGeo.rotateZ(Math.PI)
      archTopGeo.translate(0, archH, 0)
      group.add(new THREE.Mesh(archTopGeo, pillarMat))
    }

    // === COLONNADE (temple, cathedral, guild_hall — columns along front) ===
    if ((obj.definitionId === 'temple' || obj.definitionId === 'cathedral' || obj.definitionId === 'guild_hall') && fp.w >= 4) {
      const colRadius = 0.1, colH = wallH * 0.85
      const colMat = new THREE.MeshStandardMaterial({ color: 0xc0b8a8, flatShading: true, roughness: 0.7 })
      const numCols = Math.floor(fp.w / 1.2)
      const spacing = fp.w / (numCols + 1)
      for (let ci = 1; ci <= numCols; ci++) {
        const colGeo = new THREE.CylinderGeometry(colRadius * 0.85, colRadius, colH, 6)
        colGeo.translate(-fp.w / 2 + ci * spacing, colH / 2, fp.h / 2 + 0.25)
        group.add(new THREE.Mesh(colGeo, colMat))
      }
      // Entablature (horizontal beam across column tops)
      const beamGeo = new THREE.BoxGeometry(fp.w + 0.2, 0.12, 0.25)
      beamGeo.translate(0, colH + 0.06, fp.h / 2 + 0.25)
      group.add(new THREE.Mesh(beamGeo, colMat))
    }

    // === BALCONY (balcony_house, inn — projecting platform on front) ===
    if ((obj.definitionId === 'balcony_house' || obj.definitionId === 'inn') && floors >= 2) {
      const balcW = fp.w * 0.5, balcD = 0.4, balcH = 0.06
      const balcY = FLOOR_HEIGHT * 1.1 * heightMult
      const balcMat = new THREE.MeshStandardMaterial({ color: 0x705a40, flatShading: true, roughness: 0.85 })
      // Platform
      const balcGeo = new THREE.BoxGeometry(balcW, balcH, balcD)
      balcGeo.translate(0, balcY, fp.h / 2 + balcD / 2)
      group.add(new THREE.Mesh(balcGeo, balcMat))
      // Railing
      const railGeo = new THREE.BoxGeometry(balcW, 0.25, 0.04)
      railGeo.translate(0, balcY + 0.15, fp.h / 2 + balcD)
      group.add(new THREE.Mesh(railGeo, balcMat))
      // Support brackets
      for (const side of [-balcW * 0.35, balcW * 0.35]) {
        const bracketGeo = new THREE.BoxGeometry(0.06, 0.2, balcD * 0.7)
        bracketGeo.translate(side, balcY - 0.1, fp.h / 2 + balcD * 0.4)
        group.add(new THREE.Mesh(bracketGeo, balcMat))
      }
    }

    result.push(group)
  }

  return result
}

/** Create a gabled/hipped roof as BufferGeometry */
function createGabledRoof(w: number, d: number, h: number, hipped: boolean): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2
  // Add slight overhang beyond the walls
  const ow = hw + 0.08, od = hd + 0.08

  if (hipped) {
    const inset = Math.min(hw, hd) * 0.25
    const verts = new Float32Array([
      -ow, 0, -od,  ow, 0, -od,  inset, h, -inset,
      -ow, 0, -od,  inset, h, -inset,  -inset, h, -inset,
      ow, 0, od,  -ow, 0, od,  -inset, h, inset,
      ow, 0, od,  -inset, h, inset,  inset, h, inset,
      ow, 0, -od,  ow, 0, od,  inset, h, inset,
      ow, 0, -od,  inset, h, inset,  inset, h, -inset,
      -ow, 0, od,  -ow, 0, -od,  -inset, h, -inset,
      -ow, 0, od,  -inset, h, -inset,  -inset, h, inset,
      -inset, h, -inset,  inset, h, -inset,  inset, h, inset,
      -inset, h, -inset,  inset, h, inset,  -inset, h, inset,
    ])
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geo.computeVertexNormals()
    return geo
  } else {
    // Gabled: ridge runs along the longer axis with overhang
    const verts = new Float32Array([
      // Front gable triangle
      -ow, 0, -od,  ow, 0, -od,  0, h, -od,
      // Back gable triangle
      ow, 0, od,  -ow, 0, od,  0, h, od,
      // Left slope
      -ow, 0, od,  -ow, 0, -od,  0, h, -od,
      -ow, 0, od,  0, h, -od,  0, h, od,
      // Right slope
      ow, 0, -od,  ow, 0, od,  0, h, od,
      ow, 0, -od,  0, h, od,  0, h, -od,
    ])
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geo.computeVertexNormals()
    return geo
  }
}
