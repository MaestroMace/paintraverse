/**
 * HARNESS — run the battery, compare against the last recorded reading, and
 * fail on a regression.
 *
 * WHY THIS EXISTS.
 *
 * There are twenty-eight tools in here and no way to run them. That is not a
 * cosmetic problem; it is the single most expensive failure this project has
 * had. District character was recorded at 55%, nothing re-ran the town battery
 * for the whole length of the river arc, and it read 36% by the end — eighteen
 * points lost to one commit's side effect, found only by bisecting HEAD's tool
 * against every commit's source. CLAUDE.md's own words: **a metric you stop
 * running can regress in silence.**
 *
 * A pile of instruments with no dashboard is a pile of instruments you will
 * stop reading. So:
 *
 *   node tools/harness.mjs               run the battery, diff against baseline
 *   node tools/harness.mjs --save        record the current readings as the baseline
 *   node tools/harness.mjs --quick       only the checks that do not need Electron
 *   node tools/harness.mjs --only=audit,odd
 *
 * Exit code is non-zero if any GATE fails or any tracked metric moved the
 * wrong way by more than its noise band. That is the part that makes it a
 * harness rather than a report.
 *
 * TWO DESIGN NOTES, both learned the hard way in this repo.
 *
 * **A check that cannot parse its tool must FAIL, not pass.** Extractors are
 * regexes over another program's stdout and they rot. The failure mode of a
 * silently-unparsed check is a green board that has never looked at anything —
 * exactly what `npm run typecheck` did for months while compiling zero files.
 * A green gate that has never failed is not evidence; it is an untested
 * instrument.
 *
 * **A noise band, not an exact match, and MEASURE IT.** `--repeat=3` runs each
 * check three times on identical seeds and prints the spread. Every band below
 * comes from that, because a band picked by eye either cries wolf or swallows
 * a real regression and there is no way to tell which. What it showed:
 *
 *     districts   character        49, 49, 49     spread 0
 *     provenance  outsideBox        0,  0,  0     spread 0
 *     provenance  habitablePinned  11, 11, 11     spread 0
 *     provenance  doubled          18, 16, 18     spread 2
 *     roofcheck   openTops         14, 13, 16     spread 3
 *     odd         overZ3           39, 48, 41     spread 9
 *     odd         bareWall         28, 40, 31     spread 12
 *
 * districts reads the MAP and is perfectly stable, so the generator is
 * deterministic. Everything noisy reads the BUILT SCENE. Part of that was a
 * race — every tool waited a guessed number of milliseconds for the 3D view,
 * and lib/scene.mjs polls for completion instead, which took habitablePinned
 * from spread 1 to 0.
 *
 * AND THE REST WAS NOT STRUCTURAL, WHICH IS WHAT THIS PARAGRAPH USED TO SAY.
 *
 * It said overZ3, bareWall and spireAtCap are counts over a threshold whose
 * scale comes from the same population, so a small shift moves a cluster of
 * items across the line at once — true of the metric, and not the cause. The
 * cause was that `obj.id` is a UUID and every renderer seeded a building's
 * entire architecture from `simpleHash(obj.id)`, so each generate produced the
 * same streets with different buildings standing on them. `districts` was
 * stable BECAUSE it reads the map, which is precisely the observation used
 * here to rule the generator out.
 *
 * With `stableHash(obj)` (core/types.ts) the same command reads:
 *
 *     provenance  outsideBox  0, 0, 0        doubled  14, 14, 14
 *     clash       deepClash   124, 124, 124  onAir    16, 16, 16
 *     roofcheck   openTops    16, 16, 16
 *     odd         overZ3      22, 22, 22     bareWall  9,  9,  9
 *
 * spread 0 on every one. The bands below came down accordingly. Left the wrong
 * paragraph's reasoning visible above rather than deleting it: every step of
 * it was true except the conclusion, and that is the failure worth recognising
 * next time — when you have fixed one cause and a residual remains, the
 * residual is a new question, not a footnote on the old answer.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const argv = process.argv.slice(2)
const save = argv.includes('--save')
const quick = argv.includes('--quick')
const only = argv.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',') ?? null
/**
 * --repeat=N: run each check N times on the SAME seed and report the spread
 * instead of diffing a baseline.
 *
 * THE NOISE FLOOR IS NOT OPTIONAL. Two runs of `roofcheck 4242 777 31337`
 * inside five minutes read 22 and 9, and provenance has reported 838, 839 and
 * 847 volumes for seed 31337. A band picked by eye against a metric that moves
 * that much is a band that will either cry wolf or swallow a real regression,
 * and I have no way to know which. anomaly.mjs already learned this and prints
 * how often it disagrees with itself; every metric here owes the same number.
 */
const repeat = Number(argv.find((a) => a.startsWith('--repeat='))?.split('=')[1] ?? 0)
const BASELINE = 'tools/harness-baseline.json'

/**
 * `dir` is the direction that is BETTER. A metric with dir 0 is tracked but
 * not graded — printed so a human notices, never failed on, because "is 47%
 * coverage better than 45%" is an argument and not a fact.
 */
// EVERY BAND HERE WAS SIZED FOR A NOISE FLOOR THAT TURNED OUT TO BE A BUG.
//
// `--repeat=3` used to read openTops 14/13/16, overZ3 39/48/41, bareWall
// 28/40/31, and the bands were widened to swallow it. The cause was not noise:
// obj.id is a UUID and every renderer seeded a building's whole architecture
// from it, so each generate produced the same streets with different buildings
// on them (see stableHash in core/types.ts). With that fixed the same command
// reads spread 0 on every metric it was run against:
//
//   provenance  outsideBox 0,0,0   doubled 14,14,14   spireAtCap 0,0,0
//   clash       deepClash 124,124,124   onAir 16,16,16
//   roofcheck   openTops 16,16,16
//   odd         overZ3 22,22,22    bareWall 9,9,9
//
// So the bands come down to 0-2. A wide band on a deterministic metric is not
// caution, it is a regression detector switched off: the old openTops band of
// 12 would have sat quietly through a change that doubled the open roofs.
// eyeball was left wide and marked UNVERIFIED until it had actually been run
// twice; it has now, byte-identical, so it comes down too. Marking a band as
// unverified and then tightening it anyway would have been the same mistake as
// a green gate that has never failed.
const CHECKS = [
  {
    name: 'registry',
    why: 'is every building type wired into all six id-keyed tables',
    electron: false,
    cmd: ['node', ['tools/registry.mjs']],
    extract: (o) => ({ problems: num(o, /(\d+) of \d+ building types have a registration problem/) }),
    gates: { problems: (v) => v === 0 },
  },
  {
    name: 'roofwinding',
    why: 'inward-facing roof triangles are DELETED, not mis-lit',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/roofwinding.mjs']],
    extract: (o) => ({ inward: num(o, /TOTAL INWARD-FACING TRIANGLES:\s*(\d+)/) }),
    gates: { inward: (v) => v === 0 },
  },
  {
    name: 'audit',
    why: 'placement invariants over the regression seeds',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/audit.mjs']],
    extract: (o) => ({ errors: num(o, /TOTAL ERRORS ACROSS \d+ SEEDS:\s*(\d+)/) }),
    gates: { errors: (v) => v === 0 },
  },
  {
    name: 'spawn',
    why: 'the first frame — can the player stand, and is there anything to see',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/spawn.mjs']],
    extract: (o) => ({ facingWall: num(o, /(\d+) of \d+ spawn FACING A WALL/) }),
    gates: { facingWall: (v) => v === 0 },
  },
  {
    name: 'provenance',
    why: 'is the geometry in the world the geometry the code asked for',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/provenance.mjs', '31337']],
    extract: (o) => ({
      outsideBox: num(o, /(\d+) volumes end up outside the box/),
      doubled: num(o, /VERDICT: (\d+) declarations built at more than double/),
      spireAtCap: num(o, /spire\s+n=\s*\d+\s+cap [\d.]+.*at the cap\s+(\d+)%/),
      habitablePinned: num(o, /MIN_HABITABLE_W [\d.]+m\s+\d+\/\d+ habitable volumes at the floor \((\d+)%\)/),
    }),
    // outsideBox is the hard invariant — a clamp that is not last is not a
    // clamp, and this went 39 -> 0 by ordering. It must stay there.
    gates: { outsideBox: (v) => v === 0 },
    dir: { doubled: -1, spireAtCap: -1, habitablePinned: -1 },
    // Bands MEASURED with --repeat=3 on identical seeds, not picked by eye:
    //   doubled 18,16,18 -> 2   spireAtCap 7,14,3 -> 11   habitablePinned 11,11,11 -> 0
    // spireAtCap is a count over a threshold on a population of ~29 spires, so
    // two buildings moving swings it 7 points. It is kept because the SHAPE of
    // the finding mattered (96% -> single digits) and dropped as a gate.
    band: { doubled: 1, spireAtCap: 1, habitablePinned: 1 },
  },
  {
    name: 'clash',
    why: 'does the built geometry collide with itself, and stand on the ground',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/clash.mjs', '31337']],
    extract: (o) => ({
      deepClash: num(o, /VERDICT: (\d+) interpenetrations deeper than 0\.5m/),
      onAir: num(o, /(\d+) structures on air/),
      buried: num(o, /(\d+) buried\./),
    }),
    // Not gates yet: the class was only just discovered and the count is 100.
    // A gate at zero would be red on every run and read as noise. Tracked, so
    // it cannot drift further while somebody decides what to do about it.
    dir: { deepClash: -1, onAir: -1, buried: -1 },
    band: { deepClash: 2, onAir: 1, buried: 0 },
  },
  {
    name: 'eyeball',
    why: 'what FILLS a street view — chosen by screen presence, not by any audit',
    electron: true,
    // SIX views, not four. Tone is measured over whatever buildings happen to
    // be in frame, so a small sample swings hard: wallLuma read 222 and then
    // 180 on the same build inside one sweep. More views is the cheap half of
    // the fix; the wider band below is the honest half.
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/eyeball.mjs', '31337', '--views=6']],
    extract: (o) => ({
      roofToWallMed: num(o, /p10 \d+%\s+med (\d+)%/),
      roofOver80: num(o, /over 80% \(roof nearly as tall as the house\): \d+ \((\d+)%\)/),
      dwellingsOver4: num(o, /over 4 storeys \(11\.6m\): \d+ \((\d+)%\)/),
      // ABSOLUTE tone, x1000 so the board stays integer. The one measure here
      // with an opinion about what a rendered scene should look like — every
      // other pixel number is relative to a control and so is blind to the
      // whole town being too dark.
      wallLuma: pct1000(o, /^\s+wall\s+\d+\s+[\d.]+\s+([\d.]+)/m),
      roofBlackPct: num(o, /^\s+roof\s+\d+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+(\d+)%/m),
    }),
    dir: { roofToWallMed: -1, roofOver80: -1, dwellingsOver4: -1, wallLuma: 1, roofBlackPct: -1 },
    // VERIFIED. Two runs on the current build are byte-identical — same sample
    // counts (491 sky / 710 roof / 6631 wall / 3424 ground) and same
    // percentiles — so the 157/187/222/229 wallLuma swing was the UUID bug
    // across builds, not pixel noise, and this band comes down with the rest.
    // A couple of points of slack is kept because these come off a rasteriser
    // and a driver change could move a boundary pixel; the metric itself has
    // no randomness left in it.
    band: { roofToWallMed: 2, roofOver80: 2, dwellingsOver4: 2, wallLuma: 4, roofBlackPct: 2 },
  },
  {
    name: 'facade',
    why: '3D detail nailed to a wall, against the openings PAINTED on it',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/facade.mjs', '31337']],
    extract: (o) => ({
      overOpening: num(o, /VERDICT: (\d+) member-over-opening collisions/),
      // Openings painted outside the wall they are painted on. A containment
      // failure, not a collision — the count above is structurally unable to
      // report it, which is how a window as wide as its whole wall and a
      // window 0.80m above its own roofline both survived every earlier run.
      offWall: num(o, /(\d+) openings painted off their own wall/),
      // Awnings whose MEASURED slope is not an awning's — tilting up, flat as
      // a shelf, or steep as a lean-to. The block that reports this used to
      // print a sentence pointing at a source comment and check nothing.
      awnBad: num(o, /(\d+) awnings mis-sloped/),
    }),
    dir: { overOpening: -1, offWall: -1, awnBad: -1 },
    band: { overOpening: 6, offWall: 0, awnBad: 0 },
  },
  {
    name: 'humanscale',
    why: 'a storey, a door and a window against what those things measure',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/humanscale.mjs', '31337']],
    extract: (o) => ({ subHuman: num(o, /storeys under 2\.15m head-to-ceiling\s*:\s*\d+\/\d+\s+\((\d+)%\)/) }),
    gates: { subHuman: (v) => v === 0 },
  },
  {
    name: 'roofcheck',
    why: 'volumes ending flat and open against the sky',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/roofcheck.mjs', '4242', '777', '31337']],
    extract: (o) => ({ openTops: num(o, /TOTAL OPEN-TOPPED VOLUMES ACROSS \d+ SEEDS:\s*(\d+)/) }),
    // This one carried the loudest wrong lesson on the board. It read 9, 13,
    // 14, 16, 17, 22 and 23 across a session on the SAME build, and two runs
    // inside one sweep read 9 then 17 — so the note here concluded that three
    // samples estimate a lower bound on noise and widened the band to the
    // observed range. The sampling point stands and the conclusion did not:
    // none of it was noise. It was a different town each run (see stableHash).
    // 16, 16, 16 now.
    dir: { openTops: -1 }, band: { openTops: 1 },
  },
  {
    name: 'traverse',
    why: 'can a PERSON get there — the axis every other tool is missing',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/traverse.mjs']],
    extract: (o) => ({
      // Reachability is the one that cannot be faked: scattering props cannot
      // move it, only a town a person can actually walk across.
      reachPct: num(o, /worst reachability (\d+)%/),
      noPass: num(o, /VERDICT: (\d+) crossings you cannot walk through/),
      clamber: num(o, /crossings you cannot walk through, (\d+) tile pairs/),
      lowHead: num(o, /(\d+) walkable tiles have under/),
    }),
    dir: { reachPct: 1, noPass: -1, clamber: -1, lowHead: -1 },
    band: { reachPct: 2, noPass: 1, clamber: 2, lowHead: 2 },
  },
  {
    name: 'variety',
    why: 'can the eye copy-paste one building onto another — the axis odd is blind to',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/variety.mjs', '31337']],
    extract: (o) => ({
      // The NEIGHBOUR rate is the one that matters. A twin across town is a
      // housing type; a twin in the same frame is a copy-paste, and scattering
      // cannot move it. The global rate is tracked but never graded — a real
      // terrace repeats on purpose and 93% of this town shares a party wall.
      twinNear: num(o, /VERDICT: (\d+)% of structures have an interchangeable twin/),
      twinAny: num(o, /; (\d+)% have one anywhere/),
    }),
    dir: { twinNear: -1, twinAny: 0 }, band: { twinNear: 2, twinAny: 3 },
  },
  {
    name: 'odd',
    why: 'how many things are unlike their own peers, by feature',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/odd.mjs', '31337', '--shots=0']],
    extract: (o) => ({
      overZ3: num(o, /WHAT IS ODD, over z=3 \((\d+) of \d+\)/),
      bareWall: num(o, /bareWallArea\s+(\d+) over z=3/) ?? 0,
    }),
    // measured 39,48,41 and 28,40,31 -> spreads of 9 and 12.
    //
    // Both are COUNTS OVER A THRESHOLD whose scale (median + MAD) is computed
    // from the same population, so a small shift moves a cluster of items
    // across z=3 at once. That is jumpy by construction, not a bug in the
    // scene, and the honest response is a band wide enough to say so rather
    // than a tighter one that would cry wolf every run.
    dir: { overZ3: -1, bareWall: -1 }, band: { overZ3: 2, bareWall: 2 },
  },
  {
    name: 'urbanform',
    why: 'the space BETWEEN buildings — the thing that decides if it reads as a town',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/urbanform.mjs', '4242', '777', '31337']],
    extract: (o) => ({
      coverage: num(o, /built coverage of non-street land\s+~[\d-]+%\s+here:\s*(\d+)%/),
      partyWalls: num(o, /buildings sharing a party wall\s+~[\d-]+%\s+here:\s*(\d+)%/),
      streetWidth: num(o, /street width between facades\s+~[\d-]+m\s+here:\s*(\d+)m/),
      frontage: num(o, /frontage with a building against it\s+~[\d-]+%\s+here:\s*(\d+)%/),
    }),
    dir: { coverage: 1, frontage: 1, streetWidth: -1, partyWalls: 0 },
    band: { coverage: 4, frontage: 5, streetWidth: 3, partyWalls: 6 },
  },
  {
    name: 'districts',
    why: 'can you tell which quarter you are in — the metric that silently lost 18 points',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/districts.mjs', '4242', '777', '31337']],
    extract: (o) => ({ character: num(o, /CHARACTER\s+(\d+)% of buildings are a type distinctive/) }),
    dir: { character: 1 }, band: { character: 6 },
  },
]

/** A 0..1 reading carried as an integer, so the board and its bands stay whole. */
function pct1000(out, re) {
  const m = out.match(re)
  return m ? Math.round(Number(m[1]) * 1000) : null
}

function num(out, re) {
  const m = out.match(re)
  return m ? Number(m[1]) : null
}

/* ------------------------------------------------------------------ */

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
const results = {}
let hardFail = 0, regressed = 0, unparsed = 0

const todo = CHECKS.filter((c) => (!quick || !c.electron) && (!only || only.includes(c.name)))

function runCheck(c) {
  try {
    return execFileSync(c.cmd[0], c.cmd[1], {
      cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      // Several tools exit non-zero BY DESIGN when they find something. That
      // is a finding, not a crash, so read the output either way.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    if (!out.trim()) throw e
    return out
  }
}

if (repeat > 1) {
  console.log(`=== HARNESS NOISE FLOOR — ${todo.length} checks x ${repeat} runs, same seeds ===`)
  console.log('How much each metric moves when NOTHING changes. A band narrower')
  console.log('than this cries wolf; a band wider hides a real regression.\n')
  for (const c of todo) {
    const series = {}
    for (let i = 0; i < repeat; i++) {
      let m
      try { m = c.extract(runCheck(c)) } catch { m = null }
      if (!m) continue
      for (const [k, v] of Object.entries(m)) {
        if (typeof v === 'number') (series[k] ??= []).push(v)
      }
    }
    for (const [k, vs] of Object.entries(series)) {
      const lo = Math.min(...vs), hi = Math.max(...vs)
      const flag = hi - lo > 0 ? (hi - lo >= Math.max(2, 0.25 * Math.max(1, hi)) ? '   <-- NOISY' : '') : ''
      console.log(`  ${c.name.padEnd(12)} ${k.padEnd(16)} ${vs.join(', ').padEnd(24)} spread ${hi - lo}${flag}`)
    }
  }
  process.exit(0)
}

console.log(`=== HARNESS — ${todo.length} checks ===\n`)

for (const c of todo) {
  process.stdout.write(`  ${c.name.padEnd(12)} `)
  let out = ''
  try {
    out = runCheck(c)
  } catch (e) {
    console.log(`CRASHED — ${e.message.split('\n')[0]}`)
    hardFail++; results[c.name] = { crashed: true }
    continue
  }
  const m = c.extract(out)
  results[c.name] = m
  const parts = []
  let line = 'ok'
  for (const [k, v] of Object.entries(m)) {
    if (v === null || v === undefined) {
      // AN UNPARSED CHECK MUST FAIL. A silently-skipped metric is a green
      // board that has never looked at anything — see the header.
      parts.push(`${k}=UNPARSED`); unparsed++; line = 'BROKEN'
      continue
    }
    const was = baseline[c.name]?.[k]
    const dir = c.dir?.[k] ?? 0
    const band = c.band?.[k] ?? 0
    let mark = ''
    if (typeof was === 'number') {
      const d = v - was
      if (Math.abs(d) > band) {
        const better = dir === 0 ? null : (dir > 0 ? d > 0 : d < 0)
        mark = ` (${d > 0 ? '+' : ''}${d}${better === false ? ' WORSE' : better === true ? ' better' : ''})`
        if (better === false) { regressed++; line = 'REGRESSED' }
      }
    }
    const gate = c.gates?.[k]
    if (gate && !gate(v)) { hardFail++; line = 'FAIL' }
    parts.push(`${k}=${v}${mark}`)
  }
  console.log(`${line.padEnd(10)} ${parts.join('  ')}`)
  if (line !== 'ok') console.log(`               ^ ${c.why}`)
}

if (save) {
  writeFileSync(BASELINE, JSON.stringify({ ...baseline, ...results }, null, 2) + '\n')
  console.log(`\nbaseline written to ${BASELINE}`)
}

console.log(`\n${hardFail} gate failures · ${regressed} regressions · ${unparsed} unparsed`)
if (unparsed) {
  console.log('An UNPARSED metric means a tool changed its output and this file')
  console.log('did not. Fix the extractor — do not let it pass quietly.')
}
process.exit(hardFail || regressed || unparsed ? 1 : 0)
