/**
 * BUDGET — what does this build COST on the machine that cares?
 *
 * Every other tool here grades whether the town is right. None of them grades
 * what it costs to draw, and the project's stated target is a phone.
 *
 * It was written after finishing all four walls of every building, which is
 * unambiguously the right change and quietly took the live texture count from
 * 246 to 976 — a 4x, invisible to the placement audit, to allsides.mjs, to
 * the feature census and to every screenshot, because none of them look at
 * the renderer's own accounting. The walkshots harness prints draw calls, but
 * a draw call is not where this kind of regression shows: a BoxGeometry with
 * a material array costs six draws whether the six slots hold two distinct
 * materials or four, so the array change registered as zero there while
 * quadrupling texture memory.
 *
 *   meshes            per scene group, and how many are multi-material
 *                     (a multi-material box = one draw call PER FACE)
 *   tris              per group
 *   textures          renderer.info.memory.textures — the number that grew
 *   geometries        renderer.info.memory.geometries
 *
 * THE SEED IS PINNED. Without that every run generates a different town and
 * the A/B compares two maps rather than two builds, which is how an earlier
 * prop comparison in this repo produced a confident meaningless delta. To
 * compare against another commit:
 *
 *   node tools/budget.mjs                       # this build
 *   git stash push src/renderer/renderer3d/
 *   git checkout <sha> -- src/renderer/renderer3d/ && npm run build
 *   node tools/budget.mjs                       # that build, same town
 *   git checkout HEAD -- src/renderer/renderer3d/ && git stash pop && npm run build
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/budget.mjs [seed]
 */
import { _electron as electron } from 'playwright-core'

const seed = Number(process.argv[2] ?? 4242)
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
await win.waitForTimeout(2600)

const r = await win.evaluate(() => {
  const three = window.__pt.renderer()
  const gl = three.renderer
  const groups = {}
  for (const k of ['buildingGroup', 'propGroup', 'terrainGroup']) {
    const g = three[k]
    if (!g) continue
    let n = 0, tri = 0, multi = 0
    g.traverse((o) => {
      if (!o.isMesh) return
      n++
      if (Array.isArray(o.material)) multi++
      // Sprites and point clouds live in these groups too and have no
      // position attribute; guarding rather than assuming was the difference
      // between a number and a stack trace.
      const idx = o.geometry?.index
      const pos = o.geometry?.attributes?.position
      if (idx) tri += idx.count / 3
      else if (pos) tri += pos.count / 3
    })
    groups[k] = { meshes: n, multiMaterial: multi, tris: Math.round(tri) }
  }
  // BYTES, not just count. renderer.info.memory.textures counts texture
  // OBJECTS, so lowering the authoring resolution of the back and flank walls
  // — the whole point of the per-face scale — is invisible to it. Walk the
  // live materials instead and add up the actual surfaces, deduped by image
  // so a texture shared by fifty buildings is charged once.
  const seen = new Set()
  let texBytes = 0, texCount = 0
  const charge = (t) => {
    if (!t || !t.image || seen.has(t.uuid)) return
    seen.add(t.uuid)
    texCount++
    texBytes += (t.image.width || 0) * (t.image.height || 0) * 4
  }
  for (const g of ['buildingGroup', 'propGroup', 'terrainGroup']) {
    three[g]?.traverse((o) => {
      if (!o.isMesh) return
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
        if (!m) continue
        charge(m.map); charge(m.emissiveMap); charge(m.normalMap); charge(m.alphaMap)
      }
    })
  }
  return {
    groups,
    textures: gl.info.memory.textures,
    geometries: gl.info.memory.geometries,
    liveTextures: texCount,
    textureMB: +(texBytes / (1024 * 1024)).toFixed(1),
  }
})
await app.close()

console.log(`\n=== BUDGET — seed ${seed} ===\n`)
console.log('group            meshes   multi-mat        tris')
console.log('-'.repeat(50))
for (const [k, g] of Object.entries(r.groups)) {
  console.log(`${k.padEnd(16)}${String(g.meshes).padStart(7)}` +
    `${String(g.multiMaterial).padStart(12)}${String(g.tris).padStart(12)}`)
}
console.log('-'.repeat(50))
console.log(`\ntextures   ${r.textures} allocated, ${r.liveTextures} reachable from the scene`)
console.log(`           ${r.textureMB} MB of surface, deduped by image`)
console.log(`geometries ${r.geometries}`)
console.log(`\nWatch the MB, not the count: authoring the flanks coarser changes bytes`)
console.log(`and not one texture object, so info.memory cannot see it.`)
console.log(`\nA multi-material mesh costs one draw call PER GEOMETRY GROUP — six for`)
console.log(`a box — however many of the six slots hold the same material. So the`)
console.log(`draw count moves with MESH count, not with material variety, and a`)
console.log(`texture-memory regression does not show up in draw calls at all.`)
