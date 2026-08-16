/**
 * VANTAGE — put the camera somewhere it can actually SEE the thing, and prove
 * it did.
 *
 * Every camera-placing tool in this repo has reinvented "find a spot to stand"
 * out of the tile map, and every one of them has put the camera inside a
 * building at least once. rivershot.mjs documents it, asset.mjs documents it,
 * bridgeshot.mjs was written *because* of it — four attempts in one session to
 * photograph a bridge, each one a black frame I then reasoned about instead of
 * looking at. The common cause is that a tile being free says nothing about
 * whether the LINE OF SIGHT to the subject is clear, and `flyTo` does not test
 * anything at all.
 *
 * So: raycast. Try candidate cameras, ask the SCENE whether the ray from each
 * one reaches the subject, and take the first that does. The answer is exact,
 * and when nothing works it names the mesh in the way instead of handing back
 * a dark rectangle to guess about.
 *
 * Then project the subject's box back to the screen, and refuse the shot if it
 * lands as a speck or runs off the edge. A clear ray is necessary and not
 * sufficient: judging a 4x2 bridge from a 935px view of a whole town is
 * reading thirty pixels, and thirty pixels is exactly what let a plank pass
 * for a bridge.
 *
 *   import { lookAt, cropTo, FRAME } from './lib/vantage.mjs'
 *   const v = await lookAt(win, { min: [x0,y0,z0], max: [x1,y1,z1] })
 *   if (!v.ok) { console.log(v.why); continue }
 *   await win.screenshot({ clip: cropTo(v.screen, FRAME), path: '...' })
 */

/** The 3D canvas inside the desktop shell — every tool here clips to it. */
export const FRAME = { x: 232, y: 40, width: 935, height: 806 }

/**
 * Hide the in-app overlays before capturing. `.walk-hint` sits dead centre of
 * the viewport; the FPS readout and the Screenshot button sit in two corners.
 * A full-frame shot mostly gets away with all three, and a CROPPED one does
 * not — the tighter the frame, the larger a share of it the chrome is.
 */
export async function hideChrome(win) {
  await win.evaluate(() => {
    for (const el of document.querySelectorAll('.walk-hint, .hud-chrome, .panel-toggle')) {
      el.style.display = 'none'
    }
  })
}

/**
 * Place the camera with a verified clear view of a world-space box, settle the
 * frame, render, and report where the subject landed on screen.
 *
 * @param win           playwright page
 * @param box           { min:[x,y,z], max:[x,y,z] } in WORLD units (metres)
 * @param opts.dists    standoff distances in metres, tried nearest first
 * @param opts.heights  camera heights above the box centre, in metres
 * @param opts.dirs     how many compass directions to try
 * @param opts.maxFill  largest fraction of the half-frame the subject may span
 * @param opts.minFill  smallest — below this it is a speck and not evidence
 * @param opts.prefer   bearing(s) to shoot from, in radians — one or several
 * @param opts.arc      how far off `prefer` a candidate may stray, in radians.
 *                      Default is anywhere. Narrow it when the SIDE matters:
 *                      a bridge photographed from three-quarters-on down a
 *                      street is unoccluded, correctly framed and useless, and
 *                      a preference alone will happily wander there.
 */
export async function lookAt(win, box, opts = {}) {
  const cfg = {
    dists: opts.dists ?? [8, 12, 18, 26, 36, 50],
    heights: opts.heights ?? [2, 5, 10, 18, 30],
    dirs: opts.dirs ?? 16,
    maxFill: opts.maxFill ?? 0.8,
    minFill: opts.minFill ?? 0.1,
    prefer: opts.prefer == null ? null
      : (Array.isArray(opts.prefer) ? opts.prefer : [opts.prefer]),
    arc: opts.arc ?? Math.PI,
    // Which loop is outer. 'dist' takes the nearest workable camera, which is
    // right for a plan shot. 'height' exhausts every DISTANCE at eye level
    // before it will consider going up — right for anything whose walls are
    // the subject, because a shot from 28m looking down cannot show you a
    // wall, and the first version of this tool cheerfully took one to grade
    // whether a facade was textured.
    order: opts.order ?? 'dist',
    // 'first' takes the first clear candidate. 'largest' finishes the tier and
    // keeps the one where the subject covers the most screen — which for a
    // FLAT subject is the difference between a picture and a stick. The prop
    // hunt framed a two-post shop sign 16cm edge-on, correctly and
    // unoccludedly, and the resulting photograph could not answer the question
    // it was taken to answer.
    pick: opts.pick ?? 'first',
  }
  return win.evaluate(async ({ box, cfg }) => {
    const pt = window.__pt, three = pt.renderer(), THREE = pt.THREE
    if (!three || !THREE) return { ok: false, why: 'no renderer or THREE on the bridge' }
    const cam = three.camera
    const target = new THREE.Vector3(
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2,
    )

    // What can actually stop a view. The sky dome would swallow every ray, and
    // the things you can see THROUGH must not count as walls — the water is
    // 0.88 opaque and a lamp pool is a decal, and treating either as scenery
    // would rule out every vantage over a river, which is most of them.
    const seeThrough = (m) => !m || m.depthWrite === false ||
      (m.transparent === true && (m.opacity ?? 1) < 0.9)
    const blockers = []
    three.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return
      if (o === three.skyMesh || o.name === 'skyDome') return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      if (mats.every(seeThrough)) return
      blockers.push(o)
    })
    const ray = new THREE.Raycaster()

    /**
     * Distance at which a ray first touches the subject's box. The ray must
     * stop HERE and not at some fraction of the way to the box's centre — the
     * centre is inside the solid, so a ray aimed at it always hits the subject
     * itself, and the first cut of this dutifully reported every bridge in
     * town as occluded by its own parapet. Standard slab test.
     */
    const enterAt = (eye, dir) => {
      let t0 = -Infinity, t1 = Infinity
      for (let k = 0; k < 3; k++) {
        const o = [eye.x, eye.y, eye.z][k], d = [dir.x, dir.y, dir.z][k]
        const lo = [box.min[0], box.min[1], box.min[2]][k]
        const hi = [box.max[0], box.max[1], box.max[2]][k]
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) return null; continue }
        let a = (lo - o) / d, b = (hi - o) / d
        if (a > b) { const s = a; a = b; b = s }
        t0 = Math.max(t0, a); t1 = Math.min(t1, b)
      }
      return t1 < Math.max(0, t0) ? null : t0
    }

    /** What, if anything, stands between `eye` and the subject. */
    const blockedBy = (eye) => {
      const dir = target.clone().sub(eye).normalize()
      const hitBox = enterAt(eye, dir)
      if (hitBox == null) return 'aim missed the subject box'
      ray.set(eye, dir)
      ray.near = 0
      ray.far = Math.max(0.05, hitBox - 0.05)
      const hits = ray.intersectObjects(blockers, false)
      return hits.length === 0 ? null : (hits[0].object.name || 'unnamed mesh')
    }

    // Compass order. With preferred bearings, walk outward from the nearest of
    // them, and drop anything further off than `arc` — that is the difference
    // between "shoot from the channel if you can" and "shoot from the channel".
    const TAU = Math.PI * 2
    const off = (i) => {
      if (!cfg.prefer) return 0
      const a = (i / cfg.dirs) * TAU
      return Math.min(...cfg.prefer.map((p) => {
        const d = Math.abs(((a - p) % TAU + TAU + Math.PI) % TAU - Math.PI)
        return d
      }))
    }
    const order = []
    for (let i = 0; i < cfg.dirs; i++) if (off(i) <= cfg.arc + 1e-6) order.push(i)
    order.sort((a, b) => off(a) - off(b))

    const project = (eye) => {
      // The renderer aims with camera.lookAt() off cameraYaw/cameraPitch, and
      // applies it on the NEXT tick — so asking flyTo and projecting straight
      // away reads the PREVIOUS orientation. Do the same lookAt here, on the
      // same camera, where it takes effect immediately.
      cam.position.copy(eye)
      cam.lookAt(target)
      cam.updateMatrixWorld(true)
      const xs = [], ys = []
      for (const gx of [box.min[0], box.max[0]])
        for (const gy of [box.min[1], box.max[1]])
          for (const gz of [box.min[2], box.max[2]]) {
            const v = new THREE.Vector3(gx, gy, gz).project(cam)
            if (v.z > 1) return null                 // corner behind the camera
            xs.push(v.x); ys.push(v.y)
          }
      return { xs, ys }
    }

    // (dist, height) pairs in the requested priority.
    const pairs = []
    if (cfg.order === 'height') {
      for (const hUp of cfg.heights) for (const dist of cfg.dists) pairs.push([dist, hUp])
    } else {
      for (const dist of cfg.dists) for (const hUp of cfg.heights) pairs.push([dist, hUp])
    }

    let firstBlocker = null, nearMiss = null
    let win_ = null
    search:
    {
      for (const [dist, hUp] of pairs) {
        for (const i of order) {
          if (cfg.pick === 'largest' && win_ && (win_.dist !== dist || win_.up !== hUp)) break search
          const a = (i / cfg.dirs) * Math.PI * 2
          const eye = new THREE.Vector3(
            target.x + Math.cos(a) * dist, target.y + hUp, target.z + Math.sin(a) * dist)
          const hit = blockedBy(eye)
          if (hit) { firstBlocker ??= hit; continue }

          const p = project(eye)
          if (!p) continue
          const w = (Math.max(...p.xs) - Math.min(...p.xs)) / 2
          const h = (Math.max(...p.ys) - Math.min(...p.ys)) / 2
          if (w > cfg.maxFill || h > cfg.maxFill) { nearMiss ??= 'too close'; continue }
          if (w < cfg.minFill && h < cfg.minFill) { nearMiss ??= 'too far — a speck'; continue }
          if (Math.min(...p.xs) < -1 || Math.max(...p.xs) > 1 ||
              Math.min(...p.ys) < -1 || Math.max(...p.ys) > 1) {
            nearMiss ??= 'runs off the edge of frame'; continue
          }
          const area = w * h
          if (cfg.pick === 'largest') {
            // Keep scanning THIS tier for a broader view; do not walk further
            // out, because distance costs more than bearing does.
            if (!win_ || area > win_.area) win_ = { eye, dist, up: hUp, bearing: a, area }
            continue
          }
          win_ = { eye, dist, up: hUp, bearing: a, area }
          break search
        }
      }
    }
    if (!win_) {
      return {
        ok: false,
        why: firstBlocker
          ? `no clear view — nearest blocker "${firstBlocker}"${nearMiss ? `; unoccluded candidates were ${nearMiss}` : ''}`
          : `no candidate framed the subject (${nearMiss ?? 'nothing tried'})`,
      }
    }

    // Hand the pose to the app so its own loop keeps it, then let the frame
    // settle — shadows update on demand and particles need a tick.
    const flat = Math.hypot(target.x - win_.eye.x, target.z - win_.eye.z)
    const yaw = Math.atan2(target.z - win_.eye.z, target.x - win_.eye.x)
    const pitch = -Math.atan2(win_.eye.y - target.y, Math.max(0.01, flat))
    pt.flyToWorld(win_.eye.x, win_.eye.y, win_.eye.z, yaw, pitch)
    for (let k = 0; k < 8; k++) await new Promise((r) => requestAnimationFrame(r))
    await new Promise((r) => setTimeout(r, 350))

    // Re-project AFTER settling, so the screen box describes the frame that is
    // actually about to be captured rather than the one we planned.
    const p = project(win_.eye)
    three.renderer.render(three.scene, three.camera)
    const xs = p.xs, ys = p.ys
    return {
      ok: true,
      eye: [win_.eye.x, win_.eye.y, win_.eye.z],
      dist: win_.dist, up: win_.up, bearing: win_.bearing, yaw, pitch,
      // Normalised 0..1 screen box, for cropping the screenshot.
      screen: {
        x0: (Math.min(...xs) + 1) / 2, x1: (Math.max(...xs) + 1) / 2,
        y0: (1 - Math.max(...ys)) / 2, y1: (1 - Math.min(...ys)) / 2,
      },
      fill: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2,
    }
  }, { box, cfg })
}

/**
 * MEASURE THE PIXELS THE SUBJECT ACTUALLY OCCUPIES.
 *
 * The other half of "I cannot perceive it". Framing got me a picture; this
 * stops the verdict being my eyeball on that picture. A blank untextured shaft
 * and a richly detailed facade are the same object to every data audit here —
 * both are legal geometry with legal dimensions — and they are not remotely
 * the same number of edges.
 *
 * THE MASK HAS TO BE EXACT. The first cut measured the whole projected BOX and
 * reported a windmill with 554 square metres of bare wall as "reads as
 * detailed", because the box also contained sky, a street and four neighbours.
 * A tool's numerator and denominator have to count the same population, and
 * the population here is "pixels showing this building".
 *
 * So raycast the grid: for each sample point in the box, cast from the camera
 * through that pixel and ask whether the FIRST thing hit lies inside the
 * subject's own world AABB. That is exact, it costs a few thousand rays, and
 * it is the same argument as stopping the occlusion ray at the box rather than
 * at 98% of the way to its centre — prefer the exact test to the proxy.
 *
 * Returns, over subject pixels only:
 *   cover      share of the box that is actually the subject
 *   luma       mean brightness 0..1
 *   contrast   standard deviation of luma — a flat slab is near zero
 *   edges      share of adjacent sample pairs with a real gradient step
 *   colors     distinct colours at 4 bits per channel
 */
export async function subjectPixels(win, screen, box, grid = 56) {
  return win.evaluate(({ s, box, grid }) => {
    const pt = window.__pt, three = pt.renderer(), THREE = pt.THREE
    const cv = three?.renderer?.domElement
    if (!cv || !THREE) return null
    three.renderer.render(three.scene, three.camera)
    const W = cv.width, H = cv.height
    const x0 = Math.max(0, Math.floor(s.x0 * W)), x1 = Math.min(W, Math.ceil(s.x1 * W))
    const y0 = Math.max(0, Math.floor(s.y0 * H)), y1 = Math.min(H, Math.ceil(s.y1 * H))
    const w = Math.max(2, x1 - x0), h = Math.max(2, y1 - y0)
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const g = c.getContext('2d', { willReadFrequently: true })
    g.drawImage(cv, x0, y0, w, h, 0, 0, w, h)
    const px = g.getImageData(0, 0, w, h).data

    // Everything that can be hit, on the same terms lookAt uses.
    const seeThrough = (m) => !m || m.depthWrite === false ||
      (m.transparent === true && (m.opacity ?? 1) < 0.9)
    const blockers = []
    three.scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return
      if (o === three.skyMesh || o.name === 'skyDome') return
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      if (mats.every(seeThrough)) return
      blockers.push(o)
    })
    const ray = new THREE.Raycaster()
    const ndc = new THREE.Vector2()
    const inBox = (p) => p.x >= box.min[0] - 0.15 && p.x <= box.max[0] + 0.15 &&
      p.y >= box.min[1] - 0.15 && p.y <= box.max[1] + 0.15 &&
      p.z >= box.min[2] - 0.15 && p.z <= box.max[2] + 0.15

    const gw = Math.min(grid, w), gh = Math.min(grid, h)
    const mask = new Uint8Array(gw * gh)
    const lum = new Float32Array(gw * gh)
    const seen = new Set()
    let hits = 0, sum = 0
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const cx = x0 + Math.floor((gx + 0.5) * w / gw)
        const cy = y0 + Math.floor((gy + 0.5) * h / gh)
        ndc.set((cx / W) * 2 - 1, -((cy / H) * 2 - 1))
        ray.setFromCamera(ndc, three.camera)
        ray.near = 0; ray.far = 500
        const hit = ray.intersectObjects(blockers, false)[0]
        if (!hit || !inBox(hit.point)) continue
        const li = ((cy - y0) * w + (cx - x0)) * 4
        const r = px[li] / 255, gg = px[li + 1] / 255, b = px[li + 2] / 255
        const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b
        const i = gy * gw + gx
        mask[i] = 1; lum[i] = L; sum += L; hits++
        seen.add(((px[li] >> 4) << 8) | ((px[li + 1] >> 4) << 4) | (px[li + 2] >> 4))
      }
    }
    if (hits < 12) return { cover: +(hits / (gw * gh)).toFixed(3), sparse: true }
    const mean = sum / hits
    let varsum = 0, pairs = 0, steps = 0
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const i = gy * gw + gx
        if (!mask[i]) continue
        varsum += (lum[i] - mean) ** 2
        for (const j of [i - 1, i - gw]) {
          if (j < 0 || !mask[j]) continue
          if (j === i - 1 && gx === 0) continue
          pairs++
          if (Math.abs(lum[i] - lum[j]) > 0.045) steps++
        }
      }
    }
    return {
      cover: +(hits / (gw * gh)).toFixed(3),
      samples: hits,
      luma: +mean.toFixed(3),
      contrast: +Math.sqrt(varsum / hits).toFixed(3),
      edges: +(pairs ? steps / pairs : 0).toFixed(3),
      colors: seen.size,
    }
  }, { s: screen, box, grid })
}

/**
 * Outline the subject on the page before capturing.
 *
 * asset.mjs learned this the expensive way: without a mark, the tool answers
 * "here is a street with your building somewhere in it", and two rounds went
 * on guessing which box in the frame was the lean-to. A crop narrows the
 * question; only the outline answers it.
 */
export async function markSubject(win, screen) {
  await win.evaluate((s) => {
    document.querySelectorAll('.pt-subject-mark').forEach((n) => n.remove())
    const cv = window.__pt.renderer()?.renderer?.domElement
    if (!cv) return
    const r = cv.getBoundingClientRect()
    const box = document.createElement('div')
    box.className = 'pt-subject-mark'
    Object.assign(box.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: 99999,
      left: `${r.left + s.x0 * r.width}px`, top: `${r.top + s.y0 * r.height}px`,
      width: `${(s.x1 - s.x0) * r.width}px`, height: `${(s.y1 - s.y0) * r.height}px`,
      border: '2px solid #ff00d0', boxShadow: '0 0 0 1px #000',
    })
    document.body.appendChild(box)
  }, screen)
}

/**
 * Crop a screenshot to the subject, padded, and never below a floor size — a
 * tight crop of a small thing is a big blurry rectangle, but a wide shot of it
 * is thirty pixels, and thirty pixels is what let a plank pass for a bridge.
 */
export function cropTo(screen, frame = FRAME, pad = 0.4, min = 0.34) {
  let x0 = screen.x0, x1 = screen.x1, y0 = screen.y0, y1 = screen.y1
  const padX = (x1 - x0) * pad, padY = (y1 - y0) * pad
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  // Square it up as well as floor it: a 20:1 letterbox of a bridge deck is
  // technically the subject and unreadable as a picture.
  const s = Math.max(min, x1 - x0, y1 - y0)
  x0 = cx - s / 2; x1 = cx + s / 2
  y0 = cy - s / 2; y1 = cy + s / 2
  // Slide back inside the frame rather than clipping, so the subject stays
  // centred when it sits near an edge.
  if (x0 < 0) { x1 -= x0; x0 = 0 }
  if (x1 > 1) { x0 -= x1 - 1; x1 = 1 }
  if (y0 < 0) { y1 -= y0; y0 = 0 }
  if (y1 > 1) { y0 -= y1 - 1; y1 = 1 }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(1, x1); y1 = Math.min(1, y1)
  return {
    x: Math.round(frame.x + x0 * frame.width),
    y: Math.round(frame.y + y0 * frame.height),
    width: Math.max(16, Math.round((x1 - x0) * frame.width)),
    height: Math.max(16, Math.round((y1 - y0) * frame.height)),
  }
}
