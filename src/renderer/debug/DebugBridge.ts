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
 *   __pt.teleport(x, z)      -> move the walk camera to a tile
 *   __pt.lookAt(yaw, pitch)  -> aim the camera (radians)
 *   __pt.heightAt(x, z)      -> terrain surface height used for placement
 */

import { useAppStore } from '../app/store'
import { auditMapGeometry } from '../renderer3d/GeometryAudit'
import { getActiveThreeRenderer } from '../ui/components/ThreeViewport'

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

    /** Vertical extent of the built scene — catches runaway spire geometry. */
    sceneStats: () => getActiveThreeRenderer()?.debugSceneStats() ?? null,

    heightAt: (x: number, z: number) =>
      getActiveThreeRenderer()?.debugHeightAt(x, z) ?? null,

    teleport: (x: number, z: number) =>
      getActiveThreeRenderer()?.debugTeleport(x, z) ?? null,

    lookAt: (yaw: number, pitch: number) =>
      getActiveThreeRenderer()?.debugLookAt(yaw, pitch) ?? null,

    /** Fly the camera to an arbitrary point (no gravity) — inspect from above. */
    flyTo: (x: number, y: number, z: number, yaw: number, pitch: number) =>
      getActiveThreeRenderer()?.debugFlyTo(x, y, z, yaw, pitch) ?? null,

    /**
     * Look down at a tile from `height` up and `back` away — the standard
     * "show me this placement" shot.
     */
    inspectTile: (tx: number, tz: number, height = 14, back = 12) => {
      const r = getActiveThreeRenderer()
      if (!r) return null
      const yaw = Math.PI / 4 // look toward +x/+z
      const camX = tx - back * Math.cos(yaw)
      const camZ = tz - back * Math.sin(yaw)
      const camY = r.debugHeightAt(tx, tz) + height
      const pitch = -Math.atan2(height, back)
      r.debugFlyTo(camX, camY, camZ, yaw, pitch)
      return { camX, camY, camZ, yaw, pitch }
    },
  }
}
