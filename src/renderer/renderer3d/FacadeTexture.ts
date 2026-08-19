/**
 * Procedural Facade Textures
 * Generates window/door/timber patterns on Canvas2D, used as Three.js textures.
 * Each unique facade config = one texture, reused across all buildings with same config.
 * This is how real games do it: paint detail on textures, not as individual geometry.
 */

import * as THREE from 'three'
import { STOREY_HEIGHT } from './scale'
import { doorColorFor } from './Materials'

interface FacadeConfig {
  floors: number
  /** Wall width in METRES. The field used to be documented as tiles, but the
   *  caller has passed `Math.round(v.width)` — world units — since the tile
   *  rescale, so the horizontal axis was already metric and only the comment
   *  was wrong. Every layout number below now says so explicitly. */
  width: number
  /** Wall height in METRES. Without this the vertical axis was laid out in
   *  "floors + 0.5" units and stretched over the wall, which is what made a
   *  door 0.55 of a made-up unit — 0.79m in practice, against a 1.75m person. */
  wallH: number
  wallColor: number
  roofColor: number
  doorColor: number
  hasTimber: boolean
  hasAwning: boolean
  hasShutters: boolean
  hasFlowerBox: boolean
  /**
   * IS THIS A WALL SOMEBODY LIVES BEHIND?
   *
   * The door was gated on `face === 'front'` alone, and every masonry volume
   * in the town has a front. `tools/facade.mjs` found 44 doors a town painted
   * OUTSIDE the wall carrying them — 29 along boundary walls, 6 on bridges —
   * because a 2.05m door on a 1.45m precinct wall is anchored to the canvas
   * base and simply clipped, so it fills the wall top to bottom with its head
   * cut off. A churchyard wall with a front door every metre.
   *
   * THIRD INSTANCE of `role: 'mainBody'` carrying two meanings. It already
   * meant both "the principal volume" and "a room, so apply the habitability
   * rules", which was fixed for SIZING with `Volume.habitable = false`. The
   * door is the sibling that kept reading the role. Derive it from the same
   * declaration rather than from the role.
   */
  hasDoor: boolean
  style: string // 'ornate' | 'standard' | 'rustic' | 'weathered'
  /** Optional override color for the ground-floor band — paints the lower
   *  TEXTURE_SCALE pixels of the canvas in this color, simulating the
   *  classic "stone shop on the ground floor, timber/plaster upstairs"
   *  pattern. Undefined = uniform wallColor. */
  groundFloorColor?: number
}
export type { FacadeConfig }

/**
 * WHICH WALL THIS TEXTURE IS FOR.
 *
 * This used to be `'front' | 'side'` and `'side'` had NO CONSUMER — the only
 * caller hardcoded `'front'`, so the whole side-wall branch was a ghost. What
 * the renderer actually did was hand the box
 *
 *     [plain, plain, plain, plain, facade, facade]
 *      +X     -X     +Y     -Y     +Z      -Z
 *
 * so both FLANKS of every building in the town were a single flat colour with
 * no openings at all, and the back wall wore the front's door. That is the
 * "every other angle looks like a back alley" report, and it was never a
 * dressing problem.
 *
 * The three faces are genuinely different buildings-worth of drawing, not one
 * drawing with bits switched off:
 *   front — the composed elevation: full window rhythm, the main door.
 *   back  — a working rear: same rhythm, a plainer off-centre door, no awning,
 *           and the odd bricked-up opening.
 *   side  — a flank: blind at ground level (that is where a neighbour abuts or
 *           a cart passes), fewer and higher openings above.
 */
export type FacadeFace = 'front' | 'side' | 'back'

/** Texture pixels per METRE. Both canvas axes are metric — see createFacadeTexture. */
const TEXTURE_SCALE = 32

/**
 * Authoring resolution follows how closely a face is inspected.
 *
 * Finishing all four walls took the live facade surface from 78.9MB to 150MB
 * on a seed-4242 town (tools/budget.mjs, seeded), because at 32 px/m a 6x9m
 * wall is a 221KB RGBA surface and there are now three of them per volume
 * instead of one. That is nothing on a desktop and it is the phone that cares
 * — the same machine CLAUDE.md keeps pointing at for the shadow budget. With
 * this and MAX_TEX_PX below it lands at 102.7MB: +30% for twice the walls.
 *
 * A front elevation is read at three feet and keeps full resolution. A back
 * is read across a yard and a flank down an alley, so they are authored
 * coarser: (20/32)^2 and (14/32)^2 of the memory, which is 0.39x and 0.19x.
 *
 * This is only safe because the window layout is expressed in FRACTIONS of
 * the wall now — changing pixels per metre cannot move an opening. Before
 * that refactor this constant was load-bearing for three separate hand-kept
 * copies of the layout and could not have been touched.
 *
 * The other lever, cache CARDINALITY, is deliberately NOT pushed further. The
 * flank quantises to whole metres and no coarser: the canvas is stretched
 * over the real wall, so rounding a 3m flank up to a 4m authoring size shrinks
 * its painted window to 0.75m. At 1m steps the worst case stays inside the
 * 0.7-1.4m humanscale.mjs accepts; at 2m steps it does not, and that is the
 * exact bug the metric-facade arc was fought over.
 */
function faceScale(face: FacadeFace): number {
  return face === 'front' ? TEXTURE_SCALE : (face === 'back' ? 20 : 14)
}

/**
 * Longest edge any facade canvas may have, in pixels.
 *
 * A fixed pixels-per-metre means a big wall gets a big texture, and the cost
 * is quadratic: at 32 px/m a cathedral's 12x30m flank is 384x960x4 = 1.4MB
 * for ONE wall. Measured with tools/budget.mjs, the town's live facade
 * surface was 78.9MB before this round even with only two faces drawn — the
 * handful of landmark walls dominate it. This cap is worth 47MB on its own
 * (150 -> 102.7) and costs the ordinary town nothing: a wall under 8m still
 * gets the full 32 px/m, so every row house is untouched and only the
 * landmarks are coarsened.
 *
 * Capping the LONGEST EDGE and deriving pixels-per-metre from that keeps the
 * scaling uniform, so nothing in the drawing distorts; a big wall simply gets
 * a coarser metre. It only became possible with the fractional window grid:
 * while three separate places computed openings from pixel constants, the
 * pixels-per-metre figure was load-bearing and could not vary per building.
 */
const MAX_TEX_PX = 256

/** Effective pixels per metre for this face at this size. */
function metricScale(face: FacadeFace, wallWm: number, wallHm: number): number {
  return Math.min(faceScale(face), MAX_TEX_PX / Math.max(wallWm, wallHm))
}
const STOREY_M = STOREY_HEIGHT
const _textureCache = new Map<string, THREE.CanvasTexture>()

/**
 * Quantize a 24-bit color to 4 bits per channel (12 bits total) before
 * using it as a cache key. Two near-identical wallColors that differ
 * only in low-order bits will hash to the SAME quantized key, sharing
 * one cached texture and one material — and therefore one merged
 * wall mesh in coalesceWalls. Visually the 16-step-per-channel ramp
 * is well below the per-building variation we already get from
 * weathering / mood lighting; the eye can't distinguish #6b3a1f
 * from #6c3b1e at building scale.
 *
 * Drops the unique-facade-material count significantly: with N
 * palettes generating dozens of slightly-different wallColors,
 * quantization collapses them to ~16-32 distinct buckets.
 */
function quantizeColor(c: number): number {
  const r = (c >> 16) & 0xf0
  const g = (c >> 8) & 0xf0
  const b = c & 0xf0
  return (r << 16) | (g << 8) | b
}

function facadeKey(config: FacadeConfig, face: FacadeFace): string {
  // Cache key uses QUANTIZED colors so near-identical wallColors collapse
  // into the same texture/material, allowing coalesceWalls to merge their
  // wall meshes. The CANVAS still paints with the full-fidelity colors
  // (see createFacadeTexture below) — only the cache identity is quantized.
  //
  // EVERY FIELD THE DRAWING READS MUST BE IN HERE. A flag that changes what
  // is painted but not the key hands the second caller the first caller's
  // canvas, which is a wrong texture with no error anywhere — `hasDoor`
  // would have put a door back on half the boundary walls it was added to
  // remove one from, at random, depending on build order.
  const wq = quantizeColor(config.wallColor)
  const dq = quantizeColor(config.doorColor)
  const gfc = config.groundFloorColor !== undefined
    ? quantizeColor(config.groundFloorColor).toString(16)
    : 'none'
  return `${config.floors}_${Math.round(config.width * 2)}_${Math.round(config.wallH * 2)}_${wq.toString(16)}_${dq.toString(16)}_${config.hasTimber}_${config.hasAwning}_${config.hasShutters}_${config.hasFlowerBox}_${config.hasDoor}_${config.style}_${gfc}_${face}`
}

function hexToRGB(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]
}

function colorStr(color: number, alpha: number = 1): string {
  const [r, g, b] = hexToRGB(color)
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha})` : `rgb(${r},${g},${b})`
}

function darkenColor(color: number, amount: number): number {
  const r = Math.max(0, ((color >> 16) & 0xff) * (1 - amount)) | 0
  const g = Math.max(0, ((color >> 8) & 0xff) * (1 - amount)) | 0
  const b = Math.max(0, (color & 0xff) * (1 - amount)) | 0
  return (r << 16) | (g << 8) | b
}

/** Tint a color toward white by `amount` (0..1). Used for masonry trim
 *  (lintels/sills) that catch the dusk light and read as a lighter stone
 *  band against the wall — the horizontal banding the eye uses to parse
 *  a row of windows at distance. Clamped at 255 per channel. */
function lightenColor(color: number, amount: number): number {
  const r = Math.min(255, ((color >> 16) & 0xff) + (255 - ((color >> 16) & 0xff)) * amount) | 0
  const g = Math.min(255, ((color >> 8) & 0xff) + (255 - ((color >> 8) & 0xff)) * amount) | 0
  const b = Math.min(255, (color & 0xff) + (255 - (color & 0xff)) * amount) | 0
  return (r << 16) | (g << 8) | b
}

/**
 * One window opening, expressed as FRACTIONS OF THE WALL rather than pixels
 * or metres.
 *
 * That is deliberate and it is the only form all three consumers can share.
 * The canvas is authored at the config's QUANTISED size (widths round to
 * 0.5m so the texture cache stays bounded) and then stretched over the wall's
 * real dimensions by the UV mapping. So a metric position on the canvas is
 * NOT the metric position on the wall — it is off by the quantisation ratio.
 * Anything placing real geometry against a painted opening has to apply the
 * same stretch, and a fraction applies it for free: multiply by the real
 * wall and you land exactly where the texture drew it.
 */
interface WinCell {
  /** Centre, 0..1 across the wall from its left edge. */
  u: number
  /** Centre, 0..1 up the wall from its base. */
  vCenter: number
  /** Opening width as a fraction of wall width. */
  uW: number
  /** Opening height as a fraction of wall height. */
  vH: number
  floor: number
  col: number
  /** Bricked-up: the aperture, lintel and sill are still drawn but the opening
   *  is filled. A real cue (window tax, a room subdivided, a lean-to built
   *  against the wall) and the cheapest way to make a rear elevation read as
   *  having a HISTORY rather than being the front with the door removed. */
  blocked: boolean
}

/**
 * THE WINDOW GRID — one definition, THREE consumers.
 *
 * `createFacadeTexture` paints the openings, `createEmissiveTexture` lights
 * them, and `VolumeRenderer` hangs real projecting lintels and sills on them.
 * All three used to compute the layout themselves. The emissive copy carried a
 * comment insisting it "has to stay identical" by hand, and the geometry copy
 * had already silently drifted an entire scale generation behind:
 *
 *     cols = max(1, floor(round(width) * 1.5))     // vs round(width / 2.4)
 *     canvasH = floors * 64 + 32                   // pre-metric texture units
 *     winWworld = (width / round(width)) * 0.22    // a 22cm window
 *
 * On an ordinary 2.8m row house that is FOUR 21cm stone nubs at the wrong
 * height, projecting from a wall whose painted facade has one 1.0m window —
 * plus, when hasFlowerBox fires, four flower boxes hanging on blank plaster.
 * Nobody wrote that; it is what a copy becomes after the original is fixed.
 * This is the "duplicated math drifts silently" lesson with a third instance,
 * so the duplication is gone rather than re-synchronised.
 *
 * A real sash is about 1.0m x 1.35m with its sill 0.95m off the floor, and
 * windows sit roughly every 2.4m along a facade. All of those are metres, so
 * all of them survive any future change to the tile factor.
 */
const WIN_W_M = 1.0, WIN_H_M = 1.35, SILL_M = 0.95, WIN_PITCH_M = 2.4

/**
 * Quantise a wall dimension in METRES for cache identity.
 *
 * Every distinct value here is another facade texture, another material, and
 * — because coalesceWalls buckets by the material array — one less merged
 * wall mesh. Giving the flanks their own textures cost 118 draw calls on a
 * seed-4242 walkthrough (622 -> 740) purely in lost merges, so the flank
 * quantises to whole metres where the front and back keep half. A flank is
 * looked at from further away and across fewer of its openings; spending the
 * same cache budget on it as on the composed elevation is not a trade worth
 * making on a phone.
 *
 * Both the texture and the 3D window trim must quantise IDENTICALLY or the
 * lintels land on a different column count from the painted windows — which
 * is the drift this module has now produced three times, so it is one call.
 */
export function quantizeWallM(metres: number, face: FacadeFace, min = 1): number {
  const step = face === 'side' ? 1 : 0.5
  return Math.max(min, Math.round(metres / step) * step)
}

export function facadeOpenings(
  floors: number,
  /** Wall width in METRES — pass the same quantised value the FacadeConfig
   *  carries, or the column count can differ from the painted one. */
  wallWidthM: number,
  /** Wall height in METRES, likewise quantised. */
  wallHeightM: number,
  face: FacadeFace,
  /** Seeds which openings are bricked up. Pass the wall colour, which is what
   *  the config-based callers have. */
  seed: number
): WinCell[] {
  const wallWm = Math.max(1, wallWidthM)
  const wallHm = Math.max(1.5, wallHeightM)
  // A flank is the wall a neighbour abuts or a cart squeezes past, so it is
  // pierced less often. The back is a working elevation, not a blank one.
  const pitch = face === 'side' ? 3.2 : WIN_PITCH_M
  const cols = Math.max(1, Math.round(wallWm / pitch))
  // Storeys are laid out from the ground up at their true height, so the top
  // floor is dropped when the wall is not tall enough to hold it rather than
  // every floor being compressed to fit.
  const floorsThatFit = Math.max(1, Math.min(floors, Math.floor(wallHm / STOREY_M)))
  // ...EXCEPT THAT `max(1, ...)` FORCES A STOREY ONTO A WALL THAT CANNOT HOLD
  // ONE. The comment above is true of floors 2 and up and defeated for floor
  // 0: the lowest window's head sits at SILL_M + WIN_H_M = 2.30m whatever the
  // wall does, so a 1.5m volume — a porch, an outshot, a lean-to, a coping —
  // was painted with a window whose top is 0.80m ABOVE ITS OWN ROOFLINE.
  //
  // This is the exact sibling of the width defect below, one axis over, and it
  // was found by asking the same question vertically rather than by a new
  // measurement. A bug in a gate is a bug in a PATTERN — and `uW` and `vH` are
  // the same unclamped `size / wall` fraction written twice.
  const HEAD_M = 0.25   // lintel plus a course of wall above it
  if (SILL_M + WIN_H_M + HEAD_M > wallHm) return []
  // Ground-floor flanks stay blind — that is where the party wall, the
  // buttress and the lean-to go. A blind base with openings above is what
  // makes a side wall read as a side wall rather than a second front.
  const firstFloor = face === 'side' && floorsThatFit > 1 ? 1 : 0

  // Deterministic per-face jitter: the texture is CACHED, so anything random
  // here has to come out of the inputs or two buildings with the same config
  // would get different walls and the cache would hand out whichever was
  // built first.
  let rng = (seed ^ (floors * 7919) ^ (face.length * 104729)) >>> 0
  const next = (): number => {
    rng = (rng * 1103515245 + 12345) & 0x7fffffff
    return rng / 0x7fffffff
  }
  const blockRate = face === 'front' ? 0 : (face === 'back' ? 0.14 : 0.22)

  // A WINDOW CANNOT BE THE WHOLE WALL.
  //
  // `uW` is `WIN_W_M / wallWm` — a fraction with no ceiling — and both ends of
  // that ratio are 1.0 at the bottom of the range: WIN_W_M is 1.0m and
  // quantizeWallM floors at 1.0m. So every volume 1.25m or narrower was
  // painted with an opening running corner to corner, at every storey. On the
  // 1.20m x 10.49m wings that turned up in the audit that is a three-storey
  // glass slot with no wall left to be a wall, and the structural corner posts
  // standing straight down the middle of it.
  //
  // It reported as "a post covers 11% of a window", which is the small half of
  // the finding and the only half a collision count can express. The window
  // being 100% of its wall is not a collision at all, so nothing was ever
  // going to say it — the same shape as MIN_OPENING_W at the other end of the
  // range, where a fraction of a sliver came out as a 13cm "window".
  //
  // A window needs a pier either side, and the corner post lives in that pier.
  // If one will not fit, the wall is too narrow to be pierced — which is what
  // a real narrow outbuilding elevation is: masonry.
  const PIER_M = 0.28          // pier each side, wide enough to hold the post
  const MIN_WIN_W_M = 0.5      // narrower than this is an arrow slit, not a window
  const winWm = Math.min(WIN_W_M, wallWm - 2 * PIER_M)
  if (winWm < MIN_WIN_W_M) return []

  // Half a window plus a corner post's width, as a fraction of the wall.
  const marginU = Math.min(0.45, (0.24 + winWm / 2) / wallWm)

  const cells: WinCell[] = []
  for (let floor = firstFloor; floor < floorsThatFit; floor++) {
    for (let col = 0; col < cols; col++) {
      cells.push({
      // KEEP THE OUTERMOST COLUMN OFF THE CORNER. A timber-framed wall has a
      // corner post at its edge and it is structural, so it cannot move out of
      // a window's way — tools/facade.mjs measured 34 posts a town crossing
      // one, the worst covering 93% of it. On a wide wall (col+1)/(cols+1)
      // already clears; this only bites on the narrow ones, which is exactly
      // where the collision was.
      u: Math.min(1 - marginU, Math.max(marginU, (col + 1) / (cols + 1))),
        vCenter: (floor * STOREY_M + SILL_M + WIN_H_M / 2) / wallHm,
        uW: winWm / wallWm,
        vH: WIN_H_M / wallHm,
        floor,
        col,
        blocked: next() < blockRate,
      })
    }
  }
  return cells
}

/** The canvas-space view of the same grid: pixel rects on this face's texture. */
function windowGrid(config: FacadeConfig, face: FacadeFace): {
  winW: number; winH: number; cells: Array<WinCell & { x: number; y: number }>
} {
  const wallWm = Math.max(1, config.width)
  const wallHm = Math.max(1.5, config.wallH)
  const M = metricScale(face, wallWm, wallHm)
  const w = Math.round(wallWm * M)
  const h = Math.round(wallHm * M)
  const cells = facadeOpenings(config.floors, wallWm, wallHm, face, config.wallColor)
    .map((c) => ({
      ...c,
      x: c.u * w - (c.uW * w) / 2,
      y: h - (c.vCenter + c.vH / 2) * h,
    }))
  return { winW: WIN_W_M * M, winH: WIN_H_M * M, cells }
}

/** Blend a colour toward a mortar tone. Used for bricked-up openings: the
 *  infill is never the same batch as the wall, and painting it the wall colour
 *  exactly would make the whole point of the detail invisible. */
const MORTAR = 0x8a7f70
function shiftToward(color: number, amount: number): number {
  const mix = (a: number, b: number): number => Math.round(a + (b - a) * amount)
  const r = mix((color >> 16) & 0xff, (MORTAR >> 16) & 0xff)
  const g = mix((color >> 8) & 0xff, (MORTAR >> 8) & 0xff)
  const b = mix(color & 0xff, MORTAR & 0xff)
  return (r << 16) | (g << 8) | b
}

export function createFacadeTexture(config: FacadeConfig, face: FacadeFace): THREE.CanvasTexture {
  const key = facadeKey(config, face)
  const cached = _textureCache.get(key)
  if (cached) return cached

  // ONE texture pixel-per-metre in BOTH axes. Horizontal already worked this
  // way by accident; vertical was floors-based, so a taller building squeezed
  // the same drawing into more wall and every opening shrank. With both axes
  // metric an opening drawn at 2.05 units lands on the wall at 2.05 metres,
  // whatever the building.
  const wallWm = Math.max(1, config.width)
  const wallHm = Math.max(1.5, config.wallH)
  const M = metricScale(face, wallWm, wallHm)
  const w = Math.round(wallWm * M)
  const h = Math.round(wallHm * M)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  // Base wall color
  ctx.fillStyle = colorStr(config.wallColor)
  ctx.fillRect(0, 0, w, h)

  // Ground-floor band — when groundFloorColor is set, paint the entire
  // lower TEXTURE_SCALE pixels in that contrasting color. Implies a stone
  // shop foundation under timber/plaster upper floors. Otherwise just a
  // subtle darker stripe matches the original look.
  if (config.groundFloorColor !== undefined) {
    const gh = STOREY_M * M
    ctx.fillStyle = colorStr(config.groundFloorColor)
    ctx.fillRect(0, h - gh, w, gh)
    // Suggest stone courses with a few horizontal banding lines in a
    // slightly darker shade — adds masonry texture without spending verts.
    ctx.strokeStyle = colorStr(darkenColor(config.groundFloorColor, 0.18))
    ctx.lineWidth = 1
    for (let row = 1; row < 4; row++) {
      const y = h - gh + row * (gh / 4)
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
    }
    // Vertical "block edge" lines, offset per row for staggered courses.
    ctx.strokeStyle = colorStr(darkenColor(config.groundFloorColor, 0.22))
    for (let row = 0; row < 4; row++) {
      const yTop = h - gh + row * (gh / 4)
      const yBot = yTop + gh / 4
      const colSpacing = TEXTURE_SCALE * 0.45
      const offset = (row % 2) * colSpacing * 0.5
      for (let x = offset; x < w; x += colSpacing) {
        ctx.beginPath(); ctx.moveTo(x, yTop); ctx.lineTo(x, yBot); ctx.stroke()
      }
    }
  } else {
    const groundH = TEXTURE_SCALE * 0.4
    ctx.fillStyle = colorStr(darkenColor(config.wallColor, 0.1))
    ctx.fillRect(0, h - groundH, w, groundH)
  }

  // Timber framing
  if (config.hasTimber) {
    ctx.strokeStyle = colorStr(darkenColor(config.wallColor, 0.35))
    ctx.lineWidth = 3
    // Horizontal beams
    for (let floor = 0; floor < config.floors; floor++) {
      const y = h - (floor + 1) * STOREY_M * M + M * 0.15
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()
    }
    // Vertical beams
    const bays = Math.max(1, Math.round(wallWm / 1.7))
    const beamSpacing = w / (bays + 1)
    for (let i = 1; i <= bays; i++) {
      ctx.beginPath(); ctx.moveTo(i * beamSpacing, 0); ctx.lineTo(i * beamSpacing, h); ctx.stroke()
    }
    // Diagonal crosses in each panel
    for (let floor = 0; floor < config.floors; floor++) {
      const fy = h - (floor + 1) * STOREY_M * M
      for (let panel = 0; panel < bays; panel++) {
        const px = panel * beamSpacing + beamSpacing / 2
        if ((floor + panel) % 3 === 0) {
          ctx.beginPath()
          ctx.moveTo(px - beamSpacing * 0.3, fy + STOREY_M * M * 0.2)
          ctx.lineTo(px + beamSpacing * 0.3, fy + STOREY_M * M * 0.8)
          ctx.stroke()
        }
      }
    }
  }

  // STRING COURSES — a shallow band of stone at each floor line, running the
  // full width. Almost every masonry building of this period has them, and
  // they are the cheapest thing that stops a large wall reading as a blank
  // panel: they give the eye a horizontal rhythm and a scale reference even
  // where there are no windows.
  {
    const bandH = Math.max(2, 0.14 * M)
    const light = colorStr(lightenColor(config.wallColor, 0.16))
    const shade = colorStr(darkenColor(config.wallColor, 0.24))
    for (let fl = 1; fl * STOREY_M < wallHm - 0.4; fl++) {
      const y = h - fl * STOREY_M * M
      ctx.fillStyle = light
      ctx.fillRect(0, y - bandH, w, bandH)
      ctx.fillStyle = shade
      ctx.fillRect(0, y, w, Math.max(1, bandH * 0.35))
    }
    // Plinth at the base — the same idea where the wall meets the ground.
    ctx.fillStyle = shade
    ctx.fillRect(0, h - Math.max(2, 0.3 * M), w, Math.max(2, 0.3 * M))
    ctx.fillStyle = light
    ctx.fillRect(0, h - Math.max(2, 0.3 * M) - Math.max(1, 0.05 * M), w, Math.max(1, 0.05 * M))
  }

  // Windows — laid out by windowGrid so the painted openings and the lit
  // ones cannot drift apart, and so each face gets its own rhythm.
  {
    const { winW, winH, cells } = windowGrid(config, face)
    for (const cell of cells) {
      const wx = cell.x, wy = cell.y
      const floor = cell.floor, col = cell.col

      // Window frame (dark)
      ctx.fillStyle = colorStr(darkenColor(config.wallColor, 0.25))
      ctx.fillRect(wx - 2, wy - 2, winW + 4, winH + 4)

      // Masonry trim: a lintel (header) above and a sill (ledge) below.
      // Thin light bands that catch the light + a darker seam under each so
      // they read as projecting stone. This is what turns a flat grid of
      // squares into a legible row of windows at walkaround distance.
      const trimLight = colorStr(lightenColor(config.wallColor, 0.28))
      const trimShadow = colorStr(darkenColor(config.wallColor, 0.3))
      // Lintel — spans a touch wider than the frame, sits just above it.
      ctx.fillStyle = trimLight
      ctx.fillRect(wx - 4, wy - 2 - 3, winW + 8, 3)
      ctx.fillStyle = trimShadow
      ctx.fillRect(wx - 4, wy - 2, winW + 8, 1)
      // Sill — overhangs wider than the lintel, with a drop shadow beneath
      // to imply it projects from the wall face.
      ctx.fillStyle = trimLight
      ctx.fillRect(wx - 5, wy + winH + 2, winW + 10, 3)
      ctx.fillStyle = trimShadow
      ctx.fillRect(wx - 5, wy + winH + 5, winW + 10, 1)

      if (cell.blocked) {
        // BRICKED UP. The frame, lintel and sill above are already drawn, so
        // the aperture still reads as an opening — it has just been filled
        // in, which is the whole point. Slightly off the wall colour, because
        // nobody ever matched the render, plus a stretcher-bond hatch.
        const fill = shiftToward(config.wallColor, 0.12)
        ctx.fillStyle = colorStr(fill)
        ctx.fillRect(wx, wy, winW, winH)
        ctx.strokeStyle = colorStr(darkenColor(fill, 0.16))
        ctx.lineWidth = 1
        const courseH = Math.max(3, winH / 5)
        for (let by = wy + courseH; by < wy + winH; by += courseH) {
          ctx.beginPath(); ctx.moveTo(wx, by); ctx.lineTo(wx + winW, by); ctx.stroke()
        }
        let row = 0
        for (let by = wy; by < wy + winH; by += courseH, row++) {
          const off = (row % 2) * (winW / 4)
          for (let bx = wx + off; bx < wx + winW; bx += winW / 2) {
            ctx.beginPath()
            ctx.moveTo(bx, by)
            ctx.lineTo(bx, Math.min(by + courseH, wy + winH))
            ctx.stroke()
          }
        }
        continue
      }

      // GLASS IS SHOWING YOU THE SKY, so it cannot be painted as a dark hole.
      //
      // This was rgb(60,70,90) — 0.077 sRGB luma, an albedo so low that any
      // reduction in light takes it to zero. In direct sun it read as a
      // window; on a SHADOWED facade at noon, and on every facade at dusk,
      // `tools/holes.mjs` measured whole panes at 0.01 absolute and a person
      // reads that as a hole in the wall. Fifty-three of them in four
      // daylight views on one seed.
      //
      // Third instance of the same physical mistake in this repo. Still water
      // rendered nearly black at dusk because a diffuse blue plane has
      // nothing to return, and the fix was that real water shows you the sky.
      // Glass does the same, harder, and at the grazing angles a street gives
      // you it returns most of what the sky sends. A gradient because the
      // head of a pane sees more sky than its foot does.
      //
      // Still well under the wall — a lit window is ~10x its surround and has
      // to stay that way for DESIGN.md pillar 1 — but no longer at zero.
      const glass = ctx.createLinearGradient(wx, wy, wx, wy + winH)
      glass.addColorStop(0, 'rgb(104,120,144)')
      glass.addColorStop(1, 'rgb(74,86,108)')
      ctx.fillStyle = glass
      ctx.fillRect(wx, wy, winW, winH)

      // Window mullion (cross bar)
      ctx.fillStyle = colorStr(darkenColor(config.wallColor, 0.15))
      ctx.fillRect(wx + winW / 2 - 1, wy, 2, winH)
      ctx.fillRect(wx, wy + winH / 2 - 1, winW, 2)

      // Shutters. Kept off the flank: shutters are a street-facing courtesy
      // and a blind-ish side wall wearing them reads as a second front.
      if (config.hasShutters && face !== 'side' && col % 2 === 0) {
        const shutterColor = darkenColor(config.wallColor, 0.2)
        ctx.fillStyle = colorStr(shutterColor)
        ctx.fillRect(wx - winW * 0.35, wy, winW * 0.3, winH)
        ctx.fillRect(wx + winW + winW * 0.05, wy, winW * 0.3, winH)
      }

      // Flower box — front only. A rear elevation wearing window boxes reads
      // as a second front, which is the exact failure mode this whole change
      // is about: the back should be finished, not duplicated.
      if (config.hasFlowerBox && face === 'front' && floor === 0 && col % 2 === 0) {
        ctx.fillStyle = colorStr(0x6a4a2a)
        ctx.fillRect(wx - 4, wy + winH + 2, winW + 8, 6)
        // Flowers
        const flowerColors = [0xff6688, 0xffaa44, 0xdd88dd]
        for (let fi = 0; fi < 3; fi++) {
          ctx.fillStyle = colorStr(flowerColors[fi])
          ctx.beginPath()
          ctx.arc(wx + (fi + 0.5) * winW / 3, wy + winH - 1, 3, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }
  }

  // Door (front face only, and only on a wall that can hold one).
  //
  // The height test is not redundant with `hasDoor` — it is the exact form of
  // the same question, and it catches the case the declaration cannot: a
  // habitable volume can still be shorter than a door. `doorY = h - doorH`
  // anchors to the canvas base, so when the wall is shorter the door is drawn
  // from above the top edge and CLIPPED, which reads as a slab, not a door.
  const DOOR_LINTEL_M = 0.18
  if (face === 'front' && config.hasDoor && 2.05 + DOOR_LINTEL_M <= h / M) {
    // A door you can walk through: 0.95m x 2.05m.
    const doorW = 0.95 * M
    const doorH = 2.05 * M
    const doorX = w / 2 - doorW / 2
    const doorY = h - doorH

    // FLOORED AT THE POINT OF USE — see Materials.doorColorFor. Two palette
    // sources both hand over near-black doors, and flooring either one leaves
    // the other.
    const doorC = doorColorFor(config.doorColor)
    // Door frame
    ctx.fillStyle = colorStr(darkenColor(doorC, 0.2))
    ctx.fillRect(doorX - 3, doorY - 5, doorW + 6, doorH + 5)

    // Door body
    ctx.fillStyle = colorStr(doorC)
    ctx.fillRect(doorX, doorY, doorW, doorH)

    // Door panels
    ctx.strokeStyle = colorStr(darkenColor(doorC, 0.15))
    ctx.lineWidth = 1
    ctx.strokeRect(doorX + 3, doorY + 4, doorW - 6, doorH * 0.35)
    ctx.strokeRect(doorX + 3, doorY + doorH * 0.45, doorW - 6, doorH * 0.35)

    // Door handle
    ctx.fillStyle = colorStr(0xc0a040)
    ctx.beginPath()
    ctx.arc(doorX + doorW * 0.75, doorY + doorH * 0.5, 2, 0, Math.PI * 2)
    ctx.fill()

    // Awning over door
    if (config.hasAwning) {
      ctx.fillStyle = colorStr(darkenColor(config.roofColor, 0.1), 0.9)
      ctx.beginPath()
      ctx.moveTo(doorX - 10, doorY - 5)
      ctx.lineTo(doorX + doorW + 10, doorY - 5)
      ctx.lineTo(doorX + doorW + 15, doorY + 8)
      ctx.lineTo(doorX - 15, doorY + 8)
      ctx.closePath()
      ctx.fill()
    }
  }

  // BACK DOOR. Not the front door with the brass taken off — a different
  // door. Narrower, shorter, plank-built rather than panelled, weathered
  // darker, and crucially OFF THE AXIS: a rear door sits beside the stair or
  // the scullery, never centred on the elevation. A centred rear door is the
  // single tell that a building has been mirrored rather than finished.
  //
  // SAME GATE AS THE FRONT. `doorY = h - doorH` with no height test, written
  // twice — so the rear elevation put a clipped 1.95m batten door on every
  // boundary wall and bridge pier exactly as the front did. The audit records
  // only front openings and could not have found this one; the sibling sweep
  // did. A bug in a gate is a bug in a PATTERN.
  const REAR_DOOR_H_M = 1.95
  if (face === 'back' && config.hasDoor && REAR_DOOR_H_M + 0.18 <= h / M) {
    const doorW = 0.85 * M
    const doorH = REAR_DOOR_H_M * M
    // Off-centre, but deterministically so — the texture is cached.
    const leftish = ((config.wallColor >> 4) & 1) === 0
    const doorX = leftish ? w * 0.28 - doorW / 2 : w * 0.72 - doorW / 2
    const doorY = h - doorH
    // The rear door darkens its own base, so it has to floor FIRST or the
    // sibling sweep misses it — a back door at 0.7 of a black door is still
    // black. `facade.mjs` found the identical bug written out twice before.
    const rearColor = darkenColor(doorColorFor(config.doorColor), 0.3)

    // Rough timber lining rather than a moulded frame.
    ctx.fillStyle = colorStr(darkenColor(rearColor, 0.35))
    ctx.fillRect(doorX - 3, doorY - 3, doorW + 6, doorH + 3)
    ctx.fillStyle = colorStr(rearColor)
    ctx.fillRect(doorX, doorY, doorW, doorH)

    // Vertical planks with two iron ledger straps across — a batten door.
    ctx.strokeStyle = colorStr(darkenColor(rearColor, 0.28))
    ctx.lineWidth = 1
    for (let p = 1; p < 4; p++) {
      const px = doorX + (p * doorW) / 4
      ctx.beginPath(); ctx.moveTo(px, doorY); ctx.lineTo(px, doorY + doorH); ctx.stroke()
    }
    ctx.fillStyle = colorStr(0x2a241e)
    ctx.fillRect(doorX, doorY + doorH * 0.18, doorW, 3)
    ctx.fillRect(doorX, doorY + doorH * 0.74, doorW, 3)

    // Worn stone threshold under it — the one bright note on a rear wall,
    // and it stops the door reading as floating on the base course.
    ctx.fillStyle = colorStr(lightenColor(config.wallColor, 0.22))
    ctx.fillRect(doorX - 5, h - 6, doorW + 10, 6)
  }

  // Stone/brick base course
  ctx.fillStyle = colorStr(darkenColor(config.wallColor, 0.15))
  ctx.fillRect(0, h - 8, w, 8)

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  _textureCache.set(key, texture)
  return texture
}

/** Create an emissive-only texture: black background, glowing window rectangles.
 *  Takes the face for the same reason the painted texture does — a flank has a
 *  blind ground floor and some bricked-up openings, and lighting a window that
 *  is not painted there puts a glowing rectangle on a blank wall. */
export function createEmissiveTexture(config: FacadeConfig, face: FacadeFace): THREE.CanvasTexture {
  const key = `emissive_${facadeKey(config, face)}`
  const cached = _textureCache.get(key)
  if (cached) return cached

  // Same metric canvas as createFacadeTexture — if these two disagree the lit
  // windows sit somewhere other than the painted ones.
  const wallWm = Math.max(1, config.width)
  const wallHm = Math.max(1.5, config.wallH)
  const M = metricScale(face, wallWm, wallHm)
  const w = Math.round(wallWm * M)
  const h = Math.round(wallHm * M)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  // Black background = no emission
  ctx.fillStyle = 'rgb(0,0,0)'
  ctx.fillRect(0, 0, w, h)

  // Glowing windows — SAME grid the painted texture used. This was a copy of
  // the layout with a comment insisting it stay identical by hand; it is one
  // call now, so a face with a blind ground floor cannot end up with a lit
  // rectangle floating on blank plaster.
  const { winW, winH, cells } = windowGrid(config, face)

  // Seeded random for consistent dark windows
  let rng = config.wallColor ^ (config.floors * 7919)
  const nextRng = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff }

  {
    for (const cell of cells) {
      // A bricked-up opening has no room behind it to light.
      if (cell.blocked) continue
      // Per-window state with mood variety:
      //   ~25% dark (room unlit / shutters drawn)
      //   ~10% dim (a candle, low intensity)
      //   ~10% cool blue-white (workshop / scribe / oil lamp with glass shade)
      //   ~5%  bright sun-yellow (a hearth fire visible inside)
      //   rest: warm amber (the standard glow)
      const r1 = nextRng()
      let kind: 'dark' | 'dim' | 'cool' | 'bright' | 'amber'
      if (r1 < 0.25) kind = 'dark'
      else if (r1 < 0.35) kind = 'dim'
      else if (r1 < 0.45) kind = 'cool'
      else if (r1 < 0.50) kind = 'bright'
      else kind = 'amber'
      const wx = cell.x, wy = cell.y

      // AN UNLIT WINDOW AT DUSK IS NOT A VOID — IT MIRRORS THE SKY.
      //
      // `dark` used to `continue`, so a quarter of every facade's windows had
      // no emission at all and rendered as the painted rgb(60,70,90) times a
      // dusk light of about 0.2 — which is zero. `tools/holes.mjs` finds them
      // as solid black rectangles at 0.00-0.19x the wall around them, and a
      // person reads a black rectangle in a wall as a HOLE, not as a room
      // with nobody in it.
      //
      // This is the water fix one surface over. Still water rendered nearly
      // black at dusk because a Lambert blue plane has nothing to return, and
      // the answer was that real water is showing you the SKY. Glass does the
      // same and more strongly at the grazing angles a street gives you.
      //
      // Sized against the tool's own CONTROL rather than against a number:
      // lit openings measure ~9x their surround, ordinary wall sits at 0.078,
      // and this lands unlit glass at roughly the wall's own level. So it
      // reads as a surface, and DESIGN.md pillar 1's warm-windows-against-
      // dark-silhouettes contrast is untouched — the lit ones are still an
      // order of magnitude above it.
      //
      // It costs nothing in daylight: `windowGlow` is 0 at noon, so the whole
      // emissive map goes dark and the painted glass — which already reads
      // correctly at noon — is all that remains.
      if (kind === 'dark') {
        const g = ctx.createLinearGradient(wx, wy, wx, wy + winH)
        // Brighter at the head, because that is where a pane catches the sky.
        g.addColorStop(0, 'rgb(34,42,58)')
        g.addColorStop(1, 'rgb(20,25,36)')
        ctx.fillStyle = g
        ctx.fillRect(wx, wy, winW, winH)
        continue
      }

      const warmth = nextRng()
      let r: number, g: number, b: number
      switch (kind) {
        case 'dim': {
          // Faint orange ember
          const k = 0.45 + warmth * 0.15
          r = Math.floor(180 * k); g = Math.floor(120 * k); b = Math.floor(50 * k)
          break
        }
        case 'cool': {
          // Soft blue-white workshop light — channels capped so the window
          // can't saturate to pure white under bloom at dusk. Still reads
          // as a cool interior against warm amber neighbors.
          r = 150 + Math.floor(warmth * 20)
          g = 170 + Math.floor(warmth * 20)
          b = 220
          break
        }
        case 'bright': {
          // Rich amber hearth — brighter than default amber but clamped so
          // it never clips to white under bloom. Replaces the previous
          // pure-white-yellow which read as an overexposed lightbulb.
          r = 240; g = 190 + Math.floor(warmth * 20); b = 90
          break
        }
        default: {
          // Standard warm amber (existing palette)
          r = 255
          g = Math.floor(180 + warmth * 40)
          b = Math.floor(60 + warmth * 30)
        }
      }
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.fillRect(wx, wy, winW, winH)

      // Mullion cross casts slight shadow on glow
      ctx.fillStyle = 'rgba(0,0,0,0.3)'
      ctx.fillRect(wx + winW / 2 - 1, wy, 2, winH)
      ctx.fillRect(wx, wy + winH / 2 - 1, winW, 2)
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  _textureCache.set(key, texture)
  return texture
}

// createFacadeConfig() lived here and had NO CALLERS. It predated `wallH`
// becoming part of FacadeConfig and never gained the field, so it could not
// have built a valid config — the ghost failure in its plainest form, kept
// alive only because the typecheck gate was checking zero files.
