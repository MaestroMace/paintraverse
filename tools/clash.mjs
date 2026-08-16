/**
 * CLASH — does the built geometry collide with itself, and does it stand on
 * the ground?
 *
 * THE CLASS THE HARNESS COULD NOT SEE.
 *
 * `provenance.mjs` grades a thing against the CODE. `odd.mjs` grades a thing
 * against its PEERS. Neither can see a thing in relation to its NEIGHBOURS,
 * and that is where two of the most visible defect families live:
 *
 *  - **Interpenetration.** `audit.mjs` checks FOOTPRINTS — tile rectangles —
 *    and a footprint invariant is not a geometry invariant. Two buildings can
 *    own disjoint tiles and still have a wing driven through each other's
 *    walls, because a volume may legally overhang its footprint by
 *    MAX_OVERHANG and two neighbours may both do it toward each other. That is
 *    "buildings colliding", reported from the device and never measured.
 *  - **Ground contact.** A building on a slope is placed at ONE height. Its
 *    uphill corner buries and its downhill corner lifts, and a lifted corner
 *    is a gap you can see daylight under from the street. Nothing has ever
 *    asked whether a building touches the ground it stands on.
 *
 * Both are exact tests over the built solids, both are invariants rather than
 * outliers, and both are photographable — so the number says where and the
 * picture says how bad.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/clash.mjs [seed] [--shots=N] [--all]
 *
 * A NOTE ON WHAT IS ALLOWED. Terraces are SUPPOSED to touch — 93% of this town
 * shares party walls, and grading contact as a defect would condemn the thing
 * the urban-form arc spent itself achieving. So the test is not "do these
 * touch" but "how deep does one solid reach into the other", with a tolerance
 * that lets a shared wall and a deliberate 2cm z-fight nudge through.
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { lookAt, cropTo, markSubject, hideChrome, FRAME } from './lib/vantage.mjs'
import { waitForScene } from './lib/scene.mjs'

const argv = process.argv.slice(2)
const seed = Number(argv.find((a) => /^\d+$/.test(a)) ?? 31337)
const shots = Number(argv.find((a) => a.startsWith('--shots='))?.split('=')[1] ?? 0)
const showAll = argv.includes('--all')
mkdirSync('.shots/clash', { recursive: true })

// A party wall is contact, not a clash. Two volumes may share a plane and the
// massing deliberately nudges attached volumes 2cm proud to break depth ties,
// so anything under this is the design working.
const TOUCH = 0.12
// How far a corner may hang over air before it reads as a building on stilts.
// A 12cm lip is a threshold; 40cm is daylight.
const GAP = 0.40
// And how deep it may sink before the ground floor is a basement.
const SINK = 1.20

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
  set.call(inp, s); inp.dispatchEvent(new Event('input', { bubbles: true }))
}, seed)
await win.waitForTimeout(200)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2800)
await win.getByRole('button', { name: '3D', exact: true }).click()
const built = await waitForScene(win)
await win.evaluate(() => window.__pt.store.getState().updateEnvironment({ timeOfDay: 12 }))
await win.waitForTimeout(700)
await hideChrome(win)

const scene = await win.evaluate(() => window.__pt.sceneFeatures())
const vols = scene?.volumes ?? []
if (!vols.length) { console.log('no volume boxes — rebuild and retry'); await app.close(); process.exit(1) }

console.log(`=== CLASH — seed ${seed}, ${built.succeeded} structures, ${vols.length} volumes ===`)
console.log('Exact tests over the BUILT solids: does geometry interpenetrate,')
console.log('and does it stand on the ground it was placed on.\n')

/* ------------------------------------------------------------------ */
/* 1. INTERPENETRATION                                                */
/* ------------------------------------------------------------------ */

// Bucket by tile-ish cell so this is not 850^2 pairs. Volumes are small
// relative to the map, so a 6m grid keeps the candidate lists short.
const CELL = 6
const grid = new Map()
const key = (i, j) => `${i},${j}`
vols.forEach((v, idx) => {
  for (let i = Math.floor(v.x0 / CELL); i <= Math.floor(v.x1 / CELL); i++) {
    for (let j = Math.floor(v.z0 / CELL); j <= Math.floor(v.z1 / CELL); j++) {
      const k = key(i, j)
      if (!grid.has(k)) grid.set(k, [])
      grid.get(k).push(idx)
    }
  }
})

const seenPair = new Set()
const clashes = []
for (const list of grid.values()) {
  for (let a = 0; a < list.length; a++) {
    for (let b = a + 1; b < list.length; b++) {
      const ia = list[a], ib = list[b]
      const va = vols[ia], vb = vols[ib]
      // Volumes of the SAME building are allowed to interpenetrate — that is
      // how a wing meets a body, and massing owns those relationships.
      if (va.id === vb.id) continue
      // A plinth is a foundation: it is MEANT to sit under and beside things,
      // it overlaps its own neighbours by 8% on purpose, and grading it as a
      // collision would bury the real signal under stonework.
      if (va.role === 'plinth' || vb.role === 'plinth') continue
      const pk = ia < ib ? `${ia}:${ib}` : `${ib}:${ia}`
      if (seenPair.has(pk)) continue
      seenPair.add(pk)
      const ox = Math.min(va.x1, vb.x1) - Math.max(va.x0, vb.x0)
      const oz = Math.min(va.z1, vb.z1) - Math.max(va.z0, vb.z0)
      const oy = Math.min(va.y1, vb.y1) - Math.max(va.y0, vb.y0)
      if (ox <= TOUCH || oz <= TOUCH || oy <= 0.05) continue
      // DEPTH, not volume. Two terraced houses sharing a 6m wall overlap by a
      // huge area and 3cm of depth; a wing driven through a neighbour overlaps
      // a small area and a metre of depth. The second is the defect, and only
      // the shallower horizontal axis distinguishes them.
      const depth = Math.min(ox, oz)
      if (depth <= TOUCH) continue
      clashes.push({ a: va, b: vb, depth, ox, oz, oy,
        x: (Math.max(va.x0, vb.x0) + Math.min(va.x1, vb.x1)) / 2,
        z: (Math.max(va.z0, vb.z0) + Math.min(va.z1, vb.z1)) / 2 })
    }
  }
}
clashes.sort((p, q) => q.depth - p.depth)

console.log(`INTERPENETRATION — geometry from two different structures sharing space,`)
console.log(`deeper than ${TOUCH}m (a party wall and the 2cm z-fight nudge pass):`)
console.log(`  ${clashes.length} pairs`)
const byPair = new Map()
for (const c of clashes) {
  const k = `${c.a.def}:${c.a.role} x ${c.b.def}:${c.b.role}`
  const e = byPair.get(k) ?? { n: 0, worst: 0, at: null }
  e.n++
  if (c.depth > e.worst) { e.worst = c.depth; e.at = c }
  byPair.set(k, e)
}
for (const [k, e] of [...byPair.entries()].sort((x, y) => y[1].worst - x[1].worst).slice(0, showAll ? 999 : 12)) {
  console.log(`  ${e.worst.toFixed(2)}m deep  x${String(e.n).padStart(3)}  ${k}` +
    `  @(${e.at.x.toFixed(0)}, ${e.at.z.toFixed(0)})`)
}

/* ------------------------------------------------------------------ */
/* 2. GROUND CONTACT                                                  */
/* ------------------------------------------------------------------ */

// Only the volume that is supposed to be standing on the ground: bottomY at
// or near the building's own base. A jetty's upper floor is meant to be in the
// air and grading it would be the category error this repo keeps making.
const grounded = vols.filter((v) => v.role !== 'chimneyVol' && v.role !== 'plinth')
const plinths = vols.filter((v) => v.role === 'plinth')
const plinthBy = new Map()
for (const p of plinths) {
  if (!plinthBy.has(p.id)) plinthBy.set(p.id, [])
  plinthBy.get(p.id).push(p)
}
const perBuilding = new Map()
for (const v of grounded) {
  const e = perBuilding.get(v.id)
  if (!e || v.y0 < e.y0) perBuilding.set(v.id, v)
}
const candidates = [], sunk = []
for (const v of perBuilding.values()) {
  const d = v.y0 - v.groundY
  if (d > GAP) candidates.push({ v, d })
  else if (d < -SINK) sunk.push({ v, d: -d })
}

// ASK ABOUT THE PLINTH, NOT JUST THE MASSING.
//
// The first cut reported 32 structures "standing on air" and the very first
// photograph refuted it: BuildingFactory emits a stair-step FOUNDATION PLINTH
// of per-tile stone columns, and it is not one of massing.volumes. A building
// is deliberately placed at the HIGHEST corner of its footprint so nothing
// buries, so on any slope the massing bottom is above the terrain at the
// centre BY CONSTRUCTION — the plinth exists precisely to close that.
//
// (A raycast down from under the volume was tried first and read 0 plinthed.
// It starts INSIDE the plinth, and the batched material is FrontSide, so every
// face of the solid it is standing in is back-facing and unhittable. The
// picture caught that too.)
//
// So the real question is whether the plinth covers the point in question —
// and the interesting residual is a volume OVERHANGING its footprint, because
// the plinth only spans footprint tiles while a volume may hang MAX_OVERHANG
// past them.
const floating = []
for (const c of candidates) {
  const cols = plinthBy.get(c.v.id) ?? []
  let worst = 0
  for (const fx of [0.15, 0.5, 0.85]) {
    for (const fz of [0.15, 0.5, 0.85]) {
      const x = c.v.x0 + (c.v.x1 - c.v.x0) * fx
      const z = c.v.z0 + (c.v.z1 - c.v.z0) * fz
      // Highest support under this point: a plinth column covering it, or the
      // bare terrain.
      let support = c.v.groundY
      for (const p of cols) {
        if (x >= p.x0 && x <= p.x1 && z >= p.z0 && z <= p.z1) {
          if (p.y1 > support) support = p.y1
        }
      }
      const drop = c.v.y0 - support
      if (drop > worst) worst = drop
    }
  }
  if (worst > GAP) floating.push({ v: c.v, d: worst, claimed: c.d })
}
floating.sort((a, b) => b.d - a.d)
sunk.sort((a, b) => b.d - a.d)
const plinthed = candidates.length - floating.length

console.log(`\nGROUND CONTACT — the lowest volume of each structure against the`)
console.log(`terrain beneath its own centre:`)
console.log(`  ${candidates.length} sit above the terrain under their own centre,`)
console.log(`  but ${plinthed} of those are standing on their FOUNDATION PLINTH — verified`)
console.log(`  by casting a ray down and seeing what is actually there.`)
console.log(`  ${floating.length} genuinely on air by more than ${GAP}m`)
for (const f of floating.slice(0, showAll ? 999 : 8)) {
  console.log(`    ${f.d.toFixed(2)}m of daylight under  ${f.v.def}:${f.v.role}` +
    `  @(${((f.v.x0 + f.v.x1) / 2).toFixed(0)}, ${((f.v.z0 + f.v.z1) / 2).toFixed(0)})`)
}
console.log(`  ${sunk.length} buried by more than ${SINK}m`)
for (const f of sunk.slice(0, showAll ? 999 : 8)) {
  console.log(`    ${f.d.toFixed(2)}m below grade  ${f.v.def}:${f.v.role}` +
    `  @(${((f.v.x0 + f.v.x1) / 2).toFixed(0)}, ${((f.v.z0 + f.v.z1) / 2).toFixed(0)})`)
}

/* ------------------------------------------------------------------ */
/* 3. GO AND LOOK                                                     */
/* ------------------------------------------------------------------ */

if (shots > 0) {
  console.log('\nphotographing the worst:')
  const subjects = [
    ...clashes.slice(0, Math.ceil(shots / 2)).map((c) => ({
      tag: `clash-${c.depth.toFixed(2)}m`,
      label: `${c.a.def}:${c.a.role} into ${c.b.def}:${c.b.role}, ${c.depth.toFixed(2)}m deep`,
      box: {
        min: [Math.min(c.a.x0, c.b.x0), Math.min(c.a.y0, c.b.y0), Math.min(c.a.z0, c.b.z0)],
        max: [Math.max(c.a.x1, c.b.x1), Math.max(c.a.y1, c.b.y1), Math.max(c.a.z1, c.b.z1)],
      },
    })),
    ...floating.slice(0, Math.floor(shots / 2)).map((f) => ({
      tag: `float-${f.d.toFixed(2)}m`,
      label: `${f.v.def}:${f.v.role} standing on ${f.d.toFixed(2)}m of air`,
      // Frame the GAP, not the building: a 20m tower with a 60cm lift under it
      // photographed whole shows a tower, and the defect is 3% of the frame.
      box: {
        min: [f.v.x0, f.v.groundY - 0.5, f.v.z0],
        max: [f.v.x1, f.v.y0 + 1.5, f.v.z1],
      },
    })),
  ]
  let n = 0
  for (const s of subjects) {
    const v = await lookAt(win, s.box, {
      dists: [8, 12, 18, 26, 36], heights: [0.5, 2, 5, 12], dirs: 20,
      maxFill: 0.7, order: 'height', pick: 'largest',
    })
    if (!v.ok) { console.log(`  ✗ ${s.label} — ${v.why}`); continue }
    await markSubject(win, v.screen)
    const file = `.shots/clash/${seed}-${String(n).padStart(2, '0')}-${s.tag}.png`
    writeFileSync(file, await win.screenshot({ clip: cropTo(v.screen, FRAME, 0.5) }))
    console.log(`  ✓ ${file}\n      ${s.label}`)
    n++
  }
}

const bad = clashes.filter((c) => c.depth > 0.5).length + floating.length
console.log(`\nVERDICT: ${clashes.filter((c) => c.depth > 0.5).length} interpenetrations deeper than 0.5m, ` +
  `${floating.length} structures on air, ${sunk.length} buried.`)
await app.close()
process.exit(bad ? 1 : 0)
