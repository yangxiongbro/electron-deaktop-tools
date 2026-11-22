import { BtSyncSession, type BtTransport } from './btSync'
import { openBtLink, type BtLink } from './btBridge'
import { hostname } from 'node:os'
import type { SyncTransfer } from '@shared/types'
import { recordSyncEvent, saveSyncSettings, syncState } from './sync'

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
    },
    log: (text, direction, meta) => {
      runtime.lastLog = text
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
    runtime.link = await connect(portName)
    await runtime.session.attach(transport)
    runtime.lastLog = '蓝牙已开启，等待手机连接…'
  } catch (error) {
    runtime.running = false
    runtime.lastLog = (error as Error).message
  }
  await saveSyncSettings({ btEnabled: runtime.running, btPort: portName }).catch(() => undefined)
  void options
  return btStatus()
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
