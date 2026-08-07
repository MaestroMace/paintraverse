/**
 * Load the standalone WEB build in a real Chromium and drive it.
 *
 * The Electron harnesses cannot prove the web target works: they run the
 * Electron build, where `window.electronAPI` exists and Node is one layer
 * away. Everything about the Android APK rests on this bundle running with
 * neither, so it needs its own way to be looked at — the same reason
 * tools/pixelart.mjs exists.
 *
 * Also useful as a phone preview: `--mobile` uses a Pixel-sized viewport
 * with touch enabled, so layout and touch controls can be checked here
 * before anything is installed on a device.
 *
 *   npm run build:web
 *   xvfb-run -a node tools/webshot.mjs [--mobile] [--seed=4242]
 */
import { chromium } from 'playwright-core'
import { createServer } from 'http'
import { readFile } from 'fs/promises'
import { extname, join, normalize } from 'path'
import { mkdirSync } from 'fs'

const argv = process.argv.slice(2)
const MOBILE = argv.includes('--mobile')
const seedArg = argv.find((a) => a.startsWith('--seed='))
const SEED = seedArg ? seedArg.split('=')[1] : '4242'
mkdirSync('.shots', { recursive: true })

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
}

const server = createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0]
    const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '')
    const body = await readFile(join('dist-web', rel))
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})
await new Promise((r) => server.listen(4178, r))

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})
const ctx = await browser.newContext(
  MOBILE
    // Pixel 8 logical viewport. hasTouch drives the app's touch detection,
    // so this exercises the same code path the phone will.
    ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true }
    : { viewport: { width: 1400, height: 900 } }
)
const page = await ctx.newPage()

const errors = []
page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR:', e.message) })
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE ERROR:', m.text()) })

await page.goto('http://127.0.0.1:4178/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500)

const tag = MOBILE ? 'mobile' : 'desktop'
await page.screenshot({ path: `.shots/web-${tag}-01-menu.png` })
console.log(`✓ .shots/web-${tag}-01-menu.png`)

try {
  await page.getByText('Landscape', { exact: false }).first().click()
  await page.waitForTimeout(1500)

  // On a narrow screen both rails start closed, so the seed field and
  // Generate live behind the left drawer handle — open it like a user would.
  if (MOBILE) {
    await page.locator('.panel-toggle.left-toggle').click()
    await page.waitForTimeout(600)
    await page.screenshot({ path: `.shots/web-${tag}-01b-drawer.png` })
    console.log(`✓ .shots/web-${tag}-01b-drawer.png`)
  }

  await page.evaluate((s) => {
    const inp = [...document.querySelectorAll('input')]
      .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
    if (inp) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(inp, s)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, SEED)
  await page.getByRole('button', { name: /^generate$/i }).first().click()
  await page.waitForTimeout(2800)
  await page.screenshot({ path: `.shots/web-${tag}-02-plan.png` })
  console.log(`✓ .shots/web-${tag}-02-plan.png`)

  // Close the drawer again so the 3D shot shows what the player sees.
  // The handle is under the open drawer, so tap the scrim like a user.
  if (MOBILE) {
    await page.locator('.drawer-scrim').click({ position: { x: 380, y: 700 } })
    await page.waitForTimeout(500)
  }
  await page.getByRole('button', { name: '3D', exact: true }).click()
  await page.waitForTimeout(7000)
  await page.screenshot({ path: `.shots/web-${tag}-03-3d.png` })
  console.log(`✓ .shots/web-${tag}-03-3d.png`)

  const info = await page.evaluate(() => window.__pt?.debugInfo() ?? null)
  if (info) {
    console.log(`fps=${info.fps} draws=${info.render?.drawCalls} tris=${info.render?.triangles}`)
  } else {
    console.log('NOTE: window.__pt missing — debug bridge did not install')
  }
} catch (e) {
  console.log('STEP FAILED:', e.message)
  await page.screenshot({ path: `.shots/web-${tag}-ERROR.png` })
}

console.log(errors.length ? `\n${errors.length} PAGE ERROR(S)` : '\nno page errors')
await browser.close()
server.close()
