import * as THREE from 'three'
import type { MapDocument, PlacedObject, ObjectDefinition, EnvironmentState } from '../core/types'

// Terrain tile colors matching the 2D editor
const TERRAIN_3D_COLORS: Record<number, number> = {
  0: 0x2d5a27, // grass
  1: 0x8b7355, // dirt
  2: 0x708090, // stone
  3: 0x4682b4, // water
  4: 0xf4e9c8, // sand
  5: 0x556b2f, // dark grass
  6: 0x5a5a5a, // road
  7: 0xdcdcdc  // snow
}

export function buildScene(
  map: MapDocument,
  objectDefs: ObjectDefinition[]
): THREE.Scene {
  const scene = new THREE.Scene()

  // Build terrain mesh
  const terrainLayer = map.layers.find((l) => l.type === 'terrain')
  if (terrainLayer?.terrainTiles) {
    const terrainGroup = buildTerrain(terrainLayer.terrainTiles, map.tileSize)
    scene.add(terrainGroup)
  }

  // Build structures (extruded buildings)
  const structureLayer = map.layers.find((l) => l.type === 'structure')
  if (structureLayer) {
    for (const obj of structureLayer.objects) {
      const def = objectDefs.find((d) => d.id === obj.definitionId)
      if (!def) continue
      const mesh = buildStructure(obj, def, map.tileSize)
      scene.add(mesh)
    }
  }

  // Build props (billboards)
  const propLayer = map.layers.find((l) => l.type === 'prop')
  if (propLayer) {
    for (const obj of propLayer.objects) {
      const def = objectDefs.find((d) => d.id === obj.definitionId)
      if (!def) continue
      const mesh = buildProp(obj, def, map.tileSize)
      scene.add(mesh)
    }
  }

  // Apply environment lighting
  applyLighting(scene, map.environment)

  return scene
}

function buildTerrain(tiles: number[][], tileSize: number): THREE.Group {
  const group = new THREE.Group()

  // Group tiles by color for batching
  const colorGroups = new Map<number, { x: number; y: number }[]>()

  for (let y = 0; y < tiles.length; y++) {
    for (let x = 0; x < tiles[y].length; x++) {
      const tileId = tiles[y][x]
      const color = TERRAIN_3D_COLORS[tileId] ?? TERRAIN_3D_COLORS[0]
      if (!colorGroups.has(color)) colorGroups.set(color, [])
      colorGroups.get(color)!.push({ x, y })
    }
  }

  for (const [color, positions] of colorGroups) {
    const geometry = new THREE.PlaneGeometry(tileSize, tileSize)
    const material = new THREE.MeshLambertMaterial({ color })

    const mesh = new THREE.InstancedMesh(geometry, material, positions.length)

    const matrix = new THREE.Matrix4()
    positions.forEach((pos, i) => {
      matrix.makeTranslation(
        pos.x * tileSize + tileSize / 2,
        0,
        pos.y * tileSize + tileSize / 2
      )
      // Rotate to lie flat (XZ plane)
      const rotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2)
      matrix.multiply(rotation)
      mesh.setMatrixAt(i, matrix)
    })

    mesh.instanceMatrix.needsUpdate = true
    group.add(mesh)
  }

  return group
}

function buildStructure(
  obj: PlacedObject,
  def: ObjectDefinition,
  tileSize: number
): THREE.Mesh {
  const w = def.footprint.w * tileSize
  const d = def.footprint.h * tileSize
  const floors = (obj.properties.floors as number) || 1
  const h = floors * tileSize * 0.8

  const geometry = new THREE.BoxGeometry(w, h, d)
  const color = parseInt(def.color.replace('#', ''), 16)

  // Create slightly different shades for different faces
  const materials = [
    new THREE.MeshLambertMaterial({ color }), // right
    new THREE.MeshLambertMaterial({ color: darken(color, 0.1) }), // left
    new THREE.MeshLambertMaterial({ color: darken(color, -0.15) }), // top (roof)
    new THREE.MeshLambertMaterial({ color: darken(color, 0.2) }), // bottom
    new THREE.MeshLambertMaterial({ color: darken(color, 0.05) }), // front
    new THREE.MeshLambertMaterial({ color: darken(color, 0.15) }), // back
  ]

  const mesh = new THREE.Mesh(geometry, materials)
  mesh.position.set(
    obj.x * tileSize + w / 2,
    h / 2,
    obj.y * tileSize + d / 2
  )

  // Add simple "door" indicator on front face
  const doorGeo = new THREE.BoxGeometry(tileSize * 0.3, tileSize * 0.5, 0.5)
  const doorMat = new THREE.MeshLambertMaterial({ color: 0x4a3520 })
  const door = new THREE.Mesh(doorGeo, doorMat)
  door.position.set(0, -h / 2 + tileSize * 0.25, d / 2 + 0.3)
  mesh.add(door)

  // Add simple "windows" on front face
  if (def.styleSetSlots.includes('window')) {
    const winGeo = new THREE.BoxGeometry(tileSize * 0.2, tileSize * 0.2, 0.5)
    const winMat = new THREE.MeshLambertMaterial({ color: 0x87ceeb, emissive: 0x1a3050, emissiveIntensity: 0.3 })
    for (let f = 0; f < floors; f++) {
      for (let wx = -1; wx <= 1; wx += 2) {
        const win = new THREE.Mesh(winGeo, winMat)
        win.position.set(
          wx * tileSize * 0.4,
          -h / 2 + tileSize * 0.5 + f * tileSize * 0.8,
          d / 2 + 0.3
        )
        mesh.add(win)
      }
    }
  }

  return mesh
}

function buildProp(
  obj: PlacedObject,
  def: ObjectDefinition,
  tileSize: number
): THREE.Group {
  const group = new THREE.Group()
  const color = parseInt(def.color.replace('#', ''), 16)
  const x = obj.x * tileSize + (def.footprint.w * tileSize) / 2
  const z = obj.y * tileSize + (def.footprint.h * tileSize) / 2

  switch (def.id) {
    case 'tree': {
      // Trunk
      const trunkGeo = new THREE.CylinderGeometry(tileSize * 0.08, tileSize * 0.12, tileSize * 0.6, 6)
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4226 })
      const trunk = new THREE.Mesh(trunkGeo, trunkMat)
      trunk.position.set(x, tileSize * 0.3, z)
      group.add(trunk)

      // Canopy (sphere)
      const canopyGeo = new THREE.SphereGeometry(tileSize * 0.35, 6, 5)
      const canopyMat = new THREE.MeshLambertMaterial({ color })
      const canopy = new THREE.Mesh(canopyGeo, canopyMat)
      canopy.position.set(x, tileSize * 0.75, z)
      group.add(canopy)
      break
    }

    case 'bush': {
      const bushGeo = new THREE.SphereGeometry(tileSize * 0.2, 5, 4)
      const bushMat = new THREE.MeshLambertMaterial({ color })
      const bush = new THREE.Mesh(bushGeo, bushMat)
      bush.position.set(x, tileSize * 0.15, z)
      group.add(bush)
      break
    }

    case 'lamppost': {
      // Pole
      const poleGeo = new THREE.CylinderGeometry(tileSize * 0.03, tileSize * 0.04, tileSize * 1.2, 6)
      const poleMat = new THREE.MeshLambertMaterial({ color: 0x333333 })
      const pole = new THREE.Mesh(poleGeo, poleMat)
      pole.position.set(x, tileSize * 0.6, z)
      group.add(pole)

      // Lamp
      const lampGeo = new THREE.SphereGeometry(tileSize * 0.08, 6, 5)
      const lampMat = new THREE.MeshLambertMaterial({ color: 0xffdd44, emissive: 0xffaa00, emissiveIntensity: 0.8 })
      const lamp = new THREE.Mesh(lampGeo, lampMat)
      lamp.position.set(x, tileSize * 1.25, z)
      group.add(lamp)

      // Point light
      const light = new THREE.PointLight(0xffaa44, 0.5, tileSize * 4)
      light.position.set(x, tileSize * 1.2, z)
      group.add(light)
      break
    }

    case 'fountain': {
      // Base
      const baseGeo = new THREE.CylinderGeometry(tileSize * 0.6, tileSize * 0.7, tileSize * 0.3, 8)
      const baseMat = new THREE.MeshLambertMaterial({ color: 0x808080 })
      const base = new THREE.Mesh(baseGeo, baseMat)
      base.position.set(x, tileSize * 0.15, z)
      group.add(base)

      // Water
      const waterGeo = new THREE.CylinderGeometry(tileSize * 0.55, tileSize * 0.55, tileSize * 0.05, 8)
      const waterMat = new THREE.MeshLambertMaterial({ color: 0x4488cc, transparent: true, opacity: 0.7 })
      const water = new THREE.Mesh(waterGeo, waterMat)
      water.position.set(x, tileSize * 0.28, z)
      group.add(water)

      // Spout
      const spoutGeo = new THREE.CylinderGeometry(tileSize * 0.05, tileSize * 0.08, tileSize * 0.5, 6)
      const spoutMat = new THREE.MeshLambertMaterial({ color: 0x808080 })
      const spout = new THREE.Mesh(spoutGeo, spoutMat)
      spout.position.set(x, tileSize * 0.5, z)
      group.add(spout)
      break
    }

    default: {
      // Generic prop as a simple box
      const w = def.footprint.w * tileSize * 0.6
      const d = def.footprint.h * tileSize * 0.6
      const h = tileSize * 0.3
      const geo = new THREE.BoxGeometry(w, h, d)
      const mat = new THREE.MeshLambertMaterial({ color })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.set(x, h / 2, z)
      group.add(mesh)
    }
  }

  return group
}

function applyLighting(scene: THREE.Scene, env: EnvironmentState): void {
  const t = env.timeOfDay

  // Determine ambient color based on time of day
  let ambientColor: number
  let ambientIntensity: number
  let sunIntensity: number
  let sunColor: number

  if (t >= 6 && t < 18) {
    // Daytime
    const dayProgress = (t - 6) / 12
    ambientColor = 0xffffff
    ambientIntensity = 0.4 + Math.sin(dayProgress * Math.PI) * 0.3
    sunColor = dayProgress < 0.15 || dayProgress > 0.85 ? 0xffaa66 : 0xffffff
    sunIntensity = Math.sin(dayProgress * Math.PI) * 1.2
  } else {
    // Nighttime
    ambientColor = 0x1a1a4a
    ambientIntensity = 0.15
    sunColor = 0x4466aa
    sunIntensity = 0.1
  }

  const ambient = new THREE.AmbientLight(ambientColor, ambientIntensity)
  scene.add(ambient)

  // Directional light (sun/moon)
  const sunAngleRad = (env.celestial.sunAngle * Math.PI) / 180
  const dirLight = new THREE.DirectionalLight(sunColor, sunIntensity)
  dirLight.position.set(
    Math.cos(sunAngleRad) * 100,
    80,
    Math.sin(sunAngleRad) * 100
  )
  dirLight.castShadow = false // keep it fast
  scene.add(dirLight)

  // Sky color
  if (t >= 6 && t < 18) {
    const dayProgress = (t - 6) / 12
    if (dayProgress < 0.1) {
      scene.background = new THREE.Color(0x2a1a3a) // dawn
    } else if (dayProgress > 0.9) {
      scene.background = new THREE.Color(0x3a2a1a) // dusk
    } else {
      scene.background = new THREE.Color(0x87ceeb) // day sky
    }
  } else {
    scene.background = new THREE.Color(0x0a0a1a) // night sky
  }

  // Fog based on weather
  if (env.weather === 'fog') {
    scene.fog = new THREE.FogExp2(0xcccccc, 0.002 + env.weatherIntensity * 0.005)
  } else if (env.weather === 'rain' || env.weather === 'storm') {
    scene.fog = new THREE.FogExp2(0x888899, 0.001 + env.weatherIntensity * 0.002)
  }
}

function darken(color: number, amount: number): number {
  const r = Math.max(0, Math.min(255, ((color >> 16) & 0xff) * (1 - amount)))
  const g = Math.max(0, Math.min(255, ((color >> 8) & 0xff) * (1 - amount)))
  const b = Math.max(0, Math.min(255, (color & 0xff) * (1 - amount)))
  return (Math.floor(r) << 16) | (Math.floor(g) << 8) | Math.floor(b)
}
