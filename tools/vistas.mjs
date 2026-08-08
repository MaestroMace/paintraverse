/**
 * VISTAS — what do you SEE when you look down a street?
 *
 * Every metric so far grades the town as a map: how wide the street is, how
 * much frontage is built, how far the nearest wall stands. All of them are
 * measured looking DOWN at the plan. None of them can tell you what the town
 * looks like from inside it, which is the only view the player ever has.
 *
 * The Imagineering term for the thing this is missing is a WEENIE: a visual
 * magnet that closes the end of a street and pulls you toward it. Main Street
 * has the castle at the end of it, and that single fact is what turns a
 * shopping arcade into a place you walk down. Every reference in DESIGN.md
 * does this — Diagon Alley bends so Gringotts closes the view, Gion frames
 * the pagoda at the top of the hill.
 *
 * So stand on every road tile, look along the street, and record what stops
 * the view:
 *
 *   A LANDMARK — a tower, cathedral, clock tower, windmill, gate. The view
 *     terminates on something worth walking toward. This is the weenie.
 *   AN ORDINARY BUILDING — the view closes. Fine, and much better than not
 *     closing: a street that ends in a wall is still a room.
 *   NOTHING — the corridor runs off the map, or out into open ground. The
 *     street dissolves and there is nowhere to go. This is what makes a town
 *     read as a set of props on a field rather than a place with a plan.
 *
 * The number to move is the share of LONG views (a proper look down a street,
 * not a glance across an alley mouth) that land on a landmark.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/vistas.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337)
const TILE = 3.0
/** A view worth calling a vista, in tiles. 8 tiles is 24m of street. */
const LONG_VIEW = 8

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

const rows = []
for (const seed of seeds) {
  await win.evaluate((s) => {
    const inp = [...document.querySelectorAll('.left-panel input')]
      .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(inp, s)
    inp.dispatchEvent(new Event('input', { bubbles: true }))
  }, seed)
  await win.waitForTimeout(150)
  await win.getByRole('button', { name: /^generate$/i }).first().click()
  await win.waitForTimeout(2800)

  const r = await win.evaluate((LONG) => {
    const st = window.__pt.store.getState()
    const map = st.map
    const defs = st.objectDefinitions
    const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
    const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
    if (!terrain) return null
    const H = terrain.length, W = terrain[0].length
    const isRoad = (x, y) => {
      const t = terrain[y]?.[x]
      return t === 8 || t === 9
    }
    // What stops a VIEW is geometry, not a change of floor.
    //
    // The first version of this marched over paved tiles and stopped at the
    // first unpaved one, reporting 35% of long views as "dissolving into open
    // ground". That is not what a player sees. Standing in a street looking
    // down it, the ground turning from cobble to grass does not end the view —
    // you keep seeing, until a building blocks you or you are looking at the
    // horizon. Scoring a material change as a terminated view meant the fix
    // and the metric disagreed about where a wall was needed, and a pass that
    // placed 40 buildings moved the number by zero.
    const blocksView = (x, y) => terrain[y]?.[x] === undefined

    // What terminates a view is a BUILDING, and which building matters.
    // Anything with real height and presence reads as a destination; a row
    // house reads as the side of the street.
    const LANDMARKS = new Set([
      'clock_tower', 'cathedral', 'tower', 'windmill', 'town_gate', 'gate',
      'temple', 'guildhall', 'manor', 'mansion', 'lighthouse',
    ])
    const built = Array.from({ length: H }, () => new Int16Array(W).fill(-1))
    structs.forEach((o, idx) => {
      const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
      const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
      for (let dy = 0; dy < f.h; dy++) {
        for (let dx = 0; dx < f.w; dx++) {
          const px = o.x + dx, py = o.y + dy
          if (px >= 0 && py >= 0 && px < W && py < H) built[py][px] = idx
        }
      }
    })
    const isLandmark = (idx) => {
      const o = structs[idx]
      if (!o) return false
      if (LANDMARKS.has(o.definitionId)) return true
      // A tower house that stands well above its neighbours also terminates a
      // view — the "someone built up" outlier in DESIGN.md is a weenie too.
      return (o.properties?.floors ?? 1) >= 5
    }

    const views = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isRoad(x, y)) continue
        // Look along the street, both ways, on whichever axis it runs.
        const run = (dx, dy) => {
          let n = 1
          for (let k = 1; k <= 40 && isRoad(x + dx * k, y + dy * k); k++) n++
          for (let k = 1; k <= 40 && isRoad(x - dx * k, y - dy * k); k++) n++
          return n
        }
        const runX = run(1, 0), runY = run(0, 1)
        if (Math.abs(runX - runY) < 2) continue    // a square, not a corridor
        const axis = runX > runY ? [1, 0] : [0, 1]
        for (const sign of [1, -1]) {
          const dx = axis[0] * sign, dy = axis[1] * sign
          let dist = 0, ended = 'horizon', hitIdx = -1
          for (let k = 1; k <= 40; k++) {
            const px = x + dx * k, py = y + dy * k
            if (blocksView(px, py)) { ended = 'offmap'; break }
            if (built[py][px] >= 0) { ended = 'building'; hitIdx = built[py][px]; break }
            dist = k
          }
          views.push({
            dist,
            kind: ended === 'building'
              ? (isLandmark(hitIdx) ? 'landmark' : 'building')
              : ended,
            id: hitIdx >= 0 ? structs[hitIdx].definitionId : null,
          })
        }
      }
    }
    const byId = {}
    for (const v of views) {
      if (v.kind !== 'landmark') continue
      byId[v.id] = (byId[v.id] ?? 0) + 1
    }
    return { views, byId, structures: structs.length }
  }, LONG_VIEW)
  if (!r) { console.log(`seed ${seed}: no terrain`); continue }
  rows.push({ seed, ...r })
  await win.waitForTimeout(150)
}
await app.close()

const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 100))

console.log('\n=== WHAT CLOSES THE VIEW DOWN A STREET ===')
console.log('seed      views   landmark  building  horizon   off-map    median')
console.log('-'.repeat(70))
const all = []
for (const r of rows) {
  all.push(...r.views)
  const n = r.views.length
  const c = (k) => r.views.filter((v) => v.kind === k).length
  const ds = r.views.map((v) => v.dist).sort((a, b) => a - b)
  console.log(
    `${String(r.seed).padStart(7)}${String(n).padStart(8)}` +
    `${String(pct(c('landmark'), n) + '%').padStart(11)}` +
    `${String(pct(c('building'), n) + '%').padStart(10)}` +
    `${String(pct(c('horizon'), n) + '%').padStart(9)}` +
    `${String(pct(c('offmap'), n) + '%').padStart(10)}` +
    `${String((ds[Math.floor(ds.length / 2)] * TILE).toFixed(0) + 'm').padStart(10)}`)
}

// The number that matters is not every glance — it is the long look down a
// street, where the eye has time to ask what it is walking toward.
const long = all.filter((v) => v.dist >= LONG_VIEW)
console.log('-'.repeat(70))
console.log(`\nLONG VIEWS (>= ${LONG_VIEW} tiles / ${(LONG_VIEW * TILE).toFixed(0)}m of open street): ` +
  `${long.length} of ${all.length}`)
for (const k of ['landmark', 'building', 'horizon', 'offmap']) {
  const n = long.filter((v) => v.kind === k).length
  const label = { landmark: 'terminate on a LANDMARK  (the weenie)',
    building: 'terminate on a building  (closed, fine)',
    horizon: 'never close — open to the horizon',
    offmap: 'run off the map edge' }[k]
  console.log(`  ${label.padEnd(42)} ${String(pct(n, long.length) + '%').padStart(5)}  (${n})`)
}

const byId = {}
for (const r of rows) for (const [k, v] of Object.entries(r.byId)) byId[k] = (byId[k] ?? 0) + v
const top = Object.entries(byId).sort((a, b) => b[1] - a[1]).slice(0, 8)
if (top.length) {
  console.log('\nwhat is at the end of the street, when it is something:')
  for (const [id, n] of top) console.log(`  ${id.padEnd(20)} ${n}`)
}
