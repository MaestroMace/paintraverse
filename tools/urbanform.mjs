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

    // --- FRONTAGE BY SIDE ----------------------------------------------
    // Footprints extend +X/+Y from their origin tile, so a building can only
    // butt against a road lying to its NORTH or WEST — a road to the south or
    // east would be overlapped by the building's own footprint and the
    // placement is rejected. If that asymmetry is real, frontage occupancy
    // splits by side, and half of every street is structurally set back.
    const bySide = { N: [0, 0], S: [0, 0], E: [0, 0], W: [0, 0] }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isRoad(x, y)) continue
        const dirs = [[0, -1, 'N'], [0, 1, 'S'], [1, 0, 'E'], [-1, 0, 'W']]
        for (const [dx, dy, name] of dirs) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          if (isRoad(nx, ny) || isWater(nx, ny)) continue
          bySide[name][1]++
          if (built[ny][nx] >= 0) bySide[name][0]++
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
    // For each road tile, scan ACROSS the street until a building is hit.
    // Enclosure = storeys / street width, the classic height-to-width ratio.
    // A comfortable street is 0.5-1.5; below ~0.25 the space reads as a field
    // with things around the edge.
    //
    // "Across" has to mean across. The first version of this scanned BOTH the
    // [1,0] and [0,1] axes at every road tile regardless of which way the road
    // ran, so half of every sample measured the length of the street rather
    // than its width — and near the map edge the out-of-bounds hit turned that
    // into a legitimate-looking 12-tile "width". The road's local direction is
    // cheap to recover from its own neighbours, so recover it.
    const ratios = []
    // Setback = how far the wall stands back from the road edge, per side.
    // 0 means the building is flush against the carriageway. This is the
    // number the street-width figure is actually made of, and it is the one a
    // placement change moves; width also carries the road's own width, which
    // is set by the road carver and already known.
    const setbacks = []
    const roadWidths = []
    let openSides = 0, sideSamples = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!isRoad(x, y)) continue
        // Which way does the street RUN here? Not "is there road beside me" —
        // every tile of a 2-lane street has road on both axes and that test
        // classifies the entire street as a junction, leaving only 1-wide
        // alleys in the sample. Measure the contiguous run in each axis
        // instead: a 2-wide north-south street runs 2 across and 20 along, so
        // the longer run is the street and the shorter one is its width.
        const run = (dx, dy) => {
          let n = 1
          for (let k = 1; k <= 24 && isRoad(x + dx * k, y + dy * k); k++) n++
          for (let k = 1; k <= 24 && isRoad(x - dx * k, y - dy * k); k++) n++
          return n
        }
        const runX = run(1, 0), runY = run(0, 1)
        // A square or a crossing runs the same distance both ways and is
        // legitimately open; only measure a tile that is clearly a corridor.
        if (Math.abs(runX - runY) < 2) continue
        const [dx, dy] = runX > runY ? [0, 1] : [1, 0]   // perpendicular to the run
        let hitA = -1, hitB = -1
        for (let k = 1; k <= 12; k++) {
          if (hitA < 0) {
            const px = x + dx * k, py = y + dy * k
            if (px < 0 || py < 0 || px >= W || py >= H) hitA = k
            else if (built[py][px] >= 0) hitA = k
          }
          if (hitB < 0) {
            const px = x - dx * k, py = y - dy * k
            if (px < 0 || py < 0 || px >= W || py >= H) hitB = k
            else if (built[py][px] >= 0) hitB = k
          }
        }
        // Setback counts only the non-road tiles between carriageway and wall,
        // so a house flush against the kerb scores 0 whatever the road's width.
        for (const [hit, sx, sy] of [[hitA, dx, dy], [hitB, -dx, -dy]]) {
          sideSamples++
          if (hit < 0) { openSides++; continue }
          let gap = 0
          for (let k = 1; k < hit; k++) if (!isRoad(x + sx * k, y + sy * k)) gap++
          setbacks.push(gap)
        }
        if (hitA > 0 && hitB > 0) {
          // Split the width into the two terms that produce it, because they
          // have different owners: the carriageway belongs to the road carver
          // and the setback to the placer. A single total cannot tell you
          // which one to go and change.
          let road = 0
          for (let k = 1; k < hitA; k++) if (isRoad(x + dx * k, y + dy * k)) road++
          for (let k = 1; k < hitB; k++) if (isRoad(x - dx * k, y - dy * k)) road++
          roadWidths.push(road + 1)   // + the tile we are standing on
          ratios.push(hitA + hitB)
        }
      }
    }
    return {
      buildings: structs.length,
      frontageTotal, frontageBuilt,
      touching: touches.size,
      land, landBuilt,
      widths: ratios,
      setbacks, roadWidths, openSides, sideSamples,
      bySide,
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
  w: a.w.concat(r.widths), sb: a.sb.concat(r.setbacks),
  rw: a.rw.concat(r.roadWidths),
  open: a.open + r.openSides, sides: a.sides + r.sideSamples,
}), { b: 0, ft: 0, fb: 0, t: 0, l: 0, lb: 0, w: [], sb: [], rw: [], open: 0, sides: 0 })

// SETBACK is the term the placer owns. Street width = road width + both
// setbacks, and the road carver already fixed the first part, so this is the
// only half a placement change can move. Printed as a distribution because
// "median 2" hides "a third of the town stands 5 tiles back".
{
  const dist = (arr, label) => {
    const s = [...arr].sort((a, b) => a - b)
    const q = (p) => s.length ? s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))] : NaN
    const m = (v) => (v * TILE).toFixed(1).padStart(6) + 'm'
    console.log(`  ${label.padEnd(22)} med${m(q(50))}  p75${m(q(75))}  p90${m(q(90))}` +
      `  max${m(s[s.length - 1] ?? 0)}`)
  }
  const flush = all.sb.filter((v) => v === 0).length
  console.log('\nWHAT THE STREET WIDTH IS MADE OF (width = carriageway + both setbacks):')
  dist(all.rw, 'carriageway')
  dist(all.sb, 'setback, per side')
  dist(all.w, 'facade to facade')
  console.log(`  ${all.sb.length} side samples; flush against the kerb ` +
    `${pct(flush, all.sb.length)}%; no wall within 12 tiles ${pct(all.open, all.sides)}%`)
}

// Frontage occupancy split by which side of the road the land is on. Roughly
// equal means the placer is symmetric; a big N/W vs S/E gap means the
// top-left footprint anchor is structurally setting back half of every street.
const sides = { N: [0, 0], S: [0, 0], E: [0, 0], W: [0, 0] }
for (const r of rows) {
  for (const k of ['N', 'S', 'E', 'W']) {
    sides[k][0] += r.bySide[k][0]
    sides[k][1] += r.bySide[k][1]
  }
}
console.log('\nFRONTAGE OCCUPANCY BY SIDE (is the placer symmetric?):')
for (const k of ['N', 'S', 'E', 'W']) {
  console.log(`  land ${k} of the road: ${String(pct(sides[k][0], sides[k][1]) + '%').padStart(5)}` +
    `   (${sides[k][1]} edges)`)
}

console.log('\nWHAT A REAL WALLED TOWN LOOKS LIKE, for comparison:')
console.log('  frontage with a building against it   ~85-95%   here: ' +
  pct(all.fb, all.ft) + '%')
console.log('  buildings sharing a party wall        ~60-80%   here: ' +
  pct(all.t, all.b) + '%')
console.log('  built coverage of non-street land     ~50-70%   here: ' +
  pct(all.lb, all.l) + '%')
console.log('  street width between facades          ~4-10m    here: ' +
  (med(all.w) * TILE).toFixed(0) + 'm')
