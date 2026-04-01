// Palette extraction from reference images using median cut algorithm
// Works entirely client-side via Canvas API

import type { Palette } from '../renderer3d/PaletteQuantizer'

type RGB = [number, number, number]

export interface ExtractedPalette {
  palette: Palette
  warmth: number        // 0 = cool/blue, 1 = warm/amber
  saturation: number    // 0 = desaturated, 1 = vivid
  brightness: number    // 0 = dark, 1 = bright
  darks: RGB[]
  midtones: RGB[]
  lights: RGB[]
  accents: RGB[]
}

export async function extractPalette(
  imageDataURL: string,
  colorCount: number = 24
): Promise<ExtractedPalette> {
  // Load image into offscreen canvas
  const img = await loadImage(imageDataURL)
  const { data } = getDownsampledPixels(img, 100)

  // Collect all pixels as RGB
  const pixels: RGB[] = []
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
    if (a < 128) continue // skip transparent
    // Skip near-black and near-white (noise)
    const lum = r * 0.299 + g * 0.587 + b * 0.114
    if (lum < 8 || lum > 248) continue
    pixels.push([r, g, b])
  }

  if (pixels.length === 0) {
    return emptyPalette()
  }

  // Run median cut
  const rawColors = medianCut(pixels, colorCount)

  // Merge perceptually similar colors
  const merged = mergeClose(rawColors, 25)

  // Sort by luminance
  merged.sort((a, b) => luminance(a) - luminance(b))

  // Analyze
  const analysis = analyzeColors(merged)

  return {
    palette: {
      name: 'Inspiration',
      colors: merged
    },
    ...analysis
  }
}

// === Median Cut Algorithm ===

function medianCut(pixels: RGB[], targetCount: number): RGB[] {
  if (pixels.length === 0) return []

  let buckets: RGB[][] = [pixels]

  while (buckets.length < targetCount) {
    // Find the bucket with the largest range on any channel
    let bestIdx = 0
    let bestRange = -1
    let bestChannel = 0

    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i]
      if (bucket.length < 2) continue

      for (let ch = 0; ch < 3; ch++) {
        let min = 255, max = 0
        for (const px of bucket) {
          if (px[ch] < min) min = px[ch]
          if (px[ch] > max) max = px[ch]
        }
        const range = max - min
        if (range > bestRange) {
          bestRange = range
          bestIdx = i
          bestChannel = ch
        }
      }
    }

    if (bestRange <= 0) break

    // Split the best bucket at the median of the widest channel
    const bucket = buckets[bestIdx]
    bucket.sort((a, b) => a[bestChannel] - b[bestChannel])
    const mid = Math.floor(bucket.length / 2)

    buckets.splice(bestIdx, 1, bucket.slice(0, mid), bucket.slice(mid))
  }

  // Average each bucket to get representative colors
  return buckets
    .filter((b) => b.length > 0)
    .map((bucket) => {
      let r = 0, g = 0, b = 0
      for (const px of bucket) {
        r += px[0]; g += px[1]; b += px[2]
      }
      const n = bucket.length
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)] as RGB
    })
}

// === Color Analysis ===

function analyzeColors(colors: RGB[]): {
  warmth: number; saturation: number; brightness: number
  darks: RGB[]; midtones: RGB[]; lights: RGB[]; accents: RGB[]
} {
  const darks: RGB[] = []
  const midtones: RGB[] = []
  const lights: RGB[] = []
  const accents: RGB[] = []

  let totalWarmth = 0
  let totalSaturation = 0
  let totalBrightness = 0

  for (const c of colors) {
    const lum = luminance(c)
    const sat = colorSaturation(c)
    const warm = colorWarmth(c)

    if (lum < 0.25) darks.push(c)
    else if (lum < 0.65) midtones.push(c)
    else lights.push(c)

    if (sat > 0.4) accents.push(c)

    totalWarmth += warm
    totalSaturation += sat
    totalBrightness += lum
  }

  const n = colors.length || 1
  return {
    warmth: totalWarmth / n,
    saturation: totalSaturation / n,
    brightness: totalBrightness / n,
    darks, midtones, lights, accents
  }
}

// === Helpers ===

function luminance(c: RGB): number {
  return (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255
}

function colorSaturation(c: RGB): number {
  const max = Math.max(c[0], c[1], c[2])
  const min = Math.min(c[0], c[1], c[2])
  if (max === 0) return 0
  return (max - min) / max
}

function colorWarmth(c: RGB): number {
  // Warm = more red/yellow, Cool = more blue
  // Simple heuristic: (r - b) normalized to 0-1
  return Math.max(0, Math.min(1, (c[0] - c[2] + 255) / 510))
}

function colorDistance(a: RGB, b: RGB): number {
  // Perceptually weighted distance
  const dr = (a[0] - b[0]) * 0.299
  const dg = (a[1] - b[1]) * 0.587
  const db = (a[2] - b[2]) * 0.114
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

function mergeClose(colors: RGB[], threshold: number): RGB[] {
  const result: RGB[] = []
  const used = new Set<number>()

  for (let i = 0; i < colors.length; i++) {
    if (used.has(i)) continue

    let r = colors[i][0], g = colors[i][1], b = colors[i][2]
    let count = 1

    for (let j = i + 1; j < colors.length; j++) {
      if (used.has(j)) continue
      if (colorDistance(colors[i], colors[j]) < threshold) {
        r += colors[j][0]; g += colors[j][1]; b += colors[j][2]
        count++
        used.add(j)
      }
    }

    result.push([Math.round(r / count), Math.round(g / count), Math.round(b / count)])
    used.add(i)
  }

  return result
}

function loadImage(dataURL: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = dataURL
  })
}

function getDownsampledPixels(img: HTMLImageElement, maxDim: number): ImageData {
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
  const w = Math.round(img.width * scale)
  const h = Math.round(img.height * scale)

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, w, h)
  return ctx.getImageData(0, 0, w, h)
}

function emptyPalette(): ExtractedPalette {
  return {
    palette: { name: 'Inspiration', colors: [[128, 128, 128]] },
    warmth: 0.5, saturation: 0, brightness: 0.5,
    darks: [], midtones: [[128, 128, 128]], lights: [], accents: []
  }
}
