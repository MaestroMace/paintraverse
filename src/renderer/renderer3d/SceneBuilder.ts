import * as THREE from 'three'
import type { MapDocument, PlacedObject, ObjectDefinition, EnvironmentState } from '../core/types'

const TERRAIN_3D_COLORS: Record<number, number> = {
  0: 0x2d5a27, 1: 0x8b7355, 2: 0x708090, 3: 0x4682b4,
  4: 0xf4e9c8, 5: 0x556b2f, 6: 0x5a5a5a, 7: 0xdcdcdc,
  8: 0x6a6a68, 9: 0x4a4a48
}

// Building color variations for visual variety
const BUILDING_PALETTES = [
  { wall: 0x9e8b76, roof: 0x8b4513, door: 0x4a3520 },
  { wall: 0xa09080, roof: 0x6b3a2a, door: 0x3a2a1a },
  { wall: 0xb8a898, roof: 0x7a4a3a, door: 0x5a4030 },
  { wall: 0x8a7a6a, roof: 0x5a3020, door: 0x4a3020 },
  { wall: 0xc8b8a0, roof: 0x8a5a40, door: 0x6a4a30 },
  { wall: 0x7a8a7a, roof: 0x4a6a4a, door: 0x3a4a3a },
]

// Allow external override of building palettes (from inspiration system)
let _buildingPaletteOverride: { wall: number; roof: number; door: number }[] | null = null

export function setBuildingPaletteOverride(palettes: { wall: number; roof: number; door: number }[] | null): void {
  _buildingPaletteOverride = palettes
}

function getActiveBuildingPalettes() {
  return _buildingPaletteOverride || BUILDING_PALETTES
}

export function buildScene(
  map: MapDocument,
  objectDefs: ObjectDefinition[]
): THREE.Scene {
  const scene = new THREE.Scene()

  const terrainLayer = map.layers.find((l) => l.type === 'terrain')
  if (terrainLayer?.terrainTiles) {
    scene.add(buildTerrain(terrainLayer.terrainTiles, map.tileSize))
  }

  const structureLayer = map.layers.find((l) => l.type === 'structure')
  if (structureLayer) {
    for (const obj of structureLayer.objects) {
      const def = objectDefs.find((d) => d.id === obj.definitionId)
      if (!def) continue
      scene.add(buildStructure(obj, def, map.tileSize))
    }
  }

  const propLayer = map.layers.find((l) => l.type === 'prop')
  if (propLayer) {
    for (const obj of propLayer.objects) {
      const def = objectDefs.find((d) => d.id === obj.definitionId)
      if (!def) continue
      scene.add(buildProp(obj, def, map.tileSize))
    }
  }

  applyLighting(scene, map.environment)
  buildSky(scene, map.environment)
  return scene
}

function buildTerrain(tiles: number[][], tileSize: number): THREE.Group {
  const group = new THREE.Group()
  const colorGroups = new Map<number, { x: number; y: number }[]>()

  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < tiles[y].length; x++) {
      const tileId = tiles[y][x]
      const color = TERRAIN_3D_COLORS[tileId] ?? TERRAIN_3D_COLORS[0]
      if (!colorGroups.has(color)) colorGroups.set(color, [])
      colorGroups.get(color)!.push({ x, y })
    }
  }

  // Single shared geometry for all terrain tiles
  const geo = new THREE.PlaneGeometry(tileSize, tileSize)
  geo.rotateX(-Math.PI / 2)

  for (const [color, positions] of colorGroups) {
    const mat = new THREE.MeshLambertMaterial({ color })
    const mesh = new THREE.InstancedMesh(geo, mat, positions.length)
    const matrix = new THREE.Matrix4()

    positions.forEach((pos, i) => {
      matrix.makeTranslation(
        pos.x * tileSize + tileSize / 2,
        0,
        pos.y * tileSize + tileSize / 2
      )
      mesh.setMatrixAt(i, matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    group.add(mesh)
  }

  return group
}

function buildStructure(obj: PlacedObject, def: ObjectDefinition, tileSize: number): THREE.Group {
  const hash = simpleHash(obj.id)
  const activePalettes = getActiveBuildingPalettes()
  const palette = activePalettes[hash % activePalettes.length]

  switch (def.id) {
    case 'tavern': return buildTavern(obj, def, tileSize, palette, hash)
    case 'shop': return buildShop(obj, def, tileSize, palette, hash)
    case 'tower': return buildTower(obj, def, tileSize, palette, hash)
    case 'balcony_house': return buildBalconyHouse(obj, def, tileSize, palette, hash)
    case 'archway': return buildArchway(obj, def, tileSize, palette)
    case 'staircase': return buildStaircase(obj, def, tileSize)
    case 'clock_tower': return buildClockTower(obj, def, tileSize, palette)
    case 'row_house': return buildRowHouse(obj, def, tileSize, palette)
    case 'town_gate': return buildTownGate(obj, def, tileSize)
    case 'corner_building': return buildCornerBuilding(obj, def, tileSize, palette, hash)
    default: return buildGenericBuilding(obj, def, tileSize, palette)
  }
}

interface BPalette { wall: number; roof: number; door: number }

// Shared helpers for building construction
function addWalls(group: THREE.Group, w: number, h: number, d: number, palette: BPalette): void {
  const geo = new THREE.BoxGeometry(w - 1, h, d - 1)
  const mats = [
    new THREE.MeshLambertMaterial({ color: palette.wall }),
    new THREE.MeshLambertMaterial({ color: darken(palette.wall, 0.08) }),
    new THREE.MeshLambertMaterial({ color: palette.wall }),
    new THREE.MeshLambertMaterial({ color: darken(palette.wall, 0.2) }),
    new THREE.MeshLambertMaterial({ color: darken(palette.wall, 0.04) }),
    new THREE.MeshLambertMaterial({ color: darken(palette.wall, 0.12) }),
  ]
  const mesh = new THREE.Mesh(geo, mats)
  mesh.position.set(w / 2, h / 2, d / 2)
  group.add(mesh)
}

function addPitchedRoof(group: THREE.Group, w: number, h: number, d: number, roofH: number, color: number): void {
  const shape = new THREE.Shape()
  shape.moveTo(-w / 2 - 2, 0)
  shape.lineTo(0, roofH)
  shape.lineTo(w / 2 + 2, 0)
  shape.lineTo(-w / 2 - 2, 0)
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d + 2, bevelEnabled: false })
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }))
  mesh.position.set(w / 2, h, -1)
  group.add(mesh)
}

function addDoor(group: THREE.Group, x: number, d: number, tileSize: number, palette: BPalette): void {
  const dw = tileSize * 0.25, dh = tileSize * 0.45
  const doorMat = new THREE.MeshLambertMaterial({ color: palette.door })
  const door = new THREE.Mesh(new THREE.BoxGeometry(dw, dh, 1.5), doorMat)
  door.position.set(x, dh / 2, d + 0.3)
  group.add(door)
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(dw + 3, dh + 2, 1),
    new THREE.MeshLambertMaterial({ color: darken(palette.door, 0.3) })
  )
  frame.position.set(x, dh / 2 + 1, d + 0.1)
  group.add(frame)
}

function addWindows(group: THREE.Group, w: number, d: number, floors: number, tileSize: number, palette: BPalette): void {
  const winGeo = new THREE.BoxGeometry(tileSize * 0.15, tileSize * 0.18, 1.5)
  // Warm glowing windows - the key to the Traverse Town feel
  const winMat = new THREE.MeshLambertMaterial({
    color: 0xffcc66,
    emissive: 0xffaa33,
    emissiveIntensity: 0.7
  })
  const shutterMat = new THREE.MeshLambertMaterial({ color: darken(palette.wall, 0.25) })
  const shutterGeo = new THREE.BoxGeometry(tileSize * 0.04, tileSize * 0.2, 1)

  for (let f = 0; f < floors; f++) {
    const wy = tileSize * 0.4 + f * tileSize * 0.7
    for (let wx = -1; wx <= 1; wx += 2) {
      const win = new THREE.Mesh(winGeo, winMat)
      win.position.set(w / 2 + wx * w * 0.25, wy, d + 0.3)
      group.add(win)
      for (const sx of [-1, 1]) {
        const shutter = new THREE.Mesh(shutterGeo, shutterMat)
        shutter.position.set(w / 2 + wx * w * 0.25 + sx * tileSize * 0.1, wy, d + 0.5)
        group.add(shutter)
      }
      // Window light spilling out - warm amber pooling on the ground
      const winLight = new THREE.PointLight(0xffaa44, 0.35, tileSize * 3)
      winLight.position.set(w / 2 + wx * w * 0.25, wy, d + tileSize * 0.5)
      group.add(winLight)
    }
    if (d > tileSize * 1.5) {
      const sw = new THREE.Mesh(winGeo.clone(), winMat)
      sw.rotation.y = Math.PI / 2
      sw.position.set(w + 0.3, wy, d / 2)
      group.add(sw)
    }
  }
}

function addBuildingShadow(group: THREE.Group, w: number, d: number): void {
  const geo = new THREE.PlaneGeometry(w + 4, d + 4)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.15, depthWrite: false })
  const shadow = new THREE.Mesh(geo, mat)
  shadow.position.set(w / 2 + 2, 0.1, d / 2 + 2)
  group.add(shadow)
}

// Phase B: Timber framing - dark wood beams on building facades
function addTimberFraming(group: THREE.Group, w: number, wallH: number, d: number, ts: number, hash: number): void {
  const timberMat = new THREE.MeshLambertMaterial({ color: 0x2a1a0a })
  const beamThickness = ts * 0.04
  const beamDepth = 1.5

  // Pattern varies by building hash
  const pattern = hash % 3

  // Horizontal beams at each floor level
  const floorCount = Math.max(1, Math.round(wallH / (ts * 0.7)))
  for (let f = 0; f <= floorCount; f++) {
    const y = f * (wallH / floorCount)
    // Front face
    const hBeam = new THREE.Mesh(
      new THREE.BoxGeometry(w + 2, beamThickness, beamDepth),
      timberMat
    )
    hBeam.position.set(w / 2, y, d + 0.8)
    group.add(hBeam)
  }

  // Vertical corner posts
  for (const vx of [1, w - 1]) {
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(beamThickness, wallH, beamDepth),
      timberMat
    )
    post.position.set(vx, wallH / 2, d + 0.8)
    group.add(post)
  }

  // Mid-posts (1-2 depending on width)
  const midCount = Math.max(1, Math.floor(w / ts) - 1)
  for (let i = 1; i <= midCount; i++) {
    const vx = (w / (midCount + 1)) * i
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(beamThickness, wallH, beamDepth),
      timberMat
    )
    post.position.set(vx, wallH / 2, d + 0.8)
    group.add(post)
  }

  // Diagonal braces (pattern 1 and 2 only)
  if (pattern >= 1 && floorCount >= 1) {
    const sectionW = w / (midCount + 1)
    for (let i = 0; i <= midCount; i++) {
      const sx = (w / (midCount + 1)) * i + sectionW / 2
      const braceLen = Math.sqrt(sectionW * sectionW + (wallH / floorCount) * (wallH / floorCount)) * 0.4
      const braceAngle = Math.atan2(wallH / floorCount, sectionW)
      const brace = new THREE.Mesh(
        new THREE.BoxGeometry(braceLen, beamThickness, beamDepth),
        timberMat
      )
      brace.position.set(sx, wallH * 0.35, d + 0.8)
      brace.rotation.z = pattern === 1 ? braceAngle : -braceAngle
      group.add(brace)
    }
  }
}

// Phase B: Eaves - overhanging edge at roofline
function addEaves(group: THREE.Group, w: number, wallH: number, d: number, ts: number, roofColor: number): void {
  const eaveMat = new THREE.MeshLambertMaterial({ color: darken(roofColor, 0.15) })
  const overhang = ts * 0.15

  // Front eave
  const frontEave = new THREE.Mesh(
    new THREE.BoxGeometry(w + overhang * 2, ts * 0.04, ts * 0.12),
    eaveMat
  )
  frontEave.position.set(w / 2, wallH, d + overhang / 2)
  group.add(frontEave)

  // Side eaves
  for (const sx of [0 - overhang / 2, w + overhang / 2]) {
    const sideEave = new THREE.Mesh(
      new THREE.BoxGeometry(ts * 0.12, ts * 0.04, d + overhang * 2),
      eaveMat
    )
    sideEave.position.set(sx, wallH, d / 2)
    group.add(sideEave)
  }

  // Cornice strip (decorative line just below eave)
  const corniceMat = new THREE.MeshLambertMaterial({ color: darken(roofColor, 0.05) })
  const cornice = new THREE.Mesh(
    new THREE.BoxGeometry(w + 1, ts * 0.03, ts * 0.06),
    corniceMat
  )
  cornice.position.set(w / 2, wallH - ts * 0.03, d + 0.5)
  group.add(cornice)
}

// Phase B: Flower boxes under windows (some buildings)
function addFlowerBoxes(group: THREE.Group, w: number, d: number, floors: number, ts: number, hash: number): void {
  if (hash % 3 !== 0) return // only 1 in 3 buildings get flower boxes

  const boxMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1a })
  const greenMat = new THREE.MeshLambertMaterial({ color: 0x3a7a30 })
  const flowerColors = [0xdd4444, 0xddaa44, 0xdd44aa, 0x44aadd]

  for (let f = 0; f < Math.min(floors, 2); f++) {
    const wy = ts * 0.28 + f * ts * 0.7
    // One flower box per floor on front face
    const fbx = w / 2 + (hash % 2 === 0 ? w * 0.25 : -w * 0.25)
    // Box
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(ts * 0.2, ts * 0.05, ts * 0.08),
      boxMat
    )
    box.position.set(fbx, wy, d + ts * 0.08)
    group.add(box)
    // Plants
    for (let p = -1; p <= 1; p++) {
      const plant = new THREE.Mesh(
        new THREE.SphereGeometry(ts * 0.04, 4, 3),
        greenMat
      )
      plant.position.set(fbx + p * ts * 0.06, wy + ts * 0.05, d + ts * 0.08)
      group.add(plant)
    }
    // Flower dot
    const flower = new THREE.Mesh(
      new THREE.SphereGeometry(ts * 0.02, 4, 3),
      new THREE.MeshLambertMaterial({ color: flowerColors[hash % flowerColors.length] })
    )
    flower.position.set(fbx, wy + ts * 0.07, d + ts * 0.1)
    group.add(flower)
  }
}

// Phase B: Enhanced door with awning/overhang
function addDoorWithAwning(group: THREE.Group, x: number, d: number, ts: number, pal: BPalette, hash: number): void {
  addDoor(group, x, d, ts, pal)

  // Step/threshold
  const step = new THREE.Mesh(
    new THREE.BoxGeometry(ts * 0.4, ts * 0.04, ts * 0.12),
    new THREE.MeshLambertMaterial({ color: darken(pal.wall, 0.2) })
  )
  step.position.set(x, ts * 0.02, d + ts * 0.06)
  group.add(step)

  // Small awning over door (every other building)
  if (hash % 2 === 0) {
    const awningMat = new THREE.MeshLambertMaterial({ color: darken(pal.roof, 0.1) })
    const awning = new THREE.Mesh(
      new THREE.BoxGeometry(ts * 0.45, ts * 0.03, ts * 0.15),
      awningMat
    )
    awning.position.set(x, ts * 0.5, d + ts * 0.08)
    group.add(awning)
    // Awning brackets
    const bracketMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a })
    for (const bx of [-ts * 0.15, ts * 0.15]) {
      const bracket = new THREE.Mesh(
        new THREE.BoxGeometry(ts * 0.02, ts * 0.08, ts * 0.02),
        bracketMat
      )
      bracket.position.set(x + bx, ts * 0.47, d + ts * 0.12)
      group.add(bracket)
    }
  }
}

function buildGenericBuilding(obj: PlacedObject, def: ObjectDefinition, ts: number, pal: BPalette): THREE.Group {
  const group = new THREE.Group()
  const hash = simpleHash(obj.id)
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const floors = (obj.properties.floors as number) || 1
  const wallH = floors * ts * 0.7

  addWalls(group, w, wallH, d, pal)
  addTimberFraming(group, w, wallH, d, ts, hash)
  addEaves(group, w, wallH, d, ts, pal.roof)
  addPitchedRoof(group, w, wallH, d, ts * 0.5, pal.roof)
  addDoorWithAwning(group, w / 2, d, ts, pal, hash)
  if (def.styleSetSlots.includes('window')) {
    addWindows(group, w, d, floors, ts, pal)
    addFlowerBoxes(group, w, d, floors, ts, hash)
  }
  addBuildingShadow(group, w, d)

  group.position.set(obj.x * ts, obj.elevation * ts, obj.y * ts)
  return group
}

function buildTavern(obj: PlacedObject, def: ObjectDefinition, ts: number, pal: BPalette, hash: number): THREE.Group {
  const group = new THREE.Group()
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const wallH = ts * 1.6 // 2-story

  addWalls(group, w, wallH, d, pal)
  addTimberFraming(group, w, wallH, d, ts, hash)
  addEaves(group, w, wallH, d, ts, pal.roof)
  addPitchedRoof(group, w, wallH, d, ts * 0.6, pal.roof)
  addDoorWithAwning(group, w / 2, d, ts, pal, hash)
  addWindows(group, w, d, 2, ts, pal)
  addFlowerBoxes(group, w, d, 2, ts, hash)

  // Chimney
  const chimGeo = new THREE.BoxGeometry(ts * 0.2, ts * 0.6, ts * 0.2)
  const chimMat = new THREE.MeshLambertMaterial({ color: 0x5a4a3a })
  const chimney = new THREE.Mesh(chimGeo, chimMat)
  chimney.position.set(w * 0.8, wallH + ts * 0.5, d * 0.3)
  group.add(chimney)

  // Hanging tavern sign
  const signPoleGeo = new THREE.BoxGeometry(ts * 0.03, ts * 0.3, ts * 0.03)
  const signPoleMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a })
  const signPole = new THREE.Mesh(signPoleGeo, signPoleMat)
  signPole.position.set(w * 0.3, wallH * 0.5, d + ts * 0.15)
  group.add(signPole)

  const signBoard = new THREE.Mesh(
    new THREE.BoxGeometry(ts * 0.4, ts * 0.25, ts * 0.03),
    new THREE.MeshLambertMaterial({ color: 0xc8a050 })
  )
  signBoard.position.set(w * 0.3, wallH * 0.4, d + ts * 0.25)
  group.add(signBoard)

  // Warm glow from tavern interior spilling out
  const glow = new THREE.PointLight(0xffaa44, 1.2, ts * 8)
  glow.position.set(w / 2, ts * 0.5, d + ts * 0.5)
  group.add(glow)

  addBuildingShadow(group, w, d)
  group.position.set(obj.x * ts, obj.elevation * ts, obj.y * ts)
  return group
}

function buildShop(obj: PlacedObject, def: ObjectDefinition, ts: number, pal: BPalette, hash: number): THREE.Group {
  const group = new THREE.Group()
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const wallH = ts * 1.2

  addWalls(group, w, wallH, d, pal)
  addTimberFraming(group, w, wallH, d, ts, hash)
  addEaves(group, w, wallH, d, ts, pal.roof)
  addPitchedRoof(group, w, wallH, d, ts * 0.35, pal.roof)
  addDoor(group, w / 2, d, ts, pal)
  addWindows(group, w, d, 1, ts, pal)

  // Awning over the front
  const awningColors = [0xaa3333, 0x3333aa, 0x33aa33, 0xaaaa33]
  const awningColor = awningColors[hash % awningColors.length]
  const awningShape = new THREE.Shape()
  awningShape.moveTo(0, 0)
  awningShape.lineTo(ts * 0.5, -ts * 0.15)
  awningShape.lineTo(ts * 0.5, -ts * 0.12)
  awningShape.lineTo(0, 0.03)
  const awningGeo = new THREE.ExtrudeGeometry(awningShape, { depth: w - 4, bevelEnabled: false })
  const awning = new THREE.Mesh(awningGeo, new THREE.MeshLambertMaterial({ color: awningColor }))
  awning.position.set(2, wallH * 0.55, d + 0.5)
  awning.rotation.y = Math.PI / 2
  group.add(awning)

  // Display window (larger glass pane) - warm glow at night
  const displayGeo = new THREE.BoxGeometry(w * 0.6, ts * 0.3, 1)
  const displayMat = new THREE.MeshLambertMaterial({ color: 0xffcc66, emissive: 0xffaa33, emissiveIntensity: 0.6 })
  const display = new THREE.Mesh(displayGeo, displayMat)
  display.position.set(w / 2, ts * 0.35, d + 0.3)
  group.add(display)

  addBuildingShadow(group, w, d)
  group.position.set(obj.x * ts, (obj.elevation || 0) * ts, obj.y * ts)
  return group
}

function buildTower(obj: PlacedObject, def: ObjectDefinition, ts: number, pal: BPalette, hash: number): THREE.Group {
  const group = new THREE.Group()
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const wallH = ts * 2.5 // tall!

  // Stone-colored palette override for towers
  const towerPal = { wall: 0x6a6a70, roof: 0x4a3a30, door: pal.door }

  addWalls(group, w, wallH, d, towerPal)

  // Pointed/conical roof
  const coneGeo = new THREE.ConeGeometry(w * 0.55, ts * 0.8, 6)
  const coneMat = new THREE.MeshLambertMaterial({ color: towerPal.roof })
  const cone = new THREE.Mesh(coneGeo, coneMat)
  cone.position.set(w / 2, wallH + ts * 0.4, d / 2)
  group.add(cone)

  // Narrow windows (arrow slits)
  const slitGeo = new THREE.BoxGeometry(ts * 0.06, ts * 0.2, 1.5)
  const slitMat = new THREE.MeshLambertMaterial({ color: 0x1a1a2a })
  for (let f = 0; f < 3; f++) {
    const sy = ts * 0.5 + f * ts * 0.7
    const slit = new THREE.Mesh(slitGeo, slitMat)
    slit.position.set(w / 2, sy, d + 0.3)
    group.add(slit)
  }

  addDoor(group, w / 2, d, ts, towerPal)
  addBuildingShadow(group, w, d)
  group.position.set(obj.x * ts, (obj.elevation || 0) * ts, obj.y * ts)
  return group
}

function buildBalconyHouse(obj: PlacedObject, def: ObjectDefinition, ts: number, pal: BPalette, hash: number): THREE.Group {
  const group = new THREE.Group()
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const wallH = ts * 1.4 // 2 story

  addWalls(group, w, wallH, d, pal)
  addTimberFraming(group, w, wallH, d, ts, hash)
  addEaves(group, w, wallH, d, ts, pal.roof)
  addPitchedRoof(group, w, wallH, d, ts * 0.45, pal.roof)
  addDoorWithAwning(group, w * 0.3, d, ts, pal, hash)
  addWindows(group, w, d, 2, ts, pal)
  addFlowerBoxes(group, w, d, 2, ts, hash)

  // Balcony on second floor
  const balconyFloor = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.6, ts * 0.04, ts * 0.35),
    new THREE.MeshLambertMaterial({ color: darken(pal.wall, 0.15) })
  )
  balconyFloor.position.set(w * 0.6, ts * 0.7, d + ts * 0.15)
  group.add(balconyFloor)

  // Railing
  const railMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a })
  const railGeo = new THREE.BoxGeometry(w * 0.6, ts * 0.02, ts * 0.02)
  const topRail = new THREE.Mesh(railGeo, railMat)
  topRail.position.set(w * 0.6, ts * 0.88, d + ts * 0.32)
  group.add(topRail)

  // Railing posts
  const postGeo = new THREE.BoxGeometry(ts * 0.02, ts * 0.18, ts * 0.02)
  for (let i = 0; i < 4; i++) {
    const post = new THREE.Mesh(postGeo, railMat)
    post.position.set(w * 0.6 - w * 0.25 + i * w * 0.17, ts * 0.79, d + ts * 0.32)
    group.add(post)
  }

  // Balcony door
  const bDoor = new THREE.Mesh(
    new THREE.BoxGeometry(ts * 0.2, ts * 0.35, 1),
    new THREE.MeshLambertMaterial({ color: pal.door })
  )
  bDoor.position.set(w * 0.6, ts * 0.88, d + 0.3)
  group.add(bDoor)

  addBuildingShadow(group, w, d)
  group.position.set(obj.x * ts, (obj.elevation || 0) * ts, obj.y * ts)
  return group
}

function buildArchway(obj: PlacedObject, def: ObjectDefinition, ts: number, pal: BPalette): THREE.Group {
  const group = new THREE.Group()
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const archH = ts * 1.2
  const pillarW = ts * 0.4

  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x6a6a68 })
  const darkStoneMat = new THREE.MeshLambertMaterial({ color: 0x555550 })

  // Left pillar
  const pillarGeo = new THREE.BoxGeometry(pillarW, archH, d)
  const lPillar = new THREE.Mesh(pillarGeo, stoneMat)
  lPillar.position.set(pillarW / 2, archH / 2, d / 2)
  group.add(lPillar)

  // Right pillar
  const rPillar = new THREE.Mesh(pillarGeo, stoneMat)
  rPillar.position.set(w - pillarW / 2, archH / 2, d / 2)
  group.add(rPillar)

  // Top beam
  const beamGeo = new THREE.BoxGeometry(w, ts * 0.3, d + 2)
  const beam = new THREE.Mesh(beamGeo, darkStoneMat)
  beam.position.set(w / 2, archH + ts * 0.15, d / 2)
  group.add(beam)

  // Arch curve (half-cylinder approximation)
  const archGeo = new THREE.CylinderGeometry(
    (w - pillarW * 2) / 2, (w - pillarW * 2) / 2,
    d, 12, 1, false, 0, Math.PI
  )
  const arch = new THREE.Mesh(archGeo, darkStoneMat)
  arch.rotation.x = Math.PI / 2
  arch.rotation.z = Math.PI / 2
  arch.position.set(w / 2, archH, d / 2)
  group.add(arch)

  addBuildingShadow(group, w, d)
  group.position.set(obj.x * ts, (obj.elevation || 0) * ts, obj.y * ts)
  return group
}

function buildStaircase(obj: PlacedObject, def: ObjectDefinition, ts: number): THREE.Group {
  const group = new THREE.Group()
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const steps = 6
  const stepH = ts * 0.12
  const stepD = d / steps

  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x7a7a78 })
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x5a5a58 })

  for (let i = 0; i < steps; i++) {
    const stepGeo = new THREE.BoxGeometry(w, stepH, stepD - 1)
    const step = new THREE.Mesh(stepGeo, i % 2 === 0 ? stoneMat : darkMat)
    step.position.set(w / 2, stepH / 2 + i * stepH, d - i * stepD - stepD / 2)
    group.add(step)
  }

  // Side walls
  const wallH = steps * stepH + ts * 0.2
  const wallGeo = new THREE.BoxGeometry(ts * 0.1, wallH, d)
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x6a6a68 })
  for (const sx of [ts * 0.05, w - ts * 0.05]) {
    const wall = new THREE.Mesh(wallGeo, wallMat)
    wall.position.set(sx, wallH / 2, d / 2)
    group.add(wall)
  }

  addBuildingShadow(group, w, d)
  group.position.set(obj.x * ts, (obj.elevation || 0) * ts, obj.y * ts)
  return group
}

function buildRowHouse(obj: PlacedObject, def: ObjectDefinition, ts: number, pal: BPalette): THREE.Group {
  const group = new THREE.Group()
  const hash = simpleHash(obj.id)
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const floors = (obj.properties.floors as number) || 2
  const wallH = floors * ts * 0.65

  addWalls(group, w, wallH, d, pal)
  addTimberFraming(group, w, wallH, d, ts, hash)
  addEaves(group, w, wallH, d, ts, pal.roof)
  addPitchedRoof(group, w, wallH, d, ts * 0.4, pal.roof)

  // Narrow door on front
  const dw = ts * 0.2, dh = ts * 0.4
  const doorMat = new THREE.MeshLambertMaterial({ color: pal.door })
  const door = new THREE.Mesh(new THREE.BoxGeometry(dw, dh, 1.5), doorMat)
  door.position.set(w / 2, dh / 2, d + 0.3)
  group.add(door)

  // Single window per floor
  const winGeo = new THREE.BoxGeometry(ts * 0.12, ts * 0.15, 1.5)
  const winMat = new THREE.MeshLambertMaterial({ color: 0xffcc66, emissive: 0xffaa33, emissiveIntensity: 0.7 })
  for (let f = 0; f < floors; f++) {
    const wy = ts * 0.35 + f * ts * 0.65
    const win = new THREE.Mesh(winGeo, winMat)
    win.position.set(w / 2, wy, d + 0.3)
    group.add(win)
    const winLight = new THREE.PointLight(0xffaa44, 0.25, ts * 2.5)
    winLight.position.set(w / 2, wy, d + ts * 0.4)
    group.add(winLight)
  }

  addFlowerBoxes(group, w, d, floors, ts, hash)
  addBuildingShadow(group, w, d)
  group.position.set(obj.x * ts, (obj.elevation || 0) * ts, obj.y * ts)
  return group
}

function buildTownGate(obj: PlacedObject, def: ObjectDefinition, ts: number): THREE.Group {
  const group = new THREE.Group()
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const gateH = ts * 1.8
  const towerR = ts * 0.3
  const towerH = ts * 2.4

  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x5a5a60 })
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x4a4a50 })

  // Two flanking towers (cylindrical)
  for (const tx of [towerR + 1, w - towerR - 1]) {
    const tower = new THREE.Mesh(
      new THREE.CylinderGeometry(towerR, towerR * 1.1, towerH, 8), stoneMat
    )
    tower.position.set(tx, towerH / 2, d / 2)
    group.add(tower)

    // Crenellations (small boxes on top)
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2
      const cren = new THREE.Mesh(
        new THREE.BoxGeometry(ts * 0.08, ts * 0.12, ts * 0.08), darkMat
      )
      cren.position.set(
        tx + Math.cos(angle) * towerR * 0.85,
        towerH + ts * 0.06,
        d / 2 + Math.sin(angle) * towerR * 0.85
      )
      group.add(cren)
    }

    // Conical tower roof
    const roofCone = new THREE.Mesh(
      new THREE.ConeGeometry(towerR * 1.2, ts * 0.5, 8),
      new THREE.MeshLambertMaterial({ color: 0x4a3a30 })
    )
    roofCone.position.set(tx, towerH + ts * 0.35, d / 2)
    group.add(roofCone)

    // Wall lantern on each tower
    const lampMat = new THREE.MeshLambertMaterial({ color: 0xffdd44, emissive: 0xffaa00, emissiveIntensity: 0.8 })
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(ts * 0.06, 6, 5), lampMat)
    lamp.position.set(tx, gateH * 0.7, d / 2 + towerR + 1)
    group.add(lamp)
    const light = new THREE.PointLight(0xffaa44, 0.8, ts * 5)
    light.position.set(tx, gateH * 0.7, d / 2 + towerR)
    group.add(light)
  }

  // Connecting wall/beam above the gate
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(w - towerR * 2, ts * 0.5, d + 2), stoneMat
  )
  beam.position.set(w / 2, gateH + ts * 0.25, d / 2)
  group.add(beam)

  // Archway opening
  const archGeo = new THREE.CylinderGeometry(
    (w - towerR * 4) / 2, (w - towerR * 4) / 2,
    d + 4, 12, 1, false, 0, Math.PI
  )
  const arch = new THREE.Mesh(archGeo, darkMat)
  arch.rotation.x = Math.PI / 2
  arch.rotation.z = Math.PI / 2
  arch.position.set(w / 2, gateH, d / 2)
  group.add(arch)

  // Portcullis hint (dark grid)
  const portMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a })
  for (let i = -2; i <= 2; i++) {
    const bar = new THREE.Mesh(
      new THREE.BoxGeometry(ts * 0.02, gateH * 0.7, ts * 0.02), portMat
    )
    bar.position.set(w / 2 + i * ts * 0.15, gateH * 0.35, d / 2)
    group.add(bar)
  }

  addBuildingShadow(group, w, d)
  group.position.set(obj.x * ts, (obj.elevation || 0) * ts, obj.y * ts)
  return group
}

function buildCornerBuilding(obj: PlacedObject, def: ObjectDefinition, ts: number, pal: BPalette, hash: number): THREE.Group {
  const group = new THREE.Group()
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const floors = (obj.properties.floors as number) || 2
  const wallH = floors * ts * 0.7

  // Main body
  addWalls(group, w, wallH, d, pal)
  addTimberFraming(group, w, wallH, d, ts, hash)
  addEaves(group, w, wallH, d, ts, pal.roof)
  addPitchedRoof(group, w, wallH, d, ts * 0.45, pal.roof)
  addDoorWithAwning(group, w / 2, d, ts, pal, hash)
  addWindows(group, w, d, floors, ts, pal)

  // Chamfered corner: angled face on one corner
  const chamferSize = ts * 0.5
  const chamferGeo = new THREE.BoxGeometry(chamferSize * 1.4, wallH, ts * 0.1)
  const chamferMat = new THREE.MeshLambertMaterial({ color: pal.wall })
  const chamfer = new THREE.Mesh(chamferGeo, chamferMat)
  chamfer.rotation.y = Math.PI / 4
  chamfer.position.set(w - chamferSize * 0.3, wallH / 2, d - chamferSize * 0.3)
  group.add(chamfer)

  // Awning on the angled corner face
  const awningColors = [0xaa3333, 0x3355aa, 0x33aa55, 0xcc8833]
  const awningMat = new THREE.MeshLambertMaterial({ color: awningColors[hash % awningColors.length] })
  const awning = new THREE.Mesh(
    new THREE.BoxGeometry(chamferSize * 1.2, ts * 0.03, ts * 0.3), awningMat
  )
  awning.rotation.y = Math.PI / 4
  awning.position.set(w - chamferSize * 0.2, wallH * 0.6, d - chamferSize * 0.1)
  group.add(awning)

  // Corner window (on the angled face)
  const winMat = new THREE.MeshLambertMaterial({ color: 0xffcc66, emissive: 0xffaa33, emissiveIntensity: 0.7 })
  const cornerWin = new THREE.Mesh(new THREE.BoxGeometry(ts * 0.18, ts * 0.18, 1), winMat)
  cornerWin.rotation.y = Math.PI / 4
  cornerWin.position.set(w - chamferSize * 0.25, wallH * 0.45, d - chamferSize * 0.25)
  group.add(cornerWin)

  addFlowerBoxes(group, w, d, floors, ts, hash)
  addBuildingShadow(group, w, d)
  group.position.set(obj.x * ts, (obj.elevation || 0) * ts, obj.y * ts)
  return group
}

function buildClockTower(obj: PlacedObject, def: ObjectDefinition, ts: number, pal: BPalette): THREE.Group {
  const group = new THREE.Group()
  const w = def.footprint.w * ts, d = def.footprint.h * ts
  const baseH = ts * 1.2
  const towerH = ts * 3.5

  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x5a5a68 })
  const darkMat = new THREE.MeshLambertMaterial({ color: 0x4a4a58 })

  // Wide base
  const baseGeo = new THREE.BoxGeometry(w, baseH, d)
  const base = new THREE.Mesh(baseGeo, stoneMat)
  base.position.set(w / 2, baseH / 2, d / 2)
  group.add(base)

  // Narrow tower shaft
  const shaftW = w * 0.6, shaftD = d * 0.6
  const shaftGeo = new THREE.BoxGeometry(shaftW, towerH - baseH, shaftD)
  const shaft = new THREE.Mesh(shaftGeo, darkMat)
  shaft.position.set(w / 2, baseH + (towerH - baseH) / 2, d / 2)
  group.add(shaft)

  // Clock face (front)
  const clockBg = new THREE.Mesh(
    new THREE.CircleGeometry(ts * 0.35, 16),
    new THREE.MeshLambertMaterial({ color: 0xe8e0c8 })
  )
  clockBg.position.set(w / 2, towerH - ts * 0.5, d / 2 + shaftD / 2 + 0.5)
  group.add(clockBg)

  // Clock hands
  const handMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a })
  const hourHand = new THREE.Mesh(new THREE.BoxGeometry(ts * 0.02, ts * 0.2, 0.5), handMat)
  hourHand.position.set(w / 2, towerH - ts * 0.45, d / 2 + shaftD / 2 + 1)
  hourHand.rotation.z = 0.8
  group.add(hourHand)
  const minHand = new THREE.Mesh(new THREE.BoxGeometry(ts * 0.015, ts * 0.28, 0.5), handMat)
  minHand.position.set(w / 2, towerH - ts * 0.4, d / 2 + shaftD / 2 + 1.2)
  minHand.rotation.z = -0.3
  group.add(minHand)

  // Pointed roof
  const roofGeo = new THREE.ConeGeometry(shaftW * 0.6, ts * 1.0, 4)
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x3a3a4a })
  const roof = new THREE.Mesh(roofGeo, roofMat)
  roof.position.set(w / 2, towerH + ts * 0.5, d / 2)
  roof.rotation.y = Math.PI / 4
  group.add(roof)

  // Windows on shaft
  const winMat = new THREE.MeshLambertMaterial({ color: 0x87ceeb, emissive: 0x2244aa, emissiveIntensity: 0.2 })
  for (let i = 0; i < 3; i++) {
    const wy = baseH + ts * 0.5 + i * ts * 0.7
    const win = new THREE.Mesh(new THREE.BoxGeometry(ts * 0.1, ts * 0.15, 1), winMat)
    win.position.set(w / 2, wy, d / 2 + shaftD / 2 + 0.3)
    group.add(win)
  }

  addDoor(group, w / 2, d, ts, pal)
  addBuildingShadow(group, w, d)
  group.position.set(obj.x * ts, (obj.elevation || 0) * ts, obj.y * ts)
  return group
}

function buildProp(obj: PlacedObject, def: ObjectDefinition, tileSize: number): THREE.Group {
  const group = new THREE.Group()
  const x = obj.x * tileSize + (def.footprint.w * tileSize) / 2
  const z = obj.y * tileSize + (def.footprint.h * tileSize) / 2
  const hash = simpleHash(obj.id)

  switch (def.id) {
    case 'tree': {
      // Varied tree sizes
      const scale = 0.8 + (hash % 5) * 0.1
      const trunkH = tileSize * 0.5 * scale

      const trunkGeo = new THREE.CylinderGeometry(
        tileSize * 0.06 * scale, tileSize * 0.1 * scale, trunkH, 6
      )
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1a })
      const trunk = new THREE.Mesh(trunkGeo, trunkMat)
      trunk.position.set(x, trunkH / 2, z)
      group.add(trunk)

      // Layered canopy for fuller look
      const greenVariants = [0x2d5a27, 0x3a6a30, 0x256020, 0x408030]
      const canopyColor = greenVariants[hash % greenVariants.length]
      const canopyR = tileSize * 0.35 * scale

      for (let i = 0; i < 3; i++) {
        const r = canopyR * (1 - i * 0.15)
        const y = trunkH + canopyR * 0.3 + i * canopyR * 0.4
        const cGeo = new THREE.SphereGeometry(r, 7, 5)
        const cMat = new THREE.MeshLambertMaterial({ color: darken(canopyColor, i * 0.05) })
        const c = new THREE.Mesh(cGeo, cMat)
        c.position.set(x + (hash % 3 - 1) * 1, y, z + ((hash >> 2) % 3 - 1) * 1)
        group.add(c)
      }

      // Tree shadow
      addGroundShadow(group, x, z, canopyR * 1.5)
      break
    }

    case 'bush': {
      const bushScale = 0.7 + (hash % 4) * 0.15
      const greenVar = [0x3a7a33, 0x458a3a, 0x2e6a28][hash % 3]
      const bushGeo = new THREE.SphereGeometry(tileSize * 0.2 * bushScale, 6, 4)
      const bushMat = new THREE.MeshLambertMaterial({ color: greenVar })
      const bush = new THREE.Mesh(bushGeo, bushMat)
      bush.position.set(x, tileSize * 0.12 * bushScale, z)
      group.add(bush)

      // Second smaller sphere for organic feel
      const b2 = new THREE.Mesh(
        new THREE.SphereGeometry(tileSize * 0.14 * bushScale, 5, 4),
        new THREE.MeshLambertMaterial({ color: darken(greenVar, 0.1) })
      )
      b2.position.set(x + tileSize * 0.08, tileSize * 0.1 * bushScale, z - tileSize * 0.06)
      group.add(b2)
      break
    }

    case 'lamppost': {
      // Base
      const baseGeo = new THREE.CylinderGeometry(tileSize * 0.06, tileSize * 0.08, tileSize * 0.08, 6)
      const metalMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a })
      const base = new THREE.Mesh(baseGeo, metalMat)
      base.position.set(x, tileSize * 0.04, z)
      group.add(base)

      // Pole
      const poleGeo = new THREE.CylinderGeometry(tileSize * 0.02, tileSize * 0.03, tileSize * 1.1, 6)
      const pole = new THREE.Mesh(poleGeo, metalMat)
      pole.position.set(x, tileSize * 0.6, z)
      group.add(pole)

      // Arm
      const armGeo = new THREE.BoxGeometry(tileSize * 0.2, tileSize * 0.02, tileSize * 0.02)
      const arm = new THREE.Mesh(armGeo, metalMat)
      arm.position.set(x + tileSize * 0.1, tileSize * 1.12, z)
      group.add(arm)

      // Lamp housing
      const lampGeo = new THREE.CylinderGeometry(tileSize * 0.06, tileSize * 0.04, tileSize * 0.08, 6)
      const lampMat = new THREE.MeshLambertMaterial({
        color: 0xffdd44, emissive: 0xffaa00, emissiveIntensity: 0.9
      })
      const lamp = new THREE.Mesh(lampGeo, lampMat)
      lamp.position.set(x + tileSize * 0.2, tileSize * 1.08, z)
      group.add(lamp)

      // Lamppost light - bright warm pool on the ground
      const light = new THREE.PointLight(0xffaa44, 1.4, tileSize * 8)
      light.position.set(x + tileSize * 0.2, tileSize * 1.05, z)
      group.add(light)
      break
    }

    case 'bench': {
      const woodColor = 0x6b4a28
      const metalColor = 0x3a3a3a
      const bw = tileSize * 1.4
      const bh = tileSize * 0.25
      const bd = tileSize * 0.3

      // Seat
      const seatGeo = new THREE.BoxGeometry(bw, tileSize * 0.03, bd)
      const woodMat = new THREE.MeshLambertMaterial({ color: woodColor })
      const seat = new THREE.Mesh(seatGeo, woodMat)
      seat.position.set(x, bh, z)
      group.add(seat)

      // Back
      const backGeo = new THREE.BoxGeometry(bw, tileSize * 0.2, tileSize * 0.02)
      const back = new THREE.Mesh(backGeo, woodMat)
      back.position.set(x, bh + tileSize * 0.12, z - bd / 2)
      back.rotation.x = -0.1
      group.add(back)

      // Legs
      const legGeo = new THREE.BoxGeometry(tileSize * 0.03, bh, tileSize * 0.03)
      const legMat = new THREE.MeshLambertMaterial({ color: metalColor })
      for (const lx of [-bw * 0.4, bw * 0.4]) {
        for (const lz of [-bd * 0.35, bd * 0.35]) {
          const leg = new THREE.Mesh(legGeo, legMat)
          leg.position.set(x + lx, bh / 2, z + lz)
          group.add(leg)
        }
      }

      addGroundShadow(group, x, z, tileSize * 0.8)
      break
    }

    case 'fountain': {
      // Octagonal base
      const baseGeo = new THREE.CylinderGeometry(tileSize * 0.7, tileSize * 0.8, tileSize * 0.25, 8)
      const stoneMat = new THREE.MeshLambertMaterial({ color: 0x808080 })
      const base = new THREE.Mesh(baseGeo, stoneMat)
      base.position.set(x, tileSize * 0.125, z)
      group.add(base)

      // Inner basin
      const basinGeo = new THREE.CylinderGeometry(tileSize * 0.55, tileSize * 0.55, tileSize * 0.15, 8)
      const basin = new THREE.Mesh(basinGeo, new THREE.MeshLambertMaterial({ color: 0x606060 }))
      basin.position.set(x, tileSize * 0.25, z)
      group.add(basin)

      // Water surface
      const waterGeo = new THREE.CylinderGeometry(tileSize * 0.5, tileSize * 0.5, tileSize * 0.02, 8)
      const waterMat = new THREE.MeshLambertMaterial({
        color: 0x3388bb, transparent: true, opacity: 0.6,
        emissive: 0x112244, emissiveIntensity: 0.1
      })
      const water = new THREE.Mesh(waterGeo, waterMat)
      water.position.set(x, tileSize * 0.3, z)
      group.add(water)

      // Center pillar + top
      const pillarGeo = new THREE.CylinderGeometry(tileSize * 0.05, tileSize * 0.07, tileSize * 0.6, 6)
      const pillar = new THREE.Mesh(pillarGeo, stoneMat)
      pillar.position.set(x, tileSize * 0.5, z)
      group.add(pillar)

      const topGeo = new THREE.SphereGeometry(tileSize * 0.08, 6, 5)
      const top = new THREE.Mesh(topGeo, stoneMat)
      top.position.set(x, tileSize * 0.82, z)
      group.add(top)

      addGroundShadow(group, x, z, tileSize * 1)
      break
    }

    case 'sign': {
      const poleGeo = new THREE.BoxGeometry(tileSize * 0.04, tileSize * 0.6, tileSize * 0.04)
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x6b4a28 })
      const pole = new THREE.Mesh(poleGeo, woodMat)
      pole.position.set(x, tileSize * 0.3, z)
      group.add(pole)

      const signGeo = new THREE.BoxGeometry(tileSize * 0.4, tileSize * 0.25, tileSize * 0.03)
      const signMat = new THREE.MeshLambertMaterial({ color: 0xc8a868 })
      const sign = new THREE.Mesh(signGeo, signMat)
      sign.position.set(x, tileSize * 0.55, z)
      group.add(sign)
      break
    }

    case 'well': {
      const stoneGeo = new THREE.CylinderGeometry(tileSize * 0.25, tileSize * 0.3, tileSize * 0.35, 8)
      const stoneMat = new THREE.MeshLambertMaterial({ color: 0x707070 })
      const stone = new THREE.Mesh(stoneGeo, stoneMat)
      stone.position.set(x, tileSize * 0.175, z)
      group.add(stone)

      const supportGeo = new THREE.BoxGeometry(tileSize * 0.03, tileSize * 0.5, tileSize * 0.03)
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1a })
      for (const sx of [-1, 1]) {
        const support = new THREE.Mesh(supportGeo, woodMat)
        support.position.set(x + sx * tileSize * 0.2, tileSize * 0.6, z)
        group.add(support)
      }

      const roofGeo = new THREE.BoxGeometry(tileSize * 0.5, tileSize * 0.03, tileSize * 0.35)
      const roofMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1a })
      const roof = new THREE.Mesh(roofGeo, roofMat)
      roof.position.set(x, tileSize * 0.86, z)
      group.add(roof)

      addGroundShadow(group, x, z, tileSize * 0.4)
      break
    }

    // === TIER 2: STREET FURNITURE ===

    case 'wall_lantern': {
      // Wall-mounted bracket
      const bracketMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a })
      const bracket = new THREE.Mesh(
        new THREE.BoxGeometry(tileSize * 0.04, tileSize * 0.04, tileSize * 0.2),
        bracketMat
      )
      bracket.position.set(x, tileSize * 0.55, z)
      group.add(bracket)

      // Vertical mount
      const mount = new THREE.Mesh(
        new THREE.BoxGeometry(tileSize * 0.03, tileSize * 0.15, tileSize * 0.03),
        bracketMat
      )
      mount.position.set(x, tileSize * 0.5, z - tileSize * 0.08)
      group.add(mount)

      // Lantern body (hexagonal)
      const lanternGeo = new THREE.CylinderGeometry(tileSize * 0.06, tileSize * 0.05, tileSize * 0.12, 6)
      const lanternMat = new THREE.MeshLambertMaterial({
        color: 0xffcc44, emissive: 0xffaa00, emissiveIntensity: 0.85
      })
      const lantern = new THREE.Mesh(lanternGeo, lanternMat)
      lantern.position.set(x, tileSize * 0.52, z + tileSize * 0.08)
      group.add(lantern)

      // Lantern cap
      const cap = new THREE.Mesh(
        new THREE.ConeGeometry(tileSize * 0.07, tileSize * 0.05, 6),
        bracketMat
      )
      cap.position.set(x, tileSize * 0.61, z + tileSize * 0.08)
      group.add(cap)

      // Wall lantern warm glow
      const light = new THREE.PointLight(0xffaa44, 1.0, tileSize * 6)
      light.position.set(x, tileSize * 0.5, z + tileSize * 0.08)
      group.add(light)
      break
    }

    case 'hanging_sign': {
      // Pole extending from wall
      const poleMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a })
      const pole = new THREE.Mesh(
        new THREE.BoxGeometry(tileSize * 0.03, tileSize * 0.03, tileSize * 0.35),
        poleMat
      )
      pole.position.set(x, tileSize * 0.6, z)
      group.add(pole)

      // Chain links (simplified as thin rods)
      for (const sx of [-tileSize * 0.08, tileSize * 0.08]) {
        const chain = new THREE.Mesh(
          new THREE.BoxGeometry(tileSize * 0.01, tileSize * 0.1, tileSize * 0.01),
          poleMat
        )
        chain.position.set(x + sx, tileSize * 0.53, z + tileSize * 0.15)
        group.add(chain)
      }

      // Sign board
      const signColors = [0xc8a050, 0xa06830, 0x8a5a2a, 0xb88040]
      const signBoard = new THREE.Mesh(
        new THREE.BoxGeometry(tileSize * 0.3, tileSize * 0.2, tileSize * 0.03),
        new THREE.MeshLambertMaterial({ color: signColors[hash % signColors.length] })
      )
      signBoard.position.set(x, tileSize * 0.46, z + tileSize * 0.15)
      group.add(signBoard)
      break
    }

    case 'barrel': {
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x6b4226 })
      const bandMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a })

      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(tileSize * 0.18, tileSize * 0.15, tileSize * 0.35, 8),
        woodMat
      )
      body.position.set(x, tileSize * 0.175, z)
      group.add(body)

      // Metal bands
      for (const by of [0.06, 0.28]) {
        const band = new THREE.Mesh(
          new THREE.TorusGeometry(tileSize * 0.17, tileSize * 0.01, 4, 8),
          bandMat
        )
        band.rotation.x = Math.PI / 2
        band.position.set(x, tileSize * by, z)
        group.add(band)
      }

      addGroundShadow(group, x, z, tileSize * 0.25)
      break
    }

    case 'barrel_stack': {
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1a })
      const bandMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a })
      const barrelGeo = new THREE.CylinderGeometry(tileSize * 0.16, tileSize * 0.13, tileSize * 0.3, 8)

      // Bottom row: 2 barrels
      for (const bx of [-tileSize * 0.14, tileSize * 0.14]) {
        const b = new THREE.Mesh(barrelGeo, woodMat)
        b.position.set(x + bx, tileSize * 0.15, z)
        group.add(b)
      }

      // Top barrel
      const top = new THREE.Mesh(barrelGeo, woodMat)
      top.position.set(x, tileSize * 0.42, z)
      group.add(top)

      addGroundShadow(group, x, z, tileSize * 0.35)
      break
    }

    case 'crate': {
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x8b7355 })
      const trimMat = new THREE.MeshLambertMaterial({ color: 0x6a5a40 })

      const body = new THREE.Mesh(
        new THREE.BoxGeometry(tileSize * 0.3, tileSize * 0.3, tileSize * 0.3),
        woodMat
      )
      body.position.set(x, tileSize * 0.15, z)
      group.add(body)

      // Cross braces on front
      const braceGeo = new THREE.BoxGeometry(tileSize * 0.02, tileSize * 0.32, tileSize * 0.01)
      const b1 = new THREE.Mesh(braceGeo, trimMat)
      b1.rotation.z = 0.7
      b1.position.set(x, tileSize * 0.15, z + tileSize * 0.16)
      group.add(b1)
      const b2 = new THREE.Mesh(braceGeo, trimMat)
      b2.rotation.z = -0.7
      b2.position.set(x, tileSize * 0.15, z + tileSize * 0.16)
      group.add(b2)

      addGroundShadow(group, x, z, tileSize * 0.2)
      break
    }

    case 'crate_stack': {
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x7a6a50 })
      const crateGeo = new THREE.BoxGeometry(tileSize * 0.28, tileSize * 0.25, tileSize * 0.28)

      // Bottom crates
      for (const cx2 of [-tileSize * 0.12, tileSize * 0.12]) {
        const c = new THREE.Mesh(crateGeo, woodMat)
        c.position.set(x + cx2, tileSize * 0.125, z)
        group.add(c)
      }

      // Top crate (offset)
      const topCrate = new THREE.Mesh(crateGeo, new THREE.MeshLambertMaterial({ color: 0x8a7a5a }))
      topCrate.position.set(x + tileSize * 0.04, tileSize * 0.375, z - tileSize * 0.02)
      topCrate.rotation.y = 0.3
      group.add(topCrate)

      addGroundShadow(group, x, z, tileSize * 0.35)
      break
    }

    case 'cafe_table': {
      const metalMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a })
      const tableMat = new THREE.MeshLambertMaterial({ color: 0xb8a088 })

      // Table top
      const tableTop = new THREE.Mesh(
        new THREE.CylinderGeometry(tileSize * 0.2, tileSize * 0.2, tileSize * 0.02, 8),
        tableMat
      )
      tableTop.position.set(x, tileSize * 0.32, z)
      group.add(tableTop)

      // Table leg
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(tileSize * 0.02, tileSize * 0.04, tileSize * 0.3, 6),
        metalMat
      )
      leg.position.set(x, tileSize * 0.15, z)
      group.add(leg)

      // Two chairs
      const chairMat = new THREE.MeshLambertMaterial({ color: 0x5a4a3a })
      for (const cz of [-tileSize * 0.25, tileSize * 0.25]) {
        // Seat
        const seat = new THREE.Mesh(
          new THREE.BoxGeometry(tileSize * 0.12, tileSize * 0.02, tileSize * 0.12),
          chairMat
        )
        seat.position.set(x, tileSize * 0.2, z + cz)
        group.add(seat)

        // Back
        const back = new THREE.Mesh(
          new THREE.BoxGeometry(tileSize * 0.12, tileSize * 0.12, tileSize * 0.015),
          chairMat
        )
        back.position.set(x, tileSize * 0.27, z + cz + (cz > 0 ? tileSize * 0.06 : -tileSize * 0.06))
        group.add(back)

        // Legs
        const chairLegGeo = new THREE.BoxGeometry(tileSize * 0.015, tileSize * 0.19, tileSize * 0.015)
        for (const lx of [-1, 1]) {
          for (const lz2 of [-1, 1]) {
            const cl = new THREE.Mesh(chairLegGeo, metalMat)
            cl.position.set(
              x + lx * tileSize * 0.05,
              tileSize * 0.095,
              z + cz + lz2 * tileSize * 0.05
            )
            group.add(cl)
          }
        }
      }

      addGroundShadow(group, x, z, tileSize * 0.35)
      break
    }

    case 'potted_plant': {
      // Terracotta pot
      const potMat = new THREE.MeshLambertMaterial({ color: 0xb06030 })
      const pot = new THREE.Mesh(
        new THREE.CylinderGeometry(tileSize * 0.1, tileSize * 0.07, tileSize * 0.15, 8),
        potMat
      )
      pot.position.set(x, tileSize * 0.075, z)
      group.add(pot)

      // Pot rim
      const rim = new THREE.Mesh(
        new THREE.TorusGeometry(tileSize * 0.1, tileSize * 0.015, 4, 8),
        potMat
      )
      rim.rotation.x = Math.PI / 2
      rim.position.set(x, tileSize * 0.15, z)
      group.add(rim)

      // Plant (bushy sphere)
      const greenVars = [0x3a8a3a, 0x2a7a2a, 0x4a9a4a]
      const plantMat = new THREE.MeshLambertMaterial({ color: greenVars[hash % 3] })
      const plant = new THREE.Mesh(
        new THREE.SphereGeometry(tileSize * 0.15, 6, 5),
        plantMat
      )
      plant.position.set(x, tileSize * 0.28, z)
      group.add(plant)

      // A couple extra small leaf clusters
      const leaf2 = new THREE.Mesh(
        new THREE.SphereGeometry(tileSize * 0.08, 5, 4),
        new THREE.MeshLambertMaterial({ color: darken(greenVars[hash % 3], 0.1) })
      )
      leaf2.position.set(x + tileSize * 0.08, tileSize * 0.22, z + tileSize * 0.05)
      group.add(leaf2)
      break
    }

    case 'planter_box': {
      const boxW = tileSize * 1.4
      const boxMat = new THREE.MeshLambertMaterial({ color: 0x6a5030 })

      // Wooden box
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(boxW, tileSize * 0.15, tileSize * 0.3),
        boxMat
      )
      box.position.set(x, tileSize * 0.075, z)
      group.add(box)

      // Dirt
      const dirt = new THREE.Mesh(
        new THREE.BoxGeometry(boxW - 2, tileSize * 0.03, tileSize * 0.26),
        new THREE.MeshLambertMaterial({ color: 0x5a4a30 })
      )
      dirt.position.set(x, tileSize * 0.14, z)
      group.add(dirt)

      // Plants sticking out
      const greenMat = new THREE.MeshLambertMaterial({ color: 0x3a8a3a })
      for (let i = 0; i < 4; i++) {
        const px2 = x - boxW * 0.35 + i * boxW * 0.25
        const plantBall = new THREE.Mesh(
          new THREE.SphereGeometry(tileSize * 0.08 + (hash + i) % 3 * tileSize * 0.02, 5, 4),
          greenMat
        )
        plantBall.position.set(px2, tileSize * 0.22, z)
        group.add(plantBall)
      }

      addGroundShadow(group, x, z, tileSize * 0.7)
      break
    }

    case 'fence': {
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x6a5030 })
      const fw = tileSize * 1.8
      const fh = tileSize * 0.4

      // Posts
      const postGeo = new THREE.BoxGeometry(tileSize * 0.06, fh + tileSize * 0.1, tileSize * 0.06)
      for (const px2 of [-fw * 0.45, 0, fw * 0.45]) {
        const post = new THREE.Mesh(postGeo, woodMat)
        post.position.set(x + px2, (fh + tileSize * 0.1) / 2, z)
        group.add(post)
      }

      // Horizontal rails
      const railGeo = new THREE.BoxGeometry(fw, tileSize * 0.03, tileSize * 0.03)
      for (const ry of [fh * 0.4, fh * 0.85]) {
        const rail = new THREE.Mesh(railGeo, woodMat)
        rail.position.set(x, ry, z)
        group.add(rail)
      }

      // Pickets
      const picketGeo = new THREE.BoxGeometry(tileSize * 0.03, fh * 0.7, tileSize * 0.02)
      for (let i = -4; i <= 4; i++) {
        const picket = new THREE.Mesh(picketGeo, woodMat)
        picket.position.set(x + i * fw * 0.1, fh * 0.5, z)
        group.add(picket)
      }
      break
    }

    // === TIER 3: LANDMARKS & ENVIRONMENT ===

    case 'bridge': {
      const bw = def.footprint.w * tileSize
      const bd = def.footprint.h * tileSize
      const stoneMat = new THREE.MeshLambertMaterial({ color: 0x7a7a70 })
      const darkMat = new THREE.MeshLambertMaterial({ color: 0x5a5a55 })

      // Bridge deck
      const deckGeo = new THREE.BoxGeometry(bw, tileSize * 0.12, bd)
      const deck = new THREE.Mesh(deckGeo, stoneMat)
      deck.position.set(x, tileSize * 0.35, z)
      group.add(deck)

      // Arch underneath
      const archGeo = new THREE.CylinderGeometry(bd * 0.4, bd * 0.4, bw - 4, 12, 1, false, 0, Math.PI)
      const arch = new THREE.Mesh(archGeo, darkMat)
      arch.rotation.z = Math.PI / 2
      arch.rotation.y = Math.PI / 2
      arch.position.set(x, tileSize * 0.15, z)
      group.add(arch)

      // Railings
      const railMat = new THREE.MeshLambertMaterial({ color: 0x5a5a55 })
      for (const rz of [-bd / 2 + 2, bd / 2 - 2]) {
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(bw, tileSize * 0.2, tileSize * 0.04), railMat
        )
        rail.position.set(x, tileSize * 0.5, z + rz)
        group.add(rail)

        // Railing posts
        for (let i = -2; i <= 2; i++) {
          const post = new THREE.Mesh(
            new THREE.BoxGeometry(tileSize * 0.04, tileSize * 0.25, tileSize * 0.04), railMat
          )
          post.position.set(x + i * bw * 0.2, tileSize * 0.48, z + rz)
          group.add(post)
        }
      }

      addGroundShadow(group, x, z, bw * 0.4)
      break
    }

    case 'water_channel': {
      const cw = def.footprint.w * tileSize
      const cd = def.footprint.h * tileSize
      const stoneMat = new THREE.MeshLambertMaterial({ color: 0x6a6a68 })

      // Stone edges
      for (const cx2 of [-cw * 0.4, cw * 0.4]) {
        const edge = new THREE.Mesh(
          new THREE.BoxGeometry(tileSize * 0.15, tileSize * 0.15, cd), stoneMat
        )
        edge.position.set(x + cx2, tileSize * 0.05, z)
        group.add(edge)
      }

      // Water surface (slightly below ground level)
      const waterMat = new THREE.MeshLambertMaterial({
        color: 0x3a6a9a, transparent: true, opacity: 0.7,
        emissive: 0x112244, emissiveIntensity: 0.1
      })
      const water = new THREE.Mesh(
        new THREE.BoxGeometry(cw * 0.6, tileSize * 0.02, cd), waterMat
      )
      water.position.set(x, -tileSize * 0.02, z)
      group.add(water)
      break
    }

    case 'market_stall': {
      const sw = def.footprint.w * tileSize * 0.9
      const sd = def.footprint.h * tileSize * 0.9
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x6a5030 })

      // Counter/table
      const counter = new THREE.Mesh(
        new THREE.BoxGeometry(sw, tileSize * 0.04, sd * 0.6), woodMat
      )
      counter.position.set(x, tileSize * 0.35, z + sd * 0.1)
      group.add(counter)

      // Poles
      const poleMat = new THREE.MeshLambertMaterial({ color: 0x4a3a20 })
      const poleGeo = new THREE.CylinderGeometry(tileSize * 0.03, tileSize * 0.03, tileSize * 0.9, 6)
      for (const px2 of [-sw * 0.4, sw * 0.4]) {
        for (const pz of [-sd * 0.15, sd * 0.35]) {
          const pole = new THREE.Mesh(poleGeo, poleMat)
          pole.position.set(x + px2, tileSize * 0.45, z + pz)
          group.add(pole)
        }
      }

      // Canopy (colored fabric)
      const canopyColors = [0xaa3333, 0xcc8833, 0x3355aa, 0x339944]
      const canopyMat = new THREE.MeshLambertMaterial({ color: canopyColors[hash % canopyColors.length] })
      const canopy = new THREE.Mesh(
        new THREE.BoxGeometry(sw + 4, tileSize * 0.03, sd + 2), canopyMat
      )
      canopy.position.set(x, tileSize * 0.88, z + sd * 0.05)
      group.add(canopy)

      // Goods on counter (small colored boxes)
      const goodColors = [0xddaa44, 0xaa4444, 0x44aa44, 0x8866cc]
      for (let i = 0; i < 4; i++) {
        const good = new THREE.Mesh(
          new THREE.BoxGeometry(tileSize * 0.1, tileSize * 0.08, tileSize * 0.1),
          new THREE.MeshLambertMaterial({ color: goodColors[(hash + i) % goodColors.length] })
        )
        good.position.set(x - sw * 0.3 + i * sw * 0.2, tileSize * 0.41, z + sd * 0.1)
        group.add(good)
      }

      addGroundShadow(group, x, z, tileSize * 0.8)
      break
    }

    case 'street_lamp_double': {
      const metalMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a })
      const lampMat = new THREE.MeshLambertMaterial({
        color: 0xffdd44, emissive: 0xffaa00, emissiveIntensity: 0.9
      })

      // Base
      const base = new THREE.Mesh(
        new THREE.CylinderGeometry(tileSize * 0.08, tileSize * 0.1, tileSize * 0.1, 6), metalMat
      )
      base.position.set(x, tileSize * 0.05, z)
      group.add(base)

      // Pole
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(tileSize * 0.025, tileSize * 0.035, tileSize * 1.3, 6), metalMat
      )
      pole.position.set(x, tileSize * 0.7, z)
      group.add(pole)

      // Two arms + lamps
      for (const side of [-1, 1]) {
        const arm = new THREE.Mesh(
          new THREE.BoxGeometry(tileSize * 0.25, tileSize * 0.02, tileSize * 0.02), metalMat
        )
        arm.position.set(x + side * tileSize * 0.12, tileSize * 1.32, z)
        group.add(arm)

        const lamp = new THREE.Mesh(
          new THREE.CylinderGeometry(tileSize * 0.05, tileSize * 0.035, tileSize * 0.07, 6), lampMat
        )
        lamp.position.set(x + side * tileSize * 0.24, tileSize * 1.28, z)
        group.add(lamp)
      }

      const light = new THREE.PointLight(0xffaa44, 1.8, tileSize * 10)
      light.position.set(x, tileSize * 1.3, z)
      group.add(light)
      break
    }

    case 'wagon': {
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x6a5030 })
      const metalMat = new THREE.MeshLambertMaterial({ color: 0x3a3a3a })
      const ww = def.footprint.w * tileSize * 0.8
      const wd = def.footprint.h * tileSize * 0.7

      // Wagon bed
      const bed = new THREE.Mesh(new THREE.BoxGeometry(ww, tileSize * 0.1, wd), woodMat)
      bed.position.set(x, tileSize * 0.3, z)
      group.add(bed)

      // Side walls
      for (const sz of [-wd / 2, wd / 2]) {
        const side = new THREE.Mesh(
          new THREE.BoxGeometry(ww, tileSize * 0.2, tileSize * 0.03), woodMat
        )
        side.position.set(x, tileSize * 0.45, z + sz)
        group.add(side)
      }
      // Back wall
      const back = new THREE.Mesh(
        new THREE.BoxGeometry(tileSize * 0.03, tileSize * 0.2, wd), woodMat
      )
      back.position.set(x - ww / 2, tileSize * 0.45, z)
      group.add(back)

      // Wheels
      const wheelGeo = new THREE.TorusGeometry(tileSize * 0.15, tileSize * 0.025, 6, 12)
      for (const wx of [-ww * 0.35, ww * 0.25]) {
        for (const wz of [-wd / 2 - 2, wd / 2 + 2]) {
          const wheel = new THREE.Mesh(wheelGeo, metalMat)
          wheel.rotation.y = Math.PI / 2
          wheel.position.set(x + wx, tileSize * 0.15, z + wz)
          group.add(wheel)
        }
      }

      // Tongue (pull bar)
      const tongue = new THREE.Mesh(
        new THREE.BoxGeometry(tileSize * 0.6, tileSize * 0.03, tileSize * 0.03), woodMat
      )
      tongue.position.set(x + ww / 2 + tileSize * 0.25, tileSize * 0.25, z)
      tongue.rotation.z = 0.15
      group.add(tongue)

      addGroundShadow(group, x, z, tileSize * 1.2)
      break
    }

    case 'statue': {
      const stoneMat = new THREE.MeshLambertMaterial({ color: 0x8a8a88 })
      const darkMat = new THREE.MeshLambertMaterial({ color: 0x6a6a68 })

      // Pedestal
      const pedestal = new THREE.Mesh(
        new THREE.BoxGeometry(tileSize * 0.35, tileSize * 0.25, tileSize * 0.35), darkMat
      )
      pedestal.position.set(x, tileSize * 0.125, z)
      group.add(pedestal)

      // Figure (simplified: body + head)
      const body = new THREE.Mesh(
        new THREE.CylinderGeometry(tileSize * 0.08, tileSize * 0.1, tileSize * 0.4, 8), stoneMat
      )
      body.position.set(x, tileSize * 0.45, z)
      group.add(body)

      const head = new THREE.Mesh(
        new THREE.SphereGeometry(tileSize * 0.07, 8, 6), stoneMat
      )
      head.position.set(x, tileSize * 0.72, z)
      group.add(head)

      // Outstretched arm
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(tileSize * 0.25, tileSize * 0.03, tileSize * 0.03), stoneMat
      )
      arm.position.set(x + tileSize * 0.1, tileSize * 0.55, z)
      arm.rotation.z = -0.4
      group.add(arm)

      addGroundShadow(group, x, z, tileSize * 0.3)
      break
    }

    case 'stone_wall': {
      const stoneMat = new THREE.MeshLambertMaterial({ color: 0x707068 })
      const darkMat = new THREE.MeshLambertMaterial({ color: 0x5a5a55 })
      const ww = tileSize * 1.8
      const wh = tileSize * 0.5

      // Main wall body
      const wallBody = new THREE.Mesh(
        new THREE.BoxGeometry(ww, wh, tileSize * 0.25),
        stoneMat
      )
      wallBody.position.set(x, wh / 2, z)
      group.add(wallBody)

      // Cap stones
      const capGeo = new THREE.BoxGeometry(ww + 2, tileSize * 0.06, tileSize * 0.3)
      const cap = new THREE.Mesh(capGeo, darkMat)
      cap.position.set(x, wh + tileSize * 0.03, z)
      group.add(cap)

      // Stone line details (horizontal mortar lines)
      const mortarMat = new THREE.MeshLambertMaterial({ color: 0x8a8a80 })
      for (const my of [wh * 0.35, wh * 0.65]) {
        const mortar = new THREE.Mesh(
          new THREE.BoxGeometry(ww + 1, tileSize * 0.01, tileSize * 0.26),
          mortarMat
        )
        mortar.position.set(x, my, z)
        group.add(mortar)
      }
      break
    }

    default: {
      const color = parseInt(def.color.replace('#', ''), 16)
      const pw = def.footprint.w * tileSize * 0.6
      const pd = def.footprint.h * tileSize * 0.6
      const ph = tileSize * 0.3
      const geo = new THREE.BoxGeometry(pw, ph, pd)
      const mat = new THREE.MeshLambertMaterial({ color })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(x, ph / 2, z)
      group.add(mesh)
    }
  }

  // Apply elevation to props (was missing - all props were at ground level)
  if (obj.elevation) {
    group.position.y = obj.elevation * tileSize
  }

  return group
}

function addGroundShadow(group: THREE.Group, x: number, z: number, radius: number): void {
  const shadowGeo = new THREE.CircleGeometry(radius, 8)
  shadowGeo.rotateX(-Math.PI / 2)
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0.12, depthWrite: false
  })
  const shadow = new THREE.Mesh(shadowGeo, shadowMat)
  shadow.position.set(x + 1, 0.05, z + 1)
  group.add(shadow)
}

function applyLighting(scene: THREE.Scene, env: EnvironmentState): void {
  const t = env.timeOfDay

  let ambientColor: number, ambientIntensity: number
  let sunIntensity: number, sunColor: number
  let skyColor: number

  if (t >= 5 && t < 7) {
    // Dawn
    const p = (t - 5) / 2
    ambientColor = lerpColor(0x1a1a3a, 0xffccaa, p)
    ambientIntensity = 0.2 + p * 0.3
    sunColor = 0xff8844
    sunIntensity = p * 0.8
    skyColor = lerpColor(0x1a1030, 0xffaa66, p)
  } else if (t >= 7 && t < 17) {
    // Day
    const dayP = (t - 7) / 10
    ambientColor = 0xffffff
    ambientIntensity = 0.4 + Math.sin(dayP * Math.PI) * 0.3
    sunColor = 0xfff8e8
    sunIntensity = 0.6 + Math.sin(dayP * Math.PI) * 0.6
    skyColor = 0x6eb5e8
  } else if (t >= 17 && t < 19) {
    // Dusk
    const p = (t - 17) / 2
    ambientColor = lerpColor(0xffccaa, 0x1a1a3a, p)
    ambientIntensity = 0.5 - p * 0.3
    sunColor = 0xff6633
    sunIntensity = (1 - p) * 0.7
    skyColor = lerpColor(0xff8844, 0x0c0a20, p)
  } else {
    // Night - moonlit blue ambience, visible but moody
    ambientColor = 0x1a1840
    ambientIntensity = 0.35
    sunColor = 0x4466cc  // Moonlight - cool blue
    sunIntensity = 0.15
    skyColor = 0x0c0a20
  }

  scene.add(new THREE.AmbientLight(ambientColor, ambientIntensity))

  const sunAngleRad = (env.celestial.sunAngle * Math.PI) / 180
  const dirLight = new THREE.DirectionalLight(sunColor, sunIntensity)
  dirLight.position.set(Math.cos(sunAngleRad) * 100, 80, Math.sin(sunAngleRad) * 100)
  scene.add(dirLight)

  // Fill light from opposite side (softer shadows)
  const fillLight = new THREE.DirectionalLight(ambientColor, sunIntensity * 0.15)
  fillLight.position.set(-Math.cos(sunAngleRad) * 50, 40, -Math.sin(sunAngleRad) * 50)
  scene.add(fillLight)

  scene.background = new THREE.Color(skyColor)

  // Hemisphere light - sky above, warm ground bounce below
  const isNight = t < 5 || t >= 19
  const groundColor = isNight ? 0x1a1810 : 0x3a5a2a
  const hemiLight = new THREE.HemisphereLight(skyColor, groundColor, isNight ? 0.18 : 0.15)
  scene.add(hemiLight)

  // At night, add a subtle warm ground-bounce fill from below
  // This simulates light reflecting off warm cobblestone from lanterns
  if (isNight || (t >= 17 && t < 19)) {
    const groundBounce = new THREE.DirectionalLight(0x332210, 0.08)
    groundBounce.position.set(0, -10, 0)
    scene.add(groundBounce)
  }

  // Atmospheric fog - adds depth even on clear nights
  if (env.weather === 'fog') {
    const fogColor = t >= 7 && t < 17 ? 0xc8c8d0 : 0x444455
    scene.fog = new THREE.FogExp2(fogColor, 0.0015 + env.weatherIntensity * 0.004)
    scene.background = new THREE.Color(fogColor)
  } else if (env.weather === 'rain' || env.weather === 'storm') {
    scene.fog = new THREE.FogExp2(0x667788, 0.0008 + env.weatherIntensity * 0.002)
  } else if (isNight) {
    // Subtle night fog for depth - dark blue
    scene.fog = new THREE.FogExp2(0x0c0a20, 0.0005)
  }
}

// ── Sky: stars, moon, clouds, gradient ──

function buildSky(scene: THREE.Scene, env: EnvironmentState): void {
  const t = env.timeOfDay
  const isNight = t < 5 || t >= 19
  const isDawn = t >= 5 && t < 7
  const isDusk = t >= 17 && t < 19

  // Sky dome - vertical gradient instead of flat color
  const skyGeo = new THREE.SphereGeometry(800, 16, 12)
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTopColor: { value: new THREE.Color(getSkyTopColor(t)) },
      uBottomColor: { value: new THREE.Color(getSkyBottomColor(t)) },
      uHorizonColor: { value: new THREE.Color(getSkyHorizonColor(t)) },
    },
    vertexShader: `
      precision mediump float;
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform vec3 uTopColor;
      uniform vec3 uBottomColor;
      uniform vec3 uHorizonColor;
      varying vec3 vWorldPos;
      void main() {
        float h = normalize(vWorldPos).y;
        vec3 col;
        if (h > 0.0) {
          // Above horizon: blend horizon → top
          float t = clamp(h * 2.0, 0.0, 1.0);
          col = mix(uHorizonColor, uTopColor, t * t);
        } else {
          // Below horizon: blend horizon → bottom (ground glow)
          float t = clamp(-h * 4.0, 0.0, 1.0);
          col = mix(uHorizonColor, uBottomColor, t);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `
  })
  const skyDome = new THREE.Mesh(skyGeo, skyMat)
  scene.add(skyDome)
  // Override the flat background - the dome handles it now
  scene.background = null

  // Stars - visible at night, dawn, and dusk
  const starVisibility = getStarVisibility(t)
  if (starVisibility > 0 && env.celestial.starDensity > 0) {
    const starCount = Math.floor(200 * env.celestial.starDensity)
    const starPositions = new Float32Array(starCount * 3)
    const starSizes = new Float32Array(starCount)
    const starColors = new Float32Array(starCount * 3)

    // Seeded pseudo-random for consistent star field
    let seed = 12345
    const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647 }

    for (let i = 0; i < starCount; i++) {
      // Distribute on upper hemisphere
      const theta = rand() * Math.PI * 2
      const phi = rand() * Math.PI * 0.45 + 0.05 // 5° to 50° above horizon
      const r = 750
      starPositions[i * 3] = r * Math.cos(phi) * Math.cos(theta)
      starPositions[i * 3 + 1] = r * Math.sin(phi)
      starPositions[i * 3 + 2] = r * Math.cos(phi) * Math.sin(theta)

      // Vary star sizes - a few bright ones, many dim
      const brightness = rand()
      starSizes[i] = brightness > 0.92 ? 3.5 : brightness > 0.7 ? 2.0 : 1.2

      // Vary star colors: white, blue-white, warm yellow
      const colorRoll = rand()
      if (colorRoll > 0.85) {
        // Warm star
        starColors[i * 3] = 1.0; starColors[i * 3 + 1] = 0.9; starColors[i * 3 + 2] = 0.7
      } else if (colorRoll > 0.6) {
        // Blue-white star
        starColors[i * 3] = 0.8; starColors[i * 3 + 1] = 0.85; starColors[i * 3 + 2] = 1.0
      } else {
        // White star
        starColors[i * 3] = 1.0; starColors[i * 3 + 1] = 1.0; starColors[i * 3 + 2] = 1.0
      }

      // Apply visibility fade
      starColors[i * 3] *= starVisibility
      starColors[i * 3 + 1] *= starVisibility
      starColors[i * 3 + 2] *= starVisibility
    }

    const starGeo = new THREE.BufferGeometry()
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
    starGeo.setAttribute('size', new THREE.BufferAttribute(starSizes, 1))
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3))

    const starMat = new THREE.PointsMaterial({
      size: 2.5,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    })
    scene.add(new THREE.Points(starGeo, starMat))
  }

  // Clouds - layered flat planes at different heights (shared geometry + materials)
  const weather = env.weather
  const wantClouds = weather === 'clear' || weather === 'fog' || weather === 'rain' || weather === 'storm'
  if (wantClouds) {
    const cloudDensity = weather === 'clear' ? 0.3 : weather === 'fog' ? 0.7 : 0.9
    const cloudCount = Math.floor(4 + cloudDensity * 8)

    let cseed = 54321
    const crand = () => { cseed = (cseed * 16807 + 0) % 2147483647; return cseed / 2147483647 }

    const cloudGroup = new THREE.Group()
    const cloudColor = getCloudColor(t, weather)

    // Shared unit geometry — scale per-mesh instead of per-geometry
    const unitGeo = new THREE.PlaneGeometry(1, 1)
    // Pre-create opacity-bucketed materials (4 buckets to reduce material count)
    const opacityBuckets = [0.15, 0.25, 0.35, 0.5].map((o) =>
      new THREE.MeshBasicMaterial({
        color: cloudColor, transparent: true,
        opacity: o * cloudDensity, side: THREE.DoubleSide, depthWrite: false,
      })
    )

    for (let i = 0; i < cloudCount; i++) {
      const cx = (crand() - 0.5) * 1200
      const cz = (crand() - 0.5) * 1200
      const cy = 300 + crand() * 150
      const clusterSize = 2 + Math.floor(crand() * 3)

      for (let j = 0; j < clusterSize; j++) {
        const w = 40 + crand() * 80
        const h = 20 + crand() * 40
        const bucketIdx = Math.min(3, Math.floor(crand() * 4))
        const cloud = new THREE.Mesh(unitGeo, opacityBuckets[bucketIdx])
        cloud.scale.set(w, h, 1)
        cloud.position.set(
          cx + (crand() - 0.5) * w * 0.6,
          cy + (crand() - 0.5) * 10,
          cz + (crand() - 0.5) * h * 0.6
        )
        cloud.rotation.x = -Math.PI / 2
        cloud.rotation.z = crand() * Math.PI
        cloudGroup.add(cloud)
      }
    }
    scene.add(cloudGroup)
  }
}

function getSkyTopColor(t: number): number {
  if (t >= 7 && t < 17) return 0x2a4a80      // Deep blue zenith
  if (t >= 5 && t < 7) {
    const p = (t - 5) / 2
    return lerpColor(0x0a0820, 0x2a4a80, p)
  }
  if (t >= 17 && t < 19) {
    const p = (t - 17) / 2
    return lerpColor(0x2a4a80, 0x0a0820, p)
  }
  return 0x0a0820                              // Deep indigo night
}

function getSkyHorizonColor(t: number): number {
  if (t >= 7 && t < 17) return 0xa0c8e8       // Pale blue-white haze
  if (t >= 5 && t < 7) {
    const p = (t - 5) / 2
    return lerpColor(0x1a1830, 0xffaa66, p)    // Night → warm dawn band
  }
  if (t >= 17 && t < 19) {
    const p = (t - 17) / 2
    return lerpColor(0xff8855, 0x1a1830, p)    // Sunset → night
  }
  return 0x141230                              // Faint purple glow at horizon
}

function getSkyBottomColor(t: number): number {
  if (t >= 7 && t < 17) return 0xc8dce8       // Light haze below horizon
  if (t >= 5 && t < 7) {
    const p = (t - 5) / 2
    return lerpColor(0x0c0a18, 0xddaa77, p)
  }
  if (t >= 17 && t < 19) {
    const p = (t - 17) / 2
    return lerpColor(0xcc7744, 0x0c0a18, p)
  }
  return 0x0c0a18
}

function getStarVisibility(t: number): number {
  if (t >= 7 && t < 17) return 0               // No stars during day
  if (t >= 5 && t < 7) return 1 - (t - 5) / 2  // Fade out at dawn
  if (t >= 17 && t < 19) return (t - 17) / 2    // Fade in at dusk
  return 1                                       // Full at night
}

function getCloudColor(t: number, weather: string): number {
  const isStorm = weather === 'storm'
  if (t >= 7 && t < 17) return isStorm ? 0x556677 : 0xe8e0d8  // Day: warm white or dark gray
  if (t >= 5 && t < 7) return isStorm ? 0x443344 : 0xcc9977    // Dawn: lit from below
  if (t >= 17 && t < 19) return isStorm ? 0x443344 : 0xbb7755  // Dusk: warm underlit
  return isStorm ? 0x1a1a2a : 0x2a2840                          // Night: dark silhouettes
}

function darken(color: number, amount: number): number {
  const r = Math.max(0, Math.min(255, ((color >> 16) & 0xff) * (1 - amount)))
  const g = Math.max(0, Math.min(255, ((color >> 8) & 0xff) * (1 - amount)))
  const b = Math.max(0, Math.min(255, (color & 0xff) * (1 - amount)))
  return (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b)
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff
  const r = Math.floor(ar + (br - ar) * t)
  const g = Math.floor(ag + (bg - ag) * t)
  const bl = Math.floor(ab + (bb - ab) * t)
  return (r << 16) | (g << 8) | bl
}

function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}
