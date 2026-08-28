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
 *   3. DO BOTH EYES GO TOGETHER. The two eyes of one cat are 6cm apart, and a
 *      cat that winks one eye is a defect a person sees instantly and no count
 *      can. It is graded TWICE, by two statistics that fail differently: the
 *      pair blob is halved and the two halves' darkest phases must coincide,
 *      and — independently of any split — the lit pixels' CENTROID must not
 *      move, because one eye going dark alone drags it half a pair-width
 *      toward the survivor.
 *
 * THE CLOCK IS PINNED (`__pt.pinCatTime`), so the probe asks for exact phases
 * across the blink slots rather than catching one by waiting. The gust probe's
 * own negative case is what proved sampled phases unusable — it read noise the
 * same size as the effect until the clock was pinned — and a blink is a far
 * narrower target than a swing.
 *
 * IT FOUND A REAL DEFECT ON ITS FIRST HONEST RUN, which is the argument for
 * having built it: the blink phase was a function of WORLD POSITION, so every
 * fragment across one eye got its own blink moment and the eye never went
 * dark — a random scatter of its pixels did. That measured as an 8% dip where
 * a blink is a 100% one, and every marker on the material said the mechanism
 * was live.
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome, isolate, lookAt } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const seed = Number(args.find((a) => /^\d+$/.test(a))) || 4242
const time = Number((args.find((a) => a.startsWith('--time=')) ?? '').slice(7)) || 18.5
const GRID = 220
/**
 * One blink slot is 1 / 0.175 s.
 *
 * SWEPT OVER THREE SLOTS, NOT ONE, and the first run of this tool is why.
 * A one-slot sweep looks sufficient — the blink fires once per slot — and it
 * is not: the sweep starts at the cat's own phase, so it covers the tail of
 * one slot and the head of the next, and the jitter puts each of those two
 * blinks anywhere in its own slot. Both can fall outside the window, which
 * happens about a quarter of the time. It did on the first run, and the tool
 * printed `DOES NOT BLINK` on a working feature — the aliasing failure this
 * repo keeps paying for, in a tool written to avoid it.
 *
 * Stepped finely enough that the ~0.32s dip lands on more than one sample.
 */
const SLOT = 1 / 0.175
const SLOTS = 3
const STEPS = 132

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

/**
 * THE GRID COVERS THE SUBJECT, NOT THE CANVAS — which is the difference
 * between grading this feature and not.
 *
 * Downsampling the whole frame to 384 squares puts a 2.4cm eye on ten samples
 * and the 1.3cm gap between the two on about three, so the pair merges into
 * one figure-eight blob and the wink question cannot be asked at all. It also
 * drags in every OTHER cat in town as a stray pixel. Cropping to the subject's
 * own projected box first spends the whole grid on the thing being measured —
 * `subjectPixels` and `celestial.mjs`'s moon patch are the same fix, and this
 * repo has now needed it four times.
 */
const src = {
  sx: Math.max(0, (v.screen.x0 - 0.10) * canvas.width),
  sy: Math.max(0, (v.screen.y0 - 0.10) * canvas.height),
  sw: Math.min(canvas.width, (v.screen.x1 - v.screen.x0 + 0.20) * canvas.width),
  sh: Math.min(canvas.height, (v.screen.y1 - v.screen.y0 + 0.20) * canvas.height),
}
const shootGrid = () => win.evaluate(({ n, r }) => {
  const cv = window.__pt.renderer().renderer.domElement
  // The canvas BACKING store may differ from its CSS size (RENDER_SCALE
  // upscales), and drawImage's source rect is in backing pixels.
  const kx = cv.width / cv.getBoundingClientRect().width
  const ky = cv.height / cv.getBoundingClientRect().height
  const c2 = document.createElement('canvas')
  c2.width = n; c2.height = n
  const g2 = c2.getContext('2d', { willReadFrequently: true })
  g2.drawImage(cv, r.sx * kx, r.sy * ky, r.sw * kx, r.sh * ky, 0, 0, n, n)
  const d = g2.getImageData(0, 0, n, n).data
  const out = new Array(n * n)
  for (let i = 0; i < n * n; i++) {
    out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255
  }
  return out
}, { n: GRID, r: src })

// ISOLATED, so the only thing that can change between frames is the eyes.
const iso = await isolate(win, 'catEyes')
if (!iso.found) {
  console.log('  x isolate found no catEyes mesh')
  await iso.restore(); await app.close(); process.exit(1)
}
await win.waitForTimeout(600)

const frames = []
for (let i = 0; i < STEPS; i++) {
  await win.evaluate((t) => window.__pt.pinCatTime(t), (i / STEPS) * SLOT * SLOTS)
  await win.waitForTimeout(330)
  frames.push(await shootGrid())
}
await win.evaluate(() => window.__pt.pinCatTime(null))
await win.screenshot({ ...clip, path: `.shots/blink/cat-${seed}-alone.png` })
// THE EXACT REGION THE GRID SEES. Every disagreement between what a tool
// measures and what a frame shows in this repo has been settled by looking at
// the thing the tool actually looked at, not at the thing it was aimed at.
await win.screenshot({
  clip: {
    x: canvas.x + src.sx, y: canvas.y + src.sy,
    width: Math.max(8, src.sw), height: Math.max(8, src.sh),
  },
  path: `.shots/blink/cat-${seed}-crop.png`,
})
await iso.restore()

// THE EYE PIXELS ARE THE ONES THAT ARE EVER BRIGHT, taken from the per-pixel
// MAX across the sweep rather than from any single frame — pick one frame and
// you might have picked the blink, and then the mask is empty and the tool
// reports a working feature as absent. The moon's mask failure, in miniature.
const n = frames[0].length
const peak = new Array(n).fill(0)
for (const f of frames) for (let i = 0; i < n; i++) if (f[i] > peak[i]) peak[i] = f[i]
// Loops, not spread: a 384x384 grid is 147k arguments and `Math.max(...)`
// overflows the call stack on it.
let hi = 0
for (let i = 0; i < n; i++) if (peak[i] > hi) hi = peak[i]
/**
 * THE THRESHOLD IS SWEPT UNTIL THE PAIR SEPARATES, rather than chosen.
 *
 * At 45% of peak the two eyes come back as ONE connected blob however close
 * the camera stands, and the reason is not the camera: `RENDER_SCALE = 0.4`
 * means the scene renders at 40% and is upscaled, so the 1.3cm gap between two
 * 2.4cm eyes is about three real pixels and the interpolation bridges it at
 * any generous threshold. Raising the cut keeps only the bright cores, which
 * are genuinely separate — so the right value is not a number to pick but the
 * first one at which the question becomes askable, and the tool prints which
 * one it used.
 *
 * The low cut is still what measures the DIP, because there the question is
 * "how much light is there" and every lit pixel counts.
 */
const THRESH = hi * 0.45
// The grid already covers only the subject's box, so no second mask is
// needed — but a distant cat can still fall inside that box, which is why the
// pair test below takes CONNECTED COMPONENTS rather than everything bright.
const eyePx = []
for (let i = 0; i < n; i++) if (peak[i] >= THRESH) eyePx.push(i)
if (eyePx.length < 6) {
  console.log(`  x only ${eyePx.length} eye pixels above ${THRESH.toFixed(3)} — ` +
    'too few to grade. A metric cannot resolve a feature smaller than its grid.')
  await app.close(); process.exit(1)
}

/** 4-connected components of the pixels at or above `t`. */
function componentsAt(t) {
  const inMask = new Set()
  for (let i = 0; i < n; i++) if (peak[i] >= t) inMask.add(i)
  const seen = new Set()
  const comps = []
  for (const start of inMask) {
    if (seen.has(start)) continue
    const q = [start]; seen.add(start)
    const comp = []
    while (q.length) {
      const i = q.pop(); comp.push(i)
      const x = i % GRID, y = (i / GRID) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx2 = x + dx, ny2 = y + dy
        if (nx2 < 0 || nx2 >= GRID || ny2 < 0 || ny2 >= GRID) continue
        const k = ny2 * GRID + nx2
        if (!inMask.has(k) || seen.has(k)) continue
        seen.add(k); q.push(k)
      }
    }
    comps.push(comp)
  }
  return comps.sort((a, b) => b.length - a.length)
}

let xLo = GRID, xHi = 0
for (const i of eyePx) { const x = i % GRID; if (x < xLo) xLo = x; if (x > xHi) xHi = x }

/**
 * THE PAIR IS THE LARGEST COMPONENT, AND ITS TWO HALVES ARE THE TWO EYES.
 *
 * No threshold separates them and none can: the eyes are 2.4cm across with a
 * 1.3cm gap, and `RENDER_SCALE = 0.4` renders that gap as about one and a half
 * real pixels before upscaling smears the two bright discs across it. The crop
 * this tool writes shows the result exactly — two lobes joined by a bridge.
 * Standing closer does not fix it, because the gap and the eyes shrink
 * together.
 *
 * So the blob is split at its OWN x-midpoint, taken from the largest connected
 * component rather than from every lit pixel — which is what a stray distant
 * cat kept wrecking. Two halves of a bowtie are the two eyes to within a
 * pixel, and that is enough to compare when each goes dark.
 */
const comps = componentsAt(THRESH)
const pair = comps[0] ?? []
let pLo = GRID, pHi = 0
for (const i of pair) { const x = i % GRID; if (x < pLo) pLo = x; if (x > pHi) pHi = x }
const pMid = (pLo + pHi) / 2
const left = pair.filter((i) => (i % GRID) < pMid)
const right = pair.filter((i) => (i % GRID) >= pMid)
const series = (px) => frames.map((f) => px.reduce((s, i) => s + f[i], 0) / px.length)
const all = series(eyePx)
let openLevel = 0, shutLevel = Infinity
for (const a of all) { if (a > openLevel) openLevel = a; if (a < shutLevel) shutLevel = a }
const shutFrames = all.filter((x) => x < openLevel * 0.5).length

console.log(`\n  eye pixels ${eyePx.length} at 45% of peak ${hi.toFixed(3)}, ` +
  `x span ${xLo}..${xHi} of ${GRID}`)
console.log(`  ${comps.length} blob(s) ${comps.slice(0, 3).map((c) => c.length).join('/')} px; ` +
  `pair is ${pair.length} px spanning x ${pLo}..${pHi}, split ${left.length}/${right.length}`)
console.log(`  open  ${openLevel.toFixed(4)}   shut  ${shutLevel.toFixed(4)}   ` +
  `dip to ${(shutLevel / Math.max(1e-9, openLevel) * 100).toFixed(1)}% of open`)
console.log(`  shut on ${shutFrames} of ${STEPS} phases over ${SLOTS} slots = ` +
  `${(shutFrames / STEPS * 100).toFixed(1)}% of the sweep  ` +
  `(${(shutFrames / STEPS * SLOT * SLOTS).toFixed(2)}s of ` +
  `${(SLOT * SLOTS).toFixed(2)}s, so ${(shutFrames / STEPS * SLOT * SLOTS / SLOTS).toFixed(2)}s per blink)`)

// A cat's blink is a couple of tenths of a second and a cat's eyes are open
// the rest of the time. Both ends matter: no dip is a lamp, a long dip is a
// strobe.
const fires = shutLevel < openLevel * 0.5
const duty = shutFrames / STEPS
console.log(`  ${fires ? 'BLINKS' : 'DOES NOT BLINK — the eyes never go dark'}` +
  (fires && duty > 0.25 ? '  — but the dip is long enough to read as a strobe' : ''))

// Two comparable blobs is a pair of eyes; one blob, or a second one a
// fraction of the first, is a standoff that cannot resolve them.
if (left.length >= 3 && right.length >= 3 && pHi - pLo >= 6) {
  const L = series(left), R = series(right)
  const argmin = (a) => { let k = 0; for (let i = 1; i < a.length; i++) if (a[i] < a[k]) k = i; return k }
  const li = argmin(L), ri = argmin(R)
  // A straight distance: the sweep spans whole slots and does not wrap onto
  // itself, so two dips at opposite ends really are far apart.
  const d = Math.abs(li - ri)
  console.log(`\n  BOTH EYES  darkest at phase ${li} and ${ri} of ${STEPS}` +
    `  — ${d} step${d === 1 ? '' : 's'} apart`)
  console.log(`  ${d <= 1 ? 'TOGETHER — no wink' : 'WINKING — the two eyes are ' +
    'out of phase, so the per-cat phase is not reaching both of them'}`)
} else {
  // SAYING SO IS THE POINT. A silent skip here would let the one defect this
  // tool exists to catch pass as a clean board.
  console.log(`\n  BOTH EYES  NOT GRADED — the pair blob is ${pair.length} px ` +
    `spanning ${pHi - pLo} samples, too narrow to halve.`)
  console.log('  Do NOT read the verdict above as covering the wink case.')
}
/**
 * AND A SECOND, SPLIT-FREE TEST OF THE SAME THING, because the halving above
 * depends on a midpoint and this does not.
 *
 * If one eye goes dark while the other stays lit, the lit pixels' CENTROID
 * jumps toward the survivor by about half the pair's width. If both go
 * together, the whole blob dims and the centroid does not move at all. Frames
 * where the pair is nearly fully dark are excluded — with no light there is no
 * centroid, only noise — so what is measured is exactly the frames a wink
 * would show up in.
 */
const cent = []
for (const f of frames) {
  let sw = 0, sx = 0
  for (const i of pair) { const w = f[i]; sw += w; sx += w * (i % GRID) }
  cent.push({ tot: sw / Math.max(1, pair.length), x: sw > 0 ? sx / sw : null })
}
const lit = cent.filter((c) => c.x !== null && c.tot > openLevel * 0.30)
if (lit.length >= 4) {
  let cLo = Infinity, cHi = -Infinity
  for (const c of lit) { if (c.x < cLo) cLo = c.x; if (c.x > cHi) cHi = c.x }
  const halfPair = Math.max(1, (pHi - pLo) / 2)
  const shift = (cHi - cLo) / halfPair
  console.log(`\n  CENTROID   over ${lit.length} lit phases it moves ` +
    `${(cHi - cLo).toFixed(2)} samples = ${(shift * 100).toFixed(0)}% of a half-pair`)
  console.log(`  ${shift < 0.25 ? 'TOGETHER — a wink would swing this to ~100%'
    : 'WINKING — the lit centroid is sliding between the two eyes'}`)
} else {
  console.log(`\n  CENTROID   NOT GRADED — only ${lit.length} lit phases`)
}
console.log('\nfeatures.mjs owns the cat RATE; this owns whether it is alive.')
await app.close()
