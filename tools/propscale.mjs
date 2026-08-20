/**
 * PROPSCALE — how big is each prop, in metres, against what it should be?
 *
 * `humanscale.mjs` grades every BUILDING against what that thing measures in
 * the real world and has caught three separate scale bugs. Nothing did the
 * same for props, and that gap had a live defect in it: `dressWaterfront`
 * started placing boulders at the riverbank and they came out five metres
 * across — wider than a row house — because their geometry sizes itself off
 * the FOOTPRINT, which is in metres now and was in tiles when it was written.
 *
 * That is the scale-coupling bug CLAUDE.md already documents, in the one file
 * nobody swept, and it survived because those props had NEVER BEEN DRAWN.
 * They were the "content with no way in" case: the store defined no ids for
 * them, so no screenshot could contain one and no audit looked at their size.
 * Wiring them up handed the town a vocabulary that had never been to scale.
 *
 * Measured from the real emitted geometry — PropFactory brackets each object
 * and asks the batcher for the world AABB of what it just added — so this
 * grades the thing on screen rather than the numbers that were meant to
 * produce it.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/propscale.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'
import { readFileSync } from 'node:fs'

const seeds = process.argv.slice(2).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337)

/**
 * What the thing is, in metres: [minW, maxW, minH, maxH]. Only types with a
 * real-world answer are graded — a "dock" is whatever length its plot is, and
 * inventing a target for it would be grading the tool's opinion.
 */
const EXPECT = {
  barrel:        [0.5, 1.0, 0.7, 1.2],
  // A picket fence is chest-high on a child and waist-high on an adult; the
  // whole point of one is that you see the garden OVER it. Graded because it
  // was ungraded and drawing at 0.62m — knee height, which reads as a border
  // edging rather than a boundary.
  picket_fence:  [2.4, 6.2, 0.85, 1.20],
  // A market marquee FILLS its plot, which is why the width range is wide —
  // the same reason a dock and a fence are allowed to. The HEIGHT is the
  // number with an answer: you stand under a tent, so the eave is over head
  // height and the ridge above that. It drew 1.78m to the tip of its flag
  // until the plaza pass that places it started working.
  market_tent:   [2.2, 6.6, 2.6, 4.2],
  crate:         [0.5, 1.2, 0.4, 1.0],
  crate_stack:   [0.8, 1.8, 0.9, 2.0],
  bench:         [1.2, 2.2, 0.4, 1.1],   // two of three variants are backless

  well:          [1.2, 2.6, 0.8, 2.0],
  lamppost:      [0.1, 0.9, 2.6, 5.0],   // the shaft, not the lamp head
  // A hitching POST is 15cm; a hitching RAIL is what this actually models, and
  // the code says so. The first run flagged it TOO BIG at 0.80m and the
  // geometry was right — the expectation was written from the id rather than
  // from the thing. Read the code before believing a target you wrote.
  horse_post:    [0.5, 1.4, 0.9, 1.6],
  rain_barrel:   [0.5, 1.0, 0.7, 1.3],
  woodpile:      [0.6, 2.0, 0.5, 1.4],
  flower_box:    [0.4, 1.6, 0.2, 0.6],
  potted_plant:  [0.3, 0.9, 0.4, 1.4],
  cafe_table:    [0.6, 1.4, 0.6, 1.1],
  fish_rack:     [0.8, 2.5, 1.0, 2.2],
  rope_coil:     [0.3, 0.9, 0.1, 0.5],
  // Likewise: this is a stone bollard with a ring in it, not a ring set into
  // the quay, and a real bollard is 40-60cm tall.
  mooring_ring:  [0.2, 0.8, 0.3, 0.8],
  rock:          [0.3, 1.6, 0.2, 1.0],
  boulder:       [0.8, 2.5, 0.5, 1.8],
  rocky_outcrop: [1.0, 3.5, 0.6, 2.2],
  standing_stone:[0.4, 1.4, 1.6, 3.5],
  reeds:         [0.3, 1.6, 0.5, 1.8],
  bush:          [0.5, 2.0, 0.4, 1.6],
  tree:          [2.0, 8.0, 3.5, 14.0],
  // Third correction to this table in one run, and the pattern is worth the
  // warning: EVERY target here was first written from the ID rather than from
  // the object, and a "rowboat" imagined as a dinghy is 2m while a real one is
  // 3.5-4.5. The measurements have been right each time and the expectations
  // wrong. Check a target against the geometry's own comment before believing
  // it flagged something.
  rowboat:       [2.8, 4.5, 0.4, 1.4],
  skiff:         [3.0, 5.0, 0.5, 1.6],
  fishing_boat:  [4.0, 8.0, 0.8, 3.0],
  cart:          [1.2, 2.6, 0.9, 2.0],
  wagon:         [1.6, 3.2, 1.2, 2.6],
  statue:        [0.8, 2.5, 1.8, 5.0],
  signpost:      [0.3, 1.4, 1.6, 3.0],
}

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

const agg = {}
for (const seed of seeds) {
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
  await win.waitForTimeout(3200)
  const sizes = await win.evaluate(() => window.__pt.debugInfo()?.propSizes ?? null)
  if (!sizes) { console.log(`seed ${seed}: no propSizes — is the 3D view up?`); continue }
  for (const [id, e] of Object.entries(sizes)) {
    const a = (agg[id] ??= { n: 0, w: [], h: [], d: [] })
    a.n += e.n; a.w.push(...e.w); a.h.push(...e.h); a.d.push(...e.d)
  }
  await win.getByRole('button', { name: '2D', exact: true }).click()
  await win.waitForTimeout(500)
}
await app.close()

const med = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0 }
const rows = Object.entries(agg).map(([id, a]) => {
  // Footprint is w x d; a prop's "width" as a person sees it is the larger.
  const wide = a.w.map((v, i) => Math.max(v, a.d[i]))
  return { id, n: a.n, w: med(wide), wMax: Math.max(...wide), h: med(a.h), hMax: Math.max(...a.h) }
}).sort((a, b) => b.wMax - a.wMax)

console.log(`\n=== PROP SCALE — metres, over ${seeds.length} seeds ===`)
console.log('prop                 n     width med/max     height med/max   expected w / h        verdict')
console.log('-'.repeat(100))
const bad = []
for (const r of rows) {
  const e = EXPECT[r.id]
  let verdict = '', exp = '-'
  if (e) {
    const [wLo, wHi, hLo, hHi] = e
    exp = `${wLo}-${wHi} / ${hLo}-${hHi}`
    const tooWide = r.w > wHi, tooNarrow = r.w < wLo
    const tooTall = r.h > hHi, tooShort = r.h < hLo
    if (tooWide || tooTall) verdict = 'TOO BIG'
    else if (tooNarrow || tooShort) verdict = 'too small'
    else verdict = 'ok'
    if (verdict !== 'ok') bad.push({ ...r, exp, verdict })
  }
  console.log(`${r.id.padEnd(20)}${String(r.n).padStart(5)}` +
    `${String(`${r.w.toFixed(2)} / ${r.wMax.toFixed(2)}`).padStart(17)}` +
    `${String(`${r.h.toFixed(2)} / ${r.hMax.toFixed(2)}`).padStart(18)}` +
    `${String(exp).padStart(20)}   ${verdict}`)
}
console.log('-'.repeat(100))
console.log(`\n${bad.length} of ${rows.filter((r) => EXPECT[r.id]).length} graded prop types are out of range` +
  ` (${rows.length} types placed, ${rows.length - rows.filter((r) => EXPECT[r.id]).length} ungraded).`)
console.log('Ungraded types have no honest real-world answer — a dock is as')
console.log('long as its plot — and inventing a target for them would be')
console.log("grading this tool's opinion rather than the town.")
for (const b of bad) console.log(`  ${b.verdict.padEnd(10)} ${b.id}: ${b.w.toFixed(2)}m wide, ${b.h.toFixed(2)}m tall vs ${b.exp}`)

/*
 * THE REVERSE GHOST, FOR PROPS.
 *
 * `features.mjs` censuses gated FEATURES and `registry.mjs` censuses the
 * id-keyed TABLES; between them they still cannot see a prop that is defined,
 * has finished geometry, and simply never appears in a town. This repo has
 * found that class three times — twenty river props the store never defined,
 * every bridge in the town routed to the wrong factory, and a picket fence
 * with pointed slats and a rail that nothing placed — and each time it was
 * found by hand, by one grep somebody happened to run.
 *
 * This walks every prop in every seed above, so it reports what a town
 * ACTUALLY CONTAINS rather than what the source mentions. A type absent from
 * one seed may be correctly rare; absent from all of them it is art with no
 * way in. The distinction is the seed count, which is why this prints it.
 */
const src = readFileSync('src/renderer/renderer3d/PropFactory.ts', 'utf8')
const drawable = new Set([...src.matchAll(/\bid === '([a-z_0-9]+)'/g)].map((m) => m[1]))
const store = readFileSync('src/renderer/app/store.ts', 'utf8')
const defined = new Set([...store.matchAll(/\bid: '([a-z_0-9]+)'/g)].map((m) => m[1]))
const seen = new Set(rows.map((r) => r.id))
const missing = [...drawable].filter((d) => defined.has(d) && !seen.has(d)).sort()
const dead = [...drawable].filter((d) => !defined.has(d)).sort()
console.log(`\nNEVER PLACED — defined, drawable, and in none of the ${seeds.length} towns: ${missing.length}`)
if (missing.length) {
  for (let i = 0; i < missing.length; i += 6) {
    console.log('  ' + missing.slice(i, i + 6).join('  '))
  }
  console.log('  Some of these are correctly rare and tied to a quarter or a site —')
  console.log('  a gravestone needs a cemetery and a mooring ring needs a quay. Read')
  console.log('  the list against which QUARTERS these seeds grew (quarters.mjs)')
  console.log('  before calling one a ghost. What it cannot be is content you')
  console.log('  believe you have.')
}
if (dead.length) {
  console.log(`\nDEAD ART — PropFactory draws it and the store defines no id: ${dead.join(' ')}`)
  console.log('  Nothing can place these. Either give them a definition or delete')
  console.log('  the branch; a draw path with no id is a maintenance cost that')
  console.log('  cannot ever appear on screen.')
}
process.exit(bad.some((b) => b.verdict === 'TOO BIG') ? 1 : 0)
