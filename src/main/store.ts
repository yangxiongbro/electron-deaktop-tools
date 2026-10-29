import { app } from 'electron'
import { promises as fsp, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings, type ThemeMode } from '@shared/types'

let cached: AppSettings | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function defaultDownloadDir(): string {
  try {
    return app.getPath('downloads')
  } catch {
    return app.getPath('home')
  }
}

function normalize(raw: Partial<AppSettings>, fallback: AppSettings): AppSettings {
  const theme: ThemeMode = raw.theme === 'dark' ? 'dark' : raw.theme === 'light' ? 'light' : fallback.theme
  return {
    theme,
    downloadDir:
      typeof raw.downloadDir === 'string' && raw.downloadDir.trim() ? raw.downloadDir : fallback.downloadDir,
    sidebarCollapsed: typeof raw.sidebarCollapsed === 'boolean' ? raw.sidebarCollapsed : fallback.sidebarCollapsed,
    lastToolId: typeof raw.lastToolId === 'string' && raw.lastToolId ? raw.lastToolId : fallback.lastToolId
  }
}

export function loadSettings(): AppSettings {
  if (cached) return cached
  const fallback: AppSettings = { ...DEFAULT_SETTINGS, downloadDir: defaultDownloadDir() }
  try {
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<AppSettings>
    cached = normalize(raw, fallback)
  } catch {
    cached = fallback
  }
  return cached
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const next = normalize(settings, { ...DEFAULT_SETTINGS, downloadDir: defaultDownloadDir() })
  cached = next
  const target = settingsFile()
  try {
    await fsp.mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
    await fsp.rename(tmp, target)
  } catch (error) {
    // 设置写入失败不应崩溃，内存中的设置依然生效
    console.error('[settings] 写入失败', error)
  }
  return next
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return saveSettings({ ...loadSettings(), ...patch })
}
