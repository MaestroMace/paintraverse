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
import { overhangClamps, resetOverhangClamps } from '../renderer3d/architecture/Massing'
import { getActiveThreeRenderer } from '../ui/components/ThreeViewport'
import { TILE } from '../renderer3d/scale'

export function installDebugBridge(): void {
  if (typeof window === 'undefined') return
  ;(window as any).__pt = {
    store: useAppStore,
    renderer: () => getActiveThreeRenderer(),

    /** Placement invariants over the CURRENT map — works with or without 3D. */
    audit: () => {
      const s = useAppStore.getState()
      return auditMapGeometry(s.map, s.objectDefinitions)
    },

    debugInfo: () => getActiveThreeRenderer()?.getDebugInfo() ?? null,

    /** Fragment-size audit of batched geometry. Turn on, regenerate the map,
     *  then read: shows how much geometry is too small to resolve on screen. */
    fragmentAudit: { enable: setFragmentAudit, read: getFragmentAudit },

    /** Long thin batched geometry — the "giant floating timber" class — keyed
     *  by the SOURCE LINE that emitted it, with a world position to fly to.
     *  Enable, regenerate the map, then read. */
    slivers: { enable: setSliverAudit, read: getSliverAudit },

    /** Volumes trimmed by the footprint-overhang cap, by definitionId:role.
     *  Non-empty means some template is throwing geometry at its neighbours. */
    overhangs: { read: () => ({ ...overhangClamps }), reset: resetOverhangClamps },

    /** Vertical extent of the built scene — catches runaway spire geometry. */
    sceneStats: () => getActiveThreeRenderer()?.debugSceneStats() ?? null,

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

    /** Stand the walk camera on the ground at a TILE coordinate. */
    teleport: (tx: number, tz: number) =>
      getActiveThreeRenderer()?.debugTeleport(tx * TILE, tz * TILE) ?? null,

    lookAt: (yaw: number, pitch: number) =>
      getActiveThreeRenderer()?.debugLookAt(yaw, pitch) ?? null,

    /** Fly the camera (no gravity) to TILE x/z at world height y. */
    flyTo: (tx: number, y: number, tz: number, yaw: number, pitch: number) =>
      getActiveThreeRenderer()?.debugFlyTo(tx * TILE, y, tz * TILE, yaw, pitch) ?? null,

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
