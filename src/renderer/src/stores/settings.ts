import { reactive, ref } from 'vue'
import type { AppSettings, ThemeMode } from '@shared/types'

const state = reactive<AppSettings>({
  theme: 'light',
  downloadDir: '',
  sidebarCollapsed: false,
  lastToolId: 'json'
})

const ready = ref(false)

function applyTheme(theme: ThemeMode): void {
  const root = document.documentElement
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
}

/** 初始化设置：读取主进程持久化配置，并监听外部变更 */
export async function initSettings(): Promise<void> {
  const settings = await window.api.settings.get()
  Object.assign(state, settings)
  applyTheme(state.theme)
  window.api.settings.onChanged((next) => {
    Object.assign(state, next)
    applyTheme(next.theme)
  })
  ready.value = true
}

async function patch(partial: Partial<AppSettings>): Promise<void> {
  const next = await window.api.settings.update(partial)
  Object.assign(state, next)
  if (partial.theme) applyTheme(next.theme)
}

export async function setTheme(theme: ThemeMode): Promise<void> {
  await patch({ theme })
}

export async function setSidebarCollapsed(collapsed: boolean): Promise<void> {
  await patch({ sidebarCollapsed: collapsed })
}

export async function setDownloadDir(downloadDir: string): Promise<void> {
  await patch({ downloadDir })
}

export async function setLastTool(lastToolId: string): Promise<void> {
  await patch({ lastToolId })
}

export function useSettings(): { settings: AppSettings; ready: typeof ready } {
  return { settings: state, ready }
}
