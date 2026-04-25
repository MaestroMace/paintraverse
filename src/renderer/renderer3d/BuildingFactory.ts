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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { ObjectDefinition, PlacedObject } from '../core/types'
import { BatchedMeshBuilder } from './BatchedMeshBuilder'
import { buildingStyleVector, pickArchetypes } from './architecture'
import type { DistrictId } from './architecture'
import { pickMassing } from './architecture/Massing'
import { emitVolume, localToWorld, setWallEmissiveIntensity as setVolumeEmissiveIntensity } from './architecture/VolumeRenderer'
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

    // Organic lean — small tilts that pivot around the building base, so
    // a 4-story house leans forward up to ~12cm at the cornice. Pisa-style
    // is a bug; medieval-settled is the goal. Amplitude scales with weather
    // and is gated to ~22% of buildings so the average street isn't tilted
    // — just enough that the eye finds a few lopsided neighbors per block.
    // Towers/walls/gates stay vertical (NO_JITTER) — they'd read as broken
    // landmarks rather than charming-old. Cathedrals & towers also opt out
    // because the silhouette is meant to read as authoritative.
    let leanX = 0, leanZ = 0
    const isLandmark =
      obj.definitionId === 'cathedral' || obj.definitionId === 'temple' ||
      obj.definitionId === 'bell_tower' || obj.definitionId === 'bell_tower_tall' ||
      obj.definitionId === 'clock_tower' || obj.definitionId === 'lighthouse' ||
      obj.definitionId === 'tower' || obj.definitionId === 'watchtower' ||
      obj.definitionId === 'round_tower' || obj.definitionId === 'windmill'
    if (!NO_JITTER.has(obj.definitionId) && !isLandmark && rand01(hash, 401) < 0.22) {
      // Bias forward (toward the street, +Z in local frame) — that's the
      // silhouette reading. Sideways component is smaller. Max ~3.4° forward,
      // ~2° sideways. Weather scales it up; pristine wealthy buildings stay
      // upright more often.
      const weather = styleVector.weather
      const ageScale = 0.35 + weather * 0.65                   // 0.35..1.0
      // leanX rotates around X — so a positive leanX tips the building's TOP
      // forward toward +Z. That's the "bowed toward the street" look.
      leanX = (rand01(hash, 403) * 0.4 + 0.2) * 0.06 * ageScale  // 0.012..0.036 rad
      // Sideways tilt smaller and either direction.
      leanZ = (rand01(hash, 405) - 0.5) * 0.07 * ageScale        // ±0.024 rad
      // Half the leaners tip *away* from the street instead, so the row
      // doesn't all bow forward in unison.
      if (rand01(hash, 407) < 0.5) leanX = -leanX
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

    // Short 1-story buildings don't contribute meaningfully to the dusk
    // silhouette shadows — their 1.8m shadow is quickly lost under
    // neighboring props and ground shading. Exclude them from shadow
    // casting to halve the caster count in the shadow frustum (biggest
    // single draw-call sink was the shadow pass iterating every wall).
    const castsShadow = floors >= 2
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
      leanX,
      leanZ,
      hash,
      weather: styleVector.weather,
      castsShadow,
    }
    for (const vol of massing.volumes) {
      emitVolume(vol, emitCtx, wallMeshes, roofBatch, ornamentBatch)
    }

    // Approximate mainBody roof top for chimney + ornament placement.
    // Prefer the first 'mainBody' volume so chimneys don't float above
    // a tiny corner-tower sub-volume when the massing template puts
    // the body second.
    const mainVol = massing.volumes.find(v => v.role === 'mainBody') ?? massing.volumes[0]
    const mainLocalTopY = (mainVol.bottomY ?? 0) + mainVol.height
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
      // Local Y of chimney base (above the mainBody roof base). Building lean
      // pivots around (wx, wy, wz), so anchoring at this local Y means the
      // chimney follows the leaning building correctly.
      const chimBaseLocalY = mainLocalTopY + mainRoofH * 0.4
      for (let c = 0; c < chimCount; c++) {
        const chimSide = c === 0
          ? ((obj.properties.chimneyPos === 'left') ? -1 : 1)
          : (((obj.properties.chimneyPos === 'left') ? 1 : -1))
        const chimH = baseH * (c === 0 ? 1.0 : 0.75 + rand01(hash, 711 + c) * 0.15)
        const localX = chimSide * fp.w * 0.32
        const localZ = c === 0
          ? (rand01(hash, 703) - 0.5) * fp.h * 0.25
          : (rand01(hash, 600 + c) - 0.5) * fp.h * 0.4
        // Small Z-tilt on the tall whimsy variant — crooked flue look.
        const flueLeanZ = variant === 4 ? (rand01(hash, 719) - 0.5) * 0.25 : 0
        const stack = new THREE.BoxGeometry(chimW, chimH, chimW)
        if (flueLeanZ !== 0) stack.rotateZ(flueLeanZ)
        stack.translate(0, chimH / 2, 0)
        localToWorld(stack, localX, chimBaseLocalY, localZ, leanX, leanZ, rotationY, wx, wy, wz)
        detailBatch.addPositioned(stack, 0x704030)
        const capW = variant === 6 ? 0.85 : chimW + 0.12
        const cap = new THREE.BoxGeometry(capW, 0.12, capW)
        localToWorld(cap, localX, chimBaseLocalY + chimH + 0.06, localZ, leanX, leanZ, rotationY, wx, wy, wz)
        detailBatch.addPositioned(cap, capColor)
      }
    }

    // === CORNER TIMBER POSTS / QUOINS → ornament-batched ===
    // Vertical wood posts at corners on tudor/half-timber buildings, OR
    // alternating corner stones on stone-dominated noble/gothic buildings.
    // Mutually exclusive (a building reads as either timber-framed OR stone,
    // not both). Both detail types iterate over EVERY body volume — so an
    // L-shape gets posts on the wing, a jettied upper floor gets posts at
    // its corners floating above the lower wall (iconic Tudor), and a
    // step-back penthouse gets quoins on its smaller upper block.
    //
    // Roles to detail: mainBody, wing, upperFloor, transept, penthouse, tower
    //   — not spire (too narrow), porch (3-walled), chimneyVol.
    const wantsTimberPosts = (
      dominantArchetype === 'halfTimberTudor' ||
      styleVector.timber > 0.55
    ) && !NO_JITTER.has(obj.definitionId)
    const wantsQuoins = !wantsTimberPosts &&
      (styleVector.stone > 0.6 || dominantArchetype === 'nobleStone' || dominantArchetype === 'gothicStone') &&
      !NO_JITTER.has(obj.definitionId)
    const cornerableRoles = new Set(['mainBody', 'wing', 'upperFloor', 'transept', 'penthouse', 'tower'])

    if (wantsTimberPosts || wantsQuoins) {
      const postT = 0.13
      const projOut = postT * 0.45  // post outward shift so it rests ON the wall face
      const quoinW = 0.22, quoinH = 0.34, quoinProj = 0.05

      for (const v of massing.volumes) {
        if (v.circular) continue
        if (!cornerableRoles.has(v.role)) continue
        // Tower-role can be very tall; quoins still look right on stone towers.
        // But timber posts on a 6m tower would read as a giant pole, so skip.
        if (wantsTimberPosts && v.role === 'tower') continue
        if (wantsTimberPosts && v.height < 1.4) continue
        if (wantsQuoins && v.height < 1.6) continue

        const halfW = v.width / 2
        const halfD = v.depth / 2
        const baseLocalY = v.bottomY ?? 0

        if (wantsTimberPosts) {
          const postH = v.height
          const corners: Array<[number, number]> = [
            [v.offsetX + halfW + projOut, v.offsetZ + halfD + projOut],
            [v.offsetX + halfW + projOut, v.offsetZ - halfD - projOut],
            [v.offsetX - halfW - projOut, v.offsetZ + halfD + projOut],
            [v.offsetX - halfW - projOut, v.offsetZ - halfD - projOut],
          ]
          for (const [px, pz] of corners) {
            const post = new THREE.BoxGeometry(postT, postH, postT)
            post.translate(0, postH / 2, 0)
            localToWorld(post, px, baseLocalY, pz, leanX, leanZ, rotationY, wx, wy, wz)
            ornamentBatch.addPositioned(post, 0x3a2418) // dark oak
          }
          // Head-plate beam wrapping the front+back of this volume just below
          // the cornice. Skip if a heavy cornice will paint over it.
          const beamY = baseLocalY + postH - 0.08 - postT / 2
          const beamCovered = v.cornice && (v.role === 'tower' || v.role === 'spire')
          if (!beamCovered) {
            const beamProj = postT * 0.35
            const beamFront = new THREE.BoxGeometry(v.width + postT * 2, 0.10, beamProj)
            localToWorld(beamFront, v.offsetX, beamY,
              v.offsetZ + halfD + beamProj / 2 + projOut,
              leanX, leanZ, rotationY, wx, wy, wz)
            ornamentBatch.addPositioned(beamFront, 0x3a2418)
            const beamBack = new THREE.BoxGeometry(v.width + postT * 2, 0.10, beamProj)
            localToWorld(beamBack, v.offsetX, beamY,
              v.offsetZ - halfD - beamProj / 2 - projOut,
              leanX, leanZ, rotationY, wx, wy, wz)
            ornamentBatch.addPositioned(beamBack, 0x3a2418)
          }
        } else {
          // Quoins
          const wallR = (v.wallColor >> 16) & 0xff
          const lighten = wallR < 180
          const quoinColor = lighten ? 0xc8b89a : 0x6a5a48
          const corners: Array<[number, number]> = [
            [v.offsetX + halfW, v.offsetZ + halfD],
            [v.offsetX + halfW, v.offsetZ - halfD],
            [v.offsetX - halfW, v.offsetZ + halfD],
            [v.offsetX - halfW, v.offsetZ - halfD],
          ]
          const stackCount = Math.min(7, Math.max(3, Math.floor(v.height / 0.55)))
          const stackPitch = (v.height * 0.86) / stackCount
          for (const [cornerX, cornerZ] of corners) {
            const xSign = Math.sign(cornerX - v.offsetX) || 1
            const zSign = Math.sign(cornerZ - v.offsetZ) || 1
            for (let s = 0; s < stackCount; s++) {
              const centerLy = baseLocalY + 0.05 + s * stackPitch + quoinH / 2
              const onX = s % 2 === 0
              const q = onX
                ? new THREE.BoxGeometry(quoinW + quoinProj, quoinH, quoinW)
                : new THREE.BoxGeometry(quoinW, quoinH, quoinW + quoinProj)
              const lx = onX ? cornerX + xSign * quoinProj / 2 : cornerX
              const lz = onX ? cornerZ : cornerZ + zSign * quoinProj / 2
              localToWorld(q, lx, centerLy, lz, leanX, leanZ, rotationY, wx, wy, wz)
              ornamentBatch.addPositioned(q, quoinColor)
            }
          }
        }
      }
    }

    // === DRAINPIPE → batched ===
    // Thin vertical cylinder running from near the eave down to the ground
    // at one corner of the mainBody. Major "lived-in" cue at distance —
    // every old town has these dark iron/copper streaks against pale walls.
    // Skip on landmarks (cathedrals, towers) and on timber-post buildings
    // (the post would clash with the pipe).
    const wantsDrainpipe = !isLandmark && !wantsTimberPosts &&
      !mainVol.circular && !NO_JITTER.has(obj.definitionId) &&
      mainVol.height > 1.8 && rand01(hash, 901) < 0.32
    if (wantsDrainpipe) {
      const pipeR = 0.04
      const baseLocalY = mainVol.bottomY ?? 0
      // Run from ~12cm below cornice to the ground.
      const pipeTop = baseLocalY + mainVol.height - 0.12
      const pipeBottom = 0  // building base
      const pipeH = pipeTop - pipeBottom
      if (pipeH > 1.0) {
        // Pick one corner — biased toward the FRONT (+Z) face since that's
        // where the player most often sees the building.
        const xSide = rand01(hash, 903) < 0.5 ? -1 : 1
        const zSide = rand01(hash, 905) < 0.65 ? 1 : -1   // 65% front
        const cornerX = mainVol.offsetX + xSide * (mainVol.width / 2 + pipeR * 0.6)
        const cornerZ = mainVol.offsetZ + zSide * (mainVol.depth / 2 + pipeR * 0.6)
        const pipe = new THREE.CylinderGeometry(pipeR, pipeR, pipeH, 6)
        pipe.translate(0, pipeH / 2, 0)
        localToWorld(pipe, cornerX, pipeBottom, cornerZ,
          leanX, leanZ, rotationY, wx, wy, wz)
        // Verdigris copper or dark iron — pick from style.
        const pipeColor = styleVector.wealth > 0.5 ? 0x4a6a5a : 0x2a241e
        detailBatch.addPositioned(pipe, pipeColor)
        // Small horizontal collar near the top — implies a gutter elbow.
        const collar = new THREE.BoxGeometry(pipeR * 3.2, 0.06, pipeR * 1.5)
        // Project the collar slightly toward the wall edge (against zSide).
        localToWorld(collar, cornerX - xSide * pipeR * 0.6, pipeTop - 0.04, cornerZ - zSide * pipeR * 0.4,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(collar, pipeColor)
      }
    }

    // === FOUNDATION → batched ===
    // Goes through localToWorld so it follows yaw (lean intentionally not
    // applied — the foundation slab is a ground feature; if the building
    // tips, the slab stays planted on the terrain). leanX/leanZ = 0 here.
    if (district === 'noble' || district === 'temple' || style === 'ornate') {
      const geo = new THREE.BoxGeometry(fp.w + 0.1, 0.08, fp.h + 0.1)
      localToWorld(geo, 0, 0.04, 0, 0, 0, rotationY, wx, wy, wz)
      detailBatch.addPositioned(geo, 0x606060)
    }

    // === DOORSTEP → batched ===
    // Front-face doorstep — also a ground feature, no lean (a building tips
    // but its threshold stays flat) but does follow yaw so the step lands on
    // the rotated +Z face.
    if (fp.w >= 2) {
      const geo = new THREE.BoxGeometry(0.5, 0.05, 0.15)
      localToWorld(geo, 0, 0.025, fp.h / 2 + 0.08, 0, 0, rotationY, wx, wy, wz)
      detailBatch.addPositioned(geo, 0x808080)
    }

    // === DOORWAY SURROUND → ornament-batched ===
    // Stone frame (lintel + two jambs) projecting from the front (+Z) face
    // around the painted door on the FacadeTexture. The door rectangle on
    // the texture is 0.25 world units wide and ~0.22*wallH tall, centered
    // horizontally and anchored at the wall base. Wrapping it with a stone
    // surround gives the door real depth at human walking distance —
    // without it, doors read flat against the wall texture even at
    // close range. Skip on landmarks (their architecture is grand) and
    // narrow buildings where the door would dominate the front face.
    // Only emit when the mainBody volume actually carries the building's
    // front face — for L-shapes/porch templates, mainVol's front face is
    // inset and a surround there would land on an interior surface.
    const mainFrontZ = mainVol.offsetZ + mainVol.depth / 2
    const buildingFrontZ = fp.h / 2
    const frontMatches = Math.abs(mainFrontZ - buildingFrontZ) < 0.4
    const wantsSurround = !isLandmark && !mainVol.circular && frontMatches &&
      !NO_JITTER.has(obj.definitionId) && fp.w >= 2 && mainVol.width >= 1.4 &&
      (styleVector.stone > 0.5 || styleVector.cornice > 0.4 ||
       district === 'noble' || district === 'temple' ||
       rand01(hash, 951) < 0.4)
    if (wantsSurround && mainVol.height > 1.5) {
      const doorW = 0.32
      const doorH = Math.min(mainVol.height * 0.55, 1.4)
      const baseLocalY = mainVol.bottomY ?? 0
      const frontLocalZ = mainVol.offsetZ + mainVol.depth / 2
      const proj = 0.06          // how far the frame stands proud of the wall
      const jambW = 0.10
      const lintelH = 0.14
      // Color: warm limestone for darker walls, dark stone for pale walls.
      const wallR = (mainVol.wallColor >> 16) & 0xff
      const surroundColor = wallR < 180 ? 0xb8a888 : 0x6a5a48
      // Lintel
      const lintel = new THREE.BoxGeometry(doorW + jambW * 2 + 0.08, lintelH, proj)
      localToWorld(lintel, mainVol.offsetX, baseLocalY + doorH + lintelH / 2,
        frontLocalZ + proj / 2,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(lintel, surroundColor)
      // Jambs (sides)
      for (const xSide of [-1, 1]) {
        const jamb = new THREE.BoxGeometry(jambW, doorH, proj)
        localToWorld(jamb,
          mainVol.offsetX + xSide * (doorW / 2 + jambW / 2),
          baseLocalY + doorH / 2,
          frontLocalZ + proj / 2,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(jamb, surroundColor)
      }
      // Keystone — small bump at top center of lintel for noble/temple/wealth.
      if (styleVector.wealth > 0.55 || district === 'noble' || district === 'temple') {
        const keystone = new THREE.BoxGeometry(0.18, lintelH + 0.06, proj + 0.02)
        localToWorld(keystone, mainVol.offsetX, baseLocalY + doorH + (lintelH + 0.06) / 2,
          frontLocalZ + (proj + 0.02) / 2,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(keystone, surroundColor)
      }
    }

    // === SHOP SIGN → ornament-batched ===
    // Perpendicular wood sign hanging from a bracket on the front (+Z) face.
    // The medieval-Diagon-Alley signature: a row of mid-height projecting
    // signs reads as "this street has shops" the moment you turn into it.
    // Gated on commercial district + commercial building + hash. Follows the
    // building's lean+yaw via localToWorld so it stays attached visually.
    const isCommercialDistrict = district === 'market' || district === 'artisan'
    const isCommercialBldg = (
      obj.definitionId === 'shop' || obj.definitionId === 'tavern' ||
      obj.definitionId === 'inn' || obj.definitionId === 'bakery' ||
      obj.definitionId === 'apothecary' || obj.definitionId === 'guild_hall' ||
      obj.definitionId === 'covered_market' || obj.definitionId === 'building_small' ||
      obj.definitionId === 'building_medium' || obj.definitionId === 'half_timber'
    )
    if (
      isCommercialDistrict && isCommercialBldg && fp.w >= 2 &&
      !NO_JITTER.has(obj.definitionId) &&
      wallH > 2.4 && rand01(hash, 811) < 0.6
    ) {
      // Sign at ground-floor top, ~2.3m above base — eye level for a
      // 1.6m-tall player so it reads as "shop sign" not "high banner".
      const signY = Math.min(2.3, FLOOR_HEIGHT * 1.05)
      const signW = 0.5 + rand01(hash, 813) * 0.25      // 0.5..0.75
      const signH = 0.32 + rand01(hash, 815) * 0.16     // 0.32..0.48
      const signProj = 0.55                              // distance from wall to sign center
      const signSide = rand01(hash, 817) < 0.5 ? -1 : 1  // along front face
      const signLocalX = signSide * fp.w * 0.18
      const signLocalZ = fp.h / 2 + signProj
      // Bracket: thin bar along Z from wall (lz=fp.h/2) to sign center (signLocalZ).
      const bracketLen = signProj - 0.05
      const bracket = new THREE.BoxGeometry(0.05, 0.06, bracketLen)
      // Bracket centered between wall (fp.h/2 + 0.025) and sign (signLocalZ - 0.025)
      const bracketLocalZ = fp.h / 2 + bracketLen / 2 + 0.025
      localToWorld(bracket, signLocalX, signY + signH * 0.4, bracketLocalZ,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(bracket, 0x3a2418)  // dark wood
      // Sign plank itself — vertical, perpendicular to the wall (long axis = X
      // in local frame, so the BROAD face is visible from passers-by walking
      // along the building's front).
      const sign = new THREE.BoxGeometry(0.04, signH, signW)
      localToWorld(sign, signLocalX, signY, signLocalZ,
        leanX, leanZ, rotationY, wx, wy, wz)
      // Pick from a small palette so signs feel painted / individual.
      const signColors = [0x6b3a1f, 0x5a2818, 0x7a4830, 0x3a4a2a, 0x4a3a55, 0x6a5028]
      const signColor = signColors[hash % signColors.length]
      ornamentBatch.addPositioned(sign, signColor)
      // Two short chains rendered as thin vertical bars (we don't have line
      // primitives in the ornament batch). They connect the bracket bottom to
      // the sign top, suggesting the sign hangs rather than rigidly attaches.
      const chainH = signH * 0.18
      const chainY = signY + signH / 2 + chainH / 2
      for (const chOff of [-signW * 0.35, signW * 0.35]) {
        const chain = new THREE.BoxGeometry(0.025, chainH, 0.025)
        localToWorld(chain, signLocalX, chainY, signLocalZ + chOff,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(chain, 0x2a2018)
      }
    }

    // === AWNING → ornament-batched ===
    // Canvas slab over the front door of market-district buildings.
    // Sits at the top of the ground-floor band, projecting 0.55m forward.
    // Slightly thinner at the front than back so it reads as a sloped awning,
    // not a flat shelf.
    if (
      district === 'market' && fp.w >= 2 &&
      !NO_JITTER.has(obj.definitionId) &&
      wallH > 1.8 && rand01(hash, 821) < 0.45
    ) {
      const awningY = Math.min(2.0, FLOOR_HEIGHT * 0.95)
      const awningW = Math.min(1.4, fp.w * 0.55)
      const awningD = 0.55
      // Front-edge dip so the awning slopes downward away from the wall.
      const slopeRot = -0.12  // ~7° down at front edge
      const awning = new THREE.BoxGeometry(awningW, 0.04, awningD)
      // Pivot the slope around the wall edge: translate so the wall edge is
      // at z=0 in geometry space, rotate, restore.
      awning.translate(0, 0, awningD / 2)
      awning.rotateX(slopeRot)
      // Awning canvas palette — warm striped market awning colors.
      const awnColors = [0xc25a3a, 0xc8924a, 0xa84030, 0xb86a4a, 0x8b7038]
      const awnColor = awnColors[(hash >> 4) % awnColors.length]
      localToWorld(awning, 0, awningY, fp.h / 2,
        leanX, leanZ, rotationY, wx, wy, wz)
      ornamentBatch.addPositioned(awning, awnColor)
      // Two simple vertical posts at the front corners — implies tied-down canvas.
      // Post top must clear the awning's sloped underside at the post's Z. The
      // awning's local Z (relative to its translate) at the post is awningD-0.04
      // ≈ 0.51. After rotateX(slopeRot), that point's Y is z' * sin(-slopeRot)
      // below the awning's reference plane (slopeRot is negative so sin gives
      // a small positive drop). Subtract another half-thickness for the
      // bottom face, then ~3cm of headroom.
      const postZRel = awningD - 0.04
      const postZ = fp.h / 2 + postZRel
      const awningBottomDrop = postZRel * Math.sin(-slopeRot) + 0.02
      const postH = Math.max(0.5, awningY - awningBottomDrop - 0.03)
      for (const px of [-awningW * 0.42, awningW * 0.42]) {
        const post = new THREE.BoxGeometry(0.04, postH, 0.04)
        post.translate(0, postH / 2, 0)
        localToWorld(post, px, 0, postZ,
          leanX, leanZ, rotationY, wx, wy, wz)
        ornamentBatch.addPositioned(post, 0x3a2418)
      }
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
    // Lean+yaw transformed via localToWorld so the balcony stays attached to
    // the (possibly leaning) wall.
    if ((obj.definitionId === 'balcony_house' || obj.definitionId === 'inn') && floors >= 2) {
      const balcW = fp.w * 0.5, balcD = 0.4
      const balcY = FLOOR_HEIGHT * 1.1 * heightMult
      const pg = new THREE.BoxGeometry(balcW, 0.06, balcD)
      localToWorld(pg, 0, balcY, fp.h / 2 + balcD / 2,
        leanX, leanZ, rotationY, wx, wy, wz)
      detailBatch.addPositioned(pg, 0x705a40)
      const rg = new THREE.BoxGeometry(balcW, 0.25, 0.04)
      localToWorld(rg, 0, balcY + 0.15, fp.h / 2 + balcD,
        leanX, leanZ, rotationY, wx, wy, wz)
      detailBatch.addPositioned(rg, 0x705a40)
      for (const side of [-balcW * 0.35, balcW * 0.35]) {
        const bg = new THREE.BoxGeometry(0.06, 0.2, balcD * 0.7)
        localToWorld(bg, side, balcY - 0.1, fp.h / 2 + balcD * 0.4,
          leanX, leanZ, rotationY, wx, wy, wz)
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

  // Coalesce walls sharing the same material array into merged meshes.
  // Most walls land in a small number of material groups (because
  // _wallMatCache returns the same instance for same-config buildings),
  // so we can collapse 200+ individual wall meshes into ~30-50 merged
  // meshes — one per unique material array. Huge draw-call win,
  // especially in the shadow pass.
  const mergedWalls = coalesceWalls(wallMeshes)
  return { wallMeshes: mergedWalls, batched }
}

/**
 * Merge wall meshes that share the same material array into single meshes
 * with baked world transforms. BoxGeometry-based walls merge cleanly
 * (same group layout: 6 groups, one per face). Cylinder-based (circular
 * tower) walls stay separate since they use a different geometry topology.
 */
function coalesceWalls(wallMeshes: THREE.Mesh[]): THREE.Mesh[] {
  type Key = THREE.Material | THREE.Material[] | null
  // Bucket by (material, castShadow): walls that differ on castShadow must
  // stay separate because castShadow is a per-mesh flag. If we merged them
  // the combined mesh would inherit only one setting and either bloat the
  // shadow pass (merge downcast to "true") or lose wanted silhouettes
  // (merge downcast to "false").
  const groups = new Map<string, { key: Key; casts: boolean; meshes: THREE.Mesh[] }>()
  const loose: THREE.Mesh[] = []
  const keyOf = (m: THREE.Material | THREE.Material[], casts: boolean): string => {
    const mat = Array.isArray(m) ? m.map(x => x.uuid).join('|') : m.uuid
    return `${mat}#${casts ? 1 : 0}`
  }
  for (const mesh of wallMeshes) {
    // Only merge BoxGeometry walls — cylinders use different topology.
    if (!(mesh.geometry instanceof THREE.BoxGeometry)) { loose.push(mesh); continue }
    const casts = mesh.castShadow
    const k = keyOf(mesh.material as THREE.Material | THREE.Material[], casts)
    let bucket = groups.get(k)
    if (!bucket) {
      bucket = { key: mesh.material as Key, casts, meshes: [] }
      groups.set(k, bucket)
    }
    bucket.meshes.push(mesh)
  }
  const result: THREE.Mesh[] = [...loose]
  for (const { key, casts, meshes } of groups.values()) {
    // Even 2-mesh groups are worth merging — one less draw call each,
    // and the shadow pass benefits too. Only singletons stay loose.
    if (meshes.length < 2) { result.push(...meshes); continue }
    // Bake each mesh's world transform into its geometry, then merge.
    // All geometries have the same group layout since they're all BoxGeometry
    // so mergeGeometries can combine them preserving per-face material indices.
    const geos: THREE.BufferGeometry[] = []
    for (const m of meshes) {
      m.updateMatrix()
      const g = m.geometry.clone()
      g.applyMatrix4(m.matrix)
      geos.push(g)
    }
    const merged = mergeGeometries(geos, true)
    if (!merged) { result.push(...meshes); continue }
    const out = new THREE.Mesh(merged, key as THREE.Material | THREE.Material[])
    out.matrixAutoUpdate = false
    out.updateMatrix()
    out.castShadow = casts
    out.receiveShadow = true
    // Dispose the cloned geometries; the source meshes will be dropped.
    for (const g of geos) g.dispose()
    for (const m of meshes) m.geometry.dispose()
    result.push(out)
  }
  return result
}
