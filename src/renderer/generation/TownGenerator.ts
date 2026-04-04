import { v4 as uuid } from 'uuid'
import type { MapDocument, MapLayer, PlacedObject, GenerationConfig, EnvironmentState } from '../core/types'
import type { IMapGenerator } from './GeneratorRegistry'
import { createRNG, SimplexNoise, poissonDiskSampling, nearestPoint, perturbedDistance } from './noise'

// === District System ===

type DistrictType = 'market' | 'residential' | 'artisan' | 'noble' | 'waterfront' | 'temple' | 'slum' | 'garden'

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
    { id: 'row_house', w: 1, h: 2, weight: 3 },
    { id: 'tavern', w: 4, h: 3, weight: 2 },
    { id: 'building_small', w: 2, h: 2, weight: 2 },
    { id: 'archway', w: 3, h: 1, weight: 1 },
  ],
  residential: [
    { id: 'building_small', w: 2, h: 2, weight: 5 },
    { id: 'row_house', w: 1, h: 2, weight: 5 },
    { id: 'building_medium', w: 3, h: 3, weight: 3 },
    { id: 'balcony_house', w: 3, h: 2, weight: 3 },
    { id: 'building_large', w: 4, h: 3, weight: 1 },
  ],
  artisan: [
    { id: 'shop', w: 2, h: 3, weight: 5 },
    { id: 'building_small', w: 2, h: 2, weight: 4 },
    { id: 'row_house', w: 1, h: 2, weight: 4 },
    { id: 'corner_building', w: 2, h: 2, weight: 2 },
    { id: 'staircase', w: 2, h: 3, weight: 1 },
  ],
  noble: [
    { id: 'building_large', w: 4, h: 3, weight: 5 },
    { id: 'building_medium', w: 3, h: 3, weight: 4 },
    { id: 'balcony_house', w: 3, h: 2, weight: 3 },
    { id: 'tower', w: 2, h: 2, weight: 2 },
    { id: 'archway', w: 3, h: 1, weight: 1 },
  ],
  waterfront: [
    { id: 'building_small', w: 2, h: 2, weight: 4 },
    { id: 'shop', w: 2, h: 3, weight: 4 },
    { id: 'row_house', w: 1, h: 2, weight: 3 },
    { id: 'building_medium', w: 3, h: 3, weight: 2 },
    { id: 'tavern', w: 4, h: 3, weight: 2 },
  ],
  temple: [
    { id: 'tower', w: 2, h: 2, weight: 5 },
    { id: 'building_large', w: 4, h: 3, weight: 4 },
    { id: 'building_medium', w: 3, h: 3, weight: 3 },
    { id: 'archway', w: 3, h: 1, weight: 2 },
    { id: 'staircase', w: 2, h: 3, weight: 2 },
  ],
  slum: [
    { id: 'row_house', w: 1, h: 2, weight: 8 },
    { id: 'building_small', w: 2, h: 2, weight: 5 },
    { id: 'corner_building', w: 2, h: 2, weight: 2 },
    { id: 'shop', w: 2, h: 3, weight: 1 },
  ],
  garden: [
    { id: 'balcony_house', w: 3, h: 2, weight: 4 },
    { id: 'building_medium', w: 3, h: 3, weight: 3 },
    { id: 'building_small', w: 2, h: 2, weight: 2 },
    { id: 'building_large', w: 4, h: 3, weight: 1 },
  ],
}

// District-specific prop palettes
const DISTRICT_PROPS: Record<DistrictType, string[]> = {
  market: ['market_stall', 'crate', 'crate_stack', 'barrel', 'hanging_sign', 'wagon', 'sign', 'cafe_table'],
  residential: ['potted_plant', 'bench', 'well', 'fence', 'planter_box'],
  artisan: ['barrel', 'crate', 'barrel_stack', 'sign', 'fence', 'crate_stack'],
  noble: ['potted_plant', 'planter_box', 'bench', 'statue', 'fountain', 'wall_lantern'],
  waterfront: ['barrel', 'crate', 'wagon', 'sign', 'bench', 'crate_stack'],
  temple: ['statue', 'potted_plant', 'stone_wall', 'wall_lantern'],
  slum: ['barrel', 'crate', 'barrel_stack'],
  garden: ['potted_plant', 'planter_box', 'bench', 'fountain', 'bush', 'tree'],
}

// District density multipliers
const DISTRICT_DENSITY: Record<DistrictType, number> = {
  market: 1.1, residential: 0.9, artisan: 1.0, noble: 0.7,
  waterfront: 0.8, temple: 0.6, slum: 1.3, garden: 0.4,
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

    // 4. District system (Voronoi-based)
    const districts = this.generateDistricts(width, height, complexity, rng, noise, waterMap)
    const districtMap = this.assignDistrictMap(width, height, districts, noise)

    // 5. Paint district-specific terrain
    this.paintDistrictTerrain(terrainTiles, districtMap, districts, width, height, noise, waterMap)

    // 6. Central plaza + district plazas
    const mainCenter = districts.length > 0 ? districts[0].center : { x: Math.floor(width / 2), y: Math.floor(height / 2) }
    const plazaRadius = Math.floor(3 + complexity * 3)
    this.carvePlaza(terrainTiles, mainCenter.x, mainCenter.y, plazaRadius, width, height, 2)

    for (let i = 1; i < districts.length; i++) {
      const r = Math.floor(2 + complexity * 1.5)
      this.carvePlaza(terrainTiles, districts[i].center.x, districts[i].center.y, r, width, height, 8)
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
      complexity, density, rng, mainCenter
    )

    // 10. Place landmarks
    const landmarks = this.placeLandmarks(
      width, height, roadMap, waterMap, districts, districtMap, buildings,
      complexity, rng, mainCenter
    )

    // 11. Carve alleys between building clusters
    this.carveAlleys(terrainTiles, [...buildings, ...landmarks], width, height)

    // 12. Place town gates at map edges where roads exit
    const gates = this.placeGates(width, height, roadMap, rng)

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
      [...buildings, ...landmarks, ...gates, ...props, ...lights], density, rng
    )

    // 16. Vegetation with district awareness
    const vegetation = this.placeVegetation(
      width, height, roadMap, waterMap,
      [...buildings, ...landmarks, ...gates, ...props, ...lights, ...plazaProps],
      districtMap, districts, density, rng, noise
    )

    // Build layers
    const allStructures = [...buildings, ...landmarks, ...gates, ...bridges]
    const allProps = [...props, ...lights, ...plazaProps, ...vegetation]

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
  private generateHeightMap(w: number, h: number, noise: SimplexNoise): number[][] {
    const map: number[][] = []
    for (let y = 0; y < h; y++) {
      const row: number[] = []
      for (let x = 0; x < w; x++) {
        const n = noise.fbm(x * 0.03, y * 0.03, 2, 2, 0.5)
        row.push(Math.max(0, (n + 0.5) * 1.5))
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
        const n = noise.fbm(x * 0.06, y * 0.06, 3)
        if (n < -0.25) row.push(5)       // dark grass
        else if (n < 0.15) row.push(0)   // grass
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
      'market', 'residential', 'artisan', 'noble', 'waterfront', 'temple', 'slum', 'garden'
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

        switch (d.type) {
          case 'noble':
            if (n > 0.3) terrain[y][x] = 2 // stone paths
            else if (n > 0) terrain[y][x] = 0 // grass courtyards
            break
          case 'garden':
            if (n > 0.4) terrain[y][x] = 5 // dark grass
            else terrain[y][x] = 0 // grass
            break
          case 'waterfront':
            if (n > 0.2) terrain[y][x] = 4 // sand
            else terrain[y][x] = 1 // dirt
            break
          case 'slum':
            if (n > 0.1) terrain[y][x] = 1 // dirt
            else terrain[y][x] = 5 // dark grass
            break
          case 'temple':
            if (n > 0.2) terrain[y][x] = 2 // stone
            break
          // market, residential, artisan keep base terrain
        }
      }
    }
  }


  // === PLAZA ===
  private carvePlaza(
    terrain: number[][], cx: number, cy: number, radius: number,
    w: number, h: number, tilePrimary: number
  ): void {
    for (let y = cy - radius - 1; y <= cy + radius + 1; y++) {
      for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
        if (x < 0 || x >= w || y < 0 || y >= h) continue
        const dx = x - cx, dy = y - cy
        const dist = Math.sqrt(dx * dx + dy * dy)
        const edgeNoise = Math.sin(Math.atan2(dy, dx) * 5) * 0.8
        if (dist < radius + edgeNoise) {
          if (dist < radius * 0.6) {
            terrain[y][x] = tilePrimary // center tile
          } else {
            terrain[y][x] = (x + y) % 4 === 0 ? 9 : 8 // cobblestone edge
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

    // BOULEVARDS: Connect main center to each district center (width 4)
    for (const d of districts) {
      this.carveRoad(roadMap, terrain, center.x, center.y, d.center.x, d.center.y,
        w, h, 4, 0.1, noise, rng, waterMap)
    }

    // MAIN STREETS: Radiate from center with curves (width 3)
    const numMain = Math.floor(5 + complexity * 6)
    for (let i = 0; i < numMain; i++) {
      const angle = (i / numMain) * Math.PI * 2 + (rng() - 0.5) * 0.3
      const length = Math.floor(w * 0.3 + rng() * w * 0.2)
      this.carveOrganicPath(roadMap, terrain, center.x, center.y, angle,
        w, h, length, 3, 0.15, noise, rng, waterMap)
    }

    // LANES: Connect districts to each other (width 2)
    for (let i = 0; i < districts.length; i++) {
      for (let j = i + 1; j < districts.length; j++) {
        const dx = districts[i].center.x - districts[j].center.x
        const dy = districts[i].center.y - districts[j].center.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        // Only connect nearby districts
        if (dist < Math.min(w, h) * 0.5) {
          this.carveRoad(roadMap, terrain, districts[i].center.x, districts[i].center.y,
            districts[j].center.x, districts[j].center.y, w, h, 2, 0.2, noise, rng, waterMap)
        }
      }
    }

    // SECONDARY STREETS within districts (width 2)
    const numSecondary = Math.floor(4 + complexity * 12)
    for (let i = 0; i < numSecondary; i++) {
      const sx = Math.floor(w * 0.08 + rng() * w * 0.84)
      const sy = Math.floor(h * 0.08 + rng() * h * 0.84)
      if (waterMap[sy]?.[sx]) continue
      const angle = rng() * Math.PI * 2
      this.carveOrganicPath(roadMap, terrain, sx, sy, angle,
        w, h, Math.floor(6 + rng() * 12), 2, 0.25, noise, rng, waterMap)
    }

    // ALLEYS branching off roads (width 1)
    if (complexity > 0.2) {
      const numAlleys = Math.floor(8 + complexity * 18)
      for (let i = 0; i < numAlleys; i++) {
        const bx = Math.floor(rng() * w)
        const by = Math.floor(rng() * h)
        if (bx >= 0 && bx < w && by >= 0 && by < h && roadMap[by][bx]) {
          const angle = rng() * Math.PI * 2
          this.carveOrganicPath(roadMap, terrain, bx, by, angle,
            w, h, Math.floor(3 + rng() * 5), 1, 0.35, noise, rng, waterMap)
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
    rng: () => number, center: { x: number; y: number }
  ): PlacedObject[] {
    const buildings: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    const maxDist = Math.sqrt(w * w + h * h) / 2

    // Per-district building placement
    const maxBuildings = Math.floor(30 + complexity * 60 + density * 40)
    let placed = 0
    let attempts = 0
    const maxAttempts = maxBuildings * 60

    while (placed < maxBuildings && attempts < maxAttempts) {
      attempts++

      const rx = Math.floor(rng() * (w - 6)) + 3
      const ry = Math.floor(rng() * (h - 6)) + 3
      if (!this.isRoadAdjacent(rx, ry, roadMap, w, h)) continue
      if (occupied[ry]?.[rx]) continue

      // Get district for this tile
      const dId = districtMap[ry]?.[rx] ?? -1
      const district = districts.find(d => d.id === dId)
      const types = district ? DISTRICT_BUILDINGS[district.type] : DISTRICT_BUILDINGS.residential
      const distDensity = district ? district.buildingDensity : 0.8

      // Density gradient: center denser, edges sparser
      const distFromCenter = Math.sqrt((rx - center.x) ** 2 + (ry - center.y) ** 2)
      const distNorm = distFromCenter / maxDist
      const acceptChance = distDensity * (1.0 - distNorm * 0.6) * density
      if (rng() > acceptChance) continue

      // Weighted random building type
      const totalWeight = types.reduce((s, t) => s + t.weight, 0)
      let roll = rng() * totalWeight
      let type = types[0]
      for (const t of types) {
        roll -= t.weight
        if (roll <= 0) { type = t; break }
      }

      const bw = type.w, bh = type.h
      if (rx + bw > w - 1 || ry + bh > h - 1) continue

      // Check if area is free (NO buffer for shared walls)
      let free = true
      for (let dy = 0; dy < bh && free; dy++) {
        for (let dx = 0; dx < bw && free; dx++) {
          if (occupied[ry + dy]?.[rx + dx]) free = false
        }
      }
      if (!free) continue

      // Height rhythm: alternate floors for interesting rooflines
      const heightVal = heightMap[ry]?.[rx] ?? 0
      const baseFloors = 1 + Math.floor(rng() * 2)
      const centerBonus = distNorm < 0.3 ? 1 : 0
      const floors = Math.min(baseFloors + centerBonus, 3)
      const elevation = Math.min(Math.round(heightVal * 2) / 2, 2)

      buildings.push({
        id: uuid(),
        definitionId: type.id,
        x: rx, y: ry,
        rotation: 0, scaleX: 1, scaleY: 1,
        elevation,
        properties: { floors, district: district?.type || 'none' }
      })

      for (let dy = 0; dy < bh; dy++) {
        for (let dx = 0; dx < bw; dx++) {
          if (ry + dy < h && rx + dx < w) occupied[ry + dy][rx + dx] = true
        }
      }
      placed++
    }

    // === FILL PASS: Row houses to plug gaps for continuous frontage ===
    const fillMax = Math.floor(maxBuildings * 0.5)
    let filled = 0
    for (let y = 3; y < h - 3 && filled < fillMax; y++) {
      for (let x = 3; x < w - 2 && filled < fillMax; x++) {
        if (occupied[y][x] || !this.isRoadAdjacent(x, y, roadMap, w, h)) continue

        const distFromC = Math.sqrt((x - center.x) ** 2 + (y - center.y) ** 2) / maxDist
        if (distFromC > 0.55) continue // only fill in inner portion

        if (y + 1 < h && !occupied[y + 1][x]) {
          buildings.push({
            id: uuid(),
            definitionId: 'row_house',
            x, y, rotation: 0, scaleX: 1, scaleY: 1,
            elevation: Math.min(Math.round((heightMap[y]?.[x] ?? 0) * 2) / 2, 2),
            properties: { floors: 1 + Math.floor(rng() * 2) }
          })
          occupied[y][x] = true
          occupied[y + 1][x] = true
          filled++
        }
      }
    }

    return buildings
  }


  // === LANDMARKS ===
  private placeLandmarks(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    districts: District[], districtMap: number[][],
    buildings: PlacedObject[],
    complexity: number, rng: () => number,
    center: { x: number; y: number }
  ): PlacedObject[] {
    const landmarks: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markBuildings(occupied, buildings, w, h)

    // Clock tower in noble/temple district
    for (const d of districts) {
      if (d.type === 'noble' || d.type === 'temple') {
        const spot = this.findFreeSpot(occupied, d.center.x, d.center.y, 3, 3, w, h, 8)
        if (spot) {
          landmarks.push(this.createObj('clock_tower', spot.x, spot.y, 2))
          this.markArea(occupied, spot.x, spot.y, 3, 3, w, h)
          break
        }
      }
    }

    // Tavern near market center
    for (const d of districts) {
      if (d.type === 'market') {
        const spot = this.findFreeSpot(occupied, d.center.x, d.center.y, 4, 3, w, h, 8)
        if (spot) {
          landmarks.push(this.createObj('tavern', spot.x, spot.y, 0.5))
          this.markArea(occupied, spot.x, spot.y, 4, 3, w, h)
          break
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

    // Staircases where height changes significantly (near district boundaries)
    if (complexity > 0.4) {
      let staircasesPlaced = 0
      for (let attempt = 0; attempt < 30 && staircasesPlaced < 3; attempt++) {
        const sx = Math.floor(3 + rng() * (w - 8))
        const sy = Math.floor(3 + rng() * (h - 8))
        if (this.isRoadAdjacent(sx, sy, roadMap, w, h) && !occupied[sy][sx]) {
          const spot = this.findFreeSpot(occupied, sx, sy, 2, 3, w, h, 3)
          if (spot) {
            landmarks.push(this.createObj('staircase', spot.x, spot.y, 0))
            this.markArea(occupied, spot.x, spot.y, 2, 3, w, h)
            staircasesPlaced++
          }
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

  // === ALLEYS BETWEEN BUILDINGS ===
  private carveAlleys(terrain: number[][], buildings: PlacedObject[], w: number, h: number): void {
    const buildingMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (const b of buildings) {
      // Use approximate footprint based on known definitions
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

        if ((leftB && rightB) || (topB && botB)) {
          terrain[y][x] = 9 // dark cobblestone for alleys
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

      const numProps = Math.min(validSpots.length, 1 + Math.floor(rng() * 2 * density))
      const dId = districtMap[b.y]?.[b.x] ?? -1
      const district = districts.find(d => d.id === dId)
      const propPalette = district ? DISTRICT_PROPS[district.type] : DISTRICT_PROPS.residential

      for (let i = 0; i < numProps; i++) {
        const idx = Math.floor(rng() * validSpots.length)
        const spot = validSpots.splice(idx, 1)[0]
        if (spot) {
          const propId = propPalette[Math.floor(rng() * propPalette.length)]
          // Skip 2x2 props (fountain, market_stall) in tight spots
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

    // Scatter street furniture on roads
    const streetFurnitureCount = Math.floor(density * w * h * 0.006)
    const streetItems = ['cafe_table', 'bench', 'sign', 'hanging_sign', 'barrel', 'crate']
    for (let i = 0; i < streetFurnitureCount; i++) {
      const x = Math.floor(rng() * w)
      const y = Math.floor(rng() * h)
      if (this.isRoadAdjacent(x, y, roadMap, w, h) && !occupied[y]?.[x] && !roadMap[y]?.[x]) {
        place(streetItems[Math.floor(rng() * streetItems.length)], x, y)
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
            const lightType = count % 5 === 0 ? 'street_lamp_double'
              : count % 3 === 0 ? 'wall_lantern' : 'lamppost'
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
    density: number, rng: () => number
  ): PlacedObject[] {
    const props: PlacedObject[] = []
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    this.markObjects(occupied, existingObjs, w, h)

    // Fountain at main center
    if (this.areaFree(occupied, center.x - 1, center.y - 1, 2, 2, w, h)) {
      props.push(this.createObj('fountain', center.x - 1, center.y - 1))
      this.markArea(occupied, center.x - 1, center.y - 1, 2, 2, w, h)
    }

    // Statue near center
    const sx = center.x + Math.floor(rng() * 4) - 2
    const sy = center.y + Math.floor(rng() * 4) - 2
    if (sx >= 0 && sx < w && sy >= 0 && sy < h && !occupied[sy][sx]) {
      props.push(this.createObj('statue', sx, sy))
      occupied[sy][sx] = true
    }

    // Market stalls around main plaza
    const stallCount = Math.floor(2 + density * 4)
    for (let i = 0; i < stallCount; i++) {
      const mx = center.x + Math.floor(rng() * plazaRadius * 2) - plazaRadius
      const my = center.y + Math.floor(rng() * plazaRadius * 2) - plazaRadius
      if (this.areaFree(occupied, mx, my, 2, 2, w, h)) {
        props.push(this.createObj('market_stall', mx, my))
        this.markArea(occupied, mx, my, 2, 2, w, h)
      }
    }

    // District plaza features
    for (const d of districts) {
      if (d.type === 'garden') {
        // Fountain in garden district
        const fx = d.center.x - 1, fy = d.center.y - 1
        if (this.areaFree(occupied, fx, fy, 2, 2, w, h)) {
          props.push(this.createObj('fountain', fx, fy))
          this.markArea(occupied, fx, fy, 2, 2, w, h)
        }
      } else if (d.type === 'temple') {
        // Statues in temple district
        for (let i = 0; i < 2; i++) {
          const tx = d.center.x + Math.floor(rng() * 4) - 2
          const ty = d.center.y + Math.floor(rng() * 4) - 2
          if (tx >= 0 && tx < w && ty >= 0 && ty < h && !occupied[ty][tx]) {
            props.push(this.createObj('statue', tx, ty))
            occupied[ty][tx] = true
          }
        }
      } else if (d.type === 'residential') {
        // Well in residential
        const wx = d.center.x + Math.floor(rng() * 3) - 1
        const wy = d.center.y + Math.floor(rng() * 3) - 1
        if (wx >= 0 && wx < w && wy >= 0 && wy < h && !occupied[wy][wx]) {
          props.push(this.createObj('well', wx, wy))
          occupied[wy][wx] = true
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
    density: number, rng: () => number, noise: SimplexNoise
  ): PlacedObject[] {
    const vegetation: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, existingObjs, w, h)

    // Poisson disk for natural tree distribution
    const minDist = Math.max(2, Math.floor(4 - density * 2))
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
            shouldPlace = vegNoise > -0.3 // Dense vegetation
            break
          case 'noble':
            // Hedgerow bushes along paths, occasional tree
            shouldPlace = vegNoise > 0.1
            isTree = rng() > 0.6
            break
          case 'residential':
            shouldPlace = vegNoise > 0.15
            break
          case 'slum':
            shouldPlace = vegNoise > 0.4 // Very sparse
            isTree = rng() > 0.7
            break
          case 'waterfront':
            shouldPlace = vegNoise > 0.25
            break
          default:
            shouldPlace = vegNoise > 0.2 - density * 0.15
            break
        }
      } else {
        shouldPlace = vegNoise > 0.1
      }

      if (shouldPlace) {
        vegetation.push(this.createObj(isTree ? 'tree' : 'bush', tx, ty))
        occupied[ty][tx] = true
      }
    }

    // Extra tree-lined boulevards: trees along wide roads (every 3-4 tiles)
    for (let y = 2; y < h - 2; y += 3) {
      for (let x = 2; x < w - 2; x += 3) {
        if (!roadMap[y][x]) continue
        // Check if this is a wide road (boulevard)
        let roadCount = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (roadMap[y + dy]?.[x + dx]) roadCount++
          }
        }
        if (roadCount < 6) continue // Not a boulevard

        // Place tree on adjacent non-road, non-occupied tile
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

    return vegetation
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
    }
    return footprints[defId] || { w: 1, h: 1 }
  }
}
