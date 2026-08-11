/**
 * RIVER — is this a river, or blue paint on the floor?
 *
 * Reported, and the wording turned out to be mechanically exact: "the rivers
 * seem random, like a painted floor I can't walk on."
 *
 * Nothing here has ever measured the water. `site.mjs` asks whether the TOWN
 * acknowledges the river — quays, waterfront frontage, severance — which is a
 * question about the buildings. This asks whether the river is a river.
 *
 * WHAT MAKES A RIVER READ AS ONE
 *
 *   BANK RELIEF — how far the water surface sits BELOW the ground beside it.
 *     This is the whole "painted floor" complaint as a number. A real channel
 *     is cut into the land; if the relief is ~0 the water is a translucent
 *     quad lying exactly on the ground and no amount of shader work will save
 *     it. Everything else on this list is secondary to it.
 *
 *   DESCENT — water flows downhill. Walk the channel from source to mouth and
 *     count the steps that go DOWN. A course that climbs is the giveaway that
 *     it was drawn without consulting the terrain at all.
 *
 *   WIDTH PROFILE — a river gathers. It should be narrow at its source and
 *     widest at its mouth. A constant width is a canal, and a canal that
 *     meanders randomly is nothing.
 *
 *   CONTINUITY — one channel running edge to edge, not a chain of puddles.
 *     Also: does it actually START and END somewhere, or stop mid-map?
 *
 *   CROSSINGS — how many bridges, and how far apart. Water you cannot cross
 *     severs the town; that is the "can't walk on" half of the report.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/river.mjs [seeds...]
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
  // heightAt() goes through getActiveThreeRenderer(), which is null until the
  // 3D view exists. Without this every height read comes back null, `?? 0`
  // turns that into a plausible zero, and the tool confidently reports a
  // perfectly flat world with 0.00m banks. It did exactly that on the first
  // run. A probe that cannot answer must not be allowed to answer 0.
  await win.getByRole('button', { name: '3D', exact: true }).click()
  await win.waitForTimeout(2600)

  const r = await win.evaluate(() => {
    const st = window.__pt.store.getState()
    const map = st.map
    const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
    if (!terrain) return null
    const H = terrain.length, W = terrain[0].length
    const isWater = (x, y) => terrain[y]?.[x] === 3
    // THE VISIBLE waterline, not the bed. heightAt() returns the TERRAIN
    // height, and under a water tile that is the riverbed — which the carve
    // deliberately puts below the surface. So every relief figure this tool
    // printed was land-to-BED, deeper than anything the eye can see. What the
    // player looks at is land-to-WATERLINE, and the layer carries it.
    const wl = map.layers.find((l) => l.type === 'terrain')?.waterLevel
    const TERRAIN_WORLD_SCALE = 1.8
    const surfaceAt = (x, y) => {
      const raw = wl?.[y]?.[x]
      if (raw === undefined || raw === null || Number.isNaN(raw)) return hAt(x, y)
      return raw * TERRAIN_WORLD_SCALE
    }
    // heightAt takes TILE coordinates and returns METRES. Sampling tile
    // centres so a value is never an interpolation between land and water.
    let heightUnavailable = false
    const hAt = (x, y) => {
      const v = window.__pt.heightAt(x + 0.5, y + 0.5)
      if (v === null || v === undefined) { heightUnavailable = true; return 0 }
      return v
    }

    // --- components ---------------------------------------------------
    const comp = Array.from({ length: H }, () => new Int16Array(W).fill(-1))
    const comps = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isWater(x, y) || comp[y][x] >= 0) continue
        const id = comps.length
        const tiles = []
        const q = [[x, y]]
        comp[y][x] = id
        while (q.length) {
          const [cx, cy] = q.pop()
          tiles.push([cx, cy])
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            if (!isWater(nx, ny) || comp[ny][nx] >= 0) continue
            comp[ny][nx] = id
            q.push([nx, ny])
          }
        }
        comps.push(tiles)
      }
    }
    comps.sort((a, b) => b.length - a.length)
    const waterTiles = comps.reduce((s, c) => s + c.length, 0)
    if (!comps.length) return { seed: null, none: true }
    const main = comps[0]

    // --- bank relief ----------------------------------------------------
    // The number the complaint is about. For each water tile, how much higher
    // is the LAND around it? Measured against the nearest non-water tiles
    // rather than a fixed ring, so a wide river is judged by its banks and
    // not by the middle of its own channel.
    const relief = []      // land to WATERLINE — what you see
    const bedRelief = []   // land to BED — how deep the channel is cut
    for (const [x, y] of main) {
      let best = null
      for (let rad = 1; rad <= 3 && best === null; rad++) {
        let sum = 0, n = 0
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dx = -rad; dx <= rad; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            if (isWater(nx, ny)) continue
            sum += hAt(nx, ny); n++
          }
        }
        if (n >= 3) best = sum / n
      }
      if (best !== null) {
        relief.push(best - surfaceAt(x, y))
        bedRelief.push(best - hAt(x, y))
      }
    }

    // --- the course, ordered ---------------------------------------------
    // BFS from the tile nearest a map edge gives a distance field; walking it
    // in increasing distance is walking downstream, whatever shape the
    // channel is. Source = the endpoint at higher ground.
    // ORIENT BY HEIGHT, not by which endpoint happens to be nearest an edge.
    // Both ends of a river touch the map edge, so "nearest the edge" picks one
    // arbitrarily — and when it picked the mouth, this reported a river
    // flowing uphill and NARROWING downstream, which is the correct reading of
    // a course walked backwards. The source is the high end. Two BFS passes:
    // one to find the far endpoint, then start again from whichever of the two
    // stands higher.
    const edgeDist = ([x, y]) => Math.min(x, y, W - 1 - x, H - 1 - y)
    const probe = main.slice().sort((a, b) => edgeDist(a) - edgeDist(b))[0]
    const reach = (from) => {
      const dd = Array.from({ length: H }, () => new Int16Array(W).fill(-1))
      dd[from[1]][from[0]] = 0
      let qq = [from], best = from
      while (qq.length) {
        const nn = []
        for (const [cx, cy] of qq) {
          if (dd[cy][cx] > dd[best[1]][best[0]]) best = [cx, cy]
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            if (!isWater(nx, ny) || dd[ny][nx] >= 0) continue
            dd[ny][nx] = dd[cy][cx] + 1
            nn.push([nx, ny])
          }
        }
        qq = nn
      }
      return best
    }
    const endA = reach(probe)
    const endB = reach(endA)
    const start = hAt(endA[0], endA[1]) >= hAt(endB[0], endB[1]) ? endA : endB
    const dist = Array.from({ length: H }, () => new Int16Array(W).fill(-1))
    dist[start[1]][start[0]] = 0
    let q = [start]
    let far = start
    while (q.length) {
      const nq = []
      for (const [cx, cy] of q) {
        if (dist[cy][cx] > dist[far[1]][far[0]]) far = [cx, cy]
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          if (!isWater(nx, ny) || dist[ny][nx] >= 0) continue
          dist[ny][nx] = dist[cy][cx] + 1
          nq.push([nx, ny])
        }
      }
      q = nq
    }
    // Bucket the channel by distance-from-start; each bucket is a cross
    // section, and its size is the local WIDTH.
    const maxD = dist[far[1]][far[0]]
    const buckets = new Map()
    for (const [x, y] of main) {
      const d = dist[y][x]
      if (d < 0) continue
      if (!buckets.has(d)) buckets.set(d, [])
      buckets.get(d).push([x, y])
    }
    const stations = []
    for (const d of [...buckets.keys()].sort((a, b) => a - b)) {
      const b = buckets.get(d)
      const hs = b.map(([x, y]) => hAt(x, y))
      stations.push({
        d,
        width: b.length,
        h: hs.reduce((s, v) => s + v, 0) / hs.length,
      })
    }
    // Descent: fraction of steps downstream that lose height.
    let down = 0, up = 0
    for (let i = 1; i < stations.length; i++) {
      const dh = stations[i].h - stations[i - 1].h
      if (dh < -0.01) down++
      else if (dh > 0.01) up++
    }
    const startsAtEdge = edgeDist(start) <= 1
    const endsAtEdge = edgeDist(far) <= 1

    // --- crossings --------------------------------------------------------
    const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
    const bridges = structs.filter((o) => /bridge/.test(o.definitionId ?? ''))

    const med = (xs) => {
      const s = xs.slice().sort((a, b) => a - b)
      return s.length ? s[Math.floor(s.length / 2)] : 0
    }
    const firstQ = stations.slice(0, Math.max(1, Math.floor(stations.length / 4)))
    const lastQ = stations.slice(-Math.max(1, Math.floor(stations.length / 4)))
    // SANITY: a relief of exactly 0.00 could mean "no channel is cut" or it
    // could mean the height field is flat everywhere and the metric has
    // nothing to measure. Those want completely different fixes, so the tool
    // has to say which. Report the whole map's height range beside the
    // river's own.
    let hMin = Infinity, hMax = -Infinity
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        const v = hAt(x, y)
        if (v < hMin) hMin = v
        if (v > hMax) hMax = v
      }
    }
    let rMin = Infinity, rMax = -Infinity
    for (const [x, y] of main) {
      const v = hAt(x, y)
      if (v < rMin) rMin = v
      if (v > rMax) rMax = v
    }
    return {
      heightUnavailable,
      mapHMin: hMin, mapHMax: hMax, riverHMin: rMin, riverHMax: rMax,
      W, H, waterTiles, components: comps.length, mainLen: main.length,
      reliefMed: med(relief), reliefP90: relief.length
        ? relief.slice().sort((a, b) => a - b)[Math.floor(relief.length * 0.9)] : 0,
      // THE MAX, because a median cannot see a canyon. The first carve read a
      // perfectly reasonable 1.14m median and a phone screenshot came back of
      // a gorge: where the course grazed high ground the bed was cut down and
      // the land beside it was never cut down to meet it, so the worst tiles
      // were many metres deep. A distribution with a fat tail and a healthy
      // middle is exactly what one summary number hides.
      reliefMax: relief.length ? Math.max(...relief) : 0,
      bedMed: med(bedRelief), bedMax: bedRelief.length ? Math.max(...bedRelief) : 0,
      gorgeShare: relief.length
        ? relief.filter((v) => v > 3.5).length / relief.length : 0,
      flushShare: relief.length
        ? relief.filter((v) => v < 0.15).length / relief.length : 0,
      down, up, courseLen: maxD,
      dropTotal: stations.length ? stations[0].h - stations[stations.length - 1].h : 0,
      widthSource: med(firstQ.map((s) => s.width)),
      widthMouth: med(lastQ.map((s) => s.width)),
      widthMed: med(stations.map((s) => s.width)),
      startsAtEdge, endsAtEdge,
      bridges: bridges.length,
    }
  })
  if (!r) { console.log(`seed ${seed}: no terrain`); continue }
  if (r.none) { console.log(`seed ${seed}: NO WATER AT ALL`); continue }
  rows.push({ seed, ...r })
}
await app.close()

const f = (v, n = 2) => (typeof v === 'number' ? v.toFixed(n) : String(v))
if (rows.some((r) => r.heightUnavailable)) {
  console.log('\n!! heightAt() returned null — the 3D renderer is not up, and every')
  console.log('   height figure below is meaningless. Do not read them.')
}
console.log('\n=== RIVER — is it a river, or blue paint on the floor? ===\n')
console.log('seed      tiles  parts  bank relief  flush   descent  width src→mouth  ends  bridges')
console.log('-'.repeat(94))
for (const r of rows) {
  const desc = r.down + r.up ? `${Math.round((r.down / (r.down + r.up)) * 100)}%` : '  —'
  console.log(
    `${String(r.seed).padStart(8)}${String(r.waterTiles).padStart(7)}` +
    `${String(r.components).padStart(7)}` +
    `${(f(r.reliefMed) + 'm').padStart(13)}` +
    `${(Math.round(r.flushShare * 100) + '%').padStart(7)}` +
    `${desc.padStart(10)}` +
    `${String(`${r.widthSource}→${r.widthMouth}`).padStart(13)}` +
    `${String(`${r.startsAtEdge ? 'edge' : 'MID'}/${r.endsAtEdge ? 'edge' : 'MID'}`).padStart(12)}` +
    `${String(r.bridges).padStart(9)}`)
}
console.log('-'.repeat(94))
const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / (rows.length || 1)
const totDown = rows.reduce((s, r) => s + r.down, 0)
const totUp = rows.reduce((s, r) => s + r.up, 0)

console.log(`\nTERRAIN         map height range ${f(avg('mapHMin'))}m .. ${f(avg('mapHMax'))}m; ` +
  `along the river ${f(avg('riverHMin'))}m .. ${f(avg('riverHMax'))}m`)
console.log(`  If the map has relief and the river does not, the channel was`)
console.log(`  routed without consulting the height map. If NEITHER has relief,`)
console.log(`  the terrain is flat and the river is not the thing to fix first.`)

console.log(`\nBANK RELIEF     median ${f(avg('reliefMed'))}m, p90 ${f(avg('reliefP90'))}m, ` +
  `MAX ${f(avg('reliefMax'))}m   (land to WATERLINE — what you see)`)
console.log(`CHANNEL DEPTH   median ${f(avg('bedMed'))}m, max ${f(avg('bedMax'))}m   ` +
  `(land to BED — how deep it is cut)`)
console.log(`  ${Math.round(avg('gorgeShare') * 100)}% of water tiles sit more than 3.5m below their`)
console.log(`  banks — that is a gorge, not a river, and the median cannot see it.`)
console.log(`  How far the water sits BELOW the land beside it. THIS IS THE`)
console.log(`  "painted floor" COMPLAINT. The 3D water surface is built from the`)
console.log(`  same corner heights as the ground (TerrainMesh, deliberately, so`)
console.log(`  the shoreline seams instead of cracking) — so if the height map`)
console.log(`  has no channel cut into it, the water IS a translucent quad lying`)
console.log(`  flat on the ground. A real river runs 1-3m below its banks.`)
console.log(`  ${Math.round(avg('flushShare') * 100)}% of water tiles are within 15cm of their own banks.`)

console.log(`\nDESCENT         ${totDown + totUp ? Math.round((totDown / (totDown + totUp)) * 100) : 0}% of downstream steps lose height`)
console.log(`  Should be near 100%. Water does not flow uphill. Anything near`)
console.log(`  50% means the course was drawn without consulting the terrain.`)
console.log(`  Total drop source to mouth: ${f(avg('dropTotal'))}m.`)

console.log(`\nWIDTH           ${f(avg('widthSource'), 1)} tiles at the source, ${f(avg('widthMouth'), 1)} at the mouth`)
console.log(`  A river gathers as it goes. Equal numbers mean a canal.`)

console.log(`\nCONTINUITY      ${f(avg('components'), 1)} separate bodies of water; main channel ` +
  `${f(avg('mainLen'), 0)} of ${f(avg('waterTiles'), 0)} tiles`)
console.log(`CROSSINGS       ${f(avg('bridges'), 1)} bridges per town`)
console.log(`\nNOISE FLOOR: every figure here is a pure function of the seed —`)
console.log(`no camera, no frame timing — so a re-run on the same seeds is`)
console.log(`bit-identical and any movement is the generator, not the tool.`)
