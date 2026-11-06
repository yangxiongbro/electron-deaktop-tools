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
  ChatFriend,
  ChatFriendInput,
  ChatMessage,
  ChatProfile,
  ChatSendInput,
  ChatState,
  DesktopApi,
  FileStatResult,
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
      ipcRenderer.invoke('file:write-binary', filePath, base64),
    stat: (filePath: string) => ipcRenderer.invoke('file:stat', filePath) as Promise<FileStatResult>
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
    createFolder: (projectId: string, name: string, parentId: string | null) =>
      ipcRenderer.invoke('projects:create-folder', projectId, name, parentId) as Promise<ApiProject[]>,
    renameFolder: (projectId: string, folderId: string, name: string) =>
      ipcRenderer.invoke('projects:rename-folder', projectId, folderId, name) as Promise<ApiProject[]>,
    removeFolder: (projectId: string, folderId: string) =>
      ipcRenderer.invoke('projects:remove-folder', projectId, folderId) as Promise<ApiProject[]>,
    moveRequest: (projectId: string, requestId: string, folderId: string | null) =>
      ipcRenderer.invoke('projects:move-request', projectId, requestId, folderId) as Promise<ApiProject[]>,
    reorderRequests: (projectId: string, folderId: string | null, orderedIds: string[]) =>
      ipcRenderer.invoke('projects:reorder-requests', projectId, folderId, orderedIds) as Promise<ApiProject[]>,
    reorderFolders: (projectId: string, parentId: string | null, orderedIds: string[]) =>
      ipcRenderer.invoke('projects:reorder-folders', projectId, parentId, orderedIds) as Promise<ApiProject[]>,
    recordResult: (projectId: string, requestId: string, result: ApiAttemptResult) =>
      ipcRenderer.invoke('projects:record-result', projectId, requestId, result) as Promise<ApiProject[]>,
    exportAll: () => ipcRenderer.invoke('projects:export') as Promise<ApiExportResult>,
    importFile: () => ipcRenderer.invoke('projects:import') as Promise<ApiImportResult>,
    reveal: () => ipcRenderer.invoke('projects:reveal') as Promise<void>
  },
  chat: {
    state: () => ipcRenderer.invoke('chat:state') as Promise<ChatState>,
    updateProfile: (patch: Partial<Pick<ChatProfile, 'nickname' | 'avatar' | 'port'>>) =>
      ipcRenderer.invoke('chat:update-profile', patch) as Promise<ChatState>,
    addFriend: (input: ChatFriendInput) => ipcRenderer.invoke('chat:add-friend', input) as Promise<ChatState>,
    sendFriendRequest: (input: ChatFriendInput) =>
      ipcRenderer.invoke('chat:send-friend-request', input) as Promise<ChatState>,
    respondFriendRequest: (id: string, accepted: boolean) =>
      ipcRenderer.invoke('chat:respond-friend-request', id, accepted) as Promise<ChatState>,
    dismissRequest: (id: string) =>
      ipcRenderer.invoke('chat:dismiss-request', id) as Promise<ChatState>,
    resendRequests: () => ipcRenderer.invoke('chat:resend-requests') as Promise<ChatState>,
    updateFriend: (id: string, patch: Partial<ChatFriendInput>) =>
      ipcRenderer.invoke('chat:update-friend', id, patch) as Promise<ChatState>,
    removeFriend: (id: string) => ipcRenderer.invoke('chat:remove-friend', id) as Promise<ChatState>,
    refreshFriend: (id: string) =>
      ipcRenderer.invoke('chat:refresh-friend', id) as Promise<ChatFriend | null>,
    refreshAll: () => ipcRenderer.invoke('chat:refresh-all') as Promise<ChatFriend[]>,
    send: (input: ChatSendInput) => ipcRenderer.invoke('chat:send-text', input) as Promise<ChatMessage>,
    sendImage: (friendId: string, dataUrl: string, fileName: string) =>
      ipcRenderer.invoke('chat:send-image', friendId, dataUrl, fileName) as Promise<ChatMessage>,
    sendFile: (friendId: string, filePath: string) =>
      ipcRenderer.invoke('chat:send-file', friendId, filePath) as Promise<ChatMessage>,
    clearHistory: (friendId: string) =>
      ipcRenderer.invoke('chat:clear-history', friendId) as Promise<ChatState>,
    readImage: (filePath: string) => ipcRenderer.invoke('chat:image-data', filePath) as Promise<string>,
    chooseChatDir: () =>
      ipcRenderer.invoke('chat:choose-dir') as Promise<{ canceled: boolean; dirPath?: string }>,
    openChatDir: () => ipcRenderer.invoke('chat:open-dir') as Promise<void>,
    openFile: (filePath: string) => ipcRenderer.invoke('chat:open-file', filePath) as Promise<void>,
    revealFile: (filePath: string) => ipcRenderer.invoke('chat:reveal-file', filePath) as Promise<void>,
    onMessage: (callback) => {
      const handler = (_event: IpcRendererEvent, message: ChatMessage): void => callback(message)
      ipcRenderer.on('chat:message', handler)
      return () => ipcRenderer.removeListener('chat:message', handler)
    },
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, state: ChatState): void => callback(state)
      ipcRenderer.on('chat:state', handler)
      return () => ipcRenderer.removeListener('chat:state', handler)
    }
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
