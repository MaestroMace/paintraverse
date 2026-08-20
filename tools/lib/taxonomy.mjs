/**
 * WHAT THE GAME THINKS A HOUSE IS — read out of the source, never restated.
 *
 * Three files independently kept a set of "which building types are homes"
 * and they did not merely differ in length, they disagreed about what a home
 * IS:
 *
 *   TownGenerator  12 ids   decides where domestic dressing GOES
 *   tenancy.mjs    11 ids   decides whether that dressing counts as EXPLAINED
 *   eyeball.mjs    15 ids   decides which buildings are graded as ORDINARY
 *
 * So the generator hung washing on a `half_timber` that tenancy did not
 * recognise, and scored the placer's own correct behaviour as a tenancy
 * failure. That is the numerator and the denominator counting different
 * populations — the mistake tenancy.mjs's own header already records making
 * once, with invented prop ids, and which it then made again one field over.
 * And eyeball counted `coach_house` and `potting_shed` as dwellings, which is
 * an outbuilding and a garden shed dragging the storey distribution it
 * reports.
 *
 * A tool that restates a constant from the code is a copy that will drift, and
 * this repo has now proved that with the terrain table, the roof cap table and
 * this. Parsing the real declaration costs one regex and cannot go stale
 * silently: if the shape of the declaration changes, this THROWS, because a
 * taxonomy that quietly falls back to a default would grade the whole town
 * against the wrong population and report a clean number for it.
 */
import { readFileSync } from 'node:fs'

function parseSet(file, name) {
  const src = readFileSync(file, 'utf8')
  const m = src.match(new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`))
  if (!m) throw new Error(`taxonomy: could not find ${name} in ${file}`)
  const ids = [...m[1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1])
  if (!ids.length) throw new Error(`taxonomy: ${name} in ${file} parsed empty`)
  return new Set(ids)
}

/** Somewhere a household lives. `DWELLING_TYPES` in src/renderer/core/types.ts. */
export const DWELLINGS = parseSet('src/renderer/core/types.ts', 'DWELLING_TYPES')

/**
 * A BOUNDARY, NOT A BUILDING — and not a prop that belongs to one either.
 *
 * FOURTH TIME this repo has had to tell barriers apart from buildings, and the
 * first three each did it in the tool's own head: `urbanform.mjs` counted 47
 * wall segments as buildings and inflated party walls, because a ring of wall
 * is a hundred mutual "neighbours" and not one of them is a terrace;
 * `districts.mjs` scored them as not distinctive to their own quarter;
 * `variety.mjs` reported 104 of 307 "structures" as twins when a town wall
 * made of 28 identical pieces is a WALL. CLAUDE.md's verdict at the time was
 * "the filter belongs in one place, not in each tool's head", and it then
 * stayed in each tool's head.
 *
 * `tenancy.mjs` is the fourth. Its `UNOWNED_BY_NATURE` set already listed
 * `stone_wall` and `stone_wall_v` and not the other six barriers, so switching
 * on yard fences dropped explained tenancy seven points — forty boundaries
 * scored as props with no owner, which is exactly the category error the two
 * entries already in that set exist to prevent.
 *
 * Read from the store's own TAGS, so a new barrier joins by being one.
 */
export const BARRIERS = (() => {
  const src = readFileSync('src/renderer/app/store.ts', 'utf8')
  const out = new Set()
  for (const m of src.matchAll(/id:\s*'([a-z_0-9]+)',[\s\S]{0,220}?tags:\s*\[([^\]]*)\]/g)) {
    if (/'barrier'/.test(m[2])) out.add(m[1])
  }
  if (out.size < 3) {
    throw new Error(`taxonomy: BARRIERS parsed ${out.size} ids from store.ts — ` +
      'the declaration shape changed. Failing rather than grading the town ' +
      'against a population that is silently wrong.')
  }
  return out
})()

/**
 * WHAT EACH BUILDING TYPE WOULD PLAUSIBLY OWN — read out of the generator.
 *
 * `tenancy.mjs` kept a hand-written EXPLAINS table under a comment saying it
 * "mirrors the intent of getBuildingSpecificProps". A mirror is a copy, and
 * this repo has now watched that exact arrangement drift four times: the
 * terrain table, the roof cap table, the three dwelling sets, and tenancy's
 * own `half_timber` row, which listed `firewood` — an id the game does not
 * define — so a woodpile correctly placed at a half-timbered house scored as
 * unexplained. That last one is recorded IN tenancy.mjs as a lesson learned,
 * directly above the copy that caused it.
 *
 * The drift here had grown to twenty-one types. The whole small-exclusive-type
 * arc — chandlery, net_loft, weigh_house, kiln, workshop, washhouse,
 * smokehouse, boathouse, guardhouse, armory, shambles and the rest — went into
 * the generator and never into the mirror, so a quarter could be two thirds
 * distinctive by its buildings and score zero for the props saying so.
 *
 * Parsed from the switch, which means the union of every id a case can return
 * — including both branches of a `rng() > 0.5 ? [...] : [...]`, which is
 * exactly right: EXPLAINS asks what a type would PLAUSIBLY own, not what this
 * particular roll gave it.
 *
 * THROWS on a shape change rather than falling back, for the reason above it:
 * a taxonomy that silently returns less grades the town against the wrong
 * population and reports a clean number for it.
 */
export function parseBuildingProps(
  file = 'src/renderer/generation/TownGenerator.ts'
) {
  const src = readFileSync(file, 'utf8')
  const fn = src.match(
    /private getBuildingSpecificProps\([\s\S]*?\n {4}}\n {2}}/)
  if (!fn) throw new Error('taxonomy: could not find getBuildingSpecificProps')
  const out = {}
  // One case per line, `case 'id': return [ ...ids... ]`. The first quoted
  // string on the line is the KEY and the rest are what it may own.
  for (const line of fn[0].split('\n')) {
    const m = line.match(/^\s*case '([a-z_0-9]+)':\s*return\s+(.*)$/)
    if (!m) continue
    const ids = [...m[2].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1])
    if (ids.length) out[m[1]] = ids
  }
  if (Object.keys(out).length < 10) {
    throw new Error(
      `taxonomy: getBuildingSpecificProps parsed only ${Object.keys(out).length} ` +
      'cases — the declaration shape has changed')
  }
  return out
}
