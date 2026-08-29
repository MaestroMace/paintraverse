/**
 * VANEPROBE — is there ONE WIND, and does everything that measures it agree?
 *
 * Grades both instruments together, deliberately. A vane and a flag
 * disagreeing about the wind is worse than either being wrong alone: one
 * arbitrary bearing reads as a decoration, two contradictory ones read as a
 * mistake, because the eye can see there is a wind and see something ignoring
 * it. So the opposition between them — a vane points INTO the wind, a flag
 * streams AWAY from it — is a graded row rather than an assumption.
 *
 * A vane welded at a fixed bearing is a decoration shaped like an instrument.
 * Worse, ninety of them at ninety different fixed bearings say the wind blows
 * a different way on every roof, which is the one statement a skyline of vanes
 * exists to make. So this asks the two questions that matter and they pull in
 * opposite directions:
 *
 *   1. DO THEY MOVE. Read the town's own bearing over time — it must change —
 *      and then prove the movement reaches PIXELS, because a number changing
 *      in a uniform is the "setter accepted and discarded" failure this repo
 *      has now recorded five times.
 *   2. DO THEY AGREE. Every other moving thing here is deliberately given its
 *      own phase, because a town in lockstep is a metronome. The vane is the
 *      exception: the wind is a fact about the PLACE, so a hundred arrows
 *      leaning together as a gust crosses town is the whole effect, and
 *      per-vane variation must stay down at turbulence.
 *
 * THE GUST IS PINNED (`__pt.pinGust`) for the pixel half, which turns "does it
 * move" into a single-variable A/B with nothing to wait for — the fix
 * `gustprobe.mjs` needed after its own negative case proved sampled phases
 * unusable.
 *
 *   xvfb-run -a node tools/vaneprobe.mjs [seed] [--time=]
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome, isolate, lookAt } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const seed = Number(args.find((a) => /^\d+$/.test(a))) || 4242
const time = Number((args.find((a) => a.startsWith('--time=')) ?? '').slice(7)) || 12
const GRID = 256

mkdirSync('.shots/vane', { recursive: true })
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
await win.evaluate((h) => window.__pt.store.getState().updateEnvironment({ timeOfDay: h }), time)
await hideChrome(win)

// A MISSING MEASUREMENT MUST NOT READ AS A PASS.
if (!await win.evaluate(() => typeof window.__pt.vanes === 'function')) {
  console.log('\n  x __pt.vanes is missing — this bundle predates the hook.')
  await app.close(); process.exit(1)
}

const v0 = await win.evaluate(() => window.__pt.vanes())
console.log(`\n=== WEATHERVANES — seed ${seed}, t=${time} ===`)
console.log(`  ${v0.count} vanes in the town`)
if (!v0.count) {
  // AN ABSENCE HAS TWO CAUSES AND THEY WANT OPPOSITE FIXES.
  console.log('  none built. Either this seed grew no spire or tower that')
  console.log('  passed the gate, or the emit path is broken — features.mjs')
  console.log('  owns the rate and can tell you which.')
  await app.close(); process.exit(0)
}

// 1a. THE BEARING MUST MOVE. Read the town's own value rather than
// re-deriving the formula, so the probe cannot drift away from the source.
const bearings = []
for (let i = 0; i < 5; i++) {
  bearings.push((await win.evaluate(() => window.__pt.vanes())).bearing)
  await win.waitForTimeout(1400)
}
let bLo = Infinity, bHi = -Infinity
for (const b of bearings) { if (b < bLo) bLo = b; if (b > bHi) bHi = b }
const swingDeg = (bHi - bLo) * 180 / Math.PI
console.log(`  bearing over ~5.6s: ${bearings.map((b) => (b * 180 / Math.PI).toFixed(1)).join(', ')} deg`)
console.log(`  swing ${swingDeg.toFixed(2)} deg  ` +
  `${swingDeg > 0.05 ? '— turning' : '— STATIC, the tick is not running'}`)

// 1b. AND THE MOVEMENT HAS TO REACH PIXELS. A uniform that changes while the
// picture does not is the failure this repo keeps finding.
const box = await win.evaluate(() => {
  const three = window.__pt.renderer()
  let m = null
  three.scene.traverse((o) => { if (o.name === 'weatherVanes') m = o })
  if (!m) return null
  // An InstancedMesh's own bounding box is the whole town, so aim at ONE
  // instance — a vertex is on a real instance and an instance matrix names
  // one exactly. The centroid failure, avoided rather than repeated.
  const mat = new window.__pt.THREE.Matrix4()
  const p = new window.__pt.THREE.Vector3()
  m.getMatrixAt(Math.floor(m.count / 2), mat)
  p.setFromMatrixPosition(mat)
  const r = 0.7
  return { min: [p.x - r, p.y - r, p.z - r], max: [p.x + r, p.y + r, p.z + r] }
})
if (!box) {
  console.log('  x no mesh named "weatherVanes" — the arrows were not drawn.')
  await app.close(); process.exit(1)
}
const view = await lookAt(win, box, {
  dists: [4, 6, 9, 14], heights: [0, -2, -5, 2],
  order: 'height', pick: 'largest', minFill: 0.004,
})
if (!view.ok) { console.log(`  x ${view.why}`); await app.close(); process.exit(0) }
console.log(`  framed from ${view.dist?.toFixed(1)}m, fills ${((view.fill ?? 0) * 100).toFixed(1)}%`)

const canvas = await win.evaluate(() => {
  let best = null
  for (const c of document.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect()
    if (!best || r.width * r.height > best.width * best.height) {
      best = { x: r.x, y: r.y, width: r.width, height: r.height }
    }
  }
  return best
})
const clip = canvas ? { clip: canvas } : {}
const shootGrid = () => win.evaluate((n) => {
  const cv = window.__pt.renderer().renderer.domElement
  const c2 = document.createElement('canvas')
  c2.width = n; c2.height = n
  const g2 = c2.getContext('2d', { willReadFrequently: true })
  g2.drawImage(cv, 0, 0, n, n)
  const d = g2.getImageData(0, 0, n, n).data
  const out = new Array(n * n)
  for (let i = 0; i < n * n; i++) {
    out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255
  }
  return out
}, GRID)

const iso = await isolate(win, 'weatherVanes')
if (!iso.found) {
  console.log('  x isolate found no weatherVanes mesh')
  await iso.restore(); await app.close(); process.exit(1)
}
await win.waitForTimeout(600)
// PIN THE GUST AND SWING IT. The base direction drifts on its own clock, so
// with it uncontrolled a "did it move" reading is partly the passage of time;
// pinning gives one variable and a repeat at the SAME pin gives the floor.
const grab = async (g) => {
  await win.evaluate((x) => window.__pt.pinGust(x), g)
  await win.waitForTimeout(700)
  return shootGrid()
}
const a1 = await grab(1.0)
const a2 = await grab(1.0)
const b1 = await grab(0.5)
const b2 = await grab(1.35)
await win.evaluate(() => window.__pt.pinGust(null))
await win.screenshot({ ...clip, path: `.shots/vane/vanes-${seed}-alone.png` })
await iso.restore()
await win.screenshot({ ...clip, path: `.shots/vane/vanes-${seed}-scene.png` })

const mad = (u, w) => {
  let d = 0
  for (let i = 0; i < u.length; i++) d += Math.abs(u[i] - w[i])
  return d / u.length
}
// THE FLOOR IS THE SAME PIN TWICE. Two frames at an identical gust still carry
// the drifting base bearing and whatever the renderer does between frames, so
// that pair — not zero, and not a number I picked — is what the swing has to
// beat.
const floor = mad(a1, a2)
const swung = mad(b1, b2)
console.log(`\n  PIXELS   gust 1.00 twice      ${floor.toExponential(2)}  <- floor`)
console.log(`           gust 0.50 vs 1.35    ${swung.toExponential(2)}` +
  `   = ${(swung / Math.max(1e-12, floor)).toFixed(1)}x`)
console.log(`  ${swung > floor * 2 ? 'THE SWING REACHES THE PICTURE'
  : 'NOT SEPARABLE — the gust moves the uniform but not the pixels'}`)

// 2. DO THEY AGREE. One shared bearing by construction, so what is actually
// checked is that the per-vane term stayed at turbulence — the spread of the
// instance rotations about the town's own bearing.
const spread = await win.evaluate(() => {
  const three = window.__pt.renderer()
  let m = null
  three.scene.traverse((o) => { if (o.name === 'weatherVanes') m = o })
  if (!m) return null
  const mat = new window.__pt.THREE.Matrix4()
  const q = new window.__pt.THREE.Quaternion()
  const p = new window.__pt.THREE.Vector3()
  const s = new window.__pt.THREE.Vector3()
  const e = new window.__pt.THREE.Euler()
  const ys = []
  for (let i = 0; i < m.count; i++) {
    m.getMatrixAt(i, mat)
    mat.decompose(p, q, s)
    e.setFromQuaternion(q, 'YXZ')
    ys.push(e.y)
  }
  return ys
})
if (spread && spread.length > 2) {
  // Circular spread: bearings wrap, so compare through the mean VECTOR rather
  // than through the raw radians — otherwise two vanes either side of PI read
  // as maximally disagreeing when they are pointing the same way.
  let sx = 0, sy = 0
  for (const y of spread) { sx += Math.cos(y); sy += Math.sin(y) }
  const mean = Math.atan2(sy, sx)
  let worst = 0
  for (const y of spread) {
    let d = Math.abs(y - mean)
    while (d > Math.PI) d = Math.abs(d - Math.PI * 2)
    if (d > worst) worst = d
  }
  const R = Math.hypot(sx, sy) / spread.length
  console.log(`\n  AGREEMENT  ${spread.length} vanes, mean bearing ` +
    `${(mean * 180 / Math.PI).toFixed(1)} deg`)
  console.log(`             worst departure ${(worst * 180 / Math.PI).toFixed(1)} deg, ` +
    `concentration R = ${R.toFixed(3)}`)
  // R is 1 for perfect agreement and 0 for a uniform scatter. The old build
  // welded each arrow at `rand01 * 2PI`, which is exactly that scatter, so
  // this row separates the fix from what it replaced with no threshold to
  // argue about.
  console.log(`  ${R > 0.9 ? 'ONE WIND — the skyline agrees'
    : R > 0.5 ? 'PARTIAL — the per-vane term is too large to read as one wind'
      : 'SCATTERED — every roof has its own wind, which is the defect'}`)
}
/**
 * AND THE BANNERS, which had the identical defect one file over: a yaw of
 * `rand01(hash, 1607) * 2PI` under a comment saying "so banners on different
 * buildings flap in different directions" — word for word what the vanes said.
 *
 * A direction's compass yaw comes straight out of the instance matrix:
 * `Ry(t)` maps +X to `(cos t, 0, -sin t)`, and both the arrow and the flag are
 * authored pointing +X, so `atan2(-z, x)` of column 0 is what each one is
 * actually doing in the world. Nothing inferred and no formula restated.
 */
const yaws = (meshName) => win.evaluate((n) => {
  const three = window.__pt.renderer()
  let m = null
  three.scene.traverse((o) => { if (o.name === n) m = o })
  if (!m) return null
  const T = window.__pt.THREE
  const mat = new T.Matrix4()
  const out = []
  for (let i = 0; i < m.count; i++) {
    m.getMatrixAt(i, mat)
    const e = mat.elements
    out.push(Math.atan2(-e[2], e[0]))
  }
  return out
}, meshName)
/** Circular mean and concentration. R is 1 for perfect agreement and 0 for a
 *  uniform scatter — which is exactly what `rand01 * 2PI` produced, so the row
 *  separates the fix from what it replaced with no threshold to argue about. */
const circ = (a) => {
  let sx = 0, sy = 0
  for (const y of a) { sx += Math.cos(y); sy += Math.sin(y) }
  return { mean: Math.atan2(sy, sx), R: Math.hypot(sx, sy) / a.length }
}
const wrapPi = (a) => { let x = a; while (x > Math.PI) x -= Math.PI * 2; while (x < -Math.PI) x += Math.PI * 2; return x }

const vy = await yaws('weatherVanes')
const by = await yaws('banners')
if (by && by.length && vy && vy.length) {
  const V = circ(vy), B = circ(by)
  console.log(`\n  BANNERS   ${by.length} flags, mean bearing ` +
    `${(B.mean * 180 / Math.PI).toFixed(1)} deg, concentration R = ${B.R.toFixed(3)}`)
  // A flag streams DOWNWIND and a vane points UPWIND, so the two must sit half
  // a turn apart. That opposition is the claim; agreeing exactly would mean
  // one of them is wrong.
  const opp = Math.abs(Math.abs(wrapPi(B.mean - V.mean)) - Math.PI) * 180 / Math.PI
  console.log(`  vanes ${(V.mean * 180 / Math.PI).toFixed(1)} deg vs flags ` +
    `${(B.mean * 180 / Math.PI).toFixed(1)} deg — ` +
    `${opp.toFixed(1)} deg from the half-turn they should differ by`)
  console.log(`  ${B.R > 0.85 && opp < 20 ? 'ONE WIND — the vanes point into it and the flags stream away'
    : B.R <= 0.85 ? 'FLAGS SCATTERED — every roof has its own wind'
      : 'FLAGS NOT OPPOSED — they are not streaming downwind of the vanes'}`)
} else if (vy && vy.length) {
  console.log('\n  BANNERS   none in this town — flagPole needs a noble, temple')
  console.log('            or wealthy building. features.mjs owns that rate.')
} else {
  // SAYING NOTHING IS NOT A RESULT. The first cut of this block forgot to
  // forward the mesh name into `win.evaluate`, so `o.name === undefined`
  // matched nothing, both branches above were skipped and the tool printed
  // NO LINE AT ALL — a missing measurement reading as silence, in the check
  // written to grade the sibling sweep. An unreachable else is cheap.
  console.log(`\n  BANNERS   NOT GRADED — read ${vy ? vy.length : 'null'} vane`)
  console.log('            yaws and could not identify the meshes.')
}
console.log('\nfeatures.mjs owns the vane RATE; this owns whether it is an instrument.')
await app.close()
