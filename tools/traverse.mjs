/**
 * TRAVERSE — can a PERSON actually get there?
 *
 * THE AXIS EVERY OTHER INSTRUMENT HERE IS MISSING.
 *
 * provenance grades the world against the CODE. odd grades a thing against its
 * PEERS. clash grades it against its NEIGHBOURS. facade grades geometry against
 * the TEXTURE painted on it. eyeball grades what fills the FRAME. Every one of
 * them grades the world against itself, and a bridge passed all five while
 * being unusable by a person: volumes inside their box, no interpenetration,
 * standing on the ground, faithful to its template, and a deck two metres over
 * your head.
 *
 * `spawn.mjs` is the only tool that models the player at all, and only for the
 * first frame. Nothing asks what happens on the second one.
 *
 * WHAT IT FOUND ON ITS FIRST RUN, which is why it exists: the collision mask
 * and the ground-follow are TWO AUTHORS OF ONE FLOOR and nothing had ever
 * introduced them. A previous session read the `passage` tag and cleared the
 * mask over bridges — so you may walk onto a bridge tile — and `sampleGroundY`
 * reads `terrainHeightMap` and nothing else, so once you are there you stand
 * on the river BED. Half a fix, and the missing half was invisible because no
 * instrument held the two halves up against each other. Exactly the shape of
 * the facade audit (FacadeTexture vs BuildingFactory) one system over.
 *
 * FOUR QUESTIONS, in rising order of what they can catch:
 *
 *   1. STANDING SURFACE — the mask says you may walk here; what are you
 *      actually standing on, and is it the surface the geometry drew?
 *   2. STEP — how far up is it between two adjacent walkable tiles?
 *   3. REACH — flood fill from the spawn with a step limit. This is the one
 *      that cannot be faked: no amount of scattering moves it, only a town
 *      that is genuinely connected.
 *   4. HEADROOM — what hangs over a tile you are meant to walk along?
 *
 * WHAT IT GRADES AGAINST, and this matters: a HUMAN, not the engine. The
 * engine has no step limit at all — `updateCamera` snaps the camera to
 * `sampleGroundY` every frame, so a player can silently ascend a cliff. That
 * is itself a finding and it is why "the engine allows it" is not the standard
 * here. A person can step a kerb, clamber a low wall, and cannot climb their
 * own height.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/traverse.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'

const argv = process.argv.slice(2)
const seeds = argv.filter((a) => /^\d+$/.test(a)).map(Number)
const showAll = argv.includes('--all')
if (!seeds.length) seeds.push(4242, 777, 31337)

// Pinned to a body, not to a tolerance somebody liked the look of.
// EYE_HEIGHT is 1.6 in ThreeRenderer; a 1.6m eye is roughly a 1.75m person.
const EYE = 1.6
const STEP_EASY = 0.45   // a kerb, a doorstep — you walk up it without thinking
const STEP_MAX = 0.60    // a clamber; above this a person stops and looks for stairs
const HEADROOM = 1.90    // stature plus a little, below which you duck or collide
const ON_IT = 0.30       // further than this below a drawn surface and you are not on it

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

let worstReach = 100, totalUnwalkable = 0, totalSteep = 0, totalLow = 0

for (const seed of seeds) {
  await win.evaluate((s) => {
    const inp = [...document.querySelectorAll('.left-panel input')]
      .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(inp, s); inp.dispatchEvent(new Event('input', { bubbles: true }))
  }, seed)
  await win.waitForTimeout(200)
  await win.getByRole('button', { name: /^generate$/i }).first().click()
  await win.waitForTimeout(2800)
  await win.getByRole('button', { name: '3D', exact: true }).click()
  await waitForScene(win)

  const data = await win.evaluate((K) => {
    const pt = window.__pt
    const r = pt.renderer()
    // TS `private` is compile-time only — the mask is reachable, and reading it
    // is the whole point: this tool exists to compare it against the ground.
    const mask = r?.collisionMask
    if (!mask) return { error: 'no collision mask — the 3D scene never built' }
    const W = r.gridW, H = r.gridH
    const st = pt.store.getState()
    const defs = new Map(st.objectDefinitions.map((d) => [d.id, d]))
    const layer = st.map.layers.find((l) => l.type === 'structure')
    const objs = layer?.objects ?? []
    const feats = pt.sceneFeatures()
    const terr = st.map.layers.find((l) => l.type === 'terrain').terrainTiles

    // Terrain surface at every tile centre — what sampleGroundY would give the
    // player standing there. heightAt speaks TILE coordinates (see scale.ts).
    const gnd = new Float32Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) gnd[y * W + x] = pt.heightAt(x + 0.5, y + 0.5)
    }
    const free = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 0

    /* --- 1. IS THE `passage` ACTUALLY PASSABLE? ----------------------- */
    // The tag clears the collision mask, which is a promise you can get
    // through here. So measure the way through: standing on each of its own
    // tiles, how much room is there between your feet and its own geometry?
    //
    // THE FIRST CUT OF THIS ASKED THE WRONG QUESTION. It took the structure's
    // widest volume as "the surface it meant you to walk on" and compared your
    // height to that — which is right for a bridge, whose deck IS that volume,
    // and nonsense for an archway, where the widest volume is the arch 20m
    // overhead and the way through is the hole underneath. It reported six
    // archways as having "a deck over your head". A heuristic that works on
    // the case you built it for is not yet a measurement.
    //
    // Clearance needs no such guess: a bridge you cannot pass reads 0.4m and
    // an archway you can walk through reads its full opening, with the same
    // arithmetic and no notion of what the thing is.
    const inBoxEarly = (v, wx, wz) => {
      const dx = wx - v.cx, dz = wz - v.cz
      const c = Math.cos(-v.yaw), s = Math.sin(-v.yaw)
      return Math.abs(dx * c - dz * s) <= v.hw && Math.abs(dx * s + dz * c) <= v.hd
    }
    const TILE0 = pt.TILE
    const passages = []
    for (const o of objs) {
      const d = defs.get(o.definitionId)
      if (!d?.tags?.includes('passage')) continue
      const f = o.footprint ?? d.footprint ?? { w: 1, h: 1 }
      const own = feats.volumes.filter((v) => v.id === o.id && v.role !== 'plinth' &&
        v.yaw !== undefined)
      let worst = Infinity, who = null, tiles = 0
      for (let dy = 0; dy < Math.max(1, f.h); dy++) {
        for (let dx = 0; dx < Math.max(1, f.w); dx++) {
          const gx = o.x + dx, gy = o.y + dy
          if (gx < 0 || gy < 0 || gx >= W || gy >= H) continue
          if (!free(gx, gy)) continue
          tiles++
          const g = gnd[gy * W + gx]
          const wx = (gx + 0.5) * TILE0, wz = (gy + 0.5) * TILE0
          for (const v of own) {
            if (v.y0 < g + 0.35 || v.y1 < g) continue
            if (v.y0 - g >= worst) continue
            if (!inBoxEarly(v, wx, wz)) continue
            worst = v.y0 - g; who = v.role
          }
        }
      }
      if (!tiles) continue
      passages.push({
        def: o.definitionId, x: o.x, y: o.y, tiles,
        clear: Number.isFinite(worst) ? +worst.toFixed(2) : null, who,
      })
    }

    /* --- 2. STEP between adjacent walkable tiles ---------------------- */
    const steps = []
    const steep = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!free(x, y)) continue
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const nx = x + dx, ny = y + dy
          if (!free(nx, ny)) continue
          const d = Math.abs(gnd[ny * W + nx] - gnd[y * W + x])
          steps.push(d)
          if (d > K.STEP_MAX) {
            // WHERE the step is decides what it means. A metre of rise inland
            // is a hill the streets should be following; a metre at the water
            // is the bank-to-bed drop, which is the bridge defect wearing a
            // different hat. "Cut off by terrain" is not an answer until you
            // know which.
            const wet = (a, b) => terr[b]?.[a] === 3
            const nearWater = [[x, y], [nx, ny]].some(([a, b]) =>
              wet(a, b) || wet(a + 1, b) || wet(a - 1, b) || wet(a, b + 1) || wet(a, b - 1))
            steep.push({ x, y, nx, ny, d: +d.toFixed(2), nearWater })
          }
        }
      }
    }

    /* --- 3. REACH — flood fill from the spawn, with a step limit ------ */
    // The camera has not been moved this run, so it is still at the spawn the
    // renderer chose. Grading from an arbitrary tile instead would answer a
    // question nobody is asking: the player starts HERE.
    const cam = pt.debugInfo().camera.position
    const TILE = pt.TILE
    let sx = Math.floor(cam.x / TILE), sy = Math.floor(cam.z / TILE)
    let walkable = 0
    for (let i = 0; i < W * H; i++) if (mask[i] === 0) walkable++
    const seen = new Uint8Array(W * H)
    const q = [[sx, sy]]
    if (free(sx, sy)) seen[sy * W + sx] = 1
    let reached = free(sx, sy) ? 1 : 0
    while (q.length) {
      const [x, y] = q.pop()
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy
        if (!free(nx, ny) || seen[ny * W + nx]) continue
        if (Math.abs(gnd[ny * W + nx] - gnd[y * W + x]) > K.STEP_MAX) continue
        seen[ny * W + nx] = 1; reached++; q.push([nx, ny])
      }
    }
    // CONTROL: the same flood fill with NO step limit. If reachability jumps,
    // the town is cut by TERRAIN; if it does not, the tiles are genuinely
    // disconnected in the mask and the step limit is innocent. Attributing a
    // number beats reporting one — and without this control I could not tell
    // "the river severs the town" from "I picked too tight a step".
    {
      const seen2 = new Uint8Array(W * H)
      const q2 = [[sx, sy]]
      if (free(sx, sy)) seen2[sy * W + sx] = 1
      var reachedFlat = free(sx, sy) ? 1 : 0
      while (q2.length) {
        const [x, y] = q2.pop()
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy
          if (!free(nx, ny) || seen2[ny * W + nx]) continue
          seen2[ny * W + nx] = 1; reachedFlat++; q2.push([nx, ny])
        }
      }
    }

    // The biggest place you cannot get to, and where it is.
    const comp = new Uint8Array(W * H)
    let biggest = null
    for (let y0 = 0; y0 < H; y0++) {
      for (let x0 = 0; x0 < W; x0++) {
        if (!free(x0, y0) || seen[y0 * W + x0] || comp[y0 * W + x0]) continue
        const st2 = [[x0, y0]]; comp[y0 * W + x0] = 1
        let n = 0, cxs = 0, cys = 0
        while (st2.length) {
          const [x, y] = st2.pop(); n++; cxs += x; cys += y
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy
            if (!free(nx, ny) || seen[ny * W + nx] || comp[ny * W + nx]) continue
            if (Math.abs(gnd[ny * W + nx] - gnd[y * W + x]) > K.STEP_MAX) continue
            comp[ny * W + nx] = 1; st2.push([nx, ny])
          }
        }
        if (!biggest || n > biggest.n) biggest = { n, x: Math.round(cxs / n), y: Math.round(cys / n) }
      }
    }

    /* --- 4. HEADROOM over a walkable tile ----------------------------- */
    // Oriented test, not the AABB. 55% of buildings carry an off-axis wobble
    // and the axis-aligned hull of a rotated box covers tiles the building is
    // not over — which would invent clearance problems, the same way it
    // inflated clash's interpenetration count.
    const inBox = (v, wx, wz) => {
      const dx = wx - v.cx, dz = wz - v.cz
      const c = Math.cos(-v.yaw), s = Math.sin(-v.yaw)
      return Math.abs(dx * c - dz * s) <= v.hw && Math.abs(dx * s + dz * c) <= v.hd
    }
    const solid = feats.volumes.filter((v) => v.role !== 'plinth' && v.yaw !== undefined)
    const low = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!free(x, y)) continue
        const g = gnd[y * W + x]
        const wx = (x + 0.5) * TILE, wz = (y + 0.5) * TILE
        let ceil = Infinity, who = null
        for (const v of solid) {
          // Only things ABOVE the floor can be a ceiling; a volume whose base
          // is at ground level beside you is a wall, and the mask owns walls.
          if (v.y0 < g + 0.35 || v.y1 < g) continue
          if (v.y0 - g >= ceil) continue
          if (!inBox(v, wx, wz)) continue
          ceil = v.y0 - g; who = `${v.def}:${v.role}`
        }
        if (ceil < K.HEADROOM) low.push({ x, y, clear: +ceil.toFixed(2), who })
      }
    }

    return {
      W, H, walkable, reached, reachedFlat, spawn: { x: sx, y: sy },
      passages,
      steps: steps.sort((a, b) => a - b),
      steep, biggest, low,
    }
  }, { STEP_MAX, HEADROOM })

  if (data.error) { console.log(`seed ${seed}: ${data.error}`); continue }
  const pct = (n, d) => `${((n / Math.max(1, d)) * 100).toFixed(0)}%`
  const at = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : 0)

  console.log(`\n=== TRAVERSE — seed ${seed}, ${data.W}x${data.H}, ` +
    `${data.walkable} walkable tiles ===`)
  console.log('Graded against a PERSON, not against the engine: updateCamera snaps')
  console.log('the camera to the ground every frame, so the engine itself permits')
  console.log(`climbing a cliff. A person steps ${STEP_EASY}m and clambers ${STEP_MAX}m.\n`)

  /* 1 */
  if (!data.passages.length) {
    console.log('IS THE CROSSING PASSABLE — no `passage` structures in this seed.')
  } else {
    const bad = data.passages.filter((p) => p.clear !== null && p.clear < HEADROOM)
    console.log(`IS THE CROSSING PASSABLE — ${data.passages.length} \`passage\` structures.`)
    console.log('The tag clears the collision mask, which is a promise you can get')
    console.log('through here. This is the room between your feet and its own geometry.')
    console.log('  type          tiles   clearance   under')
    const rows = data.passages.slice().sort((a, b) => (a.clear ?? 99) - (b.clear ?? 99))
    for (const p of rows.slice(0, showAll ? 999 : 8)) {
      const c = p.clear === null ? 'open' : `${p.clear.toFixed(2)}m`
      console.log(`  ${p.def.padEnd(13)} ${String(p.tiles).padStart(5)} ` +
        `${c.padStart(11)}   ${String(p.who ?? '-').padEnd(10)}` +
        (p.clear !== null && p.clear < EYE ? '  <-- you cannot get through' :
          p.clear !== null && p.clear < HEADROOM ? '  <-- you would duck' : ''))
    }
    console.log(`  ${bad.length} of ${data.passages.length} cannot be walked through ` +
      `at ${HEADROOM}m. "open" means nothing of its own is overhead.`)
    totalUnwalkable += bad.length
  }

  /* 2 */
  console.log(`\nSTEP between adjacent walkable tiles — ${data.steps.length} pairs:`)
  console.log(`  p50 ${at(data.steps, 0.5).toFixed(2)}m  p90 ${at(data.steps, 0.9).toFixed(2)}m  ` +
    `p99 ${at(data.steps, 0.99).toFixed(2)}m  max ${(data.steps[data.steps.length - 1] ?? 0).toFixed(2)}m`)
  const wetSteps = data.steep.filter((s) => s.nearWater).length
  console.log(`  over ${STEP_MAX}m (you would look for stairs): ${data.steep.length}` +
    (data.steep.length ? `  —  ${wetSteps} at the water's edge, ` +
      `${data.steep.length - wetSteps} inland` : ''))
  for (const s of data.steep.slice(0, showAll ? 999 : 4)) {
    console.log(`      ${s.d}m between (${s.x},${s.y}) and (${s.nx},${s.ny})`)
  }
  totalSteep += data.steep.length

  /* 3 */
  const reachPct = (data.reached / Math.max(1, data.walkable)) * 100
  worstReach = Math.min(worstReach, reachPct)
  console.log(`\nREACH from the spawn at (${data.spawn.x},${data.spawn.y}) — ` +
    `${data.reached} of ${data.walkable} walkable tiles, ${pct(data.reached, data.walkable)}.`)
  console.log(`  ignoring height entirely (mask connectivity alone): ` +
    `${pct(data.reachedFlat, data.walkable)}`)
  console.log(`  -> ${data.reachedFlat > data.reached
    ? `the ${STEP_MAX}m step limit costs ${pct(data.reachedFlat - data.reached, data.walkable)}` +
      ' — that much of the town is cut off by TERRAIN'
    : 'the step limit costs nothing; whatever is unreachable is disconnected in the MASK'}`)
  if (data.biggest) {
    console.log(`  largest place you cannot get to: ${data.biggest.n} tiles ` +
      `around (${data.biggest.x},${data.biggest.y})`)
  }
  console.log('  Cannot be faked by scattering — only a connected town moves it.')

  /* 4 */
  console.log(`\nHEADROOM over a walkable tile — under ${HEADROOM}m: ${data.low.length} tiles`)
  const byWho = new Map()
  for (const l of data.low) byWho.set(l.who, (byWho.get(l.who) ?? 0) + 1)
  for (const [who, n] of [...byWho.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
    const worst = Math.min(...data.low.filter((l) => l.who === who).map((l) => l.clear))
    console.log(`  ${String(n).padStart(4)} x  ${String(who).padEnd(28)} lowest ${worst.toFixed(2)}m`)
  }
  totalLow += data.low.length
}

// WHAT THIS TOOL CANNOT SEE, stated because the ones that do not say so get
// believed past their range. It samples tile CENTRES, so a 0.35m player disc
// clipping a corner between two clear centres is invisible; it uses the
// terrain height the engine uses, so anything that changes what you stand on
// (a future walkable deck) has to be taught to it; and step is measured
// between tile centres, which understates a sharp edge inside one tile.
console.log(`\nVERDICT: ${totalUnwalkable} crossings you cannot walk through,` +
  ` ${totalSteep} tile pairs need a clamber, ${totalLow} walkable tiles have` +
  ` under ${HEADROOM}m of headroom, worst reachability ${worstReach.toFixed(0)}%.`)
await app.close()
process.exit(totalUnwalkable ? 1 : 0)
