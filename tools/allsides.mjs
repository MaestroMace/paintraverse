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
 * The measurement is a PAIRED comparison, which is what makes it trustworthy:
 * for each sampled building, photograph it from its own road side and from the
 * opposite side, at the same distance and eye height, and compare the visual
 * detail in the two frames. Pairing cancels out everything that varies between
 * buildings — size, colour, what happens to be behind it — and leaves only the
 * asymmetry. An absolute "how detailed is a wall" number would be swamped by
 * that variation and would tell you nothing.
 *
 * DETAIL is measured as edge density: the share of pixels that differ sharply
 * from the pixel to their right. A blank wall is a flat field and scores near
 * zero; a wall with a door, a sign, a balcony and a string course scores high.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/allsides.mjs [seed] [--n=14]
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
// sample is not one terrace.
const targets = await win.evaluate((n) => {
  const st = window.__pt.store.getState()
  const defs = st.objectDefinitions
  const structs = st.map.layers.find((l) => l.type === 'structure')?.objects ?? []
  const ok = structs.filter((o) => o.properties?.roadSide &&
    (o.properties?.floors ?? 1) >= 2)
  const step = Math.max(1, Math.floor(ok.length / n))
  const out = []
  for (let i = 0; i < ok.length && out.length < n; i += step) {
    const o = ok[i]
    const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
    const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
    out.push({ id: o.definitionId, side: o.properties.roadSide,
      cx: o.x + f.w / 2, cz: o.y + f.h / 2,
      reach: Math.max(f.w, f.h) })
  }
  return out
}, N)

const SIDE_DIR = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }

const results = []
for (let i = 0; i < targets.length; i++) {
  const t = targets[i]
  const [dx, dz] = SIDE_DIR[t.side] ?? [0, -1]
  const pair = []
  for (const sign of [1, -1]) {          // road side, then the opposite side
    const dist = 2.2 + t.reach * 0.6
    const camX = t.cx + dx * sign * dist
    const camZ = t.cz + dz * sign * dist
    const yaw = Math.atan2(t.cz - camZ, t.cx - camX)
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
    }, { camX, camZ, yaw, save: SAVE })
    if (!r) continue
    pair.push(r.density)
    if (SAVE && r.png) {
      writeFileSync(`.shots/allsides/${i}-${sign > 0 ? 'front' : 'back'}.png`,
        Buffer.from(r.png.split(',')[1], 'base64'))
    }
  }
  if (pair.length === 2) {
    results.push({ id: t.id, side: t.side, front: pair[0], back: pair[1] })
  }
}
await app.close()

console.log(`\n=== ALL SIDES — seed ${seed}, ${results.length} buildings, paired ===\n`)
console.log('building              road side   detail: front    back    back/front')
console.log('-'.repeat(74))
for (const r of results) {
  console.log(`${r.id.padEnd(21)}${r.side.padStart(6)}` +
    `${(r.front * 100).toFixed(1).padStart(17)}%` +
    `${(r.back * 100).toFixed(1).padStart(8)}%` +
    `${(r.front > 0 ? (r.back / r.front) : 0).toFixed(2).padStart(14)}`)
}
// Only pairs where the camera actually FRAMED something. A frame that is all
// sky, or pressed against a neighbouring wall, reads near 0% on both sides and
// contributes a meaningless ratio — and several such pairs dragged the first
// version of this aggregate around by a tenth with no code change behind it.
const usable = results.filter((r) => Math.max(r.front, r.back) > 0.01)
console.log('-'.repeat(74))
if (usable.length < 6) {
  console.log(`\nONLY ${usable.length} USABLE PAIRS — too few to conclude anything.`)
  console.log('Raise --n. A pair is usable when at least one of its two frames')
  console.log('actually has a building in it.')
}
const mf = usable.reduce((a, r) => a + r.front, 0) / (usable.length || 1)
const mb = usable.reduce((a, r) => a + r.back, 0) / (usable.length || 1)
const ratios = usable.map((r) => (r.front > 0 ? r.back / r.front : 0)).sort((a, b) => a - b)
const medRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0
console.log(`\nusable pairs: ${usable.length} of ${results.length}`)
console.log(`mean detail on the ROAD side:     ${(mf * 100).toFixed(1)}%`)
console.log(`mean detail on the OPPOSITE side: ${(mb * 100).toFixed(1)}%`)
console.log(`\nBACK/FRONT RATIO  mean ${(mb / (mf || 1)).toFixed(2)}   median ${medRatio.toFixed(2)}` +
  `\n  1.00 means a building is equally worth looking at from either side.`)
console.log(`\nNOTE ON SENSITIVITY: this cannot grade a rare feature. Ivy is 4% of`)
console.log(`buildings, so a 14-building sample contains roughly none of it and the`)
console.log(`aggregate moved a tenth on pure noise when it was moved to the back`)
console.log(`walls. Use this for changes that touch MOST buildings, or raise --n a`)
console.log(`lot. Watch the usable-pair count before believing a delta.`)
console.log('Theme parks finish everything a guest can walk around. A player in a')
console.log('walkaround walks around everything.')
