import { BrowserWindow } from 'electron'
import { BtSyncSession, type BtTransport } from './btSync'
import { transferHub } from './transferHub'
import { openBtLink, type BtLink } from './btBridge'
import { hostname } from 'node:os'
import type { SyncTransfer } from '@shared/types'
import {
  cancelledRecords,
  clearCancelledPaths,
  isCancelledPath,
  recordCancelledFile,
  recordSyncEvent,
  saveSyncSettings,
  syncState
} from './sync'

/* ------------------------------------------------------------------ */
/* 蓝牙自动同步服务：和 WiFi 同步一样，开着就一直盯着同步文件夹           */
/* ------------------------------------------------------------------ */

interface BtRuntime {
  port: string
  device: string
  running: boolean
  link: BtLink | null
  session: BtSyncSession | null
  /** 最近一条日志，界面上展示 */
  lastLog: string
  received: number
  sent: number
  since: number
  transfer: SyncTransfer | null
  /** 最近一次进度更新的时间，用于判断进度是否已经过期 */
  transferAt: number
}

const runtime: BtRuntime = {
  port: '',
  device: '',
  running: false,
  link: null,
  session: null,
  lastLog: '',
  received: 0,
  sent: 0,
  since: 0,
  transfer: null,
  transferAt: 0
}

export interface BtSyncStatus {
  running: boolean
  port: string
  device: string
  lastLog: string
  received: number
  sent: number
  since: number
  /** 当前正在传输的文件 */
  transfer: SyncTransfer | null
}

let btPushTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 把蓝牙状态推给界面。
 *
 * 界面 4 秒轮询一次，蓝牙传输往往一两秒就结束，所以进度变化时主动推送；
 * 高频更新合并到 120ms 一次，force 时立即发。
 */
function pushBtStatus(force = false): void {
  if (btPushTimer && !force) return
  if (btPushTimer) {
    clearTimeout(btPushTimer)
    btPushTimer = null
  }
  btPushTimer = setTimeout(() => {
    btPushTimer = null
    const status = btStatus()
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send('sync:bt-status', status)
    }
  }, force ? 0 : 120)
}

export function btStatus(): BtSyncStatus {
  return {
    running: runtime.running,
    port: runtime.port,
    device: runtime.device,
    lastLog: runtime.lastLog,
    received: runtime.received,
    sent: runtime.sent,
    since: runtime.since,
    // 超过 6 秒没有新的进度更新，就当这次传输已经结束了（避免界面卡在某个百分比）
    transfer: runtime.transfer && Date.now() - runtime.transferAt < 6000 ? runtime.transfer : null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 打开蓝牙串口，等手机连上来（失败就重试） */
async function connect(portName: string): Promise<BtLink> {
  let lastError = ''
  for (let attempt = 0; attempt < 60 && runtime.running; attempt++) {
    try {
      return await openBtLink(portName, {
        onData: (chunk) => {
          if (chunk.length > 0) runtime.session?.handleData(chunk)
        },
        onClose: (reason) => {
          if (runtime.running) {
            runtime.lastLog = reason
            void restart()
          }
        }
      })
    } catch (error) {
      lastError = (error as Error).message
      await sleep(3000)
    }
  }
  throw new Error(lastError || '蓝牙串口没有连上')
}

let restarting = false

async function restart(): Promise<void> {
  if (!runtime.running || restarting) return
  restarting = true
  try {
    const port = runtime.port
    stopBtSync(false)
    await sleep(1500)
    if (port) await startBtSync(port, { keep: true }).catch(() => undefined)
  } finally {
    restarting = false
  }
}

export async function startBtSync(portName: string, options: { keep?: boolean } = {}): Promise<BtSyncStatus> {
  stopBtSync(false)
  const state = await syncState()
  runtime.running = true
  runtime.port = portName
  runtime.device = ''
  runtime.received = 0
  runtime.sent = 0
  runtime.since = Date.now()
  runtime.lastLog = '正在等待手机连接…'
  clearCancelledPaths()

  const transport: BtTransport = {
    send: (chunk: Buffer) => runtime.link?.write(chunk),
    close: () => runtime.link?.close()
  }

  const maxFileBytes = Math.max(1, state.settings.maxFileMb ?? 100) * 1024 * 1024
  runtime.session = new BtSyncSession({
    dir: state.syncDir,
    maxFileBytes,
    deviceName: `${hostname()} 的电脑`,
    onProgress: (info) => {
      runtime.transfer = info
      runtime.transferAt = Date.now()
      if (info) {
        // 统一报到中枢：界面上的「取消」永远针对这里记录的当前传输
        transferHub.report('bt', info.path, info.outgoing, info.sent, info.total)
      } else {
        transferHub.finish('bt')
      }
      pushBtStatus()
    },
    isCancelled: (path) => isCancelledPath(path),
    onCancelled: (path, fingerprint) => {
      // 跨会话记住：这个文件不要自动再同步（文件变了会自动解除）
      void recordCancelledFile(path, fingerprint, 'local')
    },
    onRequestTimeout: (path) => {
      runtime.lastLog = `请求超时：${path}`
      pushBtStatus(true)
      void recordSyncEvent({
        direction: 'in',
        path,
        device: `${runtime.device || '蓝牙设备'}（对方没有该文件）`,
        size: 0
      })
    },
    onSkip: (path, reason) => {
      // 对方取消 / 对方没有该文件：清进度并按原因记录
      runtime.transfer = null
      runtime.lastLog = reason === 'missing' ? `对方没有该文件：${path}` : `对方取消了 ${path}`
      pushBtStatus(true)
      void recordSyncEvent({
        direction: 'in',
        path,
        device:
          reason === 'missing'
            ? `${runtime.device || '蓝牙设备'}（对方没有该文件）`
            : `${runtime.device || '蓝牙设备'}（对方取消）`,
        size: 0
      })
    },
    onSent: (path, size) => {
      runtime.sent += 1
      runtime.lastLog = `已发送 ${path}（${Math.round(size / 1024)} KB）`
      pushBtStatus()
      void recordSyncEvent({
        direction: 'out',
        path,
        device: runtime.device || '蓝牙设备',
        size
      })
    },
    onReceived: (path, size) => {
      runtime.received += 1
      runtime.lastLog = `收到 ${path}（${Math.round(size / 1024)} KB）`
      pushBtStatus()
      void recordSyncEvent({
        direction: 'in',
        path,
        device: runtime.device || '蓝牙设备',
        size
      })
    },
    log: (text, direction, meta) => {
      runtime.lastLog = text
      pushBtStatus()
      if (text.startsWith('已连接')) {
        runtime.device = text.replace('已连接', '').trim()
      }
      void direction
      void meta
    }
  })

  try {
    if (process.env.DSH_BT_SIMULATE === '1') {
      // 调试用：不需要真蓝牙，把写出去的字节直接喂回自己，用来验证进度链路
      runtime.link = { write: () => {}, close: () => {} } as unknown as BtLink
      const loopback: BtTransport = {
        // 每块延迟 2ms，模拟串口速度，方便验证进度显示
        send: (chunk: Buffer) => {
          runtime.session?.handleData(chunk)
          return new Promise<void>((resolve) => setTimeout(resolve, 2))
        },
        close: () => undefined
      }
      await runtime.session.attach(loopback)
      runtime.lastLog = '模拟蓝牙已连接'
    } else {
      runtime.link = await connect(portName)
      const saved = await cancelledRecords()
      runtime.session.seedCancelled(saved)
      await runtime.session.attach(transport)
      runtime.lastLog = '蓝牙已开启，等待手机连接…'
    }
  } catch (error) {
    runtime.running = false
    runtime.lastLog = (error as Error).message
  }
  await saveSyncSettings({ btEnabled: runtime.running, btPort: portName }).catch(() => undefined)
  void options
  return btStatus()
}

/** 取消正在进行的蓝牙传输（不断开连接） */
/** 把蓝牙的取消实现注册到传输中枢 */
export function registerBtCancel(): void {
  transferHub.register('bt', () => cancelBtTransfer())
}

export function cancelBtTransfer(): boolean {
  const session = runtime.session
  // 以会话记录的当前传输为准（进度回调会更新它），拿不到再退回本地的 runtime.transfer
  const current = session?.currentTransfer() ?? runtime.transfer
  if (!current) return false
  const isNew = session ? session.cancelTransfer(current.path) : false
  runtime.transfer = null
  pushBtStatus(true)
  runtime.lastLog = `已取消：${current.path}`
  if (isNew) {
    // 本端取消写一条记录，便于对照两端日志
    void recordSyncEvent({
      direction: current.outgoing ? 'out' : 'in',
      path: current.path,
      device: `${runtime.device || '蓝牙设备'}（已取消）`,
      size: Math.round(current.sent)
    })
  }
  return true
}

/** 仅调试：模拟对方请求某个文件（配合 DSH_BT_SIMULATE=1） */
export function debugBtWant(path: string): boolean {
  if (process.env.DSH_BT_SIMULATE !== '1') return false
  if (!runtime.session) return false
  runtime.session.handleData(
    Buffer.concat([
      (() => {
        const header = Buffer.from(JSON.stringify({ t: 'want', p: path }), 'utf8')
        const prefix = Buffer.alloc(2)
        prefix.writeUInt16BE(header.length, 0)
        return Buffer.concat([prefix, header])
      })()
    ])
  )
  return true
}

export function stopBtSync(clearLog = true): BtSyncStatus {
  // 先把 running 置 false：否则 link.close() 会触发 onClose -> restart() -> stopBtSync 无限递归
  runtime.running = false
  const session = runtime.session
  const link = runtime.link
  runtime.session = null
  runtime.link = null
  try {
    session?.detach()
  } catch {
    // 忽略
  }
  try {
    link?.close()
  } catch {
    // 忽略
  }
  if (clearLog) runtime.lastLog = '蓝牙同步已停止'
  void saveSyncSettings({ btEnabled: false }).catch(() => undefined)
  return btStatus()
}

export function shutdownBtSync(): void {
  stopBtSync(false)
}
