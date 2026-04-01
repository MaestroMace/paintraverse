import { v4 as uuid } from 'uuid'
import type { MapDocument, MapLayer, PlacedObject, GenerationConfig, EnvironmentState } from '../core/types'
import type { IMapGenerator } from './GeneratorRegistry'
import { createRNG, SimplexNoise, poissonDiskSampling } from './noise'

export class TownGenerator implements IMapGenerator {
  readonly type = 'town'
  readonly displayName = 'Town'
  readonly description = 'Generates an organic town with winding streets, plazas, and dense buildings'

  generate(config: GenerationConfig): MapDocument {
    const { width, height, seed, complexity, density } = config
    const rng = createRNG(seed)
    const noise = new SimplexNoise(seed)

    // 1. Generate height map for coherent elevation
    const heightMap = this.generateHeightMap(width, height, noise)

    // 2. Generate terrain base
    const terrainTiles = this.generateTerrain(width, height, noise)

    // 3. Define a town center and generate organic road network
    const centerX = Math.floor(width * 0.4 + rng() * width * 0.2)
    const centerY = Math.floor(height * 0.4 + rng() * height * 0.2)

    // 4. Create a plaza at the center
    const plazaRadius = Math.floor(3 + complexity * 3)
    this.carvePlaza(terrainTiles, centerX, centerY, plazaRadius, width, height)

    // 5. Generate organic roads radiating from center with curves
    const roadMap = this.generateOrganicRoads(
      width, height, centerX, centerY, complexity, density, rng, noise, terrainTiles
    )

    // 6. Place buildings densely along roads (shared walls, no buffers)
    const buildings = this.placeBuildingsAlongRoads(
      width, height, roadMap, heightMap, complexity, density, rng, centerX, centerY
    )

    // 7. Fill alleys and gaps with narrow paths
    this.carveAlleysBetweenBuildings(terrainTiles, buildings, width, height, rng)

    // 8. Scatter contextual props
    const props = this.scatterProps(
      width, height, roadMap, buildings, density, config.assetFrequencies, rng, centerX, centerY
    )

    // 9. Scatter vegetation in remaining open spaces
    const vegetation = this.scatterVegetation(
      width, height, roadMap, buildings, density, rng, noise
    )

    const terrainLayer: MapLayer = {
      id: uuid(), name: 'Terrain', type: 'terrain',
      visible: true, locked: false, objects: [], terrainTiles
    }
    const structureLayer: MapLayer = {
      id: uuid(), name: 'Structures', type: 'structure',
      visible: true, locked: false, objects: buildings
    }
    const propLayer: MapLayer = {
      id: uuid(), name: 'Props', type: 'prop',
      visible: true, locked: false, objects: [...props, ...vegetation]
    }

    const defaultEnv: EnvironmentState = {
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
      environment: defaultEnv,
      cameras: [],
      generationConfig: config
    }
  }

  // === HEIGHTMAP ===

  private generateHeightMap(w: number, h: number, noise: SimplexNoise): number[][] {
    const map: number[][] = []
    for (let y = 0; y < h; y++) {
      const row: number[] = []
      for (let x = 0; x < w; x++) {
        // Gentle rolling hills - low frequency noise
        const n = noise.fbm(x * 0.03, y * 0.03, 2, 2, 0.5)
        row.push(Math.max(0, (n + 0.5) * 1.5)) // 0 to ~2 range
      }
      map.push(row)
    }
    return map
  }

  // === TERRAIN ===

  private generateTerrain(w: number, h: number, noise: SimplexNoise): number[][] {
    const tiles: number[][] = []
    for (let y = 0; y < h; y++) {
      const row: number[] = []
      for (let x = 0; x < w; x++) {
        const n = noise.fbm(x * 0.06, y * 0.06, 3)
        if (n < -0.25) row.push(5)       // dark grass
        else if (n < 0.15) row.push(0)   // grass
        else if (n < 0.35) row.push(1)   // dirt
        else row.push(0)
      }
      tiles.push(row)
    }
    return tiles
  }

  // === PLAZA ===

  private carvePlaza(
    terrain: number[][], cx: number, cy: number, radius: number,
    w: number, h: number
  ): void {
    // Slightly irregular circle using distance + noise
    for (let y = cy - radius - 1; y <= cy + radius + 1; y++) {
      for (let x = cx - radius - 1; x <= cx + radius + 1; x++) {
        if (x < 0 || x >= w || y < 0 || y >= h) continue
        const dx = x - cx, dy = y - cy
        const dist = Math.sqrt(dx * dx + dy * dy)
        // Irregular edge
        const edgeNoise = Math.sin(Math.atan2(dy, dx) * 5) * 0.8
        if (dist < radius + edgeNoise) {
          terrain[y][x] = (x + y) % 4 === 0 ? 9 : 8
        }
      }
    }
  }

  // === ORGANIC ROAD NETWORK ===

  private generateOrganicRoads(
    w: number, h: number,
    cx: number, cy: number,
    complexity: number, density: number,
    rng: () => number,
    noise: SimplexNoise,
    terrain: number[][]
  ): boolean[][] {
    // Road map: true = road tile
    const roadMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))

    // Mark plaza
    const plazaR = Math.floor(3 + complexity * 3)
    for (let y = cy - plazaR; y <= cy + plazaR; y++) {
      for (let x = cx - plazaR; x <= cx + plazaR; x++) {
        if (x >= 0 && x < w && y >= 0 && y < h) {
          const dx = x - cx, dy = y - cy
          if (Math.sqrt(dx * dx + dy * dy) < plazaR + 0.5) {
            roadMap[y][x] = true
          }
        }
      }
    }

    // Generate main roads radiating from center with gentle curves
    const numMain = Math.floor(4 + complexity * 6)
    for (let i = 0; i < numMain; i++) {
      const angle = (i / numMain) * Math.PI * 2 + (rng() - 0.5) * 0.4
      this.carveOrganicPath(
        roadMap, terrain, cx, cy, angle, w, h,
        Math.floor(w * 0.35 + rng() * w * 0.15),
        3, // wider main roads for more building frontage
        0.15, // curviness
        noise, rng
      )
    }

    // Generate secondary connecting roads between main roads
    const numSecondary = Math.floor(4 + complexity * 10)
    for (let i = 0; i < numSecondary; i++) {
      const sx = Math.floor(w * 0.1 + rng() * w * 0.8)
      const sy = Math.floor(h * 0.1 + rng() * h * 0.8)
      const angle = rng() * Math.PI * 2
      this.carveOrganicPath(
        roadMap, terrain, sx, sy, angle, w, h,
        Math.floor(8 + rng() * 14),
        2, // medium width
        0.25, // curvier
        noise, rng
      )
    }

    // Generate small alleys branching off main roads
    if (complexity > 0.2) {
      const numAlleys = Math.floor(6 + complexity * 15)
      for (let i = 0; i < numAlleys; i++) {
        // Find a random road tile to branch from
        const bx = Math.floor(rng() * w)
        const by = Math.floor(rng() * h)
        if (bx >= 0 && bx < w && by >= 0 && by < h && roadMap[by][bx]) {
          const angle = rng() * Math.PI * 2
          this.carveOrganicPath(
            roadMap, terrain, bx, by, angle, w, h,
            Math.floor(3 + rng() * 6),
            1, // narrow alley
            0.3, // very curvy
            noise, rng
          )
        }
      }
    }

    // Paint road tiles onto terrain
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (roadMap[y][x]) {
          terrain[y][x] = (x + y) % 4 === 0 ? 9 : 8
        }
      }
    }

    return roadMap
  }

  // Carve a single organic path using random walk with directional bias
  private carveOrganicPath(
    roadMap: boolean[][], terrain: number[][],
    startX: number, startY: number,
    angle: number,
    w: number, h: number,
    length: number,
    roadWidth: number,
    curviness: number,
    noise: SimplexNoise,
    rng: () => number
  ): void {
    let x = startX, y = startY
    let dir = angle

    for (let step = 0; step < length; step++) {
      // Carve road tiles at current position
      for (let dy = 0; dy < roadWidth; dy++) {
        for (let dx = 0; dx < roadWidth; dx++) {
          const rx = Math.floor(x) + dx
          const ry = Math.floor(y) + dy
          if (rx >= 0 && rx < w && ry >= 0 && ry < h) {
            roadMap[ry][rx] = true
          }
        }
      }

      // Gentle curve using noise
      const noiseVal = noise.noise2D(x * 0.1, y * 0.1)
      dir += noiseVal * curviness + (rng() - 0.5) * curviness * 0.5

      // Move forward
      x += Math.cos(dir) * 1.2
      y += Math.sin(dir) * 1.2

      // Bounds check
      if (x < 1 || x >= w - 1 || y < 1 || y >= h - 1) break
    }
  }

  // === DENSE BUILDING PLACEMENT ===

  private placeBuildingsAlongRoads(
    w: number, h: number,
    roadMap: boolean[][],
    heightMap: number[][],
    complexity: number, density: number,
    rng: () => number,
    cx: number, cy: number
  ): PlacedObject[] {
    const buildings: PlacedObject[] = []
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))

    // Mark roads as occupied
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (roadMap[y][x]) occupied[y][x] = true
      }
    }

    // Building types - heavily favor small buildings that fill gaps, creating dense frontage
    const types: { id: string; w: number; h: number; weight: number }[] = [
      { id: 'row_house', w: 1, h: 2, weight: 6 },        // narrow gap-filler, most common
      { id: 'building_small', w: 2, h: 2, weight: 5 },   // small house, very common
      { id: 'corner_building', w: 2, h: 2, weight: 3 },  // intersections
      { id: 'shop', w: 2, h: 3, weight: 3 },             // commercial
      { id: 'balcony_house', w: 3, h: 2, weight: 2 },    // residential variety
      { id: 'building_medium', w: 3, h: 3, weight: 1.5 }, // medium
      { id: 'tavern', w: 4, h: 3, weight: 0.8 },         // rare landmark
      { id: 'building_large', w: 4, h: 3, weight: 0.5 }, // rare
      { id: 'tower', w: 2, h: 2, weight: 0.4 },          // rare landmark
      { id: 'archway', w: 3, h: 1, weight: 0.5 },        // passage
      { id: 'staircase', w: 2, h: 3, weight: 0.3 },      // elevation
      { id: 'town_gate', w: 3, h: 1, weight: 0.2 },      // very rare landmark
    ]
    const totalWeight = types.reduce((s, t) => s + t.weight, 0)

    // Much higher building count for dense towns
    const maxBuildings = Math.floor(25 + complexity * 55 + density * 35)
    let placed = 0
    let attempts = 0
    const maxAttempts = maxBuildings * 50

    while (placed < maxBuildings && attempts < maxAttempts) {
      attempts++

      // Pick a random road-adjacent tile
      const rx = Math.floor(rng() * (w - 4)) + 2
      const ry = Math.floor(rng() * (h - 4)) + 2
      if (!this.isRoadAdjacent(rx, ry, roadMap, w, h)) continue
      if (occupied[ry]?.[rx]) continue

      // Pick a building type (weighted random)
      let roll = rng() * totalWeight
      let type = types[0]
      for (const t of types) {
        roll -= t.weight
        if (roll <= 0) { type = t; break }
      }

      // Try to fit this building at this location
      const bw = type.w, bh = type.h
      if (rx + bw > w - 1 || ry + bh > h - 1) continue

      // Check if area is free (NO buffer - buildings can share walls)
      let free = true
      for (let dy = 0; dy < bh && free; dy++) {
        for (let dx = 0; dx < bw && free; dx++) {
          if (occupied[ry + dy]?.[rx + dx]) free = false
        }
      }
      if (!free) continue

      // Density gradient: prefer placing buildings near center
      const distFromCenter = Math.sqrt((rx - cx) ** 2 + (ry - cy) ** 2)
      const maxDist = Math.sqrt(w * w + h * h) / 2
      const distNorm = distFromCenter / maxDist
      // Center: 100% acceptance, edge: 30% acceptance
      const acceptChance = 1.0 - distNorm * 0.7
      if (rng() > acceptChance) continue
      const heightVal = heightMap[ry]?.[rx] ?? 0
      const elevation = Math.round((heightVal + distFromCenter / maxDist * 0.5) * 2) / 2

      buildings.push({
        id: uuid(),
        definitionId: type.id,
        x: rx, y: ry,
        rotation: 0,
        scaleX: 1, scaleY: 1,
        elevation: Math.min(elevation, 2),
        properties: { floors: 1 + Math.floor(rng() * 2) }
      })

      // Mark occupied - NO buffer for denser packing
      for (let dy = 0; dy < bh; dy++) {
        for (let dx = 0; dx < bw; dx++) {
          if (ry + dy < h && rx + dx < w) {
            occupied[ry + dy][rx + dx] = true
          }
        }
      }
      placed++
    }

    // === FILL PASS: Use row houses (1x2) to fill remaining road-adjacent gaps ===
    // This creates continuous street frontage by plugging narrow holes
    const fillMax = Math.floor(maxBuildings * 0.5)
    let filled = 0
    for (let y = 2; y < h - 3 && filled < fillMax; y++) {
      for (let x = 2; x < w - 2 && filled < fillMax; x++) {
        if (occupied[y][x] || !this.isRoadAdjacent(x, y, roadMap, w, h)) continue

        // Try 1x2 row house
        if (y + 1 < h && !occupied[y + 1][x]) {
          // Density gradient for fill pass too
          const fd = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) / maxDist
          if (fd > 0.6) continue // only fill in inner 60% of town

          buildings.push({
            id: uuid(),
            definitionId: 'row_house',
            x, y,
            rotation: 0, scaleX: 1, scaleY: 1,
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

  private isRoadAdjacent(x: number, y: number, roadMap: boolean[][], w: number, h: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && roadMap[ny][nx]) return true
      }
    }
    return false
  }

  // === ALLEYS BETWEEN BUILDINGS ===

  private carveAlleysBetweenBuildings(
    terrain: number[][], buildings: PlacedObject[],
    w: number, h: number, rng: () => number
  ): void {
    // Find 1-tile gaps between buildings and pave them as narrow alleys
    const buildingMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (const b of buildings) {
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 5; dx++) {
          const bx = b.x + dx, by = b.y + dy
          if (bx < w && by < h) buildingMap[by][bx] = true
        }
      }
    }

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (buildingMap[y][x]) continue
        // Check if this tile is between two buildings (narrow gap)
        const leftB = x > 0 && buildingMap[y][x - 1]
        const rightB = x < w - 1 && buildingMap[y][x + 1]
        const topB = y > 0 && buildingMap[y - 1][x]
        const botB = y < h - 1 && buildingMap[y + 1][x]

        if ((leftB && rightB) || (topB && botB)) {
          // This is an alley tile
          terrain[y][x] = 9 // dark cobblestone for alleys
        }
      }
    }
  }

  // === PROPS ===

  private scatterProps(
    w: number, h: number,
    roadMap: boolean[][],
    buildings: PlacedObject[],
    density: number,
    assetFrequencies: Record<string, number>,
    rng: () => number,
    cx: number, cy: number
  ): PlacedObject[] {
    const props: PlacedObject[] = []
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))

    // Mark buildings and roads
    for (const b of buildings) {
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 5; dx++) {
          const bx = b.x + dx, by = b.y + dy
          if (bx < w && by < h) occupied[by][bx] = true
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (roadMap[y][x]) occupied[y][x] = true
      }
    }

    const place = (defId: string, x: number, y: number) => {
      if (x < 0 || x >= w || y < 0 || y >= h || occupied[y][x]) return false
      props.push(this.createProp(defId, x, y))
      occupied[y][x] = true
      return true
    }

    // === Building-adjacent props (1-3 per building) ===
    for (const b of buildings) {
      const spots: { x: number; y: number }[] = []
      for (let dx = -1; dx <= 4; dx++) {
        for (const dy of [-1, 4]) {
          spots.push({ x: b.x + dx, y: b.y + dy })
        }
      }
      for (let dy = 0; dy < 4; dy++) {
        for (const dx of [-1, 5]) {
          spots.push({ x: b.x + dx, y: b.y + dy })
        }
      }

      const validSpots = spots.filter(
        (s) => s.x >= 0 && s.x < w && s.y >= 0 && s.y < h && !occupied[s.y][s.x]
      )

      const numProps = Math.min(validSpots.length, 1 + Math.floor(rng() * 3))
      const contextProps = this.getContextualProps(b.definitionId)

      for (let i = 0; i < numProps; i++) {
        const idx = Math.floor(rng() * validSpots.length)
        const spot = validSpots.splice(idx, 1)[0]
        if (spot) {
          place(contextProps[Math.floor(rng() * contextProps.length)], spot.x, spot.y)
        }
      }
    }

    // === Lights along roads ===
    const lampFreq = assetFrequencies['lamppost'] ?? 0.5
    const lampSpacing = Math.max(2, Math.floor(6 - lampFreq * 4))
    let lampCount = 0
    for (let y = 0; y < h; y += lampSpacing) {
      for (let x = 0; x < w; x += lampSpacing) {
        if (!roadMap[y]?.[x]) continue
        // Place light on adjacent non-road tile
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const lx = x + dx, ly = y + dy
          if (lx >= 0 && lx < w && ly >= 0 && ly < h &&
              !roadMap[ly][lx] && !occupied[ly][lx]) {
            const lightType = lampCount % 4 === 0 ? 'street_lamp_double'
              : lampCount % 3 === 0 ? 'wall_lantern' : 'lamppost'
            place(lightType, lx, ly)
            lampCount++
            break
          }
        }
      }
    }

    // === Plaza features ===
    // Fountain at center
    if (!occupied[cy]?.[cx] && !occupied[cy]?.[cx + 1] &&
        !occupied[cy + 1]?.[cx] && !occupied[cy + 1]?.[cx + 1]) {
      props.push(this.createProp('fountain', cx, cy))
      occupied[cy][cx] = occupied[cy][cx + 1] = true
      if (cy + 1 < h) { occupied[cy + 1][cx] = occupied[cy + 1][cx + 1] = true }
    }

    // Statue near plaza
    const statueX = cx + Math.floor(rng() * 4) - 2
    const statueY = cy + Math.floor(rng() * 4) - 2
    place('statue', statueX, statueY)

    // Market stalls around plaza
    const stallCount = Math.floor(1 + density * 3)
    for (let i = 0; i < stallCount; i++) {
      const sx = cx + Math.floor(rng() * 8) - 4
      const sy = cy + Math.floor(rng() * 8) - 4
      if (sx >= 0 && sx + 1 < w && sy >= 0 && sy + 1 < h &&
          !occupied[sy][sx] && !occupied[sy][sx + 1] &&
          !occupied[sy + 1]?.[sx] && !occupied[sy + 1]?.[sx + 1]) {
        props.push(this.createProp('market_stall', sx, sy))
        occupied[sy][sx] = occupied[sy][sx + 1] = true
        if (sy + 1 < h) { occupied[sy + 1][sx] = occupied[sy + 1][sx + 1] = true }
      }
    }

    // Scatter cafe tables, benches, signs in remaining road-adjacent spots
    const streetFurnitureCount = Math.floor(density * w * h * 0.005)
    const streetItems = ['cafe_table', 'bench', 'sign', 'hanging_sign', 'barrel', 'crate']
    for (let i = 0; i < streetFurnitureCount; i++) {
      const x = Math.floor(rng() * w)
      const y = Math.floor(rng() * h)
      if (this.isRoadAdjacent(x, y, roadMap, w, h) && !occupied[y]?.[x]) {
        place(streetItems[Math.floor(rng() * streetItems.length)], x, y)
      }
    }

    return props
  }

  private getContextualProps(buildingId: string): string[] {
    switch (buildingId) {
      case 'tavern': return ['barrel', 'barrel_stack', 'crate', 'hanging_sign', 'wall_lantern']
      case 'shop': return ['crate', 'crate_stack', 'hanging_sign', 'potted_plant', 'sign']
      case 'balcony_house': return ['potted_plant', 'planter_box', 'bench']
      case 'building_small':
      case 'building_medium': return ['potted_plant', 'planter_box', 'barrel', 'fence']
      case 'building_large': return ['barrel_stack', 'crate_stack', 'potted_plant', 'wall_lantern']
      case 'tower': return ['stone_wall', 'wall_lantern', 'sign']
      default: return ['potted_plant', 'barrel', 'crate']
    }
  }

  // === VEGETATION ===

  private scatterVegetation(
    w: number, h: number,
    roadMap: boolean[][],
    buildings: PlacedObject[],
    density: number,
    rng: () => number,
    noise: SimplexNoise
  ): PlacedObject[] {
    const vegetation: PlacedObject[] = []
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))

    // Mark roads and buildings
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (roadMap[y][x]) occupied[y][x] = true
      }
    }
    for (const b of buildings) {
      for (let dy = -1; dy <= 4; dy++) {
        for (let dx = -1; dx <= 5; dx++) {
          const bx = b.x + dx, by = b.y + dy
          if (bx >= 0 && bx < w && by >= 0 && by < h) occupied[by][bx] = true
        }
      }
    }

    // Poisson disk for natural tree distribution
    const minDist = Math.max(2, Math.floor(4 - density * 2))
    const points = poissonDiskSampling(w, h, minDist, rng)

    for (const p of points) {
      const tx = Math.floor(p.x), ty = Math.floor(p.y)
      if (tx < 0 || tx >= w || ty < 0 || ty >= h || occupied[ty][tx]) continue

      const vegNoise = noise.fbm(tx * 0.08, ty * 0.08, 2)
      if (vegNoise < 0.05 - density * 0.2) continue

      const isTree = rng() > 0.35
      vegetation.push(this.createProp(isTree ? 'tree' : 'bush', tx, ty))
    }

    return vegetation
  }

  private createProp(defId: string, x: number, y: number): PlacedObject {
    return {
      id: uuid(),
      definitionId: defId,
      x, y,
      rotation: 0,
      scaleX: 1, scaleY: 1,
      elevation: 0,
      properties: {}
    }
  }
}
