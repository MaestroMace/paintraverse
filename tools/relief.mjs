/**
 * RELIEF — the shape of the ground you walk on, and where the steep bits are.
 *
 * Reported from the phone: "there is still a giant ravine running through the
 * middle of town." `river.mjs` says bank relief 0.69m median, 1.34m max, and
 * both are true. It measures the bank — the ONE TILE between the water and the
 * land — and a ravine is not a step, it is a CROSS-SECTION. Land that keeps
 * climbing for five more tiles is invisible to a one-tile reading, which is
 * the decompose-before-you-attribute lesson arriving from a new direction.
 *
 * Three readings:
 *
 *   CROSS-SECTION — height above the local waterline against distance from
 *     the water, averaged over the whole channel. This is the river drawn in
 *     profile. A quay is ~1.5m at one tile and flat after; a ravine keeps
 *     going up. No transect direction to choose and no axis to get wrong:
 *     distance-from-water comes from a BFS, so every tile knows how far out
 *     it is regardless of which way the channel happens to run.
 *
 *   WALKABLE GRADE — the steepest step from each walkable tile to its
 *     neighbours, as a distribution. A street at 8% is comfortable, 15% is
 *     San Francisco, and past 30% you are on a stair. This is what a ravine
 *     FEELS like from inside, as opposed to what it looks like from a map.
 *
 *   ATTRIBUTION — of the steep ground, how much is at the river and how much
 *     is the terrain doing it on its own? "The ravine" might not be the
 *     river's fault at all, and only splitting it can say. A counting metric
 *     buys you guesses; one that names the cause buys you the answer.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/relief.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).map(Number)
if (seeds.length === 0) seeds.push(4242, 777, 31337)
const TILE = 3.0
const TWS = 1.8
/** Past this a street is a stair. */
const STEEP_PCT = 25
const MAX_D = 8

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
  await win.waitForTimeout(2800)

  const r = await win.evaluate((K) => {
    const st = window.__pt.store.getState()
    const map = st.map
    const tl = map.layers.find((l) => l.type === 'terrain')
    const terrain = tl?.terrainTiles
    const heights = tl?.heightMap
    // heightAt() returns null without the 3D renderer and `?? 0` once turned
    // that into a plausible perfectly-flat world for a whole river metric.
    // The layer's own map is the authority and its absence is an error.
    if (!terrain) return { err: 'no terrain layer' }
    if (!heights) return { err: 'terrain layer carries no heightMap' }
    const water = tl.waterLevel
    const isCirc = window.__pt.isCirculation
    const H = terrain.length, W = terrain[0].length
    const m = (raw) => raw * K.TWS

    // --- distance from water, and which water tile you came from ----------
    const dist = Array.from({ length: H }, () => new Int16Array(W).fill(-1))
    const srcLevel = Array.from({ length: H }, () => new Float64Array(W).fill(NaN))
    const q = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (terrain[y][x] !== 3) continue
        dist[y][x] = 0
        // The WATERLINE, not the bed. Measuring to the bed is what made every
        // earlier figure deeper than anything an eye can see.
        srcLevel[y][x] = water?.[y]?.[x] ?? heights[y][x]
        q.push([x, y])
      }
    }
    const wet = q.length
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i]
      if (dist[y][x] >= K.MAX_D) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        if (dist[ny][nx] !== -1) continue
        dist[ny][nx] = dist[y][x] + 1
        srcLevel[ny][nx] = srcLevel[y][x]
        q.push([nx, ny])
      }
    }

    // --- the cross-section: height above waterline vs distance out --------
    const band = Array.from({ length: K.MAX_D + 1 }, () => [])
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = dist[y][x]
        if (d <= 0 || d > K.MAX_D) continue
        band[d].push(m(heights[y][x] - srcLevel[y][x]))
      }
    }

    // --- grade under every walkable tile ----------------------------------
    const grades = []
    const worstTiles = []
    let steepAtRiver = 0, steepInland = 0, steepTotal = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isCirc(terrain[y][x])) continue
        let worst = 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          if (!isCirc(terrain[ny][nx])) continue
          worst = Math.max(worst, Math.abs(m(heights[ny][nx] - heights[y][x])))
        }
        const pct = (worst / K.TILE) * 100
        grades.push(pct)
        if (pct >= K.STEEP) {
          steepTotal++
          // "Near the river" generously: inside the carve's reach plus one.
          if (dist[y][x] >= 0 && dist[y][x] <= 4) steepAtRiver++
          else steepInland++
          // NAME THE TILE. A percentage tells you a cliff exists somewhere;
          // a coordinate lets you go and stand on it, which is the only way
          // to know whether it is the thing being complained about.
          worstTiles.push({ x, y, pct: +pct.toFixed(1), d: dist[y][x] })
        }
      }
    }

    // --- the same, for ALL land, so a ravine through a block still counts --
    let landSteep = 0, landTotal = 0
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (terrain[y][x] === 3) continue
        landTotal++
        let worst = 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (terrain[y + dy][x + dx] === 3) continue
          worst = Math.max(worst, Math.abs(m(heights[y + dy][x + dx] - heights[y][x])))
        }
        if ((worst / K.TILE) * 100 >= K.STEEP) landSteep++
      }
    }

    const hs = []
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hs.push(m(heights[y][x]))
    return {
      wet,
      band: band.map((v) => {
        if (!v.length) return null
        const s = [...v].sort((a, b) => a - b)
        return { n: v.length, med: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] }
      }),
      grades: (() => {
        const s = [...grades].sort((a, b) => a - b)
        return {
          n: s.length,
          med: s[Math.floor(s.length / 2)] ?? 0,
          p90: s[Math.floor(s.length * 0.9)] ?? 0,
          p99: s[Math.floor(s.length * 0.99)] ?? 0,
          max: s[s.length - 1] ?? 0,
        }
      })(),
      steepAtRiver, steepInland, steepTotal, walkable: grades.length,
      worstTiles: worstTiles.sort((a, b) => b.pct - a.pct).slice(0, 6),
      landSteep, landTotal,
      terrainMin: Math.min(...hs), terrainMax: Math.max(...hs),
    }
  }, { TWS, TILE, STEEP: STEEP_PCT, MAX_D })

  if (r?.err) { console.log(`seed ${seed}: ${r.err}`); continue }
  rows.push({ seed, ...r })
}
await app.close()

if (!rows.length) { console.log('\nNOTHING MEASURED.'); process.exit(1) }
const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 100))

console.log('\n=== RELIEF — the shape of the ground you walk on ===')
for (const r of rows) {
  console.log(`\nseed ${r.seed} — ${r.wet} water tiles, terrain ${r.terrainMin.toFixed(1)}m .. ${r.terrainMax.toFixed(1)}m`)
  console.log('  CROSS-SECTION, height above the local waterline:')
  console.log('    tiles out      1      2      3      4      5      6      7      8')
  const line = (k) => '    ' + `${k}`.padEnd(11) +
    r.band.slice(1).map((b) => (b ? `${b[k].toFixed(2)}` : '  -  ').padStart(7)).join('')
  console.log(line('med'))
  console.log(line('p90'))
  console.log(line('max'))
  console.log(`  WALKABLE GRADE  median ${r.grades.med.toFixed(1)}%, p90 ${r.grades.p90.toFixed(1)}%, ` +
    `p99 ${r.grades.p99.toFixed(1)}%, max ${r.grades.max.toFixed(1)}%`)
  console.log(`  STEEP (>=${STEEP_PCT}%)  ${pct(r.steepTotal, r.walkable)}% of street ` +
    `(${r.steepAtRiver} at the river, ${r.steepInland} inland) · ` +
    `${pct(r.landSteep, r.landTotal)}% of all land`)
  if (r.worstTiles.length) {
    console.log('    worst street tiles: ' +
      r.worstTiles.map((t) => `(${t.x},${t.y}) ${t.pct}% d=${t.d}`).join('  '))
  }
}

const agg = (f) => rows.reduce((a, r) => a + f(r), 0)
console.log('\n--- over all seeds ---')
const b = Array.from({ length: MAX_D + 1 }, (_, d) =>
  rows.map((r) => r.band[d]).filter(Boolean))
console.log('  average cross-section (median height above waterline):')
console.log('    ' + b.slice(1).map((g, i) =>
  `${i + 1}t:${(g.reduce((a, x) => a + x.med, 0) / (g.length || 1)).toFixed(2)}m`).join('  '))
console.log(`  RISE 1->${MAX_D} TILES: ` +
  `${((b[MAX_D].reduce((a, x) => a + x.med, 0) / (b[MAX_D].length || 1)) - (b[1].reduce((a, x) => a + x.med, 0) / (b[1].length || 1))).toFixed(2)}m`)
console.log(`  STEEP STREET: ${pct(agg((r) => r.steepTotal), agg((r) => r.walkable))}% ` +
  `— ${agg((r) => r.steepAtRiver)} tiles at the river vs ${agg((r) => r.steepInland)} inland`)
console.log(`\n  A quay is ~1.5m at one tile and FLAT after it. A bank that keeps`)
console.log(`  climbing tile after tile is a ravine however healthy the`)
console.log(`  one-tile reading is — that number is a step, and this is a`)
console.log(`  cross-section. Watch which column stops rising.`)
