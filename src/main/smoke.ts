import { app, type BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/**
 * 仅供自动化验证使用：设置 DSH_SMOKE_DIR 后，应用启动会自动遍历每个工具页面截图，
 * 然后退出。正常打包运行时该环境变量不存在，不会产生任何影响。
 */
export function setupSmokeCapture(win: BrowserWindow): void {
  const outputDir = process.env.DSH_SMOKE_DIR
  if (!outputDir) return

  const tools = ['json', 'naming', 'codec', 'api', 'markdown', 'settings']

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  win.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        await fsp.mkdir(outputDir, { recursive: true })
        await wait(1500)

        for (const tool of tools) {
          await win.webContents.executeJavaScript(`window.__toolbox && window.__toolbox.setTool(${JSON.stringify(tool)})`)
          await wait(700)
          const image = await win.webContents.capturePage()
          await fsp.writeFile(join(outputDir, `${tool}.png`), image.toPNG())
        }

        await win.webContents.executeJavaScript(`window.__toolbox && window.__toolbox.setTool('json')`)
        await win.webContents.executeJavaScript(`window.__toolbox && window.__toolbox.setTheme('dark')`)
        await wait(700)
        const dark = await win.webContents.capturePage()
        await fsp.writeFile(join(outputDir, 'theme-dark.png'), dark.toPNG())

        await win.webContents.executeJavaScript(
          `window.__toolbox && window.__toolbox.setCollapsed(true)`
        )
        await wait(500)
        const collapsed = await win.webContents.capturePage()
        await fsp.writeFile(join(outputDir, 'sidebar-collapsed.png'), collapsed.toPNG())

        await win.webContents.executeJavaScript(
          `window.__toolbox && window.__toolbox.setTool('api')`
        )
        await wait(600)
        const api = await win.webContents.capturePage()
        await fsp.writeFile(join(outputDir, 'api-dark.png'), api.toPNG())
      } catch (error) {
        console.error('[smoke] 截图失败', error)
      } finally {
        app.quit()
      }
    })()
  })
}
