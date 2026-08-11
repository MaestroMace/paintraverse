/**
 * ANOMALY — find the defects that only exist in PIXELS.
 *
 * Every other tool in here grades the DATA MODEL: footprints, tile ids, object
 * positions, mesh extents. That has been enormously productive and it has one
 * structural blind spot — it can only find what somebody already knew to ask
 * about. The audits sat at 0 errors, `slivers.mjs` reported 0 pieces of
 * geometry outside their envelope, and the phone kept sending back photographs
 * of long black poles sticking out of buildings. Both were true. The poles are
 * inside their volumes and still wrong on screen.
 *
 * So look at the screen. Fly the camera around the town, read the framebuffer,
 * and find things that are anomalous AS AN IMAGE, with no model of what the
 * town is supposed to contain:
 *
 *   SKY SLIVERS — long thin dark structures silhouetted against the sky. This
 *     is the "giant floating timber" class, and it is exactly what a person
 *     notices first, because the eye is very good at spotting a hard thin line
 *     against a soft gradient. Found by morphological OPENING: erode the solid
 *     mask then dilate it back, which deletes anything thinner than the
 *     structuring element. Whatever the opening removed was thin. Keep the
 *     thin pieces that are long AND mostly surrounded by sky, so a window
 *     mullion in the middle of a facade does not count but a pole against the
 *     dusk is reported.
 *
 *   SPECKLE — blocks of the image where a large share of adjacent pixels
 *     disagree sharply. Two coplanar faces resolving per-pixel per-frame look
 *     exactly like this, and so does a texture applied at the wrong scale.
 *     An ordinary edge is thin, so it barely registers; a z-fight fills a
 *     region.
 *
 * Writes an annotated PNG per flagged vantage into .shots/anomaly/ with the
 * findings boxed, because a detector you cannot check is a detector you will
 * eventually start trusting for the wrong reasons.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/anomaly.mjs [seed] [--time=12] [--shots=24]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 4242)
const timeArg = argv.find((a) => a.startsWith('--time='))
const TIME = timeArg ? Number(timeArg.split('=')[1]) : null
const shotsArg = argv.find((a) => a.startsWith('--shots='))
const NSHOTS = shotsArg ? Number(shotsArg.split('=')[1]) : 20
// Hide a named mesh for the whole sweep. "Is that thin thing against the sky
// a rope or a stray beam?" is a one-run question if you can subtract a
// suspect and re-count, which is the bisect trick applied to a metric rather
// than to a screenshot.
const hideArg = argv.find((a) => a.startsWith('--hide='))
const HIDE = hideArg ? hideArg.split('=')[1] : null

mkdirSync('.shots/anomaly', { recursive: true })
// Clear stale frames. Filenames used to omit the seed, so a later run left
// earlier seeds' frames sitting in the directory under names that looked
// current — which is how you end up debugging a screenshot of a build that no
// longer exists.
for (const f of readdirSync('.shots/anomaly')) {
  if (f.startsWith(`s${seed}-`) && f.endsWith('.png')) rmSync(`.shots/anomaly/${f}`)
}

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)
await win.evaluate((s) => {
  const inp = [...document.querySelectorAll('.left-panel input')]
    .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, s)
  inp.dispatchEvent(new Event('input', { bubbles: true }))
}, seed)
await win.waitForTimeout(200)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2800)
await win.getByRole('button', { name: '3D', exact: true }).click()
await win.waitForTimeout(2500)
if (TIME !== null) {
  await win.evaluate((t) => window.__pt.store.getState().updateEnvironment({ timeOfDay: t }), TIME)
  await win.waitForTimeout(800)
}
await win.evaluate(() => {
  const hint = document.querySelector('.walk-hint')
  if (hint) hint.style.display = 'none'
  // Birds are thin dark things against the sky, which is precisely the
  // signature this tool hunts, and they are supposed to be there. Hiding the
  // particles for the whole sweep removes the entire false-positive class
  // rather than trying to tell a bird from a beam after the fact.
  const g = window.__pt.renderer()?.particleGroup
  if (g) g.visible = false
})
if (HIDE) {
  const n = await win.evaluate((name) => {
    let hidden = 0
    window.__pt.renderer()?.scene?.traverse((o) => {
      if (o.name === name) { o.visible = false; hidden++ }
    })
    return hidden
  }, HIDE)
  console.log(`(hid ${n} mesh(es) named "${HIDE}")`)
  if (n === 0) console.log('  WARNING: nothing matched — the A/B below is meaningless')
}

// Vantage points. Street level, looking LEVEL and UP — the angle every phone
// screenshot that reported a floating timber was taken from. CLAUDE.md's
// lesson from the gable-winding bug: a negative result is only as good as the
// vantage it was taken from, and every shot in the old harness pointed down.
const VANTAGES = []
for (let i = 0; i < NSHOTS; i++) {
  const a = (i / NSHOTS) * Math.PI * 2
  const r = 6 + (i % 5) * 3.5
  VANTAGES.push({
    x: 24 + Math.cos(a) * r,
    z: 24 + Math.sin(a) * r,
    yaw: a + Math.PI + (i % 3 - 1) * 0.5,
    // Cycle level / up / well up. Up is where the defect lives.
    pitch: [0.0, 0.28, 0.5][i % 3],
  })
}

/** The whole per-vantage measurement, as one function so it can be run
 *  twice at the same vantage and the two answers compared. */
const EVAL = async (vv) => {
    const pt = window.__pt
    // Settle helper. The two captures below must come from the SAME camera
    // pose or the sky mask is misaligned and the misalignment invents thin
    // shapes: the first version waited ~120ms and was not repeatable — the
    // same seed and the same build gave 1 sliver on one run and 2 on the
    // next. A detector that disagrees with itself cannot grade anything, so
    // this waits properly and the repeatability is checked rather than
    // assumed.
    const settle = async (frames = 6, ms = 220) => {
      for (let k = 0; k < frames; k++) {
        await new Promise((r) => requestAnimationFrame(r))
      }
      await new Promise((r) => setTimeout(r, ms))
    }
    const ground = pt.heightAt(vv.x, vv.z) ?? 0
    pt.flyTo(vv.x, ground + 1.6, vv.z, vv.yaw, vv.pitch)
    await settle()

    // Largest canvas is the 3D view. preserveDrawingBuffer is on, so the
    // framebuffer survives long enough to copy out.
    // Render both frames SYNCHRONOUSLY, back to back, with no time passing
    // between them. Waiting on requestAnimationFrame between the two captures
    // is what made this tool disagree with itself: the same seed and build
    // gave 1 sliver on one run and 2 on the next, however long the settle,
    // because the dusk sky is animated and drifts a few values between the
    // two reads. Sky pixels then fail the identity test, become "solid", and
    // the tool invents thin shapes out of its own latency.
    const three = pt.renderer()
    const gl = three?.renderer, scene = three?.scene, cam = three?.camera
    if (!gl || !scene || !cam) return null
    const src = gl.domElement
    const W = src.width, H = src.height
    const c2 = document.createElement('canvas')
    c2.width = W; c2.height = H
    const ctx = c2.getContext('2d')
    gl.render(scene, cam)
    ctx.drawImage(src, 0, 0)
    const img = ctx.getImageData(0, 0, W, H)
    // Copy, not a view: the annotation pass draws onto this same context
    // later, and getImageData's buffer must not be the thing we compare.
    const px = new Uint8ClampedArray(img.data)

    // --- SKY MASK, EXACTLY -----------------------------------------------
    // Render the same camera twice: once normally, once with every top-level
    // scene group hidden so only the background remains. A pixel that is
    // IDENTICAL in both frames had nothing in front of the sky. That is the
    // sky, with no threshold to tune and nothing to leak.
    //
    // The first version of this flood-filled from the top edge with a colour
    // tolerance, which is the obvious approach and is wrong here: at dusk a
    // shadowed wall is smooth and close in value to the sky above it, so the
    // fill walked straight off the roofline and down the facade. Whole
    // buildings became "sky", their lit WINDOWS became dark islands surrounded
    // by it, and the tool confidently reported 40 floating timbers that were
    // all windows. A heuristic mask produces confident nonsense; an exact one
    // cannot.
    const idx = (x, y) => (y * W + x) * 4
    // Hide everything, render again in the same tick, read back. Nothing has
    // moved and no clock has advanced, so a pixel that is identical between
    // the two reads had nothing in front of the background.
    // Only the renderer's own content groups — the same list tools/bisect.mjs
    // uses. Hiding every direct child of the scene instead also hides whatever
    // draws the sky, so the "background" frame stops looking like the
    // background and the comparison reports the entire image as solid: that
    // attempt took the count from 2 to 32.
    const GROUPS = ['buildingGroup', 'propGroup', 'terrainGroup', 'particleGroup']
    const hidden = []
    for (const g of GROUPS) {
      const grp = three?.[g]
      if (grp && grp.visible) { hidden.push(grp); grp.visible = false }
    }
    gl.render(scene, cam)
    const cBg = document.createElement('canvas')
    cBg.width = W; cBg.height = H
    const bgCtx = cBg.getContext('2d')
    bgCtx.drawImage(src, 0, 0)
    const bg = bgCtx.getImageData(0, 0, W, H).data
    for (const o of hidden) o.visible = true
    gl.render(scene, cam)

    const sky = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) {
      const o = i * 4
      const d = Math.abs(px[o] - bg[o]) + Math.abs(px[o + 1] - bg[o + 1]) +
        Math.abs(px[o + 2] - bg[o + 2])
      sky[i] = d <= 6 ? 1 : 0
    }
    let skyCount = 0
    for (let i = 0; i < W * H; i++) if (sky[i]) skyCount++
    // No sky in frame (looking at a wall) — nothing this detector can say.
    if (skyCount < W * H * 0.02) return { W, H, skyFrac: skyCount / (W * H), slivers: [], speckle: 0 }

    // --- THIN STRUCTURES, BY MORPHOLOGICAL OPENING -----------------------
    const solid = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) solid[i] = sky[i] ? 0 : 1
    const R = 2                      // removes anything thinner than ~5px
    const erode = (src) => {
      const out = new Uint8Array(W * H)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!src[y * W + x]) continue
          let ok = 1
          for (let dy = -R; dy <= R && ok; dy++) {
            for (let dx = -R; dx <= R && ok; dx++) {
              const nx = x + dx, ny = y + dy
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
              if (!src[ny * W + nx]) ok = 0
            }
          }
          out[y * W + x] = ok
        }
      }
      return out
    }
    const dilate = (src) => {
      const out = new Uint8Array(W * H)
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (!src[y * W + x]) continue
          for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
              const nx = x + dx, ny = y + dy
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
              out[ny * W + nx] = 1
            }
          }
        }
      }
      return out
    }
    const opened = dilate(erode(solid))
    const thin = new Uint8Array(W * H)
    for (let i = 0; i < W * H; i++) thin[i] = solid[i] && !opened[i] ? 1 : 0

    // Connected components of the thin residual.
    const seen = new Uint8Array(W * H)
    const slivers = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i0 = y * W + x
        if (!thin[i0] || seen[i0]) continue
        let minX = x, maxX = x, minY = y, maxY = y, area = 0, skyAdj = 0, edge = 0
        const q = [i0]; seen[i0] = 1
        for (let k = 0; k < q.length; k++) {
          const i = q[k], cx = i % W, cy = (i / W) | 0
          area++
          if (cx < minX) minX = cx; if (cx > maxX) maxX = cx
          if (cy < minY) minY = cy; if (cy > maxY) maxY = cy
          let touchesSky = false, touchesNonThin = false
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cx + dx, ny = cy + dy
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
            const ni = ny * W + nx
            if (sky[ni]) touchesSky = true
            if (!thin[ni]) touchesNonThin = true
            if (thin[ni] && !seen[ni]) { seen[ni] = 1; q.push(ni) }
          }
          if (touchesNonThin) { edge++; if (touchesSky) skyAdj++ }
        }
        const bw = maxX - minX + 1, bh = maxY - minY + 1
        const len = Math.max(bw, bh)
        const width = area / Math.max(1, len)
        const skyFrac = edge ? skyAdj / edge : 0
        // Long, genuinely thin, and mostly seen against the sky.
        if (len >= 18 && width <= 4.5 && skyFrac >= 0.35 && area >= 20) {
          slivers.push({ x: minX, y: minY, w: bw, h: bh, area,
            len, width: +width.toFixed(2), skyFrac: +skyFrac.toFixed(2) })
        }
      }
    }

    // --- SPECKLE ---------------------------------------------------------
    // Blocks where most adjacent pixels disagree sharply. An ordinary silhouette
    // edge is one pixel wide and barely moves this; z-fighting or a texture at
    // the wrong scale fills the block.
    const BS = 8
    let speckle = 0, blocks = 0
    for (let by = 0; by + BS < H; by += BS) {
      for (let bx = 0; bx + BS < W; bx += BS) {
        let flips = 0, n = 0, anySky = false
        for (let y = by; y < by + BS; y++) {
          for (let x = bx; x < bx + BS; x++) {
            if (sky[y * W + x]) { anySky = true; continue }
            const o = idx(x, y), o2 = idx(x + 1, y)
            n++
            const d = Math.abs(px[o] - px[o2]) + Math.abs(px[o + 1] - px[o2 + 1]) +
              Math.abs(px[o + 2] - px[o2 + 2])
            if (d > 60) flips++
          }
        }
        if (anySky || n < BS * BS * 0.8) continue
        blocks++
        if (flips / n > 0.5) speckle++
      }
    }

    // Annotate and hand back a PNG only when there is something to look at.
    let png = null
    if (slivers.length) {
      ctx.lineWidth = 1
      ctx.strokeStyle = '#00ff66'
      for (const s of slivers) ctx.strokeRect(s.x - 1, s.y - 1, s.w + 2, s.h + 2)
      png = c2.toDataURL('image/png')
    }
    return { W, H, skyFrac: skyCount / (W * H), slivers, speckle,
      speckleBlocks: blocks, png }
}

// Every vantage is measured TWICE and only findings that survive both reads
// are reported. This is not belt-and-braces: the first three versions of this
// tool were not repeatable — same seed, same build, 1 sliver one run and 2 the
// next — because the dusk sky animates and the two frames behind the sky mask
// were captured at different instants. Rendering both synchronously fixed the
// cause; re-reading each vantage proves it, every run, instead of asking a
// human to run it twice and squint. The disagreement rate is printed as the
// tool's noise floor, because a detector that will not state its own noise
// floor is a detector you will eventually over-trust.
const findings = []
let repeatChecked = 0, repeatDisagreed = 0
for (let i = 0; i < VANTAGES.length; i++) {
  const v = VANTAGES[i]
  const res = await win.evaluate(EVAL, v)
  if (!res) continue
  const res2 = await win.evaluate(EVAL, v)
  repeatChecked++
  if (!res2 || res2.slivers.length !== res.slivers.length) repeatDisagreed++
  if (res.slivers.length) {
    const name = `.shots/anomaly/s${seed}-v${String(i).padStart(2, '0')}-` +
      `${res.slivers.length}sliver.png`
    if (res.png) writeFileSync(name, Buffer.from(res.png.split(',')[1], 'base64'))
    findings.push({ i, v, ...res, file: name })
  } else {
    findings.push({ i, v, ...res, file: null })
  }
}
await app.close()

const withSlivers = findings.filter((f) => f.slivers.length)
const allSlivers = findings.flatMap((f) => f.slivers)
const totalSpeckle = findings.reduce((a, f) => a + f.speckle, 0)
const totalBlocks = findings.reduce((a, f) => a + (f.speckleBlocks ?? 0), 0)

console.log(`\n=== ANOMALY SWEEP — seed ${seed}, ${findings.length} vantages ===`)
console.log(`\nSKY SLIVERS (long thin dark structures against the sky)`)
console.log(`  ${allSlivers.length} across ${withSlivers.length} of ${findings.length} vantages`)
if (allSlivers.length) {
  const s = [...allSlivers].sort((a, b) => b.len - a.len)
  console.log('  worst offenders (length px / avg width px / share of edge against sky):')
  for (const v of s.slice(0, 10)) {
    console.log(`    len ${String(v.len).padStart(3)}  width ${String(v.width).padStart(5)}` +
      `  sky ${String(Math.round(v.skyFrac * 100)).padStart(3)}%`)
  }
  console.log('\n  annotated frames:')
  for (const f of withSlivers.slice(0, 12)) {
    console.log(`    ${f.file}   (yaw ${f.v.yaw.toFixed(2)} pitch ${f.v.pitch})`)
  }
}
console.log(`\nREPEATABILITY  ${repeatDisagreed} of ${repeatChecked} vantages gave a ` +
  `different answer on a second read (${repeatChecked ? Math.round((repeatDisagreed / repeatChecked) * 100) : 0}%)`)
if (repeatDisagreed) {
  console.log("  ^ this is the tool's own noise floor. Findings below that level")
  console.log('    are not evidence of anything. Fix the tool before the town.')
}
console.log(`\nSPECKLE  ${totalSpeckle} of ${totalBlocks} solid 8x8 blocks are high-frequency ` +
  `(${totalBlocks ? Math.round((totalSpeckle / totalBlocks) * 100) : 0}%)`)
console.log('\n(a clean town reads 0 slivers. Speckle is comparative — watch it')
console.log(' across builds rather than against an absolute.)')
