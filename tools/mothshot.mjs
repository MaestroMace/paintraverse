/**
 * MOTHSHOT — stand at a lantern and look at it.
 *
 * `particles.mjs` says the moth system exists, is inside the town and draws
 * from all three lantern families. It cannot say whether a 7.5cm dot at
 * RENDER_SCALE 0.4 survives to a pixel, and that is the whole question for a
 * particle this small: the scale note in CLAUDE.md is explicit that anything
 * under ~5cm is invisible past ~17m on this renderer, so a moth is only ever
 * a near-field thing and a distant street shot would honestly report nothing.
 *
 * Takes the A/B TRIPLE this repo learned to take, in one run, because taking
 * only the composite is what let a byte-identical before/after pass as
 * evidence for a session:
 *
 *   composite   does it read, in the picture a player would see
 *   hidden      does the frame CHANGE when the moths go
 *   alone       where are they and what shape is the motion
 *
 * The vantage is a real lantern rather than a street tile, because a moth is
 * at a lamp by construction and a street picked for its corridor length is
 * usually not near one. Picks the lamp with the most moths near it, stands
 * back at a readable distance, and puts the flame near frame centre.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/mothshot.mjs [seed] [--time=]
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome, isolate, hideNamed } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const argv = process.argv.slice(2)
const seed = Number(argv.find(a => /^\d+$/.test(a))) || 4242
const timeArg = argv.find(a => a.startsWith('--time='))
const time = timeArg ? Number(timeArg.split('=')[1]) : 20

mkdirSync('.shots', { recursive: true })

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
await win.evaluate((t) => window.__pt.store.getState().updateEnvironment({ timeOfDay: t }), time)
await win.waitForTimeout(700)
await hideChrome(win)

// Pick the lamp carrying the most moths, and stand off it by enough to see
// the whole orbit without the flame filling the frame.
const shot = await win.evaluate(() => {
  const pt = window.__pt, r3 = pt.renderer(), THREE = pt.THREE
  const sys = (r3.particleSystems || []).find(p => p.type === 'moth')
  if (!sys) return null
  const byLamp = new Map()
  for (let i = 0; i < sys.count; i++) {
    const k = `${sys.origins[i * 3].toFixed(2)},${sys.origins[i * 3 + 2].toFixed(2)}`
    const e = byLamp.get(k) || { n: 0, x: sys.origins[i * 3], y: sys.origins[i * 3 + 1], z: sys.origins[i * 3 + 2] }
    e.n++
    byLamp.set(k, e)
  }
  const lamps = [...byLamp.values()].sort((a, b) => b.n - a.n)
  // Prefer a lamp at street height. A rope lantern 19m up is a real anchor
  // and a useless photograph — the camera would be over the rooftops with
  // no town in frame, which is the "correctly framed and useless" failure
  // lib/vantage.mjs already documents for a bridge seen three-quarters on.
  const lamp = lamps.find(l => l.y < 6) || lamps[0]

  // Stand back 4.5m at the flame's own height, so the orbit is broadside.
  // Try the four cardinals and keep the one whose sight line is clear.
  const ray = new THREE.Raycaster()
  const solids = []
  r3.scene.traverse(o => { if (o.isMesh && o.visible) solids.push(o) })
  const D = 4.5
  let best = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
    const eye = new THREE.Vector3(lamp.x + dx * D, lamp.y + 0.3, lamp.z + dz * D)
    const dir = new THREE.Vector3(lamp.x - eye.x, lamp.y - eye.y, lamp.z - eye.z)
    const len = dir.length()
    ray.set(eye, dir.normalize())
    ray.far = len * 0.92
    const hits = ray.intersectObjects(solids, false)
    const clear = hits.length === 0
    if (clear) { best = { eye, dir: [dx, dz] }; break }
    if (!best) best = { eye, dir: [dx, dz], blocked: hits[0]?.object?.name || 'unnamed' }
  }
  const eye = best.eye
  const yaw = Math.atan2(lamp.z - eye.z, lamp.x - eye.x)
  const pitch = Math.atan2(lamp.y - eye.y, Math.hypot(lamp.x - eye.x, lamp.z - eye.z))
  pt.flyToWorld(eye.x, eye.y, eye.z, yaw, pitch)
  return { lamp: { x: +lamp.x.toFixed(1), y: +lamp.y.toFixed(1), z: +lamp.z.toFixed(1), moths: lamp.n },
    lamps: lamps.length, blocked: best.blocked || null }
})

if (!shot) {
  console.log('NO MOTH SYSTEM in the scene — that is the finding.')
  await app.close()
  process.exit(1)
}

await win.waitForTimeout(900)
const tag = `.shots/moth-${seed}-t${time}`
// The 3D canvas only. hideChrome takes the walk hint and the HUD; the
// desktop rails are a layout, not chrome, and a shot of the whole page
// spends two thirds of its pixels on the panels.
//
// AND A CROP AROUND FRAME CENTRE, because a 7.5cm moth is two pixels in a
// 900px frame and "I can just about see it if I know where to look" is not
// a reading. The lamp is aimed at frame centre by construction, so the crop
// needs no search — it is the same argument as cropTo() in lib/vantage.mjs,
// which exists because a subject shot at thirty pixels proves nothing.
const cv = win.locator('canvas').last()
const bb = await cv.boundingBox()
const CROP = 0.30
const clip = {
  x: bb.x + bb.width * (0.5 - CROP / 2), y: bb.y + bb.height * (0.5 - CROP / 2),
  width: bb.width * CROP, height: bb.height * CROP,
}
const shoot = async (name) => {
  await cv.screenshot({ path: `${tag}-${name}.png` })
  await win.screenshot({ path: `${tag}-${name}-crop.png`, clip })
}
await shoot('composite')

const hid = await hideNamed(win, 'moths')
await win.waitForTimeout(400)
await shoot('hidden')
await hid.restore()

const iso = await isolate(win, 'moths')
await win.waitForTimeout(400)
await shoot('alone')
await iso.restore()

console.log(`\nseed ${seed} @ ${time}h — ${shot.lamps} lamps carry moths`)
console.log(`  standing at the flame at (${shot.lamp.x}, ${shot.lamp.y}, ${shot.lamp.z}), ` +
  `${shot.lamp.moths} moths on it` + (shot.blocked ? `  [no clear bearing; nearest blocker ${shot.blocked}]` : ''))
console.log(`  hideNamed found ${hid.found} mesh · isolate found ${iso.found} mesh`)
if (iso.found === 0) {
  console.log('  ^ ISOLATE FOUND NOTHING. Either the mesh is unnamed or it is')
  console.log('    not a type isolate() walks. A zero here is a bug in the')
  console.log('    instrument before it is a bug in the town.')
}
console.log(`  ${tag}-{composite,hidden,alone}[-crop].png`)
console.log('  Read them as a set: the composite says whether it reads, the')
console.log('  pair says whether it is there at all. Neither number above is')
console.log('  a verdict on the look — that is the picture\'s job.')

await app.close()
