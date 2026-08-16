/**
 * ODD — rank everything in the town by how UNLIKE its peers it is, then go and
 * photograph the worst offenders.
 *
 * WHY THIS AND NOT ANOTHER AUDIT.
 *
 * There are twenty-five tools in here and every one of them answers a question
 * somebody already knew to ask. That is the whole problem. A person looks at a
 * screenshot and instantly sees the thing that does not fit; they are not
 * running twenty-five checks, they are noticing an OUTLIER. Nothing here did
 * that, so every defect had to be reported from a phone first, and the ones
 * nobody happened to photograph stayed in for months.
 *
 * So: no targets, no thresholds anybody wrote down, no opinion about what a
 * door should measure. Take every structure and every prop, describe each one
 * as a vector of numbers the BUILT SCENE can answer for, and score it against
 * its own population. A row house three times taller than the other row houses
 * is suspicious whatever the absolute number is.
 *
 * Robust statistics, not mean and sigma. One 61m tower inflates a standard
 * deviation enough to hide itself; median absolute deviation does not move.
 *
 * Compare against the SAME definitionId first and fall back to the global
 * population when a type is too rare to have peers — a cathedral being unlike
 * a row house is not news, a cathedral being unlike the other cathedrals is.
 *
 * TWO THINGS IT CANNOT DO, both worth saying out loud:
 *
 *  - **It cannot see a defect the whole population shares.** Every bridge in
 *    town being a roofed pavilion reads as perfectly consistent. That is what
 *    tools/provenance.mjs is for — the world against the CODE. The two tools
 *    are complements: provenance catches uniform wrongness, this catches
 *    individual wrongness, and between them there is not much left.
 *  - **An outlier is not a defect.** A cathedral is supposed to be unlike
 *    everything. This ranks SUSPICION and then hands you the picture, which is
 *    the part that was missing: framing was failing, and a failed frame
 *    silently downgrades you to a wide shot and a guess (tools/lib/vantage.mjs).
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/odd.mjs [seed] [--shots=8] [--time=12]
 *
 * --shots=N   photograph the worst N (0 for numbers only, and much faster)
 * --props     rank props instead of structures
 * --all       print the whole ranked table, not just the head
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { lookAt, cropTo, markSubject, subjectPixels, hideChrome, FRAME } from './lib/vantage.mjs'
import { waitForScene } from './lib/scene.mjs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 31337)
const shots = Number(argv.find((a) => a.startsWith('--shots='))?.split('=')[1] ?? 8)
const timeOfDay = Number(argv.find((a) => a.startsWith('--time='))?.split('=')[1] ?? 12)
const doProps = argv.includes('--props')
const showAll = argv.includes('--all')
// Interrogate ONE feature. The ranking is dominated by whatever fires
// hardest, and "show me every floating prop" is a different question from
// "show me the worst thing in town".
const onlyFeature = argv.find((a) => a.startsWith('--feature='))?.split('=')[1] ?? null
mkdirSync('.shots/odd', { recursive: true })

/* ------------------------------------------------------------------ */
/* Robust scoring                                                     */
/* ------------------------------------------------------------------ */

const median = (xs) => {
  if (!xs.length) return 0
  const s = xs.slice().sort((a, b) => a - b)
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
/**
 * Median absolute deviation, scaled to be comparable with a standard
 * deviation. Robust: a single monstrous value cannot inflate the spread and
 * so cannot hide itself, which is exactly what happened when I first tried
 * this with mean and sigma and the 61m tower scored 1.9.
 */
const mad = (xs, med) => 1.4826 * median(xs.map((x) => Math.abs(x - med)))

/** How many robust deviations `x` is from the population's middle. */
function zOf(x, pop) {
  if (pop.length < 4) return 0
  const med = median(pop)
  const spread = mad(pop, med)
  // A population with zero spread is either a constant (nothing to say) or a
  // clamp everyone is pinned to (provenance.mjs's job, not this one). Fall
  // back to a relative measure so a genuine outlier in a near-constant
  // population still registers instead of dividing by zero.
  if (spread < 1e-6) {
    if (Math.abs(x - med) < 1e-6) return 0
    return Math.min(12, Math.abs(x - med) / Math.max(Math.abs(med), 0.05))
  }
  return (x - med) / spread
}

/* ------------------------------------------------------------------ */
/* Launch                                                             */
/* ------------------------------------------------------------------ */

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
// POLL, do not guess. A fixed timeout measures a partially-built town on a
// slow run and reports it with complete confidence — see lib/scene.mjs for the
// numbers that proved it.
const built = await waitForScene(win)
console.log(`scene settled: ${built.succeeded} built, ${built.failed} failed, of ${built.wanted}`)
await win.evaluate((t) => window.__pt.store.getState().updateEnvironment({ timeOfDay: t }), timeOfDay)
await win.waitForTimeout(900)
await hideChrome(win)

const scene = await win.evaluate(() => window.__pt.sceneFeatures())
if (!scene) { console.log('no scene features — the 3D renderer never built'); await app.close(); process.exit(1) }

/* ------------------------------------------------------------------ */
/* Feature vectors                                                    */
/* ------------------------------------------------------------------ */

// Each entry: [name, extractor, twoSided]. twoSided=false means only the HIGH
// side is suspicious — a building with more texture than its peers is not a
// defect, one with less is.
const STRUCT_FEATURES = [
  ['height', (s) => s.height, true],
  ['footprint', (s) => s.spanW * s.spanD, true],
  // Slenderness. The number that separates a tower from a chimney, and the one
  // MAX_TOWER_ASPECT exists to bound — so anything up here is either a
  // landmark or a gate that did not fire.
  ['slenderness', (s) => s.height / Math.max(0.3, Math.min(s.spanW, s.spanD)), true],
  ['volumes', (s) => s.volumes, true],
  // THE BLANK-SHAFT DETECTOR. A 60m untextured wall is legal in every
  // dimension, passes every geometry audit, and reads to a person as an
  // unfinished grey slab from a hundred metres away. Nothing measured it.
  ['bareWallArea', (s) => s.wallArea - s.texturedArea, true],
  ['bareShare', (s) => (s.wallArea > 0 ? 1 - s.texturedArea / s.wallArea : 0), true],
  // A building whose walls rise a long way with no roof on them.
  ['roofless', (s) => (s.roofStyles.length ? 0 : s.height), true],
]

const PROP_FEATURES = [
  ['width', (p) => Math.max(p.w, p.d), true],
  ['height', (p) => p.h, true],
  // A pancake or a needle: real objects are not 20:1 in one axis.
  ['flatness', (p) => Math.max(p.w, p.d) / Math.max(0.02, p.h), true],
  // FLOATING OR BURIED. The complaint "props hovering or oddly placed" has
  // been on the list for a year and nothing ever put a number on it: this is
  // the emitted geometry's lowest point against the ground sampled underneath.
  ['floating', (p) => p.gap, true],
  ['buried', (p) => -p.gap, true],
]

function rank(items, features, keyOf) {
  // Population per definition id, plus the global one as a fallback.
  const byKey = new Map()
  for (const it of items) {
    const k = keyOf(it)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(it)
  }
  const out = []
  for (const it of items) {
    const peers = byKey.get(keyOf(it))
    // A type with fewer than 5 instances has no peer group worth the name;
    // fall back to the whole town and say so, because "unlike every building"
    // and "unlike other lighthouses" are different claims.
    const usePeers = peers.length >= 5
    const pop = usePeers ? peers : items
    let best = null
    for (const [name, get, twoSided] of features) {
      if (!usePeers && !INTRINSIC.has(name)) continue
      const vals = pop.map(get).filter(Number.isFinite)
      const v = get(it)
      const z = zOf(v, vals)
      const score = twoSided ? z : Math.abs(z)
      if (score <= 0) continue
      const med = median(vals)
      // A HIGH z IS NOT THE SAME AS A BIG DIFFERENCE, and the first version of
      // this conflated them. `lean_to` heights are so tightly clustered that
      // MAD is nearly zero, so 6.4m against a median of 3.8m scored z=85 —
      // while a 50m tower against a 29m median, the same 1.7x, scored 8.8 and
      // was buried underneath eleven lean-tos. Ranking by z alone is ranking by
      // which population has the smallest spread.
      //
      // So require the difference to be REAL as well as unusual. Below this it
      // is a statistical curiosity about a uniform population, which is
      // provenance.mjs's department (a clamp everyone is pinned to), not a
      // thing worth photographing.
      const ratio = med === 0 ? (Math.abs(v) > 1e-6 ? Infinity : 1)
        : Math.max(Math.abs(v), Math.abs(med)) / Math.max(Math.min(Math.abs(v), Math.abs(med)), 1e-6)
      // 1.25 was still far too loose: the board came back topped by a x1.2
      // staircase footprint and a x1.4 lean-to, both z>18 and both completely
      // unremarkable to look at. If a person would not notice the difference,
      // a photograph of it is a wasted minute.
      if (ratio < 1.6 && Math.abs(v - med) < 1.0) continue
      if (!best || score > best.score) {
        best = {
          name, score, value: v, med, ratio,
          against: usePeers ? keyOf(it) : 'the whole town', usePeers,
        }
      }
    }
    if (best) out.push({ it, ...best })
  }
  return out.sort((a, b) => b.score - a.score)
}

/**
 * Features that mean something even with no peer group.
 *
 * The first run of the prop mode ranked two PIERS at the top for being 11m
 * wide against a town median of 0.66 — a pier is supposed to be 11m wide, and
 * with fewer than five of them in a town there is nothing to compare against
 * but every barrel and flower box in the place. Fences and docks did the same.
 * That is the sample-count lesson: a metric that suddenly has an opinion about
 * a population of two has not got an opinion worth having.
 *
 * SIZE is only meaningful against peers. Whether a thing FLOATS, is BURIED, or
 * is twenty times wider than it is tall is a fact about the object alone, so
 * those still count for a type with no peers. Everything else waits for five.
 */
const INTRINSIC = new Set(['floating', 'buried', 'flatness', 'bareShare', 'roofless'])

/* ------------------------------------------------------------------ */
/* Report                                                             */
/* ------------------------------------------------------------------ */

const fmt = (x) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2))

let ranked, label
if (doProps) {
  ranked = rank(scene.props, PROP_FEATURES, (p) => p.id)
  label = 'PROPS'
  console.log(`=== ODD — ${scene.props.length} props, seed ${seed} ===`)
} else {
  ranked = rank(scene.structures, STRUCT_FEATURES, (s) => s.def)
  label = 'STRUCTURES'
  console.log(`=== ODD — ${scene.structures.length} structures, seed ${seed} ===`)
}
console.log('Ranked by how unlike its own peers each thing is. No targets, no')
console.log('thresholds — just robust deviations from the population median.')
console.log('An outlier is SUSPICION, not a verdict: a cathedral should be odd.\n')

// KEEP THE UNFILTERED RANKING. The control samples ordinary items from it, and
// filtering first silently emptied that sample — so a --feature run lost its
// baseline and every verdict fell back to "in line with an ordinary building",
// which is the confident-wrong failure this whole design exists to avoid. A
// missing control must read as MISSING, never as a pass.
const rankedAll = ranked
if (onlyFeature) {
  ranked = ranked.filter((r) => r.name === onlyFeature)
  console.log(`(filtered to --feature=${onlyFeature}: ${ranked.length} of them)\n`)
}
const head = showAll ? ranked : ranked.slice(0, Math.max(shots, 14))
console.log(`${label} — worst first:`)
console.log('   z   ratio  what             value   peer median   against')
for (const r of head) {
  const name = doProps ? r.it.id : r.it.def
  const caveat = r.usePeers ? '' : '  [no peer group]'
  const rx = Number.isFinite(r.ratio) ? `x${r.ratio.toFixed(1)}` : 'new'
  console.log(`  ${r.score.toFixed(1).padStart(5)}  ${rx.padStart(5)}  ${r.name.padEnd(14)} ` +
    `${fmt(r.value).padStart(8)}  ${fmt(r.med).padStart(11)}   ${name} vs ${r.against}${caveat}`)
}

// WHICH FEATURE IS FIRING, across the whole town. One building at z=9 is an
// instance; forty buildings whose worst feature is `bareShare` is a systemic
// hole, and only the tally tells them apart.
const byFeature = new Map()
for (const r of ranked) {
  if (r.score < 3) continue
  const e = byFeature.get(r.name) ?? { n: 0, worst: 0 }
  e.n++; e.worst = Math.max(e.worst, r.score)
  byFeature.set(r.name, e)
}
console.log(`\nWHAT IS ODD, over z=3 (${[...byFeature.values()].reduce((s, e) => s + e.n, 0)} of ${ranked.length}):`)
if (!byFeature.size) console.log('  nothing — the population is uniform on every feature measured.')
for (const [name, e] of [...byFeature.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const many = e.n >= 8 ? '   <-- a class, not an instance' : ''
  console.log(`  ${name.padEnd(14)} ${String(e.n).padStart(4)} over z=3, worst ${e.worst.toFixed(1)}${many}`)
}

/* ------------------------------------------------------------------ */
/* And go and LOOK at them                                            */
/* ------------------------------------------------------------------ */

/**
 * Frame one structure and measure its pixels. Distances scale with the
 * subject: a fixed list refused a 45m cathedral outright ("unoccluded
 * candidates were too close"), which is the thirty-pixels failure wearing its
 * opposite face.
 */
async function inspect(st, cheap = false) {
  const dia = Math.hypot(st.box.max[0] - st.box.min[0], st.box.max[1] - st.box.min[1],
    st.box.max[2] - st.box.min[2])
  const v = await lookAt(win, st.box, {
    // height-first: exhaust every distance at eye level before going up. The
    // subject is usually a WALL, and a shot from 28m looking down cannot show
    // you one — the first cut of this tool took exactly that shot to grade
    // whether a facade was textured.
    dists: [0.7, 1.0, 1.5, 2.2, 3.2].map((k) => Math.max(2, k * dia)),
    heights: doProps ? [0.5, 1.6, 3, 6] : [1, 4, 10, 20, 32],
    dirs: cheap ? 8 : 16, maxFill: 0.7, minFill: doProps ? 0.05 : 0.1, order: 'height',
    // Broadside, not merely unoccluded. A 16cm-deep shop sign photographed
    // edge-on is a black stick, and that picture cannot answer the question it
    // was taken to answer.
    pick: cheap ? 'first' : 'largest',
  })
  if (!v.ok) return { v }
  // Every candidate lookAt rejects costs a raycast against the whole scene,
  // and the mask costs grid^2 more. Under SwiftShader that is seconds per
  // subject, so the control pass — which only needs a median — runs coarse.
  return { v, px: await subjectPixels(win, v.screen, st.box, cheap ? 28 : 48) }
}

// === THE CONTROL ===
//
// Grading an outlier's pixels against thresholds I invented is the propscale
// mistake again — a hand-written target, wrong three times out of three. So
// measure the ORDINARY buildings first and grade against them. This is also
// the noise floor: if a typical facade reads 0.05 edges, then 0.05 on an
// outlier means nothing, and I would rather find that out here than in a
// confident paragraph.
let base = null
if (shots > 0) {
  const typical = rankedAll.filter((r) => Math.abs(r.score) < 1.2 && r.it.box)
  const step = Math.max(1, Math.floor(typical.length / 6))
  const sample = []
  for (let i = 0; i < typical.length && sample.length < 6; i += step) sample.push(typical[i])
  const es = [], cs = [], ls = []
  for (const r of sample) {
    const { px } = await inspect(r.it, true)
    if (!px || px.sparse) continue
    es.push(px.edges); cs.push(px.contrast); ls.push(px.luma)
  }
  if (es.length >= 4) {
    base = { edges: median(es), contrast: median(cs), luma: median(ls), n: es.length }
    console.log(`\nCONTROL — ${base.n} ordinary structures (|z| < 1.2), measured the same way:`)
    console.log(`  edges ${base.edges.toFixed(3)}  contrast ${base.contrast.toFixed(3)}  luma ${base.luma.toFixed(3)}`)
    console.log('  These are the numbers an unremarkable building in this town produces.')
    console.log('  An outlier is graded against them, not against anything I made up.')
  } else {
    console.log('\nCONTROL: could not frame enough ordinary structures to set a baseline.')
  }
}

/**
 * A prop has no BuildingTop and so no structureBox — but it has an emitted
 * AABB, which is the same thing and arguably better, because it is measured
 * from the geometry rather than from the massing's intent. Without this the
 * prop mode was numbers only, which is exactly the half of the problem this
 * whole exercise exists to fix.
 */
const propBox = (p) => ({
  min: [p.x - p.w / 2, p.y - p.h / 2, p.z - p.d / 2],
  max: [p.x + p.w / 2, p.y + p.h / 2, p.z + p.d / 2],
})
for (const p of scene.props) p.box = propBox(p)

if (shots > 0) {
  console.log('\nphotographing the worst — the number says something is odd, only the')
  console.log('picture says whether it is wrong:')
  let taken = 0
  for (const r of ranked) {
    if (taken >= shots) break
    const s = r.it
    if (!s.box) continue
    const { v, px: pxEarly } = await inspect(s)
    if (!v.ok) { console.log(`  ✗ ${s.def ?? s.id} z=${r.score.toFixed(1)} — ${v.why}`); continue }
    const px = pxEarly     // measured before the marker is drawn over it
    await markSubject(win, v.screen)
    const file = `.shots/odd/${seed}-${doProps ? 'prop-' : ''}${String(taken).padStart(2, '0')}-${s.def ?? s.id}-${r.name}.png`
    writeFileSync(file, await win.screenshot({ clip: cropTo(v.screen, FRAME, 0.5) }))
    console.log(`  ✓ ${file}`)
    console.log(`      z=${r.score.toFixed(1)} ${r.name} ${fmt(r.value)} vs ${fmt(r.med)} · ` +
      (doProps
        ? `${s.id} · ${s.w.toFixed(2)}x${s.d.toFixed(2)}x${s.h.toFixed(2)}m · gap ${s.gap.toFixed(2)}m`
        : `${s.def} in ${s.district} · ${s.height}m tall on ${s.spanW}x${s.spanD}m · ` +
          `${s.volumes} volumes, ${s.texturedVolumes} textured`))
    if (px?.sparse) {
      console.log(`      pixels: only ${(px.cover * 100).toFixed(0)}% of the box is the subject — too little to grade`)
    } else if (px) {
      // The picture's own opinion, over SUBJECT PIXELS ONLY (raycast mask), so
      // the verdict is neither my eyeball nor a crop full of neighbours — and
      // graded against the CONTROL, so it is not a threshold I invented.
      let verdict = 'NO CONTROL — cannot grade this, do not read it as a pass'
      if (base) {
        const eR = px.edges / Math.max(base.edges, 1e-3)
        const lR = px.luma / Math.max(base.luma, 1e-3)
        verdict = eR < 0.45 ? `BLANKER than normal — ${eR.toFixed(2)}x the usual detail`
          : lR < 0.45 ? `DARKER than normal — ${lR.toFixed(2)}x the usual brightness`
          : eR > 1.8 ? `busier than normal — ${eR.toFixed(2)}x`
          : `in line (${eR.toFixed(2)}x detail, ${lR.toFixed(2)}x brightness)`
      }
      console.log(`      pixels: ${px.samples} on target (${(px.cover * 100).toFixed(0)}% of box) · ` +
        `luma ${px.luma} contrast ${px.contrast} edges ${px.edges} colors ${px.colors}`)
      console.log(`      -> ${verdict}`)
    }
    taken++
  }
}

await app.close()
