/**
 * Debug bridge — exposes the app's internals on `window.__pt` so the running
 * app can be inspected and driven from devtools or headless tooling
 * (Playwright, the screenshot harness) without adding UI for it.
 *
 * Everything here is read-only-ish diagnostics plus a couple of camera
 * helpers; nothing the app itself depends on. It exists because the only way
 * to check this project used to be looking at pixels — with this you can ask
 * the running town hard questions and get numbers back.
 *
 * Usage (devtools console or Playwright page.evaluate):
 *   __pt.audit()             -> placement invariant report (see GeometryAudit)
 *   __pt.debugInfo()         -> ThreeRenderer.getDebugInfo() (fps/draws/etc)
 *   __pt.teleport(tx, tz)    -> move the walk camera to a TILE coordinate
 *   __pt.lookAt(yaw, pitch)  -> aim the camera (radians)
 *   __pt.heightAt(tx, tz)    -> terrain surface height at a TILE coordinate
 */

import { useAppStore } from '../app/store'
import { auditMapGeometry } from '../renderer3d/GeometryAudit'
import { setFragmentAudit, getFragmentAudit, setSliverAudit, getSliverAudit } from '../renderer3d/BatchedMeshBuilder'
import { overhangClamps, resetOverhangClamps, massingTrace, setMassingTrace, MAX_TOWER_ASPECT } from '../renderer3d/architecture/Massing'
import { auditRoofWinding, MAX_ROOF_SPAN_RATIO } from '../renderer3d/architecture/Roofs'
import { placeStats } from '../generation/TownGenerator'
import { lampAnchors, lanternStats } from '../renderer3d/LanternStrings'
import * as THREE from 'three'
import { getActiveThreeRenderer } from '../ui/components/ThreeViewport'
import { getActiveEditorViewport } from '../editor/EditorViewport'
import { TILE } from '../renderer3d/scale'
import { TERRAIN_COLORS, TERRAIN_NAMES, isCirculation } from '../core/terrain'

export function installDebugBridge(): void {
  if (typeof window === 'undefined') return
  ;(window as any).__pt = {
    store: useAppStore,
    renderer: () => getActiveThreeRenderer(),

    /**
     * The THREE namespace, so a harness can RAYCAST.
     *
     * Every camera-placing tool here has independently reinvented "find a spot
     * to stand" out of the tile map, and every one of them has put the camera
     * inside a building at least once — `flyTo` does not test occupancy, and a
     * tile being free says nothing about whether the line of sight to the
     * subject is clear. Four attempts to photograph a bridge failed that way in
     * one session, and each failure looks like a black frame you then have to
     * guess about. With a Raycaster the question is exact and the answer names
     * the mesh that is in the way.
     */
    THREE,

    /** The 2D plan viewport, and where it is looking. tools/touch.mjs grades
     *  gestures against this rather than against pixels — a screenshot diff
     *  cannot tell a pan from a selection highlight being drawn. */
    editor: () => getActiveEditorViewport(),
    editorView: () => getActiveEditorViewport()?.viewState() ?? null,

    /** Placement invariants over the CURRENT map — works with or without 3D. */
    audit: () => {
      const s = useAppStore.getState()
      return auditMapGeometry(s.map, s.objectDefinitions)
    },

    debugInfo: () => getActiveThreeRenderer()?.getDebugInfo() ?? null,

    /** Fragment-size audit of batched geometry. Turn on, regenerate the map,
     *  then read: shows how much geometry is too small to resolve on screen. */
    fragmentAudit: { enable: setFragmentAudit, read: getFragmentAudit },

    /** Why the building placer rejected candidates on the last generate. A
     *  town with no buildings and no exception is otherwise indistinguishable
     *  from a placer that simply chose not to build. */
    placeStats: () => ({ ...placeStats }),

    /**
     * The terrain palette, so a tool can ask what a tile LOOKS like instead of
     * carrying its own copy of the table. Three copies of this had already
     * drifted into disagreeing about what tiles mean (see core/terrain.ts);
     * a fourth living in tools/ would be the same mistake with a longer fuse.
     */
    terrainPalette: () => ({ colors: { ...TERRAIN_COLORS }, names: { ...TERRAIN_NAMES } }),

    /** Which tiles a person can WALK along. Same argument as the palette: only
     *  8 and 9 are circulation, 14/15/16 are paving, and every tool that
     *  hardcoded that pair is one edit away from disagreeing with the engine. */
    isCirculation: (tileId: number | undefined) => isCirculation(tileId),

    /** Every roof triangle checked for OUTWARD winding. The batched material
     *  is FrontSide, so an inward face is deleted, not just mis-lit — and you
     *  cannot photograph a face that is not drawn. */
    roofWinding: auditRoofWinding,

    /** Long thin batched geometry — the "giant floating timber" class — keyed
     *  by the SOURCE LINE that emitted it, with a world position to fly to.
     *  Enable, regenerate the map, then read. */
    slivers: { enable: setSliverAudit, read: getSliverAudit },

    /** Volumes trimmed by the footprint-overhang cap, by definitionId:role.
     *  Non-empty means some template is throwing geometry at its neighbours. */
    overhangs: { read: () => ({ ...overhangClamps }), reset: resetOverhangClamps },

    /** Vertical extent of the built scene — catches runaway spire geometry. */
    sceneStats: () => getActiveThreeRenderer()?.debugSceneStats() ?? null,

    /**
     * GEOMETRY PROVENANCE — what the pipeline did to what the templates asked
     * for, stage by stage. Turn on, regenerate, then read. See massingTrace:
     * every other audit here grades a model, and this is the only one that
     * asks whether the world matches the code's own declaration.
     */
    massingTrace: { enable: setMassingTrace, read: () => massingTrace.rows },

    // === COORDINATE CONTRACT ===
    // Horizontal arguments here are TILE coordinates, because everything that
    // calls this speaks tiles: the audit reports tile positions, the map is a
    // tile grid, and the tools frame shots by grid cell. Vertical arguments
    // are world units (metres), because a camera height of 1.6 means eye
    // height and nothing else. The renderer below the bridge is all world
    // space, so the conversion happens right here — see renderer3d/scale.ts.

    /** Terrain surface height (world Y) under a TILE coordinate. */
    heightAt: (tx: number, tz: number) =>
      getActiveThreeRenderer()?.debugHeightAt(tx * TILE, tz * TILE) ?? null,

    /**
     * WHAT A PLAYER STANDING HERE WOULD BE ON — terrain, or a deck above it.
     *
     * Deliberately NOT folded into `heightAt`. That one means the terrain and
     * five tools read it that way; a walkable deck is a different question and
     * gets a different name. traverse.mjs has to use THIS one or it would
     * grade the fix against the surface the fix was about.
     */
    standAt: (tx: number, tz: number) =>
      getActiveThreeRenderer()?.debugStandAt(tx * TILE, tz * TILE) ?? null,

    /** Stand the walk camera on the ground at a TILE coordinate. */
    teleport: (tx: number, tz: number) =>
      getActiveThreeRenderer()?.debugTeleport(tx * TILE, tz * TILE) ?? null,

    lookAt: (yaw: number, pitch: number) =>
      getActiveThreeRenderer()?.debugLookAt(yaw, pitch) ?? null,

    /** Fly the camera (no gravity) to TILE x/z at world height y. */
    flyTo: (tx: number, y: number, tz: number, yaw: number, pitch: number) =>
      getActiveThreeRenderer()?.debugFlyTo(tx * TILE, y, tz * TILE, yaw, pitch) ?? null,

    /**
     * Fly the camera to a WORLD position. The tile-coordinate contract above is
     * right for a tool framing a grid cell and wrong for anything that has
     * already raycast the scene: tools/lib/vantage.mjs works entirely in metres
     * because that is what a Raycaster speaks, and converting to tiles at the
     * bridge only to multiply straight back is a unit round-trip with nothing
     * to gain and a factor of three to lose.
     */
    flyToWorld: (x: number, y: number, z: number, yaw: number, pitch: number) =>
      getActiveThreeRenderer()?.debugFlyTo(x, y, z, yaw, pitch) ?? null,

    /**
     * Start a shooting star NOW.
     *
     * The schedule fires one every 17-43 seconds of dark, which is right for
     * play and impossible to photograph by waiting — so the feature would be
     * exactly the kind of content this repo calls a GHOST: real, correct and
     * unverifiable. One line on the bridge turns it into a subject a tool can
     * point a camera at.
     */
    /**
     * WHERE THE MOON ACTUALLY IS, because `celestial.mjs` had the position
     * written into it as a literal `[0, 180, 0]`. Moving the moon left the
     * probe masking a patch of empty sky, and it reported `moonPhase` as
     * EXACTLY 0.00000 — which this repo already records as the tell that a
     * mask is off its subject rather than that a subject is dead. A tool that
     * restates a value the renderer owns is the terrain table again, in the
     * sky; deriving it is the only fix that cannot drift a second time.
     */
    moonPos: () => {
      const r = getActiveThreeRenderer()
      const d = r?.debugMoonPos()
      return d ? [d.x, d.y, d.z] : null
    },

    fireMeteor: () => getActiveThreeRenderer()?.fireMeteor() ?? null,

    /** Put every fish-rise site into its burst now — same argument as
     *  `fireMeteor`: a system that is visible 12% of the time photographs as
     *  an empty river four times in five. */
    burstRises: () => getActiveThreeRenderer()?.burstRises() ?? 0,

    /** The tile -> world factor, so no tool has to hardcode 3.0. */
    TILE,

    /**
     * The roof span caps, so provenance.mjs can ask how much of the town is
     * PINNED to them instead of carrying its own copy. It carried one for
     * exactly one session and the copy had already drifted — spire went 3.0 ->
     * 3.8 in the source and the tool went on reporting 100% at a cap that no
     * longer existed. Three copies of the terrain table taught this lesson
     * once already (core/terrain.ts).
     */
    roofCaps: () => ({ ...MAX_ROOF_SPAN_RATIO, _towerAspect: MAX_TOWER_ASPECT }),

    /**
     * EVERY LANTERN IN THE TOWN, by family. Three separate producers make a
     * lantern — a lamppost bulb, a wall bracket and a rope lantern — and the
     * moth pass draws from all three, so a census that cannot tell them apart
     * would read healthy while a whole family contributed nothing. Each
     * anchor states its own `kind`; particles.mjs tallies them.
     */
    lampAnchors: () => lampAnchors.map(a => ({ ...a })),

    /** Why each building pair did or did not get washing. See lanternStats. */
    lanternStats: () => ({ ...lanternStats }),

    /**
     * EVERY structure and prop as a feature vector — the input to
     * tools/odd.mjs, which ranks things by how unlike their peers they are.
     * See debugSceneFeatures.
     */
    sceneFeatures: () => getActiveThreeRenderer()?.debugSceneFeatures() ?? null,

    /**
     * World-space AABB of one placed structure, by object id — the anchor
     * tools/lib/vantage.mjs frames against. See debugStructureBox.
     */
    structureBox: (id: string) => getActiveThreeRenderer()?.debugStructureBox(id) ?? null,

    /**
     * Look down at a tile from `height` tiles up and `back` tiles away — the
     * standard "show me this placement" shot. Both distances are in TILES so
     * the framing stays put whatever the tile factor is.
     */
    inspectTile: (tx: number, tz: number, height = 14, back = 12) => {
      const r = getActiveThreeRenderer()
      if (!r) return null
      const yaw = Math.PI / 4 // look toward +x/+z
      const backW = back * TILE, heightW = height * TILE
      const camX = tx * TILE - backW * Math.cos(yaw)
      const camZ = tz * TILE - backW * Math.sin(yaw)
      const camY = r.debugHeightAt(tx * TILE, tz * TILE) + heightW
      const pitch = -Math.atan2(heightW, backW)
      r.debugFlyTo(camX, camY, camZ, yaw, pitch)
      return { camX, camY, camZ, yaw, pitch }
    },
  }
}
