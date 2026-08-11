# CITYPLAN — how this town gets planned instead of assembled

Read `DESIGN.md` for the aesthetic north star and `CLAUDE.md` for the session
handoff. This file is the third one: **what a town is structurally, why ours
is not one yet, and the order to fix it in.**

## The diagnosis, in one sentence

The generator has no causal hierarchy: it is a stack of independent passes
that each sweep the whole map and none of which constrains the next, so
nothing in the town is the way it is *because* of anything else.

That is precisely what "scattered" means. Every previous fix has been an
improvement to one pass — narrower streets, anchored plots, weenies at the end
of vistas — and each of them worked. But a town assembled from independently
good passes is still assembled. A planned town is *derived*.

Here is what the pipeline does today, in order:

    noise heightmap -> water channels from noise -> Voronoi districts
      -> district ground paint -> plazas at district centres
      -> roads radiating from the map centre -> erosion -> bridges
      -> landmarks -> buildings on road edges -> props

Read that list looking for causation and there is almost none. The water is
noise and nothing responds to it. The districts are Voronoi cells around
random centres, so a "harbour district" can sit inland and a "noble district"
in a marsh. The roads radiate from the map centre whether or not anything is
there. The plazas are at district centres, which are arbitrary points, not
where roads meet.

A real town is the opposite: every element is downstream of the one before.

    SITE  ->  REASON  ->  ARMATURE  ->  BLOCKS  ->  PLOTS  ->  BUILDINGS  ->  DRESSING

Why is the town *here* (a ford, a harbour, a defensible hill, a crossroads)?
That answer picks the primary street. The primary street picks the market
square. The square and the streets bound the blocks. The blocks subdivide into
plots. Plots carry buildings. Buildings own their dressing.

## The principles we are planning against

Four sources, all saying compatible things, plus the Imagineering layer that
DESIGN.md already commits us to.

**Kevin Lynch, *The Image of the City* (1960).** People navigate by five
elements: PATHS, EDGES, DISTRICTS, NODES, LANDMARKS. A place is *legible* when
those five are distinct and reinforce one another. Score ourselves honestly:

| element | what it should be | what we have |
|---|---|---|
| paths | a hierarchy you can feel — high street, lane, alley | tiers exist in data, but every street looks alike |
| edges | river, wall, cliff: a seam the town acknowledges | quay 53%, wall 6.5m and 76% sealed — **built** |
| districts | recognisable from inside, with a transition | heights differ now (2 -> 4 medians); character 27%, seam unbuilt |
| nodes | where paths converge and you pause | 4 seeds in 5 have a square, 27-33m, 61-97% enclosed — **improving** |
| landmarks | visible from far, orienting | **done** — vista termination 6% -> 18% |

Landmarks are the one element we have actually built. The other four are the
work.

**Camillo Sitte, *City Planning According to Artistic Principles* (1889).**
The classic study of why medieval squares feel good and Beaux-Arts ones do
not. Three rules we can encode:
- A square must be ENCLOSED. Streets should enter at the corners, not through
  the middle of a side, or the enclosure leaks out of the gap.
- Monuments belong at the EDGE of a square, not the centre. The centre is for
  people; a statue in the middle divides the space and blocks the view across.
- A square's proportions should relate to the height of the buildings round
  it — roughly 1:1 to 1:3 of width to facade height for the minor dimension.

**Christopher Alexander, *A Pattern Language* (1977).** The relevant patterns:
- **#106 Positive Outdoor Space.** Outdoor space must be *shaped* — convex,
  bounded, deliberate. Space that is merely left over between buildings reads
  as nothing. Most of our open ground is left over.
- **#61 Small Public Squares.** A square people use is around 20m across, far
  smaller than designers reach for. Ours were 48m before the last pass.
- **#100 Pedestrian Street**, **#121 Path Shape.** A path is a *place*, not a
  corridor — it wants bulges, narrowings and things to stop at.

**Gordon Cullen, *Townscape* (1961).** SERIAL VISION: a town is experienced as
a sequence of revealed views, and the pleasure is in the rhythm of enclosure
and release. Turn a corner and something new is disclosed. This is the same
idea as the Imagineering cross-dissolve, arrived at from the British side, and
it is the one that argues hardest against a grid.

**Imagineering (DESIGN.md).** The weenie (done). Cross-dissolve: you never see
two lands at once, a bend or a berm hides the seam. The three-distance read:
silhouette at 100ft, composition at 30ft, detail at 3ft. The story: every
element answers "what happened here".

Where the four agree is the plan: **make the space between buildings shaped
and intentional, make the boundaries between areas perceptible, and make the
sequence of views along a path rewarding.**

## The order of work, and the metric that grades each

Ordered by payoff per risk. Each item names the number that says it worked, so
none of this is graded by squinting at a screenshot.

### 1. ONE MATERIAL PER PLACE — the ground is a mosaic

**Measured: 40% of paved-to-paved tile edges change material.** The commonest
seam is street cobble against plaza flagstone, 252 of 659, and it is a
regression: the road painter was taught to skip tiles that are already a
designed square, so wherever a road crosses a plaza's outer ring the street
keeps flagstone. `carvePlaza` then speckles its own rings with `(x+y)%3` and
`(x+y)%5` patterns, which is a patchwork generator by construction.

This is the "broken overlapping textures" report, and it is not a texture bug:
it is six near-identical paving ids interleaved at tile granularity. A place
should have ONE floor. The seam belongs at the edge of the place.

*Grades: paving churn, target under 10%. Ground colour families (streets.mjs).*

**DONE — visible seams 33% -> 20%, and the confetti seam 791 -> 13.**
`streets.mjs` now measures seams in COLOUR rather than tile id, because ids
15/16 are deliberately identical to 8/9 and counting those reports a mosaic
nobody can see. `softenBackOfBlock` resolves every paved tile that is neither
street nor designed square to its DISTRICT's single canonical paving, instead
of preserving whatever the last of six passes to touch it happened to write.
Plaza flagstone went from 152 blobs with 750 tiles of perimeter to 3 blobs
with 36. `carvePlaza` lays a field and a rim rather than alternating on
`(x + y) % 3` and `% 5`, which is a checker at bathroom-tile scale and a
patchwork at 3 metres per tile.
Honest cost: the stone-against-cobble seam went 135 -> 394, because temple and
noble quarters now floor their forecourts in stone. That one is systematic
rather than random — it reads as a footway beside a carriageway — but it is a
trade, not a free win.

**Also done, same principle applied to props.** `dressEmptyStreets` decided
"is this a square?" by testing the paving MATERIAL, which stopped being a
valid question the moment district cobble became the street's own forecourt:
every kerb in a cobbled quarter was classified as a square and furnished from
the square kit, whose heaviest entry is a TREE. That is the tree standing in
the middle of the street. It reads `squareMap` now — the only thing that
actually knows — and the carriageway is a hard exclusion rather than a 75%
thinning, per Alexander #124: the life of a public space forms at its edge,
and a space whose edge fails never becomes lively however much you put in the
middle of it.

A warning for whoever measures this next. THREE definitions of "misplaced
prop" were tried before one matched the defect on screen. Counting props on
circulation tiles scored a barrel against a tavern wall as a failure, when
that is exactly where a barrel belongs — 22% "in the road" was mostly correct
kerbside dressing. Counting only circulation then missed the tree entirely,
because it stood on the APRON. The definition that works: on hard paving, in
the open, no wall beside it, not inside a designed square. Also: an early A/B
here compared two different towns, because the probe never set a seed and the
UI supplies whatever it holds. Pin the seed.

### 2. THE RIVER IS AN EDGE THE TOWN ACKNOWLEDGES

**Measured: water is 6% of the map and 9% of buildings touch it.** The river
is generated from noise before anything else exists and nothing downstream
reads it. So it is a ribbon that happens to pass through, which is exactly the
"scattered buildings and rivers" report.

A town on a river has: a QUAY (a hard edge you can walk, not a mud bank), a
FORD or bridge that is the reason the town is here, buildings that FRONT the
water rather than turning their backs, and a waterfront district that is
about the water. Lynch's edge only works if it is legible from inside.

*Grades: waterfront frontage occupancy; bridges per crossing; a new
`tools/site.mjs`.*

**PARTLY DONE — quay 19% -> 53% of the bank is walkable street.** `carveQuays`
lays a lane along the bank inside the town, which does two jobs for one: it
gives the river the hard edge Lynch's EDGE needs to be legible from inside,
and because the building placer walks ROAD edges, the lane grows a frontage
without touching the placer. Bridges 4 -> 10. Waterfront wall 78% -> 83%.

**And a warning about that 78%.** The first cut of this metric asked "does a
bank tile carry a building" and reported 7%, which reads as an empty riverside
and is not one — the bank tile is normally the verge, and the building stands
one tile back. Asking the same question urbanform asks of streets (a building
within 2 tiles) says 78% before any change. The bank was never empty; it was
UNWALKABLE. Two different problems, and the first metric named the wrong one.
Note also that "buildings with their back to the water" gets WORSE as the quay
improves, because a building fronting a quay no longer touches the river and
drops out of the sample. A metric whose denominator your fix shrinks will lie
to you.

Still open here: the town is on the river but not OF it. There is no harbour,
the waterfront is not a district, and nothing about the river explains why the
town is where it is.

### 1b. A LANDMARK ONLY WORKS IF IT IS RARE

**Measured: 93 towers averaging 19m against 179 row houses averaging 4.7m.**
`round_tower` carried weight 10 in the fortress district — the heaviest weight
of any building type anywhere — and the row streak copies its anchor's type up
to four more times in each direction. So one roll produced a TERRACE OF
TOWERS, which is not a thing. Meanwhile the curtain wall those towers stand on
is 2.9m, shorter than the houses it defends.

This is a Lynch failure and not merely an ugly one: a landmark orients you
only when it is rare, and ninety-three of them are wallpaper. The vista audit
was scoring `tower` as a weenie 97 times precisely because towers were
everywhere, which is the metric flattering a defect.

**PARTLY DONE — towers 93 -> 41.** A `NEVER_TERRACED` set stops landmark types
streaking along a street, and the pathological weights came down. The
structural half matters more than the weights: the streak was amplifying every
tower roll about ninefold.

Still open: a fortress district still reads as a thicket, because its whole
palette is towers and walls. The real fix is that a citadel is a PLACE with a
keep and a bailey, not a district whose building list happens to be military.
And the curtain wall wants to be 6-8m so it reads as a wall with towers
punctuating it, rather than a fence with spires behind.

### 2b. THE WALL IS THE OTHER EDGE, AND IT WAS A FENCE

**Measured: the curtain wall was 2.2m.** A storey is 2.9 and a row house is
4.0, so the town's defensive wall was shorter than every building it defends.
Same scale-coupling bug as the rest of that arc — a constant tuned when a
building was one to three world units wide, left behind when `TILE` became 3.0.

It is a Lynch failure, not just a silly number. EDGE is one of the five
elements a place is legible by, and a boundary you can see over is not a
boundary. **6.5m now**, against Carcassonne's ~8m and York's ~4m on a rampart,
with a 1.6m thickness instead of 0.55 (a 6.5m wall 55cm thick is a sheet of
card on edge) and merlons at a 1.5m pitch instead of 0.4 — a 6m segment was
growing 31 merlons of 19cm each, which past a few metres is a fuzzy line and
31 extra volumes per segment on a mesh budget that cares.

Continuity: 71% -> 76% of the boundary ring sealed, 50% -> 55% by masonry.
The gate clearance box was ±4 tiles per gate, which was survivable at four
gates and became a third of the perimeter when the vista work raised the cap
to eight. **A fix in one pass quietly undermining another is the hazard of a
pipeline with no hierarchy, which is what this whole document is about.**

**Read this before measuring the wall again.** The first version of the ring
metric walked `minY/maxY/minX/maxX`, while the wall builder lays its bottom
row at `maxY - 1` and its right column at `maxX - 1`. Two of the four sides
were therefore one tile outside the wall, every segment on them scored as a
gap, and the tool reported 52% sealed with "233 tiles where the placer simply
did not build". Aligning the ring took it to 76% with nothing changed. TWO
code changes were made chasing that phantom before the tool was made to
explain its own gaps rather than just count them — and classifying the gaps by
CAUSE is what exposed it in one run.

And a second one: a `town_gate` is 3 tiles wide, so a symmetric ±2 clearance
box let a wall start at `gate.x + 2` and overlap the gate's third tile. One
placement error on seed 11. Gate footprints are marked into the occupancy set
now; a distance heuristic standing in for a footprint test is wrong in
whichever direction you did not picture.

### 3. NODES WHERE PATHS MEET, NOT AT DISTRICT CENTRES

A square belongs where roads converge, because that is where people already
are. Ours are placed at Voronoi centroids and the roads are drawn to them
afterwards, which is backwards. Sitte's rules then apply: enter at the
corners, keep it enclosed, monument at the edge.

*Grades: `tools/squares.mjs` — how many squares exist, their minor dimension,
and enclosure measured as line of sight from the middle of them.*

**PARTLY DONE — squares per town 1-in-5 seeds -> 4-in-5, enclosure 61-97%.**
Three causes, and the interesting thing is that the one everybody would guess
at (the squares are not walled) was never true.

- **TWO DEFINITIONS OF WHERE A SQUARE IS.** `carvePlaza` painted an ellipse;
  `generateStreetNetwork` separately stamped a DISC of a different radius to
  reserve it. A comment sat above the disc warning the next person to keep the
  two in sync — they could not be, the shapes differ. The square's outer band
  was therefore invisible to the building placer, which finds frontage by
  walking ROAD edges, so nothing was required to ring a square and nothing was
  stopped from building on its edge. One definition now: the tiles carvePlaza
  actually painted.
- **THE GOLDEN RATIO WAS THE WRONG NUMBER.** Plazas were elliptical at 1.618,
  which is a lovely proportion and makes every square markedly oblong — and it
  is the MINOR dimension that decides whether a space reads as a square or as
  a wide spot in the road. 1.3 now.
- **THE PRINCIPAL SQUARE WAS UNDERSIZED.** Cutting it from four football
  pitches overshot to 24m by 18m. Radius 4-6 gives ~30m by 24m.

`narrowRoadSwathes` also decided "is this a square?" from the MATERIAL, and
stone (id 2) is both a designed square and the ground of every temple and
noble quarter — so an entire district was spared from erosion and its
over-wide approaches never narrowed. Third time that same mistake has appeared
(dressEmptyStreets, this, and the sky mask in anomaly.mjs): **a question about
the PLAN cannot be answered by the material.**

Still open: one seed in five has no square at all, and street mouths onto a
square run to 5-9 where Sitte wants a few, entering at the corners.

### THE METRIC HERE WAS WRONG TWICE, WHICH IS THE REAL LESSON

Enclosure was first measured as "what share of the tiles just outside the
square are buildings", which reported 29-33% and would not move however the
town changed. That is the signature of a metric measuring its own
construction: after the one-material-per-place change a square and its apron
are contiguous paving, so the "boundary" fell wherever an arbitrary 3-ring
growth stopped, usually in the middle of more paving.

Re-asked as **line of sight from the middle of the square** — cast rays, count
how many meet a facade within 27m — the same towns read 75%, and the fix took
them to 94%. Nothing about the town changed between those two numbers. The
first metric was answering a question about the tool.

And it was hiding the real defect. "Squares are 30% enclosed" points at
walling them; "four seeds in five contain no square at all" points somewhere
completely different, and only the second one was true. Making the tool print
its INGREDIENTS — open paved tiles, and how many are deep enough to stand in —
is what showed it: the seeds with no square had MORE open paving than the seed
that had one.

### 4. DISTRICTS YOU CAN FEEL, WITH A CROSS-DISSOLVE

A district should be recognisable from inside — its ground, its building
types, its props, its density — and the boundary should be hidden by a bend, a
gate, a bridge or a level change rather than being an invisible line where the
palette swaps. Cross-dissolve is the Imagineering term; Cullen calls the same
move a "closure".

*Grades: `tools/districts.mjs` — character (share of a district's buildings
that are types distinctive to it) and signature (do the quarters differ in the
three things a player perceives: ground, height, density).*

**PARTLY DONE — distinct median heights across six districts went 2 to 4.**
The ranges had been differentiated in the main placer all along. They did not
survive because SIX other places also set `floors`, each with its own
hardcoded formula — the gap-fill, two terrace fill passes, the corner
buildings and a courtyard placer — and every one wrote 1-2 regardless of
district. Every quarter's 10th percentile came out at 1 storey INCLUDING the
noble quarter, whose baseline starts at 3. One `districtFloors()` now, and all
seven callers go through it. Duplicated maths drifts silently; this is the
same failure as the smoke plumes that kept a stale FLOOR_HEIGHT.

**The guard in the tool earned its place immediately.** DESIGN.md's philosophy
wants height variation INSIDE a cluster — "2 storey next to 4 storey next to 3
storey, not uniform district heights" — while Lynch wants the quarters to
differ FROM each other, and with a floor of one storey and a cap of five there
is not enough range for both. The first attempt used 2-wide ranges: distinct
medians 2 -> 4, and within-district spread 3 storeys -> 2 with three of twelve
districts going flat. That is the silhouette pillar being traded away for a
Lynch number. Widening every range back to 3 and lifting the cap to 6 keeps
the separation and puts flat districts at 0 of 12. **Printing both numbers
side by side is the only reason the trade was visible.**

Still open, and it is the bigger half: **CHARACTER is 27%** — every district is
mostly row houses, a market quarter included. CLAUDE.md records two failed
attempts at the type mix and exactly why they failed, so this wants the
render-layer route (a row house in a market district drawn as a shopfront)
rather than another go at the weights.

Also unbuilt: the SEAM. Nothing hides a district boundary — no bend, gate,
bridge or level change — so the transition is an invisible line on a Voronoi
diagram. That is the cross-dissolve, and it is untouched.

### 5. POSITIVE OUTDOOR SPACE

Alexander #106. Every piece of open ground should be either a shaped public
space or a private yard belonging to somebody. Leftover space between
buildings is the failure mode. `softenBackOfBlock` made a start by turning
back-of-block paving into gardens; the next step is enclosing them.

*Grades: share of open ground that is inside a bounded, convex-ish region
versus leftover slivers.*

## 6. THE PIXEL LAYER — anomalies the data model cannot see

Every item above is graded from the data model. That has been productive and
it has one structural blind spot: **it can only find what somebody already
knew to ask about.** The placement audit sat at 0 errors across fourteen seeds
and `slivers.mjs` reported 0 pieces of geometry outside their envelope, while
photographs from the phone kept showing long black members projecting out of
buildings. Both were true. The geometry is inside its volume and still wrong
on screen.

`tools/anomaly.mjs` closes that. It flies the camera around the town LOOKING
UP — the angle every one of those photographs was taken from — reads the
framebuffer, and asks what is anomalous AS AN IMAGE with no model of what the
town should contain. Currently: long thin dark shapes silhouetted against the
sky, found by morphological opening; and high-frequency speckle blocks, which
is what two coplanar faces look like.

Current state: 2-3 findings per 10 vantages, small (18-42px) — the class is
real and rare rather than absent. **The lantern ropes were the leading
hypothesis and were refuted**: hiding them with `--hide=lanternRopes` and
re-counting gave the same number. The remaining signature is a small dark X of
thin members floating above the rooftops; seed 31337 at noon, vantage v05, is
a reproducible example.

Three things about building this tool are worth more than the tool:

- **A heuristic mask produces confident nonsense.** The sky mask began as a
  flood fill with a colour tolerance. At dusk a shadowed wall is close in
  value to the sky above it, so the fill walked off the roofline and down the
  facade, whole buildings became "sky", their lit windows became dark islands
  inside it, and the tool reported forty floating timbers that were all
  windows. Rendering the frame twice — once with the content groups hidden —
  gives an exact mask with nothing to tune and nothing to leak.
- **A detector must state its own noise floor.** Three successive versions
  were not repeatable: same seed, same build, one sliver on one run and two on
  the next, because the dusk sky animates between the two reads behind the
  mask. Rendering both frames synchronously in one tick fixed the cause. The
  tool now re-reads every vantage and prints its disagreement rate, so nobody
  has to take its word for it.
- **Annotate the frames.** A detector you cannot check is a detector you will
  eventually trust for the wrong reason — and looking at the boxes is exactly
  what revealed the windows-as-timbers failure in one glance.

*Grades: sliver count per vantage, target 0. Speckle share, comparative.*

**The vantage set is the tool's blind spot.** Every vantage was at eye height
until a routine walkshot from the skyline turned up an obvious long dark bar
floating against the sky that the sweep had never once reported — from the
street that bar is behind a roof. A quarter of the vantages are elevated now,
looking slightly DOWN across the rooftops, and the first run with them found a
169px sliver, four times longer than anything the street-level sweep had ever
seen. Same lesson the gable winding taught from the other direction: a
negative result is only as good as its vantage, so vary the vantage rather
than trusting a clean run.

## Rules to hold onto while doing this

- **Derive, do not decorate.** If a new pass sweeps the whole map and places
  things by a global rule, it is scatter with better manners. Ask what it is
  downstream of.
- **A metric that scatter can satisfy will be satisfied by scatter.** Prefer
  the metric only the real structure can move. See `emptiness.mjs` in
  CLAUDE.md for the cautionary case.
- **Decompose before attributing.** The street-width figure was a sum of two
  terms with different owners and got assigned to the wrong one for months.
- **Change the tool and the code separately.** A/B the tool against the old
  build before claiming a delta, and pin the seed while you do it.
- **Prefer an exact test to a heuristic proxy.** Every proxy in this project
  has eventually disagreed with the thing it stood for: a neighbour count for
  road hierarchy, a clearance box for a gate footprint, a colour tolerance for
  the sky. The exact test was available and cheaper to trust in all three.
- **Make the tool explain itself, not just count.** Two changes were spent
  chasing a phantom before the wall metric was asked to classify its gaps by
  CAUSE, which exposed an off-by-one in the metric itself in a single run.
