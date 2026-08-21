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

**A metric that ranks by deviation cannot see uniformity, and the fix is a
second metric, not a better threshold.** `odd.mjs` scores each thing in robust
deviations from its peers, so the most invisible possible reading is a town of
three hundred identical houses: every one of them scores z ≈ 0. Its own blind
spot note points at `provenance.mjs`, which grades the world against the CODE —
and code that faithfully asks for three hundred identical houses passes. The
missing question is not "is this thing unusual" but "is this thing
interchangeable with the one next to it", and no tuning of the first ever
becomes the second. Whenever a tool measures DISTANCE FROM A CENTRE, ask what
sitting exactly on the centre would look like.

**"Pin the seed" pinned the LAYOUT and nothing else — check what your seed
actually reaches.** Every `PlacedObject` gets a fresh UUID and
`simpleHash(obj.id)` was the seed for every architectural decision in every
renderer, so the streets were identical run to run and the buildings standing on
them were not. `stableHash(obj)` keys on `definitionId|x,y` instead. The
damning part is that this was MEASURED a session earlier and explained away:
`--repeat=3` showed districts stable at 49/49/49 while odd swung 39/48/41, and
the note reasoned "districts reads the MAP, so the generator is deterministic,
so the rest must be a timing race plus counts on a threshold." The race was
real, fixing it helped, and then the residual got a structural explanation that
was plausible and wrong. **When you have fixed one cause and a residual
remains, the residual is a new question, not a footnote on the old answer.**

**When two checks of the same thing disagree, compare their STRICTNESS before
you debug either.** BuildingFactory's `_clearsOpenings` is a bare AABB overlap
and `facade.mjs` insets each opening by a tenth before testing, so the guard is
strictly harsher and a member it passes CANNOT fail the audit. It was passing
members the audit called dirty. That is not a bug in either test, it is
arithmetic proof they are looking at different things — and they were: the
frame is per-VOLUME and the audit keyed it per-BUILDING, so a tower's head
plate was crossing the main body's windows. 48 reported collisions, 8 real.
This is faster than reading either implementation and it needs no picture.

**Ask the containment question before the collision question — it has no
threshold in it.** Three defects on one wall were invisible to a collision
count because none of them IS a collision: a window painted as wide as its
whole wall, a window whose head sits 0.80m above its own roofline, and 44 doors
a town painted off the wall carrying them. All three are "is the thing we drew
actually ON the surface we drew it on", which is exact arithmetic with nothing
to tune, and the collision count could only ever report the first two sideways
as "a corner post covers 11% of a window". When a tool grades how two things
INTERACT, check first that each of them is where it claims to be.

**A clamp that shaves when it could slide is throwing away the thing it is
protecting.** `clipToFootprint` correctly runs last and correctly cut every
volume back inside the box — by deleting whatever hung out, floored at 0.1m, so
a 2.6m wing came back a 1.20m x 10.49m splinter. A volume that FITS the box and
merely sits in the wrong place needs to MOVE, not to lose mass; shaving is only
right when the volume is genuinely bigger than the box. Ordering fixes WHEN a
clamp runs and says nothing about HOW it should act, and the second question
went unasked for the whole arc that fixed the first.

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

**`roofBlackPct` CONFLATES "dark by design" WITH "too dark", so the picture is
the tiebreaker.** It counts roof pixels under 0.06 luma at dusk — and DESIGN.md
pillar 1 asks for warm windows against DARK SILHOUETTES, so a dark roof is the
look. It rose 61 -> 81 across the content batches and the A/B says why: roof
SAMPLE COUNT went 788 -> 1370 because the new types are steep-roofed, so the
town has more roof on screen, not darker roof. The skyline photograph at the
same hour reads correctly — red roofs, warm windows, silhouetted spires.
Treat this row as a composition descriptor, not a defect gate, and settle it
with a screenshot rather than a sixth attribution.

**A MECHANISM THAT COULD PRODUCE A NUMBER IS NOT EVIDENCE THAT IT DID.** The
shutter palette measured 0.090-0.139 linear luma against a wall at 0.323 —
genuinely three times darker, at exactly the height eyeball samples. Lifting
it threefold moved `wallLuma` by ZERO. The measurement was correct and the
inference was wrong, and this was the FIFTH such call in one session. The
cheap discipline that would have caught every one of them: before writing the
cause down, change the suspected thing and see whether the number moves.

**A SETTER THAT IS ACCEPTED AND DISCARDED is the ghost failure with a type
signature.** `BatchedMeshBuilder.toneFloor` was honoured by `addPositioned`
and silently ignored by its sibling `addPositionedNoised`, so setting it on
the roof batch — which uses the noised path — compiled, ran, and did nothing.
The measurement is what caught it: the number did not move by a single point.
When a field is read in one method, grep for the others that should read it.

**A FLOOR THAT UNDOES A SCALE MUST NOT OVERRULE THE THING IT RESTORES.** The
post-wealthScale storey floor raised every `mainBody` to STOREY_HEIGHT flat,
so any template asking for LESS was silently overridden — and several
intrinsic-size types do. A potting shed asks for 2.32-3.07m and came out at
exactly 2.9 every time. Its purpose is to undo a slum multiplier crushing a
house storey, so the honest target is the AUTHORED height capped at a storey,
not the storey itself. Written down because the same clamp has now produced
two separate defects in one session — it also moved a ceiling up through the
floor resting on it — and both came from it acting on a number rather than on
the reason for the number.

**REMOVING ACCIDENTAL VARIATION LOOKS EXACTLY LIKE A REGRESSION.** Collapsing
the lean-to's two boxes into one volume with a real slope moved two tracked
numbers the wrong way: `variety` twinNear 14% -> 17%, because volume count and
roof style are two of the four things it keys on and both had just become
constant, and `allsides` back/front 0.72 -> 0.61, because half the edges on the
back wall WERE the step between the two boxes. Both costs are real and both
were paid for a defect: the shapes differed because a repair pass was putting
hipped and mansard roofs on a building whose whole point is a mono-pitch. The
answer is deliberate variation that is true to the type, not the defect back —
a coal store tacked on the low side and a prop under the eave, independently
rolled, give four combinations across the twenty-two a town and took twinNear
back to 14%. **A metric cannot tell "you removed variety" from "you removed
variety that was a bug"; only the reason it existed can.**

**AND `backFront` IS A MEDIAN OVER THIRTEEN BUILDINGS.** allsides grades n=30,
of which 22 are reachable and only 13 have a reachable BACK — and the tool's
own note records reading 0.28 at n=14 and 0.79 at n=30 on one build. So the
back ratio is a hypothesis at this sample size and is tracked at `dir: 0`
rather than gated, with the back count on the board beside it; FLANK is the
graded one, which is what this file has said since the first version of the
tool shot front-vs-back and read a comfortable 0.79 while both flanks were
flat colour. **When a tool prints two sample sizes, the metric belongs to the
smaller one.**

**A TEMPLATE WORKING AROUND A MISSING PRIMITIVE IS A REQUEST FOR THE
PRIMITIVE.** `tmplLeanTo`'s comment said, in as many words, "there is no
mono-pitch roof primitive and a gable would make this a small cottage, which
is the opposite of the point", and built a stepped pair of flat-topped boxes
instead. Two things were wrong with that and only a tool saw either: the
open-box repair correctly refuses to leave an exposed flat top on a habitable
volume, so every lean-to in the slum came out as two small HIPPED cottages —
`variety.mjs` reported `2 vol hipped+hipped` on nine at once — and the
workaround therefore produced the exact silhouette it existed to avoid.
`shed` is a roof style now: a convex wedge that `enforceOutwardWinding`
repairs like every other solid in Roofs.ts, so adding a fifth hand-written
roof was safe in a file where hand-maintained winding has been wrong four
times.

**AND THE WINDING AUDIT HAD A HAND-WRITTEN STYLE LIST**, so a new solid would
have been invisible to the one instrument standing between this file and
invisible roofs — the ghost failure with a type signature, inside the tool
built to catch it. `auditRoofWinding` enumerates `Object.keys(
MAX_ROOF_SPAN_RATIO)` now, which is a `Record<RoofStyle, number>`: the
compiler refuses to let a style exist without an entry, so the audit inherits
the guarantee instead of restating it. **When you add to a union, look for the
lists that should have grown and could not.** The strict Record types named
two more tables the same way, in the same compile.

**AN 11.4m POTTING SHED — THE INTRINSIC-SIZE CLASS, THIRD TIME.** A bench was
built as a nine-metre house; a coach house reached 37.5m; and `odd.mjs` found
`potting_shed` at 11.4m with a 5.6m median across the seed. Same cause every
time: a type whose real-world size is FIXED taking `ctx.wallH`, which describes
the plot. All four of the outbuildings — potting_shed, sexton_hut, coach_house,
mausoleum — had no DEF_OVERRIDE at all, so they took the generic archetype AND
its 28% chance of promotion to a tower. Registering a template is both halves
of that fix, because `pickMassing` checks the override table before it rolls
for a landmark. potting_shed 5.6m -> 3.0m.

**And `tmplLeanTo` carried the identical idiom forty lines above the comment
that explains why it is wrong.** `max(STOREY_HEIGHT * 0.95, ctx.wallH * 0.5)`
is verbatim what tmplCottage records costing two rounds to learn, and it
produced the 7.53m lean-to that `odd.mjs` ranked as the town's most slender
structure at z=69. **When a template's own comment names a bug pattern, grep
the file for the pattern the same day** — `Math.max(<absolute>, ctx.wallH * f)`
is one grep and there was exactly one instance left.

**BLIND IS NOT ABSENT, AND THE DIFFERENCE IS THE WHOLE 30FT READ.** A flank's
ground storey was laid out starting at floor 1 — nothing at eye level — under a
comment making the correct architectural argument that a blind base is what
makes a side wall read as a side wall rather than a second front. The argument
is right and the implementation threw away the thing that expresses it: a real
terraced side elevation is covered in BRICKED-UP openings, and a flat colour
field is not a blind wall, it is an unfinished one. The machinery already
existed — `blocked` cells are drawn with frame, lintel, sill and a
stretcher-bond fill — so the fix was to emit floor 0 with every cell forced
blind, and it cost no new drawing code.

    flank/front (allsides, n=30)   0.56 -> 0.64
    blank patches (holes, 6 views)    9 -> 8,  9.0% -> 7.6% of a view
    facade overOpening / offWall    0 / 0, held — the timber frame still
                                    clears a whole extra floor of openings
    eyeball wallLuma               84 -> 82, which is the COST and is correct:
                                    a bricked-up opening is darker than the
                                    wall it replaces, and flat colour was
                                    scoring well by having nothing on it

**A RATE THAT MOVES WITH ITS DENOMINATOR HAS NOT MOVED.** `habitablePinned`
jumped 5% -> 16% on the staircase change and read as the worst regression of
the day. Split into its two halves against the previous source: **numerator
32 -> 32, denominator 598 -> 311.** Not one additional volume became pinned.
`provenance.mjs` was deciding "habitable" from the ROLE — the `mainBody`-means-
two-things bug this file already records fixing in the SOURCE with
`Volume.habitable`, sitting unfixed in the tool — so 287 masonry volumes that
the clamp explicitly skips were padding the denominator, and the true rate was
always about 10%. Always print both halves of a rate you are about to believe;
a percentage is two measurements wearing one number.

**A SHAPE THAT CANNOT FIT ITS PLACER IS NOT A RARE PROP, IT IS A GHOST WITH A
WEIGHT.** `monument`, `well_grand`, `pavilion` and `fountain` were absent from
five towns; all four are 2x2 and all four sat in `DISTRICT_PROPS`, which is
consumed by a PERIMETER placer — one tile beside a building. The bag's own
comment two lines below it says "only small ground clutter that belongs at the
kerb", and seven 2x2 entries had been sitting in it against that contract,
diluting the odds of the small props that CAN fit and placing nothing
themselves. The main square already knew the fix in as many words — "it has to
SEARCH, because the exact centre is never free" — so every quarter gets one
civic centrepiece placed by the same spiral, and the kerb bag now holds only
what the kerb can take. Never-placed 12 -> 8.

**AN ENTIRE PASS WAS DEAD BECAUSE ITS GATE ASKED A MAP THAT IS NEVER TRUE.**
Every clause in `placeCountryside` asked `districtMap[y][x] !== -1`, and
`generateDistricts` assigns EVERY tile to its nearest centre — so the answer is
always true and the pass could never run: the terrain painting, the farm
fields, the orchards, the roadside stones. A reject tally read
`country~inDistrict:farm` on 80 of 80 attempts. Countryside is land the TOWN
has not reached, which is a fact about buildings and not about a Voronoi.

**AND THEN THE MEASUREMENT SAID THE LAND BARELY EXISTS.** Rewritten against
building distance, the map yields 134 open tiles of 2304 at r=1 and 47 at r=2 —
this town fills its own 48x48 map. So eighty random darts found four
candidates, and the pass still read as "no land" when the land was there and
the SEARCH was wrong: gathering the open tiles once, during a grid walk that
already happens, took orchards from 0 to 8 groups a town. `farm_field` still
cannot place and its counters now say why — `noRoad` and `edge` — because a
4x3 field needs a field.

**AND `genlog.mjs` DID NOT PIN ITS SEED**, which is the discipline this file
repeats more than any other, missing from the one tool whose job is comparing
one run's rejection counters against another's. Two readings of the same code
path gave 52 open tiles and then 147; that reads as a code change and was a
different town. It takes a seed and defaults to 4242 now, and two consecutive
runs agree exactly.

**THE SQUARE WAS THE ROAD JUNCTION, AND ITS OWN COMPOSITION PASS BELIEVED IT.**
`placePlazaFeatures` built its occupancy grid from `roadMap`, and the main
square is exactly where nine main streets converge — the comment on its own
fountain says so. So the pass that exists to furnish the square was told the
square was a carriageway. A tally on its two return paths read **`plazaOk: 1
bench` against 25 blocked**, and `bench`, `statue`, `wagon` and `market_tent`
are placed HERE AND NOWHERE ELSE. `carvePlaza` paints the square as flagstone
and `isCirculation` says flagstone is not circulation — the terrain table has
drawn that distinction since 14/15/16 were split out of 8, for exactly this.
**"Ask isCirculation(terrain), never roadMap" is written up as the precinct
wall placing itself in an alley; this is the same rule failing in the other
direction, with roadMap OVER-reporting.**

**AND A CENSUS OF WHAT A TOWN ACTUALLY CONTAINS IS NOT THE SAME AS A CENSUS OF
WHAT THE SOURCE MENTIONS.** `registry.mjs` checks the id-keyed tables and
`features.mjs` censuses gated features; neither can see a prop that is defined,
has finished geometry, is NAMED in three placement paths, and never appears.
`propscale.mjs` walks every prop in every seed it runs, so the census was four
lines: **13 defined-and-drawable types in none of five towns**, plus five
DEAD ART ids PropFactory draws that the store defines no id for. That is how
the plaza bug was found — not by suspecting the plaza, but by asking what is
missing and noticing that four of the absent types share one placer.

**AND CONTENT WITH NO WAY IN ARRIVES AT WHATEVER SCALE IT WAS AUTHORED AT** —
the riverbank-boulder lesson, now with a fourth instance. The moment those four
started placing, propscale graded them: a market tent 1.78m to the tip of its
flag, a civic statue at 1.42m, a wagon the same size as the cart it is supposed
to be bigger than. All three were invisible for as long as they were unplaced.

**A LOOKUP WITH A DEFAULT HAS NO ABSENT STATE — AND `PropFactory` WAS READING
THE WRONG FOOTPRINT ENTIRELY.** `const fpT = def?.footprint || { w: 1, h: 1 }`
takes the DEFINITION's rectangle, not the one the placer reserved, which is
exactly what `footprintOf(obj, def)` and the whole PlacedObject refactor exist
to prevent — CLAUDE.md's words: "anything reading `def.footprint` directly is a
bug waiting for the next structural change". It cost a 5.52m picket fence
standing on a one-tile reservation, drawn straight through the neighbour, and
it will have been silently wrong for every prop whose object footprint differs
from its type's.

**AND EVERY FENCE IN TOWN RAN EAST-WEST.** The whole `fence | iron_fence |
stone_wall | crenellated_wall | picket_fence` branch baked world coordinates
into `.translate(px + dx, ..., pz)` and never touched `propRot` — which is
precisely what the comment above `emitRot` warns against, four hundred lines
above the code that ignores it. Three of those ids are placed today, so a
boundary meant to run north–south was drawn across its own street. A fence's
facing also has to be DECIDED rather than rolled: propRot falls back to a
random angle up to a half turn on a 1x1 prop, which is right for a barrel and
meaningless for a boundary.

**A BOUNDARY IS NOT A PROP THAT BELONGS TO A BUILDING, AND THAT FILTER IS NOW
IN ONE PLACE.** Fourth time barriers have had to be told apart from buildings
and the first three each did it in the tool's own head — urbanform inflating
party walls with 47 wall segments, districts scoring them as not distinctive,
variety calling a town wall 104 twins. This file's verdict at the time was
"the filter belongs in one place, not in each tool's head", and it then stayed
in each tool's head. `tools/lib/taxonomy.BARRIERS` parses the store's own
`barrier` TAG, so a new barrier joins by being one; it found nine, including a
`hedge` nobody had listed.

**AND `tenancy` DIVIDED BY A POPULATION ITS NUMERATOR CANNOT CONTAIN.**
Switching on forty yard fences dropped explained tenancy 51% -> 44% without one
prop changing owner: a barrier lands in the civic bucket AND stays in the
denominator, so the rate is partly a measure of how many UNOWNABLE props the
town has. On the honest denominator the same change reads **58% -> 56%**, and
the towns either side are near-neighbours rather than an isolation, because
adding a generation pass perturbs the RNG stream. `EXPLAINED, OF THE PROPS
THAT COULD BE` is the graded row now and the all-props one is `dir: 0`. Third
instance of this exact shape in a week, after `habitablePinned` and the
feature census reading 182%.

**RELIEF, NOT TEXTURE, IS WHAT MAKES A BIG PLAIN SURFACE READ.** The curtain
wall is 6.5m tall, 1.6m thick, `textured: false` and therefore one flat colour
from the cobbles to the merlons — and there are ~47 segments a town, so it is
the largest blank surface class the town can have; `eyeball.mjs` reports "100%
bare wall" whenever one closes a vista. Texturing it is the wrong fix, because
a facade paints WINDOWS and a curtain wall has none. What real masonry has
instead is a battered plinth, a string course under the parapet and buttresses
at intervals — three volume kinds, all masonry, all untextured, no new drawing
code, and they cast their own shadow, which is the whole mechanism.

**AND THE +3 IT COST ON `deepClash` IS DIAGNOSTIC, NOT CAUSED.** Classified,
every new pair is at ONE coordinate: `workshop:mainBody x stone_wall_v` at
(5,60) on seed 31337, already overlapping 0.73m mainBody-to-mainBody before
any of this. The three new trim volumes simply occupy the same space, so an
existing collision is counted three more times. **Open, with coordinates**: the
per-side overhang clip builds its occupancy set from EVERY structure-layer
object, walls included, so `sideTaken` should have zeroed the workshop's
allowance on that face and did not. `provenance outsideBox` reads 0, which
bounds it at footprint + 0.6m, so the overlap is at the edge of what the clip
permits rather than beyond it. Worth one focused look with
`clash.mjs 31337 --all`.

**AND A GARDEN SHED HAS NO HEARTH.** The smoke collector drew a chimney from
every structure in the layer, which was harmless while the shortest thing in
town was a house and stopped being harmless the hour the outbuildings got
intrinsic heights and a potting shed became 3m instead of 5.6m. `particles.mjs`
was the only thing that noticed — smoke venting 2.4m above its own ground,
which is not the tile-coordinate bug that gate exists for and is still a plume
out of a shed roof at head height. **A gate can fail for a reason it was not
written for, and that reading is worth more than the one it was written for.**

**A CONVENTION RESTATED IN A TOOL INSTEAD OF DERIVED FROM THE CODE THAT OWNS
IT IS THE TERRAIN TABLE AGAIN, IN RADIANS.** `lib/vantage.lookAt` computes a
heading as `atan2(target.z - eye.z, target.x - eye.x)`, so yaw 0 looks +X. Two
hand-written street-vantage pickers had that table rotated ninety degrees, so
every "street view" in `hours.mjs` was taken facing the wall BESIDE the street
— which is why it needed a 9-degree up-pitch to find any sky and why its prop
column collected eleven samples. `eyeball.mjs`'s copy was worse still: it
counted road only in the +x and +z directions and only ever yawed positive, so
a tile at the west end of an east–west street scored zero both ways and
photographed a facade from a metre away. One such frame contributed thousands
of wall samples from a single wall and put `potting_shed` top of "what
dominates the town's own streets" at 98.9%.

`streetVantages` in lib now: all four directions, longest clear run, and
candidates with no corridor at all are dropped rather than pointed somewhere
arbitrary. Every view is a street. **The tone rows moved a long way and NONE
of it is the town** — eyeball wallLuma 83 -> 131 and roofBlackPct 32 -> 45 are
a camera change and were re-baselined as one; the harness printed "(+49
better)", which is precisely the thing it cannot tell apart.

**And the conclusion published an hour earlier survived the correction, which
is the only reason to check.** Props re-measured on honest vantages read 0.065
median and 47% black — the same figures the broken sample gave. It could
easily have gone the other way.

**A CATEGORY FIELD IS NOT A TAXONOMY, AND THE SWEEP THAT USES ONE WILL MISS.**
`staircase` had no DEF_OVERRIDE, so all ~8 a town were built as two-storey
houses with hipped roofs and 28% of them got a spire — the bridge finding, one
type over, and CLAUDE.md already said to sweep for it. The sweep was run and
came back clean, because it filtered on `category: 'infrastructure'` and a
staircase's definition says `category: 'building'`. Its TAGS say
`structure, elevation`. Sweeping by tag found it in one command. What actually
found the defect first was neither: `holes.mjs` named it as 7 of 16 blank
patches and 12.6% of an average street view, which is the whole argument for a
tool that selects by SCREEN PRESENCE rather than by a field somebody typed.

**AND THE POPULATION WAS THE OPPOSITE OF THE ONE I DESIGNED FOR.** The
replacement was a stepped street derived from `ctx.groundDrop`, with a perron
as the flat-ground fallback. Measured across five seeds: 42 staircases, ONE
with a drop over 0.9m, median 0.35m — the placer draws the type from a weighted
district table and never asks the terrain anything, so the fallback was the
whole town and the first build was a 6m raised slab. Same blank surface, new
shape. **Check what the bucket CONTAINS before deciding which case is
degenerate.** Capping the landing and the width to a street's took it to a
narrow flight that leaves most of its reserved rectangle as open ground:
blanks 16 -> 9 patches, 21.5% -> 9.0% of an average view, with every other
definitionId's figures unchanged.

**AND FOUR CAMERA HUNTS WERE SETTLED BY ONE COLOUR PROBE.** A 0.9m stone
platform in a shadowed corner is unreadable at noon and at golden hour, from
eye level and from above, and I took all four shots before remembering the note
in this file. `isolate()` cannot help — the geometry is merged into a batch —
so the equivalent is the door probe: paint the volumes magenta for one build,
which costs six seconds and shows the shape exactly. The permanent half of the
fix is in `asset.mjs`: **a subject flatter than half its own footprint is
looked DOWN at**, derived from the box rather than a flag, so stairs, quays,
docks and bridge decks are all framed correctly instead of photographed
edge-on as a dark line behind the near paving.

**A CLAMP THAT MOVES A SURFACE MUST TELL WHAT IS STANDING ON IT.** Every one
of the 22 open-topped volumes in the town was `mainBody`, authored flat, on
eleven ordinary types — and the whole count was ONE LINE. The post-wealthScale
storey floor raised a volume's `height` in place, so a jetty's deliberately
squat 0.32 ground floor, pushed under STOREY_HEIGHT by a slum multiplier of
0.78, grew its ceiling up THROUGH the upper floor resting on it while that
floor's `bottomY` stayed put. Same shape as the bridge deck versus the terrain:
two authors of one surface, and the fix is that whoever moves it lifts what
sits on it. **22 -> 0 over five seeds and not one other tracked metric moved** —
clash, provenance, eyeball, facade, humanscale, variety and odd are all
byte-identical, which is what a correct local fix looks like.

The route there is the whole point and took three keys on one tally rather than
any reading of the source. `definitionId:role` said every offender was the
principal volume, so not a template quirk. Adding the roof style said all of
them were authored `flat` with rise 0, not a rise collapsed by a clamp — two
arms of a disjunction that want opposite fixes. Adding WHY the coverage test
failed said `sitsTooLow` on every one, which turns "which template forgot a
roof" into "where did the thing above it go". Then one A/B — the suspected line
disabled, rebuilt — read 18 -> 0 and convicted it before a word was written
down. **A counting metric buys guesses; each extra key on the tally bought a
whole class of hypothesis eliminated.**

**A SHARED DEFINITION THAT ONE OF ITS TWO CALLERS DOES NOT CALL IS NOT SHARED,
IT IS A COPY WITH BETTER PAPERWORK.** `doorColorFor` was put in Materials.ts —
the file whose entire justification is that BOTH renderers pick a palette
independently — and wired into FacadeTexture only. The pixel-art export kept
its own door table, which runs down to 0.112 sRGB luma against a floor of 0.3
and is darker than any door in the 3D palette, so the fix reached one path of
two on the day after the file was pointed at exactly this failure for roofs.
The tell is cheap: after adding anything to a shared-vocabulary module, grep
the OTHER renderer for the table it is supposed to replace. And apply it at the
POINT OF USE rather than at the palette table, or the next palette added skips
it silently.

**A CONSTANT CHOSEN FOR PARITY WITH A MEASURED QUANTITY IS AT PARITY ONLY ON
THE DAY YOU SET IT.** The roof tone floor was picked by a principle — parity
with the wall beneath it, because a roof darker than its own wall reads as a
hole rather than a surface — and the comment recording it also recorded the
wall figure it was matched against, 0.046. That single number is what made the
drift provable months later: raising the dusk arm took the wall to 0.105 and
left the floor at 0.18, so the parity it was set to hold had quietly gone. The
durable fix is not a better constant, it is **both numbers on the same line of
the board**; `hours.mjs` prints dusk roof beside dusk wall for exactly this.
Write down the quantity you calibrated against, or the next person cannot tell
a considered value from a leftover one.

**AND THE ARITHMETIC OF A CLAMP CAN CLOSE A QUESTION WITHOUT A BUILD.** The
tempting fix was to raise that floor and recover the last 15%. The roof palette
runs 0.097-0.290 linear luma and the wall palette 0.224-0.812 — roofing is
intrinsically about three times darker than masonry, which is what a clay tile
is — so 0.18 already lifts five of eight colours and 0.25 lifts seven and
squeezes the palette into 0.25-0.29. **A floor is a clamp on the LOW end of a
distribution; pushed past that distribution's median it stops being a floor and
becomes the colour.** Pillar 2 spent to buy a tenth of pillar 1. Thirty seconds
of arithmetic on the palette beat two builds and an A/B.

**Choose a tuning value by a PRINCIPLE, not by taste or by whichever number
moves most.** The roof floor's defect was stated precisely — roofs reading
darker than the walls beneath them, which is a hole rather than a surface —
so the stopping point is parity with the wall, and the tone table says where
that is. Without that, 0.35 "improves" the metric by four times as much and
flattens the silhouette the project exists for.

**The only honest A/B in a seeded generator is CHECKING OUT THE OTHER
COMMIT'S SOURCE.** Disabling a feature in place looks equivalent and is not:
setting two building types to weight 0 stops them being placed, and still
perturbs the RNG stream, because the placer rolls over the whole table and
splices misfits in a retry loop. The result is a near-neighbour town whose
metrics land *close* to baseline — close enough to read as "snapped back" and
conclude the opposite of the truth. `git checkout <commit> -- src/ && npm run
build` is two commands and settles it.

**A metric moving against your prediction is not evidence the metric is
broken.** Faced with a tone number that would not fit the story, I wrote down
that the tool was noisy and unrepeatable, and pushed it. `--repeat=3` then
read spread 0 on all five of its metrics, and the baseline commit's source
reproduced the baseline exactly. The instrument was fine; the story was
wrong. This is the most tempting wrong turn in the whole method, because it
explains any inconvenient number and costs nothing to assert.

**A constant expressed as a fraction of a variable inherits that variable's
range, which is the opposite of pinning it.** A cottage template asked for
`ctx.wallH * 0.55` as its "low wall" and got 7.7m on a tall plot, then a roof
derived from that wall on top — a black triangle written deliberately into the
one template meant to demonstrate the good version of it. A type with an
INTRINSIC size takes a physical number, the rule MAX_OVERHANG and
PropFactory's `physical()` already follow. And never derive a roof rise from
the wall it stands on: that guarantees a roof taller than the house.

**A SHAPE and a CAP are one decision, not two.** A wash house at 2x2 was
absent from two towns in five; at 1x2 it hit seventeen in one and starved its
neighbour type. Real odds are the weight times how often the shape FITS, so
the footprint buys presence and the cap buys scarcity, and tuning either alone
just moves the failure to the other end.

**Check how many INSTANCES a type gets before reading a per-district count as
a town total.** `MAX_PER_DISTRICT` is keyed by district instance and
`residential` is the one type `generateDistricts` deliberately lets repeat, so
four wash houses under a cap of two is two quarters obeying it. That went into
a draft as "the cap is leaking" — the right diagnosis for the wrong reading.

**A GATE FIXED TWICE AND NEVER SWEPT WILL BE THERE A THIRD TIME.** The shop
sign's `fp.w >= 2` was corrected to `max(w, h) >= 2`, then `stoopBench`'s
`fpT.w >= 3` after it, and `grep 'fpT.w >='` still returned five more — of
which `placard` admitted only three of its six eligible types (shop,
apothecary and bakery are 2 wide and could never carry one) and `doorstep`
excluded every 1-wide type, which is most of the town. Grep the PATTERN the
same day you fix the instance, and prefer the exact quantity: all of these
attach to the FRONT WALL, `frontWallHalfW` is that wall in metres and already
in scope, and a tile count in one axis is a proxy that is also blind to
orientation.

**AN ACCIDENTAL EXCLUSION HIDES BEHIND A WRONG GATE, AND FIXING THE GATE
RELEASES IT.** Widening the doorstep test took it to 97% — 820 steps against
about 614 real buildings, so every precinct wall and bridge had acquired a
threshold. `fpT.w >= 2` had been excluding them only because a precinct wall
is 1x1, which is the worst kind of correct. **A count that exceeds its own
population is a free bug report**, the same tell as a rate above 100%. The
real predicate was already written: `habitable !== false`, which
FacadeConfig.hasDoor reads for the same reason.

**A lookup with a default has no ABSENT state.** `getFootprint` ends
`|| { w: 1, h: 1 }`, so an id missing from the table is not unopinionated — it
reserves one tile, and a 3x3 fountain was doing exactly that while being drawn
over eight cells the map believed were free. `registry.mjs` compared only the
entries that EXIST and so could not see a single one of six such props.
Compare against the value the code will actually GET, never against the
table's contents.

**A check evaluated before the writes it protects against is not a check.**
Vignette parts picked their tiles by filtering a list ONCE, before anything
was placed, so every candidate looked free at the moment it was tested and two
parts were handed the same tile — the anchor being the guaranteed case, not
the unlucky one. The same defect sat one level down in the footprint
validation. A running claim set makes both impossible by construction rather
than by two more guards, and `audit.mjs` had been reporting it as 49
prop-stacked warnings the whole time, on a system I was actively working on.

**A selection criterion must measure the same population as the constraint it
serves.** Anchoring vignettes on the best-connected perimeter tile is right,
and counting neighbours in ONE spot pool while the placer draws from both made
the rejection rate go UP. That is not a weaker filter, it is a filter aimed
somewhere else — the numerator/denominator lesson rotated onto a gate.

**Two rules that each sound like a clamp can compose into a FILTER.** Hanging
washing 1.7m below the eave and then requiring head clearance is satisfiable
only by buildings six metres tall, so the feature silently selected the
tallest pairs in town instead of adapting to short ones. Whenever a minimum
and a maximum are derived from different anchors, ask which population can
satisfy both.

**Exactness is not free, and an exact test that never finishes is worse than a
proxy.** Ranking cameras by how many rays land on the subject is the correct
question and it takes minutes, because three.js walks a 213k-triangle merged
mesh triangle by triangle. Budget the measurement, or take four fixed pictures
and look at them.

**When you cannot find the thing you built in a photograph, render it ALONE.**
`isolate()` in tools/lib/vantage.mjs. Four rounds of camera-hunting for one
garment — including one search that reported every bearing blocked BY THE
SUBJECT ITSELF — were settled by one subject-only frame. Hidden-vs-visible
proves the subject is in frame; subject-alone says where it is.

**Name your suspects once.** A component blamed repeatedly without evidence is
noise. The windmill was accused four times for defects it had nothing to do
with; the lantern ropes were a good hypothesis for the floating-timber class
and were refuted in one A/B by hiding them and re-counting. Test the suspect,
then either convict it or stop mentioning it.

**A metric that a lazy fix can max out will be maxed out by one, and the
highest-scoring town is usually the worst one.** District character counts a
type as distinctive if its quarter is one of few that list it, so a quarter of
twenty-one identical sexton's huts scores 100%. Every application of the
small-exclusive-type pattern has overshot into that on its first run, eleven
times, and the tell is always the same: a number arriving at its ceiling. When
a metric reads 100%, ask what the degenerate solution looks like before
believing the number — it is the mirror of "prefer the metric that only the
real structure can move".

**A fix aimed at one number through a bigger footprint pays for it in
another.** Coverage and street width both come out of how many buildings meet
the kerb, and the board prints them on separate lines as if they were
independent. Buying two points of coverage with a 2x2 where a 1x2 used to be
moved the facades three metres apart. When a quarter is short of buildings,
give it more of the SHAPE it lost.

**Half a fix is a fix you will need again, and the note recording the first
half will be sitting right above the second.** tenancy's EXPLAINS table had a
comment explaining exactly what its hand-written copy had cost — and the fix
applied at the time covered only the dwelling half, so the other half drifted
by twenty-one types. When you fix a copy-drift, fix the whole table, and grep
for the sibling copies the same day.

**Two independent failures can agree on "invisible".** The chandlery's hoist
beam was on the wrong face AND over the overhang budget, and either alone
produced the same empty frame; fixing one would have "disproved" the other. A
count of volumes emitted said the beam was there.

**A RATIO CANNOT TELL A WINDOW FROM A VOID — pair it with the one absolute
line you already have.** Every pixel test in `holes.mjs` is relative to the
local surround, which is what makes it work at any hour; and at noon, where
nothing glows, it flagged fifty-four ordinary windows as holes, because a
dark rectangle in a bright wall is simply what a window looks like in
daylight. The fix is not a better ratio. It is eyeball's existing "reads
black" at 0.06 — a number already in use — as a second, absolute gate. The
relative test FINDS candidates and the absolute one DECIDES.

**WHEN A COUNTER AND A PHOTOGRAPH DISAGREE, THE PHOTOGRAPH ADJUDICATES —
and an unwatched instrument is the one most likely to be lying.**
`river.mjs` was not on the board and reported 1.7 bridges a town "stopping
in open water", which is exactly the sort of finding that eats a session.
`bridgeshot.mjs` photographed all six on the seed and every one read
`LLL=###=LLL`. The town was fine and the tool was wrong twice: a 1x1
footbridge has no axis and `fp.w >= fp.h` silently answers X, so a
north-south chain was walked east and west and read as three dangling
bridges; and a deck reaching the map edge was called dangling because the
test steps one tile past it and falls off the map. **A false alarm nobody
runs is worse than no instrument at all** — nothing contradicts it and the
next person believes it.

**A SQUARE FOOTPRINT HAS NO AXIS, so any code that derives one from
`w >= h` is guessing.** Three separate places in this repo pick an axis that
way. It is right for a 1x2 and meaningless for a 1x1, and the failure is
silent because the guess is always SOME axis. Derive it from the thing that
actually has a direction — the deck mask, the ridge, the road.

**A FIX CAN BE APPLIED TO ONE BRANCH OF FOUR AND MEASURE AS DONE.** The tone
arc raised ambient and hemisphere with a correct argument about skylight,
took every measurement at NOON, and therefore edited the noon branch of
`updateLighting`. Dusk — the hour DESIGN.md is written against — kept the
pre-arc numbers for the whole subsequent arc, and this file recorded the
resulting 0.058 wall as a mysterious regression. When a fix is a value in a
switch, grep the other cases the same day.

**And the general answer to that is an instrument that grades every arm by
construction, not a note asking the next person to remember.** `hours.mjs`
prints all four rows together and is on the board. Grading one hour is the
right call for `eyeball.mjs` — 18.5 is the view the design is written against
— and it is exactly why the other three could rot: the tone arc edited noon,
night was later found reading sky 0.005 / wall 0.000 with 90% black, and
golden carried barely half the skylight of the dimmer hour beside it. The
gates are the SILHOUETTE (is the sky brighter than what stands in front of
it), a blackout line, and whether the branch was measured at all.

**A camera pointed where the defect is not will report that there is none.**
hours.mjs's first run pointed level at eye height and got SIX sky samples out
of four hundred — a 12m street between 10m buildings is wall from edge to
edge — so the sky column read 0.000 on every row, the silhouette test printed
"no sky", and the verdict counted zero failures. A green board that had never
looked at anything, in the tool written to stop exactly that. Pitched up 9
degrees it takes 312. The vantage lesson (`anomaly.mjs` looks UP, walkshots
carries `gable-up`) is now three tools deep, and the fix that matters is the
second one: **too few samples to answer is a FAILURE, not a pass.**

**Registry-clean is not wired-in.** `registry.mjs` checks the six ID-KEYED
tables, which are identity. There are four more that are BEHAVIOUR — the
massing template, the per-district cap, the building's own prop list, and
whether it counts as a trade building — and a type missing from those passes
every static check while being a partial ghost.

**Fixing only the instances you just wrote moves the aggregate by zero while
the composition shifts underneath it.** A second roof style on the five newest
types left `twinNear` at exactly 21%; `workshop` and `smokehouse` predated the
arc, carried the identical defect, and were three pairs each on their own.
The byte-identical number is the tell that a real mechanism reached too small
a share of the population — sweep the siblings the same run, not the next one.

**A repeatable entry in a weighted pool is an entry on EVERY draw.**
`residential` was the one type allowed to repeat and was never removed from
`avail`, so it held 10 of 35 points forever — 29% of every free slot, in a
town with three or four free slots. Removing a used type is what makes the
other weights mean what they say, and the single exception silently became the
dominant term. Forcing it once and halving the repeat took artisan from 3/12
towns to 9/12.

**A MEDIAN CANNOT SEE A STAR FIELD, AND THAT IS THE EXPECTED READING RATHER
THAN A DISAPPOINTMENT.** `hours.mjs` grades the sky as a median over sky
samples at all four hours, and a field where 4% of cells carry a point cannot
move it — the stars ARE the tail. nightSky 65 -> 65, eyeball and holes
byte-identical, and the silhouette gate can only ever be helped by a brighter
sky. It is the canyon lesson inverted: there a healthy median hid a fat tail
and the fix was to report the MAX; here the tail is the feature and there is
nothing to report. **Decide before you measure whether the metric you are
about to run could move at all** — otherwise a correct zero reads as a failed
change and invites a second one.

**AND A SKY SHADER CANNOT ALLOCATE A TEXTURE, WHICH IS PROOF AND NOT A
GUESS.** `budget` read 92.4 -> 89 across the star commit and the temptation
was to credit it. The arithmetic rules it out on its face, and a stash-and-
rebuild confirmed 89 without the change, so it was re-baselined as the
PREVIOUS commit's. This is the mechanism lesson run backwards and it is the
half that IS sound: a mechanism that COULD produce a number is not evidence
that it did, but a mechanism that could not is evidence that it did not.
Proving it took one run and beat the paragraph I would otherwise have
written.

**A HAND-WRITTEN LIST OF DRAWABLE TYPES IS THE ROOF-STYLE LIST AGAIN.**
`lib/vantage.isolate` — the function this file recommends whenever you cannot
find the thing you built in a photograph — filtered on `o.isMesh`, so the four
particle systems were the one part of the scene it could not isolate. Asking
for the moths HID them along with everything else and returned `found: 0`,
which reads exactly like "your geometry does not exist". Inside the tool built
to catch invisible content. It walks Points, Line and Sprite now, and
`hideNamed` is beside it so the A/B triple is one import.

**AND `particles.mjs` LABELLED ITS SYSTEMS BY ORDER OF ADDITION.** A
positional `['smoke','fireflies','birds']`, which worked for exactly as long
as nobody added a fourth — moths spawn between the fireflies and the birds, so
on the day they landed every bird in the verdict would have been a moth and
the moths would have been unnamed. Same shape, same hour, two files apart. It
reads `ps.type` off `particleSystems` now and prints `UNLABELLED-` loudly
rather than guessing, because a missing label must not read as a pass.

**A GHOST WITH A USER INTERFACE IS WORSE THAN A PLAIN ONE.** `moonPhase` and
`starDensity` are declared in `EnvironmentState`, defaulted in the store AND
in the generator, and wired to two Environment-panel sliders that report a
percentage — and NOTHING READ EITHER OF THEM, for the whole life of the app.
Nobody notices absent content, which is the ordinary ghost; a labelled control
is a PROMISE, so a person drags it, watches the number move and concludes the
feature exists and is subtle. `registry.mjs` audits definitions and
`features.mjs` audits gated features, and a control is neither. **Census the
CONTROLS, not only the gates** — `tools/celestial.mjs` sets each to both
extremes and asks whether the frame changed.

**AND THE TOOL BUILT TO CATCH THAT WAS WRONG THREE TIMES IN A ROW, EACH TIME
FOR A DIFFERENT REASON, WHICH IS THE REAL ENTRY.**

- **It compared PNG bytes and reported all three controls live** — including
  `sunAngle`, which the 3D renderer demonstrably does not read. The scene
  ANIMATES: moths, fireflies, smoke, window flicker and water shimmer all
  move, so any two frames differ in some byte and a boolean "differs" can only
  answer yes. It was measuring the passage of time. **A known-dead control is
  the only reason it was caught, and that is the whole argument for keeping
  `sunAngle` in the table rather than dropping it once explained: a test with
  no negative case has never been tested.**
- **Then a fraction-of-frame statistic read the moon as DEAD while the
  photograph showed a new moon vanishing perfectly.** The moon is ~20px in a
  935px frame, so at a 96-grid it lands on two samples in nine thousand. A
  metric cannot grade a feature smaller than its sample resolves — the ivy
  lesson, one instrument over.
- **And then an invented absolute floor of 0.0006 failed it again**, because
  the moon's own signal is a tenth of a number I made up. Three hand-written
  targets in `propscale.mjs` were wrong on their first run and this was the
  fourth. The bar is three times the MEASURED animation now and nothing else.

The fix that actually worked was not a threshold at all: **measure where the
subject IS.** Whole-frame energy at that vantage is window flicker, which is
genuinely larger than a small disc, so no bar could separate them. Projecting
the moon's own world position and comparing only that patch took it from
"2.5x the floor, DEAD" to **1700x, live** — nothing about the town changed
between those two numbers, only where the tool looked. `subjectPixels` solved
the identical problem the identical way and its note was sitting in this file
the whole time.

**A CONFOUND IS NOT A THRESHOLD PROBLEM.** The moon vantage's noise was partly
star twinkle — a feature added the same session, nothing to do with the moon.
Turning the stars off for that probe is the single-variable discipline this
file demands of every A/B, and it is just as binding on a tool as on a change.
It was not enough on its own, which is how the flicker got named.

**AND PRINT THE BAR BESIDE THE NUMBER.** One run came back with everything
DEAD on unchanged signal values and there was no way to tell a real regression
from a floor that had spiked. A verdict you cannot audit costs a round of
guessing every time it surprises you.

**AND THE SAME CENSUS FOUND SIX MORE: THE WEATHER DID NOTHING.** Five buttons
— clear, rain, fog, snow, storm — plus an intensity slider that APPEARS the
moment you choose a weather, which is a complete and specific promise, read by
nothing in either renderer. `weatherAir` in Materials.ts is the response, and
it is expressed as MULTIPLIERS on what the hour already decided rather than as
absolute values: every arm of `updateLighting` has had a session spent on it,
so a table setting fog density outright would overwrite that work in four
places at once, and `clear` returning exact identity is what makes wiring up a
dead control provably free. hours and eyeball are byte-identical.

**AND CLOUD REDISTRIBUTES LIGHT RATHER THAN REMOVING IT** — the sun goes down
and the SKYLIGHT GOES UP, because an overcast sky is a vast soft source.
Scaling both the same way is what "weather" looks like when it is implemented
as an opacity.

**PRECIPITATION COMES OUT OF CLOUD, AND THE FIRST CUT FORGOT THE SKY.** Fog,
sun and skylight were wired and the DOME was left alone, and the photograph
settled it in one frame: rain falling through a clear orange dusk with stars
in it. The sky is the largest surface in any street view here and pillar 1 is
built on it, so a weather that does not reach it has changed the air and not
the day. `uCloud` had been a uniform on that dome the whole time.

**AND A LIVE METRIC WITH A BAD PICTURE IS STILL A BAD PICTURE.** `celestial`
graded rain and snow as equally live because both plainly changed the frame;
only the photograph said rain drawn as round dots reads as DUST. A raindrop's
whole silhouette is the streak, and a Points sprite cannot be stretched — so
rain is `LineSegments` and snow is `Points`, one simulation feeding two draw
objects. WebGL locking line width to one pixel is exactly right for a rain
streak and is why the reverse arrangement could never work.

**A CAMERA-LOCAL SYSTEM IS GRADED ON A DIFFERENT QUESTION, AND IT HAS TO SAY
SO ITSELF.** Rain is everywhere by definition, so it is a box that travels
with the player and recycles — and `particles.mjs` grades every system on
whether its extent covers the town, which is precisely the wrong question and
would report a correct implementation as a defect. That is the false alarm
this repo calls worse than no instrument at all. `ParticleSystem.cameraLocal`
is declared in the source and the tool reads it, rather than the tool carrying
a list of names; what it asks instead is whether the box is CENTRED on the
camera, which is the one way that kind of system fails. It also reports the
DRAWN count rather than the buffer size — precipitation allocates once at its
maximum and scales by draw range, so a clear day was reporting 900 particles
and calling the allocation weather.

**A STILL PHOTOGRAPH SYSTEMATICALLY UNDER-REPORTS A MOTION FEATURE, SO GRADE
THE THING IT CAN SEE.** The whole value of moths is the erratic movement, and
no screenshot in this harness can show it. What a still CAN settle is whether
the particle is on screen at all and whether it is distinguishable from what
is behind it, and that is where the defect was: the isolate frame showed four
crisp 5px moths and the composite showed ONE, because a 0.34-0.55m orbit keeps
every moth inside the lantern's own screen footprint at any standoff a person
would stand at — and the one surface in frame a pale speck cannot be seen
against is the flame. **A radius chosen for physical plausibility was measured
as invisible.** Widened to 0.58-1.05 and the count per lamp taken 3 -> 5,
because a trio reads as three dots and a cloud reads as a cloud. Do not tune
the motion against a still; tune the visibility, and say which of the two you
measured.

## Critical files map

### Shared vocabulary (import these, never re-declare)
- `src/renderer/core/terrain.ts` — tile ids, colours, names, `isCirculation()`.
  All three renderers read this one table.
- `src/renderer/renderer3d/scale.ts` — `TILE = 3.0`, the horizontal tile ->
  world factor for the 3D walkaround, and the rule for when to apply it.
  **Read this before touching any 3D coordinate.**
- `src/renderer/core/types.ts` — `footprintOf(obj, def)` and
  `stableHash(obj)`, the two ways to ask a `PlacedObject` a question.
  **Never seed anything from `obj.id` — it is a UUID, minted fresh on every
  generate.** Five renderers each kept a private `simpleHash(obj.id)` and
  between them they reseeded every building's architecture on every run, which
  is where the whole harness noise floor came from. Both functions live here
  for the same reason: a value ten files derive independently is a value that
  drifts, and the drift is silent.

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
- `src/renderer/renderer3d/Materials.ts` — `THATCH_ODDS` / `THATCH_COLORS` /
  `roofColorFor(defId, hash, paletteRoof)`. **Shared vocabulary: BOTH
  renderers read it.** The 3D walkaround and the pixel-art export each pick a
  palette independently, so a second copy of the odds would grow thatched
  cottages in one and tiled ones in the other with nothing erroring. Same
  argument as `core/terrain.ts` and `core/types.ts`.
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
- **Washing lines share that same 25-string budget** — one pairing pass emits
  two kinds. A pair carries laundry only when BOTH buildings are in
  `DWELLING_TYPES` and there is room; anything else falls through to lanterns.
  Hung at `ground + 5.0m` (a storey plus a sill plus a window) clamped to
  `min(eave) - 0.6`, never below `ground + 4.2`. 4-5 lines and ~30 garments a
  town, garment 0.57m x 1.0m median. **Do not re-derive the height from the
  eave** — a drop-from-eave rule plus a head-clearance rule composes into a
  filter that only tall buildings pass, and the washing migrates to the
  tallest pairs in town.
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

**This session's arc, in one place.** The board is 28 checks and reads 0 gate
failures / 0 regressions. What moved:

- `hours.mjs` — all four arms of `updateLighting` in one table, gated on the
  SILHOUETTE (is the sky brighter than the buildings), a blackout line and
  whether the branch was measured at all. The arms could rot one at a time
  before this and two of them had.
- Open-topped volumes **22 -> 0**. One line: the post-wealthScale storey floor
  raised a ceiling up through the floor resting on it.
- `staircase` was built as a two-storey HOUSE — no massing override, and the
  sweep that should have caught it filtered on `category` while a staircase
  says `category: 'building'`. It is a stepped street now, and it was 12.6% of
  an average street view as a blank surface.
- A flank's ground storey is BLIND (bricked-up openings) rather than absent.
  flank/front 0.56 -> 0.64.
- Four outbuildings (potting_shed, sexton_hut, coach_house, mausoleum) had no
  override either: an 11.4m potting shed, and a 28% chance of a spire.
- `shed` roof primitive, so `tmplLeanTo` has the mono-pitch its own comment
  said it could not have; the winding audit enumerates from a compiler-checked
  table so a new style cannot go untested.
- **Every street view in the harness was facing the wall beside the street** —
  a yaw table rotated 90 degrees, in two hand-written copies. `streetVantages`
  is in lib now.
- Prop tone at dusk: measured properly for the first time (0.065 med, 47%
  black) and deliberately left alone.
- Curtain walls have a plinth, a string course and buttresses; sheds no longer
  smoke.

**THE MAGICAL PASS — two additions, and the instruments cost more than the
content did.**

- **Stars, in both skies, from one curve.** The dome was an empty gradient at
  midnight. `starIntensityFor(hour)` is in Materials.ts because BOTH renderers
  draw a sky, and it is a CURVE rather than four literals in four branches of
  `updateLighting` — the shape `hours.mjs` exists to catch, and it corrected a
  literal I had written wrong (golden hour at 16:00 had 0.12 of a star field).
  The board did not move and could not have: a 4% point field cannot shift a
  median.
- **Moths at the lanterns** — the fourth particle system, and the first moving
  thing in the town that knows where the LIGHTS are. Derived from time like
  the birds, with the radius BREATHING so it does not read as one, at 14 lamps
  chosen farthest-point over ~150-175 anchors.
- `lampAnchors` is the handle that made it possible: three producers make a
  lantern and none of them returned a position, so nothing could be attached
  to one. Same shape as `PlacedObject.footprint` and `BuildingTop`.
- **Two instruments were blind in the same hour, both to a hand-written list.**
  `lib/vantage.isolate` filtered on `o.isMesh`, so the particle systems were
  the one part of the scene it could not isolate; `particles.mjs` named its
  systems positionally, so a fourth would have renamed the birds. Both read
  the source of truth now.
- And the A/B triple found the real defect: **four crisp moths in the isolate
  frame and ONE in the composite**, because an orbit chosen for physical
  plausibility kept every moth inside the lantern's own screen footprint.

**Named and open**: `workshop:mainBody x stone_wall_v` overlapping 0.73m at
(5,60) on seed 31337 — see the deepClash note above. And a large black
featureless mass fills the lower-centre of `.shots/moth-4242-t20-composite.png`
— seen while grading the moths, not yet identified; `holes.mjs` grades BLANKS
at noon and this is a night frame.

- Scale fixed (FLOOR_HEIGHT 1.8), lamp pools as ground discs, chimneys
  anchored to mainBody with 7 whimsical variants
- Terrain slopes continuously (corner-shared heights, retaining walls
  gated at 0.6m drop)
- Cobble texture via procedural voronoi + grout, pucks removed
- Window moods warm-clamped, flicker slow (0.25–0.7 Hz ±4%)
- Lamp pools horizontal discs with radial alpha
- Lanterns in four layers: overhead rope strings, wall-mounted at 2.4m,
  ground pools under lampposts, and brazier embers at street level (the
  fourth is new — `emitGlow` finally routes them into the emissive mesh)
- Washing hangs between upper windows on domestic pairs, sharing the lantern
  pairing pass and its 25-string budget
- Props come in designed GROUPS — 22 vignettes, ~34 a town, placed before the
  scatter runs and gated on the building being a home and on which side of it
  the anchor sits. Every quarter now has at least one of its own; temple and
  cemetery had none for the whole life of the feature.
- **Every quarter has two or three small building types that are its alone**,
  each capped, and `row_house` is confined to residential and the slum. That
  pair of decisions is what took district character 26 -> 55 -> 86.
- Roofs come in two materials: tile from the palette, and thatch on the
  humble and rural types at 6% of buildings (`renderer3d/Materials.ts`)
- Spires and pointed towers carry a verdigris copper cap on 13% of buildings —
  DESIGN.md pillar 2's sixth distinguishing feature, and the last one built
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
| detail over painted glass | facade.mjs | 0 crossings (was 48, of which 40 were the tool) | clean |
| openings off their own wall | facade.mjs | 0 (was 44 — a NEW check, new class) | clean |
| awning slope | facade.mjs | 6.8° down, p10 = med = p90, 0 tilting up | clean |
| bare untextured wall | odd.mjs | 9 over z=3, was 36 — a jettied ground floor authored blank | improving |
| copy-paste twins | variety.mjs | 16% have an interchangeable twin within 15m | the price of capped exclusives and of four correct outbuilding templates |
| **build determinism** | **harness --repeat=3** | **spread 0 on every metric, was up to 12** | **fixed** |
| open-topped volumes | roofcheck.mjs | **0 over 5 seeds, was 22** | **fixed** |
| all four lighting arms | hours.mjs | sky>wall on every branch, 0 blacked out, 0 unmeasured | **new — clean** |
| holes in a wall | holes.mjs | 6 at noon; BLANKS 5 patches, 7.7% of a street view (was 21.5%) | improving |
| moving content | particles.mjs | 0 off-town, 0 smoke at head height, spread 0.94 | clean |
| human scale | humanscale.mjs | door 2.05m, window 1.35m, storey 2.90m, 0% sub-human | clean |
| street emptiness | emptiness.mjs | median 3m, 0% over 12m | satisfiable by scatter — see below |
| enclosure (to a WALL) | streets.mjs | median 3m, 0% over 15m | clean |
| corridor width | streets.mjs | 4% of road over-wide, was 58% | clean |
| street width | urbanform.mjs | 12m facade to facade vs 4-10m | recovered |
| built coverage | urbanform.mjs | 48% vs 50-70% (walls not counted as buildings) | just under range |
| district character | districts.mjs | **82%** distinctive to their quarter (was 26%; the row-house split took 55 -> 86) | in range |
| party walls | urbanform.mjs | 92% vs 60-80% | above range, deliberately |
| frontage occupancy | urbanform.mjs | **75% of ACHIEVABLE** frontage vs 85-95% | the price of the district trade |
| ground read | streets.mjs | 60% of the map one colour family | art-direction call |
| vista termination | vistas.mjs | 18% of long views end on a landmark, was 6% | improving |
| prop tenancy | tenancy.mjs | **44% of props explained by their owner** (42 -> 44 is the TOOL being corrected, not the town) | improving |
| street dressing gates | features.mjs | 1 wallpaper (copperCap, on a roof style), 3 ghosts and all correctly rare | clean |
| roof material | features.mjs | thatch on 6% of buildings, spread 0-13% | new |
| roof ornaments | features.mjs | dormer 38 / finial 26 / weatherVane 16 / copperCap 13 / spireCross 3% | new — never counted before |
| props in a designed group | genlog `vigOk:` | 41/35/27 groups a town over 14 vignettes | new |
| washing lines | (see buildLanternStrings) | 28-35 garments a town, 10 of 12 lines over walkable ground | new |
| interpenetration | clash.mjs | **25 pairs over 0.5m, was 124** — see THE OVERHANG BUDGET | fixed; the residual is named |
| bridges you can walk onto | bridgeshot.mjs | **0.34-0.58m step up, was 2.2-2.4m over head** | fixed |
| **can a person get there** | **traverse.mjs** | **78-91% reachable, 0 impassable crossings, 32 clamber pairs** | **the terrain relax is derived from the 0.6m step now** |
| **the river** | **river.mjs** | **bank relief 0.67m med / 1.28m max (was 0.03m), drop +3.6m** | **fixed** |
| river severance | site.mjs | 0 of 5 seeds have an unreachable district, was 2 | clean |
| waterfront dressing | (see dressWaterfront) | 10 maritime/natural types at the bank, was 2 | improving |
| **360-degree read** | **allsides.mjs** | **flank/front 0.64, back/front 0.71 at n=30 — ON THE BOARD now** | **improving** |
| **the district seam** | **seam.mjs** | **90% of quarter crossings marked, 3 unmarked in 8 towns** | **closed — was believed unbuilt** |
| which quarters exist | quarters.mjs | 5.8 a town; residential and market 12/12, artisan 9/12, cemetery 7, noble 4 | improving |

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

**Registry is necessary and not sufficient — there are FOUR more tables it
cannot see, because they are behaviour rather than identity.** A type can pass
`registry.mjs` clean and still be a partial ghost:

- `Massing.TEMPLATES` — no entry means the generic archetype, which is how
  every bridge in the town was built as a house standing in the river.
- `MAX_PER_DISTRICT` — no entry means uncapped, which is how a quarter becomes
  twenty-one identical sexton's huts.
- `getBuildingSpecificProps` — no entry means `[]`, so the type's props are
  drawn from the district bag at random and explain nothing.
- `BuildingFactory.TRADE_BUILDINGS` — no entry means no hanging sign, however
  obviously commercial the building is.

The first two are visible in a screenshot and the second two are not. Add all
six plus these four the same hour, and run `features.mjs` and `typemix.mjs`
afterwards rather than assuming.

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
along the road frontage of cemetery, temple, garden **and noble** quarters,
gapped every seventh tile for a gateway and skipped wherever a street passes
through. ~25 segments a town; boundary-wall frontage 2% -> 5%.

Noble was added with the `gate_lodge`, and it is the clearest of the four: the
other three are walled because they are SPARSE and a sparse quarter leaves
gaps in the street line, while a noble quarter is walled because privacy is
what the quarter IS — which is also why a gate lodge is a building type, and a
lodge standing at no gate is a small pedimented house in the middle of
nothing. **Fortress is deliberately excluded**: its boundary is the town wall
and its gates are `town_gate` and `gatehouse`, both real buildings, and a
1.45m coping course round a garrison would read as a garden.

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
0b. **WALLS AT DUSK: FIXED, and the cause was a fix applied to one branch
   of four.** This item stood at 0.058 median with 52% of wall pixels black,
   against a tone arc that recorded taking them to 0.203 — worse than the
   figure that arc started from. `updateLighting` has four branches (night,
   dusk, golden, day); the arc raised ambient 0.42 -> 0.62 and hemisphere
   0.52 -> 0.95 and, because every measurement it took was at NOON, edited
   the noon branch. Dusk kept the pre-arc numbers.

   The file already said "THE WHOLE TONE ARC WAS MEASURED AT THE WRONG HOUR"
   and concluded that the BOARD should be graded at dusk. **It never asked
   whether the arc's own FIX had reached the hour it was now grading.** A
   measurement taken under conditions nobody experiences is a measurement of
   nothing, and so is a fix.

   Sun 0.8 : hemi 0.42 is now 0.8 : 0.70, by a principle rather than by
   taste: at dusk the sun is a weak low disc and the SKY DOME is the dominant
   source — eyeball measures the dusk sky at 0.247, brighter than any surface
   in frame — so the skylight fraction should be HIGHER at dusk than at noon
   relative to the sun, and it was less than half. Still well under noon's
   0.95, and the photograph confirms dusk still reads as dusk: orange sky,
   dark silhouettes, warm windows dominating, and now you can read the
   masonry they belong to.

       wall   0.052 -> 0.088   black 52% -> 41%
       roof   0.084 -> 0.085   black 84% -> 32%   (the tail, not the middle)
       ground 0.172 -> 0.253

   **Found by `tools/holes.mjs`, not by staring at the tone table.** After
   the glass and door fixes its residual findings were all things in SHADOW,
   with nothing wrong in their palettes. Two of the remaining branches —
   night at 0.26/0.26 and golden at 0.36/0.40 — have never been measured at
   all; grade them before touching them.

1. **Ground-level life — mostly closed, and the residual is DECLINED on
   purpose rather than still open.** Props come in 22 designed GROUPS rather
   than being scattered by a distance metric, every quarter has at least one
   of its own, and washing hangs over the street between upper windows.
   This item used to ask for "things left in the street rather than tidied
   against a wall — a handcart parked across a corner, a ladder leaning, a
   crate half-unloaded." Two thirds of that arrived as the `repairs` and
   `unloading` vignettes, which are exactly work-stopped-here.
   **The last third — objects in the CARRIAGEWAY — is a rule the code argues
   against and the argument is good.** `dressEmptyStreets` places only at the
   kerb, citing Alexander #124: the life of a public space forms around its
   EDGE, and a space whose edge fails never becomes lively however much you
   put in the middle. Its own comment records that this used to be a 75%
   thinning instead of a rule and that 22% of every town's props stood in the
   road. Anything placed mid-street also has to answer to `traverse.mjs`.
   Do not reopen this without a reason better than "it would look busier";
   grade with `tenancy.mjs` (44%) and the `vigOk:` counters, not by eye.
2. **Trade quarters: CLOSED, and the fix was structural rather than more
   vocabulary.** This item said "only ~7 of ~200 buildings are trade types"
   for a long time. Market now runs 88-100% distinctive on four seeds
   (shambles / cookshop / weigh_house), harbor 100% (chandlery / net_loft /
   sail_loft) and the town reads 86%. Two things got it there and only one was
   content: seven new small exclusive types, and **taking `row_house` out of
   four of the six tables it was in.** See the section above. The one open
   residual is that **`artisan` still does not appear in most seeds** — that
   is `generateDistricts` not choosing it, not the type mix, and
   `quarters.mjs` is the tool that answers it. Do not add vocabulary to
   artisan before asking whether it is being generated.
2b. **ONE QUARTER IS HALF THE TOWN, and nothing grades quarter SIZE.**
   `quarters.mjs` prints it and I had been reading only the type list:

       seed  4242   212 bldgs   slum 99, market 29, residential 27, temple 23, noble 18, waterfront 16
       seed 65535   177 bldgs   residential 92, market 25, artisan 25, waterfront 24, noble 11
       seed    11   183 bldgs   residential 82, market 58, waterfront 28, fortress 15

   The largest cell runs 2.8-4x the mean. For `residential` that is correct —
   a town IS mostly houses — and for `slum` it is not: a slum is a corner of
   a town, and one that is 47% of it reads as a slum with a market in it.

   The cause is structural rather than a weight. Centres come from a Poisson
   disk and are sorted by distance from the map centre, so the LAST-assigned
   centres get the biggest peripheral cells, and the pool is drawn from
   uniformly at every index — a cemetery is exactly as likely as anything
   else to be handed the largest cell on the map. The fix is to assign types
   to centres in order of CELL SIZE, giving the big ones to the types that can
   carry them (residential, artisan, market) and the small ones to the
   specialised quarters, which is also just how a town is arranged. That
   needs cell sizes at assignment time and they are not computed until after,
   so it is a real change and not a tuning pass.

   **Do not fix it by lowering slum's pool weight.** That changes how OFTEN a
   slum appears, which is a different question from how BIG it is, and the
   measurement above cannot tell the two apart.

3. **Row placement predates the narrowing.** Streets are much tighter than
   when the row-streak logic was tuned; worth revisiting whether rows should
   hug the new lanes more aggressively.
4. **Perf on real hardware is unmeasured.** ~125k triangles at ~300-600 draw
   calls is unremarkable for a GPU; the low FPS in agent screenshots is
   SwiftShader software rendering with no GPU. Don't optimise against that
   number — get a debug dump from real hardware first. The narrowing added
   ~40 buildings per town, so this is more worth checking than it was.
5. **DONE — roofs have a tone floor, and the setter was being ignored.**
   `roofBlackPct` 66% -> 61% at dusk 18.5. The interesting part is that
   setting `roofBatch.toneFloor` changed NOTHING at first:
   `addPositionedNoised` is `addPositioned`'s sibling and never applied the
   field, so it was accepted and discarded, and roofs go through the noised
   path. A setter that is silently ignored is the ghost failure with a type
   signature. Only the measurement caught it — the number did not move by a
   point. **The value was chosen by a principle rather than by taste**: a dark
   roof is correct (pillar 1), the defect was roofs darker than the WALLS
   BENEATH THEM, so parity with the wall is the stop. 0.18 lands there; 0.25
   makes roofs brighter than walls and 0.055 moves nothing because the palette
   already sits above it.
6. **"PROPS READ 88% BLACK AT DUSK" — CLOSED BY MEASUREMENT, AND THE ANSWER
   IS THAT PROPS ARE FINE.** `eyeball.mjs` has a real prop MASK now: propGroup
   membership, asked BEFORE the orientation fallback that used to file a
   barrel's side as `other` and its lid as `ground`. At dusk over six views:

       prop   353 samples   med 0.065   47% reads black
       wall  6530 samples   med 0.075   31%
       other  318 samples   med 0.025   76%   <- the figure that was filed

   Props are 13% darker than the walls they stand against, which is what wood
   and iron are against plaster, and the filed claim was overstated by roughly
   double because `other` is a different population. Raising the prop tone
   floor 0.12 -> 0.18 moved the row by ZERO (the palette already sits above
   it); 0.45, tried only to prove the floor still reaches those meshes, takes
   props to 0.133 — nearly twice the wall, which is pillar 1 flattened. **The
   fix was to build the mask, and then to change nothing.**

   `hours.mjs` has the same mask and refuses to quote it: pitching up 9
   degrees for the sky collects ELEVEN prop samples, and it says "too thin to
   quote" instead of printing a median. A guard like that is why the four-row
   table can be trusted at all.

   The original note is kept below, because its reasoning was right and it is
   the reason the mask exists.

   **"PROPS READ 88% BLACK AT DUSK" WAS NOT A MEASUREMENT OF PROPS.** Filed
   here as an open item off eyeball's `other` row, and eyeball's own comment
   says what that row is: *"terrain, water, a prop or a wall mesh"* — every
   sample no building volume owns, that is not horizontal, at 265 samples
   against 9865 for walls. Vertical river-bank cuts and grazing water are in
   there with the barrels. Raising the prop floor 0.12 -> 0.25 moved the row
   the WRONG way (88% -> 94%), which is the tell that the bucket is not
   measuring what its name suggests.
   Nothing is known about prop tone at dusk. Measuring it needs a mask over
   prop meshes specifically, the way `subjectPixels` raycasts a subject —
   `other` cannot answer it and should not be quoted as if it could. **Check
   what a bucket CONTAINS before filing a defect against it**, which is the
   sample-population lesson this file already records three times in other
   clothes.
7. **The 3D walkaround has no equivalent of the pixel-art tone-mapping fix.**
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
- `node tools/propscale.mjs [seeds...]` — **every prop's real size in metres,
  AND a census of the ones that never appear at all.** The second half is the
  reverse ghost: `registry.mjs` checks the id-keyed tables and `features.mjs`
  censuses gated features, and neither can see a prop that is defined, has
  finished geometry, is named in three placement paths and simply never
  exists. It walks every prop in every seed, so it reports what a town
  CONTAINS rather than what the source mentions — and it prints DEAD ART too,
  ids PropFactory draws that the store defines no id for. Its first run found
  thirteen absent types and, because four of them shared one placer, the cause:
  the main square's composition pass asking roadMap whether the square was
  free. Read the list against `quarters.mjs` before calling one a ghost; a
  gravestone needs a cemetery.
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
  the subject. Both halves are `tools/lib/vantage.mjs` now. **And a subject
  FLATTER than half its own footprint is looked DOWN at**, derived from the box
  rather than a flag: a 6x9m stepped street a metre tall is a dark line behind
  the near paving from eye level — honestly unoccluded and completely useless —
  and the same goes for a quay, a dock and a bridge deck. When even that fails,
  and merged batch geometry cannot be `isolate`d, paint the volumes magenta for
  one build. Six seconds, and it settled four camera hunts.
- `node tools/holes.mjs [seed] [--views=N] [--time=] [--all]` — **dark
  rectangles a person reads as a HOLE in a wall, and large featureless
  surfaces they read as a BLANK one.** The class every other instrument here
  is blind to, and I found it by LOOKING: three street frames out of three
  had solid black rectangles where windows and doors are. `facade.mjs` knows
  where every opening IS and has no opinion about its colour; `eyeball.mjs`
  buries a black door among four thousand wall samples; `anomaly.mjs` finds
  thin dark shapes against the SKY and this is a fat one against a WALL;
  `odd.mjs` cannot see a defect the whole population shares. Every test is a
  RATIO to the local surround so the exposure cancels and one run means the
  same thing at noon and at dusk — plus ONE absolute line, eyeball's existing
  0.06 "reads black", because relative alone cannot tell a window from a
  void and flagged fifty-four ordinary windows at noon. Carries its own
  CONTROL (the lit openings) and names the building, the prop or the terrain
  tile with one ray per patch. **Read its four self-inflicted findings** —
  a shadowed storey with windows inside it scoring as one hole, the
  containment test then killing the control, string courses at 25:1, and the
  window/void confusion — all four found by looking at the annotated frames
  it writes, which is why it writes them.
- `node tools/eyeball.mjs [seed] [--views=N]` — **what FILLS a street view.**
  Selection by SCREEN PRESENCE rather than by data anomaly, which is the one
  thing every other tool here gets backwards: they pick a subject by z-score,
  crop to it and box it, so the big obvious thing in the frame is never the
  subject. Raycasts a grid over the whole frame at eye level and attributes
  every sample to the structure it hit. Also reports the ROOF-TO-WALL ratio,
  which nothing else asks and which is the largest visible defect in the town
  (p90 199%). Read its note about apex vs wall height before quoting a storey
  count.
- `node tools/hours.mjs [seed] [--views=N]` — **all four arms of
  `updateLighting`, side by side.** eyeball grades ONE hour, correctly, and
  that is exactly how the other three rotted: the tone arc edited noon because
  every measurement it took was at noon, night was later found at sky 0.005 /
  wall 0.000, golden at half the skylight of the dimmer hour beside it. Two
  questions per branch — is any surface class effectively BLACK (eyeball's
  0.06, reused not reinvented), and **is the sky brighter than the buildings**,
  because pillar 1's dark silhouettes need something to be silhouetted
  against. Deliberately coarse: a tripwire, not a portrait. Reads sky/wall
  night 0.065/0.032 · dusk 0.226/0.105 · golden 0.232/0.186 · day 0.233/0.169,
  spread 0 over three runs. **It looks UP by 9 degrees** — see the vantage
  lesson; level, it got six sky samples out of four hundred and passed itself.
- `node tools/facade.mjs [seed] [--shots=N]` — **does the 3D detail on a wall
  collide with the openings PAINTED on it?** The fourth axis, and the one that
  found the timber-over-windows defect: a wall has two authors, FacadeTexture
  and BuildingFactory, and nothing compared them because the windows are not
  geometry. BuildingFactory records every opening and every attached member in
  the same WALL-LOCAL frame, so the test is exact 2D arithmetic. Read its note
  on what counts as CROSSING — the first version asked what fraction of an
  opening a member covers and a 12% floor excluded every stud, which is the
  defect it was written to find.
  It now reports **four** things and only the first is a collision, which is
  the point: `OFF THE WALL` asks whether each painted opening lies inside the
  wall carrying it (exact, no threshold, and it found a window as wide as its
  whole wall, a window 0.80m above its own roofline and 44 doors a town on
  boundary walls); `RECORDED` is a census of every part kind, so a kind that
  never fires is distinguishable from one that never offends; and `AWNINGS`
  measures the canvas slope off its BUILT vertices — that block used to print
  a sentence pointing at a source comment and check nothing at all. Parts are
  keyed by WALL, not by building: keyed by `obj.id` it cross-multiplied a
  tower's members against the main body's windows and inflated 8 real hits to
  48. `--all` prints every hit's geometry, which is what distinguishes "a hair
  over the reveal" from "straight through the glass".
- `node tools/variety.mjs [seed] [--near=15] [--all]` — **can the eye
  copy-paste one building onto another?** The axis `odd.mjs` is blind to BY
  CONSTRUCTION: odd ranks a thing by how UNLIKE its peers it is, so a building
  that looks like everything else scores z ≈ 0, the most invisible reading
  there is. Its own note says it cannot see a defect the whole population
  shares and points at provenance.mjs — but provenance grades the world
  against the CODE, so if the code faithfully asks for three hundred identical
  houses both tools report a clean town. DESIGN.md's pillar 2 is exactly this
  and nothing measured it. Two structures are TWINS when they are
  interchangeable, not merely similar: same type, same volume count, same roof
  styles, every silhouette dimension within 5%. **Read the NEIGHBOUR rate, not
  the global one** — a real terrace repeats on purpose and 93% of this town
  shares a party wall, so a global twin rate would condemn the thing the
  urban-form arc achieved. Two identical houses across town is a housing type;
  two in the same FRAME is a copy-paste, and scattering cannot move that
  number. It states no target, for the reason propscale.mjs learned: three of
  its hand-written targets were wrong on the first run.
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
- `tools/lib/taxonomy.mjs` — **not a tool, the vocabulary every tool should
  read.** Parses `DWELLING_TYPES` out of core/types.ts and THROWS if the
  declaration shape changes, because a taxonomy that quietly falls back to a
  default would grade the whole town against the wrong population and report a
  clean number for it. Three files each kept their own list of what counts as
  a house and all three disagreed. Reach for this before writing `new Set([
  'row_house', ...])` in a tool.
- `tools/lib/vantage.mjs` — **not a tool, the camera every tool should use.**
  `lookAt(win, box)` raycasts candidate vantages against the real scene and
  flies to the first with a clear line to the subject, returning where the
  subject landed on screen; `cropTo` crops the capture to it with a floor size;
  `markSubject` outlines it; `hideChrome` removes the HUD. Reach for this
  instead of hand-placing a camera — five tools had each hand-rolled "find a
  spot to stand" out of the tile map and every one of them had stood inside a
  building. Its failures are informative: it names the mesh in the way.
  `structureBox(id)` on the debug bridge gives you the box to pass it.
  **`isolate(win, meshName)` hides everything except one named mesh** and
  returns a restore function. Use it whenever you cannot find the thing you
  just built in a photograph — four rounds of camera-hunting for one 0.8m
  garment were settled by it in a single shot. Pair it with the hide-one-mesh
  A/B: hidden-vs-visible proves the subject is IN the frame, subject-alone
  says where it is and what shape it really has. `hideNamed(win, meshName)` is
  the other half and lives beside it, so the triple is one import. Requires
  the mesh to have a NAME, which is the same reason the lantern ropes got one.
  **Both walk Points, Line and Sprite, not only Mesh** — they filtered on
  `o.isMesh` for their whole life, so the four particle systems were the one
  part of the scene they could not isolate, and asking for them returned
  `found: 0`, which reads exactly like "your geometry does not exist". A
  hand-written list of drawable types, inside the tool built to catch content
  that is invisible.
- `node tools/particles.mjs [seeds...]` — **is the MOVING content where the
  town is?** DESIGN.md pillar 4 is "motion breathes" and sixteen instruments
  graded the static world while NOT ONE looked at a particle. That is how
  chimney smoke spent the entire life of the tile rescale venting over the
  first third of the map: the collector built its Vector3 from TILE
  coordinates for x and z and a WORLD height for y, and nothing scales
  particleGroup. Measured, town x 2.8-143 against smoke x 14.5-46.4 — exactly
  a factor of three. **The mixed units inside one Vector3 are what hid it**:
  the height was always right, so the smoke sat at a plausible altitude over
  the wrong place, which looks like smoke rather than like a bug. Reports each
  system's extent as a FRACTION of the town's, so the signature shape (a clean
  ~0.33) is recognisable rather than inferred. Labels each system by what it
  SAYS it is (`ps.type`), because the first cut flagged fireflies for starting
  near the ground — which is what a firefly does — and the fix for that was a
  positional `['smoke','fireflies','birds']` that worked exactly until a
  fourth system arrived. Also censuses the three LANTERN FAMILIES, because the
  moths draw from all of them and a pass that reaches two of three reads as
  healthy while the survivors carry the count.
- `xvfb-run -a node tools/celestial.mjs [seed]` — **do the Environment
  panel's controls do anything?** Seven of them, and six were dead.** Sets each celestial control to both extremes
  and measures how much of the frame changed, against a noise floor taken from
  two frames with nothing changed — the animation is the control. No model of
  what a slider ought to do, so it cannot be wrong about the intent; a control
  whose extremes render identically is dead and that is the whole verdict.
  Found `moonPhase` and `starDensity` read by NOTHING. **Read its three
  self-inflicted failures before trusting a new probe you add to it** — PNG
  bytes measuring animation, a fraction-of-frame statistic too coarse for a
  20px moon, and an invented absolute floor — and note that `sunAngle` stays
  in the table as the NEGATIVE CASE, because it is genuinely dead in the 3D
  path and a test with no negative case has never been tested.
- `xvfb-run -a node tools/mothshot.mjs [seed] [--time=]` — **stand at a
  lantern and look at it.** particles.mjs says the moth system exists, is
  inside the town and reaches every family; it cannot say whether a 7.5cm dot
  at RENDER_SCALE 0.4 survives to a pixel, which is the only question that
  matters for a particle this small. Takes the A/B TRIPLE in one run —
  composite, moths hidden, moths alone — plus a centre crop of each, because
  the lamp is at frame centre by construction and "I can just about see it if
  I know where to look" is not a reading. That triple is what found the real
  defect: four crisp moths in the isolate frame and ONE in the composite,
  because the orbit was tight enough to keep them all inside the lantern's own
  screen footprint. **It cannot grade the MOTION, and says so** — a still
  photograph under-reports a motion feature by construction.
- `node tools/growth.mjs [seeds...]` — **does the town get sparser as you walk
  out of it?** DESIGN.md names six marks of organic growth and five had a
  tool; "dense core, sparse edges — growth rings fade outward" had none, and
  nothing else can see it, because urbanform reports coverage as ONE town-wide
  figure and a flat 46% is indistinguishable from a gradient averaging 46%.
  Equal-AREA rings out from the footprint-weighted building centroid (not the
  map centre — the town does not fill the canvas). **It REFUTED the hypothesis
  that motivated it**: coverage falls 58% -> 22% core to edge, 2.4-4.3x on
  every seed, so the principle was already satisfied and simply unwatched. On
  the board now for exactly that reason. States no target, and its storey row
  deliberately grades nothing: DESIGN.md says the oldest part is the TIGHTEST,
  which is density, and "also usually the tallest" was a target I caught
  myself inventing.
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
  **It names them now** (`definitionId:role`, most first): the count went 6 ->
  22 across a content arc that added ten building types and nothing could say
  which of them did it. Note the population — volumes declaring
  `habitable: false` are excluded, because masonry is meant to end in sky, so
  what is left is a ROOM with a flat slab on it.
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

**TWENTY-EIGHT CHECKS NOW, AND THE EIGHT MOST RECENT WERE SITTING UNRUN.**
Nineteen instruments were on the board and twenty-nine were not. Most of the
twenty-nine are PHOTOGRAPHERS — asset, bisect, walkshots, rivershot,
bridgeshot, inspect, pixelart, webshot — and belong off it; they answer "what
does this look like", which has no number to regress. Eight were
measurements: river, site, vistas, features, tenancy, streets, budget,
propscale. They are on it now, every extractor written against captured
output and tested before it went in.

Still off the board and worth adding when someone has the runtime budget:
`squares`, `emptiness`, `seam`, `relief`, `slivers`, `overhang`,
`typemix`, `quarters`, `anomaly`. (`allsides` and `hours` went on.) `anomaly` is the notable omission — it is
the pixel-defect detector and it has a stated noise floor, so it needs a
`--repeat` before a band can be chosen honestly.

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

### AND THAT SECOND BULLET WAS WRONG — IT WAS A DIFFERENT TOWN EVERY RUN

**Left standing above, because being wrong in a plausible way is the finding.**
The reasoning was: districts reads the MAP and is stable, so the generator is
deterministic, so the residual must be counts sitting on a threshold. Every
step is true except the conclusion, and it closed the question for a session.

`facade.mjs` read 152 buildings / 1352 parts and then 148 / 1175 on an
identical build and seed. Checksumming the map and the ids separately:

    layoutHash  3211781608  3211781608  3211781608   identical every generate
    idHash      3902668415  4159138546  3050480396   never the same
    sampleId    566fa0d9-...   ba6d4779-...   723bedfa-...

**Every `PlacedObject` carries a fresh UUID and `simpleHash(obj.id)` was the
seed for every architectural decision in all five renderers** — massing
template, landmark promotion, timber versus quoins, roof style, chimneys,
awnings, wealthScale, every `rand01(hash, salt)` under them. Identical streets,
different buildings on them, every single run. `districts` was stable *because*
it reads the map, which is exactly the observation that was used to rule this
out.

`stableHash(obj)` lives in `core/types.ts` beside `footprintOf`, for the same
reason: THE one way to ask. Keyed on `definitionId|x,y`, because the seeded
generator decides position, footprints do not overlap within a layer, and it
survives save/load — where a regenerated UUID would silently repaint a whole
town. Five private copies of `simpleHash` deleted; one definition now.

    before   152 / 240 / 1352   148 / 227 / 1175   156 / ... / 1213
    after    156 / 227 / 1213   156 / 227 / 1213   156 / 227 / 1213

Byte-identical, percentiles included. **Every A/B in this repo before this
commit was measuring its change plus an unknown amount of reshuffled
architecture**, and "pin the seed" was the discipline that was supposed to
prevent exactly that.

`--repeat=3` afterwards, on the four checks that used to move most:

    provenance  outsideBox 0,0,0   doubled 14,14,14   spireAtCap 0,0,0
    clash       deepClash 124,124,124   onAir 16,16,16   buried 0,0,0
    roofcheck   openTops 16,16,16
    odd         overZ3 22,22,22    bareWall 9,9,9

Spread 0 on every one, so the harness bands came down from 4-20 to 0-2.
**A wide band on a deterministic metric is not caution, it is a regression
detector switched off** — the old `openTops` band of 12 would have sat quietly
through a change that doubled the open roofs. `eyeball` keeps a wide band and
is labelled UNVERIFIED, because its numbers come from rendered pixels and it
has not been through `--repeat` since the fix.

### AND THE FIRST THING THE DETERMINISM PAID FOR WAS CATCHING ME

`deepClash` is 124/124/124. The commit before had reported it **118 -> 91,
"the splinters were CAUSING collisions, not avoiding them"** — a delta measured
across two reshuffled towns, which is to say not measured at all. Re-run as a
proper single-variable A/B (the slide disabled by turning one `if` into
`if (false)` on each axis, everything else byte-identical):

| | shave | slide |
|---|---|---|
| deepClash | 125 | **124** |
| wall width p10 | 1.84m | **2.60m** |
| walls under 1.6m | 15 | **10** |
| worst aspect | **14.4:1** (0.70 x 10.08m bakery) | **7.1:1** (1.21 x 8.55m row_house) |

**The change is good and the mechanism claimed for it was wrong.** Sliding a
volume back inside the box instead of shaving it lifts the tenth-percentile
wall by 41% and halves the worst aspect ratio, which is exactly what it was
written to do. It does essentially nothing to interpenetration. Both halves of
that are worth keeping: the fix stays, the sentence about collisions does not.

### THE VARIETY READING, AND ITS FIRST NUMBER WAS ALSO WRONG

`tools/variety.mjs` read **36% of structures have an interchangeable twin
within 15m** and the headline was mostly wall: 104 of 307 "structures" were
`stone_wall` / `stone_wall_v` / `precinct_wall` segments, and a town wall made
of 28 identical pieces is a WALL. **Third time this repo has counted barriers
as buildings** — `urbanform` inflated party walls with them, `districts` scored
them as not distinctive to their own quarter — and it is written down twice.
The filter belongs in one place, not in each tool's head.

Barriers excluded, on 197 buildings:

    has a twin ANYWHERE      39%
    has a twin within 15m     9%     <-- the one that matters
    row_house  62 built, 50 distinct silhouettes (81%)
    bakery 93%   building_small 94%   shop / tower / mausoleum 100%
    archway    6 built,  4 distinct (67%)  <-- worst, and a small population

**That REFUTES the prediction that motivated the tool.** `provenance` reports
40% of habitable volumes pinned at exactly `MIN_HABITABLE_W`, which looked like
the copy-paste failure made visible — and it is not, because the floor pins
WIDTH only while height, depth, volume count and roof style still vary. The
town does not read as repetitive because its buildings are interchangeable.
Whatever "pseudo-random assets dropped around" is, it is not this, and that is
worth knowing before more effort goes into varying silhouettes.

## THE WHOLE TONE ARC WAS MEASURED AT THE WRONG HOUR

DESIGN.md's north star is one sentence: **"Can the player stand in this town at
dusk and feel like they're somewhere?"** The app's own default `timeOfDay` is
18.5. `eyeball.mjs` defaults to `--time=12`, and every tone measurement in this
repo — the ambient and hemisphere lift, the paving pull-down, the roof palette,
the prop tone floor — was taken at NOON.

The two hours are not close. Same seed, same build, same six street views:

    surface    noon med / black      dusk 18.5 med / black
    wall        0.210    4%           0.068   47%
    roof        0.171   10%           0.047   57%
    other       0.106   16%           0.029   92%
    ground      0.682    0%           0.170    8%

**Walls at dusk read 0.068, which is exactly the figure the tone arc started
from and believed it had tripled.** Props are effectively invisible: 92% of
their pixels are black at the hour the design is graded on.

Part of that is correct and wanted — pillar 1 says warm amber windows against
DARK SILHOUETTES should dominate, so a dark wall at dusk is the look. What is
not wanted is 92% on props, because it means every piece of street dressing,
including content added specifically to make the town feel lived in, is not
visible at the test view. Pillar 5 asks for three layers of warm light and the
props are not reaching any of them.

`harness.mjs` grades `eyeball` at 18.5 now. Noon is one flag away and still
worth checking — the pair is informative, because a surface that is fine at
noon and black at dusk is a LIGHTING problem while one that is dark at both is
a PALETTE problem, and the two want opposite fixes. But the number the board
carries should be the hour the design is written against.

**The general lesson, and it is the same one this file keeps recording in other
clothes: a measurement taken under conditions nobody experiences is a
measurement of nothing.** The instrument was honest, repeatable and pointed
somewhere the player never stands.

### AND ONLY LAMPPOSTS EVER GLOWED

Found while asking what content survives dusk. `lampEmissiveGeos` — the array
feeding the one emissive mesh in the prop path — has exactly ONE producer, the
lamppost branch. Meanwhile `forge_brazier` carries a comment saying its ember
glow "shares the lantern emissive driver (reused via a constant emissive that
bloom picks up at dusk) so forges light up with the rest of the town", and what
it actually did was paint 0xffb060 into the ordinary vertex-coloured Lambert
batch. At dusk that is a dark orange dot.

A comment describing a feature that does not exist is the GHOST failure with
documentation attached, which is worse than an undocumented ghost: the next
person reads the comment and crosses it off the list. `emitGlow` is the sibling
of `emitRot` that routes into the emissive mesh, and the brazier uses it.

## THE CONTENT ARC — vignettes, and the three bugs found by grading them

Asked for a more lived-in world. Three moves, and in every case the
measurement mattered more than the content.

**Props are placed in GROUPS with a role, before the scatter runs.** A
vignette is a small table entry — `woodpile` + `crate|barrel|rubble_pile` out
of sight, `bench|potted_plant` + `flower_box` presented to the street — with a
`home` gate on the building type and a `front` gate on which side the anchor
sits. One attempt per building, taken while the perimeter is still empty,
because a designed place must be dressed BEFORE the scatter: the reject
counters said noRoom killed 59% of attempts purely because single props were
eating the perimeter tile by tile.

**A part may offer alternatives, written `crate|barrel|rubble_pile`.** That is
pillar 2 at arrangement scale — the woodpile always had exactly one crate
beside it — and the same mechanism doubles as room to manoeuvre, because many
props are 2x1 and requiring the first roll to fit rejected whole groups on a
tile a different, equally good part would have sat on.

### AND MOST OF THE GROUPS I REPORTED WERE A BUG

The census said 27-37% of props were in a group. The honest figure is about a
third of that, and the difference was **part two landing on part one**.

`near` was a filter over the perimeter evaluated ONCE, before anything was
placed, so `free()` was true for every candidate at the moment it was tested.
The anchor was the guaranteed case rather than the unlucky one: the caller
splices it out of the pool only on SUCCESS, so it is still in the list, and
`|dx| <= 1 && |dy| <= 1` includes dx = dy = 0. A running claim set makes that
impossible by construction. The identical defect sat one level down in the
footprint validation, where a 2x1 second part was tested against `occupied`,
which cannot know about this group's own tiles because nothing is placed until
every part resolves. **Both are a check evaluated before the writes it exists
to protect against**, and `audit.mjs` said so immediately — 49 prop-stacked
warnings on one seed, every reported pair a vignette pair. I had not run it.
Not the "run the battery for the system you are NOT working on" lesson; worse,
the one I was.

### SIX PROPS RESERVED ONE TILE AND ARE NOT ONE TILE

`getFootprint` ends `return footprints[defId] || { w: 1, h: 1 }`, so **an id
absent from that table is not unopinionated — it reserves ONE TILE.**
`market_tent` is 2x2 and `fountain_grand` is 3x3, both claiming a single cell
and being drawn over neighbours the map believed were free. Also
`picket_fence`, `rowboat`, `skiff`, `port_crane`.

`registry.mjs` could not see any of them, twice over: it skipped every
definition that was not a building or infrastructure, and its disagreement
check compared only entries that EXIST. **A lookup with a default has no
absent state — compare against the value the code will actually get, never
against the table's contents.** It reads all 116 definitions now; verified by
deleting an entry and watching it go red.

### ANCHOR WHERE THERE IS ROOM, AND MEASURE THE RIGHT POPULATION

noRoom was still rejecting half of all rolls because the anchor was drawn
uniformly from the perimeter and a terrace in a 93%-party-wall town presents
two or three spots that are often not adjacent to each other. Adjacency is the
group's whole requirement, so it is the thing to SELECT ON. The first cut
counted neighbours within one pool while `tryVignette` draws from both, and
noRoom went UP — **a criterion that measures a different population from the
constraint it exists to satisfy is not a weaker filter, it is one aimed
somewhere else.**

    groups per town   random anchor  23 22 23
                      pool0 adjacency 21 42 33
                      full perimeter  41 35 27

`kitchengarden` fired zero times on three seeds because both of its anchor
options are 2x1 — the alternatives were varied and none of them was SMALL.
`drying`, `yardfence` and `stallside` still fail on footprint and that is left
alone: a fish rack and a market stall genuinely need the room, and **a
fallback that reads wrong is worse than a rejection.**

Tenancy 38% -> 42% explained, and the taxonomy fix below moved it by zero.

### ONE DEFINITION OF WHAT A HOUSE IS — three had already drifted

The renderer needed "is this a home" for the washing lines, which would have
been a FOURTH copy. The other three did not merely differ in length, they
disagreed about what a home IS: TownGenerator 12 ids decides where domestic
dressing GOES, tenancy.mjs 11 decides whether it counts as EXPLAINED, and
eyeball.mjs 15 decides which buildings are graded as ORDINARY — and it counted
`coach_house` and `potting_shed`, an outbuilding and a garden shed, dragging
the storey distribution it reports.

`DWELLING_TYPES` in core/types.ts, beside `footprintOf` and `stableHash`. The
tools PARSE it (`tools/lib/taxonomy.mjs`) and throw if the declaration shape
changes. **"Keep in step with DWELLINGS in TownGenerator.ts" was already
written in tenancy.mjs as a comment and the lists drifted anyway — a note
asking a future reader to synchronise two constants is not synchronisation.**

### WASHING BETWEEN UPPER WINDOWS — and a height filter wearing a clamp

A second payload on the SAME pairing pass in LanternStrings, not a second
pass: the pairing carries the distance filter, the per-building usage budget
and the endpoint pull-in, and copying it is how three terrain tables came to
disagree. A pair that cannot carry washing falls through to lanterns.

**The first cut hung it 1.7m below the lower eave and then required head
clearance, and the pair of rules quietly became a HEIGHT FILTER.** Only
buildings almost six metres tall satisfy both, so the washing selected the
tallest pairs in town and measured 8-17m — above most of the rooflines it was
meant to hang between. A test that rejects the short case does not adapt to
it. Pinned to the window instead (storey + sill + window, measured UP from the
ground) and clamped DOWN to the eave.

`rotateY(t)` maps +X to (cos t, 0, -sin t), so `atan2(rz, rx)` sends the
thickness axis to `(rx, -rz)` — the perpendicular with its z flipped, which is
only perpendicular when the line runs along an axis. **Every diagonal line in
town hung its washing skew.** The sign belongs inside the atan2.

    garments per town        33 / 35 / 28   on 4 / 5 / 3 lines
    garment width  median    0.54-0.60m     max 0.82-0.95m
    garment drop   median    0.87-1.05m     max 1.36-1.40m
    lines over walkable ground              10 of 12

The last row is the one that decides whether the feature exists in play. The
pairing filters on distance and building type and has no notion of a street,
so a line could equally have spanned back yards nobody can reach.

### THE ORDINARY QUARTER HAD NO VOCABULARY — cottage and wash house

Seventh application of the small-exclusive-type pattern, and the first aimed
at `residential`, which read **13-14% distinctive on two seeds of three** —
the worst of any quarter. The cause is structural rather than a weight: its
whole table is row_house / building_small / bakery / narrow_house, every one
of which also appears in market, artisan, waterfront, harbor and slum, and
`districts.mjs` counts a type as characteristic only if it appears in at most
a THIRD of the quarters present. Its entire vocabulary is disqualified by
construction.

What an ordinary quarter has that no other does is the shared domestic
institution — the place the street washes — and the low dormered cottage
between the terraces.

    residential character   14 / 13 / 41%  ->  45 / 41 / 59%
    town-wide character     49%            ->  52%
    coverage 45 -> 46 · party 93 -> 91 · frontage 78 -> 78 · audit 0/0

`districts.mjs` is unchanged, so all of that is the code, and the trade is far
cheaper than the earlier district arc's: coverage did not fall and the two
points of party wall are a 2x2 cottage terracing less readily than a 1x2 row
house.

**`cottage` was already in DWELLING_TYPES and nothing defined it.** Two of
that set's twelve entries — `cottage` and `townhouse` — were ids the game does
not have, carried across when the three copies were merged and never checked
against store.ts. Same defect tenancy.mjs's header records making with
invented prop ids, one field over. A dead entry in a SHARED vocabulary is
worse than in a private one: the next person writing a district table reaches
for a type that cannot exist.

**THE SHAPE AND THE CAP HAVE TO BE CHOSEN TOGETHER.** Three rounds on one
parameter pair:

- At 2x2 the wash house placed 4/0/0/1/3 across five seeds, absent from two
  towns, and the zeros were the two SMALLEST residential quarters — real odds
  are the weight times how often the shape fits.
- So 1x2, and it hit SEVENTEEN on one seed while stealing the small slots the
  cottages needed (11 -> 1 on another). The shape buys presence, a cap buys
  scarcity, and neither does both.
- **And then I misread the cap.** 4 against a cap of 2 went down as "the cap
  is leaking", the documented enforced-in-three-of-four-paths failure. It was
  not. `MAX_PER_DISTRICT` is keyed by district INSTANCE and `residential` is
  the single type `generateDistricts` deliberately lets repeat
  (`!usedTypes.has(t.type) || t.type === 'residential'`), so 4 was two quarters
  each obeying a cap of 2. **Check how many INSTANCES a type gets before
  reading a per-district count as a town total.**

Final: cottage on all 8 seeds (1-15 a town), wash house on 6 of 8. The
institution missing from a quarter of towns is a residual worth naming rather
than tuning a fourth time — fixing it properly means placing one deliberately
per residential quarter instead of drawing it from a weighted bag.

### EIGHT REGRESSIONS, AND THE SINGLE-VARIABLE A/B SPLIT THEM IN TWO

Adding two building types moved eight tracked metrics, on a baseline saved
after the washing lines and before these — so the attribution window was
clean and every move belonged to this one commit. Rather than reason about
which were "just a different town", the types were given **weight 0** so they
exist and never place, which is the one change that isolates them:

| metric | weight 0 | with the types | baseline |
|---|---|---|---|
| habitablePinned | **10** | 13 | 11 |
| deepClash | **15** | 19 | 15 |
| odd overZ3 / bareWall | **20 / 10** | 27 / 14 | 21 / 10 |
| eyeball roofBlackPct | **69** | 66 | 56 |
| eyeball wallLuma | **63** | 75 | 72 |

The first three snap back to baseline: those regressions ARE the new types,
they are real, and they are the honest price of the character gain — a 2x2
cottage touches its neighbours where a 1x2 row house did not, and two new
proportions create new outliers in a metric that ranks by deviation from
peers. Re-baselined with that evidence rather than absorbed quietly.

The tone rows read WORSE with the cottages removed, which looked like proof
they were not a cottage effect. **That conclusion was wrong and it was
published before it was checked.** Two follow-ups killed it:

- `--repeat=3` on eyeball reads **spread 0 on all five metrics**, and building
  the baseline commit's own `src/` reproduces `63/10/12/72/56` exactly. So
  eyeball is deterministic within a build AND across builds. The "it is a
  noisy instrument, do not trust its tone rows" story was invented to explain
  a number and is simply false.
- **Weight 0 is not a clean isolation.** It stops the type being PLACED —
  typemix confirms zero of each — but `pickTypeForSpace` rolls over the whole
  table and splices misfits in a retry loop, so two extra entries can still be
  selected as an index, fail, and consume an extra `rng()`. From that point
  the stream is desynchronised and the town is a near-neighbour rather than
  the same town. The three metrics that "snapped back" landed at 10/15/20-10
  against a baseline of 11/15/21-10 — close, which is what a near-neighbour
  looks like, not what an isolation proves.

So the honest reading is the plain one I drafted first and then talked myself
out of: **a low-wall, big-roof type puts more ROOF and less WALL in a street
view, and roofs at dusk are the darkest surface in this renderer.**
roofToWallMed +5, roofBlackPct +10, dwellingsOver4 +6 all move the way that
predicts. It amplifies a defect this file already lists as the remaining tone
outlier — a steep pitch gets neither direct sun nor sideways skylight — and
the roof batch is the one batch in the renderer with **no `toneFloor` at all**,
while props carry 0.12 and the laundry 0.30.

**The full ledger for the two types, every row A/B'd by building both sides:**

| metric | before | after | |
|---|---|---|---|
| residential character | 14 / 13 / 41% | **45 / 41 / 59%** | the point |
| town character | 49% | **52%** | |
| roofcheck openTops | 16 | **6** | free — a cottage always has a roof |
| provenance spireAtCap | 6% | **3%** | free |
| built coverage | 45% | 46% | |
| achievable frontage | 78% | 78% | unmoved |
| party walls | 93% | 91% | cost — 2x2 terraces less readily than 1x2 |
| clash deepClash | 15 | 19 | cost |
| odd overZ3 / bareWall | 21 / 10 | 27 / 14 | cost — two new proportions are new outliers |
| provenance habitablePinned | 11% | 13% | cost |
| traverse clamber | 64 | 67 | cost — see below |
| eyeball roofToWallMed | 63 | 68 | cost |
| eyeball roofBlackPct | 56% | 66% | **the one that matters** |

`traverse clamber` is the only one whose mechanism needed the tool's own
attribution as well as the A/B: the pairs split half at the water's edge and
half inland, and `noPass`, `reachPct` and `lowHead` did not move at all. A
building BLOCKS its footprint, so changing which buildings stand where exposes
terrain steps that were previously under a house. Nothing became unreachable.

**Three lessons, and the middle one is the expensive one:**

- **A metric moving against your prediction is not evidence the metric is
  broken.** That is the most tempting wrong turn available, because it
  explains any inconvenient number and costs nothing to assert.
- **Disabling a feature is only an isolation if disabling it changes nothing
  else.** In a seeded generator, adding a table entry perturbs the RNG stream
  whether or not it is ever chosen. The real A/B is checking out the earlier
  commit's source and building it, which is cheap and was available the whole
  time.
- **Do not re-baseline a metric whose noise floor you have not measured** —
  and having measured it, do not invent noise you did not find.

### AND BOTH TEMPLATES KEYED THEIR "LOW WALL" TO A NUMBER THAT WAS NOT LOW

The type mix said the feature worked. A photograph said otherwise, and the
tell was in the caption: `asset.mjs` reported a cottage as **4 floors**.

`tmplCottage` wrote `max(STOREY_HEIGHT * 1.15, ctx.wallH * 0.55)`, and
`ctx.wallH` is whatever the generic building height for that plot would have
been — so on a tall plot the "low wall" came out at 7.7m, and the rise, asked
for as `max(wallH * 1.05, span * 0.62)`, came out bigger still. A two-storey
house under an eight-metre black triangle: the exact defect `eyeball.mjs`
tracks, written deliberately into the template whose whole purpose was to
demonstrate the good version of it.

**A type with an intrinsic size must be pinned to a physical number**, the
rule `MAX_OVERHANG` and PropFactory's `physical()` already follow. Absolute
wall now, and the rise off the SPAN alone — keying any part of a rise to the
wall it sits on guarantees a roof taller than the house. Cottage wall 7.7m ->
3.9m against a row house's 9.9m.

The wash house's louvre sat at `wallH + rise * 0.72` under a comment reading
"sits ON the ridge", which on a hipped roof is well inside the cone. The
photograph came back with a plain apex: the one feature separating a wash
house from a shed, buried in its own roof. **A comment is not a test.**

### AND THE BOARD CREDITED THE TAXONOMY FIX AS A TEN-POINT WIN

`eyeball roofToWallMed` went 73 -> 63 and the harness printed `(-10 better)`.
It is not better. Running the OLD dwelling set against the SAME build reads
73, so **the entire move is the tool** — a different population, not a
different town. The baseline is re-saved at 63 as a population change rather
than banked as progress.

Two things worth keeping. First, this is the A/B-the-tool-separately rule
catching a change I had already congratulated myself for in a commit message
an hour earlier, in the very same session where I wrote that rule into THE
METHOD for the third time. Second, the direction is informative: dropping
`coach_house`, `potting_shed`, `sexton_hut`, `clergy_house` and
`building_medium` lowered the median by ten points, which says outbuildings
and quarter-signature types are markedly ROOF-HEAVIER than houses — a low
wall under a full pitch is exactly what a potting shed is. They were dragging
a metric about ordinary dwellings the whole time.

**A tracked metric that moves when you edit the TOOL must be re-baselined, not
celebrated.** The harness cannot tell the two apart and will always phrase it
as an improvement.

### DISTRICT CHARACTER 55% -> 86%, AND THE THREE THINGS THAT GOT IT THERE

Seven new building types (chandlery, customs_house, guardhouse, armory,
shambles, sail_loft, cookshop) plus one structural change, and the structural
change was worth more than all seven.

**A CAP AND A SECOND TYPE ARE ONE DECISION.** The small-exclusive-type pattern
has now worked twelve times and `MAX_PER_DISTRICT` is the other half of it —
without a cap the quarter becomes a monoculture, which is exactly what the
first run of this batch measured:

    market    36 buildings, shambles 22    61% of the quarter
    fortress  26 buildings, guardhouse 21  81%
    harbor    61 buildings, chandlery 27   44%

Every one read 89-100% "distinctive" and **the number is worthless, because a
quarter-exclusive type scores as characteristic however many you stamp — a
monoculture is the highest-scoring possible town.** Eleventh instance.

But the moment the cap BINDS, the quarter falls straight back on the shared
`row_house` it was given the type to escape: capped, market read row_house 11 /
shambles 10 and harbor read row_house 31 / net_loft 17 / chandlery 12. **The
caps have to SUM to the quarter**, which means two or three small exclusives
rather than one — which is also what a real quarter is. A market street is
butchers AND cookshops AND a weigh house.

**A TYPE IN OVER A THIRD OF THE TABLES IS INVISIBLE TO THE METRIC BY
CONSTRUCTION, AND IT IS THE ONE THAT WINS THE FIT LOTTERY.** `row_house` was in
SIX of eleven tables. `districts.mjs` counts a type as characteristic only if
it appears in at most a third of the quarters present, so the commonest
building in the town — 18% of all structures — could never say anything about
anywhere, and every quarter's character was competing against it, because a
1x2 gets more plots than any other shape. Removing it from market, artisan,
waterfront and harbor took character 55 -> 86 on its own, and it was **only
safe once each of those four had small exclusives of its own**; a batch earlier
it would have starved them the way the temple quarter halved.

### AND STREET WIDTH WENT 12m -> 15m AND CAME BACK — READ THIS ONE

DESIGN.md calls street width the single number separating a town from a field,
and this file already records the identical regression from the first district
arc. It reappeared, and **it was not the change I would have blamed.** The
row-house removal alone read 12m. What widened the street was the REPAIR: I
bumped `building_small` in the three quarters that had lost their 1x2, to buy
back the two points of coverage the split cost.

**A 2x2 slot where a 1x2 used to be is FEWER BUILDINGS ON THE SAME FRONTAGE.**
Coverage went up two points and the facades moved three metres apart. Reverting
the 2x2 bumps and raising the caps on the exclusive 1x2s instead — including
the smokehouse from 4 to 8, waterfront being the one quarter whose only 1x2 was
capped tight — gave the same coverage, the same character, and 12m again.

> When a quarter is short of buildings, give it more of the SHAPE it lost, not
> more of a bigger one. Coverage and street width both fall out of how many
> buildings meet the kerb, so a fix aimed at one through a larger footprint
> pays for it in the other — and the board prints them on separate lines as if
> they were independent.

**THE HONEST LEDGER:** character 55 -> 86, street width 12 -> 12, coverage
46 -> 44, party walls 92 -> 89, achievable frontage 73 -> 68. The frontage is
the real cost and it is the district trade this file already documents.

### HALF A FIX IS A FIX YOU WILL NEED AGAIN — tenancy's EXPLAINS table

`tenancy.mjs` kept a hand-written EXPLAINS table under a comment saying it
"mirrors the intent of getBuildingSpecificProps". Four lines below that comment
sat a note recording what the mirror had ALREADY cost once — `half_timber`
listed `firewood`, an id the game does not define — and the fix applied at the
time was to READ the dwelling set instead of restating it. **The other half of
the same table was left as a copy, and it drifted by twenty-one types**: the
entire small-exclusive-type arc went into the generator and never into the
mirror, so a quarter could be two thirds distinctive by its buildings and score
zero for the props saying so.

`tools/lib/taxonomy.mjs` parses the switch now and throws on a shape change.
A/B'd as a TOOL change against the old build first, per the rule: 42% -> 44% is
the correction. **The content moved it by zero**, and the reason is the
sample-resolution lesson — dwellings host most of the town's props, so twenty
new types are too small a share of the population for the aggregate to see.

Same session, the same shape one file over: `getBuildingSpecificProps` itself
returned `[]` for twenty-one types, and `isTradeBldg` was **seven inline `===`
comparisons** untouched since any district type was added, so a chandlery, a
shambles and a weigh house could not carry a hanging sign — the butchers' row,
the one street guaranteed a sign over every door, had none. **A list of literal
ids IS the pattern; grep it the same day.** It is a `Set` now. shopSign 16% ->
20%.

### TWO INDEPENDENT FAILURES CAN AGREE ON "INVISIBLE"

The chandlery's cat-head hoist beam — a 1m stick out of the gable, the type's
whole silhouette — was absent from the photograph for TWO reasons at once, and
either alone would have produced the same empty frame:

- `roofAxis` names the axis the ridge RUNS ALONG, so a ridge along Z has its
  gables on Z. I had the beam projecting on the perpendicular, onto a party
  wall, where `clipToFootprint`'s per-side allowance correctly removed all of
  it. Settled by reading `tmplSmokehouse`'s vent, whose length is taken from
  the ridge axis, rather than by reasoning about it — the second time this
  session that reasoning about an axis got it backwards.
- It was 0.42m beyond `MAX_OVERHANG` regardless, so the clip would have shaved
  it even on the right face.

**A count of volumes emitted would have said the beam was there.** The
photograph is what found it, and `provenance.mjs --def=chandlery` is what
verified the fix — 24 volumes over 12 buildings, 0 clipped, 0 outside the box —
rather than a second round of camera-hunting.

### THE ROOF ORNAMENTS HAD NEVER BEEN COUNTED, AND THE FIRST CENSUS READ 125%

`BuildingFactory` tallies twenty-one wall features into `featureCounts` and
`VolumeRenderer` — which owns dormers, finials, spire crosses and weather vanes
— had no `tallyIn` at all. Four pieces of vocabulary that could have been
firing at zero with no way to find out, which is the `featureCounts`-with-no-
consumer situation whose first census found five near-dead features.

The first cut tallied per VOLUME against a per-BUILDING denominator and read
dormer 115%, finial 125%. **A rate above 100% is a free bug report about the
measurement** and this is the second instance of that exact tell (doorstep read
182%). Fixed with a per-building `ornamentSeen` Set.

    dormer 38%  finial 26%  weatherVane 16%  copperCap 13%  spireCross 3%

The `copperCap` is DESIGN.md pillar 2's sixth distinguishing feature — "a
crooked chimney, a copper-top cap, a different roof pitch, a balcony, a
window-box, a taller-than-neighbours profile" — and the only one of the six
never built. A verdigris shell over the top 30% of a spire, which is the one
ornament that changes a spire's COLOUR rather than its outline, so two
identical spires separate across a skyline where a finial cannot.

### THATCH, AND WHY IT LIVES IN Materials.ts

Every roof in the town came out of one palette slot, so pillar 2 was being
fought with SHAPE alone while the largest surface on the building stayed a
single colour family. Thatch is keyed by TYPE and not by district: real towns
banned it after their first fire and it survived on the humble and the rural,
so a cottage keeps it and a shop does not, and the eye reads that as age
without being told. **A district gate would paint whole quarters uniformly,
which is the wallpaper failure.** None of the odds is 1.0 — a terrace of five
identical thatched cottages is the copy-paste pillar 2 exists to prevent. 6% of
buildings, spread 0-13%.

`src/renderer/renderer3d/Materials.ts` exists because **TWO renderers draw
roofs** and the pixel-art export picks its palette independently. A copy would
give the walkaround thatched cottages and the export tiled ones with nothing
erroring — the terrain-table drift, one surface over. Both callers hand in
`stableHash(obj)`, so a roof is the same material in both paths.

The colours were chosen by what weathered straw IS, not by `roofBlackPct`: they
happen to lift that number and **the moment it becomes the reason, the roofs go
pale everywhere and pillar 1's dark silhouettes go with them.** Same discipline
the roof tone floor was chosen by.

### A HEALTHY AGGREGATE CAN HIDE A POPULATION IT NEVER REACHES

Eighteen vignettes and not one listed `temple` or `cemetery` in its district
gate, so the only groups those quarters could ever draw were the five
`home: true` ones — and a cathedral close is chapels, bell towers, clergy
houses and mausolea, barely a dwelling among them. **Two whole quarters got the
scatter and nothing else, while the vignette census reported a healthy
town-wide rate.**

That is WALLPAPER'S TWIN. Wallpaper is a feature firing everywhere equally;
this is a feature with a healthy mean that reaches none of some population.
`features.mjs` reports SPREAD across districts for exactly this reason and the
vignette census does not, because `vigOk` is one counter. Four groups added —
`shrine`, `graveside`, `stoneyard`, `guardpost`. **Whenever content is gated on
a list, census the members of the list that the gate never names.**

### RESIDENTIAL HELD 10 OF 35 POOL POINTS ON EVERY DRAW

The whole small-exclusive-type arc builds vocabulary for eleven quarters, and
`quarters.mjs` — the tool that asks which quarters a town gets AT ALL — said
most towns never show it:

    over 12 seeds:  residential 12/12  market 12/12  slum 7  waterfront 7
                    temple 6  harbor 5  garden 4  cemetery 4  artisan 3
                    noble 2  fortress 2

The frequencies do not track the weights at all — artisan is weight 6 and read
3/12 while slum is weight 3 and read 7/12 — and the reason is that
`residential` is the one type allowed to REPEAT and is never removed from
`avail`. It holds 10 of 35 points on every single draw, 29% of every free
slot, and a town only ever has three or four free slots after market and the
site-earned water quarter. Forcing it once at the second-most-central centre
(where the ordinary fabric belongs) and halving its repeat weight took
**artisan 3 -> 9, cemetery 4 -> 7, noble 2 -> 4**, with coverage 44 -> 48 and
achievable frontage 68 -> 75 as a side effect.

**A repeatable entry in a weighted pool is not one entry, it is an entry on
every draw.** Removing a used type is what makes the other weights mean what
they say, and the one exception silently became the dominant term.

### MORE DISTRICT CENTRES: TRIED, MEASURED, REJECTED — do not re-run it

The obvious follow-on is more quarters. Changing only `numDistricts`, twelve
seeds:

| base | street width | coverage | frontage | quarters/town | noble |
|---|---|---|---|---|---|
| `4 + c*5` | **12m** | 48 | 75 | 5.8 | 4/12 |
| `5 + c*5` | 15m | 48 | 73 | 6.3 | 7/12 |
| `6 + c*5` | 15m | 45 | 74 | 7.1 | 10/12 |

Ten of twelve towns with a noble quarter is a real gain and it costs the one
number DESIGN.md calls decisive, for the third time in this file: sparse
specialised quarters put their facades further apart, so more of them is more
of that. The table is in the source beside the constant so the next session
does not spend an hour rediscovering it.

### A 1x1 FITS EVERYWHERE, AND I DIAGNOSED THE OVERSHOOT WRONG FIRST

The dovecote came out at **54 of a 63-building garden quarter — 86%** — and
scored the quarter 97% distinctive for it. Twelfth instance of the pattern
overshooting into monoculture and the most extreme, because real odds are the
weight times how often the shape FITS and one tile fits every leftover cell.

The diagnosis is the lesson. Looking for the leak found a real one:
`pickTypeForSpace` counts ONE instance against `MAX_PER_DISTRICT` and returns,
and the courtyard-side placer then stamps that same type along the whole side
in a `while` loop — so a 2x2 leaked three or four and a 1x1 leaked as many as
the side was long. That is the **fifth** enforcement site, after the four
CLAUDE.md already lists, and "a gate enforced in four of five paths is not
enforced" still holds. Fixed, rebuilt, and the number was **byte-identical**.

The actual cause was that the cap edit had never applied: its anchor string
had been changed by an earlier edit in the same session, so `dovecote` was
simply absent from the table. **Verify the edit landed** — the leak was real,
the fix is kept, and it was not the cause of anything measured.

### A METRIC NAMED AFTER ONE QUANTITY AND EXTRACTING ANOTHER

The board's `roofToWallMed` was reading the SILHOUETTE block — everything
stacked above the main body, its roof plus any tower or spire promoted onto it
— because `eyeball.mjs` prints two `p10 .. med ..` lines and the harness regex
was unanchored and took the first. eyeball's own comment three lines from that
print says exactly this: *"it is not the roof, and capping roof rise moved it
by one point while I was expecting it to move by fifty."* The board carried
the wrong quantity under the roof's name anyway.

It cost an attribution. Five new templates had their roof rise nearly halved
and the row moved by ZERO, which reads as "the fix did nothing" rather than
"the board is looking somewhere else". Both are extracted now, anchored on
their labels, and `stackedMed` is `dir: 0` because a promoted tower is a
design decision and not a defect.

**And the other half of that zero is the population.** `eyeball` grades
ORDINARY DWELLINGS, read from `DWELLING_TYPES` — and not one of the twelve
district-exclusive types is in it, so a roof-pitch change on them is invisible
to the metric by construction. What actually moved `roofToWallMed` 67 -> 84
was confining `row_house` to two quarters, which changed WHICH dwellings the
tool sees. The pitch fix was verified instead with
`provenance.mjs --def=shambles`, which reports rise as a fraction of span and
read 0.31-0.34 against the 0.52-0.64 it was asking for before.

**A shambles, a chandlery and a cookshop are shop-HOUSES** — the trade below,
the family above — so they arguably belong in `DWELLING_TYPES`. That is a
population change to four tools at once and would need re-baselining as a TOOL
change, not banked as progress; left alone deliberately.

### PINNING A TYPE TO A PHYSICAL NUMBER ALSO PINS AWAY ITS VARIATION

Every new template takes an ABSOLUTE wall height rather than `ctx.wallH`, which
is right — a type with an intrinsic size must not inherit whatever the plot
would otherwise have carried, and the cottage cost two rounds learning it. But
**`ctx.wallH` is where the per-instance jitter lives** (`hScale` 0.85-1.15 in
BuildingFactory), so ignoring it throws the jitter away as well, and twelve
capped shambles in a market quarter came out at identical heights.

`variety.mjs` caught it — twinNear 7% -> 23%, the axis `odd.mjs` is blind to by
construction — and named `workshop` and `smokehouse` as the worst offenders,
three pairs each within three metres. **Widening the height ranges alone moved
it two points.** What moved it was a SECOND ROOF SHAPE: variety keys on type +
volume count + roof styles + every dimension within 5%, so a row of one capped
exclusive has one silhouette however wide its height range is. Half hipped and
half gabled halves the matching population outright, and it is what a real
street looks like — the same trade, built at different times.

`steep` and `pointed` are deliberately not the alternative: both are in
SPAN_PITCH, `ensureRoofPitch` floors them far above any deliberate ask, and
every instance would pin to the same value — the failure being fixed, wearing
a different hat.

**And fixing only the types added this session moved the aggregate by ZERO
while the composition shifted underneath it.** `workshop` and `smokehouse`
predate the arc and carried the identical defect. 23 -> 21 -> **14** once the
siblings were swept.

### A CLUSTERED PRIORITY LIST WILL EAT A SHARED BUDGET, AND THE FIX IS BOTH ENDS

`particles.mjs` read chimney smoke covering 0.30 of the town's x-extent, down
from 0.64. Two causes and both are general:

- **The always-smoking types are CLUSTERED by construction** — cookshops in the
  market, smokehouses on the waterfront, kilns in artisan — so reserving ten of
  the sixteen particle chimneys for them put all the smoke in two quarters.
  A priority list is a spatial claim when its members share a district.
- **The budget was TRUNCATED, not sampled.** The collector walks the structure
  layer in placement order, which is spatially clustered because the placer
  works outward from the road network, so taking the first sixteen took sixteen
  chimneys from one part of the map. Farthest-point selection, seeded by
  whatever the priority pass took, is O(n x 16) and costs nothing.

**0.30 -> 0.96**, better than the 0.64 it started at. Nothing else in the
harness looks at a particle, which is exactly why that tool exists.

### A VOLUME THAT PROJECTS PAST ITS FOOTPRINT IS NOT COVERED BY THE PLINTH

The stair-step foundation spans footprint TILES, so a pier, a column, a
buttress or a chimney breast standing proud of the footprint rectangle hangs
above the ground next door on any slope — `clash.mjs` reports it standing on
air and is right to. Footing such a volume 0.35m below grade is true of real
masonry and cheaper than a special case. And a flat-topped trim volume with
nothing stacked on it is an OPEN BOX: nine cookshops a town with a flat cap
course on the flue took `roofcheck` up 20. A chimney cap is ridged and a
buttress weathers to a slope, both of which are the same fact from the other
side.

### A LANTERN GOES WHERE THERE IS A REASON FOR ONE

Wall lanterns fired at a flat 18% of every building — WALLPAPER by this repo's
own definition: a rate identical everywhere reads as healthy and
differentiates nothing, and DESIGN.md pillar 5 asks for three layers of warm
light, not for them to be sprinkled. A lantern over a door is ADVERTISING
before it is lighting: an inn that is open says so with a light, a shop does it
when it trades late, a gate lodge marks the entrance it exists to mark, a house
does it occasionally. Weighted by type in `LANTERN_BY_TYPE`, landing within a
point of 18% town-wide — a redistribution, not more light.

### A PRISM ROOF CROSSES ITS SHORT DIMENSION

Every new template took its rise as a fraction of `(footW + footD) / 2`,
copying the idiom around it. On a 1x2 that average is 4.5m against a real span
of 3m, so an innocent 0.55 was a 62-degree pitch and a 2.6m roof over a 3m
house. `ensureRoofPitch` uses `Math.min(w, d)` for exactly this reason and
floors gabled at 0.42 — ask against the same quantity the floor uses, or the
floor and the ask are not speaking the same units.

### HOW TO FIND AN 0.8m THING IN A STREET PHOTOGRAPH — tools/lib/vantage.isolate

Four rounds went on hunting one garment in a frame of five hundred meshes, and
each failure is a named trap this file already contains:

- Two occlusion searches, the second reporting **all 192 bearings blocked by
  the subject occluding itself** — the aim point is the box CENTRE, which sits
  inside the cloth. `lib/vantage.mjs` documents fixing exactly this for bridge
  parapets, and I reproduced it by hand-rolling a camera rather than reading
  why that one is shaped the way it is.
- A screen-coverage ranking that was EXACT and unusable: three.js walks a
  213k-triangle merged mesh triangle by triangle, so 49 rays across 20 cameras
  never finished. Exactness is not free.
- A cluster step that compared each garment to the running MAX corner, so the
  corner drifted a little every merge and one "line" chained across 100m of
  town. The camera was aimed at a meaningless centroid.
- **My own instrument's two halves disagreed about the vertex stride.**
  `garments` divided triangles by 12 — equivalent to 36 vertices, which is
  what a de-indexed box actually is — while the box loop stepped by 24. Every
  measured garment was a two-thirds slice or a straddle across two, which is
  where `width max 51.68m` came from. **A number above a ceiling the code
  enforces is a free bug report about the measurement**, and it was also the
  reason every camera aimed at a chimera.

`isolate(win, meshName)` hides everything else and answered it in one shot.
The pair is what you want, and taking only the first is what let a
byte-identical before/after pass as evidence for most of a session:

    hidden vs visible   proves the subject IS in the frame
    subject alone       says WHERE it is and what shape it really has

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

### THE THREE ART-DIRECTION FIXES, AND ONE OF THEM WAS AIMED AT A PHANTOM

All three measured before and after on seed 31337.

**TONE — worked.** Ambient 0.42 -> 0.62, hemisphere 0.52 -> 0.95 (skylight is
the term a wall in a street actually sees), and the paving pulled down from
0xb09878 to 0x9c8770 because the RATIO was the defect, not either number alone.

Measured as a clean A/B — the pre-fix `src/` checked out, built, and shot from
the same vantages, then HEAD built and shot again, rather than two runs a
session apart:

    surface   before                  after
    wall      0.068  (44% black)      0.203  ( 8% black)
    roof      0.045  (61% black)      0.087  (33% black)
    other     0.031  (62% black)      0.085  (41% black)
    ground    0.646                   0.675

**Walls read three times brighter and the share of them that is effectively
black went 44% -> 8%.** Roofs nearly doubled with the black share cut from 61%
to 33%, and props — the "other" row, a barrel that was a dark lump and is now a
barrel with staves — nearly tripled. The ground:wall ratio went **9.5x -> 3.3x**.

The ground still rose slightly despite the darker paving, so the skylight lift
outran it; p90 0.700 is close enough to clipping that the next move is more
paving and less ambient, not more of both. Roofs at 33% black are the remaining
outlier: a steep pitch gets neither the direct sun a flat roof gets nor the
sideways skylight a wall gets.

**THE ROOF CAP — the roofs were fine and my metric was wrong.** `clampRoofToWall`
is in (a third clamp, applied last, after the span floor and the span cap) and
it does trim the tail — max roof is now exactly 170%, which is `pointed`'s cap,
so it is binding. But the p90 313% I reported as a roof was never a roof:

    main body's own roof / its wall     p10  0%  med 41%  p90  85%  max 170%
    EVERYTHING stacked above it / wall  p10 32%  med 75%  p90 333%  max 412%

`eyeball` computed apex minus wallTop, which counts a TOWER or SPIRE sitting on
the building as well as its roof. A real gable is 30-50% and the median roof
here is 41% — textbook. **The black triangles are stacked volumes, not
oversized roofs**, which is the landmark promotion (28% of generic buildings
get a dramatic vertical template) that I noticed early and then talked myself
out of. Corrected in the tool: it reports both, labelled.

**THE COLUMN INSET — aimed at an artefact.** `facadeOpenings` now keeps its
outermost column clear of the corner post, which is harmless and mildly right,
and it changed nothing: posts still read 40 crossings at "92% coverage". The
92% was arithmetic on a sliver — `uW = WIN_W_M / quantizeWallM(width)` times
the volume's REAL width paints a 13cm "window" on a narrow volume, and a 13cm
post covers 92% of it. Excluding openings under 0.45m — too small to read as a
window at all — the worst post coverage is **13%**, a corner post grazing a
reveal. The defect was in the denominator.

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

### THE FOURTH AXIS — geometry against the TEXTURE (tools/facade.mjs)

Reported plainly: "every time I generate a world I see things like lumber
beams crossing over window and door textures", and "the shop awnings never
look right; like the angles for the main piece is wrong". Both correct, and no
instrument here could have found either — `clash` compares solids, `odd`
compares peers, `provenance` compares geometry to the code. **None of them
knows where the windows are, because the windows are not geometry.** They are
painted on a canvas that gets stretched over the wall.

So a wall has two independent authors and nobody had introduced them:

    FacadeTexture    paints openings on a ~2.4m column pitch (facadeOpenings)
    BuildingFactory  nails studs on a 1.7m bay pitch, full height

Two grids that do not divide each other, so they beat. Measured: **315
crossings on 31 of 66 timber-framed buildings** — 207 studs over windows, 78
over doors, 30 awnings over windows.

FacadeTexture's own comment already says the 3D window TRIM must quantise
IDENTICALLY to the texture or the lintels land on the wrong columns, and
VolumeRenderer obeys it by calling `facadeOpenings` itself. **The timber frame
is the sibling that never got the same treatment.** Studs now come from the
wall MINUS its openings: take the gaps, stand a stud in the middle of the
widest ones. 315 -> 10.

**And the threshold I first chose excluded the exact defect I was hunting.**
The first cut asked what FRACTION of an opening a member covers, with a 12%
floor — and an 8cm stud across a 90cm window is 9%, so it reported ZERO stud
collisions. The question is not how much it covers, it is whether it crosses
the GLASS rather than butting the reveal.

**And the first audit measured a fifth of the frame.** It recorded studs and
awnings, because those were the two I happened to instrument — 118 members
across 66 buildings, which is 1.8 each on walls that carry four corner posts,
two head plates, a floor beam per storey and four braces. Recording all of them
took the count 118 -> 550 and the true collision figure to **368**, with the
studs I had already fixed sitting fifth on the list:

    146  brace across window       worst covers 100%
     96  floorBeam across window   worst covers 100%
     86  brace across door
     30  post across window
      9  stud across window        (was 207 before the stud fix)

The floor beams are the same two-grids failure rotated ninety degrees:
`floorH = v.height / volumeFloors(v)` is not the quantity `facadeOpenings` lays
its ROWS out on, so a full-width beam at every floor line walks across a window
exactly as the studs walked across a column. Beams now sit in the gaps between
opening ROWS, the head plate lifts clear of the top row, and a brace — pure
decoration — is simply not nailed on when it cannot clear the glass.
**368 -> 49.**

**One of the remaining 49 was my instrument again.** `post across door` read 50
hits on ONE building: the door was being recorded for EVERY framed volume, but
FacadeTexture paints one only on the main body, so a tower's corner posts were
crossing a door that does not exist on it. A tool's two halves have to count
the same population and this half was inventing members of it.

The awning was three bugs stacked, and reading the code found all three before
the instrument ran:

- **The slope sign was inverted.** `rotateX(t)` sends `(y,z) -> (y cos t - z
  sin t, ...)`, so a strip translated to +Z and rotated by a NEGATIVE angle has
  `y' = -z sin t = +6.6cm` — the front edge went UP, while the comment
  immediately above it said "~7 deg down at front edge".
- **The post height inherited the same sign**, subtracting a drop that never
  happened, so the posts fell ~16cm short of the canvas they hold up. A second
  piece of code derived from a wrong assumption turns one sign error into two
  visible defects.
- **It hung at 2.0m against a door FacadeTexture paints 2.05m tall**, so the
  canvas sliced the top off the doorway and crossed the ground-floor glazing.
  An awning goes over a shopfront, not through it.

### AND THEN MOST OF WHAT IT WAS REPORTING WAS THE INSTRUMENT

The 49 that pass claimed, and the 48 the harness tracked, were mostly phantom.
**The real figure was 8**, and finding that out found three defects the tool
was structurally incapable of reporting. Take the ledger in order, because each
step only became visible once the one before it was fixed.

**The audit was comparing walls that are not the same wall.** The wall-local
frame — x from the wall's centre, y above its base — belongs to a VOLUME, and
`facadeParts` was keyed by `obj.id` alone. So it cross-multiplied a tower's
members against the main body's windows on planes metres apart, and a
full-width head plate "covered 100%" of a window it cannot reach. **48 -> 8
with no change to the town.**

The tell was arithmetic and not a picture, which is the transferable part:
BuildingFactory's own `_clearsOpenings` guard is a bare AABB overlap with no
reveal tolerance, so it is STRICTLY HARSHER than the audit's glass test and a
member it passes cannot fail the audit. It was passing members the audit called
dirty. **When the stricter of two checks says clean and the looser says dirty,
they are not looking at the same thing.** Same defect as the phantom door one
level down: there the wrong buildings, here the wrong walls inside one.

**Then the honest 8 named a much larger defect sideways.** Every one was a
corner post grazing 11% of a window, on a wall keyed `wing@...,1.20` — a wall
1.20m wide carrying a window painted x[-0.60,0.60]. Corner to corner. Two
independent causes, and neither is a collision:

- **`uW = WIN_W_M / wallWm` is a fraction with no ceiling**, and both ends are
  1.0 at the bottom of the range: WIN_W_M is 1.0m and `quantizeWallM` floors at
  1.0m. Every volume 1.25m or narrower took a window as wide as its whole wall,
  at every storey. A window needs a PIER either side; if one will not fit, the
  wall is too narrow to be pierced, which is what a narrow outbuilding
  elevation actually is.
- **`clipToFootprint` SHAVED where it should have SLID.** The clip must run
  last — that ordering is what took 39 volumes-outside-the-box to 0 — but
  "last" decides WHEN, not HOW. A volume hanging off one edge lost everything
  past it, floored at 0.1m, so a 2.6m wing pushed out by wealthScale came back
  a **1.20m x 10.49m splinter**: an aspect near 9:1 on an ordinary row house.
  A volume that FITS the box and merely sits in the wrong place does not need
  to lose anything, it needs to MOVE. Sliding is a restoration rather than a
  distortion here, because the templates author a wing flush inside the
  footprint and it is wealthScale that walks it out. Shaving is kept for the
  case it was written for: a volume genuinely wider than the box.
  **`deepClash` 118 -> 91** — the splinters were CAUSING collisions, not
  avoiding them, which is the opposite of what I expected from the change.

**Then the sibling, one axis over, found by asking the same question
vertically rather than by any new measurement.** `floorsThatFit` is
`max(1, ...)`, so a wall shorter than a storey still gets one, and the lowest
window's head sits at a fixed `SILL_M + WIN_H_M` = 2.30m. A 1.5m outshot was
painted with a window **0.80m above its own roofline**. `uW` and `vH` are the
same unclamped `size / wall` fraction written twice.

**None of those three is a COLLISION**, so a collision count could never have
named any of them — it reported the first two as "a post covers 11% of a
window", which is the small half of the finding, and the third not at all. The
tool now asks the question with no threshold in it: **is the opening actually
ON the wall?** Exact, no tolerance to tune, and it immediately found a fourth:

    OFF THE WALL — 44 painted openings fall outside the wall they are on
        29 x  door off a ~3.4x1.6m wall   (precinct_wall, precinct_wall_v)
         6 x  door off a  3.9x1.7m wall   (bridge)

A 2.05m door anchored at `doorY = h - doorH` on a 1.45m boundary wall is drawn
from above the canvas and CLIPPED, so it fills the wall top to bottom with its
head cut off. A churchyard wall with a front door every metre, and a bridge
with six. **That is the THIRD instance of `role: 'mainBody'` carrying two
meanings** — "the principal volume" and "a room, so apply the habitability
rules" — already fixed for SIZING with `Volume.habitable = false`. The door
kept reading the role. `FacadeConfig.hasDoor` derives from the same
declaration, and **the REAR elevation had the identical bug written out a
second time**; the audit records only front openings and could not have found
that one. The sibling sweep did.

Two fixes to the instrument itself, both the same shape as the bugs above:

- **A kind with no collisions and a kind that was never recorded read the
  same.** The colonnade was instrumented and predicted to beat against the
  windows on a third grid; the report came back with no `column` line at all,
  and nothing distinguished a clean result from an uninstrumented one. That is
  the GHOST failure sitting inside the instrument built to find ghosts, and it
  is `featureCounts` with no consumer all over again. The census says the
  prediction was **wrong**: 8 columns, 1 entablature, zero collisions — and
  one colonnaded building in the seed is too small a sample to close it either
  way, which the census also makes visible.
- **Opening recording lived inside `if (wantsTimberPosts)`.** A quoined stone
  elevation paints its openings through the same function and nothing had ever
  looked at them. That is the "measured a fifth of the frame" mistake — the one
  that took members 118 -> 550 — sitting unnoticed on the OPENINGS half of the
  same tool. **74 buildings -> 161, 235 walls, 1319 parts.**
- `--all` was a declared-and-never-read flag, a ghost in the tool's own CLI.
  Printing each hit's geometry is what turned "a post covers 11%" into "the
  window is the whole wall" — **a count tells you a class exists; only the
  numbers tell you whether the member is a hair over the reveal or straight
  through the glass, and those want opposite fixes.**

Final: **overOpening 0, offWall 0**, on more than double the population ever
audited before.

### THE LARGEST ANOMALY CLASS IN TOWN WAS A GROUND FLOOR AUTHORED BLANK

`odd.mjs` read `bareWallArea` as **36 of 42 findings over z=3**, up to 109m² of
flat untextured colour against a peer median of ZERO, on shops, bakeries and
row houses all reading `2 volumes, 1 textured`. The arithmetic named it in one
step: 109m² over a 32m perimeter is a 3.4m band, which is
`tmplJettiedUpper`'s lower body.

**It was authored `textured: false` on the reasoning that the body under a
jetty is structural and hidden.** The jetty OVERHANGS it; it does not conceal
it. That is the storey at eye level — the one the player walks past, and on a
shop it is the shopfront. A blank one is a grey slab exactly where the 30ft
read happens. `tmplGatehouse`'s chamber over the archway was the same call and
the same answer: a room between two towers takes a facade. Only the bridge,
footbridge and boundary-wall templates are genuinely masonry, and those declare
`habitable: false` as well, so the two questions finally agree.

    bareWallArea over z=3    36 -> 10
    odd overZ3               42 -> 27      (baseline 32; the flagged
                                            "regression" is now resolved)

Swept while there: **seven templates still divided a height by `0.9`** to get a
floor count, the pre-rescale divisor this file already records fixing in
`tmplTallTowerHouse` — one instance found, seven left standing. Nothing drew
wrong, because `volumeFloors` refuses an explicit count implying a storey under
2.2m and recomputes, but the number lands in `scaleSamples` and **a dead number
in a diagnostic sends the next person after the wrong bug**. A bug in a gate is
a bug in a PATTERN; grep the siblings the same day.

### AND YOU HAVE NEVER WALKED ON ONE — tools/traverse.mjs

Asked how the bridge discovery should improve the harness, with the suggestion
"player pathing awareness". Correct, and testing the idea immediately showed
the bridge fix above was **incomplete**. Standing on a bridge tile:

    deck top   4.95   4.89   4.89
    terrain    2.71   2.57   2.59      the river BED
    you are on 2.71   2.57   2.59      the river BED

`sampleGroundY` reads `terrainHeightMap` and nothing else, so **no structure is
ever a walking surface** — not a bridge, not a stair, not an elevated walkway.
A previous session read the `passage` tag and cleared the collision mask over
crossings, which is half the fix and the half that is visible; the other half
is that once you are on the tile the ground-follow puts you on the bed. **Two
authors of one floor**, exactly the shape of FacadeTexture versus
BuildingFactory, and nothing had ever held them up against each other.

**The general point is that every instrument here grades the world against
ITSELF** — provenance against the code, odd against its peers, clash against
its neighbours, facade against the texture, eyeball against the frame. None
grades it against the PLAYER'S BODY, and the bridge passed all five while being
unusable. `spawn.mjs` models the player for exactly one frame.

`traverse.mjs` asks four questions and they triangulate:

| | 4242 | 777 | 31337 |
|---|---|---|---|
| crossings you cannot walk through | 4/11 | 10/20 | 11/16 |
| reachable from spawn, human step | 85% | 84% | **58%** |
| ...ignoring height (mask alone) | 85% | 97% | 96% |
| tile pairs needing a clamber | 7 | 68 | 66 |
| walkable tiles under 1.9m headroom | 4 | 35 | 37 |

The chain: `passage` clears the tile, so the MASK reads 96% connected; the
ground-follow drops you to the bed; bank-to-bed is ~2m; no person makes that
step; **39% of the town is unreachable**, the largest pocket 479 tiles across
the river.

Three design points, each of which was wrong in the first cut:

- **The first version of check 1 was a heuristic, not a measurement.** It took
  each structure's widest volume as "the surface it meant you to walk on" —
  true of a bridge, whose deck IS that volume, and nonsense for an archway,
  where the widest volume is the arch 20m overhead and the way through is the
  hole underneath. It reported six archways with "a deck over your head".
  CLEARANCE needs no such guess: a bridge reads 0.4m and an archway reads its
  opening, same arithmetic, no notion of what the thing is.
- **The reachability number needs a CONTROL or it cannot be attributed.**
  Running the same flood fill with no step limit separates "cut by terrain"
  from "disconnected in the mask", and the two seeds differ: 4242's shortfall
  is mask (85% = 85%) while 31337's is entirely the step. Without it I could
  not tell a real severance from a step threshold I chose.
- **"Cut off by terrain" is not an answer until you know WHERE.** Splitting the
  steep pairs by water adjacency gives 55 at the water's edge against 11
  inland, which names the bank-to-bed drop rather than leaving it as hills.

It also found a second, unrelated defect: the `passage` tag clears the whole
FOOTPRINT, so a town gate's solid tower legs are walkable — 0.43m of clearance
inside the masonry. A tag that means "there is a way through here" is being
read as "all of this is a way through".

**Grade it against a person, not against the engine.** `updateCamera` snaps the
camera to `sampleGroundY` every frame and has no step limit at all, so the
engine itself permits ascending a cliff. That is a finding, not a standard.

### AND THEN A STRUCTURE BECAME A FLOOR

Given the choice between teaching bridges to write their deck into the height
map (cheap, bridge-only, leaves stairs broken) and making structures walking
surfaces (the general answer), the second. Four pieces:

- **`Volume.walkable`** — declared per VOLUME by the template, for the reason
  `habitable` exists. `passage` cannot answer this: it is true of a bridge you
  walk OVER and an archway you walk UNDER. Only the template knows which of
  its pieces is the deck, and a roof can never become a floor by accident.
- **`walkSurface`**, a per-tile map built from the walkable volumes after
  `buildBuildingMeshes` — the geometry does not exist before then, which is
  why the collision mask could never have done this itself.
- **`terrainYAt` split from `sampleGroundY`.** The terrain query keeps its own
  name and `debugHeightAt` keeps calling it, because `__pt.heightAt` means THE
  GROUND to river.mjs, relief.mjs, rivershot.mjs and bridgeshot.mjs. Folding
  decks into it would have redefined that word for five tools at once — the
  terrain-table drift, one level up. Players get `standAt`.
- **Solid geometry under a `passage` tag re-blocks its tile.** The tag clears
  the whole FOOTPRINT, so a town gate's tower legs were walkable at 0.43m of
  clearance inside the masonry. "There is a way through here" is not "all of
  this is a way through".

| | before | after |
|---|---|---|
| crossings you cannot walk through | 11/16 | **0/16** |
| reachable from spawn | 58% | **95%** |
| what the step limit costs | 39% | **0%** |
| steep pairs (at the water) | 66 (55) | **27 (13)** |
| tiles under 1.9m headroom | 37 | **0** |
| largest unreachable pocket | 479 tiles | 23 |

**The tool had to be taught the fix or it would have graded it against the old
surface.** traverse.mjs read `heightAt`, which is terrain; a walkable deck is
invisible to it. It reads `standAt` now and prints a WARNING when the bundle
is too old to have one — a missing measurement must not read as a pass.

`tmplFootbridge` carried the identical bed-relative bug and was fixed by the
sibling sweep rather than by a second measurement: `deckY = 1.15` up from the
bank, trestles at `bottomY: 0`. A bug in one template is a bug in the PATTERN,
and the two crossings are the pattern.

### A BRIDGE WAS A DAM WITH AN UNREACHABLE WALKWAY ON IT

Reported from the device: "you modeled them as a walkway with pillars into the
water which is normal, but the whole assembly from the base of the pillars
starts at ground level and not river bed level, so the walkway is above the
human scale head." Correct, and the measurement found it worse. One bridge:

    plinth    11 columns   y 2.58 -> 4.68   the river, filled to bank height
    mainBody   6 piers     y 4.68 -> 6.42   piers standing on that fill
    trim       3 pieces    y 6.42 -> 7.47   deck 1.85m above the bank

**One root cause and three symptoms.** `wy` — the Y a building is placed at —
is the MAX terrain height across its footprint, "so the building sits on the
highest ground covered" with a stair-step plinth filling under the rest. Right
for a house on a slope and exactly wrong for a span, because the highest tile a
bridge covers is the BANK. `tmplStoneBridge` then measured `deckY = 1.85`
UPWARD from there — its comment said "clear of the waterline with headroom for
a skiff underneath", and that headroom is real but belongs BELOW the deck, not
above the bank. The plinth, gated only on `maxTH - minTH > 0.08`, poured stone
into the gap underneath.

**The value it needed already existed.** `MassingContext.groundDrop` is the
maxTH/minTH pair BuildingFactory already computed to size the plinth; it simply
never reached the templates. Same shape as `PlacedObject.footprint`,
`BuildingTop` and `frontWallZ` — when a whole category of work keeps not
happening, look for the handle it would need.

Piers take a NEGATIVE `bottomY` and descend to the bed; the deck lands a 0.22m
camber above the bank, because a real bridge rises to its crown and a step you
can take is the point.

**The plinth exemption is DERIVED, not a type list**: if the massing already
sends a volume below the placement base it has taken responsibility for the
drop. That meant moving the plinth emission to AFTER `pickMassing` — it ran
first and therefore could not ask the one question deciding whether it should
exist at all.

| | before | after |
|---|---|---|
| climb from bank to deck | 2.20-2.40m | **0.34-0.58m** |
| decks above a 1.6m eye height | 6 of 6 | **0 of 6** |
| piers stopping short of the bed | 6 of 6 | **0 of 6** |
| plinth columns in the channel | 11 each | **0** |

**And no instrument here could have found it.** `bridgeshot` photographed the
span and printed the tiles under it, `river.mjs` measures the channel, `clash`
asks whether a thing stands on the ground. None asked how far you must CLIMB to
get on — the first thing a person on the bank notices. It does now, and the
first cut of that check measured the assembly BASE, read 0.13-0.38m, and would
have passed all six: the base IS near bank level; everything above it was not.

**A FOUNDATION IS NOT A BUILDING THAT SANK.** Fixing it lit up `clash buried`
6, all six bridges — an abutment is founded ~2m into the bank, which is what an
abutment is. Exempted by the same `descends` declaration, NOT by widening SINK,
and still printed on a `FOUNDED` line so an excused class cannot go quiet. A
threshold moved to 2.1m would have swallowed a genuinely sunk building too.

### THE OVERHANG BUDGET DID NOT KNOW THE GAP WAS SHARED — 124 -> 15

`deepClash` sat at ~100-124 for the whole session, the largest tracked defect
left, and it was one cause the entire time. Two steps got there, and the first
step was the tool.

**Classify before you fix.** `clash.mjs` now splits every deep pair by what the
reserved tile footprints say: TOUCHING, a tile or more APART, or OVERLAPPING.
The answer came in one run — **all of them touch.** None apart, none
overlapping, none unknown. So these were never placement bugs and `audit.mjs`
is right to be clean; they are `MAX_OVERHANG` being a per-BUILDING budget spent
into a SHARED gap, two neighbours reaching 0.6m each toward the other.

**And the arithmetic then convicted the instrument.** Two touching footprints
permit 1.2m of overlap at most and the tool reported 1.62m. A number above a
ceiling the code enforces is a free bug report about the measurement — the same
tell as the facade audit's 100%-covered window. `BuildingFactory` records
`hx = (w/2)|cos| + (d/2)|sin|`, the box AROUND a rotated volume rather than the
volume, and 55% of buildings carry an off-axis wobble (±3° where a road aligns
them, ±12° where none does). A 6m volume at 12° inflates its hull by 1.25m, so
buildings whose walls are nowhere near each other overlapped as hulls. The
comment above that code called it "yaw-aligned", which it is not. `VolumeBox`
carries the ORIENTED box now, the hull is demoted to broad-phase bucketing, and
the narrow phase is separating-axis on two rectangles. **124 -> 97 with no
change to the town.**

**Then the fix, which is one line of architecture: a jetty overhangs the
STREET, not next door.** `clipToFootprint` takes a per-side allowance — full
`MAX_OVERHANG` where the adjacent tiles are free, zero where a neighbour has
reserved them, because a wall that stops at the plot line IS a party wall and
93% of this town has one. Applied only on the FINAL clip in BuildingFactory,
which is the last thing to touch an extent; `pickMassing` cannot do it because
it sizes one building knowing nothing about the street. The local frame maps to
the world by rounding `rotationY` to a quarter turn, which is exact for
`baseRot` — and the ±π/2 case is already restricted to square-ish footprints
precisely so a rotation cannot swap the reserved rectangle's axes.

    deepClash   124 -> 97    the instrument (AABB hulls of rotated boxes)
                 97 -> 15    the fix (per-side overhang)

**THE HONEST LEDGER, and it is the first one in this repo taken on a build
where a two-point move means something.** Two metrics moved the wrong way and
both are consequences rather than surprises:

| metric | before | after | |
|---|---|---|---|
| clash deepClash | 124 | **15** | the point |
| variety twinNear | 9% | **6%** | free |
| variety twinAny | 39% | **28%** | free |
| eyeball roofBlackPct | 14% | **10%** | free |
| urbanform coverage / party / frontage | 45 / 93 / 71 | **45 / 93 / 71** | unmoved |
| provenance spireAtCap | 0% | 6% | cost |
| eyeball wallLuma | 0.229 | 0.206 | cost, and see below |

**Coverage, party walls and frontage did not move by a single point**, which is
the result that mattered: the worry with tightening an overhang is that it
costs built form, and it costs none. The variety gain is free and makes sense —
a volume clipped by which neighbours it actually has varies more than one
clipped by a constant.

`spireAtCap` 0% -> 6% is `clampRoofHeight` biting on the narrower base a
tighter clip produces. Six percent at a cap is a tail doing what a backstop
should; the pathology this file records was 96%, where p10 = med = p90.

**And the wall reading is not a lighting change.** The whole table:

    surface    med before -> after     reads black     p10 / p90 (after)
    wall           0.229 -> 0.206      3% -> 4%        0.081 / 0.411
    roof           0.161 -> 0.175      14% -> 10%      0.054 / 0.234

The tails are identical and the black share is flat — only the middle moved,
and the roofs improved. That is what this change does: **walls previously
buried inside a neighbour are now on screen**, shaded party-wall junctions
included. The old 0.229 was partly measuring wall that should never have been
visible. Grade `reads black` here, not the median.

**And I deleted a check I had added an hour earlier**, because it was the
morning's lesson repeated. It compared each volume's world AABB against its
footprint plus `MAX_OVERHANG` and printed "OVER BY 1.12m" — wrong twice: the
AABB is a hull, and a permitted plot rectangle only means anything in the
building's OWN frame, where a plot is axis-aligned. A building legitimately
rotated inside its plot pokes past an axis-aligned plot box without breaking
anything. `provenance.mjs` already owns that invariant, tests it in the local
frame, and reads 0. **I built a second weaker copy of an existing check and
believed it over the stricter one, three hours after writing "compare their
strictness before you debug either" into THE METHOD.**

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
  build-tools 34.0.0, and `android/local.properties` pointing `sdk.dir` at the
  SDK. **A fresh container has the JDK and no SDK**, and this is the recipe
  that works — recorded because the requirement was already written down and
  the commands were not, which is the difference between a five-minute setup
  and a half-hour one:

      cd /opt && curl -sSL -o cmdline-tools.zip \
        https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
      mkdir -p /opt/android-sdk/cmdline-tools
      cd /opt/android-sdk/cmdline-tools && unzip -q /opt/cmdline-tools.zip \
        && mv cmdline-tools latest
      export ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
      yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
      $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
        "platform-tools" "platforms;android-34" "build-tools;34.0.0"
      printf 'sdk.dir=/opt/android-sdk\n' > android/local.properties
      ANDROID_HOME=/opt/android-sdk npm run android:apk

  ~2.5GB of SDK and gradle cache, about six minutes end to end, gradle itself
  downloads fine through the proxy. `android/local.properties` is already
  gitignored, so the machine path cannot be committed.
- **Verify the APK carries the source you think it does.** `android:apk` runs
  `build:web` first, so the check is that nothing in `src/` is newer than
  `dist-web/index.html` (`find src -newer dist-web/index.html`) plus a grep for
  a symbol you just added. A stale `dist-web` would ship silently — the same
  trap as a failing `npm run build` leaving the previous bundle in `dist/`.
- The web bundle has no favicon, so a browser preview logs one 404 for
  `/favicon.ico`. Cosmetic and irrelevant in a WebView; the LAUNCHER icon is a
  separate asset and comes from `android/app/src/main/res/mipmap-*`.
- The debug APK is signed with the throwaway debug key, so it installs only
  with "install unknown apps" enabled. A release build needs a real keystore.
