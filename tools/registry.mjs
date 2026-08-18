/**
 * REGISTRY — is a building type actually WIRED IN, or only half of one?
 *
 * Adding a building type means registering the same id in six places that key
 * off it independently, and missing one is silent. There is no error, no
 * warning: the renderer falls back to a default footprint, the pixel-art
 * export falls back to a 1.8-tile height, the plan view tints it wrong. That
 * is the GHOST failure mode from CLAUDE.md arriving through a different door,
 * and it will arrive every single time someone adds a type by hand.
 *
 * Worse, THREE of those tables are footprints, in three different files, and
 * nothing has ever checked that they agree. A footprint disagreement is the
 * bug the repo already has a scar from: BuildingFactory rendered bell_tower_tall
 * at 3x3 while the generator reserved 2x2, so it clipped into its neighbours.
 * That was found by eye. This finds it by parsing.
 *
 * WHAT IT CHECKS
 *   - every building definition appears in each table that needs it
 *   - the three footprint tables agree with each other
 *   - every definition is reachable: some district can actually place it
 *     (clock_tower and windmill are defined and in no district table, which
 *     means the town has two building types it can never build)
 *
 * Static parse, no Electron, no xvfb, runs in a second:
 *
 *   node tools/registry.mjs
 */
import { readFileSync } from 'node:fs'

const read = (p) => readFileSync(p, 'utf8')
const STORE = read('src/renderer/app/store.ts')
const GEN = read('src/renderer/generation/TownGenerator.ts')
const FACTORY = read('src/renderer/renderer3d/BuildingFactory.ts')
const CANVAS = read('src/renderer/renderer3d/Canvas2DRenderer.ts')

/** Slice a source file from a marker to its closing brace at column 0-ish. */
function block(src, startMarker, endMarker) {
  const i = src.indexOf(startMarker)
  if (i < 0) return ''
  const j = src.indexOf(endMarker, i + startMarker.length)
  return src.slice(i, j < 0 ? src.length : j)
}

/** ids => {w,h} from a `name: { w: N, h: N }` style table. */
function footprintTable(text) {
  const out = {}
  for (const m of text.matchAll(/(\w+):\s*\{\s*w:\s*(\d+),\s*h:\s*(\d+)\s*\}/g)) {
    out[m[1]] = { w: +m[2], h: +m[3] }
  }
  return out
}
/** ids from a `key: value` style record.
 *  Matches EVERY key, not just the first on each line — these tables pack
 *  several entries per line (`building_small: 2.2, building_medium: 3.0,`)
 *  and a line-anchored regex reported 25 of 34 types as unregistered, all of
 *  them false. Check the instrument before believing its findings. */
function keysOf(text) {
  return new Set([...text.matchAll(/(?:^|[\s{,])([a-z_]+)\s*:/gm)].map((m) => m[1]))
}

// --- the authoritative definitions ----------------------------------------
const defs = new Map()
// The name accepts EITHER quote style. It used to require single quotes, and
// "Sexton's Hut" therefore fell straight through the parser — the tool
// reported every type clean while silently not checking one of them. A parser
// that skips an entry is worse than no parser, because it answers confidently.
// The count line below exists for the same reason: if it disagrees with the
// number of definitions you think you wrote, the regex is wrong, not the code.
for (const m of STORE.matchAll(
  /\{\s*id:\s*'([a-z_]+)',\s*name:\s*(?:'[^']*'|"[^"]*"),\s*category:\s*'(\w+)',\s*tags:\s*\[([^\]]*)\],[\s\S]{0,200}?footprint:\s*\{\s*w:\s*(\d+),\s*h:\s*(\d+)\s*\}/g)) {
  // Infrastructure counts too. BUILDING_HEIGHTS and BUILDING_ROOF_STYLE are
  // consulted for every structure-layer object, so a WALL missing from them
  // exports at the 1.8-tile fallback exactly like a house would. Checking
  // only category 'building' let the precinct wall through — a tool's scope
  // has to match the table's scope, not the table's name.
  defs.set(m[1], { w: +m[4], h: +m[5], tags: m[3], cat: m[2] })
}
// Cross-check: every `id:` in a building-looking definition should have been
// parsed. Anything here means the regex above missed a definition shape.
for (const m of STORE.matchAll(/id:\s*'([a-z_]+)',\s*name:/g)) {
  if (defs.has(m[1])) continue
  // Only this definition's OWN category counts — the FIRST one after its id.
  // Scanning a fixed window spilled into the next definition and reported
  // three props (well, iron_fence, road_marker) as missed buildings.
  const after = STORE.slice(STORE.indexOf(`id: '${m[1]}',`))
  const cat = after.match(/category:\s*'(\w+)'/)
  if (cat && cat[1] === 'building') {
    console.log(`  PARSER MISS: '${m[1]}' is a building definition but did not parse`)
  }
}

// --- the tables that must know about it ------------------------------------
const genFp = footprintTable(block(GEN, 'private getFootprint(', '\n  }'))
const facFp = footprintTable(block(FACTORY, 'const FOOTPRINTS', '\n}'))
const heights = keysOf(block(CANVAS, 'const BUILDING_HEIGHTS', '\n}'))
const roofs = keysOf(block(CANVAS, 'const BUILDING_ROOF_STYLE', '\n}'))

const districtTable = block(GEN, 'const DISTRICT_BUILDINGS', '// District-specific prop palettes')
const placeable = new Map()
for (const m of districtTable.matchAll(/(\w+):\s*\[([\s\S]*?)\n  \]/g)) {
  for (const e of m[2].matchAll(/id:\s*'([a-z_]+)',\s*w:\s*(\d+),\s*h:\s*(\d+)/g)) {
    if (!placeable.has(e[1])) placeable.set(e[1], { w: +e[2], h: +e[3], districts: [] })
    placeable.get(e[1]).districts.push(m[1])
  }
}
// Types the generator places directly rather than through a district table —
// landmarks, walls, gates, bridges. Not being in DISTRICT_BUILDINGS is correct
// for these, so they must not be reported as unreachable.
const DIRECT_PLACED = new Set(
  [...GEN.matchAll(/definitionId:\s*'([a-z_]+)'/g)].map((m) => m[1]),
)
for (const m of GEN.matchAll(/getFootprint\('([a-z_]+)'\)/g)) DIRECT_PLACED.add(m[1])
for (const m of GEN.matchAll(/'([a-z_]+)'/g)) {
  // Landmark pools list bare ids in arrays; catch those too, conservatively.
  if (defs.has(m[1])) DIRECT_PLACED.add(m[1])
}

// --- report ----------------------------------------------------------------
let problems = 0
const rows = []
for (const [id, d] of [...defs].sort()) {
  const miss = []
  if (d.cat === 'building' && !genFp[id]) miss.push('gen.getFootprint')
  if (d.cat === 'building' && !facFp[id]) miss.push('BuildingFactory.FOOTPRINTS')
  // The export's height/roof tables only matter for objects that go through
  // the BUILDING path — structure-layer things. Most `infrastructure` is a
  // PROP (lamppost, fence, crane) drawn by a different route entirely, and
  // flagging those produced seventeen findings that were all noise.
  // BuildingFactory.FOOTPRINTS is precisely the list of what that path draws,
  // so it is the right scope test rather than the category name.
  const drawnAsStructure = d.cat === 'building' || !!facFp[id]
  if (drawnAsStructure && !heights.has(id)) miss.push('BUILDING_HEIGHTS')
  if (drawnAsStructure && !roofs.has(id)) miss.push('BUILDING_ROOF_STYLE')
  const disagree = []
  for (const [label, t] of [['gen', genFp[id]], ['factory', facFp[id]],
    ['district', placeable.get(id)]]) {
    if (t && (t.w !== d.w || t.h !== d.h)) disagree.push(`${label} ${t.w}x${t.h}`)
  }
  // A LOOKUP WITH A DEFAULT HAS NO "ABSENT" STATE.
  //
  // `getFootprint` ends `return footprints[defId] || { w: 1, h: 1 }`, so every
  // id already has an answer and an id that is not in the table is not
  // unopinionated — it reserves ONE TILE. The check above compares only
  // entries that exist, which is why six props sat here undetected: a 2x2
  // market_tent and a 3x3 fountain_grand reserving a single cell and being
  // drawn over neighbours the map believed were free. Compare against the
  // value the CODE WILL ACTUALLY GET, never against the table's contents.
  if (!genFp[id] && (d.w !== 1 || d.h !== 1)) {
    disagree.push('gen FALLBACK 1x1 (absent from getFootprint)')
  }
  const reachable = d.cat === 'infrastructure' ||
    placeable.has(id) || DIRECT_PLACED.has(id)
  if (miss.length || disagree.length || !reachable) {
    problems++
    rows.push({ id, d, miss, disagree, reachable })
  }
}

console.log(`\n=== REGISTRY — ${defs.size} definitions, every category ===\n`)
if (rows.length === 0) {
  console.log('  Every building type is registered in every table, all three')
  console.log('  footprint tables agree, and every type can actually be placed.')
} else {
  for (const r of rows) {
    console.log(`  ${r.id}  (store says ${r.d.w}x${r.d.h})`)
    if (r.disagree.length) {
      console.log(`      FOOTPRINT DISAGREEMENT: ${r.disagree.join(', ')}`)
      console.log(`      A type reserved at one size and drawn at another clips`)
      console.log(`      into its neighbours. This exact bug shipped once.`)
    }
    if (r.miss.length) console.log(`      missing from: ${r.miss.join(', ')}`)
    if (!r.reachable) {
      console.log(`      UNREACHABLE: in no district table and never placed`)
      console.log(`      directly — a type the town can never build.`)
    }
  }
}
console.log(`\n${problems} of ${defs.size} definitions have a registration problem.`)
console.log('\nA missing entry is SILENT: the renderer falls back to a default')
console.log('footprint, the pixel-art export to a 1.8-tile height, the plan view')
console.log('to a generic tint. Nothing errors, and the type looks almost right.')
process.exitCode = problems > 0 ? 0 : 0   // informational; never fails a build
