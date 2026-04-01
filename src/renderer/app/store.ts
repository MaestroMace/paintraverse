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
  ToolType,
  Command,
  EnvironmentState
} from '../core/types'

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
  {
    id: 'building_small',
    name: 'Small Building',
    category: 'building',
    tags: ['structure'],
    color: '#8B7355',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door']
  },
  {
    id: 'building_medium',
    name: 'Medium Building',
    category: 'building',
    tags: ['structure'],
    color: '#A0896C',
    footprint: { w: 3, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'building_large',
    name: 'Large Building',
    category: 'building',
    tags: ['structure'],
    color: '#6B5B4A',
    footprint: { w: 4, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'tree',
    name: 'Tree',
    category: 'vegetation',
    tags: ['nature', 'prop'],
    color: '#2D5A27',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'bush',
    name: 'Bush',
    category: 'vegetation',
    tags: ['nature', 'prop'],
    color: '#3A7A33',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'lamppost',
    name: 'Lamppost',
    category: 'infrastructure',
    tags: ['prop', 'light'],
    color: '#4A4A4A',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'bench',
    name: 'Bench',
    category: 'prop',
    tags: ['prop', 'furniture'],
    color: '#8B6914',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'sign',
    name: 'Sign',
    category: 'prop',
    tags: ['prop', 'info'],
    color: '#CD853F',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'fountain',
    name: 'Fountain',
    category: 'prop',
    tags: ['prop', 'water', 'decoration'],
    color: '#4682B4',
    footprint: { w: 2, h: 2 },
    styleSetSlots: []
  },
  {
    id: 'well',
    name: 'Well',
    category: 'prop',
    tags: ['prop', 'water'],
    color: '#696969',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  }
]

// === STORE ===

interface AppState {
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

  // Undo/redo
  undoStack: Command[]
  redoStack: Command[]

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
  undoStack: [],
  redoStack: [],

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

  // Terrain operations
  paintTerrain: (layerId, x, y, tileId) =>
    set((state) => ({
      map: {
        ...state.map,
        layers: state.map.layers.map((l) => {
          if (l.id !== layerId || !l.terrainTiles) return l
          const newTiles = l.terrainTiles.map((row, ry) =>
            ry === y ? row.map((t, rx) => (rx === x ? tileId : t)) : row
          )
          return { ...l, terrainTiles: newTiles }
        })
      },
      dirty: true
    })),

  // Selection
  setSelectedObjectIds: (ids) => set({ selectedObjectIds: ids }),
  setHoveredObjectId: (id) => set({ hoveredObjectId: id }),

  // Tools
  setActiveTool: (tool) => set({ activeTool: tool }),
  setSelectedDefinitionId: (id) => set({ selectedDefinitionId: id }),
  setBrushTileId: (id) => set({ brushTileId: id }),

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
