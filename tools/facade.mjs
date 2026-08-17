/**
 * FACADE — does the 3D detail on a wall collide with the wall's PAINTED
 * openings?
 *
 * THE CLASS NOTHING COULD SEE.
 *
 * Reported plainly: "every time I generate a world I see things like lumber
 * beams crossing over window and door textures." Correct, and no instrument
 * here could have found it. `clash.mjs` compares SOLIDS. `odd.mjs` compares a
 * building to its peers. `provenance.mjs` compares geometry to the code that
 * asked for it. Not one of them knows where the windows are, because the
 * windows are not geometry at all — they are drawn on a canvas that gets
 * stretched over the wall.
 *
 * So the wall has two independent authors and nobody introduced them:
 *
 *   FacadeTexture   paints openings on a ~2.4m column pitch (facadeOpenings)
 *   BuildingFactory nails studs on a 1.7m bay pitch (BAY), full height
 *
 * Two grids that do not divide each other, so they beat, and a full-height
 * stud crosses a window on most walls. FacadeTexture's own comment already
 * says the 3D window TRIM must quantise identically to the texture or the
 * lintels land on the wrong columns — and VolumeRenderer does exactly that,
 * calling facadeOpenings itself. The timber frame is the sibling that never
 * got the same treatment. A bug in a gate is a bug in a PATTERN.
 *
 * BuildingFactory now records every painted opening and every attached member
 * in the same WALL-LOCAL frame — x from the wall's centre, y from its base —
 * so the overlap test is exact 2D arithmetic with no camera and no judgement.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/facade.mjs [seed] [--shots=N]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { lookAt, cropTo, markSubject, hideChrome, FRAME } from './lib/vantage.mjs'
import { waitForScene } from './lib/scene.mjs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 31337)
const shots = Number(argv.find((a) => a.startsWith('--shots='))?.split('=')[1] ?? 0)
const showAll = argv.includes('--all')
mkdirSync('.shots/facade', { recursive: true })

// WHAT COUNTS AS CROSSING.
//
// The first cut asked "what FRACTION of the opening's width does the member
// eat" with a 12% floor, and it reported ZERO stud collisions — because an 8cm
// stud across a 90cm window is 9% of its width and fell straight through the
// gate. That is the precise defect that was reported to me, excluded by a
// threshold I chose. The question is not how much it covers; it is whether it
// crosses the GLASS rather than butting the reveal.
//
// So: the member must reach into the opening's central region on both axes. A
// lintel sitting on the head, a sill under the cill and a stud grazing a jamb
// all touch the boundary and none of them crosses.
const EDGE = 0.10   // outer tenth of an opening is its reveal, not its glass
let awnBad = 0      // awnings whose measured slope is not an awning's

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
const built = await waitForScene(win)
await win.evaluate(() => window.__pt.store.getState().updateEnvironment({ timeOfDay: 12 }))
await win.waitForTimeout(700)
await hideChrome(win)

const scene = await win.evaluate(() => window.__pt.sceneFeatures())
const parts = scene?.facade ?? []
if (!parts.length) {
  console.log('no facade parts recorded — no timber-framed building in this seed, or rebuild')
  await app.close(); process.exit(0)
}

const OPENING = new Set(['window', 'door'])
const FRAME_KIND = 'wall'   // the volume's own extent, not a member
// AN OPENING TOO SMALL TO READ AS ONE IS NOT A DEFECT WHEN SOMETHING CROSSES
// IT. `uW = WIN_W_M / quantizeWallM(width)` times the volume's REAL width, so
// on a sliver of a volume the painted "window" comes out a few centimetres
// across — and a 13cm corner post then covers 92% of a 14cm window, which is
// arithmetically true and invisible. Grade only openings a person could see.
const MIN_OPENING_W = 0.45
// GROUP BY WALL, NOT BY BUILDING.
//
// The wall-local frame — x from the wall's centre, y above its base — belongs
// to a VOLUME. Keyed by `p.id` alone this loop cross-multiplied a tower's
// members against the main body's windows, on different planes metres apart,
// and reported a full-width head plate as "covering 100%" of a window it
// cannot reach. The tell was that BuildingFactory's own `_clearsOpenings`
// guard is STRICTER than this test (a bare AABB overlap, no reveal tolerance)
// and yet passed members this called dirty. When the harsher of two checks
// says clean and the looser says dirty, they are not looking at the same
// thing. Same defect as the phantom door, one level down: there the wrong
// buildings, here the wrong walls inside one building.
const byWall = new Map()
const byBuilding = new Set()
for (const p of parts) {
  const k = `${p.id}::${p.vol ?? '?'}`
  if (!byWall.has(k)) byWall.set(k, [])
  byWall.get(k).push(p)
  byBuilding.add(p.id)
}
if (parts.some((p) => p.vol === undefined)) {
  console.log('WARNING: parts carry no wall key — stale bundle, rebuild first.\n')
}

console.log(`=== FACADE — seed ${seed}, ${byBuilding.size} buildings / ${byWall.size} walls, ${parts.length} parts ===`)
console.log('3D detail nailed to a wall, against the openings PAINTED on it.')
console.log('Two authors, one wall, and until now nothing compared them.\n')

// A KIND WITH NO COLLISIONS AND A KIND THAT WAS NEVER RECORDED READ THE SAME.
// The colonnade was instrumented and predicted to beat against the windows on
// a third grid; the report came back with no `column` line at all, and there
// was no way to tell a clean result from an uninstrumented one. That is the
// GHOST failure sitting inside the instrument built to find ghosts, and it is
// the same shape as `featureCounts` having no consumer. Census first, verdict
// second: every kind the recorder emits gets a line whether it offends or not.
const census = new Map()
for (const p of parts) census.set(p.kind, (census.get(p.kind) ?? 0) + 1)
console.log('RECORDED — what the wall actually declared (a kind absent here was')
console.log('never instrumented; a kind here with no collisions below is clean):')
for (const [k, n] of [...census.entries()].sort((a, b) => b[1] - a[1])) {
  const tag = OPENING.has(k) ? 'opening' : (k === FRAME_KIND ? 'wall   ' : 'member ')
  console.log(`  ${String(n).padStart(5)}  ${tag}  ${k}`)
}
console.log('')

/* --- HOW BIG ARE THE WALLS WE ARE PAINTING ON? ----------------------- */
//
// The splinter finding arrived as a footnote — "wall=wing@...,1.20" in a hit
// line — and the wall it named was a 1.20m x 10.49m volume, an aspect near
// 9:1. Now that every wall declares its own extent, print the tail instead of
// waiting for a collision to mention one. A wall too narrow to hold a window
// is the interesting case whether or not anything crosses it, and after the
// clip started sliding instead of shaving there should be very few.
{
  const walls = parts.filter((p) => p.kind === FRAME_KIND)
    .map((p) => ({ w: p.x1 - p.x0, h: p.y1 - p.y0, def: p.def }))
    .sort((a, b) => a.w - b.w)
  if (walls.length) {
    const at = (q) => walls[Math.min(walls.length - 1, Math.floor(q * walls.length))].w
    const splinters = walls.filter((x) => x.w < 1.6)
    console.log(`WALL WIDTHS — p10 ${at(0.1).toFixed(2)}m  med ${at(0.5).toFixed(2)}m  ` +
      `p90 ${at(0.9).toFixed(2)}m  min ${walls[0].w.toFixed(2)}m`)
    console.log(`  under 1.6m (too narrow for a window and its piers): ${splinters.length}` +
      `${splinters.length ? '  ' + [...new Set(splinters.map((s) => s.def))].slice(0, 5).join(', ') : ''}`)
    const worst = walls.slice().sort((a, b) => (b.h / b.w) - (a.h / a.w))[0]
    console.log(`  worst aspect ${(worst.h / worst.w).toFixed(1)}:1  ` +
      `(${worst.w.toFixed(2)}m wide x ${worst.h.toFixed(2)}m tall, ${worst.def})\n`)
  }
}

/* --- IS WHAT WE PAINTED ACTUALLY ON THE WALL? ------------------------ */
//
// The question with no threshold in it, and the one this tool should have
// asked first. Both defects found in this pass are containment failures, not
// collisions, so the collision count — the only thing the tool could report —
// was structurally incapable of naming either:
//
//   * uW is WIN_W_M / wallWm, a fraction with no ceiling, and both are 1.0 at
//     the bottom of the range. Every volume 1.25m or narrower took a window
//     painted corner to corner, at every storey.
//   * floorsThatFit is `max(1, ...)`, so a wall shorter than a storey still
//     got one, and the lowest window's head sits at a fixed 2.30m — 0.80m
//     above the roofline of a 1.5m outshot.
//
// Each surfaced only sideways, as "a corner post covers 11% of a window",
// which is the small half of the finding. Ask the exact question instead.
const escapes = []
for (const [wall, list] of byWall) {
  const frame = list.find((p) => p.kind === FRAME_KIND)
  if (!frame) continue
  for (const p of list) {
    if (!OPENING.has(p.kind)) continue
    const over = Math.max(
      frame.x0 - p.x0, p.x1 - frame.x1, frame.y0 - p.y0, p.y1 - frame.y1)
    if (over > 0.01) {
      escapes.push({ def: p.def, kind: p.kind, over, wall,
        wallW: frame.x1 - frame.x0, wallH: frame.y1 - frame.y0 })
    }
  }
}
if (escapes.length) {
  const byDef = new Map()
  for (const e of escapes) {
    const k = `${e.kind} off a ${(e.wallW).toFixed(1)}x${(e.wallH).toFixed(1)}m wall`
    const g = byDef.get(k) ?? { n: 0, worst: 0, defs: new Set() }
    g.n++; g.worst = Math.max(g.worst, e.over); g.defs.add(e.def)
    byDef.set(k, g)
  }
  console.log(`OFF THE WALL — ${escapes.length} painted openings fall outside the`)
  console.log('wall they are painted on. Not a collision; nothing else can see these:')
  for (const [k, g] of [...byDef.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12)) {
    console.log(`  ${String(g.n).padStart(4)} x  ${k.padEnd(42)} by up to ${g.worst.toFixed(2)}m` +
      `  (${[...g.defs].slice(0, 3).join(', ')})`)
  }
  console.log('')
} else {
  console.log('OFF THE WALL — 0. Every painted opening lies inside its own wall.\n')
}

const hits = []
let openings = 0, members = 0, skipped = 0
for (const [wall, list] of byWall) {
  const opens = list.filter((p) => OPENING.has(p.kind) && p.x1 - p.x0 >= MIN_OPENING_W)
  const tiny = list.filter((p) => OPENING.has(p.kind) && p.x1 - p.x0 < MIN_OPENING_W).length
  skipped += tiny
  const mems = list.filter((p) => !OPENING.has(p.kind) && p.kind !== FRAME_KIND)
  openings += opens.length; members += mems.length
  for (const o of opens) {
    const ow = o.x1 - o.x0
    for (const m of mems) {
      const oh = o.y1 - o.y0
      const ox = Math.min(o.x1, m.x1) - Math.max(o.x0, m.x0)
      const oy = Math.min(o.y1, m.y1) - Math.max(o.y0, m.y0)
      if (ox <= 0 || oy <= 0) continue
      // Does it reach the GLASS — the opening minus its reveal — on both axes?
      const gx0 = o.x0 + ow * EDGE, gx1 = o.x1 - ow * EDGE
      const gy0 = o.y0 + oh * EDGE, gy1 = o.y1 - oh * EDGE
      if (Math.min(gx1, m.x1) <= Math.max(gx0, m.x0)) continue
      if (Math.min(gy1, m.y1) <= Math.max(gy0, m.y0)) continue
      const eaten = ox / Math.max(ow, 1e-3)
      hits.push({ id: list[0].id, wall, def: o.def, kind: m.kind, on: o.kind, eaten, ox, oy, m, o })
    }
  }
}

const byKind = new Map()
for (const h of hits) {
  const k = `${h.kind} across ${h.on}`
  const e = byKind.get(k) ?? { n: 0, worst: 0, buildings: new Set() }
  e.n++; e.worst = Math.max(e.worst, h.eaten); e.buildings.add(h.id)
  byKind.set(k, e)
}

console.log(`${openings} painted openings, ${members} attached members` +
  `${skipped ? ` (${skipped} openings under ${MIN_OPENING_W}m wide excluded — too small to read as one)` : ''}.`)
console.log(`${hits.length} members crossing the GLASS of an opening (not merely its reveal):\n`)
if (!hits.length) console.log('  none — every member clears every opening.')
for (const [k, e] of [...byKind.entries()].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(e.n).padStart(4)} x  ${k.padEnd(26)} worst covers ${(e.worst * 100).toFixed(0)}%` +
    `  on ${e.buildings.size} buildings`)
}

// `--all` was a declared-and-never-read flag: a ghost in the tool's own CLI.
// A count tells you a class exists; only the numbers tell you whether the
// member is a hair over the reveal or straight through the glass, and those
// want opposite fixes.
if (showAll && hits.length) {
  console.log('\nEVERY HIT, in wall-local metres (x from the wall centre, y above its base):')
  for (const h of hits.slice().sort((a, b) => b.eaten - a.eaten)) {
    console.log(`  ${h.def.padEnd(16)} ${h.kind} over ${h.on}` +
      `  member x[${h.m.x0.toFixed(2)},${h.m.x1.toFixed(2)}] y[${h.m.y0.toFixed(2)},${h.m.y1.toFixed(2)}]` +
      `  opening x[${h.o.x0.toFixed(2)},${h.o.x1.toFixed(2)}] y[${h.o.y0.toFixed(2)},${h.o.y1.toFixed(2)}]` +
      `  overlap ${(h.ox * 100).toFixed(0)}cm x ${(h.oy * 100).toFixed(0)}cm` +
      `  wall=${h.wall.split('::')[1]}`)
  }
}

const affected = new Set(hits.map((h) => h.id))
console.log(`\n${affected.size} of ${byBuilding.size} buildings have at least one.`)

/* --- The awning, which is a separate report of the same kind --------- */
//
// "the shop awnings never look right; like the angles for the main piece is
// wrong." Read the code and the sign is inverted: the strips are translated
// +Z then rotateX(-0.12), and for a point at +Z that rotation gives
// y' = -z*sin(theta) = +6.6cm. The front edge RISES. The comment above it says
// "~7 deg down at front edge". Worse, the POST height then subtracts a drop
// that never happened, so the posts fall short of the canvas they hold up.
// Measured here from the built geometry rather than argued from the source.
// AND THIS BLOCK USED TO CHECK NOTHING. It printed "slope and post reach are
// checked in the geometry itself; see the note in this file", which points at
// a comment. A gate whose verdict cannot fire is worse than no gate, because
// the line reads as a clean result — this repo already shipped one (a FAIL
// branch guarded by a ratio bounded above by 1) and wrote the lesson down.
//
// The strips now carry a MEASURED side profile taken off their built vertices
// after rotation, so an inverted sign shows up as a negative drop rather than
// having to be argued from the source. Recomputing the drop from the angle
// that produced it would be a proxy agreeing with itself.
const AWN_MIN_DEG = 3, AWN_MAX_DEG = 20
const awnings = parts.filter((p) => p.kind === 'awning')
const withProfile = awnings.filter((p) => p.drop !== undefined && p.proj > 0.01)
if (!awnings.length) {
  console.log('\nAWNINGS — none in this seed.')
} else if (!withProfile.length) {
  // A MISSING MEASUREMENT MUST NOT READ AS A PASS. `--feature=` in odd.mjs
  // silently killed the control and every verdict fell back to "in line with
  // an ordinary building"; this is the same trap one tool over. Count them all
  // as bad so the verdict cannot come out clean on no evidence.
  console.log(`\nAWNINGS — ${awnings.length} recorded but NO measured profile.`)
  console.log('  Stale bundle, or the recorder stopped passing one. NOT a pass.')
  awnBad = awnings.length
} else {
  const degs = withProfile.map((p) => Math.atan2(p.drop, p.proj) * 180 / Math.PI).sort((a, b) => a - b)
  const at = (q) => degs[Math.min(degs.length - 1, Math.floor(q * degs.length))]
  const up = degs.filter((d) => d < 0).length
  const flat = degs.filter((d) => d >= 0 && d < AWN_MIN_DEG).length
  const steep = degs.filter((d) => d > AWN_MAX_DEG).length
  console.log(`\nAWNINGS — ${withProfile.length} measured, slope of the canvas away from the wall`)
  console.log(`  p10 ${at(0.1).toFixed(1)}°  med ${at(0.5).toFixed(1)}°  p90 ${at(0.9).toFixed(1)}°` +
    `   (projection ${withProfile[0].proj.toFixed(2)}m)`)
  console.log(`  tilting UP (the inverted-sign defect): ${up}`)
  console.log(`  under ${AWN_MIN_DEG}° — reads as a flat shelf, not an awning: ${flat}`)
  console.log(`  over ${AWN_MAX_DEG}° — reads as a lean-to roof: ${steep}`)
  if (up + flat + steep === 0) console.log('  all within a canvas awning\'s range.')
  awnBad = up + flat + steep
}

/* --- Go and look ----------------------------------------------------- */

if (shots > 0 && hits.length) {
  console.log('\nphotographing the worst:')
  const worst = hits.slice().sort((a, b) => b.eaten - a.eaten)
  const seen = new Set()
  let n = 0
  for (const h of worst) {
    if (n >= shots) break
    if (seen.has(h.id)) continue
    seen.add(h.id)
    const box = await win.evaluate((id) => window.__pt.structureBox(id), h.id)
    if (!box) continue
    const v = await lookAt(win, box, {
      dists: [10, 15, 22, 30], heights: [1, 4, 9, 18], dirs: 20,
      maxFill: 0.75, order: 'height', pick: 'largest',
    })
    if (!v.ok) { console.log(`  ✗ ${h.def} — ${v.why}`); continue }
    await markSubject(win, v.screen)
    const file = `.shots/facade/${seed}-${String(n).padStart(2, '0')}-${h.def}-${h.kind}-over-${h.on}.png`
    writeFileSync(file, await win.screenshot({ clip: cropTo(v.screen, FRAME, 0.4) }))
    console.log(`  ✓ ${file}\n      ${h.kind} covers ${(h.eaten * 100).toFixed(0)}% of a ${h.on} on ${h.def}`)
    n++
  }
}

console.log(`\nVERDICT: ${hits.length} member-over-opening collisions on ${affected.size} buildings,` +
  ` ${escapes.length} openings painted off their own wall, ${awnBad} awnings mis-sloped.`)
await app.close()
process.exit(hits.length + escapes.length + awnBad ? 1 : 0)
