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
import { getGenerator } from '../generation/GeneratorRegistry'

// === DEFAULT FACTORIES ===

function createDefaultEnvironment(): EnvironmentState {
  return {
    // 6:30 PM (dusk) — bloom + window glow + warm ambient all kick in here,
    // and noon at render scale looks washed out.
    timeOfDay: 18.5,
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
  // === SMALL DISTRICT-SPECIFIC HOUSES ===
  //
  // Measured need, not decoration. `tools/districts.mjs` put district
  // character at 26% and the cause was that three fill passes hardcoded
  // row_house / building_small into every quarter. Routing them through
  // DISTRICT_BUILDINGS fixed the character (57%) but cost built coverage,
  // because a census of the tables showed temple, noble and cemetery own no
  // small ORDINARY building at all — their only entries under 3 tiles are
  // towers, which infill correctly refuses to use. So those quarters had to
  // choose between being dense and being themselves.
  //
  // These are the missing vocabulary: small, humble, and each belonging to
  // one or two quarters, so a quarter can be filled with its OWN fabric.
  // Every one of them is registered in all six id-keyed tables — see
  // tools/registry.mjs, which exists because missing one is silent.
  // === SMALL TRADE-QUARTER TYPES ===
  //
  // Measured: noble 100%, garden 85%, fortress 71% district character — the
  // quarters that were given their own small vocabulary — against harbor 14%,
  // waterfront 17%, market 33%. The trade quarters are three near-identical
  // places: row houses, shops and trade dressing, sharing their whole
  // vocabulary with each other.
  //
  // They DO have exclusive types already. They are just too big to ever get
  // placed: `covered_market` is market-only at 4x3 and `lighthouse` is
  // harbor-only at 3x3, and placeBuildings' own note records why that loses —
  // a type's real odds are its weight TIMES how often it fits, and a 4x3 fits
  // almost nowhere. So the exclusive vocabulary has to be SMALL, which is
  // exactly the shape that worked for temple, cemetery and noble.
  //
  // Both get a distinct massing template rather than a new name on the same
  // box, because a type that reads identically to a row house is WALLPAPER
  // however well it scores.
  // The slum's own two. Same argument as above one level down: `slum` and
  // `residential` shared every entry in their tables, so an 87-building slum
  // read 7% distinctive and was correct to. What actually separates the two
  // in a real town is DENSITY on the same plot — a tenement stacks lodgings
  // where a row house has one household, and a lean-to is the shed somebody
  // ended up living in. Tall-and-narrow beside low-and-flat is a silhouette
  // no other quarter has.
  {
    id: 'tenement',
    name: 'Tenement',
    category: 'building',
    tags: ['structure', 'residential', 'slum'],
    color: '#6E655A',
    footprint: { w: 1, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'lean_to',
    name: 'Lean-To',
    category: 'building',
    tags: ['structure', 'residential', 'slum'],
    color: '#7A6B57',
    footprint: { w: 1, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door']
  },
  {
    id: 'net_loft',
    name: 'Net Loft',
    category: 'building',
    tags: ['structure', 'commercial', 'harbor'],
    color: '#8A7A5E',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'weigh_house',
    name: 'Weigh House',
    category: 'building',
    tags: ['structure', 'commercial', 'market'],
    color: '#A89272',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'clergy_house',
    name: 'Clergy House',
    category: 'building',
    tags: ['structure', 'religious', 'residential'],
    color: '#9C9AA8',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'almshouse',
    name: 'Almshouse',
    category: 'building',
    tags: ['structure', 'religious', 'residential', 'narrow'],
    color: '#A79C90',
    footprint: { w: 1, h: 3 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  // THE ORDINARY QUARTER HAD NO VOCABULARY OF ITS OWN.
  //
  // districts.mjs reads residential at 13-14% distinctive on two seeds of
  // three, the worst of any quarter, and the reason is structural rather
  // than a missing weight: its whole table is row_house / building_small /
  // bakery / narrow_house, every one of which also appears in market,
  // artisan, waterfront, harbor and slum. A type counts as characteristic
  // only if it appears in at most a third of the quarters present, so
  // residential's entire vocabulary is disqualified by construction.
  //
  // The pattern that has now worked six times is a SMALL EXCLUSIVE TYPE,
  // because a type's real odds are its weight times how often it fits and
  // only a small footprint fits often. What an ordinary quarter has that no
  // other does is the shared domestic institution — the place the street
  // washes, and the low dormered cottage between the terraces.
  //
  // `cottage` is not a new idea here: it was already listed in DWELLING_TYPES
  // and in propForRole, and nothing defined it. Two of that set's twelve
  // entries were ids the game does not have, which is the same defect
  // tenancy.mjs's own header records making with invented prop ids — carried
  // forward without checking when the three copies were merged.
  {
    id: 'cottage',
    name: 'Cottage',
    category: 'building',
    tags: ['structure', 'residential', 'humble'],
    color: '#C4B49A',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  // THE CRAFT QUARTER HAD NO VOCABULARY EITHER, and it was worse off than
  // residential ever was: measured 8% and 0% distinctive on the two seeds of
  // eight where artisan is generated at all, with building_small, row_house
  // and corner_building as its top three. Every entry in its table (shop,
  // building_small, row_house, warehouse, corner_building, half_timber,
  // apothecary, staircase) also appears somewhere else, so like residential
  // it is disqualified by construction.
  //
  // Eighth application of the small-exclusive-type pattern. What a craft
  // quarter has that no other does is the PROCESS building and the workshop
  // you live above.
  //
  // A kiln is the one silhouette in this town that is neither a house nor a
  // spire — a squat brick cone with a stack, and smoke. It is an installation
  // rather than housing, so it is capped: two firings a quarter, not a row of
  // them. The workshop is the ordinary artisan house, a dwelling with the
  // ground floor given over to work and a canopy thrown across the front of
  // it, which is why its trade spills into the street.
  {
    id: 'kiln',
    name: 'Kiln',
    category: 'building',
    tags: ['structure', 'industrial', 'artisan'],
    color: '#9C6A4A',
    footprint: { w: 1, h: 2 },
    styleSetSlots: ['wall', 'roof']
  },
  {
    id: 'workshop',
    name: 'Workshop',
    category: 'building',
    tags: ['structure', 'commercial', 'artisan'],
    color: '#9A8A6A',
    footprint: { w: 1, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window', 'awning']
  },
  // 1x2, NOT 2x2. At 2x2 the wash house placed 4/0/0/1/3 across five seeds —
  // absent from two towns entirely — and the zeros were the two SMALLEST
  // residential quarters. That is this repo's most-repeated finding about
  // exclusive types: real odds are the weight times how often the shape fits,
  // and only a 1x2 fits often. Raising the weight instead would have given the
  // big quarters four wash houses in order to give the small ones one.
  //
  // The note lives HERE and not inside the object because registry.mjs scans a
  // 200-character window between `tags:` and `footprint:`, and a comment
  // longer than that makes the definition unparseable. Its PARSER MISS line
  // caught that immediately, which is the whole reason that line exists.
  {
    id: 'washhouse',
    name: 'Wash House',
    category: 'building',
    tags: ['structure', 'residential', 'communal'],
    color: '#9AA5A0',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door']
  },
  {
    id: 'sexton_hut',
    name: "Sexton's Hut",
    category: 'building',
    tags: ['structure', 'functional', 'religious'],
    color: '#8A8474',
    footprint: { w: 1, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door']
  },
  {
    id: 'mausoleum',
    name: 'Mausoleum',
    category: 'building',
    tags: ['structure', 'religious'],
    color: '#B4B2AA',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door']
  },
  {
    id: 'coach_house',
    name: 'Coach House',
    category: 'building',
    tags: ['structure', 'noble', 'functional'],
    color: '#A89684',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door', 'window']
  },
  {
    id: 'potting_shed',
    name: 'Potting Shed',
    category: 'building',
    tags: ['structure', 'functional'],
    color: '#8F9470',
    footprint: { w: 1, h: 2 },
    styleSetSlots: ['wall', 'roof', 'door']
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
  // THE ONE PROP GEOMETRY WITH NO WAY IN. PropFactory has a dedicated
  // picket-fence branch — pointed slats with a rail behind them, distinct from
  // the plain `fence` boards — and it is reached only by the literal id
  // `picket_fence`, which nothing defined. So the branch could never run and
  // the geometry had never once been drawn.
  //
  // Fifth instance of content-with-no-way-in in this repo, and the cheapest:
  // an eight-line definition. A painted picket round a yard is also one of the
  // strongest "somebody owns this" signals available — a boundary says a
  // household drew a line, which is exactly the read the lived-in work wants.
  {
    id: 'picket_fence',
    name: 'Picket Fence',
    category: 'infrastructure',
    tags: ['barrier', 'garden'],
    color: '#E8D8B8',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  // Low boundary wall round a sparse quarter — a churchyard, graveyard or
  // garden edge, not a fortification. 1x1 so it can follow an irregular
  // district boundary tile by tile; the two variants carry the AXIS, since a
  // square footprint cannot imply one. Category 'infrastructure' with a
  // 'barrier' tag so urbanform.mjs counts it as enclosure and never as a
  // building.
  {
    id: 'precinct_wall',
    name: 'Precinct Wall',
    category: 'infrastructure',
    tags: ['barrier'],
    color: '#8D8478',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'precinct_wall_v',
    name: 'Precinct Wall (N-S)',
    category: 'infrastructure',
    tags: ['barrier'],
    color: '#8D8478',
    footprint: { w: 1, h: 1 },
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
  // A one-tile bridge deck. The 4x2 `bridge` cannot span a river that is now
  // up to five tiles wide at its mouth, and it only ever got placed where a
  // road happened to run east into water. This composes to any width along
  // any line, which is what guaranteeing a crossing requires. `passage` is
  // load-bearing: ThreeRenderer clears the collision mask for it.
  {
    id: 'footbridge',
    name: 'Footbridge',
    category: 'infrastructure',
    tags: ['passage', 'water'],
    color: '#8A7458',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
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
  // === THINGS LEFT IN THE STREET, and six that were already modelled ===
  //
  // Half of this block is FREE: PropFactory could already draw hedge,
  // haystack, tent, milestone, pavilion and well_grand and the store defined
  // none of them, so the geometry existed and nothing could ever place it.
  // That is the ghost in reverse — content with no way in — and diffing the
  // ids the renderer HANDLES against the ids the store DEFINES is one grep.
  //
  // The other half is new, and it is aimed at the one gap the vignette arc
  // left open: the town's clutter is crates and barrels and almost nothing
  // else, all of it tidied against a wall. A handcart tipped on its nose, a
  // ladder still leaning, sacks that read as cloth rather than joinery.
  { id: 'handcart', name: 'Handcart', category: 'prop', tags: ['trade', 'vehicle'],
    color: '#7A5A34', footprint: { w: 2, h: 1 }, styleSetSlots: [] },
  { id: 'ladder', name: 'Ladder', category: 'prop', tags: ['tool'],
    color: '#8A6A3C', footprint: { w: 1, h: 1 }, styleSetSlots: [] },
  { id: 'water_trough', name: 'Water Trough', category: 'prop', tags: ['animal'],
    color: '#827C72', footprint: { w: 2, h: 1 }, styleSetSlots: [] },
  { id: 'sack_pile', name: 'Sack Pile', category: 'prop', tags: ['storage', 'trade'],
    color: '#A89A72', footprint: { w: 1, h: 1 }, styleSetSlots: [] },
  { id: 'mounting_block', name: 'Mounting Block', category: 'prop', tags: ['street'],
    color: '#8C867A', footprint: { w: 1, h: 1 }, styleSetSlots: [] },
  { id: 'beehive', name: 'Beehive', category: 'prop', tags: ['garden'],
    color: '#C0A86A', footprint: { w: 1, h: 1 }, styleSetSlots: [] },
  { id: 'hedge', name: 'Hedge', category: 'prop', tags: ['garden', 'barrier'],
    color: '#4E6B3A', footprint: { w: 2, h: 1 }, styleSetSlots: [] },
  { id: 'haystack', name: 'Haystack', category: 'prop', tags: ['farm'],
    color: '#C6A954', footprint: { w: 2, h: 2 }, styleSetSlots: [] },
  { id: 'tent', name: 'Tent', category: 'prop', tags: ['market'],
    color: '#B0654A', footprint: { w: 2, h: 2 }, styleSetSlots: [] },
  { id: 'milestone', name: 'Milestone', category: 'prop', tags: ['street'],
    color: '#928C80', footprint: { w: 1, h: 1 }, styleSetSlots: [] },
  { id: 'pavilion', name: 'Garden Pavilion', category: 'prop', tags: ['garden'],
    color: '#A8A090', footprint: { w: 2, h: 2 }, styleSetSlots: [] },
  { id: 'well_grand', name: 'Grand Well', category: 'prop', tags: ['civic'],
    color: '#8A8478', footprint: { w: 2, h: 2 }, styleSetSlots: [] },
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
  // === REVERSE GHOSTS: geometry that existed and could never be placed ===
  //
  // PropFactory draws twenty ids the store never defined, so the art was
  // unreachable — the mirror image of the usual ghost, and invisible to
  // tools/features.mjs, which censuses gates rather than definitions. These
  // are the ones the waterfront needs: `rowboat` and `skiff` share the boat
  // builder with fishing_boat, `boulder` / `rock` / `rocky_outcrop` share the
  // stone builder, `port_crane` shares the crane. Registering them costs six
  // definitions and buys a whole river vocabulary that was already modelled.
  // Assets the QUAY WALL made possible. A hard vertical edge is a thing you
  // can cut steps into and bolt rings to; a graded mud bank is not, which is
  // why neither of these existed while every riverbank was a slope.
  // Three more reverse ghosts, and only three: of the fourteen prop geometries
  // the store never defined, most turned out to be ALIASES sharing a builder
  // with an id that is already defined — `hedge` draws a bush, `stone_bridge`
  // and `arched_bridge` are the existing bridge, `milestone` is a road_marker,
  // `picket_fence` is a fence, `haystack` is a hay_bale. Only these three have
  // a builder that actually branches on the id, so only these three are art
  // the town does not already have. Checking which is which took one grep and
  // it turned "a whole round of free content" into an honest three.
  {
    id: 'market_tent',
    name: 'Market Tent',
    category: 'prop',
    tags: ['commercial', 'market'],
    color: '#B0623A',
    footprint: { w: 2, h: 2 },
    styleSetSlots: []
  },
  {
    id: 'fountain_grand',
    name: 'Grand Fountain',
    category: 'prop',
    tags: ['civic', 'landmark'],
    color: '#9AA0A4',
    footprint: { w: 3, h: 3 },
    styleSetSlots: []
  },
  {
    id: 'standing_stone',
    name: 'Standing Stone',
    category: 'prop',
    tags: ['natural', 'landmark'],
    color: '#7E7A72',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'water_steps',
    name: 'Water Steps',
    category: 'infrastructure',
    tags: ['water', 'passage'],
    color: '#9A948A',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'mooring_ring',
    name: 'Mooring Ring',
    category: 'prop',
    tags: ['water', 'harbor'],
    color: '#6E6862',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'rowboat',
    name: 'Rowboat',
    category: 'prop',
    tags: ['water', 'vessel'],
    color: '#7A6244',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'skiff',
    name: 'Skiff',
    category: 'prop',
    tags: ['water', 'vessel'],
    color: '#846A48',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'boulder',
    name: 'Boulder',
    category: 'prop',
    tags: ['natural', 'stone'],
    color: '#8A8580',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'rock',
    name: 'Rock',
    category: 'prop',
    tags: ['natural', 'stone'],
    color: '#938E86',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'rocky_outcrop',
    name: 'Rocky Outcrop',
    category: 'prop',
    tags: ['natural', 'stone'],
    color: '#807A72',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'port_crane',
    name: 'Port Crane',
    category: 'infrastructure',
    tags: ['water', 'trade'],
    color: '#6A5A44',
    footprint: { w: 2, h: 2 },
    styleSetSlots: []
  },
  // Reeds are the one thing a river bank needs that nothing in the vocabulary
  // could stand in for. Everything natural here is a tree, a bush or a stone,
  // and none of them says "waterline".
  {
    id: 'reeds',
    name: 'Reeds',
    category: 'prop',
    tags: ['natural', 'water'],
    color: '#6E7A46',
    footprint: { w: 1, h: 1 },
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
  {
    id: 'cathedral',
    name: 'Cathedral',
    category: 'building',
    tags: ['structure', 'landmark', 'religious'],
    color: '#C8B898',
    footprint: { w: 5, h: 6 },
    styleSetSlots: ['wall', 'roof']
  },
  {
    id: 'lighthouse',
    name: 'Lighthouse',
    category: 'building',
    tags: ['structure', 'landmark', 'harbor'],
    color: '#E8E0D0',
    footprint: { w: 3, h: 3 },
    styleSetSlots: ['wall', 'roof']
  },
  {
    id: 'round_tower',
    name: 'Round Tower',
    category: 'building',
    tags: ['structure', 'fortification'],
    color: '#8A8A80',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof']
  },
  {
    id: 'gatehouse',
    name: 'Gatehouse',
    category: 'building',
    tags: ['structure', 'fortification', 'landmark'],
    color: '#8A8A80',
    footprint: { w: 4, h: 2 },
    styleSetSlots: ['wall', 'roof']
  },
  {
    id: 'stable',
    name: 'Stable',
    category: 'building',
    tags: ['structure', 'functional'],
    color: '#8A7050',
    footprint: { w: 4, h: 3 },
    styleSetSlots: ['wall', 'roof']
  },
  {
    id: 'mill',
    name: 'Mill',
    category: 'building',
    tags: ['structure', 'functional', 'waterfront'],
    color: '#A09070',
    footprint: { w: 3, h: 3 },
    styleSetSlots: ['wall', 'roof']
  },
  {
    id: 'bell_tower_tall',
    name: 'Bell Tower',
    category: 'building',
    tags: ['structure', 'landmark', 'religious'],
    color: '#C8B898',
    footprint: { w: 2, h: 2 },
    styleSetSlots: ['wall', 'roof']
  },
  {
    id: 'aqueduct',
    name: 'Aqueduct',
    category: 'infrastructure',
    tags: ['structure', 'landmark'],
    color: '#8A8A80',
    footprint: { w: 5, h: 1 },
    styleSetSlots: ['wall']
  },

  // === DISTRICT-SIGNATURE DRESSING ===
  // These are placed by TownGenerator and rendered by Prop/BuildingFactory,
  // but had no ObjectDefinition — so BuildingFactory dropped them entirely
  // (`if (!def) continue`) and PropFactory fell back to a 1x1 footprint,
  // mis-sizing and mis-centering every multi-tile one. Footprints here match
  // TownGenerator.getFootprint so placement, alley carving and rendering all
  // agree.
  {
    id: 'stone_wall_v',
    name: 'Stone Wall (Vertical)',
    category: 'infrastructure',
    tags: ['barrier', 'fortification'],
    color: '#707068',
    footprint: { w: 1, h: 2 },
    styleSetSlots: []
  },
  {
    id: 'crenellated_wall',
    name: 'Crenellated Wall',
    category: 'infrastructure',
    tags: ['barrier', 'fortification'],
    color: '#787268',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'trellis_arch',
    name: 'Trellis Arch',
    category: 'vegetation',
    tags: ['decoration', 'nature'],
    color: '#4A7A3A',
    footprint: { w: 1, h: 2 },
    styleSetSlots: []
  },
  {
    id: 'flower_bed',
    name: 'Flower Bed',
    category: 'vegetation',
    tags: ['nature', 'decoration'],
    color: '#7A9A4A',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'fish_rack',
    name: 'Fish Drying Rack',
    category: 'prop',
    tags: ['harbor', 'trade'],
    color: '#8A7A58',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'prayer_flags',
    name: 'Prayer Flags',
    category: 'prop',
    tags: ['decoration', 'religious'],
    color: '#C05050',
    footprint: { w: 2, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'rope_coil',
    name: 'Rope Coil',
    category: 'prop',
    tags: ['harbor'],
    color: '#A89060',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'forge_brazier',
    name: 'Forge Brazier',
    category: 'prop',
    tags: ['light', 'artisan'],
    color: '#8A4A28',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'bunting_pole',
    name: 'Bunting Pole',
    category: 'prop',
    tags: ['decoration', 'festive'],
    color: '#C0A050',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'heraldic_banner',
    name: 'Heraldic Banner',
    category: 'prop',
    tags: ['decoration', 'noble'],
    color: '#8A3040',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'cemetery_cross',
    name: 'Cemetery Cross',
    category: 'prop',
    tags: ['cemetery', 'decoration'],
    color: '#9A9A90',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
  {
    id: 'rubble_pile',
    name: 'Rubble Pile',
    category: 'prop',
    tags: ['debris'],
    color: '#7A7268',
    footprint: { w: 1, h: 1 },
    styleSetSlots: []
  },
]

// === STORE ===

interface AppState {
  // App mode
  appMode: AppMode

  // Landscape: 2D editor vs 3D walkthrough (toolbar-owned so it's discoverable)
  view3D: boolean

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
  setView3D: (v: boolean) => void

  // Map operations
  setMap: (map: MapDocument) => void
  /**
   * The seed the world on screen was grown from. Lives here rather than in
   * GenerationPanel's local state so the panel and the starter world cannot
   * disagree about what you are looking at — the panel prints "Last seed" and
   * a boot-time generate would otherwise leave that blank under a full town.
   */
  worldSeed: number
  setWorldSeed: (seed: number) => void
  /**
   * Grow a town if there is not one yet. The app booted onto an EMPTY 32x32
   * grid, which on a desktop is a blank canvas you can read as an invitation
   * and on a phone is just a grey screen — you have to find the Build tab,
   * pull up a sheet and press Generate before the app does anything at all.
   * Idempotent: it only fires when the structure layer is empty, so it can
   * never overwrite a map you loaded or edited.
   */
  ensureStarterWorld: () => void
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
  view3D: false,
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
    outputWidth: 640,
    outputHeight: 480,
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
  setView3D: (v) => set({ view3D: v }),

  worldSeed: Math.floor(Math.random() * 99999),
  setWorldSeed: (seed) => set({ worldSeed: seed }),

  ensureStarterWorld: () => {
    const st = get()
    const built = st.map.layers.find((l) => l.type === 'structure')?.objects.length ?? 0
    if (built > 0) return
    try {
      const gen = getGenerator('town')
      if (!gen) return
      const seed = st.worldSeed
      st.setMap(gen.generate({
        mapType: 'town', seed, width: 48, height: 48,
        complexity: 0.5, density: 0.5,
        assetFrequencies: {}, levelCount: 1, customParams: {},
      }))
    } catch (e) {
      // Never let a generator failure stop the app from opening. Logged, not
      // swallowed — a generation failure that went only into a UI state
      // variable cost two sessions once already.
      console.error('[ensureStarterWorld] failed:', e)
    }
  },

  // Map operations
  setMap: (map) => {
    // Auto-center camera on new map
    const cx = map.gridWidth / 2
    const cy = map.gridHeight / 2
    const mapSize = Math.max(map.gridWidth, map.gridHeight)
    const elevation = Math.max(3, mapSize * 0.2)
    const fov = 48
    const halfFov = (fov * Math.PI / 180) / 2
    const framingDist = (mapSize * 0.6) / Math.tan(halfFov)
    const dist = Math.max(mapSize * 0.3, Math.min(mapSize * 1.5, framingDist))
    const angle = -Math.PI * 0.75
    const hDist = Math.sqrt(Math.max(0, dist * dist - elevation * elevation)) || dist * 0.5
    set({
      map, dirty: true,
      renderCamera: {
        ...get().renderCamera,
        worldX: Math.round((cx + Math.cos(angle) * hDist) * 2) / 2,
        worldY: Math.round((cy + Math.sin(angle) * hDist) * 2) / 2,
        lookAtX: cx,
        lookAtY: cy,
        elevation,
        fov,
      }
    })
  },
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
