/**
 * Headless capture of the PIXEL-ART render path (the Render / Export PNG
 * buttons), which is the one output of this app that had no way to be seen
 * without a human clicking it.
 *
 * That blind spot has cost us: Canvas2DRenderer kept a private copy of the
 * terrain palette that stopped at tile id 13, so once the tile ids were split
 * to separate circulation from paving, every plaza and every market or harbor
 * district exported as fallback grey — and nothing caught it, because no tool
 * ever looked at this path's output.
 *
 * Prereqs:
 *   npm run build
 *
 * Run:
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/pixelart.mjs [seed ...]
 *
 * Output: .shots/pixelart-<seed>.png — the render canvas only, not the app
 * chrome, so a diff between runs shows render changes and nothing else.
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'fs'

const argv = process.argv.slice(2)
const seeds = argv.filter((a) => !a.startsWith('--'))
if (seeds.length === 0) seeds.push('4242')
// --time=12 renders at a different hour. Comparing dusk against noon is the
// quickest way to tell a lighting-model problem from a draw-path problem.
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

for (const seed of seeds) {
  // Drive the seed field and the Generate button, same as tools/audit.mjs,
  // so the map under test is exactly what a user would get.
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
    await win.waitForTimeout(500)
  }

  // Drive the render exactly as the Render button does, then read the canvas
  // back as a PNG. Going through the real handler means this exercises the
  // full pipeline (scene + water reflection + light map + grading + bloom).
  const dataUrl = await win.evaluate(async () => {
    const btn = [...document.querySelectorAll('button')]
      .find((b) => b.textContent.trim() === 'Render')
    if (!btn) return { error: 'no Render button' }
    btn.click()
    // The handler renders on the next animation frame and drops the result
    // into an <img> as a data URL. Read that, NOT a canvas: the editor's Pixi
    // canvas is WebGL without preserveDrawingBuffer, so toDataURL on it
    // silently returns a fully black image.
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const img = [...document.querySelectorAll('img')]
        .find((el) => el.src.startsWith('data:image'))
      if (img) return { url: img.src, w: img.naturalWidth, h: img.naturalHeight }
      const err = document.querySelector('.render-error')
      if (err) return { error: err.textContent }
    }
    return { error: 'render did not finish in 30s' }
  })

  if (dataUrl.error) {
    console.log(`seed ${seed}: FAILED — ${dataUrl.error}`)
    continue
  }
  const out = `.shots/pixelart-${seed}${suffix}.png`
  writeFileSync(out, Buffer.from(dataUrl.url.split(',')[1], 'base64'))
  console.log(`seed ${seed}: ✓ ${out} (${dataUrl.w}x${dataUrl.h})`)
}

await app.close()
console.log('done — see .shots/')
