import { create } from 'zustand'
import { v4 as uuid } from 'uuid'
import type {
  MapDocument,
  MapLayer,
  PlacedObject,
  ObjectDefinition,
  ManifestEntry,
  TextureEntry,
  StyleSet,
  RenderCamera,
  ToolType,
  Command,
  EnvironmentState,
  AppMode,
  SearchResult,
  GeneratedAsset
} from '../core/types'
import type { ExtractedPalette } from '../inspiration/PaletteExtractor'
import type { BuildingPalette } from '../inspiration/StyleMapper'

// === DEFAULT FACTORIES ===

function createDefaultEnvironment(): EnvironmentState {
  return {
    timeOfDay: 12,
    weather: 'clear',
    weatherIntensity: 0,
    celestial: { moonPhase: 0.5, starDensity: 0.5, sunAngle: 45 },
    lighting: {
      ambientColor: '#ffffff',
      ambientIntensity: 0.6,
      directionalAngle: 45,
      directionalIntensity: 0.8
    }
  }
}

function createDefaultLayer(type: MapLayer['type'], name: string): MapLayer {
  return {
    id: uuid(),
    name,
    type,
    visible: true,
    locked: false,
    objects: [],
    terrainTiles: type === 'terrain' ? [] : undefined
  }
}

function createDefaultMap(): MapDocument {
  const terrainLayer = createDefaultLayer('terrain', 'Terrain')
  // Initialize terrain grid
  terrainLayer.terrainTiles = Array.from({ length: 32 }, () =>
    Array.from({ length: 32 }, () => 0)
  )
  return {
    id: uuid(),
    name: 'Untitled Map',
    version: 1,
    gridWidth: 32,
    gridHeight: 32,
    tileSize: 32,
    layers: [
      terrainLayer,
      createDefaultLayer('structure', 'Structures'),
      createDefaultLayer('prop', 'Props')
    ],
    environment: createDefaultEnvironment(),
    cameras: []
  }
}

// === DEFAULT OBJECT DEFINITIONS ===

const defaultObjectDefs: ObjectDefinition[] = [
  // === BUILDINGS — Heritage Architecture ===
  {
    id: 'building_small',
    name: 'Small House',
    category: 'building',
    tags: ['structure', 'residential'],
    color: '#8B7355',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door']
  },
  {
    id: 'building_medium',
    name: 'Town House',
    category: 'building',
    tags: ['structure', 'residential'],
    color: '#A0896C',
    footprint: { w: 3, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'building_large',
    name: 'Large House',
    category: 'building',
    tags: ['structure', 'residential'],
    color: '#6B5B4A',
    footprint: { w: 4, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'tavern',
    name: 'Tavern',
    category: 'building',
    tags: ['structure', 'commercial', 'social'],
    color: '#7A5A3A',
    footprint: { w: 4, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door', 'window', 'sign']
  },
  {
    id: 'shop',
    name: 'Shop',
    category: 'building',
    tags: ['structure', 'commercial'],
    color: '#9A7A5A',
    footprint: { w: 2, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door', 'window', 'awning']
  },
  {
    id: 'tower',
    name: 'Tower',
    category: 'building',
    tags: ['structure', 'landmark'],
    color: '#606070',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'window']
  },
  {
    id: 'balcony_house',
    name: 'Balcony House',
    category: 'building',
    tags: ['structure', 'residential'],
    color: '#B09878',
    footprint: { w: 3, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window', 'balcony']
  },
  {
    id: 'archway',
    name: 'Archway',
    category: 'building',
    tags: ['structure', 'passage'],
    color: '#707060',
    footprint: { w: 3, h: 1 },
    styleSetSlots: ['wall']
  },
  {
    id: 'staircase',
    name: 'Staircase',
    category: 'building',
    tags: ['structure', 'elevation'],
    color: '#808078',
    footprint: { w: 2, h: 3 },
    styleSetSlots: []
  },
  {
    id: 'row_house',
    name: 'Row House',
    category: 'building',
    tags: ['structure', 'residential', 'narrow'],
    color: '#A89880',
    footprint: { w: 1, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'town_gate',
    name: 'Town Gate',
    category: 'building',
    tags: ['structure', 'landmark', 'passage'],
    color: '#5A5A60',
    footprint: { w: 3, h: 1 },
    styleSetSlots: ['wall']
  },
  {
    id: 'corner_building',
    name: 'Corner Building',
    category: 'building',
    tags: ['structure', 'commercial'],
    color: '#B8A890',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window', 'awning']
  },
  // --- New heritage buildings ---
  {
    id: 'chapel',
    name: 'Chapel',
    category: 'building',
    tags: ['structure', 'religious', 'landmark'],
    color: '#A0A098',
    footprint: { w: 3, h: 4 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'guild_hall',
    name: 'Guild Hall',
    category: 'building',
    tags: ['structure', 'commercial', 'landmark'],
    color: '#8A7A68',
    footprint: { w: 4, h: 4 },
    styleSetSlots: ['wall', 'roof', 'door', 'window', 'banner']
  },
  {
    id: 'warehouse',
    name: 'Warehouse',
    category: 'building',
    tags: ['structure', 'commercial', 'storage'],
    color: '#6A5A48',
    footprint: { w: 4, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door']
  },
  {
    id: 'watchtower',
    name: 'Watchtower',
    category: 'building',
    tags: ['structure', 'military', 'landmark'],
    color: '#5A5A5A',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'window']
  },
  {
    id: 'mansion',
    name: 'Mansion',
    category: 'building',
    tags: ['structure', 'residential', 'noble'],
    color: '#C8B8A0',
    footprint: { w: 5, h: 4 },
    styleSetSlots: ['wall', 'roof', 'door', 'window', 'balcony']
  },
  {
    id: 'bakery',
    name: 'Bakery',
    category: 'building',
    tags: ['structure', 'commercial'],
    color: '#B89878',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window', 'awning']
  },
  {
    id: 'apothecary',
    name: 'Apothecary',
    category: 'building',
    tags: ['structure', 'commercial'],
    color: '#7A8A6A',
    footprint: { w: 2, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door', 'window', 'sign']
  },
  {
    id: 'inn',
    name: 'Inn',
    category: 'building',
    tags: ['structure', 'commercial', 'social'],
    color: '#9A7A58',
    footprint: { w: 3, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door', 'window', 'sign', 'balcony']
  },
  {
    id: 'temple',
    name: 'Temple',
    category: 'building',
    tags: ['structure', 'religious', 'landmark'],
    color: '#B0A890',
    footprint: { w: 5, h: 5 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'covered_market',
    name: 'Covered Market',
    category: 'building',
    tags: ['structure', 'commercial'],
    color: '#8A7A60',
    footprint: { w: 4, h: 3 },
    styleSetSlots: ['wall', 'roof']
  },
  {
    id: 'bell_tower',
    name: 'Bell Tower',
    category: 'building',
    tags: ['structure', 'landmark'],
    color: '#9A9A90',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'window']
  },
  {
    id: 'half_timber',
    name: 'Half-Timber House',
    category: 'building',
    tags: ['structure', 'residential'],
    color: '#C8B090',
    footprint: { w: 3, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'narrow_house',
    name: 'Narrow House',
    category: 'building',
    tags: ['structure', 'residential'],
    color: '#A89070',
    footprint: { w: 1, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },

  // === VEGETATION ===
  {
    id: 'tree',
    name: 'Tree',
    category: 'vegetation',
    tags: ['nature'],
    color: '#2D5A27',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'bush',
    name: 'Bush',
    category: 'vegetation',
    tags: ['nature'],
    color: '#3A7A33',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'potted_plant',
    name: 'Potted Plant',
    category: 'vegetation',
    tags: ['nature', 'decoration'],
    color: '#3A8A3A',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'planter_box',
    name: 'Planter Box',
    category: 'vegetation',
    tags: ['nature', 'decoration'],
    color: '#5A7A3A',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },

  // === INFRASTRUCTURE ===
  {
    id: 'lamppost',
    name: 'Lamppost',
    category: 'infrastructure',
    tags: ['light'],
    color: '#4A4A4A',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'wall_lantern',
    name: 'Wall Lantern',
    category: 'infrastructure',
    tags: ['light', 'mounted'],
    color: '#8A6A2A',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'fence',
    name: 'Fence',
    category: 'infrastructure',
    tags: ['barrier'],
    color: '#6A5030',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'stone_wall',
    name: 'Stone Wall',
    category: 'infrastructure',
    tags: ['barrier'],
    color: '#707068',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },

  // === PROPS (Street Furniture) ===
  {
    id: 'bench',
    name: 'Bench',
    category: 'prop',
    tags: ['furniture', 'seating'],
    color: '#8B6914',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'sign',
    name: 'Sign Post',
    category: 'prop',
    tags: ['info'],
    color: '#CD853F',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'hanging_sign',
    name: 'Hanging Sign',
    category: 'prop',
    tags: ['info', 'commercial'],
    color: '#B8860B',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'barrel',
    name: 'Barrel',
    category: 'prop',
    tags: ['container', 'storage'],
    color: '#6B4226',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'barrel_stack',
    name: 'Barrel Stack',
    category: 'prop',
    tags: ['container', 'storage'],
    color: '#5A3A1A',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'crate',
    name: 'Crate',
    category: 'prop',
    tags: ['container', 'storage'],
    color: '#8B7355',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'crate_stack',
    name: 'Crate Stack',
    category: 'prop',
    tags: ['container', 'storage'],
    color: '#7A6A50',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'cafe_table',
    name: 'Cafe Table',
    category: 'prop',
    tags: ['furniture', 'social'],
    color: '#B8A088',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'fountain',
    name: 'Fountain',
    category: 'prop',
    tags: ['water', 'decoration', 'landmark'],
    color: '#4682B4',
    footprint: { w: 2, h: 2 },
    styleSetSlots: []
  },
  {
    id: 'well',
    name: 'Well',
    category: 'prop',
    tags: ['water'],
    color: '#696969',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },

  // === TIER 3: LANDMARKS & ENVIRONMENT ===
  {
    id: 'clock_tower',
    name: 'Clock Tower',
    category: 'building',
    tags: ['structure', 'landmark'],
    color: '#5A5A68',
    footprint: { w: 3, h: 3 },
    styleSetSlots: ['wall', 'roof', 'window']
  },
  {
    id: 'bridge',
    name: 'Bridge',
    category: 'infrastructure',
    tags: ['passage', 'water'],
    color: '#7A7A70',
    footprint: { w: 4, h: 2 },
    styleSetSlots: []
  },
  {
    id: 'water_channel',
    name: 'Water Channel',
    category: 'infrastructure',
    tags: ['water', 'terrain'],
    color: '#3A6A9A',
    footprint: { w: 1, h: 4 },
    styleSetSlots: []
  },
  {
    id: 'market_stall',
    name: 'Market Stall',
    category: 'prop',
    tags: ['commercial', 'social'],
    color: '#AA4444',
    footprint: { w: 2, h: 2 },
    styleSetSlots: []
  },
  {
    id: 'street_lamp_double',
    name: 'Double Lamp',
    category: 'infrastructure',
    tags: ['light'],
    color: '#3A3A3A',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'wagon',
    name: 'Wagon',
    category: 'prop',
    tags: ['transport', 'storage'],
    color: '#6A5030',
    footprint: { w: 3, h: 2 },
    styleSetSlots: []
  },
  {
    id: 'statue',
    name: 'Statue',
    category: 'prop',
    tags: ['decoration', 'landmark'],
    color: '#8A8A88',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  // --- New props: life and heritage ---
  {
    id: 'horse_post',
    name: 'Horse Post',
    category: 'prop',
    tags: ['transport'],
    color: '#5A4A30',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'flower_box',
    name: 'Flower Box',
    category: 'vegetation',
    tags: ['nature', 'decoration'],
    color: '#8A5A3A',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'rain_barrel',
    name: 'Rain Barrel',
    category: 'prop',
    tags: ['water', 'storage'],
    color: '#5A4A38',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'woodpile',
    name: 'Woodpile',
    category: 'prop',
    tags: ['storage'],
    color: '#7A5A30',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'cart',
    name: 'Cart',
    category: 'prop',
    tags: ['transport'],
    color: '#6A5030',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'column',
    name: 'Column',
    category: 'infrastructure',
    tags: ['decoration', 'architectural'],
    color: '#A0A098',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'monument',
    name: 'Monument',
    category: 'prop',
    tags: ['decoration', 'landmark'],
    color: '#8A8A80',
    footprint: { w: 2, h: 2 },
    styleSetSlots: []
  },
  {
    id: 'garden_arch',
    name: 'Garden Arch',
    category: 'vegetation',
    tags: ['decoration', 'nature'],
    color: '#4A7A3A',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'cloth_line',
    name: 'Clothesline',
    category: 'prop',
    tags: ['domestic'],
    color: '#C0B090',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'hay_bale',
    name: 'Hay Bale',
    category: 'prop',
    tags: ['agricultural'],
    color: '#C8A850',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'dock',
    name: 'Dock',
    category: 'infrastructure',
    tags: ['water', 'harbor'],
    color: '#6A5030',
    footprint: { w: 3, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'crane',
    name: 'Crane',
    category: 'infrastructure',
    tags: ['harbor', 'industrial'],
    color: '#4A4A4A',
    footprint: { w: 2, h: 2 },
    styleSetSlots: []
  },
  {
    id: 'pier',
    name: 'Pier',
    category: 'infrastructure',
    tags: ['water', 'harbor'],
    color: '#5A4A30',
    footprint: { w: 4, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'fishing_boat',
    name: 'Fishing Boat',
    category: 'prop',
    tags: ['water', 'harbor'],
    color: '#6A5030',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'gravestone',
    name: 'Gravestone',
    category: 'prop',
    tags: ['cemetery', 'decoration'],
    color: '#8A8A80',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'iron_fence',
    name: 'Iron Fence',
    category: 'infrastructure',
    tags: ['barrier', 'cemetery'],
    color: '#3A3A3A',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'windmill',
    name: 'Windmill',
    category: 'building',
    tags: ['structure', 'landmark', 'countryside'],
    color: '#C8B898',
    footprint: { w: 3, h: 3 },
    styleSetSlots: ['wall', 'roof']
  },
  {
    id: 'farm_field',
    name: 'Farm Field',
    category: 'prop',
    tags: ['agricultural', 'countryside'],
    color: '#8A7A40',
    footprint: { w: 4, h: 3 },
    styleSetSlots: []
  },
  {
    id: 'orchard_tree',
    name: 'Orchard Tree',
    category: 'vegetation',
    tags: ['nature', 'countryside'],
    color: '#2D7A27',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'road_marker',
    name: 'Road Marker',
    category: 'prop',
    tags: ['info', 'countryside'],
    color: '#8A8A80',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
]

// === STORE ===

interface AppState {
  // App mode
  appMode: AppMode

  // Document
  map: MapDocument
  projectName: string
  projectPath: string | null
  dirty: boolean

  // Object definitions
  objectDefinitions: ObjectDefinition[]
  selectedDefinitionId: string | null

  // Textures
  textures: TextureEntry[]

  // Style sets
  styleSets: StyleSet[]

  // Manifest
  manifest: ManifestEntry[]

  // Editor state
  activeTool: ToolType
  activeLayerId: string | null
  selectedObjectIds: string[]
  hoveredObjectId: string | null
  brushTileId: number

  // Camera for rendering
  renderCamera: RenderCamera

  // Inspiration
  inspirationImage: string | null
  inspirationPalette: ExtractedPalette | null
  buildingPalettes: BuildingPalette[] | null  // null = use defaults

  // Search & Asset Generation
  searchResults: SearchResult[]
  searchQuery: string
  searchLoading: boolean
  generatedAssets: GeneratedAsset[]
  selectedSearchResult: SearchResult | null

  // Undo/redo
  undoStack: Command[]
  redoStack: Command[]

  // Mode
  setAppMode: (mode: AppMode) => void

  // Map operations
  setMap: (map: MapDocument) => void
  setProjectPath: (path: string | null) => void
  setDirty: (dirty: boolean) => void

  // Layer operations
  toggleLayerVisibility: (layerId: string) => void
  toggleLayerLock: (layerId: string) => void
  setActiveLayer: (layerId: string | null) => void

  // Object operations
  addObjectToLayer: (layerId: string, obj: PlacedObject) => void
  removeObjectFromLayer: (layerId: string, objectId: string) => void
  updateObjectInLayer: (layerId: string, objectId: string, props: Partial<PlacedObject>) => void

  // Terrain operations
  paintTerrain: (layerId: string, x: number, y: number, tileId: number) => void

  // Selection
  setSelectedObjectIds: (ids: string[]) => void
  setHoveredObjectId: (id: string | null) => void

  // Tools
  setActiveTool: (tool: ToolType) => void
  setSelectedDefinitionId: (id: string | null) => void
  setBrushTileId: (id: number) => void

  // Object definitions
  addObjectDefinition: (def: ObjectDefinition) => void
  removeObjectDefinition: (id: string) => void

  // Inspiration
  setInspirationImage: (dataURL: string | null) => void
  setInspirationPalette: (palette: ExtractedPalette | null) => void
  setBuildingPalettes: (palettes: BuildingPalette[] | null) => void

  // Camera
  setRenderCamera: (camera: RenderCamera) => void
  updateRenderCamera: (updates: Partial<RenderCamera>) => void

  // Style sets
  addStyleSet: (ss: StyleSet) => void
  updateStyleSet: (id: string, updates: Partial<StyleSet>) => void
  removeStyleSet: (id: string) => void

  // Environment
  updateEnvironment: (updates: Partial<EnvironmentState>) => void

  // Manifest
  addManifestEntry: (entry: ManifestEntry) => void
  updateManifestEntry: (id: string, updates: Partial<ManifestEntry>) => void
  removeManifestEntry: (id: string) => void

  // Search & Asset Generation
  setSearchResults: (results: SearchResult[]) => void
  setSearchQuery: (query: string) => void
  setSearchLoading: (loading: boolean) => void
  setSelectedSearchResult: (result: SearchResult | null) => void
  addGeneratedAsset: (asset: GeneratedAsset) => void
  updateGeneratedAsset: (id: string, updates: Partial<GeneratedAsset>) => void
  removeGeneratedAsset: (id: string) => void

  // Undo/redo
  executeCommand: (cmd: Command) => void
  undo: () => void
  redo: () => void

  // Serialization
  toJSON: () => string
  loadFromJSON: (json: string) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  // Initial state
  appMode: 'menu' as AppMode,
  map: createDefaultMap(),
  projectName: 'Untitled Project',
  projectPath: null,
  dirty: false,
  objectDefinitions: defaultObjectDefs,
  selectedDefinitionId: defaultObjectDefs[0].id,
  textures: [],
  styleSets: [],
  manifest: [],
  activeTool: 'select',
  activeLayerId: null,
  selectedObjectIds: [],
  hoveredObjectId: null,
  brushTileId: 1,
  renderCamera: {
    id: 'default-camera',
    name: 'Camera 1',
    worldX: 14,
    worldY: 12,
    lookAtX: 26,
    lookAtY: 26,
    elevation: 3,
    fov: 55,
    outputWidth: 320,
    outputHeight: 240,
    paletteId: 'db32'
  },
  inspirationImage: null,
  inspirationPalette: null,
  buildingPalettes: null,
  searchResults: [],
  searchQuery: '',
  searchLoading: false,
  generatedAssets: [],
  selectedSearchResult: null,
  undoStack: [],
  redoStack: [],

  // Mode
  setAppMode: (mode) => set({ appMode: mode }),

  // Map operations
  setMap: (map) => set({ map, dirty: true }),
  setProjectPath: (path) => set({ projectPath: path }),
  setDirty: (dirty) => set({ dirty }),

  // Layer operations
  toggleLayerVisibility: (layerId) =>
    set((state) => ({
      map: {
        ...state.map,
        layers: state.map.layers.map((l) =>
          l.id === layerId ? { ...l, visible: !l.visible } : l
        )
      }
    })),

  toggleLayerLock: (layerId) =>
    set((state) => ({
      map: {
        ...state.map,
        layers: state.map.layers.map((l) =>
          l.id === layerId ? { ...l, locked: !l.locked } : l
        )
      }
    })),

  setActiveLayer: (layerId) => set({ activeLayerId: layerId }),

  // Object operations
  addObjectToLayer: (layerId, obj) =>
    set((state) => ({
      map: {
        ...state.map,
        layers: state.map.layers.map((l) =>
          l.id === layerId ? { ...l, objects: [...l.objects, obj] } : l
        )
      },
      dirty: true
    })),

  removeObjectFromLayer: (layerId, objectId) =>
    set((state) => ({
      map: {
        ...state.map,
        layers: state.map.layers.map((l) =>
          l.id === layerId
            ? { ...l, objects: l.objects.filter((o) => o.id !== objectId) }
            : l
        )
      },
      selectedObjectIds: state.selectedObjectIds.filter((id) => id !== objectId),
      dirty: true
    })),

  updateObjectInLayer: (layerId, objectId, props) =>
    set((state) => ({
      map: {
        ...state.map,
        layers: state.map.layers.map((l) =>
          l.id === layerId
            ? {
                ...l,
                objects: l.objects.map((o) =>
                  o.id === objectId ? { ...o, ...props } : o
                )
              }
            : l
        )
      },
      dirty: true
    })),

  // Terrain operations — only clone the changed row, skip no-ops
  paintTerrain: (layerId, x, y, tileId) =>
    set((state) => {
      const layers = state.map.layers.map((l) => {
        if (l.id !== layerId || !l.terrainTiles) return l
        if (l.terrainTiles[y]?.[x] === tileId) return l // no-op: already this tile
        const newRow = [...l.terrainTiles[y]]
        newRow[x] = tileId
        const newTiles = [...l.terrainTiles]
        newTiles[y] = newRow
        return { ...l, terrainTiles: newTiles }
      })
      if (layers === state.map.layers) return state // nothing changed
      return { map: { ...state.map, layers }, dirty: true }
    }),

  // Selection
  setSelectedObjectIds: (ids) => set({ selectedObjectIds: ids }),
  setHoveredObjectId: (id) => set({ hoveredObjectId: id }),

  // Tools
  setActiveTool: (tool) => set({ activeTool: tool }),
  setSelectedDefinitionId: (id) => set({ selectedDefinitionId: id }),
  setBrushTileId: (id) => set({ brushTileId: id }),

  // Object definitions
  addObjectDefinition: (def) =>
    set((state) => ({ objectDefinitions: [...state.objectDefinitions, def], dirty: true })),

  removeObjectDefinition: (id) =>
    set((state) => ({
      objectDefinitions: state.objectDefinitions.filter((d) => d.id !== id),
      dirty: true
    })),

  // Inspiration
  setInspirationImage: (dataURL) => set({ inspirationImage: dataURL }),
  setInspirationPalette: (palette) => set({ inspirationPalette: palette }),
  setBuildingPalettes: (palettes) => set({ buildingPalettes: palettes }),

  // Camera
  setRenderCamera: (camera) => set({ renderCamera: camera }),
  updateRenderCamera: (updates) =>
    set((state) => ({ renderCamera: { ...state.renderCamera, ...updates } })),

  // Style sets
  addStyleSet: (ss) =>
    set((state) => ({ styleSets: [...state.styleSets, ss], dirty: true })),

  updateStyleSet: (id, updates) =>
    set((state) => ({
      styleSets: state.styleSets.map((s) =>
        s.id === id ? { ...s, ...updates } : s
      ),
      dirty: true
    })),

  removeStyleSet: (id) =>
    set((state) => ({
      styleSets: state.styleSets.filter((s) => s.id !== id),
      dirty: true
    })),

  // Environment
  updateEnvironment: (updates) =>
    set((state) => ({
      map: {
        ...state.map,
        environment: { ...state.map.environment, ...updates }
      },
      dirty: true
    })),

  // Manifest
  addManifestEntry: (entry) =>
    set((state) => ({ manifest: [...state.manifest, entry], dirty: true })),

  updateManifestEntry: (id, updates) =>
    set((state) => ({
      manifest: state.manifest.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      ),
      dirty: true
    })),

  removeManifestEntry: (id) =>
    set((state) => ({
      manifest: state.manifest.filter((e) => e.id !== id),
      dirty: true
    })),

  // Search & Asset Generation
  setSearchResults: (results) => set({ searchResults: results }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setSearchLoading: (loading) => set({ searchLoading: loading }),
  setSelectedSearchResult: (result) => set({ selectedSearchResult: result }),
  addGeneratedAsset: (asset) =>
    set((state) => ({ generatedAssets: [...state.generatedAssets, asset] })),
  updateGeneratedAsset: (id, updates) =>
    set((state) => ({
      generatedAssets: state.generatedAssets.map((a) =>
        a.id === id ? { ...a, ...updates } : a
      )
    })),
  removeGeneratedAsset: (id) =>
    set((state) => ({
      generatedAssets: state.generatedAssets.filter((a) => a.id !== id)
    })),

  // Undo/redo
  executeCommand: (cmd) => {
    cmd.execute()
    set((state) => ({
      undoStack: [...state.undoStack, cmd],
      redoStack: []
    }))
  },

  undo: () => {
    const { undoStack } = get()
    if (undoStack.length === 0) return
    const cmd = undoStack[undoStack.length - 1]
    cmd.undo()
    set((state) => ({
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, cmd]
    }))
  },

  redo: () => {
    const { redoStack } = get()
    if (redoStack.length === 0) return
    const cmd = redoStack[redoStack.length - 1]
    cmd.execute()
    set((state) => ({
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, cmd]
    }))
  },

  // Serialization
  toJSON: () => {
    const state = get()
    return JSON.stringify({
      projectName: state.projectName,
      map: state.map,
      manifest: state.manifest,
      textures: state.textures,
      objectDefinitions: state.objectDefinitions,
      styleSets: state.styleSets
    }, null, 2)
  },

  loadFromJSON: (json) => {
    const data = JSON.parse(json)
    set({
      projectName: data.projectName || 'Untitled Project',
      map: data.map,
      manifest: data.manifest || [],
      textures: data.textures || [],
      objectDefinitions: data.objectDefinitions?.length
        ? data.objectDefinitions
        : defaultObjectDefs,
      styleSets: data.styleSets || [],
      dirty: false,
      undoStack: [],
      redoStack: [],
      selectedObjectIds: []
    })
  }
}))
