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

**Photograph what you carve. The number and the picture were measuring
different surfaces.** river.mjs read bank relief against `heightAt()`, which
under a water tile is the BED — so every figure was land-to-bed, deeper than
anything an eye can see. Worse, the SURFACE was drawn from `terrainCornerY`,
which samples the height field at the corner's own tile: a water tile beside
land takes the LAND height at that corner, so the water ramped up out of its
channel at every shoreline and met the quay flush. The tool reported 0.71m of
relief and the photograph showed a knife edge, and both were honest about the
thing they were looking at. Anything that reshapes terrain needs a screenshot
from standing height, and `tools/rivershot.mjs` picks a vantage that is
actually standable because `flyTo` does not test occupancy — three attempts in
a row landed inside a building.

**A median cannot see a canyon — report the tail of anything you carve.**
The first river carve measured a perfectly healthy 1.14m median bank relief
and a phone screenshot came back captioned "wow, it's a grand canyon". Adding
the MAX to the tool showed 2.06m, and the real culprit was PROPORTION rather
than depth: a channel five tiles across is 15m of dark water at dusk with long
graded ramps either side. When a change reshapes terrain, one summary number
is never enough — a fat tail and a healthy middle look identical in a median.

**A clamp that only pushes one way is not a clamp.** The bank carve only ever
RAISED land, reasoning that a river should not flatten a hill it runs past.
True of a landscape, false of a channel: where the course grazed high ground,
the bed was cut down and the land was left towering, which is a slot canyon
with a stream in it. Blending both ways bounds the result by construction
instead of reporting it afterwards.

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

**A metric you stop running can regress in silence.** District character was
recorded at 55%, and while the whole river arc was under way — carve, quay,
waterfront, crossings — nothing re-ran the TOWN battery. It reads 36-37% now
without the trade types, and a bisect showed the square work cost only one
point of it, so roughly eighteen points went missing somewhere in the river
arc and no commit message mentions it. Run the battery for the system you are
NOT working on; that is the only way a side effect gets caught while it is
still one commit wide.

**An exclusive type that is too big to place is not an exclusive type.** The
trade quarters read 14-33% against noble's 100% and garden's 85%, and it was
tempting to blame the weights: harbor's table is 25% warehouse and only 9%
row house. But placeBuildings' own note already records that a type's real
odds are its weight TIMES how often it fits — so `covered_market` (4x3,
market-only) and `lighthouse` (3x3, harbor-only) never place, and the quarter
falls back on the small generic types it shares with every other quarter. The
fix is the same one that worked for temple and cemetery: give it a SMALL
exclusive type. Measured cleanly by stash-and-rebuild, `net_loft` and
`weigh_house` are worth +8 points.

**A designed place must be dressed BEFORE the global scatter runs.** Three
instances of this in one day. The waterfront pass ran after placeVegetation
and found half the bank planted with trees. The generic scatter took the quay
lip. And `placePlazaFeatures` ran after placeProps, placeLights and
placeStreetFurniture — the main square is the most attractive open space on
the map by any distance metric, so those three filled it and the square's own
composition pass arrived to find nothing left. The scatter answers "is this
spot bare"; only the owner knows what belongs there.

**Reset diagnostics at the TOP of the thing you are diagnosing.** `placeStats`
was cleared inside `placeBuildings`, which is step 10 of about twenty — so
every counter recorded by an earlier pass was wiped before anyone could read
it, and a new counter in step 7 simply never appeared. A diagnostic that only
works for the second half of a pipeline has a trap in it.

**Census the ART, not only the gates.** `features.mjs` audits gated
FEATURES and `registry.mjs` audits DEFINITIONS, and between them they still
missed twenty finished prop geometries that the store never defined — so
PropFactory could draw `rowboat`, `skiff`, `boulder`, `rock`, `rocky_outcrop`
and `port_crane`, and nothing could ever place them. That is the ghost in
reverse: not content gated into nonexistence but content with no way in. Diff
the ids the RENDERER handles against the ids the store DEFINES; it is one
grep and it found a whole river vocabulary already modelled.

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
| street width | urbanform.mjs | 12m facade to facade vs 4-10m | recovered |
| built coverage | urbanform.mjs | 47% vs 50-70% (walls not counted as buildings) | near range |
| district character | districts.mjs | 44% distinctive to their quarter (was 26%; 55% was recorded and has since drifted — see below) | improving |
| party walls | urbanform.mjs | 89% vs 60-80% | above range, deliberately |
| frontage occupancy | urbanform.mjs | **76% of ACHIEVABLE** frontage vs 85-95% (raw 70%) | near range |
| ground read | streets.mjs | 60% of the map one colour family | art-direction call |
| vista termination | vistas.mjs | 18% of long views end on a landmark, was 6% | improving |
| prop tenancy | tenancy.mjs | 46% of props explained by their owner, was 29% | improving |
| **the river** | **river.mjs** | **bank relief 0.67m med / 1.28m max (was 0.03m), drop +3.6m** | **fixed** |
| river severance | site.mjs | 0 of 5 seeds have an unreachable district, was 2 | clean |
| waterfront dressing | (see dressWaterfront) | 10 maritime/natural types at the bank, was 2 | improving |
| **360-degree read** | **allsides.mjs** | **flank/front 0.74 / 0.51 on two seeds, was 0.42 / 0.28** | **improving** |
| **the district seam** | **seam.mjs** | **90% of quarter crossings marked, 3 unmarked in 8 towns** | **closed — was believed unbuilt** |
| which quarters exist | quarters.mjs | one water quarter per town, residential in 8 of 8 | fixed |

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

### THE SMALL DISTRICT VOCABULARY — six new types, and what they bought

The note above said a small district-specific vocabulary was the one place new
building assets would clearly pay for themselves. It was built:
`clergy_house` 2x2 and `almshouse` 1x3 (temple), `sexton_hut` 1x2,
`mausoleum` 2x2 and `almshouse` (cemetery), `coach_house` 2x2 (noble),
`potting_shed` 1x2 (garden). A cemetery now reads as 10 almshouses, 5 mausolea
and one sexton's hut instead of four buildings or seven row houses.

**Register a new type in all six id-keyed tables or it is a partial ghost.**
`store.ts` objectDefinitions, `TownGenerator.getFootprint`,
`BuildingFactory.FOOTPRINTS`, `Canvas2DRenderer.BUILDING_HEIGHTS` and
`BUILDING_ROOF_STYLE`, and a `DISTRICT_BUILDINGS` entry. Missing one is
silent — a fallback footprint, a fallback 1.8-tile height in the pixel-art
export, a generic tint in the plan. `tools/registry.mjs` checks all of it
statically in a second, including that the THREE footprint tables agree.
Its first run found seven landmark types absent from the export's height and
roof tables, **including the cathedral and the lighthouse** — the two things
the vista arc spent itself making visible down a street, exporting at the
1.8-tile fallback.

**`MAX_PER_DISTRICT` exists because giving a quarter its own small building
immediately overshot into monoculture.** Infill picks the first weighted
candidate that FITS, and the smallest type in a table fits most often, so it
wins by geometry however low its weight: the cemetery came out as 21 identical
sexton's huts out of 28 buildings, reading 100% character because a
quarter-exclusive type is "distinctive" no matter how many you stamp. That is
WALLPAPER at district scale and it is self-gaming, exactly like filling noble
gaps with towers. Set a cap by asking **how many would look wrong**, not how
many a careful person would build — the first table was written as scarcity
(1/10/4/4/3/3) and cost three points of coverage and five of frontage for no
gain over the honest numbers.

**The cap had to be enforced in FOUR places** — the road-edge walk, the row
streak, the fill passes, and Phase C's gap fill — and three of them were
found only because the measured count still exceeded its cap afterwards. A
gate enforced in three of four paths is not enforced, and the way to know is
to re-measure, not to reason about which paths you covered.

### THE EIGHTEEN MISSING POINTS — found, and it was ONE COMMIT

District character was recorded at 55%, drifted unwatched through the river
arc, and read 36%. Bisecting it — HEAD's `districts.mjs` against each commit's
`src/`, so the tool could not be the variable — put the whole drop in a single
step and every commit after it flat:

    627824c  55%      554c62e  37%
    b6d9f66  55%      d6817bc  37%
    4e4afbf  38%  <-- 07cb93d  37%
    fc782d6  40%      4aaffc4  36%

**It was not accumulated drift and it was not the height map.** `4e4afbf`
turned the river into a connected Dijkstra channel, and the district typer
asked `hasNearbyWater(radius 6)` — *any* wet tile in a 13x13 box. That
predicate was written when water was sparse noise blobs. Against a channel
that crosses the map it answers yes almost everywhere, and `harbor` sat in the
random bag besides, so **every town came out with BOTH a harbor and a
waterfront, together half of all its buildings, sharing six of their ten
building types.** A distinction with no difference, occupying the land the
ordinary quarters used to have.

Three lessons, and the middle one is the general form:

- **A PREDICATE that stops discriminating fails silently; a QUANTITY does
  not.** `countNearbyWater` replaces it. Harbour needs 34+ wet tiles in the
  box (harbourage you could moor in) and waterfront 8+, they are mutually
  exclusive, and neither is in the random pool any more — a water quarter is
  earned by the SITE, which is CITYPLAN's derive-don't-decorate rule applied
  to the one pass that was still drawing from a bag.
- **A uniform pick over "every type not used yet" has no notion of ordinary.**
  A town was exactly as likely to grow a cemetery as somewhere to live, and
  two seeds in three had no residential quarter at all. `DISTRICT_POOL` is
  weighted now: residential 10, artisan 6, noble/temple 4, the rest 2-3.
- **Run the battery for the system you are NOT working on.** Nothing in the
  river arc was wrong; the metric for a neighbouring system was simply never
  re-run, and one commit's side effect had eight commits to hide in. It is
  cheap to catch while it is one commit wide and expensive afterwards.

### SLUM AND RESIDENTIAL WERE THE SAME DEFECT ONE LEVEL DOWN

With the pool fixed, seed 4242 grew an 87-building slum reading **7%
distinctive** — and it was right to. Every entry in the slum table was also a
residential entry: two labels on one vocabulary, exactly like harbor and
waterfront. The fix is the pattern that has now worked five times
(potting_shed, sexton_hut, coach_house, net_loft, weigh_house): **give the
quarter a SMALL exclusive type, because a type's real odds are its weight
times how often it fits and only a 1x2 fits often.**

`tenement` (1x2) and `lean_to` (1x2). What separates a slum from a housing
street is not its plan, it is DENSITY on the same plot — a tenement stacks
lodgings where a row house has one household, and a lean-to is the shed
somebody ended up living in. Tall-and-narrow beside low-and-flat is a
silhouette no other quarter has. Slum 7% -> 67%, and seed 4242's residential
quarter went 13% -> 46% as a side effect, because the types stopped being
shared.

**Both got their own massing rather than a new name on the same box.** The
tenement deliberately does NOT use `tmplTallTowerHouse` — that insets to a
freestanding square and throws away the party wall, and a tenement is a
terraced block whose whole difference is that it goes up. `tmplLeanTo` is a
stepped pair of flat boxes because there is no mono-pitch primitive and a
gable would make it a cottage.

    district character   44% -> 53%   (pool fix alone 44 -> 41; the drop was
                                       the metric counting a correct
                                       residential quarter as a failure)

### THE HONEST LEDGER FOR THE DISTRICT ARC

| metric | before | after | note |
|---|---|---|---|
| district character | 26% | **55%** | the point of the exercise |
| built coverage | 50% | 48% | 2 under the 50-70% band |
| achievable frontage | 82% | 77% | |
| **street width** | **12m** | **15m** | **worse; target is 4-10m** |
| party walls | 93% | 93% | |

**Those figures all counted the town WALL as buildings.** `urbanform.mjs` read
every structure-layer object into one occupancy map, and ~47 `stone_wall` /
`crenellated_wall` segments per town went in with the houses — inflating built
coverage by five points and, worse, party walls, because a ring of wall
segments is a hundred mutual "neighbours" and not one of them is a terrace.
Split into buildings and barriers, the same towns read **coverage 43%, party
walls 89%, achievable frontage 74%**, with boundary walls reported on their own
line. A barrier still counts as fronting a street — a churchyard wall really
does define the street edge, which is the whole Sitte argument for building
one — but it is not a building and must not be counted as one.

The street-width regression is the one to take seriously — DESIGN.md calls it
the single number separating a town from a field. It is a consequence, not a
bug: quarters that legitimately want low density now have it, and a sparser
quarter puts its facades further apart. **The architectural answer is that a
cathedral close, a graveyard and a garden quarter are not defined by building
walls at all — they are defined by a BOUNDARY WALL.** `stone_wall` and
`iron_fence` already exist as objects. Enclosing sparse quarters rather than
building them up is the next move, and it would raise enclosure without
undoing any of the character work.

### THE QUAY WALL — the town builds its own river edge

Reported: "the slope may work on the outskirts, but when it gets into the city
I expect it to be built out like the rest of the town." Correct, and it is the
precinct-wall argument again: a graded earth bank is RURAL, and a town makes a
hard edge — Paris quais, Amsterdam grachten, York staithes.

`carveRiverBed` grades every bank identically because at step 3 there is no
town yet to know about. `buildQuayWalls` runs after the street network, which
is the first moment anything knows where the town reached: `carveQuays` marks
quay tiles into `roadMap`, so a road tile touching water IS the urban bank and
everything else keeps its slope. It levels the quay top to waterline + 0.8 raw
(~1.45m) along the whole run and leaves the drop sharp, because a wall needs a
FLAT top and NOTHING between the top and the bed. Measure it from the
waterline, not the existing ground, or the parapet follows the hill behind it.

The hard edge is also what made three assets possible — you cannot cut steps
into mud: `water_steps` down the wall, `mooring_ring` (dressWaterfront had
been tying boats to a HORSE POST), and `pier` / `dock` as jetties, both of
which had finished geometry and had never been placed.

### THE PRECINCT WALL — done, and what it is honestly worth

`precinct_wall` / `precinct_wall_v` (1x1, low, 1.45m with a coping) now run
along the road frontage of cemetery, temple and garden quarters, gapped every
seventh tile for a gateway and skipped wherever a street passes through.
~25 segments a town; boundary-wall frontage 2% -> 5%.

**Street width did NOT move, and that is correct.** A 1.45m wall you can see
over does not enclose a street the way a 9m facade does, and counting it as a
facade would be gaming the metric. What the wall buys is Lynch's EDGE — the
quarter reads as a bounded place — and a continuous street line where the
sparse quarter's buildings leave gaps. Grade it on the boundary-wall frontage
line, not on street width.

Three things it had to get right, each one a trap the repo had already
documented:

- **Ask `isCirculation(terrain)`, never `roadMap`.** `carveAlleys` paints tile
  9 straight into terrainTiles without registering it, and it runs before this
  pass. Testing roadMap put a precinct wall in the street on seed 4242 in the
  first run — the same bug CLAUDE.md already records putting a town wall
  across an alley.
- **A barrier must not count as a building.** These carry `district` so the
  renderer can pick their stone by quarter, and that alone dropped district
  character two points, because a wall is in no DISTRICT_BUILDINGS table and
  so read as "not distinctive to its own quarter". `districts.mjs` filters by
  category now, as `urbanform.mjs` already does.
- **The export tables are keyed by id for every STRUCTURE, not every
  building.** A wall missing from `BUILDING_HEIGHTS` exports at the 1.8-tile
  fallback: 5.4m. The town wall got away with it by luck at 6.5m real; a 1.45m
  precinct wall would have been a two-storey slab. `tools/registry.mjs` now
  scopes that check by `BuildingFactory.FOOTPRINTS` — the actual list of what
  the building draw path handles — rather than by the category name, which
  found `aqueduct` missing too.

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

0. **Real hardware: MEASURED, and it is fine.** A phone screenshot reports
   **106 FPS at 998 draws** at dusk. That closes the question this item has
   been asking since the tile rescale. Draw calls have gone 202 -> 998 across
   the whole arc and the frame rate did not care, so stop treating the draw
   count as the budget — `tools/budget.mjs` and its texture-MB line are the
   number to watch on a phone, not draws. Note the SwiftShader figures in
   agent screenshots (3-5 FPS) are ~30x pessimistic and mean nothing.
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
- **`npm run typecheck` was checking ZERO FILES and is fixed.** `tsconfig.json`
  is a solution file — `"files": []` plus two project references — and plain
  `tsc --noEmit` on one of those compiles nothing and exits 0. The gate this
  file has told every session "must be green before commit" had never once
  looked at a source file. The script is `tsc -b --force` now, and the first
  real run turned up **eleven errors**, three of them pre-existing: a
  `VolumeRole` union missing `'trim'` while three templates emitted it, three
  `LanternStringsResult` early returns missing a field added later, an
  `EditorViewport` cache typed as `ReturnType<its own getter>`, and a
  `createFacadeConfig` with NO CALLERS that predated `wallH` joining
  `FacadeConfig`. `tsconfig.node.json` also had `rootDir: src/main` while
  including `src/preload`, so that project could not build at all.
  **A green gate that has never failed is not evidence; it is an untested
  instrument.** Feed a check a known-bad input once and watch it go red.
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
- `node tools/rivershot.mjs [seed] [--time=]` — **stand on the bank and LOOK.**
  river.mjs measures the channel; this photographs it, and both are needed:
  the carve measured a healthy bank and the phone came back with a picture of
  a gorge. It picks a standable vantage with clear ground between it and the
  water, because flyTo does not test occupancy and a naive camera lands inside
  a building.
- `node tools/river.mjs [seeds...]` — **is the river a river, or blue paint on
  the floor?** Bank relief (how far the water sits BELOW the land beside it),
  descent from source to mouth, width profile, how many separate bodies of
  water, and crossings. `site.mjs` asks whether the TOWN acknowledges the
  water; this asks whether the water is water. **Read bank relief first** —
  with no channel cut into the height map the water is a translucent quad
  lying flat on the ground and nothing else matters. It also prints the map's
  whole height range beside the river's, because a relief of 0.00 can mean "no
  channel" or "the tool is reading nulls", and those want opposite fixes.
- `node tools/registry.mjs` — **is a building type actually WIRED IN?** A new
  type must be registered in SIX id-keyed tables and missing one is silent:
  a fallback footprint, a 1.8-tile height in the pixel-art export, a generic
  plan tint. Also checks the THREE footprint tables agree — a disagreement
  is the bell_tower_tall bug (reserved 2x2, drawn 3x3, clipped its
  neighbours) and it was found by eye last time. Static parse, no Electron,
  one second. Run it after adding or renaming any building type.
- `node tools/features.mjs [seeds...]` — **a census of every gated piece of
  street dressing**, with its rate and its SPREAD across districts. Catches
  the two silent failures: a GHOST that is gated into nonexistence, and
  WALLPAPER that fires everywhere equally and so tells the player nothing.
  Run it after touching any dressing gate. Read the caveat it prints — a
  feature correctly confined to a rare type looks identical to a ghost.
- `node tools/relief.mjs [seeds...]` — **the shape of the ground you walk on,
  and where the steep bits are.** Three readings: a CROSS-SECTION of the river
  corridor (height above the local waterline against distance from water,
  from a BFS so there is no transect axis to get wrong), the WALKABLE GRADE
  distribution under every street tile, and an ATTRIBUTION splitting steep
  ground into at-the-river versus inland. `river.mjs` measures the CHANNEL and
  could never see this: it reads the one tile between water and land, and a
  ravine is a cross-section. Names the worst tiles by coordinate so you can go
  and stand on one.
- `node tools/propscale.mjs [seeds...]` — **every prop's real size in metres
  against what that thing measures in the world.** humanscale.mjs does this
  for buildings and has caught three scale bugs; nothing did it for props, and
  the gap had a live defect in it — boulders 2.7m across and rowboats 5.3m
  long by 39cm tall. Measured from the EMITTED GEOMETRY (PropFactory brackets
  each object and asks the batcher for its world AABB), so it grades what is
  on screen. **Read the caveat about its own targets**: three of them were
  wrong on the first run, every one written from the ID rather than from the
  object, and the geometry was right each time.
- `xvfb-run -a node tools/touch.mjs [--device=pixel|pixel-land|tablet]` —
  **can you work the app with a FINGER?** Every other harness drives it with
  a mouse; `webshot.mjs` sets `hasTouch` and then CLICKS things, which is a
  mouse gesture wearing a touch flag, so no drag or pinch had ever been
  exercised. That blind spot hid the plainest defect in the app: the 2D plan
  could not be panned at all on a phone. Grades gestures against the
  viewport's own pan/zoom via `window.__pt.editorView()` and keeps the
  screenshots as evidence — the first cut diffed PIXELS and failed its own
  "a tap must not pan" check, because a tap draws a selection highlight.
- `node tools/seam.mjs [seeds...] [--shoot]` — **what is standing where you
  cross into another quarter.** Lynch's DISTRICT edge, the Imagineering
  cross-dissolve, Cullen's closure. **Reads 90% marked over 30 crossings on 8
  seeds, which REFUTES CITYPLAN's long-standing "the seam is unbuilt" — do not
  build a cross-dissolve pass for it.** Read its sample-size note first: there
  are only 3-5 crossings a town, because a boundary running ALONG a street
  yields one pair per tile while one CROSSING it yields one pair in total. Two
  corrections were needed before its number was honest, both on the record in
  the file, and `--shoot` photographs the crossings because `bend` carries a
  third of the pass rate and no number can settle a claim about what is
  visible.
- `node tools/quarters.mjs [seeds...]` — **which districts a town gets at all,
  and how big each one is.** districts.mjs grades a quarter from inside;
  nothing asked the prior question. That gap hid a real defect for the length
  of the river arc — two seeds in three had NO residential quarter, because
  the type was drawn uniformly from every unused type, so a town was as likely
  to grow a cemetery as somewhere to live. Also prints the wet-tile histogram
  behind the water-quarter thresholds, which are the only numbers in
  `generateDistricts` that cannot be derived.
- `node tools/asset.mjs <defId> [seed] [--n=3] [--time=]` — **photograph ONE
  building type where it actually stands, with the subject outlined.** There
  was no way to look at a single type: adding a building meant running
  walkshots and hoping one of five fixed vantages contained it, which for
  something that is 3% of the town it does not. Two things it has to do and
  neither is the camera: pick a STANDABLE vantage (flyTo does not test
  occupancy — the same trap rivershot.mjs documents), and frame by an exact
  test rather than a standoff guess. A fixed standoff shot a 1x2 lean-to as a
  30px smudge at four tiles and then a tenement's front door at two; how far
  back you must stand is decided by HEIGHT, which only the built scene knows,
  so it walks out until the projected footprint box fits. The magenta outline
  is not decoration — two rounds went on guessing which box in the frame was
  the subject. Both halves are `tools/lib/vantage.mjs` now.
- `node tools/eyeball.mjs [seed] [--views=N]` — **what FILLS a street view.**
  Selection by SCREEN PRESENCE rather than by data anomaly, which is the one
  thing every other tool here gets backwards: they pick a subject by z-score,
  crop to it and box it, so the big obvious thing in the frame is never the
  subject. Raycasts a grid over the whole frame at eye level and attributes
  every sample to the structure it hit. Also reports the ROOF-TO-WALL ratio,
  which nothing else asks and which is the largest visible defect in the town
  (p90 199%). Read its note about apex vs wall height before quoting a storey
  count.
- `node tools/clash.mjs [seed] [--shots=N] [--all]` — **does the built geometry
  collide with itself, and does it stand on the ground?** The third axis:
  provenance grades a thing against the code, odd against its peers, and this
  against its NEIGHBOURS. Exact AABB tests over the built solids. Reads ~100
  interpenetrations deeper than 0.5m a town, up to 1.9m — invisible to
  `audit.mjs`, which checks tile footprints, because two buildings can own
  disjoint tiles and still share space. Measures DEPTH not area, or every
  party wall in a 93%-terraced town would read as a collision.
- `node tools/provenance.mjs [seed] [--all] [--def=]` — **is the geometry in
  the world the geometry the code asked for?** The only audit here that grades
  the pipeline against its own declarations rather than against a model or a
  hand-written target, so it has no opinion to be wrong about. Snapshots the
  volume array at every massing stage and diffs consecutive snapshots, so it
  names the PASS that moved a dimension, not just that it moved. Also checks
  the one hard invariant — that nothing ends up outside footprint +
  MAX_OVERHANG — which a size table cannot see, because a pass that grows a
  volume about its centre leaves the offset alone. Run it after touching any
  massing template, clamp or repair pass.
- `tools/lib/vantage.mjs` — **not a tool, the camera every tool should use.**
  `lookAt(win, box)` raycasts candidate vantages against the real scene and
  flies to the first with a clear line to the subject, returning where the
  subject landed on screen; `cropTo` crops the capture to it with a floor size;
  `markSubject` outlines it; `hideChrome` removes the HUD. Reach for this
  instead of hand-placing a camera — five tools had each hand-rolled "find a
  spot to stand" out of the tile map and every one of them had stood inside a
  building. Its failures are informative: it names the mesh in the way.
  `structureBox(id)` on the debug bridge gives you the box to pass it.
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
- `node tools/odd.mjs [seed] [--shots=N] [--props] [--all]` — **rank
  everything by how UNLIKE its peers it is, then photograph the worst.** Every
  other tool here answers a question somebody already knew to ask, which is why
  every defect had to be reported from a phone first; a person looking at a
  screenshot is not running twenty-five checks, they are noticing an OUTLIER.
  No targets and no thresholds: each structure and prop becomes a feature
  vector and is scored in robust deviations (median + MAD — with mean and sigma
  a 61m tower inflates the spread enough to hide itself) against its own
  definitionId, falling back to the whole town when a type has under 5 peers.
  Then `lookAt` frames the worst, `subjectPixels` measures ONLY the subject's
  pixels via a raycast mask, and a CONTROL pass measures ordinary buildings so
  the pixel verdict is relative to this town rather than to a number I made up.
  **Read its two stated blind spots**: it cannot see a defect the whole
  population shares (that is provenance.mjs — the world against the CODE), and
  an outlier is suspicion, not a verdict, because a cathedral is supposed to be
  odd. The pair is the point: provenance catches uniform wrongness, odd catches
  individual wrongness.
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

## A BENCH WAS BEING BUILT AS A NINE-METRE HOUSE

`humanscale.mjs --by-type` surfaced it and only because it reports by TYPE.
The aggregate spread looked like ordinary variation; a line reading
`bench ... wallH 9.5` cannot be anything but a bug.

`placeLandmarks` dresses what it places — a bench in front of the clock tower,
a barrel stack and hanging sign beside the tavern, a statue on the plaza — and
pushed all of it into `landmarks`, which flows into `anchors` and out into the
STRUCTURE layer. BuildingFactory draws that layer, so each of those props came
out as a building with walls, windows and a roof. **Three to eight a town:
rare enough never to be the subject of a screenshot, common enough to be in
most of them.**

**This wants to be an invariant enforced once at the end, like the buried-prop
and water-tile rules, and it is not.** That test needs each object's CATEGORY;
the categories live in store.ts; store.ts imports the generator registry, so
the generator cannot read them without an import cycle. The pass that creates
the dressing is the only place that knows what it is, so it returns
`{ landmarks, dressing }` and the caller files each in the right layer. If the
definitions ever move to a neutral module, make this the invariant.

### AND THE TOWER-HOUSE TEMPLATE SKIPPED THE CAP ITS FIVE SIBLINGS USE

The same by-type reading showed `coach_house` at 37.5m and `row_house` at
24.9m — an outbuilding and a terrace at tower-block height. The landmark
promotion hands **28% of ALL buildings** a dramatic template regardless of
type, and `tmplTallTowerHouse` computed `wallH * 2.2` with no ceiling while
`tmplStackedTower`, `tmplCornerTower`, `tmplSpireEnd`, `tmplCircularTower` and
`tmplCrossPlan` all run theirs through `towerHeightFor`, which caps against
MAX_TOWER_ASPECT. One of six paths missing the gate. **A bug in a gate is a
bug in a PATTERN — grep the siblings.** coach_house 37.5 -> 19.2m, row_house
24.9 -> 16.9m.

Its `floors: round(tallH / 1.05)` also still carried the pre-rescale divisor.
`volumeFloors` guards against the nonsense so nothing drew wrong, but the
count goes into `scaleSamples`, and a diagnostic reporting a THIRTEEN-STOREY
BAKERY sends the next person after the wrong bug. **A dead number in a
diagnostic is not harmless.**

### AND THE "WASHED-OUT NOON OVERVIEW" WAS NOT REAL

Reported by me from a screenshot and measured afterwards: mean luma 0.306,
**0% of pixels above 0.80, 0% above 0.95.** Nothing is clipping. What the eye
read as blown out is the known ground-colour finding — 60% of the map in one
warm pale colour family — which `streets.mjs` already reports and CLAUDE.md
already files as an art-direction call. The lesson is the one propscale.mjs
learned about its own targets, pointed at an eyeball report instead:
**when a claim you made disagrees with a measurement, suspect the claim.**

## RUN THE BATTERY — tools/harness.mjs

**Start here.** `node tools/harness.mjs` runs the gates and the tracked metrics,
diffs them against `tools/harness-baseline.json`, and exits non-zero on a gate
failure, a regression outside the metric's noise band, or an extractor that
could not parse its tool. `--save` records the current readings; `--quick`
skips everything needing Electron; `--only=audit,odd` narrows it.

Twenty-eight instruments and no way to run them was not a cosmetic problem — it
is the most expensive failure this project has had. District character was
recorded at 55%, nothing re-ran the town battery for the whole river arc, and
it read 36% by the end: eighteen points to one commit's side effect, found only
by bisecting HEAD's tool against every commit's source. **A pile of instruments
with no dashboard is a pile of instruments you will stop reading.**

Two things it has to get right, both already on the record here:

- **A check that cannot parse its tool FAILS.** Extractors are regexes over
  another program's stdout and they rot. A silently-skipped metric is a green
  board that has never looked at anything — exactly what `npm run typecheck`
  did for months while compiling zero files.
- **A noise band, not an exact match.** Generation is not bit-identical between
  runs on the same seed, so demanding equality would cry wolf until nobody read
  it. Each metric declares how much movement is nothing, and `dir: 0` means
  tracked but never failed on, because "is 47% coverage better than 45%" is an
  argument and not a fact.

Both failure paths were tested by breaking them on purpose and watching the
board go red before it was trusted — feed a check a known-bad input once.

### AND IT MEASURED ITS OWN NOISE FLOOR, WHICH IS WHERE THE FIRST FINDING CAME FROM

`--repeat=3` runs each check three times on identical seeds and prints the
spread, because a band picked by eye either cries wolf or swallows a real
regression and there is no way to know which.

    districts   character        49, 49, 49     spread 0
    provenance  outsideBox        0,  0,  0     spread 0
    provenance  habitablePinned  11, 11, 11     spread 0
    provenance  doubled          18, 16, 18     spread 2
    roofcheck   openTops         14, 13, 16     spread 3
    odd         overZ3           39, 48, 41     spread 9
    odd         bareWall         28, 40, 31     spread 12

**`districts` reads the MAP and is perfectly stable, so the generator is
deterministic; everything that moves reads the BUILT SCENE.** Two causes, and
only one of them was a bug:

- **Every tool waited a GUESSED number of milliseconds for the 3D view** —
  `waitForTimeout(2800)`, a number somebody wrote once. On a slow run under
  SwiftShader that measures a partially built town and reports it with
  complete confidence, which is the sample-count lesson wearing a stopwatch.
  `tools/lib/scene.mjs` polls until the built count stops changing AND matches
  what the map contains, and throws with both numbers if it never settles.
  That took `habitablePinned` to spread 0. **Retrofit it into any tool that
  reads the built scene.**
- **The rest is structural and not a defect.** `overZ3`, `bareWall` and
  `spireAtCap` are COUNTS OVER A THRESHOLD whose scale (median + MAD) is
  computed from the same population, so a small shift moves a cluster of items
  across the line together. Those get wide bands and are not gates; the SHAPE
  of such a finding is what matters (spire 96% -> single digits), never the
  exact count.

**A metric nobody has run twice has an unknown noise floor, and every A/B ever
taken against it inherited that.** Run `--repeat` before believing a delta.

## THE PERCEPTION HARNESS — provenance + odd + vantage, and why it is three tools

Asked to make the correctness harness strong enough that we stop having
conversations where something is obviously wrong to a person and I cannot see
it. The honest decomposition is that there were three separate failures and
they need three separate instruments; any one alone leaves a hole the other
two cover.

| failure | instrument | what it can see |
|---|---|---|
| the world does not match the CODE | `provenance.mjs` | uniform wrongness — every bridge a roofed pavilion |
| one thing does not match its PEERS | `odd.mjs` | individual wrongness — the 29m untextured mill |
| I cannot get a readable picture | `lib/vantage.mjs` | the verdict, once a number says "look here" |

**The generative insight is that every audit in this repo answers a question
somebody already knew to ask.** Twenty-five tools, each a checklist item. A
person does not run a checklist on a screenshot; they notice the thing that
does not fit. So `odd.mjs` computes a feature vector per structure and per prop
straight off the BUILT scene and scores each against its own population —
robust deviations, median and MAD, because with mean and sigma a single 61m
tower inflates the spread enough to hide itself. Against the same
`definitionId` where a type has five peers, against the whole town where it
does not: a cathedral being unlike a row house is not news.

Four design points, each of which was wrong in the first cut:

- **A hand-written threshold is the propscale mistake again.** Grading an
  outlier's pixels against `edges < 0.10` is a target I invented, and my
  targets have been wrong three times out of three. So the tool measures SIX
  ORDINARY buildings first and reports the numbers an unremarkable building in
  *this* town produces. That is the control and the noise floor in one.
- **The pixel mask has to be exact.** The first version measured the whole
  projected box and called a windmill with 554m² of bare wall "detailed",
  because the box also held sky, a street and four neighbours. `subjectPixels`
  raycasts a grid and keeps only samples whose first hit is inside the
  subject's own AABB — the numerator and denominator finally count the same
  population.
- **The camera has to prefer eye level.** `lookAt` took the NEAREST workable
  vantage, which for a hemmed-in terrace is 28m up looking down, and a shot
  from above cannot show you a wall. `order: 'height'` exhausts every distance
  at eye level first.
- **A fixed standoff refuses a cathedral.** Distances scale with the subject's
  diagonal now; "unoccluded candidates were too close" is the thirty-pixels
  failure wearing its opposite face.

### WHAT A FULL SWEEP ACTUALLY FOUND — including three bugs in the harness

Run across two seeds with photographs, the honest ledger is short, and that is
itself the result. **The pixel pass CLEARS most outliers**, which is what a
suspicion-ranker is supposed to do: lean-to slenderness, staircase footprint,
tall row houses and every one of the sixteen "floating" props read in line.
The only confirmed visual discrepancies are the CATHEDRAL at 0.26x the detail
density of an ordinary building — a 42m plain grey box — and the MILL at 0.40x
with 0 of 3 volumes textured.

Three defects were in the instrument, and all three are the same shape as
defects it was built to catch:

- **The camera framed a 16cm shop sign EDGE-ON**, correctly and unoccludedly,
  and the photograph could not answer the question it was taken to answer.
  `lookAt` took the first clear bearing; `pick: 'largest'` finishes the tier and
  keeps the broadest view.
- **z alone ranks by which population has the smallest spread.** `lean_to`
  heights cluster so tightly that 6.4m against a median of 3.8m scored z=85,
  while a 50m tower against a 29m median — the same 1.7x — scored 8.8 and sat
  eleven rows below it. A ratio gate is now required as well as a high z:
  statistically unusual and physically identical is provenance.mjs's
  department, not this one.
- **`--feature=` silently killed the CONTROL.** It filtered the ranking before
  the control sampled ordinary items from it, so the baseline vanished and
  every verdict fell back to the string "in line with an ordinary building" —
  a missing measurement reading as a pass, which is the exact failure the
  control exists to prevent. It samples the unfiltered ranking now and says
  NO CONTROL when it has none.

First run found a CLASS rather than an instance, which is the whole point:
**38 structures a town carry 40-105m² of bare untextured wall while their peer
median is zero** — legal in every dimension, invisible to every geometry audit,
and to a person a grey slab. The tool tallies how many things share a top
feature precisely so a class cannot be mistaken for an instance.

### MISSING THE TREES FOR THE FOREST — tools/eyeball.mjs

Told, correctly, that something is often obviously wrong in a screenshot while
I am hyper-focused on something else. It is structural, and it is built into
the harness I made:

**Every tool selects a subject by DATA ANOMALY, crops tightly to it, and draws
a magenta box round it.** Three mechanisms all aiming my attention at the thing
the number already cared about, and `subjectPixels` masks the rest of the frame
away on purpose. So I read each picture to confirm or deny ONE hypothesis. I
photographed a 1.52m interpenetration and reported it while three of the five
buildings in the same frame were thirty-metre slabs.

`eyeball.mjs` inverts the selection: stand at eye level in a street, raycast a
grid over the WHOLE frame, attribute every sample to the structure it hit, and
report what FILLS THE VIEW whatever the audits think of it. Then aggregate —
one tall thing in one frame is a building, the same type dominating six of
eight street views is what the town looks like.

**AND MY FIRST FINDING FROM IT WAS WRONG, WHICH IS THE OTHER HALF OF THE
LESSON.** I reported "69% of ordinary dwellings are over four storeys" and it
was my own metric: I divided APEX height by a storey, so every roof pitch was
counted as extra floors. Wall height is median 7.5m — 2.6 storeys, p90 4.3.
The storey count was fine all along. Being told I miss the obvious is not a
licence to overstate the first thing I finally notice.

The real finding was in the gap between those two numbers — median wall 7.5m
against median apex 13.5m:

    ROOF as a fraction of the WALL it sits on
      p10 31%   med 62%   p90 199%   max 413%
      33% of dwellings have a roof nearly as tall as the house or taller

A real gable on a two- or three-storey house rises 30-50% of its wall. One
dwelling in ten here carries a roof TWICE the height of the building under it,
and at dusk that is a black triangle with a cottage beneath it — which is what
every street screenshot has been showing for the entire session.

**No prior tool asked this.** `humanscale` grades a storey, a door and a
window. `roofcheck` asks whether a roof EXISTS. `provenance` asks whether the
rise obeys its own cap — and the cap is against the volume's SPAN, so a wide
building is permitted an enormous roof no matter how short its walls are. Every
part is individually legal and the proportion is nobody's job. It is now.

Note honestly that the spire/pointed work earlier in this same session made
part of this worse: `riseForSpan` derives those rises from the span and
`MAX_ROOF_SPAN_RATIO.spire` went 3.0 -> 3.8, and neither change ever checked
the result against the wall.

### AND THE ONE MEASURE WITH NO CONTROL — ABSOLUTE TONE

Every pixel number in this harness is RELATIVE. `odd` grades a building
against its peers; `subjectPixels` grades a subject against six ordinary
buildings. Both are blind by construction to the case where the WHOLE TOWN is
wrong in the same direction, and that is the case: at NOON, over five street
views,

    surface   p10    med    p90   reads black
    sky       0.233  0.256  0.432    0%
    ground    0.376  0.646  0.676    1%
    wall      0.016  0.087  0.214   25%
    roof      0.014  0.061  0.148   47%

**The ground is seven times brighter than the walls standing on it, and half
of all roof pixels are effectively black at midday.** Mid-grey is 0.22; a
sunlit pale wall is 0.45-0.7. That single fact has been contaminating every
pixel measurement in this session — the cathedral reading 0.26x detail, the
mill reading blank, the bridge reading as a slab. You cannot see detail in
black.

**And the day/night A/B cleared the light rig, which I nearly blamed.** At
09:00 the ground HALVES (0.646 -> 0.327) and the walls RISE (0.087 -> 0.132),
which is exactly what a lower sun should do to a horizontal and a vertical
surface. Sun 1.2 / ambient 0.42 / hemi 0.52 are all behaving. What is left is
absolute: even with a low sun favouring them, walls sit at 0.13 against a real
0.45+, and roofs get WORSE at 09:00 (0.029, 66% black) because a low sun leaves
a steep pitch in shade.

So the roof finding above and this one are the same defect seen twice: the
roofs are enormous AND they are black. That is the black-triangle silhouette in
every street screenshot, measured two independent ways.

`tools/eyeball.mjs` reports tone by surface class, split by raycast — sky,
roof, wall, ground — because the aggregate hides it: a frame that is 40%
brilliant paving and 40% black wall has a perfectly reasonable mean.

### THE THIRD AXIS — a thing against its NEIGHBOURS (tools/clash.mjs)

provenance grades a thing against the CODE and odd grades it against its PEERS.
Neither can see a thing in relation to what stands next to it, and two very
visible families live exactly there.

**Interpenetration: ~100 pairs a town overlap by more than 0.5m, worst 1.9m.**
`audit.mjs` checks FOOTPRINTS, and a footprint invariant is not a geometry
invariant: two buildings can own disjoint tiles and still share space, because
a volume may legally overhang its footprint by MAX_OVERHANG and two neighbours
may both do it toward each other. That is "buildings colliding", reported from
the device long ago and never once measured. The test is depth, not area — a
terrace SHARES a party wall by design and 93% of this town does, so grading
contact would condemn the thing the urban-form arc achieved. Two houses sharing
a 6m wall overlap hugely in area and by 3cm in depth; a wing driven through a
neighbour overlaps a small area and a metre deep, and only `min(overlapX,
overlapZ)` tells them apart.

**And the ground-contact half REFUTED ITSELF, twice, which is the more useful
result.** It first read "32 structures standing on air" and the very first
photograph showed a stone plinth filling the gap: BuildingFactory emits a
stair-step FOUNDATION of per-tile columns that is not in `massing.volumes`, and
a building is deliberately placed at the HIGHEST corner of its footprint, so on
any slope the massing bottom is above the ground BY CONSTRUCTION and the plinth
exists to close it. Then the fix was wrong too — a raycast down from under the
volume read 0 plinthed, because it starts INSIDE the plinth and the batched
material is FrontSide, so every face of the solid it is standing in is
back-facing and unhittable. Recording the plinth's boxes where they are emitted
settled it: 16 of 33 are plinthed, and the residual is a volume OVERHANGING its
footprint, since the plinth only spans footprint tiles.

**Two false positives in one afternoon, both caught by looking.** A new
instrument's first numbers should be treated as a hypothesis, not a finding.

## THE ROOT CAUSE OF NOT BEING ABLE TO TELL — tools/provenance.mjs

Told the bridges were STILL comically wrong after two rounds of me reporting
them fixed, and asked to solve the root cause rather than the instance. This
is it, and it is not perception.

**Every audit in this repo grades a MODEL.** `audit.mjs` grades footprints and
tile ids. `tenancy.mjs` grades adjacency. `propscale.mjs` grades built bounds
against a target table written BY HAND from the id — wrong three times out of
three. `humanscale.mjs` grades against what a real door measures. Not one of
them asks the question that contains no judgement at all:

> **is the geometry in the world the geometry the code asked for?**

The templates declare their intent in metres, in the source. Nine passes then
run over those numbers — two flat-top roof repairs, an overhang clip, a
z-fight nudge, the habitable minimum in THREE places, wealthScale, two roof
clamps — and nothing recorded that any of them had fired, let alone which.
`tools/provenance.mjs` snapshots the volume array at every named stage and
diffs consecutive snapshots, so attribution is exact rather than inferred.
There is no target table to get wrong and no picture to misread.

First run, and this is the finding that matters more than any single bug:

    stage             volumes moved      mean move   worst
    minHabitable       135 / 847    16%     x1.5      x2.0
    overhangClip        15 / 847     2%     x2.9      x6.2
    roofClamp          155 / 847    18%     x1.5      x2.6
    wealthScale        543 / 847    64%     x1.1      x2.7

**Three "repair" passes are rewriting a third of the town's geometry by about
a factor of two.** They were written as backstops for outliers. They are the
dominant sizing rule, and the templates — the only place that knows what a
thing IS — are being overruled without anyone being told.

### AND A CLAMP THAT IS NOT LAST IS NOT A CLAMP

39 volumes a town ended up outside the footprint + `MAX_OVERHANG` box the
overhang clip exists to enforce, up to **1.5m proud**, every one of them a
`wing`. Ordinary row houses with a room-sized lump projecting into the street.

The clip ran BEFORE the habitable minimum. The minimum grows a volume about
its own centre and never touches the offset, so `tmplSideBay`'s **0.7m
projecting bay window** — pinned 0.35m proud of the wall, as a bay window is —
came out 2.6m deep and reaching 1.55m into the street.

Nothing caught it for three reasons, all of them instructive:

- **`overhangClamps` counts the clip FIRING, not the final state.** A counter
  on a repair tells you the repair ran; it cannot tell you the repair held.
- **The comment above the minimum argued it was safe** because it bounds the
  SIZE by footprint + MAX_OVERHANG. True only for a volume centred on the
  origin, which an attached one never is. A comment is not a test.
- **`slivers.mjs` was lying** — see below.

Fixed by ordering (`clipToFootprint` is now one exported function, called last
in `pickMassing` AND again in BuildingFactory after wealthScale, which scales
offsets and so walks an edge volume straight back out) and by declaration
(`tmplSideBay`'s bay and the windmill's 16cm SAILS are `habitable: false` —
a physical declaration, same argument as PropFactory's `physical(m, span)`).
**39 volumes outside the box -> 0.**

### AND EVERY SPIRE IN TOWN WAS EXACTLY 3.0x ITS SPAN

The general form of the MIN_HABITABLE_W finding, and `provenance.mjs` now has
a census for it: **a clamp that most of a population sits EXACTLY on is not a
clamp, it is the design.** The template's variation is computed and thrown
away, and no aggregate can see it, because a perfectly uniform value has a
perfectly healthy median.

| style | at the cap, before | after |
|---|---|---|
| spire | **96%** — p10 = med = p90 = **3.00** | 17% — 3.15 / 3.47 / 3.80 |
| pointed | 48% — med 2.16 | 1% — 1.82 / 2.06 / 2.30 |

`roofHeightFor` derives every rise from `wallH`, a VERTICAL quantity, and
`clampRoofHeight` caps against the volume's own width, a HORIZONTAL one. For
the shallow styles the two land in the same range and the cap catches a tail.
For the tall ones the ask is always 2-3x what the cap allows, so the cap always
won and there was ONE spire silhouette in a 300-building town. Same shape as
`ensureRoofPitch`, which fixed the opposite failure — a rise too SMALL for a
span that had tripled. `riseForSpan` asks in the right units; the cap goes back
to being a backstop, and `MAX_ROOF_SPAN_RATIO.spire` moves 3.0 -> 3.8 because a
real Gothic spire runs 5-7x its base and 3.0 was only ever a guard against the
wallH-derived runaway.

Two things it turned up on the way, both already-documented classes:

- **A copy of the cap table in the tool drifted within one session.** The
  source went 3.0 -> 3.8 and `provenance.mjs` kept reporting "100% at the cap"
  against a number that no longer existed, with ratios printed ABOVE its own
  cap. It reads `__pt.roofCaps()` now. Three copies of the terrain table
  taught this once already.
- **My own `clipToFootprint` after wealthScale reintroduced the floating
  finial.** A volume clipped narrower keeps a roof sized for its original
  span; BuildingFactory re-runs `clampRoofHeight` after the clip, which is
  idempotent, so last is safe.

The same census also asks about `MAX_TOWER_ASPECT`, and towers are pinned the
same way — **p90 = 4.0, exactly the cap** — with 5 bodies a town OVER it (max
5.0), for the same reason: the late clip narrows a base whose height was capped
against the old width. Left as recorded rather than chased; a 5-25% overshoot
on five volumes is not visible, and lowering a tower body after its spire's
`bottomY` is fixed would leave the spire in the air.

### AND slivers.mjs HAD BEEN CONFIDENTLY REPORTING PROPS 71 METRES LONG

`PropFactory` never called `setBuildEnvelope`, and `BuildingFactory` set one
per building and never cleared it. So every prop in town was measured against
whatever BUILDING ran last, and `over` came out as the distance across the map
to that building: `buildPropMeshes ... longest=71.35m`, dozens of them. No
such geometry exists — `propscale.mjs` measures the same props at 3.6m at
their largest, and the two tools had been disagreeing by a factor of twenty in
silence.

**A stale global is worse than a missing one.** `recordSliver` already has a
`NO-ENVELOPE:` bucket, written after an earlier version scored unattributed
geometry 0 and returned a confident "nothing found" while beams hung in the
sky. Leftover state walks straight past that guard and produces the opposite
lie with the same confidence. Both factories now clear the envelope at the top
of each iteration and at the end of the function, so anything unbracketed
lands in the honest bucket — which immediately showed **655 building pieces
and 250 lantern pieces that the sliver audit has never graded at all.**

Also worth keeping: the tool's own first metric was `|b-a| / max(a,b)`, which
is bounded above by 1, so a FAIL line of "doubled" was unreachable by
construction — it printed a x16 divergence three lines above a verdict of
"0 failures". **A gate whose verdict cannot fire is not a gate.** Ratios now.

## HOW TO ACTUALLY LOOK AT SOMETHING — tools/lib/vantage.mjs

Asked "is there a way to improve your interpretation of visuals?" after I had
twice graded a 4x2 bridge from a 40-metre skyline and once called a noon
overview washed out without measuring it. The honest diagnosis is that neither
was a perception problem. **Framing was failing, and a failed frame silently
downgrades you to a wide shot and a guess.** Four cameras in a row landed
inside geometry that session; each returned a dark rectangle, and each time I
reasoned about the rectangle instead of fixing the camera.

Three rules, and every camera-placing tool here now goes through them:

- **Raycast the vantage; do not infer it from the tile map.** A free tile says
  nothing about the LINE OF SIGHT, which is why `rivershot`, `asset` and
  `bridgeshot` each independently stood a camera inside a house. `lookAt()`
  casts eye -> subject over the real scene and takes the first candidate that
  is clear. When nothing works it NAMES the mesh in the way, which is a bug
  report rather than a black frame.
- **Aim at the box, not at the centre.** The first cut stopped the ray at 98%
  of the distance to the box's midpoint — but the midpoint is inside the solid,
  so every ray hit the subject itself and the tool reported all six bridges in
  town as occluded by their own parapets. A slab test against the AABB is
  exact and is three lines.
- **Crop to the projected subject, and constrain the BEARING.** A bridge seen
  three-quarters-on down a street is unoccluded, correctly framed and useless.
  `prefer` + `arc` say "broadside from either bank, or tell me you can't".
  And `maxFill` is the lever that matters for anything long and thin: at a
  generous fill the camera satisfies the test from INSIDE the span — 14m from
  an 18m bridge, 79% of frame, one pier at arm's length.

**What it found in its first run is the point.** With a bridge finally on
screen at a readable size, it was obviously a roofed pavilion on a plinth.

### AND role: 'mainBody' WAS CARRYING TWO MEANINGS

`mainBody` means "the principal volume, report it as BuildingTop" AND "this is
a room, so apply the habitability rules". Four templates that are not
buildings used it for the first meaning and silently got the second:

| authored | built |
|---|---|
| 0.22m footbridge trestle | 2.60m block |
| 0.70m bridge pier | 2.60m block, 2.90m tall, with a HIPPED ROOF |
| 1.45m precinct wall | 2.90m tall, roofed — this file said 1.45 for weeks |
| 1.60m curtain wall | 2.60m thick |
| 1.0m merlon (`penthouse`) | 2.6m block at a 1.2m pitch — a solid slab |

`Volume.habitable = false` and a `masonry()` stamp on the four templates. Note
what that did NOT fix: **the habitable minimum exists in THREE places** —
twice in `pickMassing` and once in `BuildingFactory` after wealthScale — and
the BuildingFactory copy is the dominant one because it skips only three roles
and so widened every piece of `trim` as well (a bridge parapet, an 8cm
handrail, a wall's coping). Guarding two of three changed nothing on screen.
A rule applied in two places out of three is not applied, and the only way to
know is to re-measure.

    precinct_wall   wallH 3.3m -> 1.6m
    bridge pier     wallH 2.9m -> 1.8m
    wallW p10 / min 2.60 / 2.60 -> 1.60 / 0.52

The p10 reading is the tell in hindsight: **`MIN_HABITABLE_W` was the p10 AND
the exact minimum of the whole town.** A floor that is also the tenth
percentile is a floor that is doing far more than catching outliers, and
`humanscale.mjs --by-type` had been printing `precinct_wall wallH 3.3` in
plain sight for as long as precinct walls existed.

There is also a **second, near-identical open-flat-top repair pass** in
`pickMassing` with different constants. Both are live, they see different
heights (one before the habitable minimum raises them and one after), and both
need every guard — that is exactly how a 1.85m pier slipped past a 2.0m
threshold in the first and got roofed by the second. Left in place because
deleting one changes every roof in town and wants its own A/B.

### AND BuildingTop IS THE WRONG BOX TO FRAME

`structureBox` first returned the main body, and for a bridge the main body is
one pier at one end of the span — so the tool framed a pier from two metres,
which is the same "thirty pixels" failure it was built to end. `BuildingTop`
now also carries `originX/originZ` and `spanHalfW/spanHalfD`: the envelope of
ALL volumes about the placement origin. Same anchor argument as
`PlacedObject.footprint` and `BuildingTop` itself — **when a whole category of
work keeps not happening, look for the handle it would need.**

## AND I VERIFIED THE BRIDGES WITH A METRIC AND A DISTANT SKYLINE

Told they still looked like planks after I had reported them fixed. They were
— **one bridge in the whole of seed 31337**, down from thirteen — and the
reason I did not know is that FOUR attempts to photograph one had failed and I
fell back on a number plus my own reading of a 40-metre-away skyline. Both
halves of that were bad practice and the picture would have taken one run.

Two defects, one in the code and one in the harness:

- **The new placer stepped `y += 2, x += 2`.** A crossing only exists where a
  road tile touches water, those are rare, and skipping three quarters of the
  bank took a town from 13 bridges to 1. Stepping by one restores it; the
  reservation and a 7-tile minimum separation are what stop a bridge on every
  tile of a quay, which is what the stride was doing by accident.
- **`tools/bridgeshot.mjs` is the instrument that should have existed first.**
  Every ground-level vantage picker in this repo fails on a bridge for the
  same reason: `flyTo` does not test occupancy, a bridge sits over water, and
  its own tiles are `passage`-tagged, so the camera lands inside a building or
  underneath the deck. Stop fighting for a standable spot and go UP — at 44m
  nothing but a spire is in the way. Note it is not enough to be above the
  buildings: the whole RAY has to clear them, and the first cut at 26m looked
  straight through a roofline.

It takes two shots per bridge and prints the tiles beside them. The plan view
proves the span REACHES; the profile — taken from over the CHANNEL, the one
line through a town guaranteed to be free of buildings — shows whether it
READS as a bridge. And the tile strip distinguishes deck-over-water from
deck-over-dry-land, because the first version printed `#` for every deck tile
and a bridge over the river looked identical to a bridge over a field in the
output written to tell them apart.

    LLL=###=LLL     land · abutment · deck over water · abutment · land

## THERE WERE NO BRIDGES — the geometry and the object lived in different layers

Reported: "there are also essentially no bridges." `river.mjs` said 7.7
crossings a town and `typemix.mjs` said 20 `bridge` plus 3 `footbridge` over
three seeds, so they were being PLACED. They were not being DRAWN as bridges.

`bridge` appears **zero times in BuildingFactory** and nowhere in the massing
overrides. The arched-bridge geometry — piers, deck, parapet walls, arch bands
— exists and is good, and it lives in **PropFactory**, which never sees these
objects, because bridges go into the STRUCTURE layer. Every one fell through
to the generic archetype and was built as an ordinary house standing in the
river. Not "no bridges" — cottages on the water, which is worse.

**Fourth instance of content-with-no-way-in in this arc, and the first where
it was the ROUTING rather than the definition.** The geometry had a home, the
object had a home, and they were different homes. When a type looks absent,
check which FACTORY draws its layer before checking whether the art exists.

`tmplStoneBridge` in Massing, registered for bridge / stone_bridge /
arched_bridge / aqueduct. Rebuilt there rather than reached for across the
boundary: the object genuinely belongs to the structure layer — it blocks, it
carries the `passage` tag the collision mask clears, and the audit reads its
footprint. Like the footbridge it stands on PIERS, because a bridge tile sits
over water and the terrain under it is the river BED, so a deck at local
ground height is submerged.

**And adding it to `BuildingFactory.FOOTPRINTS` is what let `registry.mjs`
finally see the type at all.** That check is scoped by the building path's own
list — deliberately, so it does not grade props — which means a structure the
building path does not handle is invisible to the tool built to catch exactly
this. It then immediately reported `bridge` missing from `BUILDING_HEIGHTS`
and `BUILDING_ROOF_STYLE`, where it would have exported at the 1.8-tile
fallback: a 5.4m slab across the river. **A registry scoped by what a path
handles cannot report what that path is missing.**

## A TOWN DOES NOT SLOPE INTO ITS RIVER — the corner-sharing rule at a shore

Asked plainly: "the city river would have man made masonry edges right? why
does it slope down?" Correct on both counts, and the previous round's fix was
cosmetic — it painted the slope to LOOK like stone instead of making it a
wall.

**The slope was a consequence of the corner-shared height rule.** A mesh
corner belongs to one tile and every tile touching it takes the same value,
which is exactly what stops the ground stair-stepping. At a SHORELINE that
same rule is a defect: the corner between a quay at +1.45m and a riverbed at
-0.58m can hold only one number, so the quad between them is a two-metre dirt
ramp. No colour makes a ramp a wall.

So the two surfaces are allowed to disagree there, and only there:

- `terrainCornerY` — the LAND surface, and the single definition every
  consumer reaches through `getTerrainHeight` (camera, props, collision,
  audits) — resolves a corner whose own tile is WATER to the highest LAND at
  that corner. Away from water it is byte-identical to the one-line rule it
  always was, which is what keeps everything standing where it stood.
- `bedCornerY` mirrors it for the channel floor, so the bed cannot climb out
  of itself and poke through the water surface.
- The vertical gap between them is closed by `buildRetainingWalls`, which for
  a land/water edge ignores its 0.6m threshold (an unclosed gap is a hole you
  see sky through), spans the two CORNER heights rather than one tile-centre
  value, and lays the face in alternating courses — dressed ashlar where the
  town has paved up to the water, rougher revetment where it has not.

**Bank relief 0.69m -> 1.31m median.** Nothing was deepened; the land simply
stopped ramping, so the figure is now the quay you can actually see.

### AND FIFTEEN TILES A TOWN WERE WATER IN ONE MAP AND LAND IN THE OTHER

With the walls in, pale wedges still dived into the river every few tiles. Not
props — a height dump settled it in one run: a tile carrying terrain id 5
(grass) at height 2.1 raw, which is the BED, below the 2.4 waterline. Land
sitting under the water.

`carveRiverBed` keys off `waterMap`, and somewhere among ~20 terrain passes a
tile that waterMap calls water gets painted as land. It kept the bed height
and gained a land quad, so the mesh drew a slipway. Enforced once at the end
of `generate()` rather than by auditing twenty passes for a guard — the same
shape as the buried-prop invariant, and for the same reason: **a rule applied
in nineteen places out of twenty is not applied.** `placeStats`
`_waterTilesRepainted` reports the count so it cannot go quiet.

Free consequence worth noting: **continuity 2.7 -> 1.0 separate bodies of
water.** Those mispainted tiles were islands cutting the channel into
fragments, and every "the river is in pieces" reading for the whole arc was
partly them.

## THE RAVINE WAS NEVER THE CHANNEL — it was the blend, and then the light

Reported: "there is still a giant ravine running through the middle of town."
Every number said otherwise, and all of them were honest: bank relief 0.69m
median and 1.34m max, channel depth 1.07m, and — once `tools/relief.mjs`
existed to ask — a CROSS-SECTION that FALLS AWAY from the water rather than
rising. 1.37m at one tile, 1.10m at two, 0.44m at four. The river sits on a
low ridge. There is no gorge in the height field at all.

**It was in the tail, and then it was not geometry.** Two separate causes, and
neither is anything `river.mjs` asks about:

1. **The carve's skirt left a hard step.** Walkable grade read p99 35% with a
   max of 44%, and every steep tile was within four tiles of water — in
   ADJACENT PAIRS at distance 2 and 3, which is exactly where
   `carveRiverBed`'s two-tile ease stops and untouched terrain resumes. Where
   the natural ground is a couple of metres from `waterline + BANK`, two tiles
   cannot absorb it and the remainder appears as one 44% wall, repeated the
   whole length of the course. A continuous artificial escarpment either side
   of the river is a ravine by any reasonable reading of the word.
   Widening the skirt is the obvious fix and it is the one that produced the
   original grand-canyon report. `relaxTerrainSteps` instead relaxes the
   height field against a 0.36-raw maximum step with the water and its
   immediate bank PINNED — so the quay edge stays exactly as built and
   everything outward spreads over as many tiles as the drop needs. Bounded by
   construction rather than measured afterwards, same as the two-way bank
   clamp. **Steep street tiles 31 -> 0 over seven seeds; max grade 44% -> 22%.**

2. **The bank FACE was dirt, and dirt on a steep face is black.** Hiding the
   retaining walls and re-shooting changed nothing, which settles what the
   dark bands are: the ground mesh's own slope. Land shares its shoreline
   corner with the riverbed — `terrainCornerY` samples the corner's own tile —
   so the bank ramps into the channel as ordinary terrain wearing whatever
   colour that tile had. A near-vertical face also gets no direct sun and only
   the sideways half of the hemisphere term, so it renders as a dark slab
   whatever colour it carries. Two dark ramps either side of a channel IS a
   ravine.
   Steep ground now mixes toward pale weathered stone (0 below a 20% grade, 1
   at 60%), which is what a cut bank or a battered revetment actually looks
   like, and it exempts that ground from the lowland darkening that was making
   the deepest part of the bank the darkest part of the picture.

**Note what could not have found this.** The channel metrics were all in range
and stayed in range; the fix moved none of them. `relief.mjs` had to exist,
and then the A/B with `retainingWalls` hidden had to be run, because "is that
dark band the wall or the ground?" is not answerable by looking. The mesh
carries a NAME now for exactly that reason.

## THE RIVER READ AS A HOLE, AND river.mjs COULD NOT SEE IT

Reported from the phone: "the river is a total mess." It was, and every
number in `river.mjs` was healthy at the time — bank relief 0.69m, descent
76%, width gathering 2.3 to 3.0. **That tool measures the CHANNEL, which is a
fact about the height map, and the defect was in the SURFACE.** The carve was
right and the thing on screen was wrong, and only a photograph separates
those two. Same shape as the entry above it: a metric can be honest and
stable while the defect sits one question away from what it asks.

**Water was a `MeshLambertMaterial`.** Lambert is pure diffuse: no specular,
no reflection, no view dependence. At dusk the sun is low and warm and the
hemisphere term is dim and blue, so a blue diffuse plane renders very nearly
BLACK — under a bright orange sky the river was the darkest thing in frame.
That is backwards in the most basic way. **At dusk water is the BRIGHTEST
surface in a landscape, because it is showing you the sky.**

It is Fresnel-mixed toward the sky now — Schlick at water's real 2%
normal-incidence reflectance, so almost nothing looking straight down and
almost total at a grazing angle, which is most of what reads as "wet" — plus
a sun glint and three crossed wavetrains perturbing the normal so the
highlight travels. Phong rather than a raw ShaderMaterial so the fog and
shadow chunks still apply; distant water has to sit in the same haze as the
land. `setWaterSky` is fed from the sky dome's own uniforms in one place after
the time-of-day branches, so the two can never disagree — a river mirroring
last hour's sky is worse than one mirroring nothing.

**A perfect mirror was the wrong answer too.** First pass reflected the sky
exactly, and at a grazing angle that is the same warm tone as the sunlit
ground either side, so the river stopped reading as water and started reading
as wet paving. Real water takes the red out of what it reflects and gives back
less than it receives: `sky * vec3(0.60, 0.74, 0.92) * 0.85`.

### AND THE PROPS AT THE BANK HAD NEVER BEEN TO SCALE

The other half of the photograph was a faceted lump the size of a house
sitting on the bank. `tools/propscale.mjs` measured every prop and found
**18 of 27 graded types out of range** — boulders 2.7m across, standing stones
4.3m tall, rowboats 5.3m long and 39cm tall (a pancake), fish racks at 5.5m.

**These are the props that had no way in until the river arc gave them one.**
The store defined no ids for `boulder`, `rowboat`, `skiff`, `rocky_outcrop`,
so nothing could place them, no screenshot could contain one, and the
TILE = 3.0 rescale swept straight past them. Wiring them up handed the town a
vocabulary that had never once been drawn. **Content with no way in, once
given a way in, arrives at whatever scale it was authored at.**

Two populations, and they are wrong in OPPOSITE directions from the same
rescale:

- Props sized as a fraction of `fp` **tripled**, because `fp` is metres now
  and was tiles when they were written. A rowboat at `fp.w * 0.85` on a 2x1
  plot is 5.1m long — against a 22cm hull and a 30cm prow, which are absolute
  and did not move. That mixture is what makes a pancake.
- Props sized by **absolute constants** stayed put, and were tuned when a
  house was one to three world units wide: crates at 35cm, benches at 90cm,
  street trees at 3.4m — shorter than the ground floor they stand against.

The rule is the one already on the record for MAX_OVERHANG: **pin a thing with
an intrinsic size to a physical number, and only span the footprint when the
object genuinely fills its plot** (a fence, a dock, a bridge). `physical(m,
span)` in PropFactory takes the real size clamped to the plot so it can never
overflow. 18 out of range -> 8, all marginal.

**Three of the tool's own targets were wrong on the first run**, and the
pattern is worth more than the fix: every one had been written from the ID
rather than from the object. A "rowboat" imagined as a dinghy is 2m and a real
one is 3.5-4.5; `horse_post` models a hitching RAIL and its own comment says
so; `mooring_ring` is a stone bollard. The measurements were right each time.
**When a target you wrote disagrees with geometry whose comment explains
itself, suspect the target.**

## MOBILE QUALITY OF LIFE — and why none of it was caught

Four defects, and what they have in common is that every harness in this repo
drives the app with a MOUSE. `webshot.mjs` sets `hasTouch: true` and then
CLICKS buttons, so the touch flag was decoration: no drag, no pinch, no
two-finger anything had ever run. `tools/touch.mjs` is the missing instrument
and it found all of them in one pass.

- **The 2D plan could not be moved.** Panning was bound to the MIDDLE MOUSE
  BUTTON or space-and-drag, and zoom to the SCROLL WHEEL. A phone has none of
  the three. The rule now is the one every map app uses: **two fingers always
  pan and pinch, in every tool; one finger belongs to the tool EXCEPT where
  the tool has no drag behaviour, and then it pans too.** Select is the
  default and does nothing on drag, so the app you first open scrolls under
  your thumb. An 8px threshold keeps a shaky tap a tap. `_touchActive` gates
  the Pixi stage handlers off during a gesture — both listen to the same
  canvas, and without it a two-finger pan also paints a line of cobbles.
  `touch-action: none` on the canvas, or the browser takes the gesture.
- **`centerView` centred the pan and left the ZOOM alone.** A 48x48 town is
  1536px of plan; on a 412px phone you saw about a twelfth of it. Centring a
  thing whose edges you cannot see is not centring it. It fits now, never
  magnifying past 1:1, and the desktop was cropped too.
- **The view was re-framed on EVERY store change.** That effect runs whenever
  a new map object is produced — one prop, one tile — so even once panning
  existed, your next edit threw the view away. Re-frames only when
  `map.id`/dimensions actually change.
- **The app booted onto an empty 32x32 grid.** On a desktop that reads as a
  blank canvas; on a phone it is a grey screen you must find the Build tab and
  pull up a sheet to escape. `ensureStarterWorld()` grows a town on entering
  the Landscape editor — idempotent, so it can never clobber a loaded map, and
  the seed lives in the store so GenerationPanel's "Last seed" agrees with
  what is on screen instead of sitting blank under a full town.
- **The mode-select landing page ran off both sides of the screen.** Two cards
  at `min-width: 260px` plus a 24px gap need 544px; a Pixel is 412. The first
  thing anyone saw of this app was two half-cards reading "andscape Editor"
  and "Asset Creator". ModeSelector.css had no media query at all.

### THE SPAWN FACED A WALL IN HALF OF ALL SEEDS

`spawn.mjs` read **0 of 16 STUCK** and was right, and the app still opened on
a brown rectangle. Both true at once: the tool asks whether the player can
STAND, and the spawn yaw pointed at the map CENTRE, which in a dense town is a
building far more often than it is a street. Measured after teaching the tool
to cast along the camera's own yaw: **8 of 16 seeds spawned with 1.5m of view
— nose against a facade.** Now 0 of 16, median ~24m.

The fix casts 32 directions across the collision mask and takes the longest
clear run, biased up to 4 tiles' worth toward the town centre so you still set
off inward. Draw calls at spawn fell 871 -> 189 as a side effect, because a
camera pressed into a wall frustum-culls nothing.

**The lesson is the sample-aimed-at-the-wrong-thing one again.** A metric can
be honest, stable and clean while the defect sits one question away from what
it asks. "Can the player stand here" and "is there anything to look at" are
different questions about the same first frame, and only one of them was ever
asked.

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
