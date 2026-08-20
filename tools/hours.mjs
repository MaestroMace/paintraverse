/**
 * HOURS — the tone of all four lighting branches, side by side.
 *
 * `updateLighting` is a switch with four arms — night, dusk, golden, day —
 * and this repo has now been bitten by that shape twice in one week:
 *
 *   · The tone arc raised ambient 0.42 -> 0.62 and hemisphere 0.52 -> 0.95
 *     with a correct argument about skylight, took every measurement at
 *     NOON, and therefore edited the noon arm. Dusk kept the pre-arc numbers
 *     for the whole arc that followed, and CLAUDE.md recorded the resulting
 *     0.058 wall as a regression it could not attribute.
 *   · Graded for the first time afterwards, NIGHT read sky 0.005 / wall 0.000
 *     with 90% of wall pixels black — a black screen with windows floating in
 *     it — and GOLDEN, which is the brighter neighbour of dusk with the sun
 *     still well up, carried barely half its skylight.
 *
 * Both are the same failure: each arm was only ever edited while somebody was
 * measuring at that arm's own hour. `eyeball.mjs` grades ONE hour, which is
 * the right call for the design's test view and is exactly why the other
 * three could rot unwatched. This tool exists to make that impossible.
 *
 * WHAT IT ASKS, and the second question is the one a person actually notices:
 *
 *   1. Is any surface class effectively BLACK at this hour? Absolute luma,
 *      against eyeball's existing 0.06 "reads black" line rather than a new
 *      constant.
 *   2. IS THE SKY BRIGHTER THAN THE BUILDINGS? DESIGN.md pillar 1 is warm
 *      windows against dark SILHOUETTES, and a silhouette needs something to
 *      be silhouetted against. At night the sky measured 0.005 and the
 *      buildings 0.000, so there were no silhouettes at all — and while
 *      fixing it, an over-strong hemisphere term inverted the relationship
 *      the other way, lifting the STREET to 0.165 against a 0.022 sky. Both
 *      failures are invisible to a per-surface tone table read one hour at a
 *      time, and both are obvious the moment the four rows sit together.
 *
 * IT LOOKS UP, and the first run is why. Pointed level at eye height, 394 of
 * 400 rays landed on a wall — a 12m street between 10m buildings IS wall from
 * edge to edge — so the sky column read 0.000 on all four branches and the
 * silhouette test printed "no sky" and counted zero failures. A green board
 * that had not looked at anything. Pitched up 9 degrees the roofline comes
 * into frame with the sky above it, which is where a silhouette is and the
 * angle every phone screenshot that reported one was taken from; `anomaly.mjs`
 * and walkshots' `gable-up` are here for the same reason. A branch that cannot
 * supply enough sky samples now FAILS rather than passing quietly.
 *
 * Deliberately cheap: a few views per hour and a coarse ray grid, because this
 * is a tripwire and not a portrait. `eyeball.mjs` remains the detailed read
 * at the design's own hour; if a row here moves, go and run that.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/hours.mjs [seed] [--views=N]
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome } from './lib/vantage.mjs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 31337)
const viewsArg = argv.find((a) => a.startsWith('--views='))
const VIEWS = viewsArg ? Number(viewsArg.split('=')[1]) : 4
/**
 * Up 9 degrees. Level put 98.5% of the frame on a wall and left the silhouette
 * test with nothing to test; this keeps the horizon in the lower third of a
 * 70-degree frame, so ground, wall, roof AND sky are all sampled from one
 * vantage. Any more and the ground leaves frame.
 */
const PITCH = 0.16
/** Fewer sky samples than this and the branch is unmeasured, not clean. */
const MIN_SKY = 8

// One hour per branch of the switch, named for the branch rather than for the
// clock so a boundary change shows up here as a renamed row instead of
// silently regrading the same arm twice.
const HOURS = [
  { h: 22, name: 'night' },
  { h: 18.5, name: 'dusk' },
  { h: 16, name: 'golden' },
  { h: 12, name: 'day' },
]
/** eyeball.mjs's line, reused rather than reinvented. */
const BLACK = 0.06

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
  set.call(inp, s); inp.dispatchEvent(new Event('input', { bubbles: true }))
}, seed)
await win.waitForTimeout(150)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2600)
await win.getByRole('button', { name: '3D', exact: true }).click()
await waitForScene(win)
await hideChrome(win)

const scene = await win.evaluate(() => window.__pt.sceneFeatures())

const spots = await win.evaluate((n) => {
  const pt = window.__pt, st = pt.store.getState()
  const terrain = st.map.layers.find((l) => l.type === 'terrain').terrainTiles
  const H = terrain.length, W = terrain[0].length
  const road = []
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) if (pt.isCirculation(terrain[y][x])) road.push([x, y])
  }
  const out = []
  const step = Math.max(1, Math.floor(road.length / n))
  for (let i = 0; i < road.length && out.length < n; i += step) {
    const [x, y] = road[i]
    let best = 0, bestYaw = 0
    for (const [dx, dy, yaw] of [[1, 0, Math.PI / 2], [-1, 0, -Math.PI / 2], [0, 1, 0], [0, -1, Math.PI]]) {
      let run = 0
      for (let k = 1; k < 14; k++) {
        const nx = x + dx * k, ny = y + dy * k
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) break
        if (!pt.isCirculation(terrain[ny][nx])) break
        run++
      }
      if (run > best) { best = run; bestYaw = yaw }
    }
    out.push({ x: x + 0.5, y: y + 0.5, yaw: bestYaw })
  }
  return out
}, VIEWS)

console.log(`=== HOURS — seed ${seed}, ${spots.length} street views per branch ===`)
console.log('Every arm of updateLighting, side by side. Each one has been edited')
console.log('while somebody measured at its own hour, and only at its own hour.\n')

const rows = []
for (const { h, name } of HOURS) {
  await win.evaluate((t) => window.__pt.store.getState().updateEnvironment({ timeOfDay: t }), h)
  await win.waitForTimeout(700)
  const acc = { sky: [], wall: [], roof: [], ground: [] }
  for (const sp of spots) {
    const pts = await win.evaluate(async ({ sp, volumes, pitch }) => {
      const pt = window.__pt, three = pt.renderer(), THREE = pt.THREE
      pt.flyTo(sp.x, (pt.heightAt(sp.x, sp.y) ?? 0) + 1.6, sp.y, sp.yaw, pitch)
      for (let k = 0; k < 4; k++) await new Promise((r) => requestAnimationFrame(r))
      await new Promise((r) => setTimeout(r, 120))
      const gl = three.renderer, sc = three.scene, cam = three.camera
      const src = gl.domElement
      const cw = src.width, ch = src.height
      const c2 = document.createElement('canvas')
      c2.width = cw; c2.height = ch
      const g2 = c2.getContext('2d', { willReadFrequently: true })
      gl.render(sc, cam)
      g2.drawImage(src, 0, 0)
      const px = g2.getImageData(0, 0, cw, ch).data
      const blockers = []
      for (const g of ['buildingGroup', 'propGroup', 'terrainGroup']) {
        const grp = three[g]
        if (grp) grp.traverse((o) => { if (o.isMesh && o.visible) blockers.push(o) })
      }
      const ray = new THREE.Raycaster()
      const ndc = new THREE.Vector2()
      // COARSE on purpose: this is a tripwire, not a portrait. eyeball.mjs
      // casts 44x44 per view and takes minutes; a branch that has gone black
      // does not need that resolution to say so.
      const GRID = 20
      const out = []
      for (let gy = 0; gy < GRID; gy++) {
        for (let gx = 0; gx < GRID; gx++) {
          const u = (gx + 0.5) / GRID, v = (gy + 0.5) / GRID
          ndc.set(u * 2 - 1, -(v * 2 - 1))
          ray.setFromCamera(ndc, cam)
          ray.near = 0; ray.far = 300
          const hit = ray.intersectObjects(blockers, false)[0]
          const ix = (Math.min(ch - 1, Math.floor(v * ch)) * cw +
            Math.min(cw - 1, Math.floor(u * cw))) * 4
          const L = (0.2126 * px[ix] + 0.7152 * px[ix + 1] + 0.0722 * px[ix + 2]) / 255
          if (!hit) { out.push({ k: 'sky', L }); continue }
          const p = hit.point
          const up = hit.face ? Math.abs(hit.face.normal.y) : 0
          let owner = null
          for (const vv of volumes) {
            if (p.x >= vv.x0 - 0.2 && p.x <= vv.x1 + 0.2 &&
                p.z >= vv.z0 - 0.2 && p.z <= vv.z1 + 0.2 &&
                p.y >= vv.y0 - 0.2 && p.y <= vv.y1 + 0.2) { owner = vv; break }
          }
          if (!owner) { out.push({ k: up > 0.7 ? 'ground' : 'wall', L }); continue }
          out.push({ k: up > 0.6 ? 'roof' : 'wall', L })
        }
      }
      return out
    }, { sp, volumes: scene.volumes, pitch: PITCH })
    for (const s of pts) acc[s.k]?.push(s.L)
  }
  const med = (a) => a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0
  const blk = (a) => a.length ? Math.round(100 * a.filter((v) => v < BLACK).length / a.length) : 0
  rows.push({
    name, h,
    sky: med(acc.sky), wall: med(acc.wall), roof: med(acc.roof), ground: med(acc.ground),
    wallBlack: blk(acc.wall), skyN: acc.sky.length, wallN: acc.wall.length,
  })
}
await app.close()

console.log('  branch    hour     sky    wall    roof  ground   wall black   silhouette')
console.log('  ---------------------------------------------------------------------------')
let inverted = 0
let blackout = 0
let unmeasured = 0
for (const r of rows) {
  // A SILHOUETTE NEEDS THE SKY TO BE BRIGHTER THAN WHAT IS IN FRONT OF IT.
  // Reported per branch because it is the thing a person notices going wrong
  // and no per-surface median read one hour at a time can show it.
  //
  // NO SKY IS A FAILURE OF THIS TOOL, NOT A CLEAN BRANCH. The first run
  // printed it on all four rows and counted zero failures, which is a green
  // board that has never looked at anything.
  const ok = r.skyN < MIN_SKY ? `NO SKY (${r.skyN})` : (r.sky > r.wall ? 'ok' : 'INVERTED')
  if (ok === 'INVERTED') inverted++
  if (ok.startsWith('NO SKY')) unmeasured++
  if (r.wallBlack >= 80) blackout++
  console.log(`  ${r.name.padEnd(8)} ${String(r.h).padStart(5)}   ` +
    `${r.sky.toFixed(3)}  ${r.wall.toFixed(3)}  ${r.roof.toFixed(3)}  ${r.ground.toFixed(3)}` +
    `      ${String(r.wallBlack).padStart(3)}%   ${ok}`)
}
console.log('  ---------------------------------------------------------------------------')
console.log(`  mid-grey is 0.22; "black" is eyeball's 0.06 line, reused not reinvented.`)
console.log(`  samples per branch: ${rows[0]?.skyN ?? 0} sky, ${rows[0]?.wallN ?? 0} wall` +
  ` (${VIEWS} views x 400 rays)`)
console.log(`\nVERDICT: ${inverted} inverted, ${blackout} blacked out, ${unmeasured} unmeasured.`)
console.log('  A branch reading near zero everywhere is not a dark branch, it is an')
console.log('  UNLIT one, and the two look identical in a single-hour tone table.')
console.log('  SKY and GROUND should ramp day > golden > dusk > night. THE WALL NEED')
console.log('  NOT: a noon sun overhead grazes a vertical surface and pours onto a')
console.log('  horizontal one, so wall can legitimately peak at golden. Read a step')
console.log('  the wrong way in sky or ground as an arm edited on its own.')
console.log('\nNOT A TARGET TABLE. Night SHOULD be far darker than noon — the point')
console.log('is the SHAPE of the four rows and the silhouette column, not any one')
console.log('figure. For the detailed read at the design\'s own hour, use eyeball.')
