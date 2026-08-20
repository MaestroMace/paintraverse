/**
 * EYEBALL — stand in the street and report WHAT FILLS THE FRAME.
 *
 * THE FAILURE THIS EXISTS TO FIX, stated plainly because it is mine.
 *
 * Every other tool in the perception harness selects a subject by DATA
 * ANOMALY, crops tightly to it, and draws a magenta box round it. That is
 * three separate mechanisms all pointing my attention at the thing the number
 * already cared about — and then I read the picture to confirm or deny that
 * one hypothesis. `subjectPixels` even masks the rest of the frame away on
 * purpose, which is correct for grading a subject and is exactly why I stop
 * seeing anything else.
 *
 * The result: I photographed a 1.52m interpenetration and reported it, while
 * three of the five buildings in the same frame were thirty-metre slabs with a
 * window grid repeated ten times up their faces. Missing the trees for the
 * forest. A person opening that screenshot sees the towers in a quarter of a
 * second and does not notice the interpenetration at all.
 *
 * So invert the selection. Do not choose by z-score; choose by SCREEN
 * PRESENCE, which is what a human's attention actually tracks. Stand at eye
 * level in a street, raycast a grid over the WHOLE frame, attribute every
 * sample to the structure it hit, and report the things that fill the view —
 * whatever the audits think of them.
 *
 * Then aggregate. One tall slab in one frame is a building; the same TYPE of
 * thing dominating eight of twelve street views is what the town looks like.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/eyeball.mjs [seed] [--views=8] [--time=12]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { hideChrome, FRAME, streetVantages } from './lib/vantage.mjs'
import { waitForScene } from './lib/scene.mjs'
import { DWELLINGS } from './lib/taxonomy.mjs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 31337)
const views = Number(argv.find((a) => a.startsWith('--views='))?.split('=')[1] ?? 8)
const timeOfDay = Number(argv.find((a) => a.startsWith('--time='))?.split('=')[1] ?? 12)
mkdirSync('.shots/eyeball', { recursive: true })

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
await win.waitForTimeout(200)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2800)
await win.getByRole('button', { name: '3D', exact: true }).click()
const built = await waitForScene(win)
await win.evaluate((t) => window.__pt.store.getState().updateEnvironment({ timeOfDay: t }), timeOfDay)
await win.waitForTimeout(800)
await hideChrome(win)

const scene = await win.evaluate(() => window.__pt.sceneFeatures())
const byId = new Map(scene.structures.map((s) => [s.id, s]))

// Vantages: walkable tiles spread across the map, looking along the street.
// Not a fixed list — fixed vantages are how walkshots keeps photographing the
// same five places while the rest of the town goes unlooked-at.
// ONE DEFINITION, in lib/vantage.mjs, and the copy that used to live here was
// the broken one: it counted road only in the +x and +z directions and only
// ever yawed positive, so a tile at the west end of an east–west street scored
// zero both ways, defaulted to facing +x and photographed a wall from a metre
// away. In a tool whose whole job is "what fills a street view", one such frame
// contributed thousands of wall samples from a single facade and put
// `potting_shed` top of the dominance table at 98.9%.
const spots = await streetVantages(win, views)

console.log(`=== EYEBALL — seed ${seed}, ${built.succeeded} structures, ${spots.length} street views ===`)
console.log('What FILLS THE FRAME at eye level, chosen by screen presence rather')
console.log('than by any audit\'s opinion. This is what a person sees first.\n')

const tally = new Map()   // definitionId -> { frames, area, maxH }
const tone = { sky: [], roof: [], wall: [], ground: [], prop: [], other: [] }
let totalHit = 0, totalSamples = 0

for (let i = 0; i < spots.length; i++) {
  const sp = spots[i]
  const hits = await win.evaluate(async ({ sp, grid }) => {
    const pt = window.__pt, three = pt.renderer(), THREE = pt.THREE
    pt.flyTo(sp.x, (pt.heightAt(sp.x, sp.y) ?? 0) + 1.6, sp.y, sp.yaw, -0.02)
    for (let k = 0; k < 6; k++) await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => setTimeout(r, 250))
    three.renderer.render(three.scene, three.camera)

    const blockers = []
    // WHICH MESHES ARE PROPS. CLAUDE.md has carried "nothing is known about
    // prop tone at dusk" as an open item since the `other` row below was
    // misread as a prop measurement — that row is every sample no building
    // volume owns and is not horizontal, so vertical river-bank cuts and
    // grazing water sit in it with the barrels. The mask it asked for is a
    // Set: propGroup already exists, and this is the tool that looks LEVEL
    // and takes thousands of samples, which is what a small object needs.
    // (hours.mjs has the same mask and honestly refuses to quote it — it
    // pitches up 9 degrees for the sky and collects eleven prop samples.)
    const propSet = new Set()
    if (three.propGroup) three.propGroup.traverse((o) => { if (o.isMesh) propSet.add(o) })
    three.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return
      if (o === three.skyMesh) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      if (mats.every((m) => !m || m.depthWrite === false)) return
      blockers.push(o)
    })
    // Read the FRAME's own pixels alongside the geometry. Every pixel measure
    // in this harness so far is RELATIVE to a control, and a town that is
    // uniformly too dark has a perfectly healthy relative distribution — the
    // one defect a peer comparison can never report. This is the absolute
    // question: at noon, how bright is this actually.
    const cv = three.renderer.domElement
    const cw = cv.width, ch = cv.height
    const c2 = document.createElement('canvas')
    c2.width = cw; c2.height = ch
    const g2 = c2.getContext('2d', { willReadFrequently: true })
    g2.drawImage(cv, 0, 0)
    const px = g2.getImageData(0, 0, cw, ch).data

    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const pts = []
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        const u = (gx + 0.5) / grid, v = (gy + 0.5) / grid
        ndc.set(u * 2 - 1, -(v * 2 - 1))
        ray.setFromCamera(ndc, three.camera)
        ray.near = 0; ray.far = 300
        const h = ray.intersectObjects(blockers, false)[0]
        const ix = (Math.min(ch - 1, Math.floor(v * ch)) * cw + Math.min(cw - 1, Math.floor(u * cw))) * 4
        const L = (0.2126 * px[ix] + 0.7152 * px[ix + 1] + 0.0722 * px[ix + 2]) / 255
        pts.push(h
          ? { p: [+h.point.x.toFixed(2), +h.point.y.toFixed(2), +h.point.z.toFixed(2)],
              up: h.face ? +Math.abs(h.face.normal.y).toFixed(2) : 0, L: +L.toFixed(3),
              prop: propSet.has(h.object) }
          : { p: null, up: 0, L: +L.toFixed(3), prop: false })
      }
    }
    return pts
  }, { sp, grid: 44 })

  // Attribute each sample to the structure whose volume box contains it.
  const frameTally = new Map()
  let inFrame = 0
  for (const s of hits) {
    totalSamples++
    const p = s.p
    if (!p) { tone.sky.push(s.L); continue }
    // A PROP IS A PROP WHATEVER IT STANDS ON, and it is asked FIRST: the
    // orientation fallback below files a barrel's side as `other` and its lid
    // as `ground`, which is how a whole surface class stayed unmeasured.
    if (s.prop) { tone.prop.push(s.L); continue }
    let owner = null
    for (const v of scene.volumes) {
      if (p[0] >= v.x0 - 0.2 && p[0] <= v.x1 + 0.2 &&
          p[2] >= v.z0 - 0.2 && p[2] <= v.z1 + 0.2 &&
          p[1] >= v.y0 - 0.2 && p[1] <= v.y1 + 0.2) { owner = v; break }
    }
    if (!owner) {
      // No volume owns it: terrain, water, or a wall mesh — NOT a prop any
      // more, those are taken above. Split by orientation: a horizontal face
      // down here is the ground you walk on.
      tone[s.up > 0.7 ? 'ground' : 'other'].push(s.L)
      continue
    }
    totalHit++; inFrame++
    frameTally.set(owner.id, (frameTally.get(owner.id) ?? 0) + 1)
    // Roof or wall: above the main body's wall top is roof. The distinction
    // matters because they are lit completely differently and a dark roof on a
    // lit wall is the silhouette problem, not a global exposure problem.
    const st = byId.get(owner.id)
    const wallTopY = st ? st.baseY + st.wallTop : owner.y1
    tone[p[1] > wallTopY - 0.1 ? 'roof' : 'wall'].push(s.L)
  }

  const ranked = [...frameTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  const total = hits.length
  console.log(`view ${i} @(${sp.x.toFixed(0)},${sp.y.toFixed(0)}) — ${((inFrame / total) * 100).toFixed(0)}% built:`)
  for (const [id, n] of ranked) {
    const s = byId.get(id)
    if (!s) continue
    const share = (n / total) * 100
    if (share < 2) continue
    const bare = s.wallArea > 0 ? 1 - s.texturedArea / s.wallArea : 0
    console.log(`   ${share.toFixed(1).padStart(5)}% of frame  ${s.def.padEnd(16)} ` +
      `${s.height.toFixed(1).padStart(5)}m tall  ${(s.height / 2.9).toFixed(1)} storeys` +
      `${bare > 0.25 ? `  ${(bare * 100).toFixed(0)}% bare wall` : ''}`)
    const e = tally.get(s.def) ?? { frames: 0, area: 0, maxH: 0, tall: 0, n: 0 }
    e.frames++; e.area += share; e.maxH = Math.max(e.maxH, s.height)
    tally.set(s.def, e)
  }
  const buf = await win.screenshot({ clip: FRAME })
  writeFileSync(`.shots/eyeball/${seed}-${String(i).padStart(2, '0')}.png`, buf)
}

/* ------------------------------------------------------------------ */

// === ABSOLUTE TONE ===
//
// Not relative to anything. odd.mjs grades a building against its peers and
// subjectPixels grades a subject against a control, and BOTH are blind to the
// case where the whole town is too dark — a uniform failure has a healthy
// distribution by construction. This is the one number in the harness with an
// opinion about what a rendered scene should look like, and the opinion is
// mild: at NOON, a sunlit surface should not read like a night shot.
const tq = (a, f) => { const s2 = a.slice().sort((x, y) => x - y); return s2.length ? s2[Math.floor(s2.length * f)] : 0 }
console.log(`\nTONE AT ${String(timeOfDay).padStart(2, '0')}:00 — absolute luma, by surface:`)
console.log('  surface   samples   p10    med    p90   share under 0.06 (reads black)')
for (const k of ['sky', 'roof', 'wall', 'ground', 'prop', 'other']) {
  const a = tone[k]
  if (!a.length) continue
  const black = a.filter((x) => x < 0.06).length / a.length
  const flag = k !== 'sky' && tq(a, 0.5) < 0.14 ? '   <-- reads as night' : ''
  console.log(`  ${k.padEnd(9)} ${String(a.length).padStart(6)}   ${tq(a, 0.1).toFixed(3)}  ` +
    `${tq(a, 0.5).toFixed(3)}  ${tq(a, 0.9).toFixed(3)}   ${(black * 100).toFixed(0)}%${flag}`)
}
console.log('  For reference: mid-grey is ~0.22 and a sunlit pale wall 0.45-0.7.')
console.log('  A roof darker than its own wall by a wide margin is a silhouette,')
console.log('  not a roof, and no relative metric in this harness can say so.')

console.log(`\nWHAT DOMINATES THE TOWN'S OWN STREETS — summed over ${spots.length} views:`)
console.log('  type              views  total frame share  tallest')
for (const [def, e] of [...tally.entries()].sort((a, b) => b[1].area - a[1].area).slice(0, 12)) {
  console.log(`  ${def.padEnd(18)} ${String(e.frames).padStart(4)}  ${e.area.toFixed(1).padStart(14)}%` +
    `  ${e.maxH.toFixed(1).padStart(7)}m`)
}

// THE SILHOUETTE QUESTION. A town is mostly two- and three-storey buildings
// with a handful of landmarks. If the ordinary DWELLING types are routinely
// six storeys and up, the skyline reads as a modern city whatever the roofs
// are doing, and no per-building audit will ever say so because each one is
// individually legal.
// Read out of core/types.ts rather than restated. The list that used to sit
// here counted `coach_house`, `potting_shed`, `sexton_hut` and `clergy_house`
// as dwellings — an outbuilding, a garden shed and two quarter-signature
// types, all of them dragging the storey distribution this tool reports — and
// it disagreed with the generator's own set in both directions.
const DWELLING = DWELLINGS
const dwellings = scene.structures.filter((s) => DWELLING.has(s.def))
// WALL height, not apex. `height` is the top of the roof, and dividing that by
// a storey overstates the count by the whole pitch — a 3-storey house with a
// 40-degree gable reads as 4. Getting told I miss the obvious is not a licence
// to overstate the thing I finally noticed.
const hs = dwellings.map((s) => s.wallTop).sort((a, b) => a - b)
const apex = dwellings.map((s) => s.height).sort((a, b) => a - b)
const q = (f) => hs[Math.min(hs.length - 1, Math.floor(hs.length * f))]
const over = (m) => hs.filter((h) => h > m).length
console.log(`\nORDINARY DWELLINGS — ${dwellings.length} of ${scene.structures.length} structures:`)
console.log(`  WALL height (storeys live here)  p10 ${q(0.1).toFixed(1)}m  med ${q(0.5).toFixed(1)}m` +
  `  p90 ${q(0.9).toFixed(1)}m  max ${hs[hs.length - 1].toFixed(1)}m`)
console.log(`  apex incl. roof (the silhouette)  p10 ${apex[Math.floor(apex.length * 0.1)].toFixed(1)}m` +
  `  med ${apex[apex.length >> 1].toFixed(1)}m  p90 ${apex[Math.floor(apex.length * 0.9)].toFixed(1)}m` +
  `  max ${apex[apex.length - 1].toFixed(1)}m`)
console.log(`  storeys  med ${(q(0.5) / 2.9).toFixed(1)}  p90 ${(q(0.9) / 2.9).toFixed(1)}`)
console.log(`  over 4 storeys (11.6m): ${over(11.6)} (${Math.round(100 * over(11.6) / hs.length)}%)`)
console.log(`  over 6 storeys (17.4m): ${over(17.4)} (${Math.round(100 * over(17.4) / hs.length)}%)`)
console.log(`  over 8 storeys (23.2m): ${over(23.2)} (${Math.round(100 * over(23.2) / hs.length)}%)`)
// THE ROOF-TO-WALL RATIO.
//
// The storey count came back fine — median 2.6, p90 4.3 — and the silhouette
// still reads as a city of dark spikes, because the ROOF is doing it. A real
// gable on a two-storey house rises 30-50% of the wall it sits on. Anything
// approaching 100% is a spire wearing a cottage, and at dusk it is a black
// triangle twice the size of the house.
//
// No existing audit asks this. humanscale grades a storey, a door and a
// window; roofcheck asks whether a roof EXISTS; provenance asks whether the
// rise matches its own cap. Nothing compares the roof to the building.
// TWO DIFFERENT QUESTIONS, and the first version conflated them. `height` is
// the APEX of the whole building, so height - wallTop is everything above the
// main body — its roof AND any tower, spire or penthouse stacked on it. That
// is a real silhouette measure, but it is not the roof, and capping roof rise
// moved it by one point while I was expecting it to move by fifty.
const ratios = dwellings
  .filter((s) => s.wallTop > 1)
  .map((s) => s.roofH / s.wallTop)
  .sort((a, b) => a - b)
const stacked = dwellings
  .filter((s) => s.wallTop > 1)
  .map((s) => (s.height - s.wallTop) / s.wallTop)
  .sort((a, b) => a - b)
const rq = (f) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * f))]
const sq = (f) => stacked[Math.min(stacked.length - 1, Math.floor(stacked.length * f))]
console.log(`\n  EVERYTHING ABOVE THE MAIN BODY, as a fraction of its wall`)
console.log(`  (its roof PLUS any tower or spire stacked on it — the silhouette):`)
console.log(`    p10 ${(sq(0.1) * 100).toFixed(0)}%  med ${(sq(0.5) * 100).toFixed(0)}%` +
  `  p90 ${(sq(0.9) * 100).toFixed(0)}%  max ${(stacked[stacked.length - 1] * 100).toFixed(0)}%`)
console.log(`\n  THE MAIN BODY'S OWN ROOF as a fraction of the WALL it sits on:`)
console.log(`    p10 ${(rq(0.1) * 100).toFixed(0)}%  med ${(rq(0.5) * 100).toFixed(0)}%` +
  `  p90 ${(rq(0.9) * 100).toFixed(0)}%  max ${(ratios[ratios.length - 1] * 100).toFixed(0)}%`)
console.log(`    over 80% (roof nearly as tall as the house): ` +
  `${ratios.filter((r) => r > 0.8).length} (${Math.round(100 * ratios.filter((r) => r > 0.8).length / ratios.length)}%)`)
console.log('    A real gable on a 2-3 storey house is 30-50%. Near 100% is a')
console.log('    spire wearing a cottage, and at dusk it is a black triangle')
console.log('    twice the size of the building under it.')
console.log('')
console.log('  A real pre-industrial town is almost entirely 2-4 storeys with a')
console.log('  handful of landmarks. Anything much above 4 is a tower, and a town')
console.log('  full of towers reads as a modern city however medieval the roofs are.')

await app.close()
