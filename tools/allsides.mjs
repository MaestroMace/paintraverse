/**
 * ALL SIDES — is this a building, or a facade with three blank walls?
 *
 * Reported: "many of these assets are planned for one direction of visibility,
 * and every other angle makes the world look like a back alley. Theme parks
 * are interesting from every vantage point."
 *
 * That is structurally true of this codebase and CLAUDE.md half-says it
 * already: every front-attached detail — shop signs, awnings, stoops,
 * doorsteps, benches, hitching posts, colonnades, balconies, wall lanterns —
 * hangs off `frontWallZ` and `frontWallHalfW`, derived from the building's
 * road-facing side. There is no equivalent anchor for the other three walls,
 * so by construction the dressing budget is spent on one face.
 *
 * It is also the Imagineering rule the project has not applied. Disney hides
 * backstage COMPLETELY; anything a guest can see is finished from every angle,
 * because a guest walks round things. A player in a walkaround does the same.
 *
 * ── WHY THIS TOOL SHOOTS FOUR SIDES AND NOT TWO ──────────────────────────
 *
 * The first version photographed the road side and the OPPOSITE side only,
 * and read a comfortable 0.79 — which is true and useless, because those are
 * the two walls that are FINE. `emitVolume` builds each volume as a
 * BoxGeometry with the material array
 *
 *     [plain, plain, plain, plain, facade, facade]
 *      +X     -X     +Y     -Y     +Z      -Z
 *
 * so +Z and -Z both carry the painted facade and the two FLANKS (±X) are a
 * single flat colour with no openings at all. A front-vs-back metric is
 * blind to the defect by construction: it grades the pair that matches and
 * never looks at the pair that doesn't. This is the CLAUDE.md rule about
 * proxies in its other form — the sampled sides agreed with the target right
 * up until you asked which sides were actually broken.
 *
 * ── AND WHY IT SKIPS SIDES YOU CANNOT STAND ON ───────────────────────────
 *
 * 93% of buildings here share a party wall. A flank buried against a
 * neighbour is legitimately backstage — Disney's rule is that anything a
 * guest CAN see is finished, not that every surface is. So a side is only
 * graded when the camera position is a tile the player could actually
 * occupy. Grading unreachable walls would swamp the number with frames that
 * are pressed against a neighbour and read near zero whatever we build.
 *
 * DETAIL is measured as edge density: the share of pixels that differ sharply
 * from the pixel to their right. A blank wall is a flat field and scores near
 * zero; a wall with a door, a window row, a lintel and a string course scores
 * high. The comparison is PAIRED per building, which cancels out size, colour
 * and whatever happens to be standing behind it.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/allsides.mjs [seed] [--n=30]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 4242)
const nArg = argv.find((a) => a.startsWith('--n='))
const N = nArg ? Number(nArg.split('=')[1]) : 30
const SAVE = argv.includes('--save')
if (SAVE) mkdirSync('.shots/allsides', { recursive: true })

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)
await win.evaluate((s) => {
  const inp = [...document.querySelectorAll('.left-panel input')]
    .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, s)
  inp.dispatchEvent(new Event('input', { bubbles: true }))
}, seed)
await win.waitForTimeout(200)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2800)
await win.getByRole('button', { name: '3D', exact: true }).click()
await win.waitForTimeout(2600)
// Noon: a dusk frame is mostly silhouette, and silhouette hides exactly the
// surface detail this tool is trying to count.
await win.evaluate(() => window.__pt.store.getState().updateEnvironment({ timeOfDay: 12 }))
await win.waitForTimeout(900)
await win.evaluate(() => {
  const h = document.querySelector('.walk-hint')
  if (h) h.style.display = 'none'
})

// Buildings that HAVE a recorded road side, spread across the town so the
// sample is not one terrace. Each target carries the four camera stations it
// wants shot, with the unreachable ones already dropped — that decision needs
// the occupancy map, and the page is where the map lives.
const targets = await win.evaluate((n) => {
  const st = window.__pt.store.getState()
  const defs = st.objectDefinitions
  const map = st.map
  const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
  const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
  const H = terrain.length, W = terrain[0].length
  const fpOf = (o) => {
    const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
    return o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
  }
  const built = Array.from({ length: H }, () => new Uint8Array(W))
  for (const o of structs) {
    const f = fpOf(o)
    for (let dy = 0; dy < f.h; dy++) {
      for (let dx = 0; dx < f.w; dx++) {
        const px = o.x + dx, py = o.y + dy
        if (px >= 0 && py >= 0 && px < W && py < H) built[py][px] = 1
      }
    }
  }
  // A camera station is usable when a player could stand there: on the map,
  // not inside a footprint, not in the river.
  const standable = (tx, tz) => {
    const ix = Math.floor(tx), iz = Math.floor(tz)
    if (ix < 0 || iz < 0 || ix >= W || iz >= H) return false
    return built[iz][ix] === 0 && terrain[iz][ix] !== 3
  }
  const SIDE_DIR = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }
  const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' }

  const ok = structs.filter((o) => o.properties?.roadSide &&
    (o.properties?.floors ?? 1) >= 2)
  const step = Math.max(1, Math.floor(ok.length / n))
  const out = []
  for (let i = 0; i < ok.length && out.length < n; i += step) {
    const o = ok[i]
    const f = fpOf(o)
    const cx = o.x + f.w / 2, cz = o.y + f.h / 2
    const reach = Math.max(f.w, f.h)
    const dist = 2.2 + reach * 0.6
    const road = o.properties.roadSide
    const stations = []
    for (const [side, [dx, dz]] of Object.entries(SIDE_DIR)) {
      const camX = cx + dx * dist, camZ = cz + dz * dist
      if (!standable(camX, camZ)) continue
      stations.push({
        side,
        // 'front' = the wall the road is on; 'back' = directly opposite it;
        // 'flank' = the two walls at right angles, which is where the plain
        // material lives.
        role: side === road ? 'front' : (side === OPPOSITE[road] ? 'back' : 'flank'),
        camX, camZ,
        yaw: Math.atan2(cz - camZ, cx - camX),
      })
    }
    // Only worth shooting if we can see the road side AND at least one other,
    // otherwise there is nothing to pair against.
    if (!stations.some((s) => s.role === 'front')) continue
    if (stations.length < 2) continue
    out.push({ id: o.definitionId, road, stations })
  }
  return out
}, N)

const results = []
for (let i = 0; i < targets.length; i++) {
  const t = targets[i]
  const shot = {}
  for (const st of t.stations) {
    const r = await win.evaluate(async (a) => {
      const pt = window.__pt
      const three = pt.renderer()
      const gl = three?.renderer, scene = three?.scene, cam = three?.camera
      if (!gl || !scene || !cam) return null
      const g = pt.heightAt(a.camX, a.camZ) ?? 0
      pt.flyTo(a.camX, g + 2.2, a.camZ, a.yaw, 0.12)
      for (let k = 0; k < 5; k++) await new Promise((r2) => requestAnimationFrame(r2))
      await new Promise((r2) => setTimeout(r2, 140))
      gl.render(scene, cam)
      const src = gl.domElement
      const W = src.width, H = src.height
      const c = document.createElement('canvas')
      c.width = W; c.height = H
      const ctx = c.getContext('2d')
      ctx.drawImage(src, 0, 0)
      const px = ctx.getImageData(0, 0, W, H).data
      // Central band only: the building fills the middle of the frame, and
      // the edges are its neighbours.
      const x0 = Math.floor(W * 0.3), x1 = Math.floor(W * 0.7)
      const y0 = Math.floor(H * 0.15), y1 = Math.floor(H * 0.75)
      let edges = 0, total = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1 - 1; x++) {
          const o = (y * W + x) * 4, o2 = (y * W + x + 1) * 4
          total++
          const d2 = Math.abs(px[o] - px[o2]) + Math.abs(px[o + 1] - px[o2 + 1]) +
            Math.abs(px[o + 2] - px[o2 + 2])
          if (d2 > 34) edges++
        }
      }
      return { density: total ? edges / total : 0,
        png: a.save ? c.toDataURL('image/png') : null }
    }, { camX: st.camX, camZ: st.camZ, yaw: st.yaw, save: SAVE })
    if (!r) continue
    // Two flanks per building; keep them both and average at the end.
    ;(shot[st.role] ??= []).push(r.density)
    if (SAVE && r.png) {
      writeFileSync(`.shots/allsides/${i}-${st.role}-${st.side}.png`,
        Buffer.from(r.png.split(',')[1], 'base64'))
    }
  }
  if (!shot.front) continue
  const avg = (xs) => (xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  results.push({
    id: t.id, road: t.road,
    front: avg(shot.front),
    back: avg(shot.back),
    flank: avg(shot.flank),
    flanks: (shot.flank ?? []).length,
  })
}
await app.close()

const pct = (v) => (v === null || v === undefined ? '    —' : `${(v * 100).toFixed(1)}%`)
const rat = (a, b) => (a === null || a === undefined || !b ? '   —' : (a / b).toFixed(2))

console.log(`\n=== ALL SIDES — seed ${seed}, ${results.length} buildings, four faces each ===\n`)
console.log('building              road   front     back    flank    back/f  flank/f')
console.log('-'.repeat(76))
for (const r of results) {
  console.log(`${r.id.padEnd(21)}${r.road.padStart(4)}` +
    `${pct(r.front).padStart(9)}${pct(r.back).padStart(9)}${pct(r.flank).padStart(9)}` +
    `${rat(r.back, r.front).padStart(10)}${rat(r.flank, r.front).padStart(9)}`)
}
console.log('-'.repeat(76))

// Only frames where the camera actually FRAMED something. A frame that is all
// sky, or pressed against a neighbouring wall, reads near 0% on every side and
// contributes a meaningless ratio — several such pairs dragged the first
// version of this aggregate around by a tenth with no code change behind it.
const usable = results.filter((r) => r.front > 0.01)
if (usable.length < 6) {
  console.log(`\nONLY ${usable.length} USABLE BUILDINGS — too few to conclude anything.`)
  console.log('Raise --n. A building is usable when its road-side frame actually')
  console.log('has a building in it.')
}
const med = (xs) => {
  const s = xs.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const mean = (xs) => {
  const s = xs.filter((v) => v !== null && v !== undefined)
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0
}
const withBack = usable.filter((r) => r.back !== null)
const withFlank = usable.filter((r) => r.flank !== null)

console.log(`\nusable buildings: ${usable.length} of ${results.length}` +
  `   (with a reachable back: ${withBack.length}, with a reachable flank: ${withFlank.length})`)
console.log(`mean detail, ROAD side:   ${(mean(usable.map((r) => r.front)) * 100).toFixed(1)}%`)
console.log(`mean detail, BACK wall:   ${(mean(withBack.map((r) => r.back)) * 100).toFixed(1)}%`)
console.log(`mean detail, FLANK walls: ${(mean(withFlank.map((r) => r.flank)) * 100).toFixed(1)}%`)
console.log(`\nBACK / FRONT    median ${med(withBack.map((r) => r.back / r.front)).toFixed(2)}` +
  `    mean ${(mean(withBack.map((r) => r.back)) / (mean(withBack.map((r) => r.front)) || 1)).toFixed(2)}`)
console.log(`FLANK / FRONT   median ${med(withFlank.map((r) => r.flank / r.front)).toFixed(2)}` +
  `    mean ${(mean(withFlank.map((r) => r.flank)) / (mean(withFlank.map((r) => r.front)) || 1)).toFixed(2)}`)
console.log(`  1.00 means a wall is as worth looking at as the building's front.`)
console.log(`\nOnly walls a player could WALK TO are graded — a flank buried against`)
console.log(`a party wall is legitimately backstage, and grading it would bury the`)
console.log(`signal under frames that read near zero whatever we build.`)
console.log(`\nNOTE ON SENSITIVITY: this cannot grade a rare feature. Ivy is 4% of`)
console.log(`buildings, so a 14-building sample contains roughly none of it and the`)
console.log(`aggregate moved a tenth on pure noise when it was moved to the back`)
console.log(`walls. The same 14-sample run read back/front 0.28 where 30 reads 0.79.`)
console.log(`Use this for changes that touch MOST buildings, and watch the count.`)
console.log('Theme parks finish everything a guest can walk around. A player in a')
console.log('walkaround walks around everything.')
