/**
 * Ornaments — small BufferGeometry generators that push into a
 * BatchedMeshBuilder. Each emit* takes enough parameters to place a piece
 * of real 3D relief onto an axis-aligned building. All walls in the current
 * codebase are axis-aligned (no Y rotation yet), so normals are always one
 * of ±X / ±Z — we express that as a NormalAxis string rather than vectors.
 *
 * Phase 1 ornament set (picked for silhouette payoff per vertex):
 *   - emitCornice          — heavy projecting band at roof line
 *   - emitStringCourse     — thin projecting band at a floor line
 *   - emitJettyShelf       — thick projecting shelf (upper-floor overhang)
 *   - emitWindowTrim       — sill + lintel that give windows apparent depth
 *   - emitBayOriel         — true 3D projecting window bay with mini roof
 *   - emitDormer           — gable popping from a roof face
 *   - emitChimneyStack     — chimney with proper shoulder + cap
 */

import * as THREE from 'three'
import type { BatchedMeshBuilder } from '../BatchedMeshBuilder'

/** Axis-aligned outward normal for an ornament attached to a building face. */
export type NormalAxis = 'x+' | 'x-' | 'z+' | 'z-'

function nSign(n: NormalAxis): 1 | -1 {
  return (n === 'x+' || n === 'z+') ? 1 : -1
}
function isZ(n: NormalAxis): boolean {
  return n === 'z+' || n === 'z-'
}

/* ------------------------------------------------------------------ */
/* Perimeter bands: cornice, string course, jetty shelf               */
/* ------------------------------------------------------------------ */

/**
 * Horizontal band wrapping all four sides of a building. Used as the
 * primitive for cornices, string courses, and jetty shelves.
 */
export function emitPerimeterBand(
  batch: BatchedMeshBuilder,
  cx: number, cz: number, y: number,
  footW: number, footD: number,
  projection: number, bandH: number,
  color: number,
): void {
  // North + south (±Z faces)
  for (const zSide of [-1, 1]) {
    const geo = new THREE.BoxGeometry(footW + projection * 2, bandH, projection)
    geo.translate(cx, y + bandH / 2, cz + zSide * (footD / 2 + projection / 2))
    batch.addPositioned(geo, color)
  }
  // East + west (±X faces)
  for (const xSide of [-1, 1]) {
    const geo = new THREE.BoxGeometry(projection, bandH, footD)
    geo.translate(cx + xSide * (footW / 2 + projection / 2), y + bandH / 2, cz)
    batch.addPositioned(geo, color)
  }
}

/** Cornice: heavy band at the top of the wall, just below the roof. */
export function emitCornice(
  batch: BatchedMeshBuilder,
  cx: number, cz: number, topOfWallY: number,
  footW: number, footD: number,
  color: number, heavy = false,
): void {
  const projection = heavy ? 0.14 : 0.08
  const bandH = heavy ? 0.20 : 0.10
  emitPerimeterBand(batch, cx, cz, topOfWallY - bandH, footW, footD, projection, bandH, color)
}

/** String course: thin horizontal band at an intermediate floor line. */
export function emitStringCourse(
  batch: BatchedMeshBuilder,
  cx: number, cz: number, y: number,
  footW: number, footD: number, color: number,
): void {
  emitPerimeterBand(batch, cx, cz, y, footW, footD, 0.04, 0.06, color)
}

/** Jetty shelf: thick projecting shelf, typically at the second-floor line. */
export function emitJettyShelf(
  batch: BatchedMeshBuilder,
  cx: number, cz: number, y: number,
  footW: number, footD: number, color: number,
): void {
  emitPerimeterBand(batch, cx, cz, y, footW, footD, 0.18, 0.22, color)
}

/* ------------------------------------------------------------------ */
/* Window trim: sill + lintel sticking out of an axis-aligned face    */
/* ------------------------------------------------------------------ */

/**
 * Sill (below) and lintel (above) around a window opening. Both pieces
 * sit flush to the wall and project slightly outward, giving the window
 * the apparent depth of being set into a frame rather than painted on.
 */
export function emitWindowTrim(
  batch: BatchedMeshBuilder,
  normal: NormalAxis,
  winCx: number, winCy: number, winCz: number,
  winW: number, winH: number,
  frameColor: number,
): void {
  const sign = nSign(normal)
  const onZFace = isZ(normal)

  const sillProj = 0.10
  const lintelProj = 0.07
  const extra = 0.06
  const sillH = 0.06
  const lintelH = 0.07

  // Sill (below window)
  const sillW = onZFace ? (winW + extra * 2) : sillProj
  const sillD = onZFace ? sillProj : (winW + extra * 2)
  const sill = new THREE.BoxGeometry(sillW, sillH, sillD)
  sill.translate(
    winCx + (onZFace ? 0 : sign * sillProj / 2),
    winCy - winH / 2 - sillH / 2,
    winCz + (onZFace ? sign * sillProj / 2 : 0),
  )
  batch.addPositioned(sill, frameColor)

  // Lintel (above window) — thinner projection
  const linW = onZFace ? (winW + extra * 2) : lintelProj
  const linD = onZFace ? lintelProj : (winW + extra * 2)
  const lintel = new THREE.BoxGeometry(linW, lintelH, linD)
  lintel.translate(
    winCx + (onZFace ? 0 : sign * lintelProj / 2),
    winCy + winH / 2 + lintelH / 2,
    winCz + (onZFace ? sign * lintelProj / 2 : 0),
  )
  batch.addPositioned(lintel, frameColor)
}

/* ------------------------------------------------------------------ */
/* Bay oriel: projecting 3-wall bay with a small roof                 */
/* ------------------------------------------------------------------ */

/**
 * Projecting window bay — a three-walled mini-volume sticking out of one
 * face of the main building, with a simple slanted roof on top. Meant to
 * anchor a large residential or noble building; not placed on every wall.
 *
 *   baseY: y of the bay floor (usually second-floor level)
 *   w:     along-face width of the bay
 *   h:     bay height (usually matches one floor)
 *   depth: how far it projects from the wall
 */
export function emitBayOriel(
  batch: BatchedMeshBuilder,
  normal: NormalAxis,
  faceCx: number, faceCz: number, baseY: number,
  w: number, h: number, depth: number,
  wallColor: number, roofColor: number,
): void {
  const sign = nSign(normal)
  const onZFace = isZ(normal)
  const wallTh = 0.08

  // Front wall — parallel to the building's face, offset outward by `depth`
  const frontW = onZFace ? w : wallTh
  const frontD = onZFace ? wallTh : w
  const front = new THREE.BoxGeometry(frontW, h, frontD)
  front.translate(
    faceCx + (onZFace ? 0 : sign * (depth - wallTh / 2)),
    baseY + h / 2,
    faceCz + (onZFace ? sign * (depth - wallTh / 2) : 0),
  )
  batch.addPositioned(front, wallColor)

  // Two side walls connecting front to main wall
  for (const t of [-1, 1]) {
    const sideW = onZFace ? wallTh : depth
    const sideD = onZFace ? depth : wallTh
    const side = new THREE.BoxGeometry(sideW, h, sideD)
    side.translate(
      faceCx + (onZFace ? t * (w / 2 - wallTh / 2) : sign * depth / 2),
      baseY + h / 2,
      faceCz + (onZFace ? sign * depth / 2 : t * (w / 2 - wallTh / 2)),
    )
    batch.addPositioned(side, wallColor)
  }

  // Bracket beneath the bay (visual support — a thin diagonal-ish slab)
  const bracketH = 0.18
  const brW = onZFace ? (w * 0.85) : (depth * 0.8)
  const brD = onZFace ? (depth * 0.8) : (w * 0.85)
  const bracket = new THREE.BoxGeometry(brW, bracketH, brD)
  bracket.translate(
    faceCx + (onZFace ? 0 : sign * depth / 2),
    baseY - bracketH / 2,
    faceCz + (onZFace ? sign * depth / 2 : 0),
  )
  batch.addPositioned(bracket, wallColor)

  // Mini slanted roof on top — simple prism with apex along the face
  const roofH = 0.22
  const roofProj = depth + 0.04 // slight overhang beyond bay
  const rxW = onZFace ? (w + 0.08) : roofProj
  const rxD = onZFace ? roofProj : (w + 0.08)
  const roof = buildPrismGeometry(rxW, roofH, rxD, onZFace ? 'ridgeX' : 'ridgeZ')
  roof.translate(
    faceCx + (onZFace ? 0 : sign * roofProj / 2),
    baseY + h,
    faceCz + (onZFace ? sign * roofProj / 2 : 0),
  )
  batch.addPositioned(roof, roofColor)
}

/* ------------------------------------------------------------------ */
/* Dormer: small gabled box projecting from a roof face               */
/* ------------------------------------------------------------------ */

/**
 * Gable "dormer" protruding from the main roof. Placed on a roof face,
 * it reads as a second-floor window peeking up through the roof — a
 * quintessential Traverse Town roofline cue.
 */
export function emitDormer(
  batch: BatchedMeshBuilder,
  normal: NormalAxis,
  baseCx: number, baseCz: number, baseY: number,
  w: number, d: number, wallH: number, gableH: number,
  wallColor: number, roofColor: number,
): void {
  const sign = nSign(normal)
  const onZFace = isZ(normal)

  // Dormer wall body
  const bodyW = onZFace ? w : d
  const bodyD = onZFace ? d : w
  const body = new THREE.BoxGeometry(bodyW, wallH, bodyD)
  body.translate(
    baseCx + (onZFace ? 0 : sign * d / 2),
    baseY + wallH / 2,
    baseCz + (onZFace ? sign * d / 2 : 0),
  )
  batch.addPositioned(body, wallColor)

  // Gabled roof on top (ridge runs parallel to main roof slope direction)
  const roof = buildPrismGeometry(bodyW + 0.08, gableH, bodyD + 0.08,
    onZFace ? 'ridgeX' : 'ridgeZ')
  roof.translate(
    baseCx + (onZFace ? 0 : sign * d / 2),
    baseY + wallH,
    baseCz + (onZFace ? sign * d / 2 : 0),
  )
  batch.addPositioned(roof, roofColor)
}

/* ------------------------------------------------------------------ */
/* Chimney stack with shoulder + cap                                  */
/* ------------------------------------------------------------------ */

/**
 * Proper chimney: a main stack with a wider base "shoulder" and a small
 * flat cap on top. Replaces the old 0.2×0.2 bare box.
 */
export function emitChimneyStack(
  batch: BatchedMeshBuilder,
  x: number, z: number, baseY: number, h: number,
  stackW: number, shoulderW: number,
  includeShoulder: boolean,
  color: number,
): void {
  const shH = 0.22
  let stackBaseY = baseY

  if (includeShoulder) {
    const shoulder = new THREE.BoxGeometry(shoulderW, shH, shoulderW)
    shoulder.translate(x, baseY + shH / 2, z)
    batch.addPositioned(shoulder, color)
    stackBaseY = baseY + shH
  }

  const stackH = Math.max(0.2, h - (includeShoulder ? shH : 0) - 0.06)
  const stack = new THREE.BoxGeometry(stackW, stackH, stackW)
  stack.translate(x, stackBaseY + stackH / 2, z)
  batch.addPositioned(stack, color)

  // Cap: slightly wider than stack, thin
  const capW = stackW + 0.1
  const capH = 0.06
  const cap = new THREE.BoxGeometry(capW, capH, capW)
  cap.translate(x, stackBaseY + stackH + capH / 2, z)
  batch.addPositioned(cap, color)
}

/* ------------------------------------------------------------------ */
/* Internal: simple triangular prism for mini-roofs / dormer caps     */
/* ------------------------------------------------------------------ */

/**
 * Triangular prism with its ridge centered along either X or Z.
 *   ridgeX: ridge runs along X — gable ends face ±Z
 *   ridgeZ: ridge runs along Z — gable ends face ±X
 *
 * Position-only BufferGeometry (normals are recomputed at batch build).
 */
function buildPrismGeometry(w: number, h: number, d: number, axis: 'ridgeX' | 'ridgeZ'): THREE.BufferGeometry {
  const hw = w / 2, hd = d / 2
  let verts: Float32Array
  if (axis === 'ridgeX') {
    // Ridge at y=h, along x from -hw..hw. Gable faces are ±Z triangles.
    verts = new Float32Array([
      // Slope +Z (front)
      -hw, 0,  hd,   hw, 0,  hd,   hw, h, 0,
      -hw, 0,  hd,   hw, h, 0,   -hw, h, 0,
      // Slope -Z (back)
       hw, 0, -hd,  -hw, 0, -hd,  -hw, h, 0,
       hw, 0, -hd,  -hw, h, 0,    hw, h, 0,
      // Gable +X (triangle)
       hw, 0, -hd,   hw, 0,  hd,   hw, h, 0,
      // Gable -X (triangle)
      -hw, 0,  hd,  -hw, 0, -hd,  -hw, h, 0,
      // Bottom
      -hw, 0, -hd,   hw, 0, -hd,   hw, 0,  hd,
      -hw, 0, -hd,   hw, 0,  hd,  -hw, 0,  hd,
    ])
  } else {
    // Ridge along z, gables face ±X
    verts = new Float32Array([
      // Slope +X
       hw, 0, -hd,   hw, 0,  hd,   0, h,  hd,
       hw, 0, -hd,   0, h,  hd,    0, h, -hd,
      // Slope -X
      -hw, 0,  hd,  -hw, 0, -hd,   0, h, -hd,
      -hw, 0,  hd,   0, h, -hd,    0, h,  hd,
      // Gable +Z
      -hw, 0,  hd,   hw, 0,  hd,   0, h,  hd,
      // Gable -Z
       hw, 0, -hd,  -hw, 0, -hd,   0, h, -hd,
      // Bottom
      -hw, 0, -hd,   hw, 0, -hd,   hw, 0,  hd,
      -hw, 0, -hd,   hw, 0,  hd,  -hw, 0,  hd,
    ])
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  return geo
}
