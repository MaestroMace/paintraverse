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
  imageDataURL: string // lazy — only computed when accessed
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
  const sceneResult = renderCanvas2D(map, camera, objectDefs, buildingPalettes, time, isPreview)
  let imageData = sceneResult.imageData

  // Skip expensive per-pixel post-processing in preview mode for playable framerates
  if (!isPreview) {
    // Water reflections (per-pixel with trig — expensive)
    applyWaterReflection(imageData, sceneResult.waterMask, outputWidth, outputHeight, time)
  }

  // === MERGED POST-PROCESSING (single pixel loop) ===
  // Night darken + light map composite + color grading in one pass.
  // Bloom extraction piggybacks on the same loop for final renders.
  const tod = map.environment.timeOfDay
  const isNight = tod < 5 || tod >= 19
  const isDusk = tod >= 17 && tod < 19

  let lightMapData: ImageData | null = null
  if (!isPreview && (isNight || isDusk) && sceneResult.lights.length > 0) {
    lightMapData = renderLightMap(sceneResult.lights, outputWidth, outputHeight)
  }

  const darkFactor = isNight ? 0.55 : isDusk ? 0.75 : 1.0
  const needsGrade = isNight || isDusk || (tod >= 15 && tod < 17) || (tod >= 5 && tod < 7)
  const needsBloom = !isPreview
  const needsAnyPostProcess = darkFactor < 1.0 || needsGrade || needsBloom || lightMapData !== null

  if (needsAnyPostProcess) {
    const totalPixels = outputWidth * outputHeight
    if (needsBloom) ensureBloomBuffers(totalPixels)

    applyMergedPostProcess(
      imageData, lightMapData, darkFactor, tod,
      isNight || isDusk, needsGrade, needsBloom, outputWidth
    )

    if (needsBloom) {
      applyBloomFromBuffer(imageData, outputWidth, outputHeight)
    }
  }

  // Skip quantization + outlines in preview mode (saves ~10ms per frame)
  if (!isPreview) {
    const palette = PALETTES[opts.paletteId] || PALETTES['db32']
    imageData = quantizeImageData(imageData, palette, opts.dithering)
    if (opts.outlines) {
      imageData = applyOutlines(imageData)
    }
  }

  if (!_outputCanvas || _outputCanvas.width !== outputWidth || _outputCanvas.height !== outputHeight) {
    _outputCanvas = document.createElement('canvas')
    _outputCanvas.width = outputWidth
    _outputCanvas.height = outputHeight
    _outputCtx = _outputCanvas.getContext('2d')!
  }
  _outputCtx!.putImageData(imageData, 0, 0)

  // CRITICAL: toDataURL('image/png') is 50-200ms per call (PNG encode + Base64).
  // For preview/animation, return empty string — caller uses canvas directly.
  // Only compute dataURL for final renders (Export PNG, Debug Pkg).
  return {
    canvas: _outputCanvas,
    width: outputWidth,
    height: outputHeight,
    imageDataURL: isPreview ? '' : _outputCanvas.toDataURL('image/png')
  }
}

// === Merged Post-Processing (single pixel loop) ===
// Combines night darkening + light map composite + color grading + bloom extraction
// into ONE pass over the pixel data. Saves 3-4 full array traversals per frame.

// Pooled bloom buffers — avoids 11MB allocation per frame
let _bloomBright: Float32Array | null = null
let _bloomTmp: Float32Array | null = null
let _bloomDst: Float32Array | null = null
let _bloomBufSize = 0

function ensureBloomBuffers(pixels: number): void {
  const size = pixels * 3
  if (_bloomBufSize === size && _bloomBright) return
  _bloomBright = new Float32Array(size)
  _bloomTmp = new Float32Array(size)
  _bloomDst = new Float32Array(size)
  _bloomBufSize = size
}

function applyMergedPostProcess(
  imageData: ImageData, lightMap: ImageData | null,
  darkFactor: number, timeOfDay: number,
  nightApplied: boolean, needsGrade: boolean, needsBloom: boolean,
  _width: number
): void {
  const d = imageData.data
  const ld = lightMap?.data ?? null
  const bright = needsBloom ? _bloomBright! : null

  // Pre-compute grading constants outside the loop
  const isGoldenHour = timeOfDay >= 15 && timeOfDay < 17
  const isDawn = timeOfDay >= 5 && timeOfDay < 7
  const isNight = timeOfDay < 5 || timeOfDay >= 19
  const isDusk = timeOfDay >= 17 && timeOfDay < 19

  let warmStrength = 0
  if (needsGrade) {
    if (isNight) warmStrength = 0.08
    else if (isDusk) warmStrength = 0.04 + ((timeOfDay - 17) / 2) * 0.04
    else if (isGoldenHour) warmStrength = 0.02 + ((timeOfDay - 15) / 2) * 0.02
    else if (isDawn) warmStrength = 0.02 + (1 - (timeOfDay - 5) / 2) * 0.03
  }
  const shadowScale = nightApplied ? 0.4 : 1.0
  const applyDark = darkFactor < 1.0

  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2]

    // Night darken (multiply)
    if (applyDark) { r *= darkFactor; g *= darkFactor; b *= darkFactor }

    // Additive light map composite
    if (ld) {
      r += ld[i]; if (r > 255) r = 255
      g += ld[i + 1]; if (g > 255) g = 255
      b += ld[i + 2]; if (b > 255) b = 255
    }

    // Color grading (inlined)
    if (needsGrade) {
      if (isGoldenHour || isDawn) {
        r += warmStrength * 15; if (r > 255) r = 255
        g += warmStrength * 6; if (g > 255) g = 255
        b -= warmStrength * 8; if (b < 0) b = 0
      } else {
        const lum = (r * 0.299 + g * 0.587 + b * 0.114) * 0.00392156863 // / 255
        if (lum < 0.3) {
          r = r * (0.95 + warmStrength * 0.3 * shadowScale) + warmStrength * 3 * shadowScale
          g = g * (0.93 + warmStrength * 0.2 * shadowScale) + warmStrength * 1 * shadowScale
          b = b * (1.0 + 0.01 * shadowScale) + warmStrength * 4 * shadowScale
        } else if (lum < 0.6) {
          r += warmStrength * 20; g += warmStrength * 8; b -= warmStrength * 10
        } else {
          r += warmStrength * 15; g += warmStrength * 5; b -= warmStrength * 8
        }
        if (r > 255) r = 255; else if (r < 0) r = 0
        if (g > 255) g = 255; else if (g < 0) g = 0
        if (b > 255) b = 255; else if (b < 0) b = 0
      }
    }

    d[i] = r; d[i + 1] = g; d[i + 2] = b

    // Bloom extraction (piggybacks on same loop — no extra pass)
    if (bright) {
      const lum = (r * 0.299 + g * 0.587 + b * 0.114) * 0.00392156863
      const bi = (i >> 2) * 3
      if (lum > 0.65) {
        const f = (lum - 0.65) * 2.857 // / 0.35
        bright[bi] = r * f; bright[bi + 1] = g * f; bright[bi + 2] = b * f
      } else {
        bright[bi] = 0; bright[bi + 1] = 0; bright[bi + 2] = 0
      }
    }
  }
}

// === Bloom (half-res blur + upsample) ===

function applyBloomFromBuffer(imageData: ImageData, width: number, height: number): void {
  if (!_bloomBright) return
  // Downsample bright buffer to half-res for faster blur
  const halfW = width >> 1, halfH = height >> 1
  const halfSize = halfW * halfH * 3
  // Reuse _bloomTmp for half-res
  const half = _bloomTmp!
  for (let y = 0; y < halfH; y++) {
    for (let x = 0; x < halfW; x++) {
      const si = ((y * 2) * width + (x * 2)) * 3
      const di = (y * halfW + x) * 3
      // Average 2x2 block
      const si2 = si + 3, si3 = si + width * 3, si4 = si3 + 3
      half[di] = (_bloomBright[si] + _bloomBright[si2] + _bloomBright[si3] + _bloomBright[si4]) * 0.25
      half[di + 1] = (_bloomBright[si + 1] + _bloomBright[si2 + 1] + _bloomBright[si3 + 1] + _bloomBright[si4 + 1]) * 0.25
      half[di + 2] = (_bloomBright[si + 2] + _bloomBright[si2 + 2] + _bloomBright[si3 + 2] + _bloomBright[si4 + 2]) * 0.25
    }
  }

  // Box blur at half res (4x fewer pixels)
  const blurred = boxBlurHalf(half, halfW, halfH)

  // Upsample + add back to full-res
  const { data } = imageData
  const bloomStrength = 0.12
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bi = ((y >> 1) * halfW + (x >> 1)) * 3
      const di = (y * width + x) * 4
      data[di] = Math.min(255, data[di] + blurred[bi] * bloomStrength)
      data[di + 1] = Math.min(255, data[di + 1] + blurred[bi + 1] * bloomStrength)
      data[di + 2] = Math.min(255, data[di + 2] + blurred[bi + 2] * bloomStrength)
    }
  }
}

function boxBlurHalf(src: Float32Array, width: number, height: number): Float32Array {
  const dst = _bloomDst!
  const radius = 2

  // Horizontal pass (src → dst)
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
      dst[idx] = r / count; dst[idx + 1] = g / count; dst[idx + 2] = b / count
    }
  }

  // Vertical pass (dst → src, reuse src as output)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, count = 0
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy
        if (ny >= 0 && ny < height) {
          const idx = (ny * width + x) * 3
          r += dst[idx]; g += dst[idx + 1]; b += dst[idx + 2]; count++
        }
      }
      const idx = (y * width + x) * 3
      src[idx] = r / count; src[idx + 1] = g / count; src[idx + 2] = b / count
    }
  }

  return src
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
