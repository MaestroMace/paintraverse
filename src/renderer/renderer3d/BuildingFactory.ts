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
import { pickMassing } from './architecture/Massing'
import { emitVolume, setWallEmissiveIntensity as setVolumeEmissiveIntensity } from './architecture/VolumeRenderer'
import { pickPaletteForStyle } from './architecture/PaletteBias'

/** Re-export so ThreeRenderer can keep importing from BuildingFactory. */
export const setWallEmissiveIntensity = setVolumeEmissiveIntensity

const VALID_DISTRICTS: Set<string> = new Set([
  'market', 'residential', 'artisan', 'noble', 'waterfront',
  'temple', 'slum', 'garden', 'harbor', 'fortress', 'cemetery',
])

// World units per building floor. Previous 1.05 made a 2-story building
// only 2.1m tall — roughly the player's eye height — which read as the
// player towering over a toy town ("kaiju" scale). Bumped to 1.8 so a
// 2-story is a comfortable 3.6m and a 3-story is 5.4m, letting the player
// feel inside the architecture rather than above it.
const FLOOR_HEIGHT = 1.8

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

    // Continuous Y rotation per building — computed once and applied to
    // the plinth, chimneys, and all volumes so they rotate as a unit.
    // Amplitude scales with footprint aspect so long narrow buildings
    // don't diagonal-overflow their grid slot catastrophically.
    let rotationY = 0
    if (!NO_JITTER.has(obj.definitionId)) {
      const aspect = Math.min(fp.w, fp.h) / Math.max(fp.w, fp.h)
      const maxRot = aspect * 0.5                              // ~28° for square
      rotationY = (rand01(hash, 6) - 0.5) * 2 * maxRot
      if (rand01(hash, 7) < 0.25) rotationY = 0                // 25% stay aligned
    }

    // Foundation plinth — emitted as per-tile stone columns so the foundation
    // STEPS with the terrain rather than sitting as one flat block. Each
    // footprint tile gets its own column from that tile's ground up to the
    // building's base (maxTH). Tiles already at maxTH get no column.
    // Columns overlap slightly (1.08 vs 1.0) so interior seams don't z-fight
    // and outer edges extend past the wall face, matching the old plinth's
    // +0.06 overhang on each side.
    if (getHeight && maxTH - minTH > 0.08) {
      const cos = Math.cos(rotationY), sin = Math.sin(rotationY)
      for (let fy = 0; fy < fp.h; fy++) {
        for (let fx = 0; fx < fp.w; fx++) {
          const tileGround = getHeight(obj.x + fx, obj.y + fy)
          const colH = maxTH - tileGround
          if (colH < 0.08) continue
          // Tile-local offset from building center, then rotate by rotationY.
          const lx = fx - fp.w / 2 + 0.5
          const lz = fy - fp.h / 2 + 0.5
          const rx = lx * cos - lz * sin
          const rz = lx * sin + lz * cos
          const col = new THREE.BoxGeometry(1.08, colH, 1.08)
          if (rotationY !== 0) col.rotateY(rotationY)
          col.translate(
            centerTileX + rx,
            tileGround + colH / 2,
            centerTileZ + rz,
          )
          detailBatch.addPositioned(col, 0x6a5a48) // stone foundation
        }
      }
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

    // (rotationY already computed above — before plinth emission — so
    // the plinth rotates with the building. Reused here for the volume
    // loop and emitCtx below.)

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
      rotationY,
      hash,
      weather: styleVector.weather,
    }
    for (const vol of massing.volumes) {
      emitVolume(vol, emitCtx, wallMeshes, roofBatch, ornamentBatch)
    }

    // Approximate mainBody roof top for chimney + ornament placement.
    // Prefer the first 'mainBody' volume so chimneys don't float above
    // a tiny corner-tower sub-volume when the massing template puts
    // the body second.
    const mainVol = massing.volumes.find(v => v.role === 'mainBody') ?? massing.volumes[0]
    const mainTopY = wy + (mainVol.bottomY ?? 0) + mainVol.height
    const mainRoofH = mainVol.roofHeight
    // Does massing already include a chimney volume? (cottageSmall does.)
    const massingHasChimney = massing.volumes.some(v => v.role === 'chimneyVol')

    // === CHIMNEYS → batched ===
    // Skip entirely if massing already supplies a chimney volume.
    // Big/tall buildings (floors >= 3 or wealth archetype) get two chimneys.
    if (!massingHasChimney && hash % 5 < 2 && mainRoofH > 0) {
      // Chimney stacks with deliberate whimsical variety — brick stacks on
      // small houses, the occasional tall crooked flue, the rare copper-top
      // or double-stack. Hash picks the variant so regenerating the seed
      // gives the same silhouette.
      const variant = hash % 7
      // Variant 0,1,2 — stocky single; 3 — double stack; 4 — tall whimsy;
      // 5 — copper-top; 6 — wide short.
      const chimCount = (floors >= 3 || styleVector.wealth > 0.6) ? 2
                      : variant === 3 ? 2
                      : 1
      // Height/width picked per variant so silhouettes read distinctly.
      const baseH = variant === 4 ? 1.2 + rand01(hash, 701) * 0.8     // 1.2–2.0 (tall whimsy)
                  : variant === 6 ? 0.35 + rand01(hash, 701) * 0.1    // short chubby
                  : 0.5 + rand01(hash, 701) * 0.35                    // default 0.5–0.85
      const chimW = variant === 6 ? 0.7 : variant === 4 ? 0.42 : 0.5
      const capColor = variant === 5 ? 0x4a7870 /* verdigris copper */ : 0x5a3020
      for (let c = 0; c < chimCount; c++) {
        const chimSide = c === 0
          ? ((obj.properties.chimneyPos === 'left') ? -1 : 1)
          : (((obj.properties.chimneyPos === 'left') ? 1 : -1))
        const chimH = baseH * (c === 0 ? 1.0 : 0.75 + rand01(hash, 711 + c) * 0.15)
        // Local offset from building center; random Z so double stacks
        // aren't perfectly in line.
        const localX = chimSide * fp.w * 0.32
        const localZ = c === 0
          ? (rand01(hash, 703) - 0.5) * fp.h * 0.25
          : (rand01(hash, 600 + c) - 0.5) * fp.h * 0.4
        // Small lean on the tall whimsy variant — reads as a crooked flue.
        const leanZ = variant === 4 ? (rand01(hash, 719) - 0.5) * 0.25 : 0
        const stack = new THREE.BoxGeometry(chimW, chimH, chimW)
        if (leanZ !== 0) stack.rotateZ(leanZ)
        stack.translate(localX, 0, localZ)
        if (rotationY !== 0) stack.rotateY(rotationY)
        // Anchor to the mainBody roof peak (mainTopY) — not the wider roof
        // height — so chimneys don't float above tiny sub-volumes.
        stack.translate(wx, mainTopY + mainRoofH * 0.4 + chimH / 2, wz)
        detailBatch.addPositioned(stack, 0x704030)
        const capW = variant === 6 ? 0.85 : chimW + 0.12
        const cap = new THREE.BoxGeometry(capW, 0.12, capW)
        cap.translate(localX, 0, localZ)
        if (rotationY !== 0) cap.rotateY(rotationY)
        cap.translate(wx, mainTopY + mainRoofH * 0.4 + chimH + 0.06, wz)
        detailBatch.addPositioned(cap, capColor)
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
