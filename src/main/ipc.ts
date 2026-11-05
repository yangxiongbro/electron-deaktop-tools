import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  AppInfo,
  AppSettings,
  ApiExportResult,
  ApiImportResult,
  ApiProjectsState,
  ApiRequestDraft,
  ApiRequestSaveResult,
  ApiAttemptResult,
  ChatFriendInput,
  ChatMessage,
  ChatProfile,
  ChatSendInput,
  ChatState,
  FilePickResult,
  FileStatResult,
  JsonFileRequest,
  JsonFileResult,
  OpenFileOptions,
  SaveFileOptions,
  WriteTextResult,
  ReadTextResult
} from '@shared/types'
import { formatJsonFile } from './jsonFile'
import { abortHttpRequest, performHttpRequest } from './httpClient'
import {
  createFolder,
  createProject,
  dataFile as apiDataFile,
  exportProjectsTo,
  importProjectsFrom,
  loadProjects,
  moveRequest,
  projectsState,
  recordResult,
  removeFolder,
  removeProject,
  removeRequest,
  renameFolder,
  renameProject,
  reorderFolders,
  reorderRequests,
  saveRequest
} from './apiProjects'
import {
  addFriend,
  chatDataFile,
  chatState,
  clearHistory,
  dismissRequest,
  readImageDataUrl,
  refreshAllFriends,
  refreshFriend,
  removeFriend,
  resendPendingRequests,
  respondFriendRequest,
  sendFile,
  sendFriendRequest,
  sendImage,
  sendText,
  setChatDir,
  updateFriend,
  updateProfile
} from './chat'
import { configDir, defaultDownloadDir, loadSettings, settingsFile, updateSettings } from './store'
import { applyWindowChrome } from './windowChrome'
import type { HttpRequestConfig } from '@shared/types'

const MAX_TEXT_FILE_BYTES = 32 * 1024 * 1024

function assertAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label}不能为空`)
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) throw new Error(`${label}必须是绝对路径`)
  return value
}

async function statQuiet(filePath: string): Promise<number | undefined> {
  try {
    const stat = await fsp.stat(filePath)
    return stat.size
  } catch {
    return undefined
  }
}

export function registerIpcHandlers(): void {
  /* ----------------------------- 设置 ----------------------------- */

  ipcMain.handle('settings:get', (): AppSettings => loadSettings())

  ipcMain.handle('settings:update', async (_event: IpcMainInvokeEvent, patch: Partial<AppSettings>) => {
    const next = await updateSettings(patch ?? {})
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) applyWindowChrome(win, next.theme)
      win.webContents.send('settings:changed', next)
    }
    return next
  })

  ipcMain.handle('settings:choose-download-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, {
          title: '选择默认下载目录',
          defaultPath: loadSettings().downloadDir,
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: '选择默认下载目录',
          defaultPath: loadSettings().downloadDir,
          properties: ['openDirectory', 'createDirectory']
        })
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    return { canceled: false, dirPath: result.filePaths[0] }
  })

  /* ----------------------------- 对话框 --------------------------- */

  ipcMain.handle('dialog:open-file', async (event, options: OpenFileOptions = {}): Promise<FilePickResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const args = {
      title: options.title ?? '选择文件',
      defaultPath: options.defaultPath || loadSettings().downloadDir,
      filters: options.filters && options.filters.length ? options.filters : undefined,
      properties: ['openFile' as const]
    }
    const result = win ? await dialog.showOpenDialog(win, args) : await dialog.showOpenDialog(args)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const filePath = result.filePaths[0]
    return {
      canceled: false,
      filePath,
      fileName: filePath.split(/[\\/]/).pop() ?? filePath,
      size: await statQuiet(filePath)
    }
  })

  ipcMain.handle('dialog:save-file', async (event, options: SaveFileOptions = {}): Promise<FilePickResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const settings = loadSettings()
    const defaultPath =
      options.defaultPath || join(settings.downloadDir, options.defaultFileName || 'untitled.txt')
    const args = {
      title: options.title ?? '保存文件',
      defaultPath,
      filters: options.filters && options.filters.length ? options.filters : undefined
    }
    const result = win ? await dialog.showSaveDialog(win, args) : await dialog.showSaveDialog(args)
    if (result.canceled || !result.filePath) return { canceled: true }
    return { canceled: false, filePath: result.filePath, fileName: result.filePath.split(/[\\/]/).pop() }
  })

  /* ----------------------------- 文件读写 -------------------------- */

  ipcMain.handle('file:read-text', async (_event, filePath: string): Promise<ReadTextResult> => {
    try {
      const target = assertAbsolutePath(filePath, '文件路径')
      const stat = await fsp.stat(target)
      if (stat.size > MAX_TEXT_FILE_BYTES) {
        return { ok: false, error: `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），请使用"文件处理"模式` }
      }
      const content = await fsp.readFile(target, 'utf8')
      return { ok: true, content, size: stat.size }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'file:write-text',
    async (_event, filePath: string, content: string): Promise<WriteTextResult> => {
      try {
        const target = assertAbsolutePath(filePath, '文件路径')
        await fsp.writeFile(target, content ?? '', 'utf8')
        return { ok: true, filePath: target, bytes: Buffer.byteLength(content ?? '', 'utf8') }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle(
    'file:write-binary',
    async (_event, filePath: string, base64: string): Promise<WriteTextResult> => {
      try {
        const target = assertAbsolutePath(filePath, '文件路径')
        if (typeof base64 !== 'string' || !base64) throw new Error('二进制内容为空')
        const buffer = Buffer.from(base64, 'base64')
        if (!buffer.length) throw new Error('二进制内容解析失败')
        await fsp.mkdir(dirname(target), { recursive: true }).catch(() => undefined)
        await fsp.writeFile(target, buffer)
        return { ok: true, filePath: target, bytes: buffer.length }
      } catch (error) {
        return { ok: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('file:stat', async (_event, filePath: string): Promise<FileStatResult> => {
    try {
      const target = assertAbsolutePath(filePath, '文件路径')
      const stat = await fsp.stat(target)
      return { exists: true, mtimeMs: stat.mtimeMs, size: stat.size }
    } catch {
      return { exists: false, mtimeMs: 0, size: 0 }
    }
  })

  /* ----------------------------- JSON 文件 ------------------------- */

  ipcMain.handle('json:format-file', async (event, request: JsonFileRequest): Promise<JsonFileResult> => {
    const inputPath = assertAbsolutePath(request?.inputPath, '输入文件路径')
    const outputPath = assertAbsolutePath(request?.outputPath, '输出文件路径')
    let lastReport = 0
    return formatJsonFile(
      {
        inputPath,
        outputPath,
        indent: request.indent ?? 2,
        minify: request.minify ?? false
      },
      (loaded, total) => {
        const now = Date.now()
        if (now - lastReport < 120) return
        lastReport = now
        if (!event.sender.isDestroyed()) event.sender.send('json:progress', { loaded, total })
      }
    )
  })

  /* ----------------------------- HTTP ----------------------------- */

  ipcMain.handle('http:request', async (event, config: HttpRequestConfig) => {
    let lastReport = 0
    return performHttpRequest(config, (loaded, total) => {
      const now = Date.now()
      if (now - lastReport < 120) return
      lastReport = now
      if (!event.sender.isDestroyed()) {
        event.sender.send('http:progress', { requestId: config.requestId, loaded, total })
      }
    })
  })

  ipcMain.handle('http:abort', (_event, requestId: string) => {
    abortHttpRequest(requestId)
  })

  /* ----------------------------- 项目 / 请求记录 -------------------- */

  ipcMain.handle('projects:load', (): Promise<ApiProjectsState> => projectsState())

  ipcMain.handle('projects:create', (_event, name: string) => createProject(name))

  ipcMain.handle('projects:rename', (_event, id: string, name: string) => renameProject(id, name))

  ipcMain.handle('projects:remove', (_event, id: string) => removeProject(id))

  ipcMain.handle(
    'projects:save-request',
    (_event, projectId: string, draft: ApiRequestDraft): Promise<ApiRequestSaveResult> =>
      saveRequest(projectId, draft)
  )

  ipcMain.handle('projects:remove-request', (_event, projectId: string, requestId: string) =>
    removeRequest(projectId, requestId)
  )

  ipcMain.handle(
    'projects:create-folder',
    (_event, projectId: string, name: string, parentId: string | null) =>
      createFolder(projectId, name, parentId ?? null)
  )

  ipcMain.handle('projects:rename-folder', (_event, projectId: string, folderId: string, name: string) =>
    renameFolder(projectId, folderId, name)
  )

  ipcMain.handle('projects:remove-folder', (_event, projectId: string, folderId: string) =>
    removeFolder(projectId, folderId)
  )

  ipcMain.handle(
    'projects:reorder-requests',
    (_event, projectId: string, folderId: string | null, orderedIds: string[]) =>
      reorderRequests(projectId, folderId ?? null, Array.isArray(orderedIds) ? orderedIds : [])
  )

  ipcMain.handle(
    'projects:reorder-folders',
    (_event, projectId: string, parentId: string | null, orderedIds: string[]) =>
      reorderFolders(projectId, parentId ?? null, Array.isArray(orderedIds) ? orderedIds : [])
  )

  ipcMain.handle('projects:move-request', (_event, projectId: string, requestId: string, folderId: string | null) =>
    moveRequest(projectId, requestId, folderId ?? null)
  )

  ipcMain.handle(
    'projects:record-result',
    (_event, projectId: string, requestId: string, result: ApiAttemptResult) =>
      recordResult(projectId, requestId, result)
  )

  ipcMain.handle('projects:export', async (event): Promise<ApiExportResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const settings = loadSettings()
    const now = new Date()
    const pad = (value: number): string => String(value).padStart(2, '0')
    const stamp =
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}`
    const args = {
      title: '导出全部请求数据',
      defaultPath: join(settings.downloadDir, `devtoolbox-api-requests-${stamp}.json`),
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, args) : await dialog.showSaveDialog(args)
    if (result.canceled || !result.filePath) return { canceled: true }
    try {
      const summary = await exportProjectsTo(result.filePath)
      return { canceled: false, filePath: result.filePath, requests: summary.requests }
    } catch (error) {
      return { canceled: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('projects:import', async (event): Promise<ApiImportResult> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const args = {
      title: '导入请求数据',
      defaultPath: loadSettings().downloadDir,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile' as const]
    }
    const result = win ? await dialog.showOpenDialog(win, args) : await dialog.showOpenDialog(args)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    const filePath = assertAbsolutePath(result.filePaths[0], '导入文件路径')
    try {
      const summary = await importProjectsFrom(filePath)
      return {
        canceled: false,
        projects: summary.projects,
        importedProjects: summary.importedProjects,
        importedRequests: summary.importedRequests
      }
    } catch (error) {
      return { canceled: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('projects:reveal', async () => {
    await loadProjects()
    shell.showItemInFolder(apiDataFile())
  })

  /* ----------------------------- 应用信息 -------------------------- */

  ipcMain.handle('app:info', (): AppInfo => {
    const pkg = app.getVersion()
    return {
      name: app.getName(),
      version: pkg,
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      platform: process.platform,
      arch: process.arch,
      v8: process.versions.v8 ?? '',
      userDataPath: app.getPath('userData'),
      defaultDownloadDir: defaultDownloadDir(),
      configDir: configDir(),
      settingsFile: settingsFile(),
      apiDataFile: apiDataFile(),
      chatDataFile: chatDataFile()
    }
  })

  ipcMain.handle('app:open-path', async (_event, targetPath: string) => {
    const target = assertAbsolutePath(targetPath, '路径')
    return shell.openPath(target)
  })

  ipcMain.handle('app:show-item', async (_event, targetPath: string) => {
    const target = assertAbsolutePath(targetPath, '路径')
    shell.showItemInFolder(target)
  })

  ipcMain.handle('app:open-external', async (_event, url: string) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('只允许打开 http/https 链接')
    }
    await shell.openExternal(url)
  })

  /* ----------------------------- 本地聊天 -------------------------- */

  ipcMain.handle('chat:state', (): Promise<ChatState> => chatState())

  ipcMain.handle(
    'chat:update-profile',
    (_event, patch: Partial<Pick<ChatProfile, 'nickname' | 'avatar' | 'port'>>) => updateProfile(patch ?? {})
  )

  ipcMain.handle('chat:add-friend', (_event, input: ChatFriendInput) => addFriend(input))

  ipcMain.handle('chat:send-friend-request', (_event, input: ChatFriendInput) => sendFriendRequest(input))

  ipcMain.handle(
    'chat:respond-friend-request',
    (_event, id: string, accepted: boolean, inheritHistory: boolean) =>
      respondFriendRequest(id, Boolean(accepted), Boolean(inheritHistory))
  )

  ipcMain.handle('chat:dismiss-request', (_event, id: string) => dismissRequest(id))

  ipcMain.handle('chat:resend-requests', () => resendPendingRequests())

  ipcMain.handle('chat:update-friend', (_event, id: string, patch: Partial<ChatFriendInput>) =>
    updateFriend(id, patch ?? {})
  )

  ipcMain.handle('chat:remove-friend', (_event, id: string) => removeFriend(id))

  ipcMain.handle('chat:refresh-friend', (_event, id: string) => refreshFriend(id))

  ipcMain.handle('chat:refresh-all', () => refreshAllFriends())

  ipcMain.handle('chat:send-text', (_event, input: ChatSendInput): Promise<ChatMessage> => sendText(input))

  ipcMain.handle('chat:send-image', (_event, friendId: string, dataUrl: string, fileName: string) =>
    sendImage(friendId, dataUrl, fileName)
  )

  ipcMain.handle('chat:send-file', (_event, friendId: string, filePath: string) =>
    sendFile(friendId, assertAbsolutePath(filePath, '文件路径'))
  )

  ipcMain.handle('chat:clear-history', (_event, friendId: string) => clearHistory(friendId))

  ipcMain.handle('chat:image-data', (_event, filePath: string) => readImageDataUrl(filePath))

  ipcMain.handle('chat:choose-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const current = (await chatState()).chatDir
    const args = {
      title: '选择聊天文件保存目录',
      defaultPath: current,
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const result = win ? await dialog.showOpenDialog(win, args) : await dialog.showOpenDialog(args)
    if (result.canceled || result.filePaths.length === 0) return { canceled: true }
    await setChatDir(result.filePaths[0])
    return { canceled: false, dirPath: result.filePaths[0] }
  })

  ipcMain.handle('chat:open-dir', async () => {
    const state = await chatState()
    await fsp.mkdir(state.chatDir, { recursive: true }).catch(() => undefined)
    const error = await shell.openPath(state.chatDir)
    if (error) throw new Error(error)
  })

  ipcMain.handle('chat:open-file', async (_event, filePath: string) => {
    const target = assertAbsolutePath(filePath, '文件路径')
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
  })

  ipcMain.handle('chat:reveal-file', (_event, filePath: string) => {
    shell.showItemInFolder(assertAbsolutePath(filePath, '文件路径'))
  })
}
