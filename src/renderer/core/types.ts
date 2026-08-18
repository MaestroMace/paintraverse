// =============================================
// PainTraverse Core Data Types
// =============================================

// === MAP DOCUMENT ===

export interface MapDocument {
  id: string
  name: string
  version: number
  gridWidth: number
  gridHeight: number
  tileSize: number
  layers: MapLayer[]
  environment: EnvironmentState
  cameras: RenderCamera[]
  generationConfig?: GenerationConfig
}

export interface MapLayer {
  id: string
  name: string
  type: LayerType
  visible: boolean
  locked: boolean
  objects: PlacedObject[]
  terrainTiles?: number[][] // only for terrain layers
  /**
   * Ground elevation per tile, raw units — TERRAIN_WORLD_SCALE turns them
   * into metres. Terrain layers only.
   *
   * This exists because there were TWO height maps and they were different
   * landscapes. TownGenerator built one (freq 0.03/0.06, x2.0, clamp 2.5, 70%
   * terraced) and planned the whole town against it; TerrainMesh built its own
   * from the seed (freq 0.022/0.055/0.11, x4.4, clamp 5.5, 10% terraced) and
   * drew that. So ponds were placed in the low ground of a landscape the
   * player never saw, and a river carved into the generator's terrain was
   * invisible in 3D. One map now, written here by the generator and consumed
   * by the renderer; TerrainMesh keeps its own generator only as a fallback
   * for maps that predate this field.
   */
  heightMap?: number[][]
  /**
   * The WATERLINE per tile, raw units, meaningful only where the terrain is
   * water. Absent entries mean "flush with the ground", which is what ponds
   * and hand-drawn water get.
   *
   * It has to be stored rather than derived because the renderer cannot know
   * it: `terrainCornerY` samples the height field at the corner's own tile, so
   * a water tile bordering land takes the LAND height at that corner and the
   * water surface ramps up out of its own channel at every shoreline. The
   * carve puts a real valley in the height map and the shoreline smeared it
   * away — measured 0.71m of bank relief in the tile centres, and photographed
   * a knife-edge flush waterline. This is the level the surface actually sits
   * at, independent of the ground under it.
   */
  waterLevel?: number[][]
  /**
   * Which quarter owns each tile, as a district id, plus the id -> type table
   * to read it with. Terrain layers only.
   *
   * Stored for the same reason `heightMap` is: it is a fact about the PLAN
   * that nothing downstream can recover. The obvious reconstruction — read the
   * ground and infer the quarter — is the mistake this repo has now made three
   * times (dressEmptyStreets, narrowRoadSwathes, anomaly.mjs's sky mask), and
   * the one-material-per-place pass makes it worse by deliberately giving
   * several quarters the same paving. Buildings carry a `district` property,
   * but they are sparse and absent exactly where the interesting question is:
   * on the street between two quarters.
   */
  districtMap?: number[][]
  districtTypes?: Record<number, string>
}

export type LayerType = 'terrain' | 'structure' | 'prop' | 'road' | 'water' | 'custom'

// === PLACED OBJECTS ===

export interface PlacedObject {
  id: string
  definitionId: string
  x: number
  y: number
  rotation: number
  scaleX: number
  scaleY: number
  elevation: number
  properties: Record<string, unknown>
  /**
   * The tile rectangle this object ACTUALLY reserved when it was placed.
   *
   * Without this, an object stores only `definitionId` and every consumer
   * re-derives the rectangle from the definition — which ten separate files
   * did, independently. That made any change to how a building occupies space
   * a ten-file change where missing one is SILENT: the generator reserves
   * h x w, a consumer reads w x h, and you get props buried inside buildings
   * or meshes drawn through their neighbours. Four attempts at plot
   * orientation died on exactly that.
   *
   * Optional so hand-authored and legacy maps still load; read it through
   * `footprintOf()` below, which falls back to the definition.
   */
  footprint?: { w: number; h: number }
}

/**
 * The tile rectangle an object occupies. THE one way to ask.
 *
 * Prefers what the placer actually reserved and falls back to the definition,
 * so a map saved before footprints were recorded still renders correctly.
 * Everything that needs to know where a building sits — the renderer, the
 * audit, the collision mask, prop placement, the plan view — must come
 * through here rather than reaching for `def.footprint` itself.
 */
export function footprintOf(
  obj: PlacedObject,
  def?: { footprint?: { w: number; h: number } } | null,
): { w: number; h: number } {
  const f = obj.footprint ?? def?.footprint
  return { w: Math.max(1, f?.w ?? 1), h: Math.max(1, f?.h ?? 1) }
}

/**
 * THE STABLE ARCHITECTURAL SEED for a placed object. THE one way to ask.
 *
 * Every renderer decides a building's whole character from `simpleHash(obj.id)`
 * — massing template, landmark promotion, timber versus quoins, roof style,
 * chimneys, awnings, wealthScale, and every `rand01(hash, salt)` under them.
 * And `obj.id` IS A UUID, freshly minted on every generate. So the town's
 * LAYOUT was perfectly deterministic while its ARCHITECTURE was reseeded every
 * single run:
 *
 *     layoutHash  3211781608  3211781608  3211781608   identical
 *     idHash      3902668415  4159138546  3050480396   never the same
 *
 * That is the real source of the harness noise floor, and it had already been
 * measured and MISATTRIBUTED. `--repeat=3` recorded districts perfectly stable
 * at 49 while odd's counts swung by 12, and the note reasoned: districts reads
 * the MAP so the generator is deterministic, therefore the movement must be a
 * timing race plus counts sitting on a threshold. Half of that was right — the
 * race was real and fixing it took habitablePinned to spread 0 — and the
 * residual was explained structurally when the truth is simpler and worse: it
 * was a different town every time. Same streets, different buildings on them.
 *
 * Everything downstream inherited it. "Pin the seed" was the discipline, and
 * the seed only ever pinned the layout, so every A/B in this repo has been
 * measuring its change plus an unknown amount of reshuffled architecture.
 *
 * Position is the right key: the seeded generator decides it, footprints do
 * not overlap within a layer, and it survives save/load — where a regenerated
 * UUID would silently repaint the whole town. Definition id is folded in so a
 * prop and the building under it do not share a seed.
 */
export function stableHash(obj: { definitionId: string; x: number; y: number }): number {
  const s = `${obj.definitionId}|${obj.x},${obj.y}`
  let h = 0
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * SOMEWHERE A HOUSEHOLD LIVES. THE one way to ask, for the same reason
 * `footprintOf` and `stableHash` are here: a value several files derive
 * independently is a value that drifts, silently.
 *
 * It had already drifted three ways before this existed, and the copies did
 * not merely differ in length — they disagreed about what a home IS:
 *
 *   TownGenerator  12 ids   decides where domestic dressing GOES
 *   tenancy.mjs    11 ids   decides whether that dressing counts as EXPLAINED
 *   eyeball.mjs    15 ids   decides which buildings are graded as ORDINARY
 *
 * So the generator hung washing on a `half_timber` that tenancy did not
 * recognise and scored the placer's own correct behaviour as a failure — the
 * numerator and denominator counting different populations, which is a
 * mistake this repo has now made in four separate tools. And eyeball counted
 * `coach_house` and `potting_shed` as dwellings: an outbuilding and a garden
 * shed, both of which drag the storey distribution it reports.
 *
 * The merged set is the union MINUS the two that are not houses. Outbuildings
 * (`coach_house`, `potting_shed`, `sexton_hut`) and `clergy_house` are quarter
 * signature types, not homes — a quarter's exclusive building is the thing
 * that makes it distinctive, and treating it as ordinary housing defeats both
 * the character metric and the domestic dressing. `building_medium` is a
 * generic mid-size block that lands in every quarter, so it is out for the
 * same reason: it says nothing about who is inside.
 *
 * The tools read this list out of this file rather than restating it.
 *
 * TWO OF THE TWELVE ENTRIES WERE IDS THE GAME DOES NOT DEFINE. `cottage` and
 * `townhouse` came across in the merge because they were in the generator's
 * list, and nobody had ever checked them against store.ts — the same defect
 * tenancy.mjs's own header records making with invented prop ids, one field
 * over. A dead entry in a shared vocabulary is worse than a private one: the
 * next person writing a district table reaches for a type that cannot exist.
 * `cottage` is a real definition now because the residential quarter needed
 * exactly that; `townhouse` is dropped until something defines it.
 */
export const DWELLING_TYPES: ReadonlySet<string> = new Set([
  'row_house', 'building_small', 'cottage', 'half_timber',
  'balcony_house', 'corner_building', 'building_large',
  'narrow_house', 'tenement', 'lean_to', 'almshouse',
])

// === OBJECT DEFINITIONS ===

export interface ObjectDefinition {
  id: string
  name: string
  category: ObjectCategory
  tags: string[]
  color: string           // fallback color when no texture
  textureId?: string      // texture reference
  footprint: { w: number; h: number }
  styleSetSlots: string[]
  render3d?: Render3DSpec
}

export type ObjectCategory = 'building' | 'prop' | 'terrain' | 'vegetation' | 'infrastructure' | 'custom'

export interface Render3DSpec {
  type: 'extrusion' | 'billboard' | 'model' | 'composite'
  height?: number
  faces?: Record<string, string>
  children?: Render3DSpec[]
}

// === STYLE SETS ===

export interface StyleSet {
  id: string
  name: string
  slots: Record<string, StyleSlot>
}

export interface StyleSlot {
  variants: StyleVariant[]
  defaultWeight: number
}

export interface StyleVariant {
  textureId: string
  weight: number
  tags: string[]
}

// === TEXTURES ===

export interface TextureEntry {
  id: string
  name: string
  path: string
  width: number
  height: number
  tags: string[]
}

// === ENVIRONMENT ===

export interface EnvironmentState {
  timeOfDay: number        // 0-24
  weather: WeatherType
  weatherIntensity: number // 0-1
  celestial: {
    moonPhase: number
    starDensity: number
    sunAngle: number
  }
  lighting: {
    ambientColor: string
    ambientIntensity: number
    directionalAngle: number
    directionalIntensity: number
  }
}

export type WeatherType = 'clear' | 'rain' | 'fog' | 'snow' | 'storm'

// === GENERATION CONFIG ===

export interface GenerationConfig {
  mapType: string
  seed: number
  width: number
  height: number
  complexity: number       // 0-1
  density: number          // 0-1
  styleSetId?: string
  assetFrequencies: Record<string, number>
  levelCount: number
  customParams: Record<string, unknown>
}

// === RENDER CAMERA ===

export interface RenderCamera {
  id: string
  name: string
  worldX: number
  worldY: number
  lookAtX: number
  lookAtY: number
  elevation: number
  fov: number
  outputWidth: number
  outputHeight: number
  paletteId: string
}

// === MANIFEST / TODO ===

export interface ManifestEntry {
  id: string
  title: string
  status: ManifestStatus
  linkedAssets: string[]
  notes: string
  priority: number
}

export type ManifestStatus = 'todo' | 'in-progress' | 'done'

// === PROJECT ===

export interface Project {
  name: string
  version: string
  maps: string[]           // map file paths
  styleSets: string[]
  manifest: ManifestEntry[]
  textures: TextureEntry[]
  objectDefinitions: ObjectDefinition[]
}

// === EDITOR STATE ===

export type ToolType = 'select' | 'place' | 'erase' | 'brush' | 'camera'

// === APP MODES ===

export type AppMode = 'menu' | 'landscape' | 'asset-creator'

// === SEARCH / ASSET GENERATION ===

export interface SearchResult {
  id: string
  url: string
  thumbnailUrl: string
  title: string
  source: string
  width: number
  height: number
}

export interface GeneratedAsset {
  id: string
  name: string
  prompt: string
  imageUrl: string
  modelUrl?: string
  status: 'pending' | 'generating' | 'complete' | 'error'
  createdAt: number
}

export interface SelectionState {
  selectedIds: string[]
  hoveredId: string | null
}

// === COMMANDS (undo/redo) ===

export interface Command {
  type: string
  description: string
  execute: () => void
  undo: () => void
}
