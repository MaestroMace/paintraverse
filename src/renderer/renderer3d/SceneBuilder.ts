import * as THREE from 'three'
import type { MapDocument, PlacedObject, ObjectDefinition, EnvironmentState } from '../core/types'

const TERRAIN_3D_COLORS: Record<number, number> = {
  0: 0x2d5a27, 1: 0x8b7355, 2: 0x708090, 3: 0x4682b4,
  4: 0xf4e9c8, 5: 0x556b2f, 6: 0x5a5a5a, 7: 0xdcdcdc
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
  const group = new THREE.Group()
  const w = def.footprint.w * tileSize
  const d = def.footprint.h * tileSize
  const floors = (obj.properties.floors as number) || 1
  const wallH = floors * tileSize * 0.7

  // Pick a palette based on object ID hash for consistent variety
  const hash = simpleHash(obj.id)
  const palette = BUILDING_PALETTES[hash % BUILDING_PALETTES.length]

  // === Walls ===
  const wallGeo = new THREE.BoxGeometry(w - 1, wallH, d - 1)
  const wallMats = [
    new THREE.MeshLambertMaterial({ color: palette.wall }),
    new THREE.MeshLambertMaterial({ color: darken(palette.wall, 0.08) }),
    new THREE.MeshLambertMaterial({ color: palette.wall }), // top (hidden by roof)
    new THREE.MeshLambertMaterial({ color: darken(palette.wall, 0.2) }),
    new THREE.MeshLambertMaterial({ color: darken(palette.wall, 0.04) }),
    new THREE.MeshLambertMaterial({ color: darken(palette.wall, 0.12) }),
  ]
  const walls = new THREE.Mesh(wallGeo, wallMats)
  walls.position.set(w / 2, wallH / 2, d / 2)
  group.add(walls)

  // === Pitched roof ===
  const roofH = tileSize * 0.5
  const roofShape = new THREE.Shape()
  roofShape.moveTo(-w / 2 - 2, 0)
  roofShape.lineTo(0, roofH)
  roofShape.lineTo(w / 2 + 2, 0)
  roofShape.lineTo(-w / 2 - 2, 0)

  const roofGeo = new THREE.ExtrudeGeometry(roofShape, {
    depth: d + 2,
    bevelEnabled: false
  })
  const roofMat = new THREE.MeshLambertMaterial({ color: palette.roof })
  const roof = new THREE.Mesh(roofGeo, roofMat)
  roof.position.set(w / 2, wallH, -1)
  group.add(roof)

  // === Door ===
  const doorW = tileSize * 0.25
  const doorH = tileSize * 0.45
  const doorGeo = new THREE.BoxGeometry(doorW, doorH, 1.5)
  const doorMat = new THREE.MeshLambertMaterial({ color: palette.door })
  const door = new THREE.Mesh(doorGeo, doorMat)
  door.position.set(w / 2, doorH / 2, d + 0.3)
  group.add(door)

  // Door frame
  const frameGeo = new THREE.BoxGeometry(doorW + 3, doorH + 2, 1)
  const frameMat = new THREE.MeshLambertMaterial({ color: darken(palette.door, 0.3) })
  const frame = new THREE.Mesh(frameGeo, frameMat)
  frame.position.set(w / 2, doorH / 2 + 1, d + 0.1)
  group.add(frame)

  // === Windows (on front and side faces) ===
  if (def.styleSetSlots.includes('window')) {
    const winGeo = new THREE.BoxGeometry(tileSize * 0.15, tileSize * 0.18, 1.5)
    const winMat = new THREE.MeshLambertMaterial({
      color: 0x87ceeb,
      emissive: 0x2244aa,
      emissiveIntensity: 0.2
    })
    const shutterMat = new THREE.MeshLambertMaterial({ color: darken(palette.wall, 0.25) })

    for (let f = 0; f < floors; f++) {
      const wy = tileSize * 0.4 + f * tileSize * 0.7

      // Front windows
      for (let wx = -1; wx <= 1; wx += 2) {
        const win = new THREE.Mesh(winGeo, winMat)
        win.position.set(w / 2 + wx * w * 0.25, wy, d + 0.3)
        group.add(win)

        // Shutters
        const shutterGeo = new THREE.BoxGeometry(tileSize * 0.04, tileSize * 0.2, 1)
        for (const sx of [-1, 1]) {
          const shutter = new THREE.Mesh(shutterGeo, shutterMat)
          shutter.position.set(
            w / 2 + wx * w * 0.25 + sx * tileSize * 0.1,
            wy, d + 0.5
          )
          group.add(shutter)
        }
      }

      // Side windows
      if (d > tileSize * 1.5) {
        const sideWin = new THREE.Mesh(winGeo.clone(), winMat)
        sideWin.rotation.y = Math.PI / 2
        sideWin.position.set(w + 0.3, wy, d / 2)
        group.add(sideWin)
      }
    }
  }

  // === Ground shadow plane ===
  const shadowGeo = new THREE.PlaneGeometry(w + 4, d + 4)
  shadowGeo.rotateX(-Math.PI / 2)
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.15,
    depthWrite: false
  })
  const shadow = new THREE.Mesh(shadowGeo, shadowMat)
  shadow.position.set(w / 2 + 2, 0.1, d / 2 + 2)
  group.add(shadow)

  group.position.set(obj.x * tileSize, 0, obj.y * tileSize)
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

      // Light
      const light = new THREE.PointLight(0xffaa44, 0.6, tileSize * 5)
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

      // Roof supports
      const supportGeo = new THREE.BoxGeometry(tileSize * 0.03, tileSize * 0.5, tileSize * 0.03)
      const woodMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1a })
      for (const sx of [-1, 1]) {
        const support = new THREE.Mesh(supportGeo, woodMat)
        support.position.set(x + sx * tileSize * 0.2, tileSize * 0.6, z)
        group.add(support)
      }

      // Mini roof
      const roofGeo = new THREE.BoxGeometry(tileSize * 0.5, tileSize * 0.03, tileSize * 0.35)
      const roofMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1a })
      const roof = new THREE.Mesh(roofGeo, roofMat)
      roof.position.set(x, tileSize * 0.86, z)
      group.add(roof)

      addGroundShadow(group, x, z, tileSize * 0.4)
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
    skyColor = lerpColor(0xff8844, 0x0a0a1a, p)
  } else {
    // Night
    ambientColor = 0x0a0a2a
    ambientIntensity = 0.1
    sunColor = 0x3344aa
    sunIntensity = 0.08
    skyColor = 0x050510
  }

  scene.add(new THREE.AmbientLight(ambientColor, ambientIntensity))

  const sunAngleRad = (env.celestial.sunAngle * Math.PI) / 180
  const dirLight = new THREE.DirectionalLight(sunColor, sunIntensity)
  dirLight.position.set(Math.cos(sunAngleRad) * 100, 80, Math.sin(sunAngleRad) * 100)
  scene.add(dirLight)

  // Fill light from opposite side (softer shadows)
  const fillLight = new THREE.DirectionalLight(ambientColor, sunIntensity * 0.2)
  fillLight.position.set(-Math.cos(sunAngleRad) * 50, 40, -Math.sin(sunAngleRad) * 50)
  scene.add(fillLight)

  scene.background = new THREE.Color(skyColor)

  // Hemisphere light for natural outdoor feel
  const hemiLight = new THREE.HemisphereLight(skyColor, 0x3a5a2a, 0.15)
  scene.add(hemiLight)

  // Weather fog
  if (env.weather === 'fog') {
    const fogColor = t >= 7 && t < 17 ? 0xc8c8d0 : 0x444455
    scene.fog = new THREE.FogExp2(fogColor, 0.0015 + env.weatherIntensity * 0.004)
    scene.background = new THREE.Color(fogColor)
  } else if (env.weather === 'rain' || env.weather === 'storm') {
    scene.fog = new THREE.FogExp2(0x667788, 0.0008 + env.weatherIntensity * 0.002)
  }
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
