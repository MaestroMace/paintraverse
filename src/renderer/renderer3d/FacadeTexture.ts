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
  /** Optional override color for the ground-floor band — paints the lower
   *  TEXTURE_SCALE pixels of the canvas in this color, simulating the
   *  classic "stone shop on the ground floor, timber/plaster upstairs"
   *  pattern. Undefined = uniform wallColor. */
  groundFloorColor?: number
}
export type { FacadeConfig }

const TEXTURE_SCALE = 64 // pixels per tile unit
const _textureCache = new Map<string, THREE.CanvasTexture>()

function facadeKey(config: FacadeConfig, face: 'front' | 'side'): string {
  const gfc = config.groundFloorColor !== undefined ? config.groundFloorColor.toString(16) : 'none'
  return `${config.floors}_${config.width}_${config.wallColor.toString(16)}_${config.doorColor.toString(16)}_${config.hasTimber}_${config.hasAwning}_${config.hasShutters}_${config.hasFlowerBox}_${config.style}_${gfc}_${face}`
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

  // Ground-floor band — when groundFloorColor is set, paint the entire
  // lower TEXTURE_SCALE pixels in that contrasting color. Implies a stone
  // shop foundation under timber/plaster upper floors. Otherwise just a
  // subtle darker stripe matches the original look.
  if (config.groundFloorColor !== undefined) {
    const gh = TEXTURE_SCALE
    ctx.fillStyle = colorStr(config.groundFloorColor)
    ctx.fillRect(0, h - gh, w, gh)
    // Suggest stone courses with a few horizontal banding lines in a
    // slightly darker shade — adds masonry texture without spending verts.
    ctx.strokeStyle = colorStr(darkenColor(config.groundFloorColor, 0.18))
    ctx.lineWidth = 1
    for (let row = 1; row < 4; row++) {
      const y = h - gh + row * (gh / 4)
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
    }
    // Vertical "block edge" lines, offset per row for staggered courses.
    ctx.strokeStyle = colorStr(darkenColor(config.groundFloorColor, 0.22))
    for (let row = 0; row < 4; row++) {
      const yTop = h - gh + row * (gh / 4)
      const yBot = yTop + gh / 4
      const colSpacing = TEXTURE_SCALE * 0.45
      const offset = (row % 2) * colSpacing * 0.5
      for (let x = offset; x < w; x += colSpacing) {
        ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke()
      }
    }
  } else {
    const groundH = TEXTURE_SCALE * 0.4
    ctx.fillStyle = colorStr(darkenColor(config.wallColor, 0.1))
    ctx.fillRect(0, h - groundH, w, groundH)
  }

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
      // Per-window state with mood variety:
      //   ~25% dark (room unlit / shutters drawn)
      //   ~10% dim (a candle, low intensity)
      //   ~10% cool blue-white (workshop / scribe / oil lamp with glass shade)
      //   ~5%  bright sun-yellow (a hearth fire visible inside)
      //   rest: warm amber (the standard glow)
      const r1 = nextRng()
      let kind: 'dark' | 'dim' | 'cool' | 'bright' | 'amber'
      if (r1 < 0.25) kind = 'dark'
      else if (r1 < 0.35) kind = 'dim'
      else if (r1 < 0.45) kind = 'cool'
      else if (r1 < 0.50) kind = 'bright'
      else kind = 'amber'
      if (kind === 'dark') continue

      const wx = spacing * (col + 1) - winW / 2
      const wy = floorY + TEXTURE_SCALE * 0.25

      const warmth = nextRng()
      let r: number, g: number, b: number
      switch (kind) {
        case 'dim': {
          // Faint orange ember
          const k = 0.45 + warmth * 0.15
          r = Math.floor(180 * k); g = Math.floor(120 * k); b = Math.floor(50 * k)
          break
        }
        case 'cool': {
          // Soft blue-white workshop light — channels capped so the window
          // can't saturate to pure white under bloom at dusk. Still reads
          // as a cool interior against warm amber neighbors.
          r = 150 + Math.floor(warmth * 20)
          g = 170 + Math.floor(warmth * 20)
          b = 220
          break
        }
        case 'bright': {
          // Rich amber hearth — brighter than default amber but clamped so
          // it never clips to white under bloom. Replaces the previous
          // pure-white-yellow which read as an overexposed lightbulb.
          r = 240; g = 190 + Math.floor(warmth * 20); b = 90
          break
        }
        default: {
          // Standard warm amber (existing palette)
          r = 255
          g = Math.floor(180 + warmth * 40)
          b = Math.floor(60 + warmth * 30)
        }
      }
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
