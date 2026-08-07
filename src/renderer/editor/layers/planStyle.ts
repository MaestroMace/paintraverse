/**
 * Shared styling for the 2D editor's plan view.
 *
 * The plan view's job is not to be a small picture of the 3D scene — it is a
 * WORKING SURFACE. Reading it should answer "what is this, and what is it
 * next to?" at a glance. It previously answered neither: every building was
 * the same beige rectangle distinguished only by a name that overflowed its
 * own footprint into the neighbour's, and every 1x1 prop was a coloured
 * circle stamped with the first letter of its name — so barrel, bench, bush,
 * bakery-crate and bunting all read as "B".
 *
 * The map already carries the semantics to fix this. Every ObjectDefinition
 * has `tags` (residential / commercial / religious / landmark / light /
 * nature / container / ...), which is exactly the axis a plan should encode.
 * This module turns those tags into a role tint and a glyph shape, and
 * provides the one text-fitting routine both layers use.
 *
 * Colour and text helpers live here rather than in each layer because both
 * had their own copy of darkenCSS already, and duplicated presentation math
 * drifts apart the same way duplicated geometry math does.
 */

// === COLOUR ===

function parseHex(hex: string): [number, number, number] {
  const c = parseInt(hex.replace('#', ''), 16)
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff]
}

function toHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return '#' + h(r) + h(g) + h(b)
}

export function darkenCSS(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex)
  return toHex(r * (1 - amount), g * (1 - amount), b * (1 - amount))
}

export function lightenCSS(hex: string, amount: number): string {
  const [r, g, b] = parseHex(hex)
  return toHex(r * (1 + amount), g * (1 + amount), b * (1 + amount))
}

/** Linear blend from `a` toward `b`. t=0 is all a, t=1 is all b. */
export function mixCSS(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a)
  const [br, bg, bb] = parseHex(b)
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t)
}

// === GROUND WASH ===

/**
 * Push a terrain colour back into the background of the plan.
 *
 * The 3D scene separates buildings from the ground with height, shading and
 * shadow. A flat plan has none of that, so it needs tonal separation instead:
 * sharing one palette with the 3D renderer (which is right — the ids must
 * mean the same thing everywhere) left warm-tan streets sitting at the same
 * value as warm-tan houses, and the town dissolved into one field of beige.
 *
 * Mixing every tile toward a dark neutral keeps the hue relationships that
 * make the palette legible — cobble still reads warmer than grass, plaza
 * still reads paler than alley — while dropping the whole terrain layer a
 * clear step below anything built on top of it. Water is washed less, since
 * "that is a river" has to survive at a glance.
 */
const GROUND_BASE = '#2a2430'

export function groundWash(hex: number, isWater: boolean): string {
  const css = '#' + hex.toString(16).padStart(6, '0')
  return mixCSS(css, GROUND_BASE, isWater ? 0.22 : 0.46)
}

// === ROLE TINT ===

/**
 * Buildings ship with colours sampled from their 3D wall material, which is
 * why 34 of them land in a 30-degree band of brown and the plan reads as
 * porridge. Nudging each toward a role hue separates them by FUNCTION while
 * keeping the app's warm palette — the blend is deliberately partial so a
 * timber house and a stone house still differ within "residential".
 *
 * Order matters: the first matching tag wins, so a religious landmark reads
 * as religious and a commercial landmark reads as a landmark.
 */
const STRUCTURE_ROLES: [string, string][] = [
  ['religious', '#8f7fb8'],     // cool violet — chapels, temples, cathedrals
  ['fortification', '#6f7d92'], // slate — walls, gatehouses, round towers
  ['military', '#6f7d92'],
  ['landmark', '#7f95b5'],      // steel blue — towers, windmills, lighthouse
  ['commercial', '#d69a4a'],    // amber — shops, taverns, guild halls
  ['noble', '#c8a6cf'],         // pale orchid — mansions
  ['residential', '#c19a6b'],   // warm tan — the default town fabric
  ['passage', '#8e8e86'],       // neutral — archways, gates
  ['functional', '#93856d'],    // stables, mills
]

const PROP_ROLES: [string, string][] = [
  ['light', '#f0b840'],
  ['nature', '#4f8f43'],
  ['water', '#4682b4'],
  ['cemetery', '#9a9a90'],
  ['religious', '#8f7fb8'],
  ['harbor', '#5f8fa8'],
  ['agricultural', '#b39a45'],
  ['commercial', '#d69a4a'],
  ['storage', '#8a6a45'],
  ['container', '#8a6a45'],
]

function roleFor(tags: string[] | undefined, table: [string, string][]): string | null {
  if (!tags) return null
  for (const [tag, hue] of table) if (tags.includes(tag)) return hue
  return null
}

/**
 * The district a building stands in, when that says more than its type does.
 *
 * A generated town is ~40% row houses by design — a medieval town IS mostly
 * terraced housing, and the placement measurements say the weight tables
 * cannot move that without wrecking the terraced rows (see the note in
 * TownGenerator.placeBuildings). So a market district is largely row houses,
 * and colouring purely by definition made every district look residential.
 *
 * But those row houses are not residential. The 3D renderer already draws a
 * row house on a trading street as a SHOPFRONT, with a hanging sign and an
 * awning — the building serves a commercial role, only its definition id
 * does not say so. The plan now reads the district the generator recorded on
 * the object and tints generic housing toward it, so markets read as markets
 * for the same reason they do in the walkaround.
 *
 * Buildings whose own type is already specific — a chapel, a mansion, a
 * guild hall — keep their type colour; a definite type outranks its address.
 */
const DISTRICT_ROLES: Record<string, string> = {
  market: '#d69a4a',      // amber, same as commercial
  artisan: '#c0803a',     // deeper amber-brown — workshops
  harbor: '#5f8fa8',      // sea blue-grey
  waterfront: '#5f8fa8',
  noble: '#c8a6cf',
  temple: '#8f7fb8',
  garden: '#6f9a55',
  cemetery: '#8a8a96',
  slum: '#7a6a5c',
  fortress: '#6f7d92',
}

/** Tags that mean "this type is generic housing" — safe to tint by district. */
const GENERIC_HOUSING = new Set([
  'building_small', 'building_medium', 'building_large', 'row_house',
  'narrow_house', 'half_timber', 'balcony_house', 'corner_building',
])

/** Blend a definition's own colour toward the hue of its structural role. */
export function structureTint(
  color: string,
  tags?: string[],
  definitionId?: string,
  district?: string,
): string {
  const role = roleFor(tags, STRUCTURE_ROLES)
  let out = role ? mixCSS(color, role, 0.34) : color

  if (district && definitionId && GENERIC_HOUSING.has(definitionId)) {
    const dh = DISTRICT_ROLES[district]
    // Residential districts are the baseline, so leave those alone entirely
    // rather than tinting them toward themselves.
    if (dh && district !== 'residential') out = mixCSS(out, dh, 0.4)
  }
  return out
}

/** Same for props, but lighter-handed: prop colours are already varied. */
export function propTint(color: string, tags?: string[]): string {
  const role = roleFor(tags, PROP_ROLES)
  return role ? mixCSS(color, role, 0.22) : color
}

// === TEXT FITTING ===

/**
 * Pick the longest form of `name` that fits in `maxW`, or null if nothing
 * does. The old code drew `def.name` unconditionally at x+3 with no width
 * check at all, so a 1x2 row house (32px wide) painted a 59px "Row House"
 * straight across its neighbour — the source of the "Row HouseHouse" and
 * "Corner Bu Row H" mush in the plan.
 *
 * Degrades full name -> word initials -> truncated first word -> nothing.
 * Callers must still clip to the footprint; this is the cosmetic choice,
 * the clip is the guarantee.
 */
export function fitLabel(
  ctx: CanvasRenderingContext2D,
  name: string,
  maxW: number,
): string | null {
  if (maxW <= 0) return null
  const fits = (s: string) => ctx.measureText(s).width <= maxW

  if (fits(name)) return name

  const words = name.split(/\s+/).filter(Boolean)
  if (words.length > 1) {
    const initials = words.map((w) => w[0].toUpperCase()).join('')
    if (fits(initials)) return initials
  }

  // Truncate the first word, longest-first. Below two characters a label is
  // noise rather than information, so we draw nothing and let the shape,
  // tint and the hover tooltip carry it.
  const first = words[0] ?? name
  for (let n = first.length - 1; n >= 2; n--) {
    const cut = first.slice(0, n)
    if (fits(cut)) return cut
  }
  return null
}

/**
 * Draw text with a real outline rather than a drop shadow. White-on-shadow
 * vanished against the pale stone buildings (lighthouse is #E8E0D0); an
 * outline holds contrast against any body colour.
 */
export function drawOutlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
): void {
  ctx.lineJoin = 'round'
  ctx.lineWidth = 3
  ctx.strokeStyle = 'rgba(12,8,16,0.85)'
  ctx.strokeText(text, x, y)
  ctx.fillStyle = '#f4ece0'
  ctx.fillText(text, x, y)
}

// === PROP GLYPHS ===

export type Glyph =
  | 'dot' | 'square' | 'triangle' | 'bar' | 'star'
  | 'cross' | 'diamond' | 'wheel' | 'post' | 'wave' | 'chevron'

/**
 * A shape vocabulary, so classes of prop are distinguishable without a
 * legend and without reading any text. You may not know which container it
 * is, but you can see that a row of squares is storage and a scatter of
 * triangles is planting — which is the question a plan view is actually
 * asked.
 */
const GLYPH_BY_TAG: [string, Glyph][] = [
  ['light', 'star'],
  ['cemetery', 'cross'],
  ['nature', 'triangle'],
  ['container', 'square'],
  ['storage', 'square'],
  ['seating', 'bar'],
  ['furniture', 'bar'],
  ['barrier', 'bar'],
  ['transport', 'wheel'],
  ['info', 'post'],
  ['water', 'wave'],
  ['agricultural', 'chevron'],
  ['debris', 'dot'],
  ['landmark', 'diamond'],
  ['decoration', 'diamond'],
]

export function glyphFor(tags?: string[]): Glyph {
  if (!tags) return 'dot'
  for (const [tag, g] of GLYPH_BY_TAG) if (tags.includes(tag)) return g
  return 'dot'
}

/** Stroke a glyph centred on (cx, cy) at radius r. Caller sets strokeStyle. */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  glyph: Glyph,
  cx: number,
  cy: number,
  r: number,
): void {
  ctx.beginPath()
  switch (glyph) {
    case 'square':
      ctx.rect(cx - r * 0.62, cy - r * 0.62, r * 1.24, r * 1.24)
      break
    case 'triangle':
      ctx.moveTo(cx, cy - r * 0.8)
      ctx.lineTo(cx + r * 0.72, cy + r * 0.6)
      ctx.lineTo(cx - r * 0.72, cy + r * 0.6)
      ctx.closePath()
      break
    case 'bar':
      ctx.rect(cx - r * 0.78, cy - r * 0.26, r * 1.56, r * 0.52)
      break
    case 'star':
      // Four spokes reads as "emits light" at this size; a real star does not.
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2 + Math.PI / 4
        ctx.moveTo(cx, cy)
        ctx.lineTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9)
      }
      break
    case 'cross':
      ctx.moveTo(cx, cy - r * 0.85)
      ctx.lineTo(cx, cy + r * 0.85)
      ctx.moveTo(cx - r * 0.55, cy - r * 0.25)
      ctx.lineTo(cx + r * 0.55, cy - r * 0.25)
      break
    case 'diamond':
      ctx.moveTo(cx, cy - r * 0.85)
      ctx.lineTo(cx + r * 0.72, cy)
      ctx.lineTo(cx, cy + r * 0.85)
      ctx.lineTo(cx - r * 0.72, cy)
      ctx.closePath()
      break
    case 'wheel':
      ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2)
      ctx.moveTo(cx - r * 0.72, cy)
      ctx.lineTo(cx + r * 0.72, cy)
      ctx.moveTo(cx, cy - r * 0.72)
      ctx.lineTo(cx, cy + r * 0.72)
      break
    case 'post':
      ctx.moveTo(cx - r * 0.15, cy + r * 0.85)
      ctx.lineTo(cx - r * 0.15, cy - r * 0.85)
      ctx.lineTo(cx + r * 0.7, cy - r * 0.5)
      ctx.lineTo(cx - r * 0.15, cy - r * 0.15)
      break
    case 'wave':
      ctx.moveTo(cx - r * 0.8, cy + r * 0.2)
      ctx.quadraticCurveTo(cx - r * 0.4, cy - r * 0.5, cx, cy + r * 0.2)
      ctx.quadraticCurveTo(cx + r * 0.4, cy + r * 0.9, cx + r * 0.8, cy + r * 0.2)
      break
    case 'chevron':
      ctx.moveTo(cx - r * 0.7, cy + r * 0.1)
      ctx.lineTo(cx, cy - r * 0.6)
      ctx.lineTo(cx + r * 0.7, cy + r * 0.1)
      ctx.moveTo(cx - r * 0.7, cy + r * 0.7)
      ctx.lineTo(cx, cy)
      ctx.lineTo(cx + r * 0.7, cy + r * 0.7)
      break
    case 'dot':
    default:
      ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2)
      break
  }
  ctx.stroke()
}
