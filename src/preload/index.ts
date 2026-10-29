import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ApiHistoryDraft,
  ApiHistoryEntry,
  AppSettings,
  DesktopApi,
  HttpProgress,
  HttpResponseResult,
  HttpRequestConfig,
  JsonFileRequest,
  JsonFileResult,
  OpenFileOptions,
  SaveFileOptions
} from '@shared/types'

const api: DesktopApi = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
    update: (patch) => ipcRenderer.invoke('settings:update', patch) as Promise<AppSettings>,
    chooseDownloadDir: () =>
      ipcRenderer.invoke('settings:choose-download-dir') as Promise<{ canceled: boolean; dirPath?: string }>,
    onChanged: (callback) => {
      const handler = (_event: IpcRendererEvent, settings: AppSettings): void => callback(settings)
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.removeListener('settings:changed', handler)
    }
  },
  dialog: {
    openFile: (options?: OpenFileOptions) => ipcRenderer.invoke('dialog:open-file', options),
    saveFile: (options?: SaveFileOptions) => ipcRenderer.invoke('dialog:save-file', options)
  },
  file: {
    readText: (filePath: string) => ipcRenderer.invoke('file:read-text', filePath),
    writeText: (filePath: string, content: string) => ipcRenderer.invoke('file:write-text', filePath, content)
  },
  json: {
    formatFile: (request: JsonFileRequest) =>
      ipcRenderer.invoke('json:format-file', request) as Promise<JsonFileResult>,
    onProgress: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: { loaded: number; total: number }): void =>
        callback(payload)
      ipcRenderer.on('json:progress', handler)
      return () => ipcRenderer.removeListener('json:progress', handler)
    }
  },
  http: {
    request: (config: HttpRequestConfig) =>
      ipcRenderer.invoke('http:request', config) as Promise<HttpResponseResult>,
    abort: (requestId: string) => ipcRenderer.invoke('http:abort', requestId) as Promise<void>,
    onProgress: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: HttpProgress): void => callback(payload)
      ipcRenderer.on('http:progress', handler)
      return () => ipcRenderer.removeListener('http:progress', handler)
    }
  },
  history: {
    list: () => ipcRenderer.invoke('history:list') as Promise<ApiHistoryEntry[]>,
    add: (entry: ApiHistoryDraft) => ipcRenderer.invoke('history:add', entry) as Promise<ApiHistoryEntry[]>,
    remove: (id: string) => ipcRenderer.invoke('history:remove', id) as Promise<ApiHistoryEntry[]>,
    clear: () => ipcRenderer.invoke('history:clear') as Promise<ApiHistoryEntry[]>
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openPath: (targetPath: string) => ipcRenderer.invoke('app:open-path', targetPath),
    showItemInFolder: (targetPath: string) => ipcRenderer.invoke('app:show-item', targetPath),
    openExternal: (url: string) => ipcRenderer.invoke('app:open-external', url)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('api', api)
