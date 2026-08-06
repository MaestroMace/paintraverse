/**
 * Headless placement audit: generates towns across several seeds and runs
 * the GeometryAudit invariants against each, via the window.__pt bridge.
 *
 *   npm run build && xvfb-run -a node tools/audit.mjs [seed ...]
 *   xvfb-run -a node tools/audit.mjs --max-errors=73
 *
 * Exits non-zero when the total error count exceeds --max-errors (default 0),
 * so CI can hold the line against regressions while a known backlog is worked
 * down. Lower the baseline as classes of defect are fixed; it should never be
 * raised to make a red build green.
 */
import { _electron as electron } from 'playwright-core'

const argv = process.argv.slice(2)
const maxErrorsArg = argv.find((a) => a.startsWith('--max-errors='))
const MAX_ERRORS = maxErrorsArg ? Number(maxErrorsArg.split('=')[1]) : 0
const seedArgs = argv.filter((a) => !a.startsWith('--'))
const seeds = seedArgs.length ? seedArgs : ['4242', '777', '31337']

const app = await electron.launch({ args: ['.'], cwd: process.cwd() })
const win = await app.firstWindow()
win.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
await win.waitForLoadState('domcontentloaded')
await win.waitForTimeout(3000)
await win.getByText('Landscape', { exact: false }).first().click()
await win.waitForTimeout(1000)

let totalErrors = 0
for (const seed of seeds) {
  await win.evaluate((s) => {
    const inp = [...document.querySelectorAll('.left-panel input')]
      .find((i) => i.type !== 'range' && /^\d+$/.test(i.value))
    if (inp) {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(inp, s)
      inp.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, seed)
  await win.waitForTimeout(150)
  await win.getByRole('button', { name: /^generate$/i }).first().click()
  await win.waitForTimeout(2600)

  const rep = await win.evaluate(() => window.__pt.audit())
  totalErrors += rep.counts.errors
  console.log(`\n=== seed ${seed} === structures=${rep.counts.structures} props=${rep.counts.props} ` +
    `errors=${rep.counts.errors} warnings=${rep.counts.warnings}`)
  const kinds = Object.entries(rep.byKind).sort((a, b) => b[1] - a[1])
  for (const [k, n] of kinds) console.log(`   ${String(n).padStart(5)}  ${k}`)
  if (rep.missingDefinitions.length) {
    console.log('   missingDefinitions:', rep.missingDefinitions.join(', '))
  }
  for (const i of rep.issues.slice(0, 6)) {
    console.log(`     - [${i.kind}] ${i.definitionId} @(${i.x},${i.y}): ${i.detail}`)
  }
}

await app.close()
console.log(`\nTOTAL ERRORS ACROSS ${seeds.length} SEEDS: ${totalErrors} (budget ${MAX_ERRORS})`)
if (totalErrors > MAX_ERRORS) {
  console.error(`FAIL: ${totalErrors} placement errors exceeds the budget of ${MAX_ERRORS}.`)
  process.exit(1)
}
if (totalErrors < MAX_ERRORS) {
  console.log(`Budget has slack — lower --max-errors to ${totalErrors} to lock in the win.`)
}
process.exit(0)
