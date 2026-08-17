/**
 * Terrain tile vocabulary — the single source of truth for what a tile id
 * MEANS and what colour it is.
 *
 * There were three copies of this table: TerrainMesh (the 3D walkaround),
 * TerrainLayer (the 2D editor plan, which also feeds the texture browser's
 * names), and Canvas2DRenderer (the pixel-art export). They had drifted into
 * genuine disagreement, not just different shades:
 *
 *   - id 6 was "light grass" in 3D and "Road" in the editor's own name table,
 *     so the palette UI offered a road that painted grass.
 *   - id 7 was "gravel" in 3D and "Snow" in the editor, drawn near-white;
 *     the generator writes 7 for rocky ground, so generated towns showed
 *     snowfields in the plan view.
 *   - ids 14/15/16 (plaza flagstone and district paving) were added when the
 *     tile ids were split to separate circulation from paving, but only in
 *     the 3D path. Canvas2DRenderer had never heard of them, so every plaza,
 *     market and harbor district exported as fallback grey.
 *
 * Colours are the warm dusk palette the 3D scene was tuned to; the editor and
 * the export path now match it, which is also why the plan view reads like
 * the town it describes.
 *
 * Renderers still shade these however they like — TerrainMesh applies
 * elevation bias and per-corner jitter, Canvas2DRenderer applies lighting —
 * but they all start from the same base colour and the same meaning.
 */

export const TERRAIN_COLORS: Record<number, number> = {
  0: 0x4a8a3a,  // grass — vivid spring green
  1: 0xa88868,  // dirt — warm earthy tan
  2: 0xc8c0a8,  // stone — pale warm sandstone
  3: 0x4682b4,  // water — renderers handle this specially
  4: 0xe8d090,  // sand — warm light yellow
  5: 0x3a7a28,  // dark grass — forest green
  6: 0x5aae4a,  // light grass — more saturated vivid green
  7: 0xb0a898,  // rocky ground / gravel — warm light grey
  // Paving pulled DOWN, not for its own sake but for the ratio: at noon the
  // ground measured 0.639 against walls at 0.084 (tools/eyeball.mjs), and a
  // town where the floor is seven times brighter than the buildings reads as
  // silhouettes on a beach. Real cobble is a mid tone; this was near-white.
  8: 0x9c8770,  // cobblestone STREET — warm orange-grey
  9: 0x584838,  // dark cobblestone ALLEY — deep warm brown
  10: 0x70a060, // garden
  11: 0x7a5c3a, // mud — saturated brown
  12: 0x78b040, // wildflower — bright apple green
  13: 0xd8c490, // gravel path — warm sandy
  // Plaza / courtyard flagstone. Distinct from 8 so the data says whether a
  // tile is circulation or just paved open space — a building fronting a
  // plaza stands on paving, it does not block a street. Paler and warmer
  // than street cobble so squares read as their own space.
  14: 0xb0a189,   // plaza flagstone — see the note on 8
  // District GROUND paving — market and harbor districts are cobbled all
  // over, which is a material choice, not circulation. Deliberately the same
  // colours as 8/9 so nothing looks different; they exist so the data can say
  // whether a cobbled tile is a street or merely a cobbled district.
  // paintDistrictTerrain lays these down before the street network, so real
  // roads overwrite them with 8/9 exactly where roads actually run.
  15: 0x9c8770, // district cobble (matches 8)
  16: 0x584838, // dark district cobble (matches 9)
}

export const TERRAIN_NAMES: Record<number, string> = {
  0: 'Grass',
  1: 'Dirt',
  2: 'Stone',
  3: 'Water',
  4: 'Sand',
  5: 'Dark Grass',
  6: 'Light Grass',
  7: 'Rocky Ground',
  8: 'Cobblestone Street',
  9: 'Alley Cobble',
  10: 'Garden',
  11: 'Mud',
  12: 'Wildflower',
  13: 'Gravel Path',
  14: 'Plaza Flagstone',
  15: 'District Cobble',
  16: 'Dark District Cobble',
}

/** Water. Blocks building and prop placement; renderers draw it specially. */
export const TILE_WATER = 3
/** Cobbled street. */
export const TILE_STREET = 8
/** Narrow alley. */
export const TILE_ALLEY = 9

/**
 * Is this tile part of the walkable street network?
 *
 * Only 8 and 9 are. This distinction is the whole reason ids 14/15/16 exist,
 * and getting it wrong has caused real bugs twice: an audit that counted
 * every plaza-fronting building as "blocking a street" (~350 false errors),
 * and a town wall built straight across an alley because the placer tested
 * roadMap while carveAlleys paints tile 9 without registering it there.
 * Anything that asks "is this a street?" should ask here.
 */
export function isCirculation(tileId: number | undefined): boolean {
  return tileId === TILE_STREET || tileId === TILE_ALLEY
}
