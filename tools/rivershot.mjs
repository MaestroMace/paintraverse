/**
 * RIVERSHOT — stand on the bank and LOOK at the water.
 *
 * river.mjs measures the channel; this photographs it. Both are needed and
 * the reason is on the record: the carve measured a perfectly healthy 1.14m
 * median bank relief and the phone came back with a picture of a gorge. The
 * numbers were true and the proportion was wrong, and only a picture shows
 * proportion.
 *
 * The hard part is not the camera, it is finding somewhere to PUT it. Earlier
 * attempts flew to a point near the water and landed inside a building three
 * times running, because flyTo does not test occupancy. So this picks its
 * vantage properly: a tile that is free of buildings and water, with a clear
 * run of free tiles between it and the river, looking along that run.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/rivershot.mjs [seed] [--time=18.5]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 4242)
const tArg = argv.find((a) => a.startsWith('--time='))
const timeOfDay = tArg ? Number(tArg.split('=')[1]) : 12
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
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, s)
  inp.dispatchEvent(new Event('input', { bubbles: true }))
}, seed)
await win.waitForTimeout(200)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2800)
await win.getByRole('button', { name: '3D', exact: true }).click()
await win.waitForTimeout(2600)
await win.evaluate((t) => window.__pt.store.getState().updateEnvironment({ timeOfDay: t }), timeOfDay)
await win.waitForTimeout(900)
await win.evaluate(() => {
  const h = document.querySelector('.walk-hint')
  if (h) h.style.display = 'none'
})

const vantages = await win.evaluate(() => {
  const st = window.__pt.store.getState()
  const map = st.map
  const defs = st.objectDefinitions
  const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
  const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
  const H = terrain.length, W = terrain[0].length
  const solid = Array.from({ length: H }, () => new Uint8Array(W))
  for (const o of structs) {
    const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
    if ((d?.tags ?? []).includes('passage')) continue
    const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
    for (let dy = 0; dy < f.h; dy++) {
      for (let dx = 0; dx < f.w; dx++) {
        const x = o.x + dx, y = o.y + dy
        if (x >= 0 && y >= 0 && x < W && y < H) solid[y][x] = 1
      }
    }
  }
  const isWater = (x, y) => terrain[y]?.[x] === 3
  const free = (x, y) => x > 0 && y > 0 && x < W - 1 && y < H - 1 &&
    !solid[y][x] && !isWater(x, y)

  // A vantage is: a free tile, with BACK tiles of clear ground between it and
  // the water, so the camera sees the bank and the channel rather than the
  // back of a house. Ranked by how much water is visible along that line.
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const out = []
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      if (!free(x, y)) continue
      for (const [dx, dy] of DIRS) {
        let clear = 0
        while (clear < 5 && free(x + dx * (clear + 1), y + dy * (clear + 1))) clear++
        if (clear < 2) continue
        // Water must start just past the clear run and continue a while.
        let wet = 0
        while (wet < 8 && isWater(x + dx * (clear + 1 + wet), y + dy * (clear + 1 + wet))) wet++
        if (wet < 2) continue
        // And there should be something to look AT on the far side.
        const farX = x + dx * (clear + 1 + wet), farY = y + dy * (clear + 1 + wet)
        const farBank = free(farX, farY)
        out.push({
          x: x + 0.5, y: y + 0.5, dx, dy, wet, clear,
          score: wet * 2 + (farBank ? 4 : 0) + clear,
        })
      }
    }
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, 3)
})

if (!vantages.length) {
  console.log('no standable vantage with a view of water')
} else {
  for (let i = 0; i < vantages.length; i++) {
    const v = vantages[i]
    await win.evaluate(async (a) => {
      const pt = window.__pt, three = pt.renderer()
      const g = pt.heightAt(a.x, a.y) ?? 0
      // Eye height, and a slight downward tilt — the bank is below the eye and
      // a level camera at the water's edge shows mostly sky.
      pt.flyTo(a.x, g + 1.6, a.y, Math.atan2(a.dy, a.dx), -0.10)
      for (let k = 0; k < 8; k++) await new Promise((r) => requestAnimationFrame(r))
      await new Promise((r) => setTimeout(r, 350))
      three.renderer.render(three.scene, three.camera)
    }, v)
    const buf = await win.screenshot({ clip: { x: 232, y: 40, width: 935, height: 806 } })
    writeFileSync(`.shots/rivershot-${seed}-${i}.png`, buf)
    console.log(`✓ .shots/rivershot-${seed}-${i}.png  ` +
      `stand (${v.x},${v.y}) look (${v.dx},${v.dy})  ${v.clear} tiles of bank, ${v.wet} of water`)
  }
}
await app.close()
