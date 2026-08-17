/**
 * How empty is the walkable town?
 *
 * "A ton of empty space" is a real complaint and a vague one, so measure it:
 * for every walkable tile — street, alley, plaza, district paving — how far is
 * the nearest prop? A town that reads as furnished has something within a few
 * metres almost everywhere; a town that reads as a car park has long runs of
 * nothing. The distribution says which, and says it per surface type, so
 * "plazas are bare" and "streets are bare" are separate answers.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/emptiness.mjs [seeds...]
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

const agg = new Map()
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
    const map = window.__pt.store.getState().map
    const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
    const props = map.layers.find((l) => l.type === 'prop')?.objects ?? []
    const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
    if (!terrain) return null
    const H = terrain.length, W = terrain[0].length
    // Multi-source BFS out from every prop, over walkable tiles only.
    const INF = 1e9
    const dist = new Int32Array(W * H).fill(INF)
    const q = []
    // TWO FIELDS, because the existing one cannot answer the question that
    // matters for CONTENT. It seeds from props AND building frontage, and a
    // town is wall-to-wall buildings, so "distance to the nearest thing" reads
    // a comfortable 3m median while the ground you actually walk on is bare —
    // which is what a street-level screenshot plainly shows. CLAUDE.md already
    // records this tool being satisfiable by scatter; this is the same blind
    // spot pointed at furniture instead of enclosure.
    //
    // Distance to the nearest PROP can only be moved by putting something in
    // the street. A building cannot satisfy it and neither can a facade.
    const distProp = new Int32Array(W * H).fill(INF)
    const qProp = []
    const seedProp = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return
      const i = y * W + x
      if (distProp[i] !== 0) { distProp[i] = 0; qProp.push(i) }
    }
    const seed = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return
      const i = y * W + x
      if (dist[i] !== 0) { dist[i] = 0; q.push(i) }
    }
    for (const p of props) { seed(Math.round(p.x), Math.round(p.y)); seedProp(Math.round(p.x), Math.round(p.y)) }
    // Building frontages count as "something to look at" too — a street lined
    // with doors is not empty even without furniture.
    for (const b of structs) seed(Math.round(b.x), Math.round(b.y))
    // Walkable = circulation (8 street, 9 alley) + paving (14, 15, 16).
    const walk = (x, y) => {
      const t = terrain[y]?.[x]
      return t === 8 || t === 9 || t === 14 || t === 15 || t === 16
    }
    for (let head = 0; head < q.length; head++) {
      const i = q[head], x = i % W, y = (i / W) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        if (!walk(nx, ny)) continue
        const ni = ny * W + nx
        if (dist[ni] > dist[i] + 1) { dist[ni] = dist[i] + 1; q.push(ni) }
      }
    }
    for (let head = 0; head < qProp.length; head++) {
      const i = qProp[head], x = i % W, y = (i / W) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        if (!walk(nx, ny)) continue
        const ni = ny * W + nx
        if (distProp[ni] > distProp[i] + 1) { distProp[ni] = distProp[i] + 1; qProp.push(ni) }
      }
    }
    const byKind = { street: [], plaza: [] }
    const byKindProp = { street: [], plaza: [] }
    let walkTiles = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!walk(x, y)) continue
        walkTiles++
        const d = dist[y * W + x]
        if (d >= 1e9) continue
        const t = terrain[y][x]
        ;(t === 8 || t === 9 ? byKind.street : byKind.plaza).push(d)
        const dp = distProp[y * W + x]
        if (dp < 1e9) (t === 8 || t === 9 ? byKindProp.street : byKindProp.plaza).push(dp)
      }
    }
    return { walkTiles, props: props.length, byKind, byKindProp }
  })
  if (!r) { console.log(`seed ${seed}: no terrain`); continue }
  console.log(`seed ${seed}: ${r.walkTiles} walkable tiles, ${r.props} props`)
  for (const k of ['street', 'plaza']) {
    const a = agg.get(k) ?? []
    a.push(...r.byKind[k])
    agg.set(k, a)
    const b = agg.get(k + ':prop') ?? []
    b.push(...r.byKindProp[k])
    agg.set(k + ':prop', b)
  }
  await win.waitForTimeout(200)
}
await app.close()

const TILE = 3.0
const pct = (s, p) => s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))]
console.log('\n=== DISTANCE FROM WALKABLE GROUND TO THE NEAREST THING ===')
console.log('(metres; a furnished street has something within ~6m almost everywhere)')
console.log('The `:prop` rows exclude BUILDINGS. The plain rows count a facade as')
console.log('something, and a town is wall-to-wall facades, so they read comfortable')
console.log('however bare the ground is — which is what a street-level shot shows.')
console.log('Only putting something IN the street moves a :prop row.\n')
console.log('surface   tiles     med    p75    p90    p99    max   over 12m')
console.log('-'.repeat(66))
for (const [k, arr] of agg) {
  if (!arr.length) continue
  arr.sort((a, b) => a - b)
  const m = (v) => (v * TILE).toFixed(1).padStart(6)
  const far = arr.filter((d) => d * TILE > 12).length
  console.log(
    `${k.padEnd(9)}${String(arr.length).padStart(6)}${m(pct(arr, 50))}${m(pct(arr, 75))}` +
    `${m(pct(arr, 90))}${m(pct(arr, 99))}${m(arr[arr.length - 1])}` +
    `   ${((far / arr.length) * 100).toFixed(0)}%`)
}
