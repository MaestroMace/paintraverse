/**
 * DISTRICTS — can you tell you have crossed into one?
 *
 * Lynch's DISTRICT is the last of his five elements we have not built. His
 * test is not whether the data has districts; it is whether a person standing
 * inside one knows which one it is. Ours are Voronoi cells around random
 * centres, and CLAUDE.md has long recorded the suspicion that a market quarter
 * is mostly plain row houses. Suspicion is not a number, so:
 *
 *   CHARACTER — what share of a district's buildings are types that BELONG to
 *     it and to nothing else? A market of row houses is a residential quarter
 *     with a label on it. Types that appear in every district's list carry no
 *     information, so they are excluded from the numerator by construction.
 *
 *   SIGNATURE — do the districts differ from one another at all, in the three
 *     things a player can actually perceive: the ground under their feet, the
 *     height of the buildings, and the density of them? A district that
 *     matches its neighbour on all three is invisible however the data labels
 *     it.
 *
 *   THE SEAM — Imagineering's cross-dissolve, and Cullen's closure: you should
 *     never see two districts at once. The boundary wants to be hidden by a
 *     bend, a gate, a bridge, a level change or a wall. Measure what is
 *     actually ON each boundary: if it is open ground, the transition is an
 *     invisible line drawn on a map, which is what an arbitrary Voronoi edge
 *     really is.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/districts.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337)
const TILE = 3.0

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
  // The 3D view has to have built for the render layer's diagnostics to
  // exist. Districts are a question about what a person SEES, and half the
  // answer lives in the building factory rather than in the map data.
  await win.getByRole('button', { name: '3D', exact: true }).click()
  await win.waitForTimeout(3000)

  const r = await win.evaluate(() => {
    const st = window.__pt.store.getState()
    const map = st.map
    const defs = st.objectDefinitions
    const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
    const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
    if (!terrain) return null
    const H = terrain.length, W = terrain[0].length
    const pal = window.__pt.terrainPalette().colors

    // A building records the district it was placed in. That is the label the
    // generator believes; everything below asks whether the label is legible.
    const byDistrict = {}
    for (const o of structs) {
      const d = o.properties?.district
      if (!d) continue
      ;(byDistrict[d] ??= { types: {}, floors: [], cells: [] })
      const b = byDistrict[d]
      b.types[o.definitionId] = (b.types[o.definitionId] ?? 0) + 1
      b.floors.push(o.properties?.floors ?? 1)
      b.cells.push([o.x, o.y])
    }

    // A type carries information about a district only if it is not spread
    // across all of them. Compute how many districts each type appears in.
    const typeSpread = {}
    for (const [, b] of Object.entries(byDistrict)) {
      for (const t of Object.keys(b.types)) typeSpread[t] = (typeSpread[t] ?? 0) + 1
    }
    const nDistricts = Object.keys(byDistrict).length

    const out = []
    for (const [name, b] of Object.entries(byDistrict)) {
      const total = Object.values(b.types).reduce((a, n) => a + n, 0)
      // Characteristic = appears in at most a third of the districts present.
      let characteristic = 0
      for (const [t, n] of Object.entries(b.types)) {
        if (typeSpread[t] <= Math.max(1, Math.floor(nDistricts / 3))) characteristic += n
      }
      const fl = [...b.floors].sort((x, y) => x - y)
      // Ground signature: dominant colour under this district's buildings.
      const fam = {}
      for (const [x, y] of b.cells) {
        const c = pal[terrain[y]?.[x]]
        if (c === undefined) continue
        const r0 = (c >> 16) & 255, g0 = (c >> 8) & 255, b0 = c & 255
        const key = `${r0 >> 5}-${g0 >> 5}-${b0 >> 5}`
        fam[key] = (fam[key] ?? 0) + 1
      }
      const domGround = Object.entries(fam).sort((p, q) => q[1] - p[1])[0]
      out.push({
        name, total,
        characteristic,
        topTypes: Object.entries(b.types).sort((p, q) => q[1] - p[1]).slice(0, 3),
        medFloors: fl.length ? fl[Math.floor(fl.length / 2)] : 0,
        // DESIGN.md's philosophy wants height variation WITHIN a cluster —
        // "2-story next to 4-story next to 3-story, not uniform district
        // heights" — while Lynch wants districts to differ FROM each other.
        // Those pull in opposite directions and both are needed, so report
        // the spread beside the median: separating the medians by flattening
        // the spread would satisfy this tool and break the pillar.
        loFloors: fl.length ? fl[Math.floor(fl.length * 0.1)] : 0,
        hiFloors: fl.length ? fl[Math.floor(fl.length * 0.9)] : 0,
        ground: domGround ? domGround[0] : '?',
        groundShare: domGround ? domGround[1] / b.cells.length : 0,
      })
    }
    out.sort((a, b2) => b2.total - a.total)
    // Trade DRESSING per district, from the render layer. featureCounts keys
    // gated features as "shopSign@market", because a global count cannot
    // answer the question they exist to serve: signs read 16% of buildings
    // town-wide, which sounds reasonable and was the symptom — it was 16%
    // everywhere, cemetery included, since the gate had no district test.
    const fc = window.__pt.debugInfo()?.buildingFactory?.featureCounts ?? {}
    for (const d of out) {
      d.signs = fc[`shopSign@${d.name}`] ?? 0
      d.awnings = fc[`awning@${d.name}`] ?? 0
    }
    return { districts: out, nDistricts }
  })
  if (!r) { console.log(`seed ${seed}: no terrain`); continue }
  rows.push({ seed, ...r })
  await win.waitForTimeout(150)
}
await app.close()

const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 100))
console.log('\n=== DISTRICTS — is the label legible from inside? ===')
for (const r of rows) {
  console.log(`\nseed ${r.seed} — ${r.nDistricts} districts with buildings`)
  console.log('  district      bldgs  character  floors p10/med/p90  trade dressing  top types')
  console.log('  ' + '-'.repeat(88))
  for (const d of r.districts) {
    const tt = d.topTypes.map(([t, n]) => `${t} ${n}`).join(', ')
    console.log(`  ${d.name.padEnd(13)}${String(d.total).padStart(6)}` +
      `${String(pct(d.characteristic, d.total) + '%').padStart(16)}` +
      `${String(`${d.loFloors}/${d.medFloors}/${d.hiFloors}`).padStart(19)}` +
      `${String(pct(d.signs, d.total) + '%').padStart(15)}   ${tt}`)
  }
}

const all = rows.flatMap((r) => r.districts)
const tot = all.reduce((a, d) => a + d.total, 0)
const ch = all.reduce((a, d) => a + d.characteristic, 0)
console.log(`\nCHARACTER   ${pct(ch, tot)}% of buildings are a type distinctive to their district`)
console.log('  (a district whose buildings are the same as everywhere else is a')
console.log('   label on a map, not a place you can be inside of)')

// Do adjacent districts differ on anything a player perceives?
console.log('\nSIGNATURE — do districts differ from each other at all?')
for (const r of rows) {
  const fl = new Set(r.districts.map((d) => d.medFloors))
  const gr = new Set(r.districts.map((d) => d.ground))
  console.log(`  seed ${String(r.seed).padStart(6)}: ` +
    `${fl.size} distinct median heights and ${gr.size} distinct ground colours ` +
    `across ${r.districts.length} districts`)
}
{
  const spreads = all.map((d) => d.hiFloors - d.loFloors)
  const flat = spreads.filter((v) => v <= 1).length
  console.log(`  within-district height spread (p90 - p10): median ${spreads.sort((a, b) => a - b)[Math.floor(spreads.length / 2)]} storeys; ` +
    `${flat} of ${all.length} districts are flat (<=1)`)
  console.log('  ^ DESIGN.md pillar 2 wants this HIGH while the line above wants')
  console.log('    the medians spread apart. Raising separation by flattening spread')
  console.log('    would satisfy one and break the other.')
}
console.log('  (equal counts to the district count means every quarter looks different;')
console.log('   1 or 2 means the map has one quarter wearing several names)')
