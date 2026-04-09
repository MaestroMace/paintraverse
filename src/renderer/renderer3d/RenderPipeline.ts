import type { MapDocument, RenderCamera, ObjectDefinition } from '../core/types'
import type { BuildingPalette } from '../inspiration/StyleMapper'
import { quantizeImageData, applyOutlines, PALETTES } from './PaletteQuantizer'
import { renderCanvas2D } from './Canvas2DRenderer'
import type { LightSource } from './Canvas2DRenderer'

export interface RenderOptions {
  paletteId: string
  dithering: 'none' | 'ordered' | 'floyd-steinberg'
  outlines: boolean
  outlineThreshold: number
  quality: 'preview' | 'final'
}

export interface RenderResult {
  canvas: HTMLCanvasElement
  width: number
  height: number
  imageDataURL: string
}

// Cached output canvas
let _outputCanvas: HTMLCanvasElement | null = null
let _outputCtx: CanvasRenderingContext2D | null = null

const DEFAULT_OPTIONS: RenderOptions = {
  paletteId: 'db32',
  dithering: 'none',
  outlines: false,
  outlineThreshold: 80,
  quality: 'final'
}

export function renderPixelArt(
  map: MapDocument,
  camera: RenderCamera,
  objectDefs: ObjectDefinition[],
  options: Partial<RenderOptions> = {},
  buildingPalettes?: BuildingPalette[] | null,
  time: number = 0
): RenderResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const { outputWidth, outputHeight } = camera
  const isPreview = opts.quality === 'preview'

  // Render scene using pure Canvas2D (no WebGL — avoids SwiftShader crashes)
  const sceneResult = renderCanvas2D(map, camera, objectDefs, buildingPalettes, time)
  let imageData = sceneResult.imageData

  // Skip expensive per-pixel post-processing in preview mode for playable framerates
  if (!isPreview) {
    // Water reflections (per-pixel with trig — expensive)
    applyWaterReflection(imageData, sceneResult.waterMask, outputWidth, outputHeight, time)
  }

  // Dynamic light map (night/dusk only)
  const tod = map.environment.timeOfDay
  const isNight = tod < 5 || tod >= 19
  const isDusk = tod >= 17 && tod < 19
  let nightDarkeningApplied = false
  if (isNight || isDusk) {
    const darkFactor = isNight ? 0.55 : 0.75
    applyNightDarkening(imageData, darkFactor)
    nightDarkeningApplied = true
    // Light map compositing only in final render (radial gradients are slow)
    if (!isPreview && sceneResult.lights.length > 0) {
      const lightMap = renderLightMap(sceneResult.lights, outputWidth, outputHeight)
      compositeAdditive(imageData, lightMap)
    }
  }

  // Color grading — fast enough for preview
  applyColorGrading(imageData, tod, nightDarkeningApplied)

  // Skip bloom in preview mode for speed
  if (!isPreview) {
    applyBloom(imageData, outputWidth, outputHeight)
  }

  const palette = PALETTES[opts.paletteId] || PALETTES['db32']
  imageData = quantizeImageData(imageData, palette, isPreview ? 'none' : opts.dithering)

  if (opts.outlines && !isPreview) {
    imageData = applyOutlines(imageData)
  }

  if (!_outputCanvas || _outputCanvas.width !== outputWidth || _outputCanvas.height !== outputHeight) {
    _outputCanvas = document.createElement('canvas')
    _outputCanvas.width = outputWidth
    _outputCanvas.height = outputHeight
    _outputCtx = _outputCanvas.getContext('2d')!
  }
  _outputCtx!.putImageData(imageData, 0, 0)

  return {
    canvas: _outputCanvas,
    width: outputWidth,
    height: outputHeight,
    imageDataURL: _outputCanvas.toDataURL('image/png')
  }
}

// === Color Grading ===

function applyColorGrading(imageData: ImageData, timeOfDay: number, nightDarkeningApplied: boolean = false): void {
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
      // Night/dusk shadows: gentle cool tint (not aggressive blue push)
      // When night darkening already applied, most pixels hit this branch —
      // so keep the effect very subtle to avoid blue striping
      const shadowScale = nightDarkeningApplied ? 0.4 : 1.0
      data[i] = Math.max(0, r * (0.95 + warmStrength * 0.3 * shadowScale) + warmStrength * 3 * shadowScale)
      data[i + 1] = Math.max(0, g * (0.93 + warmStrength * 0.2 * shadowScale) + warmStrength * 1 * shadowScale)
      data[i + 2] = Math.min(255, b * (1.0 + 0.01 * shadowScale) + warmStrength * 4 * shadowScale)
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

// === Night Darkening ===

function applyNightDarkening(imageData: ImageData, factor: number): void {
  const { data } = imageData
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(data[i] * factor)
    data[i + 1] = Math.floor(data[i + 1] * factor)
    data[i + 2] = Math.floor(data[i + 2] * factor)
  }
}

// === Light Map Rendering ===

// Cached light map canvas to avoid allocating a new one every frame
let _lightMapCanvas: HTMLCanvasElement | null = null
let _lightMapCtx: CanvasRenderingContext2D | null = null

function renderLightMap(lights: LightSource[], width: number, height: number): ImageData {
  if (!_lightMapCanvas || _lightMapCanvas.width !== width || _lightMapCanvas.height !== height) {
    _lightMapCanvas = document.createElement('canvas')
    _lightMapCanvas.width = width
    _lightMapCanvas.height = height
    _lightMapCtx = _lightMapCanvas.getContext('2d')!
  }
  const lc = _lightMapCanvas
  const lctx = _lightMapCtx!
  lctx.clearRect(0, 0, width, height)

  // Additive blending: each light adds warm glow
  lctx.globalCompositeOperation = 'lighter'

  for (const light of lights) {
    const r = (light.color >> 16) & 0xff
    const g = (light.color >> 8) & 0xff
    const b = light.color & 0xff
    const grad = lctx.createRadialGradient(
      light.sx, light.sy, 0,
      light.sx, light.sy, light.radius
    )
    grad.addColorStop(0, `rgba(${r},${g},${b},${light.intensity})`)
    grad.addColorStop(0.3, `rgba(${r},${g},${b},${light.intensity * 0.5})`)
    grad.addColorStop(0.7, `rgba(${r},${g},${b},${light.intensity * 0.15})`)
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
    lctx.fillStyle = grad
    lctx.beginPath()
    lctx.arc(light.sx, light.sy, light.radius, 0, Math.PI * 2)
    lctx.fill()
  }

  return lctx.getImageData(0, 0, width, height)
}

// === Additive Compositing ===

function compositeAdditive(base: ImageData, overlay: ImageData): void {
  const bd = base.data, od = overlay.data
  for (let i = 0; i < bd.length; i += 4) {
    bd[i] = Math.min(255, bd[i] + od[i])
    bd[i + 1] = Math.min(255, bd[i + 1] + od[i + 1])
    bd[i + 2] = Math.min(255, bd[i + 2] + od[i + 2])
  }
}

// === Water Reflections ===

function applyWaterReflection(
  imageData: ImageData, waterMask: Uint8Array,
  width: number, height: number, time: number
): void {
  // Quick check: any water at all?
  let hasWater = false
  for (let i = 0; i < waterMask.length; i++) {
    if (waterMask[i]) { hasWater = true; break }
  }
  if (!hasWater) return

  const data = imageData.data
  const copy = new Uint8ClampedArray(data) // snapshot for sampling

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!waterMask[y * width + x]) continue

      // Wave distortion
      const waveX = Math.sin(x * 0.4 + time * 2.5) * 1.2 + Math.cos(y * 0.3 + time * 1.7) * 0.6
      const waveY = Math.cos(x * 0.25 + time * 1.8) * 1.0

      // Reflection: sample from above with flip + distortion
      const reflectDist = 3 + Math.abs(Math.sin(x * 0.15 + time * 0.8)) * 4
      const srcY = Math.max(0, Math.min(height - 1, y - Math.floor(reflectDist * 2 + waveY)))
      const srcX = Math.max(0, Math.min(width - 1, x + Math.floor(waveX)))

      const si = (srcY * width + srcX) * 4
      const di = (y * width + x) * 4

      // Blend reflection with water tint
      const reflectStr = 0.55
      const waterR = 65, waterG = 110, waterB = 145
      data[di] = Math.floor(copy[si] * reflectStr + waterR * (1 - reflectStr))
      data[di + 1] = Math.floor(copy[si + 1] * reflectStr + waterG * (1 - reflectStr))
      data[di + 2] = Math.floor(copy[si + 2] * reflectStr + waterB * (1 - reflectStr))

      // Specular highlights (sun/moon glints)
      const spec = Math.pow(Math.max(0, Math.sin(x * 0.6 + time * 3.5) * Math.cos(y * 0.4 + time * 2.2)), 12)
      if (spec > 0.3) {
        const glint = Math.floor(spec * 80)
        data[di] = Math.min(255, data[di] + glint)
        data[di + 1] = Math.min(255, data[di + 1] + glint)
        data[di + 2] = Math.min(255, data[di + 2] + Math.floor(glint * 0.7))
      }
    }
  }
}
