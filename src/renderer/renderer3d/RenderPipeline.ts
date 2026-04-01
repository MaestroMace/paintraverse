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
  // Apply building palette overrides before building the scene
  setBuildingPaletteOverride(buildingPalettes || null)
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const { outputWidth, outputHeight } = camera

  // Build the 3D scene from map data
  const scene = buildScene(map, objectDefs)

  // Create Three.js renderer at pixel art resolution
  const renderer = new THREE.WebGLRenderer({
    antialias: false,
    preserveDrawingBuffer: true,
    alpha: false
  })
  renderer.setSize(outputWidth, outputHeight)
  renderer.setPixelRatio(1) // Force 1:1 pixel mapping
  renderer.outputColorSpace = THREE.SRGBColorSpace

  // Create camera from RenderCamera spec
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

  // Render
  renderer.render(scene, cam)

  // Read pixels
  const gl = renderer.getContext()
  const pixels = new Uint8Array(outputWidth * outputHeight * 4)
  gl.readPixels(0, 0, outputWidth, outputHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels)

  // Flip Y (WebGL reads bottom-up)
  const flipped = new Uint8ClampedArray(outputWidth * outputHeight * 4)
  for (let y = 0; y < outputHeight; y++) {
    const srcRow = (outputHeight - 1 - y) * outputWidth * 4
    const dstRow = y * outputWidth * 4
    flipped.set(pixels.slice(srcRow, srcRow + outputWidth * 4), dstRow)
  }

  let imageData = new ImageData(flipped, outputWidth, outputHeight)

  // === PRE-QUANTIZATION PROCESSING ===

  // A3: Color grading - warm shift for night scenes, purple-blue shadows
  applyColorGrading(imageData, map.environment.timeOfDay)

  // A4: Bloom/glow approximation - soft halos around bright light sources
  applyBloom(imageData, outputWidth, outputHeight)

  // Apply palette quantization
  const palette = PALETTES[opts.paletteId] || PALETTES['db32']
  imageData = quantizeImageData(imageData, palette, opts.dithering)

  // Apply outlines
  if (opts.outlines) {
    imageData = applyOutlines(imageData)
  }

  // Write to output canvas
  const outputCanvas = document.createElement('canvas')
  outputCanvas.width = outputWidth
  outputCanvas.height = outputHeight
  const ctx = outputCanvas.getContext('2d')!
  ctx.putImageData(imageData, 0, 0)

  // Clean up Three.js resources
  renderer.dispose()
  scene.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose()
      if (Array.isArray(obj.material)) {
        obj.material.forEach((m) => m.dispose())
      } else {
        obj.material.dispose()
      }
    }
  })

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

  const warmStrength = isNight ? 0.15 : 0.08

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255

    if (lum < 0.3) {
      // Dark pixels → push toward purple-blue (not gray)
      data[i] = Math.max(0, r * 0.85 + 8)           // slight red tint
      data[i + 1] = Math.max(0, g * 0.8)              // reduce green
      data[i + 2] = Math.min(255, b * 1.1 + 15)       // boost blue
    } else if (lum < 0.6) {
      // Midtones → warm shift
      data[i] = Math.min(255, r + warmStrength * 40)   // boost red
      data[i + 1] = Math.min(255, g + warmStrength * 15) // slight green
      data[i + 2] = Math.max(0, b - warmStrength * 20)  // reduce blue
    } else {
      // Highlights → push toward warm amber (light sources)
      data[i] = Math.min(255, r + warmStrength * 30)
      data[i + 1] = Math.min(255, g + warmStrength * 10)
      data[i + 2] = Math.max(0, b - warmStrength * 15)
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

  // 5x5 box blur (two passes for a wider spread)
  const blurred = boxBlur(bright, width, height)
  const blurred2 = boxBlur(blurred, width, height)

  // Composite bloom back onto original at 25% opacity
  const bloomStrength = 0.25
  for (let i = 0; i < data.length; i += 4) {
    const idx = (i / 4) * 3
    data[i] = Math.min(255, data[i] + blurred2[idx] * bloomStrength)
    data[i + 1] = Math.min(255, data[i + 1] + blurred2[idx + 1] * bloomStrength)
    data[i + 2] = Math.min(255, data[i + 2] + blurred2[idx + 2] * bloomStrength)
  }
}

function boxBlur(src: Float32Array, width: number, height: number): Float32Array {
  const dst = new Float32Array(src.length)
  const radius = 2

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, count = 0

      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = (ny * width + nx) * 3
            r += src[idx]
            g += src[idx + 1]
            b += src[idx + 2]
            count++
          }
        }
      }

      const idx = (y * width + x) * 3
      dst[idx] = r / count
      dst[idx + 1] = g / count
      dst[idx + 2] = b / count
    }
  }

  return dst
}
