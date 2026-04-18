/**
 * Archetype "columns" of the style matrix. Each is a plausible architectural
 * style hand-tuned as a fixed StyleVector. Every generated building is a
 * weighted sum of 2–3 of these plus jitter.
 */

import type { StyleVector } from './StyleVector'

export type ArchetypeId =
  | 'traverseCozy'
  | 'nobleStone'
  | 'halfTimberTudor'
  | 'medievalRustic'
  | 'mediterraneanStucco'
  | 'gothicStone'

export const ARCHETYPES: Record<ArchetypeId, StyleVector> = {
  // Narrow plastered walls, heavy cornice, deep overhang, many small windows.
  // The "cozy lamp-lit evening district" look.
  traverseCozy: {
    roofPitch: 0.65, overhang: 0.60, windowDensity: 0.75, windowRecess: 0.45,
    cornice: 0.55, timber: 0.30, stone: 0.25, ornament: 0.45,
    wealth: 0.45, weather: 0.30, warmth: 0.80, windowArch: 0.10,
    floors: 2, footW: 3, footD: 2, district: 'residential',
  },

  // Tall ashlar stone, deep window recesses, prominent cornice, cool palette.
  nobleStone: {
    roofPitch: 0.40, overhang: 0.15, windowDensity: 0.40, windowRecess: 0.70,
    cornice: 0.90, timber: 0.00, stone: 0.95, ornament: 0.80,
    wealth: 0.90, weather: 0.10, warmth: 0.25, windowArch: 0.45,
    floors: 3, footW: 4, footD: 4, district: 'noble',
  },

  // Heavy timber framing (currently painted), steep roof, jettied upper floor.
  halfTimberTudor: {
    roofPitch: 0.80, overhang: 0.80, windowDensity: 0.65, windowRecess: 0.30,
    cornice: 0.30, timber: 0.90, stone: 0.20, ornament: 0.30,
    wealth: 0.35, weather: 0.50, warmth: 0.60, windowArch: 0.00,
    floors: 2, footW: 3, footD: 3, district: 'artisan',
  },

  // Small, plain, worn — single-story cottages and shacks.
  medievalRustic: {
    roofPitch: 0.55, overhang: 0.20, windowDensity: 0.30, windowRecess: 0.20,
    cornice: 0.10, timber: 0.40, stone: 0.50, ornament: 0.10,
    wealth: 0.20, weather: 0.70, warmth: 0.50, windowArch: 0.00,
    floors: 1, footW: 2, footD: 2, district: 'residential',
  },

  // Low-pitch roof, arched windows, warm stucco, almost no timber.
  mediterraneanStucco: {
    roofPitch: 0.20, overhang: 0.10, windowDensity: 0.50, windowRecess: 0.40,
    cornice: 0.35, timber: 0.00, stone: 0.10, ornament: 0.35,
    wealth: 0.55, weather: 0.25, warmth: 0.90, windowArch: 0.65,
    floors: 2, footW: 3, footD: 3, district: 'garden',
  },

  // Steep pointed roofs, deeply-set pointed-arch windows, heavy stone.
  gothicStone: {
    roofPitch: 0.95, overhang: 0.15, windowDensity: 0.30, windowRecess: 0.80,
    cornice: 0.70, timber: 0.00, stone: 1.00, ornament: 0.90,
    wealth: 0.80, weather: 0.40, warmth: 0.20, windowArch: 0.95,
    floors: 3, footW: 4, footD: 4, district: 'temple',
  },
}

export const ALL_ARCHETYPES: ArchetypeId[] =
  Object.keys(ARCHETYPES) as ArchetypeId[]
