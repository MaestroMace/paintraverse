/**
 * ASSET — photograph ONE building type where it actually stands.
 *
 * There was no way to look at a single type. Adding a building meant running
 * walkshots and hoping one of five fixed vantages happened to contain the new
 * thing, which for a type that is 3% of the town it does not. Every asset
 * added in this repo so far has been graded by a metric and a wide shot, and
 * "does it read as a tenement" is not a question either can answer.
 *
 * The camera problem is the one rivershot.mjs already solved and it is solved
 * the same way here: `flyTo` does not test occupancy, so a naive "stand near
 * it" lands inside a neighbour. This walks outward from the building along
 * each compass direction, takes the first standable tile with clear ground
 * back to the subject, and looks at it from there.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/asset.mjs <defId> [seed] [--n=3] [--time=12]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const defId = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a))
if (!defId) { console.log('usage: node tools/asset.mjs <definitionId> [seed] [--n=3] [--time=12]'); process.exit(1) }
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 4242)
const want = Number(argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? 3)
const timeOfDay = Number(argv.find((a) => a.startsWith('--time='))?.split('=')[1] ?? 12)
mkdirSync('.shots/asset', { recursive: true })

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
await win.waitForTimeout(2800)
await win.evaluate((t) => window.__pt.store.getState().updateEnvironment({ timeOfDay: t }), timeOfDay)
await win.waitForTimeout(900)
await win.evaluate(() => { const h = document.querySelector('.walk-hint'); if (h) h.style.display = 'none' })

const shots = await win.evaluate(({ id, want }) => {
  const st = window.__pt.store.getState()
  const map = st.map, defs = st.objectDefinitions
  const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
  const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
  const H = terrain.length, W = terrain[0].length
  const defOf = (o) => defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
  const solid = Array.from({ length: H }, () => new Uint8Array(W))
  for (const o of structs) {
    const d = defOf(o)
    if ((d?.tags ?? []).includes('passage')) continue
    const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
    for (let dy = 0; dy < f.h; dy++) for (let dx = 0; dx < f.w; dx++) {
      const x = o.x + dx, y = o.y + dy
      if (x >= 0 && y >= 0 && x < W && y < H) solid[y][x] = 1
    }
  }
  const free = (x, y) => x > 0 && y > 0 && x < W - 1 && y < H - 1 &&
    !solid[y][x] && terrain[y][x] !== 3
  const hits = structs.filter((o) => o.definitionId === id)
  if (!hits.length) return { none: true, total: structs.length }
  const out = []
  for (const o of hits) {
    const f = o.footprint ?? defOf(o)?.footprint ?? { w: 1, h: 1 }
    const cx = o.x + f.w / 2, cy = o.y + f.h / 2
    // Step outward until standable, keeping the run between clear so the
    // subject is not behind a neighbour.
    for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
      // Collect EVERY standable step outward, near to far, and let the shot
      // loop pick. Distance cannot be chosen here: how far you must stand back
      // depends on how TALL the thing is, which only the built scene knows. A
      // fixed standoff photographed a 1x2 lean-to as a 30-pixel smudge at four
      // tiles and then a tenement's front door at two.
      const lead = Math.max(f.w, f.h) / 2 + 1
      const steps = []
      for (let s = lead; s <= lead + 6; s += 1) {
        const px = Math.floor(cx + dx * s), py = Math.floor(cy + dy * s)
        if (!free(px, py)) break
        steps.push({ x: px + 0.5, y: py + 0.5, dist: s })
      }
      if (!steps.length) continue
      out.push({
        id: o.id, cx, cy, steps,
        fx0: o.x, fx1: o.x + f.w, fy0: o.y, fy1: o.y + f.h,
        district: o.properties?.district ?? '?',
        floors: o.properties?.floors ?? '?',
      })
      if (out.length >= want) break
    }
    if (out.length >= want) break
  }
  return { shots: out, count: hits.length }
}, { id: defId, want })

if (shots.none) {
  console.log(`no ${defId} in seed ${seed} (${shots.total} structures placed)`)
} else if (!shots.shots.length) {
  console.log(`${shots.count} x ${defId} placed, but none has a standable vantage`)
} else {
  console.log(`${shots.count} x ${defId} in seed ${seed}`)
  for (let i = 0; i < shots.shots.length; i++) {
    const v = shots.shots[i]
    const framed = await win.evaluate(async (a) => {
      const pt = window.__pt, three = pt.renderer()
      const cam = three.camera, cv = three.renderer.domElement
      const TL = 3.0
      const gY = pt.heightAt(a.cx, a.cy) ?? 0

      // Walk out until the subject FITS. This is an exact test against the
      // projected footprint box rather than a standoff guessed from the
      // footprint, because the thing that decides how far back you need to
      // stand is the height, and only the built scene knows it. Every proxy
      // for this in the repo has eventually disagreed with its target.
      const project = () => {
        const rect = cv.getBoundingClientRect()
        const pts = []
        for (const gx of [a.fx0, a.fx1]) for (const gz of [a.fy0, a.fy1]) {
          for (const wy of [gY, gY + 14]) {
            const q = cam.position.clone().set(gx * TL, wy, gz * TL).project(cam)
            pts.push([(q.x * 0.5 + 0.5) * rect.width + rect.left,
                      (-q.y * 0.5 + 0.5) * rect.height + rect.top, q.z])
          }
        }
        return { pts, rect }
      }
      let chosen = a.steps[a.steps.length - 1], best = null
      for (const st of a.steps) {
        const yaw = Math.atan2(a.cy - st.y, a.cx - st.x)
        const runM = Math.hypot(a.cx - st.x, a.cy - st.y) * TL
        pt.flyTo(st.x, gY + 1.6, st.y, yaw, Math.atan2(4.0, Math.max(1, runM)))
        cam.updateMatrixWorld(true); cam.updateProjectionMatrix()
        const { pts, rect } = project()
        // Anything behind the camera makes the box meaningless.
        if (pts.some((q) => q[2] > 1)) continue
        const w = Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0]))
        const hgt = Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1]))
        best = { st, yaw, runM }
        if (w < rect.width * 0.8 && hgt < rect.height * 0.8) { chosen = st; break }
        chosen = st
      }
      const yaw = Math.atan2(a.cy - chosen.y, a.cx - chosen.x)
      const runM = Math.hypot(a.cx - chosen.x, a.cy - chosen.y) * TL
      pt.flyTo(chosen.x, gY + 1.6, chosen.y, yaw, Math.atan2(3.2, Math.max(1, runM)))
      void best
      for (let k = 0; k < 8; k++) await new Promise((r) => requestAnimationFrame(r))
      await new Promise((r) => setTimeout(r, 350))
      three.renderer.render(three.scene, three.camera)

      // MARK THE SUBJECT. Without this the tool answers "here is a street with
      // your building somewhere in it", and two rounds were spent guessing
      // which box was the lean-to. anomaly.mjs learned the same thing: a
      // detector you cannot check is one you will trust for the wrong reason.
      document.querySelectorAll('.pt-asset-mark').forEach((n) => n.remove())
      const { pts, rect } = project()
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1])
      const box = document.createElement('div')
      box.className = 'pt-asset-mark'
      Object.assign(box.style, {
        position: 'fixed', pointerEvents: 'none', zIndex: 99999,
        left: `${Math.min(...xs)}px`, top: `${Math.min(...ys)}px`,
        width: `${Math.max(...xs) - Math.min(...xs)}px`,
        height: `${Math.max(...ys) - Math.min(...ys)}px`,
        border: '2px solid #ff00d0', boxShadow: '0 0 0 1px #000',
      })
      document.body.appendChild(box)
      void rect
      return { dist: chosen.dist }
    }, v)
    const buf = await win.screenshot({ clip: { x: 232, y: 40, width: 935, height: 806 } })
    writeFileSync(`.shots/asset/${defId}-${seed}-${i}.png`, buf)
    console.log(`  ✓ .shots/asset/${defId}-${seed}-${i}.png  ` +
      `${v.district} quarter, ${v.floors} floors, framed at ${framed.dist} tiles`)
  }
}
await app.close()
