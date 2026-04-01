// === Noise utilities for procedural generation ===

// Simple seeded PRNG (mulberry32)
export function createRNG(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 2D Simplex-like noise (value noise with interpolation)
export class SimplexNoise {
  private perm: number[]
  private rng: () => number

  constructor(seed: number) {
    this.rng = createRNG(seed)
    this.perm = Array.from({ length: 512 }, (_, i) => i % 256)
    // Fisher-Yates shuffle first 256
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1))
      ;[this.perm[i], this.perm[j]] = [this.perm[j], this.perm[i]]
    }
    // Duplicate for overflow
    for (let i = 0; i < 256; i++) {
      this.perm[i + 256] = this.perm[i]
    }
  }

  private grad(hash: number, x: number, y: number): number {
    const h = hash & 3
    const u = h < 2 ? x : y
    const v = h < 2 ? y : x
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v)
  }

  private fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10)
  }

  private lerp(a: number, b: number, t: number): number {
    return a + t * (b - a)
  }

  noise2D(x: number, y: number): number {
    const xi = Math.floor(x) & 255
    const yi = Math.floor(y) & 255
    const xf = x - Math.floor(x)
    const yf = y - Math.floor(y)
    const u = this.fade(xf)
    const v = this.fade(yf)

    const aa = this.perm[this.perm[xi] + yi]
    const ab = this.perm[this.perm[xi] + yi + 1]
    const ba = this.perm[this.perm[xi + 1] + yi]
    const bb = this.perm[this.perm[xi + 1] + yi + 1]

    return this.lerp(
      this.lerp(this.grad(aa, xf, yf), this.grad(ba, xf - 1, yf), u),
      this.lerp(this.grad(ab, xf, yf - 1), this.grad(bb, xf - 1, yf - 1), u),
      v
    )
  }

  // Fractal Brownian Motion for more natural terrain
  fbm(x: number, y: number, octaves: number = 4, lacunarity: number = 2, gain: number = 0.5): number {
    let value = 0
    let amplitude = 1
    let frequency = 1
    let maxValue = 0

    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.noise2D(x * frequency, y * frequency)
      maxValue += amplitude
      amplitude *= gain
      frequency *= lacunarity
    }

    return value / maxValue
  }
}

// Poisson disk sampling for even object distribution
export function poissonDiskSampling(
  width: number,
  height: number,
  minDistance: number,
  rng: () => number,
  maxAttempts: number = 30
): { x: number; y: number }[] {
  const cellSize = minDistance / Math.SQRT2
  const gridW = Math.ceil(width / cellSize)
  const gridH = Math.ceil(height / cellSize)
  const grid: (number | null)[][] = Array.from({ length: gridH }, () =>
    Array.from({ length: gridW }, () => null)
  )
  const points: { x: number; y: number }[] = []
  const active: number[] = []

  const addPoint = (x: number, y: number) => {
    const idx = points.length
    points.push({ x, y })
    active.push(idx)
    const gx = Math.floor(x / cellSize)
    const gy = Math.floor(y / cellSize)
    if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) {
      grid[gy][gx] = idx
    }
  }

  // Start with a random point
  addPoint(rng() * width, rng() * height)

  while (active.length > 0) {
    const randIdx = Math.floor(rng() * active.length)
    const pointIdx = active[randIdx]
    const point = points[pointIdx]
    let found = false

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const angle = rng() * Math.PI * 2
      const dist = minDistance + rng() * minDistance
      const nx = point.x + Math.cos(angle) * dist
      const ny = point.y + Math.sin(angle) * dist

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue

      const gx = Math.floor(nx / cellSize)
      const gy = Math.floor(ny / cellSize)
      let tooClose = false

      for (let dy = -2; dy <= 2 && !tooClose; dy++) {
        for (let dx = -2; dx <= 2 && !tooClose; dx++) {
          const cx = gx + dx
          const cy = gy + dy
          if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) continue
          const neighborIdx = grid[cy][cx]
          if (neighborIdx === null) continue
          const neighbor = points[neighborIdx]
          const ddx = neighbor.x - nx
          const ddy = neighbor.y - ny
          if (ddx * ddx + ddy * ddy < minDistance * minDistance) {
            tooClose = true
          }
        }
      }

      if (!tooClose) {
        addPoint(nx, ny)
        found = true
        break
      }
    }

    if (!found) {
      active.splice(randIdx, 1)
    }
  }

  return points
}
