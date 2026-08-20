/**
 * HOLES — dark rectangles on a wall, which a person reads as a hole in it.
 *
 * This is the defect class every instrument here is blind to, and it is the
 * first thing a person notices in a street screenshot. Three frames out of
 * three showed it before this tool existed, and I found it by LOOKING, which
 * is exactly the failure mode CLAUDE.md keeps recording: twenty-five audits,
 * each answering a question somebody already knew to ask.
 *
 * Why nothing else can see it:
 *
 *   facade.mjs   compares 3D detail against the openings PAINTED on a wall.
 *                It knows where every opening IS and has no opinion about
 *                what COLOUR it is.
 *   eyeball.mjs  measures tone by surface class over a raycast grid, so a
 *                black door is a handful of dark samples among four thousand
 *                "wall" pixels and vanishes into the median.
 *   anomaly.mjs  finds thin dark shapes against the SKY. A hole is a fat dark
 *                shape against a WALL — the same eye, pointed inward.
 *   odd.mjs      ranks structures by a feature vector. Colour is not in it,
 *                and a whole town painting black doors is a defect the whole
 *                population shares, which odd is blind to by construction.
 *
 * WHAT IT MEASURES, and the point is that there is no absolute threshold in
 * it. A hole is defined RELATIVE to the surface it sits in:
 *
 *   1. Dark, against the LOCAL surround rather than against a number. Each
 *      pixel is compared to a heavily blurred copy of the frame, so the test
 *      is a ratio and the exposure cancels — the same run works at noon and
 *      at dusk without a second constant. That matters here more than usual:
 *      this repo has an entire arc of tone measurements that were taken at
 *      the wrong hour and meant nothing.
 *   2. COMPACT. A shadow is irregular and soft-edged; a painted door is a
 *      rectangle. `fill` is the component's area over its bounding box, and a
 *      rectangle scores near 1.0.
 *   3. SURROUNDED BY SURFACE. The exact sky mask (hide every content group,
 *      re-render in the same tick, diff — anomaly.mjs's trick, and it has to
 *      be exact: a colour-tolerance flood fill walks down a dusk facade and
 *      turns every lit window into an island) means a silhouette against the
 *      sky is not a hole. That is anomaly's department.
 *
 * AND IT CARRIES ITS OWN CONTROL. Every pixel verdict in this repo that had no
 * control has been wrong at least once, so the tool also measures the BRIGHT
 * compact patches — the lit windows — and the ordinary wall around them. The
 * reader sees what an opening in THIS town looks like when it is working,
 * and the hole figure is relative to that rather than to a number I invented.
 * Three hand-written targets in propscale.mjs were wrong on their first run.
 *
 * It names the building. One ray per flagged patch — not a grid, so this
 * stays seconds rather than minutes — attributed to the volume box that
 * contains the hit, the same way eyeball attributes its samples. "There is a
 * hole" is a finding; "the door on every bakery" is a fix.
 *
 * Annotated frames land in .shots/holes/. A detector you cannot check is a
 * detector you will eventually trust for the wrong reasons.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/holes.mjs [seed] [--views=N] [--time=18.5] [--all]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome } from './lib/vantage.mjs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 4242)
const viewsArg = argv.find((a) => a.startsWith('--views='))
const VIEWS = viewsArg ? Number(viewsArg.split('=')[1]) : 6
const timeArg = argv.find((a) => a.startsWith('--time='))
const TIME = timeArg ? Number(timeArg.split('=')[1]) : 18.5
const ALL = argv.includes('--all')

mkdirSync('.shots/holes', { recursive: true })
for (const f of readdirSync('.shots/holes')) {
  if (f.startsWith(`s${seed}-`)) rmSync(`.shots/holes/${f}`)
}

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

await win.evaluate((s) => {
  const inp = [...document.querySelectorAll('.left-panel input')]
    .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, s); inp.dispatchEvent(new Event('input', { bubbles: true }))
}, seed)
await win.waitForTimeout(150)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2600)
await win.getByRole('button', { name: '3D', exact: true }).click()
await waitForScene(win)
await win.evaluate((t) => window.__pt.store.getState().updateEnvironment({ timeOfDay: t }), TIME)
await win.waitForTimeout(800)
// The HUD sits over the frame and its text is a high-contrast dark shape on a
// light chip, which is a hole by any honest definition of one.
await hideChrome(win)

const scene = await win.evaluate(() => window.__pt.sceneFeatures())

// Street-level vantages, chosen the way eyeball chooses them: walkable tiles
// spread over the map, looking along the corridor. NOT a fixed list — fixed
// vantages are how walkshots keeps photographing the same five places.
const spots = await win.evaluate((n) => {
  const pt = window.__pt, st = pt.store.getState()
  const terrain = st.map.layers.find((l) => l.type === 'terrain').terrainTiles
  const H = terrain.length, W = terrain[0].length
  const road = []
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) if (pt.isCirculation(terrain[y][x])) road.push([x, y])
  }
  if (!road.length) return []
  const out = []
  const step = Math.max(1, Math.floor(road.length / n))
  for (let i = 0; i < road.length && out.length < n; i += step) {
    const [x, y] = road[i]
    // Look along the street: whichever of the four directions has the most
    // road ahead of it. A camera pointed at the wall it is standing against
    // photographs one texture, which is the spawn-facing-a-wall defect.
    let best = 0, bestYaw = 0
    for (const [dx, dy, yaw] of [[1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2], [0, 1, 0], [0, -1, Math.PI]]) {
      let run = 0
      for (let k = 1; k < 14; k++) {
        const nx = x + dx * k, ny = y + dy * k
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) break
        if (!pt.isCirculation(terrain[ny][nx])) break
        run++
      }
      if (run > best) { best = run; bestYaw = yaw }
    }
    out.push({ x: x + 0.5, y: y + 0.5, yaw: bestYaw })
  }
  return out
}, VIEWS)

console.log(`=== HOLES — seed ${seed}, ${spots.length} street views at ${TIME}:00 ===`)
console.log('Dark rectangles sitting INSIDE a lit surface: what a person reads')
console.log('as a hole in a wall. No absolute threshold — every test below is a')
console.log('ratio against the surface the patch sits in, so the same run means')
console.log('the same thing at noon and at dusk.\n')

const holes = []
const lits = []
const blanksAll = []
let wallSamples = []
let framesWithSky = 0
let nearMisses = 0

for (let i = 0; i < spots.length; i++) {
  const sp = spots[i]
  const res = await win.evaluate(async ({ sp, volumes }) => {
    const pt = window.__pt, three = pt.renderer(), THREE = pt.THREE
    pt.flyTo(sp.x, (pt.heightAt(sp.x, sp.y) ?? 0) + 1.6, sp.y, sp.yaw, -0.02)
    for (let k = 0; k < 4; k++) await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => setTimeout(r, 120))

    const gl = three.renderer, sc = three.scene, cam = three.camera
    const src = gl.domElement
    const W = src.width, H = src.height
    const c2 = document.createElement('canvas')
    c2.width = W; c2.height = H
    const ctx = c2.getContext('2d', { willReadFrequently: true })

    // Both reads in the SAME tick with no clock advancing between them. The
    // dusk sky is animated; waiting on a frame between the two captures is
    // what made anomaly.mjs disagree with itself.
    gl.render(sc, cam)
    ctx.drawImage(src, 0, 0)
    const px = new Uint8ClampedArray(ctx.getImageData(0, 0, W, H).data)

    const GROUPS = ['buildingGroup', 'propGroup', 'terrainGroup', 'particleGroup']
    const hidden = []
    for (const g of GROUPS) {
      const grp = three[g]
      if (grp && grp.visible) { hidden.push(grp); grp.visible = false }
    }
    gl.render(sc, cam)
    const cb = document.createElement('canvas')
    cb.width = W; cb.height = H
    const bctx = cb.getContext('2d', { willReadFrequently: true })
    bctx.drawImage(src, 0, 0)
    const bg = bctx.getImageData(0, 0, W, H).data
    for (const o of hidden) o.visible = true
    gl.render(sc, cam)

    const N = W * H
    const sky = new Uint8Array(N)
    const L = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const o = i * 4
      L[i] = (0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2]) / 255
      const d = Math.abs(px[o] - bg[o]) + Math.abs(px[o + 1] - bg[o + 1]) +
        Math.abs(px[o + 2] - bg[o + 2])
      sky[i] = d <= 6 ? 1 : 0
    }

    // LOCAL SURROUND, by separable box blur over the NON-SKY pixels only.
    // Blurring across the roofline would drag the bright sky into the wall's
    // local mean and hide every hole near an eave. Radius is deliberately
    // much larger than an opening — a blur that a door fits inside would
    // average the door into its own reference.
    const R = 26
    const blurMasked = (val, mask) => {
      const sum = new Float32Array(N), cnt = new Float32Array(N)
      // horizontal
      for (let y = 0; y < H; y++) {
        let s = 0, c = 0
        for (let x = 0; x < Math.min(R + 1, W); x++) { const i = y * W + x; if (mask[i]) { s += val[i]; c++ } }
        for (let x = 0; x < W; x++) {
          const i = y * W + x
          sum[i] = s; cnt[i] = c
          const add = x + R + 1, rem = x - R
          if (add < W) { const j = y * W + add; if (mask[j]) { s += val[j]; c++ } }
          if (rem >= 0) { const j = y * W + rem; if (mask[j]) { s -= val[j]; c-- } }
        }
      }
      const s2 = new Float32Array(N), c2a = new Float32Array(N)
      for (let x = 0; x < W; x++) {
        let s = 0, c = 0
        for (let y = 0; y < Math.min(R + 1, H); y++) { const i = y * W + x; s += sum[i]; c += cnt[i] }
        for (let y = 0; y < H; y++) {
          const i = y * W + x
          s2[i] = s; c2a[i] = c
          const add = y + R + 1, rem = y - R
          if (add < H) { const j = add * W + x; s += sum[j]; c += cnt[j] }
          if (rem >= 0) { const j = rem * W + x; s -= sum[j]; c -= cnt[j] }
        }
      }
      const out = new Float32Array(N)
      for (let i = 0; i < N; i++) out[i] = c2a[i] > 0 ? s2[i] / c2a[i] : 0
      return out
    }
    const solid = new Uint8Array(N)
    for (let i = 0; i < N; i++) solid[i] = sky[i] ? 0 : 1
    const local = blurMasked(L, solid)

    // A patch is DARK when it is well under its own surround, and BRIGHT when
    // it is well over it. Both are openings; one is working and one is not.
    const DARK = 0.45, BRIGHT = 1.9
    const dark = new Uint8Array(N), bright = new Uint8Array(N)
    for (let i = 0; i < N; i++) {
      if (!solid[i] || local[i] <= 0.002) continue
      const r = L[i] / local[i]
      if (r < DARK) dark[i] = 1
      else if (r > BRIGHT) bright[i] = 1
    }

    // Connected components (4-connected, iterative stack — a recursive fill
    // blows the stack on a large frame).
    const comps = (mask) => {
      const lab = new Int32Array(N).fill(-1)
      const out = []
      const stack = []
      for (let s = 0; s < N; s++) {
        if (!mask[s] || lab[s] >= 0) continue
        const id = out.length
        let n = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9
        const vals = []
        stack.length = 0; stack.push(s); lab[s] = id
        while (stack.length) {
          const i = stack.pop()
          const x = i % W, y = (i / W) | 0
          n++; vals.push(L[i])
          if (x < x0) x0 = x; if (x > x1) x1 = x
          if (y < y0) y0 = y; if (y > y1) y1 = y
          if (x > 0 && mask[i - 1] && lab[i - 1] < 0) { lab[i - 1] = id; stack.push(i - 1) }
          if (x < W - 1 && mask[i + 1] && lab[i + 1] < 0) { lab[i + 1] = id; stack.push(i + 1) }
          if (y > 0 && mask[i - W] && lab[i - W] < 0) { lab[i - W] = id; stack.push(i - W) }
          if (y < H - 1 && mask[i + W] && lab[i + W] < 0) { lab[i + W] = id; stack.push(i + W) }
        }
        vals.sort((a, b) => a - b)
        out.push({ n, x0, x1, y0, y1, med: vals[vals.length >> 1], lab: id })
      }
      return { out, lab }
    }

    // A patch has to be big enough to READ as a hole. Below about this the
    // eye sees a mullion or an eave shadow, and a tool that reports those
    // buries the finding it exists for. Scaled off the frame so it means the
    // same thing whatever RENDER_SCALE is doing.
    const MIN_PX = Math.max(60, Math.round(N * 0.00035))

    const grade = (mask, isDark) => {
      const { out, lab } = comps(mask)
      const keep = []
      for (const c of out) {
        if (c.n < MIN_PX) continue
        // Touching the frame edge: we cannot see its shape, so we cannot say
        // whether it is a rectangle or the side of a building running out of
        // frame. Excluded rather than guessed at.
        if (c.x0 === 0 || c.y0 === 0 || c.x1 === W - 1 || c.y1 === H - 1) continue
        const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1
        const fill = c.n / (bw * bh)
        // The RING: a band just outside the bounding box. This is the surface
        // the patch is sitting in, and it is what the verdict is relative to.
        const pad = 7
        const rv = []
        let ringSky = 0, ringN = 0
        for (let y = Math.max(0, c.y0 - pad); y <= Math.min(H - 1, c.y1 + pad); y++) {
          for (let x = Math.max(0, c.x0 - pad); x <= Math.min(W - 1, c.x1 + pad); x++) {
            if (x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) continue
            const i = y * W + x
            ringN++
            if (sky[i]) { ringSky++; continue }
            if (lab[i] === c.lab) continue
            rv.push(L[i])
          }
        }
        if (rv.length < 20) continue
        rv.sort((a, b) => a - b)
        const ringMed = rv[rv.length >> 1]
        const skyFrac = ringN ? ringSky / ringN : 0
        // Against the SKY is a silhouette, not a hole — anomaly.mjs's job.
        if (skyFrac > 0.12) continue
        // A HOLE CONTAINS NOTHING BRIGHTER THAN ITSELF, and the first version
        // of this had no such test. It reported a 12000px "hole" that was a
        // SHADOWED UPPER STOREY with two lit windows inside it: the dark
        // pixels form a ring around the windows, the bounding box swallows
        // the lot, and `fill` still scores 0.9 because the ring is most of
        // the box. Rectangularity cannot tell a ring from a rectangle.
        //
        // Exact and threshold-free: walk the bbox interior and count pixels
        // brighter than the ring median. A door has none; a dark wall with
        // windows in it is mostly made of them. This is the containment
        // question CLAUDE.md keeps recommending over the interaction one.
        //
        // DIRECTION-AWARE, and the first cut was not. Testing "contains
        // anything brighter than the ring" on the BRIGHT patches rejected
        // every lit window, so the control printed "none" — a missing
        // measurement reading as an absence, which is the exact failure the
        // control exists to prevent and which `odd.mjs --feature=` already
        // made once. A dark patch must contain nothing bright; a bright patch
        // must contain nothing dark.
        let inWrong = 0, inN = 0
        for (let y = c.y0; y <= c.y1; y++) {
          for (let x = c.x0; x <= c.x1; x++) {
            const i = y * W + x
            if (sky[i]) continue
            inN++
            if (isDark ? L[i] > ringMed : L[i] < ringMed) inWrong++
          }
        }
        // ONLY THE DARK PATCHES GET THIS TEST. It exists because a dark RING
        // around two lit windows scored as one 12000px hole, and a hole is a
        // hard-edged thing so requiring a clean interior costs nothing. A
        // GLOW is not hard-edged: a lamp pool fades to nothing at its rim by
        // design, so the corners of its bounding box are dark road and the
        // test rejected every one of them. The tool then reported 1 pool
        // against 44 lit windows and I nearly filed DESIGN.md pillar 5's
        // ground layer as missing — an overhead night photograph shows the
        // pools plainly. Same shape as river.mjs's phantom dangling bridges,
        // caught the same way: the photograph adjudicates.
        if (isDark && inN && inWrong / inN > 0.06) continue
        // A HOLE IS ROUGHLY OPENING-SHAPED. The first honest run reported
        // seven survivors at aspect ratios of 11:1 to 25:1 — those are string
        // courses, sill shadows and the dark line under a jetty, all of which
        // a person reads as a MOULDING and not as a hole. A door is about
        // 0.45:1 and a window about 0.75:1, so the bound is generous in both
        // directions and still excludes a strip.
        const asp = bw / bh
        if (asp > 5 || asp < 0.18) continue
        // AND THE RING DECIDES, NOT THE BLUR. The blur (radius 26) FINDS
        // candidates; it is deliberately much wider than an opening so a door
        // cannot average itself into its own reference. But a patch can be
        // dark against that wide average while matching its immediate
        // surround exactly — which means it is sitting in a locally dark area
        // and is not a hole in anything. One survivor read 1.00x its own ring
        // and was flagged anyway. Two tests of the same thing at two scales:
        // the tighter one is the verdict.
        const rr = ringMed > 0 ? c.med / ringMed : 1
        if (isDark ? rr > 0.55 : rr < 1.6) continue
        // AND AN ABSOLUTE FLOOR, BECAUSE RELATIVE ALONE CANNOT TELL A WINDOW
        // FROM A VOID.
        //
        // At dusk the lit windows glow, so the dark ones are the only dark
        // rectangles and relative works. At NOON nothing glows, every window
        // is a dark rectangle against a bright wall, and the relative test
        // flagged fifty-four of them — which is simply what a window looks
        // like in daylight. A tool that reports every window as a defect is
        // worse than no tool.
        //
        // The line is eyeball.mjs's, not one I invented: it calls a pixel
        // "reads black" under 0.06 luma and has done for the whole tone arc.
        // Nothing in a lit scene is legitimately at zero — a real pane
        // returns the sky, a painted door returns the sun. So the RELATIVE
        // test finds candidates and the ABSOLUTE one decides, and the pair
        // behaves correctly at both hours: glass at 0.077 in daylight is a
        // window, a door at 0.005 is a hole, and at dusk unlit glass lifted
        // to ~0.09 passes while the old pure-black one did not.
        //
        // This is also the one place this tool has an opinion about a
        // rendered scene rather than about a ratio, which CLAUDE.md notes is
        // the only way to see a town that is uniformly too dark.
        if (isDark && c.med >= 0.06) { nearMiss++; continue }
        keep.push({
          n: c.n, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1,
          fill: +fill.toFixed(2),
          med: +c.med.toFixed(4),
          ring: +ringMed.toFixed(4),
          ratio: +(ringMed > 0 ? c.med / ringMed : 0).toFixed(3),
          aspect: +(bw / bh).toFixed(2),
          dark: isDark,
        })
      }
      return keep
    }

    let nearMiss = 0
    const darkC = grade(dark, true)
    const brightC = grade(bright, false)

    // --- BLANK: A LARGE FEATURELESS SURFACE FILLING THE VIEW ---------------
    //
    // The other thing a person says about a street screenshot, and the one
    // DESIGN.md names as the remaining hole: "the 30ft read IS the street
    // wall". A hole is a dark patch; a BLANK is a patch with nothing ON it —
    // a wall you can see is a wall and can say nothing else about.
    //
    // `odd.mjs` already reports `bareWallArea`, and it reads the DATA: which
    // volumes were authored `textured: false`. That cannot see a wall that IS
    // textured and still reads flat — a flank whose window grid put no
    // openings on it, a plain gable above an eave, a landmark's 42m side.
    // The cathedral measured 0.26x an ordinary building's detail density and
    // it is textured. Pixels are the only place that question is answerable.
    //
    // Measured as local GRADIENT, not variance: a smooth lighting ramp across
    // a big wall has real variance and no detail, and would read as busy.
    // A pixel is featureless when neither neighbour differs from it by more
    // than a hair RELATIVE to the local brightness — a ratio again, so a dark
    // wall and a lit one are held to the same standard and the exposure
    // cancels.
    const flat = new Uint8Array(N)
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        if (!solid[i]) continue
        const l = local[i]
        if (l <= 0.004) continue
        const gx = Math.abs(L[i + 1] - L[i - 1])
        const gz = Math.abs(L[i + W] - L[i - W])
        if ((gx + gz) / l < 0.035) flat[i] = 1
      }
    }
    const blanks = []
    {
      const { out } = comps(flat)
      // A blank has to be big enough to BE the thing you are looking at. A
      // 200px smooth patch is a roof slope; a patch that is a twentieth of
      // the frame is a wall you are standing in front of with nothing on it.
      // 4% of the frame, not 2%. A plaster panel between two timbers is
      // featureless and is also just what a half-timbered wall IS — the eye
      // does not call that a blank wall. What it calls a blank wall is a
      // large expanse with nothing at all on it, like a landmark's 40m flank.
      const MIN_BLANK = Math.round(N * 0.04)
      for (const c of out) {
        if (c.n < MIN_BLANK) continue
        const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1
        blanks.push({
          n: c.n, x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1,
          frac: +(c.n / N).toFixed(3),
          fill: +(c.n / (bw * bh)).toFixed(2),
          med: +c.med.toFixed(4),
        })
      }
      blanks.sort((a, b) => b.n - a.n)
    }

    // ONE RAY PER PATCH, at its centre — not a grid, so this stays seconds.
    // "There is a hole" is a finding; "the door on every bakery" is a fix.
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const blockers = []
    for (const g of ['buildingGroup', 'propGroup', 'terrainGroup']) {
      const grp = three[g]
      if (grp) grp.traverse((o) => { if (o.isMesh && o.visible) blockers.push(o) })
    }
    const attribute = (list) => {
      for (const c of list) {
        const u = ((c.x0 + c.x1) / 2 + 0.5) / W, v = ((c.y0 + c.y1) / 2 + 0.5) / H
        ndc.set(u * 2 - 1, -(v * 2 - 1))
        ray.setFromCamera(ndc, cam)
        ray.near = 0; ray.far = 300
        const h = ray.intersectObjects(blockers, false)[0]
        c.def = '?'
        if (!h) continue
        const p = h.point
        c.up = h.face ? +Math.abs(h.face.normal.y).toFixed(2) : 0
        for (const vv of volumes) {
          if (p.x >= vv.x0 - 0.2 && p.x <= vv.x1 + 0.2 &&
              p.z >= vv.z0 - 0.2 && p.z <= vv.z1 + 0.2 &&
              p.y >= vv.y0 - 0.2 && p.y <= vv.y1 + 0.2) { c.def = vv.def; break }
        }
        // NO BUILDING OWNS IT — SAY WHAT DOES, rather than printing `?`.
        //
        // The first sweep found a 2053px hard-edged dark SQUARE lying flat on
        // a cobbled street, and the tool could only call it "?". A hole in the
        // GROUND is a different defect from a hole in a wall and wants a
        // different fix, so the tool has to be able to tell them apart. This
        // is the "make the tool explain itself, not just count" rule: a
        // counting metric buys guesses, an explaining one buys the answer.
        if (c.def === '?') {
          c.mesh = h.object?.name || h.object?.type || '?'
          if (c.up > 0.7) {
            // Horizontal: it is the floor. Name the terrain tile under it, so
            // "a black square on the street" becomes "tile id 14".
            // Read from the store, NOT via `inspectTile` — that helper flies
            // the camera, which would move the vantage mid-sweep and
            // photograph somewhere else. A debug call with a side effect is a
            // trap when the caller is in the middle of a measurement.
            const tx = Math.floor(p.x / 3.0), tz = Math.floor(p.z / 3.0)
            const tt = pt.store.getState().map.layers
              .find((l) => l.type === 'terrain')?.terrainTiles
            c.def = `ground:${tt?.[tz]?.[tx] ?? '?'}`
          } else {
            // PropFactory MERGES its props into a handful of batches, so the
            // mesh name cannot identify one — it is `Mesh`. Ask the map
            // instead: the nearest prop to the hit point, which for a 2-tile
            // search radius is unambiguous because props do not overlap.
            // Without this the tool reports `?` for the whole non-building
            // half of the town, which is where the largest hole in the first
            // sweep turned out to be.
            const st2 = pt.store.getState()
            const props = st2.map.layers.find((l) => l.type === 'prop')?.objects ?? []
            let near = null, bd = 2.2 * 2.2
            for (const o of props) {
              const dx = (o.x + 0.5) * 3.0 - p.x, dz = (o.y + 0.5) * 3.0 - p.z
              const d = dx * dx + dz * dz
              if (d < bd) { bd = d; near = o }
            }
            c.def = near ? `prop:${near.definitionId}` : `mesh:${c.mesh}`
          }
        }
      }
    }
    attribute(darkC)
    attribute(brightC)
    attribute(blanks)
    // THE GROUND IS ALLOWED TO BE FEATURELESS. A road with no detail on it is
    // a road; the 30ft read is about the street WALL. The first run counted
    // the cobbles as 2.4% of a view and a `ground:4` terrain tile appeared in
    // the by-type table, which is the tool grading correct content as a
    // defect — the same category error humanscale made counting a 1.6m wall
    // as a storey under head height.
    //
    // And no nearest-prop fallback for a blank: it attributed a 7%-of-frame
    // wall to a LADDER standing in front of it. That guess is defensible for
    // a 200px patch and absurd for a quarter of the screen.
    const blanksV = blanks.filter((c) => (c.up ?? 0) < 0.6 &&
      !String(c.def).startsWith('prop:'))

    // Ordinary wall reference: non-sky, near-vertical, not in any patch.
    const wallRef = []
    for (let i = 0; i < N; i += 37) if (solid[i]) wallRef.push(L[i])
    wallRef.sort((a, b) => a - b)

    // Annotate and return the frame.
    ctx.lineWidth = 2
    for (const c of darkC) {
      ctx.strokeStyle = '#ff2ec4'
      ctx.strokeRect(c.x0 - 1, c.y0 - 1, c.x1 - c.x0 + 3, c.y1 - c.y0 + 3)
    }
    for (const c of brightC) {
      ctx.strokeStyle = '#38d0ff'
      ctx.strokeRect(c.x0 - 1, c.y0 - 1, c.x1 - c.x0 + 3, c.y1 - c.y0 + 3)
    }
    for (const c of blanks) {
      ctx.strokeStyle = '#ffe14d'
      ctx.strokeRect(c.x0 - 1, c.y0 - 1, c.x1 - c.x0 + 3, c.y1 - c.y0 + 3)
    }
    return {
      W, H, dark: darkC, bright: brightC, blanks: blanksV, nearMiss,
      wallMed: wallRef.length ? +wallRef[wallRef.length >> 1].toFixed(4) : 0,
      skyFrac: +(sky.reduce((a, b) => a + b, 0) / N).toFixed(3),
      png: (darkC.length || blanks.length) ? c2.toDataURL('image/png') : null,
    }
  }, { sp, volumes: scene.volumes })

  if (!res) continue
  if (res.skyFrac > 0.01) framesWithSky++
  nearMisses += res.nearMiss ?? 0
  if (res.wallMed) wallSamples.push(res.wallMed)
  for (const c of res.dark) holes.push({ ...c, view: i })
  for (const c of res.bright) lits.push({ ...c, view: i })
  for (const c of res.blanks ?? []) blanksAll.push({ ...c, view: i })
  if (res.png) {
    writeFileSync(`.shots/holes/s${seed}-v${i}.png`,
      Buffer.from(res.png.split(',')[1], 'base64'))
  }
}

await app.close()

const q = (a, f) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * f))] : 0
const byDef = new Map()
for (const h of holes) {
  const k = h.def ?? '?'
  const e = byDef.get(k) ?? { n: 0, area: 0, worst: 1 }
  e.n++; e.area += h.n; e.worst = Math.min(e.worst, h.ratio)
  byDef.set(k, e)
}

console.log(`ORDINARY WALL in these views: median luma ${q(wallSamples, 0.5).toFixed(3)}`)
// PILLAR 5's GROUND LAYER, counted rather than squinted at. DESIGN.md asks
// for "warm ground pools under every lamppost" as the first of three layers
// of warm light, and looking at a dusk street I could not tell whether they
// were rendering at all — the road in front of the camera reads near-black
// and there is a lamppost in frame. The bright-patch pass already finds and
// attributes every lit thing, so splitting it by surface orientation answers
// the question with a number: a patch on a near-horizontal face is a POOL,
// one on a vertical face is a window. Nothing else in the harness looks.
const pools = lits.filter((l) => (l.up ?? 0) > 0.7)
console.log(`  of which ${pools.length} lie on a near-horizontal surface — the LAMP POOLS,`)
console.log(`  DESIGN.md pillar 5's ground layer; ${lits.length - pools.length} are on walls.`)
console.log('  Read the pool figure as a FLOOR. A pool is a soft radial glow seen')
console.log('  at a grazing angle, so it is a faint ellipse a few pixels tall and')
console.log('  the size floor drops most of them; the overhead night view shows')
console.log('  more than this counts. It is here to catch the pools going to ZERO,')
console.log('  not to census them.')
console.log(`LIT OPENINGS (the control — this is an opening that works):`)
if (lits.length) {
  console.log(`  ${lits.length} found · median ${q(lits.map((l) => l.ratio), 0.5).toFixed(2)}x its surround` +
    ` · median ${Math.round(q(lits.map((l) => l.n), 0.5))} px`)
} else {
  console.log('  none — no lit windows in frame, so the dark figure below has')
  console.log('  no control and should be read as a hypothesis.')
}

console.log(`\nHOLES — dark, compact, opening-shaped, and BLACK: ${holes.length}`)
console.log(`  (${nearMisses} more are dark against their surround but not black —` +
  ` an ordinary\n   window in daylight is one of those, which is why the` +
  ` absolute line is here)`)
if (holes.length) {
  console.log(`  darkness  p10 ${q(holes.map((h) => h.ratio), 0.1).toFixed(2)}x` +
    `  med ${q(holes.map((h) => h.ratio), 0.5).toFixed(2)}x` +
    `  worst ${q(holes.map((h) => h.ratio), 0).toFixed(2)}x  of the wall around them`)
  console.log(`  size      med ${Math.round(q(holes.map((h) => h.n), 0.5))} px` +
    `  largest ${Math.round(q(holes.map((h) => h.n), 1))} px of a ${holes[0] ? '' : ''}frame`)
  console.log(`  fill      med ${q(holes.map((h) => h.fill), 0.5).toFixed(2)}` +
    `  (1.00 is a perfect rectangle; a shadow is ragged)`)
  console.log('\n  BY BUILDING TYPE — a class, not an instance, is the thing to fix:')
  for (const [def, e] of [...byDef.entries()].sort((a, b) => b[1].area - a[1].area).slice(0, 12)) {
    console.log(`    ${String(def).padEnd(18)} ${String(e.n).padStart(3)} holes` +
      `  ${String(e.area).padStart(6)} px  worst ${e.worst.toFixed(2)}x`)
  }
}
if (ALL && holes.length) {
  console.log('\n  EVERY HOLE:')
  for (const h of holes.sort((a, b) => a.ratio - b.ratio)) {
    console.log(`    view ${h.view}  ${String(h.def).padEnd(16)} ${String(h.n).padStart(5)}px` +
      `  ${h.ratio.toFixed(2)}x  fill ${h.fill.toFixed(2)}  aspect ${h.aspect.toFixed(2)}` +
      `  @(${h.x0},${h.y0})`)
  }
}

const blankFrac = blanksAll.reduce((a, c) => a + c.frac, 0) / Math.max(1, spots.length)
console.log(`\nBLANKS — one VERTICAL surface with no detail, filling 4%+ of the view: ${blanksAll.length}`)
console.log(`  ${(blankFrac * 100).toFixed(1)}% of an average street view is a single flat`)
console.log('  patch with no detail on it. This is DESIGN.md\'s 30ft read, and')
console.log('  `odd.mjs bareWallArea` cannot see it — that reads which volumes were')
console.log('  authored `textured: false`, so a wall that IS textured and still')
console.log('  looks flat is invisible to it.')
console.log('  The GROUND is excluded — a road with no detail on it is a road, and')
console.log('  counting it is the category error humanscale made calling a 1.6m wall')
console.log('  a storey under head height. NO TARGET is stated: a half-timbered')
console.log('  panel is featureless and is also just what that wall IS.')
if (blanksAll.length) {
  const byB = new Map()
  for (const c of blanksAll) {
    const e = byB.get(c.def ?? '?') ?? { n: 0, frac: 0 }
    e.n++; e.frac += c.frac; byB.set(c.def ?? '?', e)
  }
  for (const [def, e] of [...byB.entries()].sort((a, b) => b[1].frac - a[1].frac).slice(0, 8)) {
    console.log(`    ${String(def).padEnd(18)} ${String(e.n).padStart(3)} patches` +
      `  ${(e.frac * 100 / spots.length).toFixed(1)}% of an average view`)
  }
}

console.log(`\n  frames written to .shots/holes/  (magenta = hole, cyan = lit opening, yellow = blank)`)
console.log('\nWHAT THIS DOES NOT SEE, so nobody quotes it for the wrong thing:')
console.log('  · anything against the SKY — that is a silhouette and anomaly.mjs owns it')
console.log('  · patches under the minimum size — a mullion and an eave shadow are')
console.log('    not holes, and reporting them buries the finding this exists for')
console.log('  · long thin strips (outside 0.18:1 to 5:1) — a string course, a sill')
console.log('    shadow and the dark line under a jetty are MOULDINGS, and the first')
console.log('    honest run reported seven of them at up to 25:1')
console.log('  · a wall that is uniformly too dark. Every test here is a RATIO to')
console.log('    the local surround, so a town that is dark everywhere reads clean.')
console.log('    That is eyeball.mjs\'s absolute tone table, and it is the one')
console.log('    measure in the harness with an opinion about a rendered scene.')
console.log('\nNO TARGET IS STATED. The control above is what an opening in THIS')
console.log('town looks like when it works; compare the two rather than either')
console.log('to a number. Three hand-written targets in propscale.mjs were wrong')
console.log('on their first run, all three written from the id rather than the object.')
