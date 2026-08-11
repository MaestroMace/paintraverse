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
