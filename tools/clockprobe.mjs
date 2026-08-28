/**
 * CLOCKPROBE — does the town clock tell the time, and does it run FORWARDS?
 *
 * `timeOfDay` is a labelled control that the sky, all four lighting branches,
 * the lanterns, the stars, the moon, the mist and the meteors read. The clock
 * did not: its hands were `(hash % 12) / 12`, a fixed random hour per
 * building. That is the GHOST-WITH-A-USER-INTERFACE failure this repo already
 * records for `moonPhase` and the weather buttons, in the one object whose
 * entire job is to display the value.
 *
 *   xvfb-run -a node tools/clockprobe.mjs [seed]
 *
 * THIS IS THE RARE CHECK WITH NOTHING TO TUNE. A clock is right or it is not,
 * so the probe reads the instance matrices, recovers each hand's bearing in
 * its own dial plane, and compares it to the hour — no threshold beyond float
 * tolerance and no target anyone invented.
 *
 * AND IT GRADES THE HANDEDNESS SEPARATELY, because that was the defect the
 * random hour was hiding. The baked hands rotated by `-ang` on all four
 * dials; seen from outside a dial whose normal is -Z or -X the viewer's right
 * has flipped, so two faces in four ran ANTICLOCKWISE. Nobody could see it
 * while the hour was meaningless — a backwards clock at a random time is a
 * clock at a different random time. **A random value hides a sign error**,
 * which is an argument for real values over plausible ones even where the
 * fake one looks fine.
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome, lookAt } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const seed = Number(args.find((a) => /^\d+$/.test(a))) || 4242

mkdirSync('.shots/clock', { recursive: true })
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
await hideChrome(win)

if (!await win.evaluate(() => typeof window.__pt.clocks === 'function')) {
  console.log('\n  x __pt.clocks is missing — this bundle predates the hook.')
  await app.close(); process.exit(1)
}

console.log(`\n=== GREAT CLOCK — seed ${seed} ===`)
const c0 = await win.evaluate(() => window.__pt.clocks())
console.log(`  ${c0.count} hands (${c0.count / 2} dials) in the town`)
if (!c0.count) {
  console.log('  none built. Either this seed grew no clock_tower, or every')
  console.log('  face was under the 0.55m dial minimum — typemix.mjs and the')
  console.log('  `greatClock` tally in features.mjs tell you which.')
  await app.close(); process.exit(0)
}

/**
 * Read every hand as {origin, tip direction, length}.
 *
 * Column 1 of the instance matrix is the hand's own +Y — the direction it
 * POINTS — scaled by its length, so the bearing and the hour/minute
 * distinction both fall out of the matrix with nothing inferred.
 */
const readHands = () => win.evaluate(() => {
  const three = window.__pt.renderer()
  let m = null
  three.scene.traverse((o) => { if (o.name === 'clockHands') m = o })
  if (!m) return null
  const T = window.__pt.THREE
  const mat = new T.Matrix4()
  const out = []
  for (let i = 0; i < m.count; i++) {
    m.getMatrixAt(i, mat)
    const e = mat.elements
    out.push({
      o: [e[12], e[13], e[14]],
      // Column 1 = local +Y after the full transform.
      tip: [e[4], e[5], e[6]],
    })
  }
  return out
})

const first = await readHands()
if (!first) { console.log('  x no mesh named "clockHands"'); await app.close(); process.exit(1) }

const len = (v) => Math.hypot(v[0], v[1], v[2])
const norm = (v) => { const l = len(v) || 1; return [v[0] / l, v[1] / l, v[2] / l] }
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// Both hands of one dial share an origin exactly, so grouping needs no
// tolerance — and the SHORTER of the pair is the hour hand, which is what a
// clock is, so nothing about the ordering has to be assumed.
const dials = new Map()
first.forEach((h, i) => {
  const k = h.o.map((v) => v.toFixed(4)).join(',')
  const a = dials.get(k) ?? []
  a.push({ i, l: len(h.tip), o: h.o })
  dials.set(k, a)
})
const hourIdx = []
for (const a of dials.values()) {
  if (a.length !== 2) continue
  hourIdx.push(a[0].l <= a[1].l ? a[0] : a[1])
}
console.log(`  ${dials.size} dials paired, ${hourIdx.length} hour hands identified`)

/**
 * The OUTWARD normal of each dial, taken from the tower it belongs to.
 *
 * A dial's normal points away from the shaft, and the shaft is the centroid of
 * the four dials on it — so clustering by proximity and pointing away from the
 * centre is exact and needs no knowledge of the building. The sign of that
 * normal is the whole question: it decides which way "clockwise" is, and
 * getting it from the geometry rather than from a table is what keeps this
 * probe from inheriting the bug it is testing for.
 */
const towers = []
for (const h of hourIdx) {
  let t = towers.find((x) => Math.hypot(...sub(x.sum.map((v) => v / x.n), h.o)) < 8)
  if (!t) { t = { sum: [0, 0, 0], n: 0, members: [] }; towers.push(t) }
  t.sum = [t.sum[0] + h.o[0], t.sum[1] + h.o[1], t.sum[2] + h.o[2]]
  t.n++
  t.members.push(h)
}
const UP = [0, 1, 0]

/** Bearing of a hand within its dial, measured clockwise from 12 as seen from
 *  OUTSIDE — which is what a person reading the clock does. */
function bearing(tip, outward) {
  // A viewer outside looks along -outward with up +Y, so their right is
  // -(outward x up). Verified against the +Z case: right = +X.
  const R = cross(outward, UP).map((v) => -v)
  const t = norm(tip)
  return Math.atan2(dot(t, R), dot(t, UP))
}
const wrap = (a) => { let x = a; while (x > Math.PI) x -= Math.PI * 2; while (x < -Math.PI) x += Math.PI * 2; return x }

// THREE HOURS, because one reading cannot separate "right" from "stuck". The
// offsets are the per-clock few-minutes error, so the hour hand's tolerance is
// (4/60)/12 of a turn = 0.035 rad plus float slop.
const HOURS = [3, 6, 9.5]
let worst = 0, backwards = 0, graded = 0
for (const hh of HOURS) {
  await win.evaluate((h) => window.__pt.store.getState().updateEnvironment({ timeOfDay: h }), hh)
  await win.waitForTimeout(400)
  const hands = await readHands()
  const expect = ((hh % 12) / 12) * Math.PI * 2
  const errs = []
  for (const t of towers) {
    const c = [t.sum[0] / t.n, t.sum[1] / t.n, t.sum[2] / t.n]
    for (const h of t.members) {
      const out = norm([h.o[0] - c[0], 0, h.o[2] - c[2]])
      if (!isFinite(out[0])) continue
      const b = bearing(hands[h.i].tip, out)
      const e = Math.abs(wrap(b - expect))
      errs.push(e)
      graded++
      if (e > worst) worst = e
      // A backwards dial reads the MIRROR of the right answer, so its error is
      // about twice the expected bearing rather than a small slip.
      if (e > 0.25 && Math.abs(wrap(b + expect)) < 0.25) backwards++
    }
  }
  const mx = errs.length ? Math.max(...errs) : NaN
  console.log(`  ${String(hh).padStart(4)}:00  expected ${(expect * 180 / Math.PI).toFixed(1).padStart(6)} deg   ` +
    `worst hand off by ${(mx * 180 / Math.PI).toFixed(2)} deg`)
}

console.log(`\n  ${graded} hour-hand readings over ${HOURS.length} hours`)
console.log(`  worst error ${(worst * 180 / Math.PI).toFixed(2)} deg  ` +
  `(a few minutes of per-clock offset is ${(0.035 * 180 / Math.PI).toFixed(1)} deg)`)
console.log(`  dials running BACKWARDS: ${backwards}`)
console.log(`  ${worst < 0.09 && backwards === 0 ? 'TELLS THE TIME, AND FORWARDS'
  : backwards ? 'MIRRORED — the handedness fix did not reach every face'
    : 'OFF — the hands do not follow timeOfDay'}`)

// AND A PICTURE, because a number cannot say whether it READS as a clock.
// 10:10 is the hour every catalogue photograph uses, for the good reason that
// both hands are clear of each other and of the numerals.
await win.evaluate(() => window.__pt.store.getState().updateEnvironment({ timeOfDay: 10.17 }))
await win.waitForTimeout(500)
const box = await win.evaluate(() => {
  const three = window.__pt.renderer()
  let m = null
  three.scene.traverse((o) => { if (o.name === 'clockHands') m = o })
  if (!m) return null
  const T = window.__pt.THREE
  const mat = new T.Matrix4(), p = new T.Vector3()
  m.getMatrixAt(0, mat); p.setFromMatrixPosition(mat)
  const r = 1.5
  return { min: [p.x - r, p.y - r, p.z - r], max: [p.x + r, p.y + r, p.z + r] }
})
if (box) {
  const v = await lookAt(win, box, {
    dists: [5, 8, 12, 18], heights: [0, -4, -9, 2],
    order: 'height', pick: 'largest', minFill: 0.01,
  })
  if (v.ok) {
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
    await win.screenshot({ ...(canvas ? { clip: canvas } : {}), path: `.shots/clock/clock-${seed}-1010.png` })
    console.log(`\n  ✓ .shots/clock/clock-${seed}-1010.png at 10:10, ${v.dist?.toFixed(1)}m out`)
  } else {
    console.log(`\n  (no clear view for a photograph: ${v.why})`)
  }
}
await app.close()
