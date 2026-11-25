import { transferHub } from './transferHub'
import { app } from 'electron'
import { promises as fsp, createReadStream, createWriteStream } from 'node:fs'
import { BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import type { SyncDevice, SyncEvent, SyncSettings, SyncState, SyncTransfer } from '@shared/types'
import { configDir } from './store'
import {
  manifestVersion,
  scanSyncFolder,
  type ManifestEntry
} from './syncFs'

export type { ManifestEntry }
import { listNetworkOptions } from './netInfo'

/* ------------------------------------------------------------------ */
/* 文件同步：桌面端做同步服务端，手机（android-tools）通过 WiFi 连过来   */
/* ------------------------------------------------------------------ */

const STORE_VERSION = 1
const DEFAULT_PORT = 45872
const AUDIT_LIMIT = 60

interface SyncStore {
  version: number
  settings: SyncSettings
  devices: SyncDeviceRecord[]
  events: SyncEvent[]
}

interface SyncDeviceRecord extends SyncDevice {
  /** 最近一次握手拿到的端口 */
  port: number
}


let cache: SyncStore | null = null
let server: Server | null = null
let serverPort = 0
let watcher: ReturnType<typeof setInterval> | null = null
let lastVersion = ''
let transfer: SyncTransfer | null = null
/** 正在传输的任务的中止函数（点「取消传输」时调用） */
let transferAbort: (() => void) | null = null

/** 上一次推给界面的传输状态，避免重复发送 */
let lastPushedTransfer = ''
let transferPushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 更新当前传输状态，并推给界面。
 *
 * 文件传输往往只持续一两秒，界面 4 秒轮询会漏掉，所以这里主动推送（高频更新合并到 120ms）。
 */
function setTransfer(next: SyncTransfer | null): void {
  transfer = next
  // 统一报到中枢：界面上的「取消」针对的就是这里记录的当前传输
  if (next) transferHub.report('wifi', next.path, next.outgoing, next.sent, next.total)
  else transferHub.finish('wifi')
  const key = next ? `${next.path}|${next.sent}|${next.total}|${next.outgoing}` : ''
  if (key === lastPushedTransfer) return
  lastPushedTransfer = key
  if (transferPushTimer) return
  transferPushTimer = setTimeout(() => {
    transferPushTimer = null
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('sync:transfer', transfer)
    }
  }, 120)
}

/** 取消正在进行的传输（WiFi）。返回是否真的取消了一个任务 */
export function isCancelledPath(path: string): boolean {
  // 以中枢的取消登记表为准（三条通道共用同一份）
  return cancelledPaths.has(path) || transferHub.isCancelled(path)
}

/** 重新开始同步时清空"已取消"清单 */
export function clearCancelledPaths(): void {
  cancelledPaths.clear()
}

export function cancelTransfer(): boolean {
  const abort = transferAbort
  transferAbort = null
  const current = transfer
  setTransfer(null)
  if (!abort) return false
  try {
    abort()
  } catch {
    // 连接可能已经断了，忽略
  }
  if (current) {
    cancelledPaths.add(current.path)
    transferHub.markCancelled(current.path, 'local')
    logEventOfCancel(current)
  }
  return true
}

/** 把 WiFi（本机作服务端）的取消实现注册到传输中枢 */
export function registerWifiCancel(): void {
  transferHub.register('wifi', () => cancelTransfer())
}

/** 取消时在「最近同步」里留一条记录，用户能看到是主动取消的 */
function logEventOfCancel(info: SyncTransfer): void {
  if (alreadyLoggedCancel.has(info.path)) return
  alreadyLoggedCancel.add(info.path)
  setTimeout(() => alreadyLoggedCancel.delete(info.path), 10000)
  void (async () => {
    try {
      const store = await loadStore()
      logEvent(store, {
        direction: info.outgoing ? 'out' : 'in',
        path: info.path,
        device: '已取消',
        size: Math.round(info.sent)
      })
      await persist()
    } catch {
      // 记录失败不影响取消
    }
  })()
}
let lastManifest: ManifestEntry[] = []
/** 用户取消过传输的文件：本次同步内不再提供 / 接收，重新开始同步会清空 */
const cancelledPaths = new Set<string>()
/** 已经记过「已取消」的文件：避免取消按钮 + 连接中断各记一条 */
const alreadyLoggedCancel = new Set<string>()
/**
 * 开启同步那一刻的文件指纹（path → size:mtime）。
 * 只有「开启同步之后被新增 / 改动过」的文件才需要同步，历史文件不再全量传输。
 */
let baseline: Map<string, string> | null = null

function fingerprint(entry: { size: number; mtime: number }): string {
  return `${entry.size}:${entry.mtime}`
}

/** 记录当前目录作为基线（开启同步 / 换目录后调用） */
async function captureBaseline(): Promise<void> {
  const store = await loadStore()
  const root = resolveSyncDir(store.settings.syncDir)
  await fsp.mkdir(root, { recursive: true }).catch(() => undefined)
  const files = await scanSyncFolder(root, currentMaxBytes())
  baseline = new Map(files.map((file) => [file.path, fingerprint(file)]))
}

/** 基线之后新增或改动过的文件 */
function changedSinceBaseline(files: ManifestEntry[]): ManifestEntry[] {
  if (!baseline) return files
  return files.filter((file) => baseline?.get(file.path) !== fingerprint(file))
}

function storeFile(): string {
  return join(configDir(), 'sync.json')
}

function resolveSyncDir(value: string): string {
  const dir = value.trim()
  return dir || join(configDir(), 'sync-folder')
}

function createDefaultStore(): SyncStore {
  return {
    version: STORE_VERSION,
    settings: {
      enabled: false,
      port: DEFAULT_PORT,
      syncDir: '',
      autoPush: true,
      maxFileMb: 100,
      btEnabled: false,
      btPort: ''
    },
    devices: [],
    events: []
  }
}

function cloneState(): SyncState {
  const store = cache ?? createDefaultStore()
  const dir = resolveSyncDir(store.settings.syncDir)
  return {
    running: Boolean(server),
    port: serverPort || store.settings.port,
    syncDir: dir,
    settings: { ...store.settings, syncDir: dir },
    devices: store.devices.map((item) => ({ ...item })),
    events: store.events.map((item) => ({ ...item })),
    addresses: listNetworkOptions().map((item) => ({
      address: item.address,
      label: item.iface,
      virtual: item.virtual
    })),
    version: lastVersion,
    fileCount: lastManifest.length,
    transfer
  }
}

async function persist(): Promise<void> {
  if (!cache) return
  const file = storeFile()
  await fsp.mkdir(dirname(file), { recursive: true }).catch(() => undefined)
  await fsp.writeFile(file, JSON.stringify(cache, null, 2), 'utf8')
}

async function loadStore(): Promise<SyncStore> {
  if (cache) return cache
  try {
    const text = await fsp.readFile(storeFile(), 'utf8')
    const parsed = JSON.parse(text) as Partial<SyncStore>
    cache = {
      version: STORE_VERSION,
      settings: {
        enabled: parsed.settings?.enabled === true,
        port: clampPort(Number(parsed.settings?.port ?? DEFAULT_PORT)),
        syncDir: typeof parsed.settings?.syncDir === 'string' ? parsed.settings.syncDir : '',
        autoPush: parsed.settings?.autoPush !== false,
        maxFileMb: clampMaxMb(Number(parsed.settings?.maxFileMb ?? 100)),
        btEnabled: parsed.settings?.btEnabled === true,
        btPort: typeof parsed.settings?.btPort === 'string' ? parsed.settings.btPort : ''
      },
      devices: Array.isArray(parsed.devices)
        ? parsed.devices
            .filter((item): item is SyncDeviceRecord => Boolean(item) && typeof item.id === 'string')
            .slice(0, 32)
        : [],
      events: Array.isArray(parsed.events) ? parsed.events.slice(0, AUDIT_LIMIT) : []
    }
    return cache
  } catch {
    cache = createDefaultStore()
    return cache
  }
}

/** 单文件上限：1 MB ~ 4096 MB（默认 100 MB） */
function clampMaxMb(value: number): number {
  if (!Number.isFinite(value)) return 100
  return Math.min(4096, Math.max(1, Math.round(value)))
}

/** 当前生效的单文件上限（字节） */
function currentMaxBytes(): number {
  const mb = cache?.settings.maxFileMb ?? 100
  return clampMaxMb(mb) * 1024 * 1024
}

function clampPort(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PORT
  return Math.min(65535, Math.max(1024, Math.round(value)))
}

/* ---------------------------- 文件夹清单 ---------------------------- */

async function refreshManifest(): Promise<{ version: string; files: ManifestEntry[] }> {
  const store = await loadStore()
  const root = resolveSyncDir(store.settings.syncDir)
  await fsp.mkdir(root, { recursive: true }).catch(() => undefined)
  const files = await scanSyncFolder(root, currentMaxBytes())
  const version = manifestVersion(files)
  if (version !== lastVersion) {
    lastVersion = version
    lastManifest = files
  }
  return { version: lastVersion, files: lastManifest }
}

/** 防止 ../ 越权：只允许同步目录内的相对路径 */
function safeTarget(root: string, relativePath: string): string | null {
  const cleaned = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.includes('..')) return null
  const target = normalize(join(root, cleaned))
  const rootNormalized = normalize(root)
  return target.startsWith(rootNormalized) ? target : null
}

/* ------------------------------ HTTP 服务 ------------------------------ */

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  })
  res.end(body)
}

async function readBody(
  req: IncomingMessage,
  limit = currentMaxBytes() + 1024 * 1024,
  onProgress?: (sent: number, total: number) => void
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  const total = Number(req.headers['content-length'] ?? 0) || 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(buf)
    onProgress?.(size, total)
  }
  return Buffer.concat(chunks, size)
}

function touchDevice(
  store: SyncStore,
  info: { id: string; name?: string; platform?: string },
  ip: string,
  port: number
): SyncDeviceRecord {
  const id = String(info.id || '').trim() || ip
  let device = store.devices.find((item) => item.id === id)
  const now = Date.now()
  if (!device) {
    device = {
      id,
      name: String(info.name || '').trim() || id,
      platform: String(info.platform || 'Android').slice(0, 20),
      ip,
      port,
      lastSeenAt: now,
      lastSyncAt: 0,
      filesSynced: 0
    }
    store.devices.push(device)
  } else {
    device.name = String(info.name || device.name).slice(0, 40)
    device.platform = String(info.platform || device.platform).slice(0, 20)
    device.ip = ip
    device.port = port
    device.lastSeenAt = now
  }
  store.devices = store.devices
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, 32)
  return device
}

/** 给蓝牙同步用：把一次收发记到「最近同步」里 */
export async function recordSyncEvent(event: Omit<SyncEvent, 'at'>): Promise<void> {
  const store = await loadStore()
  logEvent(store, event)
  await persist()
}

function logEvent(store: SyncStore, event: Omit<SyncEvent, 'at'>): void {
  store.events.unshift({ ...event, at: Date.now() })
  store.events = store.events.slice(0, AUDIT_LIMIT)
}

function clientIp(req: IncomingMessage): string {
  const raw = req.socket.remoteAddress ?? ''
  return raw.replace(/^::ffff:/, '')
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    })
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', 'http://localhost')
  const store = await loadStore()
  const root = resolveSyncDir(store.settings.syncDir)

  if (req.method === 'GET' && url.pathname === '/sync/ping') {
    sendJson(res, 200, { ok: true, app: 'DevToolbox', version: compactVersion() })
    return
  }

  // 清单：手机轮询它来判断有没有变化
  if (req.method === 'GET' && url.pathname === '/sync/list') {
    const { files } = await refreshManifest()
    const changed = changedSinceBaseline(files)
    sendJson(res, 200, {
      ok: true,
      version: manifestVersion(changed),
      fileCount: changed.length,
      files: changed
    })
    return
  }

  // 下载某个文件
  if (req.method === 'GET' && url.pathname === '/sync/download') {
    const target = safeTarget(root, url.searchParams.get('path') ?? '')
    if (!target) {
      sendJson(res, 400, { ok: false, error: '非法路径' })
      return
    }
    const downloadPath = url.searchParams.get('path') ?? ''
    if (cancelledPaths.has(downloadPath)) {
      // 这台设备是被取消的文件：直接告诉它跳过，别再重试
      sendJson(res, 409, { ok: false, cancelled: true, error: '已取消该文件的传输' })
      return
    }
    try {
      const stat = await fsp.stat(target)
      if (!stat.isFile()) throw new Error('不是文件')
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'Access-Control-Allow-Origin': '*'
      })
      const stream = createReadStream(target)
      let sent = 0
      const filePath = url.searchParams.get('path') ?? ''
      transferAbort = () => {
        // 先解除 pipe 再销毁，确保对端（手机）立刻收到连接关闭，不会挂着等数据
        try {
          stream.unpipe(res)
        } catch {
          // 忽略
        }
        stream.destroy()
        res.destroy()
        res.socket?.destroy()
      }
      setTransfer({ path: filePath, sent: 0, total: stat.size, outgoing: true })
      stream.on('data', (chunk: Buffer | string) => {
        sent += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        setTransfer({ path: filePath, sent, total: stat.size, outgoing: true })
      })
      const ip = clientIp(req)
      const device = touchDevice(store, { id: url.searchParams.get('device') ?? ip }, ip, store.settings.port)
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        transferAbort = null
        setTransfer(null)
        if (sent >= stat.size) {
          // 完整发完：记一条「发送」记录（之前漏了，手机上收到了电脑却没有记录）
          device.filesSynced += 1
          device.lastSyncAt = Date.now()
          logEvent(store, { direction: 'out', path: filePath, device: device.name, size: stat.size })
          void persist()
        } else if (!alreadyLoggedCancel.has(filePath)) {
          // 对端中途断开 = 对方取消了接收（本端主动取消的那种已经记过了，不再重复）
          cancelledPaths.add(filePath)
          transferHub.markCancelled(filePath, 'peer')
          logEvent(store, {
            direction: 'out',
            path: filePath,
            device: `${device.name}（对方取消）`,
            size: sent
          })
          void persist()
        }
      }
      res.on('close', finish)
      res.on('finish', finish)
      stream.on('error', finish)
      stream.pipe(res)
    } catch {
      sendJson(res, 404, { ok: false, error: '文件不存在或已被删除' })
    }
    return
  }

  // 手机把文件推上来
  if (req.method === 'POST' && url.pathname === '/sync/upload') {
    const relativePath = url.searchParams.get('path') ?? ''
    const target = safeTarget(root, relativePath)
    if (!target) {
      sendJson(res, 400, { ok: false, error: '非法路径' })
      return
    }
    const uploadPath = relativePath
    if (cancelledPaths.has(uploadPath)) {
      // 这个文件本端已经取消过：告诉手机别再传了
      sendJson(res, 409, { ok: false, cancelled: true, error: '已取消该文件的传输' })
      return
    }
    const ip = clientIp(req)
    const device = touchDevice(store, { id: url.searchParams.get('device') ?? ip }, ip, store.settings.port)
    let received = 0
    try {
      await fsp.mkdir(dirname(target), { recursive: true })
      transferAbort = () => req.destroy()
      setTransfer({ path: uploadPath, sent: 0, total: Number(req.headers['content-length'] ?? 0) || 0, outgoing: false })
      const body = await readBody(req, undefined, (sent, total) => {
        received = sent
        setTransfer({ path: uploadPath, sent, total: total || sent, outgoing: false })
      })
      transferAbort = null
      setTransfer(null)
      const stream = createWriteStream(target)
      stream.end(body)
      await new Promise<void>((resolve, reject) => {
        stream.on('close', () => resolve())
        stream.on('error', reject)
      })
      device.filesSynced += 1
      device.lastSyncAt = Date.now()
      logEvent(store, { direction: 'in', path: relativePath, device: device.name, size: body.length })
      await persist()
      const stat = await fsp.stat(target).catch(() => null)
      if (stat && baseline) baseline.set(relativePath, fingerprint({ size: stat.size, mtime: Math.round(stat.mtimeMs) }))
      refreshManifest().catch(() => undefined)
      sendJson(res, 200, { ok: true, size: body.length })
    } catch (error) {
      // 对端中途断开（取消上传）：清掉传输状态，否则界面会一直停在取消时的进度
      transferAbort = null
      setTransfer(null)
      cancelledPaths.add(uploadPath)
      transferHub.markCancelled(uploadPath, 'peer')
      if (!alreadyLoggedCancel.has(uploadPath)) {
        logEvent(store, {
          direction: 'in',
          path: uploadPath,
          device: `${device.name}（对方取消）`,
          size: received
        })
        void persist()
      }
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: (error as Error).message })
    }
    return
  }

  // 握手：手机登记自己
  if (req.method === 'POST' && url.pathname === '/sync/hello') {
    try {
      const body = await readBody(req, 64 * 1024)
      const payload = JSON.parse(body.toString('utf8') || '{}') as {
        id?: string
        name?: string
        platform?: string
        port?: number
      }
      const ip = clientIp(req)
      const device = touchDevice(
        store,
        { id: String(payload.id ?? ip), name: payload.name, platform: payload.platform },
        ip,
        clampPort(Number(payload.port ?? 0)) || store.settings.port
      )
      await persist()
      const { files } = await refreshManifest()
      const changed = changedSinceBaseline(files)
      sendJson(res, 200, {
        ok: true,
        deviceId: device.id,
        serverName: `${app.getName()} 文件同步`,
        version: manifestVersion(changed),
        fileCount: changed.length,
        syncDirName: root.split(/[\\/]/).pop() ?? 'sync-folder'
      })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: (error as Error).message })
    }
    return
  }

  sendJson(res, 404, { ok: false, error: '未知接口' })
}

function compactVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return ''
  }
}

/* ------------------------------ 对外接口 ------------------------------ */

async function ensureServer(): Promise<void> {
  const store = await loadStore()
  if (server) return
  serverPort = store.settings.port
  server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { ok: false, error: (error as Error).message })
    })
  })
  await new Promise<void>((resolve, reject) => {
    server?.once('error', reject)
    server?.listen(serverPort, '0.0.0.0', () => resolve())
  })
  // 定时刷新清单，让手机轮询能立刻发现变化
  watcher = setInterval(() => {
    void refreshManifest().then(({ version }) => {
      if (version !== lastVersion) lastVersion = version
    })
  }, 2000)
}

async function stopServer(): Promise<void> {
  if (watcher) {
    clearInterval(watcher)
    watcher = null
  }
  const current = server
  server = null
  if (!current) return
  await new Promise<void>((resolve) => current.close(() => resolve()))
}

export async function syncState(): Promise<SyncState> {
  await loadStore()
  // 第一次读状态时顺手扫描一次同步目录，界面上的文件数 / 版本才有值
  if (!lastVersion) refreshManifest().catch(() => undefined)
  return cloneState()
}

export async function saveSyncSettings(patch: Partial<SyncSettings>): Promise<SyncState> {
  const store = await loadStore()
  const next: SyncSettings = { ...store.settings, ...patch }
  next.port = clampPort(Number(next.port))
  next.syncDir = resolveSyncDir(String(next.syncDir ?? ''))
  const portChanged = next.port !== store.settings.port
  store.settings = next
  await persist()
  await fsp.mkdir(next.syncDir, { recursive: true }).catch(() => undefined)

  if (next.enabled) {
    if (server && portChanged) {
      await stopServer()
      serverPort = next.port
    }
    await ensureServer()
  } else {
    await stopServer()
  }
  refreshManifest().catch(() => undefined)
  return cloneState()
}

export async function startSync(): Promise<SyncState> {
  clearCancelledPaths()
  alreadyLoggedCancel.clear()
  // 开启同步的这一刻打基线：此前的文件视为「已经同步过」
  await captureBaseline()
  return saveSyncSettings({ enabled: true })
}

export async function stopSync(): Promise<SyncState> {
  baseline = null
  return saveSyncSettings({ enabled: false })
}

export async function removeSyncDevice(deviceId: string): Promise<SyncState> {
  const store = await loadStore()
  store.devices = store.devices.filter((item) => item.id !== deviceId)
  await persist()
  return cloneState()
}

export async function clearSyncEvents(): Promise<SyncState> {
  const store = await loadStore()
  store.events = []
  await persist()
  return cloneState()
}

export async function chooseSyncDir(dir: string): Promise<SyncState> {
  return saveSyncSettings({ syncDir: dir })
}

/** 应用启动时如果上次是「已开启」，自动把服务拉起来 */
export async function bootstrapSync(): Promise<void> {
  clearCancelledPaths()
  const store = await loadStore()
  if (!store.settings.enabled) return
  // 程序启动时同步是开着的：这一刻的文件同样视为「已同步」
  await captureBaseline().catch(() => undefined)
  try {
    await ensureServer()
  } catch (error) {
    console.error('[sync] 启动同步服务失败', error)
    store.settings.enabled = false
    server = null
    await persist()
  }
}

export async function shutdownSync(): Promise<void> {
  await stopServer()
}

/** 同步目录里的文件里，扩展名统计（界面上给个概览） */
export function extnameOf(relativePath: string): string {
  return extname(relativePath).toLowerCase()
}
