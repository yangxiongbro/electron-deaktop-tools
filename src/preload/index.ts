import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ApiAttemptResult,
  ApiExportResult,
  ApiImportResult,
  ApiProject,
  ApiProjectsState,
  ApiRequestDraft,
  ApiRequestSaveResult,
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
    writeText: (filePath: string, content: string) => ipcRenderer.invoke('file:write-text', filePath, content),
    writeBinary: (filePath: string, base64: string) =>
      ipcRenderer.invoke('file:write-binary', filePath, base64)
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
  projects: {
    load: () => ipcRenderer.invoke('projects:load') as Promise<ApiProjectsState>,
    create: (name: string) => ipcRenderer.invoke('projects:create', name) as Promise<ApiProject[]>,
    rename: (id: string, name: string) =>
      ipcRenderer.invoke('projects:rename', id, name) as Promise<ApiProject[]>,
    remove: (id: string) => ipcRenderer.invoke('projects:remove', id) as Promise<ApiProject[]>,
    saveRequest: (projectId: string, draft: ApiRequestDraft) =>
      ipcRenderer.invoke('projects:save-request', projectId, draft) as Promise<ApiRequestSaveResult>,
    removeRequest: (projectId: string, requestId: string) =>
      ipcRenderer.invoke('projects:remove-request', projectId, requestId) as Promise<ApiProject[]>,
    recordResult: (projectId: string, requestId: string, result: ApiAttemptResult) =>
      ipcRenderer.invoke('projects:record-result', projectId, requestId, result) as Promise<ApiProject[]>,
    exportAll: () => ipcRenderer.invoke('projects:export') as Promise<ApiExportResult>,
    importFile: () => ipcRenderer.invoke('projects:import') as Promise<ApiImportResult>,
    reveal: () => ipcRenderer.invoke('projects:reveal') as Promise<void>
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
