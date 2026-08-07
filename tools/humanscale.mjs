/**
 * HUMAN-SCALE AUDIT — is this town built for people?
 *
 * Every earlier attempt to answer "is the scale right?" used a single median
 * building height, and a median cannot see the thing that was actually being
 * reported: "some buildings are tiny and others are huge, and the tiny ones
 * have tiny doors and windows." That is a statement about a DISTRIBUTION, and
 * about whether details track their building or stay human-sized. A median
 * hides both.
 *
 * So this prints the spread of every dimension a person would notice, in
 * metres, against what that dimension is in the real world. No screenshots, no
 * adjectives — if a door comes out at 0.8m the report says 0.8m and says a
 * door is 2.0m.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/humanscale.mjs [seeds...]
 *   ... --by-type     also break the worst metrics down by building type
 *
 * The door and window numbers are DERIVED, not eyeballed: FacadeTexture lays
 * the facade out in texture units and that image is stretched over the wall,
 * so an opening's real size is its texture fraction times the wall's world
 * size. See BuildingScale in BuildingFactory.
 */
import { _electron as electron } from 'playwright-core'

const args = process.argv.slice(2)
const seeds = args.filter((a) => !a.startsWith('--')).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337)
const BY_TYPE = args.includes('--by-type')

// What a person is, and what the things around them measure. These are the
// yardstick the whole report is against; they are not tunables.
const HUMAN = {
  eye: 1.6,
  stature: 1.75,
}
/** [low, high] in metres — the range a real example of this falls in. */
const TARGET = {
  storeyH:  [2.5, 3.4,  'floor to floor in a house'],
  doorH:    [1.9, 2.2,  'a door you can walk through'],
  doorW:    [0.8, 1.1,  'a door you can fit through'],
  windowH:  [1.0, 1.6,  'a window you can see out of'],
  windowW:  [0.7, 1.4,  'a window sash'],
  wallH:    [3.0, 30.0, 'wall height, cottage to landmark'],
  wallW:    [3.0, 25.0, 'frontage, cottage to landmark'],
}

const pct = (sorted, p) => {
  if (sorted.length === 0) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[i]
}
const f = (n) => (Number.isFinite(n) ? n.toFixed(2).padStart(6) : '     -')

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

const all = []
for (const seed of seeds) {
  await win.evaluate((s) => {
    const inp = [...document.querySelectorAll('.left-panel input')]
      .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(inp, s)
    inp.dispatchEvent(new Event('input', { bubbles: true }))
  }, seed)
  await win.waitForTimeout(150)
  await win.getByRole('button', { name: /^generate$/i }).first().click()
  await win.waitForTimeout(2600)
  await win.getByRole('button', { name: '3D', exact: true }).click()
  await win.waitForTimeout(6500)
  const samples = await win.evaluate(
    () => window.__pt.debugInfo()?.buildingFactory?.scaleSamples ?? [])
  console.log(`seed ${seed}: ${samples.length} buildings`)
  all.push(...samples)
  await win.getByRole('button', { name: '2D', exact: true }).click()
  await win.waitForTimeout(500)
}
await app.close()

if (all.length === 0) {
  console.log('\nNo samples — the 3D scene did not build.')
  process.exit(1)
}

console.log(`\n=== HUMAN SCALE AUDIT — ${all.length} buildings, ${seeds.length} seeds ===`)
console.log(`reference: eye ${HUMAN.eye}m · person ${HUMAN.stature}m tall\n`)
console.log('metric        min    p10    med    p90    max  |  target       off-target')
console.log('-'.repeat(78))

const rows = []
for (const [key, [lo, hi, what]] of Object.entries(TARGET)) {
  const vals = all.map((s) => s[key]).filter(Number.isFinite).sort((a, b) => a - b)
  const bad = vals.filter((v) => v < lo || v > hi).length
  const share = Math.round((bad / vals.length) * 100)
  const med = pct(vals, 50)
  const verdict = share === 0 ? 'ok'
    : `${String(share).padStart(3)}%  ${med < lo ? 'TOO SMALL' : med > hi ? 'TOO BIG' : 'spread'}`
  console.log(
    `${key.padEnd(10)}${f(vals[0])}${f(pct(vals, 10))}${f(med)}${f(pct(vals, 90))}` +
    `${f(vals[vals.length - 1])}  |  ${(lo + '-' + hi).padEnd(11)}  ${verdict}`)
  rows.push({ key, what, lo, hi, med, share })
}

// Spread is its own finding: "some tiny, some huge" is a ratio, not a median.
console.log('\nspread (p90 / p10) — how unlike each other two buildings are:')
for (const key of ['wallH', 'wallW', 'totalH', 'storeyH']) {
  const vals = all.map((s) => s[key]).filter(Number.isFinite).sort((a, b) => a - b)
  const lo = pct(vals, 10), hi = pct(vals, 90)
  console.log(`  ${key.padEnd(10)} ${(hi / lo).toFixed(1)}x   (${lo.toFixed(1)}m .. ${hi.toFixed(1)}m)`)
}

console.log('\nagainst a person:')
const dh = all.map((s) => s.doorH).sort((a, b) => a - b)
const sh = all.map((s) => s.storeyH).sort((a, b) => a - b)
const shorterDoors = dh.filter((v) => v < HUMAN.stature).length
const shorterStoreys = sh.filter((v) => v < HUMAN.stature + 0.4).length
console.log(`  doors shorter than a ${HUMAN.stature}m person : ` +
  `${shorterDoors}/${dh.length}  (${Math.round(shorterDoors / dh.length * 100)}%)`)
console.log(`  storeys under ${(HUMAN.stature + 0.4).toFixed(2)}m head-to-ceiling : ` +
  `${shorterStoreys}/${sh.length}  (${Math.round(shorterStoreys / sh.length * 100)}%)`)

const failing = rows.filter((r) => r.share > 20)
if (failing.length) {
  console.log('\nwhat a person would notice:')
  for (const r of failing) {
    console.log(`  ${r.what}: median ${r.med.toFixed(2)}m, should be ${r.lo}-${r.hi}m`)
  }
}

if (BY_TYPE) {
  console.log('\nby building type (median storey / door / window height):')
  const byType = new Map()
  for (const s of all) {
    if (!byType.has(s.definitionId)) byType.set(s.definitionId, [])
    byType.get(s.definitionId).push(s)
  }
  const medOf = (arr, k) => pct(arr.map((x) => x[k]).sort((a, b) => a - b), 50)
  for (const [t, arr] of [...byType.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${t.padEnd(20)} n=${String(arr.length).padStart(4)}  ` +
      `storey ${medOf(arr, 'storeyH').toFixed(2)}  door ${medOf(arr, 'doorH').toFixed(2)}  ` +
      `win ${medOf(arr, 'windowH').toFixed(2)}  wallH ${medOf(arr, 'wallH').toFixed(1)}`)
  }
}
