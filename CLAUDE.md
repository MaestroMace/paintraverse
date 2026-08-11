# CLAUDE.md — Session Handoff

Read this FIRST when picking up a PainTraverse session. For the aesthetic
north star, read `DESIGN.md` next.

## Project at a glance

- **PainTraverse** — Electron + React + TypeScript + Three.js + Pixi.js
  procedural town generator. Main target: a real-time 3D walkaround that
  reads as a Traverse Town-like dusk scene at 30+ FPS.
- **Primary entry**: `src/renderer/renderer3d/ThreeRenderer.ts` — the
  3D scene, camera, shadows, composer, particle systems, render loop.
- **Build/run commands**:
  - `npm run typecheck` — tsc --noEmit (must be green before commit)
  - `npm run build` — production build (must be green before commit)
  - `npm run dev` — electron dev (user runs themselves; don't start it)

## Working tone

- Saturday-morning-fun energy. Ambitious, a bit playful, not precious.
- User is authorized for big blind sprints with multiple commits per session.
- Don't ask permission for each small change; push and show.
- When user drops a debug dump, read it, diagnose, fix, ship.

## Git workflow

- **Work directly on `main`.** The user wants changes shipped to main every
  commit — this is their durable preference, overriding the default
  safety of "never push to main". Do NOT create side branches or open
  PRs unless explicitly asked.
- **Commits**: Frequent, small-to-medium. Clear messages focused on WHY.
  End commit body with the full context of what changed.
- **Push**: Always `git push origin main`. Retry on network error with
  exponential backoff (2s, 4s, 8s, 16s).
- **Never force-push.** Never use `--no-verify`. If hooks fail, fix the
  underlying issue and create a new commit.

## Debug-dump workflow

The user creates debug dumps from the running app and uploads them via
GitHub commits. To process:

```bash
git pull origin claude/explore-repo-w4X5k
ls -lat debug-dumps/*.html | head -3
```

Then extract the latest dump's image and diagnostic JSON:

```bash
python3 -c "
import re, base64, os, json
p = 'debug-dumps/<LATEST>.html'
html = open(p).read()
os.makedirs('/tmp/debug-out', exist_ok=True)
for i, m in enumerate(re.finditer(r'class=\"label\">([^<]+)</div><img src=\"data:image/png;base64,([A-Za-z0-9+/=]+)\"', html)):
    with open(f'/tmp/debug-out/{i:02d}.png', 'wb') as f: f.write(base64.b64decode(m.group(2)))
m = re.search(r'<pre[^>]*>(.*?)</pre>', html, re.DOTALL)
body = m.group(1).replace('&quot;','\"').replace('&lt;','<').replace('&gt;','>').replace('&amp;','&')
data = json.loads(body)
print(json.dumps(data.get('threeRenderer'), indent=2))
"
```

Then `Read` the extracted PNG to see the scene. The diagnostic JSON shows:
- `fps` (real wall-clock now, not lied-about)
- `camera` — position, yaw/pitch, flyMode, fov
- `render.drawCalls` — honest per-frame count (autoReset=false)
- `render.triangles` / `geometries` / `textures`
- `frameMs` — { total, update, render } split
- `renderSettings` — shadowMapSize, type, bloom state, composer state
- `particles` — { smoke, firefly, bird } counts
- `scene` — { buildingCount, propCount, terrainCount }

**Only use the latest dump.** Older dumps don't reflect current code.

## THE METHOD — how this project actually makes progress

This is the most transferable thing in the repo. Every large win below came
from the same loop, and every expensive failure came from skipping a step in
it. Read this before you read the findings; the findings are just what the
loop produced.

**Build the instrument before the fix.** Nearly every defect here was
invisible to the tools that existed when it was reported. "Broken overlapping
textures" was not a texture bug, it was six paving ids interleaved. "Scattered
buildings" was a road network merged into a lake. In both cases the fix was
easy and finding it was not, and what found it was a new measurement. If a
code path produces output, build a way to look at it.

**Decompose a number before you attribute it.** Facade-to-facade street width
is carriageway plus two setbacks — different owners. It was measured as one
figure, a 6m road was ASSUMED, and the remaining 18m was written into this
file as setback and treated as the project's top priority. The real split was
12m of carriageway and 0m of setback. Four attempts at a plot system aimed at
a term that was already zero. Never subtract an assumed term from a measured
total.

**Prefer the metric that only the real structure can move.** `emptiness.mjs`
reads a comfortable median because it seeds its search from PROPS, so it can
be satisfied by scattering harder — and it did read comfortable while the town
was still a lake. Distance to the nearest BUILDING cannot be faked, because
only a building makes a wall. When choosing what to measure, ask what a lazy
fix would do to the number.

**A comparison can only find defects in the things it compares.** `allsides.mjs`
photographed a building's road side against the side OPPOSITE it and read a
comfortable 0.79 — a true number about the one pair that was fine. Both those
walls carry the painted facade; the two FLANKS were a single flat colour with
no openings, and the metric never pointed a camera at them. Ask what the
sampled population EXCLUDES, not just what it includes. This is the sample-count
lesson rotated ninety degrees: there a filter shrank the sample, here the sample
was always aimed at the wrong members.

**A parameter that is only ever passed one literal is dead code the compiler
will not flag.** `createFacadeTexture(config, face)` took `'front' | 'side'`,
had a whole `if (face === 'front')` branch, and exactly one call site — passing
`'front'`. The side-wall vocabulary had a type signature, a code path and no
existence, which is the GHOST failure wearing a disguise good enough to survive
several censuses. When auditing for ghosts, grep the ARGUMENTS at call sites,
not just the gates inside functions.

**Prefer an exact test to a heuristic proxy.** Proxies agree with their target
right up until you change the target. The road painter inferred hierarchy from
a neighbour COUNT, which tracked the tiers only while streets were fat and
painted the whole town as alley the moment corridors were capped. A ±2
clearance box stood in for a gate footprint and let a wall overlap a 3-wide
gate. A colour-tolerance flood fill stood in for "which pixels are sky" and
walked down a dusk facade, reporting forty floating timbers that were all
windows. In each case the exact test was available and cheaper to trust.

**Verify the edit landed.** Byte-identical output is a red flag, not a null
result. A failing build leaves the previous bundle in `dist/`, so check with a
success marker: `npm run build 2>&1 | grep -E "^✓ built in [0-9.]+s|error"`.

**A/B the tool separately from the code.** If you improved the metric in the
same session, run the NEW tool against the OLD build before claiming a delta.
Tenancy read 29% -> 46%; only 35 -> 46 was the change, the rest was the metric
being corrected. Pin the seed while you do it — an early prop A/B compared two
different towns because the probe never set one.

**Watch the sample count when you change a filter.** A metric that suddenly
agrees with you on a tenth of the data has not agreed with you. Recovering
road direction from "is there road beside me" narrowed a 3426-sample scan to
220 one-wide alleys and reported a comfortable 6m.

**Make the tool explain itself, not just count.** Two changes were spent
chasing "233 tiles where the wall placer simply did not build" before the tool
was asked to classify gaps by CAUSE — which revealed in one run that the ring
was drawn one tile outside the wall on two of its four sides. A counting
metric buys you guesses; an explaining metric buys you the answer. The same
move works on a GATE: tally the clause that rejected each candidate, not just
the ones that passed. A rear outshot read 6% and could have been the district
list, the height test, the dice or the geometry; one census with `~` reject
counters said noRoomBehind on 55% of eligible buildings and closed it. Cheap
enough to leave in — `tools/features.mjs` prints any tally containing `~` in
its own block and keeps it out of the ghost verdict.

**A gate derived from another gate inherits its constraints silently.** The
flank chimney breast was supposed to need less clearance than a buttress, and
it computed its candidate walls by FILTERING the buttress's list at the looser
threshold — which can only ever narrow a set, never widen it, so the looser
number could not take effect. Derive each gate from the underlying quantity.

**State the tool's noise floor.** `anomaly.mjs` re-reads every vantage and
prints how often it disagrees with itself, because the first three versions of
it were not repeatable and would happily have graded a change.

**A classifier's categories encode a causal claim — check it against the order
things actually happen in.** Splitting unbuilt street frontage by cause put
"a prop stands there" at 39%, the largest category by far, and it reads like a
perfectly good excuse. Counting it as one gave 93% against an 85-95% target
and would have declared the project's last open metric solved. It is a
symptom: `generate()` places buildings before every prop pass, the last of
them named `dressEmptyStreets`, so the prop did not take the plot — the plot
was empty and the prop was sent to cover it. Same reading, opposite verdict,
and only the pipeline order distinguishes them.

**Report the honest aggregate.** Vista termination went 3% -> 17% on seed
4242 and 6% -> 8% across three seeds. The three-seed number is the result.

**Revert what measures zero.** Plot orientation, a tile-based row streak, and
a pass that placed 40 buildings to close vistas were each written, measured at
about zero, and removed. Complexity for a measured zero is a cost, and a real
mechanism that is not the cause is the expensive kind of wrong.

**Test from the angle the bug appears at.** Inverted gable winding was tested
with DoubleSide, showed nothing, and was dismissed — because every shot in the
harness pointed level or down, and a roof with missing gable ends looks
perfect from above. A negative result is only as good as its vantage.

**Census the whole vocabulary, not the feature you are looking at.** A lesson
about one gated feature is almost always a lesson about twenty. `featureCounts`
existed in BuildingFactory with NO CONSUMER and only two of ~20 gated features
tallied into it, so nobody could know which of the rest fired at zero. Running
the census found five that essentially did not exist, including a `balcony`
that appeared ONCE in 525 buildings — for a feature with a building type named
after it. `tools/features.mjs` is the general form; run it after touching any
dressing.

**There are two silent failures, and the second one looks like success.** A
GHOST is content gated into nonexistence: no error, no warning, just a
vocabulary you believe you have. WALLPAPER is content that fires at the same
rate everywhere, which reads as a healthy number and differentiates nothing —
shop signs were 16% of buildings town-wide and 16% in the cemetery too. A
screenshot of one building looks fine in either case. Report rate AND spread.

**When you fix a gate, sweep its siblings.** The shop sign's `fp.w >= 2` was
fixed to `max(w, h) >= 2` because a row_house is 1x2 and the ordinary town is
mostly row houses. The identical bug sat unfixed in `stoopBench` (`fpT.w >= 3`)
in the same file, firing on 4 buildings in 525. A bug in a gate is a bug in a
PATTERN; grep for the pattern before moving on.

**A tool's numerator and denominator must count the same population.** The
feature census reported a doorstep rate of 182% of a district, which is the
tool saying its two halves disagree: BuildingFactory defaults a missing
district to 'residential' while the tool counted only buildings carrying the
property, so walls and gates landed in the numerator alone. Any rate above
100% is a free bug report about the measurement.

**A metric cannot grade a feature rarer than its sample resolves.** Moving ivy
to the back walls was measured with `allsides.mjs` at 14 buildings and the
aggregate went the WRONG way by a tenth — but ivy is 4% of buildings, so the
sample contained roughly none of it and the movement was pure noise. Before
believing a delta, ask how many of the sampled items could possibly carry the
thing you changed. This is the sample-count lesson from the street-width scan
in its other form: there, a filter shrank the sample; here, the feature was
always too rare for it.

**Test the first thing that happens, not just the interesting things.** No
audit here had ever exercised the player SPAWN — the placement audit grades
where buildings are, and every screenshot harness teleports to fixed vantages.
Five seeds in sixteen started the player inside a wall and one in the river,
for a year, because the code path that runs before anything else was the one
path nothing tested.

**A pass that reads a value for LABELLING while hardcoding the CONTENT will
undo whatever the value was supposed to decide.** Three fill passes each read
the district at their tile, used it to pick a floor count and to stamp
`district:` on the object, and then hardcoded `row_house` / `building_small` /
`corner_building` as the type. So every quarter got generic housing and then
signed it with its own name. `DISTRICT_BUILDINGS.noble` contains no row house
and noble's commonest building was 13 row houses; `cemetery` lists only chapel
and tower and had 7. District character was not failing to be generated — it
was being overwritten downstream. Grep for the variable being used twice in
one block and only once meaningfully.

**Content goes where there is an ANCHOR to attach it to.** Every front-attached
detail in BuildingFactory hangs off `frontWallZ` / `frontWallHalfW`. There was
no equivalent pair for the back or the flanks, and that absence — not any
decision about dressing — is why three walls of every building were bare. The
fix for "this face has no content" is usually an anchor, not more content, and
the same shape recurs: `PlacedObject.footprint` unblocked four failed plot
attempts, `BuildingTop` unblocked the particle systems. When a whole category
of work keeps not happening, look for the handle it would need.

**Name your suspects once.** A component blamed repeatedly without evidence is
noise. The windmill was accused four times for defects it had nothing to do
with; the lantern ropes were a good hypothesis for the floating-timber class
and were refuted in one A/B by hiding them and re-counting. Test the suspect,
then either convict it or stop mentioning it.

## Critical files map

### Shared vocabulary (import these, never re-declare)
- `src/renderer/core/terrain.ts` — tile ids, colours, names, `isCirculation()`.
  All three renderers read this one table.
- `src/renderer/renderer3d/scale.ts` — `TILE = 3.0`, the horizontal tile ->
  world factor for the 3D walkaround, and the rule for when to apply it.
  **Read this before touching any 3D coordinate.**

### Rendering (3D)
- `src/renderer/renderer3d/ThreeRenderer.ts` — main renderer, scene, loop
- `src/renderer/renderer3d/BuildingFactory.ts` — per-building mesh emission,
  chimneys, foundation stair-step plinth, `coalesceWalls()` post-merge
- `src/renderer/renderer3d/PropFactory.ts` — lampposts, trees, props, lamp pool
- `src/renderer/renderer3d/TerrainMesh.ts` — ground mesh (corner heights),
  retaining walls (threshold-gated), water, road surface (CobbleTexture)
- `src/renderer/renderer3d/CobbleTexture.ts` — procedural voronoi cobble
- `src/renderer/renderer3d/LanternStrings.ts` — overhead rope+lantern chains
  AND `buildWallLanterns()` — wall-mounted eye-level lanterns
- `src/renderer/renderer3d/FacadeTexture.ts` — procedural window/wall textures
- `src/renderer/renderer3d/architecture/VolumeRenderer.ts` — `emitVolume`,
  `_wallMatCache`, `tickWallEmissive` (flicker)
- `src/renderer/renderer3d/architecture/Massing.ts` — building massing templates
- `src/renderer/renderer3d/BatchedMeshBuilder.ts` — shared merge helper

### Generation
- `src/renderer/generation/TownGenerator.ts` — street network, district zoning,
  building placement (Phase B walks road edges + row-streak extension),
  vegetation, props
- `src/renderer/generation/noise.ts` — SimplexNoise + fbm

### Pixel-art export path (the Render / Export PNG buttons)
- `src/renderer/renderer3d/Canvas2DRenderer.ts` — the whole painterly
  renderer: `shadeFace` (ambient + sun + hemisphere skylight, tone-mapped),
  building blueprints, prop drawing, light-source collection
- `src/renderer/renderer3d/RenderPipeline.ts` — `renderLightMap` (float
  accumulation + tone map), post-process, bloom, palette quantization

### 2D editor plan view
- `src/renderer/editor/layers/planStyle.ts` — role tints, ground wash, prop
  glyph vocabulary, label fitting. Shared by both object layers.
- `src/renderer/editor/layers/{Structure,Prop,Terrain}Layer.ts` — each bakes
  its whole layer to ONE canvas texture (SwiftShader can't take hundreds of
  Pixi draw calls). Rendered at `map.tileSize`; zoom is a container scale, so
  a label that fits once always fits.

### UI
- `src/renderer/ui/panels/RenderPanel.tsx` — debug dump export (embeds
  screenshot + settings JSON + threeRenderer diagnostics)

## Key numbers / constants

Verified against the code; if you change one, change it here too.

- `TILE = 3.0` (scale.ts) — one map tile is 3 metres across, horizontally.
  World units ARE metres; the player's eye is at 1.6 of them.
- `FLOOR_HEIGHT = 1.8` (BuildingFactory) — 1.05 was the "kaiju" scale bug
- `TERRAIN_WORLD_SCALE = 1.8` (TerrainMesh) — raw height unit → world
- `EYE_HEIGHT = 1.6` (ThreeRenderer) — player camera height
- `RENDER_SCALE = 0.4` (ThreeRenderer) — renders at 40% then CSS-upscales.
  This is why thin geometry aliases: a feature spans one pixel at ~340× its
  own size, so anything under ~5cm is invisible past ~17m.
- `PLAYER_RADIUS = 0.35` (ThreeRenderer) — the player's collision disc. Before
  this existed the player was a point in tile space.
- `SHADOW_RADIUS = 30m` (ThreeRenderer) — follows the player, and also sizes
  `shadow.normalBias`. Ten tiles: the street you are in plus both sides of it.
  Every caster inside it is a shadow-pass draw call, so it is a frame-time
  lever and the phone is the machine that cares.
- Shadow map **512²** with PCF, manual updates (not per-frame)
- Tone mapping: **ACESFilmic, exposure 1.15**. Without it the light sum clips
  at 1.0 and midday paving fuses into a white sheet.
- Composer/bloom is **disabled** (`_useComposer = false`)
- `MAX_ROOF_SPAN_RATIO` (Roofs) / `MAX_TOWER_ASPECT = 4` (Massing) — roofs and
  tower bodies are capped against their own width. Without these, spires
  reached 74m needles. The aspect cap was 9 when width was a tile count; 4 is
  the faithful translation now that it is metres.
- `MAX_OVERHANG = 0.6` (Massing) — how far a volume may leave its footprint, in
  METRES. Pinned to a physical jetty, not translated proportionally: 0.9 tiles
  would now be 2.7m, which is the sail this cap exists to prevent.
- Lantern strings max 25 per map, 2.6–5.0 tiles apart, hung above the higher
  building's **eaves** (not a fixed height above ground)
- Birds: max 15, dusk-only. Smoke: 2 × 16 chimneys = 32. Fireflies: 36.
- Lampposts: ~28 per 48×48 town, spaced along every road; all their ground
  light pools are merged into ONE mesh sharing `_lampPoolMat`
- Terrain tile ids live in **`src/renderer/core/terrain.ts`** — one table for
  all three renderers, plus `isCirculation()`. 3 water · 8 street cobble ·
  9 alley · 14 plaza flagstone · 15/16 district cobble. **Only 8 and 9 are
  circulation** — 14/15/16 are paving, so a building standing on them is not
  blocking a street. Never re-declare this table; three copies had already
  drifted into disagreeing about what tiles *mean*.

## Hard-won lessons (don't repeat)

- **FPS counter was dishonest** — it used `dt` capped at 0.1s, so at 2 real
  FPS it reported 10. Fixed to `performance.now()`. If you need accurate
  timing, use `_frameStats.frameMs`.
- **renderer.info.render was unreliable** until we set `autoReset=false`
  and snapshot manually. The post-composer OutputPass overwrites counts.
- **Lamp pool as a vertical cone looked like a teepee.** As a vertical
  sprite looked like a floating disc. As a HORIZONTAL plane lying on the
  ground with radial-alpha, it reads as a real light pool. Don't revert.
- **Cobble pucks look alien** sitting on top of the cobble TEXTURE —
  they read as black disks, not stones. Texture alone sells cobbles.
- **Terrain stair-step cliffs** came from the ground mesh using ONE
  tileH for all 4 corners of each quad. Corner-shared heights (cornerH
  helper in buildGroundWithHeight) fixed it.
- **FLOOR_HEIGHT = 1.05 made buildings too short** relative to the
  1.6m player eye height — "kaiju scale." Bumped to 1.8.
- **Mood mix "bright" (255,255,160-210) clipped to white under bloom**
  at dusk, reading as a blown-out window. Clamped to warm amber.
- **Flicker at 2.2–4.4 Hz read as strobe.** Dropped to 0.25–0.7 Hz.
- **Shadow cam on town-radius was wasteful.** Now follows camera at 28m
  radius — sharper shadows AND fewer casters in frustum.

### Measurement lessons (this arc fixed ~350 placement errors)

- **Tile ids conflated material with function.** Tile 8 meant "street" AND
  "plaza paving" AND "market district ground", so an audit could not tell a
  building blocking a road from one fronting a square. Most "buildings in the
  street" were never real. Split into 8/9 (circulation) vs 14/15/16 (paving).
- **A clean metric is not a clean codebase.** The first "exposed flat roof"
  check asked *is this volume the building's apex?* and returned a confident
  0. A flat-topped tower on a building with a taller spire elsewhere is still
  an open box. Asking *is anything stacked on THIS volume?* found 14-16.
- **Verify the edit landed before trusting an A/B.** A patch silently failed
  to apply and the "before/after" was two identical builds, which
  "disproved" a correct hypothesis. Byte-identical output is a red flag.
- **Three seeds is not enough.** Eight previously-untested seeds found a
  staircase-on-bridge bug the regression seeds all missed.
- **Count gated features before tuning them.** Shop signs required a
  commercial district AND type AND `fp.w >= 2`; the result was 0-4 per town
  and the "row of shop signs" simply never existed. Nobody notices absent
  content — `featureCounts` in BuildingDiagnostics exists for this.
- **Duplicated math drifts silently.** ThreeRenderer re-derived building
  heights for smoke/birds; that copy kept a stale 1.05 FLOOR_HEIGHT long
  after the real one became 1.8. BuildingFactory now reports `BuildingTop`
  and there is one calculation.

### Scale-coupling lessons (the tile -> world arc)

- **A constant expressed against a quantity you change is a bug you just
  wrote.** Every one of `MAX_OVERHANG`, `MAX_TOWER_ASPECT`, the lantern pair
  filter, the cobble UV scale, `SHADOW_RADIUS` and the door-surround's 0.4
  tolerance was tuned against something that tripled. Some needed the factor
  applied (lantern distances, UVs), some needed pinning to a physical number
  instead (overhang, jetty), and one needed rewriting into a scale-free
  question entirely: "is the main body flush with the footprint edge, within
  0.4?" became "is anything sticking out in front of the main body?", which is
  what the comment above it always claimed it asked.
- **The footprint is not the building, and everything that forgot that broke
  in the same way.** The massing volume is inset inside its reserved footprint
  and then multiplied by wealthScale, so `fp.h / 2` is a per-building distance
  in front of the actual wall. Signs, awnings, stoops, benches, doorsteps,
  posts, colonnades, balconies, wall lanterns and chimneys were all anchored
  there. Every one was already wrong; the rescale only made the error metres
  wide instead of centimetres. **`BuildingTop` now reports the main body's
  centre, half-extents and yaw** for the same reason it already reported
  heights: so nothing has to re-derive where a wall is.
- **Order matters between two clamps on the same value.** `clampRoofHeight`
  ran before the overhang clip, so a volume clipped narrower kept the roof
  height computed for its original span; `buildRoof` re-clamped against the
  real width and drew a shorter cone while the finial stayed at the old apex.
  Ornaments hung in the air above every clipped spire. Moving the roof clamp
  after the clip fixed it — it is idempotent, so last is safe.
- **Two coincident faces is a bug even when the geometry is "correct".** The
  corner tower and the L-wing put a side face on exactly the main body's plane.
  Nothing is wrong with either volume; the pair is a depth-buffer tie that
  resolves per pixel per frame. This was the reported flickering.
- **Interpolating and then flooring throws the interpolation away.**
  `sampleGroundY` called `Math.floor` on the camera position before handing it
  to a function whose whole purpose is sub-tile interpolation — with a comment
  explaining that this made the contract "explicit". It made the player's eye
  step by the full tile rise.
- **Hiding scene groups one at a time beats staring at the picture.**
  `tools/bisect.mjs` attributed the floating ornaments in one run after two
  rounds of guessing had failed.
- **A batch hides its authors, so make it name them.** "Giant floating accent
  timbers" survived several rounds of guessing because a merged mesh cannot
  tell you which line drew a triangle. `tools/slivers.mjs` captures a stack in
  BatchedMeshBuilder and prints emitter -> length -> position; it found the
  real cause in one run. Note the frame filter has to match on FUNCTION NAME,
  not filename — in a bundle every module shares one `index-<hash>.js`, so a
  filename filter skips nothing and hands you back the audit's own line.
- **Two things were called "the timbers" and only one was a bug.** The frame's
  members were both floating (pushed out by the POST's 5.9cm shift while being
  4.5cm deep, leaving a slit of daylight behind a 12m beam) AND too long to be
  framing (a head plate spanning the whole volume, with nothing under it). The
  fix for the first is arithmetic; the fix for the second is more geometry, not
  less — studs at a 1.7m bay pitch and corner braces, so a wider building grows
  more frame instead of a longer stick.
- **Test the hypothesis from the angle the bug appears at, or you will rule
  out the right answer.** Inverted gable winding was tested with DoubleSide,
  showed no change, and was dismissed — but every shot in the harness pointed
  level or down, and a roof with missing gable ends looks perfect from above.
  The harness now has an up-looking shot. A negative result is only as good as
  the vantage it was taken from.
- **An open shell is invisible until something projects.** The roof prism never
  had an underside. That is free and correct right up until the eave overhangs
  the wall, at which point the player standing in the street looks up into an
  open box and sees sky — and the only geometry left is the trim, which reads
  as beams floating in mid-air. Two reported defects, one missing face.
- **A ratio to the wrong quantity flattens silently.** Roof rise came from
  wallH, which did not change, while the span it crosses tripled — so every
  pitch in the town dropped by about a third and a 40-degree gable became 23.
  A shallow slab on a wide building reads as a building someone stopped working
  on: this was "half built roofs". `ensureRoofPitch` now floors the rise
  against the SPAN (tan of the intended pitch), with `clampRoofHeight` still
  owning the ceiling — floor first, cap last.

### Measurement lessons (the street-network arc)

- **A number that is a SUM of terms with different owners will be assigned to
  the wrong owner.** Facade-to-facade street width is carriageway plus two
  setbacks. It was measured as one figure, the road was ASSUMED to be 6m, and
  the remaining 18m was recorded in this file as setback and treated as the
  project's top priority. The real split was 12m of carriageway and 0m of
  setback with 56% of walls already flush against the kerb. Four attempts at a
  plot system were aimed at a term that was already zero. Decompose before you
  attribute, and never subtract an assumed term from a measured total.
- **A scan has to know what it is scanning.** The width scan ran both axes at
  every road tile regardless of the road's direction, so half its samples
  measured street LENGTH, and out-of-bounds hits near the map edge made those
  look like legitimate 12-tile widths. The obvious fix — "is there road beside
  me?" — then called every tile of a 2-lane street a junction and silently
  narrowed the sample to 1-wide alleys, 220 across three seeds, reporting a
  comfortable 6m. **Watch the sample count when you change a filter**; a metric
  that suddenly agrees with you on a tenth of the data has not agreed with you.
- **The union of narrow things is not narrow.** Every road tier is 1-3 tiles.
  58% of road tiles were in a corridor wider than 3, one component covered a
  quarter of the map, and the widest run was 33 tiles. Nine main streets from
  one origin, a dozen random scribbles, and a disc at every district centre
  compose into a lake. This is why narrowing the carver moved 27m to 24m and
  stopped: **the thing being measured was never drawn by the thing being
  tuned.** When a fix at the source barely moves the number, ask whether the
  source is the author.
- **A proxy agrees with its target right up until you change the target.** The
  road painter called anything with fewer than 7 road neighbours an alley.
  That tracked the tier hierarchy only because ordinary streets were fat; the
  moment corridors were capped at 3, a 2-wide street had 6 neighbours and the
  entire town painted as dark alley in one step. Record the real quantity at
  the point that knows it — the carver knows its own tier.
- **Relabelling is not a change, and only a perceptual metric catches it.**
  Narrowing the streets turned the lake into 37% plaza; unpaving the yards cut
  hard paving 57% -> 43% and moved the way the ground READS by five points,
  because dirt, sand, gravel, stone, flagstone and street cobble are all warm
  tan. Both times the tile histogram looked like progress. Measuring the map
  by COLOUR FAMILY, off the app's own palette, is what said 65% of the ground
  was one surface however many ids it had.
- **An erosion needs a topology guard, not a heuristic.** Removing only simple
  points — where the road in the 8-neighbourhood forms exactly one connected
  run — provably cannot disconnect the network or open a hole, and it has to
  be re-tested against the LIVE map between removals: two tiles can each be
  individually removable and jointly cut the street.
- **A cap expressed against a quantity you just changed is the same bug as a
  constant expressed against one.** `maxBuildings` was ~155, tuned when a
  third of the map was road. Freeing a quarter of the town did not build a
  single extra house; coverage FELL from 49% to 43% as the land grew, because
  the cap pocketed the gain. It is derived from the free tile count now.
  (Compare the scale-coupling lessons: same mistake, different axis.)

### Drift and blind-spot lessons (the plan-view / pixel-art arc)

- **Hand-threaded argument lists are a bug generator.** Six prop placers each
  hand-listed "everything placed so far" by spreading up to nine arrays. Three
  sources were simply never threaded in, so road markers landed on lampposts.
  `generate()` now keeps `anchors` / `blockers` / `placedProps` accumulators
  and `allProps` IS the accumulator — there is no second list to forget.
- **Duplicated *presentation* drifts too, and worse: it drifts in MEANING.**
  Three copies of TERRAIN_COLORS disagreed about what tiles are — id 6 was
  "light grass" in 3D and "Road" in the editor's own name table; id 7 was
  gravel vs "Snow"; ids 14/15/16 didn't exist in the pixel-art path at all,
  so plazas exported as fallback grey.
- **An output nobody can see WILL be broken.** The Render / Export PNG path
  had no headless capture and was producing a white blob with black spires.
  Four real defects were hiding there. If a code path produces output, build
  a way to look at it — that is what found every one of them.
- **Clamping is not tone mapping.** Both the light map (`'lighter'` into 8-bit)
  and `shadeFace` (`Math.min(1, ...)`) clipped instead of rolling off. Each
  looked fine at low density and collapsed as the town got richer: the light
  map saturated to white once lamps went 9 → 28, and midday paving fused into
  a flat white sheet. Both now use `1 - exp(-x)`.
- **Compare two times of day to split a lighting bug from a draw bug.** The
  black spires looked like broken geometry. Rendering the same seed at noon
  showed them perfectly coloured, which localised it to dusk exposure in one
  step. `tools/pixelart.mjs --time=12`. The same trick then found the 3D
  path's missing hemisphere light: a wall that is still pure black at NOON
  under a blue sky cannot be explained by the hour.
- **AmbientLight is not skylight.** It adds the same value to a face whether
  it points at the sky or the ground, so anything the sun and shadow map miss
  gets one flat number and reads as a black slab. Both renderers now carry a
  hemisphere term keyed to the sky colour they are actually under. If a
  surface looks like a void, check orientation-dependent light before
  suspecting the geometry.
- **A footprint invariant is not a geometry invariant.** The audit was clean at
  0 errors while ~3 buildings per town threw wing volumes outside their own
  footprint and through the neighbours — reported from a phone as "crossed
  timbers jutting out of houses". `MAX_OVERHANG` in Massing caps it and
  tools/overhang.mjs counts it. The windmill was the worst case at three tiles
  of overhang per side, but ordinary row houses did it too.
- **Measure before "fixing" a distribution, then measure again after.** The
  DISTRICT_BUILDINGS weights look wrong and the obvious repairs make them
  worse; `tools/typemix.mjs` caught that within one build each time. Two
  changes were written, measured, and reverted on the evidence.

## Current state summary (as of last commit)

- Scale fixed (FLOOR_HEIGHT 1.8), lamp pools as ground discs, chimneys
  anchored to mainBody with 7 whimsical variants
- Terrain slopes continuously (corner-shared heights, retaining walls
  gated at 0.6m drop)
- Cobble texture via procedural voronoi + grout, pucks removed
- Window moods warm-clamped, flicker slow (0.25–0.7 Hz ±4%)
- Lamp pools horizontal discs with radial alpha
- Lanterns in three layers: overhead rope strings, wall-mounted at 2.4m,
  plus ground pools under lampposts
- Birds circle tall spires at dusk only
- Row-streak placement (continuity 0.7, 2-4 tangent extensions, ±1
  floor variation)
- Tower-house whimsy (4% of buildings get +2 floors)
- Coalesced wall meshes (merge 2+ same-material into 1 mesh)
- Shadow: 512² map, PCF, camera-follow at 28m radius
- Bloom half-res, composer gated in daytime
- Debug dump exposes honest FPS, draw calls, frame time split
- Street network narrowed (circulation 48% → 39-43% of tiles), which turned
  the freed land into ~40 more buildings: ~165-222 structures per town
- **Scale fixed: `TILE = 3.0`.** A 1x2 row house is 3m x 6m x ~7m instead of
  1m x 2m x 7m. Median building top 8.1 against a 1.6 eye height.
- Player has a collision radius; ground follow interpolates instead of stepping
- Water seams with its banks over an opaque bed; cobbles are ~24cm setts
- ACES tone mapping, 512² shadow map at 30m, texel-derived normalBias
- Placement audit is at **0 errors AND 0 warnings across 16 seeds**
- **Street network narrowed for real.** `narrowRoadSwathes` erodes merged road
  swathes back to 3 tiles; over-wide corridors 58% -> 4%, facade-to-facade
  21m -> 12m, height-to-width 0.49 -> 0.89. Designed squares are spared via a
  `squareMap`, road hierarchy comes from a `tierMap` the carver writes, and
  `softenBackOfBlock` unpaves the land behind the terraces into gardens, grass
  and mud. ~250 structures per town.
- Plan view reads: role-tinted buildings, prop glyphs, labels that fit
- Pixel-art export works at every hour (see tools/pixelart.mjs)

## HUMAN SCALE — read tools/humanscale.mjs before believing a screenshot

TILE = 3.0 fixed the *town's* scale. It did not fix the *building's*, and three
rounds of screenshots failed to tell the two apart. The audit did it in one run:

| metric | was | now | real |
|---|---|---|---|
| storey height | 1.91m | 2.90m | 2.6-3.2 |
| door height | 0.79m | 2.05m | 2.0 |
| window height | 0.50m | 1.35m | 1.3 |
| doors shorter than a person | **95%** | 0% | — |
| storeys under head height | 59% | 0% | — |
| frontage p10 / min | 1.34 / 0.55m | 2.60 / 2.60m | — |

Three causes, all of them a number that meant one thing and was read as another:

1. **`FLOOR_HEIGHT` was 1.8m.** A storey is 2.9. The old comment warned against
   raising it because it "makes needles" — true when a building was 1-3 world
   units WIDE, meaningless at TILE = 3. Now `STOREY_HEIGHT` in scale.ts, one
   definition.
2. **`volumeFloors` divided height by a hardcoded `0.9`** left over from an
   earlier scale, so a 5.4m volume claimed SIX storeys and the facade painted
   six rows of windows a third of a metre tall. It also trusted an explicit
   floor count even when that implied an 0.8m storey — templates hand the
   BUILDING's floor count to every volume, including a jetty's squat lower
   floor.
3. **FacadeTexture laid out in texture units, not metres.** The canvas was
   `width` by `floors + 0.5` units and got stretched over the wall, so an
   opening's real size was its fraction times the wall — a taller building
   squeezed the same drawing into more wall and every opening shrank. Both axes
   are metric now: a door drawn at 2.05 units lands at 2.05 metres on any
   building. `FacadeConfig.width`/`wallH` are METRES, quantised to 0.5m so the
   cache stays bounded.

And the "some tiny" half: templates inset volumes by FRACTIONS that compound
(a jetty takes 54% off the lower floor, an L-wing is 55% of frontage,
wealthScale another 22%), and each template's own floor — `Math.max(0.9, ...)`
— meant 0.9 of a TILE when it was written. `MIN_HABITABLE_W` is enforced once
at the end of massing and again after wealthScale, bounded by footprint +
MAX_OVERHANG so it can never reintroduce a sail.

## THE SCALE FACTOR (fixed — read before touching FLOOR_HEIGHT or TILE)

Reported from the phone as "houses the size of cars with windows as big as
inches". Measured, the diagnosis was the opposite of what it sounded like.

- Median building top was **6.96 units** against `EYE_HEIGHT = 1.6` — ~4.3x eye
  height, and a real two-storey house is ~4.1x. **Heights were already right.**
- But 60% of structures have a 1- or 2-tile footprint, mostly `row_house` at
  1x2, and the 3D scene passed footprint TILES straight through as world units.
  The typical building was **1m wide x 2m deep x ~7m tall — a 7:1 tower**. A
  1m facade can only fit inch-wide windows, so that complaint was literal.

**This is why raising FLOOR_HEIGHT 1.05 -> 1.8 did not fix it.** That treated a
horizontal problem with a vertical lever: it stopped buildings being squat and
made them needles. Do not reach for FLOOR_HEIGHT again — lowering it brings
kaiju scale straight back.

The fix is `src/renderer/renderer3d/scale.ts`: **`TILE = 3.0`**, the horizontal
tile -> world factor. Read that file before touching any of this; the rule is:

> Multiply by TILE when converting a **tile coordinate or a footprint extent**
> into world space. Do NOT multiply anything already expressed in metres.

Nearly every hardcoded number in the geometry code — a 0.4m chimney, a 0.9m
door, a 0.08m doorstep lip — was already metric and correct, and only looked
wrong because the buildings around it were too small. Vertical is untouched:
`TERRAIN_WORLD_SCALE` still maps raw height units to world height and
`FLOOR_HEIGHT` is still metres per storey.

Both factories keep the two footprints side by side and the distinction is
load-bearing:

- `fpT` — footprint in TILES. Anything that indexes the map: terrain sampling,
  per-tile loops, and "is this building wide enough for a stoop?" gates.
- `fp` — the same footprint in WORLD units. Every geometry dimension and local
  offset, which is nearly all of them.

`getTerrainHeight()` takes TILE coordinates; `groundYAtWorld()` takes world.
They used to be interchangeable and are not — mixing them silently samples the
height map at a third of the intended place. The `window.__pt` bridge takes
TILE coordinates horizontally and METRES vertically, and converts at the
boundary, so every tool keeps speaking grid cells.

## Known problems, reported from the device

In the reporter's words. All seven root causes are now identified; the first
six are fixed and pushed.

0. **See-through roofs AND "wild crossed timbers" — ONE bug, finally measured.**
   `tools/roofwinding.mjs` builds every roof style x axis x sag and checks each
   triangle's normal against the direction from the solid's centroid. First
   run: **136 inward-facing triangles**. Mansard was 18 of 18 — completely
   invisible. Hipped was 10 of 12, in every axis. Gabled and steep with
   `axis === 'z'` lost half the roof.
   With the roof surface culled away, all that renders is the roof's TRIM —
   bargeboards, ridge caps, finials — which are closed boxes and survive. Dark
   lines crossing in mid-air, on almost every building. **That is what the
   "wild crossed timbers" were.** Both complaints, one cause, and the
   protrusion audit confirms it: 0 pieces of building geometry stick out past
   their own envelope, so there were never any stray beams to find.
   Winding is no longer hand-maintained. `enforceOutwardWinding` runs the same
   centroid test the audit runs, as a repair, on every hand-written roof — so
   the audit cannot fail on anything that goes through it. Hand-written winding
   had been wrong in this file four separate times.
   **The older entry below is left in place because its fix was real but its
   verification was not** — it corrected one of the four cases and declared the
   class closed on the strength of a DoubleSide test taken from vantages that
   could not see the defect.
0b. **See-through roofs, first pass (incomplete)** — FIXED for one case only. The gable
   END TRIANGLES were wound backwards for `axis === 'x'`, which is most
   buildings (`roofAxisFor` returns 'x' whenever w >= d). Their normals pointed
   INTO the roof cavity, so backface culling removed them and you looked
   straight through the gable to the sky. The `axis === 'z'` gables were
   correct all along, which is why it looked fine in some shots.
   Compounding it: the prism had **no underside at all** — two slopes and two
   gable ends, an open shell. The eave PROJECTS past the wall, so from the
   street you look up into it, the slopes' undersides are backfaces and get
   culled, and the roof vanishes. What is left drawn is the trim, which is
   closed boxes — a set of dark lines hanging in mid-air. **That is what the
   "giant floating accent timbers" actually were.** Both symptoms, one cause.
   `buildGablePrism` now closes with a soffit wound to face -Y.
   **The verification lesson matters more than the fix**: an earlier pass
   tested this exact hypothesis with DoubleSide, saw no change, and ruled
   winding out — because every shot in the harness pointed level or DOWN. From
   above a roof looks complete. `walkshots.mjs` now carries a `gable-up` shot
   that looks UP from eye level, which is the angle every phone screenshot that
   reported this was taken from.
1. **Half built roofs (shallow pitch)** — also fixed, and a separate scale
   coupling. `roofHeightFor` derives the rise from wallH, which did not change,
   while the span the roof crosses tripled. Every pitch flattened by a third —
   a 40-degree gable became 23 degrees, and a shallow slab on a wide building
   reads as unfinished. `ensureRoofPitch` (Roofs.ts) now floors the rise
   against the span. Checked first and ruled out: flipped winding (roofs render
   identically under DoubleSide) and open-topped volumes (`tools/roofcheck.mjs`
   reports 1 across 3 seeds).
2. **Half-timber frame floating off the wall** — FIXED, and a real second
   cause once the roofs stopped hiding it. The exposed half-timber frame
   pushed every horizontal member out by `projOut`, the POST's outward shift:
   a post is 13cm deep and needs 5.9cm to seat, but the beams are 4.5cm deep,
   so they hung with a ~6cm slit behind them. Invisible on a 2m wall,
   unmistakable on a 12m one against a dusk sky. Members now seat their own
   inner face on the wall, and the frame subdivides — studs at a 1.7m bay
   pitch, plate returns around the corners, diagonal corner braces — so a wide
   building grows more frame rather than one longer beam.
2. **Scale** — FIXED. See above.
2. **Signs floating** — FIXED, and it was a whole family, not one bug. Shop
   signs, awnings, stoops, benches, doorsteps, hitching posts, colonnades,
   balconies and wall lanterns all hung off `fp.h / 2`: the edge of the
   footprint RECTANGLE. The massing volume is inset inside its footprint and
   then multiplied by wealthScale, so that anchor is some nonzero,
   per-building distance in FRONT of the actual wall. Everything front-attached
   now hangs off `frontWallZ` / `frontWallHalfW`, derived from the main volume.
3. **Buildings colliding / flickering overlapping textures** — FIXED. The
   corner-tower template sits at `footW/2 - towerW/2` and the L-shape wing at
   `wingSide * (footW/2 - wingW/2)`; both put a side face on exactly `footW/2`,
   the same plane as the main body's. Two coplanar same-facing quads is a
   depth-buffer tie. pickMassing nudges the attached volume 2cm proud.
4. **Shading glitches** — FIXED, two causes. (a) No tone mapping, so a surface
   facing the noon sky took sun 1.2 + ambient 0.42 + hemisphere 0.40 and
   everything over 1.0 was thrown away. ACES filmic at 1.15 exposure now. (b)
   `normalBias` was 0.04 against a 14cm shadow texel, so big sunlit walls
   self-shadowed at grazing sun — which is the dusk this scene is tuned for.
   It is derived from the texel size now.
5. **Props hovering or oddly placed** — FIXED for the causes found:
   `sampleGroundY` floored the camera position before sampling, throwing away
   the interpolation and snapping to a tile corner; chimneys offset by a
   fraction of the FOOTPRINT could clear the roof edge and stand on air beside
   the building; elevated walkways sat at 1.2m with their supports buried
   inside the buildings at each end. Wide props on steep slopes still sample at
   their centre — inherent to point sampling, and 3x less visible now that a
   bench spans a third of a tile instead of a whole one.
6. **Jagged water tiles** — FIXED. Water drew ONE flat quad per tile (the exact
   stair-step bug corner-shared heights fixed for the ground) into a hole in a
   sloped ground mesh, 0.08 BELOW the terrain — and the ground mesh skips water
   tiles entirely. What showed through was a ragged outline of whatever ground
   happened to be lower. It now uses corner-shared heights and the same quad
   diagonal as the ground, over an opaque bed.
7. **Collision feels random** — FIXED. `isBlocked` floored to one tile index
   and tested that single cell, so the player was a dimensionless point:
   standing with your nose in a wall was legal if your centre was on the open
   tile, and on the far side of the same tile you stopped a full tile early.
   The player is now a disc of `PLAYER_RADIUS = 0.35`.

## URBAN FORM — the measurement that reframed the rework

`tools/urbanform.mjs` measures the SPACE BETWEEN buildings rather than the
buildings, which is the thing every earlier metric could not see. Four numbers,
against what a real walled town runs:

| metric | real town | measured |
|---|---|---|
| frontage with a building against it | 85-95% | **76%** |
| buildings sharing a party wall | 60-80% | **91%** |
| built coverage of non-street land | 50-70% | **49%** |
| **street width, facade to facade** | **4-10m** | **24m** |

This inverted the assumption the rework was built on. Buildings already touch
each other MORE than a real town does, and coverage is nearly in range. The
town does not read as scatter because the buildings are badly arranged — it
reads as scatter because **the space between them is three times too wide.**
At 24m facade to facade with ~10m buildings, the height-to-width ratio is 0.4
against a comfortable 0.5-1.5. That is a field with things around the edge,
which is precisely how it was described.

Narrowing the carved roads (boulevards 4/3 -> 3/2 tiles, main streets 3 -> 2)
moved it only 27m -> 24m, and that was read as the second finding: road width
is not the dominant term, so ~18m of the 24m must be unbuilt SETBACK and the
buildings must not be pulled up to their frontage.

### THAT WAS WRONG, AND THE ERROR WAS ARITHMETIC ON AN UNVERIFIED TERM

**FIXED — street width is 12m now, and the setback was never the problem.**

The 18m came from subtracting an ASSUMED 6m road from a measured 24m total. It
was never measured. Split the width into the two terms that produce it — they
have different owners, the carriageway belonging to the road carver and the
setback to the placer — and the diagnosis inverts:

| term | assumed | measured |
|---|---|---|
| carriageway | 6m | **12m median, 33m at p90** |
| setback per side | ~9m | **0m median; 56% of walls flush against the kerb** |

The buildings were already where they should be. **The road was three times too
wide**, and every plan to pull frontages forward was aimed at a term that was
already zero. Four attempts at plot systems failed against a 9m target that
did not exist.

Two bugs in the measurement had to be fixed before it could say this, and both
are the same kind of mistake — a scan that does not know what it is scanning:

- It ran BOTH the `[1,0]` and `[0,1]` axes at every road tile regardless of
  which way the road ran, so half of every sample measured the LENGTH of the
  street. Near the map edge the out-of-bounds hit dressed that up as a
  legitimate 12-tile "width".
- Recovering the road's direction from "is there road beside me" then
  classified every tile of a 2-lane street as a junction and left only 1-wide
  alleys in the sample — 220 of them across three seeds, reporting a
  comfortable 6m. A run-length estimate tolerates width and keeps 3426.

**No single carve drew the wide road.** Nine main streets radiate from one
point, ~12 secondary streets land at random angles on the same 48x48 grid, and
every district centre gets a disc of road on top. Each is 1-3 tiles; their
UNION had 58% of road tiles in a corridor wider than 3 and one connected
component covering a quarter of the map. That is why narrowing the carver
moved 27m -> 24m and stopped — **the carver never drew it.**
`narrowRoadSwathes` erodes over-wide corridors from the shoreline inward,
sparing designed squares and removing only simple points (the standard 2D
thinning criterion, which provably cannot disconnect the network). Over-wide
58% -> 4%; largest road component 535 -> 155 tiles; facade to facade 21m ->
12m; height-to-width 0.49 -> 0.89.

### The frontage asymmetry — still open, and now the largest term

`urbanform.mjs` also splits frontage occupancy by which side of the road the
land is on, and the split is not random:

    land N of the road: 34%      land E of the road: 58%
    land S of the road: 40%      land W of the road: 52%

North-south streets are served half again as well as east-west ones. With the
carriageway fixed this is now the LARGEST remaining term in frontage
occupancy, which sits at 70% against 85-95%. It was previously measured, found
to move the by-side split by ~1 point, and set aside — correctly, because the
carriageway was swamping it. That reason has gone. The cause
is in `placeBuildings`: `const bw = type.w, bh = type.h` takes the footprint
as authored, whatever direction the street runs. A 1x2 row house therefore
presents a TWO tile face to a north-south street and a ONE tile face to an
east-west one, so the same building covers twice the frontage on one axis as
on the other. Half the streets in every town are structurally worse served
than the other half and nobody chose that.

`tools/genlog.mjs` runs one generation and prints layer counts, how many plots
rotated, any page exception, and the placer's rejection counters
(`placeStats`). It exists because a placement change can produce a town with
zero buildings and NO exception, which is indistinguishable from a placer that
simply chose not to build until you can see WHICH `continue` fired.

The fix is to orient the plot to its street — short side on the frontage,
depth running away from it, which is what makes a terrace a terrace and is the
same shape on both axes once oriented. **An attempt at this was reverted**: it
is not a local change, because `BuildingFactory` and `GeometryAudit` both look
the footprint up by definition id, so a reserved h x w rectangle has to be
communicated to both (a `plotRotated` property) and the building's base
rotation turned to match. Threading all three produced a town with zero
buildings and no exception. A second attempt, bisected with the new rejection
counters, got further and is worth writing down so the next one starts ahead:

- Swapping bw/bh alone is SAFE — 208 buildings, audit clean. Only ~6 of 223
  plots actually rotate, though, because a candidate whose road lies south or
  east has its footprint grow into that road and gets rejected. The swap on its
  own therefore buys almost nothing.
- Anchoring the far corner (`oy = ry - (bh - 1)` when the road is south, and
  the mirror for east) is the half that matters. With it, `placeStats` showed
  **43 buildings PLACED and a final map containing none** — so the loop throws
  partway through and something upstream swallows it. That is the thing to
  chase: find the swallowing try/catch, not the placement logic.
- The row-streak extension at the bottom of the loop reuses the anchor's
  bw/bh but pushes its own objects, so it needs `plotRotated` too or it
  reserves h x w while the renderer draws w x h.
- The scaffolding is already in place and inert: `GeometryAudit.footprintOf`
  and `BuildingFactory` both honour an `obj.properties.plotRotated` flag, and
  nothing sets it. The next attempt is a one-file change in TownGenerator.

Start here: it is the highest-value item in the rework and the measurement is
already in place to grade it.

Cheap side effect of the narrowing, worth keeping: ~+9 buildings per town and
coverage 48% -> 49%, because narrower streets return land to the blocks.

## STATE OF THE ENGINE — measured, all seeds, current main

Run these before believing anything about where the project is.

| audit | tool | reading | verdict |
|---|---|---|---|
| placement invariants | audit.mjs | 0 err / 0 warn, 8 seeds | clean |
| roof winding | roofwinding.mjs | 0 inward triangles | clean |
| geometry protrusion | slivers.mjs | 0 pieces outside envelope | clean |
| open-topped volumes | roofcheck.mjs | ~6 per town | near-clean |
| human scale | humanscale.mjs | door 2.05m, window 1.35m, storey 2.90m, 0% sub-human | clean |
| street emptiness | emptiness.mjs | median 3m, 0% over 12m | satisfiable by scatter — see below |
| enclosure (to a WALL) | streets.mjs | median 3m, 0% over 15m | clean |
| corridor width | streets.mjs | 4% of road over-wide, was 58% | clean |
| street width | urbanform.mjs | 12m facade to facade vs 4-10m | near range |
| built coverage | urbanform.mjs | 47% vs 50-70% — see the district trade below | slightly under |
| **district character** | **districts.mjs** | **57% of buildings distinctive to their quarter, was 26%** | **improving** |
| party walls | urbanform.mjs | 93% vs 60-80% | above range, deliberately |
| frontage occupancy | urbanform.mjs | **75% of ACHIEVABLE** frontage vs 85-95% (raw 66%) | near range |
| ground read | streets.mjs | 60% of the map one colour family | art-direction call |
| vista termination | vistas.mjs | 18% of long views end on a landmark, was 6% | improving |
| prop tenancy | tenancy.mjs | 46% of props explained by their owner, was 29% | improving |
| **360-degree read** | **allsides.mjs** | **flank/front 0.74 / 0.51 on two seeds, was 0.42 / 0.28** | **improving** |

**Every metric here is now in or near range, and the last outlier was mostly
the denominator.** That standing instruction — measure what the unoccupied
frontage actually IS before tuning against it — was finally carried out, and
it moved the reading nine points without touching the generator:

| why an unbuilt frontage edge is unbuilt | share |
|---|---|
| dressed with a prop | 37% — REAL |
| bare buildable ground | 22% — REAL |
| river bank | 19% |
| square skirt (plaza paving) | 11% |
| map edge | 10% |
| open grass | 1% — REAL |

40% of the shortfall is land nobody should build on, and the 85-95% band
counts it. Against ACHIEVABLE frontage the town reads **82%**, three points
under the band rather than twelve. Grade the achievable number; the raw one
moves when the river moves.

### THE DISTRICT TRADE — read this before "fixing" coverage

Coverage 50% -> 47% and achievable frontage 82% -> 75% are **deliberate and
they are the price of district character going 26% -> 57%.** Do not reverse
them without reading this.

The fill passes used to hardcode `row_house` / `building_small` into every
quarter while reading the district only to label the result. Making them draw
from `DISTRICT_BUILDINGS` instead means a quarter with no small ORDINARY
building simply does not get filled — and three of them have none:

| quarter | before | after |
|---|---|---|
| temple | 39 bldgs: row_house 20, staircase 7 | 19: staircase 8, bell_tower_tall 6 |
| noble | 21: row_house 13, tower 2 | 14: narrow_house 6, balcony_house 2 |
| cemetery | 12: row_house 7, chapel 2 | 4: chapel 2, tower 2 |

**The lost coverage was fake.** It was row houses stamped into a graveyard.
A cemetery with four buildings reads as a cemetery; one with twelve, seven of
them cottages, reads as a housing estate with graves in it.

Two constraints discovered while doing it, both worth keeping:

- **Infill must exclude `NEVER_TERRACED`.** A first pass let noble and
  cemetery fill their 2x2 gaps with TOWERS, which looks absurd and also games
  the character metric — a tower is by definition distinctive to its quarter.
  Monuments come from the main placer and from landmarks, never from infill.
- **Size the pick to the space actually free, not to a fixed slot.** Asking
  for types that fit 2x2 leaves a noble quarter nothing at all, because its
  smallest ordinary house is 3x2. `pickTypeForSpace` asks the occupancy map.

`narrow_house` was added to the noble table as its one small ordinary type —
every other noble entry is 3 wide or a tower. A census of the definitions
confirmed there is nothing else to reallocate: only `clock_tower` and
`windmill` are defined and unused, and both are 3x3 monuments. **A small
district-specific vocabulary (a sexton's hut, a coach house, clergy lodgings)
is the one place in this project where new building assets would clearly pay
for themselves** — it is what would let temple and cemetery be dense AND
distinctive instead of choosing.

Two things fell out of that decomposition and both are load-bearing:

- **"A prop stands there" is a SYMPTOM, not an excuse**, and it is the largest
  single category. Counting it as excusable gives 93% and would have closed
  the metric on a false reading. Which side it belongs on is settled by
  PIPELINE ORDER — `generate()` runs `placeBuildings` before every prop pass,
  the last named `dressEmptyStreets` — not by intuition. **A classifier's
  categories encode a causal claim; check it against the order things happen
  in.**
- **The remaining real gaps are not holes in a terrace.** A second infill pass
  over `roadEdges` was written, measured at 0.7 of a point, and reverted — and
  the split rejection counters said why: on the second pass, with the whole
  town already built, EVERY `acceptChance` rejection was still `lonely`. Those
  plots have no neighbour even at the end, so they are isolated frontage on
  the periphery and filling them would manufacture the exact scatter this arc
  removed. Do not re-attempt without first making those plots adjacent to
  something.

**`emptiness.mjs` is kept but do not trust it as an enclosure metric.** It
seeds its BFS from props as well as buildings, and props are scattered
everywhere by construction, so it can be satisfied by scattering harder — it
read a comfortable median while the town was still a lake. `streets.mjs`
measures distance to the nearest BUILDING, because only a building makes a
wall. Prefer metrics that can only be satisfied by the structure you want.

### The enabling refactor is DONE (and proved itself)

`PlacedObject` now carries `footprint` — the tile rectangle actually reserved
at placement — and `core/types.footprintOf(obj, def)` is the one way to ask,
preferring the reserved rectangle and falling back to the definition so old
maps still load. GeometryAudit, BuildingFactory and the generator's own
`markObjects` all read it.

Proof it worked: plot orientation, the change that had failed four times and
last produced **118 placement errors**, was re-applied afterwards as a
**one-file change** and the audit stayed at **0 errors / 0 warnings**. Then it
was removed again — see below — but the point stands: structural changes to how
a building occupies space are now safe.

**When adding a new placement site, set `footprint` on the object.** That is
the only rule. Anything reading `def.footprint` directly is a bug waiting for
the next structural change.

### THE PLOT PROBLEM IS SOLVED — fifth attempt, and it was the anchor

**Built coverage 47% -> 53%, inside the 50-70% a real walled town runs.**
Frontage on the structurally-broken side 34% -> 43%; the axis gap narrowed
from 24 points to 13; party walls 93%; frontage occupancy 73%.

It was never about which way a building FACES. A footprint grows +X/+Y from
its origin, and the origin was always the road-edge tile, so a plot whose
street lies SOUTH grew into that street and was rejected — and the tile that
would have worked (origin one row north, south wall on the kerb) is not
adjacent to any road, so it is not in `roadEdges` and was never tried. Half of
every town was structurally unbuildable. The x-axis only showed a mild version
because a 1-wide row house cannot overlap an eastern road.

`placeBuildings` now sets `ox`/`oy` so the building ENDS at the road edge when
the street is south or east, and every consumer inside the loop reads the
anchored rectangle: road-side detection, terrain height, style noise, the
object, the occupancy marking, and the row streak's step origin. **Keep the
lower-bound guard** — the previous attempt indexed `occupied[-1]` and threw.

Two things that are NOT in that diff had to land first, which is the whole
lesson: `PlacedObject` had to carry its own footprint, and generation failures
had to reach the console instead of a UI state variable. Four attempts failed
against those two absences, not against the placement logic.

Measured and reverted on the way: making the row streak's length a distance in
tiles rather than a count of buildings. A 1x2 house steps 1 tile along an
east-west street and 2 along a north-south one, so a fixed count builds twice
the wall on one axis — a clean-looking explanation for the asymmetry, worth
0.5 points when measured, and coverage went slightly down. It was a real
mechanism that was not the cause; those are the expensive ones.

### Plot orientation (short-side-to-street): still measured at zero

Short-side-to-the-street is architecturally correct, is what makes a terrace a
terrace, and with the refactor it is audit-clean. It was measured twice and
removed because it moved frontage occupancy by side only 38/45/59/58 ->
39/47/61/58.

**That verdict has expired.** It was measured while the carriageway was three
times too wide, which swamped everything else; the roads are 6m now and the
axis asymmetry is the largest remaining term in the one metric still out of
range. Re-attempt it. The notes below on HOW it failed are still accurate and
still the place to start — in particular, anchoring the far corner is the half
that matters, and the swallowed exception is the thing to chase.

### The architectural debt behind four failed attempts (historical)

Four separate attempts to change how a building occupies space have failed the
same way, and the cause is structural: **`PlacedObject` does not carry its own
footprint.** It stores only `definitionId`, and TEN files independently look
the rectangle up from that id — store.ts, BuildingFactory, Canvas2DRenderer,
Massing, GeometryAudit, TownGenerator, LanternStrings, PlaceTool, ThreeRenderer,
StructureLayer.

So any change to what rectangle a building occupies has to be threaded through
all ten, and missing one is silent: the generator reserves h x w, a consumer
reads w x h, and you get props buried inside buildings or meshes drawn through
neighbours. The plot system will hit this wall on its first day.

**Do the enabling refactor first.** Give `PlacedObject` an explicit reserved
footprint written at placement time, and make every consumer read it instead of
looking it up. It is mechanical, the placement audit is a complete test for it
(it must stay 0/0), and it turns the plot system from a ten-file change into a
one-file change.

### A lesson about the metrics themselves

`emptiness.mjs` reached 0% of tiles more than 12m from anything, and the town
still read as "random scatter across big open spaces". The metric was
SATISFIABLE BY SCATTER — adding props moved it without changing the structure.
`urbanform.mjs` is the first metric that is not: you cannot fake frontage
occupancy or facade-to-facade street width with props, only with buildings in
the right places. Prefer metrics that can only be satisfied by the structure
you actually want; a metric that scatter can satisfy will be satisfied by
scatter.

## THEME-PARK DESIGN, AND WHY IT ALL POINTS AT ONE NUMBER

DESIGN.md names the references; this is what they have in common mechanically,
and it happens to agree with the only failing metric.

- **Compression.** Disney's Main Street is about 10m wide against ~12m
  facades — a height-to-width near 1.2. Diagon Alley is tighter, Gion tighter
  still. That compression is the whole trick: it makes a modest street feel
  like a place. **Ours is 24m wide against ~10m buildings: 0.4.** Every
  reference in DESIGN.md is between 1.0 and 2.0. This is the single number that
  separates "a town" from "a field with things around the edge", and it is the
  same outlier urbanform.mjs reports.
- **The weenie.** A visual magnet terminating a vista, pulling you forward.
  Landmarks here land wherever they fit; they should close the end of a street.
  Cheap to add once blocks exist, and it is what turns wandering into moving
  toward something.
- **Read at three distances.** Silhouette at 100ft, composition at 30ft, detail
  at 3ft. Silhouette works (roof variety, height rhythm). Detail works now
  (metric facades, string courses, framing). **The 30ft read is the hole** —
  and the 30ft read IS the street wall.
- **Cross-dissolve.** You never see two lands at once; a bend or a berm hides
  the seam. Districts here blend arbitrarily in the open.
- **Kinetics and patina.** Already covered by DESIGN.md pillars 4 and the
  weather/lean system. These are in decent shape.

So the aesthetic references, the Imagineering rulebook and the measurement all
name the same next move, which is reassuring: **close the street wall.**

## COMPOSITION AND TENANCY — the arc after urban form

With the streets fixed, the two rework items that were blocked on them landed.
Both are "measure from where the player stands", which is the through-line.

**Vista termination 6% -> 18%** (`tools/vistas.mjs`). Landmarks were placed
AFTER buildings, so by the time a cathedral looked for somewhere to stand,
every spot that closed a street was a row house. Composition has to be decided
before the infill — which is also the ordinary way round for a town. The
single largest term was not the cathedral though: **the gate cap was four,
keyed on compass side**, while the carver radiates ~9 main streets outward, so
every exit after the first on each edge was silently discarded. Gates dedupe
by distance now; town_gate went from terminating 42 views to 120.

**Prop tenancy 35% -> 46% explained** (`tools/tenancy.mjs`). 90% of props
already touched a building; only 29% touched one that explained them, because
`getBuildingSpecificProps` returns `[]` for every ordinary dwelling and row
houses are 40% of the town. `propForRole` gives dwellings a vocabulary split
by WHICH SIDE the spot is on — flower box to the street, woodpile and rain
barrel round the back. The placer already knew the side; it just wasn't using
the fact for anything but position.

Two lessons from this arc, both about grading your own work:

- **A fix and a metric that share a wrong assumption agree perfectly and are
  both wrong.** The vista pass and the vista metric both stopped a view at a
  change of ground material. A pass that placed 40 buildings moved the number
  by exactly zero, and the byte-identical output was the only reason it got
  caught. Correcting the model collapsed a whole 35% category to 0%.
- **If you change the tool and the code in the same session, A/B the tool
  separately.** Tenancy read 29% -> 46%, but 29 -> 35 was the metric being
  corrected (it graded domestic props against prop ids the game does not
  define) and only 35 -> 46 was the change. Run the new tool against the old
  build before claiming the delta.

## THE GENERATION REWORK (next arc — read before adding more props)

Reported plainly: "it still reads as random scatter across big open spaces
with pseudo-random building assets dropped around." That is correct, and no
amount of placement hygiene fixes it. Everything up to here — denser plazas,
kerbside clutter, a distance metric — is **scatter with better rules, which is
still scatter.** The generator has no concept of a PLACE.

What it has today: districts (a zone with a type), roads, buildings placed by
walking road EDGES one at a time with a gap and a rotation wobble, and props
scattered by a global distance metric. Nothing owns anything. A building does
not belong to a block; a barrel does not belong to a tavern.

What makes a town read as a town, roughly in order of payoff:

1. **Blocks and plots.** The land between streets is a BLOCK. Subdivide each
   block's street frontage into PLOTS, give each plot to exactly one building,
   and make the building fill its plot's frontage. Terraces then share party
   walls and the street gets a continuous wall instead of detached objects with
   gaps. This is the single biggest difference between "assets on ground" and
   "a town", and it replaces the current Phase B road-edge walk.
2. **Back-of-block space becomes courtyards and gardens**, enclosed by the
   terrace, instead of the current leftover void. Enclosure is what makes a
   town feel built rather than placed.
3. **Props are OWNED.** A prop should be emitted by its parcel with a role —
   barrels at the tavern's side door, a bench under the front window, a cart in
   the yard, a well in the courtyard — not sprinkled by a global metric. The
   metric answers "is this spot bare"; ownership answers "why is this here",
   and only the second one reads as sensical.
4. **Composition.** Landmarks should terminate street vistas rather than land
   wherever they fit; a market square should be surrounded by trade frontages.

The step already taken (see below) is only 1a: buildings that know their road
are now square to it. Do NOT add more scatter passes before the plot system —
`dressEmptyStreets` is a stopgap and should end up mostly redundant once
parcels own their frontage.

## What's still open / what to push on next

The whole device problem list is fixed. What is left:

0. **Verify on real hardware.** The scale change is the largest single edit
   this project has taken and every screenshot of it is SwiftShader software
   rendering. Get a debug dump from the phone. Specifically watch draw calls:
   the shadow frustum went from covering six tiles to ten, and every caster
   inside it is a shadow-pass draw. The last real-hardware number was 104 FPS
   at 202 draws, before that change.
1. **Ground-level life is thin.** Streets are lit and kerb-dressed now, but
   the walkable space could still carry more. Highest aesthetic payoff.
2. **Only ~7 of ~200 buildings are trade types**, and market districts are
   mostly plain row houses. Signage compensates on the render side, but
   biasing district building-type weights would make markets read as markets
   in the plan view too. This is now easy to *see*, since the plan colours by
   role — a market district that looks residential is visibly wrong.
3. **Row placement predates the narrowing.** Streets are much tighter than
   when the row-streak logic was tuned; worth revisiting whether rows should
   hug the new lanes more aggressively.
4. **Perf on real hardware is unmeasured.** ~125k triangles at ~300-600 draw
   calls is unremarkable for a GPU; the low FPS in agent screenshots is
   SwiftShader software rendering with no GPU. Don't optimise against that
   number — get a debug dump from real hardware first. The narrowing added
   ~40 buildings per town, so this is more worth checking than it was.
5. **The 3D walkaround has no equivalent of the pixel-art tone-mapping fix.**
   Its composer/bloom is disabled, so it dodged the problem, but if bloom is
   ever re-enabled check it against a dense dusk town, not a sparse one —
   that is exactly how the Canvas2D light map got away with being broken.

## Quick reference — where commands live

- Start session: `git pull origin main`
- Build check: `npm run typecheck && npm run build`
  **Check the build with a success marker, not `| tail -1`.** On failure the
  last line of `npm run build` is an esbuild stack frame, not an error banner,
  so `tail -1` reads as "something happened" either way. A failing build leaves
  the PREVIOUS bundle in dist/, so the app keeps running old code and every
  measurement you take afterwards is of the change you did not make. Use:
      npm run build 2>&1 | grep -E "^✓ built in [0-9.]+s|error"
  This cost a full debugging cycle: an esbuild "symbol has already been
  declared" error was invisible, the bundle never updated, and the A/B looked
  byte-identical — which reads as "the change did nothing" rather than "the
  change was never compiled".
- Commit: `git add -A && git commit -m "..."`
- Push: `git push origin main`
- Inspect latest dump: see Debug-dump workflow above

## Seeing and measuring the app (no display needed)

You do not have to guess what the app looks like, and you should not.

```bash
npm install && npm run build
xvfb-run -a -s "-screen 0 1400x900x24" node tools/screenshot.mjs   # or: npm run shot
```

**Every tool needs `xvfb-run` on a headless box** — Electron exits with
"Missing X server or $DISPLAY" otherwise, and the failure looks like a
SIGSEGV crash rather than a missing display.

Screenshots land in `.shots/`. Three more tools and a live bridge:

- `node tools/audit.mjs [seeds...] [--max-errors=N]` — placement invariants
  (see `renderer3d/GeometryAudit.ts`). Currently **0 errors, 0 warnings across
  16 seeds**; exits non-zero above the budget, so run it after touching
  placement or massing. Never raise the budget to make a red run green.
  Regression seeds: `4242 777 31337 11 65535 2024 8080 999999`. Untested
  seeds keep finding real bugs — the last sweep of eight fresh ones caught a
  town gate standing in a river, so add new seeds, don't just rerun these.
- `node tools/pixelart.mjs [seeds...] [--time=12]` — captures the **pixel-art
  render path** (Render / Export PNG), which the screenshot harness cannot
  see because the result lands in an `<img>`, not a canvas. `--time` renders
  a different hour; comparing dusk against noon is the fastest way to tell a
  lighting bug from a draw bug.
- `node tools/walkshots.mjs [seed] [--time=12]` — flies the 3D camera through
  five fixed vantage points (overview, skyline, two street-level, rooftops)
  and prints scene extent + draw calls. `tools/screenshot.mjs` only ever sees
  the player spawn, which is usually pressed against a wall. Also hides the
  "Click to walk" hint (`.walk-hint`), which otherwise sits dead centre of
  every shot.
- `node tools/overhang.mjs [seeds...]` — volumes trimmed by the footprint
  overhang cap, by `definitionId:role`. The placement audit checks FOOTPRINTS,
  so a building can pass every invariant and still throw geometry through its
  neighbour; this is the only thing looking at mesh extents. Should trend to
  zero — non-zero means a massing template overhangs.
- `node tools/slivers.mjs [seeds...] [--min=4] [--shoot=N]` — long thin batched
  geometry (the "giant floating timber" class), keyed by the SOURCE LINE that
  emitted it plus a world position, and optionally photographed. A batched mesh
  otherwise gives you no way to ask which line drew a triangle, which is why
  that defect survived several rounds of staring at screenshots.
- `node tools/urbanform.mjs [seeds...]` — **frontage occupancy, party walls,
  built coverage, and street width DECOMPOSED into carriageway + setback.**
  The only tool that measures the space BETWEEN buildings, which is what
  decides whether a town reads as a town. The decomposition is the point: a
  single width figure has two owners and was misread for months as being all
  setback. Also splits frontage occupancy by which side of the road the land
  is on, which is where the remaining asymmetry shows.
- `node tools/spawn.mjs [seeds...]` — **does the player start somewhere they
  can stand?** Inside a building, in water, buried below terrain, or with
  nowhere to walk, across sixteen seeds. Nothing else here touches the spawn
  path; it was 5-in-16 broken and invisible to every other audit.
- `node tools/allsides.mjs [seed] [--n=30] [--save]` — **is a building worth
  looking at from ANY side?** Photographs each sampled building from all four
  compass directions and compares edge density, PAIRED so the comparison
  cancels out size, colour and neighbours. Only sides the player could stand on
  are graded: 93% of buildings share a party wall, and a flank buried against a
  neighbour is legitimately backstage. **Watch FLANK/front, not back/front** —
  the first version shot only front-vs-back, which is the pair that was never
  broken, and read a comfortable 0.79 while both flanks were flat untextured
  colour. Read its sensitivity note: it cannot grade a feature that only 4% of
  buildings carry, and the same build read 0.28 at n=14 and 0.79 at n=30.
- `node tools/budget.mjs [seed]` — **what this build COSTS.** Meshes,
  multi-material meshes, triangles, and live texture SURFACE in MB. Every
  other tool grades whether the town is right; none grades what it costs to
  draw, and the target is a phone. Written after finishing all four walls of
  every building took facade texture surface 78.9MB -> 150MB with **no change
  in draw calls at all** — a multi-material box costs one draw per geometry
  group however many distinct materials the array holds, so material-count
  regressions are invisible there. Watch the MB, not the count:
  `info.memory.textures` counts texture OBJECTS, so authoring a face coarser
  changes bytes and not one object. The seed is pinned; to A/B against another
  commit, stash `src/renderer/renderer3d/`, check the old files out, rebuild,
  and run it again on the same seed.
- `node tools/features.mjs [seeds...]` — **a census of every gated piece of
  street dressing**, with its rate and its SPREAD across districts. Catches
  the two silent failures: a GHOST that is gated into nonexistence, and
  WALLPAPER that fires everywhere equally and so tells the player nothing.
  Run it after touching any dressing gate. Read the caveat it prints — a
  feature correctly confined to a rare type looks identical to a ghost.
- `node tools/districts.mjs [seeds...]` — **can you tell which quarter you are
  in?** Character (are the building types distinctive), signature (do ground,
  height and density differ), and trade dressing per district. Prints
  within-district height spread beside the median on purpose: DESIGN.md wants
  variation INSIDE a cluster while Lynch wants quarters to differ FROM each
  other, and separating the medians by flattening the spread would satisfy one
  and break the other.
- `node tools/squares.mjs [seeds...]` — **is the open space a room or a gap?**
  Counts squares, their minor dimension, and enclosure as LINE OF SIGHT from
  the middle of the square. Graded against Sitte and Alexander #61.
- `node tools/anomaly.mjs [seed] [--time=12] [--shots=N] [--hide=meshName]` —
  **the defects that only exist in PIXELS.** Every other tool grades the data
  model, which can only find what somebody already knew to ask about; the
  audits sat at 0 while the phone kept sending photographs of black poles
  sticking out of buildings, and both were true. This flies the camera around
  the town LOOKING UP (the angle every such photo was taken from), reads the
  framebuffer, and finds long thin dark shapes silhouetted against the sky by
  morphological opening, plus high-frequency speckle blocks. Writes annotated
  frames to `.shots/anomaly/`. `--hide=<meshName>` subtracts a named mesh and
  re-counts, which turns "is that a rope or a stray beam?" into one run — that
  is how the lantern ropes were ruled out. **Read its noise-floor line before
  its findings.**
- `node tools/site.mjs [seeds...]` — **does the town know the water is there?**
  Waterfront frontage, quay coverage, severance by the river, and whether the
  town WALL is a continuous edge or scenery with holes in it.
- `node tools/vistas.mjs [seeds...]` — **what you SEE looking down a street.**
  The first metric here that grades the town from INSIDE rather than from
  above: stand on every road tile, look along the corridor, record what stops
  the view — a landmark, an ordinary building, the horizon, or the map edge.
  This is the Imagineering "weenie" made countable. Read the note in the file
  about what terminates a view: an early version stopped at a change of FLOOR
  MATERIAL and reported 35% of long views as dissolving into open ground,
  which is not something a player can see. Cobble turning to grass does not
  end a view; a building does.
- `node tools/tenancy.mjs [seeds...]` — **does anything belong to anything?**
  For every prop: is it on a building's perimeter, and would that building
  plausibly own it? Adjacency was never the problem (90%); MEANING was (29%).
  Civic and natural props are excluded — a lamppost belongs to the street and
  a tree to the ground, and counting them as tenancy failures makes the number
  say nothing. Prefer this over emptiness.mjs when asking whether the town
  reads as inhabited.
- `node tools/streets.mjs [seeds...]` — **the road network on its own terms.**
  Tile histogram; corridor width per road tile against what the carver
  authorises; connected road components; ground colour families; and
  ENCLOSURE as distance to the nearest building. This is the tool that found
  the merged lake — the carver only ever draws 1-3 tiles, so anything wider is
  roads that overlapped, and no amount of narrowing the carver touches it.
- `node tools/emptiness.mjs [seeds...]` — distance from every walkable tile to
  the nearest prop or building frontage, as a distribution, split street vs
  plaza. "A ton of empty space" is a real complaint and a vague one; this makes
  it a number and says WHICH surface is bare. Streets were median 6m with 8% of
  tiles over 12m from anything; they are median 3m and 0% now.
- `node tools/roofwinding.mjs` — **every roof triangle checked for OUTWARD
  winding, exhaustively, with no camera.** The batched material is FrontSide,
  so an inward-facing triangle is DELETED, not mis-lit — and you cannot
  photograph a face that is not drawn, which is why camera checks produced a
  confident false negative on this exact bug. Must read 0. Run after touching
  any roof builder.
- `node tools/humanscale.mjs [seeds...] [--by-type]` — **the scale audit.** Every
  building's dimensions in METRES against what that thing measures in the real
  world, as a DISTRIBUTION. A median cannot see "some buildings are tiny and
  others are huge, and the tiny ones have tiny doors" — that is a spread and a
  detail-tracks-its-building problem, and this is the only tool that shows
  either. Run it after touching STOREY_HEIGHT, TILE, any massing template's
  size fractions, or FacadeTexture. Read the numbers, not a screenshot.
- `node tools/roofcheck.mjs [seeds...]` — volumes whose top is flat with
  nothing stacked on them, i.e. open boxes against the sky. Should stay near 0.
- `node tools/bisect.mjs [seed] [--x= --z= --up= --yaw= --pitch=] [--mesh]` — screenshot
  one vantage point with each top-level scene group hidden in turn, so "what IS
  that artifact?" is a diff instead of a guess. TS `private` is compile-time
  only, so the groups are reachable through the bridge. This is what found the
  finials floating above the spire tips.
- `node tools/typemix.mjs [seeds...]` — what building types actually get
  placed, and at what footprint size. Read the note in `placeBuildings`
  before trying to change the mix; the obvious fixes were tried and measured
  and they made it worse.
- `node tools/inspect.mjs <seed> <issue-kind>` — flies the camera to flagged
  objects and screenshots them.
- `window.__pt` (see `debug/DebugBridge.ts`) — from devtools or
  `page.evaluate`: `audit()`, `debugInfo()`, `sceneStats()`, `heightAt()`,
  `teleport()`, `flyTo()`, `inspectTile()`, `fragmentAudit`.
  TS `private` is compile-time only, so `__pt.renderer().buildingGroup` etc.
  are reachable — hiding groups/meshes at runtime is the fastest way to
  bisect "what is that artifact?".

## Android / mobile build

The renderer runs as a plain web app, which is what makes an APK possible —
Electron has no Android port, so the phone build is the web bundle inside a
Capacitor WebView.

```bash
npm run build:web     # dist-web/ — standalone, no Electron
npm run android:apk   # -> android/app/build/outputs/apk/debug/app-debug.apk
xvfb-run -a node tools/webshot.mjs --mobile   # Pixel-sized preview, no device
```

- `src/renderer/core/platform.ts` is the one place that knows which host it is
  on. Never call `window.electronAPI` directly again — it does not exist in
  the browser or the APK, and the old direct calls made Save/Open silently
  no-op there.
- Touch: left half of the 3D canvas is a drag-anywhere virtual stick, right
  half looks. There is no pointer lock and no keyboard on a phone.
- Layout: phones do NOT get the desktop shell. `LandscapeMode` hands off to
  `ui/modes/MobileShell.tsx` — full-bleed viewport, a floating 2D/3D switch,
  and four bottom tabs (Build / Objects / World / Render) that open a sheet
  over the lower half. It reuses the same panel components, so nothing can
  drift from desktop behaviour. Sliding the desktop rails in from the side
  was tried first and is not a mobile layout: opening one covered three
  quarters of the screen and left the town as a thumbnail inside a menu.
- The phone breakpoint is `MOBILE_LAYOUT_QUERY` in core/platform.ts, mirrored
  verbatim in App.css. **Width alone does not identify a phone** — a Pixel is
  412px in portrait and 915px in landscape, so a width-only rule shipped an
  APK that reverted to the desktop layout the moment it was rotated.
- `tools/webshot.mjs --device=` has presets (pixel, pixel-land, pixel-pro,
  fold, tablet). Testing one shape is what let that through; check landscape.
- Toolchain needed for the APK: JDK 21, Android SDK platform 34 +
  build-tools 34.0.0 (`sdkmanager "platforms;android-34" "build-tools;34.0.0"`),
  and `android/local.properties` pointing `sdk.dir` at the SDK.
- The debug APK is signed with the throwaway debug key, so it installs only
  with "install unknown apps" enabled. A release build needs a real keystore.
