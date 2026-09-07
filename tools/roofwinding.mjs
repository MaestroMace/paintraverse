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

/**
 * AND THE RIDGE THE CAP CLAIMS, AGAINST THE RIDGE THE ROOF HAS.
 *
 * Winding says whether a face is DRAWN. It has nothing to say about whether
 * the thing sitting on that face FITS, and that gap had a live defect in it
 * for the life of the hipped roof: the prism topped out in a flat square
 * plateau of half-side `min(hw,hd)*0.25` while the ridge cap spanned
 * `alongDim - 2*inset`, so a 6m building carried a 5.25m board at peak height
 * over 0.75m of roof — reported from the device as "a board stuck to the top
 * of them jutting out on both long ends".
 *
 * `ridgeBuilt` is measured from the VERTICES at the solid's own maximum Y, so
 * it cannot inherit either formula's bug. `capped` comes from the same
 * `hasRidge` predicate that gates the cap, so a new roof style joins this
 * check by joining the feature.
 */
console.log('\n=== RIDGE (does the cap fit the roof it sits on?) ===')
let overhang = 0
for (const r of rows) {
  if (!r.capped) continue
  const over = r.ridgeClaimed - r.ridgeBuilt
  const badRidge = over > 1e-3
  if (badRidge) overhang++
  console.log(
    `${r.style.padEnd(8)} axis=${r.axis} sag=${r.sag}` +
    `  built=${r.ridgeBuilt.toFixed(2)}m  claimed=${r.ridgeClaimed.toFixed(2)}m` +
    (badRidge ? `  <-- CAP OVERHANGS BY ${(over * 2).toFixed(2)}m, ${over.toFixed(2)} EACH END` : ''))
}
console.log(`\nCAPS LONGER THAN THEIR OWN RIDGE: ${overhang}`)
if (bad > 0 || overhang > 0) process.exit(1)
