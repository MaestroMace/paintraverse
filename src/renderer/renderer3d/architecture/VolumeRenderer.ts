/**
 * VolumeRenderer — emits the geometry for one Volume.
 *
 * Walls: one textured Mesh per volume (BoxGeometry or CylinderGeometry) that
 * goes into the wallMeshes array (not batched) so it can carry the facade
 * material with its emissive window map.
 *
 * Roof: one BufferGeometry per volume pushed into the shared roofBatch with
 * the volume's roofColor baked as vertex color.
 *
 * Cornice: emitted into the ornamentBatch when volume.cornice is true.
 */

import * as THREE from 'three'
import type { Volume } from './Massing'
import { buildRoof } from './Roofs'
import type { BatchedMeshBuilder } from '../BatchedMeshBuilder'
import { emitCornice, emitDormer } from './Ornaments'
import type { FacadeConfig } from '../FacadeTexture'
import { createFacadeTexture, createEmissiveTexture } from '../FacadeTexture'

function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

/** Shift a color's RGB components by a signed [-1,1] amount per channel. */
function shiftColor(color: number, dR: number, dG: number, dB: number): number {
  const r = Math.max(0, Math.min(255, ((color >> 16) & 0xff) + Math.round(dR * 255)))
  const g = Math.max(0, Math.min(255, ((color >> 8) & 0xff) + Math.round(dG * 255)))
  const b = Math.max(0, Math.min(255, (color & 0xff) + Math.round(dB * 255)))
  return (r << 16) | (g << 8) | b
}

/** Cached facade materials keyed by FacadeConfig tuple. */
const _wallMatCache = new Map<string, THREE.MeshLambertMaterial>()
const _plainMatCache = new Map<number, THREE.MeshLambertMaterial>()

function facadeKey(cfg: FacadeConfig): string {
  return `${cfg.floors}_${cfg.width}_${cfg.wallColor.toString(16)}_${cfg.hasTimber}_${cfg.hasShutters}_${cfg.hasFlowerBox}_${cfg.style}`
}

function getFacadeMat(cfg: FacadeConfig): THREE.MeshLambertMaterial {
  const key = facadeKey(cfg)
  let mat = _wallMatCache.get(key)
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({
      map: createFacadeTexture(cfg, 'front'),
      emissiveMap: createEmissiveTexture(cfg),
      emissive: 0xffffff,
      emissiveIntensity: 0,
      flatShading: true,
    })
    _wallMatCache.set(key, mat)
  }
  return mat
}

function getPlainMat(wallColor: number): THREE.MeshLambertMaterial {
  let mat = _plainMatCache.get(wallColor)
  if (!mat) {
    mat = new THREE.MeshLambertMaterial({ color: wallColor, flatShading: true })
    _plainMatCache.set(wallColor, mat)
  }
  return mat
}

/** Walk the facade cache and update emissive intensity on all textured materials. */
export function setWallEmissiveIntensity(intensity: number): void {
  for (const mat of _wallMatCache.values()) {
    mat.emissiveIntensity = intensity
  }
}

export interface EmitVolumeContext {
  /** Building's placed world center (XZ). */
  centerX: number
  centerZ: number
  /** Building's base Y (terrain + elevation). */
  baseY: number
  /** Hash-seeded per-building texture options (timber/shutters/flower/style). */
  hasTimber: boolean
  hasShutters: boolean
  hasFlowerBox: boolean
  style: string
  palette: { wall: number; roof: number; door: number }
  /** Y-rotation of the building, radians. Currently 0 for all buildings. */
  rotationY: number
  /** Stable hash of the building id (for randomized ornament placement). */
  hash: number
  /** If true, suppress fancy roof ornaments (dormer/finial) for this volume. */
  skipRoofOrnaments?: boolean
}

export function emitVolume(
  v: Volume,
  ctx: EmitVolumeContext,
  wallMeshes: THREE.Mesh[],
  roofBatch: BatchedMeshBuilder,
  ornamentBatch: BatchedMeshBuilder,
): void {
  const wx = ctx.centerX + v.offsetX
  const wz = ctx.centerZ + v.offsetZ
  const wy = ctx.baseY + v.bottomY
  const floors = Math.max(1, v.floors ?? Math.max(1, Math.round(v.height / 0.9)))

  // --- Walls ---
  if (v.circular) {
    const r = v.width / 2
    const geo = new THREE.CylinderGeometry(r, r * 1.02, v.height, 10)
    geo.translate(wx, wy + v.height / 2, wz)
    const mat = v.textured
      ? getFacadeMatForCircular(v.wallColor)
      : getPlainMat(v.wallColor)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    wallMeshes.push(mesh)
  } else {
    const geo = new THREE.BoxGeometry(v.width, v.height, v.depth)
    geo.translate(wx, wy + v.height / 2, wz)
    if (v.textured) {
      const cfg: FacadeConfig = {
        floors,
        width: Math.max(1, Math.round(v.width)),
        wallColor: v.wallColor,
        roofColor: v.roofColor,
        doorColor: ctx.palette.door,
        hasTimber: ctx.hasTimber,
        hasAwning: false,
        hasShutters: ctx.hasShutters,
        hasFlowerBox: ctx.hasFlowerBox,
        style: ctx.style,
      }
      const facadeMat = getFacadeMat(cfg)
      const plainMat = getPlainMat(v.wallColor)
      // Face order: +X -X +Y -Y +Z(front) -Z(back)
      const mats = [plainMat, plainMat, plainMat, plainMat, facadeMat, facadeMat]
      const mesh = new THREE.Mesh(geo, mats)
      mesh.castShadow = true
      mesh.receiveShadow = true
      wallMeshes.push(mesh)
    } else {
      const mesh = new THREE.Mesh(geo, getPlainMat(v.wallColor))
      mesh.castShadow = true
      mesh.receiveShadow = true
      wallMeshes.push(mesh)
    }
  }

  // --- Stone base course — subtly-projecting darker band at wall bottom.
  //     Big enough to read at render scale (0.22 unit tall, 0.06 out).
  //     Skipped for chimneys and small cottage wings (looks wrong on them).
  if (!v.circular && v.role !== 'chimneyVol' && v.height > 0.9) {
    const baseH = Math.min(0.28, v.height * 0.18)
    const baseProj = 0.08
    const baseColor = shiftColor(v.wallColor, -0.12, -0.1, -0.08) // darker + slightly desaturated
    const bFront = new THREE.BoxGeometry(v.width + baseProj * 2, baseH, baseProj)
    bFront.translate(wx, wy + baseH / 2, wz + v.depth / 2 + baseProj / 2)
    ornamentBatch.addPositioned(bFront, baseColor)
    const bBack = new THREE.BoxGeometry(v.width + baseProj * 2, baseH, baseProj)
    bBack.translate(wx, wy + baseH / 2, wz - v.depth / 2 - baseProj / 2)
    ornamentBatch.addPositioned(bBack, baseColor)
    const bLeft = new THREE.BoxGeometry(baseProj, baseH, v.depth)
    bLeft.translate(wx - v.width / 2 - baseProj / 2, wy + baseH / 2, wz)
    ornamentBatch.addPositioned(bLeft, baseColor)
    const bRight = new THREE.BoxGeometry(baseProj, baseH, v.depth)
    bRight.translate(wx + v.width / 2 + baseProj / 2, wy + baseH / 2, wz)
    ornamentBatch.addPositioned(bRight, baseColor)
  }

  // --- Roof ---
  const roofGeo = buildRoof(v.width, v.depth, v.roofHeight, v.roofStyle, v.roofAxis)
  if (roofGeo) {
    roofGeo.translate(wx, wy + v.height, wz)
    roofBatch.addPositioned(roofGeo, v.roofColor)
  }

  // --- Cornice around top of wall (for rectangular textured volumes) ---
  if (v.cornice && !v.circular) {
    const topOfWall = wy + v.height
    emitCornice(
      ornamentBatch, wx, wz, topOfWall,
      v.width, v.depth, v.wallColor, v.role === 'tower' || v.role === 'spire',
    )
  }

  // --- Roof ornaments (dormers, spire finials) ---
  if (!ctx.skipRoofOrnaments) {
    emitRoofOrnaments(v, wx, wz, wy, ctx, roofBatch, ornamentBatch)
  }
}

/**
 * Emit roof features that read at render resolution: dormers on wide
 * gabled/hipped roofs, finials on spires, ridge knobs on steep pointed roofs.
 */
function emitRoofOrnaments(
  v: Volume,
  wx: number, wz: number, wy: number,
  ctx: EmitVolumeContext,
  roofBatch: BatchedMeshBuilder,
  ornamentBatch: BatchedMeshBuilder,
): void {
  const topOfWall = wy + v.height
  const h = ctx.hash + (v.role === 'tower' ? 1001 : v.role === 'spire' ? 2003 : 3007)

  // --- Dormers on gabled / steep / hipped roofs with sufficient footprint ---
  if (
    (v.roofStyle === 'gabled' || v.roofStyle === 'steep' || v.roofStyle === 'hipped') &&
    v.roofHeight > 0.35 &&
    Math.min(v.width, v.depth) >= 2.4 &&
    !v.circular &&
    rand01(h, 7) < 0.55
  ) {
    const dormerW = Math.min(0.95, v.width * 0.3)
    const dormerD = 0.35
    const dormerWallH = Math.min(0.45, v.roofHeight * 0.55)
    const dormerGableH = Math.min(0.3, v.roofHeight * 0.38)
    // Which face of the roof gets a dormer — pick the one perpendicular to
    // the ridge axis so the dormer has a proper gable.
    const dormerOnZ = v.roofAxis === 'x'
    // Walk along the ridge-parallel axis and try up to 2 positions.
    const count = rand01(h, 9) < 0.45 ? 2 : 1
    for (let i = 0; i < count; i++) {
      const tNorm = (i + 0.5) / count - 0.5 // -0.25 / 0.25 for count=2, 0 for count=1
      const jitter = (rand01(h, 11 + i) - 0.5) * 0.3
      const tAlong = tNorm + jitter
      const sideSign = i % 2 === 0 ? 1 : -1
      if (dormerOnZ) {
        emitDormer(
          ornamentBatch, sideSign > 0 ? 'z+' : 'z-',
          wx + tAlong * v.width, wz + sideSign * (v.depth / 2 - 0.35),
          topOfWall - 0.02,
          dormerW, dormerD, dormerWallH, dormerGableH,
          v.wallColor, v.roofColor,
        )
      } else {
        emitDormer(
          ornamentBatch, sideSign > 0 ? 'x+' : 'x-',
          wx + sideSign * (v.width / 2 - 0.35), wz + tAlong * v.depth,
          topOfWall - 0.02,
          dormerW, dormerD, dormerWallH, dormerGableH,
          v.wallColor, v.roofColor,
        )
      }
    }
  }

  // --- Finial on spires (cross for gothic, ball otherwise) ---
  if (v.roofStyle === 'spire' || v.roofStyle === 'pointed') {
    const peakY = topOfWall + v.roofHeight
    const ball = new THREE.SphereGeometry(v.roofStyle === 'spire' ? 0.18 : 0.14, 6, 4)
    ball.translate(wx, peakY + (v.roofStyle === 'spire' ? 0.16 : 0.12), wz)
    ornamentBatch.addPositioned(ball, 0xd4c070) // brass-ish

    if (v.roofStyle === 'spire' && rand01(h, 13) < 0.65) {
      // A small cross on top: two thin bars
      const armH = 0.3, armW = 0.25, armT = 0.05
      const vertical = new THREE.BoxGeometry(armT, armH, armT)
      vertical.translate(wx, peakY + 0.28 + armH / 2, wz)
      ornamentBatch.addPositioned(vertical, 0xd4c070)
      const horiz = new THREE.BoxGeometry(armW, armT, armT)
      horiz.translate(wx, peakY + 0.28 + armH * 0.7, wz)
      ornamentBatch.addPositioned(horiz, 0xd4c070)
    }
  }

  // --- Ridge knobs on steep roofs (small decorative bumps along ridge) ---
  if (
    v.roofStyle === 'steep' &&
    v.roofHeight > 0.5 &&
    Math.max(v.width, v.depth) >= 3 &&
    rand01(h, 15) < 0.4
  ) {
    const ridgeOnX = v.roofAxis === 'x'
    const ridgeLen = ridgeOnX ? v.width : v.depth
    const count = Math.min(4, Math.max(2, Math.floor(ridgeLen / 1.1)))
    for (let i = 0; i < count; i++) {
      const tAlong = (i + 0.5) / count - 0.5
      const px = wx + (ridgeOnX ? tAlong * v.width : 0)
      const pz = wz + (ridgeOnX ? 0 : tAlong * v.depth)
      const knob = new THREE.ConeGeometry(0.08, 0.22, 4)
      knob.translate(px, topOfWall + v.roofHeight + 0.11, pz)
      ornamentBatch.addPositioned(knob, v.roofColor)
    }
  }
}

function getFacadeMatForCircular(wallColor: number): THREE.MeshLambertMaterial {
  // Cylinder walls use plain material — the facade texture is designed for
  // flat BoxGeometry UVs. Towers get their visual variety from color only.
  return getPlainMat(wallColor)
}
