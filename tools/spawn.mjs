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

    // WHAT IS IN FRONT OF YOU, not just whether you can stand.
    //
    // Both halves can be true at once and this tool only ever asked the first,
    // so it read 0 of 16 STUCK while the app's opening frame was a brown
    // rectangle: the spawn yaw pointed at the map CENTRE, which in a dense
    // town is a building far more often than it is a street. Test the first
    // thing that happens — and then test what it LOOKS like.
    const yaw = three.cameraYaw ?? 0
    let viewTiles = 0
    for (let s = 0.5; s <= 20; s += 0.5) {
      if (blocked(tx + Math.cos(yaw) * s, tz + Math.sin(yaw) * s)) break
      viewTiles = s
    }
    // CAN YOU GET ANYWHERE — the third spawn question, and the one that was
    // still missing after the other two were fixed.
    //
    // STUCK asks whether the player can stand. FACING A WALL asks what they
    // can see. Both passed clean on a seed where the player stood on legal
    // ground, with a clear twenty-metre view, in a FOUR-TILE COURTYARD with
    // 962 tiles of town behind a wall. Each check here was written by asking
    // the previous question more carefully; none of them asked a new one.
    //
    // A flood fill is exact and has no threshold in it. The share of standable
    // ground reachable from the spawn is the honest number, and it is the same
    // quantity `traverse.mjs` reports — but traverse is a separate check on a
    // separate seed list, and a spawn defect belongs to the spawn tool.
    const gw = pt.store.getState().map.gridWidth
    const gh = pt.store.getState().map.gridHeight
    const free = (ix, iz) => !blocked(ix + 0.5, iz + 0.5)
    let total = 0
    for (let iz = 0; iz < gh; iz++) for (let ix = 0; ix < gw; ix++) if (free(ix, iz)) total++
    const seen = new Uint8Array(gw * gh)
    const sx = Math.floor(tx), sz = Math.floor(tz)
    let reached = 0
    if (sx >= 0 && sz >= 0 && sx < gw && sz < gh && free(sx, sz)) {
      const stack = [sz * gw + sx]
      seen[sz * gw + sx] = 1
      while (stack.length) {
        const cur = stack.pop()
        reached++
        const x = cur % gw, y = (cur / gw) | 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue
          if (seen[ny * gw + nx] || !free(nx, ny)) continue
          seen[ny * gw + nx] = 1
          stack.push(ny * gw + nx)
        }
      }
    }
    const ground = pt.heightAt(tx, tz) ?? 0
    return {
      tx: +tx.toFixed(2), tz: +tz.toFixed(2),
      insideBuilding, inWater, openDirs,
      viewM: +(viewTiles * TILE).toFixed(1),
      buried: cam.position.y < ground - 0.1,
      selfBlocked: blocked(tx, tz),
      camY: +cam.position.y.toFixed(2), ground: +ground.toFixed(2),
      reachPct: total ? Math.round((reached / total) * 100) : 0,
    }
  })
  if (!r) { console.log(`seed ${seed}: no camera`); continue }
  rows.push({ seed, ...r })
}
await app.close()

const bad = rows.filter((r) => r.selfBlocked || r.insideBuilding || r.inWater ||
  r.buried || r.openDirs === 0)
/** A wall within 4m fills the frame. That is the app's first impression. */
const WALL_M = 4
const facingWall = rows.filter((r) => r.viewM < WALL_M)
/**
 * Half the standable ground. Deliberately generous rather than tuned: a town
 * legitimately has pockets — a walled garden, a courtyard, the far bank before
 * a bridge — and `traverse.mjs` is the tool that grades how connected the TOWN
 * is. What this catches is the spawn landing in one of them, which is a
 * different defect and is never acceptable at any threshold. Observed 0% and
 * 9% when it was broken, and 75-96% when it was not, so there is nothing near
 * this line to argue about.
 */
const POCKET_PCT = 50
const inPocket = rows.filter((r) => r.reachPct < POCKET_PCT)
console.log('\n=== SPAWN — where does the player actually start? ===')
console.log('seed        tile        in bldg  water  buried  open dirs   view  reach  verdict')
console.log('-'.repeat(80))
for (const r of rows) {
  const stuck = r.selfBlocked || r.insideBuilding || r.inWater || r.buried || r.openDirs === 0
  console.log(`${String(r.seed).padStart(8)}  ${String(`${r.tx},${r.tz}`).padEnd(14)}` +
    `${String(r.insideBuilding ? 'YES' : '-').padStart(7)}` +
    `${String(r.inWater ? 'YES' : '-').padStart(7)}` +
    `${String(r.buried ? 'YES' : '-').padStart(8)}` +
    `${String(r.openDirs).padStart(11)}` +
    `${String(`${r.viewM}m`).padStart(7)}` +
    `${String(`${r.reachPct}%`).padStart(7)}   ` +
    `${stuck ? 'STUCK' : r.reachPct < POCKET_PCT ? 'IN A POCKET'
      : r.viewM < WALL_M ? 'FACING A WALL' : 'ok'}`)
}
console.log('-'.repeat(80))
console.log(`\n${bad.length} of ${rows.length} seeds spawn the player somewhere they cannot stand.`)
console.log('This is the first thing that happens in the app and there is no')
console.log('recovering from it: you cannot walk out of a wall.')
console.log(`\n${inPocket.length} of ${rows.length} spawn IN A POCKET (under ${POCKET_PCT}% of`)
console.log('standable ground reachable). The player can stand, can see, and')
console.log('cannot get to the town — the two checks above both pass on it.')
console.log(`\n${facingWall.length} of ${rows.length} spawn FACING A WALL (under ${WALL_M}m of view).`)
console.log('A separate question from the one above, and this tool asked only the')
console.log('first for a year: you can stand on perfectly legal ground with your')
console.log('nose against a facade, and the app opens on a brown rectangle.')
