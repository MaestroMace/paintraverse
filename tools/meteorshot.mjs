/**
 * METEORSHOT — catch a shooting star.
 *
 * The schedule fires one every 17-43 seconds of dark, which is right for play
 * and impossible to photograph by waiting: a still harness that sat there
 * hoping would report "no meteor" most runs, and an unverifiable feature is
 * the GHOST this repo keeps finding. `__pt.fireMeteor()` exists for exactly
 * this — the instrument is one line and it turns a rare event into a subject.
 *
 * SHOOTS A BURST ACROSS THE FLIGHT, because a meteor lives 1.15s and a single
 * frame at an arbitrary phase is as likely to catch the fade as the streak.
 *
 *   xvfb-run -a node tools/meteorshot.mjs [seed] [--time=23]
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const seed = Number(args.find((a) => /^\d+$/.test(a))) || 4242
const time = Number((args.find((a) => a.startsWith('--time=')) ?? '').slice(7)) || 23

mkdirSync('.shots/meteor', { recursive: true })
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

if (!(await win.evaluate(() => typeof window.__pt.fireMeteor === 'function'))) {
  console.log('\n__pt.fireMeteor is missing — the bundle predates the feature.')
  console.log('A missing measurement must not read as a pass.')
  await app.close()
  process.exit(1)
}


const canvas = await win.evaluate(() => {
  let best = null
  for (const el of document.querySelectorAll('canvas')) {
    const r = el.getBoundingClientRect()
    if (!best || r.width * r.height > best.width * best.height) {
      best = { x: r.x, y: r.y, width: r.width, height: r.height }
    }
  }
  return best
})
const clip = canvas ? { clip: canvas } : {}

console.log(`\n=== METEOR — seed ${seed}, t=${time} ===`)
// Several flights, a few frames into each: under SwiftShader the frame rate
// is a handful per second, so one shot per flight is a lottery on the phase.
let shot = 0
for (let flight = 0; flight < 3; flight++) {
  // AIM AT THE FLIGHT, NOT AT A PATCH OF SKY. The first cut pitched up 41
  // degrees on a fixed yaw and caught the streak in one frame of nine,
  // because the bearing is random and the camera was pointed at a guess.
  // `fireMeteor` returns the path's midpoint for exactly this — the fix that
  // took celestial.mjs from "DEAD" to 1700x on nothing but where it looked.
  const mid = await win.evaluate(() => window.__pt.fireMeteor())
  if (!mid) { console.log('  x fireMeteor returned nothing'); break }
  await win.evaluate((m) => {
    const c = window.__pt.renderer().camera
    const dx = m.x - c.position.x, dy = m.y - c.position.y, dz = m.z - c.position.z
    window.__pt.flyToWorld(c.position.x, c.position.y, c.position.z,
      Math.atan2(dz, dx), Math.atan2(dy, Math.hypot(dx, dz)))
  }, mid)
  for (const wait of [140, 300, 470]) {
    await win.waitForTimeout(wait)
    const path = `.shots/meteor/meteor-${seed}-${shot}.png`
    await win.screenshot({ ...clip, path })
    console.log(`  ✓ ${path}`)
    shot++
  }
  await win.waitForTimeout(900)
}
console.log('\nA still CAN show a meteor — the streak IS its silhouette, which')
console.log('is the one motion feature in this town a photograph does not')
console.log('systematically under-report.')
await app.close()
