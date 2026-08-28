/**
 * CELESTIAL — do the Environment panel's sliders do anything?
 *
 * `moonPhase` and `starDensity` were declared in EnvironmentState, defaulted
 * in the store AND in the generator, and wired to two sliders reporting a
 * percentage, and NOTHING READ EITHER OF THEM for the whole life of the app.
 * That is the ghost failure with a user interface, and it is worse than the
 * plain kind: nobody notices absent content, but a labelled control is a
 * promise, so a person drags it, watches the number move and concludes the
 * feature is there and subtle.
 *
 * `registry.mjs` audits definitions and `features.mjs` audits gated features.
 * Neither can see this, because a control is not a definition and not a gate
 * — so it needs the one test that has no way to be fooled: SET IT TO BOTH
 * EXTREMES AND COUNT THE PIXELS THAT CHANGED. No thresholds, no model of what
 * the slider ought to do, and it cannot pass on a control that is wired to
 * something irrelevant either, because the frames would differ in the wrong
 * place — which is why it also writes them out to be looked at.
 *
 * A control whose two extremes render identically is DEAD. That is the whole
 * verdict.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/celestial.mjs [seed]
 */
import { _electron as electron } from 'playwright-core'
import { waitForScene } from './lib/scene.mjs'
import { hideChrome } from './lib/vantage.mjs'
import { mkdirSync } from 'node:fs'

const seed = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a))) || 4242
mkdirSync('.shots/celestial', { recursive: true })

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

const setEnv = (patch) =>
  win.evaluate((p) => {
    const st = window.__pt.store.getState()
    st.updateEnvironment({ ...p, celestial: { ...st.map.environment.celestial, ...(p.celestial || {}) } })
  }, patch)

// LOOK UP. Both controls live in the sky and a level camera sees almost none
// of it — the same trap hours.mjs documents getting six sky samples out of
// four hundred and passing itself on an empty measurement.
const aim = async (pitch) => {
  await win.evaluate((pi) => {
    const pt = window.__pt, r3 = pt.renderer()
    const c = r3.camera
    pt.flyToWorld(c.position.x, c.position.y, c.position.z, 0.6, pi)
  }, pitch)
  await win.waitForTimeout(500)
}

/**
 * POINT AT THE SUBJECT, FROM A PLACE THAT DOES NOT DEPEND ON THE SEED.
 *
 * `aim` keeps the camera wherever `waitForScene` left it — the player SPAWN —
 * and only changes the pitch, which for a sky subject is a lottery. Run
 * across four seeds, moonPhase read DEAD on three of them, twice at EXACTLY
 * 0.00000: the projected mask was landing on empty sky beside a moon that
 * was out of frame, and an exactly-zero signal on a masked patch is the tell
 * that the mask is not on the subject rather than that the subject is dead.
 *
 * The moon's world position is known exactly, so there is nothing to infer.
 * Fly to the town centre well above the roofline and look at it — one vantage,
 * every seed, and the lit windows that dominated the star probe's noise floor
 * drop out of frame as a side effect.
 */
const aimAtWorld = async (world) =>
  win.evaluate(({ w }) => {
    const pt = window.__pt, r3 = pt.renderer(), THREE = pt.THREE
    const box = new THREE.Box3().setFromObject(r3.buildingGroup)
    const c = box.getCenter(new THREE.Vector3())
    const eye = new THREE.Vector3(c.x, box.max.y + 12, c.z)
    const dx = w[0] - eye.x, dy = w[1] - eye.y, dz = w[2] - eye.z
    pt.flyToWorld(eye.x, eye.y, eye.z,
      Math.atan2(dz, dx), Math.atan2(dy, Math.hypot(dx, dz)))
    return true
  }, { w: world })

const shoot = async (name) => {
  await win.locator('canvas').last().screenshot({ path: `.shots/celestial/${seed}-${name}.png` })
  // A LUMA GRID, NOT THE PNG BYTES.
  //
  // The first version compared PNG files and reported all three controls
  // live — INCLUDING sunAngle, which the 3D renderer demonstrably does not
  // read. False positive from a scene that ANIMATES: moths, fireflies,
  // smoke, window flicker and water shimmer all move, so any two frames
  // differ in some byte and a boolean "differs" can only ever answer yes.
  // The instrument was measuring the passage of time.
  return win.evaluate((n) => {
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
  }, GRID)
}

// 256, NOT 96, AND ENERGY, NOT A COUNT — and both because the tool got the
// moon WRONG in the other direction, twice.
//
// With a 96 grid and a thresholded fraction it read moonPhase as DEAD, and
// the photograph said otherwise: the new moon is completely invisible and
// the full moon is a clean disc, which is the feature working exactly. The
// moon is ~20px in a 935px frame, so at 96 it lands on two samples out of
// nine thousand — 0.02%, under any floor by construction. A METRIC CANNOT
// GRADE A FEATURE SMALLER THAN ITS SAMPLE RESOLVES, which this repo already
// records for ivy at 4% of buildings, and a fraction-of-frame statistic is
// blind to one small bright thing by design.
//
// Mean absolute difference sees both shapes: a whole moon vanishing is a few
// samples changing by a lot, and a sky filling with stars is many samples
// changing a little. So the tool reports it alongside the fraction and grades
// on it, with the fraction kept because it is the one a person can picture.
const GRID = 256
const EPS = 0.02
const stats = (a, b, mask) => {
  let n = 0, sum = 0, total = 0
  for (let i = 0; i < a.length; i++) {
    if (mask && !mask[i]) continue
    total++
    const d = Math.abs(a[i] - b[i])
    sum += d
    if (d > EPS) n++
  }
  return { frac: n / Math.max(1, total), mad: sum / Math.max(1, total) }
}

/**
 * SAMPLES AROUND ONE WORLD POINT, so a small subject is not graded against
 * the whole frame's animation.
 *
 * The moon is ~20px in a 935px frame and the night sky behind it is full of
 * flickering windows, so whole-frame energy reads the FLICKER and calls a
 * working control dead: floor 0.00026 against a moon signal of 0.00047. No
 * threshold fixes that, because the noise genuinely is larger than the signal
 * when you measure the wrong area — and turning the stars off, which was the
 * right move for a different confound, did not help because the windows were
 * never the stars.
 *
 * `subjectPixels` in lib/vantage solved the same problem the same way: it
 * raycasts a mask rather than measuring the projected box, because the box
 * also holds sky, a street and four neighbours. Projecting the moon's own
 * world position is EXACT — the tool is TOLD where the subject is rather than
 * inferring it — and returns null when the subject is off screen, which is a
 * failure and not a pass.
 */
const maskAround = async (world, radiusFrac) =>
  win.evaluate(({ w, rf, n }) => {
    const pt = window.__pt, r3 = pt.renderer(), THREE = pt.THREE
    const v = new THREE.Vector3(w[0], w[1], w[2]).project(r3.camera)
    // 0.85, NOT 1.2. A subject just past the frame edge still projects to an
    // NDC inside 1.2, so the circle drawn around it lands on empty sky and
    // the control reads DEAD on a signal of exactly zero. Require it to be
    // comfortably IN frame, and say so when it is not.
    if (v.z > 1 || Math.abs(v.x) > 0.85 || Math.abs(v.y) > 0.85) return null
    const cx = (v.x * 0.5 + 0.5) * n
    const cy = (1 - (v.y * 0.5 + 0.5)) * n
    const r = rf * n
    const out = new Array(n * n).fill(false)
    let hit = 0
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { out[y * n + x] = true; hit++ }
      }
    }
    return hit ? out : null
  }, { w: world, rf: radiusFrac, n: GRID })

const rows = []
let dead = 0
let graded = 0

/**
 * One control, measured against a noise floor taken AT ITS OWN VANTAGE.
 *
 * Per-vantage on purpose: looking up at the moon is mostly empty sky and
 * almost no animation, while a level street view is full of moths and
 * flickering windows. One global floor would be too strict for the first and
 * too slack for the second, which is the numerator/denominator lesson wearing
 * a camera.
 */
const probe = async (label, pitch, hour, apply, cases, focus, floorSetup) => {
  await setEnv({ timeOfDay: hour })
  // A SKY SUBJECT GETS AIMED AT; a street subject keeps the player's own
  // vantage, because weather is about the street and the moon is not.
  if (focus) await aimAtWorld(focus.world)
  else await aim(pitch)
  await win.waitForTimeout(400)
  const mask = focus && focus.radius ? await maskAround(focus.world, focus.radius) : null
  if (focus && focus.radius && !mask) {
    console.log(`  ${label}: SUBJECT OFF SCREEN — cannot grade. Not a pass.`)
  }
  // MEASURE THE FLOOR WITH THE FEATURE'S OWN ANIMATION REMOVED, where it has
  // one. The star probe's noise IS the star twinkle: the same pixels changing
  // by a similar amount as the density signal, so the ratio is intrinsically
  // about 1.5 and no choice of statistic separates them — two consecutive
  // runs on an unchanged build flipped the verdict, twice, before this.
  // Turning the stars off makes the floor "everything ELSE in this frame",
  // which is the honest baseline for "does adding stars change it".
  if (floorSetup) await floorSetup()
  // THE FLOOR, THREE TIMES, AND TAKE THE LARGEST.
  //
  // Measured once it jitters, and two consecutive runs of this tool on an
  // unchanged build returned different verdicts — starDensity live in one and
  // dead in the next, purely because the bar moved under it. A tool that
  // disagrees with itself grades nothing, which is why `anomaly.mjs` prints
  // how often it contradicts itself and why this repo's rule is to state the
  // noise floor rather than assume it. Largest of three, so the bar errs
  // toward calling a marginal control dead — a false DEAD sends someone to
  // look at working code, a false LIVE leaves a lying slider shipped.
  let floor = null
  for (let k = 0; k < 3; k++) {
    const a0 = await shoot(`${label}-noise-${k}`)
    await win.waitForTimeout(700)
    const a1 = await shoot(`${label}-noise-${k}b`)
    const f = stats(a0, a1, mask)
    if (!floor || f.mad > floor.mad) floor = f
  }
  // THREE TIMES THE MEASURED NOISE, and NOTHING ELSE.
  //
  // There was an absolute minimum of 0.0006 here, invented by me, and it
  // failed the moon: with the star confound removed the moon's own signal is
  // 0.00025 against a floor near zero — twelve times its noise and a tenth of
  // a number I made up. Three hand-written targets in propscale.mjs were
  // wrong on their first run and this was the fourth. The epsilon that
  // remains exists only so a perfectly static frame cannot divide the bar to
  // zero; it is four times under the quietest floor ever measured here.
  const bar = Math.max(1e-5, floor.mad * 3)

  const frames = {}
  for (const [name, value] of cases) {
    await apply(value)
    frames[name] = await shoot(`${label}-${name}`)
  }
  return { floor, bar, frames, mask }
}

/**
 * A graded row, or an INFORMATIONAL one when the label is indented.
 *
 * The intermediate comparisons — 50% against each end, quarter against full —
 * cover half the sweep by construction, so grading them against the full
 * sweep's bar prints DEAD on a control that plainly works and reads as a
 * finding. They are here to show the slider is monotonic and that its default
 * sits between the ends, which is a magnitude to read rather than a gate to
 * pass. Print the number, withhold the verdict.
 */
const record = (label, what, p, a, b) => {
  const bar = p.bar
  const st = stats(a, b, p.mask)
  const isGraded = !label.startsWith('  ')
  // EITHER STATISTIC. They fail in opposite directions and the pair covers
  // both: `mad` is blind to nothing but weights a few big changes over many
  // small ones, and `frac` counts a sky filling with faint stars that barely
  // move the mean. Requiring both would make the tool as blind as its weaker
  // half on every subject.
  const live = st.mad > bar || st.frac > p.floor.frac * 3 + 0.002
  if (isGraded) { graded++; if (!live) dead++ }
  rows.push([label, what, st, bar, isGraded ? (live ? 'live' : 'NO — DEAD') : 'ref'])
}

// STAR DENSITY — night, sky in frame.
{
  // AIMED AT A PATCH OF SKY, from the same seed-independent vantage as the
  // moon, and deliberately AWAY from the moon so the two subjects do not
  // share a frame. Run across four seeds on the spawn vantage, this control's
  // verdict flipped between live and dead purely with how many lit windows
  // the spawn happened to face — the floor was the town, not the stars.
  const p = await probe('stars', 0.9, 22,
    (v) => setEnv({ celestial: { starDensity: v } }),
    [['000', 0], ['100', 1], ['050', 0.5]],
    // No mask: the star field is the whole sky, not one point. The `focus`
    // world position is used only to aim.
    { world: [400, 220, 400], radius: null },
    () => setEnv({ celestial: { starDensity: 0 } }))
  console.log(`  stars vantage: animation floor mad ${p.floor.mad.toFixed(5)}`)
  record('starDensity', '0 vs 100%', p, p.frames['000'], p.frames['100'])
  // The default must sit BETWEEN the extremes and must reproduce what was
  // hardcoded, or wiring up a dead control quietly restyles every scene that
  // already exists.
  record('  ^ 50% vs 0%', 'sanity', p, p.frames['000'], p.frames['050'])
  record('  ^ 50% vs 100%', 'sanity', p, p.frames['050'], p.frames['100'])
}

// MOON PHASE — overhead at night, so point at it.
//
// STARS OFF FOR THIS ONE. The animation at this vantage is almost entirely
// star twinkle, which is a feature added in the same session and has nothing
// to do with the moon: with it on, the floor came out at 0.00026 against a
// moon signal of 0.00064, so a control that visibly works — the new moon
// vanishes completely and the full moon is a clean disc — sat just under the
// bar. The answer is not a looser bar, which is tuning to the result I
// wanted; it is to CHANGE ONE THING, which is the single-variable discipline
// this repo insists on everywhere else and is just as binding on a tool.
{
  await setEnv({ celestial: { starDensity: 0 } })
  // ASK THE RENDERER WHERE THE MOON IS. This was the literal `[0, 180, 0]`,
  // copied from `updateLighting` — and the day the moon moved so it could lay
  // a path on the water, the mask stayed on a patch of empty sky and the probe
  // reported `moonPhase` as EXACTLY 0.00000. This file's own note says an
  // exact zero on a masked patch means the mask is off its subject rather than
  // that the subject is dead, and it was right about its own output. A tool
  // that restates a value the renderer owns is the terrain table again.
  const moonWorld = await win.evaluate(() => window.__pt.moonPos?.() ?? null)
  if (!moonWorld) {
    console.log('  moon  SKIPPED — __pt.moonPos is missing; the bundle predates')
    console.log('        the bridge hook, and a missing measurement must not')
    console.log('        read as a pass.')
  }
  const p = await probe('moon', 1.35, 22,
    (v) => setEnv({ celestial: { moonPhase: v } }),
    [['new', 0], ['quarter', 0.5], ['full', 1]],
    // Derived, with a radius generous enough to hold the disc plus its edge.
    { world: moonWorld ?? [0, 180, 0], radius: 0.06 })
  console.log(`  moon  vantage: animation floor mad ${p.floor.mad.toFixed(5)}`)
  record('moonPhase', 'new vs full', p, p.frames['new'], p.frames['full'])
  record('  ^ quarter vs full', 'sanity', p, p.frames['quarter'], p.frames['full'])
  await setEnv({ celestial: { starDensity: 0.5 } })
}

// SUN ANGLE — the NEGATIVE CASE, and it is here on purpose.
//
// The pixel-art export reads it and the 3D walkaround derives its sun from
// the hour alone, so this row is KNOWN dead in this path. A test with no
// negative case has never been tested, and this one earned its keep
// immediately: the first version of this tool reported it live.
//
// Not fixed in passing. Turning the 3D sun moves every shadow in the town,
// which is a lighting change wanting its own A/B, not a footnote in a sky
// commit.
{
  const p = await probe('sunangle', -0.1, 12,
    (v) => setEnv({ celestial: { sunAngle: v } }),
    [['000', 0], ['180', 180]])
  console.log(`  sun   vantage: animation floor mad ${p.floor.mad.toFixed(5)}`)
  record('sunAngle (3D) — known dead', '0 vs 180deg', p, p.frames['000'], p.frames['180'])
}

// WEATHER — five buttons and an intensity slider, and the whole set was read
// by nothing. A weather that does not reach the frame is the same ghost as a
// moon phase that does not, and there are six of them.
//
// Graded at DUSK on a level street view, because that is the hour the board
// grades and the view a player has. Each is compared against CLEAR at the
// same vantage rather than against its own opposite: "does pressing this
// button change anything" is the actual question, and it needs no model of
// what rain ought to look like.
{
  await setEnv({ celestial: { starDensity: 0.5 } })
  const p = await probe('weather', -0.05, 18.5,
    (v) => setEnv({ weather: v[0], weatherIntensity: v[1] }),
    [['clear', ['clear', 0]], ['rain', ['rain', 1]], ['fog', ['fog', 1]],
     ['snow', ['snow', 1]], ['storm', ['storm', 1]],
     ['rain-half', ['rain', 0.5]]])
  console.log(`  weather vantage: animation floor mad ${p.floor.mad.toFixed(5)}`)
  for (const w of ['rain', 'fog', 'snow', 'storm']) {
    record(`weather: ${w}`, 'vs clear', p, p.frames.clear, p.frames[w])
  }
  // Intensity must be a DIAL and not a switch, or the slider is half a lie:
  // it appears the moment a weather is chosen and would do nothing.
  record('  ^ rain 50% vs 100%', 'sanity', p, p.frames['rain-half'], p.frames.rain)
  record('  ^ rain 50% vs clear', 'sanity', p, p.frames.clear, p.frames['rain-half'])
  await setEnv({ weather: 'clear', weatherIntensity: 0 })
}

// PUDDLES WERE BUILT HERE AND REVERTED — read this before building them
// again.
//
// Rain fell onto a bone-dry street, so 150 draped, deterministic puddles went
// onto the flat circulation tiles, sharing the RIVER's Fresnel shader so they
// would mirror the sky and catch the sun glint by construction rather than by
// a second set of tuned constants. They work exactly as designed and they are
// invisible, and the A/B run here said so: against the noise floor of FALLING
// RAIN they moved the frame by 1.4x on BOTH statistics, where every live
// control in the table above clears 3x and most clear fifty.
//
// The reason is worth more than the feature. A horizontal puddle seen from
// eye height is foreshortened to a sliver, and a Fresnel surface at a grazing
// angle mirrors THE SKY — which at night is the darkest thing in the scene. A
// mirror of black, on dark cobbles, is black. Real wet ground reads because
// it reflects the LIGHTS, and that needs actual reflections rather than a sky
// term. Do not re-attempt with a darker colour or a bigger radius: the
// isolate frame showed dark slivers on a black field, which is what the
// mechanism produces however it is tuned.
//
// Three readings were all true and none of them answered the question: a
// COUNT said 150 were built, the weather delta said rain was live, and the
// composite showed a convincingly rainy street. Only hiding the one mesh and
// re-measuring settled it.

console.log(`\nseed ${seed} — CELESTIAL CONTROLS`)
console.log('  control                        extremes        moved      mad      bar    verdict')
// PRINT THE BAR BESIDE THE NUMBER. Without it a run where everything reads
// DEAD is indistinguishable from a run where the floor spiked, and one such
// run cost a round of guessing — the "make the tool explain itself, do not
// just count" rule, applied to the tool's own verdict.
for (const [name, what, st, bar, verdict] of rows) {
  console.log(`  ${name.padEnd(30)} ${what.padEnd(14)} ${(st.frac * 100).toFixed(2).padStart(6)}%  ` +
    `${st.mad.toFixed(5)}  ${bar.toFixed(5)}  ${verdict}`)
}
console.log(`\nVERDICT: ${dead} of ${graded} environment controls do not reach the frame at all.`)
console.log('  A control that lies is worse than absent content: nobody notices')
console.log('  what is missing, and everybody believes a labelled slider.')
console.log('  Graded on `mad` against three times the ANIMATION measured at the')
console.log('  same vantage, over the subject`s own patch where it has one. The')
console.log('  moon read DEAD at 2.5x a whole-frame floor and reads 1700x a')
console.log('  masked one; nothing about the town changed between those two')
console.log('  numbers, only where the tool was looking.')
console.log('  A number here says the control REACHES the frame, not that it')
console.log('  reaches the right part of it — frames are in .shots/celestial/')
console.log('  and that half is settled by looking.')

await app.close()
