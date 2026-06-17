/**
 * Headless screenshot harness for PainTraverse.
 *
 * Drives the BUILT Electron app with Playwright's Electron driver and saves
 * PNGs to .shots/. This is how an agent (or CI) can SEE the app without a
 * physical display — it reuses the app's own SwiftShader WebGL config from
 * src/main/index.ts, so both the Pixi 2D editor and the Three.js 3D
 * walkthrough render.
 *
 * Prereqs:
 *   npm install            (playwright is a devDependency)
 *   npm run build          (this loads dist/, so build first)
 *
 * Run:
 *   # on a machine with a display:
 *   node tools/screenshot.mjs
 *   # headless (Linux, no display):
 *   xvfb-run -a -s "-screen 0 1500x1000x24" node tools/screenshot.mjs
 *
 * Flags:
 *   --no-3d        skip the 3D walkthrough capture (faster)
 *   --no-generate  don't generate a town first (capture the empty default map)
 *
 * Output: .shots/01-menu.png, 02-landscape.png, 03-toolbar.png,
 *         04-left-rail.png, 05-right-rail.png, 06-3d.png
 */
import { _electron as electron } from 'playwright'
import { mkdirSync } from 'fs'

const flags = process.argv.slice(2)
const want3d = !flags.includes('--no-3d')
const wantGenerate = !flags.includes('--no-generate')
mkdirSync('.shots', { recursive: true })

const shot = async (loc, path) => { try { await loc.screenshot({ path: `.shots/${path}` }); console.log('✓', path) } catch (e) { console.log('✗', path, '-', e.message) } }

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000) // SwiftShader first paint is slow

await shot(win, '01-menu.png')

try {
  await win.getByText('Landscape', { exact: false }).first().click()
  await win.waitForTimeout(1500)
  if (wantGenerate) {
    await win.getByRole('button', { name: /^generate$/i }).first().click()
    await win.waitForTimeout(2800)
  }
  await shot(win, '02-landscape.png')
  await shot(win.locator('.toolbar'), '03-toolbar.png')
  await shot(win.locator('.left-panel'), '04-left-rail.png')
  await shot(win.locator('.right-panel'), '05-right-rail.png')

  if (want3d) {
    await win.getByRole('button', { name: '3D', exact: true }).click()
    await win.waitForTimeout(6000) // Three init + load + first render under SwiftShader
    await shot(win, '06-3d.png')
  }
} catch (e) {
  console.log('STEP FAILED:', e.message)
  await shot(win, 'ERROR.png')
}

await app.close()
console.log('done — see .shots/')
