/**
 * Procedural Facade Textures
 * Generates window/door/timber patterns on Canvas2D, used as Three.js textures.
 * Each unique facade config = one texture, reused across all buildings with same config.
 * This is how real games do it: paint detail on textures, not as individual geometry.
 */

import * as THREE from 'three'

interface FacadeConfig {
  floors: number
  width: number   // footprint width in tiles
  wallColor: number
  roofColor: number
  doorColor: number
  hasTimber: boolean
  hasAwning: boolean
  hasShutters: boolean
  hasFlowerBox: boolean
  style: string // 'ornate' | 'standard' | 'rustic' | 'weathered'
}
export type { FacadeConfig }

const TEXTURE_SCALE = 64 // pixels per tile unit
const _textureCache = new Map<string, THREE.CanvasTexture>()

function facadeKey(config: FacadeConfig, face: 'front' | 'side'): string {
  return `${config.floors}_${config.width}_${config.wallColor.toString(16)}_${config.doorColor.toString(16)}_${config.hasTimber}_${config.hasAwning}_${config.hasShutters}_${config.hasFlowerBox}_${config.style}_${face}`
}

function hexToRGB(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]
}

function colorStr(color: number, alpha: number = 1): string {
  const [r, g, b] = hexToRGB(color)
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha})` : `rgb(${r},${g},${b})`
}

function darkenColor(color: number, amount: number): number {
  const r = Math.max(0, ((color >> 16) & 0xff) * (1 - amount)) | 0
  const g = Math.max(0, ((color >> 8) & 0xff) * (1 - amount)) | 0
  const b = Math.max(0, (color & 0xff) * (1 - amount)) | 0
  return (r << 16) | (g << 8) | b
}

export function createFacadeTexture(config: FacadeConfig, face: 'front' | 'side'): THREE.CanvasTexture {
  const key = facadeKey(config, face)
  const cached = _textureCache.get(key)
  if (cached) return cached

  const w = config.width * TEXTURE_SCALE
  const h = config.floors * TEXTURE_SCALE + TEXTURE_SCALE / 2 // extra for ground floor height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  // Base wall color
  ctx.fillStyle = colorStr(config.wallColor)
  ctx.fillRect(0, 0, w, h)

  // Ground floor darker band
  const groundH = TEXTURE_SCALE * 0.4
  ctx.fillStyle = colorStr(darkenColor(config.wallColor, 0.1))
  ctx.fillRect(0, h - groundH, w, groundH)

  // Timber framing
  if (config.hasTimber) {
    ctx.strokeStyle = colorStr(darkenColor(config.wallColor, 0.35))
    ctx.lineWidth = 3
    // Horizontal beams
    for (let floor = 0; floor < config.floors; floor++) {
      const y = h - (floor + 1) * TEXTURE_SCALE + TEXTURE_SCALE * 0.15
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
    }
    // Vertical beams
    const beamSpacing = w / (config.width + 1)
    for (let i = 1; i <= config.width; i++) {
      ctx.beginPath(); ctx.moveTo(i * beamSpacing, 0); ctx.lineTo(i * beamSpacing, h); ctx.stroke()
    }
    // Diagonal crosses in each panel
    for (let floor = 0; floor < config.floors; floor++) {
      const fy = h - (floor + 1) * TEXTURE_SCALE
      for (let panel = 0; panel < config.width; panel++) {
        const px = panel * beamSpacing + beamSpacing / 2
        if ((floor + panel) % 3 === 0) {
          ctx.beginPath()
          ctx.moveTo(px - beamSpacing * 0.3, fy + TEXTURE_SCALE * 0.2)
          ctx.lineTo(px + beamSpacing * 0.3, fy + TEXTURE_SCALE * 0.8)
          ctx.stroke()
        }
      }
    }
  }

  // Windows
  const winW = TEXTURE_SCALE * 0.22
  const winH = TEXTURE_SCALE * 0.35
  const cols = Math.max(1, Math.floor(config.width * 1.5))
  const spacing = w / (cols + 1)

  for (let floor = 0; floor < config.floors; floor++) {
    const floorY = h - (floor + 1) * TEXTURE_SCALE
    for (let col = 0; col < cols; col++) {
      const wx = spacing * (col + 1) - winW / 2
      const wy = floorY + TEXTURE_SCALE * 0.25

      // Window frame (dark)
      ctx.fillStyle = colorStr(darkenColor(config.wallColor, 0.25))
      ctx.fillRect(wx - 2, wy - 2, winW + 4, winH + 4)

      // Window glass (dark blue-grey, slightly reflective)
      ctx.fillStyle = 'rgb(60,70,90)'
      ctx.fillRect(wx, wy, winW, winH)

      // Window mullion (cross bar)
      ctx.fillStyle = colorStr(darkenColor(config.wallColor, 0.15))
      ctx.fillRect(wx + winW / 2 - 1, wy, 2, winH)
      ctx.fillRect(wx, wy + winH / 2 - 1, winW, 2)

      // Shutters
      if (config.hasShutters && col % 2 === 0) {
        const shutterColor = darkenColor(config.wallColor, 0.2)
        ctx.fillStyle = colorStr(shutterColor)
        ctx.fillRect(wx - winW * 0.35, wy, winW * 0.3, winH)
        ctx.fillRect(wx + winW + winW * 0.05, wy, winW * 0.3, winH)
      }

      // Flower box
      if (config.hasFlowerBox && floor === 0 && col % 2 === 0) {
        ctx.fillStyle = colorStr(0x6a4a2a)
        ctx.fillRect(wx - 4, wy + winH + 2, winW + 8, 6)
        // Flowers
        const flowerColors = [0xff6688, 0xffaa44, 0xdd88dd]
        for (let fi = 0; fi < 3; fi++) {
          ctx.fillStyle = colorStr(flowerColors[fi])
          ctx.beginPath()
          ctx.arc(wx + (fi + 0.5) * winW / 3, wy + winH - 1, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  }

  // Door (front face only)
  if (face === 'front') {
    const doorW = TEXTURE_SCALE * 0.25
    const doorH = TEXTURE_SCALE * 0.55
    const doorX = w / 2 - doorW / 2
    const doorY = h - doorH

    // Door frame
    ctx.fillStyle = colorStr(darkenColor(config.doorColor, 0.2))
    ctx.fillRect(doorX - 3, doorY - 5, doorW + 6, doorH + 5)

    // Door body
    ctx.fillStyle = colorStr(config.doorColor)
    ctx.fillRect(doorX, doorY, doorW, doorH)

    // Door panels
    ctx.strokeStyle = colorStr(darkenColor(config.doorColor, 0.15))
    ctx.lineWidth = 1
    ctx.strokeRect(doorX + 3, doorY + 4, doorW - 6, doorH * 0.35)
    ctx.strokeRect(doorX + 3, doorY + doorH * 0.45, doorW - 6, doorH * 0.35)

    // Door handle
    ctx.fillStyle = colorStr(0xc0a040)
    ctx.beginPath()
    ctx.arc(doorX + doorW * 0.75, doorY + doorH * 0.5, 2, 0, Math.PI * 2)
    ctx.fill()

    // Awning over door
    if (config.hasAwning) {
      ctx.fillStyle = colorStr(darkenColor(config.roofColor, 0.1), 0.9)
      ctx.beginPath()
      ctx.moveTo(doorX - 10, doorY - 5)
      ctx.lineTo(doorX + doorW + 10, doorY - 5)
      ctx.lineTo(doorX + doorW + 15, doorY + 8)
      ctx.lineTo(doorX - 15, doorY + 8)
      ctx.closePath()
      ctx.fill()
    }
  }

  // Stone/brick base course
  ctx.fillStyle = colorStr(darkenColor(config.wallColor, 0.15))
  ctx.fillRect(0, h - 8, w, 8)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  _textureCache.set(key, texture)
  return texture
}

/** Create an emissive-only texture: black background, glowing window rectangles */
export function createEmissiveTexture(config: FacadeConfig): THREE.CanvasTexture {
  const key = `emissive_${facadeKey(config, 'front')}`
  const cached = _textureCache.get(key)
  if (cached) return cached

  const w = config.width * TEXTURE_SCALE
  const h = config.floors * TEXTURE_SCALE + TEXTURE_SCALE / 2
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  // Black background = no emission
  ctx.fillStyle = 'rgb(0,0,0)'
  ctx.fillRect(0, 0, w, h)

  // Glowing windows (same layout as facade)
  const winW = TEXTURE_SCALE * 0.22
  const winH = TEXTURE_SCALE * 0.35
  const cols = Math.max(1, Math.floor(config.width * 1.5))
  const spacing = w / (cols + 1)

  // Seeded random for consistent dark windows
  let rng = config.wallColor ^ (config.floors * 7919)
  const nextRng = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff }

  for (let floor = 0; floor < config.floors; floor++) {
    const floorY = h - (floor + 1) * TEXTURE_SCALE
    for (let col = 0; col < cols; col++) {
      // 20% chance window is dark (unlit room)
      if (nextRng() < 0.2) continue

      const wx = spacing * (col + 1) - winW / 2
      const wy = floorY + TEXTURE_SCALE * 0.25

      // Warm glow — slight color variation per window
      const warmth = nextRng()
      const r = 255
      const g = Math.floor(180 + warmth * 40)
      const b = Math.floor(60 + warmth * 30)
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(wx, wy, winW, winH)

      // Mullion cross casts slight shadow on glow
      ctx.fillStyle = 'rgba(0,0,0,0.3)'
      ctx.fillRect(wx + winW / 2 - 1, wy, 2, winH)
      ctx.fillRect(wx, wy + winH / 2 - 1, winW, 2)
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  _textureCache.set(key, texture)
  return texture
}

export function createFacadeConfig(
  obj: { id: string; properties: Record<string, unknown> },
  footprintW: number,
  palette: { wall: number; roof: number; door: number },
  hash: number
): FacadeConfig {
  return {
    floors: (obj.properties.floors as number) || 1 + (hash % 2),
    width: footprintW,
    wallColor: palette.wall,
    roofColor: palette.roof,
    doorColor: palette.door,
    hasTimber: !!obj.properties.hasTimber || hash % 3 === 0,
    hasAwning: !!obj.properties.hasAwning,
    hasShutters: !!obj.properties.hasShutters || hash % 4 !== 0,
    hasFlowerBox: !!obj.properties.hasFlowerBox,
    style: (obj.properties.style as string) || 'standard',
  }
}
