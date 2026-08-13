/**
 * QUARTERS — which districts a town actually gets, and how big each one is.
 *
 * districts.mjs grades a quarter from inside; nothing asked the prior
 * question, which is WHICH quarters exist. That gap hid a real defect for the
 * length of the river arc: two seeds in three had no residential district at
 * all, because the type was drawn uniformly at random from every unused type,
 * so a town was exactly as likely to grow a cemetery as somewhere to live.
 * One run across six seeds says it immediately and no other tool can.
 *
 * Also prints the wet-tile histogram behind the water-quarter decision. The
 * two thresholds in generateDistricts are the only numbers there that cannot
 * be derived, so the distribution they cut has to stay visible.
 *
 * Pins the seed — genlog does not, and two of its readings were once
 * different towns.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/quarters.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'
const seeds = process.argv.slice(2).map(Number)
if (!seeds.length) seeds.push(4242, 777, 31337, 11, 65535, 2024)
const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)
const wetAll = {}
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
  const r = await win.evaluate(() => {
    const st = window.__pt.store.getState()
    const objs = st.map.layers.find((l) => l.type === 'structure')?.objects ?? []
    const defs = st.objectDefinitions
    const isBar = (o) => {
      const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
      return d?.category === 'infrastructure' || (d?.tags ?? []).includes('barrier')
    }
    const n = {}
    for (const o of objs) {
      const d = o.properties?.district
      if (!d || isBar(o)) continue
      n[d] = (n[d] ?? 0) + 1
    }
    const ps = window.__pt.placeStats()
    const wet = Object.fromEntries(Object.entries(ps).filter(([k]) => k.startsWith('~wet@')))
    return { n, wet, total: Object.values(n).reduce((a, b) => a + b, 0) }
  })
  for (const [k, v] of Object.entries(r.wet)) wetAll[k] = (wetAll[k] ?? 0) + v
  const line = Object.entries(r.n).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join(', ')
  console.log(`seed ${String(seed).padStart(6)}  ${String(r.total).padStart(4)} bldgs  ${line}`)
}
console.log('\nwet-count histogram over all district candidates (13x13 box, 169 tiles):')
for (const k of ['~wet@0', '~wet@1-9', '~wet@10-34', '~wet@35-69', '~wet@70+']) {
  if (wetAll[k]) console.log(`  ${k.slice(5).padEnd(8)} ${wetAll[k]}`)
}
await app.close()
