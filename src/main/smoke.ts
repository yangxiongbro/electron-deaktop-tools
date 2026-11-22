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

  // 文本工具箱里的 5 个工具合并成一页，这里按「工具 + 标签页」分别截图
  const tools = (process.env.DSH_SMOKE_ONLY ?? 'text-workbench,sql,cron,api,markdown,sync,chat,settings').split(',').filter(Boolean)
  const workbenchTabs: { tab: string; file: string; label: string }[] = [
    { tab: 'json', file: 'json.png', label: 'JSON 格式化' },
    { tab: 'naming', file: 'naming.png', label: '命名规范转换' },
    { tab: 'codec', file: 'codec.png', label: '编码 / 解码' },
    { tab: 'text', file: 'text.png', label: '字符处理' },
    { tab: 'sql', file: 'sql.png', label: 'SQL 工具' }
  ]

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

        /** 让文档截图落在更有代表性的界面上（对称加密页 / 多标签页） */
        const prepareTool = async (tool: string): Promise<void> => {
          if (tool === 'sync') {
            // 页面挂载后主动点一次「刷新串口」，再等 PowerShell 枚举完成
            await wait(1500)
            await runScript(`(() => {
              const btn = Array.from(document.querySelectorAll('button')).find(
                (el) => (el.textContent || '').trim() === '刷新串口'
              )
              if (btn) btn.click()
              return Boolean(btn)
            })()`)
            await wait(8000)
            return
          }
          if (tool === 'codec') {
            await runScript(`(() => {
              const tabs = Array.from(document.querySelectorAll('.segmented-item'))
              const target = tabs.find((el) => el.textContent.trim() === '对称加密')
              if (target) target.click()
              return Boolean(target)
            })()`)
            await wait(500)
            await runScript(`(() => {
              const example = Array.from(document.querySelectorAll('button')).find(
                (el) => (el.textContent || '').trim() === '示例'
              )
              if (example) example.click()
              return Boolean(example)
            })()`)
            await wait(600)
            return
          }
          if (tool === 'markdown') {
            await runScript(`(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
              const area = document.querySelector('.md-textarea')
              if (!area) return false
              area.value = ['# 项目说明', '', '这是一个支持多标签页的 Markdown 编辑器示例。', '', '## 特性', '', '- 同时打开、编辑多个文件', '- 每行缩进原样保留', '- 文档内搜索与预览目录'].join(String.fromCharCode(10))
              area.dispatchEvent(new Event('input', { bubbles: true }))
              await sleep(300)
              const add = document.querySelector('.doc-tab-add')
              if (add) add.click()
              await sleep(400)
              const next = document.querySelector('.md-textarea')
              next.value = ['# 第二个文档', '', '标签页之间互不影响，内容各自保留。'].join(String.fromCharCode(10))
              next.dispatchEvent(new Event('input', { bubbles: true }))
              await sleep(400)
              const tabs = Array.from(document.querySelectorAll('.doc-tab'))
              if (tabs[0]) tabs[0].click()
              await sleep(400)
              return true
            })()`)
            await wait(600)
          }
        }

        /** 切到文本工具箱的某个标签页 */
        const selectWorkbenchTab = async (label: string): Promise<void> => {
          await runScript(`(() => {
            const tabs = Array.from(document.querySelectorAll('.segmented-item'))
            const target = tabs.find((el) => el.textContent.trim() === ${JSON.stringify(label)})
            if (target) target.click()
            return Boolean(target)
          })()`)
          await wait(500)
        }

        /** JSON 标签页：填一段示例并格式化 */
        const fillJsonExample = async (): Promise<void> => {
          await runScript(`(() => {
            const area = document.querySelector('.json-textarea, .fill-textarea textarea, textarea')
            if (!area) return false
            area.value = JSON.stringify(
              {
                name: 'DevToolbox',
                version: '1.4.0',
                tools: ['JSON 格式化', '命名转换', '编码解码', '字符处理', 'SQL 工具'],
                openSource: true,
                author: { nick: '安静的松鼠', tags: ['electron', 'vue'] }
              },
              null,
              2
            )
            area.dispatchEvent(new Event('input', { bubbles: true }))
            return true
          })()`)
          await wait(400)
          await runScript(`(() => {
            const button = Array.from(document.querySelectorAll('button')).find(
              (el) => (el.textContent || '').replace(/\s+/g, '') === '格式化'
            )
            if (button) button.click()
            return Boolean(button)
          })()`)
          await wait(600)
        }

        /** 点一下工具栏里的「示例」，让截图里有内容 */
        const clickExample = async (): Promise<void> => {
          await runScript(`(() => {
            const example = Array.from(document.querySelectorAll('button')).find(
              (el) => (el.textContent || '').trim() === '示例'
            )
            if (example) example.click()
            return Boolean(example)
          })()`)
          await wait(500)
        }

        for (const tool of tools) {
          await runScript(`window.__toolbox && window.__toolbox.setTool(${JSON.stringify(tool)})`)
          await wait(800)
          if (tool === 'api') await seedApiRequest()
          if (tool === 'text-workbench') {
            for (const item of workbenchTabs) {
              await selectWorkbenchTab(item.label)
              if (item.tab === 'json') await fillJsonExample()
              else await clickExample()
              if (item.tab === 'codec') {
                await runScript(`(() => {
                  const tabs = Array.from(document.querySelectorAll('.segmented-item'))
                  const target = tabs.find((el) => el.textContent.trim() === '对称加密')
                  if (target) target.click()
                  return Boolean(target)
                })()`)
                await wait(400)
                await clickExample()
              }
              await capture(item.file)
            }
            continue
          }
          await prepareTool(tool)
          await capture(`${tool}.png`)
          if (tool === 'sync') {
            // 连接方式切到蓝牙，再补一张
            await runScript(`(() => {
              const labels = Array.from(document.querySelectorAll('.el-radio-button__inner'))
              const target = labels.find((el) => (el.textContent || '').trim() === '蓝牙')
              if (target) target.click()
              return Boolean(target)
            })()`)
            await wait(2500)
            await capture('sync-bt.png')
            await runScript(`(() => {
              const labels = Array.from(document.querySelectorAll('.el-radio-button__inner'))
              const target = labels.find((el) => (el.textContent || '').trim() === 'WiFi / 局域网')
              if (target) target.click()
              return Boolean(target)
            })()`)
            await wait(500)
          }
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
