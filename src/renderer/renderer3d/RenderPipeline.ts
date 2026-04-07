import type { MapDocument, RenderCamera, ObjectDefinition } from '../core/types'
import type { BuildingPalette } from '../inspiration/StyleMapper'
import { quantizeImageData, applyOutlines, PALETTES } from './PaletteQuantizer'
import { renderCanvas2D } from './Canvas2DRenderer'

export interface RenderOptions {
  paletteId: string
  dithering: 'none' | 'ordered' | 'floyd-steinberg'
  outlines: boolean
  outlineThreshold: number
}

export interface RenderResult {
  canvas: HTMLCanvasElement
  width: number
  height: number
  imageDataURL: string
}

const DEFAULT_OPTIONS: RenderOptions = {
  paletteId: 'db32',
  dithering: 'none',
  outlines: false,
  outlineThreshold: 80
}

export function renderPixelArt(
  map: MapDocument,
  camera: RenderCamera,
  objectDefs: ObjectDefinition[],
  options: Partial<RenderOptions> = {},
  buildingPalettes?: BuildingPalette[] | null
): RenderResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const { outputWidth, outputHeight } = camera

  // Render scene using pure Canvas2D (no WebGL — avoids SwiftShader crashes)
  let imageData = renderCanvas2D(map, camera, objectDefs, buildingPalettes, 0)

  // Post-processing pipeline (all CPU, no WebGL)
  applyColorGrading(imageData, map.environment.timeOfDay)
  applyBloom(imageData, outputWidth, outputHeight)

  const palette = PALETTES[opts.paletteId] || PALETTES['db32']
  imageData = quantizeImageData(imageData, palette, opts.dithering)

  if (opts.outlines) {
    imageData = applyOutlines(imageData)
  }

  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = outputWidth
  outputCanvas.height = outputHeight
  const ctx = outputCanvas.getContext('2d')!
  ctx.putImageData(imageData, 0, 0)

  return {
    canvas: outputCanvas,
    width: outputWidth,
    height: outputHeight,
    imageDataURL: outputCanvas.toDataURL('image/png')
  }
}

// === Color Grading ===

function applyColorGrading(imageData: ImageData, timeOfDay: number): void {
  const { data } = imageData
  const isNight = timeOfDay < 5 || timeOfDay >= 19
  const isDusk = timeOfDay >= 17 && timeOfDay < 19
  const isGoldenHour = timeOfDay >= 15 && timeOfDay < 17
  const isDawn = timeOfDay >= 5 && timeOfDay < 7

  if (!isNight && !isDusk && !isGoldenHour && !isDawn) return

  let warmStrength: number
  if (isNight) warmStrength = 0.08
  else if (isDusk) warmStrength = 0.04 + ((timeOfDay - 17) / 2) * 0.04
  else if (isGoldenHour) {
    const p = (timeOfDay - 15) / 2
    warmStrength = 0.02 + p * 0.02
  } else {
    const p = 1 - (timeOfDay - 5) / 2
    warmStrength = 0.02 + p * 0.03
  }

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255

    if (isGoldenHour || isDawn) {
      // Subtle warm shift across all tones
      data[i] = Math.min(255, r + warmStrength * 15)
      data[i + 1] = Math.min(255, g + warmStrength * 6)
      data[i + 2] = Math.max(0, b - warmStrength * 8)
    } else if (lum < 0.3) {
      // Night/dusk shadows: cool blue push
      data[i] = Math.max(0, r * 0.9 + 4)
      data[i + 1] = Math.max(0, g * 0.88)
      data[i + 2] = Math.min(255, b * 1.05 + 8)
    } else if (lum < 0.6) {
      data[i] = Math.min(255, r + warmStrength * 20)
      data[i + 1] = Math.min(255, g + warmStrength * 8)
      data[i + 2] = Math.max(0, b - warmStrength * 10)
    } else {
      data[i] = Math.min(255, r + warmStrength * 15)
      data[i + 1] = Math.min(255, g + warmStrength * 5)
      data[i + 2] = Math.max(0, b - warmStrength * 8)
    }
  }
}

// === Bloom/Glow ===

function applyBloom(imageData: ImageData, width: number, height: number): void {
  const { data } = imageData

  const bright = new Float32Array(width * height * 3)
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
    const idx = (i / 4) * 3
    if (lum > 0.65) {
      const factor = (lum - 0.65) / 0.35
      bright[idx] = data[i] * factor
      bright[idx + 1] = data[i + 1] * factor
      bright[idx + 2] = data[i + 2] * factor
    }
  }

  const blurred = boxBlur(bright, width, height)

  const bloomStrength = 0.12
  for (let i = 0; i < data.length; i += 4) {
    const idx = (i / 4) * 3
    data[i] = Math.min(255, data[i] + blurred[idx] * bloomStrength)
    data[i + 1] = Math.min(255, data[i + 1] + blurred[idx + 1] * bloomStrength)
    data[i + 2] = Math.min(255, data[i + 2] + blurred[idx + 2] * bloomStrength)
  }
}

function boxBlur(src: Float32Array, width: number, height: number): Float32Array {
  const tmp = new Float32Array(src.length)
  const dst = new Float32Array(src.length)
  const radius = 2

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, count = 0
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx
        if (nx >= 0 && nx < width) {
          const idx = (y * width + nx) * 3
          r += src[idx]; g += src[idx + 1]; b += src[idx + 2]; count++
        }
      }
      const idx = (y * width + x) * 3
      tmp[idx] = r / count; tmp[idx + 1] = g / count; tmp[idx + 2] = b / count
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, count = 0
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy
        if (ny >= 0 && ny < height) {
          const idx = (ny * width + x) * 3
          r += tmp[idx]; g += tmp[idx + 1]; b += tmp[idx + 2]; count++
        }
      }
      const idx = (y * width + x) * 3
      dst[idx] = r / count; dst[idx + 1] = g / count; dst[idx + 2] = b / count
    }
  }

  return dst
}
