/**
 * Procedural Facade Textures
 * Generates window/door/timber patterns on Canvas2D, used as Three.js textures.
 * Each unique facade config = one texture, reused across all buildings with same config.
 * This is how real games do it: paint detail on textures, not as individual geometry.
 */

import * as THREE from 'three'
import { STOREY_HEIGHT } from './scale'

interface FacadeConfig {
  floors: number
  /** Wall width in METRES. The field used to be documented as tiles, but the
   *  caller has passed `Math.round(v.width)` — world units — since the tile
   *  rescale, so the horizontal axis was already metric and only the comment
   *  was wrong. Every layout number below now says so explicitly. */
  width: number
  /** Wall height in METRES. Without this the vertical axis was laid out in
   *  "floors + 0.5" units and stretched over the wall, which is what made a
   *  door 0.55 of a made-up unit — 0.79m in practice, against a 1.75m person. */
  wallH: number
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

/** Texture pixels per METRE. Both canvas axes are metric — see createFacadeTexture. */
const TEXTURE_SCALE = 32
const STOREY_M = STOREY_HEIGHT
const _textureCache = new Map<string, THREE.CanvasTexture>()

/**
 * Quantize a 24-bit color to 4 bits per channel (12 bits total) before
 * using it as a cache key. Two near-identical wallColors that differ
 * only in low-order bits will hash to the SAME quantized key, sharing
 * one cached texture and one material — and therefore one merged
 * wall mesh in coalesceWalls. Visually the 16-step-per-channel ramp
 * is well below the per-building variation we already get from
 * weathering / mood lighting; the eye can't distinguish #6b3a1f
 * from #6c3b1e at building scale.
 *
 * Drops the unique-facade-material count significantly: with N
 * palettes generating dozens of slightly-different wallColors,
 * quantization collapses them to ~16-32 distinct buckets.
 */
function quantizeColor(c: number): number {
  const r = (c >> 16) & 0xf0
  const g = (c >> 8) & 0xf0
  const b = c & 0xf0
  return (r << 16) | (g << 8) | b
}

function facadeKey(config: FacadeConfig, face: 'front' | 'side'): string {
  // Cache key uses QUANTIZED colors so near-identical wallColors collapse
  // into the same texture/material, allowing coalesceWalls to merge their
  // wall meshes. The CANVAS still paints with the full-fidelity colors
  // (see createFacadeTexture below) — only the cache identity is quantized.
  const wq = quantizeColor(config.wallColor)
  const dq = quantizeColor(config.doorColor)
  const gfc = config.groundFloorColor !== undefined
    ? quantizeColor(config.groundFloorColor).toString(16)
    : 'none'
  return `${config.floors}_${Math.round(config.width * 2)}_${Math.round(config.wallH * 2)}_${wq.toString(16)}_${dq.toString(16)}_${config.hasTimber}_${config.hasAwning}_${config.hasShutters}_${config.hasFlowerBox}_${config.style}_${gfc}_${face}`
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

/** Tint a color toward white by `amount` (0..1). Used for masonry trim
 *  (lintels/sills) that catch the dusk light and read as a lighter stone
 *  band against the wall — the horizontal banding the eye uses to parse
 *  a row of windows at distance. Clamped at 255 per channel. */
function lightenColor(color: number, amount: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) + (255 - ((color >> 16) & 0xff)) * amount) | 0
  const g = Math.min(255, ((color >> 8) & 0xff) + (255 - ((color >> 8) & 0xff)) * amount) | 0
  const b = Math.min(255, (color & 0xff) + (255 - (color & 0xff)) * amount) | 0
  return (r << 16) | (g << 8) | b
}

export function createFacadeTexture(config: FacadeConfig, face: 'front' | 'side'): THREE.CanvasTexture {
  const key = facadeKey(config, face)
  const cached = _textureCache.get(key)
  if (cached) return cached

  // ONE texture pixel-per-metre in BOTH axes. Horizontal already worked this
  // way by accident; vertical was floors-based, so a taller building squeezed
  // the same drawing into more wall and every opening shrank. With both axes
  // metric an opening drawn at 2.05 units lands on the wall at 2.05 metres,
  // whatever the building.
  const M = TEXTURE_SCALE
  const wallWm = Math.max(1, config.width)
  const wallHm = Math.max(1.5, config.wallH)
  const w = Math.round(wallWm * M)
  const h = Math.round(wallHm * M)
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
    const gh = STOREY_M * M
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
      const y = h - (floor + 1) * STOREY_M * M + M * 0.15
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
    }
    // Vertical beams
    const bays = Math.max(1, Math.round(wallWm / 1.7))
    const beamSpacing = w / (bays + 1)
    for (let i = 1; i <= bays; i++) {
      ctx.beginPath(); ctx.moveTo(i * beamSpacing, 0); ctx.lineTo(i * beamSpacing, h); ctx.stroke()
    }
    // Diagonal crosses in each panel
    for (let floor = 0; floor < config.floors; floor++) {
      const fy = h - (floor + 1) * STOREY_M * M
      for (let panel = 0; panel < bays; panel++) {
        const px = panel * beamSpacing + beamSpacing / 2
        if ((floor + panel) % 3 === 0) {
          ctx.beginPath()
          ctx.moveTo(px - beamSpacing * 0.3, fy + STOREY_M * M * 0.2)
          ctx.lineTo(px + beamSpacing * 0.3, fy + STOREY_M * M * 0.8)
          ctx.stroke()
        }
      }
    }
  }

  // STRING COURSES — a shallow band of stone at each floor line, running the
  // full width. Almost every masonry building of this period has them, and
  // they are the cheapest thing that stops a large wall reading as a blank
  // panel: they give the eye a horizontal rhythm and a scale reference even
  // where there are no windows.
  {
    const bandH = Math.max(2, 0.14 * M)
    const light = colorStr(lightenColor(config.wallColor, 0.16))
    const shade = colorStr(darkenColor(config.wallColor, 0.24))
    for (let fl = 1; fl * STOREY_M < wallHm - 0.4; fl++) {
      const y = h - fl * STOREY_M * M
      ctx.fillStyle = light
      ctx.fillRect(0, y - bandH, w, bandH)
      ctx.fillStyle = shade
      ctx.fillRect(0, y, w, Math.max(1, bandH * 0.35))
    }
    // Plinth at the base — the same idea where the wall meets the ground.
    ctx.fillStyle = shade
    ctx.fillRect(0, h - Math.max(2, 0.3 * M), w, Math.max(2, 0.3 * M))
    ctx.fillStyle = light
    ctx.fillRect(0, h - Math.max(2, 0.3 * M) - Math.max(1, 0.05 * M), w, Math.max(1, 0.05 * M))
  }

  // Windows — a real sash is about 1.0m x 1.35m with its sill 0.95m off the
  // floor, and windows sit roughly every 2.4m along a facade. All four of
  // those are metres, so all four survive any future change to the tile
  // factor; the previous fractions-of-a-made-up-unit did not.
  const WIN_W_M = 1.0, WIN_H_M = 1.35, SILL_M = 0.95, WIN_PITCH_M = 2.4
  const winW = WIN_W_M * M
  const winH = WIN_H_M * M
  const cols = Math.max(1, Math.round(wallWm / WIN_PITCH_M))
  const spacing = w / (cols + 1)
  // Storeys are laid out from the ground up at their true height, so the
  // top floor is dropped when the wall is not tall enough to hold it rather
  // than every floor being compressed to fit.
  const storeyPx = STOREY_M * M
  const floorsThatFit = Math.max(1, Math.min(config.floors, Math.floor(wallHm / STOREY_M)))

  for (let floor = 0; floor < floorsThatFit; floor++) {
    const floorY = h - (floor + 1) * storeyPx
    for (let col = 0; col < cols; col++) {
      const wx = spacing * (col + 1) - winW / 2
      const wy = floorY + (STOREY_M - SILL_M - WIN_H_M) * M

      // Window frame (dark)
      ctx.fillStyle = colorStr(darkenColor(config.wallColor, 0.25))
      ctx.fillRect(wx - 2, wy - 2, winW + 4, winH + 4)

      // Masonry trim: a lintel (header) above and a sill (ledge) below.
      // Thin light bands that catch the light + a darker seam under each so
      // they read as projecting stone. This is what turns a flat grid of
      // squares into a legible row of windows at walkaround distance.
      const trimLight = colorStr(lightenColor(config.wallColor, 0.28))
      const trimShadow = colorStr(darkenColor(config.wallColor, 0.3))
      // Lintel — spans a touch wider than the frame, sits just above it.
      ctx.fillStyle = trimLight
      ctx.fillRect(wx - 4, wy - 2 - 3, winW + 8, 3)
      ctx.fillStyle = trimShadow
      ctx.fillRect(wx - 4, wy - 2, winW + 8, 1)
      // Sill — overhangs wider than the lintel, with a drop shadow beneath
      // to imply it projects from the wall face.
      ctx.fillStyle = trimLight
      ctx.fillRect(wx - 5, wy + winH + 2, winW + 10, 3)
      ctx.fillStyle = trimShadow
      ctx.fillRect(wx - 5, wy + winH + 5, winW + 10, 1)

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
    // A door you can walk through: 0.95m x 2.05m.
    const doorW = 0.95 * M
    const doorH = 2.05 * M
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

  // Same metric canvas as createFacadeTexture — if these two disagree the lit
  // windows sit somewhere other than the painted ones.
  const M = TEXTURE_SCALE
  const wallWm = Math.max(1, config.width)
  const wallHm = Math.max(1.5, config.wallH)
  const w = Math.round(wallWm * M)
  const h = Math.round(wallHm * M)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  // Black background = no emission
  ctx.fillStyle = 'rgb(0,0,0)'
  ctx.fillRect(0, 0, w, h)

  // Glowing windows — layout duplicated from createFacadeTexture and it has to
  // stay identical, so the numbers come from the same named metres.
  const winW = 1.0 * M
  const winH = 1.35 * M
  const cols = Math.max(1, Math.round(wallWm / 2.4))
  const spacing = w / (cols + 1)
  const storeyPx = STOREY_M * M
  const floorsThatFit = Math.max(1, Math.min(config.floors, Math.floor(wallHm / STOREY_M)))

  // Seeded random for consistent dark windows
  let rng = config.wallColor ^ (config.floors * 7919)
  const nextRng = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff }

  for (let floor = 0; floor < floorsThatFit; floor++) {
    const floorY = h - (floor + 1) * storeyPx
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
      const wy = floorY + (STOREY_M - 0.95 - 1.35) * M

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
