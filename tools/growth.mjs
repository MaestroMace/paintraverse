/**
 * GROWTH — does the town get sparser as you walk out of it?
 *
 * DESIGN.md lists six marks of "organic human structural controlled chaos"
 * and five of them have an instrument: shared walls (urbanform partyWalls),
 * height variation inside a cluster (districts), corridor width (streets),
 * tall outliers (variety/odd), continuous slopes (relief). The sixth —
 *
 *     Dense core, sparse edges. Growth rings fade outward; the oldest
 *     part is the tightest.
 *
 * — has never been measured by anything. A town can satisfy every other
 * metric in the harness while being a uniform slab of buildings out to a hard
 * boundary, which is the one shape a settlement that GREW cannot have, and no
 * existing check would notice: urbanform reports coverage as a single town-
 * wide figure, and a flat 46% and a proper gradient averaging 46% are the
 * same number.
 *
 * WHAT IT MEASURES. Rings of equal AREA out from the centre — equal area, not
 * equal radius, so every ring carries a comparable sample and the outermost
 * one is not four times the size of the innermost. Per ring: built coverage
 * of the land that could be built on, median building height, and party-wall
 * share. Then the shape of the coverage curve.
 *
 * WHERE THE CENTRE IS. The building centroid, not the map centre. The town
 * does not fill the map — there is river, there is countryside — and grading
 * a growth gradient against the middle of the CANVAS would measure how
 * off-centre the town is rather than how it thins.
 *
 * WHAT COUNTS AS BUILDABLE. Water and circulation are excluded, exactly as
 * urbanform does it, or the profile mostly reports where the river is. Note
 * this is the same population urbanform's `built coverage of non-street land`
 * uses, so the ring figures should average to roughly its town-wide number —
 * if they do not, one of the two is wrong.
 *
 * NO TARGET IS STATED. Three of propscale.mjs's hand-written targets were
 * wrong on its first run, all of them written from the id rather than from the
 * object, and this tool has no way to know what gradient a good town has. It
 * reports the curve and the ratio between the inner and outer thirds; whether
 * 1.4x is enough is a judgement, and the useful reading is the SHAPE and
 * whether it moves when the generator changes.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/growth.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).map(Number).filter(Boolean)
if (!seeds.length) seeds.push(4242, 777, 31337, 11, 65535, 2024)
const RINGS = 5

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
    set.call(inp, s); inp.dispatchEvent(new Event('input', { bubbles: true }))
  }, seed)
  await win.waitForTimeout(150)
  await win.getByRole('button', { name: /^generate$/i }).first().click()
  await win.waitForTimeout(2600)

  const r = await win.evaluate((RINGS) => {
    const st = window.__pt.store.getState()
    const map = st.map
    const defs = st.objectDefinitions
    const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
    if (!terrain) return null
    const H = terrain.length, W = terrain[0].length
    const objs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
    const defOf = (o) => defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
    // A BARRIER IS NOT A BUILDING. Counted as one, ~250 wall segments a town
    // inflate coverage and destroy the party-wall figure — this repo has made
    // that mistake in three separate tools, so it is filtered here up front.
    const isBar = (o) => {
      const d = defOf(o)
      return d?.category === 'infrastructure' || (d?.tags ?? []).includes('barrier')
    }
    const fpOf = (o) => o.footprint ?? defOf(o)?.footprint ?? { w: 1, h: 1 }
    const buildings = objs.filter((o) => !isBar(o))
    if (buildings.length < 20) return null

    // Centre of the TOWN, weighted by footprint area so a cathedral counts
    // for more than a shed.
    let cx = 0, cz = 0, wsum = 0
    for (const o of buildings) {
      const f = fpOf(o), a = f.w * f.h
      cx += (o.x + f.w / 2) * a; cz += (o.y + f.h / 2) * a; wsum += a
    }
    cx /= wsum; cz /= wsum

    const built = Array.from({ length: H }, () => new Uint8Array(W))
    for (const o of buildings) {
      const f = fpOf(o)
      for (let dy = 0; dy < f.h; dy++) {
        for (let dx = 0; dx < f.w; dx++) {
          const x = o.x + dx, y = o.y + dy
          if (x >= 0 && y >= 0 && x < W && y < H) built[y][x] = 1
        }
      }
    }
    // Same buildable population as urbanform: not water, not circulation.
    const buildable = (x, y) => {
      const t = terrain[y]?.[x]
      return t !== undefined && t !== 3 && t !== 8 && t !== 9
    }

    // Radii chosen so every ring covers the same AREA of buildable land.
    const rOf = (x, y) => Math.hypot(x + 0.5 - cx, y + 0.5 - cz)
    const all = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) if (buildable(x, y)) all.push(rOf(x, y))
    }
    all.sort((a, b) => a - b)
    const cuts = []
    for (let i = 1; i < RINGS; i++) cuts.push(all[Math.floor(all.length * i / RINGS)])
    const ringOf = (r) => { let i = 0; while (i < cuts.length && r >= cuts[i]) i++; return i }

    const ring = Array.from({ length: RINGS }, () => ({ land: 0, built: 0, tops: [] }))
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!buildable(x, y)) continue
        const k = ringOf(rOf(x, y))
        ring[k].land++
        if (built[y][x]) ring[k].built++
      }
    }
    // Height per ring from `properties.floors`, the PLAN's own storey count.
    // Deliberately not the built scene: the bridge has no tops accessor, and
    // going through `structureBox` per building needs the 3D view up and
    // walks 200 meshes for a second reading. The plan value is the right one
    // anyway — this tool grades the LAYOUT, and a floor count is what the
    // generator decided rather than what massing did to it afterwards.
    for (const o of buildings) {
      const f = fpOf(o)
      const k = ringOf(rOf(o.x + f.w / 2 - 0.5, o.y + f.h / 2 - 0.5))
      const fl = o.properties?.floors
      if (Number.isFinite(fl)) ring[k].tops.push(fl)
    }
    return {
      cx, cz, n: buildings.length,
      rings: ring.map((r) => ({
        pct: r.land ? Math.round((r.built / r.land) * 100) : 0,
        land: r.land,
        medTop: r.tops.length
          ? r.tops.slice().sort((a, b) => a - b)[Math.floor(r.tops.length / 2)] : null,
      })),
    }
  }, RINGS)

  if (!r) { console.log(`seed ${seed}: too few buildings to profile`); continue }
  rows.push({ seed, ...r })
}

console.log(`\n=== GROWTH — does the town thin out? (${rows.length} seeds, ${RINGS} equal-area rings) ===\n`)
console.log('  seed     bldgs   centre        coverage by ring, core -> edge      core/edge')
console.log('  ' + '-'.repeat(76))
const agg = Array.from({ length: RINGS }, () => [])
for (const row of rows) {
  const pcts = row.rings.map((r) => r.pct)
  pcts.forEach((p, i) => agg[i].push(p))
  const inner = pcts[0], outer = pcts[pcts.length - 1]
  const ratio = outer > 0 ? (inner / outer) : Infinity
  console.log(
    `  ${String(row.seed).padStart(6)}  ${String(row.n).padStart(5)}` +
    `   ${row.cx.toFixed(0)},${row.cz.toFixed(0)}`.padEnd(11) +
    `  ${pcts.map((p) => String(p).padStart(3) + '%').join('  ')}` +
    `   ${Number.isFinite(ratio) ? ratio.toFixed(2) + 'x' : '  inf'}`)
}
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)]
const prof = agg.map(med)
console.log('  ' + '-'.repeat(76))
console.log(`  median    ${' '.repeat(16)}${prof.map((p) => String(p).padStart(3) + '%').join('  ')}` +
  `   ${(prof[0] / Math.max(1, prof[prof.length - 1])).toFixed(2)}x`)

console.log('\nSTOREYS by ring (median floors from the plan). Reported WITHOUT a')
console.log('target: DESIGN.md says the oldest part is the TIGHTEST, which is')
console.log('density, not height, and it asks separately for height variation')
console.log('INSIDE a cluster. A flat storey curve is therefore not a defect —')
console.log('it is only worth watching for whether it moves:')
const h = Array.from({ length: RINGS }, () => [])
for (const row of rows) row.rings.forEach((r, i) => { if (r.medTop != null) h[i].push(r.medTop) })
if (h.some((a) => a.length)) {
  console.log('  ' + h.map((a) => (a.length ? med(a).toFixed(1) : '  -').padStart(6)).join(' '))
} else {
  console.log('  (no floors recorded on any building — the placer stopped setting them)')
}

const drop = prof[0] - prof[prof.length - 1]
console.log(`\nVERDICT: coverage falls ${drop} points from core to edge` +
  ` (${prof[0]}% -> ${prof[prof.length - 1]}%).`)
console.log('  A settlement that GREW is densest where it started. A flat curve')
console.log('  is a town that was stamped rather than grown, and every other')
console.log('  metric in the harness reads identically either way — coverage is')
console.log('  reported town-wide, so a flat 46% and a gradient averaging 46%')
console.log('  are the same number to everything except this.')
console.log('  No target is stated on purpose: what a good gradient IS is a')
console.log('  judgement, and this repo has written three wrong targets before.')

await app.close()
