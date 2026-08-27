/**
 * PARTSHOT — stand next to a named PARTICLE system and look at it.
 *
 * `particles.mjs` grades every system's extent, spread, tenancy, reactivity
 * and sway; not one of those can say whether a 30cm point survives to a pixel,
 * which is the only question that matters for a particle this small. That gap
 * already cost the moths a round — the isolate frame showed four crisp specks
 * and the composite showed ONE, because the orbit kept them all inside the
 * lantern's own screen footprint.
 *
 * `mothshot.mjs` answers it for the moths and for nothing else: it picks its
 * vantage by casting eye-to-LAMP, which every other system lacks. This is the
 * general form — give it the mesh NAME and it goes there.
 *
 *   xvfb-run -a node tools/partshot.mjs wisps [seed] [--time=23]
 *
 * TAKES THE A/B TRIPLE, because a composite alone cannot tell "too faint to
 * see" from "not in this frame", and an isolate alone cannot tell "visible"
 * from "visible against nothing". Composite, subject hidden, subject alone.
 *
 * AND IT AIMS AT A REAL PARTICLE, not at the buffer's bounding-box centre.
 * A scattered system's box is the whole town and its centre is a field
 * between the members — the failure the hanging-sway probe made and had to be
 * fixed for. A vertex is by definition on an instance.
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome, isolate, hideNamed, lookAt } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const name = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) ?? 'wisps'
const seed = Number(args.find((a) => /^\d+$/.test(a))) || 4242
const time = Number((args.find((a) => a.startsWith('--time=')) ?? '').slice(7)) || 23

mkdirSync('.shots/part', { recursive: true })
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
await win.evaluate((h) => window.__pt.store.getState().updateEnvironment({ timeOfDay: h }), time)
await hideChrome(win)

// A CLUSTER ROUND ONE REAL PARTICLE. Take a vertex, gather everything within
// a few metres of it, and aim at THAT centre — so a system scattered over the
// whole map is framed at one of its members rather than at the mean of them.
const aim = await win.evaluate(({ meshName }) => {
  const three = window.__pt.renderer()
  let pts = null
  three.scene.traverse((o) => { if (o.name === meshName && o.isPoints) pts = o })
  if (!pts) return null
  const arr = pts.geometry.getAttribute('position').array
  const n = arr.length / 3
  if (!n) return null
  const k = Math.floor(n / 2) * 3
  const px = arr[k], py = arr[k + 1], pz = arr[k + 2]
  let sx = 0, sy = 0, sz = 0, c = 0
  for (let i = 0; i < n; i++) {
    const dx = arr[i * 3] - px, dz = arr[i * 3 + 2] - pz
    if (dx * dx + dz * dz > 100) continue
    sx += arr[i * 3]; sy += arr[i * 3 + 1]; sz += arr[i * 3 + 2]; c++
  }
  return { x: sx / c, y: sy / c, z: sz / c, n, near: c }
}, { meshName: name })

if (!aim) {
  console.log(`\nno Points mesh named "${name}" in seed ${seed}.`)
  console.log('particles.mjs lists what a town actually drew; the name here is')
  console.log('the mesh name set at construction, not the ParticleSystem type.')
  await app.close()
  process.exit(0)
}
console.log(`\n=== ${name.toUpperCase()} — seed ${seed}, t=${time} ===`)
console.log(`  ${aim.n} particles; ${aim.near} within 10m of the one aimed at`)

// A CLEAR LINE, NOT A HAND-ROLLED BEARING. The first cut walked four compass
// points at a fixed standoff and put the camera against a wall on three of
// them — `flyTo` does not test occupancy, which this repo has now paid for
// five times. `lookAt` raycasts the real scene and names the mesh in the way.
const half = 4
const box = {
  min: [aim.x - half, aim.y - half, aim.z - half],
  max: [aim.x + half, aim.y + half, aim.z + half],
}
const v = await lookAt(win, box, {
  dists: [7, 10, 14, 20],
  heights: [0, 1.2, -1.0, 3],
  order: 'height',
  pick: 'first',
  minFill: 0.002,
})
if (!v.ok) {
  console.log(`  x ${v.why}`)
  await app.close()
  process.exit(0)
}
// Clip to the CANVAS. `hideChrome` only removes the HUD overlay, so a
// full-viewport shot comes back two thirds editor UI.
const canvas = await win.evaluate(() => {
  let best = null
  for (const c of document.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect()
    if (!best || r.width * r.height > best.width * best.height) {
      best = { x: r.x, y: r.y, width: r.width, height: r.height }
    }
  }
  return best
})
const clip = canvas ? { clip: canvas } : {}
await win.screenshot({ ...clip, path: `.shots/part/${name}-${seed}-view.png` })
console.log(`  ✓ .shots/part/${name}-${seed}-view.png  ` +
  `${v.dist?.toFixed(0) ?? '?'}m out, fills ${((v.fill ?? 0) * 100).toFixed(1)}%`)

// THE TRIPLE. Hidden proves the subject is what you are looking at; alone
// says where it is and what shape it really has.
const hid = await hideNamed(win, name)
await win.waitForTimeout(700)
await win.screenshot({ ...clip, path: `.shots/part/${name}-${seed}-hidden.png` })
hid.restore()
const iso = await isolate(win, name)
await win.waitForTimeout(700)
await win.screenshot({ ...clip, path: `.shots/part/${name}-${seed}-alone.png` })
iso.restore()
console.log(`  ✓ .shots/part/${name}-${seed}-hidden.png  (subject removed)`)
console.log(`  ✓ .shots/part/${name}-${seed}-alone.png   (subject only)`)
console.log('\nA composite alone cannot tell "too faint" from "not in frame".')
await app.close()
