import * as THREE from 'three'
import type { MapDocument, RenderCamera, ObjectDefinition } from '../core/types'
import { buildScene, setBuildingPaletteOverride } from './SceneBuilder'
import type { BuildingPalette } from '../inspiration/StyleMapper'
import { quantizeImageData, applyOutlines, PALETTES } from './PaletteQuantizer'

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
  dithering: 'ordered',
  outlines: true,
  outlineThreshold: 80
}

export function renderPixelArt(
  map: MapDocument,
  camera: RenderCamera,
  objectDefs: ObjectDefinition[],
  options: Partial<RenderOptions> = {},
  buildingPalettes?: BuildingPalette[] | null
): RenderResult {
  setBuildingPaletteOverride(buildingPalettes || null)
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const { outputWidth, outputHeight } = camera

  console.log('[render] building scene...')
  const scene = buildScene(map, objectDefs)

  console.log('[render] creating WebGL1 context...')
  const offCanvas = document.createElement('canvas')
  offCanvas.width = outputWidth
  offCanvas.height = outputHeight
  const gl = offCanvas.getContext('webgl', {
    antialias: false,
    preserveDrawingBuffer: true,
    alpha: false,
    depth: true,
    stencil: false,
  }) as WebGLRenderingContext | null

  if (!gl) {
    throw new Error('Failed to create WebGL1 context for 3D render')
  }
  console.log('[render] WebGL1 context OK, vendor:', gl.getParameter(gl.VENDOR), 'renderer:', gl.getParameter(gl.RENDERER))

  console.log('[render] creating Three.js renderer...')
  const renderer = new THREE.WebGLRenderer({
    canvas: offCanvas,
    context: gl,
    antialias: false,
  })
  renderer.setSize(outputWidth, outputHeight, false)
  renderer.setPixelRatio(1)
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const cam = new THREE.PerspectiveCamera(camera.fov, outputWidth / outputHeight, 1, 10000)
  cam.position.set(
    camera.worldX * map.tileSize,
    camera.elevation * map.tileSize,
    camera.worldY * map.tileSize
  )
  cam.lookAt(
    camera.lookAtX * map.tileSize,
    0,
    camera.lookAtY * map.tileSize
  )

  console.log('[render] calling renderer.render()...')
  renderer.render(scene, cam)
  console.log('[render] render complete, reading pixels...')

  const pixels = new Uint8Array(outputWidth * outputHeight * 4)
  gl.readPixels(0, 0, outputWidth, outputHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  console.log('[render] readPixels complete, disposing...')

  renderer.dispose()
  renderer.forceContextLoss()
  const disposedGeos = new Set<THREE.BufferGeometry>()
  const disposedMats = new Set<THREE.Material>()
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      if (!disposedGeos.has(obj.geometry)) {
        disposedGeos.add(obj.geometry)
        obj.geometry.dispose()
      }
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const m of mats) {
        if (!disposedMats.has(m)) {
          disposedMats.add(m)
          m.dispose()
        }
      }
    }
  })

  // Post-processing (CPU only — no WebGL needed)
  const flipped = new Uint8ClampedArray(outputWidth * outputHeight * 4)
  for (let y = 0; y < outputHeight; y++) {
    const srcRow = (outputHeight - 1 - y) * outputWidth * 4
    const dstRow = y * outputWidth * 4
    flipped.set(pixels.subarray(srcRow, srcRow + outputWidth * 4), dstRow)
  }

  let imageData = new ImageData(flipped, outputWidth, outputHeight)

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
// Shifts colors to create warm/cool contrast before palette quantization

function applyColorGrading(imageData: ImageData, timeOfDay: number): void {
  const { data } = imageData
  const isNight = timeOfDay < 5 || timeOfDay >= 19
  const isDusk = timeOfDay >= 17 && timeOfDay < 19

  if (!isNight && !isDusk) return // only grade night/dusk scenes

  const warmStrength = isNight ? 0.08 : 0.04

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255

    if (lum < 0.3) {
      // Dark pixels → push toward purple-blue (not gray)
      data[i] = Math.max(0, r * 0.9 + 4)              // slight red tint
      data[i + 1] = Math.max(0, g * 0.88)              // reduce green slightly
      data[i + 2] = Math.min(255, b * 1.05 + 8)        // mild blue boost
    } else if (lum < 0.6) {
      // Midtones → mild warm shift
      data[i] = Math.min(255, r + warmStrength * 20)    // boost red
      data[i + 1] = Math.min(255, g + warmStrength * 8) // slight green
      data[i + 2] = Math.max(0, b - warmStrength * 10)  // reduce blue
    } else {
      // Highlights → mild warm amber push
      data[i] = Math.min(255, r + warmStrength * 15)
      data[i + 1] = Math.min(255, g + warmStrength * 5)
      data[i + 2] = Math.max(0, b - warmStrength * 8)
    }
  }
}

// === Bloom/Glow ===
// Simple bloom: threshold bright pixels, blur, composite back

function applyBloom(imageData: ImageData, width: number, height: number): void {
  const { data } = imageData

  // Extract bright pixels
  const bright = new Float32Array(width * height * 3)
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) / 255
    const idx = (i / 4) * 3
    if (lum > 0.65) {
      const factor = (lum - 0.65) / 0.35 // 0 to 1
      bright[idx] = data[i] * factor
      bright[idx + 1] = data[i + 1] * factor
      bright[idx + 2] = data[i + 2] * factor
    }
  }

  // Single box blur pass (less homogenization)
  const blurred = boxBlur(bright, width, height)

  // Composite bloom back at 12% opacity (subtle glow, not color wash)
  const bloomStrength = 0.12
  const blurred2 = blurred
  for (let i = 0; i < data.length; i += 4) {
    const idx = (i / 4) * 3
    data[i] = Math.min(255, data[i] + blurred2[idx] * bloomStrength)
    data[i + 1] = Math.min(255, data[i + 1] + blurred2[idx + 1] * bloomStrength)
    data[i + 2] = Math.min(255, data[i + 2] + blurred2[idx + 2] * bloomStrength)
  }
}

function boxBlur(src: Float32Array, width: number, height: number): Float32Array {
  const tmp = new Float32Array(src.length)
  const dst = new Float32Array(src.length)
  const radius = 2

  // Separable blur: horizontal pass
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

  // Separable blur: vertical pass
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
