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
- Build check: `npm run typecheck && npm run build` (both must be green)
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
