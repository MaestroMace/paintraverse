// Maps extracted palette analysis to PainTraverse systems:
// - Building color palettes
// - Render palette
// - Generation configuration hints

import type { Palette } from '../renderer3d/PaletteQuantizer'
import type { GenerationConfig } from '../core/types'
import type { ExtractedPalette } from './PaletteExtractor'

type RGB = [number, number, number]

export interface BuildingPalette {
  wall: number
  roof: number
  door: number
}

export interface StyleMapping {
  renderPalette: Palette
  buildingPalettes: BuildingPalette[]
  generationHints: Partial<GenerationConfig>
  moodLabel: string
}

export function mapStyle(analysis: ExtractedPalette): StyleMapping {
  return {
    renderPalette: buildRenderPalette(analysis),
    buildingPalettes: buildBuildingPalettes(analysis),
    generationHints: buildGenerationHints(analysis),
    moodLabel: deriveMoodLabel(analysis)
  }
}

// === Render Palette ===
// Select the best 32 colors for pixel art rendering

function buildRenderPalette(analysis: ExtractedPalette): Palette {
  const colors = [...analysis.palette.colors]

  // Ensure we have black and white
  const hasBlack = colors.some((c) => c[0] + c[1] + c[2] < 30)
  const hasWhite = colors.some((c) => c[0] + c[1] + c[2] > 720)
  if (!hasBlack) colors.unshift([10, 10, 15])
  if (!hasWhite) colors.push([245, 240, 235])

  // Pad to at least 16 colors by interpolating between existing ones
  while (colors.length < 16 && colors.length >= 2) {
    const i = Math.floor(Math.random() * (colors.length - 1))
    const a = colors[i], b = colors[i + 1]
    colors.splice(i + 1, 0, [
      Math.round((a[0] + b[0]) / 2),
      Math.round((a[1] + b[1]) / 2),
      Math.round((a[2] + b[2]) / 2)
    ])
  }

  // Cap at 32
  const final = colors.slice(0, 32)

  return {
    name: 'Inspiration',
    colors: final
  }
}

// === Building Palettes ===
// Map extracted colors to wall/roof/door assignments

function buildBuildingPalettes(analysis: ExtractedPalette): BuildingPalette[] {
  const { darks, midtones, lights } = analysis
  const palettes: BuildingPalette[] = []

  // Wall colors: from midtones and lights (these are the large visible surfaces)
  const wallPool = [...midtones, ...lights]
  if (wallPool.length === 0) wallPool.push([160, 150, 140])

  // Roof colors: from darks (roofs are typically darker)
  const roofPool = [...darks]
  if (roofPool.length === 0) roofPool.push([80, 60, 40])

  // Door colors: darkest warm-ish colors
  const doorPool = darks.filter((c) => c[0] > c[2]).length > 0
    ? darks.filter((c) => c[0] > c[2])
    : darks.length > 0 ? darks : [[60, 40, 30] as RGB]

  // Generate 6 palette variations
  for (let i = 0; i < 6; i++) {
    const wall = wallPool[i % wallPool.length]
    const roof = roofPool[i % roofPool.length]
    const door = doorPool[i % doorPool.length]

    palettes.push({
      wall: rgbToHex(wall),
      roof: rgbToHex(roof),
      door: rgbToHex(door)
    })
  }

  // If we have accents, work some in as alternate wall colors
  if (analysis.accents.length > 0) {
    for (let i = 0; i < Math.min(2, analysis.accents.length); i++) {
      const accent = analysis.accents[i]
      // Desaturate slightly for walls (pure accents are too vivid)
      const desaturated: RGB = [
        Math.round(accent[0] * 0.7 + 128 * 0.3),
        Math.round(accent[1] * 0.7 + 128 * 0.3),
        Math.round(accent[2] * 0.7 + 128 * 0.3)
      ]
      if (palettes.length > i + 3) {
        palettes[i + 3] = {
          ...palettes[i + 3],
          wall: rgbToHex(desaturated)
        }
      }
    }
  }

  return palettes
}

// === Generation Hints ===
// Influence generation parameters based on color analysis

function buildGenerationHints(analysis: ExtractedPalette): Partial<GenerationConfig> {
  const hints: Partial<GenerationConfig> = {}
  const freqs: Record<string, number> = {}

  // Warm palette → more warm lights, taverns, cozy furniture
  if (analysis.warmth > 0.55) {
    freqs['lamppost'] = 0.6 + (analysis.warmth - 0.55) * 1.5
    freqs['bench'] = 0.4
    freqs['cafe_table'] = 0.4
    freqs['fountain'] = 0.4
  }

  // Cool palette → more stone, towers, formal structures
  if (analysis.warmth < 0.45) {
    freqs['lamppost'] = 0.3
    freqs['stone_wall'] = 0.4
    freqs['fountain'] = 0.3
  }

  // High saturation → more vegetation, market stalls, colorful life
  if (analysis.saturation > 0.35) {
    freqs['potted_plant'] = 0.4
    freqs['planter_box'] = 0.3
    freqs['market_stall'] = 0.3
  }

  // Low saturation → muted, stone-heavy
  if (analysis.saturation < 0.2) {
    freqs['fence'] = 0.3
    freqs['stone_wall'] = 0.4
  }

  // Dark images → nighttime feel, more lights
  if (analysis.brightness < 0.35) {
    freqs['lamppost'] = Math.max(freqs['lamppost'] ?? 0, 0.7)
    freqs['wall_lantern'] = 0.5
  }

  // Bright images → daytime, open, more vegetation
  if (analysis.brightness > 0.55) {
    freqs['potted_plant'] = Math.max(freqs['potted_plant'] ?? 0, 0.4)
  }

  hints.assetFrequencies = freqs

  // Density hint based on how many colors we found
  if (analysis.palette.colors.length > 16) {
    hints.density = 0.6 // lots of color variety → dense scene
  } else if (analysis.palette.colors.length < 8) {
    hints.density = 0.3 // minimal palette → sparse
  }

  // Complexity from saturation + color count
  hints.complexity = Math.min(1, 0.3 + analysis.saturation * 0.4 +
    analysis.palette.colors.length / 40)

  return hints
}

// === Mood Label ===

function deriveMoodLabel(analysis: ExtractedPalette): string {
  const parts: string[] = []

  // Time feel
  if (analysis.brightness < 0.3) parts.push('Dark')
  else if (analysis.brightness < 0.45) parts.push('Dusky')
  else if (analysis.brightness > 0.65) parts.push('Bright')

  // Temperature
  if (analysis.warmth > 0.6) parts.push('Warm')
  else if (analysis.warmth < 0.4) parts.push('Cool')

  // Saturation
  if (analysis.saturation > 0.4) parts.push('Vivid')
  else if (analysis.saturation < 0.15) parts.push('Muted')

  // Scene type suggestion
  if (analysis.warmth > 0.55 && analysis.brightness < 0.45) {
    parts.push('Evening Town')
  } else if (analysis.warmth > 0.55 && analysis.brightness > 0.5) {
    parts.push('Sunlit Village')
  } else if (analysis.warmth < 0.45 && analysis.brightness < 0.4) {
    parts.push('Stone Fortress')
  } else if (analysis.warmth < 0.45 && analysis.brightness > 0.5) {
    parts.push('Coastal Town')
  } else {
    parts.push('Town')
  }

  return parts.join(' ')
}

function rgbToHex(c: RGB): number {
  return (c[0] << 16) | (c[1] << 8) | c[2]
}
