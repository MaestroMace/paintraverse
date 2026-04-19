/**
 * Procedural cobblestone texture.
 *
 * Generates a tileable Canvas2D pattern of irregular stone polygons with
 * grout lines between them. Cached by (baseColor, darken) so a whole map
 * of road tiles shares one texture per unique base color — two textures
 * max (road + alley). Applied to road tiles as a second material on the
 * ground mesh so the road reads as laid stone rather than a vertex-
 * colored quad.
 *
 * The stones are generated as voronoi-like irregular polygons from
 * hash-jittered site points. This avoids the hex-grid look of the
 * previous puck approach and reads as real cobbles from above or at
 * oblique camera angles.
 */

import * as THREE from 'three'

const SIZE = 128
const _cache = new Map<string, THREE.CanvasTexture>()

function cacheKey(baseColor: number, darken: number): string {
  return `${baseColor.toString(16)}_${darken.toFixed(2)}`
}

function hexToRGB(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]
}

/** Deterministic 0..1 pseudo-random for the site layout. */
function rand(seed: number): number {
  const n = (seed * 2654435761) >>> 0
  return n / 0xffffffff
}

/** Generate a set of site points with light jitter off a grid. Voronoi
 *  cells around these become the stones. Returns points in [0, SIZE]². */
function generateSites(count: number, seed: number): Array<[number, number]> {
  const pts: Array<[number, number]> = []
  // Grid of cells slightly larger than what we want as stones, jittered.
  const grid = Math.max(3, Math.round(Math.sqrt(count)))
  const cell = SIZE / grid
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const jx = (rand(seed + gy * grid + gx) - 0.5) * cell * 0.75
      const jy = (rand(seed + gy * grid + gx + 999) - 0.5) * cell * 0.75
      pts.push([gx * cell + cell / 2 + jx, gy * cell + cell / 2 + jy])
    }
  }
  return pts
}

/** Find the nearest site index to (px, py). Toroidal wrap so the texture
 *  tiles cleanly (stones on the edge pair with stones on the opposite
 *  edge rather than being cut off). */
function nearestSite(
  px: number, py: number,
  sites: Array<[number, number]>,
): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < sites.length; i++) {
    let dx = Math.abs(sites[i][0] - px)
    let dy = Math.abs(sites[i][1] - py)
    if (dx > SIZE / 2) dx = SIZE - dx
    if (dy > SIZE / 2) dy = SIZE - dy
    const d = dx * dx + dy * dy
    if (d < bestD) { bestD = d; best = i }
  }
  return best
}

export function createCobbleTexture(
  baseColor: number,
  darken: number = 0,
): THREE.CanvasTexture {
  const key = cacheKey(baseColor, darken)
  const cached = _cache.get(key)
  if (cached) return cached

  const [br, bg, bb] = hexToRGB(baseColor)
  const darkMul = 1 - darken
  const baseR = br * darkMul, baseG = bg * darkMul, baseB = bb * darkMul

  const canvas = document.createElement('canvas')
  canvas.width = SIZE; canvas.height = SIZE
  const ctx = canvas.getContext('2d')!

  // ~30 stones per tile. Each site gets a per-stone color offset.
  const seed = (baseColor ^ Math.floor(darken * 1000)) >>> 0
  const sites = generateSites(30, seed)
  const siteColor = sites.map((_, i) => {
    const jr = (rand(seed + i * 17 + 3) - 0.5) * 0.22
    const jg = (rand(seed + i * 19 + 5) - 0.5) * 0.22
    const jb = (rand(seed + i * 23 + 7) - 0.5) * 0.22
    return {
      r: Math.max(0, Math.min(255, baseR * (1 + jr))),
      g: Math.max(0, Math.min(255, baseG * (1 + jg))),
      b: Math.max(0, Math.min(255, baseB * (1 + jb))),
    }
  })

  // Pixel-by-pixel: assign each pixel to its nearest site, paint that
  // site's color. This produces voronoi regions = stones with grout
  // appearing naturally at cell boundaries when we darken edge pixels.
  const img = ctx.createImageData(SIZE, SIZE)
  const data = img.data
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      // Find nearest and second-nearest for edge detection.
      let best = 0, secondBest = 0
      let bestD = Infinity, secondD = Infinity
      for (let i = 0; i < sites.length; i++) {
        let dx = Math.abs(sites[i][0] - x)
        let dy = Math.abs(sites[i][1] - y)
        if (dx > SIZE / 2) dx = SIZE - dx
        if (dy > SIZE / 2) dy = SIZE - dy
        const d = dx * dx + dy * dy
        if (d < bestD) {
          secondD = bestD; secondBest = best
          bestD = d; best = i
        } else if (d < secondD) {
          secondD = d; secondBest = i
        }
      }
      // Edge detection: if the difference between nearest and 2nd-nearest
      // distances is small, we're at a cell boundary → grout (dark).
      const edgeness = Math.sqrt(secondD) - Math.sqrt(bestD)
      const isGrout = edgeness < 1.5
      const c = siteColor[best]
      const idx = (y * SIZE + x) * 4
      if (isGrout) {
        // Grout: 45% of stone color.
        data[idx] = Math.round(c.r * 0.45)
        data[idx + 1] = Math.round(c.g * 0.45)
        data[idx + 2] = Math.round(c.b * 0.45)
      } else {
        // Stone + subtle per-pixel speckle for texture noise.
        const n = (rand(seed + x * 73856 + y * 19349) - 0.5) * 12
        data[idx] = Math.max(0, Math.min(255, Math.round(c.r + n)))
        data[idx + 1] = Math.max(0, Math.min(255, Math.round(c.g + n)))
        data[idx + 2] = Math.max(0, Math.min(255, Math.round(c.b + n)))
      }
      data[idx + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true
  _cache.set(key, tex)
  return tex
}
