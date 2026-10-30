import { app, type BrowserWindow } from 'electron'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/**
 * 仅供自动化验证使用：设置 DSH_SMOKE_DIR 后，应用启动会自动遍历每个工具页面截图，
 * 然后退出。正常打包运行时该环境变量不存在，不会产生任何影响。
 *
 * 此时用户数据目录也会被指向 DSH_SMOKE_DIR/user-data（见 index.ts），
 * 因此截图过程中新建的请求不会写进真实的请求数据文件。
 */
export function setupSmokeCapture(win: BrowserWindow): void {
  const outputDir = process.env.DSH_SMOKE_DIR
  if (!outputDir) return

  const tools = ['json', 'naming', 'codec', 'api', 'markdown', 'settings']

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const capture = async (name: string): Promise<void> => {
    const image = await win.webContents.capturePage()
    await fsp.writeFile(join(outputDir, name), image.toPNG())
  }

  const runScript = (script: string): Promise<unknown> =>
    win.webContents.executeJavaScript(script) as Promise<unknown>

  /** 在 API 页面点击「新请求」并填入示例内容，让截图更接近真实使用场景 */
  const seedApiRequest = async (): Promise<void> => {
    const hasRequests = await runScript(`document.querySelectorAll('.req-item').length > 0`)
    if (hasRequests) {
      // 已有数据（例如预置的示例数据）时直接展示，不再新建空请求
      await wait(600)
      return
    }
    await runScript(`(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const create = buttons.find((item) => (item.textContent || '').replace(/\\s+/g, '').startsWith('新请求'))
      if (create) create.click()
      return Boolean(create)
    })()`)
    await wait(900)
    await runScript(`(() => {
      const fill = (selector, value) => {
        const input = document.querySelector(selector)
        if (!input) return false
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      const named = fill('.name-input input', '获取示例数据')
      const url = fill('.url-input input', 'https://httpbin.org/get')
      return named && url
    })()`)
    // 等待自动保存落盘、提示消失，截图里就是「已保存」状态
    await wait(3400)
  }

  win.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        await fsp.mkdir(outputDir, { recursive: true })
        await wait(1500)

        for (const tool of tools) {
          await runScript(`window.__toolbox && window.__toolbox.setTool(${JSON.stringify(tool)})`)
          await wait(700)
          if (tool === 'api') await seedApiRequest()
          await capture(`${tool}.png`)
        }

        // 多项目：展开项目下拉，展示「按项目管理请求」的能力
        await runScript(`window.__toolbox && window.__toolbox.setTool('api')`)
        await wait(600)
        await runScript(`document.querySelector('.project-select .el-select__wrapper')?.click()`)
        await wait(600)
        await capture('api-projects.png')
        await runScript(`(() => {
          const fire = (type) => document.body.dispatchEvent(new MouseEvent(type, { bubbles: true }))
          fire('mousedown')
          fire('mouseup')
          fire('click')
          return true
        })()`)
        await wait(400)

        await runScript(`window.__toolbox && window.__toolbox.setTool('json')`)
        await runScript(`window.__toolbox && window.__toolbox.setTheme('dark')`)
        await wait(700)
        await capture('theme-dark.png')

        await runScript(`window.__toolbox && window.__toolbox.setCollapsed(true)`)
        await wait(500)
        await capture('sidebar-collapsed.png')

        await runScript(`window.__toolbox && window.__toolbox.setTool('api')`)
        await wait(800)
        await capture('api-dark.png')
      } catch (error) {
        console.error('[smoke] 截图失败', error)
      } finally {
        app.quit()
      }
    })()
  })
}
