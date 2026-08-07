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

- `FLOOR_HEIGHT = 1.8` (BuildingFactory) — 1.05 was the "kaiju" scale bug
- `TERRAIN_WORLD_SCALE = 1.8` (TerrainMesh) — raw height unit → world
- `EYE_HEIGHT = 1.6` (ThreeRenderer) — player camera height
- `RENDER_SCALE = 0.4` (ThreeRenderer) — renders at 40% then CSS-upscales.
  This is why thin geometry aliases: a feature spans one pixel at ~340× its
  own size, so anything under ~5cm is invisible past ~17m.
- `SHADOW_RADIUS = 28m` (ThreeRenderer.updateShadowCamera) — follows player
- Shadow map **256²** with PCF, manual updates (not per-frame)
- Composer/bloom is **disabled** (`_useComposer = false`)
- `MAX_ROOF_SPAN_RATIO` (Roofs) / `MAX_TOWER_ASPECT = 9` (Massing) — roofs and
  tower bodies are capped against their own width. Without these, spires
  reached 74m needles.
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
- Placement audit is at **0 errors AND 0 warnings across 16 seeds**
- Plan view reads: role-tinted buildings, prop glyphs, labels that fit
- Pixel-art export works at every hour (see tools/pixelart.mjs)

## What's still open / what to push on next

Everything on the previous list except perf has been done and verified.
Current state:

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
- Layout: below 820px the two side rails become slide-over drawers with a
  tap-outside scrim, because 2x232px of rail does not fit a 412px screen.
- Toolchain needed for the APK: JDK 21, Android SDK platform 34 +
  build-tools 34.0.0 (`sdkmanager "platforms;android-34" "build-tools;34.0.0"`),
  and `android/local.properties` pointing `sdk.dir` at the SDK.
- The debug APK is signed with the throwaway debug key, so it installs only
  with "install unknown apps" enabled. A release build needs a real keystore.
