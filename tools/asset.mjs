/**
 * ASSET — photograph ONE building type where it actually stands.
 *
 * There was no way to look at a single type. Adding a building meant running
 * walkshots and hoping one of five fixed vantages happened to contain the new
 * thing, which for a type that is 3% of the town it does not. Every asset
 * added in this repo so far has been graded by a metric and a wide shot, and
 * "does it read as a tenement" is not a question either can answer.
 *
 * The camera is tools/lib/vantage.mjs now. This tool used to walk outward tile
 * by tile looking for standable ground, project a footprint box with a GUESSED
 * 14m height, and hope the line between was clear — three separate proxies for
 * questions the scene can answer exactly. `lookAt` raycasts the candidate and
 * `structureBox` reports the real envelope, so the standoff comes from how
 * tall the thing actually is instead of from how big its plot is.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/asset.mjs <defId> [seed] [--n=3] [--time=12]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { lookAt, cropTo, markSubject, hideChrome, FRAME } from './lib/vantage.mjs'

const argv = process.argv.slice(2)
const defId = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a))
if (!defId) { console.log('usage: node tools/asset.mjs <definitionId> [seed] [--n=3] [--time=12]'); process.exit(1) }
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 4242)
const want = Number(argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 3)
const timeOfDay = Number(argv.find((a) => a.startsWith('--time='))?.split('=')[1] ?? 12)
mkdirSync('.shots/asset', { recursive: true })

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
await win.waitForTimeout(2800)
await win.evaluate((t) => window.__pt.store.getState().updateEnvironment({ timeOfDay: t }), timeOfDay)
await win.waitForTimeout(900)
await hideChrome(win)

const shots = await win.evaluate(({ id, want }) => {
  const st = window.__pt.store.getState()
  const structs = st.map.layers.find((l) => l.type === 'structure')?.objects ?? []
  const hits = structs.filter((o) => o.definitionId === id)
  if (!hits.length) return { none: true, total: structs.length }
  return {
    count: hits.length,
    shots: hits.slice(0, want).map((o) => ({
      oid: o.id, x: o.x, y: o.y,
      district: o.properties?.district ?? '?',
      floors: o.properties?.floors ?? '?',
    })),
  }
}, { id: defId, want })

if (shots.none) {
  console.log(`no ${defId} in seed ${seed} (${shots.total} structures placed)`)
} else {
  console.log(`${shots.count} x ${defId} in seed ${seed}`)
  for (let i = 0; i < shots.shots.length; i++) {
    const v = shots.shots[i]
    const box = await win.evaluate((id) => window.__pt.structureBox(id), v.oid)
    if (!box) { console.log(`  ✗ ${defId} @(${v.x},${v.y}) has no built geometry`); continue }
    // Eye level first, then step up. A building is meant to be seen from the
    // street; the higher candidates are the fallback for one hemmed in by
    // neighbours, which is most of a terrace.
    const view = await lookAt(win, box, {
      dists: [10, 14, 19, 26, 34], heights: [0, 2, 5, 11], dirs: 20, maxFill: 0.7,
    })
    if (!view.ok) { console.log(`  ✗ ${defId} @(${v.x},${v.y}): ${view.why}`); continue }
    await markSubject(win, view.screen)
    const buf = await win.screenshot({ clip: cropTo(view.screen, FRAME, 0.55) })
    writeFileSync(`.shots/asset/${defId}-${seed}-${i}.png`, buf)
    console.log(`  ✓ .shots/asset/${defId}-${seed}-${i}.png  ${v.district} quarter, ` +
      `${v.floors} floors — ${view.dist.toFixed(0)}m out, ${view.up.toFixed(0)}m up, ` +
      `fills ${(view.fill * 100).toFixed(0)}%`)
  }
}
await app.close()
