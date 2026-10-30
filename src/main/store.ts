import { app } from 'electron'
import { accessSync, constants as fsConstants, promises as fsp, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type ThemeMode } from '@shared/types'

let cached: AppSettings | null = null
let resolvedConfigDir: string | null = null

/** 所有配置写入串行执行，避免并发写同一个临时文件导致内容撕裂 */
let writeChain: Promise<unknown> = Promise.resolve()
let writeSeq = 0

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = writeChain.then(task, task)
  writeChain = result.catch(() => undefined)
  return result
}

function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 配置文件目录。
 * - 打包运行：优先使用安装目录（exe 所在目录），实现"配置跟着程序走"；
 *   若安装目录不可写（例如装到 Program Files、Linux AppImage 只读挂载），回退到用户数据目录。
 * - 开发运行：使用用户数据目录，避免污染源码仓库。
 */
export function configDir(): string {
  if (resolvedConfigDir) return resolvedConfigDir
  if (!app.isPackaged) {
    resolvedConfigDir = app.getPath('userData')
    return resolvedConfigDir
  }
  const exeDir = dirname(process.execPath)
  resolvedConfigDir = isWritableDir(exeDir) ? exeDir : app.getPath('userData')
  return resolvedConfigDir
}

export function settingsFile(): string {
  return join(configDir(), 'settings.json')
}

function legacySettingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function defaultDownloadDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('home')
  }
}

function normalizeContentTypes(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || result.includes(trimmed)) continue
    result.push(trimmed)
    if (result.length >= 60) break
  }
  return result.length ? result : [...fallback]
}

function normalize(raw: Partial<AppSettings>, fallback: AppSettings): AppSettings {
  const theme: ThemeMode = raw.theme === 'dark' ? 'dark' : raw.theme === 'light' ? 'light' : fallback.theme
  return {
    theme,
    downloadDir:
      typeof raw.downloadDir === 'string' && raw.downloadDir.trim() ? raw.downloadDir : fallback.downloadDir,
    sidebarCollapsed: typeof raw.sidebarCollapsed === 'boolean' ? raw.sidebarCollapsed : fallback.sidebarCollapsed,
    lastToolId: typeof raw.lastToolId === 'string' && raw.lastToolId ? raw.lastToolId : fallback.lastToolId,
    apiAutoSave: typeof raw.apiAutoSave === 'boolean' ? raw.apiAutoSave : fallback.apiAutoSave,
    apiContentTypes: normalizeContentTypes(raw.apiContentTypes, fallback.apiContentTypes),
    apiSidebarCollapsed:
      typeof raw.apiSidebarCollapsed === 'boolean' ? raw.apiSidebarCollapsed : fallback.apiSidebarCollapsed
  }
}

async function writeJson(target: string, value: unknown): Promise<void> {
  await fsp.mkdir(dirname(target), { recursive: true })
  writeSeq += 1
  const tmp = `${target}.${process.pid}.${writeSeq}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, target)
}

function readSettingsFile(file: string, fallback: AppSettings): AppSettings | null {
  try {
    return normalize(JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>, fallback)
  } catch {
    return null
  }
}

export function loadSettings(): AppSettings {
  if (cached) return cached
  const fallback: AppSettings = { ...DEFAULT_SETTINGS, downloadDir: defaultDownloadDir() }
  const primary = settingsFile()
  const legacy = legacySettingsFile()

  const fromPrimary = readSettingsFile(primary, fallback)
  if (fromPrimary) {
    cached = fromPrimary
    return cached
  }

  // 安装目录没有（或已损坏）时，尝试从旧版本的用户数据目录迁移
  if (primary !== legacy) {
    const fromLegacy = readSettingsFile(legacy, fallback)
    if (fromLegacy) {
      cached = fromLegacy
      void saveSettings(cached)
      return cached
    }
  }

  cached = fallback
  return cached
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const next = normalize(settings, { ...DEFAULT_SETTINGS, downloadDir: defaultDownloadDir() })
  cached = next

  return enqueueWrite(async () => {
    const primary = settingsFile()
    try {
      await writeJson(primary, next)
      return next
    } catch (error) {
      console.error('[settings] 写入安装目录失败，回退到用户数据目录', error)
    }

    const fallback = legacySettingsFile()
    try {
      await writeJson(fallback, next)
      resolvedConfigDir = app.getPath('userData')
    } catch (error) {
      // 写入失败不应崩溃，内存中的设置依然生效
      console.error('[settings] 写入失败', error)
    }
    return next
  })
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return saveSettings({ ...loadSettings(), ...patch })
}
