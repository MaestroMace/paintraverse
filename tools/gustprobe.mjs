/**
 * GUSTPROBE — does the wind actually gust, and does the gust reach a pixel?
 *
 * `particles.mjs` grades hanging sway against an ABSOLUTE floor: is the mesh
 * moving at all. That gate exists because a constant `customProgramCacheKey`
 * once threw the sway shader away entirely and every mesh read exactly
 * 0.00000. It cannot say anything about the ENVELOPE on top of that motion,
 * because a gust and a lull both read as "moving" — so the wind shipped as
 * exactly the kind of content this repo calls a GHOST: real, plausible, and
 * with no instrument pointed at it.
 *
 * AND YOU CANNOT ANSWER IT BY WAITING. The envelope's terms are 43s and 27s
 * over a sway period of 8-12s, so any two frames may be in the same gust
 * phase, in opposite ones, or aliased against the swing underneath — which is
 * the failure the sway check itself was already fixed for once. So BOTH the
 * wind and the sway clock are pinned (`__pt.pinGust`, `__pt.pinSwayTime`) and
 * the question becomes a single-variable A/B with nothing to wait for.
 *
 *   xvfb-run -a node tools/gustprobe.mjs [seed] [--mesh=] [--time=]
 *
 * WHAT IS MEASURED. Displacement, not brightness: the mesh is ISOLATED so
 * nothing else in the scene can move, the sway clock is stepped through twelve
 * EXACT phases across one full period, and the statistic is the mean over
 * pixels of each pixel's range across those twelve — the swept excursion,
 * which is what the gust scales.
 *
 * AND IT CARRIES ITS OWN NEGATIVE CASE, TWICE OVER. Rung zero pins the gust to
 * nothing, so a correct build must read EXACTLY 0.00e+0: with one mesh visible
 * and the camera still, a frame that does not change is proof the isolation is
 * complete and that the pin reaches the shader. Then gust 1.00 is measured a
 * second time, which with the clock pinned must reproduce the first reading to
 * the digit. A verdict is only allowed to beat the noise the tool just
 * measured — never a bar I invented, which this repo has got wrong four times.
 *
 * READ THE LADDER, NOT ONLY THE RATIO. The rungs come in below the 2.70x
 * commanded, and by feature width: garments 2.47x, lantern bulbs 2.38x, 4cm
 * ropes 1.94x. A frame difference stops growing once a thing has moved
 * further than its own width, so the thinnest subject under-reports the most.
 * That ordering is the metric's, not the town's.
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome, isolate, lookAt } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const seed = Number(args.find((a) => /^\d+$/.test(a))) || 4242
const meshArg = (args.find((a) => a.startsWith('--mesh=')) ?? '').slice(7)
const MESHES = meshArg ? [meshArg] : ['ropeLanterns', 'laundryLines', 'lanternRopes']
const time = Number((args.find((a) => a.startsWith('--time=')) ?? '').slice(7)) || 18.5
const GRID = 256
const PHASES = 12

mkdirSync('.shots/gust', { recursive: true })
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

// THE PIN HAS TO EXIST OR THE RUN IS MEANINGLESS, and a missing measurement
// must never read as a pass.
const hasPin = await win.evaluate(() => typeof window.__pt.pinGust === 'function'
  && typeof window.__pt.pinSwayTime === 'function')
if (!hasPin) {
  console.log('\n  x __pt.pinGust / pinSwayTime are missing — bundle predates the hook.')
  console.log('    Rebuild before believing anything from this tool.')
  await app.close()
  process.exit(1)
}

// THE ENVELOPE'S OWN EXTREMES, sampled rather than asserted, so the two pinned
// values below are the wind's range and not two numbers I chose. Fifteen
// minutes of scene time covers both terms many times over.
const env = []
for (let t = 0; t < 900; t += 0.25) {
  const a = 0.5 + 0.5 * Math.sin(t * 0.145)
  const b = 0.5 + 0.5 * Math.sin(t * 0.234 + 1.7)
  env.push(0.5 + 0.85 * Math.pow(a * 0.65 + b * 0.35, 2.2))
}
const GUST_LO = Math.min(...env), GUST_HI = Math.max(...env)
console.log(`\n=== HANGING GUST — seed ${seed}, t=${time} ===`)
console.log(`  envelope ${GUST_LO.toFixed(3)} .. ${GUST_HI.toFixed(3)}  ` +
  `(${(GUST_HI / GUST_LO).toFixed(2)}x asked for)`)

/** A luma grid off the LIVE canvas — the repo's own idiom. Comparing PNG
 *  bytes would answer "did anything change", which in an animated scene can
 *  only ever answer yes. */
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

/**
 * Hold the wind at `g` and measure the mesh's SWEPT excursion — the mean, over
 * pixels, of each pixel's range across the frames.
 *
 * THE STATISTIC WENT WRONG TWICE BEFORE THIS AND ITS OWN NEGATIVE CASE CAUGHT
 * BOTH, which is the entire argument for having one.
 *
 *   1. ADJACENT-PAIR MAD, normalised by the frame gap, measures VELOCITY. A
 *      swing sampled four times over 0.7 of its period sometimes straddles the
 *      fast part and sometimes the turn, so the max lands wherever the phase
 *      fell. Run twice at an IDENTICAL pinned gust it read 1.69e-4 and
 *      4.23e-5 — a fourfold swing with nothing changed, larger than the 2.7x
 *      effect being graded.
 *   2. WIDEST-OF-ALL-PAIRS fixes the units — the widest separation any two
 *      frames reach IS the peak-to-peak excursion, with no clock in it — and
 *      is still an extreme over a single PAIR, so it inherits that pair's
 *      phase. Same mesh, same build, two runs: noise 1.11x and then 2.56x,
 *      with the upper rungs swinging while the lull rung held to 1%.
 *   3. PER-PIXEL RANGE OVER PINNED PHASES uses every frame at every pixel, at
 *      phases chosen rather than caught. Each pixel's max-minus-min is its own
 *      peak-to-peak; averaging thousands of them is an average of estimates
 *      rather than the extreme of six; and with the clock pinned there is no
 *      sampling left to be noisy. The negative case went 1.11x, then 2.15x,
 *      then EXACTLY 1.00x across those three versions.
 */
async function measure(g, frames = PHASES) {
  await win.evaluate((v) => window.__pt.pinGust(v), g)
  const shots = []
  for (let i = 0; i < frames; i++) {
    // EXACT PHASES, not sampled ones. The sway's slowest term is 0.51 rad/s,
    // so 12.4s is one full period and `frames` points across it visit every
    // part of the swing exactly once, the same on every run and every rung.
    await win.evaluate((t) => window.__pt.pinSwayTime(t), (i / frames) * 12.4)
    await win.waitForTimeout(360)   // one SwiftShader frame, comfortably
    shots.push(await shootGrid())
  }
  let s = 0
  const n = shots[0].length
  for (let i = 0; i < n; i++) {
    let lo = shots[0][i], hi = shots[0][i]
    for (let k = 1; k < shots.length; k++) {
      const v = shots[k][i]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    s += hi - lo
  }
  return s / n
}

let graded = 0, live = 0
for (const name of MESHES) {
  // AIM AT A REAL VERTEX. `ropeLanterns` is every lantern in the town in one
  // buffer, so its bounding-box centre is a field between them — the failure
  // the sway probe already made and had to be fixed for. A vertex is by
  // definition on an instance.
  const aim = await win.evaluate(([n, R]) => {
    const three = window.__pt.renderer()
    const drawable = (o) => o.isMesh || o.isPoints || o.isLine || o.isLineSegments
    const pts = []
    three.scene.traverse((o) => {
      if (!drawable(o) || o.name !== n) return
      const p = o.geometry?.getAttribute('position')
      if (!p || !p.count) return
      o.updateWorldMatrix(true, false)
      const m = o.matrixWorld.elements
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
        pts.push([
          m[0] * x + m[4] * y + m[8] * z + m[12],
          m[1] * x + m[5] * y + m[9] * z + m[13],
          m[2] * x + m[6] * y + m[10] * z + m[14],
        ])
      }
    })
    if (!pts.length) return null
    const s = pts[Math.floor(pts.length / 2)]
    const lo = [...s], hi = [...s]
    let c = 0
    for (const w of pts) {
      if ((w[0] - s[0]) ** 2 + (w[2] - s[2]) ** 2 > R * R) continue
      c++
      for (let k = 0; k < 3; k++) {
        if (w[k] < lo[k]) lo[k] = w[k]
        if (w[k] > hi[k]) hi[k] = w[k]
      }
    }
    return { min: lo, max: hi, near: c, total: pts.length }
  }, [name, 7])
  if (!aim) { console.log(`\n  ${name}: not in this town`); continue }

  const pad = 1.0
  const box = {
    min: [aim.min[0] - pad, aim.min[1] - pad, aim.min[2] - pad],
    max: [aim.max[0] + pad, aim.max[1] + pad, aim.max[2] + pad],
  }
  const v = await lookAt(win, box, {
    dists: [6, 9, 13, 18], heights: [0, 1.5, -1.2, 3],
    order: 'height', pick: 'largest', minFill: 0.003,
  })
  if (!v.ok) { console.log(`\n  ${name}: x ${v.why}`); continue }

  // ISOLATE, so nothing else in the frame can move. The window flicker, the
  // moths, the mist and the water shimmer are all larger than a 7cm sway and a
  // composite floor would swamp it — the puddle finding's second half, that
  // the floor has to be the RIGHT noise.
  const iso = await isolate(win, name)
  if (!iso.found) { console.log(`\n  ${name}: x isolate found nothing`); await iso.restore(); continue }
  await win.waitForTimeout(600)
  /**
   * A LADDER, NOT A PAIR — because the metric is only linear in displacement
   * while the displacement is smaller than the feature being displaced.
   *
   * A frame difference stops growing once a thin object has moved further than
   * its own width: past that you are subtracting two disjoint silhouettes and
   * the statistic plateaus at twice the object's own coverage. A rope is 4cm
   * wide and swings 3.5-9.5cm, so it under-reports at both ends of the
   * envelope; a garment is 57cm wide and stays linear throughout. That is why
   * the three meshes read 1.94x, 2.38x and 2.47x against one commanded 2.70x,
   * IN ORDER OF FEATURE WIDTH — a property of the metric, not of the town.
   *
   * So the run measures four rungs and prints them all. A shortfall against
   * the commanded ratio is then legible as compression rather than as a
   * weakening wind, and a ladder that stops climbing is legible as the metric
   * giving up. A counting metric buys guesses; an explaining one buys the
   * answer.
   *
   * Rung zero is the STATIC floor. With one mesh isolated and the camera
   * still, a pinned gust of 0 must read essentially nothing — the property
   * `windowSpill` already proves at exactly 0.00000 — so it is the render
   * noise, and it is subtracted before any ratio is taken. A ratio of two
   * numbers that both carry a constant offset is not the ratio of the things
   * they measure.
   */
  const rungs = [0, GUST_LO, 1.0, GUST_HI]
  const read = []
  for (const g of rungs) read.push(await measure(g))
  const negB = await measure(1.0)   // the negative case: 1.00 measured twice
  await win.evaluate(() => { window.__pt.pinGust(null); window.__pt.pinSwayTime(null) })
  // Clipped to the CANVAS. The measurement reads `renderer.domElement`
  // directly and never sees the panels, but the saved frame is the evidence a
  // person looks at, and two thirds editor UI is not evidence.
  await win.screenshot({ ...clip, path: `.shots/gust/${name}-${seed}-alone.png` })
  await iso.restore()

  const floor = read[0]
  const net = read.map((r) => Math.max(0, r - floor))
  const negA = read[2]
  const noise = Math.max(negA - floor, 1e-12) / Math.max(negB - floor, 1e-12)
  const nr = noise < 1 ? 1 / noise : noise
  const ratio = net[3] / Math.max(1e-12, net[1])
  console.log(`\n  ${name}  (${aim.total} verts, ${aim.near} in the cluster, ` +
    `${v.dist?.toFixed(0)}m out, fills ${((v.fill ?? 0) * 100).toFixed(1)}%)`)
  console.log('    gust   0.00 (still)  ' + read[0].toExponential(2) +
    '   <- the render floor, subtracted below')
  for (let i = 1; i < rungs.length; i++) {
    console.log(`    gust   ${rungs[i].toFixed(2)}          ` +
      `${read[i].toExponential(2)}   net ${net[i].toExponential(2)}`)
  }
  console.log(`    NEGATIVE  1.00 again  ${negB.toExponential(2)}   ` +
    `net ${Math.max(0, negB - floor).toExponential(2)}  ->  ${nr.toFixed(2)}x`)
  console.log(`    push / lull            ${ratio.toFixed(2)}x  ` +
    `(asked ${(GUST_HI / GUST_LO).toFixed(2)}x, noise ${nr.toFixed(2)}x)`)
  // The verdict clears the tool's OWN noise, measured this run, and nothing
  // else. Every hand-written bar in this repo has been wrong on its first run.
  const ok = ratio > nr && net[3] > net[1]
  if (ok) live++
  // A FAILURE HERE HAS TWO CAUSES AND THEY WANT OPPOSITE RESPONSES, so name
  // both with the number that tells them apart rather than printing a bare
  // verdict. If rung zero read nonzero, the isolation leaked and the whole
  // ladder is suspect. If it read zero and the ladder is nearly flat, the
  // MESH is the problem: a frame difference stops growing once a thin object
  // moves further than its own width, so a 4cm rope swinging 3.5-9.5cm
  // saturates at both ends of the envelope and reads as dead. That is the
  // metric plateauing, not the wind, and the fix is a wider subject or a
  // finer grid — never a lower bar.
  console.log(`    ${ok ? 'LIVE' : 'NOT SEPARABLE — ' + (floor > 1e-9
    ? `the static floor is ${floor.toExponential(2)}, so the isolation leaked`
    : `the ladder climbs ${(net[3] / Math.max(1e-12, net[1])).toFixed(2)}x ` +
      'over its whole span; at this grid the subject is too thin to resolve')}`)
  graded++
}

if (!graded) console.log('\n  nothing graded. No hanging mesh could be framed.')
else console.log(`\n  ${live} of ${graded} meshes separate a push from a lull.`)
console.log('A ratio inside the negative case means the envelope is not')
console.log('reaching the picture, whatever the uniform says.')
await app.close()
