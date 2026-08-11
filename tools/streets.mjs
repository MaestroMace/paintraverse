/**
 * THE STREET NETWORK ITSELF — is it streets, or is it a puddle?
 *
 * urbanform.mjs measures the space between buildings and reports one number
 * for it: facade-to-facade width. That number is a SUM of two terms with
 * different owners — the carriageway belongs to the road carver, the setback
 * to the building placer — and for a long time it was read as if the setback
 * were all of it. It is not: the carriageway is the larger half, and no amount
 * of pulling buildings forward can fix a road that is already 11 tiles wide.
 *
 * So measure the road network on its own terms:
 *
 *   TILE HISTOGRAM — what the terrain actually ended up as. The generator
 *     carves a main plaza (id 2) and district plazas (id 14) and then paints
 *     every roadMap tile as street cobble, so the squares can be silently
 *     repainted as street. A square that reads as street is not a square.
 *
 *   CORRIDOR WIDTH — for each road tile, the contiguous road extent through it
 *     in x and in y. The SMALLER is the corridor's width: a 2-wide street
 *     running 20 long scores 2, a crossroads scores 2, and only a genuine
 *     blob scores high. The carver authorises 1-3; anything above that is
 *     roads that merged, not a road anybody drew.
 *
 *   BLOBS — connected road components, by area, and how much of the network's
 *     total area sits in tiles wider than the carver ever authorised. This is
 *     "big open spaces" as a number, and it says whether the cause is one
 *     giant merged square or many mid-size puddles.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/streets.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337)
const TILE = 3.0
/** The widest corridor any tier of the carver is allowed to draw. */
const AUTHORISED = 3

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

  const r = await win.evaluate((AUTH) => {
    const map = window.__pt.store.getState().map
    const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
    if (!terrain) return null
    const H = terrain.length, W = terrain[0].length
    const isRoad = (x, y) => {
      const t = terrain[y]?.[x]
      return t === 8 || t === 9
    }

    const hist = {}
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) hist[terrain[y][x]] = (hist[terrain[y][x]] ?? 0) + 1
    }

    // Corridor width through each road tile: the smaller of its two runs.
    const widths = []
    let overWide = 0, roadTiles = 0
    const wide = Array.from({ length: H }, () => new Uint8Array(W))
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isRoad(x, y)) continue
        roadTiles++
        const run = (dx, dy) => {
          let n = 1
          for (let k = 1; k <= 40 && isRoad(x + dx * k, y + dy * k); k++) n++
          for (let k = 1; k <= 40 && isRoad(x - dx * k, y - dy * k); k++) n++
          return n
        }
        const cw = Math.min(run(1, 0), run(0, 1))
        widths.push(cw)
        if (cw > AUTH) { overWide++; wide[y][x] = 1 }
      }
    }

    // Connected road components, 4-connectivity, by area.
    const seen = Array.from({ length: H }, () => new Uint8Array(W))
    const blobs = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isRoad(x, y) || seen[y][x]) continue
        let area = 0, wideArea = 0
        const q = [[x, y]]
        seen[y][x] = 1
        for (let i = 0; i < q.length; i++) {
          const [cx, cy] = q[i]
          area++
          if (wide[cy][cx]) wideArea++
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            if (!isRoad(nx, ny) || seen[ny][nx]) continue
            seen[ny][nx] = 1
            q.push([nx, ny])
          }
        }
        blobs.push({ area, wideArea })
      }
    }
    blobs.sort((a, b) => b.area - a.area)

    // OPEN GROUND — the metric that cannot be relabelled away.
    //
    // Painting a merged road swathe as "plaza flagstone" makes the tile
    // histogram look intentional without changing what the player sees, which
    // is a big empty expanse. So ignore what the ground is CALLED and ask the
    // only question that matters: standing here, how far does the emptiness
    // run? Connected components of paved-or-walkable ground with no building
    // on it. A market square is one of these and should be; a quarter of the
    // map being one is the complaint.
    const defs = window.__pt.store.getState().objectDefinitions
    const structs = window.__pt.store.getState().map.layers
      .find((l) => l.type === 'structure')?.objects ?? []
    const occupied = Array.from({ length: H }, () => new Uint8Array(W))
    for (const o of structs) {
      const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
      const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
      for (let dy = 0; dy < f.h; dy++) {
        for (let dx = 0; dx < f.w; dx++) {
          const px = o.x + dx, py = o.y + dy
          if (px >= 0 && py >= 0 && px < W && py < H) occupied[py][px] = 1
        }
      }
    }
    // Anywhere the player can stand — not just anywhere that is paved. The
    // first version of this walked paved ground only, which quietly excluded
    // the ~35% of the map that is grass and dirt, and a bare field between two
    // buildings is precisely the thing being complained about. Water is the
    // only ground that is not standable; everything else counts.
    const paved = (x, y) => terrain[y]?.[x] !== undefined && terrain[y][x] !== 3
    // Connected AREA is the wrong question, and answering it first is what
    // made that clear: a real town's street network is one connected paved
    // component of many hundreds of tiles, and you cannot see across any of
    // it. The thing a player perceives as "open" is the distance to the
    // nearest WALL. So: a multi-source BFS out from every building tile,
    // across paved ground. In a 2-wide lane every tile is 1 from a facade; in
    // the middle of a 20-tile square it is 10.
    //
    // Buildings only — not props. emptiness.mjs seeds this BFS from props too
    // and reports a comfortable median, but props are scattered everywhere by
    // construction, so that metric can be satisfied by scattering more of
    // them. Enclosure cannot: only a building makes a wall.
    const INF = 1e9
    const dist = new Int32Array(W * H).fill(INF)
    const q = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!occupied[y][x]) continue
        dist[y * W + x] = 0
        q.push(y * W + x)
      }
    }
    for (let head = 0; head < q.length; head++) {
      const i = q[head], cx = i % W, cy = (i / W) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        if (occupied[ny][nx] || !paved(nx, ny)) continue
        const ni = ny * W + nx
        if (dist[ni] > dist[i] + 1) { dist[ni] = dist[i] + 1; q.push(ni) }
      }
    }
    const toWall = []
    let unreached = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (occupied[y][x] || !paved(x, y)) continue
        const d = dist[y * W + x]
        if (d >= INF) { unreached++; continue }
        toWall.push(d)
      }
    }
    // GROUND READ — does the floor look like one surface?
    //
    // The tile histogram can say "21% flagstone, 18% dirt, 5% sand" and the
    // player still sees one continuous pale plane, because flagstone, dirt,
    // sand, gravel, stone AND street cobble are all warm tan in the palette.
    // Renaming a tile is not a visual change; this is the metric that catches
    // that, and it is why "unpave the yards" had to be checked rather than
    // assumed. Colours come from the app's own table over the debug bridge —
    // a copy in this file would be a fourth version of a table that has
    // already drifted three times.
    const pal = window.__pt.terrainPalette().colors
    const family = (id) => {
      const c = pal[id]
      if (c === undefined) return 'other'
      if (id === 3) return 'water'
      const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255
      const max = Math.max(r, g, b), min = Math.min(r, g, b)
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      // Green dominant by a clear margin is vegetation; everything else warm
      // splits on brightness, because a dark brown and a pale sandstone read
      // as different surfaces while two pale tans do not.
      if (g > r && g > b && (g - Math.max(r, b)) > 20) return 'green'
      if (max - min < 24) return lum > 0.5 ? 'pale neutral' : 'dark neutral'
      return lum > 0.55 ? 'pale warm' : lum > 0.3 ? 'mid warm' : 'dark warm'
    }
    // PAVING COHERENCE — is the floor one material per place, or a mosaic?
    //
    // Counted in COLOUR, not tile id. Ids 15/16 are deliberately identical to
    // 8/9 (see core/terrain.ts): a cobbled market district and a cobbled
    // street are the same surface and the id exists only so the data can say
    // which is circulation. A seam between them is invisible and counting it
    // would report a mosaic that nobody can see. Only a seam the eye can find
    // is a seam.
    const rgb = (id) => {
      const c = pal[id]
      if (c === undefined) return null
      return [(c >> 16) & 255, (c >> 8) & 255, c & 255]
    }
    const PAVED_IDS = new Set([2, 8, 9, 13, 14, 15, 16])
    let pavedEdges = 0, visibleSeams = 0
    const seamPairs = {}
    for (let y = 0; y < H - 1; y++) {
      for (let x = 0; x < W - 1; x++) {
        const t = terrain[y][x]
        if (!PAVED_IDS.has(t)) continue
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const n = terrain[y + dy][x + dx]
          if (!PAVED_IDS.has(n)) continue
          pavedEdges++
          if (n === t) continue
          const a = rgb(t), b = rgb(n)
          if (!a || !b) continue
          // Perceptually "different surface" rather than "different number".
          const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
          if (d < 40) continue
          visibleSeams++
          const k = [t, n].sort((p, q) => p - q).join('/')
          seamPairs[k] = (seamPairs[k] ?? 0) + 1
        }
      }
    }

    const families = {}
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const f = family(terrain[y][x])
        families[f] = (families[f] ?? 0) + 1
      }
    }
    return {
      W, H, hist, widths, overWide, roadTiles,
      blobs: blobs.slice(0, 5),
      components: blobs.length,
      toWall, unreached, families, pavedEdges, visibleSeams, seamPairs,
    }
  }, AUTHORISED)
  if (!r) { console.log(`seed ${seed}: no terrain`); continue }
  rows.push({ seed, ...r })
  await win.waitForTimeout(150)
}
await app.close()

const NAMES = {
  0: 'grass', 1: 'dirt', 2: 'stone', 3: 'water', 4: 'sand',
  5: 'dark grass', 6: 'light grass', 7: 'rocky', 8: 'STREET cobble',
  9: 'ALLEY cobble', 10: 'garden', 11: 'mud', 12: 'wildflower',
  13: 'gravel path', 14: 'plaza flagstone', 15: 'district cobble',
  16: 'dark district cobble',
}
const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 100))

console.log('\n=== WHAT THE GROUND ACTUALLY IS ===')
console.log('(stone and plaza flagstone are both pale warm sandstone and read as')
console.log(' ONE surface from any distance. Tile 2 is mostly district paving —')
console.log(' paintDistrictTerrain paves whole temple/noble quarters in it — not')
console.log(' the plaza, so do not read a big id-2 count as a big square.)\n')
for (const r of rows) {
  const total = r.W * r.H
  const parts = Object.entries(r.hist)
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n / total >= 0.01)
    .map(([id, n]) => `${NAMES[id] ?? id} ${pct(n, total)}%`)
  console.log(`seed ${String(r.seed).padStart(6)}: ${parts.join(', ')}`)
  const pale = (r.hist[2] ?? 0) + (r.hist[14] ?? 0)
  const paved = pale + (r.hist[8] ?? 0) + (r.hist[9] ?? 0) +
    (r.hist[15] ?? 0) + (r.hist[16] ?? 0)
  console.log(`${' '.repeat(14)}pale stone+flagstone: ${pct(pale, total)}%` +
    `   circulation: ${pct((r.hist[8] ?? 0) + (r.hist[9] ?? 0), total)}%` +
    `   ALL hard paving: ${pct(paved, total)}% of map`)
}

console.log('\n=== CORRIDOR WIDTH (the carver authorises 1-3 tiles) ===')
console.log('seed     road tiles   med    p75    p90    max   over-wide')
console.log('-'.repeat(60))
const allW = []
let allOver = 0, allRoad = 0
for (const r of rows) {
  const s = [...r.widths].sort((a, b) => a - b)
  allW.push(...r.widths); allOver += r.overWide; allRoad += r.roadTiles
  const q = (p) => s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))]
  const m = (v) => (v * TILE).toFixed(0).padStart(5) + 'm'
  console.log(`${String(r.seed).padStart(7)}${String(r.roadTiles).padStart(12)}` +
    `${m(q(50))}${m(q(75))}${m(q(90))}${m(s[s.length - 1])}` +
    `${String(pct(r.overWide, r.roadTiles) + '%').padStart(11)}`)
}
console.log('-'.repeat(60))
console.log(`OVER-WIDE: ${pct(allOver, allRoad)}% of all road tiles sit in a corridor ` +
  `wider than ${AUTHORISED} tiles (${(AUTHORISED * TILE).toFixed(0)}m).`)
console.log('That is carriageway nobody drew — it is roads that merged.')

console.log('\n=== BIGGEST CONNECTED ROAD AREAS ===')
for (const r of rows) {
  const b = r.blobs.map((x) => `${x.area} (${pct(x.wideArea, x.area)}% wide)`).join(', ')
  console.log(`seed ${String(r.seed).padStart(6)}: ${r.components} components; largest: ${b}`)
}

console.log('\n=== GROUND READ — what the floor LOOKS like, by colour family ===')
console.log('(a town floor should be mixed. If one family is most of the map,')
console.log(' the ground reads as a single continuous plane whatever the tile')
console.log(' ids say, and the town looks open even where it is enclosed.)\n')
for (const r of rows) {
  const total = r.W * r.H
  const parts = Object.entries(r.families)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${pct(n, total)}%`)
  console.log(`seed ${String(r.seed).padStart(6)}: ${parts.join(', ')}`)
}
{
  const agg = {}
  let total = 0
  for (const r of rows) {
    total += r.W * r.H
    for (const [k, n] of Object.entries(r.families)) agg[k] = (agg[k] ?? 0) + n
  }
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1])[0]
  console.log(`\nlargest single family: ${top[0]} at ${pct(top[1], total)}% of the map`)
}

console.log('\n=== PAVING COHERENCE — one material per place, or a mosaic? ===')
console.log('(seams counted in COLOUR: ids 15/16 are identical to 8/9 by design,')
console.log(' so a seam between them is not something anyone can see.)\n')
{
  let pe = 0, vs = 0
  const pairs = {}
  for (const r of rows) {
    pe += r.pavedEdges; vs += r.visibleSeams
    for (const [k, v] of Object.entries(r.seamPairs)) pairs[k] = (pairs[k] ?? 0) + v
  }
  console.log(`  ${vs} of ${pe} paved-to-paved edges are a VISIBLE material change ` +
    `(${pct(vs, pe)}%)`)
  const top = Object.entries(pairs).sort((a, b) => b[1] - a[1]).slice(0, 6)
  for (const [k, n] of top) {
    const [a, b] = k.split('/')
    console.log(`    ${(NAMES[a] ?? a)} | ${(NAMES[b] ?? b)}`.padEnd(52) + n)
  }
}

console.log('\n=== ENCLOSURE — from anywhere you can stand, how far to a WALL? ===')
console.log('(a lane encloses at 3m; a generous square opens to ~12m at its')
console.log(' centre. Ground more than ~15m from any facade is a field.)\n')
console.log('seed      tiles    med    p75    p90    p99    max   over 15m')
console.log('-'.repeat(66))
const allWall = []
for (const r of rows) {
  const s = [...r.toWall].sort((a, b) => a - b)
  allWall.push(...r.toWall)
  const q = (p) => s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))]
  const m = (v) => (v * TILE).toFixed(1).padStart(6)
  const far = s.filter((d) => d * TILE > 15).length
  console.log(`${String(r.seed).padStart(7)}${String(s.length).padStart(7)}` +
    `${m(q(50))}${m(q(75))}${m(q(90))}${m(q(99))}${m(s[s.length - 1])}` +
    `${String(pct(far, s.length) + '%').padStart(10)}`)
}
{
  const s = allWall.sort((a, b) => a - b)
  const far = s.filter((d) => d * TILE > 15).length
  console.log('-'.repeat(66))
  console.log(`${pct(far, s.length)}% of standable ground is more than 15m from any facade.`)
}
