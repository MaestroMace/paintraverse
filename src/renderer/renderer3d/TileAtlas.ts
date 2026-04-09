// ═══════════════════════════════════════════════════════════════
// Tile Atlas: Pre-Rendered Sprite Cache
// ═══════════════════════════════════════════════════════════════
// Instead of 40-80 canvas draw calls per building per frame,
// render each unique visual element ONCE to an offscreen atlas,
// then blit with a single drawImage() call.
//
// Atlas key = definitionId + paletteIndex + floors + style + viewAngle
// On a typical scene: ~50-100 unique atlas entries cover ALL buildings
// and props, because many share the same type+palette combination.
// ═══════════════════════════════════════════════════════════════

const ATLAS_TILE_SIZE = 128 // max size per atlas entry (pixels)
const ATLAS_PAGE_SIZE = 2048 // atlas page dimensions

interface AtlasEntry {
  pageIndex: number
  sx: number; sy: number // source position in atlas page
  sw: number; sh: number // source dimensions
  anchorX: number; anchorY: number // anchor point (base center of object)
}

interface AtlasPage {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  nextX: number
  nextY: number
  rowHeight: number
}

// Global atlas state
let _pages: AtlasPage[] = []
let _entries = new Map<string, AtlasEntry>()
let _atlasKey = '' // invalidation key (lighting + palette + angle)

function createPage(): AtlasPage {
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS_PAGE_SIZE
  canvas.height = ATLAS_PAGE_SIZE
  return {
    canvas,
    ctx: canvas.getContext('2d')!,
    nextX: 0, nextY: 0, rowHeight: 0
  }
}

function allocateSlot(w: number, h: number): { page: AtlasPage; x: number; y: number } {
  const tw = Math.min(w, ATLAS_PAGE_SIZE)
  const th = Math.min(h, ATLAS_PAGE_SIZE)

  for (const page of _pages) {
    // Try to fit in current row
    if (page.nextX + tw <= ATLAS_PAGE_SIZE && page.nextY + th <= ATLAS_PAGE_SIZE) {
      const x = page.nextX, y = page.nextY
      page.nextX += tw + 1 // 1px gap to avoid bleeding
      page.rowHeight = Math.max(page.rowHeight, th)
      return { page, x, y }
    }
    // Try next row
    if (tw <= ATLAS_PAGE_SIZE && page.nextY + page.rowHeight + th + 1 <= ATLAS_PAGE_SIZE) {
      page.nextX = 0
      page.nextY += page.rowHeight + 1
      page.rowHeight = th
      const x = 0, y = page.nextY
      page.nextX = tw + 1
      return { page, x, y }
    }
  }

  // Need a new page
  const page = createPage()
  _pages.push(page)
  page.nextX = tw + 1
  page.rowHeight = th
  return { page, x: 0, y: 0 }
}

/** Check if the atlas needs rebuilding (lighting/palette/angle changed) */
export function atlasNeedsRebuild(key: string): boolean {
  return key !== _atlasKey
}

/** Clear the atlas for rebuilding */
export function clearAtlas(newKey: string): void {
  _pages = []
  _entries.clear()
  _atlasKey = newKey
}

/** Get a cached atlas entry, or null if not yet rendered */
export function getAtlasEntry(key: string): AtlasEntry | null {
  return _entries.get(key) ?? null
}

/**
 * Render a visual element to the atlas.
 * The `renderFn` receives a context positioned at (0,0) with the given dimensions.
 * It should draw the element as if drawing to a standalone canvas.
 */
export function renderToAtlas(
  key: string,
  width: number, height: number,
  anchorX: number, anchorY: number,
  renderFn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
): AtlasEntry {
  const existing = _entries.get(key)
  if (existing) return existing

  const { page, x, y } = allocateSlot(width, height)

  // Draw to atlas at the allocated position
  page.ctx.save()
  page.ctx.translate(x, y)
  // Clip to prevent bleeding
  page.ctx.beginPath()
  page.ctx.rect(0, 0, width, height)
  page.ctx.clip()
  renderFn(page.ctx, width, height)
  page.ctx.restore()

  const entry: AtlasEntry = {
    pageIndex: _pages.indexOf(page),
    sx: x, sy: y, sw: width, sh: height,
    anchorX, anchorY
  }
  _entries.set(key, entry)
  return entry
}

/** Blit an atlas entry to the target context at the given screen position */
export function blitFromAtlas(
  ctx: CanvasRenderingContext2D,
  entry: AtlasEntry,
  screenX: number, screenY: number
): void {
  const page = _pages[entry.pageIndex]
  if (!page) return
  ctx.drawImage(
    page.canvas,
    entry.sx, entry.sy, entry.sw, entry.sh,
    screenX - entry.anchorX, screenY - entry.anchorY, entry.sw, entry.sh
  )
}

/** Get atlas stats for debugging */
export function getAtlasStats(): { pages: number; entries: number; totalPixels: number } {
  return {
    pages: _pages.length,
    entries: _entries.size,
    totalPixels: _pages.reduce((s, p) => s + p.canvas.width * p.canvas.height, 0)
  }
}
