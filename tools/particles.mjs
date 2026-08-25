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
import { isolate, hideNamed } from './lib/vantage.mjs'

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
let mistWater = null, mistOffRiver = 0
let reactFails = 0
let swayFails = 0, swayBlind = 0
let spillMean = null, spillDead = 0
let missingSystems = 0
let laundryGaps = 0
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
    // BOTH SHARES, BECAUSE ONE MASK CANNOT ANSWER TWO CLAIMS. The firefly's
    // claim is soft ground OR water — a glow over a meadow and a glow over a
    // pond are both right. River mist's claim is WATER, and nothing else,
    // because mist forms where the air cools faster than the surface does and
    // that is the whole reason it is a river system rather than a scatter.
    //
    // Grading it on the combined figure reads 81-90% and calls that healthy,
    // when a fifth of the town's mist could be sitting over a field. That is
    // the bucket lesson in its usual clothes: check what a population CONTAINS
    // before filing a number against it. Returned split; each consumer asks
    // its own question.
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
      if (!n) return null
      return {
        nature: Math.round(((soft + water) / n) * 100),
        water: Math.round((water / n) * 100),
      }
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
      const under = local ? null : groundUnder(o, Math.max(1, drawn))
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
        overNature: under?.nature ?? null,
        overWater: under?.water ?? null,
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

  // FIREFLY TENANCY is one of two `nature` figures with a claim attached: a
  // firefly over cobbles is a dust mote. The rest are printed for comparison
  // and graded at nothing, because smoke comes out of a roof and a bird is
  // over whatever it circles.
  const ff = r.systems.find((x) => x.kind === 'firefly')
  if (ff && ff.overNature !== null) {
    fireflyNature = ff.overNature
    if (ff.overNature < 50) {
      console.log(`             ^ only ${ff.overNature}% of fireflies are over soft ground`)
      console.log('               or water. The rest are over cobbles and rooftops,')
      console.log('               where a pale dot reads as dust.')
    }
  }

  // MIST IS GRADED ON WATER, NOT ON `nature`, and the two disagree by a fifth.
  //
  // Every other system here is graded on WHERE IT REACHES; mist is the one
  // whose whole identity is a PLACE, because it forms where air cools faster
  // than the surface under it does. So "is it over water" is not a nicety, it
  // is the difference between river mist and a fog machine — and the shared
  // soft-ground-OR-water mask cannot ask it. It read 81-90% and the water
  // share is what that number was standing in for.
  //
  // The residual is REAL and expected rather than a defect: the particles are
  // 3m smudges deliberately drifting off the channel so the bank is soft
  // rather than knife-edged, and a tile is 3m. Gated low enough to catch a
  // system that has come off the river altogether, which is the failure that
  // matters, and printed always so the drift is visible before it is a gate.
  //
  // STATE THE NOISE FLOOR. This row read 69, 72, 81, 81, 83 across five runs
  // of the SAME seed — spread 14, against spread 0 on nearly everything else
  // here. It is a fact about the subject and not a fault in the measurement,
  // and it means a single-run delta on this row is worth nothing. The gate
  // sits two spreads below the worst observed.
  //
  // POOLING OVER TIME WAS TRIED, MEASURED AT ZERO, AND REMOVED. Four buffer
  // reads 450ms apart read 81 / 91 / 95 across three runs — the same spread as
  // one read — because the variance is not DRIFT. Mist is scattered with
  // `Math.random()` at init, so each run gets a different cloud over the same
  // channel, and no amount of sampling within a run can average that out.
  // Pinning the seed pins the LAYOUT and not the scatter, which is this
  // repo's oldest lesson wearing a particle costume.
  //
  // So the row is tracked at `dir: 0` rather than graded: a spread of 14
  // cannot support a directional band, and pretending otherwise is a
  // regression detector switched off. The GATE is `mistOffRiver`, which is a
  // count over a threshold two spreads below anything observed.
  const mi = r.systems.find((x) => x.kind === 'mist')
  if (mi && mi.overWater !== null) {
    mistWater = mistWater === null ? mi.overWater : Math.min(mistWater, mi.overWater)
    console.log(`             ^ mist over WATER ${mi.overWater}% (nature ${mi.overNature}%) — ` +
      'the nature mask counts a meadow, this does not')
    if (mi.overWater < 40) {
      mistOffRiver++
      console.log(`               only ${mi.overWater}% is actually over the channel; the`)
      console.log('               rest has drifted onto land, which is not river mist.')
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
  let spill = null
  const spillByHour = []
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
    // STAND AT THE SUBJECT — AT EACH SUBJECT, not at one of them.
    //
    // The first version of this shot the whole town from 26m up on a 128 grid,
    // where one sample is over a metre of world and a 7cm sway cannot move a
    // single one: it read exactly 0 on all three and would have reported a
    // working feature as dead. That is the moon failure for the third time in
    // this repo — A METRIC CANNOT GRADE A FEATURE SMALLER THAN ITS SAMPLE
    // RESOLVES, and the fix is never a threshold, it is to measure where the
    // subject is.
    //
    // The SECOND version fixed that halfway. It flew to a rope lantern and
    // then graded all four meshes from there, so `laundryLines` read TOO FEW
    // PIXELS on every seed — the one hanging thing whose placement had just
    // been changed was the one thing never graded, and the verdict said
    // "0 hanging-sway failures". A camera pointed where the subject is not
    // will report that there is none. Each mesh gets its own vantage now,
    // derived from its own world box.
    //
    // At ~6m the frame spans about 8m, so a sample is ~3cm and the sway moves
    // several.
    // ONE INSTANCE, NOT THE MERGED MESH.
    //
    // `laundryLines` is every washing line in the town in one buffer and
    // `windowSpill` is every lit elevation's pool of light, so their BOUNDING
    // BOXES are the town and a camera at the box centre is standing in a field
    // between them. That is the garment-cluster failure this repo already
    // records — "the camera was aimed at a meaningless centroid" — and the
    // first cut of this vantage reproduced it exactly, dropping ropeLanterns
    // from 0.00226 to 0.0001 and leaving laundry unseeable.
    //
    // A VERTEX IS BY DEFINITION ON A REAL INSTANCE. Take one near the middle
    // of the buffer, gather everything within a room's width of it, and frame
    // THAT. No clustering, no centroid, nothing to drift.
    const CLUSTER_R = 7
    const meshBox = (name) => win.evaluate(([n, R]) => {
      const three = window.__pt.renderer()
      const drawable = (o) => o.isMesh || o.isPoints || o.isLine || o.isLineSegments
      const pts = []
      three.scene.traverse((o) => {
        if (!drawable(o) || o.name !== n) return
        const p = o.geometry.getAttribute('position')
        if (!p || !p.count) return
        o.updateWorldMatrix(true, false)
        const m = o.matrixWorld.elements
        for (let i = 0; i < p.count; i++) {
          const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
          pts.push([
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          ])
        }
      })
      if (!pts.length) return null
      const s = pts[Math.floor(pts.length / 2)]
      const lo = [...s], hi = [...s]
      let n2 = 0
      for (const w of pts) {
        if ((w[0] - s[0]) ** 2 + (w[2] - s[2]) ** 2 > R * R) continue
        n2++
        for (let k = 0; k < 3; k++) {
          if (w[k] < lo[k]) lo[k] = w[k]
          if (w[k] > hi[k]) hi[k] = w[k]
        }
      }
      return { min: lo, max: hi, verts: n2, total: pts.length }
    }, [name, CLUSTER_R])
    const out = []
    for (const name of ['laundryLines', 'ropeLanterns', 'lanternRopes', 'windowSpill']) {
      // THE NEGATIVE CASE HAS TO BE LIT TO BE A NEGATIVE CASE. Every other
      // subject is measured at noon, deliberately, because nothing else in the
      // scene animates then. The window spill is DRIVEN BY windowGlow and is
      // therefore opacity zero at midday, so at noon it is absent rather than
      // static — and an absent negative case has never been tested, which is
      // the same argument that keeps `sunAngle` in celestial.mjs's table.
      // Isolated, dusk shows the spill and nothing else, so the measurement
      // stays as exact as the others.
      await win.evaluate((h) => window.__pt.store.getState()
        .updateEnvironment({ timeOfDay: h }), name === 'windowSpill' ? 18.5 : 12)
      const box = await meshBox(name)
      if (!box) { out.push([name, null, 'NOT IN SCENE']); continue }
      // Broadside from 6m at the subject's own height, which is the shape the
      // rope vantage already used and is correct for anything strung across a
      // gap. No occlusion search: these meshes hang over the street by
      // construction, and a raycast sweep against a 200k-triangle merged scene
      // costs minutes for four subjects on four seeds.
      const cx = (box.min[0] + box.max[0]) / 2, cz = (box.min[2] + box.max[2]) / 2
      const cy = (box.min[1] + box.max[1]) / 2
      // Look along the SHORT axis of the box so a line of washing crosses the
      // frame rather than receding down it — `w >= h` guessing an axis is a
      // documented failure here, and a box that is genuinely square gets an
      // arbitrary answer that is equally good.
      const spanX = box.max[0] - box.min[0], spanZ = box.max[2] - box.min[2]
      const spanY = box.max[1] - box.min[1]
      // A SUBJECT FLATTER THAN HALF ITS OWN FOOTPRINT IS LOOKED DOWN AT —
      // `asset.mjs`'s rule, derived from the box rather than from a flag. The
      // window spill is a band lying on the cobbles, so at eye level it is a
      // sliver behind the near paving; the same is true of a quay or a bridge
      // deck, which is why the rule lives in the box and not in a name list.
      const flat = spanY < Math.min(spanX, spanZ) * 0.5
      const [ox, oz] = spanX >= spanZ ? [0.8, 6.0] : [6.0, 0.8]
      const rise = flat ? Math.max(4.5, Math.max(spanX, spanZ) * 0.7) : 0.4
      const pitch = flat ? -Math.atan2(rise, Math.hypot(ox, oz)) : -0.05
      await win.evaluate(([x, y, z, dx, dz, up, pi]) => {
        window.__pt.flyToWorld(x - dx, y + up, z - dz, Math.atan2(dz, dx), pi)
      }, [cx, cy, cz, ox, oz, rise, pitch])
      await new Promise((r) => setTimeout(r, 1200))
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
          // renderer allows. `windowSpill` is the NEGATIVE CASE and is now
          // measured at its own vantage rather than being off-frame: a pool
          // of light on the cobbles is named, isolated and deliberately does
          // not sway, so it is the one row that must read below its bar. A
          // negative case that is merely absent proves nothing, which is the
          // same argument that keeps `sunAngle` in celestial.mjs's table.
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
        +bar.toFixed(5), sig > bar, { verts: box.verts, total: box.total, lit }])
      await iso.restore()

      /**
       * AND DOES THE SPILL DO ITS JOB — the one question nothing asked.
       *
       * Every other reading here is about a mesh EXISTING, being in the right
       * place, or moving. The window spill's purpose is different: it is
       * pillar 5's fourth layer, and its job is to put light on the ground at
       * the foot of a lit elevation, because the other three layers are all
       * SOURCES and nothing let a lit window affect anything outside itself.
       * Whether it succeeds is a question about the COMPOSITE frame, and the
       * isolate frame above cannot answer it — a mesh alone always looks like
       * something.
       *
       * THE PUDDLES ARE THE PRECEDENT AND THE WARNING. 150 of them were built,
       * counted, and photographed into a convincingly rainy street, and only
       * hiding the one mesh and re-measuring showed they contributed 1.4x the
       * noise floor. A count said they existed; a photograph said they looked
       * right; neither was a reading. `hideNamed` is what turned that into a
       * number, and this is the same triple on the same kind of claim.
       *
       * BOTH STATISTICS, because they can disagree and only their agreement is
       * trustworthy: the mean shift says how much light arrived, and the count
       * of changed samples says whether it arrived somewhere or everywhere. A
       * large mean over three samples is a bug; a tiny mean over thousands is
       * a wash rather than a pool, and pillar 1 wants a dark street.
       */
      // AND GRADE IT AT MORE THAN ONE HOUR. The spill is driven by
      // `windowGlow`, so it is a time-of-day feature, and this repo already
      // pays for a four-arm lighting switch measured at one arm — `hours.mjs`
      // exists because the tone arc edited noon and dusk kept the pre-arc
      // numbers for a whole session. The compression that crushes an additive
      // term depends on where the surface under it already sits on the ACES
      // curve, and a dusk street is far brighter than a night one, so the same
      // mesh can be invisible at 18.5 and read perfectly at 22.
      for (const hour of (name === 'windowSpill' ? [18.5, 22] : [])) {
        await win.evaluate((h) => window.__pt.store.getState()
          .updateEnvironment({ timeOfDay: h }), hour)
        // AND THE FLOOR HAS TO BE THE RIGHT NOISE — the half of the puddle
        // finding that is easiest to get wrong, and I got it wrong first.
        // `floor` above is the noise of an ISOLATED frame, where nothing but
        // the subject is drawn and nothing animates, so it is near zero. This
        // A/B runs on the COMPOSITE, where moths, fireflies, smoke, mist and
        // the window flicker all move every frame. Grading a composite delta
        // against an isolated floor would clear almost anything.
        //
        // So the control is two composite frames with NOTHING changed, taken
        // as close together as this renderer allows, and it is measured on
        // both statistics — a mean and a changed-sample share — because the
        // puddles cleared neither honestly and only the pair said so.
        // SETTLE AFTER THE RESTORE, or the floor is a transient rather than
        // the noise. `iso.restore()` above makes every mesh in the town
        // visible again in one go, and the first frames after that carry a
        // shadow-map rebuild and a fresh frustum cull: seed 4242 read a floor
        // of 0.069 over 100% of the frame between two frames 70ms apart,
        // which is not animation, it is a scene still arriving. A tool that
        // measures during its own setup is measuring its own setup.
        await new Promise((r) => setTimeout(r, 1500))
        const a1 = await shootGrid()
        await new Promise((r) => setTimeout(r, 200))
        const a2 = await shootGrid()
        const hid = await hideNamed(win, name)
        await new Promise((r) => setTimeout(r, 700))
        const b = await shootGrid()
        await hid.restore()
        // MEASURE WHERE THE SUBJECT IS — the moon failure, and my own note on
        // it is three tools away. A whole-frame mean read +0.00022 against a
        // floor of 0.0001 and called a live feature dead, because the spill
        // reaches under 2% of the frame and the other 98% of that denominator
        // is zeros. `subjectPixels` solved the identical problem the identical
        // way; celestial.mjs went 2.5x to 1700x on nothing but where it looked.
        //
        // THE MASK IS THE ISOLATE FRAME, not the delta, which is what keeps it
        // honest: selecting the pixels by where the change is would be
        // circular and would clear anything. `frames[0]` is this same mesh
        // rendered alone at this same camera, so it says where the subject
        // DRAWS, independently of whether it does anything in the composite.
        // AND THE MASK IS STILL THE WRONG DENOMINATOR FOR THE CORE. The pool
        // is a RADIAL falloff, so most of the pixels it touches are at nearly
        // zero alpha on purpose — averaging over all of them under-reports the
        // middle, which is the part a person actually sees. Same shape as the
        // whole-frame mean one step earlier, and the reason to print both:
        // the mask says how far the light reaches, the CORE says whether the
        // brightest part of it survives to a single 8-bit level. One step is
        // 1/255 = 0.0039, which is the only non-invented bar available here.
        const THRESH = 0.004
        let peak = 0
        for (const v of frames[0]) if (v > peak) peak = v
        const CORE = Math.max(0.05, peak * 0.5)
        let dm = 0, changed = 0, noise = 0, noiseChanged = 0, mask = 0
        let dmAll = 0, dmCore = 0, core = 0
        for (let i = 0; i < a1.length; i++) {
          const lit = (a1[i] + a2[i]) / 2
          const d = lit - b[i]
          dmAll += d
          if (frames[0][i] <= 0.02) continue
          mask++
          dm += d
          if (Math.abs(d) > THRESH) changed++
          const nd = a1[i] - a2[i]
          noise += Math.abs(nd)
          if (Math.abs(nd) > THRESH) noiseChanged++
          if (frames[0][i] >= CORE) { core++; dmCore += d }
        }
        spill = {
          // Signed: the spill ADDS light, so a negative mean would mean the
          // mesh is darkening the ground it exists to brighten — which the
          // material forbids, so it convicts the measurement.
          mean: mask ? +(dm / mask).toFixed(5) : 0,
          changedPct: mask ? +((changed / mask) * 100).toFixed(1) : 0,
          // The composite control, over THE SAME pixels. A floor taken over a
          // different population than the signal is the numerator/denominator
          // failure this repo has now recorded four times.
          floor: mask ? +(noise / mask).toFixed(5) : 0,
          floorChangedPct: mask ? +((noiseChanged / mask) * 100).toFixed(1) : 0,
          // Both denominators printed, because a rate with an unstated
          // population is not a reading — and the whole-frame mean is what a
          // naive version of this probe would have quoted.
          maskPct: +((mask / a1.length) * 100).toFixed(1),
          frameMean: +(dmAll / a1.length).toFixed(5),
          // THE CORE, and the one bar in this probe that is not a ratio to a
          // measured floor: 1/255 is what an 8-bit display can represent, so a
          // contribution below it is not faint, it is absent on most pixels.
          coreMean: core ? +(dmCore / core).toFixed(6) : 0,
          coreSteps: core ? +((dmCore / core) * 255).toFixed(2) : 0,
          // THE COUNT, because `core 0` and `core bright but unchanged` print
          // the same zero and want opposite investigations — the explaining
          // metric rather than the counting one.
          coreN: core,
          corePeak: +peak.toFixed(3),
          hour,
        }
        spillByHour.push(spill)
      }
    }
    return out
  })()
  {
    const movers = sway.filter((r) => r[0] !== 'windowSpill' && r[1] !== null && !r[2])
    /**
     * GATED ON AN ABSOLUTE FLOOR, NOT ON THE PER-MESH BAR — because the bar is
     * not repeatable and this is a GATE.
     *
     * `--repeat=3` on identical seeds read noSway 0, 0, 1. The per-mesh bar is
     * `floor * 4`, and that floor comes from two frames 200ms apart: under
     * SwiftShader at 3-5 FPS the pair sometimes straddles a frame boundary,
     * the floor spikes, and a working mechanism fails its own bar. A gate that
     * cries wolf one run in three is a gate people learn to ignore, which is
     * worse than not having one.
     *
     * The failure it exists to catch is GLOBAL and was not marginal: when
     * `patchHeightFog`'s constant cache key threw the sway shader away, every
     * mesh read EXACTLY 0.00000, and it stayed exactly zero when the amplitude
     * was cranked to two and a half metres. `windowSpill` is the standing
     * proof that a static mesh in an isolated frame reads exact zero, so any
     * clearly-nonzero reading IS the mechanism running. 1e-4 is two orders
     * below the 0.001-0.008 these meshes actually produce and two orders above
     * the zero a dead shader gives — there is nothing near it to argue about.
     *
     * The per-mesh bar is still PRINTED, because it says whether an individual
     * mesh is moving enough to see, which is a different and useful question
     * from whether the shader is reaching it.
     */
    const SWAY_ALIVE = 1e-4
    const moving = movers.filter((r) => r[1] > SWAY_ALIVE).length
    console.log('  hanging:   ' + sway.map(([n, d, why, bar]) =>
      `${n} ${why ? why : `${d}/${bar}`}`).join('  ·  '))
    // AN UNGRADED MESH IS NOT A CLEAN ONE. Each subject now gets a camera
    // pointed at its own box, so `TOO FEW PIXELS` no longer means "the
    // vantage was chosen for something else" — it means the camera was aimed
    // at this mesh and could not see it, which is a finding. Reported
    // separately from the sway gate so a framing failure and a dead shader do
    // not read as the same defect.
    const blind = sway.filter((r) => r[0] !== 'windowSpill' && r[2] === 'TOO FEW PIXELS')
    swayBlind += blind.length
    for (const [n, , , , , d] of blind) {
      // SAY WHICH HALF FAILED. `could not be seen` is a count that buys
      // guesses: a cluster of 4 vertices means the instance picker landed on a
      // stray, and a cluster of 400 that lights 3 pixels means the camera is
      // pointed at it and something is in the way. Those want opposite fixes.
      console.log(`             ^ ${n} was framed at its own instance and still could`)
      console.log(`               not be seen — ${d.verts} of ${d.total} verts in the ` +
        `cluster, ${d.lit} lit samples of 65536.`)
      console.log('               Too few samples to answer is a FAILURE, not a pass.')
    }
    // The negative case has to fail. A probe whose "does not move" row is
    // itself unmeasurable has never been tested.
    const neg = sway.find((r) => r[0] === 'windowSpill')
    if (neg && neg[1] !== null && !neg[2] && neg[4]) {
      swayFails++
      console.log('             ^ windowSpill MOVED. It is the negative case — a ground')
      console.log('               quad that must not sway — so either the displacement')
      console.log('               is reaching a mesh it should not, or the floor is bad.')
    }
    // DOES THE SPILL PUT LIGHT ON THE GROUND — its whole job, and the one
    // claim here that a composite frame has to settle. Both statistics are
    // printed because they can disagree and only their agreement is worth
    // anything: the mean says how much light arrived, the changed share says
    // whether it arrived in a POOL or as a wash over the whole street, and a
    // uniform wash is the failure this feature was tuned away from.
    for (const sp of spillByHour) {
      console.log(`  spill ${String(sp.hour).padEnd(4)}: +${sp.mean} mean on ${sp.changedPct}% of ` +
        `its own px  ·  floor ${sp.floor}/${sp.floorChangedPct}%  ·  core ${sp.coreSteps} of a ` +
        `255 step over ${sp.coreN} px (isolate peak ${sp.corePeak})`)
    }
    if (spill) {
      // GRADED ON THE BEST HOUR IT GETS, because the question is whether the
      // layer is ever visible, not whether it is visible at every hour — a
      // pool of light under a lit window is a NIGHT thing and being absent at
      // noon is correct.
      spill = spillByHour.reduce((a, b) => (b.coreSteps > a.coreSteps ? b : a), spillByHour[0])
      spillMean = spillMean === null ? spill.mean : Math.min(spillMean, spill.mean)
      // A NEGATIVE MEAN CONVICTS THE MEASUREMENT, NOT THE SPILL, and it is a
      // proof rather than a suspicion: `_spillMat` is AdditiveBlending, so
      // hiding the mesh can only ever remove light and `with - without` is
      // non-negative at every pixel by construction. A negative aggregate is
      // therefore impossible from the subject and can only come from the
      // frames not being comparable — which is exactly what it caught, a
      // floor of 0.069 over 100% of the frame while the scene was still
      // settling after the isolate was restored. Same tell as a rate over
      // 100% or an overlap deeper than the clamp allows: a number outside
      // what the code can produce is a free bug report about the tool.
      if (spill.mean < 0) {
        spillDead++
        console.log('             ^ NEGATIVE DELTA — IMPOSSIBLE. The spill is additive,')
        console.log('               so hiding it cannot brighten anything. The two')
        console.log('               frames are not comparable; this is a tool failure')
        console.log('               and the reading must not be quoted.')
      // BOTH STATISTICS HAVE TO CLEAR, because the puddles cleared the mean at
      // 1.4x against falling rain and that was not a reading. Three times the
      // measured composite noise is the same bar celestial.mjs settled on
      // after three invented ones, and the changed share must beat its own
      // control too — otherwise the "signal" is the animation.
      } else if (spill.mean <= spill.floor * 3 || spill.changedPct <= spill.floorChangedPct) {
        spillDead++
        console.log('             ^ THE WINDOW SPILL CONTRIBUTES NOTHING. Hiding it')
        console.log('               moves the frame by no more than the composite\'s own')
        console.log('               noise — the puddle reading, on pillar 5 layer 4.')
      } else if (spill.coreSteps < 1) {
        // MEASURABLE IS NOT VISIBLE, and conflating them is how a green board
        // ends up certifying something nobody can see. The mask mean clears
        // its floor by 13x, so the mesh is genuinely there and correctly
        // signed; the CORE — the brightest part of the pool — moves the
        // composite by under one 8-bit step, so on most pixels it rounds away.
        // Reported and not gated, because this is a KNOWN and accepted state
        // with the arithmetic written up in CLAUDE.md: raising it enough to
        // clear a step needs ~9x, which is past the lamp pool and into the
        // uniform wash. The row exists so that if the tone curve, the exposure
        // or the opacity ever change, this moves and somebody sees it.
        console.log(`             ^ present but BELOW A DISPLAY STEP: core ${spill.coreSteps}` +
          ' of 255. Measurable, correctly signed, and not visible. See CLAUDE.md')
        console.log('               before spending a session raising it — 3x was')
        console.log('               photographed and is indistinguishable.')
      } else if (spill.changedPct > 60) {
        spillDead++
        console.log('             ^ THE SPILL IS A WASH, NOT A POOL. It reaches most of')
        console.log('               the frame, and a uniformly lit street is the worst')
        console.log('               of both pillars — 1 wants dark, 5 wants pools.')
      }
    }
    if (!movers.length) {
      swayFails++
      console.log('             ^ NOTHING GRADED. No hanging mesh had enough pixels')
      console.log('               even framed at its own box — too few samples to')
      console.log('               answer is a FAILURE, not a pass.')
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
      console.log('             ^ NOTHING HANGING MOVES. Every hanging mesh read under')
      console.log(`               ${SWAY_ALIVE} — the sway shader is not reaching them at`)
      console.log('               all; check patchHeightFog\'s cache key.')
    }
  }

  // WHICH SYSTEMS EXIST AT ALL — and WHY one does not.
  //
  // Three of the seven bail out when their prerequisite is missing: mist
  // needs water, the flock needs open paving, the washing needs a pair of
  // dwellings close enough. A town without them produces a SHORTER TABLE and
  // nothing else — the verdict would still read "0 particles outside the town
  // box across N systems" with N quietly one lower, which is the ghost
  // failure in the one tool that grades moving content.
  //
  // AN ABSENCE NEEDS A CAUSE, NOT A FLAG. `no mist` on a town with a river is
  // a defect and on a dry one is correct, and a count cannot tell them apart
  // — the classify-by-cause discipline that turned "233 tiles the wall placer
  // did not build" into an answer in one run. So the tool asks the MAP what
  // the town has before deciding whether an absence is a finding.
  const census = await win.evaluate(() => {
    const pt = window.__pt, r3 = pt.renderer()
    const layer = pt.store.getState().map.layers.find((l) => l.type === 'terrain')
    const tt = layer?.terrainTiles || []
    let water = 0, paving = 0
    for (const row of tt) for (const t of row) {
      if (t === 3) water++
      else if (t === 14 || t === 8) paving++
    }
    const seen = new Set()
    r3.particleGroup.traverse((o) => {
      if (o.isPoints || o.isLineSegments) seen.add(o.name || '(unnamed)')
    })
    let laundry = false, ropes = false
    r3.scene.traverse((o) => {
      if (o.name === 'laundryLines') laundry = true
      if (o.name === 'lanternRopes') ropes = true
    })
    return { water, paving, seen: [...seen], laundry, ropes }
  })
  {
    // name -> the prerequisite that excuses its absence, and how much is
    // needed. `null` means it should exist in every town, always.
    const EXPECT = [
      ['smoke', null], ['fireflies', null], ['birds', null], ['moths', null],
      ['rainfall', null], ['snowfall', null],
      ['rivermist', ['water', 12]], ['pigeons', ['paving', 8]],
    ]
    const gone = []
    for (const [name, req] of EXPECT) {
      if (census.seen.includes(name)) continue
      if (req && census[req[0]] < req[1]) {
        console.log(`  ${name}: absent, and correctly — the town has ` +
          `${census[req[0]]} ${req[0]} tiles against ${req[1]} needed.`)
      } else {
        gone.push(name)
      }
    }
    console.log(`  systems:   ${census.seen.length} drawn ` +
      `(town has ${census.water} water, ${census.paving} paving tiles)` +
      (census.laundry ? '' : '  ·  NO WASHING LINES'))
    if (gone.length) {
      missingSystems += gone.length
      console.log(`             ^ MISSING with its prerequisite present: ${gone.join(', ')}`)
    }
    const ls0 = await win.evaluate(() => (window.__pt.lanternStats
      ? window.__pt.lanternStats() : null))
    if (ls0) {
      console.log('  washing:   ' + Object.entries(ls0)
        .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  '))
    }
    if (!census.laundry) {
      laundryGaps++
      // WHY, not just that. The four ways a pair can fail to carry washing
      // are indistinguishable in a zero, and the counters are already in the
      // source — reading them is what turns this line from a report into an
      // answer.
      const ls = await win.evaluate(() => (window.__pt.lanternStats
        ? window.__pt.lanternStats() : null))
      if (ls) {
        console.log('             ^ why: ' + Object.entries(ls)
          .sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('  '))
      }
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
  `mist over water ${mistWater === null ? 'n/a' : mistWater + '%'} worst seed, ` +
  `${mistOffRiver} off the river; ` +
  `${reactFails} seeds where nothing reacts to the player; ` +
  `${swayFails} hanging-sway failures, ${swayBlind} hanging meshes unseeable at their own box; ` +
  `window spill +${spillMean === null ? 'n/a' : spillMean} mean luma worst seed, ${spillDead} contributing nothing; ` +
  `${missingSystems} systems missing with ` +
  `their prerequisite present; ${laundryGaps} seeds with no washing lines.`)
console.log('  `spread` is each system\'s x-extent as a fraction of the town\'s;')
console.log('  `cam` means the system travels with the player and is graded on')
console.log('  whether its box is centred there instead.')
console.log('  A system at a clean ~0.33 is the TILE bug: tile coordinates used')
console.log('  as world coordinates, which is exactly how chimney smoke spent')
console.log('  the whole tile rescale venting over the wrong third of the map.')
console.log('  No target for HOW MUCH motion is enough — that is a judgement,')
console.log('  and three hand-written targets in this repo were all wrong.')

await app.close()
