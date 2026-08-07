/**
 * Platform shim — one file-I/O interface, two backends.
 *
 * The app was written against `window.electronAPI`, seven functions that go
 * over IPC to the main process for native save/open dialogs. That object does
 * not exist in a browser or in an Android WebView, and the two call sites
 * both did `if (!window.electronAPI) return` — so off Electron, Save and Open
 * silently did nothing at all, with no error and no explanation.
 *
 * Rather than leave the web build half-functional, this provides the same
 * operations on browser primitives: a download for save, a file picker for
 * open, FileReader for images. Electron still gets the real native dialogs
 * when it is there, because those are genuinely better on a desktop.
 *
 * The `path` values differ in meaning between backends — a real filesystem
 * path under Electron, a bare filename in the browser — so treat one as an
 * opaque handle produced by openFile/saveFile and passed back, never as
 * something to parse.
 */

export interface ElectronAPI {
  saveDialog: (defaultPath?: string) => Promise<string | null>
  openDialog: () => Promise<string | null>
  openImageDialog: () => Promise<string | null>
  writeFile: (path: string, data: string) => Promise<boolean>
  readFile: (path: string) => Promise<string>
  readImageAsDataURL: (path: string) => Promise<string>
  onMenuAction: (callback: (action: string) => void) => void
}

declare global {
  interface Window { electronAPI?: ElectronAPI }
}

/** True when running inside Electron with the preload bridge available. */
export const isElectron = (): boolean =>
  typeof window !== 'undefined' && !!window.electronAPI

/** True when the app is running on a touch-primary device (phone/tablet). */
export const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' &&
  (('ontouchstart' in window) || navigator.maxTouchPoints > 0) &&
  !window.matchMedia('(pointer: fine)').matches

/**
 * When to use the phone layout (rails become drawers, viewport goes
 * full-bleed). This string is duplicated verbatim in App.css — keep them in
 * step, since a mismatch means React thinks the rails are drawers while CSS
 * still lays them out as columns, or the reverse.
 *
 * Width alone is not enough, and getting that wrong is what shipped a broken
 * first APK. The original rule was `max-width: 820px`, which a Pixel in
 * PORTRAIT satisfies at 412px — so emulation looked perfect. Rotate the same
 * phone and it is 915px wide, falls through to the desktop three-column
 * layout, and the 3D view collapses into a narrow middle column between two
 * rails. A Fold is 841px even unrotated.
 *
 * So: narrow by width, OR a coarse pointer on anything up to a large tablet.
 * The width ceiling on the coarse branch keeps a touchscreen laptop on the
 * desktop layout, where it belongs.
 */
export const MOBILE_LAYOUT_QUERY =
  '(max-width: 900px), (pointer: coarse) and (max-width: 1180px)'

/** Evaluate the phone-layout query right now. */
export const isMobileLayout = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia(MOBILE_LAYOUT_QUERY).matches

// === Browser file helpers ===

/** Prompt a download. The browser owns where it lands; we only pick a name. */
function downloadText(filename: string, data: string, mime = 'application/json'): void {
  const blob = new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cancel the download in some engines.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Open a hidden file input and resolve with the chosen File, or null. */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    // 'cancel' is not universally supported, so a focus-based fallback keeps
    // the promise from hanging forever if the user dismisses the picker.
    let settled = false
    const done = (f: File | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(f)
    }
    input.addEventListener('change', () => done(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => done(null))
    document.body.appendChild(input)
    input.click()
  })
}

// Files chosen in the browser are held here so readFile(path) can find them
// again; the browser has no path we could re-open from.
const _pendingFiles = new Map<string, File>()

// === The unified surface ===

export const platform = {
  /**
   * Ask where to save. Electron returns a real path; the browser has no such
   * concept before the download happens, so it returns the filename and the
   * actual write is what triggers the download.
   */
  async saveDialog(defaultPath?: string): Promise<string | null> {
    if (window.electronAPI) return window.electronAPI.saveDialog(defaultPath)
    const suggested = defaultPath?.split(/[\\/]/).pop() || 'town.ptv.json'
    const name = window.prompt('Save as', suggested)
    return name ? name : null
  },

  async openDialog(): Promise<string | null> {
    if (window.electronAPI) return window.electronAPI.openDialog()
    const file = await pickFile('.json,.ptv,application/json')
    if (!file) return null
    _pendingFiles.set(file.name, file)
    return file.name
  },

  async openImageDialog(): Promise<string | null> {
    if (window.electronAPI) return window.electronAPI.openImageDialog()
    const file = await pickFile('image/png,image/jpeg,image/webp')
    if (!file) return null
    _pendingFiles.set(file.name, file)
    return file.name
  },

  async writeFile(path: string, data: string): Promise<boolean> {
    if (window.electronAPI) return window.electronAPI.writeFile(path, data)
    downloadText(path, data)
    return true
  },

  async readFile(path: string): Promise<string> {
    if (window.electronAPI) return window.electronAPI.readFile(path)
    const file = _pendingFiles.get(path)
    if (!file) throw new Error(`no pending file for "${path}"`)
    return file.text()
  },

  async readImageAsDataURL(path: string): Promise<string> {
    if (window.electronAPI) return window.electronAPI.readImageAsDataURL(path)
    const file = _pendingFiles.get(path)
    if (!file) throw new Error(`no pending file for "${path}"`)
    return new Promise((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(String(fr.result))
      fr.onerror = () => reject(fr.error)
      fr.readAsDataURL(file)
    })
  },

  /** Native menu bar only exists under Electron; a no-op elsewhere. */
  onMenuAction(callback: (action: string) => void): void {
    window.electronAPI?.onMenuAction(callback)
  },
}
