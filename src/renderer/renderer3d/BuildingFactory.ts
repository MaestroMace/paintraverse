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
import { BatchedMeshBuilder } from './BatchedMeshBuilder'
import { buildingStyleVector, pickArchetypes } from './architecture'
import type { DistrictId } from './architecture'
import { pickMassing, rotateVolume } from './architecture/Massing'
import { emitVolume, setWallEmissiveIntensity as setVolumeEmissiveIntensity } from './architecture/VolumeRenderer'
import { pickPaletteForStyle } from './architecture/PaletteBias'

/** Re-export so ThreeRenderer can keep importing from BuildingFactory. */
export const setWallEmissiveIntensity = setVolumeEmissiveIntensity

const VALID_DISTRICTS: Set<string> = new Set([
  'market', 'residential', 'artisan', 'noble', 'waterfront',
  'temple', 'slum', 'garden', 'harbor', 'fortress', 'cemetery',
])

const FLOOR_HEIGHT = 1.05

// Districts where buildings should read as urban — taller floor counts.
const URBAN_DISTRICTS = new Set<string>([
  'residential', 'market', 'artisan', 'noble',
])

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
  // Town-wall variants: horizontal runs 2x1, vertical runs 1x2.
  stone_wall: { w: 2, h: 1 }, stone_wall_v: { w: 1, h: 2 },
  crenellated_wall: { w: 2, h: 1 },
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
  'stone_wall', 'stone_wall_v', 'crenellated_wall',
])

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
  const ornamentBatch = new BatchedMeshBuilder()

  for (const obj of objects) {
    const def = defMap.get(obj.definitionId)
    if (!def) continue

    const fp = FOOTPRINTS[obj.definitionId] || { w: def.footprint.w, h: def.footprint.h }
    const hash = simpleHash(obj.id)
    const style = (obj.properties.style as string) || 'standard'
    const district = (obj.properties.district as string) || 'residential'

    // Floor count: generator-provided value wins, but otherwise bias urban
    // districts taller (2–4) and rural/fringe shorter (1–2). narrow_house is
    // always tall regardless of district (it's meant to read as a Traverse-
    // Town-style tall-narrow house). This is the biggest lever for aspect
    // ratio — a 2×2×3-floor building stops looking like a cube.
    let floors: number
    if (typeof obj.properties.floors === 'number') {
      floors = obj.properties.floors as number
    } else if (obj.definitionId === 'narrow_house') {
      floors = 3 + (hash % 2) // 3 or 4
    } else if (URBAN_DISTRICTS.has(district)) {
      floors = 2 + (hash % 3) // 2, 3, or 4
    } else {
      floors = 1 + (hash % 2) // 1 or 2
    }

    const heightMult = HEIGHT_MULT[obj.definitionId] ?? 1.0

    // Per-instance jitter so the town stops reading as a grid. Keyed off
    // the object id hash, so regenerating the same seed is stable.
    const jitter = !NO_JITTER.has(obj.definitionId)
    const hScale = jitter ? 0.85 + rand01(hash, 1) * 0.3 : 1.0          // 0.85–1.15
    const jitterDX = jitter ? (rand01(hash, 2) - 0.5) * 0.35 : 0         // ±0.175 tile
    const jitterDZ = jitter ? (rand01(hash, 3) - 0.5) * 0.35 : 0

    const wallH = floors * FLOOR_HEIGHT * heightMult * hScale

    // World position of building center. Sample terrain height across
    // EVERY footprint tile and use the max so the building sits on the
    // highest ground covered; the min is used to size a foundation plinth
    // that fills the gap over lower tiles. Fixes "hovering over low tiles"
    // for multi-tile buildings.
    //
    // We *ignore* obj.elevation when getHeight is available: the generator
    // stored elevation in raw heightMap units (0..2.5) whereas terrainH is
    // in scaled world units, so adding them double-counts the terrain.
    const centerTileX = obj.x + fp.w / 2
    const centerTileZ = obj.y + fp.h / 2
    let maxTH = 0, minTH = Infinity
    if (getHeight) {
      for (let fy = 0; fy < fp.h; fy++) {
        for (let fx = 0; fx < fp.w; fx++) {
          const th = getHeight(obj.x + fx, obj.y + fy)
          if (th > maxTH) maxTH = th
          if (th < minTH) minTH = th
        }
      }
    } else {
      minTH = 0
    }
    if (!isFinite(minTH)) minTH = 0
    const wx = centerTileX + jitterDX
    const wy = getHeight ? maxTH : (obj.elevation || 0)
    const wz = centerTileZ + jitterDZ

    // Foundation plinth — fills the space between the lowest footprint tile
    // and the building's base so multi-tile buildings on uneven ground look
    // planted on a stone ledge, not floating above empty air. Applies to
    // walls and gates too (they still need the plinth on slopes).
    const plinthH = maxTH - minTH
    if (plinthH > 0.08) {
      const plinth = new THREE.BoxGeometry(fp.w + 0.12, plinthH, fp.h + 0.12)
      plinth.translate(centerTileX, minTH + plinthH / 2, centerTileZ)
      detailBatch.addPositioned(plinth, 0x6a5a48) // stone foundation
    }

    // === PARAMETRIC MASSING ===
    // The style vector drives a weighted blend of archetypes; pickMassing
    // then chooses a massing template (body + tower, L-shape, jetty, spire,
    // nave-transept, cottage-plus-chimney, etc.) and emits Volume[] which
    // we render one at a time. Buildings are no longer single boxes.
    const districtId: DistrictId = VALID_DISTRICTS.has(district)
      ? (district as DistrictId) : 'residential'
    const styleVector = buildingStyleVector(districtId, hash)
    const picks = pickArchetypes(districtId, hash)
    const dominantArchetype = picks[0]?.id ?? 'traverseCozy'
    const palette = pickPaletteForStyle(palettes, styleVector, hash)

    const massing = pickMassing({
      definitionId: obj.definitionId,
      dominantArchetype,
      sv: styleVector,
      hash,
      footW: fp.w, footD: fp.h,
      wallH, floors,
      wallColor: palette.wall, roofColor: palette.roof,
    })

    // Building rotation — 0/90/180/270°. Square footprints can rotate
    // any quarter-turn; rectangular footprints only flip 0/180 so they
    // still fit the grid cell assigned by TownGenerator. Skipped for
    // NO_JITTER types (gates, staircases) so they still interlock.
    let rotSteps = 0
    if (!NO_JITTER.has(obj.definitionId)) {
      rotSteps = fp.w === fp.h ? (hash % 4) : ((hash % 2) * 2)
    }
    if (rotSteps !== 0) {
      massing.volumes = massing.volumes.map(v => rotateVolume(v, rotSteps))
    }

    // Wealth-driven size scaling — slums shrink to 0.78x, palatial buildings
    // grow to 1.22x. Signature landmark buildings ALSO get a flat +25–40%
    // scale bump on top so they visibly dominate their districts. Applied to
    // every volume in place (width, depth, height, offsets, roofHeight,
    // bottomY). Slight inter-tile overlap is fine; it actually helps the town
    // feel less like a checkerboard.
    const wealthScale = 0.78 + styleVector.wealth * 0.44
    const landmarkScale =
      obj.definitionId === 'cathedral' ? 1.35 :
      obj.definitionId === 'temple' ? 1.3 :
      obj.definitionId === 'bell_tower_tall' ? 1.25 :
      obj.definitionId === 'bell_tower' ? 1.2 :
      obj.definitionId === 'clock_tower' ? 1.2 :
      obj.definitionId === 'lighthouse' ? 1.2 :
      obj.definitionId === 'mansion' ? 1.18 :
      obj.definitionId === 'guild_hall' ? 1.15 :
      obj.definitionId === 'watchtower' ? 1.15 :
      1.0
    const sizeScale = wealthScale * landmarkScale
    if (Math.abs(sizeScale - 1.0) > 0.02 && !NO_JITTER.has(obj.definitionId)) {
      massing.volumes = massing.volumes.map(v => ({
        ...v,
        width: v.width * sizeScale,
        depth: v.depth * sizeScale,
        offsetX: v.offsetX * sizeScale,
        offsetZ: v.offsetZ * sizeScale,
        height: v.height * sizeScale,
        roofHeight: v.roofHeight * sizeScale,
        bottomY: v.bottomY * sizeScale,
      }))
    }

    const emitCtx = {
      centerX: wx,
      centerZ: wz,
      baseY: wy,
      hasTimber: !!obj.properties.hasTimber || hash % 3 === 0,
      hasShutters: !!obj.properties.hasShutters || hash % 4 !== 0,
      hasFlowerBox: !!obj.properties.hasFlowerBox,
      style,
      palette,
      rotationY: 0,
      hash,
      weather: styleVector.weather,
    }
    for (const vol of massing.volumes) {
      emitVolume(vol, emitCtx, wallMeshes, roofBatch, ornamentBatch)
    }

    // Approximate mainBody roof top for chimney + ornament placement.
    const mainVol = massing.volumes[0]
    const mainTopY = wy + (mainVol.bottomY ?? 0) + mainVol.height
    const mainRoofH = mainVol.roofHeight
    // Does massing already include a chimney volume? (cottageSmall does.)
    const massingHasChimney = massing.volumes.some(v => v.role === 'chimneyVol')

    // === CHIMNEYS → batched ===
    // Skip entirely if massing already supplies a chimney volume.
    // Big/tall buildings (floors >= 3 or wealth archetype) get two chimneys.
    if (!massingHasChimney && hash % 5 < 2 && mainRoofH > 0) {
      // Clamp chimney height to a fixed range (0.5–0.9 world units) so the
      // scaling stopped producing 2-4 world unit black sticks once wallH
      // doubled. Width bumped to 0.3 so they read as stacks, not sticks.
      const chimCount = (floors >= 3 || styleVector.wealth > 0.6) ? 2 : 1
      const baseH = 0.55 + rand01(hash, 701) * 0.3  // 0.55–0.85
      const chimW = 0.3
      for (let c = 0; c < chimCount; c++) {
        const chimSide = c === 0
          ? ((obj.properties.chimneyPos === 'left') ? -1 : 1)
          : (((obj.properties.chimneyPos === 'left') ? 1 : -1))
        const chimH = baseH * (c === 0 ? 1.0 : 0.85)
        // Main stack
        const stack = new THREE.BoxGeometry(chimW, chimH, chimW)
        stack.translate(
          wx + chimSide * fp.w * 0.3,
          mainTopY + mainRoofH * 0.3 + chimH / 2,
          wz + (c === 0 ? 0 : (rand01(hash, 600 + c) - 0.5) * fp.h * 0.4),
        )
        detailBatch.addPositioned(stack, 0x704030)
        // Cap (slightly wider thin disc)
        const cap = new THREE.BoxGeometry(chimW + 0.12, 0.08, chimW + 0.12)
        cap.translate(
          wx + chimSide * fp.w * 0.3,
          mainTopY + mainRoofH * 0.3 + chimH + 0.04,
          wz + (c === 0 ? 0 : (rand01(hash, 600 + c) - 0.5) * fp.h * 0.4),
        )
        detailBatch.addPositioned(cap, 0x5a3020)
      }
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

    // Circular tower, bay window, and archway specialty blocks moved to
    // architecture/Massing.ts (tmplCircularTower / tmplGatehouse /
    // tmplStepBack-and-friends produce the projecting bays).

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

    // (Per-volume cornice is emitted inside emitVolume; nothing further
    // needed here. Style-driven roof dormers and window trim are deferred
    // until camera angle / render scale let them read visibly.)
  }

  // Build batched meshes
  const batched: THREE.Mesh[] = []
  const roofMesh = roofBatch.build()
  if (roofMesh) batched.push(roofMesh)
  const detailMesh = detailBatch.build()
  if (detailMesh) batched.push(detailMesh)
  const ornamentMesh = ornamentBatch.build()
  if (ornamentMesh) {
    // Ornaments are thin geometry — self-shadowing acne under CSM looks
    // worse than the silhouette-depth gain, so disable casting. Still receive.
    ornamentMesh.castShadow = false
    ornamentMesh.receiveShadow = true
    batched.push(ornamentMesh)
  }

  return { wallMeshes, batched }
}
