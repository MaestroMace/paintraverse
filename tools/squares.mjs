/**
 * SQUARES — is the open space a room, or a gap?
 *
 * Lynch's NODE is the fourth of his five elements and the one we have not
 * built. A node is where paths converge and you stop; a square is the built
 * form of one. Sitte spent a book on why medieval squares work and
 * nineteenth-century ones do not, and his conclusions are testable:
 *
 *   ENCLOSURE — a square must be walled. Sitte's central observation is that
 *     the pleasure of a piazza comes from being INSIDE something, and that
 *     modern squares fail by opening at the corners until the space leaks
 *     away. Measure the share of a square's boundary that is building.
 *
 *   OPENINGS AT THE CORNERS — streets should enter at the corners, not
 *     through the middle of a side. A street entering mid-side punches a hole
 *     in the wall you are standing inside; entering at a corner, the far side
 *     still reads as continuous from almost everywhere in the square.
 *
 *   SIZE — Alexander #61 puts a square people actually use at around 20m
 *     across, far smaller than designers reach for. Sitte's proportion rule is
 *     that the minor dimension wants to be one to three times the height of
 *     the buildings around it.
 *
 * A square is DEFINED here as a connected patch of paved ground with no
 * building on it, big enough and compact enough not to be a street. That is
 * deliberately a definition the player could apply: it does not ask the
 * generator what it MEANT, it asks what is actually there. A carriageway
 * junction that has grown into an open expanse is a square by this test, and
 * it should be — the player cannot tell it was an accident.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/squares.mjs [seeds...]
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
    const PAVED = new Set([2, 8, 9, 14, 15, 16])
    const isPaved = (x, y) => PAVED.has(terrain[y]?.[x])
    const isStreet = (x, y) => { const t = terrain[y]?.[x]; return t === 8 || t === 9 }

    const built = Array.from({ length: H }, () => new Int16Array(W).fill(-1))
    for (const o of structs) {
      const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
      const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
      for (let dy = 0; dy < f.h; dy++) {
        for (let dx = 0; dx < f.w; dx++) {
          const px = o.x + dx, py = o.y + dy
          if (px >= 0 && py >= 0 && px < W && py < H) built[py][px] = 1
        }
      }
    }
    const open = (x, y) => isPaved(x, y) && built[y][x] < 0

    const seen = Array.from({ length: H }, () => new Uint8Array(W))
    const squares = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (seen[y][x] || !open(x, y)) continue
        const cells = []
        const q = [[x, y]]; seen[y][x] = 1
        let minX = x, maxX = x, minY = y, maxY = y
        for (let i = 0; i < q.length; i++) {
          const [cx, cy] = q[i]
          cells.push([cx, cy])
          if (cx < minX) minX = cx; if (cx > maxX) maxX = cx
          if (cy < minY) minY = cy; if (cy > maxY) maxY = cy
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            if (seen[ny][nx] || !open(nx, ny)) continue
            seen[ny][nx] = 1; q.push([nx, ny])
          }
        }
        // A square is compact. A street network is one huge sprawling
        // component of open paving, so tell them apart by SHAPE: find the
        // largest solid rectangle-ish core rather than trusting the bbox,
        // which a street network fills at 5%.
        const bw = maxX - minX + 1, bh = maxY - minY + 1
        squares.push({ cells, minX, minY, bw, bh, area: cells.length })
      }
    }

    // Now extract the SQUARE-LIKE parts. Erode each component: a tile that has
    // open ground all around it at radius 2 is "deep" open space. Connected
    // groups of deep tiles are the cores of squares; a 2-wide street has no
    // deep tiles at all, which is exactly the discrimination wanted.
    const deep = Array.from({ length: H }, () => new Uint8Array(W))
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        let ok = 1
        for (let dy = -2; dy <= 2 && ok; dy++) {
          for (let dx = -2; dx <= 2 && ok; dx++) {
            if (!open(x + dx, y + dy)) ok = 0
          }
        }
        deep[y][x] = ok
      }
    }
    const dseen = Array.from({ length: H }, () => new Uint8Array(W))
    const found = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (dseen[y][x] || !deep[y][x]) continue
        const core = []
        const q = [[x, y]]; dseen[y][x] = 1
        for (let i = 0; i < q.length; i++) {
          const [cx, cy] = q[i]
          core.push([cx, cy])
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            if (dseen[ny][nx] || !deep[ny][nx]) continue
            dseen[ny][nx] = 1; q.push([nx, ny])
          }
        }
        if (core.length < 2) continue
        // Grow the core back out over open ground to recover the whole square.
        const inSq = new Set(core.map(([a, b]) => b * W + a))
        let frontier = [...core]
        for (let ring = 0; ring < 3; ring++) {
          const next = []
          for (const [cx, cy] of frontier) {
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = cx + dx, ny = cy + dy
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
              const k = ny * W + nx
              if (inSq.has(k) || !open(nx, ny)) continue
              inSq.add(k); next.push([nx, ny])
            }
          }
          frontier = next
        }
        // ENCLOSURE BY LINE OF SIGHT, from the middle of the square.
        //
        // The first version classified the tiles just outside the grown patch
        // as building / street / other. That measures the edge of an
        // arbitrary 3-ring growth, not the edge of the square — and since the
        // one-material-per-place change made a square and its apron
        // contiguous paving, the "boundary" often fell in the middle of more
        // paving and scored as open. It reported 33% enclosure and would not
        // move however the town changed, which is the signature of a metric
        // measuring its own construction.
        //
        // Stand in the square instead and look around. Cast rays from the
        // centroid; a ray is enclosed if it meets a building before it has
        // travelled further than a square is wide. That is what "being inside
        // a room" means, it cannot be faked by paving, and it is the same
        // measure-from-where-the-player-stands rule as the rest of the audits.
        let cxs = 0, cys = 0
        for (const k of inSq) { cxs += k % W; cys += (k / W) | 0 }
        const ccx = cxs / inSq.size, ccy = cys / inSq.size
        const RAYS = 36, REACH = 9      // 27m — beyond that you are not in a room
        let hits = 0
        for (let a = 0; a < RAYS; a++) {
          const th = (a / RAYS) * Math.PI * 2
          const dx = Math.cos(th), dy = Math.sin(th)
          for (let t = 1; t <= REACH; t++) {
            const nx = Math.round(ccx + dx * t), ny = Math.round(ccy + dy * t)
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) break
            if (built[ny][nx] >= 0) { hits++; break }
          }
        }
        const sightEnclosure = hits / RAYS

        // Boundary classification. Walk every tile just OUTSIDE the square.
        let bBuilt = 0, bStreet = 0, bOther = 0
        const streetCells = []
        const bound = new Set()
        for (const k of inSq) {
          const cx = k % W, cy = (k / W) | 0
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            const nk = ny * W + nx
            if (inSq.has(nk) || bound.has(nk)) continue
            bound.add(nk)
            if (built[ny][nx] >= 0) bBuilt++
            else if (isStreet(nx, ny) || open(nx, ny)) { bStreet++; streetCells.push([nx, ny]) }
            else bOther++
          }
        }
        const bTotal = bBuilt + bStreet + bOther
        if (bTotal === 0) continue
        // How many separate street mouths? Connected runs of boundary street.
        const scSet = new Set(streetCells.map(([a, b]) => b * W + a))
        const scSeen = new Set()
        let mouths = 0
        for (const [sx, sy] of streetCells) {
          const k0 = sy * W + sx
          if (scSeen.has(k0)) continue
          mouths++
          const qq = [[sx, sy]]; scSeen.add(k0)
          for (let i = 0; i < qq.length; i++) {
            const [cx, cy] = qq[i]
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = cx + dx, ny = cy + dy
                const nk = ny * W + nx
                if (!scSet.has(nk) || scSeen.has(nk)) continue
                scSeen.add(nk); qq.push([nx, ny])
              }
            }
          }
        }
        let sMinX = W, sMinY = H, sMaxX = 0, sMaxY = 0
        for (const k of inSq) {
          const cx = k % W, cy = (k / W) | 0
          if (cx < sMinX) sMinX = cx; if (cx > sMaxX) sMaxX = cx
          if (cy < sMinY) sMinY = cy; if (cy > sMaxY) sMaxY = cy
        }
        const w = sMaxX - sMinX + 1, h2 = sMaxY - sMinY + 1
        found.push({
          area: inSq.size, w, h: h2,
          minor: Math.min(w, h2),
          enclosure: sightEnclosure,
          edgeBuilt: bBuilt / bTotal,
          streetShare: bStreet / bTotal,
          mouths,
        })
      }
    }
    // Explain a zero. "No squares" can mean the town has no open space, or
    // that it has plenty but none of it is deep enough to be a room, and those
    // are opposite problems. Counting only the answer leaves you guessing —
    // so report the ingredients too.
    let openTiles = 0, deepTiles = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (open(x, y)) openTiles++
      if (deep[y][x]) deepTiles++
    }
    return { squares: found, openTiles, deepTiles }
  })
  if (!r) { console.log(`seed ${seed}: no terrain`); continue }
  rows.push({ seed, ...r })
  await win.waitForTimeout(150)
}
await app.close()

const all = rows.flatMap((r) => r.squares)
const pct = (a, b) => (b === 0 ? 0 : Math.round((a / b) * 100))
console.log('\n=== SQUARES — open paved space that is not a street ===')
console.log('seed     squares   median size      median enclosure   median mouths')
console.log('-'.repeat(72))
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN }
for (const r of rows) {
  const s = r.squares
  console.log(`${String(r.seed).padStart(7)}${String(s.length).padStart(10)}` +
    `${String((med(s.map((q) => q.minor)) * TILE).toFixed(0) + 'm').padStart(14)}` +
    `${String(Math.round(med(s.map((q) => q.enclosure)) * 100) + '%').padStart(19)}` +
    `${String(med(s.map((q) => q.mouths))).padStart(16)}` +
    `   [open ${r.openTiles}, deep ${r.deepTiles}]`)
}
console.log('-'.repeat(72))
if (all.length) {
  const encl = all.map((q) => q.enclosure)
  const walled = all.filter((q) => q.enclosure >= 0.6).length
  console.log(`\nENCLOSURE — can you see a wall from the middle of the square?`)
  console.log(`  median ${Math.round(med(encl) * 100)}%   ` +
    `squares at least 60% walled: ${walled} of ${all.length} (${pct(walled, all.length)}%)`)
  console.log(`  Sitte's point: a square is a room. Below ~60% it is a widening.`)
  console.log(`  (rays from the square's centre that meet a facade within 27m)`)
  console.log(`\nSIZE — minor dimension (Alexander #61 wants ~20m; Sitte 1-3x facade height)`)
  const minors = all.map((q) => q.minor * TILE)
  console.log(`  median ${med(minors).toFixed(0)}m   biggest ${Math.max(...minors).toFixed(0)}m` +
    `   over 40m: ${all.filter((q) => q.minor * TILE > 40).length}`)
  console.log(`\nMOUTHS — separate street openings onto the square`)
  console.log(`  median ${med(all.map((q) => q.mouths))}   ` +
    `open share of boundary: median ${Math.round(med(all.map((q) => q.streetShare)) * 100)}%`)
} else {
  console.log('\nNo squares found at all — every open space is street-shaped.')
}
