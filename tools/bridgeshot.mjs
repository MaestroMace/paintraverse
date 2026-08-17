/**
 * BRIDGESHOT — photograph every bridge, with its tiles printed beside it.
 *
 * Written because I claimed bridges were fixed on the strength of a metric and
 * a distant skyline, and was told they still looked like planks. Four separate
 * attempts to photograph one had failed: `flyTo` does not test occupancy, and
 * a bridge sits over water with its own tiles tagged `passage`, so every
 * ground-level vantage picker either stood inside a building or under the deck.
 *
 * Both cameras here were hand-placed and both were wrong at first — one at 26m
 * looked straight through a roofline, and the profile shot went to the wrong
 * axis and stood inside a house. They are `lookAt()` now (tools/lib/vantage.mjs),
 * which RAYCASTS the candidate before flying to it and refuses rather than
 * returning a frame with a wall in it. The plan shot asks it to go up; the
 * profile shot asks for a low bearing along the channel. Neither guesses.
 *
 * And the frames are CROPPED to the subject's projected box. A 4x2 bridge in a
 * 935px view of a whole town is about thirty pixels, which is exactly how many
 * pixels it takes for a plank to pass for a bridge.
 *
 * Each frame is printed with the tile row underneath it: L for land, ~ for
 * water, # for deck. The picture and the numbers come out of the same run, so
 * neither can quietly disagree with the other.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/bridgeshot.mjs [seed] [--n=3] [--time=12]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { lookAt, cropTo, hideChrome, FRAME } from './lib/vantage.mjs'

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
await hideChrome(win)

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
    // CAN YOU WALK ONTO IT? The question this tool never asked.
    //
    // Reported from the device: "the whole assembly from the base of the
    // pillars starts at ground level and not river bed level, so the walkway
    // is above the human scale head." Correct, and no instrument here could
    // have said so — bridgeshot photographed the span and printed the tiles
    // under it, river.mjs measures the channel, clash asks whether it stands
    // on the ground. None of them asked how far you have to CLIMB to get on.
    //
    // The deck's world height comes from structureBox outside this evaluate;
    // here we record the two ground heights it has to be compared against: the
    // BANK the player walks in from, and the BED the piers should reach down
    // to. `heightAt` speaks TILE coordinates — see scale.ts.
    const hAt = (x, y) => window.__pt.heightAt(x + 0.5, y + 0.5)
    let bank = -Infinity, bed = Infinity
    for (let i = -3; i < len + 3; i++) {
      const x = mx + dx * i, y = my + dy * i
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      const h = hAt(x, y)
      if (!Number.isFinite(h)) continue
      // Land beside the crossing is the bank you approach from; the wet tiles
      // under the deck are the bed the piers are supposed to stand in.
      if (!wet(x, y) && (i < 0 || i >= len)) bank = Math.max(bank, h)
      if (wet(x, y)) bed = Math.min(bed, h)
    }
    return {
      id: o.definitionId, oid: o.id, x: o.x, y: o.y, fw: f.w, fh: f.h, alongX, len,
      cx: o.x + f.w / 2, cy: o.y + f.h / 2, strip,
      bank: Number.isFinite(bank) ? +bank.toFixed(2) : null,
      bed: Number.isFinite(bed) ? +bed.toFixed(2) : null,
    }
  })
})

if (!info.length) { console.log(`no bridges in seed ${seed}`); await app.close(); process.exit(0) }
console.log(`${info.length} bridges in seed ${seed}`)
console.log('key: L land · ~ open water · # deck OVER WATER · = deck over dry land\n')

const TL = await win.evaluate(() => window.__pt.TILE)

/* --- CAN YOU WALK ONTO IT, AND DO THE PIERS REACH THE WATER? -------- */
//
// Reported from the device, and correct: "the whole assembly from the base of
// the pillars starts at ground level and not river bed level, so the walkway
// is above the human scale head."
//
// `wy` for any building is the MAX terrain height over its footprint — "so the
// building sits on the highest ground covered", which is right for a house on
// a slope and exactly wrong for a span across a channel, because the highest
// tile a bridge covers is the BANK. tmplStoneBridge then authors its piers at
// bottomY 0 and stacks the deck 1.85m ON TOP, so the deck ends up over head
// height above the bank while the piers stop short of the bed entirely.
//
// TWO questions, because they have different answers and one number hides
// that: how far you must CLIMB to get on the deck, and how far the piers stop
// SHORT of the bed. The first cut of this block measured the assembly base
// instead of the deck, read 0.13-0.38m, and would have reported the bridge
// fine — the base IS near bank level; it is everything above it that is not.
{
  const EYE = 1.6
  const rows = []
  for (const b of info) {
    if (b.bank === null || b.bed === null) continue
    // Read the BUILT volumes rather than re-deriving from template constants.
    // The deck is the widest piece of trim; the piers are the mainBody roles.
    const v = await win.evaluate((id) => {
      const all = window.__pt.sceneFeatures().volumes.filter((q) => q.id === id)
      if (!all.length) return null
      const trim = all.filter((q) => q.role === 'trim')
      const piers = all.filter((q) => q.role === 'mainBody')
      const area = (q) => (q.x1 - q.x0) * (q.z1 - q.z0)
      const deck = trim.sort((a, c) => area(c) - area(a))[0]
      return {
        deckTop: deck ? deck.y1 : null,
        pierBottom: piers.length ? Math.min(...piers.map((q) => q.y0)) : null,
      }
    }, b.oid)
    if (!v || v.deckTop === null) continue
    rows.push({
      def: b.id, bank: b.bank, bed: b.bed,
      deck: +v.deckTop.toFixed(2),
      climb: +(v.deckTop - b.bank).toFixed(2),
      short: v.pierBottom === null ? null : +(v.pierBottom - b.bed).toFixed(2),
    })
  }
  if (rows.length) {
    console.log('THE DECK AGAINST THE GROUND IT CROSSES:')
    console.log('   bank    bed   deck top   climb from bank   piers stop above bed')
    for (const r of rows.sort((a, c) => c.climb - a.climb)) {
      const flag = r.climb > EYE ? '   <-- deck is over head height'
        : r.climb > 0.45 ? '   <-- a clamber, not a landing' : ''
      console.log(`  ${String(r.bank).padStart(5)} ${String(r.bed).padStart(6)} ` +
        `${String(r.deck).padStart(10)} ${String(r.climb).padStart(17)} ` +
        `${String(r.short ?? '-').padStart(22)}${flag}`)
    }
    const overHead = rows.filter((r) => r.climb > EYE).length
    const floating = rows.filter((r) => r.short !== null && r.short > 0.3).length
    console.log(`  ${overHead} of ${rows.length} decks sit above a ${EYE}m eye height.`)
    console.log(`  ${floating} of ${rows.length} have piers that never reach the bed.\n`)
  }
}


for (let i = 0; i < Math.min(want, info.length); i++) {
  const b = info[i]

  // The subject box comes from the RENDERER's own record of what it built
  // (BuildingTop -> structureBox), not from the tile footprint and a guessed
  // height. A guessed height is what put a camera under the deck.
  const box = await win.evaluate((id) => window.__pt.structureBox(id), b.oid)
  if (!box) { console.log(`  (no geometry) ${b.id} @(${b.x},${b.y})`); continue }
  // Widen along the span so both banks are in frame — the question a plan shot
  // answers is "does it REACH", and a box tight to the deck cannot show that.
  const pad = 4 * TL
  const wide = {
    min: [box.min[0] - (b.alongX ? pad : 0), box.min[1], box.min[2] - (b.alongX ? 0 : pad)],
    max: [box.max[0] + (b.alongX ? pad : 0), box.max[1], box.max[2] + (b.alongX ? 0 : pad)],
  }

  // PLAN — high and steep, showing the span, both banks and the water at once.
  const plan = await lookAt(win, wide, { dists: [26, 34, 44, 56], heights: [22, 32, 44] })
  if (plan.ok) {
    writeFileSync(`.shots/bridge/${seed}-${i}-above.png`,
      await win.screenshot({ clip: cropTo(plan.screen, FRAME, 0.25) }))
  }

  // PROFILE — low, along the channel, which is the one line through a town
  // guaranteed to be free of buildings. Only this angle shows whether it READS
  // as a bridge: parapets, piers, headroom over the water. The bearing is a
  // PREFERENCE, not an instruction — if that side is blocked, lookAt walks
  // round to the nearest clear one instead of returning a wall.
  // maxFill is the lever that matters here. A long thin subject satisfies a
  // generous fill from INSIDE its own span — the first cut stood 14m from an
  // 18m bridge, filled 79% of frame and photographed one pier at arm's length.
  // Broadside, from either bank-to-bank direction, and NOT from three-quarters
  // down a street — an unoccluded, correctly-framed oblique of a bridge is
  // still a picture of a dark mass behind some houses.
  const along = b.alongX ? Math.PI / 2 : 0
  const prof = await lookAt(win, box, {
    dists: [14, 20, 28, 38], heights: [2, 5, 9], dirs: 24, maxFill: 0.55,
    prefer: [along, along + Math.PI], arc: 0.5,
  })
  if (prof.ok) {
    writeFileSync(`.shots/bridge/${seed}-${i}-profile.png`,
      await win.screenshot({ clip: cropTo(prof.screen, FRAME, 0.5) }))
  }

  const note = (v, n) => v.ok
    ? `${n} ${v.dist.toFixed(0)}m/${v.up.toFixed(0)}up fill ${(v.fill * 100).toFixed(0)}%`
    : `${n} FAILED: ${v.why}`
  console.log(`${plan.ok && prof.ok ? '✓' : '✗'} ${b.id} ${b.fw}x${b.fh} @(${b.x},${b.y})  ${b.strip}`)
  console.log(`    ${note(plan, 'plan')} · ${note(prof, 'profile')}`)
}
for (const b of info.slice(want)) {
  console.log(`  (not shot) ${b.id} ${b.fw}x${b.fh} @(${b.x},${b.y})  ${b.strip}`)
}
await app.close()
