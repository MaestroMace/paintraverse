/**
 * VARIETY — can the eye copy-paste one building onto another?
 *
 * THE AXIS `odd.mjs` IS BLIND TO BY CONSTRUCTION.
 *
 * odd ranks each structure by how UNLIKE its peers it is, in robust
 * deviations. That finds the 29m untextured mill and the splinter wing, and it
 * can never find the opposite failure, because a thing that looks like
 * everything else scores z ≈ 0 — the most invisible possible reading. Its own
 * note already says it cannot see a defect the whole population shares and
 * points at provenance.mjs; but provenance grades the world against the CODE,
 * so if the code faithfully asks for three hundred identical houses, both
 * tools report a clean town.
 *
 * Nothing here measured VARIETY, and it is a stated design pillar:
 * DESIGN.md's rule is that the eye should never be able to copy-paste one
 * silhouette onto another, and the standing complaint is that the town reads
 * as "pseudo-random building assets dropped around" — which is a statement
 * about REPETITION, not about outliers.
 *
 * WHAT COUNTS AS A TWIN. Not "similar" — interchangeable. Two structures of
 * the same definitionId whose silhouette numbers all agree within TOL, and
 * whose roof styles match exactly. A roofline is categorical and the eye reads
 * it first; a 4% difference in width is not something anyone can see.
 *
 * AND DISTANCE IS HALF THE QUESTION. A real terrace repeats on purpose — 93%
 * of this town shares a party wall — so a global twin rate would condemn the
 * one thing the urban-form arc achieved. Two identical houses at opposite ends
 * of town is a town with a housing type. Two identical houses SIDE BY SIDE is
 * a copy-paste, because both are in the same frame and the eye does the
 * comparison for free. So the headline number is the NEIGHBOUR twin rate, and
 * it cannot be gamed by scattering: only actually varying the buildings moves
 * it.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/variety.mjs [seed] [--near=15]
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 31337)
const NEAR_M = Number(argv.find((a) => a.startsWith('--near='))?.split('=')[1] ?? 15)
const showAll = argv.includes('--all')

// Within this fraction on every continuous axis and the eye cannot tell two
// buildings apart at street distance. Deliberately tight: the claim being
// tested is INTERCHANGEABLE, not "a bit alike", and a loose tolerance would
// turn an honest terrace into a false positive.
const TOL = 0.05

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
await win.waitForTimeout(200)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2800)
await win.getByRole('button', { name: '3D', exact: true }).click()
await waitForScene(win)

const scene = await win.evaluate(() => window.__pt.sceneFeatures())
await app.close()
const all = scene?.structures ?? []
if (!all.length) { console.log('no structures — the 3D renderer never built'); process.exit(1) }

// What the eye actually copy-pastes: the silhouette and the roof. Wall colour
// and dressing are deliberately NOT in here — a repainted copy of the same box
// is still the same box, and including colour would let a palette shuffle
// score as variety.
const SILHOUETTE = [
  ['height', (s) => s.height],
  ['wallTop', (s) => s.wallTop],
  ['spanW', (s) => s.spanW],
  ['spanD', (s) => s.spanD],
]
const near = (a, b) => {
  const m = Math.max(Math.abs(a), Math.abs(b), 0.25)
  return Math.abs(a - b) / m <= TOL
}
const roofKey = (s) => (s.roofStyles ?? []).slice().sort().join('+')
const twins = (a, b) =>
  a.def === b.def && a.volumes === b.volumes && roofKey(a) === roofKey(b) &&
  SILHOUETTE.every(([, get]) => near(get(a), get(b)))

console.log(`=== VARIETY — ${all.length} structures, seed ${seed} ===`)
console.log('Two buildings are TWINS when the eye cannot tell them apart: same')
console.log(`type, same volume count, same roof styles, and every silhouette`)
console.log(`dimension within ${(TOL * 100).toFixed(0)}%. Not "similar" — interchangeable.\n`)

let anyTwin = 0, nearTwin = 0
const clusterOf = new Map()
const pairsNear = []
for (let i = 0; i < all.length; i++) {
  let hasAny = false, hasNear = false
  for (let j = 0; j < all.length; j++) {
    if (i === j) continue
    if (!twins(all[i], all[j])) continue
    hasAny = true
    const d = Math.hypot(all[i].x - all[j].x, all[i].z - all[j].z)
    if (d <= NEAR_M) {
      hasNear = true
      if (i < j) pairsNear.push({ a: all[i], b: all[j], d })
    }
  }
  if (hasAny) anyTwin++
  if (hasNear) nearTwin++
  const k = `${all[i].def}|${all[i].volumes}|${roofKey(all[i])}|` +
    SILHOUETTE.map(([, g]) => Math.round(g(all[i]) / 0.5)).join(',')
  clusterOf.set(k, (clusterOf.get(k) ?? 0) + 1)
}

const pct = (n) => `${((n / all.length) * 100).toFixed(0)}%`
console.log(`  has a twin ANYWHERE in town      ${String(anyTwin).padStart(4)}  ${pct(anyTwin)}`)
console.log(`  has a twin within ${String(NEAR_M).padStart(2)}m           ${String(nearTwin).padStart(4)}  ${pct(nearTwin)}` +
  '   <-- the one that matters')
console.log('')
console.log('  A twin across town is a town with a housing type. A twin in the')
console.log('  SAME FRAME is a copy-paste, because the eye compares them for')
console.log('  free. Scattering cannot move the second number; only varying the')
console.log('  buildings can.\n')

// TWO DEFINITIONS OF "THE SAME" LIVE IN THIS FILE AND THEY ARE NOT THE SAME
// DEFINITION. The pair test above is relative (within TOL of each other);
// grouping needs a canonical key, so it buckets to the nearest half metre.
// They can disagree at a bucket boundary — two buildings 2cm apart across a
// 0.5m line are twins by the pair test and land in different groups. The pair
// counts are the headline for that reason; the groups are a shape, not a
// count. Saying so beats letting the next reader find the discrepancy and
// distrust both.
const clusters = [...clusterOf.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1])
if (clusters.length) {
  console.log('LARGEST INTERCHANGEABLE GROUPS (type | volumes | roofs | silhouette to 0.5m):')
  for (const [k, n] of clusters.slice(0, 8)) {
    const [def, vols, roofs, dims] = k.split('|')
    console.log(`  ${String(n).padStart(4)} x  ${def.padEnd(18)} ${vols} vol  ` +
      `${(roofs || '(none)').padEnd(18)} ${dims}`)
  }
  console.log('')
}

// PER TYPE, because the aggregate hides which vocabulary is thin. A type with
// 40 instances and 3 distinct silhouettes is the wallpaper failure at building
// scale — a healthy rate town-wide that differentiates nothing on the ground.
const byDef = new Map()
for (const s of all) {
  if (!byDef.has(s.def)) byDef.set(s.def, [])
  byDef.get(s.def).push(s)
}
const rows = []
for (const [def, list] of byDef) {
  if (list.length < 5) continue
  const shapes = new Set(list.map((s) =>
    `${s.volumes}|${roofKey(s)}|` + SILHOUETTE.map(([, g]) => Math.round(g(s) / 0.5)).join(',')))
  rows.push({ def, n: list.length, shapes: shapes.size, ratio: shapes.size / list.length })
}
rows.sort((a, b) => a.ratio - b.ratio)
if (rows.length) {
  console.log('DISTINCT SILHOUETTES PER TYPE — worst first (only types with 5+):')
  console.log('  type                 built  distinct  distinct/built')
  for (const r of (showAll ? rows : rows.slice(0, 12))) {
    console.log(`  ${r.def.padEnd(20)} ${String(r.n).padStart(5)}  ${String(r.shapes).padStart(8)}` +
      `  ${(r.ratio * 100).toFixed(0)}%`)
  }
  console.log('')
}

if (pairsNear.length) {
  pairsNear.sort((a, b) => a.d - b.d)
  console.log(`CLOSEST COPY-PASTES — ${pairsNear.length} twin pairs within ${NEAR_M}m:`)
  for (const p of pairsNear.slice(0, 8)) {
    console.log(`  ${p.d.toFixed(1)}m apart  ${p.a.def} in ${p.a.district}` +
      `  ${p.a.height.toFixed(1)}m tall on ${p.a.spanW.toFixed(1)}x${p.a.spanD.toFixed(1)}m` +
      `  @(${p.a.x.toFixed(0)},${p.a.z.toFixed(0)}) and (${p.b.x.toFixed(0)},${p.b.z.toFixed(0)})`)
  }
  console.log('')
}

// NO TARGET IS STATED ON PURPOSE, for the reason propscale.mjs learned the
// hard way: three of its hand-written targets were wrong on the first run, all
// of them written from the id rather than the object. What a healthy neighbour
// twin rate is for a medieval town is an argument, not a fact. Track the
// number, move it down, and let the picture settle whether it went far enough.
console.log(`VERDICT: ${pct(nearTwin)} of structures have an interchangeable twin within ${NEAR_M}m` +
  ` (${nearTwin} of ${all.length}); ${pct(anyTwin)} have one anywhere.`)
