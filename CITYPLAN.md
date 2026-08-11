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
| edges | river, wall, cliff: a seam the town acknowledges | river ignored; wall exists but is decorative |
| districts | recognisable from inside, with a transition | Voronoi cells; you cannot tell you crossed one |
| nodes | where paths converge and you pause | plazas sit at district centres, not junctions |
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

### 3. NODES WHERE PATHS MEET, NOT AT DISTRICT CENTRES

A square belongs where roads converge, because that is where people already
are. Ours are placed at Voronoi centroids and the roads are drawn to them
afterwards, which is backwards. Sitte's rules then apply: enter at the
corners, keep it enclosed, monument at the edge.

*Grades: share of squares with 3+ streets meeting; enclosure of square
perimeter; vista termination.*

### 4. DISTRICTS YOU CAN FEEL, WITH A CROSS-DISSOLVE

A district should be recognisable from inside — its ground, its building
types, its props, its density — and the boundary should be hidden by a bend, a
gate, a bridge or a level change rather than being an invisible line where the
palette swaps. Cross-dissolve is the Imagineering term; Cullen calls the same
move a "closure".

*Grades: district purity (what fraction of a district's buildings are its own
types) and boundary legibility.*

### 5. POSITIVE OUTDOOR SPACE

Alexander #106. Every piece of open ground should be either a shaped public
space or a private yard belonging to somebody. Leftover space between
buildings is the failure mode. `softenBackOfBlock` made a start by turning
back-of-block paving into gardens; the next step is enclosing them.

*Grades: share of open ground that is inside a bounded, convex-ish region
versus leftover slivers.*

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
  build before claiming a delta.
