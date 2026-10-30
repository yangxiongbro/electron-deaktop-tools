import { app, BrowserWindow, Menu, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { loadSettings } from './store'
import { setupSmokeCapture } from './smoke'

const APP_ID = 'com.electron.deaktoptools'

/** 默认窗口大小（也会按屏幕可用区域自动收窄，避免小屏幕上超出边界） */
const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 }
const MIN_WINDOW_SIZE = { width: 1040, height: 660 }

let mainWindow: BrowserWindow | null = null

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID)
}

// 自动化截图时把用户数据目录指向临时目录，避免污染真实配置与请求数据
if (process.env.DSH_SMOKE_DIR) {
  try {
    app.setPath('userData', join(process.env.DSH_SMOKE_DIR, 'user-data'))
  } catch (error) {
    console.error('[smoke] 设置临时用户数据目录失败', error)
  }
}

function createWindow(): BrowserWindow {
  const settings = loadSettings()
  const smoke = Boolean(process.env.DSH_SMOKE_DIR)
  const iconPath = join(__dirname, '../../build/icon.png')

  // 以默认尺寸打开，但不超过当前屏幕可用区域（小屏笔记本 / 高缩放比时自动收窄）
  const { workAreaSize } = screen.getPrimaryDisplay()
  const width = Math.min(DEFAULT_WINDOW_SIZE.width, Math.max(MIN_WINDOW_SIZE.width, workAreaSize.width - 80))
  const height = Math.min(DEFAULT_WINDOW_SIZE.height, Math.max(MIN_WINDOW_SIZE.height, workAreaSize.height - 80))

  const win = new BrowserWindow({
    width,
    height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: smoke,
    backgroundColor: settings.theme === 'dark' ? '#141414' : '#f5f7fa',
    autoHideMenuBar: true,
    title: 'DevToolbox 开发工具箱',
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl && url.startsWith(devUrl)) return
    if (!url.startsWith('file://')) {
      event.preventDefault()
    }
  })

  // 开发环境下 F12 打开开发者工具（没有应用菜单时快捷键不会自动生效）
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        win.webContents.toggleDevTools()
      }
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  setupSmokeCapture(win)

  return win
}

function buildMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ])
  )
}

const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    buildMenu()
    registerIpcHandlers()
    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
