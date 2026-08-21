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
import { hideChrome, streetVantages } from './lib/vantage.mjs'

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

/**
 * --weather: CROSS THE FOUR ARMS WITH THE FIVE WEATHERS.
 *
 * This tool exists because `updateLighting` is a switch whose arms could each
 * rot while somebody measured at that arm's own hour. Weather is now a fifth
 * multiplier applied to ALL FOUR of them — fog density, sun, skylight, cloud
 * and the star field — and it is graded at exactly one combination out of
 * twenty: clear. That is the same shape one level up, and the same argument
 * applies: a storm knocks the sun to 0.22 and pulls the sky 75% toward an
 * overcast grey, so it can plausibly INVERT the silhouette the whole design
 * rests on, and nothing would say so.
 *
 * Off by default because it is 5x the frames and this is meant to be a
 * tripwire. Run it after touching `weatherAir` or any arm of updateLighting.
 */
const WEATHERS = [
  { w: 'clear', wi: 0 },
  { w: 'rain', wi: 1 },
  { w: 'fog', wi: 1 },
  { w: 'snow', wi: 1 },
  { w: 'storm', wi: 1 },
]
const withWeather = process.argv.includes('--weather')
const ARMS = withWeather
  ? HOURS.flatMap((hr) => WEATHERS.map((wx) => ({ ...hr, ...wx })))
  : HOURS.map((hr) => ({ ...hr, w: 'clear', wi: 0 }))
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

// SHARED, see lib/vantage.streetVantages. This picker was written here
// first and correct — all four directions, longest clear run — and
// `eyeball.mjs` had a second copy that only looked two ways. Two copies of a
// camera is the terrain-table drift with a lens on it.
const spots = await streetVantages(win, VIEWS)

console.log(`=== HOURS — seed ${seed}, ${spots.length} street views per branch ===`)
console.log('Every arm of updateLighting, side by side. Each one has been edited')
console.log('while somebody measured at its own hour, and only at its own hour.\n')

const rows = []
for (const { h, name, w, wi } of ARMS) {
  await win.evaluate(({ t, wk, wv }) => window.__pt.store.getState()
    .updateEnvironment({ timeOfDay: t, weather: wk, weatherIntensity: wv }), { t: h, wk: w, wv: wi })
  await win.waitForTimeout(700)
  const acc = { sky: [], wall: [], roof: [], ground: [], prop: [] }
  const propIds = new Map()
  for (const sp of spots) {
    const pts = await win.evaluate(async ({ sp, volumes, pitch }) => {
      const pt = window.__pt, three = pt.renderer(), THREE = pt.THREE
      const props = pt.store.getState().map.layers.find((l) => l.type === 'prop')?.objects ?? []
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
      // TAGGED BY GROUP, so a prop can be told from a wall. CLAUDE.md has
      // carried "nothing is known about prop tone at dusk" as an open item
      // since eyeball's `other` row was misread as a prop measurement — that
      // row is every sample no building volume owns and is not horizontal, so
      // vertical river-bank cuts and grazing water sit in it with the barrels,
      // 265 samples against 9865 for walls. The mask it asked for is one line
      // here, because the groups are already walked separately.
      const blockers = []
      const groupOf = new Map()
      for (const g of ['buildingGroup', 'propGroup', 'terrainGroup']) {
        const grp = three[g]
        if (!grp) continue
        grp.traverse((o) => {
          if (!o.isMesh || !o.visible) return
          // A LAMP POOL IS NOT A SURFACE. eyeball drops depthWrite:false
          // meshes for this reason and it matters more here than there: the
          // ground light pools are horizontal discs in propGroup, so without
          // this the prop column would be measuring the brightest thing in
          // the town and reporting that props are fine.
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          if (mats.every((m) => !m || m.depthWrite === false)) return
          blockers.push(o); groupOf.set(o, g)
        })
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
          // A PROP IS A PROP WHATEVER IT IS STANDING ON. Asked first, because
          // the orientation fallback below would file a barrel's side as
          // `wall` and its lid as `ground`, which is how the question went
          // unanswered for so long.
          if (groupOf.get(hit.object) === 'propGroup') {
            // NAME IT. A prop median that is really a TREE median would be a
            // bucket measuring something other than its label, which is the
            // mistake that put "props read 88% black" in CLAUDE.md off a row
            // containing river banks and grazing water. The batch merges every
            // prop into one mesh, so identity comes from the nearest prop
            // object — unambiguous inside two tiles, since props do not stack.
            let near = null, bd = 2.2 * 2.2
            for (const o of props) {
              const dx = (o.x + 0.5) * 3.0 - p.x, dz = (o.y + 0.5) * 3.0 - p.z
              const d = dx * dx + dz * dz
              if (d < bd) { bd = d; near = o }
            }
            out.push({ k: 'prop', L, id: near ? near.definitionId : '?' })
            continue
          }
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
    for (const s of pts) {
      acc[s.k]?.push(s.L)
      if (s.k === 'prop') propIds.set(s.id, (propIds.get(s.id) ?? 0) + 1)
    }
  }
  const med = (a) => a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0
  const blk = (a) => a.length ? Math.round(100 * a.filter((v) => v < BLACK).length / a.length) : 0
  rows.push({
    name: w === 'clear' ? name : `${name}/${w}`, h,
    sky: med(acc.sky), wall: med(acc.wall), roof: med(acc.roof), ground: med(acc.ground),
    prop: med(acc.prop),
    wallBlack: blk(acc.wall), propBlack: blk(acc.prop),
    skyN: acc.sky.length, wallN: acc.wall.length, propN: acc.prop.length,
    propIds: [...propIds].sort((a, b) => b[1] - a[1]).slice(0, 6),
  })
}
await win.evaluate(() => window.__pt.store.getState()
  .updateEnvironment({ weather: 'clear', weatherIntensity: 0 }))
await app.close()

console.log('  branch         hour     sky    wall    roof  ground    prop   wall black   silhouette')
console.log('  -----------------------------------------------------------------------------------------')
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
  //
  // AND AN INVERSION HAS A MARGIN. A sky at 0.156 against a wall at 0.175 is
  // not the world inside out, it is the silhouette GONE — and a storm sky
  // darker than a lit wall is what a storm looks like, as fog erasing
  // silhouettes is what fog is. A sky well BELOW its walls is a different
  // finding from a sky level with them, and reporting one number for both is
  // how the weather matrix's first run read as seven defects when three of
  // them were weather doing its job. Printed, not exempted: the count still
  // includes them, because the moment a category is excused it stops being
  // looked at.
  const ratio = r.wall > 1e-4 ? r.sky / r.wall : 99
  const ok = r.skyN < MIN_SKY ? `NO SKY (${r.skyN})`
    : r.sky > r.wall ? 'ok'
    : ratio > 0.75 ? `flat ${ratio.toFixed(2)}x`
    : `INVERTED ${ratio.toFixed(2)}x`
  if (ok.startsWith('INVERTED') || ok.startsWith('flat')) inverted++
  if (ok.startsWith('NO SKY')) unmeasured++
  if (r.wallBlack >= 80) blackout++
  console.log(`  ${r.name.padEnd(13)} ${String(r.h).padStart(5)}   ` +
    `${r.sky.toFixed(3)}  ${r.wall.toFixed(3)}  ${r.roof.toFixed(3)}  ${r.ground.toFixed(3)}  ${r.prop.toFixed(3)}` +
    `       ${String(r.wallBlack).padStart(3)}%   ${ok}`)
}
console.log('  ------------------------------------------------------------------------------------')
console.log(`  mid-grey is 0.22; "black" is eyeball's 0.06 line, reused not reinvented.`)
console.log(`  samples per branch: ${rows[0]?.skyN ?? 0} sky, ${rows[0]?.wallN ?? 0} wall,` +
  ` ${rows[0]?.propN ?? 0} prop (${VIEWS} views x 400 rays)`)
// THE PROP COLUMN IS THE MASK CLAUDE.md ASKED FOR. Reported with its own
// black share and sample count, because a prop is small on screen and a
// median over a handful of samples is a hypothesis. If propN is thin, say so
// rather than quoting the median.
for (const r of rows) {
  if (r.propN < 20) console.log(`  prop median at ${r.name} is ${r.propN} samples — too thin to quote.`)
}
console.log(`  props read black: ` + rows.map((r) => `${r.name} ${r.propBlack}%`).join(' · '))
console.log(`  what is IN the prop bucket: ` +
  (rows[0]?.propIds ?? []).map(([id, n]) => `${id} x${n}`).join(', '))
console.log('  `?` is a propGroup mesh with no object of the prop LAYER within two')
console.log('  tiles — ThreeRenderer.generateStaircases adds up to 30 bare terrain')
console.log('  step blocks straight to that group, and the lamp bulbs are there too.')
console.log('  Printed rather than hidden: a bucket you cannot name is a bucket you')
console.log('  should not quote, and that is the mistake this column exists to undo.')
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
