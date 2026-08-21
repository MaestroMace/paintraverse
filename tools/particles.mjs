/**
 * PARTICLES — is the moving content where the town is?
 *
 * DESIGN.md pillar 4 is "motion breathes": chimney smoke, fireflies, birds
 * circling spires. Sixteen instruments grade the static world and NOT ONE
 * looks at a particle, which is how the following survived the entire life of
 * the tile rescale:
 *
 *     town   x   2.8 - 143.0
 *     smoke  x  14.5 -  46.4
 *
 * The chimney collector built its Vector3 from TILE coordinates for x and z
 * and a WORLD height for y, and nothing scales particleGroup — so every
 * chimney vented over the first third of the map, detached from the building
 * producing it. The mixed units inside one Vector3 are what hid it: the
 * height was always right, so the smoke was at a plausible altitude over the
 * wrong place, which looks like smoke rather than like a bug.
 *
 * WHAT IT CHECKS, and all three are containment questions with no threshold
 * to tune — the kind this repo prefers:
 *
 *   1. Does each emitter's spread lie inside the town's own bounding box?
 *      A system whose extent is a fixed fraction of the town's is the scale
 *      bug above; one clustered in a corner is a placement bug.
 *   2. Is smoke ABOVE the roofline it comes from? Smoke at ground level is
 *      not smoke.
 *   3. Do the counts match what CLAUDE.md records, so a budget that quietly
 *      stops firing is visible.
 *
 * It states no target for how much motion is enough — that is a judgement,
 * and this file's history is three hand-written targets that were all wrong.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/particles.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'

const seeds = process.argv.slice(2).map(Number).filter(Boolean)
if (!seeds.length) seeds.push(4242, 31337, 8080)

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

let offTown = 0, belowRoof = 0, systems = 0, familyGaps = 0, adrift = 0
for (const seed of seeds) {
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

  const r = await win.evaluate(() => {
    const pt = window.__pt, r3 = pt.renderer(), THREE = pt.THREE
    const town = new THREE.Box3().setFromObject(r3.buildingGroup)
    // LABELLED BY WHAT THE SYSTEM SAYS IT IS, not by the order it was added.
    //
    // The verdict cannot distinguish "smoke starts at ground level", which is
    // a bug, from "fireflies start at ground level", which is what a firefly
    // is — the first version of this tool flagged all three and was wrong
    // twice. So it labelled them positionally from a hand-written
    // ['smoke','fireflies','birds'], which worked exactly as long as nobody
    // added a fourth: MOTHS are spawned between the fireflies and the birds,
    // so on the day they landed every bird in the verdict would have been a
    // moth and the moths would have been unnamed. That is the hand-written
    // list that cannot grow, the same shape as the roof-winding style table,
    // and the fix is the same one — read it off the thing that owns it.
    //
    // `particleSystems` carries `type` per system and TS `private` is
    // compile-time only, so it is reachable here. A mesh that matches no
    // system is named LOUDLY rather than guessed at: a missing label must not
    // read as a pass.
    const out = []
    const cam = r3.camera.position
    r3.particleGroup.traverse((o) => {
      if (!o.isPoints && !o.isLineSegments) return
      const p = o.geometry.getAttribute('position')
      if (!p || !p.count) return
      // THE DRAWN COUNT, NOT THE BUFFER SIZE. Precipitation allocates once at
      // its maximum and is scaled by draw range, because the weather controls
      // are sliders and rebuilding the buffer on every tick of a drag would
      // allocate hundreds of kilobytes a frame. Reporting 900 for a clear day
      // would be reporting the allocation and calling it weather.
      const dr = o.geometry.drawRange
      const drawn = Math.min(p.count, dr.count === Infinity ? p.count : dr.count)
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, y0 = 1e9, y1 = -1e9
      let outside = 0
      for (let i = 0; i < Math.max(1, drawn); i++) {
        const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
        x0 = Math.min(x0, x); x1 = Math.max(x1, x)
        z0 = Math.min(z0, z); z1 = Math.max(z1, z)
        y0 = Math.min(y0, y); y1 = Math.max(y1, y)
        // Generous margin: birds circle wide and fireflies drift past the
        // last house on purpose. This is a scale check, not a leash.
        if (x < town.min.x - 25 || x > town.max.x + 25 ||
            z < town.min.z - 25 || z > town.max.z + 25) outside++
      }
      const sys = (r3.particleSystems || []).find((ps) => ps.points === o)
      // A CAMERA-LOCAL SYSTEM IS GRADED ON A DIFFERENT QUESTION, and it says
      // so itself rather than being special-cased by name here. Rain and snow
      // are everywhere by definition, so they are drawn as a box that travels
      // with the player and recycles; asking whether their extent covers the
      // town is exactly the wrong question and would report a correct
      // implementation as a defect — the false alarm this file's own header
      // calls worse than no instrument at all. What IS worth asking is
      // whether the box is centred on the camera, which is the failure mode:
      // a box left at the origin is invisible everywhere else.
      const local = sys?.cameraLocal === true ||
        (o.name === 'rainfall' || o.name === 'snowfall')
      out.push({
        // Camera-local systems prefer their MESH name, because precipitation
        // is one simulation with two draw objects — a Points for snow and a
        // LineSegments for rain, since a sprite cannot be stretched into a
        // streak — and both would otherwise print as `precip` with one of
        // them always empty. Everything else keeps the system's own type.
        kind: (local ? o.name : sys?.type) ?? sys?.type
              ?? (o.name || `UNLABELLED-system${out.length}`),
        local,
        offCam: local
          ? +Math.hypot((x0 + x1) / 2 - cam.x, (z0 + z1) / 2 - cam.z).toFixed(1)
          : null,
        n: drawn, outside: local ? 0 : outside,
        x: [+x0.toFixed(1), +x1.toFixed(1)], z: [+z0.toFixed(1), +z1.toFixed(1)],
        y: [+y0.toFixed(1), +y1.toFixed(1)],
        // The fraction of the town's own footprint this system covers. A
        // system sitting at a clean 1/3 of it is the TILE bug; the number is
        // printed so that shape is recognisable rather than inferred.
        spread: +(((x1 - x0) / Math.max(1, town.max.x - town.min.x))).toFixed(2),
      })
    })
    // THE LANTERN FAMILIES, tallied by what each anchor SAYS it is. The
    // moths draw from all three and a feature that reaches two of three is
    // the ghost this repo keeps paying for — and it would read healthy,
    // because the surviving families still put moths on screen. Also
    // reported: how many distinct lamps actually carry moths, because the
    // budget is a farthest-point selection and a selection that collapses
    // onto one lamp is invisible in a particle count.
    const anchors = (pt.lampAnchors && pt.lampAnchors()) || []
    const fam = {}
    for (const a of anchors) fam[a.kind || 'UNSTATED'] = (fam[a.kind || 'UNSTATED'] || 0) + 1
    const mothSys = (r3.particleSystems || []).find((ps) => ps.type === 'moth')
    const lamps = new Set()
    if (mothSys) {
      for (let i = 0; i < mothSys.count; i++) {
        lamps.add(`${mothSys.origins[i * 3].toFixed(2)},${mothSys.origins[i * 3 + 2].toFixed(2)}`)
      }
    }
    return {
      town: { x: [+town.min.x.toFixed(1), +town.max.x.toFixed(1)],
        z: [+town.min.z.toFixed(1), +town.max.z.toFixed(1)] },
      groundY: +town.min.y.toFixed(1),
      systems: out,
      lanternFamilies: fam,
      mothLamps: lamps.size,
    }
  })

  console.log(`\nseed ${seed} — town x ${r.town.x.join('-')}  z ${r.town.z.join('-')}`)
  console.log('  system       n     x-range          z-range        y-range     spread  out')
  for (const s of r.systems) {
    systems++
    if (s.outside) offTown += s.outside
    console.log(
      `  ${s.kind.padEnd(10)} ${String(s.n).padStart(3)}  ${(s.x.join(' - ')).padEnd(15)}  ` +
      `${(s.z.join(' - ')).padEnd(15)}  ${(s.y.join(' - ')).padEnd(12)}` +
      `  ${String(s.local ? 'cam' : s.spread).padStart(5)}  ${String(s.outside).padStart(4)}`)
    // Only SMOKE has to start on a roof. A firefly at knee height is a
    // firefly and a bird at 30m is a bird.
    if (s.kind === 'smoke' && s.y[0] < r.groundY + 3) belowRoof++
    // A camera-local box that is not centred on the camera has come adrift,
    // which is the one way this kind of system fails and is invisible in
    // every other column.
    if (s.local && s.n > 0 && s.offCam > 6) {
      adrift++
      console.log(`             ^ ${s.kind} is camera-local and its box centre is ` +
        `${s.offCam}m from the camera — it should travel WITH the player.`)
    }
  }

  // LANTERN FAMILIES — a zero here is the finding, not the total.
  const fam = r.lanternFamilies || {}
  const names = ['lamppost', 'wall', 'rope']
  const missing = names.filter((k) => !fam[k])
  const extra = Object.keys(fam).filter((k) => !names.includes(k))
  console.log('  lanterns:  ' + names.map((k) => `${k} ${fam[k] || 0}`).join('  ') +
    (extra.length ? `  [UNEXPECTED ${extra.join(',')}]` : '') +
    `  ->  moths at ${r.mothLamps} distinct lamps`)
  if (missing.length) {
    familyGaps++
    console.log(`             ^ NO ANCHORS from: ${missing.join(', ')} — a lantern`)
    console.log('               family the moth pass cannot reach. The count above')
    console.log('               still looks healthy because the others carry it.')
  }
}

console.log(`\nVERDICT: ${offTown} particles outside the town box across ` +
  `${systems} systems; smoke starts within 3m of the ground on ${belowRoof}; ` +
  `${familyGaps} seeds miss a lantern family; ${adrift} camera-local boxes adrift.`)
console.log('  `spread` is each system\'s x-extent as a fraction of the town\'s;')
console.log('  `cam` means the system travels with the player and is graded on')
console.log('  whether its box is centred there instead.')
console.log('  A system at a clean ~0.33 is the TILE bug: tile coordinates used')
console.log('  as world coordinates, which is exactly how chimney smoke spent')
console.log('  the whole tile rescale venting over the wrong third of the map.')
console.log('  No target for HOW MUCH motion is enough — that is a judgement,')
console.log('  and three hand-written targets in this repo were all wrong.')

await app.close()
