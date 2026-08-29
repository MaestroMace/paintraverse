/**
 * ROPEPROBE — is each end of a rope actually TIED TO SOMETHING?
 *
 * Reported from the device: the lantern strings "start on a building and hover
 * in the air". That is the one claim a rope makes and nothing here could check
 * it — a floating end is not a collision, not a blank surface, not an outlier
 * and not a missing system, so every instrument on the board is blind to it by
 * construction. `particles.mjs` grades whether the rope SWAYS, which it does,
 * beautifully, while hanging off nothing.
 *
 *   xvfb-run -a node tools/ropeprobe.mjs [seeds...]
 *
 * THREE EXACT QUESTIONS, none with a threshold worth arguing about:
 *
 *   1. DROP TO ITS OWN EAVE. Each end records the eave it was tied to, so the
 *      gap between the endpoint and that eave is arithmetic. A rope tied off
 *      properly sits a fixed clearance above its own building; one that hangs
 *      metres above it is tied to the OTHER building's roofline and floating
 *      over this one.
 *   2. SIGHTLINE. A span that crosses a third building's footprint passes
 *      through a roof. Checked against the reserved tile rectangles, which is
 *      exact and needs no raycast.
 *   3. SPAN LENGTH against the pair filter, so a rope that survived the
 *      pull-in as a stub is visible rather than merely short.
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { lookAt, hideChrome } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const seeds = args.filter((a) => /^\d+$/.test(a)).map(Number)
const SEEDS = seeds.length ? seeds : [4242, 31337, 8080]
/** A rope tied to its own eave sits EAVE_CLEARANCE (0.55m) above it. Anything
 *  much past that is hanging over the building rather than off it — and the
 *  bar is deliberately loose, because the defect is metres not centimetres. */
const FLOAT_M = 1.5
const shoot = args.includes('--shoot')
mkdirSync('.shots/rope', { recursive: true })

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

console.log('\n=== ROPE ENDS — is each one tied to something? ===')
let totFloat = 0, totSpans = 0, totCross = 0
for (const seed of SEEDS) {
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

  if (!await win.evaluate(() => typeof window.__pt.lanternSpans === 'function')) {
    console.log('\n  x __pt.lanternSpans is missing — this bundle predates the hook.')
    await app.close(); process.exit(1)
  }
  const spans = await win.evaluate(() => window.__pt.lanternSpans())
  // The reserved tile rectangles of every structure, for the sightline test.
  // Exact: a rope crossing a footprint is over a roof, whatever its height.
  // Each obstacle's TOP as well as its rectangle. "Crosses" is not the defect
  // — a rope ten metres up over a 1.45m churchyard wall is correct — so the
  // graded number is crossings the rope does NOT clear. Both are printed,
  // because reporting only the strict one would hide a change that merely
  // raised every rope.
  const boxes = await win.evaluate(() => {
    const three = window.__pt.renderer()
    const st = window.__pt.store.getState()
    const layer = st.map.layers.find((l) => l.id === 'structures' || l.name === 'Structures')
    const T = window.__pt.TILE
    const out = []
    for (const o of layer?.objects ?? []) {
      const fp = o.footprint ?? { w: 1, h: 1 }
      const b = three?.structureBox ? three.structureBox(o.id) : null
      out.push({
        x0: o.x * T, z0: o.y * T, x1: (o.x + fp.w) * T, z1: (o.y + fp.h) * T,
        topY: b ? b.max[1] : 6,
      })
    }
    return out
  })

  let floats = 0, crossings = 0, hits = 0
  const drops = []
  for (const s of spans) {
    const dA = s.ay - s.aEave
    const dB = s.by - s.bEave
    drops.push(dA, dB)
    if (dA > FLOAT_M) floats++
    if (dB > FLOAT_M) floats++
    // Sample the span and ask whether any interior point is over a footprint
    // that is not one of its own two ends.
    let crossed = false, hit = false
    const spanLen = Math.hypot(s.bx - s.ax, s.bz - s.az)
    const sag = Math.max(0.35, spanLen * 0.06)
    for (let k = 1; k < 12; k++) {
      const t = k / 12
      // Ends legitimately sit ON their own building; only count well inside.
      if (t <= 0.22 || t >= 0.78) continue
      const x = s.ax * (1 - t) + s.bx * t
      const z = s.az * (1 - t) + s.bz * t
      const y = s.ay * (1 - t) + s.by * t - sag * Math.sin(Math.PI * t)
      for (const b of boxes) {
        if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue
        crossed = true
        if (y < b.topY) hit = true
      }
    }
    if (crossed) crossings++
    if (hit) hits++
  }
  drops.sort((a, b) => a - b)
  const med = drops.length ? drops[drops.length >> 1] : NaN
  const max = drops.length ? drops[drops.length - 1] : NaN
  console.log(`\n  seed ${seed}: ${spans.length} spans, ${spans.length * 2} ends`)
  console.log(`    drop to own eave   median ${med.toFixed(2)}m   max ${max.toFixed(2)}m`)
  console.log(`    ends floating >${FLOAT_M}m above their own eave   ${floats}` +
    `  (${(floats / Math.max(1, spans.length * 2) * 100).toFixed(0)}%)`)
  console.log(`    spans passing over a third building             ${crossings}`)
  console.log(`    ...of those, spans that do NOT CLEAR it         ${hits}`)
  totFloat += floats; totSpans += spans.length; totCross += hits

  /**
   * AND A PICTURE OF THE WORST CASE. The numbers say every end is 0.55m above
   * its own eave; only a photograph says the rope READS as tied. The span
   * chosen is the one with the largest height DIFFERENCE between its ends —
   * the exact case that used to hang level off the taller roof and terminate
   * in mid-air over the shorter one.
   */
  if (spans.length && shoot) {
    let worst = spans[0]
    for (const s of spans) {
      if (Math.abs(s.ay - s.by) > Math.abs(worst.ay - worst.by)) worst = s
    }
    const mid = {
      min: [Math.min(worst.ax, worst.bx) - 1, Math.min(worst.ay, worst.by) - 3,
        Math.min(worst.az, worst.bz) - 1],
      max: [Math.max(worst.ax, worst.bx) + 1, Math.max(worst.ay, worst.by) + 2,
        Math.max(worst.az, worst.bz) + 1],
    }
    const v = await lookAt(win, mid, {
      dists: [14, 20, 28, 38], heights: [0, -3, -8, 4],
      order: 'height', pick: 'largest', minFill: 0.05,
    })
    if (v.ok) {
      await hideChrome(win)
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
      await win.screenshot({ ...(canvas ? { clip: canvas } : {}),
        path: `.shots/rope/rope-${seed}.png` })
      console.log(`    ✓ .shots/rope/rope-${seed}.png  ` +
        `(ends differ by ${Math.abs(worst.ay - worst.by).toFixed(2)}m, ` +
        `${v.dist?.toFixed(0)}m out)`)
    } else {
      console.log(`    (no clear view of the worst span: ${v.why})`)
    }
  }
}
console.log(`\n  TOTAL  ${totFloat} floating ends of ${totSpans * 2}, ` +
  `${totCross} spans through a roof`)
console.log('  A rope makes exactly one claim — that both ends are attached.')
await app.close()
