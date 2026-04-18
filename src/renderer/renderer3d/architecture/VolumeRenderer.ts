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
import { emitCornice } from './Ornaments'
import type { FacadeConfig } from '../FacadeTexture'
import { createFacadeTexture, createEmissiveTexture } from '../FacadeTexture'

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
      v.width, v.depth, v.wallColor, v.wallColor > 0 ? false : false,
    )
  }
}

function getFacadeMatForCircular(wallColor: number): THREE.MeshLambertMaterial {
  // Cylinder walls use plain material — the facade texture is designed for
  // flat BoxGeometry UVs. Towers get their visual variety from color only.
  return getPlainMat(wallColor)
}
