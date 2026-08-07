/**
 * Oversize-sliver audit: find long thin batched geometry — the "giant floating
 * accent timber" class of defect — and name the source line that emitted it.
 *
 * A batched mesh gives you no way to ask which line drew a particular
 * triangle, which is why this defect survived several rounds of staring at
 * screenshots. BatchedMeshBuilder captures a stack when the audit is on, so
 * this prints emitter -> count, longest example, and a world position.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/slivers.mjs [seeds...] [--min=4]
 *
 * `--min` is the length in metres above which a thin piece counts as a beam.
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const seeds = args.filter((a) => !a.startsWith('--')).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337)
const MIN = Number((args.find((a) => a.startsWith('--min=')) ?? '--min=4').split('=')[1])
const SHOOT = Number((args.find((a) => a.startsWith('--shoot=')) ?? '--shoot=0').split('=')[1])

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

const totals = new Map()

for (const seed of seeds) {
  await win.evaluate((s) => {
    const inp = [...document.querySelectorAll('.left-panel input')]
      .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
    if (inp) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(inp, s)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, seed)
  await win.waitForTimeout(150)
  await win.getByRole('button', { name: /^generate$/i }).first().click()
  await win.waitForTimeout(2600)

  // Arm the audit BEFORE the 3D build runs, then force a rebuild by entering
  // the view. Geometry is emitted during loadMap, not during generate.
  await win.evaluate((m) => window.__pt.slivers.enable(true, m), MIN)
  await win.getByRole('button', { name: '3D', exact: true }).click()
  await win.waitForTimeout(7000)

  const report = await win.evaluate(() => window.__pt.slivers.read())
  for (const [site, v] of Object.entries(report)) {
    const e = totals.get(site) ?? { count: 0, maxLen: 0, at: null, seed: null }
    e.count += v.count
    if (v.maxLen > e.maxLen) { e.maxLen = v.maxLen; e.at = v.at; e.seed = seed }
    totals.set(site, e)
  }
  // Fly to the longest few and photograph them. A number tells you something
  // is 13m long; only a picture tells you whether that is a cornice doing its
  // job or a beam hanging in the sky.
  if (SHOOT) {
    mkdirSync('.shots', { recursive: true })
    await win.addStyleTag({ content: '.walk-hint { display: none !important; }' })
    const top = Object.entries(report)
      .sort((a, b) => b[1].maxLen - a[1].maxLen)
      .slice(0, SHOOT)
    for (const [site, v] of top) {
      const [x, y, z] = v.at
      await win.evaluate(([wx, wy, wz]) => {
        // flyTo takes TILE coords horizontally and metres vertically; the
        // audit records world metres, so convert. Stand back and slightly
        // above, looking at the piece.
        const T = 3.0
        const back = 14
        window.__pt.flyTo((wx - back) / T, wy + 5, (wz - back) / T, Math.PI / 4, -0.2)
      }, [x, y, z])
      await win.waitForTimeout(1200)
      const safe = site.replace(/[^\w@]/g, '_')
      const path = `.shots/sliver-${seed}-${safe}-${v.maxLen}m.png`
      await win.screenshot({ path })
      console.log('  📷', path)
    }
  }

  // Back to 2D so the next seed rebuilds cleanly.
  await win.getByRole('button', { name: '2D', exact: true }).click()
  await win.waitForTimeout(600)
}

console.log(`\n=== THIN GEOMETRY LONGER THAN ${MIN}m (${seeds.length} seeds) ===`)
const rows = [...totals.entries()].sort((a, b) => b[1].maxLen - a[1].maxLen)
if (rows.length === 0) console.log('  none — nothing thin is longer than the threshold')
for (const [site, v] of rows) {
  const at = v.at ? `at ${v.at.join(', ')} (seed ${v.seed})` : ''
  console.log(`  ${site.padEnd(34)} n=${String(v.count).padStart(4)}  longest=${v.maxLen}m  ${at}`)
}

await app.close()
