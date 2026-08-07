/**
 * Roof winding audit — which roof faces are invisible, and why.
 *
 * The batched material is FrontSide, so a triangle wound the wrong way is
 * DELETED, not merely mis-lit. "Half the roof is invisible from every angle"
 * is exactly what that looks like, and no screenshot can identify the culprit:
 * you cannot photograph a face that is not drawn. Camera-based checking has
 * already produced one confident false negative on this exact bug.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/roofwinding.mjs
 */
import { _electron as electron } from 'playwright-core'

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3500)

const rows = await win.evaluate(() => window.__pt.roofWinding())
await app.close()

console.log('\n=== ROOF WINDING (inward-facing triangles are invisible) ===')
let bad = 0
for (const r of rows) {
  const flag = r.inward > 0 ? `  <-- ${r.inward} INVISIBLE  ${r.inwardCentroids.join(' ')}` : ''
  if (r.inward > 0) bad += r.inward
  console.log(
    `${r.style.padEnd(8)} axis=${r.axis} sag=${r.sag}` +
    `  tris=${String(r.triangles).padStart(3)}  inward=${String(r.inward).padStart(3)}${flag}`)
}
console.log(`\nTOTAL INWARD-FACING TRIANGLES: ${bad}`)
