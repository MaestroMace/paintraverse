/**
 * BLINKPROBE — do the cat's eyes blink, and do the two of them do it TOGETHER?
 *
 * A cat on a sill is four pixels of dark fur and two emissive specks, and the
 * specks are the whole feature. A steady speck is a LAMP, and this town has
 * hundreds; what makes it a creature is that the light goes out for a moment.
 * So the blink is the content, and none of the existing instruments can see
 * it: `particles.mjs` grades particle systems and a cat is geometry,
 * `features.mjs` counts the gate that placed it, and a still photograph misses
 * a two-tenths-of-a-second wink thirty times in thirty-one.
 *
 *   xvfb-run -a node tools/blinkprobe.mjs [seed] [--time=]
 *
 * THREE QUESTIONS, AND THE THIRD IS THE ONE THAT WOULD HAVE SHIPPED BROKEN.
 *
 *   1. DOES IT FIRE — do the eyes actually go dark, and how far down.
 *   2. THE DUTY CYCLE — a cat is open-eyed nearly all the time. A feature that
 *      is shut half the time is a strobe, not a blink.
 *   3. DO BOTH EYES GO TOGETHER. The phase comes from world position, and the
 *      two eyes of one cat are 6cm apart. A SMOOTH function of position (the
 *      sway's trick) separates them by about a fiftieth of a radian; a
 *      QUANTISED one — the obvious way to give each cat a single value —
 *      straddles a cell boundary on roughly one cat in twenty-five and winks
 *      it forever. That is invisible to any count and unmistakable to a
 *      person, so it is measured: the two eyes are tracked as separate pixel
 *      clusters and their darkest frames must coincide.
 *
 * THE CLOCK IS PINNED (`__pt.pinCatTime`), so the probe asks for exact phases
 * across one blink slot rather than catching one by waiting. The gust probe's
 * own negative case is what proved sampled phases unusable — it read noise the
 * same size as the effect until the clock was pinned — and a blink is a far
 * narrower target than a swing.
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome, isolate, lookAt } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const seed = Number(args.find((a) => /^\d+$/.test(a))) || 4242
const time = Number((args.find((a) => a.startsWith('--time=')) ?? '').slice(7)) || 18.5
const GRID = 384
/** One blink slot is 1 / 0.175 s. Stepped finely enough that the ~0.32s dip
 *  lands on several samples rather than being jumped over. */
const SLOT = 1 / 0.175
const STEPS = 56

mkdirSync('.shots/blink', { recursive: true })
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
if (!await win.evaluate(() => typeof window.__pt.pinCatTime === 'function')) {
  console.log('\n  x __pt.pinCatTime is missing — this bundle predates the hook.')
  await app.close()
  process.exit(1)
}

console.log(`\n=== CAT BLINK — seed ${seed}, t=${time} ===`)

/**
 * ONE CAT, NOT THE MERGED MESH. `catEyes` is every cat in the town in one
 * buffer, so its bounding box is the town and its centre is a street between
 * them — the centroid failure this repo has now paid for three times. A vertex
 * is by definition on a real instance; gather only what is within 30cm of it,
 * which is one cat's two eyes and cannot reach a neighbour's.
 */
const aim = await win.evaluate(() => {
  const three = window.__pt.renderer()
  let pts = []
  three.scene.traverse((o) => {
    if (o.name !== 'catEyes' || !o.geometry) return
    const p = o.geometry.getAttribute('position')
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
    if ((w[0] - s[0]) ** 2 + (w[1] - s[1]) ** 2 + (w[2] - s[2]) ** 2 > 0.09) continue
    c++
    for (let k = 0; k < 3; k++) {
      if (w[k] < lo[k]) lo[k] = w[k]
      if (w[k] > hi[k]) hi[k] = w[k]
    }
  }
  return { min: lo, max: hi, near: c, total: pts.length }
})
if (!aim) {
  console.log('  no mesh named "catEyes" in this town.')
  console.log('  features.mjs owns the RATE; if windowCat is zero here the gate')
  console.log('  did not fire on this seed, which is a different finding.')
  await app.close()
  process.exit(0)
}
console.log(`  ${aim.total} eye vertices town-wide; ${aim.near} on the cat aimed at`)

// CLOSE. A cat is 30cm and its eyes are 2.4cm — the standoffs that frame a
// belfry put it under one sample. `asset.mjs`'s lesson: how far back you stand
// is decided by the subject, never by a table.
const pad = 0.22
const box = {
  min: [aim.min[0] - pad, aim.min[1] - pad, aim.min[2] - pad],
  max: [aim.max[0] + pad, aim.max[1] + pad, aim.max[2] + pad],
}
const v = await lookAt(win, box, {
  dists: [1.4, 2.0, 2.8, 4.0], heights: [0, 0.6, -0.6, 1.6],
  order: 'height', pick: 'largest', minFill: 0.0005,
})
if (!v.ok) { console.log(`  x ${v.why}`); await app.close(); process.exit(0) }
console.log(`  framed from ${v.dist?.toFixed(1)}m, fills ${((v.fill ?? 0) * 100).toFixed(2)}%`)

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

// ISOLATED, so the only thing that can change between frames is the eyes.
const iso = await isolate(win, 'catEyes')
if (!iso.found) {
  console.log('  x isolate found no catEyes mesh')
  await iso.restore(); await app.close(); process.exit(1)
}
await win.waitForTimeout(600)

const frames = []
for (let i = 0; i < STEPS; i++) {
  await win.evaluate((t) => window.__pt.pinCatTime(t), (i / STEPS) * SLOT)
  await win.waitForTimeout(330)
  frames.push(await shootGrid())
}
await win.evaluate(() => window.__pt.pinCatTime(null))
await win.screenshot({ ...clip, path: `.shots/blink/cat-${seed}-alone.png` })
await iso.restore()

// THE EYE PIXELS ARE THE ONES THAT ARE EVER BRIGHT, taken from the per-pixel
// MAX across the sweep rather than from any single frame — pick one frame and
// you might have picked the blink, and then the mask is empty and the tool
// reports a working feature as absent. The moon's mask failure, in miniature.
const n = frames[0].length
const peak = new Array(n).fill(0)
for (const f of frames) for (let i = 0; i < n; i++) if (f[i] > peak[i]) peak[i] = f[i]
const hi = Math.max(...peak)
const THRESH = hi * 0.45
const eyePx = []
for (let i = 0; i < n; i++) if (peak[i] >= THRESH) eyePx.push(i)
if (eyePx.length < 6) {
  console.log(`  x only ${eyePx.length} eye pixels above ${THRESH.toFixed(3)} — ` +
    'too few to grade. A metric cannot resolve a feature smaller than its grid.')
  await app.close(); process.exit(1)
}

// TWO CLUSTERS BY SCREEN X — the two eyes. Split at the midpoint of their own
// x range, which is exact for a pair side by side and degrades to "one blob"
// rather than to a wrong answer when the standoff cannot resolve them.
const xs = eyePx.map((i) => i % GRID)
const xLo = Math.min(...xs), xHi = Math.max(...xs)
const mid = (xLo + xHi) / 2
const left = eyePx.filter((i) => (i % GRID) < mid)
const right = eyePx.filter((i) => (i % GRID) >= mid)
const series = (px) => frames.map((f) => px.reduce((s, i) => s + f[i], 0) / px.length)
const all = series(eyePx)
const openLevel = Math.max(...all)
const shutLevel = Math.min(...all)
const shutFrames = all.filter((x) => x < openLevel * 0.5).length

console.log(`\n  eye pixels ${eyePx.length}  (left ${left.length}, right ${right.length}), ` +
  `x span ${xLo}..${xHi} of ${GRID}`)
console.log(`  open  ${openLevel.toFixed(4)}   shut  ${shutLevel.toFixed(4)}   ` +
  `dip to ${(shutLevel / Math.max(1e-9, openLevel) * 100).toFixed(1)}% of open`)
console.log(`  shut on ${shutFrames} of ${STEPS} phases  = ` +
  `${(shutFrames / STEPS * 100).toFixed(1)}% of a slot  ` +
  `(${(shutFrames / STEPS * SLOT).toFixed(2)}s of ${SLOT.toFixed(2)}s)`)

// A cat's blink is a couple of tenths of a second and a cat's eyes are open
// the rest of the time. Both ends matter: no dip is a lamp, a long dip is a
// strobe.
const fires = shutLevel < openLevel * 0.5
const duty = shutFrames / STEPS
console.log(`  ${fires ? 'BLINKS' : 'DOES NOT BLINK — the eyes never go dark'}` +
  (fires && duty > 0.25 ? '  — but the dip is long enough to read as a strobe' : ''))

if (left.length >= 3 && right.length >= 3 && xHi - xLo >= 3) {
  const L = series(left), R = series(right)
  const argmin = (a) => a.indexOf(Math.min(...a))
  const li = argmin(L), ri = argmin(R)
  // Circular distance: the slot wraps, so a dip at phase 0 and one at the last
  // step are adjacent, not maximally apart.
  const d = Math.min(Math.abs(li - ri), STEPS - Math.abs(li - ri))
  console.log(`\n  BOTH EYES  darkest at phase ${li} and ${ri} of ${STEPS}` +
    `  — ${d} step${d === 1 ? '' : 's'} apart`)
  console.log(`  ${d <= 1 ? 'TOGETHER — no wink' : 'WINKING — the two eyes are ' +
    'out of phase, so the position hash is separating them'}`)
} else {
  // SAYING SO IS THE POINT. A silent skip here would let the one defect this
  // tool exists to catch pass as a clean board.
  console.log(`\n  BOTH EYES  NOT GRADED — the two eyes are not resolved at this ` +
    `standoff (x span ${xHi - xLo} samples). Move closer or raise GRID; do not`)
  console.log('  read the verdict above as covering the wink case.')
}
console.log('\nfeatures.mjs owns the cat RATE; this owns whether it is alive.')
await app.close()
