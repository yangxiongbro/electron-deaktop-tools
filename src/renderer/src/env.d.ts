import type { DesktopApi } from '@shared/types'

declare global {
  interface Window {
    api: DesktopApi
    /** 仅供自动化截图验证使用 */
    __toolbox?: {
      setTool: (id: string) => void
      setTheme: (theme: 'light' | 'dark') => void
      setCollapsed: (collapsed: boolean) => void
    }
  }
}

export {}
