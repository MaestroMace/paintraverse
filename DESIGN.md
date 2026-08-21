# PainTraverse — Design & Philosophy

## North star

**1,000 mathematically principled Traverse Town-like areas with cohesion
and flexibility. Immersion is the metric.**

Can the player stand in this town at dusk and feel like they're somewhere?
That's the test. Every track of work earns its place by moving that needle.

## Visual references

The aesthetic pulls from four touchstones, each contributing a different
ingredient to the blend:

- **Traverse Town (Kingdom Hearts)** — the iconic: warm windows, hanging
  overhead lanterns, curved alleys, dusk sky, silhouetted rooflines,
  architectural whimsy. The primary target read.
- **Diagon Alley (Harry Potter)** — shared-wall terraced rows leaning
  toward the street, signage projecting from walls, mixed heights within
  a single block.
- **Kyoto (Gion district)** — continuous slopes rather than stair-step
  plateaus, dark timber framing, lanterns at human eye-level, density
  without menace.
- **Paris (Marais, Latin Quarter) / Lisbon / Porto** — the "500 years of
  organic growth" feel: one ambitious family built up tall, the next
  stayed short; every block has 2/3/4/5-story rhythm; occasional tower
  house outliers.

## The philosophy: organic human structural controlled chaos

Real towns are built by a thousand small decisions over centuries, not
one master plan. That shows as:

- **Shared walls.** Buildings press against each other in rows, forming
  block perimeters — not scattered plots with grass between them.
- **Height variation within clusters.** 2-story next to 4-story next to
  3-story, not uniform district heights.
- **Curved streets, not grids.** Paths follow terrain and old property
  lines. Grids read as "developer" not "community."
- **Occasional tall outliers.** One lanky 5-story in a row of 2-stories —
  the "someone built up" story.
- **Continuous slopes.** Real streets grade gently up and down. Sharp
  1-tile plateaus read as a staircase bug.
- **Dense core, sparse edges.** Growth rings fade outward; the oldest
  part is the tightest.

The opposite — what we actively fight against:

- 90° grid lock on every building
- Uniform cube silhouettes
- Isolated plots with grass between them
- Staircase terrain
- All-warm or all-cool window palettes (read as fake)

## Aesthetic pillars

### 1. Warmth reads as home
The dusk frame is the primary test view. Warm amber windows against dark
silhouettes should dominate; cool and bright moods exist but must be
clamped so they can't saturate to white against warm neighbors.

### 2. Silhouette variety
Every building in a row should have something distinguishing it: a
crooked chimney, a copper-top cap, a different roof pitch, a balcony,
a window-box, a taller-than-neighbors profile. The eye should never be
able to copy-paste one silhouette onto another.

### 3. Scale feels human
`STOREY_HEIGHT` is 2.9m and `TILE` is 3.0m, both in `renderer3d/scale.ts`.
Doors are 2.05m, windows 1.35m. Props are tuned so a 1.6m-tall player feels
inside the architecture, not above it. "Kaiju scale" is a bug, not a style —
and so is its opposite: this pillar read "FLOOR_HEIGHT is 1.8m" while the
audit found 95% of doors were shorter than a person. Check `tools/humanscale.mjs`
rather than this paragraph; a number in prose goes stale, a distribution does not.

### 4. Motion breathes
Window flicker is slow (0.25–0.7 Hz) and gentle (±4%), reading as
firelight rather than strobe. Smoke drifts on a shared wind vector.
Birds circle spires at dusk. Moths work the lanterns after sunset.
Water shimmers. Stars come out. Nothing is static, but nothing pulses —
**and no two periodic things share a rate**, which is why the star
twinkle sits at 0.18–0.40 Hz deliberately below the window flicker: two
things breathing together read as one strobe, and that is the defect the
flicker was dropped from 2.2–4.4 Hz to fix.

Moths are the first moving thing that knows where the LIGHTS are. Smoke
comes out of chimneys, birds circle spires, fireflies are scattered over
the map at random; a lantern with nothing at it is a lamp, and a lantern
with a few moths at it is a summer evening. They orbit erratically rather
than cleanly, because a clean circle at this scale reads as a small bird.

Grade motion with `tools/particles.mjs` (is it where the town is, and does
it reach every family it draws from) and `tools/mothshot.mjs` (can you see
it). **Neither can grade the movement itself — a still photograph
systematically under-reports a motion feature**, so the pictures settle
visibility and the look is a judgement made in the running app.

### 5. Depth through light pools
At dusk/night, warm ground pools under every lamppost (horizontal disc
with radial-alpha, not vertical cone). Hanging lanterns overhead between
close buildings. Wall-mounted lanterns on ~18% of houses at eye level.
And the light those windows THROW: a warm band on the cobbles at the foot of
every lit elevation, off the same term as the window emissive so it cannot
outlive the light casting it. Four layers, all shared-material so dimming the
sun dims them together.

The spill is a band rather than a disc because a lamppost is a point source
and a lit elevation is a line of windows. It is deliberately faint: every
building casts one, they overlap, and a value that reads well alone lights the
whole street to an even wash — which is the worst of both pillars at once,
since pillar 1 wants a dark street and this one wants pools.

**There are three lantern FAMILIES and a feature aimed at "the lanterns"
must reach all three** — the lamppost bulb, the wall bracket and the rope
lantern, roughly 150–175 of them a town. Each records itself into
`lampAnchors` (LanternStrings.ts) stating which family it is, so anything
attaching to a light has one list to read and `particles.mjs` can report a
family that contributed nothing. A pass that reaches two of three reads as
perfectly healthy, because the survivors carry the count.

### 5b. Weather is a multiplier, never a repaint
Rain, fog, snow and storm scale what the HOUR already decided — fog density,
sun, skylight, cloud, star field — and `clear` is exact identity. The four
lighting arms have had a session each spent on them and dusk is the hour the
board grades; a weather table that set values outright would silently
overwrite all four. Cloud REDISTRIBUTES light rather than removing it, so the
sun goes down and the skylight goes up. Precipitation comes out of cloud: a
weather that does not reach the sky dome has changed the air and not the day.

Grade with `tools/celestial.mjs`, which sets every Environment control to both
extremes and asks whether the frame changed at all. It exists because
`moonPhase`, `starDensity` and the whole weather set were read by NOTHING for
the life of the app — a labelled control is a promise, and an unkept one is
worse than absent content because the label makes people believe it.

### 6. Perf is aesthetic
If it doesn't run at 30+ FPS, none of the above matters. Shadow cam
follows the player (tight bounds, sharp texels). Bloom gated during
daytime. Wall meshes coalesced by material so 200 individual walls
become 40-50 merged meshes. Particles under budget.

## Architectural principles (code)

- **Determinism.** Same seed → same world. All random draws go through
  `rand01(hash, salt)` or a seeded RNG. No `Math.random()` in generation.
- **Shared-material caching.** `_wallMatCache` + `_plainMatCache` in
  VolumeRenderer so same-config buildings share materials (enables
  coalescing).
- **One draw call per logical layer when possible.** Terrain = 1 mesh
  per zone (ground / walls / water / roads / alleys). Buildings use
  `coalesceWalls()` to merge per-material. Roofs/ornaments/details all
  batch via `BatchedMeshBuilder`.
- **Physical plausibility over stylistic tricks.** Lamp pools are ground
  discs (physical), not vertical cones (stylistic). Chimneys anchor to
  the actual building mainBody, not an arbitrary volume.
- **Debug-first.** `ThreeRenderer.getDebugInfo()` exposes FPS, honest
  draw-call count, frame time breakdown, shadow/bloom state. Every
  change is measured, not guessed.

## Out-of-scope (explicitly)

- **NPC pedestrian figures.** Own system, large. Mentioned but deferred.
- **Indoor scenes.** Way out of scope.
- **Audio.** No engine work on sound yet.
- **Weather rendering.** Data exists but no renderer yet.
- **Day/night auto-advance.** UX question, not immersion.

## Related docs

- `CLAUDE.md` — session handoff, commands, workflow, lessons learned.
- Plan file for in-flight pushes: `/root/.claude/plans/familiarize-yourself-with-the-lively-graham.md`
  (this path rotates per session; check the active plan referenced in
  the current conversation).
