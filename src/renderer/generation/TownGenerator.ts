import { v4 as uuid } from 'uuid'
import type { MapDocument, MapLayer, PlacedObject, GenerationConfig, EnvironmentState } from '../core/types'
import type { IMapGenerator } from './GeneratorRegistry'
import { createRNG, SimplexNoise, poissonDiskSampling, nearestPoint, perturbedDistance } from './noise'

// === District System ===

type DistrictType = 'market' | 'residential' | 'artisan' | 'noble' | 'waterfront' | 'temple' | 'slum' | 'garden' | 'harbor' | 'fortress' | 'cemetery'

interface District {
  id: number
  type: DistrictType
  center: { x: number; y: number }
  radius: number
  buildingDensity: number
  propDensity: number
}

// District-specific building weights
const DISTRICT_BUILDINGS: Record<DistrictType, { id: string; w: number; h: number; weight: number }[]> = {
  market: [
    { id: 'shop', w: 2, h: 3, weight: 6 },
    { id: 'corner_building', w: 2, h: 2, weight: 4 },
    { id: 'bakery', w: 2, h: 2, weight: 4 },
    { id: 'row_house', w: 1, h: 2, weight: 3 },
    { id: 'tavern', w: 4, h: 3, weight: 2 },
    { id: 'covered_market', w: 4, h: 3, weight: 2 },
    { id: 'building_small', w: 2, h: 2, weight: 2 },
    { id: 'apothecary', w: 2, h: 3, weight: 2 },
    { id: 'inn', w: 3, h: 3, weight: 1 },
    { id: 'archway', w: 3, h: 1, weight: 1 },
  ],
  residential: [
    { id: 'building_small', w: 2, h: 2, weight: 5 },
    { id: 'row_house', w: 1, h: 2, weight: 5 },
    { id: 'half_timber', w: 3, h: 2, weight: 4 },
    { id: 'building_medium', w: 3, h: 3, weight: 3 },
    { id: 'balcony_house', w: 3, h: 2, weight: 3 },
    { id: 'narrow_house', w: 1, h: 3, weight: 3 },
    { id: 'bakery', w: 2, h: 2, weight: 2 },
    { id: 'building_large', w: 4, h: 3, weight: 1 },
    { id: 'stable', w: 4, h: 3, weight: 4 },
  ],
  artisan: [
    { id: 'shop', w: 2, h: 3, weight: 5 },
    { id: 'building_small', w: 2, h: 2, weight: 4 },
    { id: 'row_house', w: 1, h: 2, weight: 4 },
    { id: 'warehouse', w: 4, h: 3, weight: 3 },
    { id: 'corner_building', w: 2, h: 2, weight: 2 },
    { id: 'half_timber', w: 3, h: 2, weight: 2 },
    { id: 'apothecary', w: 2, h: 3, weight: 1 },
    { id: 'staircase', w: 2, h: 3, weight: 1 },
  ],
  noble: [
    { id: 'mansion', w: 5, h: 4, weight: 5 },
    { id: 'building_large', w: 4, h: 3, weight: 4 },
    { id: 'building_medium', w: 3, h: 3, weight: 3 },
    { id: 'balcony_house', w: 3, h: 2, weight: 3 },
    { id: 'guild_hall', w: 4, h: 4, weight: 2 },
    { id: 'tower', w: 2, h: 2, weight: 2 },
    { id: 'archway', w: 3, h: 1, weight: 1 },
    { id: 'stable', w: 4, h: 3, weight: 1 },
  ],
  waterfront: [
    { id: 'building_small', w: 2, h: 2, weight: 4 },
    { id: 'shop', w: 2, h: 3, weight: 4 },
    { id: 'warehouse', w: 4, h: 3, weight: 3 },
    { id: 'row_house', w: 1, h: 2, weight: 3 },
    { id: 'building_medium', w: 3, h: 3, weight: 2 },
    { id: 'tavern', w: 4, h: 3, weight: 2 },
    { id: 'inn', w: 3, h: 3, weight: 2 },
    { id: 'half_timber', w: 3, h: 2, weight: 1 },
    { id: 'mill', w: 3, h: 3, weight: 6 },
  ],
  temple: [
    { id: 'chapel', w: 3, h: 4, weight: 5 },
    { id: 'tower', w: 2, h: 2, weight: 4 },
    { id: 'bell_tower', w: 2, h: 2, weight: 3 },
    { id: 'building_large', w: 4, h: 3, weight: 3 },
    { id: 'temple', w: 5, h: 5, weight: 2 },
    { id: 'archway', w: 3, h: 1, weight: 2 },
    { id: 'staircase', w: 2, h: 3, weight: 2 },
    { id: 'cathedral', w: 5, h: 6, weight: 6 },
    { id: 'bell_tower_tall', w: 2, h: 2, weight: 7 },
  ],
  slum: [
    { id: 'row_house', w: 1, h: 2, weight: 8 },
    { id: 'narrow_house', w: 1, h: 3, weight: 5 },
    { id: 'building_small', w: 2, h: 2, weight: 5 },
    { id: 'corner_building', w: 2, h: 2, weight: 2 },
    { id: 'shop', w: 2, h: 3, weight: 1 },
  ],
  garden: [
    { id: 'balcony_house', w: 3, h: 2, weight: 4 },
    { id: 'mansion', w: 5, h: 4, weight: 3 },
    { id: 'building_medium', w: 3, h: 3, weight: 3 },
    { id: 'half_timber', w: 3, h: 2, weight: 3 },
    { id: 'building_small', w: 2, h: 2, weight: 2 },
    { id: 'building_large', w: 4, h: 3, weight: 1 },
  ],
  harbor: [
    { id: 'warehouse', w: 4, h: 3, weight: 8 },
    { id: 'shop', w: 2, h: 3, weight: 4 },
    { id: 'tavern', w: 4, h: 3, weight: 3 },
    { id: 'row_house', w: 1, h: 2, weight: 3 },
    { id: 'inn', w: 3, h: 3, weight: 2 },
    { id: 'building_small', w: 2, h: 2, weight: 2 },
    { id: 'lighthouse', w: 3, h: 3, weight: 4 },
    { id: 'mill', w: 3, h: 3, weight: 5 },
  ],
  fortress: [
    { id: 'watchtower', w: 2, h: 2, weight: 6 },
    { id: 'tower', w: 2, h: 2, weight: 5 },
    { id: 'town_gate', w: 3, h: 1, weight: 3 },
    { id: 'warehouse', w: 4, h: 3, weight: 2 },
    { id: 'building_small', w: 2, h: 2, weight: 2 },
    { id: 'round_tower', w: 2, h: 2, weight: 10 },
    { id: 'gatehouse', w: 4, h: 2, weight: 5 },
  ],
  cemetery: [
    { id: 'chapel', w: 3, h: 4, weight: 5 },
    { id: 'tower', w: 2, h: 2, weight: 2 },
  ],
}

// District-specific prop palettes
const DISTRICT_PROPS: Record<DistrictType, string[]> = {
  market: ['market_stall', 'crate', 'crate_stack', 'barrel', 'hanging_sign', 'wagon', 'sign', 'cafe_table', 'cart', 'hay_bale'],
  residential: ['potted_plant', 'bench', 'well', 'fence', 'planter_box', 'flower_box', 'cloth_line', 'rain_barrel', 'woodpile'],
  artisan: ['barrel', 'crate', 'barrel_stack', 'sign', 'fence', 'crate_stack', 'woodpile', 'cart', 'rain_barrel'],
  noble: ['potted_plant', 'planter_box', 'bench', 'statue', 'fountain', 'wall_lantern', 'column', 'monument', 'garden_arch', 'flower_box'],
  waterfront: ['barrel', 'crate', 'wagon', 'sign', 'bench', 'crate_stack', 'horse_post', 'rain_barrel'],
  temple: ['statue', 'potted_plant', 'stone_wall', 'wall_lantern', 'column', 'monument', 'garden_arch'],
  slum: ['barrel', 'crate', 'barrel_stack', 'woodpile', 'rain_barrel'],
  garden: ['potted_plant', 'planter_box', 'bench', 'fountain', 'bush', 'tree', 'flower_box', 'garden_arch'],
  harbor: ['barrel', 'crate', 'crate_stack', 'wagon', 'horse_post', 'dock', 'crane', 'fishing_boat', 'rain_barrel'],
  fortress: ['stone_wall', 'barrel', 'crate', 'wall_lantern', 'iron_fence'],
  cemetery: ['gravestone', 'iron_fence', 'potted_plant', 'tree', 'wall_lantern', 'bench'],
}

// District density multipliers
const DISTRICT_DENSITY: Record<DistrictType, number> = {
  market: 1.1, residential: 0.9, artisan: 1.0, noble: 0.7,
  waterfront: 0.8, temple: 0.6, slum: 1.3, garden: 0.4,
  harbor: 0.9, fortress: 0.5, cemetery: 0.3,
}

// District elevation bias — temples and nobles on the heights, waterfront at sea level
// Applied as a modifier to the height map during building placement
const DISTRICT_ELEVATION_BIAS: Record<DistrictType, number> = {
  temple: 0.8,     // acropolis — always seek the high ground
  noble: 0.5,      // elevated mansions overlooking the town
  garden: 0.3,     // hillside gardens with views
  residential: 0,  // neutral
  artisan: -0.1,   // slightly lower, workshop districts
  market: -0.2,    // accessible center, ground level
  waterfront: -0.4, // down by the water
  slum: -0.3,      // low-lying areas
  harbor: -0.5, fortress: 0.6, cemetery: 0.2,
}


export class TownGenerator implements IMapGenerator {
  readonly type = 'town'
  readonly displayName = 'Town'
  readonly description = 'Generates an organic town with districts, winding streets, plazas, and dense buildings'

  generate(config: GenerationConfig): MapDocument {
    const { width, height, seed, complexity, density } = config
    const rng = createRNG(seed)
    const noise = new SimplexNoise(seed)

    // 1. Height map
    const heightMap = this.generateHeightMap(width, height, noise)

    // 2. Base terrain
    const terrainTiles = this.generateBaseTerrain(width, height, noise)

    // 3. Water channels as natural district dividers
    const waterMap = this.generateWaterChannels(width, height, noise, rng, complexity)
    this.paintWater(terrainTiles, waterMap, width, height, noise)

    // 3b. Natural ponds in low-lying areas (organic water bodies)
    this.generateNaturalPonds(width, height, heightMap, waterMap, terrainTiles, noise, rng)

    // 4. District system (Voronoi-based)
    const districts = this.generateDistricts(width, height, complexity, rng, noise, waterMap)
    const districtMap = this.assignDistrictMap(width, height, districts, noise)

    // 5. Paint district-specific terrain
    this.paintDistrictTerrain(terrainTiles, districtMap, districts, width, height, noise, waterMap)

    // 6. Central plaza + district plazas (sized for 3D walkability)
    const mainCenter = districts.length > 0 ? districts[0].center : { x: Math.floor(width / 2), y: Math.floor(height / 2) }
    const plazaRadius = Math.floor(4 + complexity * 4) // larger main plaza
    this.carvePlaza(terrainTiles, mainCenter.x, mainCenter.y, plazaRadius, width, height, 2)

    for (let i = 1; i < districts.length; i++) {
      // District plazas: larger for noble/temple/market, smaller for residential
      const d = districts[i]
      const dPlazaR = d.type === 'temple' || d.type === 'noble' ? Math.floor(4 + complexity * 2)
        : d.type === 'market' || d.type === 'garden' ? Math.floor(3 + complexity * 2)
        : Math.floor(2 + complexity * 1.5)
      this.carvePlaza(terrainTiles, d.center.x, d.center.y, dPlazaR, width, height, 8)
    }

    // 7. Street hierarchy
    const roadMap = this.generateStreetNetwork(
      width, height, mainCenter, districts, complexity, density, rng, noise, terrainTiles, waterMap
    )

    // 8. Place bridges over water where roads cross
    const bridges = this.placeBridges(width, height, roadMap, waterMap, rng)

    // 9. Place buildings with district awareness
    const buildings = this.placeBuildings(
      width, height, roadMap, waterMap, heightMap, districtMap, districts,
      complexity, density, rng, mainCenter, terrainTiles, noise
    )

    // 10. Place landmarks
    const landmarks = this.placeLandmarks(
      width, height, roadMap, waterMap, districts, districtMap, buildings, heightMap,
      complexity, rng, mainCenter
    )

    // 10b. Hidden passages & garden courtyards (Parisian passages + Kyoto tsuboniwa)
    const hiddenCourtyards = this.carveHiddenPassages(
      terrainTiles, roadMap, waterMap, heightMap,
      [...buildings, ...landmarks], districtMap, districts,
      width, height, rng, noise
    )

    // 11. Carve alleys between building clusters
    this.carveAlleys(terrainTiles, [...buildings, ...landmarks], width, height)

    // 12. Place town gates at map edges where roads exit
    const gates = this.placeGates(width, height, roadMap, rng)

    // 12b. Town walls around perimeter
    const townWalls = this.placeWalls(width, height, roadMap, waterMap, [...buildings, ...landmarks], gates, rng)

    // 12c. Grand courtyards — intentional enclosed spaces with symmetry
    const courtyardProps = this.generateGrandCourtyards(
      terrainTiles, roadMap, waterMap, heightMap,
      [...buildings, ...landmarks, ...gates, ...townWalls],
      districtMap, districts, width, height, rng, noise
    )

    // 13. Contextual props per district
    const props = this.placeProps(
      width, height, roadMap, waterMap, [...buildings, ...landmarks, ...gates],
      districtMap, districts, density, config.assetFrequencies, rng, mainCenter
    )

    // 14. Lampposts along all streets
    const lights = this.placeLights(width, height, roadMap, [...buildings, ...landmarks, ...gates, ...props], rng, density)

    // 15. Plaza features (fountain, market stalls, statues)
    const plazaProps = this.placePlazaFeatures(
      width, height, mainCenter, plazaRadius, districts,
      [...buildings, ...landmarks, ...gates, ...props, ...lights], density, rng,
      roadMap, waterMap,
    )

    // 16. Vegetation with district awareness + species variety
    const vegetation = this.placeVegetation(
      width, height, roadMap, waterMap,
      [...buildings, ...landmarks, ...gates, ...props, ...lights, ...plazaProps],
      districtMap, districts, density, rng, noise, heightMap
    )

    // 16b. Private gardens behind buildings
    const gardens = this.plantPrivateGardens(
      width, height, roadMap, waterMap, heightMap,
      [...buildings, ...landmarks], districtMap, districts,
      [...props, ...lights, ...plazaProps, ...vegetation],
      terrainTiles, rng, noise
    )

    // 16c. Organic terrain features (rocky outcrops, wildflower meadows)
    this.paintOrganicTerrain(terrainTiles, heightMap, waterMap, roadMap, districtMap, districts,
      width, height, noise, rng)

    // Build layers
    // 17. Countryside beyond walls
    const countrysideProps = this.placeCountryside(
      width, height, roadMap, waterMap, districtMap, terrainTiles,
      [...buildings, ...landmarks, ...gates, ...bridges, ...townWalls], gates, noise, rng
    )

    const allStructures = [...buildings, ...landmarks, ...gates, ...bridges, ...townWalls]
    const allProps = [...props, ...lights, ...plazaProps, ...vegetation, ...hiddenCourtyards, ...gardens, ...courtyardProps, ...countrysideProps]

    const terrainLayer: MapLayer = {
      id: uuid(), name: 'Terrain', type: 'terrain',
      visible: true, locked: false, objects: [], terrainTiles
    }
    const structureLayer: MapLayer = {
      id: uuid(), name: 'Structures', type: 'structure',
      visible: true, locked: false, objects: allStructures
    }
    const propLayer: MapLayer = {
      id: uuid(), name: 'Props', type: 'prop',
      visible: true, locked: false, objects: allProps
    }

    const env: EnvironmentState = {
      timeOfDay: 12, weather: 'clear', weatherIntensity: 0,
      celestial: { moonPhase: 0.5, starDensity: 0.5, sunAngle: 45 },
      lighting: {
        ambientColor: '#ffffff', ambientIntensity: 0.6,
        directionalAngle: 45, directionalIntensity: 0.8
      }
    }

    return {
      id: uuid(),
      name: `Town (seed: ${seed})`,
      version: 1,
      gridWidth: width,
      gridHeight: height,
      tileSize: 32,
      layers: [terrainLayer, structureLayer, propLayer],
      environment: env,
      cameras: [],
      generationConfig: config
    }
  }


  // === HEIGHT MAP ===
  // Piranesi-inspired dramatic terrain: clear plateaus, steep drops, terraced ridges
  private generateHeightMap(w: number, h: number, noise: SimplexNoise): number[][] {
    const map: number[][] = []
    for (let y = 0; y < h; y++) {
      const row: number[] = []
      for (let x = 0; x < w; x++) {
        // Base terrain with two octaves for natural ridgelines
        const n1 = noise.fbm(x * 0.03, y * 0.03, 2, 2, 0.5)
        const n2 = noise.fbm(x * 0.06 + 50, y * 0.06 + 50, 2, 2, 0.5)
        const raw = (n1 * 0.7 + n2 * 0.3 + 0.5) * 2.0

        // Terrace quantization — snap to plateaus for dramatic stepping
        // Creates 0, 0.5, 1.0, 1.5, 2.0 elevation bands
        const terraced = Math.round(raw * 2) / 2

        // Smooth edges slightly so transitions aren't too harsh
        const blend = terraced * 0.7 + raw * 0.3
        row.push(Math.max(0, Math.min(blend, 2.5)))
      }
      map.push(row)
    }
    return map
  }

  // === BASE TERRAIN ===
  private generateBaseTerrain(w: number, h: number, noise: SimplexNoise): number[][] {
    const tiles: number[][] = []
    for (let y = 0; y < h; y++) {
      const row: number[] = []
      for (let x = 0; x < w; x++) {
        // Two noise octaves for more natural terrain variation
        const n1 = noise.fbm(x * 0.06, y * 0.06, 3)
        const n2 = noise.fbm(x * 0.12 + 100, y * 0.12 + 100, 2)
        const n = n1 * 0.7 + n2 * 0.3
        if (n < -0.3) row.push(5)        // dark grass (meadow patches)
        else if (n < -0.05) row.push(0)  // grass
        else if (n < 0.15) row.push(n2 > 0 ? 0 : 5) // mixed grass patches
        else if (n < 0.35) row.push(1)   // dirt
        else row.push(0)                 // grass
      }
      tiles.push(row)
    }
    return tiles
  }

  // === WATER CHANNELS ===
  private generateWaterChannels(
    w: number, h: number, noise: SimplexNoise, rng: () => number, complexity: number
  ): boolean[][] {
    const waterMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    const numChannels = complexity > 0.3 ? Math.floor(1 + complexity) : 0
    if (numChannels === 0) return waterMap

    for (let c = 0; c < numChannels; c++) {
      // Start from an edge
      const horizontal = rng() > 0.5
      let x: number, y: number
      if (horizontal) {
        x = 0
        y = Math.floor(h * 0.25 + rng() * h * 0.5)
      } else {
        x = Math.floor(w * 0.25 + rng() * w * 0.5)
        y = 0
      }

      const channelWidth = 2 + Math.floor(rng() * 2)
      let dir = horizontal ? 0 : Math.PI / 2

      for (let step = 0; step < Math.max(w, h) * 1.5; step++) {
        for (let cw = 0; cw < channelWidth; cw++) {
          const perpX = horizontal ? 0 : cw
          const perpY = horizontal ? cw : 0
          const wx = Math.floor(x) + perpX
          const wy = Math.floor(y) + perpY
          if (wx >= 0 && wx < w && wy >= 0 && wy < h) {
            waterMap[wy][wx] = true
          }
        }

        // Meander with noise
        dir += noise.noise2D(x * 0.08, y * 0.08) * 0.2
        if (horizontal) {
          dir = Math.max(-0.4, Math.min(0.4, dir))
          x += 1
          y += Math.sin(dir) * 0.8
        } else {
          dir = Math.max(Math.PI / 2 - 0.4, Math.min(Math.PI / 2 + 0.4, dir))
          x += Math.cos(dir) * 0.8
          y += 1
        }

        if (x < -1 || x >= w + 1 || y < -1 || y >= h + 1) break
      }
    }
    return waterMap
  }

  private paintWater(terrain: number[][], waterMap: boolean[][], w: number, h: number, noise: SimplexNoise): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (waterMap[y][x]) {
          terrain[y][x] = 3 // water
        } else {
          // Sand along water edges
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const nx = x + dx, ny = y + dy
              if (nx >= 0 && nx < w && ny >= 0 && ny < h && waterMap[ny][nx]) {
                const dist = Math.abs(dx) + Math.abs(dy)
                if (dist <= 2 && !waterMap[y][x]) {
                  if (dist === 1) terrain[y][x] = 4 // sand right next to water
                  else if (terrain[y][x] === 0) terrain[y][x] = 1 // dirt near water
                }
              }
            }
          }
        }
      }
    }
  }


  // === DISTRICT GENERATION ===
  private generateDistricts(
    w: number, h: number, complexity: number, rng: () => number,
    noise: SimplexNoise, waterMap: boolean[][]
  ): District[] {
    const numDistricts = Math.max(3, Math.floor(4 + complexity * 5))
    const districtTypes: DistrictType[] = [
      'market', 'residential', 'artisan', 'noble', 'waterfront', 'temple', 'slum', 'garden',
      'harbor', 'fortress', 'cemetery'
    ]

    // Use Poisson disk for spread-out district centers
    const minDist = Math.max(6, Math.floor(Math.min(w, h) / (numDistricts * 0.6)))
    const candidates = poissonDiskSampling(w - 4, h - 4, minDist, rng)
      .map(p => ({ x: Math.floor(p.x) + 2, y: Math.floor(p.y) + 2 }))
      .filter(p => !waterMap[p.y]?.[p.x]) // Don't place centers in water

    const districts: District[] = []
    const usedTypes = new Set<DistrictType>()

    // First district is always market (town center, closest to map center)
    const mapCx = w / 2, mapCy = h / 2
    candidates.sort((a, b) => {
      const da = (a.x - mapCx) ** 2 + (a.y - mapCy) ** 2
      const db = (b.x - mapCx) ** 2 + (b.y - mapCy) ** 2
      return da - db
    })

    for (let i = 0; i < Math.min(numDistricts, candidates.length); i++) {
      let type: DistrictType
      if (i === 0) {
        type = 'market'
      } else {
        // Check if near water -> waterfront
        const isNearWater = this.hasNearbyWater(candidates[i].x, candidates[i].y, waterMap, w, h, 6)
        if (isNearWater && !usedTypes.has('waterfront')) {
          type = 'waterfront'
        } else {
          // Pick a type that hasn't been used yet, with preference
          const available = districtTypes.filter(t => !usedTypes.has(t) || t === 'residential')
          type = available[Math.floor(rng() * available.length)]
        }
      }

      usedTypes.add(type)
      const baseDensity = DISTRICT_DENSITY[type]

      districts.push({
        id: i,
        type,
        center: candidates[i],
        radius: Math.floor(6 + rng() * 4 + complexity * 3),
        buildingDensity: baseDensity * (0.8 + rng() * 0.4),
        propDensity: baseDensity * (0.7 + rng() * 0.6),
      })
    }

    return districts
  }

  private hasNearbyWater(x: number, y: number, waterMap: boolean[][], w: number, h: number, radius: number): boolean {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && waterMap[ny][nx]) return true
      }
    }
    return false
  }

  private assignDistrictMap(w: number, h: number, districts: District[], noise: SimplexNoise): number[][] {
    const map: number[][] = []
    for (let y = 0; y < h; y++) {
      const row: number[] = []
      for (let x = 0; x < w; x++) {
        if (districts.length === 0) {
          row.push(-1)
          continue
        }
        // Noise-perturbed nearest district
        let bestDist = Infinity
        let bestId = 0
        for (const d of districts) {
          const dist = perturbedDistance(x, y, d.center.x, d.center.y, noise, 0.08, 4)
          if (dist < bestDist) {
            bestDist = dist
            bestId = d.id
          }
        }
        row.push(bestId)
      }
      map.push(row)
    }
    return map
  }

  // === DISTRICT TERRAIN PAINTING ===
  private paintDistrictTerrain(
    terrain: number[][], districtMap: number[][], districts: District[],
    w: number, h: number, noise: SimplexNoise, waterMap: boolean[][]
  ): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (waterMap[y][x]) continue // Don't overwrite water
        const dId = districtMap[y][x]
        const d = districts.find(dd => dd.id === dId)
        if (!d) continue
        const n = noise.noise2D(x * 0.15, y * 0.15)

        // Second noise layer for terrain variety within districts
        const n2 = noise.noise2D(x * 0.25 + 50, y * 0.25 + 50)

        switch (d.type) {
          case 'noble':
            if (n > 0.3) terrain[y][x] = 2 // stone paths
            else if (n > 0.1) terrain[y][x] = n2 > 0 ? 2 : 0 // stone/grass mix
            else terrain[y][x] = 0 // grass courtyards
            break
          case 'garden':
            if (n > 0.4) terrain[y][x] = 5 // dark grass
            else if (n > 0.1) terrain[y][x] = n2 > 0.3 ? 5 : 0 // varied green
            else terrain[y][x] = 0 // grass
            break
          case 'waterfront':
            if (n > 0.2) terrain[y][x] = 4 // sand
            else if (n > -0.1) terrain[y][x] = n2 > 0 ? 4 : 1 // sand/dirt mix
            else terrain[y][x] = 1 // dirt
            break
          case 'slum':
            if (n > 0.1) terrain[y][x] = 1 // dirt
            else if (n > -0.2) terrain[y][x] = n2 > 0 ? 1 : 5 // dirt/dark grass
            else terrain[y][x] = 5 // dark grass
            break
          case 'temple':
            if (n > 0.2) terrain[y][x] = 2 // stone
            else if (n > -0.1) terrain[y][x] = n2 > 0.2 ? 2 : 0 // stone accents
            break
          case 'market':
            // Cobblestone base with stone accents
            if (n > 0.15) terrain[y][x] = 8 // cobblestone
            else if (n > -0.1) terrain[y][x] = n2 > 0 ? 9 : 8 // dark/light cobble
            break
          case 'artisan':
            // Dirt workshop yards
            if (n > 0.0) terrain[y][x] = 1 // dirt
            else if (n > -0.2) terrain[y][x] = n2 > 0 ? 1 : 0 // dirt/grass
            break
          case 'residential':
            // Grass with occasional dirt strips
            if (n > 0.25 && n2 > 0) terrain[y][x] = 1 // dirt paths
            break
          case 'harbor':
            if (n > 0.1) terrain[y][x] = 8 // cobblestone
            else if (n > -0.15) terrain[y][x] = n2 > 0 ? 4 : 8 // sand/cobble mix
            else terrain[y][x] = 4 // sand
            break
          case 'fortress':
            if (n > -0.1) terrain[y][x] = 2 // stone primarily
            else terrain[y][x] = n2 > 0 ? 2 : 1 // stone/dirt
            break
          case 'cemetery':
            if (n > 0.2) terrain[y][x] = 2 // stone paths
            else terrain[y][x] = 5 // dark grass
            break
        }
      }
    }
  }


  // === PLAZA ===
  // Golden ratio proportions (phi ~= 1.618) with organic asymmetric edges
  private carvePlaza(
    terrain: number[][], cx: number, cy: number, radius: number,
    w: number, h: number, tilePrimary: number
  ): void {
    const PHI = 1.618
    // Elliptical plaza with golden ratio aspect ratio
    const rX = radius
    const rY = Math.max(2, Math.round(radius / PHI))
    // Organic edge noise — multiple harmonics for natural imperfection
    for (let y = cy - rY - 2; y <= cy + rY + 2; y++) {
      for (let x = cx - rX - 2; x <= cx + rX + 2; x++) {
        if (x < 0 || x >= w || y < 0 || y >= h) continue
        const dx = x - cx, dy = y - cy
        const angle = Math.atan2(dy, dx)
        // Normalized elliptical distance
        const ellDist = Math.sqrt((dx / rX) ** 2 + (dy / rY) ** 2)
        // Multi-harmonic edge noise for wabi-sabi imperfection
        const edgeNoise = Math.sin(angle * 3) * 0.12
          + Math.sin(angle * 7 + 1.3) * 0.06
          + Math.sin(angle * 13 + 2.7) * 0.04
        if (ellDist < 1.0 + edgeNoise) {
          if (ellDist < 0.5) {
            terrain[y][x] = tilePrimary // inner sanctum
          } else if (ellDist < 0.75) {
            // Golden inner ring — alternating pattern
            terrain[y][x] = (x + y) % 3 === 0 ? tilePrimary : 8
          } else {
            // Outer ring — cobblestone with accent variation
            terrain[y][x] = (x + y) % 5 === 0 ? 9 : 8
          }
        }
      }
    }
  }

  // === STREET NETWORK ===
  private generateStreetNetwork(
    w: number, h: number,
    center: { x: number; y: number },
    districts: District[],
    complexity: number, density: number,
    rng: () => number, noise: SimplexNoise,
    terrain: number[][], waterMap: boolean[][]
  ): boolean[][] {
    const roadMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))

    // Mark plazas
    const plazaR = Math.floor(3 + complexity * 3)
    this.markCircle(roadMap, center.x, center.y, plazaR, w, h)

    for (const d of districts) {
      const r = Math.floor(2 + complexity * 1.5)
      this.markCircle(roadMap, d.center.x, d.center.y, r, w, h)
    }

    // BOULEVARDS: Connect main center to each district center
    // Temple and noble districts get grand processional ways (width 5)
    // Others get standard boulevards (width 4)
    for (const d of districts) {
      const boulWidth = (d.type === 'temple' || d.type === 'noble') ? 5 : 4
      const curviness = d.type === 'temple' ? 0.05 : 0.1 // Temples get straighter, more formal approaches
      this.carveRoad(roadMap, terrain, center.x, center.y, d.center.x, d.center.y,
        w, h, boulWidth, curviness, noise, rng, waterMap)
    }

    // MAIN STREETS: Radiate from center with curves (width 3)
    const numMain = Math.floor(5 + complexity * 6)
    for (let i = 0; i < numMain; i++) {
      const angle = (i / numMain) * Math.PI * 2 + (rng() - 0.5) * 0.3
      const length = Math.floor(w * 0.3 + rng() * w * 0.2)
      this.carveOrganicPath(roadMap, terrain, center.x, center.y, angle,
        w, h, length, 3, 0.15, noise, rng, waterMap)
    }

    // LANES: Connect districts to each other (width 3 for walkable 3D streets)
    for (let i = 0; i < districts.length; i++) {
      for (let j = i + 1; j < districts.length; j++) {
        const dx = districts[i].center.x - districts[j].center.x
        const dy = districts[i].center.y - districts[j].center.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < Math.min(w, h) * 0.5) {
          this.carveRoad(roadMap, terrain, districts[i].center.x, districts[i].center.y,
            districts[j].center.x, districts[j].center.y, w, h, 3, 0.2, noise, rng, waterMap)
        }
      }
    }

    // SECONDARY STREETS within districts (width 3) — walkable side streets
    const numSecondary = Math.floor(8 + complexity * 18)
    for (let i = 0; i < numSecondary; i++) {
      const sx = Math.floor(w * 0.08 + rng() * w * 0.84)
      const sy = Math.floor(h * 0.08 + rng() * h * 0.84)
      if (waterMap[sy]?.[sx]) continue
      const angle = rng() * Math.PI * 2
      this.carveOrganicPath(roadMap, terrain, sx, sy, angle,
        w, h, Math.floor(6 + rng() * 12), 3, 0.25, noise, rng, waterMap)
    }

    // ALLEYS branching off roads (width 2 for walkable 3D)
    if (complexity > 0.2) {
      const numAlleys = Math.floor(8 + complexity * 18)
      for (let i = 0; i < numAlleys; i++) {
        const bx = Math.floor(rng() * w)
        const by = Math.floor(rng() * h)
        if (bx >= 0 && bx < w && by >= 0 && by < h && roadMap[by][bx]) {
          const angle = rng() * Math.PI * 2
          this.carveOrganicPath(roadMap, terrain, bx, by, angle,
            w, h, Math.floor(3 + rng() * 5), 2, 0.35, noise, rng, waterMap)
        }
      }
    }

    // Carve market squares — rectangular open areas in market districts
    for (const d of districts) {
      if (d.type !== 'market') continue
      const sqSize = 4 + Math.floor(rng() * 3) // 4-6 tiles wide
      const sqX = d.center.x - Math.floor(sqSize / 2)
      const sqY = d.center.y - Math.floor(sqSize / 2)
      for (let dy = 0; dy < sqSize; dy++) {
        for (let dx = 0; dx < sqSize; dx++) {
          const px = sqX + dx, py = sqY + dy
          if (px >= 0 && px < w && py >= 0 && py < h && !waterMap[py][px]) {
            roadMap[py][px] = true
          }
        }
      }
    }

    // Paint road tiles onto terrain
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (roadMap[y][x] && !waterMap[y][x]) {
          terrain[y][x] = (x + y) % 4 === 0 ? 9 : 8
        }
      }
    }

    return roadMap
  }

  private markCircle(map: boolean[][], cx: number, cy: number, r: number, w: number, h: number): void {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x >= 0 && x < w && y >= 0 && y < h) {
          if (Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) < r + 0.5) {
            map[y][x] = true
          }
        }
      }
    }
  }

  // Carve a road between two points with noise-driven curves
  private carveRoad(
    roadMap: boolean[][], terrain: number[][],
    x1: number, y1: number, x2: number, y2: number,
    w: number, h: number, roadWidth: number, curviness: number,
    noise: SimplexNoise, rng: () => number, waterMap: boolean[][]
  ): void {
    const dx = x2 - x1, dy = y2 - y1
    const dist = Math.sqrt(dx * dx + dy * dy)
    const steps = Math.ceil(dist * 1.5)
    const baseAngle = Math.atan2(dy, dx)

    let x = x1, y = y1
    let angle = baseAngle

    for (let step = 0; step < steps; step++) {
      // Carve tiles
      for (let cw = 0; cw < roadWidth; cw++) {
        for (let ch = 0; ch < roadWidth; ch++) {
          const rx = Math.floor(x) + cw - Math.floor(roadWidth / 2)
          const ry = Math.floor(y) + ch - Math.floor(roadWidth / 2)
          if (rx >= 0 && rx < w && ry >= 0 && ry < h && !waterMap[ry][rx]) {
            roadMap[ry][rx] = true
          }
        }
      }

      // Pull back toward target
      const toTarget = Math.atan2(y2 - y, x2 - x)
      const nv = noise.noise2D(x * 0.1, y * 0.1)
      angle = angle * 0.3 + toTarget * 0.5 + nv * curviness + (rng() - 0.5) * curviness * 0.3

      x += Math.cos(angle) * 1.2
      y += Math.sin(angle) * 1.2

      // Check if we reached the target
      if (Math.abs(x - x2) < 2 && Math.abs(y - y2) < 2) break
      if (x < 0 || x >= w || y < 0 || y >= h) break
    }
  }

  // Carve a single organic path
  private carveOrganicPath(
    roadMap: boolean[][], terrain: number[][],
    startX: number, startY: number, angle: number,
    w: number, h: number, length: number, roadWidth: number, curviness: number,
    noise: SimplexNoise, rng: () => number, waterMap: boolean[][]
  ): void {
    let x = startX, y = startY, dir = angle
    for (let step = 0; step < length; step++) {
      for (let dy = 0; dy < roadWidth; dy++) {
        for (let dx = 0; dx < roadWidth; dx++) {
          const rx = Math.floor(x) + dx
          const ry = Math.floor(y) + dy
          if (rx >= 0 && rx < w && ry >= 0 && ry < h && !waterMap[ry][rx]) {
            roadMap[ry][rx] = true
          }
        }
      }
      const nv = noise.noise2D(x * 0.1, y * 0.1)
      dir += nv * curviness + (rng() - 0.5) * curviness * 0.5
      x += Math.cos(dir) * 1.2
      y += Math.sin(dir) * 1.2
      if (x < 1 || x >= w - 1 || y < 1 || y >= h - 1) break
    }
  }


  // === BRIDGES ===
  private placeBridges(
    w: number, h: number, roadMap: boolean[][], waterMap: boolean[][], rng: () => number
  ): PlacedObject[] {
    const bridges: PlacedObject[] = []
    const placed = new Set<string>()

    for (let y = 2; y < h - 4; y += 3) {
      for (let x = 2; x < w - 6; x += 3) {
        if (!roadMap[y][x]) continue

        // Check if road crosses water ahead (horizontal)
        let waterCross = false
        for (let dx = 1; dx <= 4; dx++) {
          if (x + dx < w && waterMap[y][x + dx]) { waterCross = true; break }
        }
        if (waterCross) {
          const key = `${Math.floor(x / 4)},${Math.floor(y / 4)}`
          if (!placed.has(key)) {
            bridges.push(this.createObj('bridge', x, y))
            placed.add(key)
          }
        }
      }
    }
    return bridges
  }

  // === BUILDING PLACEMENT ===
  private placeBuildings(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][], heightMap: number[][],
    districtMap: number[][], districts: District[],
    complexity: number, density: number,
    rng: () => number, center: { x: number; y: number },
    terrainTiles: number[][], noise: SimplexNoise
  ): PlacedObject[] {
    const buildings: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    const maxDist = Math.sqrt(w * w + h * h) / 2

    // ════════════════════════════════════════════════════════════════
    // ORGANIC GROWTH: Street-frontage walk (center→edge)
    // Instead of random scatter, systematically walk road edges
    // from center outward. This creates continuous street walls,
    // natural growth rings, and organically dense cores.
    // ════════════════════════════════════════════════════════════════

    // Phase A: Collect all road-edge positions (non-road tiles adjacent to road)
    interface RoadEdge { x: number; y: number; distSq: number }
    const roadEdges: RoadEdge[] = []
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        if (roadMap[y][x] || waterMap[y][x] || occupied[y][x]) continue
        // Must be adjacent to road
        let nearRoad = false
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
          if (roadMap[y + dy]?.[x + dx]) { nearRoad = true; break }
        }
        if (!nearRoad) continue
        roadEdges.push({ x, y, distSq: (x - center.x) ** 2 + (y - center.y) ** 2 })
      }
    }

    // Sort center-first: core gets built first (growth rings)
    roadEdges.sort((a, b) => a.distSq - b.distSq)

    const maxBuildings = Math.floor(50 + complexity * 90 + density * 60)
    let placed = 0

    // Phase B: Walk edges, placing buildings with continuity bonus
    // Track which tiles have a neighbor building for "street wall" bonus
    const hasBuildingNeighbor = (x: number, y: number): boolean => {
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && occupied[ny][nx] && !roadMap[ny][nx] && !waterMap[ny][nx]) {
          return true
        }
      }
      return false
    }

    for (const edge of roadEdges) {
      if (placed >= maxBuildings) break
      const { x: rx, y: ry } = edge
      if (occupied[ry]?.[rx]) continue

      // District context
      const dId = districtMap[ry]?.[rx] ?? -1
      const district = districts.find(d => d.id === dId)
      const types = district ? DISTRICT_BUILDINGS[district.type] : DISTRICT_BUILDINGS.residential
      const distDensity = district ? district.buildingDensity : 0.8
      const dType = district?.type || 'residential'

      // Growth ring: distance-based acceptance
      const distFromCenter = Math.sqrt(edge.distSq)
      const distNorm = distFromCenter / maxDist

      // Continuity bonus: much more likely to build next to existing buildings
      // This creates organic street walls instead of isolated buildings
      const continuityBonus = hasBuildingNeighbor(rx, ry) ? 0.35 : 0
      const acceptChance = distDensity * (1.0 - distNorm * 0.5) * density + continuityBonus
      if (rng() > acceptChance) continue

      // Growth ring character: core gets bigger, taller buildings
      const ringChar = distNorm < 0.25 ? 'core' : distNorm < 0.5 ? 'middle' : 'outer'

      // Weighted random building type (bias toward larger buildings in core)
      const totalWeight = types.reduce((s, t) => {
        let w = t.weight
        if (ringChar === 'core' && t.w >= 3) w *= 1.5
        if (ringChar === 'outer' && t.w >= 3) w *= 0.5
        return s + w
      }, 0)
      let roll = rng() * totalWeight
      let type = types[0]
      for (const t of types) {
        let tw = t.weight
        if (ringChar === 'core' && t.w >= 3) tw *= 1.5
        if (ringChar === 'outer' && t.w >= 3) tw *= 0.5
        roll -= tw
        if (roll <= 0) { type = t; break }
      }

      const bw = type.w, bh = type.h
      if (rx + bw > w - 1 || ry + bh > h - 1) continue

      // Check if area is free
      let free = true
      for (let dy = 0; dy < bh && free; dy++) {
        for (let dx = 0; dx < bw && free; dx++) {
          if (occupied[ry + dy]?.[rx + dx]) free = false
        }
      }
      if (!free) continue

      // Growth-ring-aware floor count
      const heightVal = heightMap[ry]?.[rx] ?? 0
      let baseFloors: number
      switch (dType) {
        case 'noble': baseFloors = 2 + Math.floor(rng() * 2); break
        case 'temple': baseFloors = 1 + Math.floor(rng() * 3); break
        case 'market': baseFloors = 1 + Math.floor(rng() * 2); break
        case 'slum': baseFloors = 1 + Math.floor(rng() * (rng() > 0.7 ? 2 : 1)); break
        case 'garden': baseFloors = 1 + Math.floor(rng() * 2); break
        default: baseFloors = 1 + Math.floor(rng() * 2); break
      }
      const coreBonus = ringChar === 'core' ? 1 : 0
      const hillBonus = heightVal > 1.0 ? 1 : 0
      const floors = Math.min(baseFloors + coreBonus + hillBonus, 4)

      const elevBias = DISTRICT_ELEVATION_BIAS[dType] || 0
      const rawElev = heightVal + elevBias
      const elevation = Math.max(0, Math.min(Math.round(rawElev * 2) / 2, 2.5))

      // Micro-variation: each building subtly unique
      const scaleJitter = 0.92 + rng() * 0.16
      const scaleY = 0.94 + rng() * 0.12
      const styleNoise = noise.noise2D(rx * 0.2, ry * 0.2)
      const style = styleNoise > 0.3 ? 'ornate'
        : styleNoise > -0.1 ? 'standard'
        : dType === 'slum' ? 'weathered' : 'rustic'

      buildings.push({
        id: uuid(),
        definitionId: type.id,
        x: rx, y: ry,
        rotation: 0, scaleX: scaleJitter, scaleY,
        elevation,
        properties: {
          floors, district: dType,
          style, growthRing: ringChar,
          hasAwning: dType === 'market' || (dType === 'residential' && rng() > 0.6),
          hasBalcony: type.id === 'balcony_house' || (dType === 'noble' && rng() > 0.5),
          hasFlowerBox: dType === 'garden' || dType === 'noble' || (dType === 'residential' && rng() > 0.7),
          hasShutters: dType !== 'slum' && rng() > 0.4,
          chimneyPos: rng() > 0.5 ? 'left' : 'right',
        }
      })

      for (let dy = 0; dy < bh; dy++) {
        for (let dx = 0; dx < bw; dx++) {
          if (ry + dy < h && rx + dx < w) occupied[ry + dy][rx + dx] = true
        }
      }
      placed++
    }

    // Phase C: Gap-fill pass — random scatter for spots the walk missed
    const gapFillMax = Math.floor(maxBuildings * 0.3)
    let gapFilled = 0
    for (let attempt = 0; attempt < gapFillMax * 40 && gapFilled < gapFillMax; attempt++) {
      const rx = Math.floor(rng() * (w - 6)) + 3
      const ry = Math.floor(rng() * (h - 6)) + 3
      if (!this.isRoadAdjacent(rx, ry, roadMap, w, h) || occupied[ry]?.[rx]) continue

      const dId = districtMap[ry]?.[rx] ?? -1
      const district = districts.find(d => d.id === dId)
      const types = district ? DISTRICT_BUILDINGS[district.type] : DISTRICT_BUILDINGS.residential
      const distDensity = district ? district.buildingDensity : 0.8
      const distFromCenter = Math.sqrt((rx - center.x) ** 2 + (ry - center.y) ** 2)
      const distNorm = distFromCenter / maxDist
      if (rng() > distDensity * (1.0 - distNorm * 0.6) * density) continue

      const totalWeight = types.reduce((s, t) => s + t.weight, 0)
      let roll = rng() * totalWeight
      let type = types[0]
      for (const t of types) { roll -= t.weight; if (roll <= 0) { type = t; break } }

      const bw = type.w, bh = type.h
      if (rx + bw > w - 1 || ry + bh > h - 1) continue

      let free = true
      for (let dy = 0; dy < bh && free; dy++) {
        for (let dx = 0; dx < bw && free; dx++) {
          if (occupied[ry + dy]?.[rx + dx]) free = false
        }
      }
      if (!free) continue

      const heightVal = heightMap[ry]?.[rx] ?? 0
      const dType = district?.type || 'residential'
      const elevBias = DISTRICT_ELEVATION_BIAS[dType] || 0
      const elevation = Math.max(0, Math.min(Math.round((heightVal + elevBias) * 2) / 2, 2.5))

      buildings.push({
        id: uuid(), definitionId: type.id,
        x: rx, y: ry, rotation: 0,
        scaleX: 0.92 + rng() * 0.16, scaleY: 0.94 + rng() * 0.12,
        elevation,
        properties: { floors: 1 + Math.floor(rng() * 2), district: dType }
      })

      for (let dy = 0; dy < bh; dy++) {
        for (let dx = 0; dx < bw; dx++) {
          if (ry + dy < h && rx + dx < w) occupied[ry + dy][rx + dx] = true
        }
      }
      gapFilled++
    }

    // === FILL PASS 1: Row houses & small buildings to plug gaps for continuous frontage ===
    const fillMax = Math.floor(maxBuildings * 0.8)
    let filled = 0
    for (let y = 3; y < h - 3 && filled < fillMax; y++) {
      for (let x = 3; x < w - 2 && filled < fillMax; x++) {
        if (occupied[y][x] || !this.isRoadAdjacent(x, y, roadMap, w, h)) continue

        // Loosened from 0.7 → 0.92 so the outer ring of the map gets filled
        // instead of leaving massive empty space around the edges.
        const distFromC = Math.sqrt((x - center.x) ** 2 + (y - center.y) ** 2) / maxDist
        if (distFromC > 0.92) continue

        const elev = Math.min(Math.round((heightMap[y]?.[x] ?? 0) * 2) / 2, 2)
        const dId = districtMap[y]?.[x] ?? -1
        const district = districts.find(d => d.id === dId)
        const dType = district?.type || 'residential'

        // Try building_small (2x2) first for better density.
        // Skip-probability dropped from 0.4 → 0.15 so 85% of viable slots
        // actually get filled instead of 60% being randomly skipped.
        if (rng() > 0.15 && y + 1 < h && x + 1 < w &&
            !occupied[y][x + 1] && !occupied[y + 1][x] && !occupied[y + 1][x + 1]) {
          const defId = rng() > 0.5 ? 'building_small' : 'corner_building'
          buildings.push({
            id: uuid(), definitionId: defId,
            x, y, rotation: 0, scaleX: 1, scaleY: 1, elevation: elev,
            properties: { floors: dType === 'noble' ? 2 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * 2), district: dType }
          })
          occupied[y][x] = true; occupied[y][x + 1] = true
          occupied[y + 1][x] = true; occupied[y + 1][x + 1] = true
          filled++
        } else if (y + 1 < h && !occupied[y + 1][x]) {
          buildings.push({
            id: uuid(), definitionId: 'row_house',
            x, y, rotation: 0, scaleX: 1, scaleY: 1, elevation: elev,
            properties: { floors: 1 + Math.floor(rng() * 2), district: dType }
          })
          occupied[y][x] = true; occupied[y + 1][x] = true
          filled++
        }
      }
    }

    // === FILL PASS 2: Corner buildings at road intersections ===
    let corners = 0
    const cornerMax = Math.floor(maxBuildings * 0.15)
    for (let y = 3; y < h - 4 && corners < cornerMax; y += 2) {
      for (let x = 3; x < w - 4 && corners < cornerMax; x += 2) {
        if (occupied[y][x]) continue
        // Check for L-shaped road intersection nearby
        const hasHRoad = roadMap[y]?.[x - 1] || roadMap[y]?.[x + 2]
        const hasVRoad = roadMap[y - 1]?.[x] || roadMap[y + 2]?.[x]
        if (!hasHRoad || !hasVRoad) continue
        if (!this.areaFree(occupied, x, y, 2, 2, w, h)) continue

        buildings.push({
          id: uuid(), definitionId: 'corner_building',
          x, y, rotation: 0, scaleX: 1, scaleY: 1,
          elevation: Math.min(Math.round((heightMap[y]?.[x] ?? 0) * 2) / 2, 2),
          properties: { floors: 2, district: (districts.find(d => d.id === (districtMap[y]?.[x] ?? -1)))?.type || 'residential' }
        })
        this.markArea(occupied, x, y, 2, 2, w, h)
        corners++
      }
    }

    // === COURTYARD DETECTION: Paint courtyards between building clusters ===
    this.detectAndPaintCourtyards(terrainTiles, occupied, roadMap, waterMap, buildings, w, h, rng)

    return buildings
  }


  // === LANDMARKS ===
  private placeLandmarks(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    districts: District[], districtMap: number[][],
    buildings: PlacedObject[], heightMap: number[][],
    complexity: number, rng: () => number,
    center: { x: number; y: number }
  ): PlacedObject[] {
    const landmarks: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markBuildings(occupied, buildings, w, h)

    // Clock tower in noble/temple district + mandatory props around it
    for (const d of districts) {
      if (d.type === 'noble' || d.type === 'temple') {
        const spot = this.findFreeSpot(occupied, d.center.x, d.center.y, 3, 3, w, h, 8)
        if (spot) {
          landmarks.push(this.createObj('clock_tower', spot.x, spot.y, 2))
          this.markArea(occupied, spot.x, spot.y, 3, 3, w, h)
          // Benches and statue in front of clock tower
          for (const [dx, dy] of [[0, 3], [2, 3]] as const) {
            const bx = spot.x + dx, by = spot.y + dy
            if (bx >= 0 && bx + 1 < w && by >= 0 && by < h &&
                !occupied[by][bx] && !occupied[by][bx + 1]) {
              landmarks.push(this.createObj('bench', bx, by))
              occupied[by][bx] = true; occupied[by][bx + 1] = true
            }
          }
          if (spot.x + 1 < w && spot.y + 4 < h && !occupied[spot.y + 4][spot.x + 1]) {
            landmarks.push(this.createObj('statue', spot.x + 1, spot.y + 4))
            occupied[spot.y + 4][spot.x + 1] = true
          }
          break
        }
      }
    }

    // Tavern in EVERY market and waterfront district (not just one)
    for (const d of districts) {
      if (d.type === 'market' || d.type === 'waterfront') {
        const spot = this.findFreeSpot(occupied, d.center.x, d.center.y, 4, 3, w, h, 10)
        if (spot) {
          landmarks.push(this.createObj('tavern', spot.x, spot.y, 0.5))
          this.markArea(occupied, spot.x, spot.y, 4, 3, w, h)
          // Tavern props: barrel stack + hanging sign + café table
          for (const [dx, dy, propId] of [[-1, 1, 'barrel_stack'], [4, 0, 'hanging_sign'], [0, 3, 'cafe_table']] as const) {
            const px = spot.x + dx, py = spot.y + dy
            if (px >= 0 && px < w && py >= 0 && py < h && !occupied[py][px]) {
              landmarks.push(this.createObj(propId, px, py))
              occupied[py][px] = true
            }
          }
        }
      }
    }

    // Defense towers at map edges
    const towerPositions = [
      { x: 3, y: 3 }, { x: w - 5, y: 3 },
      { x: 3, y: h - 5 }, { x: w - 5, y: h - 5 }
    ]
    let towersPlaced = 0
    for (const pos of towerPositions) {
      if (towersPlaced >= 2 + Math.floor(complexity * 2)) break
      if (pos.x >= 0 && pos.x + 2 < w && pos.y >= 0 && pos.y + 2 < h &&
          !occupied[pos.y][pos.x] && !occupied[pos.y][pos.x + 1] &&
          !occupied[pos.y + 1][pos.x] && !occupied[pos.y + 1][pos.x + 1] &&
          !waterMap[pos.y][pos.x]) {
        landmarks.push(this.createObj('tower', pos.x, pos.y, 1.5))
        this.markArea(occupied, pos.x, pos.y, 2, 2, w, h)
        towersPlaced++
      }
    }

    // Extra towers in temple district centers
    for (const d of districts) {
      if (d.type !== 'temple') continue
      const spot = this.findFreeSpot(occupied, d.center.x + 3, d.center.y, 2, 2, w, h, 6)
      if (spot) {
        landmarks.push(this.createObj('tower', spot.x, spot.y, 1.5))
        this.markArea(occupied, spot.x, spot.y, 2, 2, w, h)
      }
    }

    // Cathedral as a major landmark in temple districts
    if (buildings.length > 8) {
      for (const d of districts) {
        if (d.type !== 'temple') continue
        const spot = this.findFreeSpot(occupied, d.center.x, d.center.y, 5, 6, w, h, 10)
        if (spot) {
          landmarks.push(this.createObj('cathedral', spot.x, spot.y, 2))
          this.markArea(occupied, spot.x, spot.y, 5, 6, w, h)
          break
        }
      }
    }

    // Archways at district boundaries where roads cross — Piranesi monumental gates
    let archways = 0
    for (let y = 3; y < h - 3 && archways < 6; y += 3) {
      for (let x = 3; x < w - 5 && archways < 6; x += 3) {
        if (!roadMap[y][x]) continue
        const d1 = districtMap[y]?.[x] ?? -1
        const d2 = districtMap[y]?.[x + 2] ?? -1
        const d3 = districtMap[y + 1]?.[x] ?? -1
        if (d1 === d2 && d1 === d3) continue
        if (this.areaFree(occupied, x, y, 3, 1, w, h)) {
          landmarks.push(this.createObj('archway', x, y, 0.5)) // slight elevation for grandeur
          this.markArea(occupied, x, y, 3, 1, w, h)
          // Flanking wall lanterns for drama
          if (x > 0 && !occupied[y][x - 1]) {
            landmarks.push(this.createObj('wall_lantern', x - 1, y))
            occupied[y][x - 1] = true
          }
          if (x + 3 < w && !occupied[y][x + 3]) {
            landmarks.push(this.createObj('wall_lantern', x + 3, y))
            occupied[y][x + 3] = true
          }
          archways++
        }
      }
    }

    // Colonnades in temple and noble districts — Piranesi's dramatic covered walkways
    for (const d of districts) {
      if (d.type !== 'temple' && d.type !== 'noble') continue
      // Place a row of stone walls along one side of the plaza — colonnade effect
      const colDir = rng() > 0.5 ? 1 : -1 // left or right of center
      const colX = d.center.x + colDir * Math.floor(d.radius * 0.5)
      let colsPlaced = 0
      for (let dy = -3; dy <= 3 && colsPlaced < 4; dy += 2) {
        const cy = d.center.y + dy
        if (colX >= 0 && colX + 1 < w && cy >= 0 && cy < h) {
          if (this.areaFree(occupied, colX, cy, 2, 1, w, h)) {
            landmarks.push(this.createObj('stone_wall', colX, cy, 0.3))
            this.markArea(occupied, colX, cy, 2, 1, w, h)
            colsPlaced++
          }
        }
      }
    }

    // Processional ways — stone-paved approaches to temple districts
    for (const d of districts) {
      if (d.type !== 'temple') continue
      // Place archway + statue sequence approaching the temple
      const approaches = [
        { dx: -4, dy: 0 }, { dx: 4, dy: 0 }, { dx: 0, dy: -4 }, { dx: 0, dy: 4 }
      ]
      for (const ap of approaches) {
        const ax = d.center.x + ap.dx, ay = d.center.y + ap.dy
        if (ax < 0 || ax >= w || ay < 0 || ay >= h) continue
        if (roadMap[ay]?.[ax] && !occupied[ay][ax]) {
          landmarks.push(this.createObj('statue', ax, ay, 0.5))
          occupied[ay][ax] = true
          break
        }
      }
    }

    // Grand staircases — Piranesi dramatic, placed where elevation changes
    // More staircases, placed specifically at elevation transitions
    if (complexity > 0.2) {
      let staircasesPlaced = 0
      const maxStairs = Math.floor(4 + complexity * 6)
      for (let attempt = 0; attempt < 80 && staircasesPlaced < maxStairs; attempt++) {
        const sx = Math.floor(3 + rng() * (w - 8))
        const sy = Math.floor(3 + rng() * (h - 8))
        if (!this.isRoadAdjacent(sx, sy, roadMap, w, h) || occupied[sy][sx]) continue

        // Prefer placement at elevation changes (Piranesi's dramatic steps)
        const spot = this.findFreeSpot(occupied, sx, sy, 2, 3, w, h, 4)
        if (!spot) continue

        // Check for elevation difference nearby
        const elHere = heightMap[spot.y]?.[spot.x] ?? 0
        let hasElevChange = false
        for (let dy = -2; dy <= 2 && !hasElevChange; dy++) {
          for (let dx = -2; dx <= 2 && !hasElevChange; dx++) {
            const el2 = heightMap[spot.y + dy]?.[spot.x + dx] ?? 0
            if (Math.abs(el2 - elHere) > 0.4) hasElevChange = true
          }
        }
        // Place staircase — prefer elevation changes but allow some random placement too
        if (hasElevChange || rng() > 0.6) {
          landmarks.push(this.createObj('staircase', spot.x, spot.y, 0))
          this.markArea(occupied, spot.x, spot.y, 2, 3, w, h)
          staircasesPlaced++
        }
      }
    }

    return landmarks
  }

  // === TOWN GATES ===
  private placeGates(
    w: number, h: number, roadMap: boolean[][], rng: () => number
  ): PlacedObject[] {
    const gates: PlacedObject[] = []

    // Check each edge for road exits
    const edges: { x: number; y: number; side: string }[] = []
    for (let x = 2; x < w - 4; x++) {
      if (roadMap[0]?.[x] || roadMap[1]?.[x]) edges.push({ x, y: 1, side: 'top' })
      if (roadMap[h - 1]?.[x] || roadMap[h - 2]?.[x]) edges.push({ x, y: h - 2, side: 'bottom' })
    }
    for (let y = 2; y < h - 4; y++) {
      if (roadMap[y]?.[0] || roadMap[y]?.[1]) edges.push({ x: 1, y, side: 'left' })
      if (roadMap[y]?.[w - 1] || roadMap[y]?.[w - 2]) edges.push({ x: w - 4, y, side: 'right' })
    }

    // Place a gate at each exit (max 4)
    const placed = new Set<string>()
    for (const edge of edges) {
      if (gates.length >= 4) break
      const key = edge.side
      if (placed.has(key)) continue
      placed.add(key)
      gates.push(this.createObj('town_gate', edge.x, edge.y))
    }

    return gates
  }

  // === ALLEYS & INTIMATE SPACES ===
  // Creates narrow alleys, alcoves, and L-shaped nooks between building clusters
  private carveAlleys(terrain: number[][], buildings: PlacedObject[], w: number, h: number): void {
    const buildingMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (const b of buildings) {
      const fp = this.getFootprint(b.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const bx = b.x + dx, by = b.y + dy
          if (bx < w && by < h) buildingMap[by][bx] = true
        }
      }
    }

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (buildingMap[y][x]) continue
        const leftB = x > 0 && buildingMap[y][x - 1]
        const rightB = x < w - 1 && buildingMap[y][x + 1]
        const topB = y > 0 && buildingMap[y - 1][x]
        const botB = y < h - 1 && buildingMap[y + 1][x]

        // Narrow passage between buildings
        if ((leftB && rightB) || (topB && botB)) {
          terrain[y][x] = 9 // dark cobblestone for alleys
        }

        // L-shaped alcoves: building on two adjacent sides (corner nooks)
        const cornerNook = (leftB && topB && !rightB && !botB) ||
                           (rightB && topB && !leftB && !botB) ||
                           (leftB && botB && !rightB && !topB) ||
                           (rightB && botB && !leftB && !topB)
        if (cornerNook) {
          terrain[y][x] = 8 // lighter cobble for alcoves (intimate feel)
        }

        // Setback detection: building on one side, open on others = covered walkway feel
        const totalWalls = (leftB ? 1 : 0) + (rightB ? 1 : 0) + (topB ? 1 : 0) + (botB ? 1 : 0)
        if (totalWalls === 1 && terrain[y][x] !== 8 && terrain[y][x] !== 9) {
          // Count more distant buildings (2 tiles away) for deeper setbacks
          let distantWalls = 0
          if (x > 1 && buildingMap[y][x - 2]) distantWalls++
          if (x < w - 2 && buildingMap[y][x + 2]) distantWalls++
          if (y > 1 && buildingMap[y - 2][x]) distantWalls++
          if (y < h - 2 && buildingMap[y + 2][x]) distantWalls++
          if (distantWalls >= 1) {
            terrain[y][x] = 8 // covered walkway / arcade feel
          }
        }
      }
    }
  }


  // === CONTEXTUAL PROPS ===
  private placeProps(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    existingObjs: PlacedObject[],
    districtMap: number[][], districts: District[],
    density: number, assetFrequencies: Record<string, number>,
    rng: () => number, center: { x: number; y: number }
  ): PlacedObject[] {
    const props: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, existingObjs, w, h)

    const place = (defId: string, x: number, y: number) => {
      if (x < 0 || x >= w || y < 0 || y >= h || occupied[y][x]) return false
      props.push(this.createObj(defId, x, y))
      occupied[y][x] = true
      return true
    }

    // Building-adjacent props (contextual per district)
    for (const b of existingObjs) {
      const fp = this.getFootprint(b.definitionId)
      const spots: { x: number; y: number }[] = []

      // Gather adjacent spots
      for (let dx = -1; dx <= fp.w; dx++) {
        spots.push({ x: b.x + dx, y: b.y - 1 })
        spots.push({ x: b.x + dx, y: b.y + fp.h })
      }
      for (let dy = 0; dy < fp.h; dy++) {
        spots.push({ x: b.x - 1, y: b.y + dy })
        spots.push({ x: b.x + fp.w, y: b.y + dy })
      }

      const validSpots = spots.filter(
        s => s.x >= 0 && s.x < w && s.y >= 0 && s.y < h && !occupied[s.y][s.x]
      )
      if (validSpots.length === 0) continue

      const numProps = Math.min(validSpots.length, 2 + Math.floor(rng() * 3 * density))
      const dId = districtMap[b.y]?.[b.x] ?? -1
      const district = districts.find(d => d.id === dId)
      const propPalette = district ? DISTRICT_PROPS[district.type] : DISTRICT_PROPS.residential

      // Building-type-specific mandatory props first
      const buildingSpecificProps = this.getBuildingSpecificProps(b.definitionId, rng)

      for (let i = 0; i < numProps; i++) {
        const idx = Math.floor(rng() * validSpots.length)
        const spot = validSpots.splice(idx, 1)[0]
        if (spot) {
          // Use building-specific prop if available, otherwise district palette
          const propId = i < buildingSpecificProps.length
            ? buildingSpecificProps[i]
            : propPalette[Math.floor(rng() * propPalette.length)]
          const propFp = this.getFootprint(propId)
          if (propFp.w === 1 && propFp.h === 1) {
            place(propId, spot.x, spot.y)
          } else if (this.areaFree(occupied, spot.x, spot.y, propFp.w, propFp.h, w, h)) {
            props.push(this.createObj(propId, spot.x, spot.y))
            this.markArea(occupied, spot.x, spot.y, propFp.w, propFp.h, w, h)
          }
        }
      }
    }

    // Scatter street furniture on tiles adjacent to roads — 2.5x denser.
    // hanging_sign / wall_lantern removed: they render with a bracket that
    // needs a wall to attach to, so they float weirdly when free-standing.
    // They still appear in DISTRICT_PROPS (building-adjacent placement).
    const streetFurnitureCount = Math.floor(density * w * h * 0.015)
    const streetItems = ['cafe_table', 'bench', 'sign', 'barrel', 'crate', 'potted_plant']
    for (let i = 0; i < streetFurnitureCount; i++) {
      const x = Math.floor(rng() * w)
      const y = Math.floor(rng() * h)
      if (this.isRoadAdjacent(x, y, roadMap, w, h) && !occupied[y]?.[x] && !roadMap[y]?.[x]) {
        // In market districts, prefer market-themed items
        const dId = districtMap[y]?.[x] ?? -1
        const dist = districts.find(d => d.id === dId)
        let item: string
        if (dist?.type === 'market' && rng() > 0.3) {
          item = ['cafe_table', 'barrel', 'crate', 'sign', 'crate_stack'][Math.floor(rng() * 5)]
        } else if (dist?.type === 'noble' && rng() > 0.4) {
          item = ['potted_plant', 'bench', 'planter_box'][Math.floor(rng() * 3)]
        } else {
          item = streetItems[Math.floor(rng() * streetItems.length)]
        }
        const fp = this.getFootprint(item)
        if (fp.w === 1 && fp.h === 1) {
          place(item, x, y)
        } else if (this.areaFree(occupied, x, y, fp.w, fp.h, w, h)) {
          props.push(this.createObj(item, x, y))
          this.markArea(occupied, x, y, fp.w, fp.h, w, h)
        }
      }
    }

    // Market district café clusters — tables along road edges every 5-6 tiles
    for (const d of districts) {
      if (d.type !== 'market') continue
      for (let y = d.center.y - d.radius; y < d.center.y + d.radius; y += 5) {
        for (let x = d.center.x - d.radius; x < d.center.x + d.radius; x += 6) {
          if (x < 0 || x >= w || y < 0 || y >= h) continue
          if (!this.isRoadAdjacent(x, y, roadMap, w, h)) continue
          // Place 2-3 café tables in a cluster
          for (let ci = 0; ci < 2 + Math.floor(rng() * 2); ci++) {
            const cx = x + Math.floor(rng() * 3) - 1
            const cy = y + Math.floor(rng() * 2)
            if (cx >= 0 && cx < w && cy >= 0 && cy < h && !occupied[cy][cx] && !roadMap[cy][cx]) {
              place('cafe_table', cx, cy)
            }
          }
        }
      }
    }

    // Well plazas — place benches near every well in existingObjs
    for (const obj of existingObjs) {
      if (obj.definitionId !== 'well') continue
      for (let i = 0; i < 3; i++) {
        const bx = obj.x + Math.floor(rng() * 4) - 1
        const by = obj.y + Math.floor(rng() * 4) - 1
        if (bx >= 0 && bx + 1 < w && by >= 0 && by < h &&
            !occupied[by][bx] && !occupied[by][bx + 1]) {
          props.push(this.createObj('bench', bx, by))
          occupied[by][bx] = true; occupied[by][bx + 1] = true
        }
      }
    }

    return props
  }

  // === LIGHTS ===
  private placeLights(
    w: number, h: number, roadMap: boolean[][],
    existingObjs: PlacedObject[], rng: () => number, density: number
  ): PlacedObject[] {
    const lights: PlacedObject[] = []
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    this.markObjects(occupied, existingObjs, w, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (roadMap[y][x]) occupied[y][x] = true
      }
    }

    const spacing = Math.max(3, Math.floor(5 - density * 2))
    let count = 0

    for (let y = 1; y < h - 1; y += spacing) {
      for (let x = 1; x < w - 1; x += spacing) {
        if (!roadMap[y]?.[x]) continue
        // Place light on adjacent non-road tile
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const lx = x + dx, ly = y + dy
          if (lx >= 0 && lx < w && ly >= 0 && ly < h &&
              !roadMap[ly][lx] && !occupied[ly][lx]) {
            // wall_lantern was in this rotation but it's a bracket-style
            // fixture that needs a wall behind it — free-standing on
            // open ground it rendered floating. Street lights stay to
            // freestanding lamppost forms.
            const lightType = count % 6 === 0 ? 'street_lamp_double' : 'lamppost'
            lights.push(this.createObj(lightType, lx, ly))
            occupied[ly][lx] = true
            count++
            break
          }
        }
      }
    }

    return lights
  }

  // === PLAZA FEATURES ===
  private placePlazaFeatures(
    w: number, h: number,
    center: { x: number; y: number }, plazaRadius: number,
    districts: District[],
    existingObjs: PlacedObject[],
    density: number, rng: () => number,
    roadMap: boolean[][], waterMap: boolean[][],
  ): PlacedObject[] {
    const props: PlacedObject[] = []
    // BUG FIX: was creating a blank occupied map, so fountains / statues /
    // market stalls / cafe tables in plaza features could land on roads or
    // water. Using createOccupied which marks both.
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, existingObjs, w, h)

    // Fountain at main center
    if (this.areaFree(occupied, center.x - 1, center.y - 1, 2, 2, w, h)) {
      props.push(this.createObj('fountain', center.x - 1, center.y - 1))
      this.markArea(occupied, center.x - 1, center.y - 1, 2, 2, w, h)
    }

    // Two concentric rings around the fountain instead of a random
    // scatter. Inner ring: 8 cafe tables at cardinal/diagonal angles.
    // Outer ring: market stalls alternating with benches. The radial
    // composition reads as a deliberate town square from any angle.
    const innerR = Math.max(2, plazaRadius * 0.45)
    const outerR = Math.max(3, plazaRadius * 0.85)
    const placePlaza = (defId: string, cx: number, cy: number, fpW = 1, fpH = 1) => {
      if (cx < 0 || cy < 0 || cx + fpW > w || cy + fpH > h) return false
      if (!this.areaFree(occupied, cx, cy, fpW, fpH, w, h)) return false
      props.push(this.createObj(defId, cx, cy))
      this.markArea(occupied, cx, cy, fpW, fpH, w, h)
      return true
    }

    // Inner ring — cafe tables + potted plants
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2
      const tx = Math.round(center.x + Math.cos(ang) * innerR)
      const ty = Math.round(center.y + Math.sin(ang) * innerR)
      const item = i % 3 === 0 ? 'potted_plant' : 'cafe_table'
      placePlaza(item, tx, ty)
    }

    // Outer ring — market stalls (2x2) alternating with benches.
    const outerCount = Math.max(8, Math.floor(8 + density * 6))
    for (let i = 0; i < outerCount; i++) {
      const ang = (i / outerCount) * Math.PI * 2
      const rx = Math.round(center.x + Math.cos(ang) * outerR)
      const ry = Math.round(center.y + Math.sin(ang) * outerR)
      if (i % 2 === 0) placePlaza('market_stall', rx, ry, 2, 2)
      else placePlaza('bench', rx, ry, 2, 1)
    }

    // One statue asymmetrically near the fountain (just off-center)
    const statueAng = rng() * Math.PI * 2
    const sx = Math.round(center.x + Math.cos(statueAng) * (innerR * 0.55))
    const sy = Math.round(center.y + Math.sin(statueAng) * (innerR * 0.55))
    placePlaza('statue', sx, sy)

    // District plaza features — richer per-district
    for (const d of districts) {
      switch (d.type) {
        case 'garden': {
          // Fountain + planter boxes around it
          const fx = d.center.x - 1, fy = d.center.y - 1
          if (this.areaFree(occupied, fx, fy, 2, 2, w, h)) {
            props.push(this.createObj('fountain', fx, fy))
            this.markArea(occupied, fx, fy, 2, 2, w, h)
          }
          // Planter ring
          for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as const) {
            const px = d.center.x + dx, py = d.center.y + dy
            if (px >= 0 && px + 1 < w && py >= 0 && py < h &&
                !occupied[py][px] && !occupied[py][px + 1]) {
              props.push(this.createObj('planter_box', px, py))
              occupied[py][px] = true; occupied[py][px + 1] = true
            }
          }
          break
        }
        case 'noble': {
          // Statue centerpiece + planter boxes around it
          if (!occupied[d.center.y]?.[d.center.x]) {
            props.push(this.createObj('statue', d.center.x, d.center.y))
            occupied[d.center.y][d.center.x] = true
          }
          for (let i = 0; i < 4; i++) {
            const px = d.center.x + Math.floor(rng() * 6) - 3
            const py = d.center.y + Math.floor(rng() * 6) - 3
            if (px >= 0 && px + 1 < w && py >= 0 && py < h &&
                !occupied[py][px] && !occupied[py][px + 1]) {
              props.push(this.createObj('planter_box', px, py))
              occupied[py][px] = true; occupied[py][px + 1] = true
            }
          }
          break
        }
        case 'temple': {
          // Multiple statues in temple plaza
          for (let i = 0; i < 3; i++) {
            const tx = d.center.x + Math.floor(rng() * 6) - 3
            const ty = d.center.y + Math.floor(rng() * 6) - 3
            if (tx >= 0 && tx < w && ty >= 0 && ty < h && !occupied[ty][tx]) {
              props.push(this.createObj('statue', tx, ty))
              occupied[ty][tx] = true
            }
          }
          // Wall lanterns
          for (let i = 0; i < 2; i++) {
            const lx = d.center.x + Math.floor(rng() * 4) - 2
            const ly = d.center.y + Math.floor(rng() * 4) - 2
            if (lx >= 0 && lx < w && ly >= 0 && ly < h && !occupied[ly][lx]) {
              props.push(this.createObj('wall_lantern', lx, ly))
              occupied[ly][lx] = true
            }
          }
          break
        }
        case 'residential': {
          // Well + benches
          const wx = d.center.x + Math.floor(rng() * 3) - 1
          const wy = d.center.y + Math.floor(rng() * 3) - 1
          if (wx >= 0 && wx < w && wy >= 0 && wy < h && !occupied[wy][wx]) {
            props.push(this.createObj('well', wx, wy))
            occupied[wy][wx] = true
            // Benches near well
            for (let i = 0; i < 2; i++) {
              const bx = wx + Math.floor(rng() * 4) - 1
              const by = wy + Math.floor(rng() * 3) - 1
              if (bx >= 0 && bx + 1 < w && by >= 0 && by < h &&
                  !occupied[by][bx] && !occupied[by][bx + 1]) {
                props.push(this.createObj('bench', bx, by))
                occupied[by][bx] = true; occupied[by][bx + 1] = true
              }
            }
          }
          break
        }
        case 'artisan': {
          // Crate and barrel clusters (workshop yards)
          for (let i = 0; i < 4; i++) {
            const cx = d.center.x + Math.floor(rng() * 6) - 3
            const cy = d.center.y + Math.floor(rng() * 6) - 3
            if (cx >= 0 && cx < w && cy >= 0 && cy < h && !occupied[cy][cx]) {
              props.push(this.createObj(rng() > 0.5 ? 'crate_stack' : 'barrel_stack', cx, cy))
              occupied[cy][cx] = true
            }
          }
          break
        }
        case 'market': {
          // Extra stalls + wagons in market district plazas
          for (let i = 0; i < 3; i++) {
            const mx = d.center.x + Math.floor(rng() * 6) - 3
            const my = d.center.y + Math.floor(rng() * 6) - 3
            if (this.areaFree(occupied, mx, my, 2, 2, w, h)) {
              props.push(this.createObj('market_stall', mx, my))
              this.markArea(occupied, mx, my, 2, 2, w, h)
            }
          }
          break
        }
        case 'waterfront': {
          // Barrels and crates along waterfront
          for (let i = 0; i < 4; i++) {
            const wx = d.center.x + Math.floor(rng() * 6) - 3
            const wy = d.center.y + Math.floor(rng() * 6) - 3
            if (wx >= 0 && wx < w && wy >= 0 && wy < h && !occupied[wy][wx]) {
              props.push(this.createObj(rng() > 0.5 ? 'barrel' : 'crate', wx, wy))
              occupied[wy][wx] = true
            }
          }
          break
        }
      }
    }

    return props
  }


  // === VEGETATION ===
  private placeVegetation(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    existingObjs: PlacedObject[],
    districtMap: number[][], districts: District[],
    density: number, rng: () => number, noise: SimplexNoise,
    heightMap?: number[][]
  ): PlacedObject[] {
    const vegetation: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, existingObjs, w, h)

    // Poisson disk for natural tree distribution — tighter spacing for lush vegetation
    const minDist = Math.max(1.5, Math.floor(3 - density * 2))
    const points = poissonDiskSampling(w, h, minDist, rng)

    for (const p of points) {
      const tx = Math.floor(p.x), ty = Math.floor(p.y)
      if (tx < 0 || tx >= w || ty < 0 || ty >= h || occupied[ty][tx]) continue

      const dId = districtMap[ty]?.[tx] ?? -1
      const district = districts.find(d => d.id === dId)
      const vegNoise = noise.fbm(tx * 0.08, ty * 0.08, 2)

      let shouldPlace = false
      let isTree = rng() > 0.35

      if (district) {
        switch (district.type) {
          case 'garden':
            shouldPlace = vegNoise > -0.5 // Very dense lush gardens
            // Mix in potted plants and planter boxes
            if (shouldPlace && rng() > 0.8) {
              const gardenProp = rng() > 0.5 ? 'potted_plant' : 'planter_box'
              const fp = this.getFootprint(gardenProp)
              if (fp.w === 1 || this.areaFree(occupied, tx, ty, fp.w, fp.h, w, h)) {
                vegetation.push(this.createObj(gardenProp, tx, ty))
                if (fp.w > 1) this.markArea(occupied, tx, ty, fp.w, fp.h, w, h)
                else occupied[ty][tx] = true
                continue
              }
            }
            break
          case 'noble':
            shouldPlace = vegNoise > 0.0 // Denser noble greenery
            isTree = rng() > 0.55
            break
          case 'residential':
            shouldPlace = vegNoise > 0.05 // More residential gardens
            break
          case 'slum':
            shouldPlace = vegNoise > 0.35 // Slightly more vegetation even in slums
            isTree = rng() > 0.7
            break
          case 'waterfront':
            shouldPlace = vegNoise > 0.15 // Lush along water
            break
          default:
            shouldPlace = vegNoise > 0.1 - density * 0.15
            break
        }
      } else {
        shouldPlace = vegNoise > 0.05 // More vegetation in unassigned areas
      }

      if (shouldPlace) {
        if (isTree) {
          const treeObj = this.createObj('tree', tx, ty)
          // Species selection based on district, elevation, and noise
          const elev = heightMap?.[ty]?.[tx] ?? 0
          const speciesNoise = noise.noise2D(tx * 0.3 + 200, ty * 0.3 + 200)
          let species: string
          if (district?.type === 'garden' || district?.type === 'noble') {
            species = speciesNoise > 0.3 ? 'maple' : speciesNoise > -0.2 ? 'birch' : 'oak'
          } else if (elev > 1.2) {
            species = speciesNoise > 0 ? 'pine' : 'oak' // Conifers on heights
          } else if (this.hasNearbyWater(tx, ty, waterMap, w, h, 3)) {
            species = speciesNoise > 0.2 ? 'willow' : 'birch' // Willows near water
          } else {
            species = speciesNoise > 0.4 ? 'pine' : speciesNoise > 0 ? 'birch' : speciesNoise > -0.3 ? 'oak' : 'maple'
          }
          treeObj.properties = { species }
          vegetation.push(treeObj)
        } else {
          vegetation.push(this.createObj('bush', tx, ty))
        }
        occupied[ty][tx] = true
      }
    }

    // Tree-lined boulevards: trees along wider roads (every 2 tiles)
    for (let y = 2; y < h - 2; y += 2) {
      for (let x = 2; x < w - 2; x += 2) {
        if (!roadMap[y][x]) continue
        let roadCount = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (roadMap[y + dy]?.[x + dx]) roadCount++
          }
        }
        if (roadCount < 4) continue // Need at least a medium-width road

        for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
          const tx = x + dx, ty = y + dy
          if (tx >= 0 && tx < w && ty >= 0 && ty < h &&
              !roadMap[ty][tx] && !occupied[ty][tx] && !waterMap[ty][tx]) {
            vegetation.push(this.createObj('tree', tx, ty))
            occupied[ty][tx] = true
            break
          }
        }
      }
    }

    // Hedgerows in noble districts — bushes along road edges every 2 tiles
    for (const d of districts) {
      if (d.type !== 'noble') continue
      for (let y = d.center.y - d.radius; y < d.center.y + d.radius; y += 2) {
        for (let x = d.center.x - d.radius; x < d.center.x + d.radius; x += 2) {
          if (x < 0 || x >= w || y < 0 || y >= h) continue
          if (occupied[y][x] || roadMap[y][x] || waterMap[y][x]) continue
          const dId = districtMap[y]?.[x]
          if (dId !== d.id) continue
          // Only along road edges
          if (!this.isRoadAdjacent(x, y, roadMap, w, h)) continue
          vegetation.push(this.createObj('bush', x, y))
          occupied[y][x] = true
        }
      }
    }

    // Lush riverbank vegetation — trees and bushes along water edges
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (waterMap[y][x] || occupied[y][x] || roadMap[y][x]) continue
        // Check if adjacent to water
        let nearWater = false
        for (let dy = -1; dy <= 1 && !nearWater; dy++) {
          for (let dx = -1; dx <= 1 && !nearWater; dx++) {
            if (waterMap[y + dy]?.[x + dx]) nearWater = true
          }
        }
        if (!nearWater) continue
        if (rng() > 0.4) continue // 40% chance per eligible tile
        vegetation.push(this.createObj(rng() > 0.4 ? 'tree' : 'bush', x, y))
        occupied[y][x] = true
      }
    }

    return vegetation
  }

  // === HIDDEN PASSAGES & GARDEN COURTYARDS ===
  // Parisian covered passages that open into Kyoto-inspired tsuboniwa (courtyard gardens)
  private carveHiddenPassages(
    terrain: number[][], roadMap: boolean[][], waterMap: boolean[][], heightMap: number[][],
    buildings: PlacedObject[], districtMap: number[][], districts: District[],
    w: number, h: number, rng: () => number, noise: SimplexNoise
  ): PlacedObject[] {
    const courtProps: PlacedObject[] = []
    const buildingMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (const b of buildings) {
      const fp = this.getFootprint(b.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const bx = b.x + dx, by = b.y + dy
          if (bx < w && by < h) buildingMap[by][bx] = true
        }
      }
    }

    const courtyardsPlaced = new Set<string>()
    const maxCourtyards = Math.floor(3 + districts.length * 1.5)

    // Search for potential hidden courtyard sites
    for (let attempt = 0; attempt < 200 && courtyardsPlaced.size < maxCourtyards; attempt++) {
      const sx = 4 + Math.floor(rng() * (w - 10))
      const sy = 4 + Math.floor(rng() * (h - 10))
      const key = `${Math.floor(sx / 5)},${Math.floor(sy / 5)}`
      if (courtyardsPlaced.has(key)) continue

      // Need a 3x3 clear area surrounded by buildings on at least 3 sides
      let clearArea = true
      for (let dy = 0; dy < 3 && clearArea; dy++) {
        for (let dx = 0; dx < 3 && clearArea; dx++) {
          if (buildingMap[sy + dy]?.[sx + dx] || waterMap[sy + dy]?.[sx + dx] || roadMap[sy + dy]?.[sx + dx]) {
            clearArea = false
          }
        }
      }
      if (!clearArea) continue

      // Count surrounding building walls
      let wallSides = 0
      // Top wall
      let topWall = false
      for (let dx = 0; dx < 3; dx++) { if (buildingMap[sy - 1]?.[sx + dx]) topWall = true }
      // Bottom wall
      let botWall = false
      for (let dx = 0; dx < 3; dx++) { if (buildingMap[sy + 3]?.[sx + dx]) botWall = true }
      // Left wall
      let leftWall = false
      for (let dy = 0; dy < 3; dy++) { if (buildingMap[sy + dy]?.[sx - 1]) leftWall = true }
      // Right wall
      let rightWall = false
      for (let dy = 0; dy < 3; dy++) { if (buildingMap[sy + dy]?.[sx + 3]) rightWall = true }
      wallSides = (topWall ? 1 : 0) + (botWall ? 1 : 0) + (leftWall ? 1 : 0) + (rightWall ? 1 : 0)

      if (wallSides < 3) continue

      courtyardsPlaced.add(key)

      // Determine courtyard style based on district
      const dId = districtMap[sy + 1]?.[sx + 1] ?? -1
      const district = districts.find(d => d.id === dId)
      const dType = district?.type || 'residential'

      // Paint courtyard ground — Kyoto-inspired varied surfaces
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const tx = sx + dx, ty = sy + dy
          if (tx >= w || ty >= h) continue
          if (dType === 'noble' || dType === 'temple') {
            terrain[ty][tx] = 2 // stone (zen garden feel)
          } else if (dType === 'garden') {
            terrain[ty][tx] = (dx + dy) % 2 === 0 ? 0 : 5 // grass/dark grass mosaic
          } else {
            terrain[ty][tx] = (dx === 1 && dy === 1) ? 2 : 8 // cobble with stone center
          }
        }
      }

      // Place courtyard features based on style
      const cx = sx + 1, cy2 = sy + 1 // center of courtyard
      if (dType === 'garden' || dType === 'noble') {
        // Kyoto tsuboniwa: tree + potted plants
        courtProps.push(this.createObj('tree', cx, cy2))
        if (sx < w && !buildingMap[sy][sx]) {
          courtProps.push(this.createObj('potted_plant', sx, sy))
        }
        if (sx + 2 < w && sy + 2 < h && !buildingMap[sy + 2][sx + 2]) {
          courtProps.push(this.createObj('potted_plant', sx + 2, sy + 2))
        }
      } else if (dType === 'temple') {
        // Zen: statue center + lanterns
        courtProps.push(this.createObj('statue', cx, cy2))
        if (!buildingMap[sy][sx]) courtProps.push(this.createObj('wall_lantern', sx, sy))
        if (sx + 2 < w && !buildingMap[sy][sx + 2]) courtProps.push(this.createObj('wall_lantern', sx + 2, sy))
      } else if (dType === 'market' || dType === 'artisan') {
        // Workshop yard: well + barrels
        courtProps.push(this.createObj('well', cx, cy2))
        if (!buildingMap[sy][sx]) courtProps.push(this.createObj('barrel_stack', sx, sy))
      } else {
        // Residential: well + bench
        courtProps.push(this.createObj('well', cx, cy2))
        if (sx + 2 < w && sy + 2 < h) {
          courtProps.push(this.createObj('bench', sx, sy + 2))
        }
      }

      // Carve the passage — a 1-tile-wide opening through the open wall side
      const openSide = !topWall ? 'top' : !botWall ? 'bottom' : !leftWall ? 'left' : 'right'
      let px: number, py: number
      switch (openSide) {
        case 'top':    px = sx + 1; py = sy - 1; break
        case 'bottom': px = sx + 1; py = sy + 3; break
        case 'left':   px = sx - 1; py = sy + 1; break
        case 'right':  px = sx + 3; py = sy + 1; break
      }
      // Paint passage tiles
      if (px >= 0 && px < w && py >= 0 && py < h) {
        terrain[py][px] = 9 // dark cobblestone (narrow passage)
      }
    }

    return courtProps
  }

  // === TOWN WALLS ===
  private placeWalls(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    buildings: PlacedObject[], gates: PlacedObject[],
    rng: () => number
  ): PlacedObject[] {
    const walls: PlacedObject[] = []
    if (buildings.length < 10) return walls

    // Find bounding box of all buildings with margin
    let minX = w, minY = h, maxX = 0, maxY = 0
    for (const b of buildings) {
      const fp = this.getFootprint(b.definitionId)
      minX = Math.min(minX, b.x)
      minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + fp.w)
      maxY = Math.max(maxY, b.y + fp.h)
    }
    // Add margin
    minX = Math.max(1, minX - 2)
    minY = Math.max(1, minY - 2)
    maxX = Math.min(w - 2, maxX + 2)
    maxY = Math.min(h - 2, maxY + 2)

    const gateSet = new Set(gates.map(g => `${g.x},${g.y}`))
    const isGateNear = (x: number, y: number): boolean => {
      for (const g of gates) {
        if (Math.abs(g.x - x) < 4 && Math.abs(g.y - y) < 4) return true
      }
      return false
    }

    // Place walls along perimeter.
    // Horizontal edges (top/bottom) use stone_wall (fp 2x1, runs along X).
    // Vertical edges (left/right) use stone_wall_v (fp 1x2, runs along Y).
    // Both route to tmplWallSegment which renders a 2.2-tall crenellated
    // fortification — not a garden wall.
    const occupied = new Set<string>()
    const placeHorizontalWall = (x: number, y: number) => {
      const key = `${x},${y}`
      if (occupied.has(key) || x < 0 || x + 1 >= w || y < 0 || y >= h) return
      if (waterMap[y]?.[x] || isGateNear(x, y)) return
      occupied.add(key)
      occupied.add(`${x + 1},${y}`)
      walls.push(this.createObj('stone_wall', x, y, 0.3))
    }
    const placeVerticalWall = (x: number, y: number) => {
      const key = `${x},${y}`
      if (occupied.has(key) || x < 0 || x >= w || y < 0 || y + 1 >= h) return
      if (waterMap[y]?.[x] || isGateNear(x, y)) return
      occupied.add(key)
      occupied.add(`${x},${y + 1}`)
      walls.push(this.createObj('stone_wall_v', x, y, 0.3))
    }

    // Reserve the 2×2 corner tower footprints FIRST so wall segments
    // don't collide with them (the old code placed walls first, corner
    // towers second → overlap + gaps at corners).
    const cornerPositions = [
      { x: minX, y: minY },
      { x: maxX - 2, y: minY },
      { x: minX, y: maxY - 2 },
      { x: maxX - 2, y: maxY - 2 },
    ]
    for (const pos of cornerPositions) {
      if (pos.x < 0 || pos.x + 1 >= w || pos.y < 0 || pos.y + 1 >= h) continue
      if (waterMap[pos.y][pos.x]) continue
      walls.push(this.createObj('watchtower', pos.x, pos.y, 1.0))
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          occupied.add(`${pos.x + dx},${pos.y + dy}`)
        }
      }
    }

    // Now place walls between the corner towers. Walls step by 2 tiles
    // (matching stone_wall footprint 2x1 / stone_wall_v footprint 1x2).
    for (let x = minX + 2; x < maxX - 2; x += 2) {
      placeHorizontalWall(x, minY)
      placeHorizontalWall(x, maxY - 1)
    }
    for (let y = minY + 2; y < maxY - 2; y += 2) {
      placeVerticalWall(minX, y)
      placeVerticalWall(maxX - 1, y)
    }

    return walls
  }

  // === COUNTRYSIDE ===
  private placeCountryside(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    districtMap: number[][], terrainTiles: number[][],
    buildings: PlacedObject[], gates: PlacedObject[],
    noise: SimplexNoise, rng: () => number
  ): PlacedObject[] {
    const countryside: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, buildings, w, h)

    // Paint countryside terrain (unassigned tiles)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (districtMap[y][x] !== -1 || waterMap[y][x] || roadMap[y][x]) continue
        const n = noise.fbm(x * 0.08, y * 0.08, 2)
        terrainTiles[y][x] = n > 0.2 ? 1 : n > -0.1 ? 0 : 5 // dirt/grass/dark grass
      }
    }

    // Place windmills in open countryside
    let windmills = 0
    for (let attempt = 0; attempt < 50 && windmills < 2; attempt++) {
      const wx = Math.floor(rng() * (w - 6)) + 2
      const wy = Math.floor(rng() * (h - 6)) + 2
      if (districtMap[wy]?.[wx] !== -1) continue
      if (this.areaFree(occupied, wx, wy, 3, 3, w, h)) {
        countryside.push(this.createObj('windmill', wx, wy, 0))
        this.markArea(occupied, wx, wy, 3, 3, w, h)
        windmills++
      }
    }

    // Place farm fields near roads in countryside
    let farms = 0
    for (let attempt = 0; attempt < 80 && farms < 3; attempt++) {
      const fx = Math.floor(rng() * (w - 6)) + 2
      const fy = Math.floor(rng() * (h - 5)) + 2
      if (districtMap[fy]?.[fx] !== -1) continue
      if (!this.isRoadAdjacent(fx, fy, roadMap, w, h)) continue
      if (this.areaFree(occupied, fx, fy, 4, 3, w, h)) {
        countryside.push(this.createObj('farm_field', fx, fy, 0))
        this.markArea(occupied, fx, fy, 4, 3, w, h)
        farms++
      }
    }

    // Scatter orchard trees in groups
    for (let g = 0; g < 4; g++) {
      const gx = Math.floor(rng() * (w - 4)) + 2
      const gy = Math.floor(rng() * (h - 4)) + 2
      if (districtMap[gy]?.[gx] !== -1) continue
      for (let i = 0; i < 3 + Math.floor(rng() * 3); i++) {
        const tx = gx + Math.floor(rng() * 4)
        const ty = gy + Math.floor(rng() * 4)
        if (tx < w && ty < h && !occupied[ty][tx] && districtMap[ty]?.[tx] === -1) {
          countryside.push(this.createObj('orchard_tree', tx, ty, 0))
          occupied[ty][tx] = true
        }
      }
    }

    // Road markers along exit roads
    for (const gate of gates) {
      for (let d = 2; d < 6; d++) {
        const mx = gate.x + (gate.x < w / 2 ? -d : d)
        const my = gate.y
        if (mx >= 0 && mx < w && my >= 0 && my < h && !occupied[my][mx]) {
          countryside.push(this.createObj('road_marker', mx, my, 0))
          occupied[my][mx] = true
          break
        }
      }
    }

    return countryside
  }

  // === BUILDING-SPECIFIC PROPS ===
  private getBuildingSpecificProps(defId: string, rng: () => number): string[] {
    switch (defId) {
      case 'tavern': return ['barrel', 'barrel_stack', 'hanging_sign', ...(rng() > 0.5 ? ['cafe_table'] : [])]
      case 'inn': return ['hanging_sign', 'barrel', ...(rng() > 0.5 ? ['horse_post'] : ['cafe_table'])]
      case 'shop': return ['hanging_sign', rng() > 0.5 ? 'crate' : 'barrel']
      case 'bakery': return ['hanging_sign', 'barrel', ...(rng() > 0.5 ? ['woodpile'] : [])]
      case 'apothecary': return ['hanging_sign', 'potted_plant']
      case 'market_stall': return ['crate_stack', 'barrel']
      case 'covered_market': return ['crate', 'barrel', 'crate_stack']
      case 'warehouse': return ['crate_stack', 'barrel_stack', 'cart']
      case 'guild_hall': return ['hanging_sign', 'bench', ...(rng() > 0.5 ? ['statue'] : ['planter_box'])]
      case 'mansion': return ['potted_plant', 'planter_box', 'flower_box']
      case 'building_large': return rng() > 0.5 ? ['potted_plant', 'planter_box'] : ['flower_box']
      case 'balcony_house': return rng() > 0.5 ? ['flower_box'] : ['planter_box']
      case 'half_timber': return rng() > 0.5 ? ['flower_box', 'potted_plant'] : ['woodpile']
      case 'chapel': return ['statue', 'wall_lantern']
      case 'temple': return ['column', 'statue', 'wall_lantern']
      case 'tower': return ['wall_lantern']
      case 'watchtower': return ['wall_lantern', 'barrel']
      case 'bell_tower': return ['wall_lantern']
      case 'clock_tower': return ['bench', 'statue']
      default: return []
    }
  }

  // === COURTYARD DETECTION ===
  private detectAndPaintCourtyards(
    terrain: number[][], occupied: boolean[][], roadMap: boolean[][], waterMap: boolean[][],
    buildings: PlacedObject[], w: number, h: number, rng: () => number
  ): void {
    // Scan for enclosed open spaces surrounded by buildings on 3+ sides
    const buildingMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (const b of buildings) {
      const fp = this.getFootprint(b.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const bx = b.x + dx, by = b.y + dy
          if (bx < w && by < h) buildingMap[by][bx] = true
        }
      }
    }

    // Check 3x3 open patches for courtyard potential
    for (let y = 2; y < h - 4; y += 3) {
      for (let x = 2; x < w - 4; x += 3) {
        // Check if center 2x2 is free
        let centerFree = true
        for (let dy = 0; dy < 2 && centerFree; dy++) {
          for (let dx = 0; dx < 2 && centerFree; dx++) {
            if (buildingMap[y + dy]?.[x + dx] || waterMap[y + dy]?.[x + dx]) centerFree = false
          }
        }
        if (!centerFree) continue

        // Count building tiles on perimeter (3-tile ring around center)
        let buildingSides = 0
        const checkSide = (sx: number, sy: number, count: number, stepX: number, stepY: number) => {
          let found = 0
          for (let i = 0; i < count; i++) {
            if (buildingMap[sy + i * stepY]?.[sx + i * stepX]) found++
          }
          return found > 0 ? 1 : 0
        }
        buildingSides += checkSide(x - 1, y, 2, 0, 1) // left
        buildingSides += checkSide(x + 2, y, 2, 0, 1) // right
        buildingSides += checkSide(x, y - 1, 2, 1, 0) // top
        buildingSides += checkSide(x, y + 2, 2, 1, 0) // bottom

        if (buildingSides >= 3) {
          // Paint courtyard cobblestone
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              if (y + dy < h && x + dx < w && !roadMap[y + dy][x + dx]) {
                terrain[y + dy][x + dx] = 8 // cobblestone courtyard
              }
            }
          }
          // Place well or planter in courtyard center
          if (!occupied[y][x] && rng() > 0.4) {
            const courtItem = rng() > 0.5 ? 'well' : 'potted_plant'
            buildings.push(this.createObj(courtItem, x, y))
            occupied[y][x] = true
          }
        }
      }
    }
  }

  // === GRAND COURTYARDS ===
  // Intentional enclosed spaces with partial symmetry, arched entries,
  // central features, and colonnades. These are the soul of the town —
  // places to pause, gather, and breathe between dense building clusters.
  private generateGrandCourtyards(
    terrain: number[][], roadMap: boolean[][], waterMap: boolean[][],
    heightMap: number[][], buildings: PlacedObject[],
    districtMap: number[][], districts: District[],
    w: number, h: number, rng: () => number, noise: SimplexNoise
  ): PlacedObject[] {
    const props: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, buildings, w, h)

    const maxCourtyards = Math.floor(2 + districts.length * 0.8)
    let placed = 0

    for (const d of districts) {
      if (placed >= maxCourtyards) break
      // Not every district gets a courtyard — prefer noble, temple, garden
      const courtChance = d.type === 'noble' ? 0.8 : d.type === 'temple' ? 0.9
        : d.type === 'garden' ? 0.7 : d.type === 'market' ? 0.5
        : d.type === 'residential' ? 0.3 : 0.1
      if (rng() > courtChance) continue

      // Find a clear area near the district center for the courtyard
      // Courtyard size varies by district type
      const courtW = d.type === 'temple' ? 6 + Math.floor(rng() * 3)
        : d.type === 'noble' ? 5 + Math.floor(rng() * 3)
        : 4 + Math.floor(rng() * 2)
      const courtH = d.type === 'temple' ? 5 + Math.floor(rng() * 2)
        : 4 + Math.floor(rng() * 2)

      // Search near district center for clear space
      let cx = -1, cy = -1
      for (let attempt = 0; attempt < 40; attempt++) {
        const tx = d.center.x + Math.floor(rng() * 8) - 4
        const ty = d.center.y + Math.floor(rng() * 8) - 4
        if (tx < 2 || ty < 2 || tx + courtW >= w - 2 || ty + courtH >= h - 2) continue
        if (this.areaFree(occupied, tx, ty, courtW, courtH, w, h)) {
          cx = tx; cy = ty; break
        }
      }
      if (cx < 0) continue

      // === Paint courtyard ground ===
      for (let dy = 0; dy < courtH; dy++) {
        for (let dx = 0; dx < courtW; dx++) {
          const tx = cx + dx, ty = cy + dy
          if (d.type === 'temple') terrain[ty][tx] = 2 // stone
          else if (d.type === 'noble') terrain[ty][tx] = (dx + dy) % 2 === 0 ? 2 : 8 // checkerboard
          else if (d.type === 'garden') terrain[ty][tx] = dx === 0 || dx === courtW - 1 || dy === 0 || dy === courtH - 1 ? 13 : 12 // gravel border, wildflower center
          else terrain[ty][tx] = 8 // cobblestone
          roadMap[ty][tx] = true // walkable
        }
      }

      // === Surrounding buildings (U-shape or L-shape enclosure) ===
      // Place buildings along 2-3 sides to create enclosure
      const buildingSides = rng() > 0.3 ? 3 : 2 // U-shape or L-shape
      const sideConfigs = [
        { dir: 'top', bx: cx, by: cy - 2, bw: courtW, bh: 2 },
        { dir: 'left', bx: cx - 2, by: cy, bw: 2, bh: courtH },
        { dir: 'right', bx: cx + courtW, by: cy, bw: 2, bh: courtH },
        { dir: 'bottom', bx: cx, by: cy + courtH, bw: courtW, bh: 2 },
      ]
      // Shuffle and pick sides
      for (let si = sideConfigs.length - 1; si > 0; si--) {
        const sj = Math.floor(rng() * (si + 1))
        ;[sideConfigs[si], sideConfigs[sj]] = [sideConfigs[sj], sideConfigs[si]]
      }

      let wallsPlaced = 0
      for (const side of sideConfigs) {
        if (wallsPlaced >= buildingSides) break
        if (side.bx < 0 || side.by < 0 || side.bx + side.bw >= w || side.by + side.bh >= h) continue
        if (!this.areaFree(occupied, side.bx, side.by, side.bw, side.bh, w, h)) continue

        // Place a row of buildings along this side
        const buildingType = d.type === 'noble' ? 'building_medium' : d.type === 'temple' ? 'chapel'
          : rng() > 0.5 ? 'building_small' : 'row_house'
        const bfp = this.getFootprint(buildingType)

        let bx = side.bx
        while (bx + bfp.w <= side.bx + side.bw) {
          if (this.areaFree(occupied, bx, side.by, bfp.w, bfp.h, w, h)) {
            const elev = Math.min(Math.round((heightMap[side.by]?.[bx] ?? 0) * 2) / 2, 2)
            buildings.push({
              id: uuid(),
              definitionId: buildingType,
              x: bx, y: side.by,
              rotation: 0, scaleX: 1, scaleY: 1,
              elevation: elev,
              properties: {
                floors: d.type === 'noble' ? 2 + Math.floor(rng() * 2) : 1 + Math.floor(rng() * 2),
                district: d.type,
                style: d.type === 'noble' ? 'ornate' : 'standard',
              }
            })
            this.markArea(occupied, bx, side.by, bfp.w, bfp.h, w, h)
          }
          bx += bfp.w
        }
        wallsPlaced++
      }

      // === Courtyard entry — archway on the open side ===
      // Find an open side (no buildings placed) and put an archway
      for (const side of sideConfigs) {
        if (wallsPlaced > 0 && side.bx >= 0 && side.by >= 0) {
          const archX = cx + Math.floor(courtW / 2) - 1
          const archY = side.dir === 'top' ? cy - 1 : side.dir === 'bottom' ? cy + courtH : cy + Math.floor(courtH / 2)
          if (archX >= 0 && archX + 3 < w && archY >= 0 && archY < h && !occupied[archY][archX]) {
            props.push(this.createObj('archway', archX, archY, 0))
            break
          }
        }
      }

      // === Central feature (partial symmetry) ===
      const centerX = cx + Math.floor(courtW / 2)
      const centerY = cy + Math.floor(courtH / 2)

      if (d.type === 'temple') {
        // Symmetric: central statue + flanking columns
        if (!occupied[centerY][centerX]) {
          props.push(this.createObj('statue', centerX, centerY))
          occupied[centerY][centerX] = true
        }
        // Columns along one axis (partial symmetry — not mirror-perfect)
        for (let ci = -2; ci <= 2; ci += 2) {
          const colX = centerX + ci
          if (colX >= cx && colX < cx + courtW && !occupied[centerY - 1]?.[colX]) {
            props.push(this.createObj('column', colX, centerY - 1))
            occupied[centerY - 1][colX] = true
          }
        }
        // Wall lanterns at corners
        for (const [dx, dy] of [[0, 0], [courtW - 1, 0], [0, courtH - 1], [courtW - 1, courtH - 1]] as const) {
          if (!occupied[cy + dy][cx + dx]) {
            props.push(this.createObj('wall_lantern', cx + dx, cy + dy))
            occupied[cy + dy][cx + dx] = true
          }
        }
      } else if (d.type === 'noble' || d.type === 'garden') {
        // Fountain + symmetric planter boxes
        if (this.areaFree(occupied, centerX - 1, centerY - 1, 2, 2, w, h)) {
          props.push(this.createObj('fountain', centerX - 1, centerY - 1))
          this.markArea(occupied, centerX - 1, centerY - 1, 2, 2, w, h)
        }
        // Symmetric planters along the central axis
        for (const offset of [-2, 2]) {
          const px = centerX + offset
          if (px >= cx && px + 1 < cx + courtW) {
            if (!occupied[centerY]?.[px] && !occupied[centerY]?.[px + 1]) {
              props.push(this.createObj('planter_box', px, centerY))
              occupied[centerY][px] = true
              if (px + 1 < w) occupied[centerY][px + 1] = true
            }
          }
        }
        // Benches facing the fountain
        for (const [dx, dy] of [[2, 0], [-2, 0]] as const) {
          const bx = centerX + dx, by = centerY + 1
          if (bx >= cx && bx + 1 < cx + courtW && by < cy + courtH) {
            if (!occupied[by][bx] && !occupied[by][bx + 1]) {
              props.push(this.createObj('bench', bx, by))
              occupied[by][bx] = true
              occupied[by][bx + 1] = true
            }
          }
        }
      } else if (d.type === 'market') {
        // Market stalls in rows
        for (let mx = cx + 1; mx < cx + courtW - 2; mx += 3) {
          if (this.areaFree(occupied, mx, centerY, 2, 2, w, h)) {
            props.push(this.createObj('market_stall', mx, centerY))
            this.markArea(occupied, mx, centerY, 2, 2, w, h)
          }
        }
      } else {
        // Residential: well + tree
        if (!occupied[centerY][centerX]) {
          props.push(this.createObj('well', centerX, centerY))
          occupied[centerY][centerX] = true
        }
        if (centerX + 2 < cx + courtW && !occupied[centerY][centerX + 2]) {
          const treeObj = this.createObj('tree', centerX + 2, centerY)
          treeObj.properties = { species: 'oak' }
          props.push(treeObj)
          occupied[centerY][centerX + 2] = true
        }
      }

      this.markArea(occupied, cx, cy, courtW, courtH, w, h)
      placed++
    }

    return props
  }

  // === NATURAL PONDS ===
  // Organic water bodies at low elevation points — adds natural beauty
  private generateNaturalPonds(
    w: number, h: number, heightMap: number[][], waterMap: boolean[][],
    terrain: number[][], noise: SimplexNoise, rng: () => number
  ): void {
    // Find local minima in height map as pond candidates
    const numPonds = 1 + Math.floor(rng() * 3)
    let pondsPlaced = 0

    for (let attempt = 0; attempt < 60 && pondsPlaced < numPonds; attempt++) {
      const cx = 5 + Math.floor(rng() * (w - 10))
      const cy = 5 + Math.floor(rng() * (h - 10))
      const elev = heightMap[cy]?.[cx] ?? 1

      // Ponds form in low-lying areas
      if (elev > 0.8) continue

      // Check not already water
      if (waterMap[cy][cx]) continue

      // Organic shape using noise threshold
      const pondR = 2 + Math.floor(rng() * 2)
      let pondSize = 0

      for (let dy = -pondR - 1; dy <= pondR + 1; dy++) {
        for (let dx = -pondR - 1; dx <= pondR + 1; dx++) {
          const px = cx + dx, py = cy + dy
          if (px < 1 || px >= w - 1 || py < 1 || py >= h - 1) continue
          if (waterMap[py][px]) continue

          // Elliptical base + noise perturbation for organic shape
          const dist = Math.sqrt((dx * dx) / (pondR * pondR) + (dy * dy) / ((pondR * 0.8) * (pondR * 0.8)))
          const edgeNoise = noise.noise2D(px * 0.3 + 500, py * 0.3 + 500) * 0.3
          if (dist < 1.0 + edgeNoise) {
            waterMap[py][px] = true
            terrain[py][px] = 3 // water
            pondSize++
          } else if (dist < 1.3 + edgeNoise) {
            // Mud/sand shore
            terrain[py][px] = 11 // mud
          }
        }
      }

      if (pondSize > 2) pondsPlaced++
    }
  }

  // === PRIVATE GARDENS ===
  // Cozy enclosed spaces behind buildings — hedges, flower beds, fruit trees
  private plantPrivateGardens(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][], heightMap: number[][],
    buildings: PlacedObject[], districtMap: number[][], districts: District[],
    existingProps: PlacedObject[],
    terrain: number[][], rng: () => number, noise: SimplexNoise
  ): PlacedObject[] {
    const gardenProps: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, buildings, w, h)
    this.markObjects(occupied, existingProps, w, h)

    // For each building, check if there's open space "behind" it (away from road)
    for (const b of buildings) {
      const fp = this.getFootprint(b.definitionId)
      const dId = districtMap[b.y]?.[b.x] ?? -1
      const district = districts.find(d => d.id === dId)
      const dType = district?.type || 'residential'

      // Skip slum and fortress — they don't have gardens
      if (dType === 'slum' || dType === 'fortress' || dType === 'harbor') continue

      // Find which side faces AWAY from the nearest road (the "back")
      let bestDir = { dx: 0, dy: 1 } // default: south
      let maxRoadDist = 0
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
        const checkX = b.x + (dx === 1 ? fp.w : dx === -1 ? -1 : 0)
        const checkY = b.y + (dy === 1 ? fp.h : dy === -1 ? -1 : 0)
        if (checkX < 0 || checkX >= w || checkY < 0 || checkY >= h) continue
        if (roadMap[checkY]?.[checkX]) continue // This side faces road — not the back
        // Count distance to nearest road from this side
        let roadDist = 0
        for (let d = 1; d <= 4; d++) {
          const rx = checkX + dx * d, ry = checkY + dy * d
          if (rx >= 0 && rx < w && ry >= 0 && ry < h && roadMap[ry][rx]) { roadDist = d; break }
        }
        if (roadDist === 0) roadDist = 5
        if (roadDist > maxRoadDist) {
          maxRoadDist = roadDist
          bestDir = { dx, dy }
        }
      }

      // Try to carve a 2x2 or 3x2 garden behind the building
      const gardenW = 2 + (dType === 'noble' || dType === 'garden' ? 1 : 0)
      const gardenH = 2
      const gx = bestDir.dx === 1 ? b.x + fp.w : bestDir.dx === -1 ? b.x - gardenW : b.x
      const gy = bestDir.dy === 1 ? b.y + fp.h : bestDir.dy === -1 ? b.y - gardenH : b.y

      if (gx < 0 || gx + gardenW > w || gy < 0 || gy + gardenH > h) continue
      if (!this.areaFree(occupied, gx, gy, gardenW, gardenH, w, h)) continue

      // Acceptance probability based on district
      const gardenChance = dType === 'garden' ? 0.8 : dType === 'noble' ? 0.6 :
        dType === 'residential' ? 0.35 : dType === 'temple' ? 0.3 : 0.15
      if (rng() > gardenChance) continue

      // Paint garden ground
      for (let dy = 0; dy < gardenH; dy++) {
        for (let dx = 0; dx < gardenW; dx++) {
          const tx = gx + dx, ty = gy + dy
          if (tx < w && ty < h) {
            terrain[ty][tx] = dType === 'temple' ? 10 : 12 // mossy stone or wildflower
          }
        }
      }

      // Place garden features
      const centerX = gx + Math.floor(gardenW / 2)
      const centerY = gy + Math.floor(gardenH / 2)

      if (dType === 'garden' || dType === 'noble') {
        // Formal garden: central feature + hedges
        if (!occupied[centerY][centerX]) {
          const feature = rng() > 0.6 ? 'potted_plant' : rng() > 0.3 ? 'statue' : 'fountain'
          if (feature === 'fountain' && this.areaFree(occupied, centerX, centerY, 2, 2, w, h)) {
            gardenProps.push(this.createObj('fountain', centerX, centerY))
            this.markArea(occupied, centerX, centerY, 2, 2, w, h)
          } else {
            gardenProps.push(this.createObj(feature, centerX, centerY))
            occupied[centerY][centerX] = true
          }
        }
        // Hedges along garden boundary (1-2 sides)
        for (let hx = gx; hx < gx + gardenW - 1; hx += 2) {
          if (hx + 1 < w && gy > 0 && !occupied[gy][hx]) {
            gardenProps.push(this.createObj('bush', hx, gy))
            occupied[gy][hx] = true
          }
        }
      } else if (dType === 'residential') {
        // Kitchen garden: fruit tree + vegetable-suggesting ground
        if (!occupied[centerY][centerX]) {
          const fruitTree = this.createObj('tree', centerX, centerY)
          fruitTree.properties = { species: 'maple' } // fruit/ornamental tree
          gardenProps.push(fruitTree)
          occupied[centerY][centerX] = true
        }
        // Fence along one edge
        if (gx + 1 < w && !occupied[gy + gardenH - 1][gx]) {
          gardenProps.push(this.createObj('fence', gx, gy + gardenH - 1))
          occupied[gy + gardenH - 1][gx] = true
          if (gx + 1 < w) occupied[gy + gardenH - 1][gx + 1] = true
        }
      } else {
        // Temple/other: contemplative garden
        if (!occupied[centerY][centerX]) {
          gardenProps.push(this.createObj('potted_plant', centerX, centerY))
          occupied[centerY][centerX] = true
        }
      }

      // Mark garden area as occupied
      this.markArea(occupied, gx, gy, gardenW, gardenH, w, h)
    }

    return gardenProps
  }

  // === ORGANIC TERRAIN PAINTING ===
  // Rocky outcrops on hilltops, wildflower meadows in open areas, gravel transitions
  private paintOrganicTerrain(
    terrain: number[][], heightMap: number[][], waterMap: boolean[][],
    roadMap: boolean[][], districtMap: number[][], districts: District[],
    w: number, h: number, noise: SimplexNoise, rng: () => number
  ): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (waterMap[y][x] || roadMap[y][x]) continue
        const elev = heightMap[y]?.[x] ?? 0
        const tile = terrain[y][x]
        const n = noise.noise2D(x * 0.12 + 300, y * 0.12 + 300)

        // Rocky outcrops on high ground (elevation > 1.5)
        if (elev > 1.5 && n > 0.1 && (tile === 0 || tile === 1 || tile === 5)) {
          terrain[y][x] = 7 // rocky ground
          continue
        }

        // Wildflower meadows in garden districts and open grassland
        const dId = districtMap[y]?.[x] ?? -1
        const district = districts.find(d => d.id === dId)
        if (district?.type === 'garden' && tile === 0 && n > 0.15) {
          terrain[y][x] = 12 // wildflower meadow
          continue
        }

        // Wildflower patches in open grass far from roads
        if (tile === 0 || tile === 5) {
          let nearRoad = false
          for (let dy = -2; dy <= 2 && !nearRoad; dy++) {
            for (let dx = -2; dx <= 2 && !nearRoad; dx++) {
              if (roadMap[y + dy]?.[x + dx]) nearRoad = true
            }
          }
          if (!nearRoad && n > 0.35 && rng() > 0.6) {
            terrain[y][x] = 12 // scattered wildflower patches
          }
        }

        // Gravel transitions between stone/cobble and grass
        if (tile === 0 || tile === 5) {
          let nearStone = false
          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
            const t = terrain[y + dy]?.[x + dx]
            if (t === 2 || t === 8 || t === 9) nearStone = true
          }
          if (nearStone && n > 0.1) {
            terrain[y][x] = 13 // gravel transition
          }
        }
      }
    }
  }

  // === UTILITY METHODS ===

  private createObj(defId: string, x: number, y: number, elevation: number = 0): PlacedObject {
    return {
      id: uuid(),
      definitionId: defId,
      x, y,
      rotation: 0, scaleX: 1, scaleY: 1,
      elevation,
      properties: {}
    }
  }

  private createOccupied(w: number, h: number, roadMap: boolean[][], waterMap: boolean[][]): boolean[][] {
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (roadMap[y][x] || waterMap[y][x]) occupied[y][x] = true
      }
    }
    return occupied
  }

  private markObjects(occupied: boolean[][], objs: PlacedObject[], w: number, h: number): void {
    for (const obj of objs) {
      const fp = this.getFootprint(obj.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const bx = obj.x + dx, by = obj.y + dy
          if (bx < w && by < h && bx >= 0 && by >= 0) occupied[by][bx] = true
        }
      }
    }
  }

  private markBuildings(occupied: boolean[][], buildings: PlacedObject[], w: number, h: number): void {
    this.markObjects(occupied, buildings, w, h)
  }

  private markArea(occupied: boolean[][], x: number, y: number, aw: number, ah: number, w: number, h: number): void {
    for (let dy = 0; dy < ah; dy++) {
      for (let dx = 0; dx < aw; dx++) {
        if (y + dy < h && x + dx < w && y + dy >= 0 && x + dx >= 0) {
          occupied[y + dy][x + dx] = true
        }
      }
    }
  }

  private areaFree(occupied: boolean[][], x: number, y: number, aw: number, ah: number, w: number, h: number): boolean {
    for (let dy = 0; dy < ah; dy++) {
      for (let dx = 0; dx < aw; dx++) {
        const bx = x + dx, by = y + dy
        if (bx < 0 || bx >= w || by < 0 || by >= h || occupied[by][bx]) return false
      }
    }
    return true
  }

  private findFreeSpot(
    occupied: boolean[][], cx: number, cy: number,
    aw: number, ah: number, w: number, h: number, searchRadius: number
  ): { x: number; y: number } | null {
    for (let r = 0; r <= searchRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue // Only check perimeter
          const x = cx + dx, y = cy + dy
          if (this.areaFree(occupied, x, y, aw, ah, w, h)) {
            return { x, y }
          }
        }
      }
    }
    return null
  }

  private isRoadAdjacent(x: number, y: number, roadMap: boolean[][], w: number, h: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && roadMap[ny][nx]) return true
      }
    }
    return false
  }

  private getFootprint(defId: string): { w: number; h: number } {
    const footprints: Record<string, { w: number; h: number }> = {
      building_small: { w: 2, h: 2 }, building_medium: { w: 3, h: 3 },
      building_large: { w: 4, h: 3 }, tavern: { w: 4, h: 3 },
      shop: { w: 2, h: 3 }, tower: { w: 2, h: 2 },
      balcony_house: { w: 3, h: 2 }, archway: { w: 3, h: 1 },
      staircase: { w: 2, h: 3 }, row_house: { w: 1, h: 2 },
      town_gate: { w: 3, h: 1 }, corner_building: { w: 2, h: 2 },
      clock_tower: { w: 3, h: 3 }, bridge: { w: 4, h: 2 },
      water_channel: { w: 1, h: 4 }, market_stall: { w: 2, h: 2 },
      wagon: { w: 3, h: 2 }, fountain: { w: 2, h: 2 },
      bench: { w: 2, h: 1 }, fence: { w: 2, h: 1 },
      stone_wall: { w: 2, h: 1 }, planter_box: { w: 2, h: 1 },
      stone_wall_v: { w: 1, h: 2 }, crenellated_wall: { w: 2, h: 1 },
      // New buildings
      chapel: { w: 3, h: 4 }, guild_hall: { w: 4, h: 4 },
      warehouse: { w: 4, h: 3 }, watchtower: { w: 2, h: 2 },
      mansion: { w: 5, h: 4 }, bakery: { w: 2, h: 2 },
      apothecary: { w: 2, h: 3 }, inn: { w: 3, h: 3 },
      temple: { w: 5, h: 5 }, covered_market: { w: 4, h: 3 },
      bell_tower: { w: 2, h: 2 }, half_timber: { w: 3, h: 2 },
      narrow_house: { w: 1, h: 3 },
      // New props
      cart: { w: 2, h: 1 }, monument: { w: 2, h: 2 },
      cloth_line: { w: 2, h: 1 },
      // New world props
      dock: { w: 3, h: 1 }, crane: { w: 2, h: 2 },
      pier: { w: 4, h: 1 }, fishing_boat: { w: 2, h: 1 },
      gravestone: { w: 1, h: 1 }, iron_fence: { w: 2, h: 1 },
      windmill: { w: 3, h: 3 }, farm_field: { w: 4, h: 3 },
      road_marker: { w: 1, h: 1 },
      cathedral: { w: 5, h: 6 }, lighthouse: { w: 3, h: 3 },
      round_tower: { w: 2, h: 2 }, gatehouse: { w: 4, h: 2 },
      stable: { w: 4, h: 3 }, mill: { w: 3, h: 3 },
      bell_tower_tall: { w: 2, h: 2 }, aqueduct: { w: 5, h: 1 },
    }
    return footprints[defId] || { w: 1, h: 1 }
  }
}
