/**
 * Report which building types actually get placed, and at what footprint
 * size, across seeds.
 *
 * DISTRICT_BUILDINGS states an intent ("a market is mostly shops"), but the
 * placement loop picks a type by weight and then abandons the whole attempt
 * if that type does not fit the free space. Nothing retries smaller. So the
 * fit test, not the weight table, may be the real selector — and this prints
 * the evidence either way.
 *
 *   xvfb-run -a node tools/typemix.mjs [seed ...]
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (seeds.length === 0) seeds.push('4242', '777', '31337', '11', '65535', '2024')

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

const totals = new Map()
const bySize = new Map()
let grand = 0

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

  const rows = await win.evaluate(() => {
    const st = window.__pt.store.getState()
    const defs = new Map(st.objectDefinitions.map((d) => [d.id, d]))
    const objs = st.map.layers.find((l) => l.type === 'structure')?.objects ?? []
    return objs.map((o) => {
      const d = defs.get(o.definitionId)
      return { id: o.definitionId, area: d ? d.footprint.w * d.footprint.h : 0 }
    })
  })

  for (const r of rows) {
    totals.set(r.id, (totals.get(r.id) ?? 0) + 1)
    bySize.set(r.area, (bySize.get(r.area) ?? 0) + 1)
    grand++
  }
}

console.log(`\n=== BUILDING TYPE MIX over ${seeds.length} seeds (${grand} structures) ===`)
for (const [id, n] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${id.padEnd(20)} ${String(n).padStart(4)}  ${(100 * n / grand).toFixed(1)}%`)
}

console.log(`\n=== BY FOOTPRINT AREA (tiles) ===`)
for (const [area, n] of [...bySize.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${String(area).padStart(3)} tiles  ${String(n).padStart(4)}  ${(100 * n / grand).toFixed(1)}%`)
}

// Trade / commercial types, the thing markets are supposed to be made of.
const TRADE = ['shop', 'bakery', 'apothecary', 'tavern', 'inn', 'covered_market',
  'warehouse', 'guild_hall', 'corner_building']
const trade = TRADE.reduce((s, t) => s + (totals.get(t) ?? 0), 0)
console.log(`\ntrade/commercial types: ${trade} of ${grand} (${(100 * trade / grand).toFixed(1)}%)`)

await app.close()
