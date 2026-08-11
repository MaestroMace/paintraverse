/** One-off probe: what is the ground actually made of, tile by tile, and how
 *  patchy is it? Plus roof-shape variety. Not a keeper tool. */
import { _electron as electron } from 'playwright-core'
const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2800)

const r = await win.evaluate(() => {
  const st = window.__pt.store.getState()
  const map = st.map
  const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
  const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
  const H = terrain.length, W = terrain[0].length
  const PAVED = new Set([2, 8, 9, 14, 15, 16])
  // Patchiness: for each paved tile, how many 4-neighbours are a DIFFERENT
  // paved id? A coherent surface is 0; a speckle is 3-4.
  let paved = 0, switches = 0, samples = 0
  const pairs = {}
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const t = terrain[y][x]
      if (!PAVED.has(t)) continue
      paved++
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const n = terrain[y + dy][x + dx]
        if (!PAVED.has(n)) continue
        samples++
        if (n !== t) {
          switches++
          const k = [t, n].sort((a, b) => a - b).join('/')
          pairs[k] = (pairs[k] ?? 0) + 1
        }
      }
    }
  }
  // Roof / silhouette variety.
  const byDef = {}
  for (const o of structs) byDef[o.definitionId] = (byDef[o.definitionId] ?? 0) + 1
  const floors = {}
  for (const o of structs) {
    const f = o.properties?.floors ?? '?'
    floors[f] = (floors[f] ?? 0) + 1
  }
  // How much of the map is water, and how does the town sit on it?
  let water = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (terrain[y][x] === 3) water++
  // Buildings whose perimeter touches water = waterfront frontage.
  let waterfront = 0
  for (const o of structs) {
    const f = o.footprint ?? { w: 1, h: 1 }
    let touches = false
    for (let dy = -1; dy <= f.h && !touches; dy++) {
      for (let dx = -1; dx <= f.w && !touches; dx++) {
        if (terrain[o.y + dy]?.[o.x + dx] === 3) touches = true
      }
    }
    if (touches) waterfront++
  }
  return { W, H, paved, switches, samples, pairs, byDef, floors, water, waterfront,
    structs: structs.length }
})
await app.close()
const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 100))
console.log(`\nPAVING PATCHINESS: ${r.switches} of ${r.samples} paved-to-paved edges ` +
  `change material (${pct(r.switches, r.samples)}%)`)
console.log('  most common material seams:')
for (const [k, n] of Object.entries(r.pairs).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`    ${k.padEnd(8)} ${n}`)
}
console.log(`\nWATER: ${pct(r.water, r.W * r.H)}% of map; ` +
  `${r.waterfront} of ${r.structs} buildings (${pct(r.waterfront, r.structs)}%) touch it`)
console.log('\nBUILDING TYPE MIX (top 14):')
for (const [k, n] of Object.entries(r.byDef).sort((a, b) => b[1] - a[1]).slice(0, 14)) {
  console.log(`  ${k.padEnd(20)} ${String(n).padStart(4)}  ${pct(n, r.structs)}%`)
}
console.log('\nFLOOR COUNTS:', JSON.stringify(r.floors))
