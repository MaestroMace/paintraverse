/**
 * URBAN FORM AUDIT — is this a town, or objects on a field?
 *
 * Every metric so far has measured OBJECTS: are the buildings the right size,
 * is the geometry attached, is there a prop nearby. None of them can answer
 * "does this read as a town", because that is a property of the SPACE BETWEEN
 * the objects, and the space between is what the generator never models.
 *
 * These are the four numbers that separate a town from a scatter:
 *
 *   FRONTAGE OCCUPANCY  — of all the road edge in the map, how much has a
 *     building standing against it? A real street is a continuous wall of
 *     facades. Detached objects with gaps is the failure mode being reported.
 *
 *   PARTY WALLS — how many buildings actually touch a neighbour? Terraces are
 *     the normal case in a walled town; freestanding is the exception.
 *
 *   BUILT COVERAGE — of the land that is NOT street, how much carries a
 *     building? A medieval town inside its walls runs 50-70%. Low coverage is
 *     "big open spaces" stated as a number.
 *
 *   ENCLOSURE — standing on a street tile, how much of the horizon is wall?
 *     Approximated as building height over distance to the nearest building on
 *     each side. Enclosure is what makes a street feel built rather than
 *     placed, and it is the one thing props cannot fake.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/urbanform.mjs [seeds...]
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

  const r = await win.evaluate(() => {
    const st = window.__pt.store.getState()
    const map = st.map
    const defs = st.objectDefinitions
    const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
    const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
    if (!terrain) return null
    const H = terrain.length, W = terrain[0].length
    const fpOf = (o) => {
      const d = defs.find?.((x) => x.id === o.definitionId) ??
        (defs[o.definitionId] ?? null)
      const f = d?.footprint
      return f ? { w: f.w, h: f.h } : { w: 1, h: 1 }
    }
    // built[y][x] = index of the building covering this tile, or -1
    const built = Array.from({ length: H }, () => new Int16Array(W).fill(-1))
    structs.forEach((o, idx) => {
      const f = fpOf(o)
      for (let dy = 0; dy < f.h; dy++) {
        for (let dx = 0; dx < f.w; dx++) {
          const x = o.x + dx, y = o.y + dy
          if (x >= 0 && y >= 0 && x < W && y < H) built[y][x] = idx
        }
      }
    })
    const isRoad = (x, y) => {
      const t = terrain[y]?.[x]
      return t === 8 || t === 9
    }
    const isWater = (x, y) => terrain[y]?.[x] === 3

    // --- FRONTAGE OCCUPANCY -------------------------------------------
    // Every road tile edge that faces non-road land is a piece of frontage.
    // Occupied if the land on the other side carries a building within 2
    // tiles (a building set back one tile still fronts the street).
    let frontageTotal = 0, frontageBuilt = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isRoad(x, y)) continue
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          if (isRoad(nx, ny) || isWater(nx, ny)) continue
          frontageTotal++
          let hit = false
          for (let k = 0; k < 2 && !hit; k++) {
            const px = x + dx * (k + 1), py = y + dy * (k + 1)
            if (px < 0 || py < 0 || px >= W || py >= H) break
            if (built[py][px] >= 0) hit = true
          }
          if (hit) frontageBuilt++
        }
      }
    }

    // --- PARTY WALLS ---------------------------------------------------
    // A building touches a neighbour when any of its tiles is orthogonally
    // adjacent to a tile of a DIFFERENT building.
    const touches = new Set()
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = built[y][x]
        if (a < 0) continue
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const b = built[y + dy]?.[x + dx]
          if (b !== undefined && b >= 0 && b !== a) { touches.add(a); touches.add(b) }
        }
      }
    }

    // --- BUILT COVERAGE ------------------------------------------------
    let land = 0, landBuilt = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (isRoad(x, y) || isWater(x, y)) continue
        land++
        if (built[y][x] >= 0) landBuilt++
      }
    }

    // --- ENCLOSURE -----------------------------------------------------
    // For each road tile, scan left and right perpendicular to the road until
    // a building is hit. Enclosure = storeys / street width, the classic
    // height-to-width ratio. A comfortable street is 0.5-1.5; below ~0.25 the
    // space reads as a field with things around the edge.
    const ratios = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isRoad(x, y)) continue
        for (const axis of [[1, 0], [0, 1]]) {
          const [dx, dy] = axis
          let a = 0, b = 0, hitA = -1, hitB = -1
          for (let k = 1; k <= 12; k++) {
            if (hitA < 0) {
              const px = x + dx * k, py = y + dy * k
              if (px < 0 || py < 0 || px >= W || py >= H) hitA = k
              else if (built[py][px] >= 0) hitA = k
              else a = k
            }
            if (hitB < 0) {
              const px = x - dx * k, py = y - dy * k
              if (px < 0 || py < 0 || px >= W || py >= H) hitB = k
              else if (built[py][px] >= 0) hitB = k
              else b = k
            }
          }
          if (hitA > 0 && hitB > 0 && hitA <= 12 && hitB <= 12) {
            const widthTiles = hitA + hitB
            ratios.push(widthTiles)
          }
        }
      }
    }
    return {
      buildings: structs.length,
      frontageTotal, frontageBuilt,
      touching: touches.size,
      land, landBuilt,
      widths: ratios,
    }
  })
  if (!r) { console.log(`seed ${seed}: no terrain`); continue }
  rows.push({ seed, ...r })
  await win.waitForTimeout(150)
}
await app.close()

const pct = (a, b) => b === 0 ? 0 : Math.round((a / b) * 100)
const med = (arr) => {
  if (!arr.length) return NaN
  const s = [...arr].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

console.log('\n=== URBAN FORM ===')
console.log('seed      bldgs  frontage-built  party-walls  built-land  median street width')
console.log('-'.repeat(84))
for (const r of rows) {
  console.log(
    `${String(r.seed).padStart(8)}${String(r.buildings).padStart(7)}` +
    `${String(pct(r.frontageBuilt, r.frontageTotal) + '%').padStart(16)}` +
    `${String(pct(r.touching, r.buildings) + '%').padStart(13)}` +
    `${String(pct(r.landBuilt, r.land) + '%').padStart(12)}` +
    `${String((med(r.widths) * TILE).toFixed(0) + 'm').padStart(21)}`)
}

const all = rows.reduce((a, r) => ({
  b: a.b + r.buildings, ft: a.ft + r.frontageTotal, fb: a.fb + r.frontageBuilt,
  t: a.t + r.touching, l: a.l + r.land, lb: a.lb + r.landBuilt,
  w: a.w.concat(r.widths),
}), { b: 0, ft: 0, fb: 0, t: 0, l: 0, lb: 0, w: [] })

console.log('\nWHAT A REAL WALLED TOWN LOOKS LIKE, for comparison:')
console.log('  frontage with a building against it   ~85-95%   here: ' +
  pct(all.fb, all.ft) + '%')
console.log('  buildings sharing a party wall        ~60-80%   here: ' +
  pct(all.t, all.b) + '%')
console.log('  built coverage of non-street land     ~50-70%   here: ' +
  pct(all.lb, all.l) + '%')
console.log('  street width between facades          ~4-10m    here: ' +
  (med(all.w) * TILE).toFixed(0) + 'm')
