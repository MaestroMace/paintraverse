/**
 * FacadeComposer — reads a StyleVector and emits ornaments onto one face
 * of a building. The unit of composition is the face, not the building,
 * so corner buildings can receive different treatments on their street-
 * facing vs alley-facing walls.
 *
 * Phase 1 emits: window trim (sill + lintel per window) and optional
 * bay oriels. Perimeter bands (cornice, string courses, jetty) live on
 * the building, not the face — composeBuilding handles those.
 */

import type { StyleVector } from './StyleVector'
import type { BuildingPalette } from '../../inspiration/StyleMapper'
import type { BatchedMeshBuilder } from '../BatchedMeshBuilder'
import { NormalAxis, emitWindowTrim, emitBayOriel } from './Ornaments'

/** Describes one rectangular face of an axis-aligned building. */
export interface FaceSpec {
  normal: NormalAxis
  /** Centre point of the face on the wall surface. */
  centerX: number
  centerZ: number
  baseY: number
  width: number   // along-face horizontal extent
  height: number  // bottom to top of wall
  /** Total floor count on this face (usually the building's). */
  floors: number
  /** Is this the "primary" face (the building's front)? */
  primary: boolean
}

function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

/**
 * Emit all per-face ornaments for one face. Currently window sills+lintels
 * and (on the primary face of larger wealthier buildings) a bay oriel.
 */
export function composeFacade(
  face: FaceSpec,
  sv: StyleVector,
  hash: number,
  palette: BuildingPalette,
  batch: BatchedMeshBuilder,
): void {
  // Window grid — match FacadeTexture.ts exactly so 3D trim aligns with
  // the painted windows on ±Z faces:
  //   cols     = max(1, floor(width * 1.5))
  //   colSpacing = width / (cols + 1)
  //   winW (tex) = 0.22 * TEXTURE_SCALE  → 0.22 tile in world
  //   winH (tex) = 0.35 * TEXTURE_SCALE  → 0.35 * floorH in world
  //   winYcenter (tex) = 0.575 of the way up a floor band
  const cols = Math.max(1, Math.floor(face.width * 1.5))
  const floorH = face.height / Math.max(1, face.floors)
  const colSpacing = face.width / (cols + 1)
  const faceLeftOffset = -face.width / 2

  const winW = Math.min(colSpacing * 0.6, 0.26)
  const winH = Math.min(floorH * 0.4, 0.55)

  // Only emit trim if the style calls for perceptible recess — below
  // ~0.2 we'd be making frames that barely read at camera distance.
  const trimPower = sv.windowRecess
  if (trimPower < 0.2) return

  const trimColor = 0xd8d0c0 // cream stone; could derive from palette later

  // For each floor and column, emit a window trim. Skip ~10% deterministically
  // to give a "one window boarded/missing" natural feel.
  for (let floor = 0; floor < face.floors; floor++) {
    // Window vertical center: ~57.5% up the floor band (matches 2D texture).
    const winCy = face.baseY + floor * floorH + floorH * 0.575
    for (let col = 0; col < cols; col++) {
      const salt = 17 + floor * 101 + col * 7 + normalSalt(face.normal)
      if (rand01(hash, salt) < 0.1) continue

      const along = faceLeftOffset + (col + 1) * colSpacing
      // Face is axis-aligned: tangent runs along X (Z-face) or Z (X-face)
      const winCx = face.centerX + (isZFace(face.normal) ? along : 0)
      const winCz = face.centerZ + (isZFace(face.normal) ? 0 : along)
      emitWindowTrim(batch, face.normal, winCx, winCy, winCz, winW, winH, trimColor)
    }
  }

  // Bay oriel — one per primary face, only for larger / wealthier buildings.
  // Landed with a small probability so not every noble house has one.
  if (
    face.primary &&
    sv.ornament > 0.55 &&
    sv.wealth > 0.45 &&
    face.floors >= 2 &&
    face.width >= 2.5 &&
    rand01(hash, 41) < 0.55
  ) {
    const bayW = Math.min(face.width * 0.5, 1.6)
    const bayH = floorH * 0.9
    const bayDepth = 0.3 + sv.ornament * 0.15
    const bayBaseY = face.baseY + floorH * 1.08
    emitBayOriel(
      batch, face.normal,
      face.centerX, face.centerZ, bayBaseY,
      bayW, bayH, bayDepth,
      palette.wall, palette.roof,
    )
  }
}

function isZFace(n: NormalAxis): boolean { return n === 'z+' || n === 'z-' }

function normalSalt(n: NormalAxis): number {
  switch (n) {
    case 'x+': return 3
    case 'x-': return 29
    case 'z+': return 53
    case 'z-': return 79
  }
}
