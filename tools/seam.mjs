/**
 * SEAM — what is standing at the point where you cross into another quarter?
 *
 * CITYPLAN item 4's second half, and the last of Lynch's five elements with
 * nothing built for it. `districts.mjs` asks whether a quarter is distinctive
 * from INSIDE; this asks whether its EDGE exists at all. Imagineering calls
 * the fix the cross-dissolve — you never see two lands at once, a bend or a
 * berm hides the join. Cullen calls the same move a closure.
 *
 * The population is deliberately NOT "boundary tiles". A Voronoi edge running
 * through the middle of a block is invisible to a player and needs nothing,
 * and marking it would be scatter with a plan behind it. The thing a player
 * can experience is a CROSSING: a step along a walkable street that takes you
 * from one quarter into the next. Contiguous crossing edges are grouped, so a
 * 3-wide street through a boundary is one crossing rather than three.
 *
 * Two readings, answering different halves:
 *
 *   MARKED — is there anything AT the crossing? A gate or bridge, water, a
 *     level change, a wall, a bend that closes the view, or a pinch between
 *     two buildings. Ranked in that order, most legible first.
 *
 *   BOTH LANDS — standing on the crossing, how far can you see into each
 *     quarter at once? That is the cross-dissolve stated as a number: a long
 *     straight sightline through a boundary shows you two lands in one frame
 *     however well the ground is painted.
 *
 * A ground-colour change is reported separately and NOT counted as a mark. It
 * is real information and it is also the exact failure the item describes —
 * "an invisible line where the palette swaps" — so folding it into the pass
 * rate would let the one-material-per-place work grade this one.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/seam.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const shoot = argv.includes('--shoot')
const seeds = argv.filter((a) => /^\d+$/.test(a)).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337)
const TILE = 3.0
const TERRAIN_WORLD_SCALE = 1.8
/** A step you would notice underfoot. Two courses of stone. */
const LEVEL_M = 1.1
/** Beyond this you are looking at a whole other quarter, not a glimpse. */
const BOTH_LANDS_M = 18
const KINDS = ['gateway', 'water', 'level', 'wall', 'bend', 'pinch', 'none']

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

  const r = await win.evaluate((K) => {
    const st = window.__pt.store.getState()
    const map = st.map
    const defs = st.objectDefinitions
    const tl = map.layers.find((l) => l.type === 'terrain')
    const terrain = tl?.terrainTiles
    if (!terrain) return { err: 'no terrain layer' }
    // No silent fallback and no plausible zero. Recovering the plan from the
    // GROUND is the mistake this repo has made three times, and heightAt's
    // `?? 0` once turned "unavailable" into "perfectly flat" for a whole
    // river metric. If the plan is not there, say so and measure nothing.
    const dmap = tl.districtMap
    if (!dmap) return { err: 'terrain layer carries no districtMap — nothing to measure' }
    const dtypes = tl.districtTypes ?? {}

    const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
    const H = terrain.length, W = terrain[0].length
    const isCirc = window.__pt.isCirculation
    if (!isCirc) return { err: 'debug bridge has no isCirculation' }
    const pal = window.__pt.terrainPalette().colors
    const heights = tl.heightMap

    const defOf = (o) => defs.find?.((x) => x.id === o.definitionId) ??
      (defs[o.definitionId] ?? null)
    const solid = Array.from({ length: H }, () => new Uint8Array(W))
    const barrier = Array.from({ length: H }, () => new Uint8Array(W))
    const threshold = Array.from({ length: H }, () => new Uint8Array(W))
    for (const o of structs) {
      const d = defOf(o)
      const tags = d?.tags ?? []
      const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
      // A gate, archway or bridge IS the threshold — the built form of a
      // cross-dissolve — and it is `passage`-tagged, so it must not also
      // count as a wall blocking the view.
      const isPass = tags.includes('passage')
      const isBar = d?.category === 'infrastructure' || tags.includes('barrier')
      for (let dy = 0; dy < f.h; dy++) {
        for (let dx = 0; dx < f.w; dx++) {
          const x = o.x + dx, y = o.y + dy
          if (x < 0 || y < 0 || x >= W || y >= H) continue
          if (isPass) threshold[y][x] = 1
          else solid[y][x] = 1
          if (isBar) barrier[y][x] = 1
        }
      }
    }

    const dAt = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? dmap[y][x] : -1)
    const walk = (x, y) => isCirc(terrain[y]?.[x])
    const near = (grid, x, y, r) => {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && grid[ny][nx]) return true
        }
      }
      return false
    }
    const nearWater = (px, py, r) => {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) if (terrain[py + dy]?.[px + dx] === 3) return true
      }
      return false
    }
    const famOf = (x, y) => {
      const c = pal[terrain[y]?.[x]]
      if (c === undefined) return '?'
      return `${((c >> 16) & 255) >> 5}-${((c >> 8) & 255) >> 5}-${(c & 255) >> 5}`
    }
    const levelStep = (px, py, ux, uy) => {
      if (!heights) return false
      const a = heights[py - uy * 2]?.[px - ux * 2]
      const b = heights[py + uy * 3]?.[px + ux * 3]
      if (a === undefined || b === undefined) return false
      return Math.abs(a - b) * K.TWS >= K.LEVEL_M
    }
    // Perpendicular width of the walkable corridor, and buildings squeezing it.
    const pinch = (px, py, ux, uy) => {
      const qx = uy, qy = ux
      let n = 1
      for (let s = 1; s <= 4; s++) { if (!walk(px + qx * s, py + qy * s)) break; n++ }
      for (let s = 1; s <= 4; s++) { if (!walk(px - qx * s, py - qy * s)) break; n++ }
      return n <= 2 && (near(solid, px + qx, py + qy, 1) || near(solid, px - qx, py - qy, 1))
    }
    // Does the street stop within 5 tiles this way, with a walkable corridor
    // leading off to the side? That is a turn, not a dead end.
    const turns = (sx, sy, ux, uy) => {
      let s = 1
      while (s <= 5 && walk(sx + ux * s, sy + uy * s)) s++
      if (s > 5) return false
      const ex = sx + ux * (s - 1), ey = sy + uy * (s - 1)
      return walk(ex + uy, ey + ux) || walk(ex - uy, ey - ux)
    }
    const cast = (sx, sy, ux, uy) => {
      let n = 0
      for (let s = 1; s <= 24; s++) {
        const px = sx + ux * s, py = sy + uy * s
        if (px < 0 || py < 0 || px >= W || py >= H) break
        if (solid[py][px]) break
        n++
      }
      return n
    }

    // --- crossing edges: a step ALONG A STREET that changes quarter -------
    //
    // A pair of adjacent walkable tiles in different quarters is not yet a
    // crossing. Where a boundary runs ALONG a street, the tile across the
    // carriageway is in the other quarter and the pair qualifies — but nobody
    // walks that way, and worse, casting a sightline along that axis hits the
    // opposite facade at once and scores as a bend. The first run of this tool
    // read 95% marked with `bend` at 31%, which was almost entirely sideways
    // steps across ordinary streets being called closures.
    //
    // The exact test is that the street CONTINUES through the join: walkable
    // ground for two tiles on both sides along the same axis. Same shape as
    // the street-width bug this repo already has on the record — a scan that
    // runs both axes at every road tile measures the street's LENGTH half the
    // time and calls it width.
    const runsThrough = (x, y, dx, dy) => {
      for (let s = 1; s <= 2; s++) {
        if (!walk(x - dx * s, y - dy * s)) return false
        if (!walk(x + dx * (s + 1), y + dy * (s + 1))) return false
      }
      return true
    }
    const edges = []
    let sideways = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!walk(x, y)) continue
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const nx = x + dx, ny = y + dy
          if (nx >= W || ny >= H || !walk(nx, ny)) continue
          const a = dAt(x, y), b = dAt(nx, ny)
          if (a === b || a < 0 || b < 0) continue
          if (!runsThrough(x, y, dx, dy)) { sideways++; continue }
          edges.push({ x, y, nx, ny, dx, dy, a, b })
        }
      }
    }
    if (!edges.length) {
      return { err: `no street runs through a quarter boundary (${sideways} sideways pairs)` }
    }

    // Group contiguous edges — a 3-wide street through a boundary is ONE
    // crossing you walk through, not three separate events.
    const idx = new Map(edges.map((e, i) => [`${e.x},${e.y},${e.dx}`, i]))
    const seen = new Uint8Array(edges.length)
    const groups = []
    for (let i = 0; i < edges.length; i++) {
      if (seen[i]) continue
      const stack = [i], mem = []
      seen[i] = 1
      while (stack.length) {
        const e = edges[stack.pop()]
        mem.push(e)
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (!ox && !oy) continue
            const k = idx.get(`${e.x + ox},${e.y + oy},${e.dx}`)
            if (k !== undefined && !seen[k]) { seen[k] = 1; stack.push(k) }
          }
        }
      }
      groups.push(mem)
    }

    // --- classify each crossing -------------------------------------------
    const tally = Object.fromEntries(K.KINDS.map((k) => [k, 0]))
    const kindOf = new Map()
    const sights = []
    let paletteChange = 0
    const pairs = {}
    const examples = []

    for (const g of groups) {
      const e = g[Math.floor(g.length / 2)]   // representative: middle of the run
      const { x, y, nx, ny, dx, dy } = e
      const pk = [dtypes[e.a] ?? e.a, dtypes[e.b] ?? e.b].sort().join('|')
      pairs[pk] = (pairs[pk] ?? 0) + 1

      const fwd = cast(nx, ny, dx, dy)
      const back = cast(x, y, -dx, -dy)
      const both = Math.min(fwd, back) * K.TILE
      sights.push(both)
      if (famOf(x, y) !== famOf(nx, ny)) paletteChange++

      let kind = 'none'
      if (near(threshold, x, y, 2) || near(threshold, nx, ny, 2)) kind = 'gateway'
      else if (nearWater(x, y, 2) || nearWater(nx, ny, 2)) kind = 'water'
      else if (levelStep(x, y, dx, dy)) kind = 'level'
      else if (near(barrier, x, y, 2) || near(barrier, nx, ny, 2)) kind = 'wall'
      // A bend is Cullen's closure: the street TURNS at the join, so there is
      // no through view to have. Not "the sightline is short" — that is also
      // what a sideways step across a lane looks like, and it is what made
      // the first version of this read 31% bend. The corridor has to actually
      // stop while a perpendicular one carries on.
      // ...AND the view has to actually be closed. `turns` reads the walkable
      // CORRIDOR and `cast` reads BUILDINGS, and the two disagree wherever a
      // road ends at open paving: the corridor stops, so turns() fires, while
      // you can still see twenty tiles. Only the second of those is something
      // a person experiences, so both have to hold.
      else if ((turns(nx, ny, dx, dy) && fwd <= 5) ||
               (turns(x, y, -dx, -dy) && back <= 5)) kind = 'bend'
      // A pinch is a gateway nobody built: two buildings squeezing the street
      // to a gap. It reads as a threshold even though nothing was placed.
      else if (pinch(x, y, dx, dy) && pinch(nx, ny, dx, dy)) kind = 'pinch'
      tally[kind]++
      kindOf.set(e, kind)
      if (kind === 'none' && examples.length < 4) {
        examples.push({ x, y, at: pk, sees: Math.round(both) })
      }
    }

    const sorted = [...sights].sort((a, b) => a - b)
    return {
      crossings: groups.length,
      edges: edges.length,
      tally,
      paletteChange,
      medSight: sorted[Math.floor(sorted.length / 2)] ?? 0,
      bothLands: sights.filter((v) => v >= K.BOTH).length,
      pairs: Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 5),
      examples, sideways,
      // Every crossing with somewhere to stand and a direction to look, so
      // --shoot can photograph the verdict. `bend` carries half the pass rate
      // and "the street turns within five tiles" is a claim about what a
      // person SEES; a number cannot settle that and a picture can.
      shots: groups.map((g) => {
        const e = g[Math.floor(g.length / 2)]
        return { x: e.x + 0.5, y: e.y + 0.5, dx: e.dx, dy: e.dy,
                 kind: kindOf.get(e), pair: [dtypes[e.a] ?? e.a, dtypes[e.b] ?? e.b].join(' -> ') }
      }),
      nDistricts: new Set(Object.values(dtypes)).size,
    }
  }, { TILE, TWS: TERRAIN_WORLD_SCALE, LEVEL_M, BOTH: BOTH_LANDS_M, KINDS })

  if (r?.err) { console.log(`seed ${seed}: ${r.err}`); rows.push({ seed, err: r.err }); continue }
  rows.push({ seed, ...r })

  if (shoot && r.shots?.length) {
    mkdirSync('.shots/seam', { recursive: true })
    await win.getByRole('button', { name: '3D', exact: true }).click()
    await win.waitForTimeout(2600)
    await win.evaluate(() => { const h = document.querySelector('.walk-hint'); if (h) h.style.display = 'none' })
    for (let i = 0; i < r.shots.length; i++) {
      const v = r.shots[i]
      await win.evaluate(async (a) => {
        const pt = window.__pt, three = pt.renderer()
        const g = pt.heightAt(a.x, a.y) ?? 0
        pt.flyTo(a.x, g + 1.6, a.y, Math.atan2(a.dy, a.dx), -0.03)
        for (let k = 0; k < 8; k++) await new Promise((rr) => requestAnimationFrame(rr))
        await new Promise((rr) => setTimeout(rr, 350))
        three.renderer.render(three.scene, three.camera)
      }, v)
      const buf = await win.screenshot({ clip: { x: 232, y: 40, width: 935, height: 806 } })
      writeFileSync(`.shots/seam/${seed}-${i}-${v.kind}.png`, buf)
      console.log(`    photo .shots/seam/${seed}-${i}-${v.kind}.png  ${v.pair}`)
    }
    await win.getByRole('button', { name: '2D', exact: true }).click()
    await win.waitForTimeout(900)
  }
}
await app.close()

const ok = rows.filter((r) => !r.err)
if (!ok.length) {
  console.log('\nNOTHING MEASURED. Every seed failed — see the reason above.')
  process.exit(1)
}
const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 100))

console.log('\n=== THE SEAM — is there anything where you cross into a quarter? ===')
for (const r of ok) {
  console.log(`\nseed ${r.seed} — ${r.crossings} crossings (${r.edges} walkable edges) ` +
    `between ${r.nDistricts} quarters`)
  console.log(`  marked ${pct(r.crossings - r.tally.none, r.crossings)}%   ` +
    KINDS.map((k) => `${k} ${r.tally[k]}`).join('  '))
  console.log(`  ground colour changes at ${pct(r.paletteChange, r.crossings)}% ` +
    `(reported, NOT counted as a mark; both tiles of a crossing are ` +
    `carriageway, which is painted the same in every quarter, so this is ` +
    `structurally near zero and says nothing about the QUARTERS' floors)`)
  console.log(`  ${r.sideways} boundary pairs run ALONGSIDE a street instead ` +
    `(not a failure — a road IS a legitimate Lynch edge — but not a threshold)`)
  console.log(`  see into both quarters: median ${Math.round(r.medSight)}m, ` +
    `${pct(r.bothLands, r.crossings)}% over ${BOTH_LANDS_M}m`)
  console.log(`  commonest joins: ${r.pairs.map(([p, n]) => `${p} x${n}`).join(', ')}`)
  for (const e of r.examples) {
    console.log(`    unmarked: (${e.x},${e.y}) ${e.at}, sees ${e.sees}m both ways`)
  }
}

const tot = ok.reduce((a, r) => a + r.crossings, 0)
const marked = ok.reduce((a, r) => a + (r.crossings - r.tally.none), 0)
const both = ok.reduce((a, r) => a + r.bothLands, 0)
const agg = Object.fromEntries(KINDS.map((k) => [k, ok.reduce((a, r) => a + r.tally[k], 0)]))
console.log(`\nMARKED       ${pct(marked, tot)}% of quarter crossings have something at them`)
console.log(`BOTH LANDS   ${pct(both, tot)}% show you ${BOTH_LANDS_M}m+ of each quarter at once`)
console.log('  ' + KINDS.map((k) => `${k} ${pct(agg[k], tot)}%`).join('  '))
const side = ok.reduce((a, r) => a + r.sideways, 0)
console.log(`\nSAMPLE       ${tot} crossings over ${ok.length} seeds, ` +
  `against ${side} boundary pairs that run alongside a street.`)
console.log('  READ THE SAMPLE SIZE BEFORE THE PERCENTAGES. Three to five')
console.log('  crossings a town is not a shortage of measurement, it is the')
console.log('  geometry: a boundary running ALONG a street yields one pair per')
console.log('  tile of overlap, one CROSSING it yields one pair in total. Run')
console.log('  eight seeds or more before believing any of the rates above.')
console.log('\n  A crossing with nothing at it is a Voronoi edge, which is literally')
console.log('  what it is. Only the crossings matter — the rest of the boundary')
console.log('  runs inside blocks where no one can stand, and marking that would')
console.log('  be scatter with a plan behind it.')
