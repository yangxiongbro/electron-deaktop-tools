import { BrowserWindow } from 'electron'
import { BtSyncSession, type BtTransport } from './btSync'
import { openBtLink, type BtLink } from './btBridge'
import { hostname } from 'node:os'
import type { SyncTransfer } from '@shared/types'
import { clearCancelledPaths, isCancelledPath, recordSyncEvent, saveSyncSettings, syncState } from './sync'

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
  transfer: null
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
    transfer: runtime.transfer
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

async function restart(): Promise<void> {
  if (!runtime.running) return
  const port = runtime.port
  stopBtSync(false)
  await sleep(1500)
  if (port) await startBtSync(port, { keep: true }).catch(() => undefined)
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
      pushBtStatus()
    },
    isCancelled: (path) => isCancelledPath(path),
    onSkip: (path) => {
      // 对方取消了：本地进度也要立刻清掉，否则界面停在旧百分比
      runtime.transfer = null
      runtime.lastLog = `对方取消了 ${path}`
      pushBtStatus(true)
      // 也记一条「最近同步」，界面上能看出来是对方取消的
      void recordSyncEvent({
        direction: 'in',
        path,
        device: `${runtime.device || '蓝牙设备'}（对方取消）`,
        size: 0
      })
    },
    log: (text, direction, meta) => {
      runtime.lastLog = text
      pushBtStatus()
      if (text.startsWith('已连接')) {
        runtime.device = text.replace('已连接', '').trim()
      }
      if (!meta?.path) return
      if (text.startsWith('已发送')) runtime.sent += 1
      if (text.startsWith('收到')) runtime.received += 1
      if (text.startsWith('已发送') || text.startsWith('收到')) {
        void recordSyncEvent({
          direction: direction === 'in' ? 'in' : 'out',
          path: meta.path,
          device: runtime.device || '蓝牙设备',
          size: meta.size ?? 0
        })
      }
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
export function cancelBtTransfer(): boolean {
  const current = runtime.transfer
  if (!current) return false
  runtime.session?.cancelTransfer(current.path)
  runtime.transfer = null
  pushBtStatus(true)
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
  runtime.session?.detach()
  runtime.session = null
  try {
    runtime.link?.close()
  } catch {
    // 忽略
  }
  runtime.link = null
  runtime.running = false
  if (clearLog) runtime.lastLog = '蓝牙同步已停止'
  void saveSyncSettings({ btEnabled: false }).catch(() => undefined)
  return btStatus()
}

export function shutdownBtSync(): void {
  stopBtSync(false)
}
