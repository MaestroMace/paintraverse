/**
 * Three.js Real-Time Renderer
 * Replaces Canvas2D for real-time preview. GPU-accelerated, 60fps.
 * Canvas2D remains as the export-only renderer for final PNG output.
 */

import * as THREE from 'three'
import type { MapDocument, ObjectDefinition, PlacedObject } from '../core/types'
import type { BuildingPalette } from '../inspiration/StyleMapper'
import { buildTerrainMesh, getTerrainHeight } from './TerrainMesh'
import { buildBuildingMeshes, type BuildingBatchResult } from './BuildingFactory'
import { buildPropMeshes, type PropBatchResult } from './PropFactory'

function simpleHash(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0
  return Math.abs(h)
}

// Mirrored from BuildingFactory so we can compute chimney positions
const HEIGHT_MULT_MAP: Record<string, number> = {
  tower: 2.5, clock_tower: 3.0, bell_tower: 3.5, bell_tower_tall: 4.5,
  watchtower: 2.8, cathedral: 2.0, lighthouse: 4.0, chapel: 1.5,
  temple: 1.5, town_gate: 1.8, archway: 1.5, round_tower: 3.0,
}
const ROOF_FRAC_MAP: Record<string, number> = {
  flat: 0, gabled: 0.35, hipped: 0.3, pointed: 0.7, steep: 0.5, dome: 0.4, none: 0,
  building_small: 0.35, building_medium: 0.35, building_large: 0.3,
  tavern: 0.35, shop: 0.5, tower: 0.7, clock_tower: 0.7,
  balcony_house: 0.35, row_house: 0.5, corner_building: 0.3,
  archway: 0, staircase: 0, town_gate: 0,
  chapel: 0.5, guild_hall: 0.3, warehouse: 0.35,
  watchtower: 0.7, mansion: 0.3, bakery: 0.35,
  apothecary: 0.5, inn: 0.35, temple: 0.4,
  covered_market: 0.35, bell_tower: 0.7, half_timber: 0.35,
  narrow_house: 0.5, cathedral: 0.5, lighthouse: 0.4,
  round_tower: 0.7, gatehouse: 0, stable: 0.35, mill: 0.35,
  bell_tower_tall: 0.7, aqueduct: 0, windmill: 0.7,
}

const DEFAULT_BUILDING_PALETTES = [
  { wall: 0xd8c8a8, roof: 0x8b4513, door: 0x4a3520 },
  { wall: 0xc8b898, roof: 0x6b3a2a, door: 0x3a2a1a },
  { wall: 0x9a9a9a, roof: 0x5a5a6a, door: 0x4a4a50 },
  { wall: 0x8a8a8a, roof: 0x484858, door: 0x3a3a42 },
  { wall: 0xe8e0d0, roof: 0x8a5a40, door: 0x5a4030 },
  { wall: 0xf0e8d8, roof: 0x7a4a3a, door: 0x6a4a30 },
  { wall: 0xb06040, roof: 0x5a3020, door: 0x4a3020 },
  { wall: 0xa05838, roof: 0x6a3828, door: 0x3a2218 },
  { wall: 0x7a6858, roof: 0x3a3028, door: 0x2a2018 },
  { wall: 0xd0c8b8, roof: 0x4a7a5a, door: 0x3a5a4a },
]

// Sky dome shader — gradient hemisphere from horizon to zenith
const SKY_VERT = `
varying vec3 vLocalPos;
void main() {
  vLocalPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
const SKY_FRAG = `
uniform vec3 uZenith;
uniform vec3 uHorizon;
varying vec3 vLocalPos;
void main() {
  float h = normalize(vLocalPos).y;
  float t = clamp(h * 2.0 + 0.1, 0.0, 1.0);
  gl_FragColor = vec4(mix(uHorizon, uZenith, t), 1.0);
}
`

// Particle data for smoke / fireflies
interface ParticleSystem {
  points: THREE.Points
  positions: Float32Array
  velocities: Float32Array
  lifetimes: Float32Array
  origins: Float32Array
  count: number
  type: 'smoke' | 'firefly'
}

export class ThreeRenderer {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer | null = null
  private clock = new THREE.Clock()
  private animId = 0

  // Camera movement
  private keysHeld = new Set<string>()
  private cameraYaw = Math.PI * 0.75  // initial look direction
  private cameraPitch = -0.4          // slight downward look
  private pointerLocked = false

  // Scene objects
  private terrainGroup = new THREE.Group()
  private buildingGroup = new THREE.Group()
  private propGroup = new THREE.Group()
  private particleGroup = new THREE.Group()
  private sunLight: THREE.DirectionalLight
  private ambientLight: THREE.AmbientLight

  // Sky dome
  private skyMesh: THREE.Mesh | null = null
  private skyUniforms: { uZenith: { value: THREE.Color }; uHorizon: { value: THREE.Color } } | null = null
  private sunDisc: THREE.Mesh | null = null

  // Particles
  private particleSystems: ParticleSystem[] = []
  private currentTimeOfDay = 12

  // Reusable vectors (avoid per-frame allocations)
  private _fwd = new THREE.Vector3()
  private _right = new THREE.Vector3()
  private _up = new THREE.Vector3(0, 1, 0)
  private _target = new THREE.Vector3()

  // State
  private container: HTMLElement | null = null
  private disposed = false
  private _onKeyDown: ((e: KeyboardEvent) => void) | null = null
  private _onKeyUp: ((e: KeyboardEvent) => void) | null = null
  private _onPointerLockChange: (() => void) | null = null
  private _onClick: (() => void) | null = null
  private _onMouseMove: ((e: MouseEvent) => void) | null = null
  private _resizeObserver: ResizeObserver | null = null
  // Track town center for shadow camera
  private townCenterX = 24
  private townCenterZ = 24

  constructor() {
    this.scene = new THREE.Scene()
    this.scene.background = null // sky dome replaces this
    this.scene.fog = new THREE.FogExp2(0xd0e0f0, 0.008) // matches sky horizon

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 500)
    this.camera.position.set(20, 4, 20)

    // Sun light (shadows disabled for performance — too many meshes)
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 1.2)
    this.sunLight.position.set(30, 50, 20)
    this.scene.add(this.sunLight)
    this.scene.add(this.sunLight.target)

    this.ambientLight = new THREE.AmbientLight(0x606880, 0.6)
    this.scene.add(this.ambientLight)

    // Create sky dome
    this.createSkyDome()

    this.scene.add(this.terrainGroup)
    this.scene.add(this.buildingGroup)
    this.scene.add(this.propGroup)
    this.scene.add(this.particleGroup)
  }

  private createSkyDome(): void {
    const uniforms = {
      uZenith: { value: new THREE.Color(0x4488cc) },
      uHorizon: { value: new THREE.Color(0xd0e0f0) },
    }
    this.skyUniforms = uniforms

    const skyGeo = new THREE.SphereGeometry(250, 16, 12)
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms,
      side: THREE.BackSide,
      depthWrite: false,
    })
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat)
    this.skyMesh.renderOrder = -1
    this.scene.add(this.skyMesh)

    // Sun/moon disc
    const discGeo = new THREE.SphereGeometry(8, 8, 6)
    const discMat = new THREE.MeshBasicMaterial({ color: 0xffee88, fog: false })
    this.sunDisc = new THREE.Mesh(discGeo, discMat)
    this.sunDisc.position.copy(this.sunLight.position).normalize().multiplyScalar(200)
    this.scene.add(this.sunDisc)
  }

  init(container: HTMLElement): void {
    this.container = container
    this.disposed = false

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // pixel art = no AA
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true, // required for toDataURL() screenshot capture
    })
    this.renderer.setPixelRatio(1) // no HiDPI — pixel art
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    this.renderer.shadowMap.enabled = false
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.imageRendering = 'pixelated'

    this.camera.aspect = container.clientWidth / container.clientHeight
    this.camera.updateProjectionMatrix()

    // Input — pointer lock FPS controls
    // Click canvas to enter pointer lock, Escape to exit
    this._onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (!this.pointerLocked) return // ignore keys when not locked
      this.keysHeld.add(e.code)
    }
    this._onKeyUp = (e: KeyboardEvent) => {
      this.keysHeld.delete(e.code)
    }
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)

    // Click to enter pointer lock
    this._onClick = () => {
      if (!this.pointerLocked) this.renderer?.domElement.requestPointerLock()
    }
    this.renderer.domElement.addEventListener('click', this._onClick)

    // Track pointer lock state
    this._onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.renderer?.domElement
      if (!this.pointerLocked) this.keysHeld.clear()
    }
    document.addEventListener('pointerlockchange', this._onPointerLockChange)

    // Mouse look (only when pointer locked — uses movementX/Y)
    this._onMouseMove = (e: MouseEvent) => {
      if (!this.pointerLocked) return
      this.cameraYaw -= e.movementX * 0.002
      this.cameraPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.cameraPitch - e.movementY * 0.002))
    }
    this.renderer.domElement.addEventListener('mousemove', this._onMouseMove)
    this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault())

    // Resize
    this._resizeObserver = new ResizeObserver(() => {
      if (!this.renderer || !this.container) return
      const w = this.container.clientWidth, h = this.container.clientHeight
      if (w === 0 || h === 0) return
      this.renderer.setSize(w, h)
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
    })
    this._resizeObserver.observe(container)

    this.startLoop()
  }

  loadMap(
    map: MapDocument,
    objectDefs: ObjectDefinition[],
    buildingPalettes?: BuildingPalette[] | null
  ): void {
    // Clear previous
    this.terrainGroup.clear()
    this.buildingGroup.clear()
    this.propGroup.clear()
    this.particleGroup.clear()
    this.particleSystems = []

    const palettes = buildingPalettes || DEFAULT_BUILDING_PALETTES
    const defMap = new Map(objectDefs.map(d => [d.id, d]))

    // Track town center for shadow camera
    this.townCenterX = map.gridWidth / 2
    this.townCenterZ = map.gridHeight / 2

    // Terrain (with height map from seed)
    const seed = map.generationConfig?.seed ?? 0
    const terrainLayer = map.layers.find(l => l.type === 'terrain')
    let heightMap: number[][] | null = null
    if (terrainLayer?.terrainTiles) {
      const terrainGroup = buildTerrainMesh(terrainLayer.terrainTiles, map.gridWidth, map.gridHeight, seed)
      this.terrainGroup.add(terrainGroup)
      heightMap = (terrainGroup as any)._heightMap ?? null
    }

    // Height lookup function for factories (bakes terrain height into geometry)
    const hLookup = heightMap
      ? (x: number, z: number) => getTerrainHeight(heightMap!, x, z)
      : undefined

    // Buildings — batched: walls individual, roofs/details merged
    const structureLayer = map.layers.find(l => l.type === 'structure')
    const chimneyPositions: THREE.Vector3[] = []
    if (structureLayer) {
      const result = buildBuildingMeshes(structureLayer.objects, defMap, palettes, hLookup)
      for (const m of result.wallMeshes) this.buildingGroup.add(m)
      for (const m of result.batched) this.buildingGroup.add(m)

      // Collect chimney positions for smoke particles
      for (const obj of structureLayer.objects) {
        const hash = simpleHash(obj.id)
        if (hash % 5 >= 2) continue
        const def = defMap.get(obj.definitionId)
        if (!def) continue
        const fp = { w: def.footprint.w, h: def.footprint.h }
        const floors = (obj.properties.floors as number) || 1 + (hash % 2)
        const heightMult = HEIGHT_MULT_MAP[obj.definitionId] ?? 1.0
        const wallH = floors * 0.75 * heightMult
        const roofFrac = ROOF_FRAC_MAP[obj.definitionId] ?? 0.3
        const roofH = wallH * roofFrac
        const chimSide = (obj.properties.chimneyPos === 'left') ? -1 : 1
        const bx = obj.x + fp.w / 2 + chimSide * fp.w * 0.3
        const bz = obj.y + fp.h / 2
        const baseY = (obj.elevation || 0) + (heightMap ? getTerrainHeight(heightMap, Math.floor(obj.x + fp.w / 2), Math.floor(obj.y + fp.h / 2)) : 0)
        const chimTopY = baseY + wallH + roofH * 0.3 + roofH * 0.8
        chimneyPositions.push(new THREE.Vector3(bx, chimTopY, bz))
      }
    }

    // Props — batched: all merged except lampposts
    const propLayer = map.layers.find(l => l.type === 'prop')
    if (propLayer) {
      const result = buildPropMeshes(propLayer.objects, defMap, hLookup)
      for (const m of result.batched) this.propGroup.add(m)
      for (const m of result.lampposts) this.propGroup.add(m)
    }

    // Spawn particles
    this.initParticles(chimneyPositions, map.gridWidth, map.gridHeight)

    // === ELEVATED WALKWAYS ===
    // Bridges between buildings that span across streets at upper floors
    if (structureLayer && structureLayer.objects.length > 20) {
      this.generateElevatedWalkways(structureLayer.objects, defMap, heightMap, map.gridWidth, map.gridHeight)
    }

    // === STAIRCASES between elevation levels ===
    if (heightMap) {
      this.generateStaircases(heightMap, map.gridWidth, map.gridHeight)
    }

    // Position camera to see the town
    const cx = map.gridWidth / 2, cz = map.gridHeight / 2
    this.camera.position.set(cx - 10, 6, cz - 10)
    this.cameraYaw = Math.atan2(cz - this.camera.position.z, cx - this.camera.position.x)
    this.cameraPitch = -0.3

    // Freeze all static transforms (saves ~3800 matrix recalcs per frame)
    for (const group of [this.terrainGroup, this.buildingGroup, this.propGroup]) {
      group.traverse((child) => {
        child.matrixAutoUpdate = false
        child.updateMatrix()
      })
    }

    // Lighting from environment
    this.updateLighting(map.environment.timeOfDay)
  }

  /** Generate elevated walkways/bridges between close buildings */
  private generateElevatedWalkways(
    objects: import('../core/types').PlacedObject[],
    defMap: Map<string, ObjectDefinition>,
    heightMap: number[][] | null,
    gridW: number, gridH: number
  ): void {
    const walkwayMat = new THREE.MeshStandardMaterial({ color: 0x8a7a68, flatShading: true, roughness: 0.85 })
    const railMat = new THREE.MeshStandardMaterial({ color: 0x5a4a3a, flatShading: true, roughness: 0.9 })
    let count = 0
    const maxWalkways = 12

    for (let i = 0; i < objects.length && count < maxWalkways; i++) {
      const a = objects[i]
      const defA = defMap.get(a.definitionId)
      if (!defA || !a.properties.floors || (a.properties.floors as number) < 2) continue

      for (let j = i + 1; j < objects.length && count < maxWalkways; j++) {
        const b = objects[j]
        const defB = defMap.get(b.definitionId)
        if (!defB || !b.properties.floors || (b.properties.floors as number) < 2) continue

        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        // Only connect buildings 3-6 tiles apart (across a street)
        if (dist < 3 || dist > 6) continue

        const fpA = defA.footprint, fpB = defB.footprint
        const ax = a.x + fpA.w / 2, az = a.y + fpA.h / 2
        const bx = b.x + fpB.w / 2, bz = b.y + fpB.h / 2
        const bridgeH = 1.2 // height of the walkway (second floor level)
        const ah = heightMap ? getTerrainHeight(heightMap, Math.floor(ax), Math.floor(az)) : 0
        const bh = heightMap ? getTerrainHeight(heightMap, Math.floor(bx), Math.floor(bz)) : 0

        // Bridge deck
        const midX = (ax + bx) / 2, midZ = (az + bz) / 2
        const angle = Math.atan2(bz - az, bx - ax)
        const bridgeLen = dist * 0.7 // shorter than building distance
        const bridgeGeo = new THREE.BoxGeometry(bridgeLen, 0.12, 0.8)
        const bridge = new THREE.Mesh(bridgeGeo, walkwayMat)
        bridge.position.set(midX, (ah + bh) / 2 + bridgeH, midZ)
        bridge.rotation.y = -angle
        this.propGroup.add(bridge)

        // Railings
        for (const side of [-0.35, 0.35]) {
          const railGeo = new THREE.BoxGeometry(bridgeLen, 0.4, 0.05)
          const rail = new THREE.Mesh(railGeo, railMat)
          rail.position.set(
            midX + Math.sin(angle) * side,
            (ah + bh) / 2 + bridgeH + 0.2,
            midZ - Math.cos(angle) * side
          )
          rail.rotation.y = -angle
          this.propGroup.add(rail)
        }

        // Support arch (simple box underneath)
        const archGeo = new THREE.BoxGeometry(0.2, bridgeH, 0.2)
        const archMat = new THREE.MeshStandardMaterial({ color: 0x706058, flatShading: true })
        const support1 = new THREE.Mesh(archGeo, archMat)
        support1.position.set(ax + Math.cos(angle) * 0.5, ah + bridgeH / 2, az + Math.sin(angle) * 0.5)
        this.propGroup.add(support1)
        const support2 = new THREE.Mesh(archGeo, archMat)
        support2.position.set(bx - Math.cos(angle) * 0.5, bh + bridgeH / 2, bz - Math.sin(angle) * 0.5)
        this.propGroup.add(support2)

        count++
      }
    }
  }

  /** Generate staircases where terrain has elevation changes */
  private generateStaircases(
    heightMap: number[][], gridW: number, gridH: number
  ): void {
    const stepMat = new THREE.MeshStandardMaterial({ color: 0x808078, flatShading: true, roughness: 0.9 })
    let count = 0
    const maxStairs = 30

    for (let ty = 2; ty < gridH - 2 && count < maxStairs; ty += 3) {
      for (let tx = 2; tx < gridW - 2 && count < maxStairs; tx += 3) {
        const h = getTerrainHeight(heightMap, tx, ty)

        // Check for elevation change in each direction
        for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]] as const) {
          const nh = getTerrainHeight(heightMap, tx + dx, ty + dz)
          const diff = h - nh
          if (diff < 0.15 || diff > 0.8) continue // need a step but not a cliff

          // Generate steps from low to high
          const numSteps = Math.max(2, Math.ceil(diff / 0.08))
          const stepW = 0.6, stepD = 0.25
          const stepH = diff / numSteps
          const startX = tx + 0.5, startZ = ty + 0.5
          const angle = Math.atan2(dz, dx)

          for (let s = 0; s < numSteps; s++) {
            const t = s / numSteps
            const sx = startX + dx * (0.3 + t * 0.6)
            const sz = startZ + dz * (0.3 + t * 0.6)
            const sy = nh + s * stepH + stepH / 2

            const stepGeo = new THREE.BoxGeometry(
              dx === 0 ? stepW : stepD,
              stepH * 0.9,
              dz === 0 ? stepW : stepD
            )
            const step = new THREE.Mesh(stepGeo, stepMat)
            step.position.set(sx, sy, sz)
            this.propGroup.add(step)
          }

          count++
          break // only one staircase per position
        }
      }
    }
  }

  updateLighting(timeOfDay: number): void {
    this.currentTimeOfDay = timeOfDay
    const isNight = timeOfDay < 5 || timeOfDay >= 19
    const isDusk = timeOfDay >= 17 && timeOfDay < 19
    const isDawn = timeOfDay >= 5 && timeOfDay < 7
    const isGolden = timeOfDay >= 15 && timeOfDay < 17

    // Sun angle based on time (0=midnight, 12=noon)
    const sunAngle = ((timeOfDay - 6) / 12) * Math.PI // 0 at 6am, PI at 6pm
    const sunY = Math.sin(sunAngle) * 50
    const sunX = Math.cos(sunAngle) * 40 + this.townCenterX
    const sunZ = this.townCenterZ + 10

    if (isNight) {
      this.sunLight.intensity = 0.15
      this.sunLight.color.setHex(0x4466aa)
      this.sunLight.position.set(this.townCenterX, 40, sunZ) // moonlight from above
      this.ambientLight.intensity = 0.2
      this.ambientLight.color.setHex(0x202848)
      this.scene.fog = new THREE.FogExp2(0x101830, 0.015)
      if (this.skyUniforms) {
        this.skyUniforms.uZenith.value.setHex(0x0a0e2a)
        this.skyUniforms.uHorizon.value.setHex(0x101830)
      }
      if (this.sunDisc) {
        (this.sunDisc.material as THREE.MeshBasicMaterial).color.setHex(0xccccdd)
        this.sunDisc.position.set(0, 180, 0) // moon overhead
        this.sunDisc.scale.setScalar(0.3) // smaller moon
      }
    } else if (isDusk || isDawn) {
      this.sunLight.intensity = 0.8
      this.sunLight.color.setHex(0xffaa66)
      this.sunLight.position.set(sunX, Math.max(5, sunY), sunZ)
      this.ambientLight.intensity = 0.4
      this.ambientLight.color.setHex(0x604838)
      this.scene.fog = new THREE.FogExp2(0xffaa88, 0.006)
      if (this.skyUniforms) {
        this.skyUniforms.uZenith.value.setHex(0xcc6633)
        this.skyUniforms.uHorizon.value.setHex(0xffaa88)
      }
      if (this.sunDisc) {
        (this.sunDisc.material as THREE.MeshBasicMaterial).color.setHex(0xff8844)
        const dir = new THREE.Vector3(sunX - this.townCenterX, Math.max(5, sunY), sunZ - this.townCenterZ).normalize()
        this.sunDisc.position.copy(dir).multiplyScalar(200)
        this.sunDisc.scale.setScalar(1.2) // larger at horizon
      }
    } else if (isGolden) {
      this.sunLight.intensity = 1.0
      this.sunLight.color.setHex(0xffe8c0)
      this.sunLight.position.set(sunX, sunY, sunZ)
      this.ambientLight.intensity = 0.5
      this.ambientLight.color.setHex(0x706050)
      this.scene.fog = new THREE.FogExp2(0xe8d8c8, 0.005)
      if (this.skyUniforms) {
        this.skyUniforms.uZenith.value.setHex(0x5588bb)
        this.skyUniforms.uHorizon.value.setHex(0xe8d8c8)
      }
      if (this.sunDisc) {
        (this.sunDisc.material as THREE.MeshBasicMaterial).color.setHex(0xffdd88)
        const dir = new THREE.Vector3(sunX - this.townCenterX, sunY, sunZ - this.townCenterZ).normalize()
        this.sunDisc.position.copy(dir).multiplyScalar(200)
        this.sunDisc.scale.setScalar(1.0)
      }
    } else {
      this.sunLight.intensity = 1.2
      this.sunLight.color.setHex(0xfff4e0)
      this.sunLight.position.set(sunX, sunY, sunZ)
      this.ambientLight.intensity = 0.6
      this.ambientLight.color.setHex(0x606880)
      this.scene.fog = new THREE.FogExp2(0xd0e0f0, 0.008)
      if (this.skyUniforms) {
        this.skyUniforms.uZenith.value.setHex(0x4488cc)
        this.skyUniforms.uHorizon.value.setHex(0xd0e0f0)
      }
      if (this.sunDisc) {
        (this.sunDisc.material as THREE.MeshBasicMaterial).color.setHex(0xffee88)
        const dir = new THREE.Vector3(sunX - this.townCenterX, sunY, sunZ - this.townCenterZ).normalize()
        this.sunDisc.position.copy(dir).multiplyScalar(200)
        this.sunDisc.scale.setScalar(0.8)
      }
    }

    // Shadow camera follows sun position, targets town center
    this.sunLight.target.position.set(this.townCenterX, 0, this.townCenterZ)

    // Update emissive window intensity on buildings
    const emissiveIntensity = isNight ? 0.8 : (isDusk || isDawn) ? 0.4 : 0
    this.buildingGroup.traverse((child) => {
      if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshStandardMaterial) {
        if (child.material.emissiveMap) {
          child.material.emissiveIntensity = emissiveIntensity
        }
      }
    })
  }

  /** Initialize particle systems for smoke and fireflies */
  private initParticles(chimneyPositions: THREE.Vector3[], gridW: number, gridH: number): void {
    // Chimney smoke particles (8 per chimney, max 20 chimneys)
    const maxChimneys = Math.min(chimneyPositions.length, 20)
    if (maxChimneys > 0) {
      const perChimney = 8
      const count = maxChimneys * perChimney
      const positions = new Float32Array(count * 3)
      const velocities = new Float32Array(count * 3)
      const lifetimes = new Float32Array(count)
      const origins = new Float32Array(count * 3)

      for (let ci = 0; ci < maxChimneys; ci++) {
        const cp = chimneyPositions[ci]
        for (let pi = 0; pi < perChimney; pi++) {
          const idx = ci * perChimney + pi
          const i3 = idx * 3
          origins[i3] = cp.x
          origins[i3 + 1] = cp.y
          origins[i3 + 2] = cp.z
          // Start at random phase
          lifetimes[idx] = Math.random()
          positions[i3] = cp.x + (Math.random() - 0.5) * 0.1
          positions[i3 + 1] = cp.y + Math.random() * 1.5
          positions[i3 + 2] = cp.z + (Math.random() - 0.5) * 0.1
          velocities[i3] = (Math.random() - 0.5) * 0.05
          velocities[i3 + 1] = 0.2 + Math.random() * 0.15
          velocities[i3 + 2] = (Math.random() - 0.5) * 0.05
        }
      }

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      const smokeMat = new THREE.PointsMaterial({
        color: 0xbbbbbb, size: 0.2, transparent: true, opacity: 0.35,
        sizeAttenuation: true, depthWrite: false,
      })
      const points = new THREE.Points(geo, smokeMat)
      this.particleGroup.add(points)
      this.particleSystems.push({ points, positions, velocities, lifetimes, origins, count, type: 'smoke' })
    }

    // Ambient fireflies / dust motes (80 particles scattered across town)
    const fireflyCount = 80
    const ffPositions = new Float32Array(fireflyCount * 3)
    const ffVelocities = new Float32Array(fireflyCount * 3)
    const ffLifetimes = new Float32Array(fireflyCount)
    const ffOrigins = new Float32Array(fireflyCount * 3)

    for (let i = 0; i < fireflyCount; i++) {
      const i3 = i * 3
      const ox = Math.random() * gridW
      const oz = Math.random() * gridH
      const oy = 1.5 + Math.random() * 3
      ffOrigins[i3] = ox; ffOrigins[i3 + 1] = oy; ffOrigins[i3 + 2] = oz
      ffPositions[i3] = ox; ffPositions[i3 + 1] = oy; ffPositions[i3 + 2] = oz
      ffVelocities[i3] = (Math.random() - 0.5) * 0.3
      ffVelocities[i3 + 1] = (Math.random() - 0.5) * 0.1
      ffVelocities[i3 + 2] = (Math.random() - 0.5) * 0.3
      ffLifetimes[i] = Math.random()
    }

    const ffGeo = new THREE.BufferGeometry()
    ffGeo.setAttribute('position', new THREE.BufferAttribute(ffPositions, 3))
    const ffMat = new THREE.PointsMaterial({
      color: 0xffeeaa, size: 0.08, transparent: true, opacity: 0.6,
      sizeAttenuation: true, depthWrite: false,
    })
    const ffPoints = new THREE.Points(ffGeo, ffMat)
    this.particleGroup.add(ffPoints)
    this.particleSystems.push({
      points: ffPoints, positions: ffPositions, velocities: ffVelocities,
      lifetimes: ffLifetimes, origins: ffOrigins, count: fireflyCount, type: 'firefly',
    })
  }

  /** Animate all particle systems */
  private updateParticles(dt: number): void {
    for (const ps of this.particleSystems) {
      const pos = ps.positions
      const vel = ps.velocities
      const life = ps.lifetimes
      const orig = ps.origins

      for (let i = 0; i < ps.count; i++) {
        const i3 = i * 3
        life[i] += dt * (ps.type === 'smoke' ? 0.3 : 0.15)

        if (life[i] >= 1.0) {
          // Respawn at origin
          life[i] = 0
          pos[i3] = orig[i3] + (Math.random() - 0.5) * 0.15
          pos[i3 + 1] = orig[i3 + 1]
          pos[i3 + 2] = orig[i3 + 2] + (Math.random() - 0.5) * 0.15
          if (ps.type === 'smoke') {
            vel[i3] = (Math.random() - 0.5) * 0.05
            vel[i3 + 1] = 0.2 + Math.random() * 0.15
            vel[i3 + 2] = (Math.random() - 0.5) * 0.05
          }
        } else {
          pos[i3] += vel[i3] * dt
          pos[i3 + 1] += vel[i3 + 1] * dt
          pos[i3 + 2] += vel[i3 + 2] * dt

          if (ps.type === 'firefly') {
            // Gentle sinusoidal drift
            vel[i3] += (Math.random() - 0.5) * 0.4 * dt
            vel[i3 + 1] += (Math.random() - 0.5) * 0.2 * dt
            vel[i3 + 2] += (Math.random() - 0.5) * 0.4 * dt
            // Damping
            vel[i3] *= 0.99; vel[i3 + 1] *= 0.99; vel[i3 + 2] *= 0.99
          }
        }
      }

      const attr = ps.points.geometry.getAttribute('position') as THREE.BufferAttribute
      attr.needsUpdate = true

      // Fireflies: visible at night, faded during day
      if (ps.type === 'firefly') {
        const isNight = this.currentTimeOfDay < 5 || this.currentTimeOfDay >= 19
        const isDusk = this.currentTimeOfDay >= 17 && this.currentTimeOfDay < 19
        ;(ps.points.material as THREE.PointsMaterial).opacity = isNight ? 0.7 : isDusk ? 0.3 : 0.05
        ;(ps.points.material as THREE.PointsMaterial).color.setHex(isNight ? 0xffdd44 : 0xffffff)
        ;(ps.points.material as THREE.PointsMaterial).size = isNight ? 0.12 : 0.04
      }
    }
  }

  private startLoop(): void {
    let frameCount = 0
    const loop = () => {
      if (this.disposed) return
      this.animId = requestAnimationFrame(loop)
      const dt = Math.min(this.clock.getDelta(), 0.1)
      this.updateCamera(dt)
      this.updateParticles(dt)
      // Keep sky dome centered on camera
      if (this.skyMesh) this.skyMesh.position.copy(this.camera.position)
      this.renderer?.render(this.scene, this.camera)
      // Log draw call count once (after first render)
      if (frameCount++ === 1 && this.renderer) {
        const info = this.renderer.info.render
        console.log(`[3D Perf] draw calls: ${info.calls}, triangles: ${info.triangles}, points: ${info.points}`)
      }
    }
    this.animId = requestAnimationFrame(loop)
  }

  private updateCamera(dt: number): void {
    const speed = 8 * dt
    this._fwd.set(
      Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch),
      Math.sin(this.cameraPitch),
      Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch)
    ).normalize()
    this._right.crossVectors(this._fwd, this._up).normalize()

    if (this.keysHeld.has('KeyW')) this.camera.position.addScaledVector(this._fwd, speed)
    if (this.keysHeld.has('KeyS')) this.camera.position.addScaledVector(this._fwd, -speed)
    if (this.keysHeld.has('KeyA')) this.camera.position.addScaledVector(this._right, -speed)
    if (this.keysHeld.has('KeyD')) this.camera.position.addScaledVector(this._right, speed)
    if (this.keysHeld.has('KeyQ')) this.camera.position.y += speed * 0.7
    if (this.keysHeld.has('KeyE')) this.camera.position.y = Math.max(1, this.camera.position.y - speed * 0.7)

    this._target.copy(this.camera.position).add(this._fwd)
    this.camera.lookAt(this._target)
  }

  /** Capture a screenshot of the current 3D view as a data URL */
  captureScreenshot(): string {
    if (!this.renderer) return ''
    this.renderer.render(this.scene, this.camera)
    return this.renderer.domElement.toDataURL('image/png')
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.animId)

    // Release pointer lock if active
    if (this.pointerLocked) document.exitPointerLock()

    // Remove all event listeners
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown)
    if (this._onKeyUp) window.removeEventListener('keyup', this._onKeyUp)
    if (this._onPointerLockChange) document.removeEventListener('pointerlockchange', this._onPointerLockChange)
    if (this.renderer?.domElement) {
      if (this._onClick) this.renderer.domElement.removeEventListener('click', this._onClick)
      if (this._onMouseMove) this.renderer.domElement.removeEventListener('mousemove', this._onMouseMove)
    }
    this._resizeObserver?.disconnect()

    // Dispose all geometries and materials in the scene
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose()
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose())
        } else {
          obj.material?.dispose()
        }
      } else if (obj instanceof THREE.Points) {
        obj.geometry?.dispose()
        ;(obj.material as THREE.Material)?.dispose()
      }
    })

    this.particleSystems = []
    this.renderer?.dispose()
    if (this.renderer?.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement)
    }
    this.renderer = null
    this.scene.clear()
  }
}
