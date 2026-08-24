/**
 * FEATURESHOT — point a camera at a named street-dressing feature.
 *
 * `features.mjs` COUNTS a gated feature and cannot say where one IS, and that
 * gap cost a whole camera hunt. The buttress fires 12 times in ~840 structures
 * — 1.4% — so photographing any given building has almost no chance of
 * containing one, and the magenta probe this repo recommends came back with an
 * empty frame, which reads exactly like "your geometry does not exist" when it
 * actually means "you were looking at a different building".
 *
 * That is the same hole `slivers.mjs` filled for batched geometry: a batch
 * hides its authors, so make it name them. `featureSites` records the world
 * position of up to a dozen instances of each named feature at the point they
 * are emitted, which is the only place that knows.
 *
 * WHY THIS IS NOT `asset.mjs`. That tool photographs a definitionId — a whole
 * building TYPE — and every one of them carries the type. A gated feature is
 * a property of an INSTANCE: most clergy houses have no buttress, so asking
 * for a clergy house and hoping is the sampling failure above. Ask for the
 * feature.
 *
 *   xvfb-run -a node tools/featureshot.mjs buttress [seed] [--n=2] [--time=]
 *   xvfb-run -a node tools/featureshot.mjs --list [seed]
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { lookAt, cropTo, markSubject, hideChrome, FRAME } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const wantList = args.includes('--list')
const feature = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'buttress'
const seed = Number(args.find((a) => /^\d+$/.test(a))) || 4242
const n = Number((args.find((a) => a.startsWith('--n=')) ?? '').slice(4)) || 2
const time = Number((args.find((a) => a.startsWith('--time=')) ?? '').slice(7)) || 18.5

mkdirSync('.shots/feature', { recursive: true })
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
await win.waitForTimeout(150)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2600)
await win.getByRole('button', { name: '3D', exact: true }).click()
await waitForScene(win)
await win.evaluate((h) => window.__pt.store.getState().updateEnvironment({ timeOfDay: h }), time)
await hideChrome(win)

const sites = await win.evaluate(() =>
  window.__pt.debugInfo()?.buildingFactory?.featureSites ?? {})

if (wantList) {
  console.log(`\n=== FEATURES WITH A RECORDED SITE — seed ${seed} ===`)
  const keys = Object.keys(sites).sort()
  if (!keys.length) console.log('  none. No emit site calls siteOf() yet.')
  for (const k of keys) console.log(`  ${k.padEnd(24)} ${sites[k].length} recorded`)
  console.log('\nRecording is CAPPED per feature — see featureSites in')
  console.log('BuildingFactory. A count of 12 here means "at least 12", not')
  console.log('twelve; features.mjs owns the rate and this owns the position.')
  await app.close()
  process.exit(0)
}

const spots = sites[feature] ?? []
console.log(`\n=== ${feature.toUpperCase()} — seed ${seed}, ${spots.length} recorded site(s) ===`)
if (!spots.length) {
  // AN ABSENCE HERE HAS TWO CAUSES AND THEY WANT OPPOSITE FIXES, so say both
  // rather than printing a bare zero — the classify-by-cause rule.
  console.log('  no recorded site. Either the feature did not fire on this seed,')
  console.log('  or its emit site does not call siteOf() yet. `--list` shows which')
  console.log('  features are instrumented; features.mjs shows which ones fired.')
  await app.close()
  process.exit(0)
}

let shot = 0
for (const p of spots.slice(0, n)) {
  // A feature is small and attached to a wall, so frame it TIGHT and insist on
  // eye level: `order: 'height'` exhausts every distance before going up,
  // because a shot from above cannot show you a flank.
  const half = 1.6
  const box = {
    min: [p.x - half, p.y - half, p.z - half],
    max: [p.x + half, p.y + half, p.z + half],
  }
  const v = await lookAt(win, box, {
    dists: [4, 6, 9, 13, 18],
    heights: [1.6, 3, 6],
    order: 'height',
    pick: 'largest',
    minFill: 0.05,
  })
  if (!v.ok) { console.log(`  x ${v.why}`); continue }
  await markSubject(win, v.screen)
  const path = `.shots/feature/${feature}-${seed}-${shot}.png`
  await win.screenshot({ clip: cropTo(v.screen, FRAME), path })
  console.log(`  ✓ ${path}  at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) — ` +
    `${v.dist?.toFixed(0) ?? '?'}m out, fills ${((v.fill ?? 0) * 100).toFixed(0)}%`)
  shot++
}
console.log('\nThe magenta box is where the FEATURE was recorded, not the')
console.log('building — so an empty box is a real finding and not a miss.')
await app.close()
