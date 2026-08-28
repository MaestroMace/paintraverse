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
import { footprintOf, stableHash } from '../core/types'
import { isSoftGround } from '../core/terrain'
import type { BuildingPalette } from '../inspiration/StyleMapper'
import { buildTerrainMesh, getTerrainHeight, groundYAtWorld, tickWater, setWaterSky, TERRAIN_WORLD_SCALE } from './TerrainMesh'
import { TILE, STOREY_HEIGHT } from './scale'

// First-person walkaround constants. Minecraft-ish feel.
const EYE_HEIGHT = 1.6
const JUMP_STRENGTH = 7.0
const GRAVITY = 22.0
const WALK_SPEED = 6.0
// Flying is for surveying, and the town is now ~144m across rather than ~48
// world units, so the old 10 made every debug fly-through a slow pan.
const FLY_SPEED = 24.0

/** How far from the player the sun's shadow map covers, in metres. Also sizes
 *  the shadow normalBias — the two have to agree or the map either self-shadows
 *  or peter-pans.
 *
 *  Every caster inside this frustum is a draw call in the shadow pass, so the
 *  radius is a direct frame-time lever and the phone is the machine that cares.
 *  30m is ten tiles around the player: the street you are standing in plus the
 *  buildings down both sides of it. It was 18 when a tile was a metre — six
 *  tiles once it was not, which had quietly shrunk the shadowed area to the
 *  ground immediately under your feet. */
const SHADOW_RADIUS = 30

/** Player's horizontal half-width, in metres. Used by isBlocked so the player
 *  is a disc rather than the dimensionless point it used to be. */
const PLAYER_RADIUS = 0.35
const DOUBLE_TAP_MS = 300
const MOUSE_YAW_SENS = 0.0025
const MOUSE_PITCH_SENS = 0.002
import { buildBuildingMeshes, setWallEmissiveIntensity, getBuildingDiagnostics, volumeBoxes, facadeParts, type BuildingBatchResult, type BuildingTop, FLOOR_HEIGHT } from './BuildingFactory'
import { tickWallEmissive } from './architecture/VolumeRenderer'
import { buildLanternStrings, buildWallLanterns, buildWindowSpill, setLanternEmissiveIntensity, setWindowSpillOpacity, tickLanternEmissive, tickHangingSway, lampAnchors, resetLampAnchors, type LampAnchor } from './LanternStrings'
import { buildPropMeshes, setLampPoolOpacity, LAMP_POOL_TEX, propSizes, propInstances, type PropBatchResult } from './PropFactory'
import { resetBeacons } from './Beacons'
import { starIntensityFor, starThresholdFor, moonPhaseDir, weatherAir } from './Materials'

/**
 * Patch a material's fog to fade in more strongly near ground level, so
 * mist appears to pool in valleys and plazas while ridges and roofs stay
 * clear. Uses Three.js onBeforeCompile shader injection. Idempotent.
 */
function patchHeightFog(material: THREE.Material): void {
  const m = material as THREE.Material & { __heightFogPatched?: boolean }
  if (m.__heightFogPatched) return
  m.__heightFogPatched = true
  // CAPTURE THE PREVIOUS HOOK'S IDENTITY BEFORE REPLACING IT — see the cache
  // key at the bottom of this function for why that matters.
  const prevSrc = material.onBeforeCompile ? String(material.onBeforeCompile) : ''
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
  /**
   * A CONSTANT CACHE KEY COLLAPSES EVERY MATERIAL THAT SHARES IT ONTO ONE
   * COMPILED PROGRAM, AND SILENTLY DISCARDS EVERY OTHER SHADER INJECTION.
   *
   * This returned the literal `'heightFog'`. three.js uses the key to decide
   * whether two materials can reuse a program, so two Lambert materials with
   * the same parameters and DIFFERENT `onBeforeCompile` source both hashed to
   * `'heightFog'` and the second one rendered with the first one's shader.
   *
   * Found by adding a sway displacement to the hanging meshes and measuring
   * exactly ZERO movement — at a 2.5m amplitude, which is the tell that a
   * mechanism is not running rather than that it is too small to see. The
   * markers said the hook had been assigned and the wrapper had chained it;
   * the program had simply been compiled already, from `_lanternMat`'s
   * unswayed twin on the wall lanterns.
   *
   * That is the ghost failure with a type signature, one level down from the
   * three this repo already records — `BatchedMeshBuilder.toneFloor`, the
   * water fragment assigning `gl_FragColor.a`, and `addPositionedNoised`
   * ignoring its own field. **Anything injected into a shader on a
   * height-fogged material was being thrown away**, and nothing would have
   * errored; the next person to reach for `onBeforeCompile` here would have
   * lost the same hour.
   *
   * Keyed on the injection that was already there, so materials whose
   * generated source is identical still share a program and ones that differ
   * do not.
   */
  material.customProgramCacheKey = () => `heightFog|${prevSrc}`
  material.needsUpdate = true
}

const NO_JITTER_MAP = new Set<string>([
  'archway', 'town_gate', 'gatehouse', 'staircase', 'aqueduct',
])
/**
 * Types whose whole function is FIRE, so they always smoke.
 *
 * Every other chimney rolls a ~40% die. These do not: a cold kiln is a brick
 * cone, a smokehouse that is not smoking is a shed with a vent on it, and a
 * cookshop with no fire is a room. The cookshop's stack is the tallest thing
 * on the building and exists for exactly this.
 *
 * A Set rather than two `!==` comparisons because that is what it was, and a
 * list of literal ids is a pattern that will need sweeping the next time a
 * type is added — this repo has paid for that lesson on the shop-sign gate,
 * the stoop bench and the trade-building test.
 */
const ALWAYS_SMOKING = new Set<string>([
  'smokehouse', 'kiln', 'cookshop', 'bakery',
])
/**
 * How many of the 16 particle chimneys the always-smoking types may take.
 *
 * The budget is a hard 16 and whatever fills it first wins, which was fine
 * while the priority list was two rare types. It is four now — roughly 8
 * smokehouses, 9 cookshops, 4 bakeries and 2 kilns in a town, which is 23
 * against 16, and without a reservation NO ORDINARY HOUSE WOULD EVER SMOKE
 * again. That is the failure mode the comment beside the collector already
 * warns about: silent, because the feature simply stops appearing.
 *
 * A cap expressed against a quantity you just changed is the bug this repo
 * keeps recording; this one is expressed against the budget it shares.
 *
 * TEN WAS TOO MANY AND `particles.mjs` SAID SO. The always-smoking types are
 * CLUSTERED by construction — cookshops in the market, smokehouses on the
 * waterfront, kilns in the artisan quarter — while ordinary chimneys are
 * spread over the whole town. Giving the priority group ten of sixteen took
 * the smoke's x-extent from 64% of the town's to 30%: all the smoke in two
 * quarters and none anywhere else, which reads as a fire rather than as a
 * town at supper. Five leaves eleven for the spread.
 *
 * Nothing else in the harness would have caught this. Sixteen instruments
 * grade the static world and `particles.mjs` is the only one that looks at a
 * particle, which is why it exists.
 */
const SMOKE_PRIORITY_SHARE = 5
/** Scratch for the moon's glint colour, so the night branch allocates none. */
const _moonGlint = new THREE.Color()
function rand01(hash: number, salt: number): number {
  const n = (hash * 2654435761 + salt * 1597334677) >>> 0
  return n / 0xffffffff
}

// ROOFS LIFTED, and for a measured reason rather than taste.
//
// tools/eyeball.mjs reads absolute luma by surface. After the skylight fix the
// walls sit at 0.203 and the roofs at 0.087 with a THIRD of every roof pixel
// still effectively black at midday. That is not the light rig — the day/night
// A/B cleared it — and it is not a colour-space bug: bakeVertexColor goes
// through new THREE.Color(hex), which converts sRGB to linear correctly. It is
// simply the palette. 0xe8d8b8 is 0.808 linear and 0x8b4513 is 0.258, a 3.1x
// albedo gap against a 2.3x measured render gap, which is as close as
// orientation lets those two numbers get.
//
// Real tile and slate in daylight are mid tones. These keep their hue and
// their character and stop being silhouettes.
const DEFAULT_BUILDING_PALETTES = [
  { wall: 0xe8d8b8, roof: 0xb0602c, door: 0x5a4030 },  // warm cream + terracotta
  { wall: 0xd8c8a0, roof: 0xa04530, door: 0x4a3020 },  // tan + red tile
  { wall: 0xf0e8d8, roof: 0x8f6a52, door: 0x6a4a30 },  // white stucco + brown tile
  { wall: 0xc0a880, roof: 0x6f7889, door: 0x3a3a42 },  // sandstone + slate
  { wall: 0xb87050, roof: 0x82492f, door: 0x4a3020 },  // red brick
  { wall: 0xd8d0c0, roof: 0x6a9e7c, door: 0x3a5a4a },  // pale + green copper
  { wall: 0xa09888, roof: 0x676a7c, door: 0x3a3a42 },  // grey stone + dark slate
  { wall: 0xe0d0b0, roof: 0xac7856, door: 0x5a4030 },  // buttercream + wood shingle
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
uniform float uStars;
uniform float uStarCut;
uniform float uTime;
varying vec3 vLocalPos;
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
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

  // STARS. The sky had a gradient, three bands of cloud and a mountain
  // silhouette, and nothing above them — so night read as a flat dark dome
  // and dusk as an orange one. DESIGN.md's north star is "can the player
  // stand in this town at dusk and feel like they're somewhere", and the
  // first stars coming out over a warm-lit street is most of that sentence.
  //
  // A hashed point field on an (azimuth, height) grid. It clusters a little
  // toward the zenith, which is what an equirectangular grid does and which
  // nobody will read as wrong on a stylised dome at 40% render scale — and
  // the alternative is a 3D hash costing more than the whole rest of this
  // shader. Weighted OUT near the horizon, because that is where the
  // atmosphere is thickest and where the town's own light pollution is.
  float starField = 0.0;
  if (uStars > 0.001) {
    vec2 cell = vec2(az * 19.0, h * 34.0);
    vec2 id = floor(cell);
    float r = hash21(id);
    // How many cells carry a star. uStarCut comes from the Star Density
    // slider through Materials.starThresholdFor — a control that existed for
    // the whole life of the app and was read by nothing at all. Its default
    // of 0.5 returns the 0.958 that was hardcoded here, so wiring it up
    // changes no existing scene. (No backticks in here: this whole shader is
    // a template literal and one would end it.)
    // Density and point size were tuned against a NIGHT SCREENSHOT, not by
    // taste on paper: RENDER_SCALE is 0.4, so a star narrower than about a
    // fifth of a cell never survives to a pixel. The first pass read as a
    // dozen specks.
    float present = step(uStarCut, r);
    // Sub-cell position, so stars do not sit on a visible lattice.
    vec2 jitter = vec2(hash21(id + 11.0), hash21(id + 27.0));
    float d = length(fract(cell) - jitter);
    float point = 1.0 - smoothstep(0.0, 0.21, d);
    // A SLOW TWINKLE, not a strobe. CLAUDE.md records window flicker at
    // 2.2-4.4 Hz reading as a strobe and being dropped to 0.25-0.7 Hz; a
    // star is slower still, and each one has its own phase and rate so the
    // sky does not pulse as one.
    float phase = r * 43.0;
    float rate = 0.18 + hash21(id + 5.0) * 0.22;
    float twinkle = 0.72 + 0.28 * sin(uTime * rate * 6.2831 + phase);
    // Brighter stars are rarer: the top of the hash range gets the size.
    float mag = 0.45 + 0.55 * smoothstep(uStarCut, 1.0, r);
    starField = present * point * twinkle * mag
              * smoothstep(0.06, 0.42, h);   // fade into the horizon haze
  }
  col += vec3(0.95, 0.96, 1.0) * starField * uStars;

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
/** How wide the precipitation box around the camera is, and how tall. Sized
 *  against the fog: at rain's 2.2x a dusk 0.004 you cannot see 30m, so a
 *  wider box would be allocating particles into grey. */
const PRECIP_BOX = 34
const PRECIP_TOP = 17

interface ParticleSystem {
  points: THREE.Points
  positions: Float32Array
  velocities: Float32Array
  lifetimes: Float32Array
  origins: Float32Array
  count: number
  type: 'smoke' | 'firefly' | 'bird' | 'moth' | 'precip' | 'mist' | 'flock' | 'wisp' | 'ember' | 'rise'
  /**
   * TRUE when the system travels with the player rather than sitting over the
   * town. Rain and snow are everywhere by definition, so they are drawn as a
   * box around the camera that recycles — the standard technique, and the
   * only affordable one. `particles.mjs` grades every system on whether its
   * extent covers the town's, which is exactly the wrong question for this
   * one and would report a correct implementation as a defect, so the flag is
   * declared here and the tool reads it instead of being told a special case.
   */
  cameraLocal?: boolean
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
  /** Real per-building vertical extents from the last build, by object id.
   *  Particle systems read these instead of re-deriving building heights. */
  private _buildingTops = new Map<string, BuildingTop>()
  // Collision mask for walk-mode: 1 byte per tile, non-zero = blocked
  // (building footprint, water, out-of-bounds). Populated in loadMap.
  private collisionMask: Uint8Array | null = null
  /** Per-tile height of any DECK a player may stand on — see sampleGroundY. */
  private walkSurface: Float32Array | null = null
  private gridW = 0
  private gridH = 0

  // Scene objects
  private terrainGroup = new THREE.Group()
  private buildingGroup = new THREE.Group()
  private propGroup = new THREE.Group()
  private particleGroup = new THREE.Group()
  // Touch input state. Split so the walk stick and the look drag are
  // independent fingers — the standard mobile FPS scheme, and the only one
  // that works here since a phone has neither pointer lock nor WASD.
  private _touchMoveX = 0        // -1..1, strafe
  private _touchMoveY = 0        // -1..1, forward is negative (screen up)
  private _touchThrottle = 0     // 0..1 analog magnitude
  private _moveTouchId: number | null = null
  private _lookTouchId: number | null = null
  private _moveOriginX = 0
  private _moveOriginY = 0
  private _lookLastX = 0
  private _lookLastY = 0
  private _onTouchStart?: (e: TouchEvent) => void
  private _onTouchMove?: (e: TouchEvent) => void
  private _onTouchEnd?: (e: TouchEvent) => void

  private sunLight: THREE.DirectionalLight
  private ambientLight: THREE.AmbientLight
  private hemiLight: THREE.HemisphereLight

  // Sky dome
  private skyMesh: THREE.Mesh | null = null
  private skyUniforms: {
    uZenith: { value: THREE.Color };
    uHorizon: { value: THREE.Color };
    uCloudColor: { value: THREE.Color };
    uCloud: { value: number };
    uMountainColor: { value: THREE.Color };
    uMountain: { value: number };
    /** How much of the star field shows — 0 in daylight, 1 at night. */
    uStars: { value: number };
    uStarCut: { value: number };
    /** Seconds, for the twinkle. Ticked in the render loop beside the
     *  window flicker, which is the other thing in this scene that moves
     *  slowly enough to read as alive rather than as a strobe. */
    uTime: { value: number };
  } | null = null
  private sunDisc: THREE.Mesh | null = null
  private discUniforms: {
    uLit: { value: THREE.Color };
    uDark: { value: THREE.Color };
    uPhaseDir: { value: THREE.Vector3 };
    uSun: { value: number };
  } | null = null
  /** The two Celestial sliders. Both existed in the panel and in the store
   *  from the beginning and NOTHING read either of them; see
   *  Materials.starThresholdFor for the census. Defaults match the store's. */
  private _scratchOvercast = new THREE.Color()
  private moonPhase = 0.5
  /** Where the moon actually hangs at night, in world space. ONE source: the
   *  disc is drawn here and the water's glint is aimed here, for the reason
   *  `setWaterSky` exists at all — a river mirroring a moon that is somewhere
   *  else is the two-authors-of-one-thing defect with a nice picture. */
  private _moonPos = new THREE.Vector3()
  private starDensity = 0.5
  /** Five buttons and an intensity slider in the Environment panel, read by
   *  nothing at all until now — see Materials.weatherAir. */
  private weather = 'clear'
  private weatherIntensity = 0

  // Particles
  private particleSystems: ParticleSystem[] = []
  private currentTimeOfDay = 12

  // Reusable vectors (avoid per-frame allocations)
  private _fwd = new THREE.Vector3()
  private _right = new THREE.Vector3()
  private _up = new THREE.Vector3(0, 1, 0)
  private _target = new THREE.Vector3()
  // Scratch vectors reused every frame by the animate loop and updateLighting
  // so we don't allocate-and-GC a Vector3 60× per second in the hot path.
  private _scratchSunDir = new THREE.Vector3()
  private _scratchSunDir2 = new THREE.Vector3()
  /** Last camera XZ when we last updated the shadow camera target. The
   *  shadow target follows the player but we only push it forward when
   *  the player has moved more than ~2m, so the shadow camera doesn't
   *  recompute its world matrix every frame for sub-pixel changes. */
  private _shadowFollowLastX = -9999
  private _shadowFollowLastZ = -9999
  // Fog is mutated in place across time-of-day bands rather than replaced;
  // Three.js is happy to pick up color/density changes on the existing
  // instance, and we stop allocating a FogExp2 per slider tick.
  private _fog = new THREE.FogExp2(0xd0e0f0, 0.004)

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
  private townCenterX = 24 * TILE
  private townCenterZ = 24 * TILE
  private townRadius = 32 * TILE

  // Post-processing
  private composer: EffectComposer | null = null
  private bloomPass: UnrealBloomPass | null = null

  constructor() {
    this.scene = new THREE.Scene()
    this.scene.background = null // sky dome replaces this
    // Shared FogExp2 instance; updateLighting mutates color/density per TOD.
    this.scene.fog = this._fog

    this.camera = new THREE.PerspectiveCamera(70, 1, 0.5, 500)
    this.camera.position.set(20, 8, 20)

    // Sun light — casts shadows on buildings only for dramatic alley silhouettes.
    // Shadow camera bounds are tuned per-map in loadMap via updateShadowCamera().
    this.sunLight = new THREE.DirectionalLight(0xfff4e0, 1.2)
    this.sunLight.position.set(30, 50, 20)
    this.sunLight.castShadow = true
    // 256² shadow map. Down from 512² (which was already down from 1024²).
    // Total pixel count: 65k vs 262k vs 1M. PCF filtering already softens
    // the result so the resolution drop reads as "atmospheric blur" rather
    // than loss of detail. On integrated GPUs the shadow rasterization
    // pass is one of the bigger frame-time contributors; cutting it 4×
    // here (and 16× from the original 1024²) is a clean GPU win.
    this.sunLight.shadow.mapSize.set(512, 512)
    this.sunLight.shadow.bias = -0.0008
    // A 36m frustum across 256 texels is 14cm per texel, and normalBias has to
    // clear roughly that much geometry or the surface shadows itself. 0.04 was
    // under a third of a texel, which is why big sunlit walls picked up acne
    // at dusk — a grazing sun is the worst case for it, and dusk is the whole
    // point of this scene. Sized to the texel, so it stays right if either the
    // radius or the map size moves.
    this.sunLight.shadow.normalBias =
      (2 * SHADOW_RADIUS / this.sunLight.shadow.mapSize.x) * 1.2
    this.sunLight.shadow.camera.near = 1
    this.sunLight.shadow.camera.far = 200
    this.scene.add(this.sunLight)
    this.scene.add(this.sunLight.target)

    this.ambientLight = new THREE.AmbientLight(0x606880, 0.45)
    this.scene.add(this.ambientLight)

    // Skylight. AmbientLight is uniform — it adds the same amount to a wall
    // whether it faces the sky or the ground — so any surface the sun and
    // shadow map miss got one flat value and read as a black slab. A wall in
    // shadow at NOON, under a blue sky, was still pure black; that is what
    // gave it away, since no time-of-day change could account for it.
    // Hemisphere light is orientation-dependent, so it gives those surfaces
    // form back. Colours are set per time-of-day from the same zenith and
    // horizon the sky shader uses, so the bounce always agrees with the sky
    // the scene is actually under. Part of the old ambient was moved into it
    // rather than added on top, to keep overall exposure close.
    this.hemiLight = new THREE.HemisphereLight(0xd0e0f0, 0x5a5240, 0.5)
    this.scene.add(this.hemiLight)

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
      uStars: { value: 0 },
      uStarCut: { value: 0.958 },
      uTime: { value: 0 },
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

    // Sun/moon disc.
    //
    // A MOON IS A SPHERE AND A PHASE IS JUST WHICH PART OF IT IS LIT, so the
    // geometry was already right and only the material was wrong: a flat
    // MeshBasicMaterial paints the whole ball one colour, which is a full
    // moon every night of the year. One dot product against the direction
    // the sun lies in gives the real thing, crescent through gibbous, with
    // no texture and no second occluding disc.
    //
    // The unlit limb blends to the SKY rather than to black, because a new
    // moon is invisible and not a dark ball with a bite out of it.
    // `uSun` collapses the whole term for the daytime sun, which has no
    // phase — one material, two bodies, no second mesh to keep in step.
    const discGeo = new THREE.SphereGeometry(8, 16, 12)
    this.discUniforms = {
      uLit: { value: new THREE.Color(0xffee88) },
      uDark: { value: new THREE.Color(0x39447e) },
      uPhaseDir: { value: new THREE.Vector3(0, -1, 0) },
      uSun: { value: 1 },
    }
    const discMat = new THREE.ShaderMaterial({
      uniforms: this.discUniforms,
      fog: false,
      vertexShader: `
varying vec3 vN;
void main() {
  vN = normalize(normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`,
      fragmentShader: `
uniform vec3 uLit;
uniform vec3 uDark;
uniform vec3 uPhaseDir;
uniform float uSun;
varying vec3 vN;
void main() {
  // A real terminator is sharp; the smoothstep is one segment wide so the
  // 16x12 sphere's faceting does not read as a staircase down the edge.
  float lit = smoothstep(-0.08, 0.08, dot(normalize(vN), normalize(uPhaseDir)));
  gl_FragColor = vec4(mix(uDark, uLit, max(lit, uSun)), 1.0);
}`,
    })
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
    // Manual shadow map update — by default Three.js redraws the shadow
    // map every single frame even when the sun, the buildings, and the
    // camera are all stationary. We turn off auto-update and explicitly
    // mark needsUpdate=true on the events that actually change shadow
    // contents:
    //   - Time-of-day change (sun moves) → set in updateLighting
    //   - Shadow camera target moves >2m → set in render loop
    //   - Initial scene load → set in loadMap
    // While standing still in a fixed-time scene: zero shadow pass work.
    this.renderer.shadowMap.autoUpdate = false
    this.renderer.shadowMap.needsUpdate = true
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    // Roll the highlights off instead of clipping them. With no tone mapping,
    // a surface facing the noon sky takes sun 1.2 + ambient 0.42 + hemisphere
    // 0.40 and everything above 1.0 is thrown away — so midday paving fused
    // into a flat white sheet with the texture washed out of it. This is the
    // same defect the Canvas2D light map had ("clamping is not tone mapping");
    // the 3D path only dodged it while the town was sparse enough not to
    // saturate. Exposure is above 1 because ACES pulls midtones down and dusk,
    // which is the look this scene is tuned for, is nearly all midtones.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.15
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

    // === TOUCH ===
    // A phone has no pointer lock and no keyboard, so the walkaround was
    // simply unreachable there. Left half of the screen is a virtual stick
    // (drag from wherever the thumb lands — a fixed on-screen pad is worse,
    // because the thumb cannot see itself); right half drags the camera.
    // Tracked by identifier so the two work simultaneously.
    const STICK_RADIUS = 90       // px to reach full throttle
    const STICK_DEADZONE = 8      // px of slop before movement starts
    const TOUCH_LOOK_SENS = 0.005

    this._onTouchStart = (e: TouchEvent) => {
      const rect = canvas.getBoundingClientRect()
      for (const t of Array.from(e.changedTouches)) {
        const localX = t.clientX - rect.left
        if (localX < rect.width * 0.5) {
          if (this._moveTouchId !== null) continue
          this._moveTouchId = t.identifier
          this._moveOriginX = t.clientX
          this._moveOriginY = t.clientY
        } else {
          if (this._lookTouchId !== null) continue
          this._lookTouchId = t.identifier
          this._lookLastX = t.clientX
          this._lookLastY = t.clientY
        }
      }
      // Stop the browser treating this as a scroll/zoom gesture on the page.
      if (e.cancelable) e.preventDefault()
    }

    this._onTouchMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this._moveTouchId) {
          const ox = t.clientX - this._moveOriginX
          const oy = t.clientY - this._moveOriginY
          const dist = Math.hypot(ox, oy)
          if (dist < STICK_DEADZONE) {
            this._touchMoveX = 0; this._touchMoveY = 0; this._touchThrottle = 0
          } else {
            const clamped = Math.min(dist, STICK_RADIUS)
            this._touchMoveX = ox / dist
            this._touchMoveY = oy / dist
            this._touchThrottle = clamped / STICK_RADIUS
          }
        } else if (t.identifier === this._lookTouchId) {
          this.cameraYaw += (t.clientX - this._lookLastX) * TOUCH_LOOK_SENS
          this.cameraPitch = Math.max(
            -Math.PI / 2 + 0.01,
            Math.min(Math.PI / 2 - 0.01,
              this.cameraPitch - (t.clientY - this._lookLastY) * TOUCH_LOOK_SENS),
          )
          this._lookLastX = t.clientX
          this._lookLastY = t.clientY
        }
      }
      if (e.cancelable) e.preventDefault()
    }

    this._onTouchEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this._moveTouchId) {
          this._moveTouchId = null
          this._touchMoveX = 0; this._touchMoveY = 0; this._touchThrottle = 0
        } else if (t.identifier === this._lookTouchId) {
          this._lookTouchId = null
        }
      }
    }

    // passive:false because these calls preventDefault — without it the
    // browser ignores it and the whole page pans while you try to walk.
    canvas.addEventListener('touchstart', this._onTouchStart, { passive: false })
    canvas.addEventListener('touchmove', this._onTouchMove, { passive: false })
    canvas.addEventListener('touchend', this._onTouchEnd)
    canvas.addEventListener('touchcancel', this._onTouchEnd)

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
    // AT THE TOP OF THE THING BEING REBUILT. Three separate producers push
    // into `lampAnchors` — the lamppost prop, the wall bracket and the rope
    // lantern — and clearing it inside any one of them would wipe whatever
    // the earlier two had recorded. That is the placeStats trap: a reset in
    // the middle of a pipeline erases the first half of it.
    resetLampAnchors()
    // Cleared for the same reason lamp anchors are: a stale global is worse
    // than a missing one, and this array is filled by the BUILDING pass and
    // drained by the PROP pass, so a load that skipped either would otherwise
    // light last town's towers in this one.
    resetBeacons()

    const palettes = buildingPalettes || DEFAULT_BUILDING_PALETTES
    const defMap = new Map(objectDefs.map(d => [d.id, d]))

    // Track town extents for shadow camera sizing
    // World units — these aim the sun rig and the shadow camera, both of
    // which live in world space, not tile space.
    this.townCenterX = (map.gridWidth / 2) * TILE
    this.townCenterZ = (map.gridHeight / 2) * TILE
    this.townRadius = Math.max(16, Math.max(map.gridWidth, map.gridHeight) * 0.7 * TILE)

    // Terrain (with height map from seed)
    const seed = map.generationConfig?.seed ?? 0
    const terrainLayer = map.layers.find(l => l.type === 'terrain')
    let heightMap: number[][] | null = null
    if (terrainLayer?.terrainTiles) {
      const terrainGroup = buildTerrainMesh(
        terrainLayer.terrainTiles, map.gridWidth, map.gridHeight, seed,
        terrainLayer.heightMap ?? null, terrainLayer.waterLevel ?? null)
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
      // The RESERVED rectangle, not the definition's — collision is exactly
      // the place where reading the wrong one lets the player walk into a wall.
      const fp = footprintOf(obj, def)
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

    // === CROSSINGS CLEAR THE MASK, and until now nothing did. ===
    //
    // Reported: the rivers are "like a painted floor I can't walk on". The
    // second half of that is literal. A bridge is a structure-layer object, so
    // the loop above SET its tiles blocked exactly like a building, and the
    // water under it is blocked too — so a bridge has never been walkable in
    // this project. There has never been a crossing anywhere, on any seed.
    //
    // The `passage` tag has been on the bridge definition the whole time and
    // nothing had ever read it. Anything tagged `passage` is a way THROUGH:
    // it clears both its own footprint and the water beneath it. Done last so
    // it wins over both earlier passes regardless of object order.
    for (const obj of structLayerForMask?.objects ?? []) {
      const def = defMap.get(obj.definitionId)
      if (!def?.tags?.includes('passage')) continue
      const fp = footprintOf(obj, def)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const bx = obj.x + dx, by = obj.y + dy
          if (bx >= 0 && bx < this.gridW && by >= 0 && by < this.gridH) {
            mask[by * this.gridW + bx] = 0
          }
        }
      }
    }
    this.collisionMask = mask

    // Height lookup function for factories (bakes terrain height into geometry)
    const hLookup = heightMap
      ? (x: number, z: number) => getTerrainHeight(heightMap!, x, z)
      : undefined

    // Buildings — batched: walls individual, roofs/details merged.
    // Wrap in try/catch so a thrown exception during building emission
    // (e.g. a malformed geometry, a math error, etc.) doesn't take the
    // whole 3D scene init down with it. The per-building loop inside
    // buildBuildingMeshes already swallows per-building errors; this
    // catches anything that happens BEFORE/AFTER the loop or anything
    // in the merge / coalesce step.
    const structureLayer = map.layers.find(l => l.type === 'structure')
    const chimneyPositions: THREE.Vector3[] = []
    // THE HOT ONES, KEPT SEPARATELY. `ALWAYS_SMOKING` already names the types
    // whose whole FUNCTION is combustion, and a forge or a kiln throws sparks
    // where a parlour hearth does not. Collected here rather than sliced off
    // the front of `chimneyPositions` afterwards, because that ordering is an
    // implicit contract the farthest-point pass below could quietly break.
    const hotChimneys: THREE.Vector3[] = []
    if (structureLayer) {
      let result: BuildingBatchResult
      try {
        result = buildBuildingMeshes(structureLayer.objects, defMap, palettes, hLookup)
      } catch (err) {
        const e = err as { message?: string; stack?: string }
        console.error(`[ThreeRenderer] buildBuildingMeshes threw: ${e?.message || err}`, e?.stack)
        result = { wallMeshes: [], batched: [], tops: [] }
      }
      for (const m of result.wallMeshes) {
        // castShadow was decided per-volume (short buildings opt out to
        // trim the shadow pass); don't clobber it here. receiveShadow is
        // safe to set universally — receiving is cheap per-fragment.
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

      // === THE FLOOR THE PLAYER GETS, AND THE ONE THEY DO NOT ===
      //
      // Two passes over the built volumes, both of which need geometry that
      // does not exist until buildBuildingMeshes has run — which is why the
      // collision mask above could not do either of them.
      //
      // 1. WALKABLE DECKS become a standing surface. Only volumes a template
      //    DECLARED walkable, so a roof can never become a floor by accident.
      // 2. SOLID GEOMETRY UNDER A `passage` TAG re-blocks its tile. The tag
      //    clears the whole FOOTPRINT, so a town gate's tower legs were
      //    walkable — traverse.mjs measured 0.43m of clearance inside the
      //    masonry. "There is a way through here" is not "all of this is a way
      //    through", and only the built volumes know which tiles are the hole.
      {
        const surf = new Float32Array(this.gridW * this.gridH).fill(-Infinity)
        const mask = this.collisionMask
        const inBox = (v: typeof volumeBoxes[number], wx: number, wz: number): boolean => {
          const dx = wx - v.cx, dz = wz - v.cz
          const c = Math.cos(-v.yaw), sn = Math.sin(-v.yaw)
          return Math.abs(dx * c - dz * sn) <= v.hw && Math.abs(dx * sn + dz * c) <= v.hd
        }
        for (const v of volumeBoxes) {
          if (!v.walkable) continue
          const tx0 = Math.max(0, Math.floor(v.x0 / TILE))
          const tx1 = Math.min(this.gridW - 1, Math.floor(v.x1 / TILE))
          const tz0 = Math.max(0, Math.floor(v.z0 / TILE))
          const tz1 = Math.min(this.gridH - 1, Math.floor(v.z1 / TILE))
          for (let tz = tz0; tz <= tz1; tz++) {
            for (let tx = tx0; tx <= tx1; tx++) {
              const i = tz * this.gridW + tx
              if (v.y1 > surf[i]) surf[i] = v.y1
            }
          }
        }
        this.walkSurface = surf

        if (mask) {
          const passageTiles: Array<[number, number]> = []
          for (const obj of structLayerForMask?.objects ?? []) {
            const d = defMap.get(obj.definitionId)
            if (!d?.tags?.includes('passage')) continue
            const fp = footprintOf(obj, d)
            for (let dy = 0; dy < fp.h; dy++) {
              for (let dx = 0; dx < fp.w; dx++) passageTiles.push([obj.x + dx, obj.y + dy])
            }
          }
          const solid = volumeBoxes.filter((v) => !v.walkable && v.role !== 'plinth')
          let reblocked = 0
          for (const [tx, tz] of passageTiles) {
            if (tx < 0 || tz < 0 || tx >= this.gridW || tz >= this.gridH) continue
            const i = tz * this.gridW + tx
            if (mask[i] !== 0) continue
            const wx = (tx + 0.5) * TILE, wz = (tz + 0.5) * TILE
            const floor = this.sampleGroundY(wx, wz)
            for (const v of solid) {
              // Anything occupying the band a body needs is a wall, whatever
              // the tag on the object says.
              if (v.y1 < floor + 0.25 || v.y0 > floor + 1.7) continue
              if (!inBox(v, wx, wz)) continue
              mask[i] = 1; reblocked++
              break
            }
          }
          if (reblocked) this.collisionMask = mask
        }
      }

      // Collect chimney positions for smoke particles. X/Z still mirrors the
      // jitter BuildingFactory applies so smoke lines up with the chimney's
      // actual position; the HEIGHT comes from the factory's reported tops
      // rather than a second copy of the floors/HEIGHT_MULT/roof math, which
      // drifted every time massing changed (see BuildingTop).
      const topById = new Map(result.tops.map(t => [t.id, t]))
      // A BUILDING WHOSE PURPOSE IS FIRE ALWAYS SMOKES, AND GOES FIRST.
      //
      // A smokehouse that is not smoking is a shed with a vent on it, a cold
      // kiln is a brick cone, a cookshop with no fire is a room, and a forge
      // that is out is a barn. These are the types whose whole FUNCTION is
      // combustion, so they are not subject to the ~40% dice every other
      // chimney rolls.
      //
      // Swept when the cookshop was added, rather than left as the pair it
      // started as: a list of literal ids IS a pattern, and this repo has
      // paid three times over for the version of that lesson where the list
      // is never revisited.
      //
      // Collected BEFORE the ordinary chimneys because the particle budget is
      // a hard 16 and whatever fills it first wins — a priority that is
      // implicit in loop order is worth stating, since the failure mode is
      // silent (the feature simply never appears in a dense town).
      for (const obj of structureLayer.objects) {
        if (chimneyPositions.length >= SMOKE_PRIORITY_SHARE) break
        if (!ALWAYS_SMOKING.has(obj.definitionId)) continue
        const top = topById.get(obj.id)
        const def = defMap.get(obj.definitionId)
        if (!top || !def) continue
        // OUT OF THE FLUE THE TEMPLATE DECLARED, and only from the footprint
        // centre when it declared none. The centre-plus-apex rule is right for
        // a smokehouse's ridge louvre and a kiln's cone and wrong for a
        // cookshop, whose entire silhouette is a stack up one FLANK — smoke
        // rising a metre and a half beside it reads worse than no smoke.
        // `BuildingTop.vent*` is already in world units; the fallback is in
        // TILES and has to be converted, which is the trap this same block
        // fell into once already.
        const flue = (top.ventX !== undefined && top.ventY !== undefined &&
          top.ventZ !== undefined)
          ? new THREE.Vector3(top.ventX, top.ventY + 0.1, top.ventZ)
          : new THREE.Vector3(
            (obj.x + def.footprint.w / 2) * TILE,
            top.mainWallTopY + top.mainRoofH * 1.05,
            (obj.y + def.footprint.h / 2) * TILE)
        chimneyPositions.push(flue)
        hotChimneys.push(flue.clone())
      }
      for (const obj of structureLayer.objects) {
        if (ALWAYS_SMOKING.has(obj.definitionId)) continue
        const hash = stableHash(obj)
        if (hash % 5 >= 2) continue
        const def = defMap.get(obj.definitionId)
        if (!def) continue
        const top = topById.get(obj.id)
        if (!top) continue
        // A GARDEN SHED HAS NO HEARTH. This drew from every structure in the
        // layer, which was harmless while the shortest thing in town was a
        // house — and stopped being harmless the moment the outbuildings got
        // their own intrinsic heights and a potting shed became 3m instead of
        // 5.6m. `particles.mjs` caught it as smoke venting 2.4m above its own
        // ground on seed 8080, which is not the tile-coordinate bug that gate
        // exists for but is still a plume coming out of a shed roof at head
        // height. A hearth needs a room and a room needs a storey.
        if (top.mainWallTopY - top.baseY < STOREY_HEIGHT * 1.4) continue
        const fp = { w: def.footprint.w, h: def.footprint.h }
        const jitter = !NO_JITTER_MAP.has(obj.definitionId)
        const jitterDX = jitter ? (rand01(hash, 2) - 0.5) * 0.35 : 0
        const jitterDZ = jitter ? (rand01(hash, 3) - 0.5) * 0.35 : 0
        const chimSide = (obj.properties.chimneyPos === 'left') ? -1 : 1
        const bx = obj.x + fp.w / 2 + chimSide * fp.w * 0.3 + jitterDX
        const bz = obj.y + fp.h / 2 + jitterDZ
        // Chimney tip clears the main body's roof.
        // x AND z MULTIPLIED BY TILE. They were not, and the smoke has been
        // venting over the wrong third of the map since the tile rescale:
        // measured, the town spans x 2.8-143 and the smoke spanned x
        // 14.5-46.4, which is exactly a factor of three. Y was always correct
        // because BuildingTop reports metres, so the mixed units inside one
        // Vector3 are what hid it — the documented TILE trap, and no metric
        // in the harness looks at particles.
        chimneyPositions.push(
          new THREE.Vector3(bx * TILE, top.mainWallTopY + top.mainRoofH * 1.1, bz * TILE)
        )
      }
      this._buildingTops = topById
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
      const ls = buildLanternStrings(map, defMap, heightMap, this._buildingTops)
      if (ls.ropeMesh) this.propGroup.add(ls.ropeMesh)
      if (ls.lanternMesh) this.propGroup.add(ls.lanternMesh)
      if (ls.laundryMesh) this.propGroup.add(ls.laundryMesh)
      // Wall-mounted eye-level lanterns — small warm points on ~18% of
      // buildings, complements the overhead rope strings.
      const wall = buildWallLanterns(map, defMap, heightMap, this._buildingTops)
      if (wall) this.propGroup.add(wall)
      // Pillar 5's fourth layer: the light those windows throw DOWN. Needs
      // the building tops, so it cannot run before the buildings exist —
      // which is the whole reason it lives here and not in BuildingFactory.
      const spill = buildWindowSpill(this._buildingTops,
        (x, z) => (heightMap ? groundYAtWorld(heightMap, x, z) : 0))
      if (spill) this.propGroup.add(spill)
    }

    // Spawn particles
    this.initParticles(
      chimneyPositions, map.gridWidth * TILE, map.gridHeight * TILE,
      terrainLayer?.terrainTiles ?? null, heightMap,
      terrainLayer?.waterLevel ?? null, hotChimneys)

    // Weather, which allocates once at its maximum and is then scaled by
    // draw range. Before initMoths so the moths keep their place in the
    // system order for a reader; particles.mjs no longer cares.
    this.initPrecipitation()
    this.initMeteor()
    this.setWeather(this.weather, this.weatherIntensity)

    // === MOTHS AT THE LANTERNS ===
    // AFTER all three lantern producers, and that ordering is the whole
    // reason `lampAnchors` is a module array rather than a return value:
    // the lamppost family comes out of PropFactory and the other two out of
    // LanternStrings, so there is no single call whose result holds them
    // all. Running this before any of them would silently light no moths at
    // that family, which is the ghost failure — and the census would look
    // healthy, because the other families would still be there.
    this.initMoths(lampAnchors)

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
        // True apex from BuildingFactory — birds circled well above the
        // spires while this was re-derived here, and the roof/tower clamps
        // made that estimate over-shoot badly.
        const top = this._buildingTops.get(obj.id)
        if (!top) continue
        const topY = top.apexY + 0.8
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

    // isBlocked takes WORLD units — it divides by TILE internally. Everything
    // here is in TILES. Passing a tile coordinate to it therefore tested a
    // point a THIRD of the way from the origin, i.e. somewhere else entirely,
    // and the whole spawn-safety mechanism has been inoperative since the
    // TILE = 3.0 rescale. Measured across sixteen seeds: five started the
    // player inside a building and one in the river, and thirteen landed on
    // the untouched default offset because the check fired, the spiral then
    // searched the wrong neighbourhood too, found nothing in twelve rings,
    // and fell out leaving the original blocked value in place.
    //
    // This is exactly the getTerrainHeight/groundYAtWorld mix-up recorded in
    // CLAUDE.md, in a second place nobody swept. The conversion happens once,
    // here, and every test below goes through it.
    const freeAt = (tileX: number, tileZ: number): boolean =>
      !this.isBlocked(tileX * TILE, tileZ * TILE)

    /**
     * A SPAWN YOU CANNOT LEAVE IS NOT A SPAWN — and nothing had ever asked.
     *
     * The spiral below takes the FIRST free tile it finds, and a free tile
     * inside an enclosed courtyard is perfectly free. `spawn.mjs` grades
     * whether the player can STAND and what they can SEE; both passed clean
     * while the player stood in a FOUR-TILE POCKET with 962 tiles of town on
     * the other side of a wall, because "can I stand here" and "can I get
     * anywhere from here" are different questions and only a flood fill
     * answers the second.
     *
     * This is the spawn lesson for the third time. The first was standing
     * inside a wall, the second was facing one from a metre away, and this is
     * the variant one step further out: legally standing, with a clear view,
     * in a room. Each was invisible to the check written for the one before,
     * because each new check asked the previous question more carefully
     * instead of asking a new one.
     *
     * A district change moved which buildings stand where and put two seeds in
     * four into a pocket — but the picker has never tested connectivity, so
     * ANY placement change could have done this at any time, and several
     * probably did. The property that matters is exact and has no threshold in
     * it: the spawn must be on the LARGEST connected region of standable
     * ground. 4-connected, which is what `traverse.mjs` measures against, and
     * conservative — a diagonal gap a player can squeeze is not a route the
     * town should depend on.
     */
    const gw = map.gridWidth, gh = map.gridHeight
    const comp = new Int32Array(gw * gh).fill(-1)
    let bestComp = -1
    if (this.collisionMask) {
      let bestSize = 0, nComp = 0
      const stack: number[] = []
      for (let iz = 0; iz < gh; iz++) {
        for (let ix = 0; ix < gw; ix++) {
          if (comp[iz * gw + ix] !== -1 || !freeAt(ix + 0.5, iz + 0.5)) continue
          let size = 0
          comp[iz * gw + ix] = nComp
          stack.push(iz * gw + ix)
          while (stack.length) {
            const cur = stack.pop() as number
            size++
            const x = cur % gw, y = (cur / gw) | 0
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const nx = x + dx, ny = y + dy
              if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
              if (comp[ny * gw + nx] !== -1 || !freeAt(nx + 0.5, ny + 0.5)) continue
              comp[ny * gw + nx] = nComp
              stack.push(ny * gw + nx)
            }
          }
          if (size > bestSize) { bestSize = size; bestComp = nComp }
          nComp++
        }
      }
    }
    /** Free AND on the main component — the test every spawn candidate takes. */
    const openTile = (tx: number, tz: number): boolean => {
      if (!this.collisionMask) return true
      const ix = Math.floor(tx), iz = Math.floor(tz)
      if (ix < 0 || iz < 0 || ix >= gw || iz >= gh) return false
      return comp[iz * gw + ix] === bestComp
    }

    // Test the position we will actually STAND on — the tile centre. The old
    // code tested the corner and then spawned at the centre, which with a
    // 0.35m collision disc covers a different set of tiles.
    let spawnX = cx - 10 + 0.5, spawnZ = cz - 10 + 0.5
    if (this.collisionMask && !openTile(spawnX, spawnZ)) {
      let found = false
      spiral:
      for (let r = 1; r <= 24; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue // ring only
            const sx = spawnX + dx, sz = spawnZ + dy
            if (openTile(sx, sz)) {
              spawnX = sx; spawnZ = sz
              found = true
              break spiral
            }
          }
        }
      }
      // A spiral that runs out of rings used to leave the player standing in
      // whatever wall it started in. Sweep the whole map rather than give up:
      // a town with nowhere at all to stand is a different bug, and this way
      // it is the only way to still be stuck.
      if (!found) {
        let best = Infinity
        for (let iz = 0; iz < map.gridHeight; iz++) {
          for (let ix = 0; ix < map.gridWidth; ix++) {
            const tx2 = ix + 0.5, tz2 = iz + 0.5
            if (!openTile(tx2, tz2)) continue
            const d = (tx2 - cx) ** 2 + (tz2 - cz) ** 2
            if (d < best) { best = d; spawnX = tx2; spawnZ = tz2 }
          }
        }
      }
    }
    // spawnX/spawnZ and cx/cz are all TILE coordinates; the height map wants
    // tiles and the camera wants world, so the conversion happens right here
    // and nowhere else. The yaw is an angle between two tile-space points,
    // and a uniform scale does not change an angle — so it needs no factor.
    const spawnGround = heightMap ? getTerrainHeight(heightMap, spawnX, spawnZ) : 0
    this.camera.position.set(spawnX * TILE, spawnGround + EYE_HEIGHT, spawnZ * TILE)

    // FACE SOMEWHERE WORTH FACING.
    //
    // This pointed at the map centre, and `spawn.mjs` graded it clean because
    // that tool asks whether the player can STAND, not what they can SEE. Both
    // are true at once: you spawn on legal ground with your nose against a
    // wall, because the centre of a dense town is a building far more often
    // than it is a street, and the first frame of the app is a brown rectangle.
    //
    // Cast along the collision mask and take the longest clear run, biased
    // toward the town centre so you still set off inward rather than out into
    // the fields. 32 directions is finer than the streets are wide.
    {
      /** Longest unobstructed run from a tile, over 32 directions, in tiles. */
      const openness = (tx: number, tz: number): number => {
        let best = 0
        for (let i = 0; i < 32; i++) {
          const a = (i / 32) * Math.PI * 2
          const ux = Math.cos(a), uz = Math.sin(a)
          let clear = 0
          for (let s = 0.5; s <= 20; s += 0.5) {
            if (!freeAt(tx + ux * s, tz + uz * s)) break
            clear = s
          }
          best = Math.max(best, clear)
        }
        return best
      }
      // MOVE, DON'T JUST TURN. Choosing the yaw fixed 8 of 16 seeds that
      // opened with a facade in your face, and left the case where there is
      // nothing good to face from here at all — a spawn wedged in a one-tile
      // gap can be turned all day and still see 1.5m. So if this tile is
      // cramped, step to a nearby one that is not. Openness is exactly the
      // property spawn.mjs measures, which is the point: search for the thing
      // being graded rather than for a proxy that usually correlates.
      if (this.collisionMask && openness(spawnX, spawnZ) < 3) {
        let bestOpen = openness(spawnX, spawnZ)
        let bx = spawnX, bz = spawnZ
        for (let r = 1; r <= 8 && bestOpen < 6; r++) {
          for (let dz = -r; dz <= r; dz++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue
              const tx = spawnX + dx, tz = spawnZ + dz
              if (!freeAt(tx, tz)) continue
              const o = openness(tx, tz)
              if (o > bestOpen) { bestOpen = o; bx = tx; bz = tz }
            }
          }
        }
        if (bx !== spawnX || bz !== spawnZ) {
          spawnX = bx; spawnZ = bz
          const g2 = heightMap ? getTerrainHeight(heightMap, spawnX, spawnZ) : 0
          this.camera.position.set(spawnX * TILE, g2 + EYE_HEIGHT, spawnZ * TILE)
        }
      }

      const centreYaw = Math.atan2(cz - spawnZ, cx - spawnX)
      let bestYaw = centreYaw, bestScore = -Infinity
      for (let i = 0; i < 32; i++) {
        const yaw = (i / 32) * Math.PI * 2
        const dx = Math.cos(yaw), dz = Math.sin(yaw)
        let clear = 0
        // Half-tile steps: a 1-tile gap between two buildings is a real view
        // down an alley and a whole-tile walk can step straight over it.
        for (let s = 0.5; s <= 20; s += 0.5) {
          if (!freeAt(spawnX + dx * s, spawnZ + dz * s)) break
          clear = s
        }
        // Turning toward the centre is worth up to 4 tiles of view, so a
        // slightly shorter street pointing inward beats a long one pointing
        // out of town — but it can never rescue a view of a wall.
        let d = Math.abs(yaw - centreYaw) % (Math.PI * 2)
        if (d > Math.PI) d = Math.PI * 2 - d
        const score = clear + (1 - d / Math.PI) * 4
        if (score > bestScore) { bestScore = score; bestYaw = yaw }
      }
      this.cameraYaw = bestYaw
    }
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
    // Tight walkaround radius — only casters within ~18m of the player
    // rasterize into the shadow map. At 512² that's 0.07m/texel: crisp
    // shadow edges at eye level, and the shadow pass only iterates the
    // handful of buildings inside the frustum. Previous 28m covered most
    // of a 48-tile town so practically every wall was a caster.
    const r = Math.min(this.townRadius, SHADOW_RADIUS)
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
        // Tile centres first — the height map is indexed in tiles — then one
        // conversion to world for the geometry.
        const atx = a.x + fpA.w / 2, atz = a.y + fpA.h / 2
        const btx = b.x + fpB.w / 2, btz = b.y + fpB.h / 2
        const ah = heightMap ? getTerrainHeight(heightMap, atx, atz) : 0
        const bh = heightMap ? getTerrainHeight(heightMap, btx, btz) : 0
        const ax = atx * TILE, az = atz * TILE
        const bx = btx * TILE, bz = btz * TILE
        // Second-floor level. 1.2 was below the player's own 1.6m eye height,
        // so the "elevated walkway between upper storeys" was a plank at
        // shin height crossing the street.
        const bridgeH = FLOOR_HEIGHT * 2

        // Bridge deck
        const midX = (ax + bx) / 2, midZ = (az + bz) / 2
        const angle = Math.atan2(bz - az, bx - ax)
        const bridgeLen = dist * TILE * 0.7 // shorter than building distance
        const bridgeGeo = new THREE.BoxGeometry(bridgeLen, 0.12, 1.1)
        const bridge = new THREE.Mesh(bridgeGeo, walkwayMat)
        bridge.position.set(midX, (ah + bh) / 2 + bridgeH, midZ)
        bridge.rotation.y = -angle
        this.propGroup.add(bridge)

        // Railings
        for (const side of [-0.5, 0.5]) {
          const railGeo = new THREE.BoxGeometry(bridgeLen, 0.9, 0.06)
          const rail = new THREE.Mesh(railGeo, railMat)
          rail.position.set(
            midX + Math.sin(angle) * side,
            (ah + bh) / 2 + bridgeH + 0.45,
            midZ - Math.cos(angle) * side
          )
          rail.rotation.y = -angle
          this.propGroup.add(rail)
        }

        // Support arch (simple box underneath)
        const archGeo = new THREE.BoxGeometry(0.2, bridgeH, 0.2)
        const archMat = new THREE.MeshLambertMaterial({ color: 0x706058, flatShading: true })
        // At the DECK ENDS. These used to sit 0.5 out from each building's
        // centre point, which is inside the building — so the walkway's only
        // visible support was buried in a wall.
        const half = bridgeLen / 2
        const support1 = new THREE.Mesh(archGeo, archMat)
        support1.position.set(midX - Math.cos(angle) * half, ah + bridgeH / 2, midZ - Math.sin(angle) * half)
        this.propGroup.add(support1)
        const support2 = new THREE.Mesh(archGeo, archMat)
        support2.position.set(midX + Math.cos(angle) * half, bh + bridgeH / 2, midZ + Math.sin(angle) * half)
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

          // Generate steps from low to high. The run is a fraction of a TILE
          // and so has to reach world units; the tread and rise are already
          // metres. Tread depth follows the actual spacing rather than a fixed
          // 0.25, which used to leave visible gaps between floating slabs
          // whenever the drop needed more than a handful of steps.
          const numSteps = Math.max(2, Math.min(9, Math.ceil(diff / 0.18)))
          const runW = 0.6 * TILE
          const spacing = runW / numSteps
          const stepW = 1.4, stepD = spacing * 1.08
          const stepH = diff / numSteps
          const startX = (tx + 0.5) * TILE, startZ = (ty + 0.5) * TILE
          const angle = Math.atan2(dz, dx)

          for (let s = 0; s < numSteps; s++) {
            const t = s / numSteps
            const sx = startX + dx * (0.3 * TILE + t * runW)
            const sz = startZ + dz * (0.3 * TILE + t * runW)
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

  /**
   * The two Celestial sliders, which were read by NOTHING.
   *
   * `moonPhase` and `starDensity` are declared in EnvironmentState, defaulted
   * in the store and in the generator, and wired to two sliders that report a
   * percentage — and no consumer existed for either. A control that lies is
   * worse than absent content: nobody notices what is missing, and everybody
   * believes a labelled slider.
   *
   * Kept as fields and re-applied through updateLighting rather than acted on
   * here, so there is one place that decides what the sky looks like. Both
   * defaults reproduce the previously hardcoded behaviour exactly.
   */
  setCelestial(moonPhase: number, starDensity: number): void {
    this.moonPhase = moonPhase
    this.starDensity = starDensity
    this.updateLighting(this.currentTimeOfDay)
  }

  /**
   * The weather buttons, which were read by nothing either — five of them
   * plus an intensity slider, and pressing Rain made the slider APPEAR, which
   * is a complete and specific promise that nothing kept.
   *
   * Routed through updateLighting for the same reason the celestial pair is:
   * weather is a multiplier on what the hour already decided, so the hour has
   * to be applied first and there must be exactly one place that composes
   * them. Applying it here directly would give a renderer whose fog depends
   * on the order the two controls were last touched.
   */
  setWeather(weather: string, intensity: number): void {
    this.weather = weather
    this.weatherIntensity = intensity
    this.updateLighting(this.currentTimeOfDay)
  }

  updateLighting(timeOfDay: number): void {
    this.currentTimeOfDay = timeOfDay
    const isNight = timeOfDay < 5 || timeOfDay >= 19
    const isDusk = timeOfDay >= 17 && timeOfDay < 19
    const isDawn = timeOfDay >= 5 && timeOfDay < 7
    // ONE SOURCE FOR "IS THE SKY DARK". The meteor schedule needs it and
    // this is the only place that classifies the hour — a second copy is how
    // the four lighting arms rotted one at a time.
    this._nightness = isNight ? 1 : (isDusk || isDawn) ? 0.5 : 0
    const isGolden = timeOfDay >= 15 && timeOfDay < 17
    // Shadow gating: at deep night the sun is below horizon, shadows are
    // invisible anyway, so skip the shadow pass entirely. Saves a full
    // 256² render + sort per frame.
    if (this.renderer) {
      const sunBelowHorizon = timeOfDay < 5.5 || timeOfDay >= 19.5
      this.renderer.shadowMap.enabled = !sunBelowHorizon
      // Sun moved → shadow contents changed → mark dirty so the next
      // frame recomputes the shadow map. (Auto-update was disabled at
      // init; we control redraws manually.)
      this.renderer.shadowMap.needsUpdate = !sunBelowHorizon
    }

    // Sun angle based on time (0=midnight, 12=noon)
    const sunAngle = ((timeOfDay - 6) / 12) * Math.PI // 0 at 6am, PI at 6pm
    const sunY = Math.sin(sunAngle) * 50
    const sunX = Math.cos(sunAngle) * 40 + this.townCenterX
    const sunZ = this.townCenterZ + 10

    if (isNight) {
      // NIGHT WAS NOT DARK, IT WAS UNLIT — and nobody had ever measured it.
      // The first reading of this branch, on the same six street views the
      // board grades dusk on:
      //
      //     sky 0.005 · wall 0.000 · roof 0.000 · ground 0.012
      //     90% of wall pixels and 100% of roof pixels read black
      //
      // A person moving the time slider to night got a black screen with
      // windows floating in it. THE SKY WAS AS BLACK AS THE BUILDINGS, so
      // DESIGN.md pillar 1 had nothing to work with: a silhouette needs
      // something to be silhouetted AGAINST, and at 0.005 the roofline and
      // the sky are the same colour.
      //
      // The cause is DOUBLE-DARKENING — a near-black COLOUR multiplied by a
      // low INTENSITY. Dusk's hemisphere is 0xffaa88 at 0.70 and contributes
      // about 0.51; night's was 0x101830 at 0.26 and contributed 0.024,
      // twenty-one times less. That is not a night-to-dusk ratio, it is a
      // term that has been dimmed twice by two people who each only looked
      // at one of the two numbers.
      //
      // Raised by the same principle the dusk branch was: at night the moon
      // is a weak disc and SKYGLOW is what actually reaches a wall in a
      // street, so the hemisphere leads. The stopping point is legibility,
      // not brightness — surfaces should read as shapes in deep blue, far
      // below mid-grey at 0.22, with the warm windows and lanterns (emissive
      // at glow 1.4, untouched here) still the brightest thing by an order
      // of magnitude.
      this.sunLight.intensity = 0.32
      this.sunLight.color.setHex(0x6a8ac8)
      this.sunLight.position.set(this.townCenterX, 40, sunZ) // moonlight from above
      // AMBIENT LEADS AT NIGHT, NOT THE HEMISPHERE, and the measurement is
      // why. Hemisphere light is orientation-dependent — an up-facing surface
      // takes the full sky colour — so pushing it lifted the GROUND to 0.165
      // while walls sat at 0.042 and the sky at 0.022. That inverts the
      // silhouette: the street became the brightest thing in frame and the
      // rooflines vanished into a sky darker than the buildings in front of
      // it. Ambient is uniform, so it lifts a wall and a road together.
      this.ambientLight.intensity = 1.15
      this.ambientLight.color.setHex(0x4a5980)
      this.hemiLight.color.setHex(0x3d5280)
      this.hemiLight.groundColor.setHex(0x241f16)
      this.hemiLight.intensity = 0.6
      this._fog.color.setHex(0x141c34); this._fog.density = 0.008
      if (this.skyUniforms) {
        // The sky has to sit ABOVE the buildings or there is no silhouette.
        // THE SKY MUST OUT-READ THE BUILDINGS or there is no silhouette, and
        // these colours go through the same tone mapping as everything else —
        // 0x1b2350 measured 0.022 on screen, a fifth of its nominal luma.
        this.skyUniforms.uZenith.value.setHex(0x39447e)
        this.skyUniforms.uHorizon.value.setHex(0x5a6a9c)
        this.skyUniforms.uCloudColor.value.setHex(0x303a52)
        this.skyUniforms.uCloud.value = 0.4
        // Distant mountains read as nearly black at night.
        this.skyUniforms.uMountainColor.value.setHex(0x05080f)
        this.skyUniforms.uMountain.value = 1.0
      }
      if (this.sunDisc) {
        this.discUniforms?.uLit.value.setHex(0xccccdd)
        // LOW, NOT OVERHEAD — and the reason is the water.
        //
        // The moon hung at (0, 180, 0), which from anywhere in town is very
        // nearly straight up. That is fine for a disc you find by looking
        // up, and it makes a moon PATH impossible: the glint term is
        // `dot(reflect(view), moonDir)`, and a reflection off a horizontal
        // surface only points at the zenith when you are staring at your own
        // feet. So the river had no moon in it, and could not have.
        //
        // At ~13 degrees of altitude the moon lays the broken silver road
        // across the water that it does in life, and it also arrives in
        // street views instead of only in upward ones — the town's own
        // vantage lesson, applied to the thing being looked AT.
        this._moonPos.set(
          this.townCenterX + 172, 48, this.townCenterZ - 124)
        this.sunDisc.position.copy(this._moonPos)
        this.sunDisc.scale.setScalar(0.3) // smaller moon
      }
    } else if (isDusk || isDawn) {
      this.sunLight.intensity = 0.8
      this.sunLight.color.setHex(0xffaa66)
      this.sunLight.position.set(sunX, Math.max(5, sunY), sunZ)
      // THE TONE ARC FIXED THE NOON BRANCH AND NEVER TOUCHED THIS ONE.
      //
      // It raised ambient 0.42 -> 0.62 and hemisphere 0.52 -> 0.95 with a
      // comment explaining that skylight is the term a wall in a street
      // actually sees — and every measurement it took was at NOON, so only
      // the noon branch was edited. Dusk kept the pre-arc numbers, which is
      // why CLAUDE.md records walls going 0.068 -> 0.203 and then reads 0.058
      // at 18.5 with 52% of their pixels black. The arc's own conclusion was
      // right; it was applied to one of four branches.
      //
      // Found by `tools/holes.mjs`, which counts surfaces that have collapsed
      // to zero: after the glass and door fixes the residual holes were all
      // things in SHADOW — a door at 0.30 albedo reading 0.05x the wall, a
      // crate whose paint is a perfectly good 0x8a7050 reading 0.17x the
      // street. Below-average albedo collapses wherever the sun does not
      // reach, and at dusk the sun reaches almost nothing.
      //
      // THE PRINCIPLE, not a taste value: at dusk the sun is a weak low disc
      // and the SKY DOME is the dominant source — eyeball measures the dusk
      // sky at 0.243 luma, brighter than any surface in the frame. So the
      // skylight fraction should be HIGHER at dusk than at noon relative to
      // the sun, and it was less than half. Sun 0.8 : hemi 0.42 becomes
      // 0.8 : 0.70, which is still well under noon's 0.95 — dusk stays dusk,
      // and DESIGN.md pillar 1's warm windows against dark silhouettes are
      // untouched because the windows are emissive and scale with the hour.
      this.ambientLight.intensity = 0.4
      this.ambientLight.color.setHex(0x604838)
      this.hemiLight.color.setHex(0xffaa88)
      this.hemiLight.groundColor.setHex(0x3a2a18)
      this.hemiLight.intensity = 0.7
      this._fog.color.setHex(0xffaa88); this._fog.density = 0.004
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
        this.discUniforms?.uLit.value.setHex(0xff8844)
        this._scratchSunDir2
          .set(sunX - this.townCenterX, Math.max(5, sunY), sunZ - this.townCenterZ)
          .normalize()
        this.sunDisc.position.copy(this._scratchSunDir2).multiplyScalar(200)
        this.sunDisc.scale.setScalar(1.2) // larger at horizon
      }
    } else if (isGolden) {
      this.sunLight.intensity = 1.0
      this.sunLight.color.setHex(0xffe8c0)
      this.sunLight.position.set(sunX, sunY, sunZ)
      // GOLDEN WAS DIMMER THAN DUSK, WHICH CANNOT BE RIGHT. Laid side by
      // side, the four branches were never graded against each other:
      //
      //     noon    ambient 0.62  hemi 0.95
      //     golden  ambient 0.36  hemi 0.40   <-- between the two, and lowest
      //     dusk    ambient 0.40  hemi 0.70
      //     night   ambient 0.26  hemi 0.26
      //
      // Golden hour is 15:00-17:00 with the sun still well up; it is the
      // BRIGHTER neighbour of dusk and it carried barely half its skylight.
      // Nobody noticed because each branch was only ever edited while
      // measuring at its own hour — the same failure that left dusk with the
      // pre-tone-arc numbers for a whole arc. Measured, golden read walls at
      // 0.115 with 36% of their pixels black, worse than it has any reason
      // to be with the sun up.
      //
      // Interpolated between its neighbours rather than tuned: golden sits
      // between dusk's 0.40/0.70 and noon's 0.62/0.95, which is also what the
      // sun angle says.
      this.ambientLight.intensity = 0.52
      this.ambientLight.color.setHex(0x786754)
      this.hemiLight.color.setHex(0xe8d8c8)
      this.hemiLight.groundColor.setHex(0x50442e)
      this.hemiLight.intensity = 0.85
      this._fog.color.setHex(0xe8d8c8); this._fog.density = 0.004
      if (this.skyUniforms) {
        this.skyUniforms.uZenith.value.setHex(0x5588bb)
        this.skyUniforms.uHorizon.value.setHex(0xe8d8c8)
        this.skyUniforms.uCloudColor.value.setHex(0xfff0d8)
        this.skyUniforms.uCloud.value = 0.35
        this.skyUniforms.uMountainColor.value.setHex(0x6a6258)
        this.skyUniforms.uMountain.value = 1.0
      }
      if (this.sunDisc) {
        this.discUniforms?.uLit.value.setHex(0xffdd88)
        this._scratchSunDir2
          .set(sunX - this.townCenterX, sunY, sunZ - this.townCenterZ)
          .normalize()
        this.sunDisc.position.copy(this._scratchSunDir2).multiplyScalar(200)
        this.sunDisc.scale.setScalar(1.0)
      }
    } else {
      this.sunLight.intensity = 1.2
      this.sunLight.color.setHex(0xfff4e0)
      this.sunLight.position.set(sunX, sunY, sunZ)
      // === WHY THESE WENT UP ===
      //
      // tools/eyeball.mjs measures ABSOLUTE luma by surface, which is the one
      // question a peer comparison can never ask. At noon it read:
      //
      //     ground 0.639    wall 0.084 (24% black)    roof 0.032 (72% black)
      //
      // The ground was seven times brighter than the walls standing on it and
      // most of every roof was effectively black at MIDDAY. The day/night A/B
      // cleared the rig's BEHAVIOUR — at 09:00 the ground halves and the walls
      // rise, exactly as a lower sun should do — so the shape was right and
      // the level was not. With the sun overhead a vertical face gets almost
      // no direct term, and ambient + hemisphere were carrying it alone.
      //
      // The hemisphere is the term that matters here: it is skylight, and a
      // wall in a street sees a lot of sky. Ambient follows it up a little so
      // the deepest shadows stop clipping to black.
      this.ambientLight.intensity = 0.62
      this.ambientLight.color.setHex(0x707890)
      this.hemiLight.color.setHex(0xd0e0f0)
      this.hemiLight.groundColor.setHex(0x6a6250)
      this.hemiLight.intensity = 0.95
      this._fog.color.setHex(0xd0e0f0); this._fog.density = 0.004
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
        this.discUniforms?.uLit.value.setHex(0xffee88)
        this._scratchSunDir2
          .set(sunX - this.townCenterX, sunY, sunZ - this.townCenterZ)
          .normalize()
        this.sunDisc.position.copy(this._scratchSunDir2).multiplyScalar(200)
        this.sunDisc.scale.setScalar(0.8)
      }
    }

    // STARS COME FROM A CURVE, NOT FROM FOUR LITERALS IN FOUR BRANCHES.
    //
    // They went in the other way first, and that shape is precisely what
    // `hours.mjs` exists to catch: the tone arc edited the noon branch of
    // this switch and dusk kept the pre-arc numbers for a whole arc. One
    // call with the hour cannot rot one arm at a time, and it interpolates,
    // so the field comes up over the half hour after sunset rather than
    // snapping on at a boundary. `starIntensityFor` is in Materials.ts
    // because the pixel-art export paints its own sky and needs the same
    // answer.
    if (this.skyUniforms) {
      this.skyUniforms.uStars.value = starIntensityFor(timeOfDay)
      this.skyUniforms.uStarCut.value = starThresholdFor(this.starDensity)
    }

    // THE MOON'S PHASE, ALSO ONCE AND ALSO AFTER THE SWITCH. Only the night
    // arm draws a moon, so the temptation is to set this inside it — which is
    // how the tone arc came to edit one branch of four. `uSun` collapses the
    // phase for the three arms that draw a sun, and the whole thing is one
    // assignment that no arm can forget.
    //
    // The moon hangs overhead at (0, 180, 0) and the player is on the ground,
    // so the direction from the moon to the viewer is -Y and the terminator
    // has to sweep from there toward the horizontal, or the shadow lands on
    // the far side of the ball where nobody can see it. `uDark` takes the
    // zenith the branch above just set, so the unlit limb blends into the sky
    // instead of reading as a black bite.
    if (this.discUniforms) {
      this.discUniforms.uSun.value = isNight ? 0 : 1
      const [px, py, pz] = moonPhaseDir(this.moonPhase, [0, -1, 0], [1, 0, 0])
      this.discUniforms.uPhaseDir.value.set(px, py, pz)
      if (this.skyUniforms) this.discUniforms.uDark.value.copy(this.skyUniforms.uZenith.value)
    }

    // THE WEATHER, LAST, AS A MULTIPLIER ON WHAT THE HOUR DECIDED.
    //
    // After the switch and after the celestial pair, because it MODIFIES
    // their result rather than replacing it: every branch above has had a
    // session of tuning spent on it and dusk is the hour the whole board
    // grades, so a weather table setting fog density outright would quietly
    // overwrite that work in four places at once. 'clear' — and any weather
    // at intensity 0 — is exact identity, which is what makes wiring up a
    // dead control provably free rather than a restyle of every scene.
    //
    // Cloud REDISTRIBUTES light rather than removing it: the sun goes down
    // and the skylight goes UP, because an overcast sky is a vast soft
    // source. Scaling both the same way would just dim the town, which is
    // what "weather" looks like when it is implemented as an opacity.
    const air = weatherAir(this.weather, this.weatherIntensity)
    if (this.skyUniforms && (air.desat > 0 || air.skyDim !== 1)) {
      // THE SKY FIRST, because the fog then takes its colour FROM it and an
      // overcast fog tinted from a clear horizon is two weathers at once.
      //
      // DESATURATE TOWARD THE SKY'S OWN LUMINANCE, never toward a fixed grey.
      // Cloud takes the COLOUR out of a sky; it does not impose one. An
      // absolute target is darker than a clear noon sky and brighter than a
      // night one, so it dimmed the day and lifted the night — and combined
      // with `skyScale` raising the walls it inverted the silhouette on seven
      // of twenty hour-weather combinations. Found by crossing the four arms
      // with the five weathers in `hours.mjs`, which is the whole reason that
      // tool exists one level down.
      const grey = (c: THREE.Color): void => {
        const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722
        this._scratchOvercast.setRGB(l, l, l)
        c.lerp(this._scratchOvercast, air.desat).multiplyScalar(air.skyDim)
      }
      grey(this.skyUniforms.uZenith.value)
      grey(this.skyUniforms.uHorizon.value)
      grey(this.skyUniforms.uCloudColor.value)
    }
    if (this.skyUniforms) {
      this.skyUniforms.uCloud.value = Math.min(1, this.skyUniforms.uCloud.value * air.cloudScale)
      this.skyUniforms.uStars.value *= air.starScale
    }
    if (air.fogScale !== 1 || air.fogToSky > 0) {
      this._fog.density *= air.fogScale
      if (air.fogToSky > 0 && this.skyUniforms) {
        // TAKE THE SKY'S HUE, NOT ITS BRIGHTNESS.
        //
        // `uHorizon` is what the dome is TOLD; it is not what the dome
        // RENDERS. At night the uniform is luma 0.417 and the sky pixel
        // measures 0.065, because the shader mixes it and the tone mapper
        // compresses it — so lerping the fog toward the raw value made the
        // fog SIX TIMES BRIGHTER than the sky it was supposed to be matching,
        // and every distant wall washed toward it. That is what left all four
        // night weathers with walls above the sky after the other two causes
        // were fixed.
        //
        // The correction is the one already applied to the sky itself:
        // relative, not absolute. Take the hue and put the hour's own fog
        // brightness back, so weather re-tints the air without lighting it.
        const before = this._fog.color.r * 0.2126 + this._fog.color.g * 0.7152
          + this._fog.color.b * 0.0722
        this._fog.color.lerp(this.skyUniforms.uHorizon.value, air.fogToSky)
        const after = this._fog.color.r * 0.2126 + this._fog.color.g * 0.7152
          + this._fog.color.b * 0.0722
        if (after > 1e-4) this._fog.color.multiplyScalar(before / after)
      }
    }
    this.sunLight.intensity *= air.sunScale
    // CLOUD REDISTRIBUTES SUNLIGHT, AND AT NIGHT THERE IS NONE TO
    // REDISTRIBUTE. `skyScale` above 1 is the daytime phenomenon — an
    // overcast sky is a vast soft source — and applying it to the night arm
    // raised the walls while nothing raised the sky, inverting the silhouette
    // on all four night weathers. That was invisible until the overcast
    // colour stopped being an absolute grey: the old fixed grey was BRIGHTER
    // than a night sky, so it lifted the sky and accidentally compensated for
    // a wall lift that should never have been applied.
    //
    // At night the sky IS the light source, so the skylight follows whatever
    // happened to the sky — one term, not a second table column.
    this.hemiLight.intensity *= isNight ? air.skyDim : air.skyScale
    this.setPrecipitation(air.precip, air.rate)

    // FEED THE WATER THE SKY IT IS REFLECTING.
    //
    // Every branch above sets the sky dome's uniforms and then the river,
    // being Lambert, ignored all of it and stayed the same flat blue. Read
    // them back here — one place, after whichever branch ran — so the two can
    // never disagree about what colour the sky is. A river mirroring last
    // hour's sky is a worse defect than one mirroring nothing.
    if (this.skyUniforms) {
      // AT NIGHT THE LIGHT ON THE WATER IS THE MOON'S, and it is aimed at the
      // disc the sky is actually drawing rather than at the sun, which is
      // under the horizon and was still being handed to the glint. That is
      // why the river was the darkest thing in the scene after dark — the one
      // surface in town that should be the brightest, because it is showing
      // you the sky.
      if (isNight) {
        this._scratchSunDir2
          .set(this._moonPos.x - this.townCenterX, this._moonPos.y,
            this._moonPos.z - this.townCenterZ)
          .normalize()
        // Cool and dim. A moon is sunlight twice removed, so the track is
        // silver rather than gold — and the glint term multiplies by 1.4, so
        // this is the value that decides whether the river reads as water or
        // as a runway.
        _moonGlint.setHex(0x8fa6c8)
        setWaterSky(
          this.skyUniforms.uHorizon.value,
          this.skyUniforms.uZenith.value,
          this._scratchSunDir2,
          _moonGlint,
        )
      } else {
        this._scratchSunDir2
          .set(sunX - this.townCenterX, Math.max(0.02, sunY), sunZ - this.townCenterZ)
          .normalize()
        setWaterSky(
          this.skyUniforms.uHorizon.value,
          this.skyUniforms.uZenith.value,
          this._scratchSunDir2,
          this.sunLight.color,
        )
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
    // Composer is OFF UNCONDITIONALLY for perf. The bloom + OutputPass
    // chain costs ~5-8ms GPU per frame on integrated graphics. The dusk
    // mood is now carried entirely by the warm-amber emissive maps on
    // textured walls + the lantern halo geometry; bloom was a polish
    // nice-to-have, not a structural requirement. If we want bloom back
    // we can re-enable per-time-of-day or with a quality flag.
    this._useComposer = false
    setWallEmissiveIntensity(windowGlow)
    // Hanging lanterns: always a bit brighter than windows (they're supposed
    // to be the primary overhead light source at dusk) but still ramp with
    // time of day. Multiplier picked so the lantern-bulb color clips into
    // the bloom threshold at night → warm halos over the street.
    const lanternIntensity = windowGlow * 1.4 + (windowGlow > 0 ? 0.2 : 0)
    setLanternEmissiveIntensity(lanternIntensity)
    // OFF THE SAME TERM AS THE WINDOW EMISSIVE, so the spill cannot outlive
    // the light casting it: a warm pool on the cobbles under dark windows at
    // noon is worse than no pool. Held well under the lamppost pools, because
    // a window is a weak source behind glass and this is a wash rather than a
    // second lamp — the failure mode is a town whose every facade sits in its
    // own spotlight, which reads as a stage set.
    // AND IT HAS TO STAY A HINT. The first value lit the entire cobbled
    // street to an even pale wash, which is the worst of both pillars at
    // once — pillar 1 wants a dark street and pillar 5 wants POOLS, and a
    // uniform floor gives neither. Every building in town casts one of
    // these and they overlap, so the per-building value must be small
    // enough that the sum is still a street with light in it rather than a
    // lit street.
    setWindowSpillOpacity(Math.min(0.11, windowGlow * 0.08))
    // Volumetric pool cones under lampposts: invisible at noon, subtle at
    // golden hour, prominent at dusk/night. Additive blending means pools
    // overlap constructively so dense lamp clusters brighten each other.
    // Sprite-based soft pool: can push brighter without silhouette showing
    // because the radial alpha fades to zero at the edge. Cap at 0.55 so
    // overlapping pools in dense districts still read as discrete glows,
    // not a flood-light wash.
    const poolOpacity = windowGlow <= 0 ? 0 : Math.min(0.55, 0.15 + windowGlow * 0.4)
    setLampPoolOpacity(poolOpacity)

    // Particle materials: all TOD-driven updates happen here, in the slow
    // path, instead of being re-applied every animate-loop frame. Saves
    // ~3 material attribute writes × N particle systems × 60 Hz.
    const birdOpacity = isNight ? 0.0 : isDusk ? 0.55 : 0.0
    // `isNight` here uses the updateLighting cutoff (19); bird roost window
    // extends a bit later (20) to match the hand-authored dusk feel.
    const birdsRoosted = timeOfDay < 5 || timeOfDay >= 20
    for (const ps of this.particleSystems) {
      const mat = ps.points.material as THREE.PointsMaterial
      if (ps.type === 'smoke') {
        if (isNight) { mat.color.setHex(0x504a52); mat.opacity = 0.22 }
        else if (isDusk || isDawn) { mat.color.setHex(0x9a8878); mat.opacity = 0.3 }
        else { mat.color.setHex(0xbbbbbb); mat.opacity = 0.35 }
      } else if (ps.type === 'firefly') {
        mat.opacity = isNight ? 0.7 : isDusk ? 0.3 : 0.05
        mat.color.setHex(isNight ? 0xffdd44 : 0xffffff)
        mat.size = isNight ? 0.12 : 0.04
      } else if (ps.type === 'bird') {
        mat.opacity = birdsRoosted ? 0.0 : birdOpacity
      } else if (ps.type === 'flock') {
        // Pigeons roost after dark and are gone by then; they are a daytime
        // and dusk creature, which is also the only time you can see a
        // 20cm dark dot against flagstones.
        mat.opacity = isNight ? 0 : isDusk || isDawn ? 0.75 : 0.9
      } else if (ps.type === 'ember') {
        // A SPARK IS ONLY A SPARK AGAINST A DARK SKY, and the photograph
        // reversed my first guess about which hour that is. I weighted DUSK
        // highest on the reasoning that a forge is worked in the evening —
        // and an amber spark against an ORANGE dusk sky is the same hue as
        // its background and nearly vanishes, while against night blue it is
        // unmistakable. Contrast decides this, not the working day.
        mat.opacity = isNight ? 1 : isDusk || isDawn ? 0.75 : 0
      } else if (ps.type === 'wisp') {
        // A NIGHT THING, with a hint at dusk. Full dark is where it belongs
        // and where a cold green point has anything to be seen against; the
        // dusk hint exists so the hour the board grades is not simply blank,
        // the same compromise the fireflies make.
        mat.opacity = isNight ? 0.9 : isDusk || isDawn ? 0.4 : 0
      } else if (ps.type === 'mist') {
        // MIST IS A COOLING EFFECT, so it is thickest before dawn and gone by
        // mid-morning — the one system here whose schedule is not simply
        // "when it is dark". Keyed off the hour rather than the isNight
        // boolean because the interesting part is the RAMP: at 18.5, the hour
        // the board grades, there should be a hint on the water and not a
        // bank of fog.
        const t = timeOfDay
        const amt = t < 4 ? 1.0
          : t < 8 ? 1.0 - (t - 4) / 4        // burning off through the morning
          : t < 17 ? 0                        // daylight
          : t < 20 ? (t - 17) / 3 * 0.55      // gathering after sunset
          : 0.55 + (Math.min(t, 24) - 20) / 4 * 0.45
        mat.opacity = 0.14 * amt
      } else if (ps.type === 'moth') {
        // KEYED TO THE LANTERNS, NOT TO A HOUR TABLE OF ITS OWN. A moth at
        // an unlit lamp is an insect hovering over a pole, so this reads the
        // same emissive level the lanterns were just given — the number is
        // computed a few lines above and there is no second branch to rot.
        // Strongest at night for the same reason the fireflies are: the
        // contrast against a dark street is what makes a 4cm dot read at all.
        mat.opacity = lanternIntensity <= 0 ? 0 : isNight ? 0.95 : isDusk || isDawn ? 0.6 : 0
        mat.size = isNight ? 0.085 : 0.075
      }
    }
  }

  /** Initialize particle systems for smoke and fireflies */
  private initParticles(
    chimneyPositions: THREE.Vector3[], worldW: number, worldH: number,
    tiles: number[][] | null, heightMap: number[][] | null,
    waterLevel: number[][] | null,
    /** The ALWAYS_SMOKING flues, which throw sparks. Passed separately rather
     *  than sliced off the front of `chimneyPositions`, because the
     *  farthest-point pass below reorders that list. */
    hotChimneys: THREE.Vector3[],
  ): void {
    // Chimney smoke: 2 particles per chimney × max 16 chimneys = 32.
    // Was 4 × 16 = 64 (originally 8 × 20 = 160). At dusk-walkaround
    // distance you can't distinguish 4 dots from 2 dots per chimney —
    // both read as a single soft puff. Halving cuts the per-frame
    // particle update loop in half on chimney smoke.
    // SPREAD THE BUDGET OVER THE TOWN, do not take the first sixteen.
    //
    // The collector walks the structure layer in PLACEMENT order, which is
    // spatially clustered by construction — the placer works outward from the
    // road network — so truncating at sixteen took sixteen chimneys from one
    // part of the map. `particles.mjs` measures each system's x-extent as a
    // fraction of the town's and read 0.30 against the town: all the smoke in
    // two quarters and none anywhere else, which reads as a fire rather than
    // as a town at supper.
    //
    // Farthest-point selection, seeded by whatever the priority pass already
    // took, so the industrial types keep their places and the ordinary
    // chimneys fill the gaps between them. O(n x 16), which is nothing.
    if (chimneyPositions.length > 16) {
      const chosen: THREE.Vector3[] = chimneyPositions.slice(0, SMOKE_PRIORITY_SHARE)
      const rest = chimneyPositions.slice(SMOKE_PRIORITY_SHARE)
      if (chosen.length === 0 && rest.length) chosen.push(rest.shift() as THREE.Vector3)
      while (chosen.length < 16 && rest.length) {
        let bestI = 0, bestD = -1
        for (let i = 0; i < rest.length; i++) {
          let near = Infinity
          for (const c of chosen) {
            const dx = rest[i].x - c.x, dz = rest[i].z - c.z
            const d = dx * dx + dz * dz
            if (d < near) near = d
          }
          if (near > bestD) { bestD = near; bestI = i }
        }
        chosen.push(rest.splice(bestI, 1)[0])
      }
      chimneyPositions = chosen
    }
    const maxChimneys = Math.min(chimneyPositions.length, 16)
    if (maxChimneys > 0) {
      const perChimney = 2
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
      points.name = 'smoke'
      this.particleGroup.add(points)
      this.particleSystems.push({ points, positions, velocities, lifetimes, origins, count, type: 'smoke' })
    }

    // Ambient fireflies / dust motes — was 80, now 36. The eye reads
    // these as scattered atmospheric dots; spatial density at this
    // count is still well above where the effect breaks. CPU update
    // loop benefits from the halving since the per-frame work scales
    // linearly with particle count.
    const fireflyCount = 36
    const ffPositions = new Float32Array(fireflyCount * 3)
    const ffVelocities = new Float32Array(fireflyCount * 3)
    const ffLifetimes = new Float32Array(fireflyCount)
    const ffOrigins = new Float32Array(fireflyCount * 3)

    // A FIREFLY IS OVER GRASS OR WATER, NOT OVER A ROOF.
    //
    // They were scattered by Math.random() across the whole map, so most of
    // them hung over cobbles, plaza flagstone and rooftops — where a pale dot
    // is a speck of dust and not an insect. The comment above still calls
    // them "dust motes", which is an honest description of what a uniform
    // scatter produces. This is the prop-tenancy lesson one layer over: a
    // distance metric answers "is this spot empty" and only ownership
    // answers "why is this here", and the same fix applies — ask the terrain
    // table, which is where a tile's meaning lives.
    //
    // Water is in as well as soft ground, because a river at dusk is the
    // place you would actually stand to watch them.
    const soft: Array<[number, number]> = []
    const water: Array<[number, number]> = []
    const marsh: Array<[number, number]> = []
    if (tiles) {
      for (let ty = 0; ty < tiles.length; ty++) {
        for (let tx = 0; tx < (tiles[ty]?.length ?? 0); tx++) {
          const t = tiles[ty][tx]
          if (t === 3) water.push([tx, ty])
          if (isSoftGround(t) || t === 3) soft.push([tx, ty])
        }
      }
      // AND THE MARSHY FRINGE, which is a different place from either.
      // A will-o'-the-wisp is a MARSH light — it belongs to the soft ground
      // BESIDE the water, not to the water itself. Keeping the two claims
      // apart is what lets `particles.mjs` grade them separately: mist should
      // read ~100% water and the wisps should not, and if both were spawned
      // over the same tiles neither number could say anything.
      //
      // A BAND, NOT A RING. The first cut asked for a wet ORTHOGONAL
      // NEIGHBOUR and the census answered with wisps on one seed in three:
      // this town quays its river, so the urban bank is road and stone and
      // the only soft edge is out in the countryside. A marsh is a couple of
      // tiles deep, not one, and widening it to a radius of two is both truer
      // and what takes the feature off the ghost line.
      const WET_R = 2
      for (let ty = 0; ty < tiles.length; ty++) {
        for (let tx = 0; tx < (tiles[ty]?.length ?? 0); tx++) {
          if (!isSoftGround(tiles[ty][tx])) continue
          let wet = false
          for (let dy = -WET_R; dy <= WET_R && !wet; dy++) {
            for (let dx = -WET_R; dx <= WET_R; dx++) {
              if (tiles[ty + dy]?.[tx + dx] === 3) { wet = true; break }
            }
          }
          if (wet) marsh.push([tx, ty])
        }
      }
    }

    for (let i = 0; i < fireflyCount; i++) {
      const i3 = i * 3
      let ox: number, oz: number, oy: number
      if (soft.length) {
        const [tx, ty] = soft[Math.floor(Math.random() * soft.length)]
        ox = (tx + Math.random()) * TILE
        oz = (ty + Math.random()) * TILE
        // Low, and measured from the GROUND rather than from zero. Fireflies
        // work the first metre or two of air above whatever they are over,
        // and a fixed altitude puts them underground on any rise — the mixed
        // tile/world units that sent every chimney's smoke over the wrong
        // third of the map, in its vertical form.
        const g = heightMap ? getTerrainHeight(heightMap, ox / TILE, oz / TILE) : 0
        oy = g + 0.5 + Math.random() * 1.9
      } else {
        // No terrain to ask: the old uniform scatter, so a bare map still
        // gets a field rather than nothing.
        ox = Math.random() * worldW
        oz = Math.random() * worldH
        oy = 1.5 + Math.random() * 3
      }
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
    ffPoints.name = 'fireflies'
    this.particleGroup.add(ffPoints)
    this.particleSystems.push({
      points: ffPoints, positions: ffPositions, velocities: ffVelocities,
      lifetimes: ffLifetimes, origins: ffOrigins, count: fireflyCount, type: 'firefly',
    })

    // Mist belongs to the river, so it is spawned here where the water tiles
    // were already gathered rather than walking the map a second time.
    this.initRiverMist(water, heightMap, waterLevel)
    this.initWisps(marsh, heightMap)
    this.initRises(water, heightMap, waterLevel)
    this.initEmbers(hotChimneys)
    this.initFlock(tiles, heightMap)
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
    points.name = 'birds'
    this.particleGroup.add(points)
    this.particleSystems.push({
      points, positions, velocities, lifetimes, origins, count, type: 'bird',
    })
  }

  /**
   * PIGEONS THAT SCATTER WHEN YOU WALK INTO THE SQUARE — the seventh particle
   * system, and the first thing in this town that knows the player is there.
   *
   * DESIGN.md pillar 4 is "motion breathes" and every moving thing here is
   * AMBIENT: smoke rises whoever is watching, birds circle a spire, moths
   * work a lamp, mist creeps over water. None of it acknowledges you, and a
   * world that carries on identically whether you are in it or not is
   * scenery. A flock bursting off the flagstones two metres ahead is the
   * cheapest possible answer and it is a moment people remember.
   *
   * On PLAZA tiles by preference — a square is open by construction, which is
   * both where pigeons actually are and the only ground where a startle has
   * room to read. Falling back to street cobble, because a town without a
   * designed square should still have them.
   *
   * THE FLOCK TAKES OFF TOGETHER. One bird startling alone is a bird; the
   * whole patch going up at once is the effect, so proximity is tested
   * against the GROUP's home rather than each bird's, and they are placed in
   * contiguous blocks so the group is `floor(i / PER_FLOCK)` with nothing to
   * store.
   *
   * And they SETTLE AGAIN. A flight that ends with the player still standing
   * there would drop them back into his feet, so the landing is gated on the
   * camera having moved off — they keep their distance while you are there
   * and come back to the same patch once you have passed, which is what
   * pigeons do and costs one extra condition.
   */
  private flockHomes: Float32Array | null = null

  private initFlock(tiles: number[][] | null, heightMap: number[][] | null): void {
    if (!tiles) return
    const plaza: Array<[number, number]> = []
    const street: Array<[number, number]> = []
    for (let ty = 1; ty < tiles.length - 1; ty++) {
      for (let tx = 1; tx < (tiles[ty]?.length ?? 0) - 1; tx++) {
        const t = tiles[ty][tx]
        if (t === 14) plaza.push([tx, ty])
        else if (t === 8) street.push([tx, ty])
      }
    }
    const pool = plaza.length >= 8 ? plaza : street
    if (pool.length < 8) return

    const PER_FLOCK = 7
    const FLOCKS = Math.min(4, Math.floor(pool.length / 10) || 1)
    const count = FLOCKS * PER_FLOCK
    const positions = new Float32Array(count * 3)
    const velocities = new Float32Array(count * 3)
    const lifetimes = new Float32Array(count)
    const origins = new Float32Array(count * 3)
    this.flockHomes = new Float32Array(FLOCKS * 2)

    // Spread the flocks over the pool rather than taking the first few, which
    // would put every pigeon in town in one corner — the same truncation that
    // had all the chimney smoke venting over two quarters.
    const chosen: Array<[number, number]> = [pool[0]]
    while (chosen.length < FLOCKS) {
      let best = -1, bestD = -1
      for (let i = 0; i < pool.length; i++) {
        let d = Infinity
        for (const c of chosen) {
          d = Math.min(d, (pool[i][0] - c[0]) ** 2 + (pool[i][1] - c[1]) ** 2)
        }
        if (d > bestD) { bestD = d; best = i }
      }
      if (best < 0 || bestD <= 0) break
      chosen.push(pool[best])
    }

    for (let f = 0; f < chosen.length; f++) {
      const [ctx, ctz] = chosen[f]
      const hx = (ctx + 0.5) * TILE, hz = (ctz + 0.5) * TILE
      this.flockHomes[f * 2] = hx
      this.flockHomes[f * 2 + 1] = hz
      for (let k = 0; k < PER_FLOCK; k++) {
        const i = f * PER_FLOCK + k
        const i3 = i * 3
        const a = (k / PER_FLOCK) * Math.PI * 2 + f
        const r = 0.5 + Math.random() * 1.6
        const x = hx + Math.cos(a) * r
        const z = hz + Math.sin(a) * r
        const g = heightMap ? getTerrainHeight(heightMap, x / TILE, z / TILE) : 0
        origins[i3] = x; origins[i3 + 1] = g + 0.09; origins[i3 + 2] = z
        positions[i3] = x; positions[i3 + 1] = g + 0.09; positions[i3 + 2] = z
        // Scatter bearing, climb rate, wingbeat phase.
        velocities[i3] = Math.cos(a + (Math.random() - 0.5) * 0.9)
        velocities[i3 + 1] = 0.8 + Math.random() * 0.5
        velocities[i3 + 2] = Math.sin(a + (Math.random() - 0.5) * 0.9)
        lifetimes[i] = 0
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color: 0x4a4640, size: 0.2, transparent: true, opacity: 0.9,
      sizeAttenuation: true, depthWrite: false,
    })
    const points = new THREE.Points(geo, mat)
    points.name = 'pigeons'
    this.particleGroup.add(points)
    this.particleSystems.push({
      points, positions, velocities, lifetimes, origins, count, type: 'flock',
    })
  }

  /**
   * MIST ON THE RIVER — the sixth particle system, and the one that belongs
   * to a place rather than to the whole map.
   *
   * The river arc carved a channel, walled the urban bank, quayed it, dressed
   * it and bridged it, and after dark the water is a dark ribbon with nothing
   * happening over it. Mist forms on water at night because the air cools
   * faster than the water does, so it is exactly and only a river thing —
   * which makes it the first particle system that can be GRADED on where it
   * is: `particles.mjs` reports the ground under every system, and this one
   * should read ~100% water or it is not river mist.
   *
   * Large, slow, and very faint. A mist particle that reads individually is
   * not mist, it is a ghost: the effect is the SUM, so each one is a 3m
   * radial smudge at a tenth of an opacity and there are enough of them to
   * overlap. That is also why it uses the lamp pool's texture — a hard-edged
   * square point at 3m is a box, and what a soft falloff looks like is one
   * decision this repo already made.
   *
   * Sits just above the waterline rather than at a fixed altitude, and the
   * waterline is resolved the same way TerrainMesh resolves it, because a
   * mist bank floating a metre over the surface is a cloud.
   */
  /**
   * SPARKS OFF THE HOT CHIMNEYS — someone is still working.
   *
   * The town's smoke says a hearth is lit and says it identically over a
   * parlour and a forge. `ALWAYS_SMOKING` already names the four types whose
   * whole function is COMBUSTION — smokehouse, kiln, cookshop, bakery — and a
   * fire being worked throws sparks where a banked one does not. So this is
   * the first moving thing in the town that distinguishes a TRADE from a
   * household, which is what "living city" is supposed to mean.
   *
   * AN EMBER COOLS AS IT RISES, and that is the whole look: bright yellow at
   * the flue, deep red at the top of its flight, out. The brightness carries
   * it rather than the size, so it needs a colour attribute — the same
   * mechanism the wisps needed and for the opposite reason (they breathe on
   * their own phase, these fade on their own age).
   *
   * DERIVED FROM TIME, so there is nothing to integrate and nothing to
   * respawn: each spark's age is `(t / life + phase) mod 1`, exactly the shape
   * the birds, moths and mist use.
   */
  private initEmbers(hot: THREE.Vector3[]): void {
    if (!hot.length) return
    // ENOUGH TO READ AS A PLUME. Nine sparks spread over four metres of rise
    // is a few dots; the effect is the COLUMN, which is the same argument the
    // mist makes for its own count — a single mist particle that reads on its
    // own is a ghost, and a single spark that reads on its own is a firefly.
    const PER = 15
    const stacks = Math.min(hot.length, 5)
    const count = stacks * PER
    const positions = new Float32Array(count * 3)
    const velocities = new Float32Array(count * 3)
    const lifetimes = new Float32Array(count)
    const origins = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)

    for (let ci = 0; ci < stacks; ci++) {
      const cp = hot[ci]
      for (let pi = 0; pi < PER; pi++) {
        const i = ci * PER + pi
        const i3 = i * 3
        origins[i3] = cp.x; origins[i3 + 1] = cp.y; origins[i3 + 2] = cp.z
        positions[i3] = cp.x; positions[i3 + 1] = cp.y; positions[i3 + 2] = cp.z
        // How far it gets, how long it lasts, and which way it leans.
        velocities[i3] = 1.6 + Math.random() * 2.3
        velocities[i3 + 1] = 1.5 + Math.random() * 1.7
        velocities[i3 + 2] = Math.random() * Math.PI * 2
        lifetimes[i] = Math.random()
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.PointsMaterial({
      // 0.13 IS THE PHYSICAL TRUTH AND IT IS TWO PIXELS. The isolate frame
      // showed a handful of specks barely above black — the same reading the
      // wisps gave at 0.34 and the moths gave before their orbit was widened.
      // A spark is a point SOURCE, and at `RENDER_SCALE = 0.4` a source has
      // to be drawn bigger than the thing it represents or it is not drawn.
      size: 0.46, transparent: true, opacity: 0, vertexColors: true,
      map: LAMP_POOL_TEX, sizeAttenuation: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(geo, mat)
    points.name = 'embers'
    this.particleGroup.add(points)
    this.particleSystems.push({
      points, positions, velocities, lifetimes, origins, count, type: 'ember',
    })
  }

  /**
   * WILL-O\'-THE-WISP — the first thing in this town that is not cosy.
   *
   * Every light here is warm and every moving thing is friendly: lanterns,
   * hearth smoke, fireflies, moths at a lamp, pigeons on the flagstones. A
   * town at night that is ONLY reassuring has no edge to it, and the oldest
   * folk light in Europe is the one that leads you off the path. So this is
   * cold green, it keeps to the marsh, and it is the one system that appears
   * where nobody has built anything.
   *
   * IT BELONGS TO THE BANK, NOT THE WATER. `initRiverMist` claims the surface
   * and is graded at ~100% water for exactly that reason; a wisp over the same
   * tiles would make both numbers meaningless. The marsh list is soft ground
   * with a wet neighbour — the fringe, which is where the folklore puts it and
   * where marsh gas actually comes from.
   *
   * EACH ONE BREATHES ON ITS OWN CYCLE, which needs a colour attribute rather
   * than the material's single opacity: twenty points fading together is a
   * blinking field, and twenty fading independently is a place with things
   * moving about in it. That is three floats a particle a frame on a system
   * capped at 28, which is nothing, and it is the only way to get the effect
   * without a second material per wisp.
   */
  private initWisps(
    marsh: Array<[number, number]>,
    heightMap: number[][] | null,
  ): void {
    if (marsh.length < 4) return
    // Scarce on purpose. A wisp you see three of is eerie; a wisp you see
    // forty of is a light show, which is the WALLPAPER failure with a ghost
    // story attached.
    const count = Math.min(28, Math.max(8, Math.round(marsh.length * 0.14)))
    const positions = new Float32Array(count * 3)
    const velocities = new Float32Array(count * 3)
    const lifetimes = new Float32Array(count)
    const origins = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)

    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      const [tx, tz] = marsh[Math.floor(Math.random() * marsh.length)]
      const x = (tx + Math.random()) * TILE
      const z = (tz + Math.random()) * TILE
      // From the GROUND, at about waist height — the mixed-units bug that
      // sent chimney smoke over the wrong third of the map, in its vertical
      // form, and the reason the fireflies read their height the same way.
      const g = heightMap ? getTerrainHeight(heightMap, x / TILE, z / TILE) : 0
      const y = g + 0.55 + Math.random() * 0.9
      origins[i3] = x; origins[i3 + 1] = y; origins[i3 + 2] = z
      positions[i3] = x; positions[i3 + 1] = y; positions[i3 + 2] = z
      // Drift radius, rate, phase — the same derive-from-time shape as the
      // mist and the moths, so nothing integrates and nothing respawns.
      // DRIFT RADIUS, AND IT IS KEPT SHORT ON PURPOSE. The wander is ~1.4x
      // this, so at 2.6 a wisp strays more than a tile and the census read it
      // over PAVING on a third of its samples — the firefly failure, where a
      // glow over cobbles is a dust mote rather than a marsh light. Spawning
      // exactly is not enough; the excursion has to stay on the ground the
      // system claims.
      velocities[i3] = 0.5 + Math.random() * 1.1
      velocities[i3 + 1] = 0.05 + Math.random() * 0.09
      velocities[i3 + 2] = Math.random() * Math.PI * 2
      // Its own breathing phase, deliberately slow and incommensurate with
      // the window flicker (0.25-0.7 Hz) and the star twinkle (0.18-0.40) —
      // this file already records that two periodic things at similar rates
      // read as one strobe.
      lifetimes[i] = Math.random()
      colors[i3] = 0; colors[i3 + 1] = 0; colors[i3 + 2] = 0
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.PointsMaterial({
      // BIG, BECAUSE A WISP IS A BALL OF LIGHT AND NOT A MOTE. At 0.34 the
      // isolate frame showed a line of 2-3px specks barely above black —
      // present, measurable and invisible, which is exactly the verdict the
      // moths got before their orbit was widened. A firefly is 0.08 and a
      // moth 0.085 because they are insects; this is a hovering lamp with a
      // halo, and the radial texture makes the size a soft glow rather than
      // a hard disc.
      size: 1.05, transparent: true, opacity: 0, vertexColors: true,
      map: LAMP_POOL_TEX, sizeAttenuation: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(geo, mat)
    points.name = 'wisps'
    this.particleGroup.add(points)
    this.particleSystems.push({
      points, positions, velocities, lifetimes, origins, count, type: 'wisp',
    })
  }

  /**
   * A FISH RISES — the river had mist over it, wisps beside it and bridges
   * across it, and nothing IN it.
   *
   * DROPLETS, NOT A RING, and that decision is the whole design. The obvious
   * shape is the expanding circle, and an expanding circle is a flat
   * horizontal disc — which is exactly the geometry the puddles were reverted
   * for: at eye height it foreshortens to a sliver behind the near water and
   * there is nothing left to see. A splash throws water UP, and perspective
   * cannot flatten a vertical thing.
   *
   * AN EVENT, ON A SCHEDULE, WITHOUT AN EVENT SYSTEM. Each site holds a fixed
   * point on the water and rises every 14-26 seconds; the burst is 12% of the
   * cycle and the rest is spent invisible. So this is derived from time like
   * everything else here — nothing to integrate, nothing to respawn — and it
   * still reads as something happening rather than something running. A fish
   * holding one station and coming up at it is also what a fish does.
   *
   * NO HOUR GATE, alone among the systems here. Smoke, wisps, embers, moths
   * and mist all have a time of day they belong to; a fish rises whenever it
   * likes, and a splash is bright against water at any hour.
   */
  private initRises(
    water: Array<[number, number]>,
    heightMap: number[][] | null,
    waterLevel: number[][] | null,
  ): void {
    if (water.length < 10) return
    const SITES = Math.min(10, Math.max(3, Math.round(water.length * 0.06)))
    // Nine, not six: a splash is a CROWN and four dots is a sneeze.
    const PER = 9
    const count = SITES * PER
    const positions = new Float32Array(count * 3)
    const velocities = new Float32Array(count * 3)
    const lifetimes = new Float32Array(count)
    const origins = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)

    for (let si = 0; si < SITES; si++) {
      const [tx, tz] = water[Math.floor(Math.random() * water.length)]
      const x = (tx + 0.2 + Math.random() * 0.6) * TILE
      const z = (tz + 0.2 + Math.random() * 0.6) * TILE
      // THE SURFACE, RESOLVED THE WAY TerrainMesh RESOLVES IT. Under a water
      // tile `heightAt` is the BED, which is the confusion that made the
      // river carve read land-to-bed and photograph as a canyon.
      const raw = waterLevel?.[tz]?.[tx]
      const surface = raw === undefined || Number.isNaN(raw)
        ? (heightMap ? getTerrainHeight(heightMap, x / TILE, z / TILE) : 0)
        : raw * TERRAIN_WORLD_SCALE
      const period = 14 + Math.random() * 12
      const phase = Math.random()
      for (let pi = 0; pi < PER; pi++) {
        const i = si * PER + pi
        const i3 = i * 3
        origins[i3] = x; origins[i3 + 1] = surface + 0.04; origins[i3 + 2] = z
        positions[i3] = x; positions[i3 + 1] = surface + 0.04; positions[i3 + 2] = z
        velocities[i3] = period
        // Which way this droplet leaves, and how hard.
        velocities[i3 + 1] = (pi / PER) * Math.PI * 2 + Math.random() * 0.5
        velocities[i3 + 2] = 0.55 + Math.random() * 0.75
        lifetimes[i] = phase
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const mat = new THREE.PointsMaterial({
      // 0.17 IS THREE PIXELS AT FOURTEEN METRES — the size wall, for the
      // fourth time this arc after the wisps, the moths and the embers. A
      // droplet is a point source and a point source has to be drawn bigger
      // than the thing it represents or it is not drawn at all.
      size: 0.42, transparent: true, opacity: 0.95, vertexColors: true,
      map: LAMP_POOL_TEX, sizeAttenuation: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const points = new THREE.Points(geo, mat)
    points.name = 'rises'
    this.particleGroup.add(points)
    this.particleSystems.push({
      points, positions, velocities, lifetimes, origins, count, type: 'rise',
    })
  }

  private initRiverMist(
    water: Array<[number, number]>,
    heightMap: number[][] | null,
    waterLevel: number[][] | null,
  ): void {
    if (water.length < 12) return
    // Scaled to the channel: a pond gets a wisp and a river gets a bank.
    const count = Math.min(90, Math.max(24, Math.round(water.length * 0.45)))
    const positions = new Float32Array(count * 3)
    const velocities = new Float32Array(count * 3)
    const lifetimes = new Float32Array(count)
    const origins = new Float32Array(count * 3)

    for (let i = 0; i < count; i++) {
      const i3 = i * 3
      const [tx, tz] = water[Math.floor(Math.random() * water.length)]
      const x = (tx + Math.random()) * TILE
      const z = (tz + Math.random()) * TILE
      const raw = waterLevel?.[tz]?.[tx]
      const surface = raw === undefined || Number.isNaN(raw)
        ? (heightMap ? getTerrainHeight(heightMap, x / TILE, z / TILE) : 0)
        : raw * TERRAIN_WORLD_SCALE
      const y = surface + 0.15 + Math.random() * 0.9
      origins[i3] = x; origins[i3 + 1] = y; origins[i3 + 2] = z
      positions[i3] = x; positions[i3 + 1] = y; positions[i3 + 2] = z
      // Drift radius, rate and phase. Mist does not fall or rise, it CREEPS,
      // so this is a slow closed orbit rather than an integration — same
      // shape as the birds and the moths, and for the same reason: nothing
      // to accumulate, nothing to respawn, two trig calls a particle.
      velocities[i3] = 0.9 + Math.random() * 2.4
      velocities[i3 + 1] = 0.04 + Math.random() * 0.07
      velocities[i3 + 2] = Math.random() * Math.PI * 2
      lifetimes[i] = Math.random()
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.PointsMaterial({
      color: 0xc4d2dc, size: 3.0, transparent: true, opacity: 0,
      map: LAMP_POOL_TEX, sizeAttenuation: true, depthWrite: false,
      blending: THREE.NormalBlending,
    })
    const points = new THREE.Points(geo, mat)
    points.name = 'rivermist'
    this.particleGroup.add(points)
    this.particleSystems.push({
      points, positions, velocities, lifetimes, origins, count, type: 'mist',
    })
  }

  /**
   * MOTHS AT THE LANTERNS — the fourth particle system.
   *
   * DESIGN.md pillar 4 is that motion breathes and pillar 5 asks for three
   * layers of warm light; this is the first thing that JOINS the two, because
   * every other moving thing in the town ignores where the lights are. Smoke
   * comes out of chimneys, birds circle spires, fireflies are scattered over
   * the whole map by `Math.random()`. A lantern at dusk with nothing around it
   * is a lamp; a lantern with three moths at it is a summer evening.
   *
   * A MOTH MUST NOT ORBIT CLEANLY OR IT IS A BIRD. The bird system two methods
   * up is a circle with a vertical bob, and at 4cm it would read as one small
   * bird rather than as an insect. What separates them is that a moth flies at
   * a fixed angle to the light rather than around it, which spirals it in and
   * out, and it changes direction faster than the eye tracks. So the radius
   * BREATHES on a second frequency and a much faster low-amplitude term rides
   * on top — no force integration, position derived from time exactly like the
   * birds, so it costs the same and never drifts or needs respawning.
   *
   * SPREAD THE BUDGET, DO NOT TAKE THE FIRST N. Farthest-point selection over
   * the anchors, the fix `particles.mjs` forced on chimney smoke: the anchor
   * list is built in placement order, which is spatially clustered by
   * construction, so a slice takes every moth in town from two quarters. That
   * reads as a swarm rather than as a town.
   */
  private initMoths(anchors: LampAnchor[]): void {
    if (anchors.length === 0) return
    const LAMPS = Math.min(14, anchors.length)
    // FIVE, NOT THREE. A trio reads as three dots; a moth cloud is the thing
    // that reads. The A/B triple is what forced this — three moths on the
    // widened orbit put one on the lantern, one on a dark wall behind it and
    // one out of frame, so the composite showed a single speck while the
    // isolate frame showed a perfectly healthy system. 70 particles, and
    // they cost a sin and a cos each because position derives from time.
    const PER_LAMP = 5

    // Farthest-point over the whole anchor list. O(n x 14) and n is ~140.
    const chosen: typeof anchors = [anchors[0]]
    while (chosen.length < LAMPS) {
      let best = -1, bestD = -1
      for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i]
        let d = Infinity
        for (const c of chosen) {
          const dx = a.x - c.x, dz = a.z - c.z
          d = Math.min(d, dx * dx + dz * dz)
        }
        if (d > bestD) { bestD = d; best = i }
      }
      if (best < 0 || bestD <= 0) break
      chosen.push(anchors[best])
    }

    const count = chosen.length * PER_LAMP
    const positions = new Float32Array(count * 3)
    const velocities = new Float32Array(count * 3)
    const lifetimes = new Float32Array(count)
    const origins = new Float32Array(count * 3)

    for (let l = 0; l < chosen.length; l++) {
      const lamp = chosen[l]
      for (let k = 0; k < PER_LAMP; k++) {
        const i = l * PER_LAMP + k
        const i3 = i * 3
        origins[i3] = lamp.x
        origins[i3 + 1] = lamp.y
        origins[i3 + 2] = lamp.z
        // radius: most of the anchor's allowance, jittered so three moths at
        // one lamp are on different tracks rather than in formation.
        velocities[i3] = lamp.r * (0.55 + Math.random() * 0.45)
        // Angular rate, SIGNED — half of them go the other way round, which
        // is most of what stops three moths reading as one rotating clump.
        velocities[i3 + 1] = (1.1 + Math.random() * 1.5) * (Math.random() < 0.5 ? -1 : 1)
        velocities[i3 + 2] = Math.random() * Math.PI * 2
        lifetimes[i] = Math.random()
        positions[i3] = lamp.x + velocities[i3]
        positions[i3 + 1] = lamp.y
        positions[i3 + 2] = lamp.z
      }
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    // NOT EMISSIVE. A moth is LIT BY the lantern; it is not a second light,
    // and pillar 5 accounts for exactly three layers of warm light. Warm and
    // pale rather than wing-scale grey, because grey is what a moth is in
    // daylight and not what the eye sees at a flame — the first pass used
    // 0xf2e2bd and the A/B crop read it as a dull olive fleck.
    //
    // Size is the one number here that is a RENDERING compromise rather than
    // a physical one: a moth is 3-5cm and this is 7.5, because RENDER_SCALE
    // is 0.4 and the frame is upscaled 2.5x. Stated plainly so nobody
    // "corrects" it against propscale's real-size rule, which is about props.
    const mat = new THREE.PointsMaterial({
      color: 0xffeecc, size: 0.075, transparent: true, opacity: 0,
      sizeAttenuation: true, depthWrite: false,
    })
    const points = new THREE.Points(geo, mat)
    points.name = 'moths'
    this.particleGroup.add(points)
    this.particleSystems.push({
      points, positions, velocities, lifetimes, origins, count, type: 'moth',
    })
  }

  /**
   * RAIN AND SNOW — the fifth particle system, and the first that MOVES WITH
   * THE PLAYER.
   *
   * Weather is everywhere by definition, and a town-sized volume of rain at
   * any density a person would call rain is tens of thousands of particles.
   * So this is a box around the camera that recycles: a particle that falls
   * out of the bottom, or that the player walks away from, reappears at the
   * top of the box in a new place. That is the standard technique and it is
   * indistinguishable from the real thing at any distance the fog allows you
   * to see.
   *
   * ALLOCATED ONCE AT THE MAXIMUM AND SCALED BY `count`, never rebuilt. The
   * weather controls are sliders, so a rebuild would allocate a few hundred
   * kilobytes per tick while somebody drags one — and the draw is one Points,
   * whose cost is the vertices actually in the buffer.
   *
   * Rain and snow differ in far more than speed, and getting that wrong is
   * what makes weather read as "the same particles, tinted". Rain is fast,
   * nearly vertical, and STREAKED, so the material is drawn small and the
   * length comes from the fall itself at 60Hz; snow is slow enough that the
   * eye tracks an individual flake, so it gets a wide lateral wander and a
   * much larger, softer point.
   */
  private precipMax = 900
  private precipKind: 'rain' | 'snow' | null = null
  private _rainLines: THREE.LineSegments | null = null
  private _rainSegments: Float32Array | null = null

  private initPrecipitation(): void {
    const n = this.precipMax
    const positions = new Float32Array(n * 3)
    const velocities = new Float32Array(n * 3)
    const lifetimes = new Float32Array(n)
    const origins = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const i3 = i * 3
      positions[i3] = (Math.random() - 0.5) * PRECIP_BOX
      positions[i3 + 1] = Math.random() * PRECIP_TOP
      positions[i3 + 2] = (Math.random() - 0.5) * PRECIP_BOX
      // Per-particle fall speed and a lateral phase, so nothing falls in
      // lockstep and no two flakes trace the same path.
      velocities[i3] = 0.6 + Math.random() * 0.8
      velocities[i3 + 1] = Math.random() * Math.PI * 2
      velocities[i3 + 2] = 0.5 + Math.random() * 1.0
      lifetimes[i] = Math.random()
    }
    // TWO DRAW OBJECTS, ONE SIMULATION — and this is the difference between
    // weather that reads and weather that is a live metric with a bad
    // picture. `celestial.mjs` graded rain and snow as equally live because
    // both plainly changed the frame; only the photograph said that rain
    // drawn as round dots reads as dust. A raindrop's whole silhouette is the
    // STREAK, and a Points sprite cannot be stretched, so rain is
    // LineSegments and snow is Points. One position buffer feeds both.
    //
    // LineBasicMaterial's width is locked to one pixel in WebGL, which is
    // exactly right here — a rain streak IS a hairline — and is why the
    // reverse arrangement would not work: snow as lines would be invisible.
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setDrawRange(0, 0)
    const mat = new THREE.PointsMaterial({
      color: 0xf2f6ff, size: 0.13, transparent: true, opacity: 0,
      sizeAttenuation: true, depthWrite: false,
    })
    const points = new THREE.Points(geo, mat)
    points.name = 'snowfall'
    points.frustumCulled = false // the box follows the camera; it is always in view
    this.particleGroup.add(points)

    this._rainSegments = new Float32Array(n * 6)
    const rainGeo = new THREE.BufferGeometry()
    rainGeo.setAttribute('position', new THREE.BufferAttribute(this._rainSegments, 3))
    rainGeo.setDrawRange(0, 0)
    this._rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
      color: 0xaebfd2, transparent: true, opacity: 0, depthWrite: false,
    }))
    this._rainLines.name = 'rainfall'
    this._rainLines.frustumCulled = false
    this.particleGroup.add(this._rainLines)
    this.particleSystems.push({
      points, positions, velocities, lifetimes, origins,
      count: 0, type: 'precip', cameraLocal: true,
    })
  }

  /**
   * A SHOOTING STAR — the sky is the biggest surface in this game and nothing
   * has ever happened in it.
   *
   * Pillar 1 is built on the dusk sky and pillar 4 is that motion breathes,
   * and between them the sky has acquired stars, a moon, weather and a
   * horizon — all of which are STATE. None of them is an EVENT. A thing that
   * happens once in a while, that you might miss, is a different kind of
   * delight from a thing that is always there, and it is the only kind this
   * town does not have.
   *
   * NOT A ParticleSystem, DELIBERATELY. That array is graded by
   * `particles.mjs` on whether a system's extent covers the TOWN, which is
   * the wrong question for something a hundred metres up — the same argument
   * `cameraLocal` exists for, one step further. A meteor belongs with the
   * moon and the sky dome, which are not in that array either.
   *
   * AND IT FLIES OVER THE CAMERA, not over the map. A rare event that happens
   * out of frame has not happened: the whole value is in being SEEN, so the
   * flight is centred on the player with a random bearing. That is also the
   * truth of it — a real meteor is overhead, not somewhere on the far side of
   * the parish.
   */
  private _meteor: THREE.LineSegments | null = null
  private _meteorHead: THREE.Points | null = null
  private _meteorCols: Float32Array | null = null
  private _meteorPos: Float32Array | null = null
  private _meteorT = -1
  private _meteorNext = 9
  private _meteorFrom = new THREE.Vector3()
  private _meteorDir = new THREE.Vector3()
  /** 1 at night, 0.5 at the dusk and dawn edges, 0 in daylight. Set by
   *  updateLighting so the schedule has one source for "is the sky dark". */
  private _nightness = 0
  private static readonly METEOR_SEGS = 9

  private initMeteor(): void {
    const n = ThreeRenderer.METEOR_SEGS
    const pos = new Float32Array(n * 6)
    const col = new Float32Array(n * 6)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
    const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }))
    line.name = 'meteor'
    // The trail is rebuilt in world space every frame and the camera can be
    // anywhere, so culling it against a stale bounding sphere drops it.
    line.frustumCulled = false
    line.visible = false
    this.scene.add(line)
    this._meteor = line
    this._meteorPos = pos
    this._meteorCols = col

    // A BURNING HEAD, because WebGL locks line width to one pixel. That is
    // exactly right for a rain streak — this file already says so — and it
    // is not enough for a meteor: at `RENDER_SCALE = 0.4` a 1px additive
    // line over a dark blue sky is a thread you have to know to look for.
    // What a meteor actually has is a bright point with the trail behind it,
    // so the halo does the seeing and the line does the direction.
    const headGeo = new THREE.BufferGeometry()
    headGeo.setAttribute('position',
      new THREE.BufferAttribute(new Float32Array(3), 3))
    const head = new THREE.Points(headGeo, new THREE.PointsMaterial({
      // SCREEN-SPACE, NOT WORLD-SPACE. `sizeAttenuation` divides by distance,
      // and this thing is 90-140m up: at a world size of 2.6 the head came
      // out two pixels across and the whole point of it — being unmistakable
      // against a star field that itself renders as 1px dashes — was lost.
      // A meteor is a POINT SOURCE, so it wants a fixed apparent size, which
      // is how the stars are drawn for the same reason.
      color: 0xfff4e2, size: 11, transparent: true, opacity: 0,
      map: LAMP_POOL_TEX, sizeAttenuation: false, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }))
    head.name = 'meteorHead'
    head.frustumCulled = false
    head.visible = false
    this.scene.add(head)
    this._meteorHead = head
  }

  /**
   * Put every rise site into its burst NOW.
   *
   * A site rises for 12% of a 14-26 second cycle, so a still lands on an
   * empty river four times in five and the isolate frame comes back black —
   * which reads exactly like "your geometry does not exist". That is the
   * meteor problem, and the meteor already has `fireMeteor` for it; building
   * a rare event without the hook that lets a camera see it is how content
   * ships on trust.
   *
   * Rewrites each site's PHASE rather than its position, so the system stays
   * on its derived-from-time path and simply resumes its own schedule after.
   */
  burstRises(): number {
    const ps = this.particleSystems.find((p) => p.type === 'rise')
    if (!ps) return 0
    const t = this.clock.elapsedTime
    for (let i = 0; i < ps.count; i++) {
      const period = ps.velocities[i * 3]
      // Land u at 0.03 — just past the surface, where it is brightest.
      ps.lifetimes[i] = ((0.03 - t / period) % 1 + 1) % 1
    }
    return ps.count
  }

  /** Where the sun/moon disc is right now, in world space. Exposed so no tool
   *  has to restate it — see the bridge comment on `moonPos`. */
  debugMoonPos(): { x: number; y: number; z: number } | null {
    if (!this.sunDisc) return null
    const p = this.sunDisc.position
    return { x: p.x, y: p.y, z: p.z }
  }

  /** Start a flight now. Exposed on the debug bridge because a feature that
   *  fires once every half-minute cannot be photographed by waiting. */
  fireMeteor(): { x: number; y: number; z: number } | null {
    if (!this._meteor) return null
    const cam = this.camera.position
    // High, and crossing rather than falling: a meteor's whole silhouette is
    // the streak, and a steep one is on screen for a few frames.
    //
    // AND BIASED TOWARD THE HALF OF THE SKY THE PLAYER IS FACING. A uniform
    // bearing is the honest simulation and it is the wrong DESIGN, because a
    // rare event that happens behind you has not happened at all — the same
    // reasoning that puts the flight over the camera rather than over the map.
    // A 130-degree arc is wide enough that it never reads as scripted and
    // narrow enough that looking up is worth doing.
    const bearing = this.cameraYaw + (Math.random() - 0.5) * 2.3
    const alt = 92 + Math.random() * 46
    const span = 150
    this._meteorFrom.set(
      cam.x + Math.cos(bearing) * span * 0.5,
      alt + 26,
      cam.z + Math.sin(bearing) * span * 0.5)
    this._meteorDir.set(
      -Math.cos(bearing) * span, -(20 + Math.random() * 26),
      -Math.sin(bearing) * span).normalize()
    this._meteorT = 0
    // The flight's midpoint, so a tool can point a camera at the subject
    // rather than at a guess. `celestial.mjs` went from "DEAD" to 1700x the
    // noise floor on nothing but where it looked.
    return {
      x: this._meteorFrom.x + this._meteorDir.x * 95,
      y: this._meteorFrom.y + this._meteorDir.y * 95,
      z: this._meteorFrom.z + this._meteorDir.z * 95,
    }
  }

  /** One flight, then a wait. Nothing to allocate and nothing to recycle. */
  private updateMeteor(dt: number): void {
    const line = this._meteor
    const pos = this._meteorPos
    const col = this._meteorCols
    if (!line || !pos || !col) return
    if (this._meteorT < 0) {
      // SCARCE, AND ONLY WHEN THE SKY IS DARK. Often enough that a player who
      // stands and looks up will see one; rare enough that it stays an event.
      if (this._nightness <= 0) return
      this._meteorNext -= dt * this._nightness
      if (this._meteorNext > 0) return
      this._meteorNext = 17 + Math.random() * 26
      this.fireMeteor()
      return
    }
    const LIFE = 1.15
    this._meteorT += dt
    if (this._meteorT > LIFE) {
      this._meteorT = -1
      line.visible = false
      if (this._meteorHead) this._meteorHead.visible = false
      return
    }
    const u = this._meteorT / LIFE
    // Fade in fast, out slow — a meteor brightens as it burns and dies away.
    const bright = Math.min(1, u * 7) * (1 - u * u)
    const speed = 190
    const headD = u * speed
    const TAIL = 26
    const n = ThreeRenderer.METEOR_SEGS
    for (let k = 0; k < n; k++) {
      const d0 = headD - (k / n) * TAIL
      const d1 = headD - ((k + 1) / n) * TAIL
      const o = k * 6
      for (let e = 0; e < 2; e++) {
        const d = e === 0 ? d0 : d1
        pos[o + e * 3] = this._meteorFrom.x + this._meteorDir.x * d
        pos[o + e * 3 + 1] = this._meteorFrom.y + this._meteorDir.y * d
        pos[o + e * 3 + 2] = this._meteorFrom.z + this._meteorDir.z * d
        // Head white-hot, tail cooling to blue and out. The taper is what
        // makes it a meteor rather than a moving dash.
        const f = Math.max(0, 1 - (k + e) / n)
        const g = f * f * bright
        col[o + e * 3] = g
        col[o + e * 3 + 1] = g * 0.94
        col[o + e * 3 + 2] = g * 0.86 + f * 0.10 * bright
      }
    }
    ;(line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
    ;(line.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true
    ;(line.material as THREE.LineBasicMaterial).opacity = 1
    line.visible = true
    const head = this._meteorHead
    if (head) {
      const hp = head.geometry.getAttribute('position') as THREE.BufferAttribute
      const a = hp.array as Float32Array
      a[0] = this._meteorFrom.x + this._meteorDir.x * headD
      a[1] = this._meteorFrom.y + this._meteorDir.y * headD
      a[2] = this._meteorFrom.z + this._meteorDir.z * headD
      hp.needsUpdate = true
      ;(head.material as THREE.PointsMaterial).opacity = bright
      head.visible = true
    }
  }

  /** Point the one precipitation system at a kind and a rate. */
  private setPrecipitation(kind: 'rain' | 'snow' | null, rate: number): void {
    const ps = this.particleSystems.find((p) => p.type === 'precip')
    if (!ps) return
    this.precipKind = kind
    const n = kind ? Math.round(this.precipMax * Math.max(0, Math.min(1, rate))) : 0
    ps.count = n
    const snowMat = ps.points.material as THREE.PointsMaterial
    const rainMat = this._rainLines?.material as THREE.LineBasicMaterial | undefined
    // Exactly one of the two draws. The simulation runs either way and the
    // other object is left at zero opacity AND zero draw range, so a weather
    // switch cannot leave the previous one's last frame hanging in the air.
    snowMat.opacity = kind === 'snow' && n > 0 ? 0.85 : 0
    if (rainMat) rainMat.opacity = kind === 'rain' && n > 0 ? 0.62 : 0
    ps.points.geometry.setDrawRange(0, kind === 'snow' ? n : 0)
    this._rainLines?.geometry.setDrawRange(0, kind === 'rain' ? n * 2 : 0)
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
        // Birds are only visible during the dusk window; skip the orbit
        // integration and buffer upload entirely outside that window. The
        // opacity assignment itself moved to updateLighting() — no point
        // recomputing it 60 Hz from a value that changes at sub-Hz rates.
        const mat = ps.points.material as THREE.PointsMaterial
        if (mat.opacity <= 0) continue
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
        continue
      }

      // Precipitation: the one system that INTEGRATES and the one that moves
      // with the player. Both are forced by what weather is — it falls, so it
      // cannot derive from a closed form the way an orbit can, and it is
      // everywhere, so it cannot sit over the town.
      if (ps.type === 'precip') {
        if (ps.count === 0) continue
        const cam = this.camera.position
        const snow = this.precipKind === 'snow'
        // Snow drifts and rain does not. A rain streak that wanders reads as
        // ash; a flake that falls straight reads as a dropped pixel.
        const fall = snow ? 1.1 : 13.0
        const drift = snow ? 0.55 : 0.05
        const half = PRECIP_BOX / 2
        for (let i = 0; i < ps.count; i++) {
          const i3 = i * 3
          pos[i3 + 1] -= dt * fall * vel[i3]
          if (snow) {
            // Two frequencies, phase per flake, so no two paths coincide.
            const ph = vel[i3 + 1]
            pos[i3] += dt * drift * (Math.sin(time * 0.7 + ph) + 0.4 * Math.sin(time * 1.9 + ph * 2))
            pos[i3 + 2] += dt * drift * (Math.cos(time * 0.6 + ph) + 0.4 * Math.cos(time * 2.1 + ph))
          } else {
            pos[i3] += dt * drift * windX
            pos[i3 + 2] += dt * drift * windZ
          }
          // RECYCLE AGAINST THE CAMERA, not against a fixed origin. Wrapping
          // on the relative offset is what makes the box travel: a particle
          // the player has walked past reappears on the side they are walking
          // toward, so the volume is always centred on them and no particle
          // is ever wasted behind them.
          let rx = pos[i3] - cam.x, rz = pos[i3 + 2] - cam.z
          if (rx > half) rx -= PRECIP_BOX; else if (rx < -half) rx += PRECIP_BOX
          if (rz > half) rz -= PRECIP_BOX; else if (rz < -half) rz += PRECIP_BOX
          pos[i3] = cam.x + rx
          pos[i3 + 2] = cam.z + rz
          if (pos[i3 + 1] < cam.y - PRECIP_TOP * 0.45) {
            pos[i3 + 1] = cam.y + PRECIP_TOP * 0.55
            // A recycled particle gets a NEW x/z too. Reusing the column it
            // fell down would make every drop trace one line forever, which
            // reads as a static texture the moment you stand still.
            pos[i3] = cam.x + (Math.random() - 0.5) * PRECIP_BOX
            pos[i3 + 2] = cam.z + (Math.random() - 0.5) * PRECIP_BOX
          }
        }
        if (snow) {
          const attr = ps.points.geometry.getAttribute('position') as THREE.BufferAttribute
          attr.needsUpdate = true
        } else if (this._rainSegments && this._rainLines) {
          // Build the streaks from the same positions. Length is the distance
          // the drop covers in ~4 frames, so it lengthens with the fall speed
          // rather than being a constant that looks right at one wind only.
          const seg = this._rainSegments
          for (let i = 0; i < ps.count; i++) {
            const i3 = i * 3, s6 = i * 6
            const len = 0.065 * fall * vel[i3]
            seg[s6] = pos[i3]; seg[s6 + 1] = pos[i3 + 1]; seg[s6 + 2] = pos[i3 + 2]
            seg[s6 + 3] = pos[i3] - windX * drift * 0.4
            seg[s6 + 4] = pos[i3 + 1] + len
            seg[s6 + 5] = pos[i3 + 2] - windZ * drift * 0.4
          }
          const rattr = this._rainLines.geometry.getAttribute('position') as THREE.BufferAttribute
          rattr.needsUpdate = true
        }
        continue
      }

      // Pigeons: the only system whose state depends on WHERE THE PLAYER IS.
      if (ps.type === 'flock') {
        const cam = this.camera.position
        const PER_FLOCK = 7
        const STARTLE = 5.5      // metres — close enough to feel deliberate
        const SETTLE = 8.0       // and they will not land back inside you
        const flocks = this.flockHomes
        for (let i = 0; i < ps.count; i++) {
          const i3 = i * 3
          const f = Math.floor(i / PER_FLOCK)
          const hx = flocks ? flocks[f * 2] : orig[i3]
          const hz = flocks ? flocks[f * 2 + 1] : orig[i3 + 2]
          const near = Math.hypot(cam.x - hx, cam.z - hz)
          // THE WHOLE FLOCK GOES AT ONCE. Testing each bird's own position
          // would ripple the takeoff across the patch, which reads as a bug
          // rather than as a flock.
          if (life[i] === 0 && near < STARTLE) life[i] = 0.001
          if (life[i] === 0) {
            pos[i3] = orig[i3]; pos[i3 + 1] = orig[i3 + 1]; pos[i3 + 2] = orig[i3 + 2]
            continue
          }
          life[i] += dt * 0.34
          if (life[i] >= 1) {
            // Only settle once the player has actually moved off, or they
            // land in his feet and take off again forever.
            if (near > SETTLE) { life[i] = 0; continue }
            life[i] = 0.55            // hold a wide circle instead
          }
          const t = life[i]
          const climb = Math.sin(Math.min(1, t * 1.7) * Math.PI * 0.5)
          const out = t * 13
          pos[i3] = orig[i3] + vel[i3] * out
          pos[i3 + 2] = orig[i3 + 2] + vel[i3 + 2] * out
          // Wingbeat on the way up: a dot that rises smoothly is a balloon.
          pos[i3 + 1] = orig[i3 + 1] + climb * 5.2 * vel[i3 + 1]
            + Math.sin(time * 11 + i) * 0.09 * climb
        }
        const attr = ps.points.geometry.getAttribute('position') as THREE.BufferAttribute
        attr.needsUpdate = true
        continue
      }

      // Rises: a short burst on a long cycle, invisible the rest of the time.
      if (ps.type === 'rise') {
        const cAttr = ps.points.geometry.getAttribute('color') as THREE.BufferAttribute
        const col = cAttr.array as Float32Array
        const BURST = 0.12
        for (let i = 0; i < ps.count; i++) {
          const i3 = i * 3
          const period = vel[i3], ang = vel[i3 + 1], force = vel[i3 + 2]
          const u = (time / period + life[i]) % 1
          if (u > BURST) {
            // Parked at the surface and black, which under AdditiveBlending
            // draws nothing at all — cheaper than toggling a draw range and
            // it keeps every particle on the same derived-from-time path.
            col[i3] = 0; col[i3 + 1] = 0; col[i3 + 2] = 0
            pos[i3] = orig[i3]; pos[i3 + 1] = orig[i3 + 1]; pos[i3 + 2] = orig[i3 + 2]
            continue
          }
          const b = u / BURST
          // Up and back down in one arc, spreading as it goes.
          const r = b * 0.34 * force
          pos[i3] = orig[i3] + Math.cos(ang) * r
          pos[i3 + 2] = orig[i3 + 2] + Math.sin(ang) * r
          pos[i3 + 1] = orig[i3 + 1] + Math.sin(b * Math.PI) * 0.42 * force
          // Brightest at the instant it breaks the surface.
          const g = (1 - b) * 0.95
          col[i3] = g * 0.78
          col[i3 + 1] = g * 0.90
          col[i3 + 2] = g
        }
        const attr = ps.points.geometry.getAttribute('position') as THREE.BufferAttribute
        attr.needsUpdate = true
        cAttr.needsUpdate = true
        continue
      }

      // Embers: derived from age, so nothing integrates and nothing respawns.
      // They cool as they climb — the colour does the work, not the size.
      if (ps.type === 'ember') {
        const mat = ps.points.material as THREE.PointsMaterial
        if (mat.opacity <= 0) continue
        const cAttr = ps.points.geometry.getAttribute('color') as THREE.BufferAttribute
        const col = cAttr.array as Float32Array
        for (let i = 0; i < ps.count; i++) {
          const i3 = i * 3
          const rise = vel[i3], span = vel[i3 + 1], phase = vel[i3 + 2]
          const u = (time / span + life[i]) % 1
          pos[i3 + 1] = orig[i3 + 1] + u * rise
          // Spreading as it goes, because a spark rides the column out — a
          // vertical line of them reads as a fountain rather than a fire.
          const spread = u * 0.42
          pos[i3] = orig[i3] + Math.cos(phase + u * 3.1) * spread
          pos[i3 + 2] = orig[i3 + 2] + Math.sin(phase + u * 2.6) * spread
          // Yellow-hot at the flue, red at the top, out. The flicker is fast
          // on purpose: this is the one thing in the town that SHOULD read as
          // a sputter rather than as a breath.
          // Cooling, but not SQUARED — that put two thirds of every spark's
          // life below a fifth of its brightness, so most of the population
          // was invisible at any instant and the flue read as almost empty.
          const cool = Math.max(0, 1 - u)
          const g = Math.pow(cool, 1.25) * (0.78 + 0.22 * Math.sin(time * 9 + phase * 5))
          col[i3] = g
          col[i3 + 1] = g * (0.30 + 0.45 * cool)
          col[i3 + 2] = g * 0.09 * cool
        }
        const attr = ps.points.geometry.getAttribute('position') as THREE.BufferAttribute
        attr.needsUpdate = true
        cAttr.needsUpdate = true
        continue
      }

      // Wisps: a slow wander with each light breathing on its own cycle.
      // The COLOUR carries the pulse rather than the material's opacity,
      // because one opacity for the whole system is a field that blinks in
      // unison — a metronome, not a marsh. Same argument as giving every
      // lantern along a street its own sway phase.
      if (ps.type === 'wisp') {
        const mat = ps.points.material as THREE.PointsMaterial
        if (mat.opacity <= 0) continue
        const cAttr = ps.points.geometry.getAttribute('color') as THREE.BufferAttribute
        const col = cAttr.array as Float32Array
        for (let i = 0; i < ps.count; i++) {
          const i3 = i * 3
          const r = vel[i3], w = vel[i3 + 1], phase = vel[i3 + 2]
          const a = time * w + phase
          // Two incommensurate terms, so the path never closes visibly and
          // the thing reads as wandering rather than orbiting.
          pos[i3] = orig[i3] + Math.cos(a) * r + Math.sin(a * 0.37 + phase) * r * 0.4
          pos[i3 + 2] = orig[i3 + 2] + Math.sin(a * 0.8) * r
            + Math.cos(a * 0.29 + phase) * r * 0.4
          pos[i3 + 1] = orig[i3 + 1] + Math.sin(a * 1.7 + phase) * 0.22
          // 0.11-0.19 Hz, well below the window flicker and the star twinkle
          // so nothing beats against anything. Never fully out: a wisp that
          // vanishes reads as a dropped frame.
          const br = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(
            time * (0.7 + life[i] * 0.5) + life[i] * 6.283))
          // SATURATED, because additive light plus ACES pulls everything
          // toward white and the first values came back as pale grey blobs.
          // The entire argument for this system is a COLD light in a town
          // whose every other light is amber, so the green has to survive the
          // tone curve rather than merely be specified.
          col[i3] = 0.16 * br
          col[i3 + 1] = 0.95 * br
          col[i3 + 2] = 0.46 * br
        }
        const attr = ps.points.geometry.getAttribute('position') as THREE.BufferAttribute
        attr.needsUpdate = true
        cAttr.needsUpdate = true
        continue
      }

      // Mist: a very slow closed orbit, so it CREEPS rather than falling or
      // rising. Same derive-from-time shape as the birds and the moths.
      if (ps.type === 'mist') {
        const mat = ps.points.material as THREE.PointsMaterial
        if (mat.opacity <= 0) continue
        for (let i = 0; i < ps.count; i++) {
          const i3 = i * 3
          const r = vel[i3], w = vel[i3 + 1], phase = vel[i3 + 2]
          const a = time * w + phase
          pos[i3] = orig[i3] + Math.cos(a) * r
          pos[i3 + 2] = orig[i3 + 2] + Math.sin(a * 0.8 + phase) * r
          // Barely any vertical travel. Mist that bobs reads as smoke.
          pos[i3 + 1] = orig[i3 + 1] + Math.sin(a * 1.3) * 0.12
        }
        const attr = ps.points.geometry.getAttribute('position') as THREE.BufferAttribute
        attr.needsUpdate = true
        continue
      }

      // Moths: same derive-from-time shape as the birds above, and skipped
      // outright whenever the lanterns are not lit.
      if (ps.type === 'moth') {
        const mat = ps.points.material as THREE.PointsMaterial
        if (mat.opacity <= 0) continue
        for (let i = 0; i < ps.count; i++) {
          const i3 = i * 3
          const r = vel[i3], w = vel[i3 + 1], phase = vel[i3 + 2]
          const seed = life[i]
          const a = time * w + phase
          // The radius BREATHES — a moth darts at the flame and falls back
          // out rather than holding a circle. This is the term that stops it
          // reading as a small bird.
          const rr = r * (0.5 + 0.5 * Math.sin(a * 2.3 + seed * 6.283))
          // And a much faster, much smaller term for the direction changes
          // the eye cannot follow. Two incommensurate frequencies, so the
          // path never visibly repeats.
          pos[i3] = orig[i3] + Math.cos(a) * rr + Math.sin(a * 5.7 + seed * 11) * r * 0.18
          pos[i3 + 2] = orig[i3 + 2] + Math.sin(a) * rr + Math.cos(a * 6.9 + seed * 7) * r * 0.18
          pos[i3 + 1] = orig[i3 + 1] + Math.sin(a * 3.1 + seed * 5) * 0.14
        }
        const attr = ps.points.geometry.getAttribute('position') as THREE.BufferAttribute
        attr.needsUpdate = true
        continue
      }

      // Fireflies: effectively invisible during the day (opacity 0.05). Skip
      // the jitter integration AND the buffer re-upload — nobody can see
      // them and they respawn from orig on each cycle anyway. Opacity and
      // material attributes are set once per TOD change in updateLighting.
      if (ps.type === 'firefly') {
        const mat = ps.points.material as THREE.PointsMaterial
        if (mat.opacity < 0.1) continue
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
      // The hanging content sways on the SAME clock as everything else that
      // breathes, so the wind cannot drift out of step with the smoke.
      tickHangingSway(t)
      tickWater(t)
      this.updateMeteor(dt)
      // The stars twinkle beside the windows and the water, which is the
      // company they should keep: pillar 4 is "motion breathes", and every
      // one of these is slow enough to read as alive rather than as a pulse.
      if (this.skyUniforms) this.skyUniforms.uTime.value = t
      if (this.skyMesh) this.skyMesh.position.copy(this.camera.position)
      // Shadow target follows the player so the tight ortho bounds
      // rasterize meshes near the camera, not the whole town. We
      // only update when the player has moved more than ~2m on the
      // ground plane — the shadow camera's frustum is 28m wide so
      // a 2m delta is well below where the cutoff edges become
      // visible, but the savings on every "stationary" frame add up.
      // The matrix update + light position recompute happens at most
      // ~once per second of walking; mostly never while standing still.
      if (this.sunLight.shadow.camera && this.renderer?.shadowMap.enabled) {
        const cx = this.camera.position.x
        const cz = this.camera.position.z
        const dx = cx - this._shadowFollowLastX
        const dz = cz - this._shadowFollowLastZ
        if (dx * dx + dz * dz > 4) {        // > 2m moved
          const sunDir = this._scratchSunDir
            .copy(this.sunLight.position)
            .sub(this.sunLight.target.position)
            .normalize()
          this.sunLight.target.position.set(cx, 0, cz)
          this.sunLight.position.copy(this.sunLight.target.position).add(sunDir.multiplyScalar(50))
          this.sunLight.target.updateMatrixWorld()
          this.sunLight.shadow.camera.updateMatrixWorld()
          // Shadow contents changed (different region of town now in
          // the frustum) → kick the shadow map to redraw this frame.
          if (this.renderer) this.renderer.shadowMap.needsUpdate = true
          this._shadowFollowLastX = cx
          this._shadowFollowLastZ = cz
        }
      }
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

  /** Ground height under a WORLD position, following the slope.
   *
   *  This used to floor x and z before sampling, which threw away the
   *  triangle interpolation getTerrainHeight exists to provide and snapped the
   *  camera to whichever tile corner it was standing nearest. The player's
   *  eye then jumped by the full tile rise at each boundary instead of walking
   *  up the slope — and at 3m tiles you get three metres of travel between
   *  steps, so it reads as the ground lurching. */
  /**
   * The TERRAIN surface. What the ground mesh draws, and nothing else.
   *
   * Kept separate from `sampleGroundY` on purpose. `debugHeightAt` — and so
   * `__pt.heightAt`, which river.mjs, relief.mjs, rivershot.mjs and
   * bridgeshot.mjs all read as "the ground" — must keep meaning the terrain.
   * Folding decks into it would have silently redefined that word for five
   * tools at once, which is how three copies of the terrain table drifted into
   * disagreeing about what a tile MEANS.
   */
  private terrainYAt(x: number, z: number): number {
    if (!this.terrainHeightMap) return 0
    return groundYAtWorld(this.terrainHeightMap, x, z)
  }

  /**
   * WHAT THE PLAYER IS STANDING ON — terrain, or a deck above it.
   *
   * This used to be the terrain alone, so no structure was ever a floor. The
   * collision mask said a bridge tile was walkable (the `passage` tag clears
   * it) and then the ground-follow put the player on the river bed two metres
   * beneath the deck. Two authors of one floor, and tools/traverse.mjs put a
   * number on it: 58% of a town reachable on foot.
   *
   * `walkSurface` is a per-tile map built from volumes the templates DECLARE
   * walkable, so a roof or a wall top can never become a floor by accident.
   *
   * SINGLE LEVEL, and that is a real limitation rather than an oversight: it
   * takes the max of terrain and deck, so if a walkway is ever thrown over a
   * street the player would be lifted onto it while walking underneath. Only
   * crossings declare `walkable` today and a crossing has nothing beneath it
   * but water. A second level needs a query that knows which one you are on.
   */
  private sampleGroundY(x: number, z: number): number {
    const terrain = this.terrainYAt(x, z)
    const w = this.walkSurface
    if (!w) return terrain
    const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE)
    if (tx < 0 || tz < 0 || tx >= this.gridW || tz >= this.gridH) return terrain
    const deck = w[tz * this.gridW + tx]
    return deck > terrain ? deck : terrain
  }

  /**
   * Is a player standing at this WORLD position clipping anything solid?
   *
   * The old version floored the position to a single tile index and tested
   * that one cell. The player therefore had no radius at all — a dimensionless
   * point in tile space. Standing with your nose in a wall was legal as long
   * as your centre was on the open tile, and on the far side of the same tile
   * you were stopped a full tile early. That asymmetry is what got reported as
   * "collision feels random", and it got worse with 3m tiles, which is the
   * error bar on a point test.
   *
   * Now the player is a disc of PLAYER_RADIUS metres and every tile its
   * bounding square touches has to be clear. Out-of-bounds counts as blocked
   * so you cannot walk off the map.
   */
  private isBlocked(x: number, z: number): boolean {
    if (!this.collisionMask) return false
    const rTiles = PLAYER_RADIUS / TILE
    const tx = x / TILE, tz = z / TILE
    const ix0 = Math.floor(tx - rTiles), ix1 = Math.floor(tx + rTiles)
    const iz0 = Math.floor(tz - rTiles), iz1 = Math.floor(tz + rTiles)
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (ix < 0 || ix >= this.gridW || iz < 0 || iz >= this.gridH) return true
        if (this.collisionMask[iz * this.gridW + ix] !== 0) return true
      }
    }
    return false
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
    // Touch stick, in the same frame as the keys so both can drive movement
    // and neither needs to know about the other. It is analog, so a small
    // thumb offset walks slowly — but `mag` below normalises the direction,
    // which would throw that away, so the magnitude is applied separately.
    if (this._touchMoveX !== 0 || this._touchMoveY !== 0) {
      dx += fwdX * -this._touchMoveY + rightX * this._touchMoveX
      dz += fwdZ * -this._touchMoveY + rightZ * this._touchMoveX
    }
    // Normalize diagonal movement so strafing isn't faster.
    const mag = Math.hypot(dx, dz)
    if (mag > 0) {
      // Analog throttle from the touch stick; 1.0 for keyboard input.
      const throttle = this._touchThrottle > 0 ? this._touchThrottle : 1
      const stepX = (dx / mag) * moveSpeed * throttle
      const stepZ = (dz / mag) * moveSpeed * throttle
      // Fly mode and "no map loaded" bypass collision — walk-mode does
      // a 3-try axis-slide: full move → X-only → Z-only → stay put.
      // The probe used to reach 0.3 ahead to compensate for the player having
      // no radius. isBlocked now tests an actual disc, so this is back to
      // being nothing more than a numerical nudge.
      if (this.flyMode || !this.collisionMask) {
        this.camera.position.x += stepX
        this.camera.position.z += stepZ
      } else {
        const EPS = 0.02
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
      // Building factory diagnostics from the most recent rebuild — failures
      // are captured per-building and surfaced here so debug-dumps include
      // any per-building runtime errors.
      buildingFactory: getBuildingDiagnostics(),
      propSizes,
    }
  }

  // === Debug hooks (used by the window.__pt bridge / headless tooling) ===

  /** Terrain surface height at a world x/z — the same sample placement uses. */
  debugHeightAt(x: number, z: number): number {
    return this.terrainYAt(x, z)
  }

  /** What a PLAYER standing here would be on: terrain, or a deck above it. */
  debugStandAt(x: number, z: number): number {
    return this.sampleGroundY(x, z)
  }

  /**
   * EVERY structure and prop as a feature vector, for tools/odd.mjs.
   *
   * The outlier hunt needs one row per thing with enough numbers on it to ask
   * "is this unlike its peers", and it must come from the BUILT scene rather
   * than from the map, because the whole point is to catch what the pipeline
   * did rather than what the generator intended. BuildingFactory records the
   * aggregates where the massing is in scope (see BuildingTop) and PropFactory
   * records each prop's emitted box and its gap to the ground.
   */
  debugSceneFeatures(): { structures: unknown[]; props: unknown[]; volumes: unknown[]; facade: unknown[] } {
    const structures: unknown[] = []
    for (const t of this._buildingTops.values()) {
      const box = this.debugStructureBox(t.id)
      structures.push({
        id: t.id, def: t.definitionId, district: t.district,
        x: t.originX, z: t.originZ,
        baseY: t.baseY,
        height: +(t.apexY - t.baseY).toFixed(2),
        wallTop: +(t.mainWallTopY - t.baseY).toFixed(2),
        // The MAIN BODY's own roof, as distinct from everything stacked above
        // it. eyeball's roof-to-wall ratio used apex-minus-wallTop, which also
        // counts a tower or a spire sitting on the building — so capping roof
        // RISE moved it by one point and I nearly concluded the clamp did
        // nothing. Two different questions wearing one number.
        roofH: +t.mainRoofH.toFixed(2),
        spanW: +(t.spanHalfW * 2).toFixed(2), spanD: +(t.spanHalfD * 2).toFixed(2),
        volumes: t.volumeCount,
        texturedVolumes: t.texturedVolumes,
        wallArea: t.wallArea, texturedArea: t.texturedArea,
        roofStyles: t.roofStyles,
        box,
      })
    }
    return {
      structures, props: propInstances.map((p) => ({ ...p })),
      volumes: volumeBoxes.map((v) => ({ ...v })),
      facade: facadeParts.map((f) => ({ ...f })),
    }
  }

  /**
   * The world-space box of one placed structure, by object id.
   *
   * Every "photograph this thing" tool has re-derived this from the tile
   * footprint plus a guessed height, and a guessed height is what stood a
   * camera under a bridge deck and inside a house. BuildingFactory already
   * computes the real extents for the particle systems (see BuildingTop);
   * this only publishes them, which is the same anchor argument that
   * `PlacedObject.footprint` settled for placement.
   */
  debugStructureBox(id: string): { min: [number, number, number]; max: [number, number, number] } | null {
    const t = this._buildingTops.get(id)
    if (!t) return null
    // Half-extents are recorded before yaw, so take the axis-aligned bound of
    // the rotated rectangle — a 45-degree building must not report a box its
    // own corners stick out of.
    const c = Math.abs(Math.cos(t.rotationY)), s = Math.abs(Math.sin(t.rotationY))
    const hx = t.spanHalfW * c + t.spanHalfD * s
    const hz = t.spanHalfW * s + t.spanHalfD * c
    // About the ORIGIN, not the main body — for a bridge the main body is one
    // pier at one end of the span, and a box centred there frames the pier.
    const baseY = this.terrainYAt(t.originX, t.originZ)
    return {
      min: [t.originX - hx, Math.min(baseY, t.mainWallTopY - 0.5), t.originZ - hz],
      max: [t.originX + hx, t.apexY, t.originZ + hz],
    }
  }

  /**
   * Vertical extent of the built scene. `maxY` is the tallest point in town —
   * a blunt but effective regression signal for runaway geometry (a single
   * needle spire pushes it into the tens of metres above everything else).
   */
  debugSceneStats(): Record<string, unknown> {
    const box = new THREE.Box3()
    const tops: number[] = []
    for (const group of [this.buildingGroup, this.propGroup]) {
      // Most scene objects run with matrixAutoUpdate=false, so their world
      // matrices can be stale when this is called from tooling — which made
      // maxY jump around between runs on an identical seed. Force them
      // current before measuring.
      group.updateMatrixWorld(true)
      for (const child of group.children) {
        box.setFromObject(child)
        if (isFinite(box.max.y)) tops.push(box.max.y)
      }
    }
    tops.sort((a, b) => b - a)
    const terrainTop = this.terrainHeightMap
      ? Math.max(...this.terrainHeightMap.flat()) * TERRAIN_WORLD_SCALE
      : 0
    return {
      maxY: tops.length ? +tops[0].toFixed(2) : 0,
      top10: tops.slice(0, 10).map((v) => +v.toFixed(2)),
      medianTop: tops.length ? +tops[Math.floor(tops.length / 2)].toFixed(2) : 0,
      terrainTop: +terrainTop.toFixed(2),
      meshes: tops.length,
    }
  }

  /** Stand the walk camera on the ground at a world x/z. */
  debugTeleport(x: number, z: number): { x: number; y: number; z: number } {
    const groundY = this.sampleGroundY(x, z)
    this.camera.position.set(x, groundY + EYE_HEIGHT, z)
    this.verticalVel = 0
    return { x, y: this.camera.position.y, z }
  }

  /**
   * Put the camera at an arbitrary world point in fly mode (no gravity), aimed
   * by yaw/pitch. Used to inspect a specific tile from above.
   */
  debugFlyTo(x: number, y: number, z: number, yaw: number, pitch: number): void {
    this.flyMode = true
    this.verticalVel = 0
    this.camera.position.set(x, y, z)
    this.debugLookAt(yaw, pitch)
  }

  /** Aim the camera (radians). Applied on the next update tick. */
  debugLookAt(yaw: number, pitch: number): void {
    this.cameraYaw = yaw
    this.cameraPitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, pitch))
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.animId)

    // Remove all event listeners
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown)
    if (this._onKeyUp) window.removeEventListener('keyup', this._onKeyUp)
    if (this._onMouseMove) document.removeEventListener('mousemove', this._onMouseMove)
    if (this._onPointerLockChange) document.removeEventListener('pointerlockchange', this._onPointerLockChange)
    const cv = this.renderer?.domElement
    if (cv) {
      if (this._onTouchStart) cv.removeEventListener('touchstart', this._onTouchStart)
      if (this._onTouchMove) cv.removeEventListener('touchmove', this._onTouchMove)
      if (this._onTouchEnd) {
        cv.removeEventListener('touchend', this._onTouchEnd)
        cv.removeEventListener('touchcancel', this._onTouchEnd)
      }
    }
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
