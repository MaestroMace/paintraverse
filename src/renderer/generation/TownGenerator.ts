import { v4 as uuid } from 'uuid'
import type { MapDocument, MapLayer, PlacedObject, GenerationConfig, EnvironmentState } from '../core/types'
import { DWELLING_TYPES } from '../core/types'
import type { IMapGenerator } from './GeneratorRegistry'
import { createRNG, SimplexNoise, poissonDiskSampling, nearestPoint, perturbedDistance } from './noise'
import { isCirculation } from '../core/terrain'

// === District System ===

/**
 * Why the building placer rejected each candidate, counted per run and read
 * through the debug bridge by tools/genlog.mjs.
 *
 * The placement loop has several `continue`s and no way to see which one is
 * firing. A change that made every candidate fail produced a town with zero
 * buildings and NO exception — indistinguishable from "the placer ran and
 * chose not to build". These make that distinguishable, and they are what
 * showed that a failed plot-orientation attempt was placing 43 buildings and
 * then losing them, rather than rejecting everything.
 */
export const placeStats: Record<string, number> = {}
function rejected(reason: string): void {
  placeStats[reason] = (placeStats[reason] ?? 0) + 1
}

type DistrictType = 'market' | 'residential' | 'artisan' | 'noble' | 'waterfront' | 'temple' | 'slum' | 'garden' | 'harbor' | 'fortress' | 'cemetery'

interface District {
  id: number
  type: DistrictType
  center: { x: number; y: number }
  radius: number
  buildingDensity: number
  propDensity: number
}

// District-specific building weights
const DISTRICT_BUILDINGS: Record<DistrictType, { id: string; w: number; h: number; weight: number }[]> = {
  market: [
    { id: 'shop', w: 2, h: 3, weight: 6 },
    { id: 'corner_building', w: 2, h: 2, weight: 4 },
    { id: 'bakery', w: 2, h: 2, weight: 4 },
    // ROW HOUSE DELIBERATELY ABSENT — see the note above `residential`.
    { id: 'tavern', w: 4, h: 3, weight: 2 },
    { id: 'covered_market', w: 4, h: 3, weight: 2 },
    // Market's only exclusive type was covered_market at 4x3, which is to say
    // it had none. A weigh house is 2x2 and arcaded.
    { id: 'weigh_house', w: 2, h: 2, weight: 7 },
    // And market's smallest entry was still the shared `row_house`, which is
    // why seed 31337's market read 13% while two other seeds read 44-49% —
    // one town's quarter drawing generic housing rather than the type mix
    // failing. The shambles is the butchers' row and it is 1x2.
    { id: 'shambles', w: 1, h: 2, weight: 7 },
    // Same argument as harbor's sail loft: capped at ten, the shambles left
    // row_house as market's largest type at 11 of 32. A market street is
    // butchers AND cookshops AND a weigh house, not one trade repeated.
    { id: 'cookshop', w: 1, h: 2, weight: 6 },
    { id: 'building_small', w: 2, h: 2, weight: 2 },
    { id: 'apothecary', w: 2, h: 3, weight: 2 },
    { id: 'inn', w: 3, h: 3, weight: 1 },
    { id: 'archway', w: 3, h: 1, weight: 1 },
  ],
  // THE ROW HOUSE BELONGS TO THIS QUARTER AND TO THE SLUM, AND TO NOWHERE
  // ELSE ANY MORE.
  //
  // It was in SIX of the eleven tables, which is over half of every quarter a
  // town grows — and `districts.mjs` counts a type as characteristic only if
  // it appears in at most a THIRD of the quarters present. So the single
  // commonest building in the town, 18% of all structures, was disqualified
  // by construction from saying anything about anywhere, and every quarter's
  // measured character was competing against it: the fit lottery hands a 1x2
  // more plots than any other shape, so a shared 1x2 in a table is the type
  // that wins it.
  //
  // Removing it from market, artisan, waterfront and harbor is only safe NOW,
  // and that is the whole point of the last two batches. Each of those four
  // has small exclusives of its own to fall back on — shambles and cookshop,
  // workshop and kiln, smokehouse and boathouse, chandlery and sail loft —
  // where before they had nothing under three tiles that was theirs. Doing
  // this a batch earlier would have starved them exactly the way the temple
  // quarter halved when the fill passes stopped stamping row houses into it.
  //
  // Kept in the slum on purpose: a slum IS row houses, subdivided, plus the
  // tenements and lean-tos that are its own. Two quarters out of eight or
  // nine is inside the third, so it now reads as characteristic of both.
  residential: [
    { id: 'building_small', w: 2, h: 2, weight: 5 },
    { id: 'row_house', w: 1, h: 2, weight: 5 },
    { id: 'half_timber', w: 3, h: 2, weight: 4 },
    { id: 'building_medium', w: 3, h: 3, weight: 3 },
    { id: 'balcony_house', w: 3, h: 2, weight: 3 },
    { id: 'narrow_house', w: 1, h: 3, weight: 3 },
    { id: 'bakery', w: 2, h: 2, weight: 2 },
    { id: 'building_large', w: 4, h: 3, weight: 1 },
    { id: 'stable', w: 4, h: 3, weight: 4 },
    // THE ORDINARY QUARTER'S OWN VOCABULARY — see the definitions in store.ts.
    // Every other entry above is shared with market, artisan, waterfront,
    // harbor or slum, so none of them can ever count as characteristic and
    // residential read 13-14% on two seeds of three. A cottage and the
    // street's communal wash house are what an ordinary quarter has that no
    // other does. The wash house is an INSTITUTION and is weighted like one:
    // one or two a quarter, not a row of them. Giving a quarter its own small
    // type has overshot into monoculture before — the cemetery came out as 21
    // identical sexton's huts — and MAX_PER_DISTRICT is the backstop.
    { id: 'cottage', w: 2, h: 2, weight: 5 },
    { id: 'washhouse', w: 2, h: 2, weight: 2 },
  ],
  artisan: [
    { id: 'shop', w: 2, h: 3, weight: 5 },
    { id: 'building_small', w: 2, h: 2, weight: 5 },
    // ROW HOUSE DELIBERATELY ABSENT — see the note above `residential`.
    { id: 'warehouse', w: 4, h: 3, weight: 3 },
    { id: 'corner_building', w: 2, h: 2, weight: 2 },
    { id: 'half_timber', w: 3, h: 2, weight: 2 },
    { id: 'apothecary', w: 2, h: 3, weight: 1 },
    { id: 'staircase', w: 2, h: 3, weight: 1 },
    // The craft quarter's own two — see store.ts. Everything above is shared
    // with somewhere else, which is why artisan measured 8% and 0%.
    { id: 'workshop', w: 1, h: 2, weight: 5 },
    { id: 'kiln', w: 1, h: 2, weight: 2 },
  ],
  noble: [
    { id: 'mansion', w: 5, h: 4, weight: 5 },
    { id: 'building_large', w: 4, h: 3, weight: 4 },
    { id: 'building_medium', w: 3, h: 3, weight: 3 },
    { id: 'balcony_house', w: 3, h: 2, weight: 3 },
    { id: 'guild_hall', w: 4, h: 4, weight: 2 },
    { id: 'tower', w: 2, h: 2, weight: 1 },
    { id: 'archway', w: 3, h: 1, weight: 1 },
    { id: 'stable', w: 4, h: 3, weight: 1 },
    // The small ORDINARY buildings of this quarter, and they have to exist:
    // every other noble entry is 3 tiles or wider except the tower, which
    // infill correctly refuses to use, so the quarter could not be filled at
    // all and built coverage fell out of its band. A narrow townhouse on a
    // noble side street is also just correct — Georgian and Parisian quarters
    // are full of them — and a coach house is what stands behind a mansion.
    // Weighted low so the mansions still lead the quarter.
    { id: 'narrow_house', w: 1, h: 3, weight: 3 },
    { id: 'coach_house', w: 2, h: 2, weight: 3 },
  ],
  waterfront: [
    { id: 'building_small', w: 2, h: 2, weight: 4 },
    { id: 'shop', w: 2, h: 3, weight: 4 },
    { id: 'warehouse', w: 4, h: 3, weight: 3 },
    // ROW HOUSE DELIBERATELY ABSENT — see the note above `residential`.
    { id: 'building_medium', w: 3, h: 3, weight: 2 },
    { id: 'tavern', w: 4, h: 3, weight: 2 },
    { id: 'inn', w: 3, h: 3, weight: 2 },
    { id: 'half_timber', w: 3, h: 2, weight: 1 },
    { id: 'mill', w: 3, h: 3, weight: 6 },
    { id: 'net_loft', w: 2, h: 2, weight: 5 },
    // Waterfront's own, not shared with harbor. 1x2 for the smokehouse so it
    // actually places — the shape buys presence — and the boathouse capped,
    // because a river frontage has one or two, not a row.
    { id: 'smokehouse', w: 1, h: 2, weight: 5 },
    { id: 'boathouse', w: 2, h: 2, weight: 3 },
  ],
  temple: [
    { id: 'chapel', w: 3, h: 4, weight: 5 },
    { id: 'tower', w: 2, h: 2, weight: 1 },
    { id: 'bell_tower', w: 2, h: 2, weight: 3 },
    { id: 'building_large', w: 4, h: 3, weight: 3 },
    { id: 'temple', w: 5, h: 5, weight: 2 },
    { id: 'archway', w: 3, h: 1, weight: 2 },
    { id: 'staircase', w: 2, h: 3, weight: 2 },
    { id: 'cathedral', w: 5, h: 6, weight: 6 },
    { id: 'bell_tower_tall', w: 2, h: 2, weight: 7 },
    // A temple precinct is not only monuments. Its one small ordinary entry
    // was `staircase`, so infill had almost nothing to build and the quarter
    // halved when the fill passes stopped stamping row houses into it.
    // Clergy lodgings and an almshouse are what actually stand round a
    // cathedral close, and they are humble enough not to compete with it.
    { id: 'clergy_house', w: 2, h: 2, weight: 5 },
    { id: 'almshouse', w: 1, h: 3, weight: 4 },
  ],
  slum: [
    // SLUM AND RESIDENTIAL WERE TWO LABELS ON ONE VOCABULARY — the same shape
    // of defect as harbor-versus-waterfront, and it showed the moment the
    // district pool started producing slums: 87 buildings on seed 4242 reading
    // 7% distinctive, because every entry here was also a residential entry.
    // A slum's real difference is not its plan, it is that the same plot
    // carries more people: a tenement is TALL, NARROW and subdivided, and it
    // has to be the small type or it loses the fit lottery to the row house.
    { id: 'tenement', w: 1, h: 2, weight: 9 },
    { id: 'row_house', w: 1, h: 2, weight: 4 },
    { id: 'narrow_house', w: 1, h: 3, weight: 4 },
    { id: 'building_small', w: 2, h: 2, weight: 4 },
    { id: 'lean_to', w: 1, h: 2, weight: 5 },
    { id: 'corner_building', w: 2, h: 2, weight: 2 },
    { id: 'shop', w: 2, h: 3, weight: 1 },
  ],
  garden: [
    { id: 'balcony_house', w: 3, h: 2, weight: 4 },
    { id: 'mansion', w: 5, h: 4, weight: 3 },
    { id: 'building_medium', w: 3, h: 3, weight: 3 },
    { id: 'half_timber', w: 3, h: 2, weight: 3 },
    { id: 'building_small', w: 2, h: 2, weight: 2 },
    { id: 'building_large', w: 4, h: 3, weight: 1 },
    // The garden quarter's only sub-3-tile entry was building_small, which is
    // generic housing and reads as nothing in particular. A potting shed is
    // small, distinctive, and exactly what a garden district is made of.
    { id: 'potting_shed', w: 1, h: 2, weight: 4 },
  ],
  harbor: [
    { id: 'warehouse', w: 4, h: 3, weight: 8 },
    { id: 'shop', w: 2, h: 3, weight: 4 },
    { id: 'tavern', w: 4, h: 3, weight: 3 },
    // ROW HOUSE DELIBERATELY ABSENT — see the note above `residential`.
    { id: 'inn', w: 3, h: 3, weight: 2 },
    { id: 'building_small', w: 2, h: 2, weight: 2 },
    { id: 'lighthouse', w: 3, h: 3, weight: 4 },
    // The quarter's one SMALL exclusive type. warehouse (25%) and lighthouse
    // (12%) are exclusive-ish already and never place, because a 4x3 and a
    // 3x3 lose the fit lottery to a 1x2 row house whatever their weight.
    { id: 'net_loft', w: 2, h: 2, weight: 6 },
    { id: 'mill', w: 3, h: 3, weight: 5 },
    // AND net_loft AT 2x2 IS STILL NOT THE SMALLEST THING IN THIS TABLE —
    // `row_house` at 1x2 is, and it is shared with five other quarters, so
    // the fit lottery still hands the quarter's ordinary building to a type
    // that says nothing about it. Harbor read ~43%. A ship's chandler is the
    // 1x2 the quarter needed; the customs house is its institution and is
    // capped at one, like the wash house.
    { id: 'chandlery', w: 1, h: 2, weight: 7 },
    { id: 'customs_house', w: 2, h: 2, weight: 2 },
    // The SECOND small exclusive. One plus a cap is not enough — the cap is
    // what stops monoculture and the moment it binds the quarter falls back
    // on the shared row_house, which measured as harbor's largest single type
    // at 31 of 65 buildings. The caps have to sum to the quarter.
    { id: 'sail_loft', w: 1, h: 2, weight: 6 },
  ],
  fortress: [
    { id: 'watchtower', w: 2, h: 2, weight: 2 },
    { id: 'tower', w: 2, h: 2, weight: 1 },
    { id: 'town_gate', w: 3, h: 1, weight: 3 },
    { id: 'warehouse', w: 4, h: 3, weight: 2 },
    { id: 'building_small', w: 2, h: 2, weight: 2 },
    { id: 'round_tower', w: 2, h: 2, weight: 2 },
    { id: 'gatehouse', w: 4, h: 2, weight: 5 },
    // FORTRESS HAD NO 1x2 AT ALL — every entry above is 2x2 or larger and
    // four of the seven are towers, so the quarter is monuments with nothing
    // between them and infill has to reach for generic housing. A guardhouse
    // is the ordinary building of a garrison: low, flat-topped, parapeted,
    // built against the wall. Flat beside four pointed towers is a silhouette
    // no other quarter has.
    { id: 'guardhouse', w: 1, h: 2, weight: 6 },
    { id: 'armory', w: 2, h: 2, weight: 3 },
  ],
  cemetery: [
    { id: 'chapel', w: 3, h: 4, weight: 5 },
    { id: 'tower', w: 2, h: 2, weight: 1 },
    // Before these, cemetery's whole table was two NEVER_TERRACED monuments,
    // so infill could place nothing and the quarter came out at four
    // buildings. A graveyard SHOULD be sparse, but sparse and empty are not
    // the same thing: a sexton's hut, a row of mausolea and an almshouse on
    // the lane are what a real burial ground has around its chapel.
    { id: 'mausoleum', w: 2, h: 2, weight: 4 },
    { id: 'sexton_hut', w: 1, h: 2, weight: 3 },
    { id: 'almshouse', w: 1, h: 3, weight: 2 },
  ],
}

// District-specific prop palettes
/**
 * Types that stand ALONE and are never repeated along a street.
 *
 * The row streak copies its anchor's type up to four more times in each
 * direction, which is right for a terrace and absurd for a tower: nobody
 * builds nine identical 19m round towers in a line. Combined with a fortress
 * district that weights `round_tower` at 10 — the heaviest weight of any
 * building type anywhere — one unlucky roll produced a thicket, and measured
 * that is exactly what happened: 93 towers averaging 19m tall against 179 row
 * houses averaging 4.7m.
 *
 * It is also a Lynch failure rather than merely an ugly one. A LANDMARK only
 * orients you if it is rare; ninety-three of them are wallpaper, and the vista
 * audit was scoring towers as weenies precisely because they were everywhere.
 */
/**
 * How many of a type ONE QUARTER may have. Absent = unlimited.
 *
 * Giving the starved districts their own small buildings worked and then
 * immediately overshot: a cemetery came out with 21 sexton's huts and a
 * garden with 11 potting sheds. There is one sexton. The character metric
 * read 100% and was meaningless, because a type exclusive to a quarter is
 * "distinctive" no matter how many of it you stamp — the same self-gaming
 * that filling noble gaps with towers produced an hour earlier.
 *
 * This is the WALLPAPER failure from CLAUDE.md at district scale: content
 * that fires at the same rate everywhere inside a quarter differentiates
 * nothing, and it looks like success in every aggregate.
 *
 * The bias that causes it is structural, not a weighting mistake: infill
 * picks the first weighted candidate that FITS, and the smallest type in a
 * table fits most often. So the smallest building in a district wins by
 * geometry however low its weight, and the only honest fix is to say out
 * loud how many of it a place should have.
 */
const MAX_PER_DISTRICT: Record<string, number> = {
  sexton_hut: 1,        // genuinely singular: there is one sexton
  mausoleum: 14,        // a row of tombs is correct, and it IS the cemetery
  almshouse: 10,        // an almshouse row is historically 6-12 units
  clergy_house: 8,      // a cathedral close is a street of them
  coach_house: 8,       // one behind each mansion
  potting_shed: 6,
  // A street washes in ONE place — same argument as the sexton. Uncapped at
  // 1x2 it hit SEVENTEEN on seed 11 and took the small slots the cottages
  // needed, dropping cottage from 11 to 1 on another: the cemetery's
  // twenty-one identical sexton's huts repeating itself in a new quarter,
  // which is what this table exists to stop.
  //
  // The footprint and the cap have to be chosen TOGETHER, and that is the
  // part I got wrong twice. At 2x2 it never overshot and was absent from two
  // towns in five, because a rare institution in a small quarter needs the
  // shape that fits often. At 1x2 uncapped it was reliable and absurd. The
  // shape buys presence, the cap buys scarcity, and neither does both.
  //
  // ONE, not two, and the reason is a thing I got wrong about this table: it
  // is keyed by district INSTANCE, and `residential` is the single type
  // `generateDistricts` deliberately lets repeat. So a cap of 2 reads as four
  // wash houses in a two-quarter town, which I briefly recorded as the cap
  // leaking. It was not leaking; I had assumed one ordinary quarter per town.
  // A cap here means "per quarter", which for a communal institution is 1.
  washhouse: 1,
  boathouse: 3,
  // FIFTEEN in a 39-building waterfront quarter — 38% of it — which is the
  // cemetery's twenty-one sexton huts arriving in a new quarter. A 1x2 shape
  // in a table whose other entries are 3x3 and 4x3 wins by geometry however
  // modest its weight, which is the same mechanism that makes a small
  // exclusive type work in the first place; the cap is the other half of it.
  //
  // It also moved two tracked metrics, and the A/B says how: eyeball's ROOF
  // sample count went 788 -> 1370 while wall fell, because fifteen tall
  // steep-roofed buildings put far more roof and less wall in a street view.
  // Nothing got darker — roofs are simply the darkest surface, so a
  // composition change reads as a tone regression. variety twinNear 6 -> 10
  // is the same fifteen buildings seen from the other side.
  smokehouse: 8,
  // A firing is an installation, not housing — same argument as the sexton
  // and the wash house. And the SHAPE and the CAP are chosen together: at
  // 2x2 the kiln placed ZERO on both seeds where artisan exists, which is
  // the wash house's failure repeating, because real odds are the weight
  // times how often the shape fits and only a 1x2 fits often.
  kiln: 2,
  // An INSTITUTION, capped like the wash house: a harbour has one customs
  // house. Same reasoning, and the same trap avoided — this table is keyed by
  // district INSTANCE, and harbor is not in the repeat list, so 1 here really
  // does mean one a town.
  customs_house: 1,
  // A garrison has an armoury, maybe two, not a street of them.
  armory: 2,
  // AND THE THREE NEW ORDINARY TYPES ALL OVERSHOT INTO MONOCULTURE ON THEIR
  // FIRST RUN, which is the eleventh time this has happened and the reason
  // this table exists. Uncapped, measured:
  //
  //     market     36 buildings, shambles 22    61% of the quarter
  //     market     47 buildings, shambles 26    55%
  //     fortress   26 buildings, guardhouse 21  81%
  //     harbor     61 buildings, chandlery 27   44%
  //
  // Every one of those quarters read 89-100% "distinctive", and the number is
  // WORTHLESS: a quarter-exclusive type scores as characteristic however many
  // you stamp, so a monoculture is the highest-scoring possible town. That is
  // self-gaming, exactly like filling noble's gaps with towers, and the
  // cemetery of 21 identical sexton's huts is the same reading.
  //
  // The caps are set by asking HOW MANY WOULD LOOK WRONG. A shambles and a
  // chandlery are STREET FORMS — York's Shambles is a whole lane of them and
  // a harbour front is a run of chandlers, so ten and twelve are a street
  // rather than scarcity. A guardhouse is not: a garrison has a few posts
  // along its wall and the rest of the quarter is towers and stores, so six.
  //
  // Written as scarcity these would be 3/4/2 and would cost coverage and
  // frontage for no gain, which the first version of this whole table did.
  shambles: 12,
  chandlery: 14,
  guardhouse: 6,
  sail_loft: 10,
  cookshop: 9,
}
// These read 1/10/4/4/3/3 first and cost three points of built coverage and
// five of achievable frontage, because they were written as SCARCITY when the
// job is preventing MONOCULTURE. The failure was a cemetery of 21 identical
// sexton's huts out of 28 buildings — one type swamping a quarter — not the
// existence of several of something. Only the hut is truly singular; the rest
// simply must not become the whole place. Set a cap by asking "how many would
// look wrong", not "how many would a careful person build".

const NEVER_TERRACED = new Set([
  'tower', 'round_tower', 'watchtower', 'bell_tower', 'bell_tower_tall',
  'clock_tower', 'cathedral', 'chapel', 'temple', 'windmill', 'lighthouse',
  'gatehouse', 'archway', 'town_gate', 'mill', 'guild_hall', 'warehouse',
])

/**
 * VIGNETTES — small groups of props that imply an ACTIVITY and share an owner.
 *
 * The dressing pass places ONE prop per chosen spot, so a house gets about one
 * object outside it (tenancy.mjs: row_house 62 buildings -> 58 props) and no
 * object explains any other. A lone barrel says nothing. A woodpile with a
 * crate beside it says somebody heats this house; a cart with crates stacked
 * off it says somebody is unloading.
 *
 * That is what "lived in" means mechanically, and it is measurable: every part
 * of a vignette sits on the same building's perimeter, so it lands as EXPLAINED
 * in tenancy.mjs rather than as another prop nobody asked for. The metric was
 * 46% before this.
 *
 * COMPOSED FROM THE EXISTING VOCABULARY on purpose. The store already defines
 * 42 props and this repo has repeatedly found finished geometry with no way
 * in; the shortage was never assets, it was a reason for two of them to be
 * near each other.
 *
 * `front` gates the group to the side the player sees: a washing line and a
 * woodpile belong out of sight, a bench and a flower box are presented to the
 * street. That split already exists in propForRole and is the one thing the
 * placer knew and was not using for composition.
 */
/**
 * Somewhere a household lives. Now `DWELLING_TYPES` in core/types.ts, beside
 * `footprintOf` and `stableHash`, because hoisting it out of propForRole
 * stopped TWO copies drifting and there were four: the renderer needs the same
 * predicate to decide whose windows a washing line may be strung between, and
 * tenancy.mjs and eyeball.mjs each kept a list that already disagreed with
 * this one about what a house is.
 */
const DWELLINGS = DWELLING_TYPES

interface Vignette {
  id: string
  /** true = street side only, false = back/side only, null = either. */
  front: boolean | null
  districts?: DistrictType[]
  /** First part goes on the anchor spot; the rest take adjacent free tiles. */
  parts: string[]
  /**
   * Only on somewhere a household lives.
   *
   * The first cut gated on DISTRICT alone and tenancy.mjs caught it at once:
   * explained fell 46% -> 30%, because a cemetery is a district and a
   * mausoleum is in it, so the placer cheerfully hung washing beside a tomb.
   * A district says what the quarter is FOR; only the building type says
   * whether anybody lives there.
   */
  home?: boolean
}
const VIGNETTES: Vignette[] = [
  // Domestic, out of sight — the evidence that somebody lives here.
  { id: 'woodpile', home: true, front: false,
    parts: ['woodpile', 'crate|barrel|rubble_pile'] },
  { id: 'washday', home: true, front: false,
    parts: ['cloth_line|rain_barrel', 'barrel|crate|woodpile'] },
  { id: 'waterbutt', home: true, front: false,
    parts: ['rain_barrel', 'woodpile|crate|bush'] },
  // Domestic, presented to the street.
  { id: 'doorstep', home: true, front: true,
    // The anchor needs options too: a bench is 2x1 and lost 18 groups to a
    // tile it could not sit on, while a pot beside a door is the same idea
    // in one tile. Every part with a multi-tile footprint wants a fallback.
    parts: ['bench|potted_plant', 'potted_plant|flower_box|planter_box'] },
  { id: 'windowgarden', home: true, front: true,
    parts: ['flower_box|flower_bed', 'planter_box|potted_plant'] },
  // Trade — something half-done, which reads as activity rather than storage.
  { id: 'delivery', front: true, districts: ['market', 'artisan', 'harbor'],
    parts: ['cart|wagon|crate_stack', 'crate_stack|barrel_stack|crate', 'barrel|crate'] },
  { id: 'stallside', front: true, districts: ['market'],
    parts: ['market_stall|market_tent', 'crate|crate_stack', 'barrel_stack|barrel'] },
  { id: 'forgeyard', front: null, districts: ['artisan'],
    parts: ['forge_brazier', 'rubble_pile', 'barrel'] },
  // Waterfront working gear.
  { id: 'quaygear', front: true, districts: ['harbor', 'waterfront'],
    parts: ['rope_coil|crate_stack', 'crate_stack|barrel_stack|barrel', 'fish_rack|crate'] },
  { id: 'drying', front: false, districts: ['harbor', 'waterfront'],
    parts: ['fish_rack', 'barrel|crate|rope_coil'] },
  // Rural.
  { id: 'hayrick', home: true, front: false, districts: ['garden', 'residential'],
    parts: ['hay_bale', 'cart|woodpile|crate'] },
  // A drawn boundary is the cheapest "somebody owns this" there is.
  { id: 'yardfence', home: true, front: false,
    parts: ['picket_fence|flower_bed', 'flower_bed|bush|potted_plant'] },
  // `potted_plant` is not decoration in this list, it is the reason the group
  // exists at all. Both of the first two options are 2x1, so they failed
  // together on any tile that could not take a pair and kitchengarden fired
  // ZERO times across three seeds — the alternatives were varied and none of
  // them was small. A herb pot by the back door is the smallest honest form of
  // the same idea, and it is what lets the group reach a terrace at all.
  { id: 'kitchengarden', home: true, front: false, districts: ['garden', 'residential', 'noble'],
    parts: ['planter_box|flower_bed|potted_plant', 'picket_fence|bush'] },
  // FIRE IN THE PUBLIC SPACE, and it is here for the test view rather than for
  // the plan view. DESIGN.md grades this town at dusk and pillar 5 asks for
  // three layers of warm light; the two that exist — lamp pools and hung
  // lanterns — are both overhead, so the walkable ground between them has no
  // light of its own. A brazier is the one prop in the vocabulary that emits,
  // now that its ember core actually reaches the emissive mesh instead of
  // being painted into the lit batch, and a fire basket in a market or on a
  // quay is what a medieval town put out when the sun went down.
  { id: 'nightfire', front: true, districts: ['market', 'harbor', 'waterfront', 'fortress'],
    parts: ['forge_brazier', 'crate|barrel|rubble_pile'] },
  // WORK STOPPED HERE, rather than "things are stored here". Every group
  // above arranges objects that are AT REST; these read as interrupted, which
  // is the difference between a tidy set-dressing and a street somebody just
  // walked out of. All three lead with a 1x1 option so they can reach a
  // terrace — the lesson kitchengarden cost, where both anchor alternatives
  // were 2x1 and the group fired zero times.
  // `front: false`, not null. At null it took 15 of one town's 39 groups —
  // a ladder against every fourth building, which is the wallpaper failure
  // arriving by way of a too-permissive gate rather than a too-common asset.
  // Round the back is also where you actually leave a ladder.
  { id: 'repairs', front: false, districts: ['artisan', 'slum', 'residential', 'harbor'],
    parts: ['ladder|crate_stack', 'sack_pile|crate|barrel'] },
  // Two parts, not three. A three-part group needs two free tiles ADJACENT to
  // its anchor and a terrace rarely offers that — `delivery` has three and
  // fires 0-1 a town for exactly this reason.
  { id: 'unloading', front: true, districts: ['market', 'harbor', 'waterfront', 'artisan'],
    parts: ['sack_pile|crate_stack', 'handcart|cart|barrel'] },
  // A tied-up horse needs somewhere to drink. hitchingPost is a BUILDING
  // feature and this is a PROP group, so they are placed by different passes
  // and cannot be paired directly — but both key off the same four types, so
  // in practice they land on the same frontages.
  { id: 'stableyard', front: true, districts: ['noble', 'fortress', 'residential'],
    parts: ['water_trough|mounting_block', 'hay_bale|haystack|sack_pile'] },
  // The garden quarter's own. A skep and a hedge is a kept garden; neither
  // exists anywhere else in the town's vocabulary.
  { id: 'apiary', home: true, front: false, districts: ['garden', 'residential'],
    parts: ['beehive', 'hedge|bush|flower_bed'] },
  // TEMPLE AND CEMETERY HAD NO DESIGNED GROUP AT ALL, which the district gates
  // make invisible: eighteen entries and not one lists either quarter, so the
  // only groups those two could ever draw are the five `home: true` ones — and
  // a cathedral close is chapels, bell towers, clergy houses and mausolea,
  // barely a dwelling among them. Two whole quarters were getting the scatter
  // and nothing else while the census reported a healthy town-wide rate.
  //
  // That is WALLPAPER'S TWIN: not a feature firing everywhere equally, but a
  // healthy aggregate hiding a population it never reaches. `features.mjs`
  // reports SPREAD across districts for exactly this reason and the vignette
  // census does not, because vigOk is one counter.
  //
  // A lit shrine at a precinct wall is also the one place pillar 5's third
  // light layer belongs outside a market: a candle stand by a gate is what a
  // temple quarter has after dark.
  { id: 'shrine', front: true, districts: ['temple', 'cemetery'],
    parts: ['wall_lantern|forge_brazier', 'potted_plant|bench|flower_bed'] },
  // Somebody tends the graves. A watering can does not exist in the
  // vocabulary; a barrow of rubble and a leaning ladder do, and they read as
  // maintenance rather than as clutter because of where they are.
  { id: 'graveside', front: false, districts: ['cemetery', 'temple'],
    parts: ['handcart|ladder', 'rubble_pile|sack_pile|woodpile'] },
  // The masons' yard beside a cathedral under construction — which every
  // medieval cathedral permanently was. Cut stone waiting to go up is the
  // most characteristic thing about a temple precinct and the town already
  // has both props.
  { id: 'stoneyard', front: null, districts: ['temple', 'noble'],
    parts: ['rubble_pile|rock', 'handcart|ladder|crate_stack'] },
  // Fortress had `nightfire` and `stableyard`, both shared with three other
  // quarters, so its groups said nothing about it. Colours over a guardhouse
  // door do.
  { id: 'guardpost', front: true, districts: ['fortress'],
    parts: ['heraldic_banner', 'barrel|crate|water_trough'] },
]

const DISTRICT_PROPS: Record<DistrictType, string[]> = {
  market: ['market_stall', 'market_tent', 'crate', 'crate_stack', 'barrel', 'hanging_sign', 'wagon', 'sign', 'cafe_table', 'cart', 'market_tent', 'bunting_pole', 'tent', 'handcart', 'sack_pile', 'well_grand'],
  residential: ['potted_plant', 'bench', 'well', 'fence', 'planter_box', 'flower_box', 'cloth_line', 'rain_barrel', 'woodpile', 'ladder', 'mounting_block', 'handcart'],
  artisan: ['barrel', 'crate', 'barrel_stack', 'sign', 'fence', 'crate_stack', 'woodpile', 'cart', 'rain_barrel', 'forge_brazier', 'forge_brazier', 'ladder', 'handcart', 'sack_pile'],
  noble: ['potted_plant', 'planter_box', 'bench', 'statue', 'fountain', 'wall_lantern', 'column', 'monument', 'garden_arch', 'flower_box', 'heraldic_banner', 'heraldic_banner', 'hedge', 'mounting_block', 'water_trough'],
  waterfront: ['barrel', 'crate', 'wagon', 'sign', 'bench', 'crate_stack', 'horse_post', 'rain_barrel', 'fish_rack', 'rope_coil', 'sack_pile', 'handcart'],
  temple: ['statue', 'potted_plant', 'stone_wall', 'wall_lantern', 'column', 'monument', 'garden_arch', 'prayer_flags', 'prayer_flags', 'hedge', 'well_grand'],
  slum: ['barrel', 'crate', 'barrel_stack', 'woodpile', 'rain_barrel', 'rubble_pile', 'rubble_pile', 'rubble_pile', 'ladder', 'sack_pile'],
  garden: ['potted_plant', 'planter_box', 'bench', 'fountain', 'bush', 'tree', 'flower_box', 'garden_arch', 'trellis_arch', 'flower_bed', 'flower_bed', 'hedge', 'beehive', 'pavilion', 'haystack'],
  harbor: ['barrel', 'crate', 'crate_stack', 'wagon', 'horse_post', 'dock', 'crane', 'fishing_boat', 'rain_barrel', 'fish_rack', 'fish_rack', 'rope_coil', 'rope_coil', 'sack_pile', 'handcart'],
  // Fortress is the one quarter whose palette had no FIRE in it, and it is
  // the quarter that would be manned all night. A brazier is also the only
  // ground-level emitter in the whole prop vocabulary, so this is pillar 5's
  // third light layer reaching a quarter that had none of it.
  fortress: ['stone_wall', 'barrel', 'crate', 'wall_lantern', 'iron_fence', 'heraldic_banner', 'heraldic_banner', 'water_trough', 'haystack', 'ladder', 'forge_brazier', 'forge_brazier', 'crate_stack', 'sack_pile', 'mounting_block'],
  cemetery: ['gravestone', 'iron_fence', 'potted_plant', 'tree', 'wall_lantern', 'bench', 'cemetery_cross', 'cemetery_cross', 'hedge'],
}

// Street-edge furniture per district. Deliberately a narrower list than
// DISTRICT_PROPS: only small ground clutter that belongs at the kerb, so no
// fountains, docks, trees or wall-mounted pieces. Placed by
// placeStreetFurniture, which walks the road network rather than clustering
// on buildings.
const STREET_FURNITURE: Record<DistrictType, string[]> = {
  market: ['crate', 'barrel', 'crate_stack', 'cart', 'market_stall', 'hay_bale', 'sign', 'sack_pile', 'handcart'],
  residential: ['bench', 'potted_plant', 'flower_box', 'rain_barrel', 'woodpile', 'planter_box', 'mounting_block', 'ladder'],
  artisan: ['barrel', 'crate', 'barrel_stack', 'woodpile', 'cart', 'crate_stack', 'ladder', 'sack_pile'],
  noble: ['bench', 'potted_plant', 'planter_box', 'flower_box', 'column', 'mounting_block'],
  waterfront: ['barrel', 'crate', 'rope_coil', 'crate_stack', 'horse_post', 'bench'],
  temple: ['potted_plant', 'column', 'bench', 'prayer_flags'],
  slum: ['barrel', 'crate', 'rubble_pile', 'woodpile', 'rain_barrel', 'sack_pile'],
  garden: ['bench', 'potted_plant', 'planter_box', 'flower_bed', 'flower_box', 'beehive'],
  harbor: ['barrel', 'crate', 'crate_stack', 'rope_coil', 'fish_rack', 'horse_post', 'sack_pile'],
  fortress: ['barrel', 'crate', 'iron_fence', 'woodpile'],
  cemetery: ['iron_fence', 'potted_plant', 'bench', 'gravestone'],
}

// District density multipliers
const DISTRICT_DENSITY: Record<DistrictType, number> = {
  market: 1.1, residential: 0.9, artisan: 1.0, noble: 0.7,
  waterfront: 0.8, temple: 0.6, slum: 1.3, garden: 0.4,
  harbor: 0.9, fortress: 0.5, cemetery: 0.3,
}

// District elevation bias — temples and nobles on the heights, waterfront at sea level
// Applied as a modifier to the height map during building placement
const DISTRICT_ELEVATION_BIAS: Record<DistrictType, number> = {
  temple: 0.8,     // acropolis — always seek the high ground
  noble: 0.5,      // elevated mansions overlooking the town
  garden: 0.3,     // hillside gardens with views
  residential: 0,  // neutral
  artisan: -0.1,   // slightly lower, workshop districts
  market: -0.2,    // accessible center, ground level
  waterfront: -0.4, // down by the water
  slum: -0.3,      // low-lying areas
  harbor: -0.5, fortress: 0.6, cemetery: 0.2,
}


export class TownGenerator implements IMapGenerator {
  readonly type = 'town'
  readonly displayName = 'Town'
  readonly description = 'Generates an organic town with districts, winding streets, plazas, and dense buildings'

  generate(config: GenerationConfig): MapDocument {
    const { width, height, seed, complexity, density } = config
    const rng = createRNG(seed)
    const noise = new SimplexNoise(seed)

    // Counters are reset HERE, at the top of generation, not inside
    // placeBuildings. They used to be cleared there — which is step 10 — so
    // every counter recorded by an earlier pass was silently wiped before
    // anyone could read it. A diagnostic that only works for passes after the
    // halfway point is a diagnostic with a trap in it.
    for (const k of Object.keys(placeStats)) delete placeStats[k]

    // 1. Height map
    const heightMap = this.generateHeightMap(width, height, noise)

    // 2. Base terrain
    const terrainTiles = this.generateBaseTerrain(width, height, noise)

    // 3. Water channels as natural district dividers
    // heightMap goes IN, and comes back with a valley cut into it. The river
    // used to be routed without it entirely — see generateWaterChannels.
    // NaN = "no explicit waterline here", which the renderer reads as flush.
    // Ponds keep that; the carved river fills it in.
    const waterLevel = Array.from({ length: height },
      () => Array.from({ length: width }, () => Number.NaN))
    const waterMap = this.generateWaterChannels(
      width, height, noise, rng, complexity, heightMap, waterLevel)
    this.paintWater(terrainTiles, waterMap, width, height, noise)

    // 3b. Natural ponds in low-lying areas (organic water bodies)
    this.generateNaturalPonds(width, height, heightMap, waterMap, terrainTiles, noise, rng)

    // 4. District system (Voronoi-based)
    const districts = this.generateDistricts(width, height, complexity, rng, noise, waterMap)
    const districtMap = this.assignDistrictMap(width, height, districts, noise)

    // 5. Paint district-specific terrain
    this.paintDistrictTerrain(terrainTiles, districtMap, districts, width, height, noise, waterMap)

    // 6. Central plaza + district plazas (sized for 3D walkability)
    const mainCenter = districts.length > 0 ? districts[0].center : { x: Math.floor(width / 2), y: Math.floor(height / 2) }
    // Plaza sizes are in TILES and a tile is 3 metres, which is the whole
    // story here. At radius 4 + complexity*4 the main square ran to rX = 8,
    // i.e. 48m across before the edge noise widened it by another half — a
    // square the size of four football pitches. Every district got one too,
    // whatever its type, and together they covered 37% OF THE MAP. Narrowing
    // the streets only made that visible: the merged carriageway had been
    // hiding inside an equally large expanse of flagstone.
    //
    // A real town square is 30-40m across. Radius 5 is an rX of 15m, so a
    // 30m x 18m ellipse — big enough to hold a market and small enough that
    // the buildings on the far side still read as a wall.
    // The town's PRINCIPAL square, and it should outrank the district ones.
    // At radius 3-5 it came out 24m by 18m, which sounds reasonable and is
    // not: tools/squares.mjs found no square at all in two seeds of three,
    // because nowhere inside it was 15m clear of a building. Plenty of open
    // paving (839 tiles in one of them, MORE than the seed that did have a
    // square) and none of it deep enough to stand in and feel enclosed.
    // Radius 4-6 gives roughly 30m by 24m — a market square rather than a
    // wide spot, and still a quarter of the four-football-pitches original.
    const plazaRadius = Math.floor(4 + complexity * 2)
    const squareMap = Array.from({ length: height },
      () => Array.from({ length: width }, () => false))
    this.carvePlaza(terrainTiles, mainCenter.x, mainCenter.y, plazaRadius,
      width, height, 2, squareMap)

    for (let i = 1; i < districts.length; i++) {
      // Not every district gets a square. A residential quarter has streets
      // and courtyards, not a civic space — giving one to all of them is how
      // six squares ended up costing more ground than every street combined.
      const d = districts[i]
      if (d.type !== 'temple' && d.type !== 'noble' && d.type !== 'market') continue
      // Overshot last round. Cutting these from "four football pitches" landed
      // at rX 2-4, which with the golden-ratio minor axis is a 6x4 tile
      // ellipse — 18m by 12m, a courtyard rather than a square, and small
      // enough that tools/squares.mjs finds no square at all in two seeds out
      // of three. Alexander #61 wants about 20m across for a square people
      // use; this lands 24-30m by 15-18m.
      const dPlazaR = d.type === 'temple' || d.type === 'noble'
        ? Math.floor(3 + complexity * 2)
        : Math.floor(3 + complexity * 1.5)
      this.carvePlaza(terrainTiles, d.center.x, d.center.y, dPlazaR,
        width, height, 14, squareMap)
    }

    // 7. Street hierarchy
    const roadMap = this.generateStreetNetwork(
      width, height, mainCenter, districts, complexity, density, rng, noise,
      terrainTiles, waterMap, squareMap
    )

    // 7a. Sitte: a square is a room, and streets meet it at its corners.
    this.openSquareRooms(width, height, roadMap, squareMap, terrainTiles,
      mainCenter, plazaRadius)

    // 7b. THE TOWN BUILDS A HARD EDGE ON ITS RIVER.
    this.buildQuayWalls(width, height, roadMap, waterMap, heightMap, waterLevel)

    // 7c. AND NOWHERE ELSE IS ALLOWED A CLIFF.
    this.relaxTerrainSteps(width, height, heightMap, waterMap)

    // 8. Place bridges over water where roads cross
    const bridges = this.placeBridges(width, height, roadMap, waterMap, rng)
    // A continuous river severs the town unless something crosses it, and
    // placeBridges only looks for a road heading east into water. This makes
    // "you can walk to the whole town" an invariant instead of a hope.
    bridges.push(...this.ensureRiverCrossings(
      width, height, waterMap, bridges, heightMap))

    // 9. Place landmarks FIRST, so they get first pick of the vistas.
    //
    // This used to run after the buildings, and that ordering is why the town
    // had no weenies. `placeBuildings` walks every road edge and fills it, so
    // by the time a cathedral went looking for somewhere to stand, every spot
    // that closed a street was already a row house and all that was left was
    // the leftovers behind them. Measured: of 244 long looks down a street,
    // FOUR ended on a landmark. Ranking the landmark search by vista score
    // barely helped for the same reason — you cannot rank spots that are gone.
    //
    // Composition has to be decided before the infill, which is the ordinary
    // way round for a town: the cathedral and the gate were there first and
    // the houses grew up against them.
    const { landmarks, dressing: landmarkDressing } = this.placeLandmarks(
      // Bridges are laid down before landmarks and are pure occupancy here —
      // without them a staircase could be dropped on top of a bridge.
      width, height, roadMap, waterMap, districts, districtMap,
      bridges, heightMap,
      complexity, rng, mainCenter, terrainTiles
    )
    // The bench, statue and tavern signage that dress those landmarks are
    // PROPS — pushed into placedProps below, where that accumulator exists.
    // They were going out in the structure layer, where the building factory
    // turned each of them into a house. See placeLandmarks.
    placeStats._landmarkDressingProps = landmarkDressing.length

    // 10. Place buildings with district awareness, around the landmarks.
    const buildings = this.placeBuildings(
      width, height, roadMap, waterMap, heightMap, districtMap, districts,
      complexity, density, rng, mainCenter, terrainTiles, noise, squareMap,
      [...bridges, ...landmarks] // already placed — don't build through them
    )

    // Running accumulators of what is already on the ground.
    //
    // Every prop placer needs this, and until now each call site hand-listed
    // its own inputs — six sites spreading up to nine arrays each. Three
    // sources were never threaded through at all (both courtyard passes and,
    // at the far end of the chain, countryside), which is exactly why road
    // markers landed on lampposts and potted plants on cafe tables. It only
    // takes one forgotten spread. Accumulating makes that impossible:
    // `allProps` below IS this list, so the props that get audited are
    // precisely the props every placer was shown.
    //
    // `anchors` are structures props may deliberately cluster AGAINST;
    // `blockers` merely occupy tiles and must never act as anchors (feeding
    // town walls through the anchor role once lined the whole perimeter
    // with barrels).
    const anchors: PlacedObject[] = [...buildings, ...landmarks]
    const blockers: PlacedObject[] = [...bridges]
    let placedProps: PlacedObject[] = [...landmarkDressing]
    /** Structures placed so far — occupancy only. */
    const solid = (): PlacedObject[] => [...anchors, ...blockers]
    /** Everything placed so far, structures and props alike. */
    const taken = (): PlacedObject[] => [...anchors, ...blockers, ...placedProps]

    // 10b. Hidden passages & garden courtyards (Parisian passages + Kyoto tsuboniwa)
    const hiddenCourtyards = this.carveHiddenPassages(
      terrainTiles, roadMap, waterMap, heightMap,
      solid(), districtMap, districts,
      width, height, rng, noise
    )
    placedProps.push(...hiddenCourtyards)

    // 11. Carve alleys between building clusters
    this.carveAlleys(terrainTiles, [...buildings, ...landmarks], width, height)

    // 11b. Give the back of the block back.
    this.softenBackOfBlock(
      terrainTiles, squareMap, districtMap, districts,
      [...buildings, ...landmarks], width, height, noise
    )

    // 12. Place town gates at map edges where roads exit
    const gates = this.placeGates(width, height, roadMap, rng, solid(), waterMap)
    anchors.push(...gates)

    // 12b. Town walls around perimeter.
    // Deliberately NOT solid(): this list also sets the wall's bounding box,
    // and gates sit at the map edge while bridges reach out over water, so
    // including either would push the perimeter outward. Gates are handled
    // by the dedicated param, which already keeps a 4-tile opening.
    // Bridges go in through the GATES parameter, not the buildings list: that
    // list also sets the wall's bounding box and a bridge reaches out over
    // water, which would push the perimeter into the river. What the wall
    // needs from a bridge is only "do not build on these tiles" — the same
    // thing it needs from a gate, and the same footprint-marking that fixed
    // the gate overlap. Longer spans now land on plain ground on the far
    // bank, which is neither road nor water, so nothing else was stopping a
    // wall segment from being laid across the end of a bridge.
    const townWalls = this.placeWalls(
      width, height, roadMap, waterMap, [...buildings, ...landmarks],
      gates, rng, terrainTiles, bridges)
    blockers.push(...townWalls)

    // 12b. Boundary walls round the quarters that are DELIBERATELY sparse.
    const precinctWalls = this.encloseSparseQuarters(
      width, height, roadMap, waterMap, districtMap, districts,
      solid(), heightMap, terrainTiles, rng)
    blockers.push(...precinctWalls)

    // 12d. THE WATERFRONT CLAIMS ITS OWN BANK, before the global prop passes
    // get to it. Run late, after placeVegetation and the rest, it found half
    // the bank already taken by scattered bushes and trees — the generic
    // scatter had spent the riverside on street furniture. A parcel owns its
    // frontage; the river owns its bank.
    placedProps.push(...this.dressWaterfront(
      width, height, terrainTiles, waterMap, taken(), solid(), heightMap, rng))

    // 12c. Grand courtyards — intentional enclosed spaces with symmetry
    const courtyardProps = this.generateGrandCourtyards(
      terrainTiles, roadMap, waterMap, heightMap,
      taken(),
      districtMap, districts, width, height, rng, noise
    )
    placedProps.push(...courtyardProps)

    // 13. Contextual props per district
    // 13a. THE MAIN SQUARE DRESSES ITSELF FIRST.
    //
    // This used to run after placeProps, placeLights and placeStreetFurniture,
    // and the square is the most attractive open space on the map by any
    // distance metric — so those three filled it, and by the time its own pass
    // arrived there was nothing left. Measured: the fountain placed ZERO times
    // across three towns. Every town this project has generated has had an
    // empty central node, silently, because the composition pass ran last.
    //
    // Third instance of the same shape today, after the waterfront and the
    // quay: A DESIGNED PLACE MUST BE DRESSED BEFORE THE GLOBAL SCATTER RUNS.
    // The scatter answers "is this spot bare"; only the owner knows what
    // belongs there.
    // 15. Plaza features (fountain, market stalls, statues)
    const plazaProps = this.placePlazaFeatures(
      width, height, mainCenter, plazaRadius, districts,
      taken(), density, rng,
      roadMap, waterMap,
    )
    placedProps.push(...plazaProps)

    const props = this.placeProps(
      width, height, roadMap, waterMap,
      anchors,
      // Blockers only: town walls and bridges were previously invisible here,
      // so props ended up buried inside the wall and its watchtowers. And it
      // happened AGAIN with precinct_wall — a hand-listed argument is a bug
      // generator, which this file already says in as many words, so use the
      // accumulator. taken() is anchors + blockers + everything placed, and
      // there is no second list to forget.
      taken(),
      districtMap, districts, density, config.assetFrequencies, rng, mainCenter
    )
    placedProps.push(...props)

    // 14. Lampposts along all streets
    const lights = this.placeLights(width, height, roadMap, waterMap, taken(), rng, density)
    placedProps.push(...lights)

    // 14b. Street furniture along the walkable network itself
    const streetFurniture = this.placeStreetFurniture(
      width, height, roadMap, waterMap, taken(),
      districtMap, districts, density, rng, terrainTiles
    )
    placedProps.push(...streetFurniture)


    // 16. Vegetation with district awareness + species variety
    const vegetation = this.placeVegetation(
      width, height, roadMap, waterMap, taken(),
      districtMap, districts, density, rng, noise, heightMap
    )
    placedProps.push(...vegetation)

    // 16b. Private gardens behind buildings
    const gardens = this.plantPrivateGardens(
      width, height, roadMap, waterMap, heightMap,
      solid(),
      districtMap, districts,
      placedProps,
      terrainTiles, rng, noise
    )
    placedProps.push(...gardens)

    // 16c. Organic terrain features (rocky outcrops, wildflower meadows)
    this.paintOrganicTerrain(terrainTiles, heightMap, waterMap, roadMap, districtMap, districts,
      width, height, noise, rng)

    // Build layers
    // 17. Countryside beyond walls
    const countrysideProps = this.placeCountryside(
      width, height, roadMap, waterMap, districtMap, terrainTiles,
      solid(), gates, placedProps, noise, rng
    )
    placedProps.push(...countrysideProps)

    // 17b. Fill the streets the emptiness metric says are bare. Runs LAST so
    // it can see every anchor and every prop the earlier passes produced.
    const streetFill = this.dressEmptyStreets(
      width, height, terrainTiles, roadMap, waterMap,
      // solid(), not anchors — bridges live in `blockers`, and passing only
      // anchors put a bush inside one. This is the hand-threaded argument list
      // the accumulators exist to prevent; use the accumulator.
      solid(), placedProps, rng, squareMap)
    placedProps.push(...streetFill)

    // Safety net: drop anything whose footprint hangs off the grid. Every
    // placer is supposed to bounds-check (most use areaFree), but a stray
    // 2x2 fountain anchored on the last row still slipped through, and an
    // object partly outside the map renders half-clipped. Enforce the
    // invariant once, here, rather than trusting a dozen call sites.
    const inBounds = (o: PlacedObject): boolean => {
      const ofp = (o.footprint ?? this.getFootprint(o.definitionId))
      return o.x >= 0 && o.y >= 0 && o.x + ofp.w <= width && o.y + ofp.h <= height
    }

    // A LANDMARK'S DRESSING IS NOT A STRUCTURE.
    //
    // `placeLandmarks` dresses what it places — a bench in front of the clock
    // tower, a barrel stack and hanging sign beside the tavern, a statue on
    // the plaza — and pushed all of it into `landmarks`, which flows into
    // `anchors` and out into the STRUCTURE layer. The intent is right and the
    // destination was wrong: BuildingFactory draws that layer, so a bench came
    // out as a NINE-METRE BUILDING with walls, windows and a roof. Three to
    // eight of them a town: rare enough never to be the subject of a
    // screenshot, common enough to be in most of them.
    //
    // `humanscale.mjs --by-type` is what surfaced it, and only because it
    // reports by TYPE. The aggregate spread looked like ordinary variation;
    // a line reading `bench ... wallH 9.5` cannot be anything else.
    //
    // This wants to be an invariant enforced once at the end, the way the
    // buried-prop and water-tile rules are. It is not, and the reason is
    // worth recording: that test needs each object's CATEGORY, the categories
    // live in store.ts, and store.ts already imports the generator registry —
    // so the generator cannot read them without an import cycle. The pass
    // that creates the dressing is the only place here that knows what it is,
    // so it keeps it separate instead.
    const allStructures = [...anchors, ...blockers].filter(inBounds)

    // NO PROP MAY BE BURIED IN A STRUCTURE — enforced once, here, instead of
    // hoped for in each of the eight passes that place props.
    //
    // Every one of those passes takes its own snapshot of what is already on
    // the ground, and this file already records the shape twice: town walls
    // were invisible to placeProps until someone passed blockers, and bridges
    // were invisible to dressEmptyStreets until someone passed solid(). It
    // happened a third time with precinct_wall. Threading the right list into
    // every pass is a bug generator; the invariant is cheap to enforce for
    // real, and it holds for any pass written later by anyone.
    const structTiles = new Set<string>()
    for (const o of allStructures) {
      const fp = o.footprint ?? this.getFootprint(o.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) structTiles.add(`${o.x + dx},${o.y + dy}`)
      }
    }
    const buriedProps = placedProps.filter((p) => {
      const fp = p.footprint ?? this.getFootprint(p.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          if (structTiles.has(`${p.x + dx},${p.y + dy}`)) return true
        }
      }
      return false
    })
    if (buriedProps.length) {
      placeStats._buriedPropsDropped = buriedProps.length
      const drop = new Set(buriedProps.map((p) => p.id))
      placedProps = placedProps.filter((p) => !drop.has(p.id))
    }
    // Exactly the accumulator every placer above was handed — there is no
    // second, hand-maintained list that can drift out of sync with it.
    const allProps = placedProps.filter(inBounds)

    // THE TILE MAP AND THE WATER MAP MUST AGREE.
    //
    // Somewhere among ~20 terrain passes, a tile that `waterMap` calls water
    // gets painted as land. Its HEIGHT is still the riverbed — `carveRiverBed`
    // keys off waterMap — so the result is a land tile sitting below the
    // waterline, and the ground mesh dutifully draws a quad ramping from the
    // quay down into the river. Photographed, that is a pale slipway diving
    // into the water every few tiles along the bank.
    //
    // Enforced once, here, rather than by auditing every pass for a guard:
    // the same shape as the buried-prop invariant, and for the same reason —
    // a rule applied in nineteen places out of twenty is not applied.
    let reasserted = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (waterMap[y][x] && terrainTiles[y][x] !== 3) {
          terrainTiles[y][x] = 3
          reasserted++
        }
      }
    }
    placeStats._waterTilesRepainted = reasserted

    const terrainLayer: MapLayer = {
      id: uuid(), name: 'Terrain', type: 'terrain',
      // heightMap travels WITH the terrain, so the renderer draws the ground
      // this generator actually planned on — including the river valley.
      // The district plan travels with it for the same reason: it is a fact
      // about the PLAN, and reading it back off the ground is the mistake this
      // repo keeps making. See MapLayer.districtMap.
      visible: true, locked: false, objects: [], terrainTiles, heightMap, waterLevel,
      districtMap,
      districtTypes: Object.fromEntries(districts.map((d) => [d.id, d.type])),
    }
    const structureLayer: MapLayer = {
      id: uuid(), name: 'Structures', type: 'structure',
      visible: true, locked: false, objects: allStructures
    }
    const propLayer: MapLayer = {
      id: uuid(), name: 'Props', type: 'prop',
      visible: true, locked: false, objects: allProps
    }

    const env: EnvironmentState = {
      // 6:30 PM (dusk) — see store.ts comment.
      timeOfDay: 18.5, weather: 'clear', weatherIntensity: 0,
      celestial: { moonPhase: 0.5, starDensity: 0.5, sunAngle: 45 },
      lighting: {
        ambientColor: '#ffffff', ambientIntensity: 0.6,
        directionalAngle: 45, directionalIntensity: 0.8
      }
    }

    return {
      id: uuid(),
      name: `Town (seed: ${seed})`,
      version: 1,
      gridWidth: width,
      gridHeight: height,
      tileSize: 32,
      layers: [terrainLayer, structureLayer, propLayer],
      environment: env,
      cameras: [],
      generationConfig: config
    }
  }


  // === HEIGHT MAP ===
  // Piranesi-inspired dramatic terrain: clear plateaus, steep drops, terraced ridges
  /**
   * THE height map. Singular, now.
   *
   * There were two, and they were not the same landscape. This one used to be
   * freq 0.03/0.06, amplitude x2.0, clamp 2.5 and 70% terraced, while
   * TerrainMesh generated its own from the seed at freq 0.022/0.055/0.11,
   * amplitude x4.4, clamp 5.5 and 10% terraced — and the renderer drew ITS
   * one. So everything planned here against elevation was planned against a
   * world the player never walks on: ponds sunk into low ground that is not
   * low, staircases on slopes that are not there, and a river carved into a
   * terrain nobody renders.
   *
   * The renderer's formula survived the merge because it is the better
   * landscape and it is the one that has been looked at: a low primary
   * frequency gives one or two broad hills across a 48-tile map instead of
   * noise texture, and only a light terrace pull, because discrete one-tile
   * steps read as a map bug rather than topography. The map is written onto
   * the terrain layer so TerrainMesh consumes it instead of re-deriving it.
   */
  private generateHeightMap(w: number, h: number, noise: SimplexNoise): number[][] {
    const map: number[][] = []
    for (let y = 0; y < h; y++) {
      const row: number[] = []
      for (let x = 0; x < w; x++) {
        const n1 = noise.fbm(x * 0.022, y * 0.022, 3, 2, 0.5)
        const n2 = noise.fbm(x * 0.055 + 50, y * 0.055 + 50, 2, 2, 0.5)
        const n3 = noise.fbm(x * 0.11 + 120, y * 0.11 + 120, 1, 2, 0.5) * 0.4
        const raw = (n1 * 0.6 + n2 * 0.3 + n3 * 0.1 + 0.5) * 4.4
        const terraced = Math.round(raw * 1.2) / 1.2
        const blend = terraced * 0.1 + raw * 0.9
        row.push(Math.max(0, Math.min(blend, 5.5)))
      }
      map.push(row)
    }
    return map
  }

  // === BASE TERRAIN ===
  private generateBaseTerrain(w: number, h: number, noise: SimplexNoise): number[][] {
    const tiles: number[][] = []
    for (let y = 0; y < h; y++) {
      const row: number[] = []
      for (let x = 0; x < w; x++) {
        // Two noise octaves for more natural terrain variation
        const n1 = noise.fbm(x * 0.06, y * 0.06, 3)
        const n2 = noise.fbm(x * 0.12 + 100, y * 0.12 + 100, 2)
        const n = n1 * 0.7 + n2 * 0.3
        if (n < -0.3) row.push(5)        // dark grass (meadow patches)
        else if (n < -0.05) row.push(0)  // grass
        else if (n < 0.15) row.push(n2 > 0 ? 0 : 5) // mixed grass patches
        else if (n < 0.35) row.push(1)   // dirt
        else row.push(0)                 // grass
      }
      tiles.push(row)
    }
    return tiles
  }

  // === WATER CHANNELS ===
  /**
   * THE RIVER — routed by the terrain and cut into it.
   *
   * Reported as "the rivers seem random, like a painted floor I can't walk
   * on", and `tools/river.mjs` says the wording was mechanically exact:
   *
   *   bank relief   0.03m   (88% of water tiles flush with their own banks)
   *   descent       51% of downstream steps, total drop -0.10m
   *   width         2.2 tiles at the source, 2.0 at the mouth
   *
   * The old routine never took `heightMap` as an argument. It started at a map
   * edge, walked in a straight line clamped to +/-0.4 radians off one axis,
   * wiggled by noise, at a constant width for its whole length — and nothing
   * lowered the ground beneath it. So the water was a translucent quad lying
   * exactly on the ground, crossing hills, flowing uphill half the time. The
   * contrast that gives the game away: `generateNaturalPonds` right below DOES
   * take heightMap and does put its ponds in low ground.
   *
   * What a river needs, in the order it matters:
   *
   * 1. A BED. Everything else is secondary — with no cut in the terrain there
   *    is no bank, and no amount of shader work rescues a flat blue patch.
   * 2. To flow DOWNHILL, monotonically, from a source to a mouth.
   * 3. To GATHER — narrow at the source, widest at the mouth.
   *
   * Routing is a Dijkstra search from source to mouth where climbing is
   * expensive and level ground is cheap, plus a noise term so the course
   * meanders instead of taking the geometrically shortest line. That is
   * deterministic, always terminates, and — unlike a greedy downhill walk —
   * cannot strand itself in a local pit and need rescuing.
   */
  private generateWaterChannels(
    w: number, h: number, noise: SimplexNoise, rng: () => number, complexity: number,
    heightMap: number[][], waterLevel: number[][]
  ): boolean[][] {
    const waterMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    const numChannels = complexity > 0.3 ? Math.floor(1 + complexity) : 0
    if (numChannels === 0) return waterMap

    const H = (x: number, y: number): number => heightMap[y]?.[x] ?? 0

    for (let c = 0; c < numChannels; c++) {
      // SOURCE high, MOUTH low. Both on the map edge so the river runs through
      // rather than beginning nowhere — two of five seeds used to have a
      // channel that simply stopped mid-map.
      const edgeTiles: { x: number; y: number }[] = []
      for (let x = 2; x < w - 2; x++) { edgeTiles.push({ x, y: 1 }); edgeTiles.push({ x, y: h - 2 }) }
      for (let y = 2; y < h - 2; y++) { edgeTiles.push({ x: 1, y }); edgeTiles.push({ x: w - 2, y }) }
      // Jitter the ranking so successive channels on the same map do not all
      // pick the same pair of corners.
      const score = (t: { x: number; y: number }): number =>
        H(t.x, t.y) + noise.noise2D(t.x * 0.15 + c * 31, t.y * 0.15) * 0.25
      const sorted = edgeTiles.slice().sort((a, b) => score(b) - score(a))
      const source = sorted[Math.floor(rng() * Math.min(6, sorted.length))]
      // The mouth must be far away, or the "river" is a puddle in one corner.
      const far = sorted.filter((t) =>
        Math.abs(t.x - source.x) + Math.abs(t.y - source.y) > (w + h) * 0.45)
      if (far.length === 0) continue
      const mouth = far[far.length - 1 - Math.floor(rng() * Math.min(6, far.length))]

      // --- Dijkstra: climbing is dear, descending is free -----------------
      const cost = new Float64Array(w * h).fill(Infinity)
      const prev = new Int32Array(w * h).fill(-1)
      const idx = (x: number, y: number): number => y * w + x
      cost[idx(source.x, source.y)] = 0
      // A simple binary heap keeps this near-linear; a 48x48 map is small but
      // this runs once per channel per generation and an O(n^2) scan here was
      // measurable.
      const heap: { c: number; x: number; y: number }[] = [{ c: 0, x: source.x, y: source.y }]
      const push = (n: { c: number; x: number; y: number }): void => {
        heap.push(n)
        let i = heap.length - 1
        while (i > 0) {
          const p = (i - 1) >> 1
          if (heap[p].c <= heap[i].c) break
          ;[heap[p], heap[i]] = [heap[i], heap[p]]; i = p
        }
      }
      const pop = (): { c: number; x: number; y: number } | undefined => {
        if (heap.length === 0) return undefined
        const top = heap[0], last = heap.pop()!
        if (heap.length) {
          heap[0] = last
          let i = 0
          for (;;) {
            const l = i * 2 + 1, r = l + 1
            let m = i
            if (l < heap.length && heap[l].c < heap[m].c) m = l
            if (r < heap.length && heap[r].c < heap[m].c) m = r
            if (m === i) break
            ;[heap[m], heap[i]] = [heap[i], heap[m]]; i = m
          }
        }
        return top
      }
      while (heap.length) {
        const cur = pop()!
        if (cur.c > cost[idx(cur.x, cur.y)]) continue
        if (cur.x === mouth.x && cur.y === mouth.y) break
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cur.x + dx, ny = cur.y + dy
          if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue
          const climb = Math.max(0, H(nx, ny) - H(cur.x, cur.y))
          // 1 = the cost of simply moving, so a route is never free; the climb
          // term dominates it, which is what makes the course seek the valley.
          // The noise term is what stops it being the shortest legal line —
          // a river meanders because the ground is uneven, not because a
          // sine wave was added to it afterwards.
          const wiggle = (noise.noise2D(nx * 0.11 + c * 17, ny * 0.11) + 1) * 0.9
          const nc = cur.c + 1 + climb * 26 + wiggle
          if (nc < cost[idx(nx, ny)]) {
            cost[idx(nx, ny)] = nc
            prev[idx(nx, ny)] = idx(cur.x, cur.y)
            push({ c: nc, x: nx, y: ny })
          }
        }
      }
      if (!Number.isFinite(cost[idx(mouth.x, mouth.y)])) continue

      // --- walk the path back, painting a widening channel ----------------
      const path: { x: number; y: number }[] = []
      for (let p = idx(mouth.x, mouth.y); p !== -1; p = prev[p]) {
        path.push({ x: p % w, y: Math.floor(p / w) })
      }
      path.reverse()

      for (let i = 0; i < path.length; i++) {
        const t = i / Math.max(1, path.length - 1)
        // A river GATHERS: half a tile of radius at the source, two at the
        // mouth. sqrt so it broadens early and then steadies, which is how a
        // catchment actually behaves and reads better than a straight ramp.
        // Reported from the phone as "wow, it's a grand canyon". The depth was
        // modest (max 2.06m) — what read as a gorge was PROPORTION: a channel
        // up to five tiles across is 15 metres of dark water at dusk with long
        // graded ramps either side, which is a river valley, not a town river.
        // A town sits on something you can shout across. 3.2 tiles at the
        // mouth is ~10m, about the Cam at Cambridge.
        const radius = 0.5 + Math.sqrt(t) * 1.1
        const ri = Math.ceil(radius)
        for (let dy = -ri; dy <= ri; dy++) {
          for (let dx = -ri; dx <= ri; dx++) {
            if (Math.hypot(dx, dy) > radius) continue
            const wx = path[i].x + dx, wy = path[i].y + dy
            if (wx < 0 || wy < 0 || wx >= w || wy >= h) continue
            waterMap[wy][wx] = true
          }
        }
      }

      this.carveRiverBed(path, waterMap, heightMap, w, h, waterLevel)
    }
    return waterMap
  }

  /**
   * Cut the channel into the height map, and raise its banks.
   *
   * This is the half that answers "painted floor". The 3D water surface is
   * built from the terrain's own corner heights (TerrainMesh does that
   * deliberately, so the shoreline seams instead of cracking), which means
   * water can only look like water if the LAND has a valley in it. Measured
   * before this existed: 88% of water tiles sat within 15cm of their own
   * banks.
   *
   * The profile is forced MONOTONIC from source to mouth before anything is
   * cut. That is what guarantees the river flows downhill — not a tendency,
   * an invariant — where routing alone only made it likely.
   */
  private carveRiverBed(
    path: { x: number; y: number }[],
    waterMap: boolean[][], heightMap: number[][],
    w: number, h: number, waterLevel: number[][]
  ): void {
    if (path.length < 2) return
    // Height units are RAW here; TERRAIN_WORLD_SCALE (1.8) turns them into
    // metres later. 0.85 raw is ~1.5m of bank, which is the low end of a real
    // river and safely inside the 0..2.5 band generateHeightMap produces.
    // Halved after the "grand canyon" report. 0.42 raw is ~0.75m of bank and
    // 0.28 is ~0.5m of bed, so the water sits ~1.25m below the land beside it
    // — an embanked town river you could sit on the edge of, rather than a
    // ravine. The first pass at 0.85/0.45 measured a perfectly healthy 1.14m
    // MEDIAN, which is why the median alone was not enough to catch it.
    // Tuned against the VISIBLE waterline, which took two rounds to measure
    // properly. river.mjs reported relief against heightAt(), and under water
    // that is the BED — so every figure was land-to-bed, deeper than anything
    // the eye sees. Land-to-waterline is what the complaint was about.
    //
    // Back-computing the version that got called a grand canyon: it had only
    // ~0.75m of visible bank. The gorge was never depth, it was PROPORTION —
    // fifteen metres of channel with a nine-metre graded ramp either side. So
    // with the width already down to three tiles, the bank can be a proper
    // quay edge again: 0.75 raw is ~1.35m, and a shorter SKIRT makes it read
    // as an edge rather than an embankment.
    const BANK = 0.75
    const BED = 0.32          // how far the bed drops below the waterline
    const SKIRT = 2           // tiles over which the bank blends back to land

    // 1. A monotonically falling waterline along the course.
    const surface: number[] = []
    let running = Infinity
    for (const p of path) {
      const here = heightMap[p.y]?.[p.x] ?? 0
      running = Math.min(running, here)
      surface.push(running)
    }
    // Guarantee a real fall even across flat ground, so the river reads as
    // going somewhere. Spread over the whole course rather than stepping.
    const drop = 0.35
    for (let i = 0; i < surface.length; i++) {
      surface[i] = Math.min(surface[i], surface[0] - (i / (surface.length - 1)) * drop)
    }

    // 2. Stamp the valley. Each path point owns a neighbourhood; the nearest
    //    point on the course wins, so a wide reach and a narrow one blend.
    const level = Array.from({ length: h }, () => new Float64Array(w).fill(NaN))
    for (let i = 0; i < path.length; i++) {
      const R = SKIRT + 2
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const x = path[i].x + dx, y = path[i].y + dy
          if (x < 0 || y < 0 || x >= w || y >= h) continue
          const d = Math.hypot(dx, dy)
          if (d > R) continue
          const s = surface[i]
          if (Number.isNaN(level[y][x]) || s < level[y][x]) level[y][x] = s
        }
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = level[y][x]
        if (Number.isNaN(s)) continue
        if (waterMap[y][x]) {
          // The bed goes into the height map; the WATERLINE goes into its own
          // map. The renderer needs both — the bed is what the bank falls to,
          // the waterline is where the surface sits — and it cannot infer the
          // second from the first.
          heightMap[y][x] = s - BED
          waterLevel[y][x] = s
          continue
        }
        // Land near the channel is BLENDED toward the bank height — raised
        // where the ground is low, and cut down where it is high.
        //
        // The first version only ever raised it, on the reasoning that a river
        // should not flatten a hill it runs past. That is true of a landscape
        // and false of a channel: where the course grazes high ground, leaving
        // the land at 5.5 raw while cutting the bed to 0.5 is a slot canyon
        // with a stream at the bottom. A real river erodes what it runs
        // through. Blending both ways bounds the bank by construction, which
        // is the guarantee the max-relief number could otherwise only report
        // after the fact.
        let nearest = Infinity
        for (let dy = -SKIRT; dy <= SKIRT; dy++) {
          for (let dx = -SKIRT; dx <= SKIRT; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            if (!waterMap[ny][nx]) continue
            nearest = Math.min(nearest, Math.hypot(dx, dy))
          }
        }
        if (!Number.isFinite(nearest)) continue
        // 1 at the water's edge, easing to 0 (untouched terrain) at SKIRT+1.
        const ease = Math.max(0, Math.min(1, 1 - (nearest - 1) / SKIRT))
        const bank = s + BANK
        heightMap[y][x] = heightMap[y][x] * (1 - ease) + bank * ease
      }
    }
  }

  /**
   * NO STREET IS A CLIFF — bounded by construction, not reported afterwards.
   *
   * Reported from the phone as "a giant ravine running through the middle of
   * town", and every number said otherwise: bank relief 0.69m median, 1.34m
   * max, and a CROSS-SECTION that falls away from the water rather than
   * rising. The river was not deep. `tools/relief.mjs` found it in the tail —
   * walkable grade p99 at 35% with a max of 44%, and every single steep tile
   * within four tiles of water.
   *
   * The tiles came in ADJACENT PAIRS at distance 2 and 3, which is exactly
   * where `carveRiverBed`'s two-tile skirt stops and untouched terrain
   * resumes. The blend eases from the bank height to nothing over two tiles;
   * where the natural ground is a couple of metres away from `waterline +
   * BANK`, two tiles cannot absorb it and the leftover appears as one hard
   * step. Repeated along the whole course, that is a continuous artificial
   * escarpment paralleling the river on both sides — which is precisely the
   * thing being described, and it is an artifact of the BLEND, not of the
   * channel's depth. No amount of measuring the channel could have found it.
   *
   * Widening the skirt is the obvious fix and it is the wrong one: a long
   * graded ramp either side is what got the first carve called a grand
   * canyon. Instead, relax the height field against a maximum step, with the
   * water and its immediate bank PINNED. That leaves the quay edge exactly as
   * built — a wall you look over is deliberate — and spreads everything
   * outward over as many tiles as the drop actually needs. Same argument as
   * the two-way bank clamp: bound it by construction rather than reporting the
   * max afterwards and hoping.
   */
  private relaxTerrainSteps(
    w: number, h: number, heightMap: number[][], waterMap: boolean[][],
  ): void {
    // 0.36 raw is 0.65m over a 3m tile — a 22% grade, steep for a street and
    // still short of a stair. Natural terrain here spans ~5m over 48 tiles,
    // so this only ever bites on the carve's own leftovers.
    const MAX_STEP = 0.36
    // Pinned: the water itself, and the bank tile whose height the carve and
    // the quay deliberately set. Relaxing those would flatten the very edge
    // this town spent an arc building.
    const pinned = Array.from({ length: h }, () => new Uint8Array(w))
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!waterMap[y][x]) continue
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx >= 0 && ny >= 0 && nx < w && ny < h) pinned[ny][nx] = 1
          }
        }
      }
    }
    // Gauss-Seidel style: fix the worst offender in each pair, sweep until it
    // converges. 24 sweeps is far more than the 5-6 it actually takes, and it
    // exits early — a cap rather than a schedule.
    for (let iter = 0; iter < 24; iter++) {
      let worst = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (waterMap[y][x]) continue
          for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
            const nx = x + dx, ny = y + dy
            if (nx >= w || ny >= h || waterMap[ny][nx]) continue
            const diff = heightMap[ny][nx] - heightMap[y][x]
            const over = Math.abs(diff) - MAX_STEP
            if (over <= 0) continue
            worst = Math.max(worst, over)
            const aPin = pinned[y][x], bPin = pinned[ny][nx]
            if (aPin && bPin) continue          // both fixed — nothing to give
            const sign = Math.sign(diff)
            // Move whichever end is free; if both are, split it.
            if (!aPin && !bPin) {
              heightMap[y][x] += sign * over * 0.5
              heightMap[ny][nx] -= sign * over * 0.5
            } else if (aPin) {
              heightMap[ny][nx] -= sign * over
            } else {
              heightMap[y][x] += sign * over
            }
          }
        }
      }
      if (worst < 0.01) break
    }
  }

  private paintWater(terrain: number[][], waterMap: boolean[][], w: number, h: number, noise: SimplexNoise): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (waterMap[y][x]) {
          terrain[y][x] = 3 // water
        } else {
          // Sand along water edges
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const nx = x + dx, ny = y + dy
              if (nx >= 0 && nx < w && ny >= 0 && ny < h && waterMap[ny][nx]) {
                const dist = Math.abs(dx) + Math.abs(dy)
                if (dist <= 2 && !waterMap[y][x]) {
                  if (dist === 1) terrain[y][x] = 4 // sand right next to water
                  else if (terrain[y][x] === 0) terrain[y][x] = 1 // dirt near water
                }
              }
            }
          }
        }
      }
    }
  }


  // === DISTRICT GENERATION ===
  private generateDistricts(
    w: number, h: number, complexity: number, rng: () => number,
    noise: SimplexNoise, waterMap: boolean[][]
  ): District[] {
    const numDistricts = Math.max(3, Math.floor(4 + complexity * 5))
    // THE ORDINARY FABRIC HAS TO BE THE COMMON CASE.
    //
    // This was a uniform pick over every unused type, which means a town was
    // exactly as likely to grow a cemetery as a residential quarter. Measured
    // over three seeds: two of them had NO residential district at all, and a
    // town whose housing has nowhere to be is not a town. Weight the pool so
    // the ordinary fabric leads and the special quarters are special.
    //
    // `waterfront` and `harbor` are absent on purpose — see below, they are
    // earned by the SITE rather than drawn from a bag.
    const DISTRICT_POOL: { type: DistrictType; weight: number }[] = [
      { type: 'residential', weight: 10 },
      { type: 'artisan', weight: 6 },
      { type: 'noble', weight: 4 },
      { type: 'temple', weight: 4 },
      { type: 'slum', weight: 3 },
      { type: 'fortress', weight: 2 },
      { type: 'garden', weight: 2 },
      { type: 'cemetery', weight: 2 },
    ]

    // Use Poisson disk for spread-out district centers
    const minDist = Math.max(6, Math.floor(Math.min(w, h) / (numDistricts * 0.6)))
    const candidates = poissonDiskSampling(w - 4, h - 4, minDist, rng)
      .map(p => ({ x: Math.floor(p.x) + 2, y: Math.floor(p.y) + 2 }))
      .filter(p => !waterMap[p.y]?.[p.x]) // Don't place centers in water

    const districts: District[] = []
    const usedTypes = new Set<DistrictType>()

    // First district is always market (town center, closest to map center)
    const mapCx = w / 2, mapCy = h / 2
    candidates.sort((a, b) => {
      const da = (a.x - mapCx) ** 2 + (a.y - mapCy) ** 2
      const db = (b.x - mapCx) ** 2 + (b.y - mapCy) ** 2
      return da - db
    })

    for (let i = 0; i < Math.min(numDistricts, candidates.length); i++) {
      let type: DistrictType
      if (i === 0) {
        type = 'market'
      } else {
        // A WATER QUARTER IS EARNED BY THE SITE, AND THERE IS ONLY ONE.
        //
        // This test was `hasNearbyWater(radius 6)` — any single wet tile in a
        // 13x13 box — written when the water was sparse noise blobs. The river
        // is a connected channel across the whole map now, so nearly every
        // candidate passes, and `harbor` sat in the random bag besides. Every
        // town came out with BOTH a harbor and a waterfront, together half of
        // all its buildings, sharing six of their ten building types: a
        // distinction with no difference, occupying the space the ordinary
        // quarters used to have.
        //
        // Count the water instead of testing for any, and make the two
        // mutually exclusive. A HARBOUR needs harbourage — a broad body you
        // could moor a hull in. A three-tile river passing by earns a
        // WATERFRONT, which is what a river town actually has.
        const wet = this.countNearbyWater(candidates[i].x, candidates[i].y, waterMap, w, h, 6)
        // Leave the histogram in. The thresholds below are the only numbers in
        // this function that cannot be derived, so the distribution they cut
        // has to stay visible or the next person tunes them blind.
        rejected(`~wet@${wet === 0 ? '0' : wet < 10 ? '1-9' : wet < 35 ? '10-34' : wet < 70 ? '35-69' : '70+'}`)
        const hasWaterQuarter = usedTypes.has('waterfront') || usedTypes.has('harbor')
        if (wet >= 34 && !hasWaterQuarter) {
          type = 'harbor'
        } else if (wet >= 8 && !hasWaterQuarter) {
          type = 'waterfront'
        } else {
          const avail = DISTRICT_POOL.filter(
            (t) => !usedTypes.has(t.type) || t.type === 'residential'
          )
          const total = avail.reduce((s, t) => s + t.weight, 0)
          let roll = rng() * total
          type = avail[avail.length - 1].type
          for (const t of avail) { roll -= t.weight; if (roll <= 0) { type = t.type; break } }
        }
      }

      usedTypes.add(type)
      const baseDensity = DISTRICT_DENSITY[type]

      districts.push({
        id: i,
        type,
        center: candidates[i],
        radius: Math.floor(6 + rng() * 4 + complexity * 3),
        buildingDensity: baseDensity * (0.8 + rng() * 0.4),
        propDensity: baseDensity * (0.7 + rng() * 0.6),
      })
    }

    return districts
  }

  private hasNearbyWater(x: number, y: number, waterMap: boolean[][], w: number, h: number, radius: number): boolean {
    return this.countNearbyWater(x, y, waterMap, w, h, radius) > 0
  }

  /**
   * HOW MUCH water is near, not whether any is.
   *
   * The boolean form of this question stopped discriminating the moment the
   * river became a connected channel: a 13x13 box around almost any centre
   * contains a wet tile, so "is this a waterfront?" answered yes everywhere.
   * A quantity survives that change; a predicate does not.
   */
  private countNearbyWater(x: number, y: number, waterMap: boolean[][], w: number, h: number, radius: number): number {
    let n = 0
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && waterMap[ny][nx]) n++
      }
    }
    return n
  }

  private assignDistrictMap(w: number, h: number, districts: District[], noise: SimplexNoise): number[][] {
    const map: number[][] = []
    for (let y = 0; y < h; y++) {
      const row: number[] = []
      for (let x = 0; x < w; x++) {
        if (districts.length === 0) {
          row.push(-1)
          continue
        }
        // Noise-perturbed nearest district
        let bestDist = Infinity
        let bestId = 0
        for (const d of districts) {
          const dist = perturbedDistance(x, y, d.center.x, d.center.y, noise, 0.08, 4)
          if (dist < bestDist) {
            bestDist = dist
            bestId = d.id
          }
        }
        row.push(bestId)
      }
      map.push(row)
    }
    return map
  }

  // === DISTRICT TERRAIN PAINTING ===
  private paintDistrictTerrain(
    terrain: number[][], districtMap: number[][], districts: District[],
    w: number, h: number, noise: SimplexNoise, waterMap: boolean[][]
  ): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (waterMap[y][x]) continue // Don't overwrite water
        const dId = districtMap[y][x]
        const d = districts.find(dd => dd.id === dId)
        if (!d) continue
        const n = noise.noise2D(x * 0.15, y * 0.15)

        // Second noise layer for terrain variety within districts
        const n2 = noise.noise2D(x * 0.25 + 50, y * 0.25 + 50)

        switch (d.type) {
          case 'noble':
            if (n > 0.3) terrain[y][x] = 2 // stone paths
            else if (n > 0.1) terrain[y][x] = n2 > 0 ? 2 : 0 // stone/grass mix
            else terrain[y][x] = 0 // grass courtyards
            break
          case 'garden':
            if (n > 0.4) terrain[y][x] = 5 // dark grass
            else if (n > 0.1) terrain[y][x] = n2 > 0.3 ? 5 : 0 // varied green
            else terrain[y][x] = 0 // grass
            break
          case 'waterfront':
            if (n > 0.2) terrain[y][x] = 4 // sand
            else if (n > -0.1) terrain[y][x] = n2 > 0 ? 4 : 1 // sand/dirt mix
            else terrain[y][x] = 1 // dirt
            break
          case 'slum':
            if (n > 0.1) terrain[y][x] = 1 // dirt
            else if (n > -0.2) terrain[y][x] = n2 > 0 ? 1 : 5 // dirt/dark grass
            else terrain[y][x] = 5 // dark grass
            break
          case 'temple':
            if (n > 0.2) terrain[y][x] = 2 // stone
            else if (n > -0.1) terrain[y][x] = n2 > 0.2 ? 2 : 0 // stone accents
            break
          case 'market':
            // Cobblestone base with stone accents
            // District GROUND cobble (15/16), not street cobble (8/9): a
            // market is paved all over, which is a material, not a road.
            if (n > 0.15) terrain[y][x] = 15 // cobblestone
            else if (n > -0.1) terrain[y][x] = n2 > 0 ? 16 : 15 // dark/light cobble
            break
          case 'artisan':
            // Dirt workshop yards
            if (n > 0.0) terrain[y][x] = 1 // dirt
            else if (n > -0.2) terrain[y][x] = n2 > 0 ? 1 : 0 // dirt/grass
            break
          case 'residential':
            // Grass with occasional dirt strips
            if (n > 0.25 && n2 > 0) terrain[y][x] = 1 // dirt paths
            break
          case 'harbor':
            if (n > 0.1) terrain[y][x] = 15 // district cobble (see market)
            else if (n > -0.15) terrain[y][x] = n2 > 0 ? 4 : 15 // sand/cobble mix
            else terrain[y][x] = 4 // sand
            break
          case 'fortress':
            if (n > -0.1) terrain[y][x] = 2 // stone primarily
            else terrain[y][x] = n2 > 0 ? 2 : 1 // stone/dirt
            break
          case 'cemetery':
            if (n > 0.2) terrain[y][x] = 2 // stone paths
            else terrain[y][x] = 5 // dark grass
            break
        }
      }
    }
  }


  // === PLAZA ===
  // Golden ratio proportions (phi ~= 1.618) with organic asymmetric edges
  private carvePlaza(
    terrain: number[][], cx: number, cy: number, radius: number,
    w: number, h: number, tilePrimary: number,
    /** Stamped true for every tile of the square, so the back-of-block pass
     *  can spare designed public space. Stone and flagstone are also laid
     *  down wholesale by paintDistrictTerrain, so the MATERIAL cannot answer
     *  "is this a square?" — only a record of what was carved can. */
    squareMap?: boolean[][]
  ): void {
    // Aspect ratio. This was the golden ratio, 1.618, which is a lovely number
    // and the wrong one: it makes every square markedly oblong, and it is the
    // MINOR dimension that decides whether a space reads as a square or as a
    // wide spot in the road. Measured, four seeds in five contained no square
    // the audit could find at all — the plazas were 30m by 18m and the 18m was
    // mostly eaten by the rim and by buildings on the long sides.
    //
    // Sitte's proportion rule is about the minor dimension against the height
    // of the facades around it, one to three times; Alexander #61 wants about
    // 20m across for a square people use. 1.3 keeps the ellipse from reading
    // as a circle while leaving the short axis usable.
    const ASPECT = 1.3
    const rX = radius
    const rY = Math.max(3, Math.round(radius / ASPECT))
    // Organic edge noise — multiple harmonics for natural imperfection
    for (let y = cy - rY - 2; y <= cy + rY + 2; y++) {
      for (let x = cx - rX - 2; x <= cx + rX + 2; x++) {
        if (x < 0 || x >= w || y < 0 || y >= h) continue
        const dx = x - cx, dy = y - cy
        const angle = Math.atan2(dy, dx)
        // Normalized elliptical distance
        const ellDist = Math.sqrt((dx / rX) ** 2 + (dy / rY) ** 2)
        // Multi-harmonic edge noise for wabi-sabi imperfection
        const edgeNoise = Math.sin(angle * 3) * 0.12
          + Math.sin(angle * 7 + 1.3) * 0.06
          + Math.sin(angle * 13 + 2.7) * 0.04
        if (ellDist < 1.0 + edgeNoise) {
          if (squareMap) squareMap[y][x] = true
          // ONE MATERIAL PER PLACE. A square has a floor, and the seam belongs
          // at its edge — not scattered through it.
          //
          // This used to lay three zones with `(x + y) % 3` and `(x + y) % 5`
          // alternation, which is a checker pattern at the scale of a bathroom
          // tile and a patchwork at the scale of a town: a tile is 3 METRES, so
          // every "accent" is a 3m square of a different colour dropped at
          // random through the paving. Measured, 40% of all paved-to-paved tile
          // edges in the map changed material, and street-cobble-against-
          // flagstone was 252 of 659 seams. That is the "broken overlapping
          // textures" report — not a texture bug at all, but six near-identical
          // paving ids interleaved at tile granularity.
          //
          // A field and a defined rim instead. Real squares read exactly like
          // this: one surface, with a kerb band that tells you where it ends.
          const RIM = 0.82
          terrain[y][x] = ellDist < RIM
            ? tilePrimary
            : (tilePrimary === 2 ? 14 : 2)
        }
      }
    }
  }

  // === STREET NETWORK ===
  private generateStreetNetwork(
    w: number, h: number,
    center: { x: number; y: number },
    districts: District[],
    complexity: number, density: number,
    rng: () => number, noise: SimplexNoise,
    terrain: number[][], waterMap: boolean[][],
    squareMap: boolean[][]
  ): boolean[][] {
    const roadMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    // Which tier of the hierarchy claimed each tile — the carver's own road
    // width. The painter below used to infer hierarchy from a neighbour count,
    // which is only a proxy for how WIDE the tile's surroundings are; once the
    // swathe narrowing capped every corridor at 3 tiles that proxy collapsed
    // and painted the entire town as dark alley. A boulevard is a boulevard
    // because of what it connects, not because it is fat.
    const tierMap = Array.from({ length: h }, () => Array.from({ length: w }, () => 0))

    // ONE definition of where a square is: the tiles carvePlaza actually
    // painted. Reserve exactly those, so nothing builds on the square and the
    // ring immediately outside it counts as frontage.
    //
    // This used to be a DISC of radius 1-4 stamped near each plaza centre,
    // while the painter drew an ELLIPSE up to 5 x 3 — two numbers for one
    // thing, in two different functions, and a comment here warning the next
    // person to keep them in sync. They were not in sync and could not be:
    // the shapes are different. The outer band of every square was therefore
    // invisible to the placer, which walks ROAD edges to find frontage. So
    // nothing was required to ring a square, and nothing was stopped from
    // building on its edge.
    //
    // Measured, squares came out 29% enclosed against Sitte's ~60% threshold,
    // below which a square stops being a room and becomes a widening in the
    // street. This is the fix for that: a square is a room made of facades,
    // and the placer can only build the room if it can see the walls.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!squareMap[y][x] || waterMap[y][x]) continue
        roadMap[y][x] = true
        tierMap[y][x] = Math.max(tierMap[y][x], 3)
      }
    }

    // BOULEVARDS: Connect main center to each district center
    // Temple and noble districts get grand processional ways (width 5)
    // Others get standard boulevards (width 4)
    for (const d of districts) {
      // Only the ceremonial approaches stay grand. Everything else steps
      // down: the town previously had NO narrow tier at all — every ordinary
      // street was 3 wide and ~25 of them overlapped into open expanses, so
      // 48% of the map was circulation and the streets read as plazas.
      // Widths are TILES, and a tile is 3 metres (renderer3d/scale.ts). The
      // urban-form audit measured 27m facade to facade against 4-10m for a
      // real town, so these were carving 9-12m of carriageway before any
      // setback. A ceremonial approach at 3 tiles is 9m — still grand — and an
      // ordinary boulevard at 2 is 6m, which is a street you can shout across.
      const boulWidth = (d.type === 'temple' || d.type === 'noble') ? 3 : 2
      const curviness = d.type === 'temple' ? 0.05 : 0.1 // Temples get straighter, more formal approaches
      this.carveRoad(roadMap, tierMap, center.x, center.y, d.center.x, d.center.y,
        w, h, boulWidth, curviness, noise, rng, waterMap)
    }

    // MAIN STREETS: Radiate from center with curves (width 3)
    const numMain = Math.floor(5 + complexity * 6)
    for (let i = 0; i < numMain; i++) {
      const angle = (i / numMain) * Math.PI * 2 + (rng() - 0.5) * 0.3
      const length = Math.floor(w * 0.3 + rng() * w * 0.2)
      this.carveOrganicPath(roadMap, tierMap, center.x, center.y, angle,
        w, h, length, 2, 0.15, noise, rng, waterMap)
    }

    // LANES: Connect districts to each other (width 2 — side streets)
    for (let i = 0; i < districts.length; i++) {
      for (let j = i + 1; j < districts.length; j++) {
        const dx = districts[i].center.x - districts[j].center.x
        const dy = districts[i].center.y - districts[j].center.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < Math.min(w, h) * 0.5) {
          this.carveRoad(roadMap, tierMap, districts[i].center.x, districts[i].center.y,
            districts[j].center.x, districts[j].center.y, w, h, 2, 0.2, noise, rng, waterMap)
        }
      }
    }

    // SECONDARY STREETS within districts (width 2) — the bulk of the network
    // Fewer, narrower side streets. 17 random 3-wide scribbles on a 48x48
    // grid merged into open ground; 10 two-wide ones read as lanes between
    // blocks and leave room for buildings to form continuous street walls.
    const numSecondary = Math.floor(5 + complexity * 10)
    for (let i = 0; i < numSecondary; i++) {
      const sx = Math.floor(w * 0.08 + rng() * w * 0.84)
      const sy = Math.floor(h * 0.08 + rng() * h * 0.84)
      if (waterMap[sy]?.[sx]) continue
      const angle = rng() * Math.PI * 2
      this.carveOrganicPath(roadMap, tierMap, sx, sy, angle,
        w, h, Math.floor(6 + rng() * 12), 2, 0.25, noise, rng, waterMap)
    }

    // ALLEYS branching off roads (width 1 — squeeze-through back lanes)
    if (complexity > 0.2) {
      const numAlleys = Math.floor(8 + complexity * 18)
      for (let i = 0; i < numAlleys; i++) {
        const bx = Math.floor(rng() * w)
        const by = Math.floor(rng() * h)
        if (bx >= 0 && bx < w && by >= 0 && by < h && roadMap[by][bx]) {
          const angle = rng() * Math.PI * 2
          this.carveOrganicPath(roadMap, tierMap, bx, by, angle,
            w, h, Math.floor(3 + rng() * 5), 1, 0.35, noise, rng, waterMap)
        }
      }
    }

    // Carve market squares — rectangular open areas in market districts.
    // Painted as plaza flagstone, not left for the road painter to claim: a
    // market square IS a square, and the difference is load-bearing. Tile 14
    // is paving rather than circulation, so the placement audit stops calling
    // a stall on the square "a building blocking a street", and the swathe
    // narrowing below leaves it alone instead of eroding it into a lane.
    for (const d of districts) {
      if (d.type !== 'market') continue
      const sqSize = 4 + Math.floor(rng() * 3) // 4-6 tiles wide
      const sqX = d.center.x - Math.floor(sqSize / 2)
      const sqY = d.center.y - Math.floor(sqSize / 2)
      for (let dy = 0; dy < sqSize; dy++) {
        for (let dx = 0; dx < sqSize; dx++) {
          const px = sqX + dx, py = sqY + dy
          if (px >= 0 && px < w && py >= 0 && py < h && !waterMap[py][px]) {
            roadMap[py][px] = true
            terrain[py][px] = 14
            squareMap[py][px] = true
          }
        }
      }
    }

    this.carveQuays(roadMap, tierMap, terrain, waterMap, w, h, center)

    this.narrowRoadSwathes(roadMap, terrain, w, h, squareMap)

    // Paint road tiles onto terrain, as street cobble (8, warm orange-grey) or
    // alley (9, dark brown), from the tier the CARVER recorded.
    //
    // This used to count road neighbours in the 3x3 and call anything with
    // fewer than 7 an alley. That is not a hierarchy, it is a width
    // measurement wearing one: it happened to agree while ordinary streets
    // were 3 tiles and merged into open ground, and it collapsed the moment
    // the swathe narrowing capped corridors at 3 — a 2-wide street has 6
    // neighbours, so the whole town painted as dark alley in one step.
    //
    // Designed squares are left alone. The main plaza is carved as stone and
    // district plazas as flagstone, and both are inside a marked circle, so
    // this loop was repainting every square as street: a public square that
    // renders as carriageway, with the placement audit then reading a stall on
    // it as a building blocking a street. Ids 14/15/16 exist precisely to
    // record that a tile is paved but not circulation (see core/terrain.ts).
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!roadMap[y][x] || waterMap[y][x]) continue
        if (terrain[y][x] === 2 || terrain[y][x] === 14) continue
        terrain[y][x] = tierMap[y][x] >= 2 ? 8 : 9
      }
    }

    return roadMap
  }

  /**
   * Give the river a bank the town can stand on.
   *
   * The water is generated from noise before districts, roads or buildings
   * exist, and nothing downstream ever reads it — so it is a ribbon that
   * happens to cross the map rather than a reason the town is where it is.
   * That is the "scattered buildings and rivers" report stated as a fact about
   * the pipeline.
   *
   * Measured: of every dry tile touching water, 7% carried a building and 19%
   * were walkable at all. Against 73% frontage occupancy on the streets, the
   * bank is empty ground. And of the buildings that did touch water, 72% had
   * their street on the DRY side, which means they faced the lane and turned
   * their back to the river.
   *
   * Lynch's EDGE only works when it is legible from inside, and the way a real
   * town makes a river legible is a QUAY: a hard walkable edge running along
   * the water. Laying one does two things for the price of one, because the
   * building placer walks road edges — give the bank a lane and the lane grows
   * a frontage, without touching the placer at all.
   *
   * Only inside the town. A quay round every pond in the countryside is a
   * ring road round a puddle; the bank out there should stay a bank.
   */
  /**
   * QUAY WALLS — where the town meets the river, the bank is BUILT.
   *
   * Reported: "the slope may work on the outskirts, but when it gets into the
   * city I expect it to be built out like the rest of the town." That is
   * correct and it is the same principle as the precinct wall: a graded earth
   * bank is a RURAL riverbank, and a town makes a hard edge. Paris quais,
   * Amsterdam grachten, York staithes — vertical masonry with the water at its
   * foot, not a lawn running into the shallows.
   *
   * carveRiverBed grades every bank identically over SKIRT tiles, because at
   * that point in generation there is no town yet to know about. This runs
   * after the street network, which is the first moment anything knows where
   * the town actually reached: carveQuays marks quay tiles into roadMap, so a
   * road tile touching water IS the urban bank, and everything else stays the
   * slope it was.
   *
   * Two properties a wall needs and a slope does not:
   *   LEVEL — the quay top is flat, at one height along its run, so it reads
   *     as a built surface rather than a ramp that happens to be paved.
   *   SHARP — nothing between the quay top and the bed. The drop is the wall.
   *
   * The height is measured from the WATERLINE rather than from the existing
   * ground, because that is what makes it a consistent parapet along the whole
   * run instead of following the hill behind it.
   */
  private buildQuayWalls(
    w: number, h: number, roadMap: boolean[][], waterMap: boolean[][],
    heightMap: number[][], waterLevel: number[][]
  ): void {
    // 0.8 raw is ~1.45m of wall above the water — chest height from a boat,
    // knee-to-waist from the quay side once the coping is on. Tall enough to
    // read as masonry and low enough that the town does not lose its river.
    const QUAY = 0.8
    const level = (x: number, y: number): number | null => {
      let best: number | null = null
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy
          if (!waterMap[ny]?.[nx]) continue
          const raw = waterLevel[ny]?.[nx]
          if (raw === undefined || Number.isNaN(raw)) continue
          if (best === null || raw < best) best = raw
        }
      }
      return best
    }
    // Pass 1: the tiles that actually front the water.
    const front: { x: number; y: number; top: number }[] = []
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (waterMap[y][x] || !roadMap[y][x]) continue
        let touches = false
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (waterMap[y + dy]?.[x + dx]) { touches = true; break }
        }
        if (!touches) continue
        const wl = level(x, y)
        if (wl === null) continue
        front.push({ x, y, top: wl + QUAY })
      }
    }
    for (const f of front) heightMap[f.y][f.x] = f.top
    // Pass 2: one tile back, blended, so the quay is a flat apron rather than
    // a kerb with the old slope still rising behind it.
    for (const f of front) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = f.x + dx, ny = f.y + dy
        if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue
        if (waterMap[ny][nx]) continue
        if (front.some((o) => o.x === nx && o.y === ny)) continue
        heightMap[ny][nx] = heightMap[ny][nx] * 0.35 + f.top * 0.65
      }
    }
  }

  /**
   * OPEN A ROOM IN THE SQUARE — Sitte's rule, which this generator cites and
   * has never obeyed.
   *
   * The main streets all radiate from the town centre, so within a few tiles
   * of it they overlap into one solid mass of carriageway. The square that
   * `carvePlaza` paves there is therefore not a room, it is a junction with
   * flagstones. Measured consequence: `placePlazaFeatures` could not find a
   * free 3x3 anywhere inside the plaza radius, so the fountain placed ZERO
   * times in every town this project has ever generated, and searching wider
   * only put it 12-15 tiles away in a random back lot.
   *
   * Sitte's actual prescription is that streets should enter a square at its
   * CORNERS and not run across it. This erodes carriageway out of the middle
   * of the square, using the same simple-point criterion as
   * `narrowRoadSwathes` — a tile whose road neighbours form exactly one
   * connected run can be removed without disconnecting anything or opening a
   * hole, and the test is re-run against the LIVE map between removals
   * because two tiles can each be individually removable and jointly cut the
   * network. The paving stays; only the carriageway goes.
   */
  private openSquareRooms(
    w: number, h: number, roadMap: boolean[][], squareMap: boolean[][],
    terrain: number[][], center: { x: number; y: number }, plazaRadius: number
  ): void {
    // The room is the inner part of the square; the outer ring stays
    // carriageway so the streets still reach it and run AROUND it, which is
    // both how traffic works and what keeps the network joined.
    const inner = Math.max(2, plazaRadius * 0.62)
    const room: { x: number; y: number }[] = []
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!roadMap[y][x]) continue
        if (squareMap && !squareMap[y][x]) continue
        if (Math.hypot(x - center.x, y - center.y) > inner) continue
        room.push({ x, y })
      }
    }
    if (room.length === 0) { rejected('plaza~roomEmpty'); return }

    // Count connected road components, so the removal can be TESTED rather
    // than argued about.
    const components = (): number => {
      const seen = Array.from({ length: h }, () => new Uint8Array(w))
      let n = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!roadMap[y][x] || seen[y][x]) continue
          n++
          const q: [number, number][] = [[x, y]]
          seen[y][x] = 1
          for (let i = 0; i < q.length; i++) {
            const [cx, cy] = q[i]
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const nx = cx + dx, ny = cy + dy
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
              if (!roadMap[ny][nx] || seen[ny][nx]) continue
              seen[ny][nx] = 1
              q.push([nx, ny])
            }
          }
        }
      }
      return n
    }

    // A SIMPLE POINT CANNOT MAKE A HOLE — that is its guarantee, and a square
    // IS a hole, so the criterion narrowRoadSwathes uses is the wrong tool
    // here. It removed exactly one tile. Cut the whole room instead and then
    // TEST connectivity, restoring if it broke: the ring of carriageway left
    // around the room is what carries the spokes past each other, so in
    // practice it holds, but "in practice" is not a guarantee and the check
    // costs one flood fill.
    const before = components()
    for (const t of room) roadMap[t.y][t.x] = false
    if (components() > before) {
      for (const t of room) roadMap[t.y][t.x] = true
      rejected('plaza~roomWouldSever')
      return
    }
    // Leave the flagstones: a square is paved, it just is not a road.
    for (const t of room) {
      if (terrain[t.y][t.x] === 8 || terrain[t.y][t.x] === 9) terrain[t.y][t.x] = 14
    }
    rejected(`plaza~roomTiles${room.length}`)
  }

  private carveQuays(
    roadMap: boolean[][], tierMap: number[][], terrain: number[][],
    waterMap: boolean[][], w: number, h: number,
    center: { x: number; y: number }
  ): void {
    const maxDist = Math.sqrt(w * w + h * h) / 2
    /** How far out of town a quay is still a quay rather than a towpath. */
    const REACH = maxDist * 0.72
    const isWet = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < w && y < h && waterMap[y][x]
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (waterMap[y][x] || roadMap[y][x]) continue
        // Designed squares keep their own floor; a square that runs down to
        // the water is a harbour piazza and wants no lane painted through it.
        if (terrain[y][x] === 2 || terrain[y][x] === 14) continue
        if (Math.hypot(x - center.x, y - center.y) > REACH) continue
        // A QUAY EXISTS BECAUSE A STREET SERVES IT. Without this the pass
        // paved every bank tile inside REACH, which is essentially the whole
        // urban river: measured, 59 of 62 free bank tiles came out paved and
        // the waterfront's entire soft-bank vocabulary — reeds, stones —
        // fired three times in three towns. A river that is quay from end to
        // end is uniform, and uniform is what reads as underdeveloped.
        // Gating on a nearby street gives working stretches where the town
        // meets the water and muddy ones between, which is both how it
        // happens and the variation Cullen's serial vision wants along a walk.
        let servedByRoad = false
        for (let dy = -3; dy <= 3 && !servedByRoad; dy++) {
          for (let dx = -3; dx <= 3; dx++) {
            if (roadMap[y + dy]?.[x + dx]) { servedByRoad = true; break }
          }
        }
        if (!servedByRoad) continue
        let wet = 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (isWet(x + dx, y + dy)) wet++
        }
        if (wet === 0) continue
        // A tile with water on three sides is a spit or a stepping stone, not
        // a bank — quaying it produces a pier to nowhere.
        if (wet >= 3) continue
        // There has to be somewhere for the quay's buildings to stand. A
        // one-tile shelf between the river and a cliff of other water is a
        // towpath at best, and putting a street on it strands the street.
        let dryBehind = 0
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            if (!waterMap[ny][nx]) dryBehind++
          }
        }
        if (dryBehind < 14) continue
        roadMap[y][x] = true
        // Tier 2: a quay is a working street, so it paves as cobble rather
        // than as a back alley.
        tierMap[y][x] = Math.max(tierMap[y][x], 2)
      }
    }
  }

  /**
   * Erode road tiles that nobody drew.
   *
   * Every tier of the carver is narrow — a ceremonial approach is 3 tiles, an
   * ordinary boulevard 2, an alley 1. Measured, the network is nothing like
   * that: 58% of road tiles sat in a corridor wider than 3 tiles, the widest
   * ran 33 tiles across, and ONE connected road component covered a quarter of
   * the map. No single carve did that. Nine main streets radiate from the same
   * point, ~12 secondary streets are dropped at random angles across the same
   * 48x48 grid, and every district centre gets a disc of road on top. Each is
   * narrow; their UNION is a lake.
   *
   * That lake is what "random scatter across big open spaces" actually is. The
   * buildings are not scattered — 91% of them share a party wall — they are
   * lining the shore of a puddle that covers a quarter of the town. Narrowing
   * the carver cannot fix it, because the carver was never the thing that drew
   * it; that was tried and moved facade-to-facade width 27m to 24m.
   *
   * So take the land back. Erode any road tile in an over-wide corridor from
   * the swathe boundary inward, and stop at the authorised width. Two guards
   * keep it honest:
   *
   *   - PLAZAS ARE SPARED. A tile already painted as stone or flagstone is a
   *     square somebody designed. Squares are supposed to be open, and the
   *     point of this pass is to tell a square apart from a puddle.
   *   - ONLY SIMPLE POINTS ARE REMOVED. A tile is removable when the road in
   *     its 8-neighbourhood forms exactly one connected run, which is the
   *     standard 2D thinning criterion: removing such a tile provably cannot
   *     disconnect the network or open a hole. Without it, erosion severs the
   *     street network and the town becomes unwalkable.
   *
   * Freed tiles simply stop being road. Their terrain was already painted by
   * the base/district pass and the road painter runs after this, so they
   * revert to ordinary ground and the building placer — which walks road
   * edges — sees new frontage exactly where the shoreline used to be.
   */
  private narrowRoadSwathes(
    roadMap: boolean[][], terrain: number[][], w: number, h: number,
    /** The designed squares. Asking the MATERIAL "is this a square?" was
     *  wrong for the same reason it was wrong in dressEmptyStreets: stone
     *  (id 2) is a designed square AND the ground of every temple and noble
     *  quarter, so an entire district was being spared from erosion and its
     *  over-wide approaches never narrowed. Only the plan knows. */
    squareMap: boolean[][]
  ): void {
    /** Widest corridor any carver tier is allowed to draw, in tiles. */
    const MAX_CORRIDOR = 3
    const isRoad = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < w && y < h && roadMap[y][x]
    const isSquare = (x: number, y: number): boolean => !!squareMap[y]?.[x]
    /** Contiguous road extent through this tile; the smaller axis is width. */
    const corridorWidth = (x: number, y: number): number => {
      const run = (dx: number, dy: number): number => {
        let n = 1
        for (let k = 1; k <= 48 && isRoad(x + dx * k, y + dy * k); k++) n++
        for (let k = 1; k <= 48 && isRoad(x - dx * k, y - dy * k); k++) n++
        return n
      }
      return Math.min(run(1, 0), run(0, 1))
    }
    // Neighbours in circular order. The number of non-road -> road transitions
    // around this ring equals the number of 8-connected road components
    // touching the tile, so 1 means removing it leaves them all joined.
    const RING: ReadonlyArray<readonly [number, number]> = [
      [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
    ]
    const isSimplePoint = (x: number, y: number): boolean => {
      let transitions = 0
      for (let i = 0; i < RING.length; i++) {
        const [ax, ay] = RING[i]
        const [bx, by] = RING[(i + 1) % RING.length]
        if (!isRoad(x + ax, y + ay) && isRoad(x + bx, y + by)) transitions++
      }
      return transitions === 1
    }

    // Boundary-inward erosion. Each pass strips one layer off every over-wide
    // swathe, so the widest (33 tiles) needs ~15; the cap is a runaway guard,
    // and the pass stops early as soon as a sweep changes nothing.
    for (let pass = 0; pass < 24; pass++) {
      const doomed: Array<[number, number]> = []
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if (!roadMap[y][x] || isSquare(x, y)) continue
          // Only the shoreline erodes; interior tiles wait their turn.
          let onEdge = false
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            if (!isRoad(x + dx, y + dy)) { onEdge = true; break }
          }
          if (!onEdge) continue
          if (corridorWidth(x, y) <= MAX_CORRIDOR) continue
          doomed.push([x, y])
        }
      }
      if (doomed.length === 0) break
      // Re-test connectivity against the LIVE map, not the snapshot: two
      // neighbours can each be individually removable and jointly cut the
      // street. Removing one at a time and re-asking is what makes that safe.
      let removed = 0
      for (const [x, y] of doomed) {
        if (!roadMap[y][x]) continue
        if (corridorWidth(x, y) <= MAX_CORRIDOR) continue
        if (!isSimplePoint(x, y)) continue
        roadMap[y][x] = false
        removed++
      }
      if (removed === 0) break
    }
  }

  private markCircle(
    map: boolean[][], cx: number, cy: number, r: number, w: number, h: number,
    tierMap?: number[][], tier = 0
  ): void {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x >= 0 && x < w && y >= 0 && y < h) {
          if (Math.sqrt((x - cx) ** 2 + (y - cy) ** 2) < r + 0.5) {
            map[y][x] = true
            if (tierMap) tierMap[y][x] = Math.max(tierMap[y][x], tier)
          }
        }
      }
    }
  }

  // Carve a road between two points with noise-driven curves.
  // `tierMap` records the widest tier that claimed each tile, so the painter
  // downstream can tell a boulevard from an alley. It replaces a `terrain`
  // parameter that was threaded through both carvers and never read.
  private carveRoad(
    roadMap: boolean[][], tierMap: number[][],
    x1: number, y1: number, x2: number, y2: number,
    w: number, h: number, roadWidth: number, curviness: number,
    noise: SimplexNoise, rng: () => number, waterMap: boolean[][]
  ): void {
    const dx = x2 - x1, dy = y2 - y1
    const dist = Math.sqrt(dx * dx + dy * dy)
    const steps = Math.ceil(dist * 1.5)
    const baseAngle = Math.atan2(dy, dx)

    let x = x1, y = y1
    let angle = baseAngle

    for (let step = 0; step < steps; step++) {
      // Carve tiles
      for (let cw = 0; cw < roadWidth; cw++) {
        for (let ch = 0; ch < roadWidth; ch++) {
          const rx = Math.floor(x) + cw - Math.floor(roadWidth / 2)
          const ry = Math.floor(y) + ch - Math.floor(roadWidth / 2)
          if (rx >= 0 && rx < w && ry >= 0 && ry < h && !waterMap[ry][rx]) {
            roadMap[ry][rx] = true
            tierMap[ry][rx] = Math.max(tierMap[ry][rx], roadWidth)
          }
        }
      }

      // Pull back toward target
      const toTarget = Math.atan2(y2 - y, x2 - x)
      const nv = noise.noise2D(x * 0.1, y * 0.1)
      angle = angle * 0.3 + toTarget * 0.5 + nv * curviness + (rng() - 0.5) * curviness * 0.3

      x += Math.cos(angle) * 1.2
      y += Math.sin(angle) * 1.2

      // Check if we reached the target
      if (Math.abs(x - x2) < 2 && Math.abs(y - y2) < 2) break
      if (x < 0 || x >= w || y < 0 || y >= h) break
    }
  }

  // Carve a single organic path
  private carveOrganicPath(
    roadMap: boolean[][], tierMap: number[][],
    startX: number, startY: number, angle: number,
    w: number, h: number, length: number, roadWidth: number, curviness: number,
    noise: SimplexNoise, rng: () => number, waterMap: boolean[][]
  ): void {
    let x = startX, y = startY, dir = angle
    for (let step = 0; step < length; step++) {
      for (let dy = 0; dy < roadWidth; dy++) {
        for (let dx = 0; dx < roadWidth; dx++) {
          const rx = Math.floor(x) + dx
          const ry = Math.floor(y) + dy
          if (rx >= 0 && rx < w && ry >= 0 && ry < h && !waterMap[ry][rx]) {
            roadMap[ry][rx] = true
            tierMap[ry][rx] = Math.max(tierMap[ry][rx], roadWidth)
          }
        }
      }
      const nv = noise.noise2D(x * 0.1, y * 0.1)
      dir += nv * curviness + (rng() - 0.5) * curviness * 0.5
      x += Math.cos(dir) * 1.2
      y += Math.sin(dir) * 1.2
      if (x < 1 || x >= w - 1 || y < 1 || y >= h - 1) break
    }
  }


  // === BRIDGES ===
  /**
   * GUARANTEE YOU CAN WALK ACROSS. An invariant, not a tendency.
   *
   * Making the river continuous fixed one complaint and created another. The
   * old channel came out as ~3.4 disconnected puddles, so you could stroll
   * between them; one real river edge-to-edge severs the town unless it is
   * bridged, and `placeBridges` only ever looks for a road running EAST into
   * water within four tiles. Measured after the carve: seed 777 had 592 tiles
   * — 28% of the town — unreachable, and seed 11 had 195 with no bridge at all.
   *
   * So: find the walkable components, and for every worthwhile island lay a
   * deck of `footbridge` tiles along the shortest water crossing back to the
   * mainland. BFS over WATER from the island's shore reaches the nearest point
   * on the far bank by construction, so the crossing is always the narrowest
   * one available rather than wherever a road happened to point.
   */
  private ensureRiverCrossings(
    w: number, h: number, waterMap: boolean[][],
    existing: PlacedObject[], heightMap: number[][]
  ): PlacedObject[] {
    const MIN_ISLAND = 25          // below this it is a rock, not a district
    const out: PlacedObject[] = []
    // Tiles already crossable: water carrying something tagged passage.
    const deck = Array.from({ length: h }, () => new Uint8Array(w))
    for (const o of existing) {
      if (!/bridge/.test(o.definitionId)) continue
      const fp = o.footprint ?? this.getFootprint(o.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const x = o.x + dx, y = o.y + dy
          if (x >= 0 && y >= 0 && x < w && y < h) deck[y][x] = 1
        }
      }
    }
    const walkable = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < w && y < h && (!waterMap[y][x] || deck[y][x] === 1)

    for (let guard = 0; guard < 8; guard++) {
      // --- components -------------------------------------------------
      const comp = Array.from({ length: h }, () => new Int16Array(w).fill(-1))
      const sizes: number[] = []
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!walkable(x, y) || comp[y][x] >= 0) continue
          const id = sizes.length
          let n = 0
          const q: [number, number][] = [[x, y]]
          comp[y][x] = id
          for (let i = 0; i < q.length; i++) {
            const [cx, cy] = q[i]; n++
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const nx = cx + dx, ny = cy + dy
              if (!walkable(nx, ny) || comp[ny][nx] >= 0) continue
              comp[ny][nx] = id
              q.push([nx, ny])
            }
          }
          sizes.push(n)
        }
      }
      if (sizes.length < 2) break
      const mainId = sizes.indexOf(Math.max(...sizes))
      let islandId = -1
      for (let i = 0; i < sizes.length; i++) {
        if (i !== mainId && sizes[i] >= MIN_ISLAND) { islandId = i; break }
      }
      if (islandId < 0) break

      // --- shortest water crossing island -> mainland ------------------
      const prev = new Int32Array(w * h).fill(-1)
      const seen = new Uint8Array(w * h)
      const q: number[] = []
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (comp[y][x] !== islandId) continue
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nx = x + dx, ny = y + dy
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
            if (!waterMap[ny][nx] || seen[ny * w + nx]) continue
            seen[ny * w + nx] = 1
            q.push(ny * w + nx)
          }
        }
      }
      let landing = -1
      for (let i = 0; i < q.length && landing < 0; i++) {
        const cur = q[i], cx = cur % w, cy = Math.floor(cur / w)
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = cx + dx, ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          if (comp[ny][nx] === mainId) { landing = cur; break }
          if (!waterMap[ny][nx] || seen[ny * w + nx]) continue
          seen[ny * w + nx] = 1
          prev[ny * w + nx] = cur
          q.push(ny * w + nx)
        }
      }
      // No water route means the island is cut off by something other than
      // the river, which a bridge cannot help. Stop rather than loop.
      if (landing < 0) break

      for (let p = landing; p !== -1; p = prev[p]) {
        const x = p % w, y = Math.floor(p / w)
        if (deck[y][x]) continue
        deck[y][x] = 1
        out.push({
          id: uuid(),
          definitionId: 'footbridge',
          x, y,
          rotation: 0, scaleX: 1, scaleY: 1,
          elevation: Math.min(Math.round((heightMap[y]?.[x] ?? 0) * 2) / 2, 2),
          footprint: { w: 1, h: 1 },
          properties: { crossing: true },
        })
      }
    }
    return out
  }

  /**
   * DRESS THE WATERFRONT — give the bank a vocabulary of its own.
   *
   * Measured before this existed: 202 objects stood within two tiles of water
   * across three towns, and they were lampposts (19), trees (17), crates (15)
   * and bushes (15). The river was dressed with the same street furniture as
   * every other street. Meanwhile `dock`, `pier`, `crane` and `fishing_boat`
   * are all defined, all have finished geometry in PropFactory, and placed
   * ZERO objects at the water — and `rowboat`, `skiff`, `boulder`, `rock`,
   * `rocky_outcrop` and `port_crane` had geometry the store never defined at
   * all, so they were unreachable.
   *
   * The bank is not one place, so it does not get one palette:
   *
   *   WHARF — bank in the built town, on paving or beside buildings. Working
   *     riverside: mooring posts, crates and barrels landed off a boat, fish
   *     racks, rope, a crane where the quay is wide. Boats moored ON the
   *     water against it.
   *   SHORE — bank outside the town. Reeds at the waterline, stones, the odd
   *     willow. Nothing built, because nobody built there.
   *
   * Everything is placed by asking the water WHICH WAY IT IS, so a mooring
   * post stands at the lip and a reed clump stands in the shallows rather
   * than both landing wherever the global spacing metric had a gap.
   */
  private dressWaterfront(
    w: number, h: number, terrain: number[][], waterMap: boolean[][],
    placed: PlacedObject[], structures: PlacedObject[],
    heightMap: number[][], rng: () => number
  ): PlacedObject[] {
    const out: PlacedObject[] = []
    const taken = new Set<string>()
    for (const o of placed) {
      const fp = o.footprint ?? this.getFootprint(o.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) taken.add(`${o.x + dx},${o.y + dy}`)
      }
    }
    const free = (x: number, y: number): boolean =>
      x > 0 && y > 0 && x < w - 1 && y < h - 1 &&
      !waterMap[y][x] && !taken.has(`${x},${y}`)

    // A bank tile counts as WHARF if the town has reached it — paving under
    // foot, or a building within two tiles. Otherwise it is open shore.
    // STRUCTURES only. Built from `placed` — which is every object including
    // scattered props — this halo covered nearly the whole map, every bank
    // tile classified as wharf, and the entire SHORE palette (reeds, stones)
    // fired zero times in three towns. "Has the town reached here" is a
    // question about buildings.
    const built = new Set<string>()
    for (const o of structures) {
      const fp = o.footprint ?? this.getFootprint(o.definitionId)
      for (let dy = -2; dy < fp.h + 2; dy++) {
        for (let dx = -2; dx < fp.w + 2; dx++) built.add(`${o.x + dx},${o.y + dy}`)
      }
    }
    const paved = (x: number, y: number): boolean => {
      const t = terrain[y]?.[x]
      return t === 8 || t === 9 || t === 14 || t === 15 || t === 16
    }

    const WHARF = ['mooring_ring', 'crate', 'barrel', 'rope_coil', 'fish_rack',
      'crate_stack', 'barrel_stack', 'rope_coil', 'mooring_ring']
    const SHORE = ['reeds', 'reeds', 'reeds', 'rock', 'boulder', 'bush',
      'rocky_outcrop', 'reeds']
    let boats = 0, cranes = 0, steps = 0, jetties = 0

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!waterMap[y][x]) {
          let t2 = 0
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            if (waterMap[y + dy]?.[x + dx]) t2++
          }
          if (t2 > 0) rejected(free(x, y) ? 'wf~bankFree' : 'wf~bankOccupied')
        }
        if (!free(x, y)) continue
        // Which way is the water, and how far? A quay is a BAND, not a line:
        // dressing only the row that touches the water left a four-tile apron
        // of bare paving behind it, which is what the wharf still read as
        // empty. The second row gets the same vocabulary at lower density —
        // goods land where they were unloaded and get stacked back from the
        // edge, not balanced on the lip.
        let wx = 0, wz = 0, touching = 0, ring = 0
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (waterMap[y + dy]?.[x + dx]) { wx += dx; wz += dy; touching++ }
        }
        if (touching > 0) ring = 1
        else {
          for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2],
            [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
            if (waterMap[y + dy]?.[x + dx]) { wx += Math.sign(dx); wz += Math.sign(dy); ring = 2; break }
          }
        }
        if (ring === 0) continue
        // PAVED, not merely "near a building". The river runs through the
        // town on a 48x48 map, so every one of its 62 free bank tiles was
        // within two tiles of something built and the shore palette fired
        // zero times. A quay is a quay because someone laid stone on it; the
        // stretches between the quays are soft, muddy and reedy, and those
        // are most of the bank even in a town.
        const isWharf = paved(x, y)
        rejected(isWharf ? 'wf~wharfTile' : 'wf~shoreTile')

        // Density: a working quay is busy, an open shore is not.
        // A working quay is BUSY — that is what makes it read as working. The
        // first pass at 0.34 left long bare stretches between the goods, which
        // is the sparseness the whole complaint was about. The shore stays
        // thinner, because nobody is stacking barrels on a mudbank.
        const dens = (isWharf ? 0.58 : 0.46) * (ring === 1 ? 1 : 0.55)
        if (rng() > dens) {
          rejected(isWharf ? 'wf~wharfDice' : 'wf~shoreDice')
          continue
        }

        const pool = isWharf ? WHARF : SHORE
        let id = pool[Math.floor(rng() * pool.length)]

        // A crane belongs where a quay is wide enough to swing one, and one
        // or two per town is plenty — it is a landmark, not clutter.
        if (isWharf && cranes < 2 && rng() < 0.10 &&
            free(x + 1, y) && free(x, y + 1) && free(x + 1, y + 1)) {
          out.push(this.createObj('port_crane', x, y,
            Math.min(Math.round((heightMap[y]?.[x] ?? 0) * 2) / 2, 2)))
          taken.add(`${x},${y}`); taken.add(`${x + 1},${y}`)
          taken.add(`${x},${y + 1}`); taken.add(`${x + 1},${y + 1}`)
          cranes++
          continue
        }

        // STEPS DOWN THE WALL, on the row that actually fronts the water.
        // Only meaningful against a built quay — a flight of stone into a mud
        // slope is nothing — so it is gated on the same wharf test that
        // buildQuayWalls uses to decide where to build the wall at all.
        if (isWharf && ring === 1 && steps < 4 && rng() < 0.14) {
          out.push(this.createObj('water_steps', x, y,
            Math.min(Math.round((heightMap[y]?.[x] ?? 0) * 2) / 2, 2)))
          taken.add(`${x},${y}`)
          steps++
          continue
        }
        // A JETTY reaching out over the water. `pier` and `dock` were both
        // defined with finished geometry and placed nowhere; a wharf with a
        // hard edge is exactly what they hang off.
        if (isWharf && ring === 1 && jetties < 3 && rng() < 0.12) {
          const len = 3
          let clear = true
          for (let k = 1; k <= len; k++) {
            if (!waterMap[y + wz * k]?.[x + wx * k] ||
                taken.has(`${x + wx * k},${y + wz * k}`)) { clear = false; break }
          }
          if (clear) {
            const jx = x + wx, jy = y + wz
            out.push(this.createObj(rng() < 0.5 ? 'pier' : 'dock', jx, jy,
              Math.min(Math.round((heightMap[y]?.[x] ?? 0) * 2) / 2, 2)))
            for (let k = 0; k < len; k++) taken.add(`${x + wx * (k + 1)},${y + wz * (k + 1)}`)
            jetties++
            continue
          }
        }

        out.push(this.createObj(id, x, y,
          Math.min(Math.round((heightMap[y]?.[x] ?? 0) * 2) / 2, 2)))
        taken.add(`${x},${y}`)

        // MOOR A BOAT against a wharf, on the water itself. This is the one
        // thing that says "river" rather than "canal-shaped hole", and the
        // boat builder has been in PropFactory the whole time with nothing
        // ever asking for it.
        if (isWharf && ring === 1 && boats < 6 && rng() < 0.30) {
          const bx = x + wx, by = y + wz
          if (waterMap[by]?.[bx] && !taken.has(`${bx},${by}`) &&
              waterMap[by + wz]?.[bx + wx]) {
            const kind = rng() < 0.45 ? 'rowboat' : (rng() < 0.6 ? 'skiff' : 'fishing_boat')
            out.push(this.createObj(kind, bx, by,
              Math.min(Math.round((heightMap[by]?.[bx] ?? 0) * 2) / 2, 2)))
            taken.add(`${bx},${by}`)
            boats++
          }
        }
      }
    }
    return out
  }

  /**
   * BRIDGES THAT REACH THE OTHER SIDE.
   *
   * The old version laid a fixed 4x2 deck wherever water appeared within four
   * tiles AHEAD of a road tile. It never asked whether four tiles was enough.
   * Measured: **0.3 of 5.8 bridges a town actually landed on the far bank** —
   * 4.5 stopped in open water and 1.0 touched no water at all. Photographed,
   * they are planks jutting off one bank into the middle of the river, and
   * that is what "there are essentially no bridges" meant. The COUNT was
   * always healthy, which is why nothing caught it: a count is not a crossing.
   *
   * Now the span is measured. Stand on a bank tile, look across, and lay a
   * deck exactly long enough to land on the far side — land, the whole run of
   * water, land. If the channel is wider than MAX_SPAN the crossing wants a
   * causeway rather than a bridge, so nothing is placed and the connectivity
   * pass (ensureRiverCrossings) picks it up.
   *
   * The per-instance length rides on `PlacedObject.footprint`, which is
   * exactly what that refactor was for: BuildingFactory, the massing
   * template, the collision mask and the audit all read `footprintOf`, so a
   * 7x2 bridge needs no special case anywhere downstream.
   */
  private placeBridges(
    w: number, h: number, roadMap: boolean[][], waterMap: boolean[][], rng: () => number
  ): PlacedObject[] {
    const bridges: PlacedObject[] = []
    const taken = new Set<string>()
    /** Perpendicular width of the deck — a cart and a person passing. */
    const DECK_W = 2
    /** Beyond this the water wants a causeway, not a span. */
    const MAX_WATER = 8
    const inB = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h
    const dry = (x: number, y: number) => inB(x, y) && !waterMap[y][x]

    const reserve = (ox: number, oy: number, fw: number, fh: number): boolean => {
      for (let dy = 0; dy < fh; dy++) {
        for (let dx = 0; dx < fw; dx++) {
          if (!inB(ox + dx, oy + dy)) return false
          if (taken.has(`${ox + dx},${oy + dy}`)) return false
        }
      }
      for (let dy = 0; dy < fh; dy++) {
        for (let dx = 0; dx < fw; dx++) taken.add(`${ox + dx},${oy + dy}`)
      }
      return true
    }

    // Step by ONE. The first cut of this stepped by two on both axes, which
    // silently discards three quarters of the bank: a crossing only exists
    // where a road meets the water, those are rare, and skipping every other
    // tile took a town from thirteen bridges to one. The `reserve` call below
    // is what stops a bridge on every tile of a quay, not the loop stride.
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!roadMap[y][x] || waterMap[y][x]) continue
        for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
          // Water must start immediately: this tile is the bank, not a tile
          // that happens to have a river somewhere in front of it.
          if (!inB(x + dx, y + dy) || !waterMap[y + dy][x + dx]) continue
          // How wide is the water?
          let n = 0
          while (n < MAX_WATER &&
                 inB(x + dx * (n + 1), y + dy * (n + 1)) &&
                 waterMap[y + dy * (n + 1)][x + dx * (n + 1)]) n++
          const farX = x + dx * (n + 1), farY = y + dy * (n + 1)
          // Still wet at the budget's end means we never found the far bank.
          if (!dry(farX, farY)) { rejected('~bridgeTooWide'); continue }
          // Deck runs from this bank tile to the far bank tile inclusive.
          const len = n + 2
          const alongX = dx === 1
          const fw = alongX ? len : DECK_W
          const fh = alongX ? DECK_W : len
          // The second row of the deck has to land on something at BOTH ends,
          // or half the bridge finishes over water.
          const sx = alongX ? 0 : 1, sy = alongX ? 1 : 0
          if (!dry(x + sx, y + sy) || !dry(farX + sx, farY + sy)) { rejected('~bridgeSecondRow'); continue }
          // Keep them apart: a quay road runs ALONG the water, so without a
          // spacing rule every tile of it would look across and qualify.
          if (bridges.some((b) => Math.abs(b.x - x) + Math.abs(b.y - y) < 7)) {
            rejected('~bridgeTooClose'); continue
          }
          if (!reserve(x, y, fw, fh)) { rejected('~bridgeTaken'); continue }
          const obj = this.createObj('bridge', x, y)
          obj.footprint = { w: fw, h: fh }
          bridges.push(obj)
          break
        }
      }
    }
    void rng
    return bridges
  }

  // === BUILDING PLACEMENT ===
  private placeBuildings(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][], heightMap: number[][],
    districtMap: number[][], districts: District[],
    complexity: number, density: number,
    rng: () => number, center: { x: number; y: number },
    terrainTiles: number[][], noise: SimplexNoise, squareMap: boolean[][],
    /** Already-placed structures whose tiles are off limits — bridges are
     *  laid down before buildings, and without this a house could be built
     *  straight through one. */
    blockers: PlacedObject[] = []
  ): PlacedObject[] {
    const buildings: PlacedObject[] = []
    // Per-generation, or a second Generate click inherits the first
    // town's counts and every scarce type reads as already at its cap.
    this._perDistrictType.clear()
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    // Count the town's buildable LAND before the blockers are stamped in.
    // The building budget below is derived from this, and blockers are mostly
    // landmarks — which are themselves structures. Counting after them charges
    // their footprint to the budget twice: once as land the budget no longer
    // sees, and again as houses that never get built to replace them. When
    // landmarks moved ahead of buildings in the pipeline that cost 5 points of
    // built coverage, 53% -> 48%, purely as an accounting artifact.
    let freeTiles = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) if (!occupied[y][x]) freeTiles++
    }
    this.markObjects(occupied, blockers, w, h)
    const maxDist = Math.sqrt(w * w + h * h) / 2

    // ════════════════════════════════════════════════════════════════
    // ORGANIC GROWTH: Street-frontage walk (center→edge)
    // Instead of random scatter, systematically walk road edges
    // from center outward. This creates continuous street walls,
    // natural growth rings, and organically dense cores.
    // ════════════════════════════════════════════════════════════════

    // Phase A: Collect all road-edge positions (non-road tiles adjacent to road)
    interface RoadEdge { x: number; y: number; distSq: number }
    const roadEdges: RoadEdge[] = []
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        if (roadMap[y][x] || waterMap[y][x] || occupied[y][x]) continue
        // Must be adjacent to road
        let nearRoad = false
        for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
          if (roadMap[y + dy]?.[x + dx]) { nearRoad = true; break }
        }
        if (!nearRoad) continue
        roadEdges.push({ x, y, distSq: (x - center.x) ** 2 + (y - center.y) ** 2 })
      }
    }

    // Sort center-first: core gets built first (growth rings)
    roadEdges.sort((a, b) => a.distSq - b.distSq)

    // How many buildings the town wants, from how much land there is to build
    // on — not from a constant.
    //
    // This was `50 + complexity*90 + density*60`, i.e. ~155, tuned when the
    // street network was a merged lake covering a third of the map. Narrowing
    // the swathes handed roughly a quarter of the town back as buildable
    // ground, and the flat cap simply pocketed it: building count barely moved
    // while the land grew, so built coverage FELL from 49% to 43% and frontage
    // occupancy from 76% to 67%. A cap expressed against a quantity you just
    // changed is the same bug as a constant expressed against one — it stops
    // meaning what it meant. Count the land instead.
    const maxBuildings = Math.floor(freeTiles * 0.14 * (0.9 + density * 0.9))
    // Surfaced because a budget that binds and a budget that never binds look
    // identical from the outside, and "raise the cap" is the kind of fix that
    // gets applied for a whole session before anyone checks it was the cap.
    placeStats._freeTiles = freeTiles
    placeStats._maxBuildings = maxBuildings
    let placed = 0

    // A DESIGNED SQUARE IS NOT A BUILDING PLOT. openSquareRooms cuts the
    // carriageway out of the middle of the main square so it can be a room
    // rather than a junction — and that immediately handed the square to this
    // placer, which saw fresh unoccupied paving and built on it. The fountain
    // then had to search fourteen tiles out again. A square is reserved.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (squareMap?.[y]?.[x]) occupied[y][x] = true
      }
    }

    // Phase B: Walk edges, placing buildings with continuity bonus
    // Track which tiles have a neighbor building for "street wall" bonus
    const hasBuildingNeighbor = (x: number, y: number): boolean => {
      for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && occupied[ny][nx] && !roadMap[ny][nx] && !waterMap[ny][nx]) {
          return true
        }
      }
      return false
    }

    // MEASURED AND REVERTED: a second infill pass over roadEdges.
    //
    // The walk visits each road edge once, centre-first, so the obvious theory
    // for the ~127 buildable unbuilt frontage edges a town carries was that
    // the walk passed them BEFORE their neighbours existed and never came
    // back. Running the identical placer a second time, once the street wall
    // is up, tests that in one edit: gaps with neighbours would be taken by
    // the continuity bonus, genuinely isolated plots would still face the
    // coin flip.
    //
    // It placed ~11 more buildings per town and moved frontage-against-
    // achievable by 0.7 of a point — about zero, on the same scale that got
    // plot orientation reverted twice. And the split rejection counters say
    // why, which is the part worth keeping: on the SECOND pass every single
    // acceptChance rejection was still `lonely`. The remaining gaps do not
    // have neighbours even after the town is built, so they are not holes in
    // a terrace — they are isolated frontage out on the periphery, and
    // filling them would manufacture exactly the scatter this whole arc
    // exists to remove.
    //
    // Do not re-attempt this without a mechanism that makes those plots
    // adjacent to something first.
    for (const edge of roadEdges) {
      if (placed >= maxBuildings) break
      const { x: rx, y: ry } = edge
      if (occupied[ry]?.[rx]) continue

      // District context
      const dId = districtMap[ry]?.[rx] ?? -1
      const district = districts.find(d => d.id === dId)
      const types = district ? DISTRICT_BUILDINGS[district.type] : DISTRICT_BUILDINGS.residential
      const distDensity = district ? district.buildingDensity : 0.8
      const dType = district?.type || 'residential'

      // Growth ring: distance-based acceptance
      const distFromCenter = Math.sqrt(edge.distSq)
      const distNorm = distFromCenter / maxDist

      // Continuity bonus: strongly biased to build next to existing
      // buildings so street walls form as rows, not islands. Medieval
      // / Traverse-Town / Kyoto / Paris towns read as rows sharing walls,
      // not scattered plots.
      const continuityBonus = hasBuildingNeighbor(rx, ry) ? 0.7 : 0
      // The growth-ring falloff is deliberate — a town thins toward its edge —
      // but it was the single biggest filter in the placer (210 rejections
      // against 143 for "no room"), and it was tuned when there was far less
      // frontage to fill. An isolated edge tile in the outer town had a 28%
      // chance of starting anything, so whole lanes on the periphery got a
      // road and no buildings, which is what holds frontage occupancy at 71%
      // against the 85-95% of a real walled town. Shallower falloff, higher
      // base: the core still builds first and densest, the edge still thins,
      // but a lane out there now gets a wall rather than a coin flip.
      const reach = 0.75 + density * 0.75
      const acceptChance = distDensity * (1.0 - distNorm * 0.25) * reach + continuityBonus
      if (rng() > acceptChance) {
        rejected('acceptChance')
        // WHICH plots the coin flip is throwing away. The bare count said 61
        // per town against ~127 buildable frontage gaps, which is the right
        // order of magnitude to be the whole remaining shortfall — but a count
        // cannot say whether they are honest frontier thinning or lanes that
        // never got started, and those want opposite fixes. Splitting by ring
        // and by whether the plot had a neighbour answers it in one run.
        rejected(`acceptChance@${distNorm < 0.25 ? 'core' : distNorm < 0.5 ? 'middle' : 'outer'}`)
        rejected(`acceptChance@${continuityBonus > 0 ? 'adjacent' : 'lonely'}`)
        continue
      }

      // Growth ring character: core gets bigger, taller buildings
      const ringChar = distNorm < 0.25 ? 'core' : distNorm < 0.5 ? 'middle' : 'outer'

      // Weighted random building type (bias toward larger buildings in core).
      //
      // NOTE — measured, and do not "fix" this the obvious way. The weights
      // do NOT produce the counts they look like they should: over six seeds
      // (1180 structures) row_house is 40% of everything, while mansion (the
      // highest weight in noble districts) and half_timber (weight 4 in
      // residential) land once each. Three effects stack up:
      //   1. A type's real odds are its weight TIMES how often it fits, and a
      //      1x2 fits nearly everywhere while a 4x3 almost nowhere.
      //   2. The ROW STREAK below copies the winning type up to 4 more times
      //      in each direction, so the anchor roll is amplified ~9x.
      //   3. Streaks of a large type need a lot of contiguous space, so they
      //      succeed far less often than streaks of small ones.
      //
      // Filtering the roll to types that fit here was tried and made it
      // WORSE (row_house 468 -> 575, archway 7 -> 82): positions that used to
      // be abandoned when a large type lost the fit test started getting
      // filled with small types instead. Scaling weights by footprint area on
      // top of that did not recover it either. Leaving the roll alone and
      // abandoning on a miss is measurably the best of the three, and a town
      // that is mostly terraced row houses is the correct look anyway — the
      // real problem was only ever that MARKETS did not read as markets, and
      // that is handled at the render layer, where a row house in a market
      // district is already drawn as a shopfront.
      const totalWeight = types.reduce((s, t) => {
        let w = t.weight
        if (ringChar === 'core' && t.w >= 3) w *= 1.5
        if (ringChar === 'outer' && t.w >= 3) w *= 0.5
        return s + w
      }, 0)
      let roll = rng() * totalWeight
      let type = types[0]
      for (const t of types) {
        let tw = t.weight
        if (ringChar === 'core' && t.w >= 3) tw *= 1.5
        if (ringChar === 'outer' && t.w >= 3) tw *= 0.5
        roll -= tw
        if (roll <= 0) { type = t; break }
      }

      // Scarce types are capped per QUARTER, not per town — see
      // MAX_PER_DISTRICT. The walk rolls its own type rather than going
      // through pickTypeForSpace, so without this the cap would only bind on
      // the fill passes and the main placer would spam them instead. A gate
      // enforced in one of two paths is not enforced.
      if (this.atDistrictCap(dId, type.id)) { rejected('districtCap'); continue }

      const bw = type.w, bh = type.h

      // ANCHOR THE PLOT AWAY FROM ITS STREET.
      //
      // A footprint grows +X/+Y from its origin, and the origin was always the
      // road-edge tile itself. So a plot whose street lies to the SOUTH grew
      // straight into that street: for a 1x2 row house, origin (x,y) with road
      // at (x,y+1) covers y and y+1, the second of which is carriageway, and
      // the placement is rejected. The tile that WOULD work — origin (x,y-1),
      // putting the house's south wall on the kerb — is not adjacent to any
      // road, so it is not in roadEdges and is never even tried.
      //
      // Half of every town was therefore structurally unbuildable, and the
      // measurement says so precisely: land north of a road (i.e. with its
      // street to the south) sits at 34% occupied against 58% for land east of
      // one. The x-axis shows only a mild version of the same thing because
      // row houses are 1 tile wide and a 1-wide footprint cannot overlap an
      // eastern road.
      //
      // So anchor the far corner instead: when the street is south or east,
      // place the origin so the building ENDS at the road edge. The lower
      // bound guard is not decoration — an earlier attempt at this indexed
      // occupied[-1] and threw, and back then the exception was swallowed into
      // UI state, giving "43 buildings placed" and a map containing none.
      let ox = rx, oy = ry
      if (roadMap[ry + 1]?.[rx]) oy = ry - (bh - 1)
      if (roadMap[ry]?.[rx + 1]) ox = rx - (bw - 1)
      if (ox < 1 || oy < 1 || ox + bw > w - 1 || oy + bh > h - 1) {
        rejected('offGrid'); continue
      }

      // Check if area is free
      let free = true
      for (let dy = 0; dy < bh && free; dy++) {
        for (let dx = 0; dx < bw && free; dx++) {
          if (occupied[oy + dy]?.[ox + dx]) free = false
        }
      }
      if (!free) { rejected('occupied'); continue }

      // Detect which side of the placed footprint faces a road. Counts road
      // tiles along each side; the side with the most wins. Ties resolve
      // N > S > W > E. This becomes the building's "primary face" in the
      // renderer so painted doors, doorsteps, awnings, signs all land on
      // the wall facing the street rather than randomly pointed away.
      let roadSide: 'N' | 'S' | 'E' | 'W' | null = null
      let nN = 0, nS = 0, nE = 0, nW = 0
      for (let dx = 0; dx < bw; dx++) {
        if (roadMap[oy - 1]?.[ox + dx]) nN++
        if (roadMap[oy + bh]?.[ox + dx]) nS++
      }
      for (let dy = 0; dy < bh; dy++) {
        if (roadMap[oy + dy]?.[ox - 1]) nW++
        if (roadMap[oy + dy]?.[ox + bw]) nE++
      }
      const best = Math.max(nN, nS, nE, nW)
      if (best > 0) {
        if (nN === best) roadSide = 'N'
        else if (nS === best) roadSide = 'S'
        else if (nW === best) roadSide = 'W'
        else roadSide = 'E'
      }

      // Growth-ring-aware floor count
      const heightVal = heightMap[oy]?.[ox] ?? 0
      const baseFloors = this.districtFloors(dType, rng)

      const coreBonus = ringChar === 'core' ? 1 : 0
      const hillBonus = heightVal > 1.0 ? 1 : 0
      // Rare "tower house" whimsy: 4% of buildings get +2 floors to stand
      // out in the silhouette like the tall-thin leaning houses of Lisbon
      // or Porto. Not confined to noble — adds the 500-year-growth feel
      // where one ambitious family built up.
      const towerHouse = rng() < 0.04
      const towerBonus = towerHouse ? 2 : 0
      // Cap 6, not 5. With a floor of one storey there are only so many levels
      // to go round, and six districts cannot have distinct medians AND
      // three-storey spreads inside a five-level range. One more level at the
      // top is 17.4m, which is a tall noble townhouse rather than a tower.
      const floors = Math.min(baseFloors + coreBonus + hillBonus + towerBonus, 6)

      const elevBias = DISTRICT_ELEVATION_BIAS[dType] || 0
      const rawElev = heightVal + elevBias
      const elevation = Math.max(0, Math.min(Math.round(rawElev * 2) / 2, 2.5))

      // Micro-variation: each building subtly unique
      const scaleJitter = 0.92 + rng() * 0.16
      const scaleY = 0.94 + rng() * 0.12
      const styleNoise = noise.noise2D(ox * 0.2, oy * 0.2)
      const style = styleNoise > 0.3 ? 'ornate'
        : styleNoise > -0.1 ? 'standard'
        : dType === 'slum' ? 'weathered' : 'rustic'

      buildings.push({
        id: uuid(),
        definitionId: type.id,
        x: ox, y: oy,
        rotation: 0, scaleX: scaleJitter, scaleY,
        elevation,
        footprint: { w: bw, h: bh },
        properties: {
          floors, district: dType,
          style, growthRing: ringChar,
          roadSide,
          hasAwning: dType === 'market' || (dType === 'residential' && rng() > 0.6),
          hasBalcony: type.id === 'balcony_house' || (dType === 'noble' && rng() > 0.5),
          hasFlowerBox: dType === 'garden' || dType === 'noble' || (dType === 'residential' && rng() > 0.7),
          hasShutters: dType !== 'slum' && rng() > 0.4,
          chimneyPos: rng() > 0.5 ? 'left' : 'right',
        }
      })

      for (let dy = 0; dy < bh; dy++) {
        for (let dx = 0; dx < bw; dx++) {
          if (oy + dy < h && ox + dx < w) occupied[oy + dy][ox + dx] = true
        }
      }
      placed++
      this.countDistrictType(dId, type.id)
      placeStats._placedPhaseB = placed

      // ROW STREAK — extend this placement along the road tangent so
      // the block reads as a terraced row of houses sharing walls, not
      // isolated plots. Sample 2–4 more buildings along each tangent
      // side with varied floor counts (±1 from baseline) for organic
      // height rhythm. This is the core of "500 years of ad-hoc growth".
      const roadW = roadMap[oy]?.[ox - 1] ? true : false
      const roadE = roadMap[oy]?.[ox + bw] ? true : false
      const roadN = roadMap[oy - 1]?.[ox] ? true : false
      const roadS = roadMap[oy + bh]?.[ox] ? true : false
      // Tangent runs perpendicular to the road side. If road to W or E,
      // tangent is along Y; if road to N or S, tangent is along X.
      const tanX = (roadN || roadS) ? 1 : 0
      const tanY = (roadW || roadE) ? 1 : 0
      if ((tanX !== 0 || tanY !== 0) && !NEVER_TERRACED.has(type.id)) {
        for (const sign of [1, -1]) {
          const maxStreak = 2 + Math.floor(rng() * 3)   // 2–4 more in this direction
          let curX = ox + sign * tanX * bw
          let curY = oy + sign * tanY * bh
          for (let k = 0; k < maxStreak && placed < maxBuildings; k++) {
            // The streak is the THIRD path that chooses a type, and it copies
            // the anchor's. Without the cap here a quarter capped at one
            // sexton's hut got four of them in a row, because the cap bound
            // on the walk and the fills and not on this. That is the same
            // "enforced in one of two paths is not enforced" mistake as the
            // comment on the walk's own check, made one loop further down.
            if (this.atDistrictCap(dId, type.id)) break
            if (curX < 1 || curY < 1 || curX + bw > w - 1 || curY + bh > h - 1) break
            // Footprint must be free and NOT on a road/water.
            let clear = true
            for (let ddy = 0; ddy < bh && clear; ddy++) {
              for (let ddx = 0; ddx < bw && clear; ddx++) {
                if (occupied[curY + ddy]?.[curX + ddx]) clear = false
                if (roadMap[curY + ddy]?.[curX + ddx]) clear = false
                if (waterMap[curY + ddy]?.[curX + ddx]) clear = false
              }
            }
            if (!clear) break
            // Varied floors: ±1 off the anchor so the row has height
            // rhythm rather than matching uniformly.
            const varyFloors = Math.max(1, Math.min(4,
              floors + (Math.floor(rng() * 3) - 1)))
            buildings.push({
              id: uuid(),
              definitionId: type.id,
              x: curX, y: curY,
              rotation: 0,
              scaleX: 0.92 + rng() * 0.16,
              scaleY: 0.94 + rng() * 0.12,
              elevation,
              footprint: { w: bw, h: bh },
              properties: {
                floors: varyFloors, district: dType,
                style, growthRing: ringChar,
                hasAwning: dType === 'market' || (dType === 'residential' && rng() > 0.6),
                hasBalcony: type.id === 'balcony_house' || (dType === 'noble' && rng() > 0.5),
                hasFlowerBox: dType === 'garden' || dType === 'noble' || (dType === 'residential' && rng() > 0.7),
                hasShutters: dType !== 'slum' && rng() > 0.4,
                chimneyPos: rng() > 0.5 ? 'left' : 'right',
              }
            })
            for (let ddy = 0; ddy < bh; ddy++) {
              for (let ddx = 0; ddx < bw; ddx++) {
                if (curY + ddy < h && curX + ddx < w) occupied[curY + ddy][curX + ddx] = true
              }
            }
            placed++
            this.countDistrictType(dId, type.id)
            curX += sign * tanX * bw
            curY += sign * tanY * bh
          }
        }
      }
    }

    // Phase C: Gap-fill pass — random scatter for spots the walk missed
    const gapFillMax = Math.floor(maxBuildings * 0.3)
    let gapFilled = 0
    for (let attempt = 0; attempt < gapFillMax * 40 && gapFilled < gapFillMax; attempt++) {
      const rx = Math.floor(rng() * (w - 6)) + 3
      const ry = Math.floor(rng() * (h - 6)) + 3
      if (!this.isRoadAdjacent(rx, ry, roadMap, w, h) || occupied[ry]?.[rx]) continue

      const dId = districtMap[ry]?.[rx] ?? -1
      const district = districts.find(d => d.id === dId)
      const types = district ? DISTRICT_BUILDINGS[district.type] : DISTRICT_BUILDINGS.residential
      const distDensity = district ? district.buildingDensity : 0.8
      const distFromCenter = Math.sqrt((rx - center.x) ** 2 + (ry - center.y) ** 2)
      const distNorm = distFromCenter / maxDist
      if (rng() > distDensity * (1.0 - distNorm * 0.6) * density) continue

      // FOURTH path that chooses a type, and it also has to honour the cap.
      // Three were fixed before this one was noticed, each time by the count
      // still exceeding its cap afterwards — which is the argument for having
      // the measurement rather than reasoning about coverage of the edit.
      const capped = types.filter((t) => !this.atDistrictCap(dId, t.id))
      if (capped.length === 0) continue
      const totalWeight = capped.reduce((s, t) => s + t.weight, 0)
      let roll = rng() * totalWeight
      let type = capped[0]
      for (const t of capped) { roll -= t.weight; if (roll <= 0) { type = t; break } }

      const bw = type.w, bh = type.h
      if (rx + bw > w - 1 || ry + bh > h - 1) continue

      let free = true
      for (let dy = 0; dy < bh && free; dy++) {
        for (let dx = 0; dx < bw && free; dx++) {
          if (occupied[ry + dy]?.[rx + dx]) free = false
        }
      }
      if (!free) continue

      const heightVal = heightMap[ry]?.[rx] ?? 0
      const dType = district?.type || 'residential'
      const elevBias = DISTRICT_ELEVATION_BIAS[dType] || 0
      const elevation = Math.max(0, Math.min(Math.round((heightVal + elevBias) * 2) / 2, 2.5))

      buildings.push({
        id: uuid(), definitionId: type.id,
        x: rx, y: ry, rotation: 0,
        scaleX: 0.92 + rng() * 0.16, scaleY: 0.94 + rng() * 0.12,
        elevation,
        footprint: { w: bw, h: bh },
        properties: { floors: this.districtFloors(dType, rng), district: dType }
      })
      this.countDistrictType(dId, type.id)

      for (let dy = 0; dy < bh; dy++) {
        for (let dx = 0; dx < bw; dx++) {
          if (ry + dy < h && rx + dx < w) occupied[ry + dy][rx + dx] = true
        }
      }
      gapFilled++
    }

    // === FILL PASS 1: Row houses & small buildings to plug gaps for continuous frontage ===
    const fillMax = Math.floor(maxBuildings * 0.8)
    let filled = 0
    for (let y = 3; y < h - 3 && filled < fillMax; y++) {
      for (let x = 3; x < w - 2 && filled < fillMax; x++) {
        if (occupied[y][x] || !this.isRoadAdjacent(x, y, roadMap, w, h)) continue

        // Loosened from 0.7 → 0.92 so the outer ring of the map gets filled
        // instead of leaving massive empty space around the edges.
        const distFromC = Math.sqrt((x - center.x) ** 2 + (y - center.y) ** 2) / maxDist
        if (distFromC > 0.92) continue

        const elev = Math.min(Math.round((heightMap[y]?.[x] ?? 0) * 2) / 2, 2)
        const dId = districtMap[y]?.[x] ?? -1
        const district = districts.find(d => d.id === dId)
        const dType = district?.type || 'residential'

        // Try building_small (2x2) first for better density.
        // Skip-probability dropped from 0.4 → 0.15 so 85% of viable slots
        // actually get filled instead of 60% being randomly skipped.
        // The type comes from the DISTRICT's table sized to the real gap, not
        // from a literal. Both branches used to hardcode generic housing and
        // then label it with whatever quarter it landed in — see
        // pickTypeForSpace. The 0.15 roll survives as a thinning coin flip.
        const pick = rng() > 0.15
          ? this.pickTypeForSpace(dType, x, y, occupied, w, h, rng, 99, 99, dId)
          : this.pickTypeForSpace(dType, x, y, occupied, w, h, rng, 2, 3, dId)
        // null = this quarter has nothing that fits here, so leave the gap.
        if (pick) {
          buildings.push({
            id: uuid(), definitionId: pick.id,
            x, y, rotation: 0, scaleX: 1, scaleY: 1, elevation: elev,
            footprint: { w: pick.w, h: pick.h },
            properties: { floors: this.districtFloors(dType, rng), district: dType }
          })
          this.markArea(occupied, x, y, pick.w, pick.h, w, h)
          filled++
        }
      }
    }

    // === FILL PASS 2: Corner buildings at road intersections ===
    let corners = 0
    const cornerMax = Math.floor(maxBuildings * 0.15)
    for (let y = 3; y < h - 4 && corners < cornerMax; y += 2) {
      for (let x = 3; x < w - 4 && corners < cornerMax; x += 2) {
        if (occupied[y][x]) continue
        // Check for L-shaped road intersection nearby
        const hasHRoad = roadMap[y]?.[x - 1] || roadMap[y]?.[x + 2]
        const hasVRoad = roadMap[y - 1]?.[x] || roadMap[y + 2]?.[x]
        if (!hasHRoad || !hasVRoad) continue
        if (!this.areaFree(occupied, x, y, 2, 2, w, h)) continue

        const cornerType = (districts.find(d => d.id === (districtMap[y]?.[x] ?? -1)))?.type || 'residential'
        const cornerId = districtMap[y]?.[x] ?? -1
        const cPick = this.pickTypeForSpace(cornerType, x, y, occupied, w, h, rng, 3, 3, cornerId)
        if (!cPick) continue
        buildings.push({
          id: uuid(), definitionId: cPick.id,
          x, y, rotation: 0, scaleX: 1, scaleY: 1,
          footprint: { w: cPick.w, h: cPick.h },
          elevation: Math.min(Math.round((heightMap[y]?.[x] ?? 0) * 2) / 2, 2),
          properties: { floors: this.districtFloors(cornerType, rng), district: cornerType }
        })
        this.markArea(occupied, x, y, cPick.w, cPick.h, w, h)
        corners++
      }
    }

    // === COURTYARD DETECTION: Paint courtyards between building clusters ===
    this.detectAndPaintCourtyards(terrainTiles, occupied, roadMap, waterMap, buildings, w, h, rng)

    return buildings
  }


  // === LANDMARKS ===
  /**
   * Ids this pass emits as DRESSING rather than as structures. A landmark is
   * a building; the bench in front of it is not, and pushing both into the
   * same list sent the bench to BuildingFactory, which built it as a
   * nine-metre house. Listed explicitly because the generator cannot read
   * object CATEGORIES — they live in store.ts, which imports the generator
   * registry, so reading them here would be an import cycle.
   */
  private static readonly LANDMARK_DRESSING = new Set([
    'bench', 'statue', 'cafe_table', 'barrel_stack', 'hanging_sign',
    'well', 'potted_plant', 'wall_lantern', 'crate', 'barrel', 'lamppost',
    'flower_box', 'market_stall', 'signpost', 'rope_coil',
  ])

  private placeLandmarks(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    districts: District[], districtMap: number[][],
    buildings: PlacedObject[], heightMap: number[][],
    complexity: number, rng: () => number,
    center: { x: number; y: number },
    terrain: number[][]
  ): { landmarks: PlacedObject[]; dressing: PlacedObject[] } {
    const landmarks: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markBuildings(occupied, buildings, w, h)
    // Where would a building close a long look down a street? Landmarks are
    // ranked against this instead of taking the first free rectangle near a
    // district centre, which is how four of 244 long views ended on one.
    const vista = this.computeVistaScores(roadMap, terrain, w, h)

    // Clock tower in noble/temple district + mandatory props around it
    for (const d of districts) {
      if (d.type === 'noble' || d.type === 'temple') {
        const spot = this.findVistaSpot(occupied, vista, d.center.x, d.center.y, 3, 3, w, h, 8)
        if (spot) {
          landmarks.push(this.createObj('clock_tower', spot.x, spot.y, 2))
          this.markArea(occupied, spot.x, spot.y, 3, 3, w, h)
          // Benches and statue in front of clock tower
          for (const [dx, dy] of [[0, 3], [2, 3]] as const) {
            const bx = spot.x + dx, by = spot.y + dy
            if (bx >= 0 && bx + 1 < w && by >= 0 && by < h &&
                !occupied[by][bx] && !occupied[by][bx + 1]) {
              landmarks.push(this.createObj('bench', bx, by))
              occupied[by][bx] = true; occupied[by][bx + 1] = true
            }
          }
          if (spot.x + 1 < w && spot.y + 4 < h && !occupied[spot.y + 4][spot.x + 1]) {
            landmarks.push(this.createObj('statue', spot.x + 1, spot.y + 4))
            occupied[spot.y + 4][spot.x + 1] = true
          }
          break
        }
      }
    }

    // Tavern in EVERY market and waterfront district (not just one)
    for (const d of districts) {
      if (d.type === 'market' || d.type === 'waterfront') {
        const spot = this.findVistaSpot(occupied, vista, d.center.x, d.center.y, 4, 3, w, h, 10)
        if (spot) {
          landmarks.push(this.createObj('tavern', spot.x, spot.y, 0.5))
          this.markArea(occupied, spot.x, spot.y, 4, 3, w, h)
          // Tavern props: barrel stack + hanging sign + café table
          for (const [dx, dy, propId] of [[-1, 1, 'barrel_stack'], [4, 0, 'hanging_sign'], [0, 3, 'cafe_table']] as const) {
            const px = spot.x + dx, py = spot.y + dy
            if (px >= 0 && px < w && py >= 0 && py < h && !occupied[py][px]) {
              landmarks.push(this.createObj(propId, px, py))
              occupied[py][px] = true
            }
          }
        }
      }
    }

    // Defense towers at map edges
    const towerPositions = [
      { x: 3, y: 3 }, { x: w - 5, y: 3 },
      { x: 3, y: h - 5 }, { x: w - 5, y: h - 5 }
    ]
    let towersPlaced = 0
    for (const pos of towerPositions) {
      if (towersPlaced >= 2 + Math.floor(complexity * 2)) break
      if (pos.x >= 0 && pos.x + 2 < w && pos.y >= 0 && pos.y + 2 < h &&
          !occupied[pos.y][pos.x] && !occupied[pos.y][pos.x + 1] &&
          !occupied[pos.y + 1][pos.x] && !occupied[pos.y + 1][pos.x + 1] &&
          !waterMap[pos.y][pos.x]) {
        landmarks.push(this.createObj('tower', pos.x, pos.y, 1.5))
        this.markArea(occupied, pos.x, pos.y, 2, 2, w, h)
        towersPlaced++
      }
    }

    // Extra towers in temple district centers
    for (const d of districts) {
      if (d.type !== 'temple') continue
      const spot = this.findVistaSpot(occupied, vista, d.center.x + 3, d.center.y, 2, 2, w, h, 6)
      if (spot) {
        landmarks.push(this.createObj('tower', spot.x, spot.y, 1.5))
        this.markArea(occupied, spot.x, spot.y, 2, 2, w, h)
      }
    }

    // Cathedral as a major landmark — prefer temple district, but every
    // town should get at least one signature skyline building. Falls back
    // to noble district, then to the biggest district by radius.
    // Gated on the town having a real street network rather than on how many
    // houses exist, because landmarks are now placed BEFORE the houses and
    // `buildings` is empty here. The gate was only ever guarding against
    // dropping a cathedral into a map too small to be a town; road extent
    // answers that question and is available at this point.
    let roadTiles = 0
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (roadMap[y][x]) roadTiles++
    let cathedralPlaced = false
    if (roadTiles > 60) {
      const tryInDistrict = (type: DistrictType): boolean => {
        for (const d of districts) {
          if (d.type !== type) continue
          const spot = this.findVistaSpot(occupied, vista, d.center.x, d.center.y, 5, 6, w, h, 12)
          if (spot) {
            landmarks.push(this.createObj('cathedral', spot.x, spot.y, 2))
            this.markArea(occupied, spot.x, spot.y, 5, 6, w, h)
            return true
          }
        }
        return false
      }
      cathedralPlaced = tryInDistrict('temple')
      if (!cathedralPlaced) cathedralPlaced = tryInDistrict('noble')
      // Fall back to the largest district regardless of type
      if (!cathedralPlaced) {
        const byRadius = [...districts].sort((a, b) => b.radius - a.radius)
        for (const d of byRadius) {
          const spot = this.findVistaSpot(occupied, vista, d.center.x, d.center.y, 5, 6, w, h, 14)
          if (spot) {
            landmarks.push(this.createObj('cathedral', spot.x, spot.y, 2))
            this.markArea(occupied, spot.x, spot.y, 5, 6, w, h)
            cathedralPlaced = true
            break
          }
        }
      }
    }
    // Add a bell_tower_tall spire in a noble or market district for a
    // secondary skyline anchor, so there's never just one tall thing.
    for (const d of districts) {
      if (d.type !== 'noble' && d.type !== 'market') continue
      const spot = this.findVistaSpot(occupied, vista, d.center.x + 4, d.center.y + 4, 3, 3, w, h, 10)
      if (spot) {
        landmarks.push(this.createObj('bell_tower_tall', spot.x, spot.y, 1.5))
        this.markArea(occupied, spot.x, spot.y, 3, 3, w, h)
        break
      }
    }

    // Archways at district boundaries where roads cross — Piranesi monumental gates
    let archways = 0
    for (let y = 3; y < h - 3 && archways < 6; y += 3) {
      for (let x = 3; x < w - 5 && archways < 6; x += 3) {
        if (!roadMap[y][x]) continue
        const d1 = districtMap[y]?.[x] ?? -1
        const d2 = districtMap[y]?.[x + 2] ?? -1
        const d3 = districtMap[y + 1]?.[x] ?? -1
        if (d1 === d2 && d1 === d3) continue
        if (this.areaFree(occupied, x, y, 3, 1, w, h)) {
          landmarks.push(this.createObj('archway', x, y, 0.5)) // slight elevation for grandeur
          this.markArea(occupied, x, y, 3, 1, w, h)
          // Flanking wall lanterns for drama
          if (x > 0 && !occupied[y][x - 1]) {
            landmarks.push(this.createObj('wall_lantern', x - 1, y))
            occupied[y][x - 1] = true
          }
          if (x + 3 < w && !occupied[y][x + 3]) {
            landmarks.push(this.createObj('wall_lantern', x + 3, y))
            occupied[y][x + 3] = true
          }
          archways++
        }
      }
    }

    // Colonnades in temple and noble districts — Piranesi's dramatic covered walkways
    for (const d of districts) {
      if (d.type !== 'temple' && d.type !== 'noble') continue
      // Place a row of stone walls along one side of the plaza — colonnade effect
      const colDir = rng() > 0.5 ? 1 : -1 // left or right of center
      const colX = d.center.x + colDir * Math.floor(d.radius * 0.5)
      let colsPlaced = 0
      for (let dy = -3; dy <= 3 && colsPlaced < 4; dy += 2) {
        const cy = d.center.y + dy
        if (colX >= 0 && colX + 1 < w && cy >= 0 && cy < h) {
          if (this.areaFree(occupied, colX, cy, 2, 1, w, h)) {
            landmarks.push(this.createObj('stone_wall', colX, cy, 0.3))
            this.markArea(occupied, colX, cy, 2, 1, w, h)
            colsPlaced++
          }
        }
      }
    }

    // Processional ways — stone-paved approaches to temple districts
    for (const d of districts) {
      if (d.type !== 'temple') continue
      // Place archway + statue sequence approaching the temple
      const approaches = [
        { dx: -4, dy: 0 }, { dx: 4, dy: 0 }, { dx: 0, dy: -4 }, { dx: 0, dy: 4 }
      ]
      for (const ap of approaches) {
        const ax = d.center.x + ap.dx, ay = d.center.y + ap.dy
        if (ax < 0 || ax >= w || ay < 0 || ay >= h) continue
        if (roadMap[ay]?.[ax] && !occupied[ay][ax]) {
          landmarks.push(this.createObj('statue', ax, ay, 0.5))
          occupied[ay][ax] = true
          break
        }
      }
    }

    // Grand staircases — Piranesi dramatic, placed where elevation changes
    // More staircases, placed specifically at elevation transitions
    if (complexity > 0.2) {
      let staircasesPlaced = 0
      const maxStairs = Math.floor(4 + complexity * 6)
      for (let attempt = 0; attempt < 80 && staircasesPlaced < maxStairs; attempt++) {
        const sx = Math.floor(3 + rng() * (w - 8))
        const sy = Math.floor(3 + rng() * (h - 8))
        if (!this.isRoadAdjacent(sx, sy, roadMap, w, h) || occupied[sy][sx]) continue

        // Prefer placement at elevation changes (Piranesi's dramatic steps)
        const spot = this.findFreeSpot(occupied, sx, sy, 2, 3, w, h, 4)
        if (!spot) continue

        // Check for elevation difference nearby
        const elHere = heightMap[spot.y]?.[spot.x] ?? 0
        let hasElevChange = false
        for (let dy = -2; dy <= 2 && !hasElevChange; dy++) {
          for (let dx = -2; dx <= 2 && !hasElevChange; dx++) {
            const el2 = heightMap[spot.y + dy]?.[spot.x + dx] ?? 0
            if (Math.abs(el2 - elHere) > 0.4) hasElevChange = true
          }
        }
        // Place staircase — prefer elevation changes but allow some random placement too
        if (hasElevChange || rng() > 0.6) {
          landmarks.push(this.createObj('staircase', spot.x, spot.y, 0))
          this.markArea(occupied, spot.x, spot.y, 2, 3, w, h)
          staircasesPlaced++
        }
      }
    }

    // Split the dressing out. Everything above was pushed into one list for
    // occupancy purposes — which is correct, a bench does take a tile — but
    // only the structures may go to the layer BuildingFactory draws.
    return {
      landmarks: landmarks.filter((o) => !TownGenerator.LANDMARK_DRESSING.has(o.definitionId)),
      dressing: landmarks.filter((o) => TownGenerator.LANDMARK_DRESSING.has(o.definitionId)),
    }
  }

  // === TOWN GATES ===
  private placeGates(
    w: number, h: number, roadMap: boolean[][], rng: () => number,
    /** Gates were placed on road exits with no regard for what already stood
     *  there, so a gatehouse could land on top of a bridge or a house. */
    blockers: PlacedObject[] = [],
    /** Gates were also the one placer never handed the water map. Where a
     *  road left the map across a river, the 3x1 gatehouse was built standing
     *  in it. Each side keeps scanning for a dry exit rather than giving up,
     *  so a watery crossing costs that gate only if the whole edge is wet. */
    waterMap?: boolean[][],
  ): PlacedObject[] {
    const gates: PlacedObject[] = []
    const blocked = new Set<string>()
    for (const b of blockers) {
      const bfp = (b.footprint ?? this.getFootprint(b.definitionId))
      for (let dy = 0; dy < bfp.h; dy++) {
        for (let dx = 0; dx < bfp.w; dx++) blocked.add(`${b.x + dx},${b.y + dy}`)
      }
    }

    // Check each edge for road exits
    const edges: { x: number; y: number; side: string }[] = []
    for (let x = 2; x < w - 4; x++) {
      if (roadMap[0]?.[x] || roadMap[1]?.[x]) edges.push({ x, y: 1, side: 'top' })
      if (roadMap[h - 1]?.[x] || roadMap[h - 2]?.[x]) edges.push({ x, y: h - 2, side: 'bottom' })
    }
    for (let y = 2; y < h - 4; y++) {
      if (roadMap[y]?.[0] || roadMap[y]?.[1]) edges.push({ x: 1, y, side: 'left' })
      if (roadMap[y]?.[w - 1] || roadMap[y]?.[w - 2]) edges.push({ x: w - 4, y, side: 'right' })
    }

    // A gate at every road out of town, not one per compass side.
    //
    // The cap used to be four, keyed on 'top'/'bottom'/'left'/'right', which
    // silently discarded every exit after the first on each edge. The carver
    // radiates roughly nine main streets outward from the centre plus a dozen
    // secondary ones, so a 48x48 town has far more than four ways out and was
    // getting a gatehouse on at most four of them.
    //
    // It shows up in the vista audit as the largest single failure: 22% of
    // every long look down a street runs off the map edge and terminates on
    // nothing at all — 102 views across three seeds, against 38 that find a
    // landmark. A road leaving a walled town through a gate is both the
    // correct thing for the town to have and, from inside, the weenie that
    // closes the street.
    //
    // Dedupe by DISTANCE rather than by side: two exits 20 tiles apart on the
    // same edge are two different roads and want two different gates, while
    // adjacent tiles of one 3-wide road are one exit.
    const MIN_GATE_SPACING = 6
    const MAX_GATES = 8
    for (const edge of edges) {
      if (gates.length >= MAX_GATES) break
      let tooClose = false
      for (const g of gates) {
        if (Math.abs(g.x - edge.x) + Math.abs(g.y - edge.y) < MIN_GATE_SPACING) {
          tooClose = true; break
        }
      }
      if (tooClose) continue
      // town_gate is 3x1 — every tile it covers must be clear.
      const gfp = this.getFootprint('town_gate')
      let clear = true
      for (let dy = 0; dy < gfp.h && clear; dy++) {
        for (let dx = 0; dx < gfp.w && clear; dx++) {
          const gx = edge.x + dx, gy = edge.y + dy
          if (gx < 0 || gy < 0 || gx >= w || gy >= h) clear = false
          else if (blocked.has(`${gx},${gy}`)) clear = false
          else if (waterMap?.[gy]?.[gx]) clear = false
        }
      }
      if (!clear) continue
      gates.push(this.createObj('town_gate', edge.x, edge.y))
    }

    return gates
  }

  // === ALLEYS & INTIMATE SPACES ===
  // Creates narrow alleys, alcoves, and L-shaped nooks between building clusters
  /**
   * Unpave the land behind the buildings.
   *
   * paintDistrictTerrain paves a district by TYPE, uniformly, over the whole
   * Voronoi cell — a temple quarter is stone from edge to edge, a market
   * quarter cobble from edge to edge. That is defensible for the street and
   * the square, and wrong everywhere else, because a district is not a floor
   * surface: it is streets, squares, buildings, and the yards behind them.
   *
   * Measured, 51-66% of the map was hard paving while only ~20% was
   * circulation. The remaining third is the pale expanse the town reads as —
   * and crucially it reads that way even where the space is tightly enclosed,
   * because a continuous floor of one material looks like one room however
   * many walls stand on it. Narrowing the streets could never fix that; the
   * ground behind a terrace was paved before any street was drawn.
   *
   * So: any hard paving more than a couple of tiles from real circulation, and
   * not part of a designed square, becomes yard. What kind of yard depends on
   * the district, because a noble's back garden and a slum's back lot are not
   * the same place. This is the courtyards-and-gardens item from the rework
   * list, arrived at from the other end.
   */
  private softenBackOfBlock(
    terrain: number[][], squareMap: boolean[][],
    districtMap: number[][], districts: District[],
    buildings: PlacedObject[], w: number, h: number, noise: SimplexNoise
  ): void {
    /** How far paving may reach from the kerb, in tiles. 2 is 6m of forecourt. */
    const APRON = 2
    const isHardPaving = (t: number): boolean =>
      t === 2 || t === 14 || t === 15 || t === 16
    // Distance to the nearest real street, by BFS from circulation. Building
    // footprints are NOT obstacles here: the apron should reach the far side
    // of a shallow terrace, and stopping at the first wall would strand the
    // paving in front of every doorway that faces a courtyard.
    const INF = 1 << 20
    const dist = Array.from({ length: h }, () => new Int32Array(w).fill(INF))
    const queue: number[] = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isCirculation(terrain[y][x])) continue
        dist[y][x] = 0
        queue.push(y * w + x)
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], cx = i % w, cy = (i / w) | 0
      if (dist[cy][cx] >= APRON) continue
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx, ny = cy + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        if (dist[ny][nx] <= dist[cy][cx] + 1) continue
        dist[ny][nx] = dist[cy][cx] + 1
        queue.push(ny * w + nx)
      }
    }
    // A building's own footprint keeps its paving: the mesh covers it, and
    // unpaving it only shows through as a fringe of grass under the walls.
    const built = Array.from({ length: h }, () => new Uint8Array(w))
    for (const b of buildings) {
      const fp = b.footprint ?? this.getFootprint(b.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const px = b.x + dx, py = b.y + dy
          if (px >= 0 && py >= 0 && px < w && py < h) built[py][px] = 1
        }
      }
    }
    // ONE MATERIAL PER PLACE.
    //
    // Every paved tile that is not a street and not a designed square gets the
    // district's single canonical paving id, rather than keeping whatever the
    // last pass to touch it happened to write. Six passes paint ground here —
    // base terrain, district paint, two plaza carvers, the market square, the
    // road painter — and each layers over the last, so a tile's material was a
    // record of its history instead of a statement about where it is.
    //
    // Measured, that produced confetti: plaza flagstone came out as 152
    // separate blobs totalling 245 tiles with 750 tiles of perimeter, biggest
    // blob 32. 40% of every paved-to-paved edge in the map was a material
    // change. From inside the town that reads as patchy, broken paving, which
    // is what it is.
    //
    // Assigning by district rather than forcing everything to street cobble is
    // the Lynch move: a temple quarter really is floored in stone and a market
    // in cobble, and putting the seam on the DISTRICT BOUNDARY is what makes
    // the boundary perceptible instead of making it noise.
    const districtPaving = (t: DistrictType | undefined): number => {
      switch (t) {
        case 'temple': case 'noble': case 'fortress': case 'cemetery': return 2
        default: return 15   // colour-matched to street cobble: street and
      }                      // forecourt read as one continuous floor
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = terrain[y][x]
        if (!isHardPaving(t)) continue
        if (squareMap[y][x]) continue          // the square owns its own floor
        if (dist[y][x] <= APRON || built[y][x]) {
          const dd = districts.find((d) => d.id === districtMap[y]?.[x])
          terrain[y][x] = districtPaving(dd?.type)
          continue
        }
        const d = districts.find((dd) => dd.id === districtMap[y]?.[x])
        // Two octaves so a yard is not a flat colour — the same trick
        // paintDistrictTerrain uses, at the same frequency, so the new ground
        // sits in the same visual family as the old.
        const n = noise.noise2D(x * 0.12, y * 0.12)
        const n2 = noise.noise2D(x * 0.3 + 40, y * 0.3 - 40)
        // Yards are GREEN and DARK, not tan. This mattered more than which
        // tiles got replaced: the first version of this pass sent market and
        // temple yards to dirt and gravel, cut hard paving from 57% to 43%,
        // and moved the way the ground reads by almost nothing — because
        // dirt, sand, gravel, stone, flagstone and street cobble are all warm
        // tan, and 65% of the map stayed one colour family. Swapping a pale
        // tile for another pale tile is relabelling, not a change. Dirt is
        // still here, but as the exception a worked yard needs rather than the
        // default a lazy one falls back to.
        switch (d?.type) {
          case 'noble':
          case 'garden':
            terrain[y][x] = n > 0.2 ? 12 : n > -0.3 ? 10 : 0    // wildflower / garden / grass
            break
          case 'temple':
            terrain[y][x] = n > 0.45 ? 13 : n2 > -0.2 ? 10 : 5  // rare gravel path, else garden
            break
          case 'slum':
            terrain[y][x] = n > 0.05 ? 11 : n2 > 0 ? 5 : 1      // mud / dark grass / dirt
            break
          case 'market':
          case 'harbor':
            // A working yard: trodden mud and scrub behind the stalls, with
            // bare dirt only where the traffic is heaviest.
            terrain[y][x] = n > 0.3 ? 1 : n2 > 0.1 ? 11 : 5     // dirt / mud / dark grass
            break
          default:
            terrain[y][x] = n > 0.15 ? 10 : n2 > -0.25 ? 0 : 11 // garden / grass / mud
        }
      }
    }
  }

  private carveAlleys(terrain: number[][], buildings: PlacedObject[], w: number, h: number): void {
    const buildingMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (const b of buildings) {
      const fp = (b.footprint ?? this.getFootprint(b.definitionId))
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const bx = b.x + dx, by = b.y + dy
          if (bx < w && by < h) buildingMap[by][bx] = true
        }
      }
    }

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (buildingMap[y][x]) continue
        const leftB = x > 0 && buildingMap[y][x - 1]
        const rightB = x < w - 1 && buildingMap[y][x + 1]
        const topB = y > 0 && buildingMap[y - 1][x]
        const botB = y < h - 1 && buildingMap[y + 1][x]

        // Narrow passage between buildings
        if ((leftB && rightB) || (topB && botB)) {
          terrain[y][x] = 9 // dark cobblestone for alleys
        }

        // L-shaped alcoves: building on two adjacent sides (corner nooks)
        const cornerNook = (leftB && topB && !rightB && !botB) ||
                           (rightB && topB && !leftB && !botB) ||
                           (leftB && botB && !rightB && !topB) ||
                           (rightB && botB && !leftB && !topB)
        if (cornerNook) {
          terrain[y][x] = 14 // plaza flagstone for alcoves (intimate feel)
        }

        // Setback detection: building on one side, open on others = covered walkway feel
        const totalWalls = (leftB ? 1 : 0) + (rightB ? 1 : 0) + (topB ? 1 : 0) + (botB ? 1 : 0)
        if (totalWalls === 1 && terrain[y][x] !== 8 && terrain[y][x] !== 9 &&
            terrain[y][x] !== 14) {
          // Count more distant buildings (2 tiles away) for deeper setbacks
          let distantWalls = 0
          if (x > 1 && buildingMap[y][x - 2]) distantWalls++
          if (x < w - 2 && buildingMap[y][x + 2]) distantWalls++
          if (y > 1 && buildingMap[y - 2][x]) distantWalls++
          if (y < h - 2 && buildingMap[y + 2][x]) distantWalls++
          if (distantWalls >= 1) {
            terrain[y][x] = 14 // covered walkway / arcade feel
          }
        }
      }
    }
  }


  // === CONTEXTUAL PROPS ===
  private placeProps(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    /** Buildings that props may cluster AGAINST — also blocks their tiles. */
    existingObjs: PlacedObject[],
    /** Blocks tiles but is not a prop anchor: town walls, bridges. Without
     *  these, props were placed inside the wall and its watchtowers; feeding
     *  them through existingObjs instead would line the whole perimeter with
     *  barrels, so the two roles are kept separate. */
    blockers: PlacedObject[],
    districtMap: number[][], districts: District[],
    density: number, assetFrequencies: Record<string, number>,
    rng: () => number, center: { x: number; y: number }
  ): PlacedObject[] {
    const props: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, existingObjs, w, h)
    this.markObjects(occupied, blockers, w, h)

    const place = (defId: string, x: number, y: number) => {
      // Check the WHOLE footprint, not just the anchor tile. Multi-tile props
      // (a 2x2 fountain, a 3x2 wagon) could previously be anchored one tile
      // inside the grid edge and hang off the map, or overlap a neighbour.
      const pfp = this.getFootprint(defId)
      if (x < 0 || y < 0 || x + pfp.w > w || y + pfp.h > h) return false
      for (let oy = 0; oy < pfp.h; oy++) {
        for (let ox = 0; ox < pfp.w; ox++) if (occupied[y + oy][x + ox]) return false
      }
      props.push(this.createObj(defId, x, y))
      for (let oy = 0; oy < pfp.h; oy++) {
        for (let ox = 0; ox < pfp.w; ox++) occupied[y + oy][x + ox] = true
      }
      return true
    }

    // Building-adjacent props (contextual per district)
    for (const b of existingObjs) {
      const fp = (b.footprint ?? this.getFootprint(b.definitionId))
      const spots: { x: number; y: number }[] = []

      // Gather adjacent spots
      for (let dx = -1; dx <= fp.w; dx++) {
        spots.push({ x: b.x + dx, y: b.y - 1 })
        spots.push({ x: b.x + dx, y: b.y + fp.h })
      }
      for (let dy = 0; dy < fp.h; dy++) {
        spots.push({ x: b.x - 1, y: b.y + dy })
        spots.push({ x: b.x + fp.w, y: b.y + dy })
      }

      const validSpots = spots.filter(
        s => s.x >= 0 && s.x < w && s.y >= 0 && s.y < h && !occupied[s.y][s.x]
      )
      if (validSpots.length === 0) continue

      // Prefer the frontage the player actually walks past. Drawing uniformly
      // from the whole perimeter scattered dressing onto the backs and sides
      // of buildings too — about half of every town's props ended up on a
      // tile that touches no street, i.e. spent where nobody ever sees them.
      // Back spots stay as the fallback so buildings hemmed in by neighbours
      // still get dressed.
      const touchesStreet = (s: { x: number; y: number }): boolean =>
        !!(roadMap[s.y - 1]?.[s.x] || roadMap[s.y + 1]?.[s.x] ||
           roadMap[s.y]?.[s.x - 1] || roadMap[s.y]?.[s.x + 1])
      const streetSpots = validSpots.filter(touchesStreet)
      const backSpots = validSpots.filter(sp => !touchesStreet(sp))

      const numProps = Math.min(validSpots.length, 2 + Math.floor(rng() * 3 * density))
      const dId = districtMap[b.y]?.[b.x] ?? -1
      const district = districts.find(d => d.id === dId)
      const dTypeForProps: DistrictType = district ? district.type : 'residential'
      const propPalette = DISTRICT_PROPS[dTypeForProps]

      // Building-type-specific mandatory props first
      const buildingSpecificProps = this.getBuildingSpecificProps(b.definitionId, rng)

      // Building center (used to compute "facing away from wall").
      const bcx = b.x + fp.w / 2, bcy = b.y + fp.h / 2

      // A DESIGNED GROUP GETS THE PERIMETER FIRST.
      //
      // The reject counters said noRoom killed 50 of 85 attempts — 59% — and
      // the reason is ordering, not geometry: single props were consuming the
      // perimeter tile by tile and a two-part group then had nowhere adjacent
      // left. This repo already has the rule, learned three times in one day
      // on the waterfront, the quay lip and the main square: a designed place
      // must be dressed BEFORE the scatter runs, because the scatter only
      // knows whether a spot is bare and the owner knows what belongs there.
      //
      // One attempt per building, at the moment the perimeter is still empty.
      {
        const pool0 = streetSpots.length > 0 ? streetSpots : backSpots
        if (pool0.length > 0 && rng() < 0.75) {
          // ANCHOR WHERE THERE IS ROOM FOR A GROUP, rather than anywhere and
          // then failing. noRoom was rejecting half of all rolls — 48 of 100
          // on one seed — because the anchor was drawn uniformly from the
          // perimeter and a terrace in a 93%-party-wall town presents two or
          // three valid spots that are often not adjacent to each other. The
          // group's whole requirement is adjacency, so it is the thing to
          // select ON, not to discover afterwards; and the best-connected
          // spot is also where a cluster architecturally belongs. Ties are
          // broken randomly so this does not become a positional bias.
          //
          // Counted over the WHOLE perimeter and only over tiles that are
          // actually free, because that is exactly the set `tryVignette`
          // draws its extra parts from. The first cut counted neighbours
          // within pool0 alone and noRoom went UP: a criterion that measures
          // a different population from the constraint it exists to satisfy
          // is not a weaker filter, it is a filter aimed somewhere else.
          const perim = [...streetSpots, ...backSpots]
          const adj = (t: { x: number; y: number }): number =>
            perim.reduce((n, o) => n + (o !== t && !occupied[o.y]?.[o.x] &&
              Math.abs(o.x - t.x) <= 1 && Math.abs(o.y - t.y) <= 1 ? 1 : 0), 0)
          const best = pool0.reduce((m, t) => Math.max(m, adj(t)), 0)
          const roomy = pool0.filter(t => adj(t) === best)
          const anchor = roomy[Math.floor(rng() * roomy.length)]
          if (anchor && this.tryVignette(anchor, streetSpots.length > 0,
                dTypeForProps, b.definitionId, streetSpots, backSpots, occupied,
                props, bcx, bcy, w, h, rng)) {
            pool0.splice(pool0.indexOf(anchor), 1)
          }
        }
      }

      for (let i = 0; i < numProps; i++) {
        // Which side of the building this spot is on decides what goes there,
        // so remember it rather than just which pool it came from.
        const front = streetSpots.length > 0
        const pool = front ? streetSpots : backSpots
        if (pool.length === 0) break
        const idx = Math.floor(rng() * pool.length)
        const spot = pool.splice(idx, 1)[0]
        if (spot) {
          // A GROUP BEFORE A SINGLE OBJECT. One prop per spot is why a house
          // gets one barrel and the barrel explains nothing; a vignette puts
          // two or three related things on the same building's perimeter so
          // the arrangement implies somebody doing something. Only tried on
          // spots the mandatory building-specific props have not claimed, and
          // only when the neighbouring perimeter tiles are actually free — it
          // degrades to the single prop below rather than forcing itself in.
          const propId = i < buildingSpecificProps.length
            ? buildingSpecificProps[i]
            : this.propForRole(b.definitionId, dTypeForProps, front, propPalette, rng)
          const propFp = this.getFootprint(propId)
          // Face away from the building wall — the prop sits on the
          // building's perimeter, so the vector (spot - buildingCenter)
          // points outward from the wall. We add π so the prop's local
          // +Z (its "front") points back into the courtyard, not into
          // the wall.
          const dx = (spot.x + 0.5) - bcx
          const dy = (spot.y + 0.5) - bcy
          const facingY = Math.atan2(dy, dx) + Math.PI
          if (propFp.w === 1 && propFp.h === 1) {
            if (spot.x >= 0 && spot.x < w && spot.y >= 0 && spot.y < h && !occupied[spot.y][spot.x]) {
              const obj = this.createObj(propId, spot.x, spot.y)
              obj.properties.facingY = facingY
              props.push(obj)
              occupied[spot.y][spot.x] = true
            }
          } else if (this.areaFree(occupied, spot.x, spot.y, propFp.w, propFp.h, w, h)) {
            const obj = this.createObj(propId, spot.x, spot.y)
            obj.properties.facingY = facingY
            props.push(obj)
            this.markArea(occupied, spot.x, spot.y, propFp.w, propFp.h, w, h)
          }
        }
      }
    }

    // Scatter street furniture on tiles adjacent to roads — 2.5x denser.
    // hanging_sign / wall_lantern removed: they render with a bracket that
    // needs a wall to attach to, so they float weirdly when free-standing.
    // They still appear in DISTRICT_PROPS (building-adjacent placement).
    const streetFurnitureCount = Math.floor(density * w * h * 0.015)
    const streetItems = ['cafe_table', 'bench', 'sign', 'barrel', 'crate', 'potted_plant']
    for (let i = 0; i < streetFurnitureCount; i++) {
      const x = Math.floor(rng() * w)
      const y = Math.floor(rng() * h)
      if (this.isRoadAdjacent(x, y, roadMap, w, h) && !occupied[y]?.[x] && !roadMap[y]?.[x]) {
        // In market districts, prefer market-themed items
        const dId = districtMap[y]?.[x] ?? -1
        const dist = districts.find(d => d.id === dId)
        let item: string
        if (dist?.type === 'market' && rng() > 0.3) {
          item = ['cafe_table', 'barrel', 'crate', 'sign', 'crate_stack'][Math.floor(rng() * 5)]
        } else if (dist?.type === 'noble' && rng() > 0.4) {
          item = ['potted_plant', 'bench', 'planter_box'][Math.floor(rng() * 3)]
        } else {
          item = streetItems[Math.floor(rng() * streetItems.length)]
        }
        const fp = this.getFootprint(item)
        // Sample the road tangent at this tile so the prop faces the
        // street consistently. Benches turn their backs to the road
        // (seat into the sidewalk); other furniture lines up parallel
        // to the road tangent.
        const tangent = this.roadTangentAt(x, y, roadMap, w, h)
        let facingY: number | undefined
        if (tangent !== null) {
          facingY = item === 'bench' ? tangent + Math.PI : tangent
        }
        if (fp.w === 1 && fp.h === 1) {
          if (x >= 0 && x < w && y >= 0 && y < h && !occupied[y][x]) {
            const obj = this.createObj(item, x, y)
            if (typeof facingY === 'number') obj.properties.facingY = facingY
            props.push(obj)
            occupied[y][x] = true
          }
        } else if (this.areaFree(occupied, x, y, fp.w, fp.h, w, h)) {
          const obj = this.createObj(item, x, y)
          if (typeof facingY === 'number') obj.properties.facingY = facingY
          props.push(obj)
          this.markArea(occupied, x, y, fp.w, fp.h, w, h)
        }
      }
    }

    // Market district café clusters — tables along road edges every 5-6 tiles
    for (const d of districts) {
      if (d.type !== 'market') continue
      for (let y = d.center.y - d.radius; y < d.center.y + d.radius; y += 5) {
        for (let x = d.center.x - d.radius; x < d.center.x + d.radius; x += 6) {
          if (x < 0 || x >= w || y < 0 || y >= h) continue
          if (!this.isRoadAdjacent(x, y, roadMap, w, h)) continue
          // Place 2-3 café tables in a cluster
          for (let ci = 0; ci < 2 + Math.floor(rng() * 2); ci++) {
            const cx = x + Math.floor(rng() * 3) - 1
            const cy = y + Math.floor(rng() * 2)
            if (cx >= 0 && cx < w && cy >= 0 && cy < h && !occupied[cy][cx] && !roadMap[cy][cx]) {
              place('cafe_table', cx, cy)
            }
          }
        }
      }
    }

    // Well plazas — place benches near every well in existingObjs
    for (const obj of existingObjs) {
      if (obj.definitionId !== 'well') continue
      for (let i = 0; i < 3; i++) {
        const bx = obj.x + Math.floor(rng() * 4) - 1
        const by = obj.y + Math.floor(rng() * 4) - 1
        if (bx >= 0 && bx + 1 < w && by >= 0 && by < h &&
            !occupied[by][bx] && !occupied[by][bx + 1]) {
          props.push(this.createObj('bench', bx, by))
          occupied[by][bx] = true; occupied[by][bx + 1] = true
        }
      }
    }

    return props
  }

  // === LIGHTS ===
  private placeLights(
    w: number, h: number, roadMap: boolean[][], waterMap: boolean[][],
    existingObjs: PlacedObject[], rng: () => number, density: number
  ): PlacedObject[] {
    const lights: PlacedObject[] = []
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    // Water was never marked here. With 9 lamps per town that almost never
    // showed; once lamps followed every street it put 15 of them in the river.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) if (waterMap[y][x]) occupied[y][x] = true
    }
    this.markObjects(occupied, existingObjs, w, h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (roadMap[y][x]) occupied[y][x] = true
      }
    }

    const spacing = Math.max(3, Math.floor(5 - density * 2))
    let count = 0

    // Walk EVERY road tile and light any stretch that isn't already covered.
    // This used to sample a coarse `spacing`-step lattice and require the
    // lattice point itself to land on a road, so the vast majority of the
    // street network was never even considered — a 48x48 town got 9 lamps
    // total and the streets read as unlit at dusk, with none of the ground
    // light pools the design leans on.
    const lit = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    // Coverage radius is deliberately smaller than `spacing`: marking a full
    // spacing-square also suppresses lamps on parallel streets a few tiles
    // over, which left whole blocks dark.
    const litR = Math.max(2, spacing - 1)
    const markLit = (cx: number, cy: number) => {
      for (let dy = -litR; dy <= litR; dy++) {
        for (let dx = -litR; dx <= litR; dx++) {
          const nx = cx + dx, ny = cy + dy
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) lit[ny][nx] = true
        }
      }
    }

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!roadMap[y]?.[x]) continue
        if (lit[y][x]) continue // this stretch of street already has a lamp
        // Place light on adjacent non-road tile.
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const lx = x + dx, ly = y + dy
          if (lx >= 0 && lx < w && ly >= 0 && ly < h &&
              !roadMap[ly][lx] && !occupied[ly][lx]) {
            const lightType = count % 6 === 0 ? 'street_lamp_double' : 'lamppost'
            const obj = this.createObj(lightType, lx, ly)
            // Face perpendicular to the adjacent road tangent so the
            // double-arm crossbar / wall lantern arm projects toward the
            // street rather than randomly. Single-sphere lamps are
            // Y-symmetric so this is a no-op for them.
            const tangent = this.roadTangentAt(lx, ly, roadMap, w, h)
            if (tangent !== null) obj.properties.facingY = tangent + Math.PI / 2
            lights.push(obj)
            occupied[ly][lx] = true
            markLit(x, y)
            count++
            break
          }
        }
      }
    }

    return lights
  }

  // === STREET FURNITURE ===
  /**
   * Dress the WALKABLE network rather than the buildings. placeProps clusters
   * against building perimeters, which left the streets themselves bare: a
   * 48x48 town had 1,099 road tiles and only a quarter of them had any prop
   * within one tile, so the space the player actually moves through read as
   * empty pavement. This walks the roads and drops small kerbside clutter on
   * free tiles beside them, spaced so it punctuates rather than clutters.
   */
  private placeStreetFurniture(
    w: number, h: number, roadMap: boolean[][], waterMap: boolean[][],
    existingObjs: PlacedObject[], districtMap: number[][], districts: District[],
    density: number, rng: () => number,
    /** Terrain, so plaza/courtyard flagstone (14) counts as walkable open
     *  space. Squares are not in roadMap — carvePlaza only paints tiles — so
     *  without this every market square stayed completely bare. */
    terrain?: number[][],
  ): PlacedObject[] {
    const furniture: PlacedObject[] = []
    // Occupancy from objects and water only — NOT roads. Roads are 48% of a
    // town's tiles, so almost every tile beside a street is another street:
    // restricting furniture to non-road tiles yielded ~17 pieces town-wide.
    // Furniture goes on the KERB instead (a road tile that touches a non-road
    // edge), which dresses the street sides and leaves the middle clear.
    // Props are not in the collision mask (only structures and water are), so
    // this cannot block the player.
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) if (waterMap[y][x]) occupied[y][x] = true
    }
    this.markObjects(occupied, existingObjs, w, h)

    // Coverage radius: how far a placed piece "satisfies" the street around it.
    const gap = Math.max(2, Math.round(4 - density * 2))
    const covered = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    const markCovered = (cx: number, cy: number) => {
      for (let dy = -gap; dy <= gap; dy++) {
        for (let dx = -gap; dx <= gap; dx++) {
          const nx = cx + dx, ny = cy + dy
          if (nx >= 0 && nx < w && ny >= 0 && ny < h) covered[ny][nx] = true
        }
      }
    }

    // Walkable = streets, alleys, and plaza/courtyard flagstone.
    const walkable = (x: number, y: number): boolean =>
      !!roadMap[y]?.[x] || terrain?.[y]?.[x] === 14

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (!walkable(x, y) || covered[y][x] || occupied[y][x]) continue
        // Only kerb tiles: a walkable tile with at least one non-walkable
        // neighbour, so dressing hugs the edges and the middle stays clear.
        const edges = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
          .filter(([ex, ey]) => !walkable(x + ex, y + ey))
        if (edges.length === 0) continue
        {
          const [ex, ey] = edges[Math.floor(rng() * edges.length)]
          const fx = x, fy = y
          const dId = districtMap[fy]?.[fx] ?? -1
          const district = districts.find(d => d.id === dId)
          const palette = district
            ? (STREET_FURNITURE[district.type] ?? STREET_FURNITURE.residential)
            : STREET_FURNITURE.residential
          const defId = palette[Math.floor(rng() * palette.length)]
          // Multi-tile pieces (cart, market_stall) need their whole footprint.
          const ffp = this.getFootprint(defId)
          let fits = true
          for (let oy = 0; oy < ffp.h && fits; oy++) {
            for (let ox = 0; ox < ffp.w && fits; ox++) {
              const tx = fx + ox, ty = fy + oy
              if (tx >= w || ty >= h || occupied[ty][tx]) fits = false
            }
          }
          if (!fits) continue
          const obj = this.createObj(defId, fx, fy)
          // Turn its back to the wall/edge it stands against.
          obj.properties.facingY = Math.atan2(-ey, -ex)
          furniture.push(obj)
          for (let oy = 0; oy < ffp.h; oy++) {
            for (let ox = 0; ox < ffp.w; ox++) {
              if (fy + oy < h && fx + ox < w) occupied[fy + oy][fx + ox] = true
            }
          }
          markCovered(x, y)
          break
        }
      }
    }
    return furniture
  }

  // === PLAZA FEATURES ===
  private placePlazaFeatures(
    w: number, h: number,
    center: { x: number; y: number }, plazaRadius: number,
    districts: District[],
    existingObjs: PlacedObject[],
    density: number, rng: () => number,
    roadMap: boolean[][], waterMap: boolean[][],
  ): PlacedObject[] {
    const props: PlacedObject[] = []
    // BUG FIX: was creating a blank occupied map, so fountains / statues /
    // market stalls / cafe tables in plaza features could land on roads or
    // water. Using createOccupied which marks both.
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, existingObjs, w, h)

    // Fountain at main center
    // THE GRAND fountain on the main square, if it fits. This is Lynch's NODE
    // — the one place in the town every path leads to — and it had the same
    // 2x2 fountain any district plaza gets. `fountain_grand` is a real variant
    // (`const grand = id === 'fountain_grand'` in PropFactory), it had never
    // been definable, and a bigger centrepiece is also a weenie: something to
    // walk toward down a street.
    //
    // AND IT HAS TO SEARCH, because the exact centre is never free. The town's
    // main streets radiate FROM this point — nine of them — so the centre tile
    // is a road junction, and createOccupied marks roads. Testing only
    // (center-1, center-1) meant the gate failed every single time: measured
    // across three towns, `fountain` placed ZERO. The central node of every
    // town this project has ever generated has been empty, silently, because
    // the one spot it was allowed to use was the one spot it could not have.
    //
    // A fountain beside the junction rather than in it is also just right.
    let placedFountain = false
    // Reach well past the square. The main streets all radiate from this
    // point, so within a few tiles of it they overlap into one solid mass of
    // road and there is no free 3x3 anywhere inside the plaza radius at all —
    // which is why the fountain placed zero times even when this pass ran
    // first. The square's usable ground starts where the roads separate.
    // BOUNDED to the square. Searching wider does find a free 3x3, but at
    // ring 11-15 — thirty to forty-five metres out, in a back lot. A grand
    // fountain that is not on the square is not a centrepiece, it is scatter
    // with a big footprint, and a town with no fountain is the better of the
    // two. If the square is genuinely full (a landmark took it) that is a
    // legitimate answer.
    const R = Math.floor(plazaRadius) + 2
    spiral:
    for (let r = 0; r <= R && !placedFountain; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue
          const fx = center.x - 1 + dx, fy = center.y - 1 + dy
          if (this.areaFree(occupied, fx, fy, 3, 3, w, h)) {
            props.push(this.createObj('fountain_grand', fx, fy))
            this.markArea(occupied, fx, fy, 3, 3, w, h)
            placedFountain = true
            break spiral
          }
        }
      }
    }
    if (placedFountain) rejected('plaza~grandOK')
    if (!placedFountain) {
      spiral2:
      for (let r = 0; r <= R; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue
            const fx = center.x - 1 + dx, fy = center.y - 1 + dy
            if (this.areaFree(occupied, fx, fy, 2, 2, w, h)) {
              props.push(this.createObj('fountain', fx, fy))
              this.markArea(occupied, fx, fy, 2, 2, w, h)
              placedFountain = true
              break spiral2
            }
          }
        }
      }
    }

    if (!placedFountain) rejected('plaza~noFountainAnywhere')
    // Two concentric rings around the fountain instead of a random
    // scatter. Inner ring: 8 cafe tables at cardinal/diagonal angles.
    // Outer ring: market stalls alternating with benches. Each prop's
    // facingY is set so the prop turns INWARD toward the fountain —
    // the whole plaza visually composes as a circle around the center.
    const innerR = Math.max(2, plazaRadius * 0.45)
    const outerR = Math.max(3, plazaRadius * 0.85)
    const placePlaza = (defId: string, cx: number, cy: number, fpW = 1, fpH = 1, facingY?: number) => {
      if (cx < 0 || cy < 0 || cx + fpW > w || cy + fpH > h) return false
      if (!this.areaFree(occupied, cx, cy, fpW, fpH, w, h)) return false
      const obj = this.createObj(defId, cx, cy)
      if (typeof facingY === 'number') obj.properties.facingY = facingY
      props.push(obj)
      this.markArea(occupied, cx, cy, fpW, fpH, w, h)
      return true
    }

    // Ring populations are derived from each ring's CIRCUMFERENCE, not from a
    // fixed count. Eight items looked right on a plaza that was eight units
    // across and leaves a 24m square almost bare — the same scale coupling as
    // everywhere else: a count tuned against tiles, spread over metres. One
    // item roughly every 2.5 tiles keeps the spacing a person would read as
    // "furnished" however big the square is.
    const ringCount = (r: number, spacingTiles: number) =>
      Math.max(6, Math.round((2 * Math.PI * r) / spacingTiles))

    // Inner ring — cafe tables + potted plants. facingY = ang + π so
    // the prop's local +Z (its "front") points back toward the fountain.
    const innerCount = ringCount(innerR, 2.2)
    for (let i = 0; i < innerCount; i++) {
      const ang = (i / innerCount) * Math.PI * 2
      const tx = Math.round(center.x + Math.cos(ang) * innerR)
      const ty = Math.round(center.y + Math.sin(ang) * innerR)
      const item = i % 3 === 0 ? 'potted_plant' : 'cafe_table'
      placePlaza(item, tx, ty, 1, 1, ang + Math.PI)
    }

    // MIDDLE ring — the gap between the two original rings is the widest
    // empty band in the town, and on a big plaza it is metres of bare paving.
    // Offset by half a step so it reads as a scatter rather than a third
    // concentric circle.
    const midR = (innerR + outerR) / 2
    const midCount = ringCount(midR, 2.8)
    const MID_ITEMS = ['barrel', 'crate', 'bench', 'potted_plant', 'wagon']
    for (let i = 0; i < midCount; i++) {
      const ang = ((i + 0.5) / midCount) * Math.PI * 2
      // Wobble the radius so the ring does not read as a drawn circle.
      const r = midR * (0.86 + rng() * 0.28)
      const mx = Math.round(center.x + Math.cos(ang) * r)
      const my = Math.round(center.y + Math.sin(ang) * r)
      const item = MID_ITEMS[Math.floor(rng() * MID_ITEMS.length)]
      placePlaza(item, mx, my, 1, 1, ang + Math.PI + (rng() - 0.5) * 0.8)
    }

    // Outer ring — market stalls (2x2) alternating with benches; same
    // inward facing so the canopies and bench backs all turn toward
    // the plaza center.
    const outerCount = ringCount(outerR, 2.4)
    for (let i = 0; i < outerCount; i++) {
      const ang = (i / outerCount) * Math.PI * 2
      const rx = Math.round(center.x + Math.cos(ang) * outerR)
      const ry = Math.round(center.y + Math.sin(ang) * outerR)
      // Alternate stalls with TENTS. The notes have said for a long time that
      // market districts read as plain row houses; a peaked cloth tent is the
      // single most legible "this is a market" object in the vocabulary, and
      // it had geometry the store never defined so it could never be placed.
      if (i % 2 === 0) {
        placePlaza(i % 4 === 0 ? 'market_tent' : 'market_stall', rx, ry, 2, 2, ang + Math.PI)
      }
      else placePlaza('bench', rx, ry, 2, 1, ang + Math.PI)
    }

    // One statue asymmetrically near the fountain — also faces the center.
    const statueAng = rng() * Math.PI * 2
    const sx = Math.round(center.x + Math.cos(statueAng) * (innerR * 0.55))
    const sy = Math.round(center.y + Math.sin(statueAng) * (innerR * 0.55))
    placePlaza('statue', sx, sy, 1, 1, statueAng + Math.PI)

    // District plaza features — richer per-district
    for (const d of districts) {
      switch (d.type) {
        case 'garden': {
          // Fountain + planter boxes around it
          const fx = d.center.x - 1, fy = d.center.y - 1
          if (this.areaFree(occupied, fx, fy, 2, 2, w, h)) {
            props.push(this.createObj('fountain', fx, fy))
            this.markArea(occupied, fx, fy, 2, 2, w, h)
          }
          // Planter ring
          for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]] as const) {
            const px = d.center.x + dx, py = d.center.y + dy
            if (px >= 0 && px + 1 < w && py >= 0 && py < h &&
                !occupied[py][px] && !occupied[py][px + 1]) {
              props.push(this.createObj('planter_box', px, py))
              occupied[py][px] = true; occupied[py][px + 1] = true
            }
          }
          break
        }
        case 'noble': {
          // Statue centerpiece + planter boxes around it
          if (!occupied[d.center.y]?.[d.center.x]) {
            props.push(this.createObj('statue', d.center.x, d.center.y))
            occupied[d.center.y][d.center.x] = true
          }
          for (let i = 0; i < 4; i++) {
            const px = d.center.x + Math.floor(rng() * 6) - 3
            const py = d.center.y + Math.floor(rng() * 6) - 3
            if (px >= 0 && px + 1 < w && py >= 0 && py < h &&
                !occupied[py][px] && !occupied[py][px + 1]) {
              props.push(this.createObj('planter_box', px, py))
              occupied[py][px] = true; occupied[py][px + 1] = true
            }
          }
          break
        }
        case 'temple': {
          // Multiple statues in temple plaza
          for (let i = 0; i < 3; i++) {
            const tx = d.center.x + Math.floor(rng() * 6) - 3
            const ty = d.center.y + Math.floor(rng() * 6) - 3
            if (tx >= 0 && tx < w && ty >= 0 && ty < h && !occupied[ty][tx]) {
              props.push(this.createObj('statue', tx, ty))
              occupied[ty][tx] = true
            }
          }
          // Wall lanterns
          for (let i = 0; i < 2; i++) {
            const lx = d.center.x + Math.floor(rng() * 4) - 2
            const ly = d.center.y + Math.floor(rng() * 4) - 2
            if (lx >= 0 && lx < w && ly >= 0 && ly < h && !occupied[ly][lx]) {
              props.push(this.createObj('wall_lantern', lx, ly))
              occupied[ly][lx] = true
            }
          }
          break
        }
        case 'residential': {
          // Well + benches
          const wx = d.center.x + Math.floor(rng() * 3) - 1
          const wy = d.center.y + Math.floor(rng() * 3) - 1
          if (wx >= 0 && wx < w && wy >= 0 && wy < h && !occupied[wy][wx]) {
            props.push(this.createObj('well', wx, wy))
            occupied[wy][wx] = true
            // Benches near well
            for (let i = 0; i < 2; i++) {
              const bx = wx + Math.floor(rng() * 4) - 1
              const by = wy + Math.floor(rng() * 3) - 1
              if (bx >= 0 && bx + 1 < w && by >= 0 && by < h &&
                  !occupied[by][bx] && !occupied[by][bx + 1]) {
                props.push(this.createObj('bench', bx, by))
                occupied[by][bx] = true; occupied[by][bx + 1] = true
              }
            }
          }
          break
        }
        case 'artisan': {
          // Crate and barrel clusters (workshop yards)
          for (let i = 0; i < 4; i++) {
            const cx = d.center.x + Math.floor(rng() * 6) - 3
            const cy = d.center.y + Math.floor(rng() * 6) - 3
            if (cx >= 0 && cx < w && cy >= 0 && cy < h && !occupied[cy][cx]) {
              props.push(this.createObj(rng() > 0.5 ? 'crate_stack' : 'barrel_stack', cx, cy))
              occupied[cy][cx] = true
            }
          }
          break
        }
        case 'market': {
          // Extra stalls + wagons in market district plazas
          for (let i = 0; i < 3; i++) {
            const mx = d.center.x + Math.floor(rng() * 6) - 3
            const my = d.center.y + Math.floor(rng() * 6) - 3
            if (this.areaFree(occupied, mx, my, 2, 2, w, h)) {
              props.push(this.createObj('market_stall', mx, my))
              this.markArea(occupied, mx, my, 2, 2, w, h)
            }
          }
          break
        }
        case 'waterfront': {
          // Barrels and crates along waterfront
          for (let i = 0; i < 4; i++) {
            const wx = d.center.x + Math.floor(rng() * 6) - 3
            const wy = d.center.y + Math.floor(rng() * 6) - 3
            if (wx >= 0 && wx < w && wy >= 0 && wy < h && !occupied[wy][wx]) {
              props.push(this.createObj(rng() > 0.5 ? 'barrel' : 'crate', wx, wy))
              occupied[wy][wx] = true
            }
          }
          break
        }
      }
    }

    return props
  }


  // === VEGETATION ===
  private placeVegetation(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    existingObjs: PlacedObject[],
    districtMap: number[][], districts: District[],
    density: number, rng: () => number, noise: SimplexNoise,
    heightMap?: number[][]
  ): PlacedObject[] {
    const vegetation: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, existingObjs, w, h)

    // THE RIVER OWNS ITS BANK. Reserve every tile touching water before the
    // generic scatter runs: dressWaterfront has already dressed it with reeds,
    // stones, mooring posts and goods, and whatever it deliberately left bare
    // is bare because a working quay is not a flowerbed. Without this the
    // forest sampler planted full-size trees and bushes on the lip of the
    // wharf — photographed twice, and it is precisely the "random" reading the
    // waterfront work is trying to remove. This is CITYPLAN's ownership rule:
    // a parcel emits its own props, and the global metric does not get a vote.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (waterMap[y][x]) continue
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          if (waterMap[y + dy]?.[x + dx]) { occupied[y][x] = true; break }
        }
      }
    }

    // Tighter Poisson so forest cores can actually get dense; the forest-
    // mask below decides whether each sampled point GETS a tree, so we
    // don't end up with uniform spacing across the whole map.
    const minDist = Math.max(1.2, 3 - density * 2)
    const points = poissonDiskSampling(w, h, minDist, rng)

    // Forest-mask parameters — low-frequency noise carves large regions of
    // "forest" vs "clearing" across the map. Frequency 0.042 → ~1 cycle
    // per 25 tiles, so a 48-tile map gets 1–2 big forests and matching
    // clearings. Per-district thresholds scale how much of that mask
    // actually produces trees: gardens are dense everywhere, slums only
    // in the tallest peaks of the mask.
    const forestFreq = 0.042
    const forestOffset = 123
    // Smoothstep helper for density gradient at the forest edge.
    const smoothstep = (edge0: number, edge1: number, x: number): number => {
      const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
      return t * t * (3 - 2 * t)
    }

    for (const p of points) {
      const tx = Math.floor(p.x), ty = Math.floor(p.y)
      if (tx < 0 || tx >= w || ty < 0 || ty >= h || occupied[ty][tx]) continue

      const dId = districtMap[ty]?.[tx] ?? -1
      const district = districts.find(d => d.id === dId)
      // Old near-neighbor noise used for species selection stays; the new
      // forest mask drives placement probability.
      const forestNoise = noise.fbm(tx * forestFreq + forestOffset, ty * forestFreq + forestOffset, 3, 2, 0.5)

      // Per-district forest-mask tuning:
      //   threshold: forestNoise value below which no trees grow
      //   feather:   how far above threshold before density hits max
      //   densityMult: ceiling on placement probability (0..1)
      //   treeProb:   P(tree | placed) — complement are bushes
      let threshold = 0.1, feather = 0.35, densityMult = 0.85, treeProb = 0.65
      if (district) {
        switch (district.type) {
          case 'garden':
            threshold = -0.4; feather = 0.6; densityMult = 1.0; treeProb = 0.45
            // Garden-specific planter / potted plant interleave, unchanged
            if (forestNoise > -0.3 && rng() > 0.8) {
              const gardenProp = rng() > 0.5 ? 'potted_plant' : 'planter_box'
              const fp = this.getFootprint(gardenProp)
              if (fp.w === 1 || this.areaFree(occupied, tx, ty, fp.w, fp.h, w, h)) {
                vegetation.push(this.createObj(gardenProp, tx, ty))
                if (fp.w > 1) this.markArea(occupied, tx, ty, fp.w, fp.h, w, h)
                else occupied[ty][tx] = true
                continue
              }
            }
            break
          case 'noble':
            threshold = 0.0; feather = 0.4; densityMult = 0.9; treeProb = 0.55
            break
          case 'residential':
            threshold = 0.05; feather = 0.4; densityMult = 0.8
            break
          case 'slum':
            threshold = 0.3; feather = 0.3; densityMult = 0.6; treeProb = 0.3
            break
          case 'waterfront':
            threshold = 0.1; feather = 0.4; densityMult = 0.85
            break
          case 'cemetery':
            // Scattered leaning trees — sparse but present
            threshold = 0.15; feather = 0.3; densityMult = 0.6
            break
          case 'harbor':
            threshold = 0.25; feather = 0.3; densityMult = 0.5
            break
          case 'fortress':
            threshold = 0.3; feather = 0.3; densityMult = 0.4
            break
          case 'temple':
            threshold = 0.1; feather = 0.4; densityMult = 0.8
            break
          default:
            threshold = 0.1 - density * 0.15
            break
        }
      } else {
        // Countryside (unassigned tiles) — the loosest mask, this is
        // where forests and meadows really get to breathe.
        threshold = -0.1; feather = 0.5; densityMult = 1.0
      }

      // Soft-edge forest mask: density 0 at threshold → densityMult at
      // threshold+feather. Reject by random roll so edges naturally thin.
      const placeChance = smoothstep(threshold, threshold + feather, forestNoise) * densityMult
      const shouldPlace = rng() < placeChance
      const isTree = rng() < treeProb

      if (shouldPlace) {
        if (isTree) {
          const treeObj = this.createObj('tree', tx, ty)
          // Species selection based on district, elevation, and noise
          const elev = heightMap?.[ty]?.[tx] ?? 0
          const speciesNoise = noise.noise2D(tx * 0.3 + 200, ty * 0.3 + 200)
          let species: string
          if (district?.type === 'garden' || district?.type === 'noble') {
            species = speciesNoise > 0.3 ? 'maple' : speciesNoise > -0.2 ? 'birch' : 'oak'
          } else if (elev > 1.2) {
            species = speciesNoise > 0 ? 'pine' : 'oak' // Conifers on heights
          } else if (this.hasNearbyWater(tx, ty, waterMap, w, h, 3)) {
            species = speciesNoise > 0.2 ? 'willow' : 'birch' // Willows near water
          } else {
            species = speciesNoise > 0.4 ? 'pine' : speciesNoise > 0 ? 'birch' : speciesNoise > -0.3 ? 'oak' : 'maple'
          }
          treeObj.properties = { species }
          vegetation.push(treeObj)
        } else {
          vegetation.push(this.createObj('bush', tx, ty))
        }
        occupied[ty][tx] = true
      }
    }

    // Tree-lined boulevards: trees along wider roads (every 2 tiles)
    for (let y = 2; y < h - 2; y += 2) {
      for (let x = 2; x < w - 2; x += 2) {
        if (!roadMap[y][x]) continue
        let roadCount = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (roadMap[y + dy]?.[x + dx]) roadCount++
          }
        }
        if (roadCount < 4) continue // Need at least a medium-width road

        for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]] as const) {
          const tx = x + dx, ty = y + dy
          if (tx >= 0 && tx < w && ty >= 0 && ty < h &&
              !roadMap[ty][tx] && !occupied[ty][tx] && !waterMap[ty][tx]) {
            vegetation.push(this.createObj('tree', tx, ty))
            occupied[ty][tx] = true
            break
          }
        }
      }
    }

    // Hedgerows in noble districts — bushes along road edges every 2 tiles
    for (const d of districts) {
      if (d.type !== 'noble') continue
      for (let y = d.center.y - d.radius; y < d.center.y + d.radius; y += 2) {
        for (let x = d.center.x - d.radius; x < d.center.x + d.radius; x += 2) {
          if (x < 0 || x >= w || y < 0 || y >= h) continue
          if (occupied[y][x] || roadMap[y][x] || waterMap[y][x]) continue
          const dId = districtMap[y]?.[x]
          if (dId !== d.id) continue
          // Only along road edges
          if (!this.isRoadAdjacent(x, y, roadMap, w, h)) continue
          vegetation.push(this.createObj('bush', x, y))
          occupied[y][x] = true
        }
      }
    }

    // Lush riverbank vegetation — trees and bushes along water edges
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        if (waterMap[y][x] || occupied[y][x] || roadMap[y][x]) continue
        // Check if adjacent to water
        let nearWater = false
        for (let dy = -1; dy <= 1 && !nearWater; dy++) {
          for (let dx = -1; dx <= 1 && !nearWater; dx++) {
            if (waterMap[y + dy]?.[x + dx]) nearWater = true
          }
        }
        if (!nearWater) continue
        if (rng() > 0.4) continue // 40% chance per eligible tile
        vegetation.push(this.createObj(rng() > 0.4 ? 'tree' : 'bush', x, y))
        occupied[y][x] = true
      }
    }

    return vegetation
  }

  // === HIDDEN PASSAGES & GARDEN COURTYARDS ===
  // Parisian covered passages that open into Kyoto-inspired tsuboniwa (courtyard gardens)
  private carveHiddenPassages(
    terrain: number[][], roadMap: boolean[][], waterMap: boolean[][], heightMap: number[][],
    buildings: PlacedObject[], districtMap: number[][], districts: District[],
    w: number, h: number, rng: () => number, noise: SimplexNoise
  ): PlacedObject[] {
    const courtProps: PlacedObject[] = []
    const buildingMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (const b of buildings) {
      const fp = (b.footprint ?? this.getFootprint(b.definitionId))
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const bx = b.x + dx, by = b.y + dy
          if (bx < w && by < h) buildingMap[by][bx] = true
        }
      }
    }

    const courtyardsPlaced = new Set<string>()
    const maxCourtyards = Math.floor(3 + districts.length * 1.5)

    // Search for potential hidden courtyard sites
    for (let attempt = 0; attempt < 200 && courtyardsPlaced.size < maxCourtyards; attempt++) {
      const sx = 4 + Math.floor(rng() * (w - 10))
      const sy = 4 + Math.floor(rng() * (h - 10))
      const key = `${Math.floor(sx / 5)},${Math.floor(sy / 5)}`
      if (courtyardsPlaced.has(key)) continue

      // Need a 3x3 clear area surrounded by buildings on at least 3 sides
      let clearArea = true
      for (let dy = 0; dy < 3 && clearArea; dy++) {
        for (let dx = 0; dx < 3 && clearArea; dx++) {
          if (buildingMap[sy + dy]?.[sx + dx] || waterMap[sy + dy]?.[sx + dx] || roadMap[sy + dy]?.[sx + dx]) {
            clearArea = false
          }
        }
      }
      if (!clearArea) continue

      // Count surrounding building walls
      let wallSides = 0
      // Top wall
      let topWall = false
      for (let dx = 0; dx < 3; dx++) { if (buildingMap[sy - 1]?.[sx + dx]) topWall = true }
      // Bottom wall
      let botWall = false
      for (let dx = 0; dx < 3; dx++) { if (buildingMap[sy + 3]?.[sx + dx]) botWall = true }
      // Left wall
      let leftWall = false
      for (let dy = 0; dy < 3; dy++) { if (buildingMap[sy + dy]?.[sx - 1]) leftWall = true }
      // Right wall
      let rightWall = false
      for (let dy = 0; dy < 3; dy++) { if (buildingMap[sy + dy]?.[sx + 3]) rightWall = true }
      wallSides = (topWall ? 1 : 0) + (botWall ? 1 : 0) + (leftWall ? 1 : 0) + (rightWall ? 1 : 0)

      if (wallSides < 3) continue

      courtyardsPlaced.add(key)

      // Determine courtyard style based on district
      const dId = districtMap[sy + 1]?.[sx + 1] ?? -1
      const district = districts.find(d => d.id === dId)
      const dType = district?.type || 'residential'

      // Paint courtyard ground — Kyoto-inspired varied surfaces
      for (let dy = 0; dy < 3; dy++) {
        for (let dx = 0; dx < 3; dx++) {
          const tx = sx + dx, ty = sy + dy
          if (tx >= w || ty >= h) continue
          if (dType === 'noble' || dType === 'temple') {
            terrain[ty][tx] = 2 // stone (zen garden feel)
          } else if (dType === 'garden') {
            terrain[ty][tx] = (dx + dy) % 2 === 0 ? 0 : 5 // grass/dark grass mosaic
          } else {
            terrain[ty][tx] = (dx === 1 && dy === 1) ? 2 : 8 // cobble with stone center
          }
        }
      }

      // Place courtyard features based on style
      const cx = sx + 1, cy2 = sy + 1 // center of courtyard
      if (dType === 'garden' || dType === 'noble') {
        // Kyoto tsuboniwa: tree + potted plants
        courtProps.push(this.createObj('tree', cx, cy2))
        if (sx < w && !buildingMap[sy][sx]) {
          courtProps.push(this.createObj('potted_plant', sx, sy))
        }
        if (sx + 2 < w && sy + 2 < h && !buildingMap[sy + 2][sx + 2]) {
          courtProps.push(this.createObj('potted_plant', sx + 2, sy + 2))
        }
      } else if (dType === 'temple') {
        // Zen: statue center + lanterns
        courtProps.push(this.createObj('statue', cx, cy2))
        if (!buildingMap[sy][sx]) courtProps.push(this.createObj('wall_lantern', sx, sy))
        if (sx + 2 < w && !buildingMap[sy][sx + 2]) courtProps.push(this.createObj('wall_lantern', sx + 2, sy))
      } else if (dType === 'market' || dType === 'artisan') {
        // Workshop yard: well + barrels
        courtProps.push(this.createObj('well', cx, cy2))
        if (!buildingMap[sy][sx]) courtProps.push(this.createObj('barrel_stack', sx, sy))
      } else {
        // Residential: well + bench
        courtProps.push(this.createObj('well', cx, cy2))
        if (sx + 2 < w && sy + 2 < h) {
          courtProps.push(this.createObj('bench', sx, sy + 2))
        }
      }

      // Carve the passage — a 1-tile-wide opening through the open wall side
      const openSide = !topWall ? 'top' : !botWall ? 'bottom' : !leftWall ? 'left' : 'right'
      let px: number, py: number
      switch (openSide) {
        case 'top':    px = sx + 1; py = sy - 1; break
        case 'bottom': px = sx + 1; py = sy + 3; break
        case 'left':   px = sx - 1; py = sy + 1; break
        case 'right':  px = sx + 3; py = sy + 1; break
      }
      // Paint passage tiles. buildingMap is built at the top of this method
      // but was never consulted here, so a passage could be painted straight
      // onto a building's footprint — which then reads (correctly) as a
      // building standing in an alley.
      if (px >= 0 && px < w && py >= 0 && py < h && !buildingMap[py][px]) {
        terrain[py][px] = 9 // dark cobblestone (narrow passage)
      }
    }

    return courtProps
  }

  // === TOWN WALLS ===
  private placeWalls(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    buildings: PlacedObject[], gates: PlacedObject[],
    rng: () => number,
    /** Terrain, because carveAlleys paints alley tiles (9) between buildings
     *  WITHOUT registering them in roadMap — so a roadMap-only check happily
     *  walled off an alley. */
    terrain?: number[][],
    /** Things the wall must not be built ON but must not open a GATEWAY for
     *  either. Bridges: their landing tile on the far bank is plain ground —
     *  not road, not water — so nothing else stopped a wall segment being
     *  laid across the end of one. Kept apart from `gates` because that
     *  parameter also punches a clearance hole, and five bridge-sized holes
     *  would undo the wall continuity the site audit measures. */
    noBuild: PlacedObject[] = [],
  ): PlacedObject[] {
    const paved = (x: number, y: number): boolean => {
      return isCirculation(terrain?.[y]?.[x])
    }
    const walls: PlacedObject[] = []
    if (buildings.length < 10) return walls

    // Find bounding box of all buildings with margin
    let minX = w, minY = h, maxX = 0, maxY = 0
    for (const b of buildings) {
      const fp = (b.footprint ?? this.getFootprint(b.definitionId))
      minX = Math.min(minX, b.x)
      minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + fp.w)
      maxY = Math.max(maxY, b.y + fp.h)
    }
    // Add margin
    minX = Math.max(1, minX - 2)
    minY = Math.max(1, minY - 2)
    maxX = Math.min(w - 2, maxX + 2)
    maxY = Math.min(h - 2, maxY + 2)

    const gateSet = new Set(gates.map(g => `${g.x},${g.y}`))
    // Clearance around a gate, in tiles. A town_gate is 3 wide, so 2 is
    // enough to keep masonry off it.
    //
    // This was 4, which excludes a 7x7 box per gate. That was survivable when
    // the gate cap was four; raising the cap to eight so that roads out of
    // town terminate on a gatehouse turned it into up to a third of the whole
    // perimeter, and the wall came out 53% gaps. A fix in one pass quietly
    // undermining another is the hazard of a pipeline with no hierarchy —
    // which is the thing CITYPLAN is about.
    const GATE_CLEARANCE = 2
    const isGateNear = (x: number, y: number): boolean => {
      for (const g of gates) {
        if (Math.abs(g.x - x) < GATE_CLEARANCE && Math.abs(g.y - y) < GATE_CLEARANCE) return true
      }
      return false
    }

    // Place walls along perimeter.
    // Horizontal edges (top/bottom) use stone_wall (fp 2x1, runs along X).
    // Vertical edges (left/right) use stone_wall_v (fp 1x2, runs along Y).
    // Both route to tmplWallSegment which renders a 2.2-tall crenellated
    // fortification — not a garden wall.
    const occupied = new Set<string>()
    // Seed with every existing building/landmark tile. The buildings list was
    // previously used ONLY for the bounding box above, so wall runs plowed
    // straight through whatever stood on the perimeter — chapels, cathedrals
    // and towers were the most-overlapped objects in the whole town.
    for (const b of buildings) {
      const bfp = (b.footprint ?? this.getFootprint(b.definitionId))
      for (let dy = 0; dy < bfp.h; dy++) {
        for (let dx = 0; dx < bfp.w; dx++) occupied.add(`${b.x + dx},${b.y + dy}`)
      }
    }

    // Gates occupy real rectangles, so test the rectangle. The clearance box
    // below is a proxy for "don't crowd the gate" and it is not a substitute:
    // a town_gate is 3 wide, so a symmetric +/-2 test lets a wall start at
    // gate.x + 2 and overlap the gate's own third tile. That shipped as one
    // placement error on seed 11, and the lesson is the usual one — a
    // distance heuristic standing in for a footprint test will be wrong in
    // whichever direction you did not picture.
    for (const g of gates) {
      const gfp = (g.footprint ?? this.getFootprint(g.definitionId))
      for (let dy = 0; dy < gfp.h; dy++) {
        for (let dx = 0; dx < gfp.w; dx++) occupied.add(`${g.x + dx},${g.y + dy}`)
      }
    }

    for (const b of noBuild) {
      const bfp = (b.footprint ?? this.getFootprint(b.definitionId))
      for (let dy = 0; dy < bfp.h; dy++) {
        for (let dx = 0; dx < bfp.w; dx++) occupied.add(`${b.x + dx},${b.y + dy}`)
      }
    }

    // A wall segment covers TWO tiles, so both must be clear of buildings,
    // water and streets. Roads are left open (that is where a gate belongs) —
    // roadMap was passed in but never consulted, so walls sealed off streets.
    const placeHorizontalWall = (x: number, y: number) => {
      if (x < 0 || x + 1 >= w || y < 0 || y >= h) return
      if (occupied.has(`${x},${y}`) || occupied.has(`${x + 1},${y}`)) return
      if (waterMap[y]?.[x] || waterMap[y]?.[x + 1]) return
      if (roadMap[y]?.[x] || roadMap[y]?.[x + 1]) return
      if (paved(x, y) || paved(x + 1, y)) return
      if (isGateNear(x, y)) return
      occupied.add(`${x},${y}`)
      occupied.add(`${x + 1},${y}`)
      walls.push(this.createObj('stone_wall', x, y, 0.3))
    }
    const placeVerticalWall = (x: number, y: number) => {
      if (x < 0 || x >= w || y < 0 || y + 1 >= h) return
      if (occupied.has(`${x},${y}`) || occupied.has(`${x},${y + 1}`)) return
      if (waterMap[y]?.[x] || waterMap[y + 1]?.[x]) return
      if (roadMap[y]?.[x] || roadMap[y + 1]?.[x]) return
      if (paved(x, y) || paved(x, y + 1)) return
      if (isGateNear(x, y)) return
      occupied.add(`${x},${y}`)
      occupied.add(`${x},${y + 1}`)
      walls.push(this.createObj('stone_wall_v', x, y, 0.3))
    }

    // Reserve the 2×2 corner tower footprints FIRST so wall segments
    // don't collide with them (the old code placed walls first, corner
    // towers second → overlap + gaps at corners).
    const cornerPositions = [
      { x: minX, y: minY },
      { x: maxX - 2, y: minY },
      { x: minX, y: maxY - 2 },
      { x: maxX - 2, y: maxY - 2 },
    ]
    for (const pos of cornerPositions) {
      if (pos.x < 0 || pos.x + 1 >= w || pos.y < 0 || pos.y + 1 >= h) continue
      if (waterMap[pos.y][pos.x]) continue
      // Corner towers are 2x2 — skip if anything already stands there.
      let blocked = false
      for (let dy = 0; dy < 2 && !blocked; dy++) {
        for (let dx = 0; dx < 2 && !blocked; dx++) {
          if (occupied.has(`${pos.x + dx},${pos.y + dy}`)) blocked = true
          if (roadMap[pos.y + dy]?.[pos.x + dx]) blocked = true
          if (paved(pos.x + dx, pos.y + dy)) blocked = true
        }
      }
      if (blocked) continue
      walls.push(this.createObj('watchtower', pos.x, pos.y, 1.0))
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          occupied.add(`${pos.x + dx},${pos.y + dy}`)
        }
      }
    }

    // Now place walls between the corner towers. Walls step by 2 tiles
    // (matching stone_wall footprint 2x1 / stone_wall_v footprint 1x2).
    for (let x = minX + 2; x < maxX - 2; x += 2) {
      placeHorizontalWall(x, minY)
      placeHorizontalWall(x, maxY - 1)
    }
    for (let y = minY + 2; y < maxY - 2; y += 2) {
      placeVerticalWall(minX, y)
      placeVerticalWall(maxX - 1, y)
    }

    return walls
  }

  // === COUNTRYSIDE ===
  private placeCountryside(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    districtMap: number[][], terrainTiles: number[][],
    buildings: PlacedObject[], gates: PlacedObject[],
    /** Props placed by every earlier pass. This is the last placer in the
     *  chain and it used to see none of them, so its road markers — laid
     *  along the exit roads, exactly where street lighting and kerbside
     *  dressing already are — stacked on lampposts and barrels. */
    existingProps: PlacedObject[],
    noise: SimplexNoise, rng: () => number
  ): PlacedObject[] {
    const countryside: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, buildings, w, h)
    this.markObjects(occupied, existingProps, w, h)

    // Paint countryside terrain (unassigned tiles)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (districtMap[y][x] !== -1 || waterMap[y][x] || roadMap[y][x]) continue
        const n = noise.fbm(x * 0.08, y * 0.08, 2)
        terrainTiles[y][x] = n > 0.2 ? 1 : n > -0.1 ? 0 : 5 // dirt/grass/dark grass
      }
    }

    // Place windmills in open countryside
    let windmills = 0
    for (let attempt = 0; attempt < 50 && windmills < 2; attempt++) {
      const wx = Math.floor(rng() * (w - 6)) + 2
      const wy = Math.floor(rng() * (h - 6)) + 2
      if (districtMap[wy]?.[wx] !== -1) continue
      if (this.areaFree(occupied, wx, wy, 3, 3, w, h)) {
        countryside.push(this.createObj('windmill', wx, wy, 0))
        this.markArea(occupied, wx, wy, 3, 3, w, h)
        windmills++
      }
    }

    // Place farm fields near roads in countryside
    let farms = 0
    for (let attempt = 0; attempt < 80 && farms < 3; attempt++) {
      const fx = Math.floor(rng() * (w - 6)) + 2
      const fy = Math.floor(rng() * (h - 5)) + 2
      if (districtMap[fy]?.[fx] !== -1) continue
      if (!this.isRoadAdjacent(fx, fy, roadMap, w, h)) continue
      if (this.areaFree(occupied, fx, fy, 4, 3, w, h)) {
        countryside.push(this.createObj('farm_field', fx, fy, 0))
        this.markArea(occupied, fx, fy, 4, 3, w, h)
        farms++
      }
    }

    // Scatter orchard trees in groups
    for (let g = 0; g < 4; g++) {
      const gx = Math.floor(rng() * (w - 4)) + 2
      const gy = Math.floor(rng() * (h - 4)) + 2
      if (districtMap[gy]?.[gx] !== -1) continue
      for (let i = 0; i < 3 + Math.floor(rng() * 3); i++) {
        const tx = gx + Math.floor(rng() * 4)
        const ty = gy + Math.floor(rng() * 4)
        if (tx < w && ty < h && !occupied[ty][tx] && districtMap[ty]?.[tx] === -1) {
          countryside.push(this.createObj('orchard_tree', tx, ty, 0))
          occupied[ty][tx] = true
        }
      }
    }

    // Road markers along exit roads
    for (const gate of gates) {
      for (let d = 2; d < 6; d++) {
        const mx = gate.x + (gate.x < w / 2 ? -d : d)
        const my = gate.y
        if (mx >= 0 && mx < w && my >= 0 && my < h && !occupied[my][mx]) {
          // Every so often the marker is a STANDING STONE instead — older
          // than the road it now marks, which is the kind of thing that makes
          // a landscape feel like it has a past. Its own branch in the stone
          // builder (`if (id === 'standing_stone')`), never definable until
          // now, so it has never once appeared.
          // A MILESTONE is the third face of the same idea and it was already
          // modelled — PropFactory has drawn one all along and the store
          // defined nothing, so it could never be placed. A carved stone
          // counting the distance to somewhere else is exactly what belongs
          // on the road OUT of a town, and it says the town has a somewhere
          // else to be counted from.
          const r = rng()
          countryside.push(this.createObj(
            r < 0.22 ? 'standing_stone' : r < 0.48 ? 'milestone' : 'road_marker',
            mx, my, 0))
          occupied[my][mx] = true
          break
        }
      }
    }

    return countryside
  }

  /**
   * What does THIS building put on THIS side of itself?
   *
   * Measured, 90% of props already sat on some building's perimeter but only
   * 29% sat on a building that would plausibly own them. Adjacency was there;
   * meaning was not. The cause is that `getBuildingSpecificProps` returns an
   * empty list for every ordinary dwelling — and row houses are 40% of the
   * town — so 205 of one seed's props were drawn from the district palette at
   * random and then parked against the nearest wall. A fountain against a
   * cottage is still scatter; it is scatter with an alibi.
   *
   * Two axes decide it. WHAT the building is, and WHICH SIDE you are on: a
   * household shows the street a flower box and a swept step, and keeps the
   * woodpile, the rain barrel and the washing round the back. That split is
   * most of what "lived in" means — the front is presented, the back is used
   * — and the placer already knows which side a spot is on, because it sorts
   * frontage spots ahead of back ones so dressing lands where players walk.
   */
  /**
   * Place a whole vignette anchored on `spot`, or report that none fitted.
   *
   * Parts after the first take tiles from the SAME building's remaining
   * perimeter pool, which is what keeps them owned — a part that wandered onto
   * a neighbour's frontage would read as somebody else's clutter and would
   * score against tenancy rather than for it. Consuming from `pool` also stops
   * the outer loop handing the same tile to a second prop.
   *
   * All-or-nothing: a two-part group with one part placed is just a prop, and
   * a three-part group missing its cart is a pile of crates in the road.
   */
  private tryVignette(
    spot: { x: number; y: number }, front: boolean, dType: DistrictType,
    defId: string,
    streetSpots: Array<{ x: number; y: number }>,
    backSpots: Array<{ x: number; y: number }>, occupied: boolean[][],
    props: PlacedObject[], bcx: number, bcy: number,
    w: number, h: number, rng: () => number
  ): boolean {
    // TALLY THE CLAUSE THAT REJECTED IT, not just the ones that passed. Four
    // vignettes fired exactly zero times across two seeds and guessing why was
    // already wrong twice — a counting metric buys guesses, an explaining one
    // buys the answer.
    rejected(`vig~roll:${dType}:${front ? 'front' : 'back'}`)
    const home = DWELLINGS.has(defId)
    const fits = VIGNETTES.filter(v =>
      (v.front === null || v.front === front) &&
      (!v.home || home) &&
      (!v.districts || v.districts.includes(dType)))
    if (!fits.length) { rejected(`vig~noFit:${dType}:${home ? 'home' : defId}`); return false }
    const v = fits[Math.floor(rng() * fits.length)]

    // Claim the anchor plus one adjacent perimeter tile per extra part.
    //
    // Searched across the WHOLE perimeter, not just the pool the anchor came
    // from. The first cut restricted parts to the same pool and the census
    // caught it immediately: 47 props in a vignette out of 356, and every
    // street-side group — doorstep, delivery, stallside, quaygear — firing
    // exactly zero times, because a terraced house presents one or two tiles
    // to the street while its whole rear is free. The SIDE the anchor is on
    // should decide which group belongs there; it should not also decide how
    // much room the group has. Every part still lands on this building's own
    // perimeter, which is what keeps it owned.
    const need = v.parts.length - 1
    const free = (t: { x: number; y: number }): boolean =>
      t.x >= 0 && t.y >= 0 && t.x < w && t.y < h && !occupied[t.y][t.x]
    if (!free(spot)) return false
    // CLAIM EVERY TILE AS IT IS CHOSEN, AND START BY CLAIMING THE ANCHOR.
    //
    // `near` used to be a filter over the perimeter, evaluated once, before
    // anything was placed — so `free()` was true for every candidate at the
    // moment it was tested and two parts could be handed the same tile. The
    // anchor was the guaranteed case rather than the unlucky one: it is still
    // in streetSpots/backSpots when this runs (the caller splices it only on
    // SUCCESS) and `|dx| <= 1 && |dy| <= 1` includes dx = dy = 0, so part two
    // sat on part one. 49 prop-stacked warnings a town, every reported pair a
    // vignette pair — planter_box on flower_bed, crate on forge_brazier.
    //
    // A running claim set makes both impossible by construction instead of by
    // two separate guards, and it also covers a coordinate appearing twice in
    // the perimeter lists, which no amount of anchor-excluding would have.
    const claimed = new Set<string>([`${spot.x},${spot.y}`])
    const near: Array<{ x: number; y: number }> = []
    for (const t of [...streetSpots, ...backSpots]) {
      if (near.length >= need) break
      const key = `${t.x},${t.y}`
      if (claimed.has(key) || !free(t)) continue
      if (Math.abs(t.x - spot.x) > 1 || Math.abs(t.y - spot.y) > 1) continue
      claimed.add(key)
      near.push(t)
    }
    if (near.length < need) { rejected(`vig~noRoom:${v.id}`); return false }

    // A PART MAY OFFER ALTERNATIVES, written 'crate|barrel|rubble_pile' and
    // chosen per instance. Pillar 2 asks that the eye never be able to
    // copy-paste one thing onto another, and a group repeated verbatim beside
    // forty houses is that failure at arrangement scale rather than silhouette
    // scale — the woodpile always had exactly one crate next to it. One line
    // here buys the whole table variation, and it keeps the alternatives
    // visible where a reader is already looking at what the group means.
    const place = (id: string, t: { x: number; y: number }): void => {
      const obj = this.createObj(id, t.x, t.y)
      obj.properties.facingY = Math.atan2((t.y + 0.5) - bcy, (t.x + 0.5) - bcx) + Math.PI
      // Every part carries the group it belongs to, so a census can ask which
      // vignettes actually fire — the ghost check this repo needs on any new
      // gated content, before anyone claims the feature exists.
      obj.properties.vignette = v.id
      props.push(obj)
      const f = this.getFootprint(id)
      if (f.w === 1 && f.h === 1) occupied[t.y][t.x] = true
      else this.markArea(occupied, t.x, t.y, f.w, f.h, w, h)
    }

    // RESOLVE AND VALIDATE EVERY PART BEFORE PLACING ANY OF THEM.
    //
    // The first cut assumed one part meant one tile, marked a single cell
    // occupied and moved on. picket_fence is 2x1 — the single-prop path
    // beside this one has always checked areaFree for anything bigger than a
    // tile, and this one did not, so a fence would have been drawn across a
    // neighbour's tile while the map believed that tile was free. Silent, and
    // exactly the class of overlap the placement audit exists to catch.
    //
    // Validated up front because the group is all-or-nothing: discovering the
    // third part does not fit after placing the first two leaves a pile of
    // crates in the road with no cart.
    const tiles = [spot, ...near]
    // TRY THE ALTERNATIVES BEFORE GIVING UP. Many props are 2x1 — bench,
    // cloth_line, picket_fence — so requiring the first roll to fit rejected
    // whole groups on a tile that a different, equally good part would have
    // sat on: doorstep lost 9 and washday 8 in one town. The `|` options exist
    // to vary the group, and they serve just as well as room to manoeuvre.
    // A multi-tile part is tested against `occupied` AND against the tiles
    // this group has already spoken for. `occupied` cannot know about them —
    // nothing is placed until every part has been resolved — so validating
    // against it alone lets a 2x1 second part reach back over its own anchor.
    // Same defect as the one the claim set above fixes, one level down: a
    // check evaluated before the writes it is supposed to be protecting
    // against.
    const taken = new Set<string>()
    const chosen: string[] = []
    for (let k = 0; k < v.parts.length; k++) {
      const opts = v.parts[k].split('|')
      // Start at a random option so the fallback order does not itself become
      // a bias toward whichever part happens to be listed first.
      const off = Math.floor(rng() * opts.length)
      let ok: string | null = null
      let okTiles: string[] = []
      for (let j = 0; j < opts.length; j++) {
        const cand = opts[(off + j) % opts.length]
        const f = this.getFootprint(cand)
        const t = tiles[k]
        if (f.w > 1 || f.h > 1) {
          if (!this.areaFree(occupied, t.x, t.y, f.w, f.h, w, h)) continue
        }
        const cells: string[] = []
        for (let dy = 0; dy < f.h; dy++) {
          for (let dx = 0; dx < f.w; dx++) cells.push(`${t.x + dx},${t.y + dy}`)
        }
        if (cells.some(c => taken.has(c))) continue
        ok = cand; okTiles = cells; break
      }
      if (!ok) { rejected(`vig~noFootprint:${v.id}`); return false }
      for (const c of okTiles) taken.add(c)
      chosen.push(ok)
    }

    rejected(`vigOk:${v.id}`)
    place(chosen[0], spot)
    for (let k = 0; k < need; k++) {
      place(chosen[k + 1], near[k])
      for (const pl of [streetSpots, backSpots]) {
        const idx = pl.indexOf(near[k])
        if (idx >= 0) pl.splice(idx, 1)
      }
    }
    return true
  }

  private propForRole(
    defId: string, dType: DistrictType, front: boolean,
    palette: string[], rng: () => number
  ): string {
    if (!DWELLINGS.has(defId)) {
      return palette[Math.floor(rng() * palette.length)]
    }
    // Presented to the street, versus used out of sight. Weighted by
    // repetition rather than a weight table, matching how the palettes above
    // already express preference.
    let list: string[]
    if (front) {
      switch (dType) {
        case 'noble':
          list = ['planter_box', 'potted_plant', 'flower_box', 'bench',
            'wall_lantern', 'iron_fence']; break
        case 'slum':
          list = ['barrel', 'crate', 'woodpile', 'rain_barrel', 'rubble_pile']; break
        case 'garden':
          list = ['flower_box', 'flower_bed', 'planter_box', 'potted_plant',
            'trellis_arch', 'bush']; break
        case 'market':
        case 'harbor':
        case 'waterfront':
          list = ['crate', 'barrel', 'sign', 'flower_box', 'bench']; break
        default:
          list = ['flower_box', 'potted_plant', 'planter_box', 'bench',
            'wall_lantern', 'flower_box']
      }
    } else {
      switch (dType) {
        case 'noble':
          list = ['planter_box', 'garden_arch', 'bush', 'woodpile', 'rain_barrel']; break
        case 'slum':
          list = ['rubble_pile', 'woodpile', 'barrel', 'crate', 'cloth_line']; break
        case 'garden':
          list = ['bush', 'flower_bed', 'woodpile', 'rain_barrel', 'trellis_arch']; break
        // A working quarter has a working back yard. These fell through to the
        // default and it showed: `woodpile` came out top-five in the fortress,
        // the waterfront AND the harbour, so a dockside back lane was dressed
        // exactly like a suburban one. The front of these districts already
        // differentiates well — nine distinct prop signatures across nine
        // quarters — and the back was the half nobody had varied.
        case 'harbor':
        case 'waterfront':
          list = ['rope_coil', 'fish_rack', 'crate_stack', 'barrel_stack',
            'crate', 'rain_barrel']; break
        case 'market':
          list = ['crate_stack', 'crate', 'barrel_stack', 'barrel', 'cloth_line',
            'rain_barrel']; break
        case 'artisan':
          list = ['woodpile', 'barrel_stack', 'crate', 'rubble_pile',
            'rain_barrel', 'cart']; break
        default:
          list = ['woodpile', 'rain_barrel', 'cloth_line', 'crate', 'barrel',
            'fence', 'woodpile']
      }
    }
    return list[Math.floor(rng() * list.length)]
  }

  /**
   * How tall does a building in THIS district want to be?
   *
   * Lynch's DISTRICT is legible only if you can tell from inside which one you
   * are standing in, and height is one of the three things a player actually
   * perceives. Measured, six districts shared TWO distinct median heights:
   * every quarter was 2 storeys.
   *
   * The ranges had been differentiated in the main placer all along. They did
   * not survive because SIX other places also set `floors`, each with its own
   * hardcoded formula — the gap-fill pass, two terrace fill passes, the corner
   * buildings, and a courtyard placer — and all of them wrote 1-2 regardless
   * of district. Every district's 10th percentile came out at 1 storey
   * including the noble quarter, whose baseline starts at 3. Duplicated maths
   * drifts silently; this is the same failure as the smoke plumes that kept a
   * stale FLOOR_HEIGHT long after the real one changed.
   *
   * The baselines are separated, NOT the spreads. DESIGN.md wants variation
   * INSIDE a cluster — "2 storey next to 4 storey next to 3 storey, not
   * uniform district heights" — so every range below is 2-3 wide and simply
   * starts somewhere else.
   */
  /**
   * Pick a building type from THE DISTRICT'S OWN TABLE that fits the space
   * actually free at (x, y).
   *
   * The fill passes each hardcoded their type — `row_house` for a 1x2 gap,
   * `building_small` or `corner_building` for a 2x2 — while reading the
   * district on the line above and using it only to label the result and
   * choose a floor count. So generic housing was stamped into every quarter
   * and then signed with that quarter's name. The census makes the size of it
   * plain: `DISTRICT_BUILDINGS.noble` contains no row house at all and noble's
   * most common building was 13 row houses; `cemetery` lists only chapel and
   * tower and had 7. District character sat at 26% not because the quarters
   * failed to be distinctive but because they were overwritten afterwards.
   *
   * Two things this does that a fixed-slot version could not, both learned by
   * measuring the fixed-slot version first:
   *
   * - It asks the OCCUPANCY MAP how much room there is rather than assuming
   *   1x2 or 2x2. Restricting a noble quarter to types that fit a 2x2 hole
   *   leaves it nothing (its smallest ordinary house is 3x2), and built
   *   coverage fell out of its 50-70% band. Sizing to the real gap keeps the
   *   density while still building the right thing.
   * - It excludes NEVER_TERRACED. Those are the stand-alone monuments —
   *   towers, chapels, bell towers — and infill is not where they come from.
   *   Without this the noble and cemetery quarters filled their gaps with
   *   TOWERS, which reads as absurd and also games the character metric,
   *   since a tower is by definition a type distinctive to its district.
   *
   * Returns null when the district has nothing that fits, and callers treat
   * that as "leave the gap". For a cemetery that is every time, which is the
   * right answer: a cemetery has no ordinary house because it should not be
   * packed with cottages, and filling it anyway is how it stopped reading as
   * a cemetery.
   */
  /** How many of each type each district instance already holds, keyed
   *  `${districtId}:${typeId}`. Reset per generation in placeBuildings. */
  private _perDistrictType = new Map<string, number>()

  private atDistrictCap(districtId: number, typeId: string): boolean {
    const cap = MAX_PER_DISTRICT[typeId]
    if (cap === undefined) return false
    return (this._perDistrictType.get(`${districtId}:${typeId}`) ?? 0) >= cap
  }

  private countDistrictType(districtId: number, typeId: string): void {
    if (MAX_PER_DISTRICT[typeId] === undefined) return
    const k = `${districtId}:${typeId}`
    this._perDistrictType.set(k, (this._perDistrictType.get(k) ?? 0) + 1)
  }

  private pickTypeForSpace(
    dType: DistrictType | string,
    x: number, y: number,
    occupied: boolean[][], w: number, h: number,
    rng: () => number,
    maxW = 99, maxH = 99,
    districtId = -1,
  ): { id: string; w: number; h: number } | null {
    const table = DISTRICT_BUILDINGS[dType as DistrictType] ?? DISTRICT_BUILDINGS.residential
    const ordinary = table.filter((t) =>
      !NEVER_TERRACED.has(t.id) && t.w <= maxW && t.h <= maxH &&
      !this.atDistrictCap(districtId, t.id))
    if (ordinary.length === 0) return null
    // Weighted order, then take the first that physically fits. Weighting the
    // ORDER rather than filtering by size first means a district's common
    // house is tried before its rare one even when both would fit.
    const pool = ordinary.slice()
    while (pool.length) {
      const total = pool.reduce((sum, t) => sum + t.weight, 0)
      let roll = rng() * total
      let idx = pool.length - 1
      for (let i = 0; i < pool.length; i++) {
        roll -= pool[i].weight
        if (roll <= 0) { idx = i; break }
      }
      const t = pool[idx]
      if (x + t.w <= w - 1 && y + t.h <= h - 1 &&
          this.areaFree(occupied, x, y, t.w, t.h, w, h)) {
        this.countDistrictType(districtId, t.id)
        return { id: t.id, w: t.w, h: t.h }
      }
      pool.splice(idx, 1)
    }
    return null
  }

  /**
   * ENCLOSE THE SPARSE QUARTERS — give a churchyard, graveyard or garden the
   * edge that a house would otherwise have provided.
   *
   * This exists because of a measured trade. Making the fill passes draw from
   * DISTRICT_BUILDINGS took district character 26% -> 55%, and correctly made
   * the quarters that own no ordinary small building genuinely sparse. A
   * sparse quarter puts its facades further apart, and facade-to-facade street
   * width went 12m -> 15m against a 4-10m target — the single number DESIGN.md
   * says separates a town from a field.
   *
   * The answer is not to put houses back in the graveyard. Sitte and Alexander
   * #106 both make ENCLOSURE the thing that turns leftover ground into a
   * place, and neither requires the enclosing thing to be a building. A
   * cathedral close, a burial ground and a garden are defined by a boundary
   * wall in every real town; that is what a precinct wall is.
   *
   * Three properties this deliberately has:
   *
   * - It only walls a quarter's ROAD frontage. An interior boundary between
   *   two built quarters needs no wall and would read as a maze.
   * - It leaves gates. A sealed precinct is a bug, not an edge, so every run
   *   longer than GATE_EVERY tiles gets an opening, and any tile a road
   *   actually enters through is skipped outright.
   * - It never counts as a building. The definitions are `infrastructure`
   *   with a `barrier` tag, which is the population split urbanform.mjs now
   *   makes — so this can raise enclosure and street definition without
   *   inflating built coverage, party walls or district character. If a
   *   change can move a metric for a reason that is not the reason you
   *   intended, it will.
   */
  private encloseSparseQuarters(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][],
    districtMap: number[][], districts: District[],
    placed: PlacedObject[], heightMap: number[][], terrain: number[][],
    rng: () => number,
  ): PlacedObject[] {
    // ASK THE TERRAIN, NOT roadMap. carveAlleys paints tile 9 straight into
    // terrainTiles without registering it in roadMap, and it runs before this
    // pass — so a roadMap test says "not a street" about a tile that is one.
    // CLAUDE.md records this exact bug putting a town wall across an alley,
    // and testing roadMap here put a precinct wall in the street on seed 4242
    // within one run. Anything asking "is this a street?" asks isCirculation.
    const isStreet = (x: number, y: number): boolean =>
      isCirculation(terrain?.[y]?.[x]) || !!roadMap[y]?.[x]
    const WALLED: Set<DistrictType> = new Set(['cemetery', 'temple', 'garden'])
    const GATE_EVERY = 7
    const out: PlacedObject[] = []

    const occupied = new Set<string>()
    for (const o of placed) {
      const fp = o.footprint ?? this.getFootprint(o.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) occupied.add(`${o.x + dx},${o.y + dy}`)
      }
    }

    for (const d of districts) {
      if (!WALLED.has(d.type)) continue
      // Walk the quarter's frontage in a stable order so a "run" really is a
      // run along one edge and the gate spacing means something.
      const edges: { x: number; y: number; alongX: boolean }[] = []
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          if ((districtMap[y]?.[x] ?? -1) !== d.id) continue
          if (isStreet(x, y) || waterMap[y][x]) continue
          if (occupied.has(`${x},${y}`)) continue
          // Only a tile whose neighbour is actually the street.
          const rN = isStreet(x, y - 1), rS = isStreet(x, y + 1)
          const rW = isStreet(x - 1, y), rE = isStreet(x + 1, y)
          if (!(rN || rS || rE || rW)) continue
          // A tile with road on two opposite sides is a threshold the street
          // passes THROUGH. Walling it seals the quarter off from its own
          // approach, which is the failure the town-wall placer had to learn
          // about gates the hard way.
          if ((rN && rS) || (rE && rW)) continue
          // The wall runs perpendicular to the direction the street lies in.
          edges.push({ x, y, alongX: rN || rS })
        }
      }
      if (edges.length < 4) continue    // too small a quarter to be worth an edge

      let run = 0
      for (const e of edges) {
        run++
        // Leave a gap for a gateway, offset by the quarter's own id so every
        // precinct in a town does not gap at the same count.
        if ((run + d.id) % GATE_EVERY === 0) continue
        const id = e.alongX ? 'precinct_wall' : 'precinct_wall_v'
        out.push({
          id: uuid(),
          definitionId: id,
          x: e.x, y: e.y,
          rotation: 0, scaleX: 1, scaleY: 1,
          // Same elevation quantisation every other placer uses. A boundary
          // wall that ignores the slope it stands on is the "props hovering"
          // class of defect with a longer footprint.
          elevation: Math.min(Math.round((heightMap[e.y]?.[e.x] ?? 0) * 2) / 2, 2),
          footprint: { w: 1, h: 1 },
          properties: { district: d.type, precinct: true },
        })
        occupied.add(`${e.x},${e.y}`)
      }
    }
    return out
  }

  private districtFloors(dType: DistrictType | string, rng: () => number): number {
    switch (dType) {
      // Every range is 3 storeys wide except the slum, which is genuinely
      // uniform and low. Narrower ranges separate the medians better and cost
      // the silhouette: the first attempt used 2-wide ranges, took distinct
      // medians from 2 to 4, and dropped within-district spread from 3 storeys
      // to 2 with three of twelve districts going flat. That is DESIGN.md
      // pillar 2 being traded away for a Lynch number, which is not a trade
      // worth making — a row of identical rooflines is the thing this project
      // most wants to avoid.
      case 'noble':    return 3 + Math.floor(rng() * 3)   // 3-5, the tall quarter
      case 'market':   return 2 + Math.floor(rng() * 3)   // 2-4, shop below, living above
      case 'harbor':
      case 'waterfront':
      case 'fortress': return 2 + Math.floor(rng() * 3)   // 2-4
      case 'temple':   return 1 + Math.floor(rng() * 3)   // 1-3; the spires are landmarks
      case 'garden':   return 1 + Math.floor(rng() * 3)   // 1-3
      case 'cemetery': return 1 + Math.floor(rng() * 3)   // 1-3
      case 'slum':     return 1 + Math.floor(rng() * (rng() > 0.7 ? 2 : 1))
      default:         return 1 + Math.floor(rng() * 3)   // 1-3, the ordinary town
    }
  }

  // === BUILDING-SPECIFIC PROPS ===
  private getBuildingSpecificProps(defId: string, rng: () => number): string[] {
    switch (defId) {
      case 'tavern': return ['barrel', 'barrel_stack', 'hanging_sign', ...(rng() > 0.5 ? ['cafe_table'] : [])]
      case 'inn': return ['hanging_sign', 'barrel', ...(rng() > 0.5 ? ['horse_post'] : ['cafe_table'])]
      case 'shop': return ['hanging_sign', rng() > 0.5 ? 'crate' : 'barrel']
      case 'bakery': return ['hanging_sign', 'barrel', ...(rng() > 0.5 ? ['woodpile'] : [])]
      case 'apothecary': return ['hanging_sign', 'potted_plant']
      case 'market_stall': return ['crate_stack', 'barrel']
      case 'covered_market': return ['crate', 'barrel', 'crate_stack']
      case 'warehouse': return ['crate_stack', 'barrel_stack', 'cart']
      case 'guild_hall': return ['hanging_sign', 'bench', ...(rng() > 0.5 ? ['statue'] : ['planter_box'])]
      case 'mansion': return ['potted_plant', 'planter_box', 'flower_box']
      case 'building_large': return rng() > 0.5 ? ['potted_plant', 'planter_box'] : ['flower_box']
      case 'balcony_house': return rng() > 0.5 ? ['flower_box'] : ['planter_box']
      case 'half_timber': return rng() > 0.5 ? ['flower_box', 'potted_plant'] : ['woodpile']
      case 'chapel': return ['statue', 'wall_lantern']
      case 'temple': return ['column', 'statue', 'wall_lantern']
      case 'tower': return ['wall_lantern']
      case 'watchtower': return ['wall_lantern', 'barrel']
      case 'bell_tower': return ['wall_lantern']
      case 'clock_tower': return ['bench', 'statue']
      // THE NINE NEW QUARTER TYPES HAD NO PROPS OF THEIR OWN, WHICH IS THE
      // SAME DEFECT THIS FUNCTION'S OWN HEADER RECORDS ONE ROW OVER.
      //
      // The header says tenancy read 90% adjacent and 29% EXPLAINED because
      // this switch returned [] for every ordinary dwelling, so a row house
      // got a fountain parked against it. Nine district-exclusive types have
      // been added since — the whole small-exclusive-type arc — and every one
      // of them fell through to `default: []` as well. So a quarter could be
      // 67% distinctive by its BUILDINGS and 0% explained by its props, which
      // is a kiln with a flower bed outside it.
      //
      // A type that exists to say what a quarter DOES is exactly the type
      // whose props say it loudest: the tar barrel outside the chandlery is
      // doing more work than the chandlery.
      case 'chandlery': return ['rope_coil', 'barrel', ...(rng() > 0.5 ? ['crate_stack'] : ['hanging_sign'])]
      case 'customs_house': return ['bench', 'wall_lantern', ...(rng() > 0.5 ? ['crate_stack'] : ['sign'])]
      case 'net_loft': return ['fish_rack', 'rope_coil', ...(rng() > 0.5 ? ['barrel'] : [])]
      case 'boathouse': return ['rowboat', 'rope_coil', ...(rng() > 0.5 ? ['mooring_ring'] : ['reeds'])]
      case 'smokehouse': return ['fish_rack', 'woodpile', ...(rng() > 0.5 ? ['barrel'] : [])]
      case 'mill': return ['sack_pile', 'cart', ...(rng() > 0.5 ? ['barrel_stack'] : [])]
      case 'guardhouse': return ['forge_brazier', 'wall_lantern', ...(rng() > 0.5 ? ['barrel'] : ['heraldic_banner'])]
      case 'armory': return ['crate_stack', 'heraldic_banner', ...(rng() > 0.5 ? ['forge_brazier'] : [])]
      case 'gatehouse': return ['heraldic_banner', 'wall_lantern', 'forge_brazier']
      case 'shambles': return ['hanging_sign', 'crate', ...(rng() > 0.5 ? ['barrel'] : ['sack_pile'])]
      case 'sail_loft': return ['rope_coil', 'crate_stack', ...(rng() > 0.5 ? ['barrel'] : ['fish_rack'])]
      case 'cookshop': return ['hanging_sign', 'woodpile', ...(rng() > 0.5 ? ['barrel'] : ['cafe_table'])]
      case 'weigh_house': return ['crate_stack', 'sack_pile', ...(rng() > 0.5 ? ['cart'] : ['bench'])]
      case 'kiln': return ['woodpile', 'rubble_pile', ...(rng() > 0.5 ? ['handcart'] : [])]
      case 'workshop': return ['woodpile', 'crate', ...(rng() > 0.5 ? ['ladder'] : ['handcart'])]
      case 'washhouse': return ['cloth_line', 'rain_barrel', ...(rng() > 0.5 ? ['well'] : [])]
      case 'potting_shed': return ['planter_box', 'hedge', ...(rng() > 0.5 ? ['beehive'] : ['woodpile'])]
      case 'coach_house': return ['cart', 'water_trough', ...(rng() > 0.5 ? ['mounting_block'] : ['horse_post'])]
      case 'stable': return ['water_trough', 'haystack', ...(rng() > 0.5 ? ['horse_post'] : ['hay_bale'])]
      case 'clergy_house': return ['bench', 'potted_plant', ...(rng() > 0.5 ? ['well'] : [])]
      case 'almshouse': return ['bench', ...(rng() > 0.5 ? ['flower_box'] : ['potted_plant'])]
      case 'sexton_hut': return ['ladder', 'rubble_pile', ...(rng() > 0.5 ? ['gravestone'] : [])]
      case 'mausoleum': return ['cemetery_cross', ...(rng() > 0.5 ? ['gravestone'] : ['statue'])]
      case 'lighthouse': return ['rope_coil', 'mooring_ring', ...(rng() > 0.5 ? ['barrel'] : [])]
      default: return []
    }
  }

  // === COURTYARD DETECTION ===
  private detectAndPaintCourtyards(
    terrain: number[][], occupied: boolean[][], roadMap: boolean[][], waterMap: boolean[][],
    buildings: PlacedObject[], w: number, h: number, rng: () => number
  ): void {
    // Scan for enclosed open spaces surrounded by buildings on 3+ sides
    const buildingMap = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (const b of buildings) {
      const fp = (b.footprint ?? this.getFootprint(b.definitionId))
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const bx = b.x + dx, by = b.y + dy
          if (bx < w && by < h) buildingMap[by][bx] = true
        }
      }
    }

    // Check 3x3 open patches for courtyard potential
    for (let y = 2; y < h - 4; y += 3) {
      for (let x = 2; x < w - 4; x += 3) {
        // Check if center 2x2 is free
        let centerFree = true
        for (let dy = 0; dy < 2 && centerFree; dy++) {
          for (let dx = 0; dx < 2 && centerFree; dx++) {
            if (buildingMap[y + dy]?.[x + dx] || waterMap[y + dy]?.[x + dx]) centerFree = false
          }
        }
        if (!centerFree) continue

        // Count building tiles on perimeter (3-tile ring around center)
        let buildingSides = 0
        const checkSide = (sx: number, sy: number, count: number, stepX: number, stepY: number) => {
          let found = 0
          for (let i = 0; i < count; i++) {
            if (buildingMap[sy + i * stepY]?.[sx + i * stepX]) found++
          }
          return found > 0 ? 1 : 0
        }
        buildingSides += checkSide(x - 1, y, 2, 0, 1) // left
        buildingSides += checkSide(x + 2, y, 2, 0, 1) // right
        buildingSides += checkSide(x, y - 1, 2, 1, 0) // top
        buildingSides += checkSide(x, y + 2, 2, 1, 0) // bottom

        if (buildingSides >= 3) {
          // Paint courtyard cobblestone
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              if (y + dy < h && x + dx < w && !roadMap[y + dy][x + dx]) {
                terrain[y + dy][x + dx] = 14 // flagstone courtyard (paving, not street)
              }
            }
          }
          // Place well or planter in courtyard center
          if (!occupied[y][x] && rng() > 0.4) {
            const courtItem = rng() > 0.5 ? 'well' : 'potted_plant'
            buildings.push(this.createObj(courtItem, x, y))
            occupied[y][x] = true
          }
        }
      }
    }
  }

  // === GRAND COURTYARDS ===
  // Intentional enclosed spaces with partial symmetry, arched entries,
  // central features, and colonnades. These are the soul of the town —
  // places to pause, gather, and breathe between dense building clusters.
  private generateGrandCourtyards(
    terrain: number[][], roadMap: boolean[][], waterMap: boolean[][],
    heightMap: number[][], buildings: PlacedObject[],
    districtMap: number[][], districts: District[],
    w: number, h: number, rng: () => number, noise: SimplexNoise
  ): PlacedObject[] {
    const props: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, buildings, w, h)

    const maxCourtyards = Math.floor(2 + districts.length * 0.8)
    let placed = 0

    for (const d of districts) {
      if (placed >= maxCourtyards) break
      // Not every district gets a courtyard — prefer noble, temple, garden
      const courtChance = d.type === 'noble' ? 0.8 : d.type === 'temple' ? 0.9
        : d.type === 'garden' ? 0.7 : d.type === 'market' ? 0.5
        : d.type === 'residential' ? 0.3 : 0.1
      if (rng() > courtChance) continue

      // Find a clear area near the district center for the courtyard
      // Courtyard size varies by district type
      const courtW = d.type === 'temple' ? 6 + Math.floor(rng() * 3)
        : d.type === 'noble' ? 5 + Math.floor(rng() * 3)
        : 4 + Math.floor(rng() * 2)
      const courtH = d.type === 'temple' ? 5 + Math.floor(rng() * 2)
        : 4 + Math.floor(rng() * 2)

      // Search near district center for clear space
      let cx = -1, cy = -1
      for (let attempt = 0; attempt < 40; attempt++) {
        const tx = d.center.x + Math.floor(rng() * 8) - 4
        const ty = d.center.y + Math.floor(rng() * 8) - 4
        if (tx < 2 || ty < 2 || tx + courtW >= w - 2 || ty + courtH >= h - 2) continue
        if (this.areaFree(occupied, tx, ty, courtW, courtH, w, h)) {
          cx = tx; cy = ty; break
        }
      }
      if (cx < 0) continue

      // === Paint courtyard ground ===
      for (let dy = 0; dy < courtH; dy++) {
        for (let dx = 0; dx < courtW; dx++) {
          const tx = cx + dx, ty = cy + dy
          if (d.type === 'temple') terrain[ty][tx] = 2 // stone
          else if (d.type === 'noble') terrain[ty][tx] = (dx + dy) % 2 === 0 ? 2 : 8 // checkerboard
          else if (d.type === 'garden') terrain[ty][tx] = dx === 0 || dx === courtW - 1 || dy === 0 || dy === courtH - 1 ? 13 : 12 // gravel border, wildflower center
          else terrain[ty][tx] = 8 // cobblestone
          roadMap[ty][tx] = true // walkable
        }
      }

      // === Surrounding buildings (U-shape or L-shape enclosure) ===
      // Place buildings along 2-3 sides to create enclosure
      const buildingSides = rng() > 0.3 ? 3 : 2 // U-shape or L-shape
      const sideConfigs = [
        { dir: 'top', bx: cx, by: cy - 2, bw: courtW, bh: 2 },
        { dir: 'left', bx: cx - 2, by: cy, bw: 2, bh: courtH },
        { dir: 'right', bx: cx + courtW, by: cy, bw: 2, bh: courtH },
        { dir: 'bottom', bx: cx, by: cy + courtH, bw: courtW, bh: 2 },
      ]
      // Shuffle and pick sides
      for (let si = sideConfigs.length - 1; si > 0; si--) {
        const sj = Math.floor(rng() * (si + 1))
        ;[sideConfigs[si], sideConfigs[sj]] = [sideConfigs[sj], sideConfigs[si]]
      }

      let wallsPlaced = 0
      for (const side of sideConfigs) {
        if (wallsPlaced >= buildingSides) break
        if (side.bx < 0 || side.by < 0 || side.bx + side.bw >= w || side.by + side.bh >= h) continue
        if (!this.areaFree(occupied, side.bx, side.by, side.bw, side.bh, w, h)) continue

        // Place a row of buildings along this side
        // Was a three-way conditional naming two of eleven district types and
        // falling through to generic housing for the other nine, which is the
        // same hardcode as the fill passes wearing a nicer coat.
        const sPick = this.pickTypeForSpace(d.type, side.bx, side.by, occupied, w, h,
          rng, side.bw, side.bh, d.id)
        if (!sPick) continue
        const buildingType = sPick.id
        const bfp = { w: sPick.w, h: sPick.h }

        let bx = side.bx
        while (bx + bfp.w <= side.bx + side.bw) {
          if (this.areaFree(occupied, bx, side.by, bfp.w, bfp.h, w, h)) {
            const elev = Math.min(Math.round((heightMap[side.by]?.[bx] ?? 0) * 2) / 2, 2)
            buildings.push({
              id: uuid(),
              definitionId: buildingType,
              x: bx, y: side.by,
              rotation: 0, scaleX: 1, scaleY: 1,
              elevation: elev,
              footprint: this.getFootprint(buildingType),
              properties: {
                floors: this.districtFloors(d.type, rng),
                district: d.type,
                style: d.type === 'noble' ? 'ornate' : 'standard',
              }
            })
            this.markArea(occupied, bx, side.by, bfp.w, bfp.h, w, h)
          }
          bx += bfp.w
        }
        wallsPlaced++
      }

      // === Courtyard entry — archway on the open side ===
      // Find an open side (no buildings placed) and put an archway
      for (const side of sideConfigs) {
        if (wallsPlaced > 0 && side.bx >= 0 && side.by >= 0) {
          const archX = cx + Math.floor(courtW / 2) - 1
          const archY = side.dir === 'top' ? cy - 1 : side.dir === 'bottom' ? cy + courtH : cy + Math.floor(courtH / 2)
          if (archX >= 0 && archX + 3 < w && archY >= 0 && archY < h && !occupied[archY][archX]) {
            props.push(this.createObj('archway', archX, archY, 0))
            break
          }
        }
      }

      // === Central feature (partial symmetry) ===
      const centerX = cx + Math.floor(courtW / 2)
      const centerY = cy + Math.floor(courtH / 2)

      if (d.type === 'temple') {
        // Symmetric: central statue + flanking columns
        if (!occupied[centerY][centerX]) {
          props.push(this.createObj('statue', centerX, centerY))
          occupied[centerY][centerX] = true
        }
        // Columns along one axis (partial symmetry — not mirror-perfect)
        for (let ci = -2; ci <= 2; ci += 2) {
          const colX = centerX + ci
          if (colX >= cx && colX < cx + courtW && !occupied[centerY - 1]?.[colX]) {
            props.push(this.createObj('column', colX, centerY - 1))
            occupied[centerY - 1][colX] = true
          }
        }
        // Wall lanterns at corners
        for (const [dx, dy] of [[0, 0], [courtW - 1, 0], [0, courtH - 1], [courtW - 1, courtH - 1]] as const) {
          if (!occupied[cy + dy][cx + dx]) {
            props.push(this.createObj('wall_lantern', cx + dx, cy + dy))
            occupied[cy + dy][cx + dx] = true
          }
        }
      } else if (d.type === 'noble' || d.type === 'garden') {
        // Fountain + symmetric planter boxes
        if (this.areaFree(occupied, centerX - 1, centerY - 1, 2, 2, w, h)) {
          props.push(this.createObj('fountain', centerX - 1, centerY - 1))
          this.markArea(occupied, centerX - 1, centerY - 1, 2, 2, w, h)
        }
        // Symmetric planters along the central axis
        for (const offset of [-2, 2]) {
          const px = centerX + offset
          if (px >= cx && px + 1 < cx + courtW) {
            if (!occupied[centerY]?.[px] && !occupied[centerY]?.[px + 1]) {
              props.push(this.createObj('planter_box', px, centerY))
              occupied[centerY][px] = true
              if (px + 1 < w) occupied[centerY][px + 1] = true
            }
          }
        }
        // Benches facing the fountain
        for (const [dx, dy] of [[2, 0], [-2, 0]] as const) {
          const bx = centerX + dx, by = centerY + 1
          if (bx >= cx && bx + 1 < cx + courtW && by < cy + courtH) {
            if (!occupied[by][bx] && !occupied[by][bx + 1]) {
              props.push(this.createObj('bench', bx, by))
              occupied[by][bx] = true
              occupied[by][bx + 1] = true
            }
          }
        }
      } else if (d.type === 'market') {
        // Market stalls in rows
        for (let mx = cx + 1; mx < cx + courtW - 2; mx += 3) {
          if (this.areaFree(occupied, mx, centerY, 2, 2, w, h)) {
            props.push(this.createObj('market_stall', mx, centerY))
            this.markArea(occupied, mx, centerY, 2, 2, w, h)
          }
        }
      } else {
        // Residential: well + tree
        if (!occupied[centerY][centerX]) {
          props.push(this.createObj('well', centerX, centerY))
          occupied[centerY][centerX] = true
        }
        if (centerX + 2 < cx + courtW && !occupied[centerY][centerX + 2]) {
          const treeObj = this.createObj('tree', centerX + 2, centerY)
          treeObj.properties = { species: 'oak' }
          props.push(treeObj)
          occupied[centerY][centerX + 2] = true
        }
      }

      this.markArea(occupied, cx, cy, courtW, courtH, w, h)
      placed++
    }

    return props
  }

  // === NATURAL PONDS ===
  // Organic water bodies at low elevation points — adds natural beauty
  private generateNaturalPonds(
    w: number, h: number, heightMap: number[][], waterMap: boolean[][],
    terrain: number[][], noise: SimplexNoise, rng: () => number
  ): void {
    // Find local minima in height map as pond candidates
    const numPonds = 1 + Math.floor(rng() * 3)
    let pondsPlaced = 0

    for (let attempt = 0; attempt < 60 && pondsPlaced < numPonds; attempt++) {
      const cx = 5 + Math.floor(rng() * (w - 10))
      const cy = 5 + Math.floor(rng() * (h - 10))
      const elev = heightMap[cy]?.[cx] ?? 1

      // Ponds form in low-lying areas
      if (elev > 0.8) continue

      // Check not already water
      if (waterMap[cy][cx]) continue

      // Organic shape using noise threshold
      const pondR = 2 + Math.floor(rng() * 2)
      let pondSize = 0

      for (let dy = -pondR - 1; dy <= pondR + 1; dy++) {
        for (let dx = -pondR - 1; dx <= pondR + 1; dx++) {
          const px = cx + dx, py = cy + dy
          if (px < 1 || px >= w - 1 || py < 1 || py >= h - 1) continue
          if (waterMap[py][px]) continue

          // Elliptical base + noise perturbation for organic shape
          const dist = Math.sqrt((dx * dx) / (pondR * pondR) + (dy * dy) / ((pondR * 0.8) * (pondR * 0.8)))
          const edgeNoise = noise.noise2D(px * 0.3 + 500, py * 0.3 + 500) * 0.3
          if (dist < 1.0 + edgeNoise) {
            waterMap[py][px] = true
            terrain[py][px] = 3 // water
            pondSize++
          } else if (dist < 1.3 + edgeNoise) {
            // Mud/sand shore
            terrain[py][px] = 11 // mud
          }
        }
      }

      if (pondSize > 2) pondsPlaced++
    }
  }

  // === PRIVATE GARDENS ===
  // Cozy enclosed spaces behind buildings — hedges, flower beds, fruit trees
  private plantPrivateGardens(
    w: number, h: number,
    roadMap: boolean[][], waterMap: boolean[][], heightMap: number[][],
    buildings: PlacedObject[], districtMap: number[][], districts: District[],
    existingProps: PlacedObject[],
    terrain: number[][], rng: () => number, noise: SimplexNoise
  ): PlacedObject[] {
    const gardenProps: PlacedObject[] = []
    const occupied = this.createOccupied(w, h, roadMap, waterMap)
    this.markObjects(occupied, buildings, w, h)
    this.markObjects(occupied, existingProps, w, h)

    // For each building, check if there's open space "behind" it (away from road)
    for (const b of buildings) {
      const fp = (b.footprint ?? this.getFootprint(b.definitionId))
      const dId = districtMap[b.y]?.[b.x] ?? -1
      const district = districts.find(d => d.id === dId)
      const dType = district?.type || 'residential'

      // Skip slum and fortress — they don't have gardens
      if (dType === 'slum' || dType === 'fortress' || dType === 'harbor') continue

      // Find which side faces AWAY from the nearest road (the "back")
      let bestDir = { dx: 0, dy: 1 } // default: south
      let maxRoadDist = 0
      for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
        const checkX = b.x + (dx === 1 ? fp.w : dx === -1 ? -1 : 0)
        const checkY = b.y + (dy === 1 ? fp.h : dy === -1 ? -1 : 0)
        if (checkX < 0 || checkX >= w || checkY < 0 || checkY >= h) continue
        if (roadMap[checkY]?.[checkX]) continue // This side faces road — not the back
        // Count distance to nearest road from this side
        let roadDist = 0
        for (let d = 1; d <= 4; d++) {
          const rx = checkX + dx * d, ry = checkY + dy * d
          if (rx >= 0 && rx < w && ry >= 0 && ry < h && roadMap[ry][rx]) { roadDist = d; break }
        }
        if (roadDist === 0) roadDist = 5
        if (roadDist > maxRoadDist) {
          maxRoadDist = roadDist
          bestDir = { dx, dy }
        }
      }

      // Try to carve a 2x2 or 3x2 garden behind the building
      const gardenW = 2 + (dType === 'noble' || dType === 'garden' ? 1 : 0)
      const gardenH = 2
      const gx = bestDir.dx === 1 ? b.x + fp.w : bestDir.dx === -1 ? b.x - gardenW : b.x
      const gy = bestDir.dy === 1 ? b.y + fp.h : bestDir.dy === -1 ? b.y - gardenH : b.y

      if (gx < 0 || gx + gardenW > w || gy < 0 || gy + gardenH > h) continue
      if (!this.areaFree(occupied, gx, gy, gardenW, gardenH, w, h)) continue

      // Acceptance probability based on district
      const gardenChance = dType === 'garden' ? 0.8 : dType === 'noble' ? 0.6 :
        dType === 'residential' ? 0.35 : dType === 'temple' ? 0.3 : 0.15
      if (rng() > gardenChance) continue

      // Paint garden ground
      for (let dy = 0; dy < gardenH; dy++) {
        for (let dx = 0; dx < gardenW; dx++) {
          const tx = gx + dx, ty = gy + dy
          if (tx < w && ty < h) {
            terrain[ty][tx] = dType === 'temple' ? 10 : 12 // mossy stone or wildflower
          }
        }
      }

      // Place garden features
      const centerX = gx + Math.floor(gardenW / 2)
      const centerY = gy + Math.floor(gardenH / 2)

      if (dType === 'garden' || dType === 'noble') {
        // Formal garden: central feature + hedges
        if (!occupied[centerY][centerX]) {
          const feature = rng() > 0.6 ? 'potted_plant' : rng() > 0.3 ? 'statue' : 'fountain'
          if (feature === 'fountain' && this.areaFree(occupied, centerX, centerY, 2, 2, w, h)) {
            gardenProps.push(this.createObj('fountain', centerX, centerY))
            this.markArea(occupied, centerX, centerY, 2, 2, w, h)
          } else {
            gardenProps.push(this.createObj(feature, centerX, centerY))
            occupied[centerY][centerX] = true
          }
        }
        // Hedges along garden boundary (1-2 sides)
        for (let hx = gx; hx < gx + gardenW - 1; hx += 2) {
          if (hx + 1 < w && gy > 0 && !occupied[gy][hx]) {
            gardenProps.push(this.createObj('bush', hx, gy))
            occupied[gy][hx] = true
          }
        }
      } else if (dType === 'residential') {
        // Kitchen garden: fruit tree + vegetable-suggesting ground
        if (!occupied[centerY][centerX]) {
          const fruitTree = this.createObj('tree', centerX, centerY)
          fruitTree.properties = { species: 'maple' } // fruit/ornamental tree
          gardenProps.push(fruitTree)
          occupied[centerY][centerX] = true
        }
        // Fence along one edge
        if (gx + 1 < w && !occupied[gy + gardenH - 1][gx]) {
          gardenProps.push(this.createObj('fence', gx, gy + gardenH - 1))
          occupied[gy + gardenH - 1][gx] = true
          if (gx + 1 < w) occupied[gy + gardenH - 1][gx + 1] = true
        }
      } else {
        // Temple/other: contemplative garden
        if (!occupied[centerY][centerX]) {
          gardenProps.push(this.createObj('potted_plant', centerX, centerY))
          occupied[centerY][centerX] = true
        }
      }

      // Mark garden area as occupied
      this.markArea(occupied, gx, gy, gardenW, gardenH, w, h)
    }

    return gardenProps
  }

  // === ORGANIC TERRAIN PAINTING ===
  // Rocky outcrops on hilltops, wildflower meadows in open areas, gravel transitions
  private paintOrganicTerrain(
    terrain: number[][], heightMap: number[][], waterMap: boolean[][],
    roadMap: boolean[][], districtMap: number[][], districts: District[],
    w: number, h: number, noise: SimplexNoise, rng: () => number
  ): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (waterMap[y][x] || roadMap[y][x]) continue
        const elev = heightMap[y]?.[x] ?? 0
        const tile = terrain[y][x]
        const n = noise.noise2D(x * 0.12 + 300, y * 0.12 + 300)

        // Rocky outcrops on high ground (elevation > 1.5)
        if (elev > 1.5 && n > 0.1 && (tile === 0 || tile === 1 || tile === 5)) {
          terrain[y][x] = 7 // rocky ground
          continue
        }

        // Wildflower meadows in garden districts and open grassland
        const dId = districtMap[y]?.[x] ?? -1
        const district = districts.find(d => d.id === dId)
        if (district?.type === 'garden' && tile === 0 && n > 0.15) {
          terrain[y][x] = 12 // wildflower meadow
          continue
        }

        // Wildflower patches in open grass far from roads
        if (tile === 0 || tile === 5) {
          let nearRoad = false
          for (let dy = -2; dy <= 2 && !nearRoad; dy++) {
            for (let dx = -2; dx <= 2 && !nearRoad; dx++) {
              if (roadMap[y + dy]?.[x + dx]) nearRoad = true
            }
          }
          if (!nearRoad && n > 0.35 && rng() > 0.6) {
            terrain[y][x] = 12 // scattered wildflower patches
          }
        }

        // Gravel transitions between stone/cobble and grass
        if (tile === 0 || tile === 5) {
          let nearStone = false
          for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1]] as const) {
            const t = terrain[y + dy]?.[x + dx]
            if (t === 2 || t === 8 || t === 9) nearStone = true
          }
          if (nearStone && n > 0.1) {
            terrain[y][x] = 13 // gravel transition
          }
        }
      }
    }
  }

  // === UTILITY METHODS ===

  /**
   * Put something within sight of every stretch of walkable street.
   *
   * tools/emptiness.mjs measures the distance from each walkable tile to the
   * nearest prop or building frontage. Plazas came out furnished (median 3m)
   * once their ring counts followed circumference, but STREETS did not: median
   * 6m, and 8% of street tiles more than 12m from anything, worst case 24m.
   * Twenty-four metres of bare cobble with nothing to look at is the "ton of
   * empty space".
   *
   * Rather than scatter more props at random and hope, this runs the same
   * measurement the tool runs and places only where the measurement says it is
   * bare. Every item lands on a tile that is genuinely far from everything, so
   * the fill is self-limiting: a dense quarter gets nothing, a long empty lane
   * gets a row of kerbside clutter.
   */
  private dressEmptyStreets(
    w: number, h: number,
    terrain: number[][],
    roadMap: boolean[][], waterMap: boolean[][],
    /** Everything solid — buildings, landmarks AND bridges. */
    solidObjs: PlacedObject[], existingProps: PlacedObject[],
    rng: () => number,
    /** The designed squares. A SQUARE is a place somebody laid out, and only
     *  this map knows which tiles are one — the material cannot answer it.
     *  District cobble (15/16) is the street's own forecourt now, so a test
     *  on paving material called every kerb in a cobbled quarter "a square"
     *  and furnished it from the square kit, whose heaviest entry is a TREE.
     *  That is the tree standing in the middle of the street. */
    squareMap: boolean[][],
  ): PlacedObject[] {
    const out: PlacedObject[] = []
    // NOT createOccupied: that marks every road tile as occupied, which is
    // right for placers that must stay off the carriageway and exactly wrong
    // here — the street is the thing being dressed. Block water and anything
    // already standing, nothing else. (Getting this wrong the first time was
    // silent: the pass ran, placed nothing, and the emptiness metric came back
    // byte-identical, which is the tell.)
    const occupied: boolean[][] = []
    for (let y = 0; y < h; y++) {
      const row: boolean[] = new Array(w).fill(false)
      for (let x = 0; x < w; x++) if (waterMap[y]?.[x]) row[x] = true
      occupied.push(row)
    }
    this.markObjects(occupied, solidObjs, w, h)
    this.markObjects(occupied, existingProps, w, h)

    // Circulation (8 street, 9 alley) AND paving (14 plaza flagstone, 15/16
    // district cobble). placePlazaFeatures furnishes the rings around a
    // fountain, but a square is bigger than its rings and the paved ground
    // beyond them got nothing at all — which is the wide bare foreground in
    // the walkaround shots. Paving still asks for more clearance below, so a
    // ceremonial square keeps its open centre.
    const isDressable = (x: number, y: number) => {
      const t = terrain[y]?.[x]
      return t === 8 || t === 9 || t === 14 || t === 15 || t === 16
    }
    const isSquare = (x: number, y: number) => !!squareMap[y]?.[x]

    // Multi-source BFS out from everything that already exists.
    const INF = 0x3fffffff
    const dist = new Int32Array(w * h).fill(INF)
    const queue: number[] = []
    const seed = (px: number, py: number) => {
      const x = Math.round(px), y = Math.round(py)
      if (x < 0 || y < 0 || x >= w || y >= h) return
      const i = y * w + x
      if (dist[i] !== 0) { dist[i] = 0; queue.push(i) }
    }
    for (const a of solidObjs) seed(a.x, a.y)
    for (const p of existingProps) seed(p.x, p.y)
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], x = i % w, y = (i / w) | 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        if (!isDressable(nx, ny)) continue
        const ni = ny * w + nx
        if (dist[ni] > dist[i] + 1) { dist[ni] = dist[i] + 1; queue.push(ni) }
      }
    }

    // 3 tiles is 9m — far enough that the tile has nothing within a normal
    // conversational distance, close enough that we are not only patching the
    // very worst holes.
    // 3 tiles (9m) on a street; 4 (12m) on paving, so an open square reads as
    // deliberately open near its middle and furnished toward its edges.
    const BARE = 3
    const BARE_PAVING = 4
    const candidates: Array<{ i: number; d: number }> = []
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isDressable(x, y)) continue
        const d = dist[y * w + x]
        const need = isSquare(x, y) ? BARE_PAVING : BARE
        if (d >= need && d < INF) candidates.push({ i: y * w + x, d })
      }
    }
    // Barest first, so the worst holes are filled even if we run out of room.
    candidates.sort((a, b) => b.d - a.d)

    // TWO kits, because a street and a square are emptied by different things.
    //
    // A street is a narrow corridor: you pass within a metre of the kerb, so
    // small clutter reads and a row of barrels feels lived-in.
    //
    // A square is thirty metres of open ground seen from eye level, where a
    // 0.8m barrel subtends almost nothing past fifteen metres. The distance
    // metric could not see this — it measures top-down, and from above a
    // barrel and a tree are both "something". What actually furnishes a square
    // is HEIGHT: trees, lampposts, market stalls, a statue. So paving draws
    // from a kit of things you can see across a square.
    const STREET_KIT: Array<[string, number]> = [
      ['barrel', 22], ['crate', 18], ['potted_plant', 14], ['bench', 12],
      ['lamppost', 12], ['bush', 10], ['well', 4], ['wagon', 4], ['statue', 2],
    ]
    const SQUARE_KIT: Array<[string, number]> = [
      ['tree', 26], ['lamppost', 22], ['market_stall', 16], ['statue', 10],
      ['well', 8], ['wagon', 8], ['bench', 6], ['potted_plant', 4],
    ]
    const pickFrom = (kit: Array<[string, number]>) => {
      const total = kit.reduce((a, [, n]) => a + n, 0)
      let r = rng() * total
      for (const [id, n] of kit) { r -= n; if (r <= 0) return id }
      return kit[0][0]
    }

    for (const c of candidates) {
      const x = c.i % w, y = (c.i / w) | 0
      if (!this.areaFree(occupied, x, y, 1, 1, w, h)) continue
      // A tile with a non-dressable neighbour is at the edge of the space —
      // against a wall, a yard or a bank.
      const atKerb = !isDressable(x + 1, y) || !isDressable(x - 1, y) ||
        !isDressable(x, y + 1) || !isDressable(x, y - 1)
      const square = isSquare(x, y)
      // THE CARRIAGEWAY IS FOR MOVEMENT. Nothing stands in the middle of a
      // street; a barrel is pushed against the wall, which is where a barrel
      // in a real town actually is. This used to be a 75% thinning rather than
      // a rule, so a quarter of mid-street tiles still got furniture and 22%
      // of every town's props ended up standing in the carriageway.
      //
      // Alexander #124, Activity Pockets: the life of a public space forms
      // around its EDGE, and a space whose edge fails never becomes lively
      // however much you put in the middle of it. So the edge is where this
      // pass works — and a square keeps a deliberately open centre, which is
      // the same rule seen from the other side.
      if (!atKerb) {
        if (!square) continue
        if (rng() < 0.7) continue
      }
      // CHECK THE FOOTPRINT YOU ARE ABOUT TO PLACE, not a 1x1 stand-in.
      //
      // The guard above tests one tile, and this kit contains a 2x2
      // market_stall and a 3x2 wagon. The 3x3 claim below happens to cover a
      // 2x2 and a 2x1, so nothing showed in the audit — but it does not cover
      // a wagon's third column, and "it happens to be covered" is not a rule.
      // Sibling of the vignette overlap fixed in the commit before this one:
      // a bug in a gate is a bug in a PATTERN, so grep the pattern the same
      // day. Fall back through the kit rather than abandoning the tile, since
      // a bare spot that can take a barrel should get one.
      let id: string | null = null
      for (let attempt = 0; attempt < 4; attempt++) {
        const cand = pickFrom(square ? SQUARE_KIT : STREET_KIT)
        const f = this.getFootprint(cand)
        if ((f.w === 1 && f.h === 1) || this.areaFree(occupied, x, y, f.w, f.h, w, h)) {
          id = cand; break
        }
      }
      if (!id) continue
      const fp = this.getFootprint(id)
      const obj = this.createObj(id, x, y)
      obj.properties.facingY = rng() * Math.PI * 2
      out.push(obj)
      // Claim what it actually occupies, plus a one-tile ring, so the fill
      // spreads instead of clumping into the single barest corner.
      for (let dy = -1; dy <= fp.h; dy++) {
        for (let dx = -1; dx <= fp.w; dx++) {
          this.markArea(occupied, x + dx, y + dy, 1, 1, w, h)
        }
      }
    }
    return out
  }

  private createObj(defId: string, x: number, y: number, elevation: number = 0): PlacedObject {
    return {
      id: uuid(),
      definitionId: defId,
      x, y,
      rotation: 0, scaleX: 1, scaleY: 1,
      elevation,
      properties: {},
      // Record what was actually reserved. Every consumer reads this rather
      // than re-deriving the rectangle from the definition — see footprintOf
      // in core/types.
      footprint: this.getFootprint(defId),
    }
  }

  private createOccupied(w: number, h: number, roadMap: boolean[][], waterMap: boolean[][]): boolean[][] {
    const occupied = Array.from({ length: h }, () => Array.from({ length: w }, () => false))
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (roadMap[y][x] || waterMap[y][x]) occupied[y][x] = true
      }
    }
    return occupied
  }

  private markObjects(occupied: boolean[][], objs: PlacedObject[], w: number, h: number): void {
    for (const obj of objs) {
      // Reserved rectangle first — a prop placed against a definition lookup
      // is how props ended up buried inside rotated buildings.
      const fp = obj.footprint ?? this.getFootprint(obj.definitionId)
      for (let dy = 0; dy < fp.h; dy++) {
        for (let dx = 0; dx < fp.w; dx++) {
          const bx = obj.x + dx, by = obj.y + dy
          if (bx < w && by < h && bx >= 0 && by >= 0) occupied[by][bx] = true
        }
      }
    }
  }

  private markBuildings(occupied: boolean[][], buildings: PlacedObject[], w: number, h: number): void {
    this.markObjects(occupied, buildings, w, h)
  }

  private markArea(occupied: boolean[][], x: number, y: number, aw: number, ah: number, w: number, h: number): void {
    for (let dy = 0; dy < ah; dy++) {
      for (let dx = 0; dx < aw; dx++) {
        if (y + dy < h && x + dx < w && y + dy >= 0 && x + dx >= 0) {
          occupied[y + dy][x + dx] = true
        }
      }
    }
  }

  private areaFree(occupied: boolean[][], x: number, y: number, aw: number, ah: number, w: number, h: number): boolean {
    for (let dy = 0; dy < ah; dy++) {
      for (let dx = 0; dx < aw; dx++) {
        const bx = x + dx, by = y + dy
        if (bx < 0 || bx >= w || by < 0 || by >= h || occupied[by][bx]) return false
      }
    }
    return true
  }

  /**
   * Score every tile by how much STREET VIEW it would close.
   *
   * The Imagineering name for what this is for is a weenie: a visual magnet
   * that terminates a vista and pulls you toward it. Main Street's whole trick
   * is the castle at the end of it — without that it is an arcade, with it, it
   * is somewhere you are walking to. Every reference in DESIGN.md does this:
   * Diagon Alley bends so Gringotts closes the view, Gion frames the pagoda at
   * the top of the hill.
   *
   * Measured, the town had none of it. Of 244 long looks down a street, FOUR
   * ended on a landmark and half ended on nothing at all — 39% dissolved into
   * open ground and 11% ran off the map edge. Landmarks were placed by
   * `findFreeSpot` near a district centre, i.e. wherever there happened to be
   * room, which is exactly the "assets dropped around" complaint applied to
   * the buildings that matter most.
   *
   * So: stand on every road tile, look along the street, and find where the
   * paving stops. That tile is where a building would close the view, and the
   * score it earns is how far the view ran to get there — a 30m corridor is
   * worth more than a 9m one, because the eye has time to ask what it is
   * walking toward.
   */
  private computeVistaScores(
    roadMap: boolean[][], terrain: number[][], w: number, h: number
  ): number[][] {
    /** A look worth closing, in tiles. 8 tiles is 24m of open street. */
    const LONG_VIEW = 8
    const score = Array.from({ length: h }, () => Array.from({ length: w }, () => 0))
    const isRoad = (x: number, y: number): boolean =>
      x >= 0 && y >= 0 && x < w && y < h && roadMap[y][x]
    /** A view carries across a square, not just along a carriageway. */
    const open = (x: number, y: number): boolean => {
      if (x < 0 || y < 0 || x >= w || y >= h) return false
      const t = terrain[y][x]
      return roadMap[y][x] || t === 2 || t === 14 || t === 15 || t === 16
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!roadMap[y][x]) continue
        // Which way does the street run? Same run-length estimate the audits
        // use: a neighbour test calls every tile of a 2-lane street a junction.
        const run = (dx: number, dy: number): number => {
          let n = 1
          for (let k = 1; k <= 40 && isRoad(x + dx * k, y + dy * k); k++) n++
          for (let k = 1; k <= 40 && isRoad(x - dx * k, y - dy * k); k++) n++
          return n
        }
        const runX = run(1, 0), runY = run(0, 1)
        if (Math.abs(runX - runY) < 2) continue    // a square, not a corridor
        const ax = runX > runY ? 1 : 0, ay = runX > runY ? 0 : 1
        for (const sign of [1, -1]) {
          const dx = ax * sign, dy = ay * sign
          for (let k = 1; k <= 40; k++) {
            const px = x + dx * k, py = y + dy * k
            if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) break
            if (open(px, py)) continue
            // Paving stops here. This is the tile that closes the view.
            if (k >= LONG_VIEW) score[py][px] += k
            break
          }
        }
      }
    }
    return score
  }

  /**
   * The free spot near (cx, cy) that closes the most street view.
   *
   * `findFreeSpot` returns the FIRST free rectangle in an outward ring scan,
   * which for a landmark means "wherever there happened to be room". This
   * takes the same search and ranks it, so a cathedral lands at the head of a
   * street instead of behind one.
   */
  private findVistaSpot(
    occupied: boolean[][], vista: number[][], cx: number, cy: number,
    aw: number, ah: number, w: number, h: number, searchRadius: number
  ): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null
    let bestScore = -1
    for (let dy = -searchRadius; dy <= searchRadius; dy++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        const x = cx + dx, y = cy + dy
        if (!this.areaFree(occupied, x, y, aw, ah, w, h)) continue
        // Sum the vista score the whole footprint would intercept, so a wide
        // cathedral gets credit for closing several parallel lanes at once.
        let s = 0
        for (let fy = 0; fy < ah; fy++) {
          for (let fx = 0; fx < aw; fx++) s += vista[y + fy]?.[x + fx] ?? 0
        }
        // Distance is the tie-breaker, not the criterion: among spots that
        // close nothing this degrades to the old nearest-free-spot behaviour.
        const dist = Math.abs(dx) + Math.abs(dy)
        const ranked = s * 100 - dist
        if (ranked > bestScore) { bestScore = ranked; best = { x, y } }
      }
    }
    return best
  }

  private findFreeSpot(
    occupied: boolean[][], cx: number, cy: number,
    aw: number, ah: number, w: number, h: number, searchRadius: number
  ): { x: number; y: number } | null {
    for (let r = 0; r <= searchRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue // Only check perimeter
          const x = cx + dx, y = cy + dy
          if (this.areaFree(occupied, x, y, aw, ah, w, h)) {
            return { x, y }
          }
        }
      }
    }
    return null
  }

  private isRoadAdjacent(x: number, y: number, roadMap: boolean[][], w: number, h: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && roadMap[ny][nx]) return true
      }
    }
    return false
  }

  /**
   * Estimate the road tangent direction at (x, y) by summing unit vectors
   * to road tiles in the 4 cardinal neighborhood. Returns the angle in
   * radians (atan2 convention, +X = 0, rotating toward +Z), or null if no
   * road tiles are adjacent. Used to face street furniture along the road.
   */
  private roadTangentAt(x: number, y: number, roadMap: boolean[][], w: number, h: number): number | null {
    const dxs = [+1, -1, 0, 0]
    const dys = [0, 0, +1, -1]
    let tx = 0, ty = 0, found = false
    for (let i = 0; i < 4; i++) {
      const nx = x + dxs[i], ny = y + dys[i]
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && roadMap[ny]?.[nx]) {
        tx += dxs[i]; ty += dys[i]; found = true
      }
    }
    if (!found) return null
    return Math.atan2(ty, tx)
  }

  private getFootprint(defId: string): { w: number; h: number } {
    const footprints: Record<string, { w: number; h: number }> = {
      // Small district-specific houses — see store.ts. tools/registry.mjs
      // checks these agree with the other two footprint tables.
      precinct_wall: { w: 1, h: 1 }, precinct_wall_v: { w: 1, h: 1 },
      footbridge: { w: 1, h: 1 },
      net_loft: { w: 2, h: 2 }, weigh_house: { w: 2, h: 2 },
      tenement: { w: 1, h: 2 }, lean_to: { w: 1, h: 2 },
      clergy_house: { w: 2, h: 2 },
      almshouse: { w: 1, h: 3 },
      sexton_hut: { w: 1, h: 2 },
      mausoleum: { w: 2, h: 2 },
      coach_house: { w: 2, h: 2 },
      potting_shed: { w: 1, h: 2 },
      building_small: { w: 2, h: 2 }, building_medium: { w: 3, h: 3 },
      building_large: { w: 4, h: 3 }, tavern: { w: 4, h: 3 },
      shop: { w: 2, h: 3 }, tower: { w: 2, h: 2 },
      balcony_house: { w: 3, h: 2 }, archway: { w: 3, h: 1 },
      staircase: { w: 2, h: 3 }, row_house: { w: 1, h: 2 },
      town_gate: { w: 3, h: 1 }, corner_building: { w: 2, h: 2 },
      clock_tower: { w: 3, h: 3 }, bridge: { w: 4, h: 2 },
      water_channel: { w: 1, h: 4 }, market_stall: { w: 2, h: 2 },
      wagon: { w: 3, h: 2 }, fountain: { w: 2, h: 2 },
      bench: { w: 2, h: 1 }, fence: { w: 2, h: 1 },
      stone_wall: { w: 2, h: 1 }, planter_box: { w: 2, h: 1 },
      stone_wall_v: { w: 1, h: 2 }, crenellated_wall: { w: 2, h: 1 },
      // New buildings
      chapel: { w: 3, h: 4 }, guild_hall: { w: 4, h: 4 },
      warehouse: { w: 4, h: 3 }, watchtower: { w: 2, h: 2 },
      mansion: { w: 5, h: 4 }, bakery: { w: 2, h: 2 },
      apothecary: { w: 2, h: 3 }, inn: { w: 3, h: 3 },
      temple: { w: 5, h: 5 }, covered_market: { w: 4, h: 3 },
      bell_tower: { w: 2, h: 2 }, half_timber: { w: 3, h: 2 },
      narrow_house: { w: 1, h: 3 },
      // New props
      cart: { w: 2, h: 1 }, monument: { w: 2, h: 2 },
      cloth_line: { w: 2, h: 1 },
      // New world props
      dock: { w: 3, h: 1 }, crane: { w: 2, h: 2 },
      pier: { w: 4, h: 1 }, fishing_boat: { w: 2, h: 1 },
      // District-signature decorations
      fish_rack: { w: 2, h: 1 }, rope_coil: { w: 1, h: 1 },
      trellis_arch: { w: 1, h: 2 }, flower_bed: { w: 2, h: 1 },
      bunting_pole: { w: 1, h: 1 }, heraldic_banner: { w: 1, h: 1 },
      prayer_flags: { w: 2, h: 1 }, cemetery_cross: { w: 1, h: 1 },
      forge_brazier: { w: 1, h: 1 }, rubble_pile: { w: 1, h: 1 },
      gravestone: { w: 1, h: 1 }, iron_fence: { w: 2, h: 1 },
      windmill: { w: 3, h: 3 }, farm_field: { w: 4, h: 3 },
      road_marker: { w: 1, h: 1 },
      cathedral: { w: 5, h: 6 }, lighthouse: { w: 3, h: 3 },
      round_tower: { w: 2, h: 2 }, gatehouse: { w: 4, h: 2 },
      stable: { w: 4, h: 3 }, mill: { w: 3, h: 3 },
      bell_tower_tall: { w: 2, h: 2 }, aqueduct: { w: 5, h: 1 },
      // SIX PROPS THAT RESERVED ONE TILE AND ARE NOT ONE TILE.
      //
      // The fallback below is `1x1`, so any id absent from this table quietly
      // claims a single cell — and store.ts says market_tent is 2x2 and
      // fountain_grand is 3x3. A grand fountain was reserving a ninth of
      // itself and being drawn over eight tiles the map believed were free,
      // which is the same silent overlap class the placement audit exists to
      // catch and which it cannot see, because the audit reads the reserved
      // rectangle and the reserved rectangle is the thing that is wrong.
      //
      // Found by diffing this table against store.ts rather than by looking:
      // registry.mjs already cross-checks the THREE footprint tables and
      // scopes that check by BuildingFactory.FOOTPRINTS — the building draw
      // path's own list — so a PROP whose tables disagree was invisible to the
      // tool written to catch exactly this. It checks every definition now.
      cottage: { w: 2, h: 2 }, washhouse: { w: 2, h: 2 },
      kiln: { w: 1, h: 2 }, workshop: { w: 1, h: 2 },
      smokehouse: { w: 1, h: 2 }, boathouse: { w: 2, h: 2 },
      chandlery: { w: 1, h: 2 }, customs_house: { w: 2, h: 2 },
      sail_loft: { w: 1, h: 2 }, cookshop: { w: 1, h: 2 },
      guardhouse: { w: 1, h: 2 }, armory: { w: 2, h: 2 },
      shambles: { w: 1, h: 2 },
      // The street-clutter batch. Every multi-tile one MUST be here or it
      // reserves a single cell and gets drawn over its neighbours — six props
      // were doing exactly that before registry.mjs learned to compare
      // against the value the code actually GETS rather than the table's
      // contents.
      handcart: { w: 2, h: 1 }, water_trough: { w: 2, h: 1 },
      hedge: { w: 2, h: 1 }, haystack: { w: 2, h: 2 },
      tent: { w: 2, h: 2 }, pavilion: { w: 2, h: 2 },
      well_grand: { w: 2, h: 2 },
      picket_fence: { w: 2, h: 1 }, market_tent: { w: 2, h: 2 },
      fountain_grand: { w: 3, h: 3 }, rowboat: { w: 2, h: 1 },
      skiff: { w: 2, h: 1 }, port_crane: { w: 2, h: 2 },
    }
    return footprints[defId] || { w: 1, h: 1 }
  }
}
