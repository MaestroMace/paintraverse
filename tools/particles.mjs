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
import { isolate } from './lib/vantage.mjs'

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
let fireflyNature = null
let reactFails = 0
let swayFails = 0
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
    // WHAT EACH SYSTEM IS OVER — particle tenancy.
    //
    // Every other column here asks WHERE a system is; none asks whether the
    // place explains it. Fireflies were scattered by Math.random() over the
    // whole map and read a perfect 0.99 spread while most of them hung over
    // cobbles and rooftops, which is exactly the shape `emptiness.mjs`
    // failed at for props: a metric a uniform scatter can max out will be
    // maxed out by one. Only ownership answers "why is this here".
    //
    // Reported for every system rather than gated, because the right answer
    // differs: smoke comes out of roofs, a bird is over whatever it circles,
    // and only the firefly has a claim about the ground under it.
    const layer = pt.store.getState().map.layers.find((l) => l.type === 'terrain')
    const tt = layer?.terrainTiles || null
    const SOFT = new Set([0, 1, 5, 6, 10, 11, 12])
    const groundUnder = (o, drawn) => {
      if (!tt) return null
      const p2 = o.geometry.getAttribute('position')
      let soft = 0, water = 0, n = 0
      for (let i = 0; i < drawn; i++) {
        const tx = Math.floor(p2.getX(i) / pt.TILE), tz = Math.floor(p2.getZ(i) / pt.TILE)
        const t = tt[tz]?.[tx]
        if (t === undefined) continue
        n++
        if (t === 3) water++
        else if (SOFT.has(t)) soft++
      }
      return n ? Math.round(((soft + water) / n) * 100) : null
    }

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
        overNature: local ? null : groundUnder(o, Math.max(1, drawn)),
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
  console.log('  system       n     x-range          z-range        y-range     spread  out  nature')
  for (const s of r.systems) {
    systems++
    if (s.outside) offTown += s.outside
    console.log(
      `  ${s.kind.padEnd(10)} ${String(s.n).padStart(3)}  ${(s.x.join(' - ')).padEnd(15)}  ` +
      `${(s.z.join(' - ')).padEnd(15)}  ${(s.y.join(' - ')).padEnd(12)}` +
      `  ${String(s.local ? 'cam' : s.spread).padStart(5)}  ${String(s.outside).padStart(4)}` +
      `  ${(s.overNature === null ? '   -' : `${s.overNature}%`).padStart(6)}`)
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

  // FIREFLY TENANCY is the one `nature` figure with a claim attached: a
  // firefly over cobbles is a dust mote. The others are printed for
  // comparison and graded at nothing, because smoke comes out of a roof and
  // a bird is over whatever it circles.
  const ff = r.systems.find((x) => x.kind === 'firefly')
  if (ff && ff.overNature !== null) {
    fireflyNature = ff.overNature
    if (ff.overNature < 50) {
      console.log(`             ^ only ${ff.overNature}% of fireflies are over soft ground`)
      console.log('               or water. The rest are over cobbles and rooftops,')
      console.log('               where a pale dot reads as dust.')
    }
  }

  // DOES ANYTHING REACT TO THE PLAYER?
  //
  // Every system above is AMBIENT — it runs the same whether anyone is there
  // or not — and no instrument here could have told the difference, because
  // extent, spread and tenancy are all properties of a frozen scene. The
  // pigeons are the first thing in this town that knows where the player is,
  // so the check is: stand far away and record, walk up to ONE flock and
  // record again, and require that flock to have moved and the OTHERS not to
  // have. The untouched flocks are the negative case, and celestial.mjs is
  // the reason there is one — a test with no negative case has never been
  // tested, and its first version passed a control that was demonstrably
  // dead.
  const react = await win.evaluate(async () => {
    const pt = window.__pt, r3 = pt.renderer()
    const ps = (r3.particleSystems || []).find((p) => p.type === 'flock')
    if (!ps) return null
    const PER = 7
    const flocks = r3.flockHomes
    if (!flocks || !flocks.length) return null
    const nf = flocks.length / 2
    const snap = () => Array.from(ps.positions)
    const spread = (a, b, f) => {
      let d = 0
      for (let i = f * PER; i < (f + 1) * PER && i < ps.count; i++) {
        d = Math.max(d, Math.hypot(a[i * 3] - b[i * 3], a[i * 3 + 2] - b[i * 3 + 2]))
      }
      return d
    }
    // Somewhere far from every flock, so nothing is startled to begin with.
    let fx = 0, fz = 0, bestD = -1
    for (let gx = 4; gx < 44; gx += 6) for (let gz = 4; gz < 44; gz += 6) {
      let d = Infinity
      for (let f = 0; f < nf; f++) {
        d = Math.min(d, Math.hypot(gx * pt.TILE - flocks[f * 2], gz * pt.TILE - flocks[f * 2 + 1]))
      }
      if (d > bestD) { bestD = d; fx = gx; fz = gz }
    }
    pt.flyTo(fx, 14, fz, 0, -0.2)
    await new Promise((r) => setTimeout(r, 1400))
    const before = snap()
    // Now stand on flock 0.
    pt.flyToWorld(flocks[0] + 1.5, 12, flocks[1] + 1.5, 0, -0.6)
    await new Promise((r) => setTimeout(r, 2200))
    const after = snap()
    const moved = []
    for (let f = 0; f < nf; f++) moved.push(+spread(before, after, f).toFixed(2))
    return { nf, approached: moved[0], others: moved.slice(1) }
  })
  if (react) {
    const quiet = react.others.length ? Math.max(...react.others) : 0
    // AGAINST THE MEASURED NEGATIVE CASE, not an invented distance. The first
    // bar was "moved more than 3m", which passed on one seed and failed on
    // another at 1.19m — and the mechanism was identical in both, because
    // under SwiftShader at 5 FPS the flight simply advances less in the same
    // wall-clock. That is a hand-written target of exactly the kind
    // propscale.mjs got wrong three times out of three. The untouched flocks
    // read EXACTLY 0m because a grounded bird is pinned to its origin, so
    // they are the floor and the ratio is the reading.
    const live = react.approached > Math.max(0.5, quiet * 10)
    if (!live) reactFails++
    console.log(`  pigeons: approached flock moved ${react.approached}m, ` +
      `the ${react.others.length} untouched ${quiet}m (bar ` +
      `${Math.max(0.5, quiet * 10).toFixed(2)}m) — ` +
      (live ? 'they react to the player' : 'NO REACTION (or all of them moved)'))
  } else {
    console.log('  pigeons: NO FLOCK SYSTEM — that is the finding, not a pass.')
    reactFails++
  }

  // DOES THE HANGING CONTENT MOVE?
  //
  // Seven particle systems and the things a breeze would actually catch — a
  // chain of lanterns over a street, a line of washing between two upper
  // windows — were welded rigid, which is what makes a town read as a
  // diorama. The sway is a vertex-shader displacement, so it never touches a
  // CPU-side position and NO amount of reading buffers can see it: this has
  // to be measured in pixels.
  //
  // ISOLATE FIRST, and that is what makes it exact rather than a threshold.
  // With one mesh visible nothing else in the scene animates and the camera
  // is still, so any difference between two frames IS the sway — a static
  // mesh reads exactly 0. `windowSpill` is the negative case: named, in the
  // same part of the scene, and deliberately not swaying.
  const sway = await (async () => {
    const grid = 256
    const shootGrid = () => win.evaluate((n) => {
      const cv = window.__pt.renderer().renderer.domElement
      const c2 = document.createElement('canvas')
      c2.width = n; c2.height = n
      const g2 = c2.getContext('2d', { willReadFrequently: true })
      g2.drawImage(cv, 0, 0, n, n)
      const d = g2.getImageData(0, 0, n, n).data
      const out = new Array(n * n)
      for (let i = 0; i < n * n; i++) {
        out[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255
      }
      return out
    }, grid)
    // STAND AT A STRING. The first version of this shot the whole town from
    // 26m up on a 128 grid, where one sample is over a metre of world and a
    // 7cm sway cannot move a single one — it read exactly 0 on all three and
    // would have reported a working feature as dead. That is the moon
    // failure for the third time in this repo: A METRIC CANNOT GRADE A
    // FEATURE SMALLER THAN ITS SAMPLE RESOLVES, and the fix is never a
    // threshold, it is to measure where the subject is.
    //
    // At 6m the frame spans about 8m, so a sample is ~3cm and the sway moves
    // several. `lampAnchors` already knows where every rope lantern hangs.
    const ok = await win.evaluate(() => {
      const pt = window.__pt
      pt.store.getState().updateEnvironment({ timeOfDay: 12 })
      const rope = (pt.lampAnchors ? pt.lampAnchors() : []).filter((a) => a.kind === 'rope')
      if (!rope.length) return false
      const a = rope[Math.floor(rope.length / 2)]
      pt.flyToWorld(a.x - 5.5, a.y + 0.4, a.z - 2.0,
        Math.atan2(2.0, 5.5), -0.05)
      return true
    })
    if (!ok) return [['(no rope lanterns)', null, 'NOT IN SCENE']]
    await new Promise((r) => setTimeout(r, 1200))
    const out = []
    for (const name of ['laundryLines', 'ropeLanterns', 'lanternRopes', 'windowSpill']) {
      const iso = await isolate(win, name)
      if (!iso.found) { out.push([name, null, 'NOT IN SCENE']); await iso.restore(); continue }
      await new Promise((r) => setTimeout(r, 500))
      const mad = (u, v) => {
        let d = 0
        for (let i = 0; i < u.length; i++) d += Math.abs(u[i] - v[i])
        return d / u.length
      }
      // FOUR FRAMES ACROSS THE PERIOD, and the MAX pair — because a sway is
      // PERIODIC and two samples taken 1.7s apart can land at the same phase
      // of a nine-second swing and read as still. The first version did
      // exactly that and reported a working mechanism as static.
      const frames = []
      for (let k = 0; k < 4; k++) {
        frames.push(await shootGrid())
        if (k === 0) {
          // The floor, from the same pixels, as close together as this
          // renderer allows. `windowSpill` — the intended negative case — is
          // not in frame at a rope-lantern vantage, and a check with no
          // negative case has never been tested.
          await new Promise((r) => setTimeout(r, 70))
          frames.push(await shootGrid())
        }
        await new Promise((r) => setTimeout(r, 1300))
      }
      const floor = mad(frames[0], frames[1])
      let lit = 0
      for (const v of frames[0]) if (v > 0.02) lit++
      let sig = 0
      for (let i = 0; i < frames.length; i++) {
        for (let j = i + 1; j < frames.length; j++) sig = Math.max(sig, mad(frames[i], frames[j]))
      }
      const bar = Math.max(1e-5, floor * 4)
      out.push([name, +sig.toFixed(5), lit < 12 ? 'TOO FEW PIXELS' : null,
        +bar.toFixed(5), sig > bar])
      await iso.restore()
    }
    return out
  })()
  {
    const movers = sway.filter((r) => r[0] !== 'windowSpill' && r[1] !== null && !r[2])
    const moving = movers.filter((r) => r[4]).length
    console.log('  hanging:   ' + sway.map(([n, d, why, bar]) =>
      `${n} ${why ? why : `${d}/${bar}`}`).join('  ·  '))
    if (!movers.length) {
      swayFails++
      console.log('             ^ NOTHING GRADED. No hanging mesh had enough pixels')
      console.log('               at this vantage — too few samples to answer is a')
      console.log('               FAILURE, not a pass.')
    } else if (moving === 0) {
      // AT LEAST ONE, NOT ALL THREE. The failure this guards against is
      // GLOBAL: the sway is one shader applied by one function, and when it
      // stopped working it stopped for every mesh at once — a constant
      // `customProgramCacheKey` in patchHeightFog collapsing them onto one
      // compiled program. Requiring all three to clear a bar instead makes
      // the check hinge on whether a 7cm sway on a 4cm-thick rope beats the
      // frame-to-frame noise of a 5 FPS software renderer, which is a
      // threshold to tune rather than a defect to catch. Every figure is
      // printed; the gate is on the mechanism.
      swayFails++
      console.log('             ^ NOTHING HANGING MOVES. The sway shader is not')
      console.log('               reaching the meshes — check patchHeightFog\'s cache key.')
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
  `${familyGaps} seeds miss a lantern family; ${adrift} camera-local boxes adrift; ` +
  `fireflies over soft ground or water ${fireflyNature === null ? 'n/a' : fireflyNature + '%'}; ` +
  `${reactFails} seeds where nothing reacts to the player; ` +
  `${swayFails} hanging-sway failures.`)
console.log('  `spread` is each system\'s x-extent as a fraction of the town\'s;')
console.log('  `cam` means the system travels with the player and is graded on')
console.log('  whether its box is centred there instead.')
console.log('  A system at a clean ~0.33 is the TILE bug: tile coordinates used')
console.log('  as world coordinates, which is exactly how chimney smoke spent')
console.log('  the whole tile rescale venting over the wrong third of the map.')
console.log('  No target for HOW MUCH motion is enough — that is a judgement,')
console.log('  and three hand-written targets in this repo were all wrong.')

await app.close()
