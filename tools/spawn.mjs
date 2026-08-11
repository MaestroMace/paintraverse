/**
 * SPAWN — does the player start standing somewhere they can stand?
 *
 * Reported from the phone: "I often show up frozen inside an asset." That is
 * the worst class of bug in a walkaround, because it is the first thing that
 * happens and there is no recovering from it — you cannot walk out of a wall.
 *
 * It is also invisible to every other audit here. The placement audit grades
 * where BUILDINGS are, the anomaly sweep flies a scripted camera that never
 * uses the spawn path at all, and a screenshot harness that teleports to fixed
 * vantages will never once exercise the thing the player exercises first.
 *
 * So check the one position that matters, across many seeds:
 *
 *   BLOCKED — is the spawn point inside a building footprint, or in water?
 *   BURIED  — is the camera below the terrain it is standing on?
 *   STUCK   — can the player move at all? Probe eight directions at one
 *             step each; a spawn with nowhere to go is as bad as one inside
 *             a wall, and it looks identical from the inside.
 *
 *   xvfb-run -a -s "-screen 0 1400x900x24" node tools/spawn.mjs [seeds...]
 */
import { _electron as electron } from 'playwright-core'

const seeds = process.argv.slice(2).map(Number)
if (seeds.length === 0) {
  // Many seeds, cheaply — this is a per-seed lottery, so a handful proves
  // nothing. The regression set plus a spread of untested ones.
  seeds.push(4242, 777, 31337, 11, 65535, 2024, 8080, 999999,
    7, 1234, 55555, 88888, 606060, 171717, 424242, 314159)
}

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1200)

const rows = []
for (const seed of seeds) {
  await win.evaluate((s) => {
    const inp = [...document.querySelectorAll('.left-panel input')]
      .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    set.call(inp, s)
    inp.dispatchEvent(new Event('input', { bubbles: true }))
  }, seed)
  await win.waitForTimeout(200)
  await win.getByRole('button', { name: /^generate$/i }).first().click()
  await win.waitForTimeout(2600)
  await win.getByRole('button', { name: '3D', exact: true }).click()
  await win.waitForTimeout(2600)

  const r = await win.evaluate(() => {
    const pt = window.__pt
    const three = pt.renderer()
    const cam = three?.camera
    if (!cam) return null
    const TILE = 3.0
    const st = pt.store.getState()
    const map = st.map
    const defs = st.objectDefinitions
    const terrain = map.layers.find((l) => l.type === 'terrain')?.terrainTiles
    const structs = map.layers.find((l) => l.type === 'structure')?.objects ?? []
    const H = terrain.length, W = terrain[0].length
    // Model what ThreeRenderer's collision mask does, including the part that
    // CLEARS: anything tagged `passage` — an archway, a town gate, a bridge
    // deck — is a way through, and the mask un-blocks it last. Without this
    // the tool called a player standing under an archway "stuck inside a
    // building with nowhere to go", which is a true statement about its own
    // model and a false one about the game.
    const built = Array.from({ length: H }, () => new Uint8Array(W))
    const passage = []
    for (const o of structs) {
      const d = defs.find?.((x) => x.id === o.definitionId) ?? defs[o.definitionId] ?? null
      const f = o.footprint ?? d?.footprint ?? { w: 1, h: 1 }
      if ((d?.tags ?? []).includes('passage')) { passage.push([o, f]); continue }
      for (let dy = 0; dy < f.h; dy++) {
        for (let dx = 0; dx < f.w; dx++) {
          const px = o.x + dx, py = o.y + dy
          if (px >= 0 && py >= 0 && px < W && py < H) built[py][px] = 1
        }
      }
    }
    const walkway = Array.from({ length: H }, () => new Uint8Array(W))
    for (const [o, f] of passage) {
      for (let dy = 0; dy < f.h; dy++) {
        for (let dx = 0; dx < f.w; dx++) {
          const px = o.x + dx, py = o.y + dy
          if (px >= 0 && py >= 0 && px < W && py < H) {
            built[py][px] = 0; walkway[py][px] = 1
          }
        }
      }
    }
    // The camera is in WORLD units; the maps are in TILES. Converting here and
    // nowhere else, because mixing the two is the bug this tool exists for.
    const tx = cam.position.x / TILE, tz = cam.position.z / TILE
    const ix = Math.floor(tx), iz = Math.floor(tz)
    const inBounds = ix >= 0 && iz >= 0 && ix < W && iz < H
    const insideBuilding = inBounds ? built[iz][ix] === 1 : false
    const inWater = inBounds ? (terrain[iz][ix] === 3 && !walkway[iz][ix]) : false

    // Can the player go anywhere? One PLAYER step in eight directions.
    const R = 0.35 / TILE
    const blocked = (px, pz) => {
      const x0 = Math.floor(px - R), x1 = Math.floor(px + R)
      const z0 = Math.floor(pz - R), z1 = Math.floor(pz + R)
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || z < 0 || x >= W || z >= H) return true
          if (walkway[z][x]) continue
          if (built[z][x] || terrain[z][x] === 3) return true
        }
      }
      return false
    }
    let openDirs = 0
    for (let a = 0; a < 8; a++) {
      const th = (a / 8) * Math.PI * 2
      if (!blocked(tx + Math.cos(th) * 0.5, tz + Math.sin(th) * 0.5)) openDirs++
    }
    const ground = pt.heightAt(tx, tz) ?? 0
    return {
      tx: +tx.toFixed(2), tz: +tz.toFixed(2),
      insideBuilding, inWater, openDirs,
      buried: cam.position.y < ground - 0.1,
      selfBlocked: blocked(tx, tz),
      camY: +cam.position.y.toFixed(2), ground: +ground.toFixed(2),
    }
  })
  if (!r) { console.log(`seed ${seed}: no camera`); continue }
  rows.push({ seed, ...r })
}
await app.close()

const bad = rows.filter((r) => r.selfBlocked || r.insideBuilding || r.inWater ||
  r.buried || r.openDirs === 0)
console.log('\n=== SPAWN — where does the player actually start? ===')
console.log('seed        tile        in bldg  water  buried  open dirs  verdict')
console.log('-'.repeat(74))
for (const r of rows) {
  const ok = !(r.selfBlocked || r.insideBuilding || r.inWater || r.buried || r.openDirs === 0)
  console.log(`${String(r.seed).padStart(8)}  ${String(`${r.tx},${r.tz}`).padEnd(14)}` +
    `${String(r.insideBuilding ? 'YES' : '-').padStart(7)}` +
    `${String(r.inWater ? 'YES' : '-').padStart(7)}` +
    `${String(r.buried ? 'YES' : '-').padStart(8)}` +
    `${String(r.openDirs).padStart(11)}   ${ok ? 'ok' : 'STUCK'}`)
}
console.log('-'.repeat(74))
console.log(`\n${bad.length} of ${rows.length} seeds spawn the player somewhere they cannot stand.`)
console.log('This is the first thing that happens in the app and there is no')
console.log('recovering from it: you cannot walk out of a wall.')
