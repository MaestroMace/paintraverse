/**
 * WAIT FOR THE SCENE TO ACTUALLY BE BUILT.
 *
 * Every tool here waits for the 3D view with `waitForTimeout(2800)` or
 * similar — a number somebody guessed once. Under SwiftShader, on a town with
 * three hundred buildings, that number is sometimes enough and sometimes not,
 * and when it is not the tool measures a PARTIAL scene and reports it with
 * complete confidence.
 *
 * That is not a hypothesis. `node tools/harness.mjs --repeat=3` on identical
 * seeds read:
 *
 *     districts   character    49, 49, 49        spread 0
 *     provenance  outsideBox    0,  0,  0        spread 0
 *     roofcheck   openTops     14, 13, 16        spread 3
 *     odd         bareWall     40, 32, 43        spread 11
 *
 * districts reads the MAP and is perfectly stable, so the generator is
 * deterministic. Everything that reads the BUILT SCENE moves. The variance is
 * a race, not randomness — and a race that silently truncates your sample is
 * the sample-count lesson wearing a stopwatch.
 *
 * So poll instead of guessing: wait until the count of built structures stops
 * changing AND matches how many the map actually contains. Returns what it
 * settled on, or throws with the numbers so a timeout is a bug report rather
 * than a quiet undercount.
 */
export async function waitForScene(win, { timeoutMs = 45000, stableMs = 700 } = {}) {
  const t0 = Date.now()
  let last = -1, stableSince = 0, snap = null
  for (;;) {
    snap = await win.evaluate(() => {
      const pt = window.__pt
      const d = pt.debugInfo?.()
      const bf = d?.buildingFactory
      const st = pt.store.getState()
      const layer = st.map.layers.find((l) => l.type === 'structure')
      return {
        built: (bf?.succeeded ?? 0) + (bf?.failed ?? 0),
        succeeded: bf?.succeeded ?? 0,
        failed: bf?.failed ?? 0,
        wanted: layer?.objects?.length ?? 0,
        meshes: pt.sceneStats?.()?.meshes ?? 0,
      }
    })
    const key = `${snap.built}/${snap.meshes}`
    if (key !== String(last)) { last = key; stableSince = Date.now() }
    // Settled AND complete. "Settled" alone is not enough — a build that has
    // not started yet is perfectly stable at zero.
    else if (Date.now() - stableSince >= stableMs && snap.built > 0) {
      return snap
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `scene never settled: ${snap.built} of ${snap.wanted} structures built, ` +
        `${snap.meshes} meshes, after ${Math.round((Date.now() - t0) / 1000)}s`)
    }
    await win.waitForTimeout(250)
  }
}
