/**
 * Capture the 3D walkaround from several deliberate vantage points.
 *
 * tools/screenshot.mjs only ever sees the player spawn, which is usually
 * pressed against a wall — fine as a smoke test, useless for judging whether
 * the town looks right. This flies the camera through a fixed set of shots
 * so the same angles can be compared across commits.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/walkshots.mjs [seed]
 *
 * Output: .shots/walk-<seed>-<name>.png
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'fs'

const argv = process.argv.slice(2)
const seed = argv.find((a) => !a.startsWith('--')) ?? '4242'
// Same trick as tools/pixelart.mjs: comparing an hour against dusk is the
// fastest way to tell "this surface is unlit" from "this surface is untextured".
const timeArg = argv.find((a) => a.startsWith('--time='))
const TIME = timeArg ? Number(timeArg.split('=')[1]) : null
const suffix = TIME === null ? '' : `-t${TIME}`
mkdirSync('.shots', { recursive: true })

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
  if (inp) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(inp, s)
    inp.dispatchEvent(new Event('input', { bubbles: true }))
  }
}, seed)
await win.waitForTimeout(150)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2600)

if (TIME !== null) {
  await win.evaluate((t) => {
    window.__pt.store.getState().updateEnvironment({ timeOfDay: t })
  }, TIME)
  await win.waitForTimeout(600)
}

await win.getByRole('button', { name: '3D', exact: true }).click()
await win.waitForTimeout(7000) // Three init + build + first frame under SwiftShader

// The "Click to walk" hint sits dead centre over whatever we came to look at.
await win.addStyleTag({ content: '.walk-hint { display: none !important; }' })

// Centre of a 48x48 town. Heights are ABOVE the terrain at that point, so
// the shots stay framed on hilly seeds too.
const SHOTS = [
  { name: 'overview',  x: 24, z: 40, up: 34, yaw: -Math.PI / 2, pitch: -0.62 },
  { name: 'skyline',   x: 24, z: 46, up: 12, yaw: -Math.PI / 2, pitch: -0.14 },
  { name: 'street',    x: 24, z: 24, up: 1.6, yaw: 0.0, pitch: -0.05 },
  { name: 'street-alt', x: 16, z: 30, up: 1.6, yaw: Math.PI / 2, pitch: 0.0 },
  { name: 'rooftops',  x: 24, z: 30, up: 16, yaw: -Math.PI / 2, pitch: -0.45 },
]

for (const s of SHOTS) {
  const ok = await win.evaluate((sh) => {
    const pt = window.__pt
    if (!pt?.renderer()) return false
    const ground = pt.heightAt(sh.x, sh.z) ?? 0
    pt.flyTo(sh.x, ground + sh.up, sh.z, sh.yaw, sh.pitch)
    return true
  }, s)
  if (!ok) { console.log('✗', s.name, '- no renderer'); continue }
  await win.waitForTimeout(1800) // let shadows/lights settle at the new position
  const path = `.shots/walk-${seed}${suffix}-${s.name}.png`
  try {
    await win.locator('canvas').last().screenshot({ path })
    console.log('✓', path)
  } catch (e) {
    console.log('✗', path, '-', e.message)
  }
}

const stats = await win.evaluate(() => window.__pt.sceneStats())
if (stats) console.log('\nscene extent:', JSON.stringify(stats))

const info = await win.evaluate(() => window.__pt.debugInfo())
if (info) {
  console.log(`\nfps=${info.fps} draws=${info.render?.drawCalls} tris=${info.render?.triangles} ` +
    `buildings=${info.scene?.buildingCount} props=${info.scene?.propCount}`)
}

await app.close()
console.log('done — see .shots/')
