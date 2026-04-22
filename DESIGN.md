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
FLOOR_HEIGHT is 1.8m (a 2-story is 3.6m). Props are tuned so a 1.6m-tall
player feels inside the architecture, not above it. "Kaiju scale" is a
bug, not a style.

### 4. Motion breathes
Window flicker is slow (0.25–0.7 Hz) and gentle (±4%), reading as
firelight rather than strobe. Smoke drifts on a shared wind vector.
Birds circle spires at dusk. Water shimmers. Nothing is static, but
nothing pulses.

### 5. Depth through light pools
At dusk/night, warm ground pools under every lamppost (horizontal disc
with radial-alpha, not vertical cone). Hanging lanterns overhead between
close buildings. Wall-mounted lanterns on ~18% of houses at eye level.
Three layers of warm light, all shared-material so dimming the sun dims
them together.

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
