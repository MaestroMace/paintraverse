/**
 * HARNESS — run the battery, compare against the last recorded reading, and
 * fail on a regression.
 *
 * WHY THIS EXISTS.
 *
 * There were twenty-eight tools in here and no way to run them. That is not a
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
    extract: (o) => ({ problems: num(o, /(\d+) of \d+ definitions have a registration problem/) }),
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
    // GRADED AT DUSK, because that is the view the design is written against.
    // DESIGN.md's north star is "can the player stand in this town at dusk and
    // feel like they're somewhere", the app's own default timeOfDay is 18.5,
    // and this check ran at NOON for the whole tone arc. The two hours are not
    // close: walls read 0.210 with 4% of their pixels black at noon and 0.068
    // with 47% black at dusk — which is exactly the figure the tone work
    // started from and thought it had fixed. Props are 16% black at noon and
    // 92% at dusk. Grading at an hour nobody plays at is how a whole arc of
    // measurements came out flattering. Noon is still one flag away.
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/eyeball.mjs', '31337', '--views=6', '--time=18.5']],
    extract: (o) => ({
      // ANCHORED ON THE LABEL, because eyeball prints TWO `p10 .. med ..`
      // lines and an unanchored regex takes the first.
      //
      // This row was called `roofToWallMed` and was reading the SILHOUETTE
      // block — everything above the main body, its roof PLUS any tower or
      // spire promoted onto it. eyeball's own comment three lines from that
      // print says exactly that ("it is not the roof, and capping roof rise
      // moved it by one point while I was expecting it to move by fifty"),
      // and the board carried the wrong quantity under the roof's name
      // anyway. It cost an attribution: a roof-pitch fix that halved the rise
      // on five new templates moved this row by ZERO, which read as "the fix
      // did nothing" rather than "the board is looking somewhere else".
      //
      // A metric named after one quantity and extracting another is the
      // numerator/denominator lesson wearing a label. Both are tracked now.
      roofToWallMed: num(o, /OWN ROOF[\s\S]*?med (\d+)%/),
      stackedMed: num(o, /EVERYTHING ABOVE[\s\S]*?med (\d+)%/),
      roofOver80: num(o, /over 80% \(roof nearly as tall as the house\): \d+ \((\d+)%\)/),
      dwellingsOver4: num(o, /over 4 storeys \(11\.6m\): \d+ \((\d+)%\)/),
      // ABSOLUTE tone, x1000 so the board stays integer. The one measure here
      // with an opinion about what a rendered scene should look like — every
      // other pixel number is relative to a control and so is blind to the
      // whole town being too dark.
      wallLuma: pct1000(o, /^\s+wall\s+\d+\s+[\d.]+\s+([\d.]+)/m),
      roofBlackPct: num(o, /^\s+roof\s+\d+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+(\d+)%/m),
    }),
    // stackedMed is `dir: 0` — tracked, never failed on. A tower promoted
    // onto a dwelling is a DESIGN decision (28% of generic buildings get a
    // dramatic template) and whether more of them is better is an argument,
    // not a fact. roofBlackPct is 0 for the reason CLAUDE.md records: pillar
    // 1 asks for dark silhouettes, so it is a composition descriptor.
    dir: { roofToWallMed: -1, stackedMed: 0, roofOver80: -1, dwellingsOver4: -1, wallLuma: 1, roofBlackPct: -1 },
    // VERIFIED. Two runs on the current build are byte-identical — same sample
    // counts (491 sky / 710 roof / 6631 wall / 3424 ground) and same
    // percentiles — so the 157/187/222/229 wallLuma swing was the UUID bug
    // across builds, not pixel noise, and this band comes down with the rest.
    // A couple of points of slack is kept because these come off a rasteriser
    // and a driver change could move a boundary pixel; the metric itself has
    // no randomness left in it.
    band: { roofToWallMed: 2, stackedMed: 4, roofOver80: 2, dwellingsOver4: 2, wallLuma: 4, roofBlackPct: 2 },
  },
  {
    name: 'hours',
    why: 'ALL FOUR arms of updateLighting, so none of them can rot unwatched',
    electron: true,
    // THE CHECK ABOVE IS WHY THIS ONE EXISTS. eyeball grades ONE hour — the
    // right call, because 18.5 is the view the design is written against —
    // and that is precisely how the other three arms went unmeasured for the
    // whole life of the project. The tone arc edited the NOON arm because
    // every measurement it took was at noon; dusk kept the pre-arc numbers
    // and CLAUDE.md filed the resulting 0.058 wall as a regression it could
    // not attribute. Graded for the first time afterwards, NIGHT read sky
    // 0.005 / wall 0.000 with 90% of wall black — a black screen with windows
    // floating in it — and GOLDEN carried barely half the skylight of the
    // dimmer hour beside it.
    //
    // A single-hour tone table cannot show any of that, and neither can four
    // of them read on four different days. The four rows have to sit
    // together.
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/hours.mjs', '31337']],
    extract: (o) => {
      // Fields taken POSITIONALLY off the row rather than by a regex that
      // spells out every column, because adding a column is a normal thing to
      // do to this table — a prop mask went in the day after it was written —
      // and a positional regex breaks on the addition rather than on the
      // metric moving. Indices are 1-based past the hour: 1 sky, 2 wall,
      // 3 roof, 4 ground, 5 prop. Too few fields still returns null and the
      // board still reports UNPARSED, which is the behaviour that matters.
      const cell = (name, i) => {
        const m = o.match(new RegExp(`^\\s+${name}\\s+\\d.*$`, 'm'))
        const nums = m ? m[0].match(/[\d.]+/g) : null
        return nums && nums.length > i ? Math.round(Number(nums[i]) * 1000) : null
      }
      return {
        // The WALL at each hour, x1000. This is the quantity that rotted:
        // every arm's failure showed up here first.
        nightWall: cell('night', 2),
        duskWall: cell('dusk', 2),
        goldenWall: cell('golden', 2),
        dayWall: cell('day', 2),
        // THE ROOF AT DUSK, BESIDE THE WALL AT DUSK, because the roof tone
        // floor was chosen by a principle — parity with the wall beneath it,
        // since a roof darker than its own wall reads as a hole rather than a
        // surface — and the comment that records it also records the wall
        // figure it was matched against: 0.046. Raising the dusk arm took the
        // wall to 0.105 and left the floor where it was. A CONSTANT CHOSEN
        // FOR PARITY WITH A MEASURED QUANTITY IS AT PARITY ONLY ON THE DAY
        // YOU SET IT, and the durable answer is not a better constant, it is
        // having both numbers on the same line.
        duskRoof: cell('dusk', 3),
        // The SKY at night, because "unlit" and "dark" are indistinguishable
        // in a wall reading alone and this is the number that separates them.
        nightSky: cell('night', 1),
        inverted: num(o, /VERDICT: (\d+) inverted/),
        blackedOut: num(o, /VERDICT: \d+ inverted, (\d+) blacked out/),
        unmeasured: num(o, /VERDICT: \d+ inverted, \d+ blacked out, (\d+) unmeasured/),
      }
    },
    // A SILHOUETTE IS THE GATE, not any luma. DESIGN.md pillar 1 is warm
    // windows against dark silhouettes, and a silhouette needs the sky to be
    // brighter than what stands in front of it. `unmeasured` is a gate for
    // the reason this tool's first run demonstrated: pointed level it got six
    // sky samples out of four hundred, printed "no sky" on all four rows and
    // counted zero failures. A missing measurement must not read as a pass.
    gates: {
      inverted: (v) => v === 0,
      unmeasured: (v) => v === 0,
      blackedOut: (v) => v === 0,
    },
    // The lumas are tracked, not gated. Night SHOULD be dark, so "higher is
    // better" is wrong for that row and an argument for the others; what
    // matters is that a drop shows up on the board instead of in a phone
    // screenshot six weeks later.
    dir: { nightWall: 0, duskWall: 0, goldenWall: 0, dayWall: 0, nightSky: 0, duskRoof: 0 },
    // VERIFIED with --repeat=3: spread 0 on all eight metrics. The camera
    // spots, the ray grid and the build are all deterministic and there is no
    // randomness left in the path, so the band is three thousandths of a
    // luma — enough slack for a rasteriser boundary pixel and nothing more.
    band: { nightWall: 3, duskWall: 3, goldenWall: 3, dayWall: 3, nightSky: 3, duskRoof: 3 },
  },
  {
    name: 'allsides',
    why: 'is a building worth looking at from any side a player can reach',
    electron: true,
    // n=30 IS NOT A PREFERENCE, IT IS THE TOOL'S STATED FLOOR. The same build
    // read back/front 0.28 at n=14 and 0.79 at n=30, and its own note says it
    // cannot grade a feature rarer than its sample resolves. A cheaper run
    // would be a number that moves on nothing.
    //
    // Watch FLANK, not back. The first version of this tool shot only
    // front-vs-back — the one pair that was never broken, since both carry a
    // painted facade — and read a comfortable 0.79 while both flanks were flat
    // untextured colour. On the board because it grades the axis DESIGN.md
    // calls the 30ft read, and because nothing else here can see a wall that
    // is textured and still looks flat.
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/allsides.mjs', '4242', '--n=30']],
    extract: (o) => ({
      flankFront: pct100(o, /FLANK \/ FRONT\s+median ([\d.]+)/),
      backFront: pct100(o, /BACK \/ FRONT\s+median ([\d.]+)/),
      // THE SAMPLES, and there are two of them, which is the whole reason
      // backFront is not graded below. `usable` is every building the camera
      // could reach; the BACK ratio is a median over only those with a
      // reachable back, which on this seed is THIRTEEN. The tool's own note
      // says it read back/front 0.28 at n=14 and 0.79 at n=30 on the same
      // build — so a 13-sample median is a hypothesis, and tracking it as a
      // gated metric would cry wolf on every change that touches a handful of
      // small types. Both counts are on the board so the reading can be
      // interpreted instead of believed.
      graded: num(o, /usable buildings: (\d+) of/),
      backN: num(o, /with a reachable back: (\d+)/),
    }),
    // FLANK IS THE GRADED ONE, which is also what CLAUDE.md has said since the
    // first version of this tool shot front-vs-back — the one pair that was
    // never broken, because both walls carry a painted facade — and read a
    // comfortable 0.79 while both flanks were flat untextured colour.
    dir: { flankFront: 1, backFront: 0, graded: 0, backN: 0 },
    // VERIFIED with --repeat=2: 64/64, 71/71, 22/22 — spread 0. The camera
    // ring, the sampled buildings and the build are all deterministic, so the
    // band is two points of edge-density slack and nothing more. The tool's
    // sensitivity caveat is about SAMPLE SIZE, which is pinned at 30 here, not
    // about run-to-run noise, and conflating the two would have bought a band
    // wide enough to sleep through a regression.
    band: { flankFront: 2, backFront: 12, graded: 1, backN: 2 },
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
    name: 'holes',
    why: 'dark rectangles a person reads as a HOLE in a wall',
    electron: true,
    // GRADED AT NOON, which is the opposite of eyeball and deliberate. At
    // dusk the lit windows glow, so a dark opening has something to be dark
    // AGAINST and the count is naturally low; in DAYLIGHT nothing glows and a
    // collapsed surface has nowhere to hide. Measured on the same three
    // seeds, the pre-fix build read 7/26/5 at dusk and 53/75/32 at noon — the
    // hour that shows the defect is the hour to gate on, and it is a
    // different hour from the one the tone board uses.
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/holes.mjs', '4242', '--views=4', '--time=12']],
    extract: (o) => ({
      holes: num(o, /opening-shaped, and BLACK:\s*(\d+)/),
      // THE TOOL MEASURES TWO THINGS AND THE BOARD WATCHED ONE. A HOLE is a
      // dark patch where a wall should be; a BLANK is a patch with nothing ON
      // it, and the annotated frames say the blanks are the bigger defect at
      // street level — DESIGN.md's 30ft read is exactly a wall with something
      // on it. Tracking half a tool's output is how a class goes unwatched.
      blanks: num(o, /filling 4%\+ of the view:\s*(\d+)/),
      blankFrac: num(o, /^\s+([\d.]+)% of an average street view is a single flat/m),
      // The CONTROL, tracked so a "clean" board cannot mean the detector
      // stopped finding anything. A run with no lit openings has no control
      // and its hole figure is a hypothesis — `odd.mjs --feature=` silently
      // killed its own control once and every verdict fell back to a string.
      litOpenings: num(o, /^\s+(\d+) found · median/m),
    }),
    dir: { holes: -1, litOpenings: 0, blanks: -1, blankFrac: 0 },
    // Deterministic within a build — same seed, same views, same framebuffer
    // — so the band is tight. A wide band on a deterministic metric is a
    // regression detector switched off.
    band: { holes: 2, litOpenings: 3, blanks: 2, blankFrac: 2 },
  },
  // ==== THE INSTRUMENTS NOBODY WAS RUNNING ==============================
  //
  // Nineteen tools were on this board and TWENTY-NINE were not. Most of the
  // twenty-nine are photographers — asset, bisect, walkshots, rivershot — and
  // belong off it. These eight are MEASUREMENTS with numbers that can move,
  // and this repo's most expensive single lesson is "a metric you stop
  // running can regress in silence": district character lost eighteen points
  // that way and it took bisecting HEAD's tool against every commit to find.
  //
  // river earned its place immediately. Unwatched, it reported 1.7 bridges a
  // town "stopping in open water" — and it was the TOOL, twice over (see its
  // header). A false alarm nobody runs is a session someone will spend
  // chasing a defect that does not exist.
  {
    name: 'river',
    why: 'is the river a river, and do its crossings reach the far bank',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/river.mjs']],
    extract: (o) => ({
      bankRelief: num(o, /BANK RELIEF\s+median ([\d.]+)m/),
      dangling: num(o, /actually reach the far bank, ([\d.]+) stop in open water/),
      descent: num(o, /DESCENT\s+(\d+)% of downstream steps/),
    }),
    // A deck that stops in the middle of a river is unambiguous, so it gates.
    gates: { dangling: (v) => v === 0 },
    // bankRelief is a DESIGN value, not a defect: too little and the water is
    // paint on the floor, too much and it is the grand canyon a phone
    // photographed. Tracked, never failed on.
    dir: { bankRelief: 0, dangling: -1, descent: 1 },
    band: { bankRelief: 0.2, dangling: 0, descent: 6 },
  },
  {
    name: 'site',
    why: 'does the town acknowledge its own water, and is the wall an edge',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/site.mjs']],
    extract: (o) => ({
      quay: num(o, /QUAY\s+(\d+)%/),
      wallSealed: num(o, /(\d+)% of the town's boundary ring is sealed/),
    }),
    dir: { quay: 0, wallSealed: 1 },
    band: { quay: 6, wallSealed: 6 },
  },
  {
    name: 'vistas',
    why: 'what you SEE down a street — the Imagineering weenie, made countable',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/vistas.mjs']],
    extract: (o) => ({ landmarkEnds: num(o, /terminate on a LANDMARK\s+\(the weenie\)\s+(\d+)%/) }),
    dir: { landmarkEnds: 1 }, band: { landmarkEnds: 4 },
  },
  {
    name: 'features',
    why: 'is the dressing vocabulary reaching the town — ghosts and wallpaper',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/features.mjs']],
    extract: (o) => {
      const g = o.match(/GHOSTS[^\n]*\n(?:[^\n]*\n)*?\s{2}([a-zA-Z, ]+)\n/)
      const w = o.match(/WALLPAPER[^\n]*\n\s{2}([^\n]+)/)
      return {
        // A GHOST IS NOT AUTOMATICALLY A BUG and the tool says so in its own
        // output: a feature correctly confined to a rare type looks identical
        // to one gated into nonexistence. Tracked at dir 0 for that reason —
        // what matters is the number CHANGING, which means a gate moved.
        ghosts: g ? g[1].split(',').filter((x) => x.trim()).length : null,
        wallpaper: w ? (/^none\./.test(w[1]) ? 0 : w[1].split(',').filter((x) => x.trim()).length) : null,
      }
    },
    dir: { ghosts: 0, wallpaper: -1 },
    band: { ghosts: 1, wallpaper: 1 },
  },
  {
    name: 'tenancy',
    why: 'does anything in this town belong to anything else',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/tenancy.mjs']],
    extract: (o) => ({
      // THE GRADED ROW IS THE ONE OVER THE OWNABLE POPULATION. `explained`
      // divides by ALL props, so it is partly a measure of how many
      // UNOWNABLE props the town has: switching on forty yard fences moved it
      // seven points without a single prop changing owner, because a barrier
      // lands in the civic bucket AND stays in the denominator. On the honest
      // denominator the same change reads 58% -> 56%. Both are tracked, and
      // the all-props one is `dir: 0` so it can never fail on its own
      // arithmetic again.
      explainable: num(o, /OF THE PROPS THAT COULD BE:\s+(\d+)%/),
      explained: num(o, /^EXPLAINED\s+(\d+)%/m),
      orphaned: num(o, /^ORPHANED\s+(\d+)%/m),
    }),
    dir: { explainable: 1, explained: 0, orphaned: -1 },
    band: { explainable: 3, explained: 8, orphaned: 2 },
  },
  {
    name: 'streets',
    why: 'the road network on its own terms — corridor width, the merged lake',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/streets.mjs']],
    extract: (o) => ({ overWide: num(o, /OVER-WIDE: (\d+)% of all road tiles/) }),
    dir: { overWide: -1 }, band: { overWide: 3 },
  },
  {
    name: 'budget',
    why: 'what this build COSTS on the machine that cares — a phone',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/budget.mjs']],
    // WATCH THE MB, NOT THE COUNT. `info.memory.textures` counts texture
    // OBJECTS, so authoring a face coarser changes bytes and not one object —
    // the tool's own header records finishing all four walls taking facade
    // surface 78.9MB -> 150MB with no change in draw calls at all.
    extract: (o) => ({ textureMB: num(o, /([\d.]+) MB of surface/) }),
    dir: { textureMB: -1 }, band: { textureMB: 6 },
  },
  {
    name: 'propscale',
    why: 'how big is each prop in metres against what that thing really is',
    electron: true,
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/propscale.mjs']],
    // Read its caveat about its own targets before acting on a rise: three of
    // them were wrong on the first run, every one written from the ID rather
    // than from the object, and the geometry was right each time.
    extract: (o) => ({ outOfRange: num(o, /(\d+) of \d+ graded prop types are out of range/) }),
    dir: { outOfRange: -1 }, band: { outOfRange: 2 },
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
  {
    name: 'growth',
    why: 'dense core, sparse edges — the DESIGN.md principle nothing else can see',
    electron: true,
    // Tracked even though it currently PASSES. urbanform reports coverage as
    // one town-wide figure, so a gradient collapsing into a uniform slab
    // would move nothing anywhere else on this board — which is precisely why
    // it is worth a row. Three seeds keeps the run short; the shape is stable
    // across six.
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/growth.mjs', '4242', '777', '31337']],
    extract: (o) => ({
      coreEdge100: (() => {
        const m = o.match(/median\s+(?:\s*\d+%)+\s+([\d.]+)x/)
        return m ? Math.round(Number(m[1]) * 100) : null
      })(),
      corePct: num(o, /coverage falls -?\d+ points from core to edge \((\d+)%/),
    }),
    // `dir: 1` on the ratio: a town that thins is the goal, so a FALLING
    // core/edge ratio is the regression. Banded wide because it is a ratio of
    // two medians over three seeds and the outer ring carries the smallest
    // sample of the five.
    dir: { coreEdge100: 1, corePct: 0 }, band: { coreEdge100: 60, corePct: 6 },
  },
  {
    name: 'particles',
    why: 'is the MOVING content where the town is — nothing else looks at a particle',
    electron: true,
    // Added because sixteen checks graded the static world and none looked at
    // a particle, so chimney smoke spent the whole tile rescale venting over
    // the first third of the map: tile coordinates used as world coordinates,
    // hidden by a correct world-space HEIGHT in the same Vector3.
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/particles.mjs', '8080']],
    extract: (o) => ({
      offTown: num(o, /VERDICT: (\d+) particles outside the town box/),
      smokeLow: num(o, /smoke starts within 3m of the ground on (\d+)/),
      // Smoke's x-extent as a fraction of the town's. This is the row that
      // would have caught the scale bug: it read ~0.33 and reads 0.68 now.
      smokeSpread100: (() => {
        const m = o.match(/smoke\s+\d+\s+\S+ - \S+\s+\S+ - \S+\s+\S+ - \S+\s+([\d.]+)/)
        return m ? Math.round(Number(m[1]) * 100) : null
      })(),
      // PARTICLE TENANCY, and the only system with a claim about the ground
      // under it. Fireflies were placed by Math.random() over the whole map
      // and read a perfect 0.99 SPREAD while 44% of them hung over cobbles
      // and rooftops — a metric a uniform scatter can max out, maxed out by
      // one. Spread says they cover the town; this says the town under them
      // explains them.
      ffNature: num(o, /fireflies over soft ground or water (\d+)%/),
    }),
    gates: {
      offTown: (v) => v === 0, smokeLow: (v) => v === 0,
      // Gated rather than tracked: this is placement, not taste, and the
      // placer draws only from soft and water tiles, so anything under 90
      // means the tile set or the lookup has broken rather than that the
      // town drifted.
      ffNature: (v) => v >= 90,
    },
    dir: { smokeSpread100: 1 }, band: { smokeSpread100: 25 },
  },
  {
    name: 'celestial',
    why: 'does every Environment control still reach the frame — a dead one is silent',
    electron: true,
    // On the board because a control that lies is worse than absent content:
    // nobody notices what is missing, and everybody believes a labelled
    // slider. Six of the seven here were read by NOTHING for the life of the
    // app — the moon phase, the star density and the whole weather set —
    // and no static check could see it, because a control is not a definition
    // and not a gate. This is also the only check that can catch the reverse:
    // a control that WAS wired quietly losing its consumer.
    cmd: ['xvfb-run', ['-a', '-s', '-screen 0 1400x900x24', 'node', 'tools/celestial.mjs', '4242']],
    extract: (o) => ({
      dead: num(o, /VERDICT: (\d+) of \d+ environment controls/),
      graded: num(o, /VERDICT: \d+ of (\d+) environment controls/),
    }),
    // ONE is the pass, not zero: `sunAngle` is genuinely dead in the 3D path
    // — the pixel-art export reads it and the walkaround derives its sun from
    // the hour — and it stays in the table as the NEGATIVE CASE, because the
    // first version of that tool reported it live and a test with no negative
    // case has never been tested. Two would mean something regressed; zero
    // would mean somebody wired the sun angle, which is a real change wanting
    // its own A/B and should not slip past as a green board.
    gates: { dead: (v) => v === 1, graded: (v) => v === 7 },
  },
]

/** A 0..1 ratio as a percentage, so the board and its bands stay whole. */
function pct100(out, re) {
  const m = out.match(re)
  return m ? Math.round(Number(m[1]) * 100) : null
}

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
