/**
 * Count volumes trimmed by the footprint-overhang cap, per building type.
 *
 * The placement audit checks FOOTPRINTS, so a building can satisfy every
 * invariant and still throw geometry straight through its neighbour. That is
 * what the windmill's sails did — a flat cross spanning diameter x 4.4, three
 * tiles of overhang per side — and nothing caught it because nothing was
 * looking at mesh extents. Non-zero output here means a template is doing it.
 *
 *   xvfb-run -a node tools/overhang.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!seeds.length) seeds.push('4242','777','31337','11','65535','2024','8080','999999')

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded'); await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click(); await win.waitForTimeout(1200)

const total = {}
for (const seed of seeds) {
  await win.evaluate((s) => {
    const inp = [...document.querySelectorAll('.left-panel input')]
      .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
    if (inp) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(inp, s); inp.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, seed)
  await win.waitForTimeout(150)
  await win.getByRole('button', { name: /^generate$/i }).first().click()
  await win.waitForTimeout(2400)
  // Reset BEFORE the 3D build, since that is what runs pickMassing.
  await win.evaluate(() => window.__pt.overhangs.reset())
  await win.getByRole('button', { name: '3D', exact: true }).click()
  await win.waitForTimeout(5000)
  const r = await win.evaluate(() => window.__pt.overhangs.read())
  for (const [k, v] of Object.entries(r)) total[k] = (total[k] ?? 0) + v
  await win.getByRole('button', { name: '2D', exact: true }).click()
  await win.waitForTimeout(800)
}

console.log(`\n=== VOLUMES TRIMMED BY THE OVERHANG CAP (${seeds.length} seeds) ===`)
const rows = Object.entries(total).sort((a, b) => b[1] - a[1])
if (!rows.length) console.log('  none — no template overhangs its footprint')
for (const [k, v] of rows) console.log('  ' + k.padEnd(34) + v)

await app.close()
