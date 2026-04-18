/**
 * Palette selection biased by the style vector.
 *
 * Default picker was palettes[hash % palettes.length] — uniformly random.
 * This picks the top-N palettes whose warmth/wealth signal is closest to
 * the building's style vector, then samples deterministically within that
 * subset using the hash. Result: slum buildings lean grimy + cool; noble
 * buildings lean lighter + cooler; market lean warm; etc.
 */

import type { BuildingPalette } from '../../inspiration/StyleMapper'
import type { StyleVector } from './StyleVector'

interface PaletteScore { idx: number; warmth: number; wealth: number }

function analysePalettes(palettes: BuildingPalette[]): PaletteScore[] {
  return palettes.map((p, idx) => {
    const r = (p.wall >> 16) & 0xff
    const g = (p.wall >> 8) & 0xff
    const b = p.wall & 0xff
    const total = Math.max(1, r + g + b)
    // Warmth: red-ish minus blue-ish, normalized 0..1 around 0.5 center.
    const warmth = Math.max(0, Math.min(1, 0.5 + (r - b) / (total * 1.5)))
    // Wealth proxy: brightness (lighter = richer / cleaner).
    const wealth = Math.max(0, Math.min(1, (r + g + b) / 765))
    return { idx, warmth, wealth }
  })
}

const _cache = new WeakMap<BuildingPalette[], PaletteScore[]>()
function getScores(palettes: BuildingPalette[]): PaletteScore[] {
  let s = _cache.get(palettes)
  if (!s) { s = analysePalettes(palettes); _cache.set(palettes, s) }
  return s
}

function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

/**
 * Pick a palette from `palettes` scored against the style vector. Uses a
 * soft top-3 sample so buildings in the same district still vary.
 */
export function pickPaletteForStyle(
  palettes: BuildingPalette[],
  sv: StyleVector,
  hash: number,
): BuildingPalette {
  if (palettes.length === 0) {
    throw new Error('pickPaletteForStyle: no palettes')
  }
  if (palettes.length === 1) return palettes[0]

  const scores = getScores(palettes)
  const targetWarmth = sv.warmth
  const targetWealth = sv.wealth

  const ranked = scores.map(s => {
    const dW = Math.abs(s.warmth - targetWarmth)
    const dWealth = Math.abs(s.wealth - targetWealth)
    // Lower score = better match; negate so "higher = better" downstream.
    return { idx: s.idx, score: -(dW + 0.7 * dWealth) }
  })
  ranked.sort((a, b) => b.score - a.score)
  const top = ranked.slice(0, Math.min(3, ranked.length))

  // Softmax-ish weighted sample among top by hash.
  const best = top[0].score
  const weights = top.map(r => Math.exp((r.score - best) * 4))
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  const r = rand01(hash, 211)
  let acc = 0
  for (let i = 0; i < top.length; i++) {
    acc += weights[i] / sum
    if (r <= acc) return palettes[top[i].idx]
  }
  return palettes[top[top.length - 1].idx]
}
