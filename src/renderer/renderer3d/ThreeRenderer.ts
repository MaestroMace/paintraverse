/**
 * Three.js Real-Time Renderer
 * Replaces Canvas2D for real-time preview. GPU-accelerated, 60fps.
 * Canvas2D remains as the export-only renderer for final PNG output.
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { MapDocument, ObjectDefinition, PlacedObject } from '../core/types'
import type { BuildingPalette } from '../inspiration/StyleMapper'
import { buildTerrainMesh, getTerrainHeight, tickWater } from './TerrainMesh'

// First-person walkaround constants. Minecraft-ish feel.
const EYE_HEIGHT = 1.6
const JUMP_STRENGTH = 7.0
const GRAVITY = 22.0
const WALK_SPEED = 6.0
const FLY_SPEED = 10.0
const DOUBLE_TAP_MS = 300
const MOUSE_YAW_SENS = 0.0025
const MOUSE_PITCH_SENS = 0.002
import { buildBuildingMeshes, setWallEmissiveIntensity, type BuildingBatchResult } from './BuildingFactory'
import { tickWallEmissive } from './architecture/VolumeRenderer'
import { buildLanternStrings, setLanternEmissiveIntensity, tickLanternEmissive } from './LanternStrings'
import { buildPropMeshes, setLampPoolOpacity, type PropBatchResult } from './PropFactory'

/**
 * Patch a material's fog to fade in more strongly near ground level, so
 * mist appears to pool in valleys and plazas while ridges and roofs stay
 * clear. Uses Three.js onBeforeCompile shader injection. Idempotent.
 */
function patchHeightFog(material: THREE.Material): void {
  const m = material as THREE.Material & { __heightFogPatched?: boolean }
  if (m.__heightFogPatched) return
  m.__heightFogPatched = true
  const prev = material.onBeforeCompile?.bind(material)
  material.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <fog_pars_vertex>',
        '#include <fog_pars_vertex>\n#ifdef USE_FOG\nvarying float vWorldY;\n#endif'
      )
      .replace(
        '#include <fog_vertex>',
        '#include <fog_vertex>\n#ifdef USE_FOG\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;\n#endif'
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <fog_pars_fragment>',
        '#include <fog_pars_fragment>\n#ifdef USE_FOG\nvarying float vWorldY;\n#endif'
      )
      .replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          float groundT = 1.0 - smoothstep(0.0, 4.0, vWorldY);
          #ifdef FOG_EXP2
            float densityBoost = 1.0 + groundT * 3.0;
            float fogFactor = 1.0 - exp(-fogDensity * fogDensity * densityBoost * densityBoost * vFogDepth * vFogDepth);
          #else
            float rangeShrink = 1.0 - groundT * 0.6;
            float fogFactor = smoothstep(fogNear, fogFar * rangeShrink, vFogDepth);
          #endif
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, clamp(fogFactor, 0.0, 1.0));
        #endif`
      )
  }
  material.customProgramCacheKey = () => 'heightFog'
  material.needsUpdate = true
}

function simpleHash(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0
  return Math.abs(h)
}

// Mirrored from BuildingFactory so we can compute chimney positions
const HEIGHT_MULT_MAP: Record<string, number> = {
  tower: 2.0, clock_tower: 2.4, bell_tower: 2.6, bell_tower_tall: 3.0,
  watchtower: 2.2, cathedral: 2.0, lighthouse: 3.0, chapel: 1.5,
  temple: 1.5, town_gate: 1.8, archway: 1.5, round_tower: 2.4,
}
const NO_JITTER_MAP = new Set<string>([
  'archway', 'town_gate', 'gatehouse', 'staircase', 'aqueduct',
])
function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
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
  { wall: 0xe8d8b8, roof: 0x8b4513, door: 0x5a4030 },  // warm cream + brown roof
  { wall: 0xd8c8a0, roof: 0x7a3020, door: 0x4a3020 },  // tan + dark red roof
  { wall: 0xf0e8d8, roof: 0x6a4a3a, door: 0x6a4a30 },  // white stucco + terracotta
  { wall: 0xc0a880, roof: 0x505868, door: 0x3a3a42 },  // sandstone + slate roof
  { wall: 0xb87050, roof: 0x5a3020, door: 0x4a3020 },  // red brick
  { wall: 0xd8d0c0, roof: 0x4a7a5a, door: 0x3a5a4a },  // pale + green copper roof
  { wall: 0xa09888, roof: 0x484858, door: 0x3a3a42 },  // grey stone + dark slate
  { wall: 0xe0d0b0, roof: 0x8a5a40, door: 0x5a4030 },  // buttercream + wood
]

// Sky dome shader — gradient hemisphere from horizon to zenith
const SKY_VERT = `
varying vec3 vLocalPos;
void main() {
  vLocalPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
// Sky shader: gradient horizon→zenith, three bands of cloud-ish streaks,
// plus a noisy distant-mountain silhouette right at the horizon line for
// depth perception. uCloud / uCloudColor / uMountain control intensity
// from updateLighting.
const SKY_FRAG = `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uCloudColor;
uniform float uCloud;
uniform vec3 uMountainColor;
uniform float uMountain;
varying vec3 vLocalPos;
void main() {
  vec3 dir = normalize(vLocalPos);
  float h = dir.y;
  float t = clamp(h * 2.0 + 0.1, 0.0, 1.0);
  vec3 base = mix(uHorizon, uZenith, t);
  float az = atan(dir.z, dir.x);

  // Cloud noise: three bands of stretched sinusoidal streaks, weighted
  // toward the lower half of the sky.
  float band1 = sin(az * 4.0 + h * 7.0) * 0.5 + 0.5;
  float band2 = sin(az * 9.0 - h * 11.0 + 1.7) * 0.5 + 0.5;
  float band3 = sin(az * 13.0 + h * 5.0 + 3.1) * 0.5 + 0.5;
  float cloudMask = smoothstep(0.55, 0.95, band1 * 0.5 + band2 * 0.3 + band3 * 0.2);
  float horizonWeight = 1.0 - smoothstep(-0.05, 0.45, h);
  float c = uCloud * cloudMask * horizonWeight;
  vec3 col = mix(base, uCloudColor, c);

  // Distant mountain silhouette: low-frequency azimuthal noise raises a
  // "horizon line" between h ~= 0.01 and ~0.17 (~3x the previous range)
  // so the range reads as proper distant peaks rather than a sliver.
  // The extra high-freq sin adds sharp peak tips on top of rolling hills.
  float mtnNoise = sin(az * 2.3) * 0.5
                 + sin(az * 5.7 + 1.0) * 0.3
                 + sin(az * 11.1 + 2.5) * 0.2
                 + sin(az * 17.1 + 4.2) * 0.15;
  float horizonY = 0.09 + mtnNoise * 0.08 * uMountain;
  float belowMtn = 1.0 - smoothstep(horizonY - 0.01, horizonY + 0.005, h);
  col = mix(col, uMountainColor, belowMtn * uMountain);

  gl_FragColor = vec4(col, 1.0);
}
`

// Particle data for smoke / fireflies / birds.
// For 'bird' particles the velocities array repurposes its 3 slots:
//   [i3]   = orbit radius
//   [i3+1] = angular speed (rad/s)
//   [i3+2] = phase offset (rad)
// origins[i3..i3+2] stores the spire top xyz the bird circles around.
interface ParticleSystem {
  points: THREE.Points
  positions: Float32Array
  velocities: Float32Array
  lifetimes: Float32Array
  origins: Float32Array
  count: number
  type: 'smoke' | 'firefly' | 'bird'
}

export class ThreeRenderer {
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private renderer: THREE.WebGLRenderer | null = null
  private clock = new THREE.Clock()
  private animId = 0

  // Camera movement — first-person walkaround
  private keysHeld = new Set<string>()
  private cameraYaw = Math.PI * 0.75
  private cameraPitch = -0.1
  private pointerLocked = false
  private flyMode = false
  private verticalVel = 0    // walk-mode physics only
  private lastSpaceTap = 0   // ms timestamp for double-tap detection
  // Cached height map for ground sampling; populated in loadMap.
  private terrainHeightMap: number[][] | null = null
  // Collision mask for walk-mode: 1 byte per tile, non-zero = blocked
  // (building footprint, water, out-of-bounds). Populated in loadMap.
  private collisionMask: Uint8Array | null = null
  private gridW = 0
  private gridH = 0

  // Scene objects
  private terrainGroup = new THREE.Group()
  private buildingGroup = new THREE.Group()
  private propGroup = new THREE.Group()
  private particleGroup = new THREE.Group()
  private sunLight: THREE.DirectionalLight
  private ambientLight: THREE.AmbientLight

  // Sky dome
  private skyMesh: THREE.Mesh | null = null
  private skyUniforms: {
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uCloudColor: { value: THREE.Color };
    uCloud: { value: number };
    uMountainColor: { value: THREE.Color };
    uMountain: { value: number };
  } | null = null
  private sunDisc: THREE.Mesh | null = null

  // Particles
  private particleSystems: ParticleSystem[] = []
  private currentTimeOfDay = 12

  // Reusable vectors (avoid per-frame allocations)
  private _fwd = new THREE.Vector3()
  private _right = new THREE.Vector3()
  private _up = new THREE.Vector3(0, 1, 0)
  private _target = new THREE.Vector3()

  // FPS tracking — wall-clock based so slow frames count correctly.
  private _fpsFrames = 0
  private _fpsWallStart = 0
  private _fps = 0
  /** Whether the browser currently has pointer lock on our canvas. */
  get isPointerLocked(): boolean { return this.pointerLocked }
  get fps(): number { return this._fps }
  private _drawCalls = 0
  get drawCalls(): number { return this._drawCalls }
  // Accurate per-frame stats snapshotted mid-composer so the final
  // OutputPass doesn't overwrite them. Updated each rAF loop.
  private _frameStats = {
    drawCalls: 0, triangles: 0, lines: 0, points: 0,
    frameMs: 0, updateMs: 0, renderMs: 0,
  }
  // Turn off post-processing at noon to skip the gaussian blur passes
  // when bloom would be nearly invisible anyway. Set by updateLighting.
  private _useComposer = true

  // State
  private container: HTMLElement | null = null
  private disposed = false
  private _onKeyDown: ((e: KeyboardEvent) => void) | null = null
  private _onKeyUp: ((e: KeyboardEvent) => void) | null = null
  private _onMouseMove: ((e: MouseEvent) => void) | null = null
  private _onPointerLockChange: (() => void) | null = null
  private _resizeObserver: ResizeObserver | null = null
  // Track town extents for shadow camera
  private townCenterX = 24
  private townCenterZ = 24
  private townRadius = 32

  // Post-processing
  private composer: EffectComposer | null = null
  private bloomPass: UnrealBloomPass | null = null

  constructor() {
    this.scene = new THREE.Scene()
    this.scene.background = null // sky dome replaces this
    this.scene.fog = new THREE.FogExp2(0xd0e0f0, 0.004) // light fog, see most of town

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.5, 500)
    this.camera.position.set(20, 8, 20)

    // Sun light — casts shadows on buildings only for dramatic alley silhouettes.
    // Shadow camera bounds are tuned per-map in loadMap via updateShadowCamera().
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 1.2)
    this.sunLight.position.set(30, 50, 20)
    this.sunLight.castShadow = true
    // 512² shadow map (was 1024²) — 4× fewer pixels to rasterize, still
    // plenty of detail for the softened alley silhouettes we want at dusk.
    this.sunLight.shadow.mapSize.set(512, 512)
    this.sunLight.shadow.bias = -0.0008
    this.sunLight.shadow.normalBias = 0.04
    this.sunLight.shadow.camera.near = 1
    this.sunLight.shadow.camera.far = 200
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
      uCloudColor: { value: new THREE.Color(0xffd0a0) },
      uCloud: { value: 0.05 },
      uMountainColor: { value: new THREE.Color(0x707888) },
      uMountain: { value: 1.0 },
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
      antialias: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    })
    // Render at 40% resolution for performance, CSS upscale with pixelated
    const RENDER_SCALE = 0.4
    const rw = Math.max(1, Math.floor(container.clientWidth * RENDER_SCALE))
    const rh = Math.max(1, Math.floor(container.clientHeight * RENDER_SCALE))
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(rw, rh, false)
    this.renderer.shadowMap.enabled = true
    // Basic PCF (not Soft) — half the sample cost per shadow lookup with
    // only slightly harder edges. PCFSoftShadowMap was the third most
    // expensive thing in the frame after wall meshes and bloom.
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // Disable automatic reset of renderer.info so we can snapshot scene
    // draw-call / triangle counts before the composer's OutputPass
    // overwrites them. We reset at the start of each rAF loop.
    this.renderer.info.autoReset = false
    container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.style.imageRendering = 'pixelated'

    this.camera.aspect = container.clientWidth / container.clientHeight
    this.camera.updateProjectionMatrix()

    // Post-processing: bloom for warm evening lamp/window glow. OutputPass
    // applies the final color-space conversion (replaces the renderer's).
    this.composer = new EffectComposer(this.renderer)
    this.composer.setSize(rw, rh)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    // Bloom at half resolution — UnrealBloomPass chains several gaussian
    // blur passes; halving the input dimensions quarters the per-frame
    // cost while the bloom halo still looks smooth (bloom is low-freq).
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(rw / 2, rh / 2), 0.2, 0.6, 0.95)
    this.composer.addPass(this.bloomPass)
    this.composer.addPass(new OutputPass())

    // First-person input — click canvas to lock pointer, ESC to exit.
    // Mouse movement rotates the camera while locked (no button hold).
    // WASD = horizontal movement, Space = jump / fly-rise, double-tap
    // Space = toggle fly mode, ShiftLeft = fly-descend.
    this._onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      // Space: single tap jumps (walk) / noop (fly); double tap toggles fly.
      if (e.code === 'Space') {
        e.preventDefault()
        const now = performance.now()
        const isDouble = (now - this.lastSpaceTap) < DOUBLE_TAP_MS
        this.lastSpaceTap = now
        if (isDouble) {
          this.flyMode = !this.flyMode
          this.verticalVel = 0
        } else if (!this.flyMode) {
          // Jump only if roughly on the ground (verticalVel ~= 0 means we
          // just landed or are planted)
          if (Math.abs(this.verticalVel) < 0.01) {
            this.verticalVel = JUMP_STRENGTH
          }
        }
        // In fly mode, holding Space is what rises; the update loop handles it.
      }
      this.keysHeld.add(e.code)
    }
    this._onKeyUp = (e: KeyboardEvent) => {
      this.keysHeld.delete(e.code)
    }
    window.addEventListener('keydown', this._onKeyDown)
    window.addEventListener('keyup', this._onKeyUp)

    const canvas = this.renderer.domElement
    // Click → request pointer lock. In newer browsers this returns a Promise
    // (and Electron varies); handle both sync and Promise paths, and log
    // explicit errors so silent-fail is visible during debugging.
    const tryLock = () => {
      if (this.pointerLocked) return
      try {
        const ret = (canvas.requestPointerLock as (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void)({
          unadjustedMovement: true,
        })
        if (ret && typeof (ret as Promise<void>).then === 'function') {
          ;(ret as Promise<void>).catch((err) => {
            // unadjustedMovement may not be supported — retry without.
            try { canvas.requestPointerLock() } catch {}
            console.warn('[ThreeRenderer] pointer lock (with unadjustedMovement) rejected:', err)
          })
        }
      } catch (err) {
        console.warn('[ThreeRenderer] pointer lock request failed:', err)
        try { canvas.requestPointerLock() } catch {}
      }
    }
    canvas.addEventListener('click', tryLock)
    // Also engage on mousedown so even incomplete clicks trigger it.
    canvas.addEventListener('mousedown', tryLock)
    this._onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === canvas
      if (!this.pointerLocked) this.keysHeld.clear()
    }
    document.addEventListener('pointerlockchange', this._onPointerLockChange)
    // Diagnostic: browsers sometimes deny the request silently. Logging
    // makes this visible in DevTools.
    document.addEventListener('pointerlockerror', () => {
      console.warn('[ThreeRenderer] pointerlockerror: browser denied pointer lock')
    })
    this._onMouseMove = (e: MouseEvent) => {
      if (!this.pointerLocked) return
      this.cameraYaw += e.movementX * MOUSE_YAW_SENS
      this.cameraPitch = Math.max(
        -Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, this.cameraPitch - e.movementY * MOUSE_PITCH_SENS),
      )
    }
    document.addEventListener('mousemove', this._onMouseMove)
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())

    // Resize (render at RENDER_SCALE, CSS fills container)
    this._resizeObserver = new ResizeObserver(() => {
      if (!this.renderer || !this.container) return
      const w = this.container.clientWidth, h = this.container.clientHeight
      if (w === 0 || h === 0) return
      const rw = Math.max(1, Math.floor(w * RENDER_SCALE))
      const rh = Math.max(1, Math.floor(h * RENDER_SCALE))
      this.renderer.setSize(rw, rh, false)
      this.composer?.setSize(rw, rh)
      this.bloomPass?.setSize(rw, rh)
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

    // Track town extents for shadow camera sizing
    this.townCenterX = map.gridWidth / 2
    this.townCenterZ = map.gridHeight / 2
    this.townRadius = Math.max(16, Math.max(map.gridWidth, map.gridHeight) * 0.7)

    // Terrain (with height map from seed)
    const seed = map.generationConfig?.seed ?? 0
    const terrainLayer = map.layers.find(l => l.type === 'terrain')
    let heightMap: number[][] | null = null
    if (terrainLayer?.terrainTiles) {
      const terrainGroup = buildTerrainMesh(terrainLayer.terrainTiles, map.gridWidth, map.gridHeight, seed)
      this.terrainGroup.add(terrainGroup)
      heightMap = (terrainGroup as any)._heightMap ?? null
    }
    // Cache heightMap for the FPS ground-follow sampler so we don't
    // traverse the scene every frame.
    this.terrainHeightMap = heightMap

    // Build walk-mode collision mask: 1 byte per tile, non-zero = blocked.
    // Buildings (structure-layer footprints) + water tiles are blocked;
    // props are deliberately NOT included so the player can walk through
    // trees / barrels / statues without clipping. Out-of-bounds counts as
    // blocked in isBlocked() so the player can't walk off the map.
    this.gridW = map.gridWidth
    this.gridH = map.gridHeight
    const mask = new Uint8Array(this.gridW * this.gridH)
    const structLayerForMask = map.layers.find(l => l.type === 'structure')
    for (const obj of structLayerForMask?.objects ?? []) {
      const def = defMap.get(obj.definitionId)
      const fp = def?.footprint ?? { w: 1, h: 1 }
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const bx = obj.x + dx, by = obj.y + dy
          if (bx >= 0 && bx < this.gridW && by >= 0 && by < this.gridH) {
            mask[by * this.gridW + bx] = 1
          }
        }
      }
    }
    const terrainTiles = terrainLayer?.terrainTiles
    if (terrainTiles) {
      for (let y = 0; y < this.gridH; y++) {
        for (let x = 0; x < this.gridW; x++) {
          if (terrainTiles[y]?.[x] === 3) mask[y * this.gridW + x] = 1
        }
      }
    }
    this.collisionMask = mask

    // Height lookup function for factories (bakes terrain height into geometry)
    const hLookup = heightMap
      ? (x: number, z: number) => getTerrainHeight(heightMap!, x, z)
      : undefined

    // Buildings — batched: walls individual, roofs/details merged
    const structureLayer = map.layers.find(l => l.type === 'structure')
    const chimneyPositions: THREE.Vector3[] = []
    if (structureLayer) {
      const result = buildBuildingMeshes(structureLayer.objects, defMap, palettes, hLookup)
      for (const m of result.wallMeshes) {
        m.castShadow = true
        m.receiveShadow = true
        this.buildingGroup.add(m)
      }
      for (const m of result.batched) {
        // Batched roof/ornament/detail meshes: merged geometry with many
        // triangles, but the visual shadow contribution above the wall
        // already established is minimal. Skip shadow-casting for a big
        // perf win on the shadow pass (halved caster triangle count).
        m.castShadow = false
        m.receiveShadow = true
        this.buildingGroup.add(m)
      }

      // Collect chimney positions for smoke particles. Must mirror the
      // jitter applied in BuildingFactory so smoke lines up with the
      // chimney's actual position, not its pre-jitter grid cell.
      const URBAN_DISTRICT_IDS = new Set(['residential', 'market', 'artisan', 'noble'])
      for (const obj of structureLayer.objects) {
        const hash = simpleHash(obj.id)
        if (hash % 5 >= 2) continue
        const def = defMap.get(obj.definitionId)
        if (!def) continue
        const fp = { w: def.footprint.w, h: def.footprint.h }
        const district = (obj.properties.district as string) || 'residential'
        // Mirrored floor-count logic from BuildingFactory (urban districts
        // taller, narrow_house always tall, otherwise 1–2 floors).
        let floors: number
        if (typeof obj.properties.floors === 'number') floors = obj.properties.floors as number
        else if (obj.definitionId === 'narrow_house') floors = 3 + (hash % 2)
        else if (URBAN_DISTRICT_IDS.has(district)) floors = 2 + (hash % 3)
        else floors = 1 + (hash % 2)
        const heightMult = HEIGHT_MULT_MAP[obj.definitionId] ?? 1.0
        const jitter = !NO_JITTER_MAP.has(obj.definitionId)
        const hScale = jitter ? 0.85 + rand01(hash, 1) * 0.3 : 1.0
        const jitterDX = jitter ? (rand01(hash, 2) - 0.5) * 0.35 : 0
        const jitterDZ = jitter ? (rand01(hash, 3) - 0.5) * 0.35 : 0
        const wallH = floors * 1.05 * heightMult * hScale
        const roofFrac = ROOF_FRAC_MAP[obj.definitionId] ?? 0.3
        const roofH = wallH * roofFrac
        const chimSide = (obj.properties.chimneyPos === 'left') ? -1 : 1
        const centerX = obj.x + fp.w / 2
        const centerZ = obj.y + fp.h / 2
        const bx = centerX + chimSide * fp.w * 0.3 + jitterDX
        const bz = centerZ + jitterDZ
        // Sample max terrain height across footprint (matches BuildingFactory).
        let maxTH = 0
        if (heightMap) {
          for (let fy = 0; fy < fp.h; fy++) {
            for (let fx = 0; fx < fp.w; fx++) {
              const th = getTerrainHeight(heightMap, obj.x + fx, obj.y + fy)
              if (th > maxTH) maxTH = th
            }
          }
        }
        const baseY = heightMap ? maxTH : (obj.elevation || 0)
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

    // === HANGING LANTERN STRINGS ===
    // Iconic Traverse-Town overhead chains of warm lanterns strung between
    // close buildings. Emissive intensity is driven from updateLighting so
    // they light up at dusk with the windows.
    {
      const ls = buildLanternStrings(map, defMap, heightMap)
      if (ls.ropeMesh) this.propGroup.add(ls.ropeMesh)
      if (ls.lanternMesh) this.propGroup.add(ls.lanternMesh)
    }

    // Spawn particles
    this.initParticles(chimneyPositions, map.gridWidth, map.gridHeight)

    // === BIRDS AT SPIRES ===
    // Collect the top-centers of the tallest landmarks (cathedral, bell tower,
    // watchtower, lighthouse, clock_tower) and spawn a few dark circling
    // birds above each. Purely atmospheric — visible at dusk against the
    // warm sky.
    // Only true landmarks — `tower` and `round_tower` were dropped because
    // they're common small buildings (weights 2–5 across multiple districts),
    // not rare spires, which caused birds to orbit lots of short roofs and
    // read as stationary dots at mid-sky.
    const SPIRE_IDS = new Set([
      'cathedral', 'bell_tower', 'bell_tower_tall', 'watchtower',
      'lighthouse', 'clock_tower',
    ])
    const spirePositions: THREE.Vector3[] = []
    if (structureLayer) {
      for (const obj of structureLayer.objects) {
        if (!SPIRE_IDS.has(obj.definitionId)) continue
        const def = defMap.get(obj.definitionId)
        if (!def) continue
        const fp = { w: def.footprint.w, h: def.footprint.h }
        const hash = simpleHash(obj.id)
        const floors = typeof obj.properties.floors === 'number'
          ? (obj.properties.floors as number) : 2 + (hash % 2)
        const heightMult = HEIGHT_MULT_MAP[obj.definitionId] ?? 1.0
        const hScale = 0.85 + rand01(hash, 1) * 0.3
        const wallH = floors * 1.05 * heightMult * hScale
        const roofFrac = ROOF_FRAC_MAP[obj.definitionId] ?? 0.3
        const roofH = wallH * roofFrac
        let maxTH = 0
        if (heightMap) {
          for (let fy = 0; fy < fp.h; fy++) {
            for (let fx = 0; fx < fp.w; fx++) {
              const th = getTerrainHeight(heightMap, obj.x + fx, obj.y + fy)
              if (th > maxTH) maxTH = th
            }
          }
        }
        const baseY = heightMap ? maxTH : (obj.elevation || 0)
        const topY = baseY + wallH + roofH + 0.8
        // Only genuinely tall landmarks — skip any sub-6m "spire" so birds
        // don't orbit low roofs and read as static dots.
        if (topY < 6.0) continue
        spirePositions.push(new THREE.Vector3(
          obj.x + fp.w / 2, topY, obj.y + fp.h / 2,
        ))
      }
    }
    this.initBirds(spirePositions)

    // === ELEVATED WALKWAYS ===
    // Bridges between buildings that span across streets at upper floors
    if (structureLayer && structureLayer.objects.length > 20) {
      this.generateElevatedWalkways(structureLayer.objects, defMap, heightMap, map.gridWidth, map.gridHeight)
    }

    // === STAIRCASES between elevation levels ===
    if (heightMap) {
      this.generateStaircases(heightMap, map.gridWidth, map.gridHeight)
    }

    // Spawn the player at ground level just outside the town center,
    // looking toward the main plaza. First-person eye-height. If the
    // default spawn tile is blocked (rare — dense building cluster near
    // the offset spot), spiral outward to find the nearest free tile so
    // the player doesn't start wedged inside a wall.
    const cx = map.gridWidth / 2, cz = map.gridHeight / 2
    let spawnX = cx - 10, spawnZ = cz - 10
    if (this.collisionMask && this.isBlocked(spawnX, spawnZ)) {
      spiral:
      for (let r = 1; r <= 12; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue // ring only
            const sx = cx - 10 + dx, sz = cz - 10 + dy
            if (!this.isBlocked(sx, sz)) {
              spawnX = sx + 0.5; spawnZ = sz + 0.5
              break spiral
            }
          }
        }
      }
    } else {
      // Nudge to tile center so the player starts centered on a tile.
      spawnX += 0.5; spawnZ += 0.5
    }
    const spawnGround = heightMap ? getTerrainHeight(heightMap, spawnX, spawnZ) : 0
    this.camera.position.set(spawnX, spawnGround + EYE_HEIGHT, spawnZ)
    this.cameraYaw = Math.atan2(cz - spawnZ, cx - spawnX)
    this.cameraPitch = -0.05
    this.verticalVel = 0
    this.flyMode = false

    // Shadow-caster flags are now set at mesh-add time (wall meshes cast,
    // batched roof/ornament meshes don't). This traverse is kept as a
    // receive-only pass for anything that slipped through.
    this.buildingGroup.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) child.receiveShadow = true
    })
    this.terrainGroup.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) child.receiveShadow = true
    })
    this.propGroup.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) child.receiveShadow = true
    })

    // Patch every material's fog to accumulate near ground level.
    // Sky dome and sun disc are skipped (fog:false / outside these groups).
    const patched = new Set<THREE.Material>()
    const patchMesh = (child: THREE.Object3D) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of mats) {
        if (!mat || patched.has(mat)) continue
        patched.add(mat)
        patchHeightFog(mat)
      }
    }
    this.terrainGroup.traverse(patchMesh)
    this.buildingGroup.traverse(patchMesh)
    this.propGroup.traverse(patchMesh)

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

  /** Size and aim the sun's shadow camera to cover the town tightly. */
  private updateShadowCamera(): void {
    const cam = this.sunLight.shadow.camera as THREE.OrthographicCamera
    const r = this.townRadius
    cam.left = -r
    cam.right = r
    cam.top = r
    cam.bottom = -r
    cam.updateProjectionMatrix()
  }

  /** Generate elevated walkways/bridges between close buildings */
  private generateElevatedWalkways(
    objects: import('../core/types').PlacedObject[],
    defMap: Map<string, ObjectDefinition>,
    heightMap: number[][] | null,
    gridW: number, gridH: number
  ): void {
    const walkwayMat = new THREE.MeshLambertMaterial({ color: 0x8a7a68, flatShading: true })
    const railMat = new THREE.MeshLambertMaterial({ color: 0x5a4a3a, flatShading: true })
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
        const archMat = new THREE.MeshLambertMaterial({ color: 0x706058, flatShading: true })
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
    const stepMat = new THREE.MeshLambertMaterial({ color: 0x808078, flatShading: true })
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
    // Shadow gating: at deep night the sun is below horizon, shadows are
    // invisible anyway, so skip the shadow pass entirely. Saves a full
    // 512² render + sort per frame.
    if (this.renderer) {
      const sunBelowHorizon = timeOfDay < 5.5 || timeOfDay >= 19.5
      this.renderer.shadowMap.enabled = !sunBelowHorizon
    }

    // Sun angle based on time (0=midnight, 12=noon)
    const sunAngle = ((timeOfDay - 6) / 12) * Math.PI // 0 at 6am, PI at 6pm
    const sunY = Math.sin(sunAngle) * 50
    const sunX = Math.cos(sunAngle) * 40 + this.townCenterX
    const sunZ = this.townCenterZ + 10

    if (isNight) {
      this.sunLight.intensity = 0.15
      this.sunLight.color.setHex(0x4466aa)
      this.sunLight.position.set(this.townCenterX, 40, sunZ) // moonlight from above
      this.ambientLight.intensity = 0.35
      this.ambientLight.color.setHex(0x2a3858)
      this.scene.fog = new THREE.FogExp2(0x101830, 0.008)
      if (this.skyUniforms) {
        this.skyUniforms.uZenith.value.setHex(0x0a0e2a)
        this.skyUniforms.uHorizon.value.setHex(0x101830)
        this.skyUniforms.uCloudColor.value.setHex(0x303a52)
        this.skyUniforms.uCloud.value = 0.4
        // Distant mountains read as nearly black at night.
        this.skyUniforms.uMountainColor.value.setHex(0x05080f)
        this.skyUniforms.uMountain.value = 1.0
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
      this.scene.fog = new THREE.FogExp2(0xffaa88, 0.004)
      if (this.skyUniforms) {
        this.skyUniforms.uZenith.value.setHex(0xcc6633)
        this.skyUniforms.uHorizon.value.setHex(0xffaa88)
        this.skyUniforms.uCloudColor.value.setHex(0xffd0a0)
        this.skyUniforms.uCloud.value = 0.55
        // Mountains silhouette — warm-grey against the orange horizon.
        this.skyUniforms.uMountainColor.value.setHex(0x4a3530)
        this.skyUniforms.uMountain.value = 1.0
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
      this.scene.fog = new THREE.FogExp2(0xe8d8c8, 0.004)
      if (this.skyUniforms) {
        this.skyUniforms.uZenith.value.setHex(0x5588bb)
        this.skyUniforms.uHorizon.value.setHex(0xe8d8c8)
        this.skyUniforms.uCloudColor.value.setHex(0xfff0d8)
        this.skyUniforms.uCloud.value = 0.35
        this.skyUniforms.uMountainColor.value.setHex(0x6a6258)
        this.skyUniforms.uMountain.value = 1.0
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
      this.scene.fog = new THREE.FogExp2(0xd0e0f0, 0.004)
      if (this.skyUniforms) {
        this.skyUniforms.uZenith.value.setHex(0x4488cc)
        this.skyUniforms.uHorizon.value.setHex(0xd0e0f0)
        this.skyUniforms.uCloudColor.value.setHex(0xffffff)
        this.skyUniforms.uCloud.value = 0.25
        // Daylight distant mountains — slightly hazy bluish.
        this.skyUniforms.uMountainColor.value.setHex(0x8090a0)
        this.skyUniforms.uMountain.value = 1.0
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
    this.updateShadowCamera()

    // Bloom + window emissive: together they produce the Traverse Town
    // "warm pools of lamp/window light in a cool night" effect.
    let windowGlow = 0
    if (this.bloomPass) {
      if (isNight) {
        this.bloomPass.strength = 1.4
        this.bloomPass.radius = 0.7
        this.bloomPass.threshold = 0.35
        windowGlow = 1.4
      } else if (isDusk || isDawn) {
        this.bloomPass.strength = 0.9
        this.bloomPass.radius = 0.6
        this.bloomPass.threshold = 0.55
        windowGlow = 0.9
      } else if (isGolden) {
        this.bloomPass.strength = 0.4
        this.bloomPass.radius = 0.5
        this.bloomPass.threshold = 0.85
        windowGlow = 0.35
      } else {
        this.bloomPass.strength = 0.12
        this.bloomPass.radius = 0.4
        this.bloomPass.threshold = 0.98
        windowGlow = 0
      }
    }
    // Composer gating: at true noon/midday (not golden, not dusk, not
    // dawn), bloom is nearly invisible but the gaussian passes still run.
    // Skip the whole composer chain and render direct — meaningful perf
    // win on low-end machines where bloom is the frame-time hotspot.
    this._useComposer = !(timeOfDay >= 8 && timeOfDay < 15)
    setWallEmissiveIntensity(windowGlow)
    // Hanging lanterns: always a bit brighter than windows (they're supposed
    // to be the primary overhead light source at dusk) but still ramp with
    // time of day. Multiplier picked so the lantern-bulb color clips into
    // the bloom threshold at night → warm halos over the street.
    setLanternEmissiveIntensity(windowGlow * 1.4 + (windowGlow > 0 ? 0.2 : 0))
    // Volumetric pool cones under lampposts: invisible at noon, subtle at
    // golden hour, prominent at dusk/night. Additive blending means pools
    // overlap constructively so dense lamp clusters brighten each other.
    // Sprite-based soft pool: can push brighter without silhouette showing
    // because the radial alpha fades to zero at the edge. Cap at 0.55 so
    // overlapping pools in dense districts still read as discrete glows,
    // not a flood-light wash.
    const poolOpacity = windowGlow <= 0 ? 0 : Math.min(0.55, 0.15 + windowGlow * 0.4)
    setLampPoolOpacity(poolOpacity)

    // Smoke particles: bright grey at day reads fine, but at night they
    // glow unnaturally white. Tint toward a dim ember color after dusk.
    for (const ps of this.particleSystems) {
      if (ps.type !== 'smoke') continue
      const mat = ps.points.material as THREE.PointsMaterial
      if (isNight) { mat.color.setHex(0x504a52); mat.opacity = 0.22 }
      else if (isDusk || isDawn) { mat.color.setHex(0x9a8878); mat.opacity = 0.3 }
      else { mat.color.setHex(0xbbbbbb); mat.opacity = 0.35 }
    }
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

  /** Birds circling tall spires — 4 per spire, capped at 8 spires (32 birds
   *  max). Each bird carries its orbit parameters in the velocities slot
   *  (see ParticleSystem comment). Position is derived from orbit params +
   *  time each frame; no forces accumulate, no respawning. Fades with the
   *  dusk/night lighting alongside fireflies. */
  private initBirds(spirePositions: THREE.Vector3[]): void {
    if (spirePositions.length === 0) return
    // Cap total birds to ~16 so they feel like scattered dusk punctuation,
    // not a flock. 5 spires × 3 birds = 15 max.
    const spires = spirePositions.slice(0, 5)
    const perSpire = 3
    const count = spires.length * perSpire
    const positions = new Float32Array(count * 3)
    const velocities = new Float32Array(count * 3)
    const lifetimes = new Float32Array(count)
    const origins = new Float32Array(count * 3)

    for (let s = 0; s < spires.length; s++) {
      const sp = spires[s]
      for (let k = 0; k < perSpire; k++) {
        const i = s * perSpire + k
        const i3 = i * 3
        origins[i3] = sp.x
        origins[i3 + 1] = sp.y + (k - 1.5) * 0.6  // stagger bird altitude
        origins[i3 + 2] = sp.z
        // Radius 1.5..3.0, speed 0.35..0.7 rad/s, phase 0..2π.
        velocities[i3] = 1.5 + Math.random() * 1.5
        velocities[i3 + 1] = 0.35 + Math.random() * 0.35
        velocities[i3 + 2] = Math.random() * Math.PI * 2
        positions[i3] = sp.x + velocities[i3]
        positions[i3 + 1] = origins[i3 + 1]
        positions[i3 + 2] = sp.z
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color: 0x202020, size: 0.22, transparent: true, opacity: 0.75,
      sizeAttenuation: true, depthWrite: false,
    })
    const points = new THREE.Points(geo, mat)
    this.particleGroup.add(points)
    this.particleSystems.push({
      points, positions, velocities, lifetimes, origins, count, type: 'bird',
    })
  }

  /** Animate all particle systems */
  private updateParticles(dt: number, time = 0): void {
    // Global low-frequency wind vector — same for all smoke particles this
    // frame, but it drifts over time so smoke columns lean in changing
    // directions. Two sine components of different frequencies give a
    // non-repeating natural wobble.
    const windX = Math.sin(time * 0.32) * 0.18 + Math.sin(time * 0.91 + 1.3) * 0.06
    const windZ = Math.cos(time * 0.41) * 0.14 + Math.sin(time * 1.07 + 0.7) * 0.05

    for (const ps of this.particleSystems) {
      const pos = ps.positions
      const vel = ps.velocities
      const life = ps.lifetimes
      const orig = ps.origins

      // Birds: orbit a fixed spire center. velocities = (radius, speed, phase).
      // Position is recomputed from scratch each frame, no force accumulation.
      if (ps.type === 'bird') {
        for (let i = 0; i < ps.count; i++) {
          const i3 = i * 3
          const r = vel[i3], w = vel[i3 + 1], phase = vel[i3 + 2]
          const a = time * w + phase
          pos[i3] = orig[i3] + Math.cos(a) * r
          pos[i3 + 2] = orig[i3 + 2] + Math.sin(a) * r
          pos[i3 + 1] = orig[i3 + 1] + Math.sin(a * 1.7 + phase) * 0.3
        }
        const attr = ps.points.geometry.getAttribute('position') as THREE.BufferAttribute
        attr.needsUpdate = true
        // Birds fade at deep night — they roost. Fully visible at dusk.
        const isNight = this.currentTimeOfDay < 5 || this.currentTimeOfDay >= 20
        const isDusk = this.currentTimeOfDay >= 17 && this.currentTimeOfDay < 20
        ;(ps.points.material as THREE.PointsMaterial).opacity =
          isNight ? 0.0 : isDusk ? 0.55 : 0.0
        continue
      }

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
          // Smoke: apply shared wind acceleration so columns lean + drift
          // with a changing wind, and longer-lived particles catch more of
          // it (accumulating velocity as they rise).
          if (ps.type === 'smoke') {
            vel[i3] += windX * dt
            vel[i3 + 2] += windZ * dt
            // Lateral damping so the wind doesn't add up unboundedly.
            vel[i3] *= 0.985
            vel[i3 + 2] *= 0.985
          }

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
    const loop = () => {
      if (this.disposed) return
      this.animId = requestAnimationFrame(loop)
      // Reset renderer stats at the start of each frame so accumulated
      // counts reflect THIS frame only. autoReset was disabled at init so
      // the composer's final OutputPass doesn't clobber what we read.
      if (this.renderer) this.renderer.info.reset()
      const frameStart = performance.now()
      const dt = Math.min(this.clock.getDelta(), 0.1)
      const t = this.clock.elapsedTime
      this.updateCamera(dt)
      this.updateParticles(dt, t)
      tickWallEmissive(t)
      tickLanternEmissive(t)
      tickWater(t)
      if (this.skyMesh) this.skyMesh.position.copy(this.camera.position)
      const updateEnd = performance.now()
      if (this.composer && this._useComposer) this.composer.render()
      else this.renderer?.render(this.scene, this.camera)
      const renderEnd = performance.now()
      // Snapshot stats once per frame. These are correct because the
      // composer has run everything by now; only the final OutputPass
      // blanks the counts (which is a single draw call added on top).
      if (this.renderer) {
        const info = this.renderer.info
        this._frameStats.drawCalls = info.render.calls
        this._frameStats.triangles = info.render.triangles
        this._frameStats.lines = info.render.lines
        this._frameStats.points = info.render.points
      }
      this._frameStats.frameMs = renderEnd - frameStart
      this._frameStats.updateMs = updateEnd - frameStart
      this._frameStats.renderMs = renderEnd - updateEnd
      // FPS counter — use real wall-clock time, not the clamped dt. The
      // previous impl accumulated dt (capped at 0.1s per frame), so at
      // 2 actual FPS it still reported ~10 FPS because each frame only
      // credited 0.1s of elapsed time. performance.now() tells the truth.
      this._fpsFrames++
      if (this._fpsWallStart === 0) this._fpsWallStart = frameStart
      if (frameStart - this._fpsWallStart >= 1000) {
        this._fps = Math.round((this._fpsFrames * 1000) / (frameStart - this._fpsWallStart))
        this._fpsFrames = 0
        this._fpsWallStart = frameStart
        this._drawCalls = this._frameStats.drawCalls
      }
    }
    this.animId = requestAnimationFrame(loop)
  }

  private sampleGroundY(x: number, z: number): number {
    if (!this.terrainHeightMap) return 0
    // getTerrainHeight now floors internally, but doing it here too makes
    // the contract explicit and saves a redundant bounds check in the
    // common case where the camera is far inside the map.
    return getTerrainHeight(this.terrainHeightMap, Math.floor(x), Math.floor(z))
  }

  /**
   * Returns true if the tile at world XZ is blocked for walking. Reads
   * the collision mask built in loadMap. Out-of-bounds counts as blocked
   * so the player can't walk off the map. When no mask exists (no map
   * loaded yet) nothing is blocked — caller handles that case.
   */
  private isBlocked(x: number, z: number): boolean {
    if (!this.collisionMask) return false
    const ix = Math.floor(x), iz = Math.floor(z)
    if (ix < 0 || ix >= this.gridW || iz < 0 || iz >= this.gridH) return true
    return this.collisionMask[iz * this.gridW + ix] !== 0
  }

  private updateCamera(dt: number): void {
    // Horizontal movement uses yaw only — Minecraft/FPS convention,
    // looking up while walking doesn't launch you into the sky.
    const fwdX = Math.cos(this.cameraYaw)
    const fwdZ = Math.sin(this.cameraYaw)
    const rightX = -fwdZ
    const rightZ = fwdX
    const moveSpeed = (this.flyMode ? FLY_SPEED : WALK_SPEED) * dt

    let dx = 0, dz = 0
    if (this.keysHeld.has('KeyW')) { dx += fwdX; dz += fwdZ }
    if (this.keysHeld.has('KeyS')) { dx -= fwdX; dz -= fwdZ }
    if (this.keysHeld.has('KeyA')) { dx -= rightX; dz -= rightZ }
    if (this.keysHeld.has('KeyD')) { dx += rightX; dz += rightZ }
    // Normalize diagonal movement so strafing isn't faster.
    const mag = Math.hypot(dx, dz)
    if (mag > 0) {
      const stepX = (dx / mag) * moveSpeed
      const stepZ = (dz / mag) * moveSpeed
      // Fly mode and "no map loaded" bypass collision — walk-mode does
      // a 3-try axis-slide: full move → X-only → Z-only → stay put.
      // Probe ~0.3 units ahead along each axis so we stop just before the
      // wall instead of clipping into it before the slide kicks in.
      if (this.flyMode || !this.collisionMask) {
        this.camera.position.x += stepX
        this.camera.position.z += stepZ
      } else {
        const EPS = 0.3
        const px = this.camera.position.x
        const pz = this.camera.position.z
        const lookX = px + stepX + Math.sign(stepX) * EPS
        const lookZ = pz + stepZ + Math.sign(stepZ) * EPS
        if (!this.isBlocked(lookX, lookZ)) {
          this.camera.position.x = px + stepX
          this.camera.position.z = pz + stepZ
        } else if (!this.isBlocked(lookX, pz)) {
          this.camera.position.x = px + stepX
        } else if (!this.isBlocked(px, lookZ)) {
          this.camera.position.z = pz + stepZ
        }
        // else: fully blocked, stay in place
      }
    }

    if (this.flyMode) {
      // Hold Space to rise, ShiftLeft to descend. Velocity is immediate
      // (no gravity) — standard Minecraft creative flight.
      if (this.keysHeld.has('Space')) this.camera.position.y += FLY_SPEED * dt
      if (this.keysHeld.has('ShiftLeft')) this.camera.position.y -= FLY_SPEED * dt
    } else {
      // Gravity + ground collision.
      this.verticalVel -= GRAVITY * dt
      // Terminal velocity clamp — stops runaway fall if ground sampling
      // ever returns NaN.
      if (this.verticalVel < -50) this.verticalVel = -50
      this.camera.position.y += this.verticalVel * dt
      const groundY = this.sampleGroundY(this.camera.position.x, this.camera.position.z) + EYE_HEIGHT
      if (isFinite(groundY) && this.camera.position.y <= groundY) {
        this.camera.position.y = groundY
        this.verticalVel = 0
      } else if (!isFinite(this.camera.position.y) || this.camera.position.y < -200) {
        // Safety net: if position ever diverges (NaN or deep fall), snap
        // back to the spawn plane so the player isn't stranded in the void.
        this.camera.position.y = EYE_HEIGHT
        this.verticalVel = 0
      }
    }

    // Aim direction — full yaw + pitch for free look.
    this._fwd.set(
      Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch),
      Math.sin(this.cameraPitch),
      Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch),
    ).normalize()
    this._target.copy(this.camera.position).add(this._fwd)
    this.camera.lookAt(this._target)
  }

  /** Capture a screenshot of the current 3D view as a data URL */
  captureScreenshot(): string {
    if (!this.renderer) return ''
    if (this.composer && this._useComposer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
    return this.renderer.domElement.toDataURL('image/png')
  }

  /** Runtime diagnostics for the debug dump. Records the FPS camera's
   *  current state, the renderer's draw-call / triangle counts, the
   *  particle system sizes, and the current time-of-day.
   *  Lightweight — all reads, no allocations in tight loops. */
  getDebugInfo(): Record<string, unknown> {
    const info = this.renderer?.info
    const cam = this.camera
    const particles: Record<string, number> = {}
    for (const ps of this.particleSystems) {
      particles[ps.type] = (particles[ps.type] ?? 0) + ps.count
    }
    return {
      fps: this._fps,
      timeOfDay: this.currentTimeOfDay,
      camera: {
        position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
        yaw: this.cameraYaw,
        pitch: this.cameraPitch,
        flyMode: this.flyMode,
        fov: cam.fov,
      },
      render: {
        // Snapshotted in the rAF loop BEFORE the composer's final
        // OutputPass overwrites renderer.info.render. The raw live
        // counts (info.render.*) are unreliable for diagnosis.
        drawCalls: this._frameStats.drawCalls,
        triangles: this._frameStats.triangles,
        lines: this._frameStats.lines,
        points: this._frameStats.points,
        geometries: info?.memory.geometries ?? -1,
        textures: info?.memory.textures ?? -1,
      },
      frameMs: {
        total: this._frameStats.frameMs.toFixed(2),
        update: this._frameStats.updateMs.toFixed(2),
        render: this._frameStats.renderMs.toFixed(2),
      },
      renderSettings: {
        shadowMapSize: this.sunLight.shadow.mapSize.x,
        shadowMapType: this.renderer?.shadowMap.type,
        shadowsEnabled: this.renderer?.shadowMap.enabled ?? false,
        bloomStrength: this.bloomPass?.strength ?? 0,
        bloomThreshold: this.bloomPass?.threshold ?? 0,
        composerEnabled: !!this.composer,
      },
      particles,
      scene: {
        buildingCount: this.buildingGroup.children.length,
        propCount: this.propGroup.children.length,
        terrainCount: this.terrainGroup.children.length,
      },
      pointerLocked: this.pointerLocked,
      collisionMaskSize: this.collisionMask?.length ?? 0,
    }
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.animId)

    // Remove all event listeners
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown)
    if (this._onKeyUp) window.removeEventListener('keyup', this._onKeyUp)
    if (this._onMouseMove) document.removeEventListener('mousemove', this._onMouseMove)
    if (this._onPointerLockChange) document.removeEventListener('pointerlockchange', this._onPointerLockChange)
    if (document.pointerLockElement) document.exitPointerLock()
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
    this.collisionMask = null
    this.terrainHeightMap = null
    this.composer?.dispose()
    this.bloomPass?.dispose()
    this.composer = null
    this.bloomPass = null
    this.renderer?.dispose()
    if (this.renderer?.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement)
    }
    this.renderer = null
    this.scene.clear()
  }
}
