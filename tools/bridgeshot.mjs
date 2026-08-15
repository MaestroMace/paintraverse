/**
 * BRIDGESHOT — photograph every bridge, from above, with its tiles printed.
 *
 * Written because I claimed bridges were fixed on the strength of a metric and
 * a distant skyline, and was told they still looked like planks. Four separate
 * attempts to photograph one had failed: `flyTo` does not test occupancy, and
 * a bridge sits over water with its own tiles tagged `passage`, so every
 * ground-level vantage picker either stood inside a building or under the deck.
 *
 * The fix is to stop fighting for a standable spot. Go UP. At 26m the only
 * things in the way are spires, and a three-quarter view from above shows the
 * whole span, both banks and the water at once — which is exactly the question
 * ("does it reach?") that a street-level shot cannot answer anyway.
 *
 * Each frame is printed with the tile row underneath it: L for land, ~ for
 * water, # for deck. The picture and the numbers come out of the same run, so
 * neither can quietly disagree with the other.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/bridgeshot.mjs [seed] [--n=3] [--time=12]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 31337)
const want = Number(argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 3)
const timeOfDay = Number(argv.find((a) => a.startsWith('--time='))?.split('=')[1] ?? 12)
mkdirSync('.shots/bridge', { recursive: true })

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
await win.evaluate(() => { const h = document.querySelector('.walk-hint'); if (h) h.style.display = 'none' })

const info = await win.evaluate(() => {
  const st = window.__pt.store.getState()
  const map = st.map, defs = st.objectDefinitions
  const terrain = map.layers.find((l) => l.type === 'terrain').terrainTiles
  const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
  const H = terrain.length, W = terrain[0].length
  const bridges = structs.filter((o) => /bridge/.test(o.definitionId))
  const deck = Array.from({ length: H }, () => new Uint8Array(W))
  const fpOf = (o) => o.footprint ??
    defs.find((d) => d.id === o.definitionId)?.footprint ?? { w: 1, h: 1 }
  for (const o of bridges) {
    const f = fpOf(o)
    for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) {
      const x = o.x + dx, y = o.y + dy
      if (x >= 0 && y >= 0 && x < W && y < H) deck[y][x] = 1
    }
  }
  const wet = (x, y) => terrain[y]?.[x] === 3
  return bridges.map((o) => {
    const f = fpOf(o)
    const alongX = f.w >= f.h
    const len = alongX ? f.w : f.h
    const mx = alongX ? o.x : o.x + Math.floor(f.w / 2)
    const my = alongX ? o.y + Math.floor(f.h / 2) : o.y
    const dx = alongX ? 1 : 0, dy = alongX ? 0 : 1
    // The line through the crossing, three tiles either side of the deck.
    let strip = ''
    for (let i = -3; i < len + 3; i++) {
      const x = mx + dx * i, y = my + dy * i
      const onDeck = i >= 0 && i < len
      // Show what is UNDER the deck, not just that there is a deck. The first
      // cut printed '#' for every deck tile, which hides the only thing that
      // matters — a bridge over dry land and a bridge over the river looked
      // identical in the output meant to tell them apart.
      strip += onDeck ? (wet(x, y) ? '#' : '=') : (wet(x, y) ? '~' : 'L')
    }
    return {
      id: o.definitionId, x: o.x, y: o.y, fw: f.w, fh: f.h, alongX, len,
      cx: o.x + f.w / 2, cy: o.y + f.h / 2, strip,
    }
  })
})

if (!info.length) { console.log(`no bridges in seed ${seed}`); await app.close(); process.exit(0) }
console.log(`${info.length} bridges in seed ${seed}`)
console.log('key: L land · ~ open water · # deck OVER WATER · = deck over dry land\n')

for (let i = 0; i < Math.min(want, info.length); i++) {
  const b = info[i]
  await win.evaluate(async (a) => {
    const pt = window.__pt, three = pt.renderer()
    // Steep and high. The first cut sat at 26m and 14 tiles back, and the
    // sightline to the bridge passed straight through the rooftops between —
    // going "above the buildings" is not enough, the whole RAY has to clear
    // them. At 44m and 8 tiles the ray is ~25m up at the midpoint, over
    // everything but the spires, and the pitch is computed to land on the
    // bridge rather than guessed.
    const ALT = 44, BACK = 8
    const ex = a.alongX ? a.cx : a.cx + BACK
    const ez = a.alongX ? a.cy + BACK : a.cy
    const TL = 3.0
    const run = Math.hypot(a.cx - ex, a.cy - ez) * TL
    const yaw = Math.atan2(a.cy - ez, a.cx - ex)
    pt.flyTo(ex, ALT, ez, yaw, -Math.atan2(ALT - 3, Math.max(1, run)))
    for (let k = 0; k < 8; k++) await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => setTimeout(r, 400))
    three.renderer.render(three.scene, three.camera)
  }, b)
  const buf = await win.screenshot({ clip: { x: 232, y: 40, width: 935, height: 806 } })
  writeFileSync(`.shots/bridge/${seed}-${i}-above.png`, buf)

  // AND A PROFILE. The plan view proves the span REACHES; only a low oblique
  // shows whether it READS as a bridge — parapets, piers, headroom. Taken
  // from over the CHANNEL, which is the one line through a town guaranteed to
  // be free of buildings, at 9m so the camera clears the deck it is looking
  // at. Every earlier attempt at this stood on the bank at eye height and
  // came back either inside a house or underneath the deck.
  await win.evaluate(async (a) => {
    const pt = window.__pt, three = pt.renderer()
    const OFF = 7, ALT = 9
    // Stand over the WATER. The deck crosses the channel, so the channel runs
    // perpendicular to the deck: a deck along X means a river along Z, and the
    // camera offsets along Z. Getting that backwards put it on the bank and
    // inside a house — which is how every previous attempt at this failed.
    const sx = a.alongX ? a.cx : a.cx + OFF
    const sz = a.alongX ? a.cy + OFF : a.cy
    const TL = 3.0
    const run = Math.hypot(a.cx - sx, a.cy - sz) * TL
    pt.flyTo(sx, ALT, sz, Math.atan2(a.cy - sz, a.cx - sx),
             -Math.atan2(ALT - 3.5, Math.max(1, run)))
    for (let k = 0; k < 8; k++) await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => setTimeout(r, 400))
    three.renderer.render(three.scene, three.camera)
  }, b)
  const buf2 = await win.screenshot({ clip: { x: 232, y: 40, width: 935, height: 806 } })
  writeFileSync(`.shots/bridge/${seed}-${i}-profile.png`, buf2)
  console.log(`✓ .shots/bridge/${seed}-${i}-{above,profile}.png  ${b.id} ${b.fw}x${b.fh} @(${b.x},${b.y})  ${b.strip}`)
}
for (const b of info.slice(want)) {
  console.log(`  (not shot) ${b.id} ${b.fw}x${b.fh} @(${b.x},${b.y})  ${b.strip}`)
}
await app.close()
