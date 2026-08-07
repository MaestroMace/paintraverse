/**
 * Group bisector: screenshot the same vantage point with each top-level scene
 * group hidden in turn, so "what IS that artifact?" becomes a diff instead of
 * a guess.
 *
 * TS `private` is compile-time only, so the renderer's groups are reachable at
 * runtime through the debug bridge. Hiding one and re-shooting is the fastest
 * way to attribute a stray piece of geometry to the code that emitted it.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/bisect.mjs [seed] \
 *     [--x=16] [--z=30] [--up=1.6] [--yaw=1.57] [--pitch=0]
 *
 * x/z are TILE coordinates and up is metres, matching tools/walkshots.mjs.
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const seed = Number(args.find((a) => !a.startsWith('--')) ?? 4242)
const num = (name, dflt) => {
  const a = args.find((s) => s.startsWith(`--${name}=`))
  return a ? Number(a.split('=')[1]) : dflt
}
const VIEW = {
  x: num('x', 16), z: num('z', 30), up: num('up', 1.6),
  yaw: num('yaw', Math.PI / 2), pitch: num('pitch', 0),
}

mkdirSync('.shots', { recursive: true })
const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

// Same seed-entry path as walkshots.mjs — the store has no direct setter.
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
await win.getByRole('button', { name: '3D', exact: true }).click()
await win.waitForTimeout(7000)
await win.addStyleTag({ content: '.walk-hint { display: none !important; }' })

// Every top-level group the renderer owns. Hiding one at a time attributes
// stray geometry to whichever pass built it.
const GROUPS = ['buildingGroup', 'propGroup', 'terrainGroup', 'particleGroup']

const shoot = async (label) => {
  const path = `.shots/bisect-${seed}-${label}.png`
  await win.screenshot({ path })
  console.log('✓', path)
}

await win.evaluate((v) => {
  const pt = window.__pt
  const ground = pt.heightAt(v.x, v.z) ?? 0
  pt.flyTo(v.x, ground + v.up, v.z, v.yaw, v.pitch)
}, VIEW)
await win.waitForTimeout(1500)
await shoot('all')

for (const g of GROUPS) {
  const ok = await win.evaluate((name) => {
    const r = window.__pt.renderer()
    const grp = r?.[name]
    if (!grp) return false
    grp.visible = false
    return true
  }, g)
  if (!ok) { console.log('–', g, 'not found'); continue }
  await win.waitForTimeout(700)
  await shoot(`no-${g}`)
  await win.evaluate((name) => { window.__pt.renderer()[name].visible = true }, g)
}

await app.close()
console.log('done — see .shots/')
