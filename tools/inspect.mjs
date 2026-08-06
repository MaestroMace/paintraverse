/**
 * Visual inspector: generate a seed, run the placement audit, then teleport
 * the walk camera to specific flagged objects and screenshot them.
 *
 *   xvfb-run -a node tools/inspect.mjs <seed> [kind]
 *
 * Uses the window.__pt debug bridge (audit + teleport + lookAt).
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync } from 'fs'

const seed = process.argv[2] || '4242'
const kind = process.argv[3] || 'building-on-road'
mkdirSync('.shots', { recursive: true })

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1000)

await win.evaluate((s) => {
  const inp = [...document.querySelectorAll('.left-panel input')]
    .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(inp, s)
  inp.dispatchEvent(new Event('input', { bubbles: true }))
}, seed)
await win.waitForTimeout(150)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(2600)

const targets = await win.evaluate((k) => {
  const rep = window.__pt.audit()
  return rep.issues.filter((i) => i.kind === k).slice(0, 3)
}, kind)
console.log('targets:', JSON.stringify(targets, null, 1))

// Daylight so geometry is legible, then enter 3D.
await win.evaluate(() => {
  const r = [...document.querySelectorAll('.right-panel input[type=range]')][0]
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  set.call(r, '12')
  r.dispatchEvent(new Event('input', { bubbles: true }))
})
await win.getByRole('button', { name: '3D', exact: true }).click()
await win.waitForTimeout(6500)

for (let i = 0; i < targets.length; i++) {
  const t = targets[i]
  // Stand back from the target and look at it.
  const info = await win.evaluate(({ x, y }) => {
    window.__pt.inspectTile(x, y, 13, 11)
    return { ground: window.__pt.heightAt(x, y) }
  }, { x: t.x + 0.5, y: t.y + 0.5 })
  await win.waitForTimeout(1400)
  const name = `.shots/inspect-${seed}-${i}-${t.definitionId}.png`
  await win.screenshot({ path: name })
  console.log(`shot ${name}  @(${t.x},${t.y}) ground=${JSON.stringify(info.ground)}`)
}

await app.close()
