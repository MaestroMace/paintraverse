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
