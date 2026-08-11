/**
 * FEATURE CENSUS — is the dressing vocabulary actually reaching the screen?
 *
 * This tool exists because of a shop sign, and it is deliberately not about
 * shop signs.
 *
 * The building factory gates twenty-odd pieces of street dressing behind
 * conditions on district, building type, footprint width and wall height —
 * chimneys, drainpipes, ivy, stoops, cellar doors, wheel guards, colonnades,
 * balconies. `featureCounts` was built to count them and had NO CONSUMER at
 * all, and only two features were ever tallied into it. So nobody could know
 * which of the rest fire at 0.
 *
 * That matters twice over, and both failures are silent:
 *
 *   A GHOST is a feature gated into non-existence. CLAUDE.md already records
 *     one: shop signs needed a commercial district AND type AND fp.w >= 2,
 *     produced 0-4 per town, and the "row of shop signs" simply never
 *     existed. Nobody notices absent content — there is no error, no warning,
 *     just a vocabulary you believe you have.
 *
 *   A WALLPAPER is worse, because it looks like success. Shop signs read 16%
 *     of buildings town-wide, which sounds like a reasonable amount of
 *     signage. It was 16% EVERYWHERE, cemetery included, because the gate had
 *     no district term. A feature that appears at the same rate in every
 *     quarter differentiates nothing; it is cost without information.
 *
 * So report every feature with its rate AND its spread across districts, and
 * name the two failure modes explicitly rather than leaving a reader to spot
 * them in a table.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/features.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337)

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

const agg = {}          // feature -> { total, byDistrict }
const districtTotals = {}
let structures = 0
for (const seed of seeds) {
  await win.evaluate((s) => {
    const inp = [...document.querySelectorAll('.left-panel input')]
      .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(inp, s)
    inp.dispatchEvent(new Event('input', { bubbles: true }))
  }, seed)
  await win.waitForTimeout(200)
  await win.getByRole('button', { name: /^generate$/i }).first().click()
  await win.waitForTimeout(2800)
  await win.getByRole('button', { name: '3D', exact: true }).click()
  await win.waitForTimeout(3000)

  const r = await win.evaluate(() => {
    const fc = window.__pt.debugInfo()?.buildingFactory?.featureCounts ?? {}
    const structs = window.__pt.store.getState().map.layers
      .find((l) => l.type === 'structure')?.objects ?? []
    // Count the denominator the SAME WAY the building factory counts the
    // numerator. It defaults a missing district to 'residential'; counting
    // only buildings that carry the property put walls, gates and towers in
    // the numerator and not the denominator, and the doorstep rate came out
    // at 182% of a district. A rate over 100% is the tool telling you its two
    // halves disagree about what they are counting.
    const byDistrict = {}
    for (const o of structs) {
      const d = o.properties?.district ?? 'residential'
      byDistrict[d] = (byDistrict[d] ?? 0) + 1
    }
    return { fc, byDistrict, total: structs.length }
  })
  structures += r.total
  for (const [k, n] of Object.entries(r.byDistrict)) {
    districtTotals[k] = (districtTotals[k] ?? 0) + n
  }
  for (const [k, n] of Object.entries(r.fc)) {
    const [feat, dist] = k.split('@')
    ;(agg[feat] ??= { total: 0, byDistrict: {} })
    if (dist === undefined) agg[feat].total += n
    else agg[feat].byDistrict[dist] = (agg[feat].byDistrict[dist] ?? 0) + n
  }
  await win.waitForTimeout(150)
}
await app.close()

const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 100))
const feats = Object.entries(agg).sort((a, b) => b[1].total - a[1].total)

console.log(`\n=== FEATURE CENSUS — ${structures} buildings over ${seeds.length} seeds ===\n`)
console.log('feature              count   of all   per-district rate (min..max)   spread')
console.log('-'.repeat(82))
const ghosts = [], wallpaper = []
for (const [name, f] of feats) {
  // Rate within each district that HAS buildings, so a feature confined to a
  // rare quarter is not punished for the quarter being rare.
  const rates = []
  for (const [d, n] of Object.entries(districtTotals)) {
    if (n < 8) continue                       // too few to say anything
    rates.push((f.byDistrict[d] ?? 0) / n)
  }
  rates.sort((a, b) => a - b)
  const lo = rates.length ? rates[0] : 0
  const hi = rates.length ? rates[rates.length - 1] : 0
  const spread = hi - lo
  console.log(`${name.padEnd(20)}${String(f.total).padStart(6)}` +
    `${String(pct(f.total, structures) + '%').padStart(9)}` +
    `${String(`${Math.round(lo * 100)}%..${Math.round(hi * 100)}%`).padStart(24)}` +
    `${String(Math.round(spread * 100) + 'pts').padStart(12)}`)
  if (f.total === 0 || pct(f.total, structures) < 2) ghosts.push(name)
  else if (spread < 0.12 && pct(f.total, structures) > 8) wallpaper.push(name)
}

console.log(`\nGHOSTS — under 2% of buildings. CHECK THE GATE BEFORE CALLING ONE A BUG:`)
console.log('  a feature correctly confined to a rare type (a colonnade belongs to a')
console.log('  temple and nowhere else) looks identical here to one gated into')
console.log('  nonexistence by accident. The tell is whether the gate names a rare')
console.log('  TYPE on purpose, or names a dimension that excludes the ordinary town.')
console.log(ghosts.length ? '  ' + ghosts.join(', ')
  : '  none. Every feature in the vocabulary actually appears.')
console.log(`\nWALLPAPER — common but identical in every quarter (<12pts spread):`)
console.log(wallpaper.length ? '  ' + wallpaper.join(', ')
  : '  none. Every common feature varies by district.')
console.log('\n  A ghost is content you believe you have and do not.')
console.log('  Wallpaper is content you have that tells the player nothing.')
console.log('  Both are silent: no error, no warning, and a screenshot of one')
console.log('  building looks fine in either case.')
