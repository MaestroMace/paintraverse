import { v4 as uuid } from 'uuid'
import type { MapDocument, MapLayer, PlacedObject, GenerationConfig, EnvironmentState } from '../core/types'
import type { IMapGenerator } from './GeneratorRegistry'
import { createRNG, SimplexNoise, poissonDiskSampling } from './noise'

export class TownGenerator implements IMapGenerator {
  readonly type = 'town'
  readonly displayName = 'Town'
  readonly description = 'Generates a town with streets, buildings, and props'

  generate(config: GenerationConfig): MapDocument {
    const { width, height, seed, complexity, density } = config
    const rng = createRNG(seed)
    const noise = new SimplexNoise(seed)

    // Create terrain
    const terrainTiles = this.generateTerrain(width, height, noise)

    // Generate road network
    const roads = this.generateRoads(width, height, complexity, rng)
    this.carveRoads(terrainTiles, roads, width, height)

    // Generate building parcels
    const parcels = this.generateParcels(width, height, roads, complexity, rng)

    // Place buildings
    const buildings = this.placeBuildings(parcels, density, rng, width, height)

    // Scatter props
    const props = this.scatterProps(width, height, roads, buildings, density, config.assetFrequencies, rng)

    // Scatter vegetation
    const vegetation = this.scatterVegetation(width, height, roads, buildings, density, rng, noise)

    // Create layers
    const terrainLayer: MapLayer = {
      id: uuid(),
      name: 'Terrain',
      type: 'terrain',
      visible: true,
      locked: false,
      objects: [],
      terrainTiles
    }

    const structureLayer: MapLayer = {
      id: uuid(),
      name: 'Structures',
      type: 'structure',
      visible: true,
      locked: false,
      objects: buildings
    }

    const propLayer: MapLayer = {
      id: uuid(),
      name: 'Props',
      type: 'prop',
      visible: true,
      locked: false,
      objects: [...props, ...vegetation]
    }

    const defaultEnv: EnvironmentState = {
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

    return {
      id: uuid(),
      name: `Town (seed: ${seed})`,
      version: 1,
      gridWidth: width,
      gridHeight: height,
      tileSize: 32,
      layers: [terrainLayer, structureLayer, propLayer],
      environment: defaultEnv,
      cameras: [],
      generationConfig: config
    }
  }

  private generateTerrain(w: number, h: number, noise: SimplexNoise): number[][] {
    const tiles: number[][] = []
    for (let y = 0; y < h; y++) {
      const row: number[] = []
      for (let x = 0; x < w; x++) {
        const n = noise.fbm(x * 0.05, y * 0.05, 3)
        // Mostly grass with some variation
        if (n < -0.3) row.push(5)       // dark grass
        else if (n < 0.2) row.push(0)   // grass
        else if (n < 0.4) row.push(1)   // dirt patches
        else row.push(0)                 // grass
      }
      tiles.push(row)
    }
    return tiles
  }

  private generateRoads(
    w: number, h: number, complexity: number, rng: () => number
  ): { x1: number; y1: number; x2: number; y2: number; width: number }[] {
    const roads: { x1: number; y1: number; x2: number; y2: number; width: number }[] = []
    const numMainRoads = Math.floor(2 + complexity * 4)
    const margin = 3

    // Main horizontal roads
    const hCount = Math.ceil(numMainRoads / 2)
    for (let i = 0; i < hCount; i++) {
      const y = margin + Math.floor(rng() * (h - margin * 2))
      roads.push({ x1: 0, y1: y, x2: w - 1, y2: y, width: 2 })
    }

    // Main vertical roads
    const vCount = Math.floor(numMainRoads / 2)
    for (let i = 0; i < vCount; i++) {
      const x = margin + Math.floor(rng() * (w - margin * 2))
      roads.push({ x1: x, y1: 0, x2: x, y2: h - 1, width: 2 })
    }

    // Secondary roads (connecting, shorter)
    if (complexity > 0.3) {
      const numSecondary = Math.floor(complexity * 6)
      for (let i = 0; i < numSecondary; i++) {
        const horizontal = rng() > 0.5
        if (horizontal) {
          const y = margin + Math.floor(rng() * (h - margin * 2))
          const x1 = Math.floor(rng() * w * 0.3)
          const x2 = Math.floor(w * 0.7 + rng() * w * 0.3)
          roads.push({ x1, y1: y, x2, y2: y, width: 1 })
        } else {
          const x = margin + Math.floor(rng() * (w - margin * 2))
          const y1 = Math.floor(rng() * h * 0.3)
          const y2 = Math.floor(h * 0.7 + rng() * h * 0.3)
          roads.push({ x1: x, y1, x2: x, y2, width: 1 })
        }
      }
    }

    return roads
  }

  private carveRoads(
    terrain: number[][],
    roads: { x1: number; y1: number; x2: number; y2: number; width: number }[],
    w: number, h: number
  ): void {
    for (const road of roads) {
      if (road.y1 === road.y2) {
        // Horizontal
        const minX = Math.max(0, Math.min(road.x1, road.x2))
        const maxX = Math.min(w - 1, Math.max(road.x1, road.x2))
        for (let x = minX; x <= maxX; x++) {
          for (let dy = 0; dy < road.width; dy++) {
            const y = road.y1 + dy
            if (y >= 0 && y < h) terrain[y][x] = (x + y) % 3 === 0 ? 9 : 8 // varied cobblestone
          }
        }
      } else {
        // Vertical
        const minY = Math.max(0, Math.min(road.y1, road.y2))
        const maxY = Math.min(h - 1, Math.max(road.y1, road.y2))
        for (let y = minY; y <= maxY; y++) {
          for (let dx = 0; dx < road.width; dx++) {
            const x = road.x1 + dx
            if (x >= 0 && x < w) terrain[y][x] = (x + y) % 3 === 0 ? 9 : 8 // varied cobblestone
          }
        }
      }
    }
  }

  private generateParcels(
    w: number, h: number,
    roads: { x1: number; y1: number; x2: number; y2: number; width: number }[],
    complexity: number,
    rng: () => number
  ): { x: number; y: number; w: number; h: number }[] {
    const parcels: { x: number; y: number; w: number; h: number }[] = []

    // Create an occupancy grid
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))

    // Mark roads as occupied
    for (const road of roads) {
      if (road.y1 === road.y2) {
        const minX = Math.max(0, Math.min(road.x1, road.x2))
        const maxX = Math.min(w - 1, Math.max(road.x1, road.x2))
        for (let x = minX; x <= maxX; x++) {
          for (let dy = -1; dy <= road.width; dy++) {
            const y = road.y1 + dy
            if (y >= 0 && y < h) occupied[y][x] = true
          }
        }
      } else {
        const minY = Math.max(0, Math.min(road.y1, road.y2))
        const maxY = Math.min(h - 1, Math.max(road.y1, road.y2))
        for (let y = minY; y <= maxY; y++) {
          for (let dx = -1; dx <= road.width; dx++) {
            const x = road.x1 + dx
            if (x >= 0 && x < w) occupied[y][x] = true
          }
        }
      }
    }

    // Try to place parcels near roads
    const maxParcels = Math.floor(8 + complexity * 30)
    let attempts = 0
    while (parcels.length < maxParcels && attempts < maxParcels * 10) {
      attempts++
      const pw = 2 + Math.floor(rng() * 3) // 2-4 tiles wide
      const ph = 2 + Math.floor(rng() * 2) // 2-3 tiles tall
      const px = Math.floor(rng() * (w - pw))
      const py = Math.floor(rng() * (h - ph))

      // Check if area is free
      let free = true
      for (let dy = 0; dy < ph && free; dy++) {
        for (let dx = 0; dx < pw && free; dx++) {
          if (occupied[py + dy]?.[px + dx]) free = false
        }
      }
      if (!free) continue

      // Check adjacency to road (within 2 tiles)
      let nearRoad = false
      for (let dy = -2; dy <= ph + 1 && !nearRoad; dy++) {
        for (let dx = -2; dx <= pw + 1 && !nearRoad; dx++) {
          const cx = px + dx
          const cy = py + dy
          if (cx >= 0 && cx < w && cy >= 0 && cy < h) {
            // Check if this cell is a road
            for (const road of roads) {
              if (road.y1 === road.y2) {
                if (cy >= road.y1 && cy < road.y1 + road.width &&
                    cx >= Math.min(road.x1, road.x2) && cx <= Math.max(road.x1, road.x2)) {
                  nearRoad = true
                }
              } else {
                if (cx >= road.x1 && cx < road.x1 + road.width &&
                    cy >= Math.min(road.y1, road.y2) && cy <= Math.max(road.y1, road.y2)) {
                  nearRoad = true
                }
              }
            }
          }
        }
      }
      if (!nearRoad) continue

      parcels.push({ x: px, y: py, w: pw, h: ph })

      // Mark as occupied (with 1-tile buffer)
      for (let dy = -1; dy <= ph; dy++) {
        for (let dx = -1; dx <= pw; dx++) {
          const cx = px + dx
          const cy = py + dy
          if (cx >= 0 && cx < w && cy >= 0 && cy < h) {
            occupied[cy][cx] = true
          }
        }
      }
    }

    return parcels
  }

  private placeBuildings(
    parcels: { x: number; y: number; w: number; h: number }[],
    _density: number,
    rng: () => number,
    width: number,
    height: number
  ): PlacedObject[] {
    const buildings: PlacedObject[] = []

    // Building types by size category
    const large4x3 = ['building_large', 'tavern']
    const medium3x3 = ['building_medium']
    const medium3x2 = ['balcony_house']
    const medium2x3 = ['shop']
    const small2x2 = ['building_small', 'tower']
    const special3x1 = ['archway']
    const special2x3 = ['staircase']

    for (const parcel of parcels) {
      let defId: string
      const roll = rng()

      if (parcel.w >= 4 && parcel.h >= 3) {
        defId = large4x3[Math.floor(rng() * large4x3.length)]
      } else if (parcel.w >= 3 && parcel.h >= 3) {
        defId = medium3x3[Math.floor(rng() * medium3x3.length)]
      } else if (parcel.w >= 3 && parcel.h >= 2) {
        defId = roll > 0.7 ? special3x1[0] : medium3x2[Math.floor(rng() * medium3x2.length)]
      } else if (parcel.w >= 2 && parcel.h >= 3) {
        defId = roll > 0.6 ? special2x3[0] : medium2x3[Math.floor(rng() * medium2x3.length)]
      } else if (parcel.w >= 2 && parcel.h >= 2) {
        defId = small2x2[Math.floor(rng() * small2x2.length)]
      } else {
        defId = 'building_small'
      }

      // Elevation variation - buildings further from center get slight elevation
      const cx = width / 2, cy = height / 2
      const distFromCenter = Math.sqrt(
        (parcel.x - cx) * (parcel.x - cx) + (parcel.y - cy) * (parcel.y - cy)
      )
      const maxDist = Math.sqrt(cx * cx + cy * cy)
      const elevationBase = (distFromCenter / maxDist) * 1.5
      const elevation = Math.floor(elevationBase + rng() * 0.8) * 0.5

      buildings.push({
        id: uuid(),
        definitionId: defId,
        x: parcel.x,
        y: parcel.y,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        elevation,
        properties: { floors: 1 + Math.floor(rng() * 3) }
      })
    }

    return buildings
  }

  private scatterProps(
    w: number, h: number,
    roads: { x1: number; y1: number; x2: number; y2: number; width: number }[],
    buildings: PlacedObject[],
    density: number,
    assetFrequencies: Record<string, number>,
    rng: () => number
  ): PlacedObject[] {
    const props: PlacedObject[] = []

    // Build occupancy grid
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (const b of buildings) {
      // Mark building area (+buffer)
      for (let dy = -1; dy <= 3; dy++) {
        for (let dx = -1; dx <= 4; dx++) {
          const cx = b.x + dx
          const cy = b.y + dy
          if (cx >= 0 && cx < w && cy >= 0 && cy < h) occupied[cy][cx] = true
        }
      }
    }

    // === Building-adjacent props (clustered near each building for lived-in feel) ===
    for (const b of buildings) {
      const bw = 3, bh = 3 // approximate footprint
      const adjacentSpots: { x: number; y: number }[] = []
      // Collect free tiles adjacent to building
      for (let dx = -1; dx <= bw; dx++) {
        for (const dy of [-1, bh]) {
          const ax = b.x + dx, ay = b.y + dy
          if (ax >= 0 && ax < w && ay >= 0 && ay < h && !occupied[ay][ax]) {
            adjacentSpots.push({ x: ax, y: ay })
          }
        }
      }
      for (let dy = 0; dy < bh; dy++) {
        for (const dx of [-1, bw]) {
          const ax = b.x + dx, ay = b.y + dy
          if (ax >= 0 && ax < w && ay >= 0 && ay < h && !occupied[ay][ax]) {
            adjacentSpots.push({ x: ax, y: ay })
          }
        }
      }

      // Place 1-3 contextual props per building
      const propsPerBuilding = Math.min(adjacentSpots.length, 1 + Math.floor(rng() * 3))
      const buildingProps: string[] = []
      if (b.definitionId === 'tavern' || b.definitionId === 'shop') {
        buildingProps.push('barrel', 'crate', 'hanging_sign', 'potted_plant')
      } else if (b.definitionId === 'building_small' || b.definitionId === 'building_medium' || b.definitionId === 'balcony_house') {
        buildingProps.push('potted_plant', 'planter_box', 'barrel')
      } else {
        buildingProps.push('crate', 'barrel', 'potted_plant')
      }

      for (let i = 0; i < propsPerBuilding && adjacentSpots.length > 0; i++) {
        const spotIdx = Math.floor(rng() * adjacentSpots.length)
        const spot = adjacentSpots.splice(spotIdx, 1)[0]
        const propId = buildingProps[Math.floor(rng() * buildingProps.length)]
        props.push(this.createProp(propId, spot.x, spot.y))
        occupied[spot.y][spot.x] = true
      }
    }

    // === Lampposts + wall lanterns along roads (alternating) ===
    const lampFreq = assetFrequencies['lamppost'] ?? 0.5
    const lampSpacing = Math.max(3, Math.floor(8 - lampFreq * 5))
    let lampCount = 0
    for (const road of roads) {
      if (road.y1 === road.y2) {
        const minX = Math.max(0, Math.min(road.x1, road.x2))
        const maxX = Math.min(w - 1, Math.max(road.x1, road.x2))
        for (let x = minX; x <= maxX; x += lampSpacing) {
          const y = road.y1 - 1
          if (y >= 0 && y < h && !occupied[y][x]) {
            const lightType = lampCount % 3 === 0 ? 'wall_lantern' : 'lamppost'
            props.push(this.createProp(lightType, x, y))
            occupied[y][x] = true
            lampCount++
          }
        }
      } else {
        const minY = Math.max(0, Math.min(road.y1, road.y2))
        const maxY = Math.min(h - 1, Math.max(road.y1, road.y2))
        for (let y = minY; y <= maxY; y += lampSpacing) {
          const x = road.x1 - 1
          if (x >= 0 && x < w && !occupied[y][x]) {
            const lightType = lampCount % 3 === 0 ? 'wall_lantern' : 'lamppost'
            props.push(this.createProp(lightType, x, y))
            occupied[y][x] = true
            lampCount++
          }
        }
      }
    }

    // === Benches ===
    const benchFreq = assetFrequencies['bench'] ?? 0.3
    const numBenches = Math.floor(density * benchFreq * w * h * 0.003)
    for (let i = 0; i < numBenches; i++) {
      const x = Math.floor(rng() * (w - 2))
      const y = Math.floor(rng() * h)
      if (!occupied[y]?.[x] && !occupied[y]?.[x + 1]) {
        props.push(this.createProp('bench', x, y))
        occupied[y][x] = true
        occupied[y][x + 1] = true
      }
    }

    // === Signs (mix of post signs and hanging signs) ===
    const signFreq = assetFrequencies['sign'] ?? 0.3
    const numSigns = Math.floor(density * signFreq * w * h * 0.003)
    for (let i = 0; i < numSigns; i++) {
      const x = Math.floor(rng() * w)
      const y = Math.floor(rng() * h)
      if (!occupied[y]?.[x]) {
        const signType = rng() > 0.5 ? 'hanging_sign' : 'sign'
        props.push(this.createProp(signType, x, y))
        occupied[y][x] = true
      }
    }

    // === Barrels and crates near buildings ===
    const storageCount = Math.floor(density * w * h * 0.004)
    const storageTypes = ['barrel', 'barrel_stack', 'crate', 'crate_stack']
    for (let i = 0; i < storageCount; i++) {
      const x = Math.floor(rng() * w)
      const y = Math.floor(rng() * h)
      if (!occupied[y]?.[x]) {
        props.push(this.createProp(storageTypes[Math.floor(rng() * storageTypes.length)], x, y))
        occupied[y][x] = true
      }
    }

    // === Cafe tables near commercial areas ===
    const cafeCount = Math.floor(density * w * h * 0.002)
    for (let i = 0; i < cafeCount; i++) {
      const x = Math.floor(rng() * w)
      const y = Math.floor(rng() * h)
      if (!occupied[y]?.[x]) {
        props.push(this.createProp('cafe_table', x, y))
        occupied[y][x] = true
      }
    }

    // === Potted plants and planter boxes ===
    const planterCount = Math.floor(density * w * h * 0.003)
    for (let i = 0; i < planterCount; i++) {
      const x = Math.floor(rng() * w)
      const y = Math.floor(rng() * h)
      if (!occupied[y]?.[x]) {
        if (rng() > 0.6 && x + 1 < w && !occupied[y]?.[x + 1]) {
          props.push(this.createProp('planter_box', x, y))
          occupied[y][x] = true
          occupied[y][x + 1] = true
        } else {
          props.push(this.createProp('potted_plant', x, y))
          occupied[y][x] = true
        }
      }
    }

    // === Fountain (town centerpiece) ===
    const fountainFreq = assetFrequencies['fountain'] ?? 0.3
    const numFountains = Math.max(0, Math.floor(density * fountainFreq * 2))
    for (let i = 0; i < numFountains; i++) {
      const x = Math.floor(w * 0.3 + rng() * w * 0.4)
      const y = Math.floor(h * 0.3 + rng() * h * 0.4)
      if (x + 1 < w && y + 1 < h &&
        !occupied[y][x] && !occupied[y][x + 1] &&
        !occupied[y + 1]?.[x] && !occupied[y + 1]?.[x + 1]) {
        props.push(this.createProp('fountain', x, y))
        occupied[y][x] = occupied[y][x + 1] = true
        occupied[y + 1][x] = occupied[y + 1][x + 1] = true
      }
    }

    // === Wells ===
    const wellFreq = assetFrequencies['well'] ?? 0.2
    const numWells = Math.floor(density * wellFreq * 2)
    for (let i = 0; i < numWells; i++) {
      const x = Math.floor(rng() * w)
      const y = Math.floor(rng() * h)
      if (!occupied[y]?.[x]) {
        props.push(this.createProp('well', x, y))
        occupied[y][x] = true
      }
    }

    // === Fences and stone walls at edges / boundaries ===
    const fenceCount = Math.floor(density * w * h * 0.001)
    for (let i = 0; i < fenceCount; i++) {
      const x = Math.floor(rng() * (w - 2))
      const y = Math.floor(rng() * h)
      if (!occupied[y]?.[x] && !occupied[y]?.[x + 1]) {
        const fenceType = rng() > 0.5 ? 'fence' : 'stone_wall'
        props.push(this.createProp(fenceType, x, y))
        occupied[y][x] = true
        occupied[y][x + 1] = true
      }
    }

    // === Market stalls (2x2, near center) ===
    const stallCount = Math.floor(density * 2)
    for (let i = 0; i < stallCount; i++) {
      const x = Math.floor(w * 0.25 + rng() * w * 0.5)
      const y = Math.floor(h * 0.25 + rng() * h * 0.5)
      if (x + 1 < w && y + 1 < h &&
        !occupied[y][x] && !occupied[y][x + 1] &&
        !occupied[y + 1]?.[x] && !occupied[y + 1]?.[x + 1]) {
        props.push(this.createProp('market_stall', x, y))
        occupied[y][x] = occupied[y][x + 1] = true
        occupied[y + 1][x] = occupied[y + 1][x + 1] = true
      }
    }

    // === Statues (rare, near center) ===
    if (density > 0.3 && rng() > 0.4) {
      const x = Math.floor(w * 0.35 + rng() * w * 0.3)
      const y = Math.floor(h * 0.35 + rng() * h * 0.3)
      if (!occupied[y]?.[x]) {
        props.push(this.createProp('statue', x, y))
        occupied[y][x] = true
      }
    }

    // === Double lamps (at key intersections - replace some regular lamps) ===
    const doubleLampCount = Math.floor(density * 3)
    for (let i = 0; i < doubleLampCount; i++) {
      const x = Math.floor(rng() * w)
      const y = Math.floor(rng() * h)
      if (!occupied[y]?.[x]) {
        props.push(this.createProp('street_lamp_double', x, y))
        occupied[y][x] = true
      }
    }

    return props
  }

  private scatterVegetation(
    w: number, h: number,
    roads: { x1: number; y1: number; x2: number; y2: number; width: number }[],
    buildings: PlacedObject[],
    density: number,
    rng: () => number,
    noise: SimplexNoise
  ): PlacedObject[] {
    const vegetation: PlacedObject[] = []

    // Use Poisson disk sampling for trees
    const minDist = Math.max(2, Math.floor(5 - density * 3))
    const points = poissonDiskSampling(w, h, minDist, rng)

    // Build quick occupancy check for roads and buildings
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (const road of roads) {
      if (road.y1 === road.y2) {
        const minX = Math.max(0, Math.min(road.x1, road.x2))
        const maxX = Math.min(w - 1, Math.max(road.x1, road.x2))
        for (let x = minX; x <= maxX; x++) {
          for (let dy = -1; dy <= road.width; dy++) {
            const y = road.y1 + dy
            if (y >= 0 && y < h) occupied[y][x] = true
          }
        }
      } else {
        const minY = Math.max(0, Math.min(road.y1, road.y2))
        const maxY = Math.min(h - 1, Math.max(road.y1, road.y2))
        for (let y = minY; y <= maxY; y++) {
          for (let dx = -1; dx <= road.width; dx++) {
            const x = road.x1 + dx
            if (x >= 0 && x < w) occupied[y][x] = true
          }
        }
      }
    }
    for (const b of buildings) {
      for (let dy = -1; dy <= 4; dy++) {
        for (let dx = -1; dx <= 5; dx++) {
          const cx = b.x + dx
          const cy = b.y + dy
          if (cx >= 0 && cx < w && cy >= 0 && cy < h) occupied[cy][cx] = true
        }
      }
    }

    for (const p of points) {
      const tx = Math.floor(p.x)
      const ty = Math.floor(p.y)
      if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue
      if (occupied[ty][tx]) continue

      // Use noise to determine vegetation density
      const vegNoise = noise.fbm(tx * 0.1, ty * 0.1, 2)
      if (vegNoise < 0.1 - density * 0.3) continue

      const isTree = rng() > 0.4
      vegetation.push(this.createProp(isTree ? 'tree' : 'bush', tx, ty))
    }

    return vegetation
  }

  private createProp(defId: string, x: number, y: number): PlacedObject {
    return {
      id: uuid(),
      definitionId: defId,
      x,
      y,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      elevation: 0,
      properties: {}
    }
  }
}
