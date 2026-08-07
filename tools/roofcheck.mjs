/**
 * Roof completeness check.
 *
 * "Half built roofs" is a reported, persistent complaint, and the thing that
 * actually produces it is a volume whose top is FLAT with nothing stacked on
 * it — an open box against the sky, which reads as a building someone stopped
 * working on. BuildingFactory already counts these as `flatToppedTallVolumes`;
 * this puts the number in front of you per seed instead of leaving it buried
 * in a debug dump.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/roofcheck.mjs [seeds...]
 *
 * Should trend to zero. Non-zero means that many buildings in that town have
 * a flat slab where a roof belongs.
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337, 11, 65535)

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

let total = 0
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
  await win.waitForTimeout(6000)
  const d = await win.evaluate(() => window.__pt.debugInfo()?.buildingFactory)
  const flat = d?.flatToppedTallVolumes ?? -1
  total += Math.max(0, flat)
  console.log(
    `seed ${String(seed).padStart(7)}  openTopVolumes=${String(flat).padStart(3)}` +
    `  built=${d?.succeeded ?? '?'}  failed=${d?.failed ?? '?'}`
  )
  await win.getByRole('button', { name: '2D', exact: true }).click()
  await win.waitForTimeout(500)
}
console.log(`\nTOTAL OPEN-TOPPED VOLUMES ACROSS ${seeds.length} SEEDS: ${total}`)
await app.close()
