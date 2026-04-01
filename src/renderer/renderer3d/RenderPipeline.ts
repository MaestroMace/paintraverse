// Stub for Phase 4: Pixel Art Rendering Pipeline
//
// This will orchestrate:
// 1. SceneBuilder - Convert 2D map data to Three.js 3D scene
// 2. CameraRig - Position camera from user-placed RenderCamera
// 3. LightingSetup - Apply environment lighting
// 4. WeatherEffects - Add weather particles/fog
// 5. Post-processing - Palette quantization, dithering, outlines
// 6. Export - Render to PNG at 320x240 (or configured resolution)

import type { MapDocument, RenderCamera } from '../core/types'

export interface RenderResult {
  imageData: ImageData
  width: number
  height: number
}

export async function renderPixelArt(
  _map: MapDocument,
  _camera: RenderCamera
): Promise<RenderResult> {
  // Phase 4 implementation
  throw new Error('Pixel art rendering not yet implemented. Coming in Phase 4!')
}
