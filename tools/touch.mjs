/**
 * TOUCH — can you actually work the app with a finger?
 *
 * Every existing harness drives this app with a MOUSE. `webshot.mjs` sets
 * `hasTouch` and then clicks buttons, which is a mouse gesture wearing a
 * touch flag, so it has never once exercised a drag or a pinch. That blind
 * spot hid the plainest possible defect: panning the 2D plan was bound to the
 * MIDDLE MOUSE BUTTON or space-and-drag and zoom to the SCROLL WHEEL, and a
 * phone has none of the three, so the map could not be moved at all.
 *
 * Gestures are graded against the viewport's OWN pan and zoom, via
 * `window.__pt.editorView()`, and only illustrated with screenshots. The first
 * cut graded them by diffing the canvas and failed its own "a tap must not
 * pan" check: the picture really did change, because the select tool drew a
 * highlight. A pixel diff cannot tell a pan from a hover — ask the thing that
 * knows, and keep the picture as evidence rather than as the verdict.
 *
 *   xvfb-run -a node tools/touch.mjs [--device=pixel]
 */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { createHash } from 'node:crypto'

const argv = process.argv.slice(2)
const DEVICES = {
  pixel: { width: 412, height: 915, dsf: 2, touch: true },
  'pixel-land': { width: 915, height: 412, dsf: 2, touch: true },
  tablet: { width: 820, height: 1180, dsf: 2, touch: true },
}
const NAME = argv.find((a) => a.startsWith('--device='))?.split('=')[1] ?? 'pixel'
const DEV = DEVICES[NAME]
if (!DEV) { console.error(`unknown device — one of ${Object.keys(DEVICES)}`); process.exit(1) }
mkdirSync('.shots/touch', { recursive: true })

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }
const server = createServer(async (req, res) => {
  try {
    const url = (req.url || '/').split('?')[0]
    const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '')
    const body = await readFile(join('dist-web', rel))
    res.writeHead(200, { 'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream' })
    res.end(body)
  } catch { res.writeHead(404); res.end('not found') }
})
await new Promise((r) => server.listen(4181, r))

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
})
const ctx = await browser.newContext({
  viewport: { width: DEV.width, height: DEV.height },
  deviceScaleFactor: DEV.dsf, isMobile: DEV.touch, hasTouch: DEV.touch,
})
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR:', e.message) })

await page.goto('http://127.0.0.1:4181/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2200)
await page.getByText('Landscape', { exact: false }).first().click()
// Long enough for the starter world to generate and the plan to bake.
await page.waitForTimeout(6000)

const results = []
const ok = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ${detail}`)
}

// --- 1. Does the app open onto a town? ---------------------------------
const built = await page.evaluate(() => {
  const m = window.__pt?.store.getState().map
  if (!m) return null
  return {
    structures: m.layers.find((l) => l.type === 'structure')?.objects.length ?? 0,
    props: m.layers.find((l) => l.type === 'prop')?.objects.length ?? 0,
    grid: `${m.gridWidth}x${m.gridHeight}`,
  }
})
ok('starter world', (built?.structures ?? 0) > 20,
  built ? `${built.structures} structures, ${built.props} props, ${built.grid}` : 'no debug bridge')

// --- 2. Does the whole map fit on screen? ------------------------------
const fit = await page.evaluate(() => {
  const cv = document.querySelector('.mobile-viewport canvas') ?? document.querySelector('canvas')
  if (!cv) return null
  const st = window.__pt.store.getState().map
  return { cw: cv.clientWidth, ch: cv.clientHeight, mapPx: st.gridWidth * st.tileSize }
})
ok('map fits the screen', !!fit && fit.mapPx > fit.cw,
  fit ? `map is ${fit.mapPx}px of plan in a ${fit.cw}x${fit.ch} canvas — must be scaled to fit` : 'no canvas')

const shotCanvas = async (tag) => {
  const cv = page.locator('.mobile-viewport canvas').first()
  const buf = await cv.screenshot()
  writeFileSync(`.shots/touch/${NAME}-${tag}.png`, buf)
  return createHash('sha1').update(buf).digest('hex').slice(0, 12)
}
/**
 * The pan and zoom the viewport is actually holding.
 *
 * The first cut of this graded gestures by DIFFING THE CANVAS, and it failed
 * its own "a tap must not pan" check — correctly, in the sense that the
 * picture really did change, and uselessly, because what changed was the
 * select tool drawing a highlight. A pixel diff cannot tell a pan from a
 * hover. Ask the thing that knows.
 */
const view = () => page.evaluate(() => window.__pt?.editorView() ?? null)
const moved = (a, b) => Math.hypot(b.panX - a.panX, b.panY - a.panY)

// --- 3. One-finger drag pans (default tool is select, which has no drag) ---
const cx = Math.round(DEV.width / 2), cy = Math.round(DEV.height * 0.35)
const before = await shotCanvas('01-before')
const vBefore = await view()
await page.touchscreen.tap(cx, cy)   // a tap belongs to the tool, not the map
await page.waitForTimeout(250)
await shotCanvas('02-after-tap')
const vTap = await view()

await page.evaluate(async ([x, y]) => {
  const cv = document.querySelector('.mobile-viewport canvas')
  const send = (type, pts) => {
    for (const p of pts) {
      cv.dispatchEvent(new PointerEvent(type, {
        pointerId: p.id, pointerType: 'touch', isPrimary: p.id === 1,
        clientX: p.x, clientY: p.y, bubbles: true, cancelable: true,
      }))
    }
  }
  send('pointerdown', [{ id: 1, x, y }])
  for (let i = 1; i <= 10; i++) {
    send('pointermove', [{ id: 1, x: x - i * 9, y: y + i * 5 }])
    await new Promise((r) => requestAnimationFrame(r))
  }
  send('pointerup', [{ id: 1, x: x - 90, y: y + 50 }])
}, [cx, cy])
await page.waitForTimeout(400)
const afterDrag = await shotCanvas('03-after-drag')
const vDrag = await view()
ok('one-finger drag pans', !!vDrag && moved(vBefore, vDrag) > 40,
  `moved ${Math.round(moved(vBefore, vDrag))}px, picture ${before} -> ${afterDrag}`)
ok('a tap does NOT pan', !!vTap && moved(vBefore, vTap) < 1,
  `moved ${moved(vBefore, vTap).toFixed(2)}px`)

// --- 4. Two-finger pinch zooms -----------------------------------------
await page.evaluate(async ([x, y]) => {
  const cv = document.querySelector('.mobile-viewport canvas')
  const send = (type, pts) => {
    for (const p of pts) {
      cv.dispatchEvent(new PointerEvent(type, {
        pointerId: p.id, pointerType: 'touch', isPrimary: p.id === 1,
        clientX: p.x, clientY: p.y, bubbles: true, cancelable: true,
      }))
    }
  }
  send('pointerdown', [{ id: 1, x: x - 40, y }, { id: 2, x: x + 40, y }])
  for (let i = 1; i <= 12; i++) {
    send('pointermove', [{ id: 1, x: x - 40 - i * 8, y }, { id: 2, x: x + 40 + i * 8, y }])
    await new Promise((r) => requestAnimationFrame(r))
  }
  send('pointerup', [{ id: 1, x: x - 136, y }, { id: 2, x: x + 136, y }])
}, [cx, cy])
await page.waitForTimeout(400)
const afterPinch = await shotCanvas('04-after-pinch')
const vPinch = await view()
ok('two-finger pinch zooms', !!vPinch && vPinch.zoom > vDrag.zoom * 1.3,
  `zoom ${vDrag.zoom.toFixed(3)} -> ${vPinch.zoom.toFixed(3)}, picture ${afterDrag} -> ${afterPinch}`)

// --- 5. The fit button brings the whole map back ------------------------
const fitBtn = page.locator('.mobile-fit')
if (await fitBtn.count()) {
  await fitBtn.tap()
  await page.waitForTimeout(400)
  await shotCanvas('05-after-fit')
  const vFit = await view()
  ok('fit button re-frames', !!vFit && Math.abs(vFit.zoom - vBefore.zoom) < 0.01 &&
    moved(vBefore, vFit) < 2, `zoom ${vPinch.zoom.toFixed(3)} -> ${vFit.zoom.toFixed(3)}`)
} else {
  ok('fit button re-frames', false, 'no .mobile-fit button found')
}

// --- 6. Nothing runs off the side of the screen -------------------------
const overflow = await page.evaluate(() => {
  const d = document.documentElement
  const bad = []
  document.querySelectorAll('body *').forEach((el) => {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) return
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.opacity === '0' || cs.position === 'fixed') return
    if (r.right > d.clientWidth + 1 || r.left < -1) {
      bad.push(`${el.tagName}.${(el.className || '-').toString().split(' ')[0]} ${Math.round(r.left)}..${Math.round(r.right)}`)
    }
  })
  return { scrollW: d.scrollWidth, clientW: d.clientWidth, bad: bad.slice(0, 6) }
})
ok('nothing overflows sideways', overflow.scrollW <= overflow.clientW && !overflow.bad.length,
  `scrollW ${overflow.scrollW} vs ${overflow.clientW}${overflow.bad.length ? ' — ' + overflow.bad.join(', ') : ''}`)

console.log(`\n${results.filter((r) => !r.pass).length} of ${results.length} checks FAILED on ${NAME}`)
console.log(errors.length ? `${errors.length} page error(s)` : 'no page errors')
await browser.close(); server.close()
process.exit(results.some((r) => !r.pass) ? 1 : 0)
