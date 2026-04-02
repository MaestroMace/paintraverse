// Palette quantization for pixel art output
// Maps each pixel to the nearest color in a limited palette

export interface Palette {
  name: string
  colors: [number, number, number][] // RGB triples
}

// DawnBringer 32 palette
export const DB32: Palette = {
  name: 'DB32',
  colors: [
    [0, 0, 0], [34, 32, 52], [69, 40, 60], [102, 57, 49],
    [143, 86, 59], [223, 113, 38], [217, 160, 102], [238, 195, 154],
    [251, 242, 54], [153, 229, 80], [106, 190, 48], [55, 148, 110],
    [75, 105, 47], [82, 75, 36], [50, 60, 57], [63, 63, 116],
    [48, 96, 130], [91, 110, 225], [99, 155, 255], [95, 205, 228],
    [203, 219, 252], [255, 255, 255], [155, 173, 183], [132, 126, 135],
    [105, 106, 106], [89, 86, 82], [118, 66, 138], [172, 50, 50],
    [217, 87, 99], [215, 123, 186], [143, 151, 74], [138, 111, 48]
  ]
}

// ENDESGA 32 palette
export const ENDESGA32: Palette = {
  name: 'ENDESGA-32',
  colors: [
    [190, 74, 47], [215, 118, 67], [234, 212, 170], [228, 166, 114],
    [184, 111, 80], [115, 62, 57], [62, 39, 49], [162, 38, 51],
    [228, 59, 68], [247, 118, 34], [254, 174, 52], [254, 231, 97],
    [99, 199, 77], [62, 137, 72], [38, 92, 66], [25, 60, 62],
    [18, 78, 137], [0, 153, 219], [44, 232, 245], [192, 203, 220],
    [139, 155, 180], [90, 105, 136], [58, 68, 102], [38, 43, 68],
    [24, 20, 37], [255, 0, 68], [104, 56, 108], [181, 80, 136],
    [246, 117, 122], [232, 183, 150], [194, 133, 105], [143, 77, 87]
  ]
}

// Traverse Town Night - warm amber lights against deep purple-blue shadows
export const TRAVERSE_NIGHT: Palette = {
  name: 'Traverse Night',
  colors: [
    // Deep shadow range (purple-blue, not gray)
    [6, 4, 18], [14, 10, 32], [22, 16, 44], [32, 24, 56],
    [42, 32, 64], [52, 38, 68],
    // Mid shadow (blue-purple transition)
    [60, 44, 72], [72, 52, 74], [80, 60, 70],
    // Warm building tones (amber/brown range)
    [100, 70, 44], [120, 84, 48], [140, 100, 56],
    [160, 114, 64], [176, 128, 72],
    // Warm light range (amber/orange/gold)
    [200, 148, 80], [220, 168, 88], [240, 186, 100],
    [255, 200, 110], [255, 170, 68], [255, 140, 40],
    // Hot highlights (light sources)
    [255, 220, 140], [255, 235, 180], [255, 245, 210],
    // Cool accent for variety (awnings, signs)
    [60, 80, 120], [80, 100, 140], [44, 66, 100],
    // Vegetation (muted at night)
    [30, 50, 28], [44, 64, 36], [56, 76, 44],
    // Stone/cobble
    [64, 58, 52], [80, 72, 64], [96, 86, 76]
  ]
}

export const PALETTES: Record<string, Palette> = {
  db32: DB32,
  endesga32: ENDESGA32,
  traverse_night: TRAVERSE_NIGHT
}

export function registerPalette(id: string, palette: Palette): void {
  PALETTES[id] = palette
}

// Quantize an ImageData to the nearest palette colors
export function quantizeImageData(
  imageData: ImageData,
  palette: Palette,
  dithering: 'none' | 'ordered' | 'floyd-steinberg' = 'none'
): ImageData {
  const { width, height, data } = imageData
  const output = new ImageData(new Uint8ClampedArray(data), width, height)

  if (dithering === 'floyd-steinberg') {
    floydSteinbergDither(output, palette)
  } else if (dithering === 'ordered') {
    orderedDither(output, palette)
  } else {
    // Simple nearest-color quantization
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = findNearestColor(data[i], data[i + 1], data[i + 2], palette)
      output.data[i] = r
      output.data[i + 1] = g
      output.data[i + 2] = b
      // Alpha stays the same
    }
  }

  return output
}

function findNearestColor(
  r: number, g: number, b: number, palette: Palette
): [number, number, number] {
  let bestDist = Infinity
  let best: [number, number, number] = [0, 0, 0]

  for (const [pr, pg, pb] of palette.colors) {
    // Weighted Euclidean distance (perceptually weighted)
    const dr = (r - pr) * 0.299
    const dg = (g - pg) * 0.587
    const db = (b - pb) * 0.114
    const dist = dr * dr + dg * dg + db * db
    if (dist < bestDist) {
      bestDist = dist
      best = [pr, pg, pb]
    }
  }

  return best
}

// Bayer matrix 4x4 for ordered dithering
const BAYER_4x4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5]
].map((row) => row.map((v) => (v / 16 - 0.5) * 16))

function orderedDither(imageData: ImageData, palette: Palette): void {
  const { width, data } = imageData
  for (let i = 0; i < data.length; i += 4) {
    const px = (i / 4) % width
    const py = Math.floor(i / 4 / width)
    const threshold = BAYER_4x4[py % 4][px % 4]

    const r = Math.max(0, Math.min(255, data[i] + threshold))
    const g = Math.max(0, Math.min(255, data[i + 1] + threshold))
    const b = Math.max(0, Math.min(255, data[i + 2] + threshold))

    const [nr, ng, nb] = findNearestColor(r, g, b, palette)
    data[i] = nr
    data[i + 1] = ng
    data[i + 2] = nb
  }
}

function floydSteinbergDither(imageData: ImageData, palette: Palette): void {
  const { width, height, data } = imageData
  const errors = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) errors[i] = data[i]

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = Math.max(0, Math.min(255, errors[i]))
      const g = Math.max(0, Math.min(255, errors[i + 1]))
      const b = Math.max(0, Math.min(255, errors[i + 2]))

      const [nr, ng, nb] = findNearestColor(r, g, b, palette)
      data[i] = nr
      data[i + 1] = ng
      data[i + 2] = nb

      const errR = r - nr
      const errG = g - ng
      const errB = b - nb

      const spread = (dx: number, dy: number, factor: number) => {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && nx < width && ny < height) {
          const ni = (ny * width + nx) * 4
          errors[ni] += errR * factor
          errors[ni + 1] += errG * factor
          errors[ni + 2] += errB * factor
        }
      }

      spread(1, 0, 7 / 16)
      spread(-1, 1, 3 / 16)
      spread(0, 1, 5 / 16)
      spread(1, 1, 1 / 16)
    }
  }
}

// Apply edge detection for pixel art outlines
export function applyOutlines(imageData: ImageData, outlineColor: [number, number, number] = [0, 0, 0]): ImageData {
  const { width, height, data } = imageData
  const output = new ImageData(new Uint8ClampedArray(data), width, height)

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4
      const r = data[i], g = data[i + 1], b = data[i + 2]

      // Check 4-connected neighbors for color difference
      const neighbors = [
        [(y - 1) * width + x, 0],
        [(y + 1) * width + x, 0],
        [y * width + (x - 1), 0],
        [y * width + (x + 1), 0]
      ]

      let isEdge = false
      for (const [ni] of neighbors) {
        const j = ni * 4
        const dr = Math.abs(r - data[j])
        const dg = Math.abs(g - data[j + 1])
        const db = Math.abs(b - data[j + 2])
        if (dr + dg + db > 80) {
          isEdge = true
          break
        }
      }

      if (isEdge) {
        output.data[i] = outlineColor[0]
        output.data[i + 1] = outlineColor[1]
        output.data[i + 2] = outlineColor[2]
      }
    }
  }

  return output
}
