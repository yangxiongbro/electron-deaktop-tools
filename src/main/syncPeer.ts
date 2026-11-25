import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { SyncPeerState, SyncTransfer } from '@shared/types'
import { scanSyncFolder, type ManifestEntry } from './syncFs'
import { transferHub } from './transferHub'
import { recordSyncEvent } from './sync'

const INTERVAL_MS = 3000
const stamp = (file: ManifestEntry): string => `${file.size}:${file.mtime}`

/**
 * PC ↔ PC 同步（WiFi / 局域网）。
 *
 * 对端就是另一台开了「文件同步」的 DevToolbox，协议与手机端完全一致：
 *   POST /sync/hello · GET /sync/list · GET /sync/download?path= · POST /sync/upload?path=&device=
 *
 * 语义和手机端一样：连接时记下本地指纹作为基线，之后只同步新增 / 改动的文件。
 */
class PeerSync {
  private state: SyncPeerState = {
    running: false,
    host: '',
    port: 45872,
    connected: false,
    lastError: '',
    remoteCount: 0,
    downloaded: 0,
    uploaded: 0,
    transfer: null
  }
  private timer: ReturnType<typeof setInterval> | null = null
  private dir = ''
  private deviceId = ''
  private maxBytes = 100 * 1024 * 1024
  private baseline = new Map<string, string>()
  private uploaded = new Set<string>()
  /** 刚从对端收到的文件（path -> 大小:修改时间），避免又当成变更上传回去 */
  private received = new Map<string, string>()
  private cancelled = new Set<string>()
  private abortCurrent: (() => void) | null = null
  private onUpdate: (() => void) | null = null

  onChange(listener: () => void): void {
    this.onUpdate = listener
  }

  snapshot(): SyncPeerState {
    return { ...this.state }
  }

  private push(): void {
    this.onUpdate?.()
  }

  private setTransfer(info: SyncTransfer | null): void {
    this.state.transfer = info
    if (info) transferHub.report('peer', info.path, info.outgoing, info.sent, info.total)
    else transferHub.finish('peer')
    this.push()
  }

  async start(config: {
    host: string
    port: number
    dir: string
    deviceId: string
    maxBytes: number
  }): Promise<SyncPeerState> {
    await this.stop()
    this.dir = config.dir
    this.deviceId = config.deviceId
    this.maxBytes = config.maxBytes
    this.baseline.clear()
    this.uploaded.clear()
    this.received.clear()
    this.cancelled.clear()
    this.state = {
      running: true,
      host: config.host,
      port: config.port,
      connected: false,
      lastError: '',
      remoteCount: 0,
      downloaded: 0,
      uploaded: 0,
      transfer: null
    }
    // 基线：此刻的本地文件，之后只同步新增 / 改动
    const local = await scanSyncFolder(this.dir, this.maxBytes).catch(() => [])
    for (const file of local) this.baseline.set(file.path, stamp(file))
    this.push()
    void this.connect()
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS)
    return this.snapshot()
  }

  async stop(): Promise<SyncPeerState> {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.abortCurrent?.()
    this.abortCurrent = null
    this.state.running = false
    this.state.connected = false
    this.state.transfer = null
    this.push()
    return this.snapshot()
  }

  /** 取消当前正在传的文件 */
  cancel(): boolean {
    const current = this.state.transfer
    if (!current) return false
    this.cancelled.add(current.path)
    this.abortCurrent?.()
    this.abortCurrent = null
    this.setTransfer(null)
    return true
  }

  private async connect(): Promise<void> {
    const ok = await this.post('/sync/hello', {
      id: this.deviceId,
      name: 'DevToolbox',
      platform: 'Windows'
    })
    if (!this.state.running) return
    this.state.connected = ok
    this.state.lastError = ok ? '' : '连接失败：确认对端已点「开启同步」'
    this.push()
    if (ok) await this.tick()
  }

  private async tick(): Promise<void> {
    if (!this.state.running) return
    const manifest = await this.list()
    if (!manifest) {
      this.state.connected = false
      this.state.lastError = '对端无响应'
      this.push()
      return
    }
    this.state.connected = true
    this.state.lastError = ''
    this.state.remoteCount = manifest.length
    this.push()

    // 远端 → 本地
    for (const file of manifest) {
      if (!this.state.running) return
      if (this.cancelled.has(file.path)) continue
      if (this.baseline.get(file.path) === stamp(file)) continue
      const bytes = await this.download(file)
      if (bytes === null) continue
      const target = join(this.dir, file.path)
      await fsp.mkdir(dirname(target), { recursive: true }).catch(() => undefined)
      if (!(await fsp.writeFile(target, bytes).then(() => true).catch(() => false))) continue
      await fsp.utimes(target, file.mtime / 1000, file.mtime / 1000).catch(() => undefined)
      this.state.downloaded += 1
      this.baseline.set(file.path, stamp(file))
      this.received.set(file.path, stamp(file))
      void recordSyncEvent({ direction: 'in', path: file.path, device: '对端电脑', size: file.size })
      this.push()
    }

    // 本地 → 远端
    const local = await scanSyncFolder(this.dir, this.maxBytes).catch(() => [])
    for (const file of local) {
      if (!this.state.running) return
      if (this.cancelled.has(file.path)) continue
      const key = `${file.path}:${file.size}:${file.mtime}`
      if (this.uploaded.has(key)) continue
      if (this.received.get(file.path) === `${file.size}:${file.mtime}`) continue
      if (this.baseline.get(file.path) === `${file.size}:${file.mtime}`) continue
      const ok = await this.upload(file)
      if (!ok) continue
      this.uploaded.add(key)
      this.state.uploaded += 1
      this.baseline.set(file.path, `${file.size}:${file.mtime}`)
      void recordSyncEvent({ direction: 'out', path: file.path, device: '对端电脑', size: file.size })
      this.push()
    }
  }

  private request(path: string, method: string, body?: Buffer, timeout = 15000): Promise<IncomingMessage | null> {
    return new Promise((resolve) => {
      const url = `http://${this.state.host}:${this.state.port}${path}`
      const req = httpRequest(
        url,
        {
          method,
          timeout,
          headers: body
            ? { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) }
            : undefined
        },
        (res) => resolve(res)
      )
      req.on('error', () => resolve(null))
      req.on('timeout', () => {
        req.destroy()
        resolve(null)
      })
      if (body) req.write(body)
      req.end()
    })
  }

  private async post(path: string, payload: unknown): Promise<boolean> {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    const res = await this.request(path, 'POST', body)
    if (!res) return false
    res.resume()
    return (res.statusCode ?? 0) < 400
  }

  private async list(): Promise<ManifestEntry[] | null> {
    const res = await this.request('/sync/list', 'GET')
    if (!res || (res.statusCode ?? 0) >= 400) return null
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { files?: ManifestEntry[] }
          resolve(Array.isArray(parsed.files) ? parsed.files : [])
        } catch {
          resolve(null)
        }
      })
    })
  }

  private download(file: ManifestEntry): Promise<Buffer | null> {
    return new Promise((resolve) => {
      void this.request(`/sync/download?path=${encodeURIComponent(file.path)}`, 'GET', undefined, 30000).then(
        (res) => {
          if (!res || (res.statusCode ?? 0) >= 400) {
            resolve(null)
            return
          }
          const chunks: Buffer[] = []
          let sent = 0
          this.abortCurrent = () => {
            res.destroy()
            resolve(null)
          }
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
            sent += chunk.length
            this.setTransfer({ path: file.path, sent, total: file.size || sent, outgoing: false })
          })
          const finish = (value: Buffer | null): void => {
            this.abortCurrent = null
            this.setTransfer(null)
            resolve(value)
          }
          res.on('end', () => finish(Buffer.concat(chunks)))
          res.on('aborted', () => finish(null))
          res.on('error', () => finish(null))
        }
      )
    })
  }

  private async upload(file: ManifestEntry): Promise<boolean> {
    const target = join(this.dir, file.path)
    const body = await fsp.readFile(target).catch(() => null)
    if (!body) return false
    this.setTransfer({ path: file.path, sent: 0, total: body.length, outgoing: true })
    const res = await this.request(
      `/sync/upload?path=${encodeURIComponent(file.path)}&device=${encodeURIComponent(this.deviceId)}`,
      'POST',
      body,
      30000
    )
    this.setTransfer(null)
    if (!res) return false
    res.resume()
    return (res.statusCode ?? 0) < 400
  }
}

export const peerSync = new PeerSync()
