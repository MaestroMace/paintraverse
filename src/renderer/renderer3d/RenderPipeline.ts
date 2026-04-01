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
