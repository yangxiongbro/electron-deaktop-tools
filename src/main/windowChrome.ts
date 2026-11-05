import type { BrowserWindow } from 'electron'
import type { ThemeMode } from '@shared/types'

/**
 * 自定义标题栏。
 *
 * Windows 上用 `titleBarStyle: 'hidden'` + `titleBarOverlay`：
 * 去掉系统标题栏（左上角的程序图标与名称），但保留右上角的最小化 / 最大化 / 关闭按钮，
 * 窗口拖拽交给页面里 `.app-header` 的 `-webkit-app-region: drag`。
 */

/** 与页面里 .app-header 的高度保持一致，标题栏按钮才会和头部对齐 */
export const APP_HEADER_HEIGHT = 62

export function titleBarOverlay(theme: ThemeMode): { color: string; symbolColor: string; height: number } {
  return {
    color: theme === 'dark' ? '#1a1d21' : '#ffffff',
    symbolColor: theme === 'dark' ? '#e6e8eb' : '#1f2329',
    height: APP_HEADER_HEIGHT
  }
}

/** 切换主题后同步标题栏按钮区的配色 */
export function applyWindowChrome(win: BrowserWindow, theme: ThemeMode): void {
  if (process.platform !== 'win32') return
  if (typeof win.setTitleBarOverlay !== 'function') return
  try {
    win.setTitleBarOverlay(titleBarOverlay(theme))
  } catch {
    // 窗口不是自定义标题栏模式时忽略
  }
}
