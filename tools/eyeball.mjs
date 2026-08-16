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
import { hideChrome, FRAME } from './lib/vantage.mjs'
import { waitForScene } from './lib/scene.mjs'

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
const spots = await win.evaluate((n) => {
  const pt = window.__pt, st = pt.store.getState()
  const terrain = st.map.layers.find((l) => l.type === 'terrain').terrainTiles
  const H = terrain.length, W = terrain[0].length
  const road = []
  for (let y = 2; y < H - 2; y++) {
    for (let x = 2; x < W - 2; x++) if (pt.isCirculation(terrain[y][x])) road.push([x, y])
  }
  // Even sample so the views are spread over the map rather than clustered.
  const step = Math.max(1, Math.floor(road.length / n))
  const out = []
  for (let i = 0; i < road.length && out.length < n; i += step) {
    const [x, y] = road[i]
    // Aim along whichever axis has more road — down the street, not at a wall.
    let ex = 0, ez = 0
    for (let d = 1; d <= 6; d++) {
      if (pt.isCirculation(terrain[y]?.[x + d])) ex++
      if (pt.isCirculation(terrain[y + d]?.[x])) ez++
    }
    out.push({ x: x + 0.5, y: y + 0.5, yaw: ex >= ez ? 0 : Math.PI / 2 })
  }
  return out
}, views)

console.log(`=== EYEBALL — seed ${seed}, ${built.succeeded} structures, ${spots.length} street views ===`)
console.log('What FILLS THE FRAME at eye level, chosen by screen presence rather')
console.log('than by any audit\'s opinion. This is what a person sees first.\n')

const tally = new Map()   // definitionId -> { frames, area, maxH }
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
    three.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return
      if (o === three.skyMesh) return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      if (mats.every((m) => !m || m.depthWrite === false)) return
      blockers.push(o)
    })
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const pts = []
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        ndc.set(((gx + 0.5) / grid) * 2 - 1, -(((gy + 0.5) / grid) * 2 - 1))
        ray.setFromCamera(ndc, three.camera)
        ray.near = 0; ray.far = 300
        const h = ray.intersectObjects(blockers, false)[0]
        pts.push(h ? [+h.point.x.toFixed(2), +h.point.y.toFixed(2), +h.point.z.toFixed(2)] : null)
      }
    }
    return pts
  }, { sp, grid: 44 })

  // Attribute each sample to the structure whose volume box contains it.
  const frameTally = new Map()
  let inFrame = 0
  for (const p of hits) {
    totalSamples++
    if (!p) continue
    let owner = null
    for (const v of scene.volumes) {
      if (p[0] >= v.x0 - 0.2 && p[0] <= v.x1 + 0.2 &&
          p[2] >= v.z0 - 0.2 && p[2] <= v.z1 + 0.2 &&
          p[1] >= v.y0 - 0.2 && p[1] <= v.y1 + 0.2) { owner = v; break }
    }
    if (!owner) continue
    totalHit++; inFrame++
    frameTally.set(owner.id, (frameTally.get(owner.id) ?? 0) + 1)
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
const DWELLING = new Set([
  'row_house', 'building_small', 'building_medium', 'narrow_house', 'half_timber',
  'cottage', 'tenement', 'lean_to', 'almshouse', 'clergy_house', 'sexton_hut',
  'potting_shed', 'coach_house', 'balcony_house', 'corner_building',
])
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
const ratios = dwellings
  .filter((s) => s.wallTop > 1)
  .map((s) => (s.height - s.wallTop) / s.wallTop)
  .sort((a, b) => a - b)
const rq = (f) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * f))]
console.log(`\n  ROOF as a fraction of the WALL it sits on:`)
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
