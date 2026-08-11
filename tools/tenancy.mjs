/**
 * TENANCY — does anything in this town belong to anything else?
 *
 * emptiness.mjs answers "is this spot bare". That is the wrong question, and
 * satisfying it is what produced a town described as "pseudo-random building
 * assets dropped around": a global distance metric will happily put a barrel
 * in the middle of a field, because the field was bare and now it is not.
 *
 * The question that reads as sensical is "why is this here". A barrel is at
 * the tavern's side door. A cart is in the yard behind the warehouse. A
 * flower box is under a house's front window. Each of those has an OWNER and
 * a ROLE, and the difference between a town that feels inhabited and one that
 * feels decorated is whether that relationship exists in the data or only in
 * the player's charity.
 *
 * So, for every prop:
 *
 *   OWNED     — it sits on some building's perimeter. Somebody put it there.
 *   EXPLAINED — its owner is a building type that would actually have it:
 *               barrels at a tavern, crates at a warehouse, a statue at a
 *               chapel. This is the number that separates "attached to a
 *               building" from "belongs to that building".
 *   ORPHANED  — it is not touching any building at all.
 *
 * Also reports which building types are getting dressed, because a feature
 * gated behind a rare building type produces almost nothing and nobody
 * notices absent content — the shop-sign lesson, applied to props.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/tenancy.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337)

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

  const r = await win.evaluate(() => {
    const st = window.__pt.store.getState()
    const map = st.map
    const defs = st.objectDefinitions
    const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
    const props = map.layers.find((l) => l.type === 'prop')?.objects ?? []
    const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
    if (!terrain) return null
    const H = terrain.length, W = terrain[0].length
    const fpOf = (o) => {
      const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
      return o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
    }

    // owner[y][x] = index of the building whose PERIMETER covers this tile.
    const owner = Array.from({ length: H }, () => new Int16Array(W).fill(-1))
    const inside = Array.from({ length: H }, () => new Int16Array(W).fill(-1))
    structs.forEach((o, idx) => {
      const f = fpOf(o)
      for (let dy = -1; dy <= f.h; dy++) {
        for (let dx = -1; dx <= f.w; dx++) {
          const px = o.x + dx, py = o.y + dy
          if (px < 0 || py < 0 || px >= W || py >= H) continue
          const isInside = dx >= 0 && dy >= 0 && dx < f.w && dy < f.h
          if (isInside) inside[py][px] = idx
          else if (owner[py][px] < 0) owner[py][px] = idx
        }
      }
    })

    // What each building type would plausibly own. Mirrors the intent of
    // getBuildingSpecificProps, plus the generic dressing any dwelling has.
    const DOMESTIC = ['flower_box', 'potted_plant', 'planter_box', 'bench',
      'woodpile', 'rain_barrel', 'cloth_line', 'crate', 'barrel', 'fence',
      'wall_lantern', 'bush', 'flower_bed', 'rubble_pile', 'garden_arch',
      'trellis_arch', 'iron_fence', 'sign', 'well']
    // A lamppost belongs to the STREET and a tree to the ground; neither wants
    // a building owner, so they are not counted as failures of tenancy.
    const UNOWNED_BY_NATURE = new Set(['lamppost', 'street_lamp_double', 'tree',
      'bush', 'well', 'fountain', 'road_marker', 'signpost', 'monument',
      'gravestone', 'cemetery_cross', 'dock', 'crane', 'fishing_boat',
      'bunting_pole', 'prayer_flags', 'stone_wall', 'stone_wall_v'])
    const EXPLAINS = {
      tavern: ['barrel', 'barrel_stack', 'hanging_sign', 'cafe_table', 'bench', 'crate'],
      inn: ['hanging_sign', 'barrel', 'horse_post', 'cafe_table', 'bench', 'trough'],
      shop: ['hanging_sign', 'crate', 'barrel', 'awning', 'crate_stack'],
      bakery: ['hanging_sign', 'barrel', 'woodpile', 'crate'],
      apothecary: ['hanging_sign', 'potted_plant', 'planter_box', 'crate'],
      market_stall: ['crate_stack', 'barrel', 'crate', 'awning'],
      covered_market: ['crate', 'barrel', 'crate_stack'],
      warehouse: ['crate_stack', 'barrel_stack', 'cart', 'crate', 'barrel'],
      guild_hall: ['hanging_sign', 'bench', 'statue', 'planter_box'],
      mansion: ['potted_plant', 'planter_box', 'flower_box', 'bench', 'statue'],
      building_large: ['potted_plant', 'planter_box', 'flower_box'],
      balcony_house: ['flower_box', 'planter_box', 'potted_plant'],
      half_timber: ['flower_box', 'potted_plant', 'woodpile', 'firewood'],
      chapel: ['statue', 'wall_lantern', 'bench', 'column'],
      temple: ['column', 'statue', 'wall_lantern', 'bench'],
      tower: ['wall_lantern'],
      watchtower: ['wall_lantern', 'barrel'],
      bell_tower: ['wall_lantern'],
      clock_tower: ['bench', 'statue'],
      stable: ['horse_post', 'trough', 'haystack', 'cart', 'woodpile'],
      // A dwelling. Whatever a household keeps by its own front or back door.
      // What a HOUSEHOLD plausibly keeps by its own door — written from what a
      // dwelling would actually have, using ids the game really defines. The
      // first draft of this list invented washing_line, firewood, broom and
      // bucket, none of which exist, so no domestic prop could ever score as
      // explained and the metric under-reported itself.
      row_house: DOMESTIC,
      building_small: DOMESTIC,
      cottage: DOMESTIC,
      townhouse: DOMESTIC,
      corner_building: DOMESTIC,
    }

    let ownedN = 0, explainedN = 0, orphanN = 0, insideN = 0, civicN = 0
    const orphanKinds = {}, ownedKinds = {}
    for (const p of props) {
      const x = Math.round(p.x), y = Math.round(p.y)
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      if (inside[y][x] >= 0) { insideN++; continue }
      const oi = owner[y][x]
      if (UNOWNED_BY_NATURE.has(p.definitionId)) { civicN++; continue }
      if (oi < 0) {
        orphanN++
        orphanKinds[p.definitionId] = (orphanKinds[p.definitionId] ?? 0) + 1
        continue
      }
      ownedN++
      const ownerId = structs[oi].definitionId
      ownedKinds[ownerId] = (ownedKinds[ownerId] ?? 0) + 1
      const list = EXPLAINS[ownerId]
      if (list && list.includes(p.definitionId)) explainedN++
    }

    // WHICH PROPS ACTUALLY LAND IN WHICH DISTRICT.
    //
    // The dead type-lists above are only a defect if nothing else supplies
    // the vocabulary. DISTRICT_PROPS does carry a harbour's rope coils and a
    // market's crates, so the question that decides whether the town reads
    // as varied is not which lists exist but whether the props on the ground
    // actually differ from quarter to quarter. Same wallpaper test as the
    // building features: a palette that produces the same top three
    // everywhere is cost without information.
    const propsByDistrict = {}
    for (const p of props) {
      const x = Math.round(p.x), y = Math.round(p.y)
      const oi = owner[y]?.[x] ?? -1
      const inn2 = inside[y]?.[x] ?? -1
      const idx2 = oi >= 0 ? oi : inn2
      if (idx2 < 0) continue
      const d = structs[idx2]?.properties?.district
      if (!d) continue
      ;(propsByDistrict[d] ??= {})
      propsByDistrict[d][p.definitionId] = (propsByDistrict[d][p.definitionId] ?? 0) + 1
    }

    // How many buildings of each type exist, so a feature gated on a rare
    // type is visible as such rather than as an absence nobody notices.
    const typeCounts = {}
    for (const o of structs) typeCounts[o.definitionId] = (typeCounts[o.definitionId] ?? 0) + 1

    return {
      props: props.length, structs: structs.length,
      ownedN, explainedN, orphanN, insideN, civicN,
      orphanKinds, ownedKinds, typeCounts, propsByDistrict,
    }
  })
  if (!r) { console.log(`seed ${seed}: no terrain`); continue }
  rows.push({ seed, ...r })
  await win.waitForTimeout(150)
}
await app.close()

const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 100))
const merge = (key) => {
  const out = {}
  for (const r of rows) for (const [k, v] of Object.entries(r[key])) out[k] = (out[k] ?? 0) + v
  return out
}

console.log('\n=== DOES ANYTHING BELONG TO ANYTHING? ===')
console.log('seed     props   owned  explained   orphaned')
console.log('-'.repeat(50))
let P = 0, O = 0, E = 0, R = 0, C = 0
for (const r of rows) {
  P += r.props; O += r.ownedN; E += r.explainedN; R += r.orphanN; C += r.civicN
  console.log(`${String(r.seed).padStart(7)}${String(r.props).padStart(8)}` +
    `${String(pct(r.ownedN, r.props) + '%').padStart(8)}` +
    `${String(pct(r.explainedN, r.props) + '%').padStart(11)}` +
    `${String(pct(r.orphanN, r.props) + '%').padStart(11)}`)
}
console.log('-'.repeat(50))
console.log(`OWNED     ${pct(O, P)}%  — sits on some building's perimeter`)
console.log(`EXPLAINED ${pct(E, P)}%  — and that building would plausibly have it`)
console.log(`ORPHANED  ${pct(R, P)}%  — touching nothing; there is no reason it is here`)
console.log(`(civic and natural props — lampposts, trees, wells, monuments — are`)
console.log(` excluded: they belong to the street or the ground, not a building.`)
console.log(` ${C} of ${P} props, ${pct(C, P)}%. Percentages above are of ALL props.)`)

const ok = merge('orphanKinds')
const top = Object.entries(ok).sort((a, b) => b[1] - a[1]).slice(0, 12)
if (top.length) {
  console.log('\nthe orphans — props with no building anywhere near them:')
  for (const [id, n] of top) console.log(`  ${id.padEnd(22)} ${n}`)
}

const tc = merge('typeCounts')
const owners = merge('ownedKinds')
// THE VOCABULARY CENSUS, applied to props.
//
// getBuildingSpecificProps carries a hand-written prop list for about twenty
// building types — tavern, warehouse, guild_hall, covered_market, apothecary.
// A list attached to a type that the placer almost never builds is a GHOST:
// content that exists in the source, reads as a rich vocabulary, and never
// reaches a screen. That is the same failure the shop signs had and the same
// one tools/features.mjs found five more of in the building factory.
//
// So print the types the VOCABULARY knows about alongside how many of them
// the town actually contains, and say plainly which lists are dead.
{
  const VOCAB = ['tavern', 'inn', 'shop', 'bakery', 'apothecary', 'market_stall',
    'covered_market', 'warehouse', 'guild_hall', 'mansion', 'building_large',
    'balcony_house', 'half_timber', 'chapel', 'temple', 'tower', 'watchtower',
    'bell_tower', 'clock_tower', 'stable']
  const dead = [], alive = []
  for (const id of VOCAB) {
    const n = tc[id] ?? 0
    ;(n < seeds.length ? dead : alive).push(`${id} ${n}`)
  }
  console.log('\nPROP VOCABULARY CENSUS — lists that exist vs types that do:')
  console.log(`  reaching the town: ${alive.join(', ') || 'none'}`)
  console.log(`  DEAD (under one per seed): ${dead.join(', ') || 'none'}`)
  console.log('  A hand-written prop list on a type the placer never builds is')
  console.log('  content you believe you have. Same failure as the shop signs.')
}

{
  const byD = {}
  for (const r of rows) {
    for (const [d, m] of Object.entries(r.propsByDistrict ?? {})) {
      byD[d] ??= {}
      for (const [k, v] of Object.entries(m)) byD[d][k] = (byD[d][k] ?? 0) + v
    }
  }
  console.log('\nPROPS BY DISTRICT — do the quarters actually look different?')
  const tops = []
  for (const [d, m] of Object.entries(byD).sort((a, b) =>
      Object.values(b[1]).reduce((x, y) => x + y, 0) -
      Object.values(a[1]).reduce((x, y) => x + y, 0))) {
    const t = Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5)
    tops.push(t.map(([k]) => k).join('|'))
    console.log(`  ${d.padEnd(13)} ${t.map(([k, n]) => `${k} ${n}`).join(', ')}`)
  }
  const distinct = new Set(tops).size
  console.log(`  ${distinct} distinct top-5 signatures across ${tops.length} districts` +
    ` — ${distinct <= 2 ? 'WALLPAPER: the palettes are not differentiating' : 'the quarters differ'}`)
}

console.log('\nwho actually gets dressed (building count -> props hosted):')
for (const [id, n] of Object.entries(tc).sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  const hosted = owners[id] ?? 0
  console.log(`  ${id.padEnd(20)} ${String(n).padStart(4)} buildings ` +
    `-> ${String(hosted).padStart(4)} props   (${(hosted / n).toFixed(2)} each)`)
}
