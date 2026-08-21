import { _electron as electron } from 'playwright-core'
import { waitForScene } from './tools/lib/scene.mjs'
const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
win.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text()) })
await win.waitForLoadState('domcontentloaded'); await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click(); await win.waitForTimeout(1200)
await win.getByRole('button', { name: /^generate$/i }).first().click(); await win.waitForTimeout(2600)
await win.getByRole('button', { name: '3D', exact: true }).click(); await waitForScene(win)
await win.waitForTimeout(800)
console.log(JSON.stringify(await win.evaluate(() => {
  const r3 = window.__pt.renderer()
  const out = []
  r3.scene.traverse((o) => {
    if (!o.isMesh || !['lanternRopes','ropeLanterns','laundryLines'].includes(o.name)) return
    const m = Array.isArray(o.material) ? o.material[0] : o.material
    out.push({ name: o.name, meshMark: o.userData.swayApplied ?? null,
      matMark: m.userData?.sway ?? null,
      hook: m.onBeforeCompile.toString().slice(0, 150),
      own: Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') })
  })
  return out
}), null, 1))
await app.close()
