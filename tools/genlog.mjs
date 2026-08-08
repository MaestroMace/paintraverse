/** Run one generation and print any console error or page exception. */
import { _electron as electron } from 'playwright-core'
const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message, '\n', (e.stack||'').split('\n').slice(0,6).join('\n')))
win.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(m.type().toUpperCase()+':', m.text().slice(0, 400)) })
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1000)
await win.getByRole('button', { name: /^generate$/i }).first().click()
await win.waitForTimeout(3000)
const n = await win.evaluate(() => {
  const m = window.__pt.store.getState().map
  return m.layers.map((l) => `${l.type}:${l.objects?.length ?? (l.terrainTiles ? 'tiles' : 0)}`).join(' ')
})
console.log('LAYERS:', n)
const rot = await win.evaluate(() => {
  const objs = window.__pt.store.getState().map.layers.find(l=>l.type==='structure')?.objects ?? []
  const n = objs.filter(o=>o.properties?.plotRotated).length
  return `${n}/${objs.length} plots rotated`
})
console.log('ORIENTATION:', rot)
const rej = await win.evaluate(() => window.__pt.placeStats?.() ?? {})
console.log('PLACER REJECTIONS:', JSON.stringify(rej))
await app.close()
