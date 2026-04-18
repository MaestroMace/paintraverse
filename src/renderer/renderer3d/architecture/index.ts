/**
 * Parametric architecture module — entry point.
 *
 * High-level flow:
 *   pickArchetypes(district, hash)  →  weighted archetype picks
 *   blendVectors(archetypeVectors, weights)  →  per-building StyleVector
 *   jitterVector(v, hashFn)         →  instance-unique perturbation
 *   composeBuilding(spec, batch)    →  emits ornaments onto the building
 *
 * composeBuilding is additive — it emits perimeter bands, window trim,
 * bay oriels, dormers, and (optionally) a chimney. The caller keeps
 * ownership of the main wall body and main roof geometry.
 */

import type { BuildingPalette } from '../../inspiration/StyleMapper'
import type { BatchedMeshBuilder } from '../BatchedMeshBuilder'
import type { StyleVector, DistrictId } from './StyleVector'
import { ARCHETYPES } from './Archetypes'
import { pickArchetypes } from './DistrictWeights'
import { blendVectors, jitterVector } from './StyleVector'
import {
  emitCornice, emitStringCourse, emitJettyShelf,
  emitDormer, emitChimneyStack,
} from './Ornaments'
import { composeFacade, type FaceSpec } from './FacadeComposer'

// Re-exports for downstream consumers
export type { StyleVector, DistrictId, ContinuousAxis } from './StyleVector'
export { blendVectors, jitterVector, CONTINUOUS_AXES } from './StyleVector'
export { ARCHETYPES, ALL_ARCHETYPES } from './Archetypes'
export type { ArchetypeId } from './Archetypes'
export { DISTRICT_BIAS, pickArchetypes } from './DistrictWeights'
export type { ArchetypePick } from './DistrictWeights'
export type { NormalAxis } from './Ornaments'
export { composeFacade } from './FacadeComposer'
export type { FaceSpec } from './FacadeComposer'

/** One-call helper: district + hash → fully blended + jittered style vector. */
export function buildingStyleVector(district: DistrictId, hash: number): StyleVector {
  const picks = pickArchetypes(district, hash)
  const blended = blendVectors(
    picks.map(p => ARCHETYPES[p.id]),
    picks.map(p => p.w),
  )
  return jitterVector(blended, (salt) => {
    const n = (hash * 2654435761 + salt * 1597334677) >>> 0
    return n / 0xffffffff
  }, 0.08)
}

export interface ComposeBuildingSpec {
  /** Building center XZ in world space. */
  centerX: number
  centerZ: number
  /** Wall base Y (usually terrain height + elevation). */
  baseY: number
  /** Final wall height (post-jitter). */
  wallH: number
  /** Footprint in tiles. */
  footW: number
  footD: number
  /** Integer floor count. */
  floors: number
  /** Pre-blended per-instance style vector. */
  style: StyleVector
  palette: BuildingPalette
  /** Stable hash of the building id; used for sub-ornament randomness. */
  hash: number
  /** Face axis of the "front" wall. Defaults to z+ (south). */
  primaryFace?: 'x+' | 'x-' | 'z+' | 'z-'
  /** If true, composeBuilding also emits a chimney stack. */
  addChimney?: boolean
}

export interface ComposeBuildingResult {
  /** World position of the chimney top, if one was emitted. */
  chimneyTop?: { x: number; y: number; z: number }
}

function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

/**
 * Emit all style-driven ornaments for one building. Does NOT emit the
 * main wall body or the main roof — those still live in BuildingFactory.
 */
export function composeBuilding(
  spec: ComposeBuildingSpec,
  ornamentBatch: BatchedMeshBuilder,
): ComposeBuildingResult {
  const { centerX, centerZ, baseY, wallH, footW, footD, floors, style, palette, hash } = spec
  const primary = spec.primaryFace ?? 'z+'

  const topY = baseY + wallH
  const floorH = wallH / Math.max(1, floors)

  // --- Perimeter bands ---

  // Cornice (always if style calls for it — low threshold so most buildings
  // get some crown molding, just of varying weight).
  if (style.cornice > 0.2) {
    emitCornice(ornamentBatch, centerX, centerZ, topY,
      footW, footD, palette.wall, style.cornice > 0.6)
  }

  // String courses at each intermediate floor line, when cornice axis is high.
  if (floors >= 2 && style.cornice > 0.45) {
    for (let f = 1; f < floors; f++) {
      emitStringCourse(ornamentBatch, centerX, centerZ,
        baseY + f * floorH, footW, footD, palette.wall)
    }
  }

  // Jetty shelf: heavy projecting shelf at the second-floor line.
  if (floors >= 2 && style.overhang > 0.55) {
    emitJettyShelf(ornamentBatch, centerX, centerZ,
      baseY + floorH, footW, footD, palette.wall)
  }

  // --- Per-face ornaments ---
  const faceDefs: { normal: 'x+' | 'x-' | 'z+' | 'z-' }[] = [
    { normal: 'z+' }, { normal: 'z-' }, { normal: 'x+' }, { normal: 'x-' },
  ]
  for (const fd of faceDefs) {
    const onZ = fd.normal === 'z+' || fd.normal === 'z-'
    const width = onZ ? footW : footD
    const sign = (fd.normal === 'x+' || fd.normal === 'z+') ? 1 : -1
    const fcx = centerX + (onZ ? 0 : sign * footW / 2)
    const fcz = centerZ + (onZ ? sign * footD / 2 : 0)
    const face: FaceSpec = {
      normal: fd.normal,
      centerX: fcx, centerZ: fcz,
      baseY, width, height: wallH,
      floors, primary: fd.normal === primary,
    }
    composeFacade(face, style, hash, palette, ornamentBatch)
  }

  // --- Roof ornaments: dormers ---
  // Only emit when the roof has enough pitch to host a dormer, and the
  // building is tall/wide enough to earn one.
  if (
    floors >= 2 && style.roofPitch > 0.45 &&
    Math.min(footW, footD) >= 3 &&
    rand01(hash, 401) < 0.6
  ) {
    // Place one dormer on each gable end (±Z) at mid-height of the roof slope.
    const dormerW = Math.min(1.1, footW * 0.35)
    const dormerD = 0.4
    const dormerWallH = 0.45
    const dormerGableH = 0.32
    for (const dn of ['z+', 'z-'] as const) {
      if (rand01(hash, dn === 'z+' ? 411 : 417) < 0.55) {
        // Base sits just above the wall top, slightly set back into the roof.
        emitDormer(
          ornamentBatch, dn,
          centerX, centerZ + (dn === 'z+' ? footD / 2 - 0.55 : -footD / 2 + 0.55),
          topY + 0.02,
          dormerW, dormerD, dormerWallH, dormerGableH,
          palette.wall, palette.roof,
        )
      }
    }
  }

  // --- Chimney ---
  let chimneyTop: { x: number; y: number; z: number } | undefined
  if (spec.addChimney) {
    const chimSide = (hash % 2 === 0) ? 1 : -1
    const cx = centerX + chimSide * footW * 0.3
    const cz = centerZ + (rand01(hash, 91) - 0.5) * footD * 0.3
    const chimH = 0.65 + rand01(hash, 93) * 0.35
    const stackW = 0.22
    const shoulderW = 0.32
    const includeShoulder = style.wealth > 0.4 || style.stone > 0.5
    emitChimneyStack(ornamentBatch, cx, cz, topY, chimH,
      stackW, shoulderW, includeShoulder, 0x6b4a38)
    chimneyTop = { x: cx, y: topY + chimH, z: cz }
  }

  return chimneyTop ? { chimneyTop } : {}
}
