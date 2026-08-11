/**
 * SITE — does the town know the water is there?
 *
 * The water is generated from noise before anything else exists, and nothing
 * downstream reads it. So the river is a ribbon that happens to pass through
 * the map rather than a reason the town is where it is, which is the
 * "scattered buildings and rivers" report stated as a pipeline fact.
 *
 * Lynch's EDGE only works if it is legible from inside. A town on a river has
 * a quay you can walk, buildings that FRONT the water instead of turning their
 * backs on it, and crossings where the crossing matters. So:
 *
 *   WATERFRONT FRONTAGE — of all the land that touches water, how much of it
 *     carries a building? This is the same question urbanform asks of streets,
 *     asked of the bank. A working waterfront is lined; a ribbon through a
 *     field is not.
 *
 *   BACKS TO THE WATER — of the buildings that DO touch water, how many have
 *     a street on the water side? A building between a lane and the river,
 *     with its face to the lane, is a building with its back to the river.
 *
 *   SEVERANCE — does the water cut the town in two? Count the connected
 *     components of the walkable network and how many bridges join them. A
 *     river with no crossing is a wall; a river with a crossing is a place.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/site.mjs [seeds...]
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
    const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
    const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
    if (!terrain) return null
    const H = terrain.length, W = terrain[0].length
    const isWater = (x, y) => terrain[y]?.[x] === 3
    const isRoad = (x, y) => { const t = terrain[y]?.[x]; return t === 8 || t === 9 }

    const built = Array.from({ length: H }, () => new Int16Array(W).fill(-1))
    let bridges = 0
    structs.forEach((o, idx) => {
      const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
      const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
      if (o.definitionId === 'bridge') bridges++
      for (let dy = 0; dy < f.h; dy++) {
        for (let dx = 0; dx < f.w; dx++) {
          const px = o.x + dx, py = o.y + dy
          if (px >= 0 && py >= 0 && px < W && py < H) built[py][px] = idx
        }
      }
    })

    // Bank tiles: dry land orthogonally touching water.
    let bank = 0, bankBuilt = 0, bankRoad = 0, bankLined = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (isWater(x, y)) continue
        let touches = false
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (isWater(x + dx, y + dy)) { touches = true; break }
        }
        if (!touches) continue
        bank++
        if (built[y][x] >= 0) bankBuilt++
        if (isRoad(x, y)) bankRoad++
        // THE WATERFRONT WALL. Is there a built edge along this stretch of
        // river? Not "does a building touch the water" — once the bank has a
        // quay on it, the buildings stand one tile back and stop touching,
        // and a building fronting a quay that fronts the river is exactly
        // what a waterfront IS. So look inland, the same two tiles urbanform
        // allows a street frontage.
        let lined = false
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (isWater(x + dx, y + dy)) continue     // that way is the river
          for (let k = 0; k <= 2 && !lined; k++) {
            if (built[y + dy * k]?.[x + dx * k] >= 0) lined = true
          }
        }
        if (lined) bankLined++
      }
    }

    // Buildings touching water, and whether they face it.
    let wet = 0, backsToWater = 0
    structs.forEach((o) => {
      const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
      const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
      let touchesWater = false, roadOnDryside = false
      for (let dy = -1; dy <= f.h; dy++) {
        for (let dx = -1; dx <= f.w; dx++) {
          const inside = dx >= 0 && dy >= 0 && dx < f.w && dy < f.h
          if (inside) continue
          if (isWater(o.x + dx, o.y + dy)) touchesWater = true
          if (isRoad(o.x + dx, o.y + dy)) roadOnDryside = true
        }
      }
      if (!touchesWater) return
      wet++
      // Touches water AND has a street elsewhere on its perimeter: the street
      // is the front, so the water side is the back.
      if (roadOnDryside) backsToWater++
    })

    // THE TOWN WALL — Lynch's EDGE, and whether it is one.
    //
    // A wall only reads as a boundary if it is continuous and tall enough to
    // stop the eye. The placer skips any perimeter tile carrying a road,
    // water, paving or a building, so the ring can end up more gap than wall
    // without anybody noticing: from inside, a wall with holes in it is not a
    // boundary, it is scenery.
    //
    // Walk the same bounding box the wall builder uses and classify every
    // tile on it. Water and a building both seal the edge as well as masonry
    // does — what does not seal it is nothing at all.
    const WALLISH = new Set(['stone_wall', 'stone_wall_v', 'crenellated_wall',
      'watchtower', 'round_tower', 'town_gate', 'gatehouse', 'tower'])
    // Derive the ring the way the wall builder does — the bounding box of the
    // BUILDINGS plus a 2-tile margin. Taking it over every structure instead
    // puts outlying countryside pieces (the windmill, a far bridge) in the
    // box, so the ring runs well outside the wall and the wall scores as full
    // of holes when it may not be. Exclude the wall objects themselves too,
    // or the measurement defines its own answer.
    const wallTile = Array.from({ length: H }, () => new Uint8Array(W))
    let wallSegs = 0
    let bMinX = W, bMinY = H, bMaxX = 0, bMaxY = 0
    for (const o of structs) {
      const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
      const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
      if (WALLISH.has(o.definitionId)) {
        wallSegs++
        for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) {
          const px = o.x + dx, py = o.y + dy
          if (px >= 0 && py >= 0 && px < W && py < H) wallTile[py][px] = 1
        }
        continue
      }
      if (o.definitionId === 'bridge' || o.definitionId === 'windmill') continue
      bMinX = Math.min(bMinX, o.x); bMinY = Math.min(bMinY, o.y)
      bMaxX = Math.max(bMaxX, o.x + f.w); bMaxY = Math.max(bMaxY, o.y + f.h)
    }
    bMinX = Math.max(1, bMinX - 2); bMinY = Math.max(1, bMinY - 2)
    bMaxX = Math.min(W - 2, bMaxX + 2); bMaxY = Math.min(H - 2, bMaxY + 2)
    // Why is each gap a gap? Guessing at this twice cost two builds — the
    // paved() skip turned out to be redundant with the road check, and gate
    // clearance was worth five points. Classify instead.
    const gapWhy = {}
    let ring = 0, sealed = 0, sealedByWall = 0
    // The ring has to be the lines the wall builder actually walks. It lays
    // its top row at minY and its BOTTOM at maxY-1, its left at minX and its
    // RIGHT at maxX-1 — so a ring drawn on minY/maxY/minX/maxX is one tile
    // outside the wall on two of its four sides, and every segment on those
    // sides scores as a gap. That artifact read as "233 tiles where the
    // placer simply did not build", which sent two changes chasing a
    // continuity problem that was half measurement.
    const edgeTiles = []
    for (let x = bMinX; x <= bMaxX; x++) { edgeTiles.push([x, bMinY], [x, bMaxY - 1]) }
    for (let y = bMinY; y <= bMaxY; y++) { edgeTiles.push([bMinX, y], [bMaxX - 1, y]) }
    for (const [x, y] of edgeTiles) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue
      ring++
      if (wallTile[y][x]) { sealed++; sealedByWall++; continue }
      if (isWater(x, y) || built[y][x] >= 0) { sealed++; continue }
      const t = terrain[y]?.[x]
      const why = isRoad(x, y) ? 'a road crosses here (wants a gate)'
        : t === 2 || t === 14 ? 'designed square runs to the edge'
        : 'nothing — the placer simply did not build here'
      gapWhy[why] = (gapWhy[why] ?? 0) + 1
    }

    // Severance: connected components of walkable ground, and how much of the
    // town is in the largest one. Bridges are what stitch them together.
    const walk = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !isWater(x, y)
    const seen = Array.from({ length: H }, () => new Uint8Array(W))
    const comps = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (seen[y][x] || !walk(x, y)) continue
        let n = 0
        const q = [[x, y]]; seen[y][x] = 1
        for (let i = 0; i < q.length; i++) {
          const [cx, cy] = q[i]; n++
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            if (seen[ny][nx] || !walk(nx, ny)) continue
            seen[ny][nx] = 1; q.push([nx, ny])
          }
        }
        comps.push(n)
      }
    }
    comps.sort((a, b) => b - a)
    let water = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (isWater(x, y)) water++
    return {
      W, H, water, bank, bankBuilt, bankRoad, bankLined, wet, backsToWater, bridges,
      ring, sealed, sealedByWall, wallSegs, gapWhy,
      structs: structs.length, comps: comps.slice(0, 4),
      landTotal: W * H - water,
    }
  })
  if (!r) { console.log(`seed ${seed}: no terrain`); continue }
  rows.push({ seed, ...r })
  await win.waitForTimeout(150)
}
await app.close()

const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 100))
console.log('\n=== DOES THE TOWN KNOW THE WATER IS THERE? ===')
console.log('seed    water  bank tiles  bank built  bank has road  wet bldgs  bridges')
console.log('-'.repeat(76))
let B = 0, BB = 0, BR = 0, BL = 0, WE = 0, BW = 0, BR2 = 0, S = 0
for (const r of rows) {
  B += r.bank; BB += r.bankBuilt; BR += r.bankRoad; BL += r.bankLined
  WE += r.wet; BW += r.backsToWater; BR2 += r.bridges; S += r.structs
  console.log(
    `${String(r.seed).padStart(7)}${String(pct(r.water, r.W * r.H) + '%').padStart(7)}` +
    `${String(r.bank).padStart(12)}` +
    `${String(pct(r.bankBuilt, r.bank) + '%').padStart(12)}` +
    `${String(pct(r.bankRoad, r.bank) + '%').padStart(15)}` +
    `${String(r.wet).padStart(11)}` +
    `${String(r.bridges).padStart(9)}`)
}
console.log('-'.repeat(76))
console.log(`\nWATERFRONT WALL       ${pct(BL, B)}%  of bank has a building within 2 tiles inland`)
console.log(`  (compare 73% frontage occupancy on the STREETS — same question, same rule)`)
console.log(`WATERFRONT FRONTAGE   ${pct(BB, B)}%  of bank tiles carry a building directly`)
console.log(`QUAY                  ${pct(BR, B)}%  of bank tiles are walkable street`)
console.log(`WET BUILDINGS         ${WE} of ${S} (${pct(WE, S)}%) touch the water`)
console.log(`  ...of which ${BW} (${pct(BW, WE)}%) have their street on the DRY side,`)
console.log(`     i.e. they face the lane and turn their back to the river.`)
console.log(`BRIDGES               ${BR2}`)
{
  let R = 0, SE = 0, SW = 0, WS = 0
  for (const r of rows) { R += r.ring; SE += r.sealed; SW += r.sealedByWall; WS += r.wallSegs }
  console.log(`\nTOWN WALL — is the EDGE continuous?`)
  console.log(`  ${WS} wall/tower/gate objects`)
  console.log(`  ${pct(SE, R)}% of the town's boundary ring is sealed by something`)
  console.log(`  ${pct(SW, R)}% of it is sealed by actual masonry (the rest is water or houses)`)
  const why = {}
  for (const r of rows) for (const [k, v] of Object.entries(r.gapWhy)) why[k] = (why[k] ?? 0) + v
  console.log('  why the gaps are gaps:')
  for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${k}`)
  }
}

console.log('\nwalkable components (largest first) — a river with no crossing splits a town:')
for (const r of rows) console.log(`  seed ${String(r.seed).padStart(6)}: ${r.comps.join(', ')}`)
