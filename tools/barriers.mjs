/**
 * BARRIERS — does a fence CONNECT to anything, or is it one tile of nothing?
 *
 * Reported from the device: the small wall/fence props "don't connect or look
 * like they belong, the placement doesn't seem to have a reason to be there",
 * and the wall was named the worst offender.
 *
 * That is a placement failure with an exact shape. **A barrier is a RUN, not a
 * prop.** One tile of fence is meaningless — a fence means "this side is mine"
 * and it can only say that by being continuous along an edge. The town already
 * knows this in one place: `placePrecinctWalls` lays a quarter's frontage as a
 * line with gaps for gateways. Everywhere else, barriers are drawn from
 * `DISTRICT_PROPS` — a bag whose own comment two lines down says it holds
 * "only small ground clutter that belongs at the kerb" — and dropped one tile
 * at a time beside a random building.
 *
 *   node tools/barriers.mjs [seeds...]
 *
 * THE METRIC HAS NOTHING TO TUNE: walk the barrier tiles, take 4-connected
 * runs, and report how many barriers are ISOLATED — no barrier neighbour at
 * all. An isolated fence tile is the defect by definition, whatever it is made
 * of and wherever it stands.
 *
 * REPORTED PER definitionId, because the town wall is thirty tiles long and
 * would otherwise drown every stray picket in the average. A metric whose
 * numerator and denominator mix a curtain wall with a garden fence is not
 * measuring either.
 */
import { _electron as electron } from 'playwright-core'
import { BARRIERS } from './lib/taxonomy.mjs'

const args = process.argv.slice(2)
const seeds = args.filter((a) => /^\d+$/.test(a)).map(Number)
const SEEDS = seeds.length ? seeds : [4242, 31337, 8080]

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

console.log('\n=== BARRIERS — is this fence part of a fence? ===')
console.log(`  ${BARRIERS.size} barrier ids from the store's own \`barrier\` tag`)
const totals = new Map()
let allTiles = 0, allIsolated = 0
for (const seed of SEEDS) {
  await win.evaluate((s) => {
    const inp = [...document.querySelectorAll('.left-panel input')]
      .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(inp, s); inp.dispatchEvent(new Event('input', { bubbles: true }))
  }, seed)
  await win.waitForTimeout(150)
  await win.getByRole('button', { name: /^generate$/i }).first().click()
  await win.waitForTimeout(2600)

  const objs = await win.evaluate((ids) => {
    const st = window.__pt.store.getState()
    const want = new Set(ids)
    const out = []
    for (const l of st.map.layers) {
      for (const o of l.objects ?? []) {
        if (!want.has(o.definitionId)) continue
        const fp = o.footprint ?? { w: 1, h: 1 }
        out.push({ id: o.definitionId, x: o.x, y: o.y, w: fp.w, h: fp.h })
      }
    }
    return out
  }, [...BARRIERS])

  // Every tile any barrier occupies, and which id owns it.
  const cell = new Map()
  for (const o of objs) {
    for (let dy = 0; dy < o.h; dy++) {
      for (let dx = 0; dx < o.w; dx++) cell.set(`${o.x + dx},${o.y + dy}`, o.id)
    }
  }
  // ISOLATED = no barrier in any of the four orthogonal neighbours. A run of
  // one is a fence that fences nothing.
  const perId = new Map()
  for (const [k, id] of cell) {
    const [x, y] = k.split(',').map(Number)
    const touching = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .some(([dx, dy]) => cell.has(`${x + dx},${y + dy}`))
    const e = perId.get(id) ?? { tiles: 0, iso: 0 }
    e.tiles++
    if (!touching) e.iso++
    perId.set(id, e)
    const t = totals.get(id) ?? { tiles: 0, iso: 0 }
    t.tiles++; if (!touching) t.iso++
    totals.set(id, t)
    allTiles++; if (!touching) allIsolated++
  }
  const iso = [...perId.values()].reduce((a, e) => a + e.iso, 0)
  const til = [...perId.values()].reduce((a, e) => a + e.tiles, 0)
  console.log(`\n  seed ${seed}: ${til} barrier tiles, ${iso} isolated ` +
    `(${(iso / Math.max(1, til) * 100).toFixed(0)}%)`)
}

console.log('\n  BY TYPE — a curtain wall is thirty tiles long and would drown')
console.log('  every stray picket in an average, so they are kept apart.')
const rows = [...totals.entries()].sort((a, b) => b[1].iso - a[1].iso)
for (const [id, e] of rows) {
  console.log(`    ${id.padEnd(20)} ${String(e.tiles).padStart(4)} tiles  ` +
    `${String(e.iso).padStart(4)} isolated  ` +
    `${(e.iso / Math.max(1, e.tiles) * 100).toFixed(0).padStart(3)}%` +
    (e.iso === e.tiles && e.tiles > 0 ? '   <- never connects to anything' : ''))
}
console.log(`\n  TOTAL  ${allIsolated} of ${allTiles} barrier tiles stand alone ` +
  `(${(allIsolated / Math.max(1, allTiles) * 100).toFixed(0)}%)`)
console.log('  A fence means "this side is mine". One tile cannot say it.')
await app.close()
