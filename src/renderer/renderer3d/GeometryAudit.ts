/**
 * Geometry Audit — machine-checkable placement invariants.
 *
 * The town is procedural, so "does it look right?" has always meant walking
 * around and eyeballing it. That misses systematic errors (a whole class of
 * object silently dropped, every wall run off by a tile) and can't tell you
 * whether a change made placement better or worse.
 *
 * This module states the invariants a correct town must satisfy and reports
 * every violation with the object id and tile, so placement bugs become a
 * number that must go down instead of a vibe. It is PURE (MapDocument +
 * ObjectDefinitions in, report out) so it runs without a 3D context — from
 * the app, from devtools via the debug bridge, or from headless tooling.
 *
 * Terrain tile semantics come from core/terrain.ts. Only 8 and 9 are
 * circulation — a building standing on plaza flagstone (14) fronts a square,
 * it does not block a street, so 14 is deliberately not an error.
 */

import type { MapDocument, ObjectDefinition, PlacedObject } from '../core/types'
// VALUE import, deliberately separate from the type-only line above: folding it
// in there would have it elided at build time and fail at runtime as
// "sharedFootprintOf is not defined", which is exactly what happened once.
import { footprintOf as sharedFootprintOf } from '../core/types'
import { TILE_WATER, isCirculation } from '../core/terrain'

export type IssueKind =
  | 'missing-definition'
  | 'out-of-bounds'
  | 'building-overlap'
  | 'building-on-road'
  | 'building-in-water'
  | 'prop-inside-building'
  | 'prop-in-water'
  | 'prop-stacked'

export interface GeometryIssue {
  kind: IssueKind
  severity: 'error' | 'warn'
  objectId: string
  definitionId: string
  x: number
  y: number
  detail: string
}

export interface AuditReport {
  ok: boolean
  counts: { structures: number; props: number; errors: number; warnings: number }
  byKind: Record<string, number>
  /** Bounded sample so a broken town can't produce a megabyte of output. */
  issues: GeometryIssue[]
  /** Distinct definitionIds present in the map but absent from the defs. */
  missingDefinitions: string[]
}


/** Structures that are SUPPOSED to sit on/over a road or water. */
const SPANS_ROAD = new Set([
  'town_gate', 'gatehouse', 'archway', 'bridge', 'aqueduct', 'covered_market',
])
const WATER_TOLERANT = new Set([
  'bridge', 'pier', 'dock', 'fishing_boat', 'water_channel', 'mill',
  'lighthouse', 'crane', 'well', 'fountain',
])

const MAX_ISSUES = 60

function footprintOf(
  obj: PlacedObject,
  defs: Map<string, ObjectDefinition>
): { w: number; h: number } | null {
  const def = defs.get(obj.definitionId)
  if (!def) return null
  // What the placer RESERVED, falling back to the definition. See
  // core/types.footprintOf for why this must never be a bare def lookup.
  return sharedFootprintOf(obj, def)
}

export function auditMapGeometry(
  map: MapDocument,
  objectDefinitions: ObjectDefinition[]
): AuditReport {
  const defs = new Map(objectDefinitions.map((d) => [d.id, d]))
  const gw = map.gridWidth
  const gh = map.gridHeight
  const tiles = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
  const structures = map.layers.find((l) => l.type === 'structure')?.objects ?? []
  const props = map.layers.find((l) => l.type === 'prop')?.objects ?? []

  const issues: GeometryIssue[] = []
  const byKind: Record<string, number> = {}
  const missingDefs = new Set<string>()
  let errors = 0
  let warnings = 0

  const add = (
    kind: IssueKind,
    severity: 'error' | 'warn',
    obj: PlacedObject,
    detail: string
  ) => {
    byKind[kind] = (byKind[kind] ?? 0) + 1
    if (severity === 'error') errors++
    else warnings++
    if (issues.length < MAX_ISSUES) {
      issues.push({
        kind, severity, objectId: obj.id, definitionId: obj.definitionId,
        x: obj.x, y: obj.y, detail,
      })
    }
  }

  const tileAt = (x: number, y: number): number =>
    tiles?.[y]?.[x] ?? -1

  // Occupancy grid of building footprints — also used for prop containment.
  const occupied: (PlacedObject | undefined)[] = new Array(gw * gh)

  for (const obj of structures) {
    const fp = footprintOf(obj, defs)
    if (!fp) {
      missingDefs.add(obj.definitionId)
      // BuildingFactory does `if (!def) continue` — this object never renders.
      add('missing-definition', 'error', obj,
        `no ObjectDefinition for "${obj.definitionId}" — silently dropped from the 3D scene`)
      continue
    }

    if (obj.x < 0 || obj.y < 0 || obj.x + fp.w > gw || obj.y + fp.h > gh) {
      add('out-of-bounds', 'error', obj,
        `${fp.w}x${fp.h} footprint at (${obj.x},${obj.y}) extends past the ${gw}x${gh} grid`)
      continue
    }

    let roadTiles = 0
    let waterTiles = 0
    for (let fy = 0; fy < fp.h; fy++) {
      for (let fx = 0; fx < fp.w; fx++) {
        const tx = obj.x + fx
        const ty = obj.y + fy
        const t = tileAt(tx, ty)
        if (isCirculation(t)) roadTiles++
        if (t === TILE_WATER) waterTiles++
        const idx = ty * gw + tx
        const other = occupied[idx]
        if (other && other !== obj) {
          add('building-overlap', 'error', obj,
            `overlaps "${other.definitionId}" (${other.id.slice(0, 8)}) at tile (${tx},${ty})`)
        }
        occupied[idx] = obj
      }
    }

    // A `passage` object is a way THROUGH by definition — a gate, an archway,
    // a bridge deck — so it is allowed to sit on the thing it crosses. The
    // two sets below are lists of literals maintaining that idea by hand, and
    // a new crossing type is exactly what they forget: `footbridge` was
    // reported four times as a building standing in a river, which is what a
    // bridge is. Read the tag the definition already carries.
    const isPassage = !!defs.get(obj.definitionId)?.tags?.includes('passage')
    if (roadTiles > 0 && !SPANS_ROAD.has(obj.definitionId) && !isPassage) {
      add('building-on-road', 'error', obj,
        `${roadTiles}/${fp.w * fp.h} footprint tiles are road/alley — building sits in the street`)
    }
    if (waterTiles > 0 && !WATER_TOLERANT.has(obj.definitionId) && !isPassage) {
      add('building-in-water', 'error', obj,
        `${waterTiles}/${fp.w * fp.h} footprint tiles are water`)
    }
  }

  // Props: PropFactory falls back to a 1x1 footprint when a def is missing,
  // so a missing def mis-sizes AND mis-centers the prop rather than dropping it.
  const propAtTile = new Map<number, PlacedObject>()
  for (const obj of props) {
    const fp = footprintOf(obj, defs)
    if (!fp) {
      missingDefs.add(obj.definitionId)
      add('missing-definition', 'error', obj,
        `no ObjectDefinition for "${obj.definitionId}" — PropFactory falls back to 1x1, so size and center are wrong`)
      continue
    }

    if (obj.x < 0 || obj.y < 0 || obj.x + fp.w > gw || obj.y + fp.h > gh) {
      add('out-of-bounds', 'error', obj,
        `${fp.w}x${fp.h} footprint at (${obj.x},${obj.y}) extends past the ${gw}x${gh} grid`)
      continue
    }

    const t = tileAt(obj.x, obj.y)
    if (t === TILE_WATER && !WATER_TOLERANT.has(obj.definitionId)) {
      add('prop-in-water', 'warn', obj, `stands on a water tile`)
    }

    const idx = obj.y * gw + obj.x
    const host = occupied[idx]
    if (host) {
      add('prop-inside-building', 'error', obj,
        `sits inside "${host.definitionId}" footprint — buried in the building`)
    }

    const prev = propAtTile.get(idx)
    if (prev) {
      add('prop-stacked', 'warn', obj,
        `shares tile (${obj.x},${obj.y}) with "${prev.definitionId}" — overlapping geometry`)
    } else {
      propAtTile.set(idx, obj)
    }
  }

  return {
    ok: errors === 0,
    counts: { structures: structures.length, props: props.length, errors, warnings },
    byKind,
    issues,
    missingDefinitions: [...missingDefs].sort(),
  }
}
