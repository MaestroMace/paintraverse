/**
 * Building Factory v3: Batched Architecture
 *
 * All non-textured geometry (roofs, chimneys, foundations, doorsteps,
 * archways, colonnades, balconies, towers) is merged into a handful
 * of batched meshes using vertex colors. Only textured wall bodies
 * remain as individual meshes (one draw call each, not six).
 *
 * ~8,300 draw calls → ~405
 */

import * as THREE from 'three'
import type { ObjectDefinition, PlacedObject } from '../core/types'
import type { BuildingPalette } from '../inspiration/StyleMapper'
import { createFacadeTexture, createFacadeConfig } from './FacadeTexture'
import { BatchedMeshBuilder } from './BatchedMeshBuilder'

const FLOOR_HEIGHT = 0.75
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
  bell_tower_tall: { w: 3, h: 3 }, aqueduct: { w: 5, h: 1 },
  windmill: { w: 3, h: 3 },
}

// Height multipliers tuned so towers read as chunky landmarks rather than
// flagpoles. Anything over ~3.0 with a 2x2 footprint rendered as a stick.
const HEIGHT_MULT: Record<string, number> = {
  tower: 2.0, clock_tower: 2.4, bell_tower: 2.6, bell_tower_tall: 3.0,
  watchtower: 2.2, cathedral: 2.0, lighthouse: 3.0, chapel: 1.5,
  temple: 1.5, town_gate: 1.8, archway: 1.5, round_tower: 2.4,
}

function simpleHash(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Deterministic 0..1 pseudo-random from an integer hash and a salt. */
function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

// Big, grid-aligned, flat-roofed types stay on the grid so they still
// interlock cleanly — archways, walls, gates, staircases.
const NO_JITTER = new Set<string>([
  'archway', 'town_gate', 'gatehouse', 'staircase', 'aqueduct',
])

// Material cache — share materials across buildings with same facade config
const _wallMatCache = new Map<string, THREE.Material>()

export interface BuildingBatchResult {
  wallMeshes: THREE.Mesh[]       // individual (textured, emissive)
  batched: THREE.Mesh[]          // merged roof/detail/feature meshes
}

export function buildBuildingMeshes(
  objects: PlacedObject[],
  defMap: Map<string, ObjectDefinition>,
  palettes: { wall: number; roof: number; door: number }[],
  getHeight?: (x: number, z: number) => number
): BuildingBatchResult {
  const wallMeshes: THREE.Mesh[] = []
  const roofBatch = new BatchedMeshBuilder()
  const detailBatch = new BatchedMeshBuilder()

  for (const obj of objects) {
    const def = defMap.get(obj.definitionId)
    if (!def) continue

    const fp = FOOTPRINTS[obj.definitionId] || { w: def.footprint.w, h: def.footprint.h }
    const hash = simpleHash(obj.id)
    const floors = (obj.properties.floors as number) || 1 + (hash % 2)
    const heightMult = HEIGHT_MULT[obj.definitionId] ?? 1.0

    // Per-instance jitter so the town stops reading as a grid. Keyed off
    // the object id hash, so regenerating the same seed is stable.
    const jitter = !NO_JITTER.has(obj.definitionId)
    const hScale = jitter ? 0.85 + rand01(hash, 1) * 0.3 : 1.0          // 0.85–1.15
    const jitterDX = jitter ? (rand01(hash, 2) - 0.5) * 0.35 : 0         // ±0.175 tile
    const jitterDZ = jitter ? (rand01(hash, 3) - 0.5) * 0.35 : 0

    const wallH = floors * FLOOR_HEIGHT * heightMult * hScale
    const roofStyle = ROOF_STYLE[obj.definitionId] || 'gabled'
    const roofFrac = ROOF_FRACTION[roofStyle] ?? 0.3
    const roofH = wallH * roofFrac
    const palette = palettes[hash % palettes.length]
    const style = (obj.properties.style as string) || 'standard'
    const district = (obj.properties.district as string) || 'residential'

    // World position of building center (including terrain height + jitter)
    const centerTileX = obj.x + fp.w / 2
    const centerTileZ = obj.y + fp.h / 2
    const terrainH = getHeight ? getHeight(Math.floor(centerTileX), Math.floor(centerTileZ)) : 0
    const wx = centerTileX + jitterDX
    const wy = (obj.elevation || 0) + terrainH
    const wz = centerTileZ + jitterDZ

    // === WALL BODY — facade texture on front/back, plain on sides/top/bottom ===
    const facadeConfig = createFacadeConfig(obj, fp.w, palette, hash)
    const frontTex = createFacadeTexture(facadeConfig, 'front')

    // Cache materials — textured for front/back, plain for sides/top/bottom
    const matKey = `${facadeConfig.floors}_${facadeConfig.width}_${palette.wall.toString(16)}_${facadeConfig.hasTimber}_${facadeConfig.hasShutters}_${facadeConfig.hasFlowerBox}_${facadeConfig.style}`
    let facadeMat = _wallMatCache.get(matKey)
    if (!facadeMat) {
      facadeMat = new THREE.MeshLambertMaterial({ map: frontTex, flatShading: true })
      _wallMatCache.set(matKey, facadeMat)
    }
    const plainKey = `plain_${palette.wall.toString(16)}`
    let plainMat = _wallMatCache.get(plainKey)
    if (!plainMat) {
      plainMat = new THREE.MeshLambertMaterial({ color: palette.wall, flatShading: true })
      _wallMatCache.set(plainKey, plainMat)
    }
    // BoxGeometry groups: 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z(front), 5=-Z(back)
    const wallMats = [plainMat, plainMat, plainMat, plainMat, facadeMat, facadeMat]

    const hasOverhang = style === 'ornate' || obj.definitionId === 'half_timber' || obj.definitionId === 'balcony_house'
    if (hasOverhang && floors >= 2) {
      const groundH = FLOOR_HEIGHT * heightMult * hScale
      const groundGeo = new THREE.BoxGeometry(fp.w * 0.95, groundH, fp.h * 0.95)
      groundGeo.translate(wx, wy + groundH / 2, wz)
      const mesh1 = new THREE.Mesh(groundGeo, wallMats)
      mesh1.matrixAutoUpdate = false; mesh1.updateMatrix()
      wallMeshes.push(mesh1)

      const upperH = wallH - groundH
      const upperGeo = new THREE.BoxGeometry(fp.w * 1.02, upperH, fp.h * 1.02)
      upperGeo.translate(wx, wy + groundH + upperH / 2, wz)
      const mesh2 = new THREE.Mesh(upperGeo, wallMats)
      mesh2.matrixAutoUpdate = false; mesh2.updateMatrix()
      wallMeshes.push(mesh2)
    } else {
      const wallGeo = new THREE.BoxGeometry(fp.w, wallH, fp.h)
      wallGeo.translate(wx, wy + wallH / 2, wz)
      const mesh = new THREE.Mesh(wallGeo, wallMats)
      mesh.matrixAutoUpdate = false; mesh.updateMatrix()
      wallMeshes.push(mesh)
    }

    // === ROOF → batched ===
    if (roofStyle === 'pointed') {
      const r = Math.max(fp.w, fp.h) * 0.55
      const geo = new THREE.ConeGeometry(r, roofH, 4)
      geo.rotateY(Math.PI / 4)
      geo.translate(wx, wy + wallH + roofH / 2, wz)
      roofBatch.addPositioned(geo, palette.roof)
    } else if (roofStyle === 'dome') {
      const r = Math.max(fp.w, fp.h) * 0.45
      const geo = new THREE.SphereGeometry(r, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2)
      geo.scale(1, roofH / r, 1)
      geo.translate(wx, wy + wallH, wz)
      roofBatch.addPositioned(geo, palette.roof)
    } else if (roofStyle === 'gabled' || roofStyle === 'steep' || roofStyle === 'hipped') {
      const geo = createGabledRoof(fp.w, fp.h, roofH, roofStyle === 'hipped')
      geo.translate(wx, wy + wallH, wz)
      roofBatch.addPositioned(geo, palette.roof)
    }

    // === CHIMNEY → batched ===
    if (hash % 5 < 2 && roofH > 0) {
      const chimSide = (obj.properties.chimneyPos === 'left') ? -1 : 1
      const chimH = roofH * 0.8
      const geo = new THREE.BoxGeometry(0.2, chimH, 0.2)
      geo.translate(wx + chimSide * fp.w * 0.3, wy + wallH + roofH * 0.3 + chimH / 2, wz)
      detailBatch.addPositioned(geo, 0x704030)
    }

    // === FOUNDATION → batched ===
    if (district === 'noble' || district === 'temple' || style === 'ornate') {
      const geo = new THREE.BoxGeometry(fp.w + 0.1, 0.08, fp.h + 0.1)
      geo.translate(wx, wy + 0.04, wz)
      detailBatch.addPositioned(geo, 0x606060)
    }

    // === DOORSTEP → batched ===
    if (fp.w >= 2) {
      const geo = new THREE.BoxGeometry(0.5, 0.05, 0.15)
      geo.translate(wx, wy + 0.025, wz + fp.h / 2 + 0.08)
      detailBatch.addPositioned(geo, 0x808080)
    }

    // === CIRCULAR TOWER → batched ===
    if (obj.definitionId === 'tower' || obj.definitionId === 'watchtower' || obj.definitionId === 'round_tower') {
      const geo = new THREE.CylinderGeometry(fp.w * 0.45, fp.w * 0.48, wallH, 8)
      geo.translate(wx, wy + wallH / 2, wz)
      detailBatch.addPositioned(geo, palette.wall)
    }

    // === BAY WINDOW → batched ===
    if ((obj.definitionId === 'mansion' || obj.definitionId === 'guild_hall' || obj.definitionId === 'balcony_house') && floors >= 2) {
      const bayW = fp.w * 0.25, bayH = FLOOR_HEIGHT * 0.6, bayD = 0.3
      const bayY = FLOOR_HEIGHT * 1.3 * heightMult
      const geo = new THREE.BoxGeometry(bayW, bayH, bayD)
      geo.translate(wx + fp.w * 0.2, wy + bayY, wz + fp.h / 2 + bayD / 2)
      detailBatch.addPositioned(geo, palette.wall)
      const glassGeo = new THREE.BoxGeometry(bayW * 0.8, bayH * 0.7, 0.02)
      glassGeo.translate(wx + fp.w * 0.2, wy + bayY, wz + fp.h / 2 + bayD + 0.01)
      detailBatch.addPositioned(glassGeo, 0x405060)
    }

    // === ARCHWAY → batched ===
    if (obj.definitionId === 'archway' || obj.definitionId === 'town_gate' || obj.definitionId === 'gatehouse') {
      const pillarW = 0.3, archH = wallH * 0.7, archW = fp.w * 0.5
      const lp = new THREE.BoxGeometry(pillarW, archH, fp.h)
      lp.translate(wx - archW / 2 - pillarW / 2, wy + archH / 2, wz)
      detailBatch.addPositioned(lp, palette.wall)
      const rp = new THREE.BoxGeometry(pillarW, archH, fp.h)
      rp.translate(wx + archW / 2 + pillarW / 2, wy + archH / 2, wz)
      detailBatch.addPositioned(rp, palette.wall)
      const at = new THREE.CylinderGeometry(archW / 2, archW / 2, fp.h, 8, 1, false, 0, Math.PI)
      at.rotateX(Math.PI / 2); at.rotateZ(Math.PI)
      at.translate(wx, wy + archH, wz)
      detailBatch.addPositioned(at, palette.wall)
    }

    // === COLONNADE → batched ===
    if ((obj.definitionId === 'temple' || obj.definitionId === 'cathedral' || obj.definitionId === 'guild_hall') && fp.w >= 4) {
      const colH = wallH * 0.85
      const numCols = Math.floor(fp.w / 1.2)
      const spacing = fp.w / (numCols + 1)
      for (let ci = 1; ci <= numCols; ci++) {
        const cg = new THREE.CylinderGeometry(0.085, 0.1, colH, 6)
        cg.translate(wx - fp.w / 2 + ci * spacing, wy + colH / 2, wz + fp.h / 2 + 0.25)
        detailBatch.addPositioned(cg, 0xc0b8a8)
      }
      const bg = new THREE.BoxGeometry(fp.w + 0.2, 0.12, 0.25)
      bg.translate(wx, wy + colH + 0.06, wz + fp.h / 2 + 0.25)
      detailBatch.addPositioned(bg, 0xc0b8a8)
    }

    // === BALCONY → batched ===
    if ((obj.definitionId === 'balcony_house' || obj.definitionId === 'inn') && floors >= 2) {
      const balcW = fp.w * 0.5, balcD = 0.4
      const balcY = FLOOR_HEIGHT * 1.1 * heightMult
      const pg = new THREE.BoxGeometry(balcW, 0.06, balcD)
      pg.translate(wx, wy + balcY, wz + fp.h / 2 + balcD / 2)
      detailBatch.addPositioned(pg, 0x705a40)
      const rg = new THREE.BoxGeometry(balcW, 0.25, 0.04)
      rg.translate(wx, wy + balcY + 0.15, wz + fp.h / 2 + balcD)
      detailBatch.addPositioned(rg, 0x705a40)
      for (const side of [-balcW * 0.35, balcW * 0.35]) {
        const bg = new THREE.BoxGeometry(0.06, 0.2, balcD * 0.7)
        bg.translate(wx + side, wy + balcY - 0.1, wz + fp.h / 2 + balcD * 0.4)
        detailBatch.addPositioned(bg, 0x705a40)
      }
    }
  }

  // Build batched meshes
  const batched: THREE.Mesh[] = []
  const roofMesh = roofBatch.build()
  if (roofMesh) batched.push(roofMesh)
  const detailMesh = detailBatch.build()
  if (detailMesh) batched.push(detailMesh)

  return { wallMeshes, batched }
}

/** Create a gabled/hipped roof as BufferGeometry */
function createGabledRoof(w: number, d: number, h: number, hipped: boolean): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2
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
    const verts = new Float32Array([
      -ow, 0, -od,  ow, 0, -od,  0, h, -od,
      ow, 0, od,  -ow, 0, od,  0, h, od,
      -ow, 0, od,  -ow, 0, -od,  0, h, -od,
      -ow, 0, od,  0, h, -od,  0, h, od,
      ow, 0, -od,  ow, 0, od,  0, h, od,
      ow, 0, -od,  0, h, od,  0, h, -od,
    ])
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
    geo.computeVertexNormals()
    return geo
  }
}
