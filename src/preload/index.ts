import { contextBridge, ipcRenderer } from 'electron'

export interface ElectronAPI {
  saveDialog: (defaultPath?: string) => Promise<string | null>
  openDialog: () => Promise<string | null>
  writeFile: (path: string, data: string) => Promise<boolean>
  readFile: (path: string) => Promise<string>
  onMenuAction: (callback: (action: string) => void) => void
}

contextBridge.exposeInMainWorld('electronAPI', {
  saveDialog: (defaultPath?: string) =>
    ipcRenderer.invoke('dialog:save', defaultPath),
  openDialog: () =>
    ipcRenderer.invoke('dialog:open'),
  writeFile: (path: string, data: string) =>
    ipcRenderer.invoke('file:write', path, data),
  readFile: (path: string) =>
    ipcRenderer.invoke('file:read', path),
  onMenuAction: (callback: (action: string) => void) => {
    const actions = ['new', 'open', 'save', 'save-as', 'undo', 'redo', 'delete']
    for (const action of actions) {
      ipcRenderer.on(`menu:${action}`, () => callback(action))
    }
  }
} satisfies ElectronAPI)
