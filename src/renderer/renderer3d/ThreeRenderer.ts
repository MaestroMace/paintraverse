/**
 * Three.js Real-Time Renderer
 * Replaces Canvas2D for real-time preview. GPU-accelerated, 60fps.
 * Canvas2D remains as the export-only renderer for final PNG output.
 */

import * as THREE from 'three'
import type { MapDocument, ObjectDefinition, PlacedObject } from '../core/types'
import type { BuildingPalette } from '../inspiration/StyleMapper'
import { buildTerrainMesh, getTerrainHeight } from './TerrainMesh'
import { buildBuildingMeshes } from './BuildingFactory'
import { buildPropMeshes } from './PropFactory'

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

export class ThreeRenderer {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer | null = null
  private clock = new THREE.Clock()
  private animId = 0

  // Camera movement
  private keysHeld = new Set<string>()
  private mouseDown = false
  private lastMouseX = 0
  private lastMouseY = 0
  private cameraYaw = Math.PI * 0.75  // initial look direction
  private cameraPitch = -0.4          // slight downward look

  // Scene objects
  private terrainGroup = new THREE.Group()
  private buildingGroup = new THREE.Group()
  private propGroup = new THREE.Group()
  private sunLight: THREE.DirectionalLight
  private ambientLight: THREE.AmbientLight

  // State
  private container: HTMLElement | null = null
  private disposed = false
  private _onKeyDown: ((e: KeyboardEvent) => void) | null = null
  private _onKeyUp: ((e: KeyboardEvent) => void) | null = null

  constructor() {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x87ceeb) // sky blue
    this.scene.fog = new THREE.FogExp2(0xc8d8e8, 0.008)

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 500)
    this.camera.position.set(20, 4, 20)

    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 1.2)
    this.sunLight.position.set(30, 50, 20)
    this.scene.add(this.sunLight)

    this.ambientLight = new THREE.AmbientLight(0x606880, 0.6)
    this.scene.add(this.ambientLight)

    this.scene.add(this.terrainGroup)
    this.scene.add(this.buildingGroup)
    this.scene.add(this.propGroup)
  }

  init(container: HTMLElement): void {
    this.container = container
    this.disposed = false

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // pixel art = no AA
      powerPreference: 'high-performance',
    })
    this.renderer.setPixelRatio(1) // no HiDPI — pixel art
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    this.renderer.shadowMap.enabled = false // Phase 4
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.imageRendering = 'pixelated'

    this.camera.aspect = container.clientWidth / container.clientHeight
    this.camera.updateProjectionMatrix()

    // Input
    this._onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      this.keysHeld.add(e.code)
    }
    this._onKeyUp = (e: KeyboardEvent) => {
      this.keysHeld.delete(e.code)
    }
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)

    // Mouse look
    this.renderer.domElement.addEventListener('mousedown', (e) => {
      if (e.button === 0 || e.button === 2) { this.mouseDown = true; this.lastMouseX = e.clientX; this.lastMouseY = e.clientY }
    })
    this.renderer.domElement.addEventListener('mouseup', () => { this.mouseDown = false })
    this.renderer.domElement.addEventListener('mousemove', (e) => {
      if (!this.mouseDown) return
      const dx = e.clientX - this.lastMouseX
      const dy = e.clientY - this.lastMouseY
      this.cameraYaw -= dx * 0.003
      this.cameraPitch = Math.max(-1.2, Math.min(0.5, this.cameraPitch - dy * 0.003))
      this.lastMouseX = e.clientX
      this.lastMouseY = e.clientY
    })
    this.renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault())

    // Resize
    const ro = new ResizeObserver(() => {
      if (!this.renderer || !this.container) return
      const w = this.container.clientWidth, h = this.container.clientHeight
      if (w === 0 || h === 0) return
      this.renderer.setSize(w, h)
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
    })
    ro.observe(container)

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

    const ts = map.tileSize
    const palettes = buildingPalettes || DEFAULT_BUILDING_PALETTES
    const defMap = new Map(objectDefs.map(d => [d.id, d]))

    // Terrain (with height map from seed)
    const seed = map.generationConfig?.seed ?? 0
    const terrainLayer = map.layers.find(l => l.type === 'terrain')
    let heightMap: number[][] | null = null
    if (terrainLayer?.terrainTiles) {
      const terrainGroup = buildTerrainMesh(terrainLayer.terrainTiles, map.gridWidth, map.gridHeight, seed)
      this.terrainGroup.add(terrainGroup)
      heightMap = (terrainGroup as any)._heightMap ?? null
    }

    // Buildings — placed at terrain height
    const structureLayer = map.layers.find(l => l.type === 'structure')
    if (structureLayer) {
      const meshes = buildBuildingMeshes(structureLayer.objects, defMap, palettes)
      for (const m of meshes) {
        // Adjust Y position to terrain height
        if (heightMap) {
          const tx = Math.floor(m.position.x)
          const tz = Math.floor(m.position.z)
          m.position.y += getTerrainHeight(heightMap, tx, tz)
        }
        this.buildingGroup.add(m)
      }
    }

    // Props — placed at terrain height
    const propLayer = map.layers.find(l => l.type === 'prop')
    if (propLayer) {
      const meshes = buildPropMeshes(propLayer.objects, defMap)
      for (const m of meshes) {
        if (heightMap) {
          const tx = Math.floor(m.position.x)
          const tz = Math.floor(m.position.z)
          m.position.y += getTerrainHeight(heightMap, tx, tz)
        }
        this.propGroup.add(m)
      }
    }

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
    const isNight = timeOfDay < 5 || timeOfDay >= 19
    const isDusk = timeOfDay >= 17 && timeOfDay < 19
    const isGolden = timeOfDay >= 15 && timeOfDay < 17

    if (isNight) {
      this.sunLight.intensity = 0.15
      this.sunLight.color.setHex(0x4466aa)
      this.ambientLight.intensity = 0.2
      this.ambientLight.color.setHex(0x202848)
      this.scene.background = new THREE.Color(0x0a0e1a)
      this.scene.fog = new THREE.FogExp2(0x0a0e1a, 0.015)
    } else if (isDusk) {
      this.sunLight.intensity = 0.8
      this.sunLight.color.setHex(0xffaa66)
      this.ambientLight.intensity = 0.4
      this.ambientLight.color.setHex(0x604838)
      this.scene.background = new THREE.Color(0xd08050)
      this.scene.fog = new THREE.FogExp2(0xc08060, 0.006)
    } else if (isGolden) {
      this.sunLight.intensity = 1.0
      this.sunLight.color.setHex(0xffe8c0)
      this.ambientLight.intensity = 0.5
      this.ambientLight.color.setHex(0x706050)
      this.scene.background = new THREE.Color(0xa0c8e0)
      this.scene.fog = new THREE.FogExp2(0xb0d0e0, 0.005)
    } else {
      this.sunLight.intensity = 1.2
      this.sunLight.color.setHex(0xfff4e0)
      this.ambientLight.intensity = 0.6
      this.ambientLight.color.setHex(0x606880)
      this.scene.background = new THREE.Color(0x87ceeb)
      this.scene.fog = new THREE.FogExp2(0xc8d8e8, 0.008)
    }
  }

  private startLoop(): void {
    const loop = () => {
      if (this.disposed) return
      this.animId = requestAnimationFrame(loop)
      const dt = Math.min(this.clock.getDelta(), 0.1)
      this.updateCamera(dt)
      this.renderer?.render(this.scene, this.camera)
    }
    this.animId = requestAnimationFrame(loop)
  }

  private updateCamera(dt: number): void {
    const speed = 8 * dt
    const forward = new THREE.Vector3(
      Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch),
      Math.sin(this.cameraPitch),
      Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch)
    ).normalize()
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize()

    if (this.keysHeld.has('KeyW')) this.camera.position.addScaledVector(forward, speed)
    if (this.keysHeld.has('KeyS')) this.camera.position.addScaledVector(forward, -speed)
    if (this.keysHeld.has('KeyA')) this.camera.position.addScaledVector(right, -speed)
    if (this.keysHeld.has('KeyD')) this.camera.position.addScaledVector(right, speed)
    if (this.keysHeld.has('KeyQ')) this.camera.position.y += speed * 0.7
    if (this.keysHeld.has('KeyE')) this.camera.position.y = Math.max(1, this.camera.position.y - speed * 0.7)

    // Look direction from yaw/pitch
    const target = this.camera.position.clone().add(forward)
    this.camera.lookAt(target)
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
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown)
    if (this._onKeyUp) window.removeEventListener('keyup', this._onKeyUp)
    this.renderer?.dispose()
    if (this.renderer?.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement)
    }
    this.renderer = null
    this.scene.clear()
  }
}
