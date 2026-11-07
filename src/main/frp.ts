import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

import type { ChatFrpConfig, ChatFrpState, ChatFrpStatus } from '@shared/types'
import { chatIdentity } from './chatCrypto'
import { configDir } from './store'

/**
 * 跨网络聊天：集成本机 frpc 客户端。
 *
 * 好友各自在公网 frps 上暴露自己的聊天端口，双方用「服务器地址:远程端口」互加，
 * 这样不在同一个局域网也能聊。聊天内容本身还有 HTTPS + 端到端加密兜底。
 *
 * 注意：代理名必须**每台机器不同**，否则两个客户端连同一台 frps 时会互相顶掉
 * （frps 报 `proxy [名字] already exists`），所以代理名里带一段本机身份短码。
 */

const MAX_LOGS = 200
const START_TIMEOUT = 20000

export function defaultFrpConfig(): ChatFrpConfig {
  return {
    enabled: false,
    serverAddr: '',
    serverPort: 7000,
    token: '',
    remotePort: 0,
    localPort: 45871,
    frpcPath: ''
  }
}

/** 本机专属的代理名：devtoolbox-chat-<8 位身份短码>，同一台 frps 上不会撞名 */
export function frpProxyName(): string {
  const seed = chatIdentity().pub || 'devtoolbox'
  const digest = createHash('sha256').update(seed).digest('hex').slice(0, 8)
  return `devtoolbox-chat-${digest}`
}

export function frpConfigFile(): string {
  return join(configDir(), 'frp.json')
}

export function frpProfileFile(): string {
  return join(configDir(), 'frpc.toml')
}

let config: ChatFrpConfig = defaultFrpConfig()
let status: ChatFrpStatus = 'stopped'
let message = ''
let binary = ''
let version = ''
let logs: string[] = []
let child: ChildProcessWithoutNullStreams | null = null
let loaded = false
let startResolvers: Array<(value: boolean) => void> = []

function normalizeConfig(raw: unknown): ChatFrpConfig {
  const base = defaultFrpConfig()
  if (!raw || typeof raw !== 'object') return base
  const value = raw as Partial<ChatFrpConfig>
  const port = (input: unknown, fallback: number): number => {
    const parsed = Math.round(Number(input))
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallback
  }
  return {
    enabled: Boolean(value.enabled),
    serverAddr: typeof value.serverAddr === 'string' ? value.serverAddr.trim().slice(0, 200) : '',
    serverPort: port(value.serverPort, base.serverPort),
    token: typeof value.token === 'string' ? value.token.slice(0, 200) : '',
    remotePort: Number(value.remotePort) >= 1 && Number(value.remotePort) <= 65535 ? Math.round(Number(value.remotePort)) : 0,
    localPort: port(value.localPort, base.localPort),
    frpcPath: typeof value.frpcPath === 'string' ? value.frpcPath.trim() : ''
  }
}

export async function loadFrp(): Promise<ChatFrpConfig> {
  if (loaded) return config
  loaded = true
  try {
    const text = await readFile(frpConfigFile(), 'utf8')
    config = normalizeConfig(JSON.parse(text))
  } catch {
    config = defaultFrpConfig()
  }
  return config
}

async function persistFrp(): Promise<void> {
  try {
    await mkdir(configDir(), { recursive: true })
    await writeFile(frpConfigFile(), JSON.stringify(config, null, 2), 'utf8')
  } catch (error) {
    console.error('[frp] 保存配置失败', error)
  }
}

export function frpPublicAddress(): string {
  if (!config.serverAddr || !config.remotePort) return ''
  return `${config.serverAddr}:${config.remotePort}`
}

/** 当前是否已经连着（正在连或已连上） */
export function frpIsActive(): boolean {
  return Boolean(child) || status === 'running' || status === 'starting'
}

export function frpState(): ChatFrpState {
  return {
    status,
    message,
    publicAddress: frpPublicAddress(),
    proxyName: frpProxyName(),
    binary,
    version,
    configFile: frpProfileFile(),
    logs: [...logs],
    config: { ...config }
  }
}

function pushLog(line: string): void {
  const text = line.replace(/\r/g, '').trimEnd()
  if (!text) return
  logs.push(text)
  if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS)
}

function setStatus(next: ChatFrpStatus, detail = ''): void {
  status = next
  message = detail
  if (next === 'running' || next === 'error' || next === 'stopped') {
    const resolvers = startResolvers
    startResolvers = []
    for (const resolve of resolvers) resolve(next === 'running')
  }
}

/** frpc 可执行文件：用户指定 → 安装目录 resources → PATH */
function candidateBinaries(): string[] {
  const name = process.platform === 'win32' ? 'frpc.exe' : 'frpc'
  const list: string[] = []
  if (config.frpcPath) list.push(config.frpcPath)
  if (app.isPackaged) {
    list.push(join(process.resourcesPath, 'frp', name))
    list.push(join(process.resourcesPath, 'frpc', name))
  }
  list.push(join(app.getAppPath(), 'resources', 'frp', name))
  list.push(join(app.getAppPath(), 'resources', 'frpc', name))
  list.push(name)
  return list
}

function resolveBinary(): string {
  for (const item of candidateBinaries()) {
    if (item === 'frpc' || item === 'frpc.exe') return item
    if (existsSync(item)) return item
  }
  return ''
}

function runVersion(target: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(target, ['-v'], { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        resolve('')
        return
      }
      const text = `${stdout || ''}${stderr || ''}`.trim()
      const match = text.match(/\d+\.\d+\.\d+/)
      resolve(match ? match[0] : '')
    })
  })
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((item) => Number(item) || 0)
  const pb = b.split('.').map((item) => Number(item) || 0)
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1
  }
  return 0
}

/** frp 0.52 起用 TOML 配置，老版本只能用 ini */
function buildProfile(useToml: boolean): { file: string; content: string } {
  // 代理名带上本机身份短码：两个客户端连同一台 frps 时不会互相顶掉
  const proxy = frpProxyName()
  if (useToml) {
    const lines = [
      `serverAddr = ${JSON.stringify(config.serverAddr)}`,
      `serverPort = ${config.serverPort}`,
      ''
    ]
    if (config.token) {
      lines.push('auth.method = "token"', `auth.token = ${JSON.stringify(config.token)}`, '')
    }
    lines.push(
      '[[proxies]]',
      `name = ${JSON.stringify(proxy)}`,
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      `localPort = ${config.localPort}`,
      `remotePort = ${config.remotePort}`,
      ''
    )
    return { file: join(configDir(), 'frpc.toml'), content: lines.join('\n') }
  }

  const lines = [
    '[common]',
    `server_addr = ${config.serverAddr}`,
    `server_port = ${config.serverPort}`
  ]
  if (config.token) lines.push(`token = ${config.token}`)
  lines.push(
    '',
    `[${proxy}]`,
    'type = tcp',
    'local_ip = 127.0.0.1',
    `local_port = ${config.localPort}`,
    `remote_port = ${config.remotePort}`,
    ''
  )
  return { file: join(configDir(), 'frpc.ini'), content: lines.join('\n') }
}

async function writeProfile(): Promise<string> {
  const useToml = !version || compareVersion(version, '0.52.0') >= 0
  const profile = buildProfile(useToml)
  await mkdir(configDir(), { recursive: true })
  await writeFile(profile.file, profile.content, 'utf8')
  return profile.file
}

export async function stopFrp(): Promise<void> {
  const instance = child
  child = null
  if (!instance) {
    if (status !== 'error') setStatus('stopped', '')
    return
  }
  // 先标记为已停止，避免停止过程中被日志回调重新判定成「已连接」
  setStatus('stopped', '已停止')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        instance.kill('SIGKILL')
      } catch {
        // 已经退出
      }
      resolve()
    }, 3000)
    instance.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      instance.kill()
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
  setStatus('stopped', '已停止')
}

export async function startFrp(): Promise<boolean> {
  await loadFrp()
  if (child) await stopFrp()

  if (!config.serverAddr) {
    setStatus('error', '请先填写 FRP 服务器地址')
    return false
  }
  if (!config.remotePort) {
    setStatus('error', '请填写服务器上对外开放的端口')
    return false
  }

  const target = resolveBinary()
  if (!target) {
    setStatus(
      'error',
      '没有找到 frpc，请点「选择 frpc」指定 frpc.exe，或把 frpc 放到安装目录的 resources/frp 下'
    )
    return false
  }

  binary = target
  version = await runVersion(target)
  if (!version) {
    setStatus('error', '无法执行 frpc，请确认文件没被拦截或缺少执行权限')
    return false
  }

  const profileFile = await writeProfile()
  logs = []
  pushLog(`[local] 使用 frpc ${version}（${target}）`)
  pushLog(`[local] 配置写入 ${profileFile}`)
  setStatus('starting', '正在连接 FRP 服务器…')

  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    startResolvers.push(finish)

    try {
      const instance = spawn(target, ['-c', profileFile], { windowsHide: true })
      child = instance

      const onData = (chunk: Buffer): void => {
        for (const line of chunk.toString('utf8').split('\n')) {
          if (!line.trim()) continue
          pushLog(line)
          const detail = line.replace(/^.*?\]\s*(\[[^\]]*\]\s*)?/, '').slice(0, 160)
          if (/start proxy success/i.test(line)) {
            setStatus('running', '已连接，好友可以通过对外地址找到你')
          } else if (/already exists|already used|is already/i.test(line)) {
            // 两个客户端撞了代理名或对外端口
            setStatus(
              'error',
              `服务器上说这个映射已存在：多半是另一台机器用了同样的「对外端口」。换一个端口再连（${detail}）`
            )
          } else if (/start error|start proxy error/i.test(line)) {
            setStatus('error', `启动映射失败：${detail}`)
          } else if (/login to server failed|connect to server error|authorization failed/i.test(line)) {
            setStatus('error', detail || '连接 FRP 服务器失败，请检查地址 / 端口 / token')
          } else if (/\[E\]/.test(line)) {
            setStatus('error', detail || 'frpc 报错')
          }
        }
      }
      instance.stdout.on('data', onData)
      instance.stderr.on('data', onData)

      instance.once('error', (error) => {
        setStatus('error', `启动 frpc 失败：${error.message}`)
        child = null
        finish(false)
      })
      instance.once('exit', (code) => {
        child = null
        if (status !== 'error') setStatus('stopped', `frpc 已退出（代码 ${code ?? 0}）`)
        finish(false)
      })

      setTimeout(() => {
        if (status === 'starting') {
          setStatus('error', '等了 20 秒还没连上服务器，请检查地址 / 端口 / token')
          void stopFrp()
        }
      }, START_TIMEOUT).unref?.()
    } catch (error) {
      setStatus('error', (error as Error).message)
      finish(false)
    }
  })
}

export async function saveFrp(patch: Partial<ChatFrpConfig>): Promise<void> {
  await loadFrp()
  config = normalizeConfig({ ...config, ...patch })
  await persistFrp()
  if (child && !config.enabled) await stopFrp()
}

/** 聊天端口变化时同步给 frpc，并在启用时重启 */
export async function syncFrpPort(port: number): Promise<void> {
  await loadFrp()
  if (config.localPort === port) return
  config.localPort = port
  await persistFrp()
  if (child) {
    await stopFrp()
    await startFrp()
  }
}

/** 启动时如果配置了「启用跨网络」就自动连上 */
export async function bootstrapFrp(): Promise<void> {
  const current = await loadFrp()
  if (!current.enabled || !current.serverAddr) return
  void startFrp()
}

export function shutdownFrp(): void {
  if (!child) return
  try {
    child.kill()
  } catch {
    // 忽略
  }
  child = null
  status = 'stopped'
}
