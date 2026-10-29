import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type {
  AppInfo,
  AppSettings,
  FilePickResult,
  JsonFileRequest,
  JsonFileResult,
  OpenFileOptions,
  SaveFileOptions,
  WriteTextResult,
  ReadTextResult
} from '@shared/types'
import { formatJsonFile } from './jsonFile'
import { abortHttpRequest, performHttpRequest } from './httpClient'
import { addHistory, clearHistory, loadHistory, removeHistory } from './history'
import { configDir, defaultDownloadDir, loadSettings, settingsFile, updateSettings } from './store'
import type { ApiHistoryDraft, HttpRequestConfig } from '@shared/types'

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

  /* ----------------------------- 请求历史 --------------------------- */

  ipcMain.handle('history:list', () => loadHistory())

  ipcMain.handle('history:add', (_event, draft: ApiHistoryDraft) => addHistory(draft))

  ipcMain.handle('history:remove', (_event, id: string) => removeHistory(id))

  ipcMain.handle('history:clear', () => clearHistory())

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
      settingsFile: settingsFile()
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
}
