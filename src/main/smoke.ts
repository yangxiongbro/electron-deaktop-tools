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

  const tools = ['json', 'naming', 'codec', 'api', 'markdown', 'cron', 'chat', 'settings']

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const capture = async (name: string): Promise<void> => {
    // 窗口被遮挡时 Chromium 会停止合成新帧，capturePage 会拿到旧画面，
    // 所以截图前先确保窗口可见并强制刷新两帧
    if (!win.isVisible()) win.show()
    win.focus()
    try {
      await win.webContents.executeJavaScript(
        'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
      )
    } catch {
      // 页面正在切换时忽略
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
    const image = await win.webContents.capturePage()
    await fsp.writeFile(join(outputDir, name), image.toPNG())
  }

  const runScript = (script: string): Promise<unknown> =>
    win.webContents.executeJavaScript(script) as Promise<unknown>

  /** 在 API 页面点击「新请求」并填入示例内容，让截图更接近真实使用场景 */
  const seedApiRequest = async (): Promise<void> => {
    const hasRequests = await runScript(`document.querySelectorAll('.list-row').length > 0`)
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
    // 自动保存默认关闭，这里点一下「保存」把示例请求落盘，截图里就是「已保存」状态
    await runScript(`(() => {
      const save = Array.from(document.querySelectorAll('.project-bar button')).find(
        (item) => (item.textContent || '').replace(/\\s+/g, '') === '保存'
      )
      if (save) save.click()
      return Boolean(save)
    })()`)
    await wait(3800)
  }

  win.webContents.once('did-finish-load', () => {
    void (async () => {
      try {
        await fsp.mkdir(outputDir, { recursive: true })
        await wait(1500)
        // 侧栏默认收起，文档截图统一用展开状态，最后再单独截一张收起状态
        await runScript(`window.__toolbox && window.__toolbox.setCollapsed(false)`)
        await wait(600)

        for (const tool of tools) {
          await runScript(`window.__toolbox && window.__toolbox.setTool(${JSON.stringify(tool)})`)
          await wait(700)
          if (tool === 'api') await seedApiRequest()
          await capture(`${tool}.png`)
        }

        // 语法弹窗：Markdown 与 Cron 各截一张
        const closeVisibleDialog = async (): Promise<void> => {
          await runScript(`(() => {
            const dialog = Array.from(document.querySelectorAll('.el-dialog')).find(
              (item) => item.offsetParent !== null
            )
            const close = dialog && dialog.querySelector('.el-dialog__headerbtn')
            if (close) close.click()
            return Boolean(close)
          })()`)
          await wait(500)
        }
        const openSyntaxDialog = async (tool: string, file: string): Promise<void> => {
          await runScript(`window.__toolbox && window.__toolbox.setTool(${JSON.stringify(tool)})`)
          await wait(700)
          await runScript(`(() => {
            const target = Array.from(document.querySelectorAll('button')).find(
              (item) => (item.textContent || '').replace(/\\s+/g, '') === '语法'
            )
            if (target) target.click()
            return Boolean(target)
          })()`)
          await wait(700)
          await capture(file)
          await closeVisibleDialog()
        }
        await openSyntaxDialog('markdown', 'markdown-syntax.png')
        await openSyntaxDialog('cron', 'cron-syntax.png')

        // 新好友：申请记录弹窗
        await runScript(`window.__toolbox && window.__toolbox.setTool('chat')`)
        await wait(700)
        await runScript(`document.querySelector('.friend-badge button')?.click()`)
        await wait(900)
        await capture('chat-requests.png')
        await closeVisibleDialog()

        // 跨网络（FRP）与安全信息
        await runScript(`document.querySelectorAll('.me-actions .me-action')[0]?.click()`)
        await wait(900)
        await capture('chat-frp.png')
        await closeVisibleDialog()
        await runScript(`document.querySelector('.me-card .avatar-btn')?.click()`)
        await wait(900)
        await capture('chat-security.png')
        await closeVisibleDialog()

        // 使用说明
        await runScript(`document.querySelectorAll('.me-actions .me-action')[2]?.click()`)
        await wait(900)
        await capture('chat-help.png')
        await closeVisibleDialog()

        // 加密详情（好友菜单 → 加密详情）
        await runScript(`document.querySelector('.chat-header button[title="更多"]')?.click()`)
        await wait(700)
        await runScript(`(() => {
          const item = Array.from(document.querySelectorAll('.el-dropdown-menu__item')).find(
            (el) => (el.textContent || '').includes('加密详情')
          )
          if (item) item.click()
          return Boolean(item)
        })()`)
        await wait(900)
        await capture('chat-crypto.png')
        await closeVisibleDialog()

        // Markdown 文档内搜索：预览模式下高亮命中文字
        await runScript(`window.__toolbox && window.__toolbox.setTool('markdown')`)
        await wait(600)
        await runScript(`(() => {
          const textarea = document.querySelector('.md-textarea')
          if (!textarea) return false
          textarea.value = '# 搜索测试\\n\\n这是一段包含关键词的文本，关键词出现了多次。\\n\\n- 关键词在列表里\\n- 另一个关键词\\n\\n最后一段也有 关键词。\\n'
          textarea.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
        await wait(400)
        await runScript(`(() => {
          const btn = Array.from(document.querySelectorAll('.segmented-item')).find(
            (item) => (item.textContent || '').trim() === '预览'
          )
          if (btn) btn.click()
          return Boolean(btn)
        })()`)
        await wait(600)
        await runScript(`(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(
            (item) => (item.textContent || '').replace(/\\s+/g, '') === '搜索'
          )
          if (btn) btn.click()
          return Boolean(btn)
        })()`)
        await wait(400)
        await runScript(`(() => {
          const input = document.querySelector('.md-search-input input')
          if (!input) return false
          input.value = '关键词'
          input.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`)
        await wait(900)
        await capture('markdown-search.png')

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
