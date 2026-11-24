import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import { manifestVersion, scanSyncFolder, type ManifestEntry } from './syncFs'

/* ------------------------------------------------------------------ */
/* 蓝牙自动同步：和 WiFi 同步一样，盯着同步文件夹，有变化就互发文件        */
/*                                                                     */
/* 分帧：2 字节大端「头部长度」+ UTF-8 JSON 头 + 负载                     */
/*   { t:'hello',  name }                                 握手           */
/*   { t:'manifest', v, files:[{p,s,m}] }                 清单           */
/*   { t:'want',   p }                                    请求某个文件   */
/*   { t:'file',   p, n, o }  + 负载（分块，o 是偏移）     文件块         */
/* ------------------------------------------------------------------ */

export interface BtTransport {
  /** 往对端写字节；缓冲满时可返回 Promise（背压） */
  send(chunk: Buffer): void | Promise<void>
  close(): void
}

export interface BtSyncLogMeta {
  path?: string
  size?: number
}

export interface BtSyncLogger {
  (text: string, direction: 'in' | 'out', meta?: BtSyncLogMeta): void
}

export interface BtSyncOptions {
  /** 同步目录 */
  dir: string
  /** 自己的设备名（手机端显示用） */
  deviceName: string
  /** 日志回调 */
  log: BtSyncLogger
  /** 单文件大小上限 */
  maxFileBytes?: number
  /** 收到文件后是否把修改时间对齐到发送方（手机 SAF 目录做不到，故可关） */
  applyMtime?: boolean
  /** 是否按发送方 mtime 上报收到的文件（关掉可复现老版本的「来回同步」问题） */
  reportReceivedMtime?: boolean
  /** 传输进度（null 表示当前没有传输） */
  onProgress?: (info: { path: string; sent: number; total: number; outgoing: boolean } | null) => void
  /** 本端是否已取消这个文件（取消后不再发送） */
  isCancelled?: (path: string) => boolean
  /** 对方取消了某个文件 */
  onSkip?: (path: string) => void
}

const CHUNK_SIZE = 32 * 1024


const MANIFEST_INTERVAL_MS = 1500
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

interface Frame {
  header: Record<string, unknown>
  payload: Buffer
}

/**
 * 组一帧：2 字节头长 + JSON 头 + 负载。
 *
 * 注意 `z` 是「这一帧负载的字节数」，与 `n`（文件总大小）不是一回事 ——
 * 分块传输时一帧只带 CHUNK_SIZE 字节，靠 z 才能正确切帧。
 */
export function encodeBtFrame(header: Record<string, unknown>, payload: Buffer = Buffer.alloc(0)): Buffer {
  const headerWithSize = { ...header, z: payload.length }
  const headerBytes = Buffer.from(JSON.stringify(headerWithSize), 'utf8')
  const frame = Buffer.alloc(2 + headerBytes.length + payload.length)
  frame.writeUInt16BE(headerBytes.length, 0)
  headerBytes.copy(frame, 2)
  payload.copy(frame, 2 + headerBytes.length)
  return frame
}

/** 从缓冲区里尽可能多地切出完整帧；返回帧与剩余尾巴 */
export function decodeBtFrames(buffer: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const headerLength = buffer.readUInt16BE(offset)
    if (headerLength <= 0 || headerLength > 64 * 1024) break
    if (offset + 2 + headerLength > buffer.length) break
    let header: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(buffer.subarray(offset + 2, offset + 2 + headerLength).toString('utf8'))
      if (!parsed || typeof parsed !== 'object') break
      header = parsed as Record<string, unknown>
    } catch {
      break
    }
    const payloadSize = Number(header.z ?? 0)
    const dataStart = offset + 2 + headerLength
    if (payloadSize < 0 || dataStart + payloadSize > buffer.length) break
    frames.push({ header, payload: buffer.subarray(dataStart, dataStart + payloadSize) })
    offset = dataStart + payloadSize
  }
  return { frames, rest: buffer.subarray(offset) }
}

/**
 * 一端（PC 或手机）的自动同步会话：协议逻辑与传输方式无关，
 * 方便用内存管道做自测。
 */
export class BtSyncSession {
  private transport: BtTransport | null = null
  private buffer: Buffer = Buffer.alloc(0)
  private timer: ReturnType<typeof setInterval> | null = null
  private localFiles: ManifestEntry[] = []
  private localVersion = ''
  private remoteFiles = new Map<string, ManifestEntry>()
  /** 正在接收的文件：p → { size, received, temp } */
  private incoming = new Map<string, { size: number; received: number; temp: string }>()
  private closed = false
  /** 正在发送的文件：避免同一条 want 触发并发发送 */
  /** 刚收完的文件：path -> { size, at }，短时间内不再重复请求（防止两端来回重传） */
  private readonly completed = new Map<string, { size: number; at: number }>()
  private readonly sending = new Set<string>()
  /** 本端取消过的文件：写进清单，确保对方一定知道（skip 帧丢了也能对齐） */
  private readonly localSkipped = new Set<string>()
  /** 对方明确取消过的文件：本端立刻停发，且不再给它发 */
  private readonly peerSkipped = new Set<string>()
  /** 已发出、还没收完的 want：path → 时间戳（防止反复请求同一个文件） */
  private requested = new Map<string, number>()
  /** 收到过的文件：path → { 应上报的 mtime, 落盘后的 mtime } */
  private receivedStamp = new Map<string, { reportMtime: number; diskMtime: number }>()
  /** 开启同步那一刻的指纹：只有之后新增 / 改动的文件才上报、才同步 */
  private baseline = new Map<string, string>()
  private lastRemoteVersion = ''

  constructor(private readonly options: BtSyncOptions) {}

  get running(): boolean {
    return this.transport !== null && !this.closed
  }

  async attach(transport: BtTransport): Promise<void> {
    this.transport = transport
    this.closed = false
    // 开启同步时先记下当前目录：这些文件视为已同步，不再互相传
    const initial = await scanSyncFolder(this.options.dir, this.options.maxFileBytes ?? DEFAULT_MAX_BYTES)
    this.baseline = new Map(initial.map((file) => [file.path, `${file.size}:${file.mtime}`]))
    await this.refreshLocal(true)
    this.send({ t: 'hello', name: this.options.deviceName })
    this.sendManifest()
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      void this.refreshLocal(false)
    }, MANIFEST_INTERVAL_MS)
  }

  detach(): void {
    this.closed = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.emitProgress(null)
    const transport = this.transport
    this.transport = null
    this.remoteFiles.clear()
    this.incoming.clear()
    try {
      transport?.close()
    } catch {
      // 忽略关闭错误
    }
  }

  /** 传输层收到字节后喂进来 */
  handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const { frames, rest } = decodeBtFrames(this.buffer)
    this.buffer = rest
    for (const frame of frames) {
      void this.handleFrame(frame).catch((error: unknown) => {
        this.options.log(`处理帧失败：${(error as Error).message}`, 'in')
      })
    }
  }

  private send(header: Record<string, unknown>, payload: Buffer = Buffer.alloc(0)): void | Promise<void> {
    if (!this.transport) return
    try {
      return this.transport.send(encodeBtFrame(header, payload))
    } catch (error) {
      this.options.log(`发送失败：${(error as Error).message}`, 'out')
    }
  }

  private sendManifest(): void {
    this.send({
      t: 'manifest',
      v: this.localVersion,
      files: this.localFiles.map((file) => ({ p: file.path, s: file.size, m: file.mtime })),
      c: [...this.localSkipped]
    })
  }

  private async refreshLocal(force: boolean): Promise<void> {
    if (!this.transport) return
    const maxBytes = this.options.maxFileBytes ?? DEFAULT_MAX_BYTES
    const scanned = await scanSyncFolder(this.options.dir, maxBytes)
    // 对端可能改不了文件的修改时间（安卓 SAF 目录就是这样）：
    // 这里把刚收到的文件按发送方的 mtime 上报，避免「发出去又被原样拉回来」。
    const changedFiles = scanned.filter((file) => this.baseline.get(file.path) !== `${file.size}:${file.mtime}`)
    const files = changedFiles.map((file) => {
      const stamp = this.receivedStamp.get(file.path)
      if (this.options.reportReceivedMtime !== false && stamp && Math.abs(file.mtime - stamp.diskMtime) <= 2000) {
        return { ...file, mtime: stamp.reportMtime }
      }
      return file
    })
    const version = manifestVersion(files)
    const changed = version !== this.localVersion
    this.localFiles = files
    this.localVersion = version
    if (changed || force) this.sendManifest()
  }

  private async handleFrame(frame: Frame): Promise<void> {
    const type = String(frame.header.t ?? '')
    switch (type) {
      case 'hello': {
        const name = String(frame.header.name ?? '对方')
        this.options.log(`已连接 ${name}`, 'in')
        this.sendManifest()
        break
      }
      case 'manifest': {
        // 对方清单里带的「已取消」列表：即使 skip 帧丢了也能对齐
        const cancelled = frame.header.c
        if (Array.isArray(cancelled)) {
          for (const item of cancelled) {
            const path = String(item ?? '')
            if (!path) continue
            const wasKnown = this.peerSkipped.has(path) || this.localSkipped.has(path)
            this.peerSkipped.add(path)
            this.incoming.delete(path)
            this.emitProgress(null)
            if (!wasKnown) this.options.onSkip?.(path)
          }
        }
        const version = String(frame.header.v ?? '')
        if (version && version === this.lastRemoteVersion) break
        this.lastRemoteVersion = version
        const files = Array.isArray(frame.header.files) ? frame.header.files : []
        this.remoteFiles.clear()
        for (const item of files) {
          if (!item || typeof item !== 'object') continue
          const record = item as { p?: string; s?: number; m?: number }
          const path = String(record.p ?? '').trim()
          if (!path) continue
          this.remoteFiles.set(path, {
            path,
            size: Number(record.s ?? 0),
            mtime: Number(record.m ?? 0)
          })
        }
        await this.requestMissing()
        break
      }
      case 'want': {
        const path = String(frame.header.p ?? '')
        if (!path) break
        if (this.peerSkipped.has(path) || this.localSkipped.has(path) || this.options.isCancelled?.(path)) {
          // 这个文件在本端被取消过：告诉对方别再要
          this.send({ t: 'skip', p: path })
          break
        }
        if (this.sending.has(path)) break
        this.sending.add(path)
        // 关键：异步发送。await 会把收帧循环卡住，发送期间收不到对方的取消
        void this.sendFile(path).finally(() => this.sending.delete(path))
        break
      }
      case 'skip': {
        // 对方取消了这个文件：不再请求、也不再发送，并清掉半截接收缓冲
        const path = String(frame.header.p ?? '')
        if (!path) break
        this.requested.delete(path)
        const wasKnown = this.peerSkipped.has(path) || this.localSkipped.has(path)
        this.peerSkipped.add(path)
        this.incoming.delete(path)
        this.emitProgress(null)
        if (!wasKnown) this.options.onSkip?.(path)
        break
      }
      case 'file': {
        await this.receiveChunk(frame)
        break
      }
      default:
        break
    }
  }

  /** 远端有我缺的文件（或版本不同）就发 want */
  private async requestMissing(): Promise<void> {
    const local = new Map(this.localFiles.map((file) => [file.path, file]))
    const now = Date.now()
    for (const [path, remote] of this.remoteFiles) {
      if (this.incoming.has(path)) continue
      const mine = local.get(path)
      // 大小与修改时间都对得上 → 认定是同一份，跳过
      if (mine && mine.size === remote.size && Math.abs(mine.mtime - remote.mtime) <= 2000) continue
      // 自己这份更新，等对方来拉，避免互相覆盖
      if (mine && mine.mtime > remote.mtime) continue
      const pendingAt = this.requested.get(path)
      if (pendingAt && now - pendingAt < 15000) continue
      this.requested.set(path, now)
      this.send({ t: 'want', p: path })
      this.options.log(`请求 ${path}`, 'out')
    }
  }

  /** 取消过的文件不再上报进度，避免取消后界面又冒出一条进度 */
  private emitProgress(info: { path: string; sent: number; total: number; outgoing: boolean } | null): void {
    if (info && (this.localSkipped.has(info.path) || this.peerSkipped.has(info.path))) {
      this.emitProgress(null)
      return
    }
    this.emitProgress(info)
  }

  /** 本端取消某个文件的传输：立即通知对方，并让清单带上取消信息 */
  cancelTransfer(path: string): void {
    if (!path) return
    const had = this.localSkipped.has(path)
    this.localSkipped.add(path)
    this.incoming.delete(path)
    if (!had) {
      this.send({ t: 'skip', p: path })
      this.sendManifest()
    }
  }

  private async sendFile(path: string): Promise<void> {
    const maxBytes = this.options.maxFileBytes ?? DEFAULT_MAX_BYTES
    const target = join(this.options.dir, path)
    const stat = await fsp.stat(target).catch(() => null)
    if (!stat || !stat.isFile()) {
      this.options.log(`文件不存在：${path}`, 'out')
      return
    }
    if (stat.size > maxBytes) {
      this.options.log(`${path} 超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB，已跳过`, 'out')
      return
    }
    const data = await fsp.readFile(target).catch(() => null)
    if (!data) return
    for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
      const chunk = data.subarray(offset, Math.min(offset + CHUNK_SIZE, data.length))
      // 等这一块真的写进串口缓冲（btBridge 有背压），否则大文件会「瞬间发完」，界面看不到进度
      const writing = this.send({ t: 'file', p: path, n: data.length, o: offset, m: Math.round(stat.mtimeMs) }, chunk)
      if (writing) await writing
      this.options.onProgress?.({ path, sent: offset + chunk.length, total: data.length, outgoing: true })
      if (this.peerSkipped.has(path)) {
        // 对方取消了：停发并清状态（它自己会清缓冲）
        this.emitProgress(null)
        this.options.log(`对方取消了 ${path}，已停止发送`, 'out', { path, size: offset })
        return
      }
      if (this.localSkipped.has(path)) {
        // 本端取消了（cancelTransfer 已经把 skip 发出去并记了日志）
        this.emitProgress(null)
        return
      }
    }
    if (data.length === 0) this.send({ t: 'file', p: path, n: 0, o: 0, m: Math.round(stat.mtimeMs) })
    this.emitProgress(null)
    this.options.log(`已发送 ${path}（${(data.length / 1024).toFixed(0)} KB）`, 'out', { path, size: data.length })
  }

  private async receiveChunk(frame: Frame): Promise<void> {
    const path = String(frame.header.p ?? '')
    if (path && (this.peerSkipped.has(path) || this.localSkipped.has(path))) {
      this.incoming.delete(path)
      this.emitProgress(null)
      return
    }
    const size = Number(frame.header.n ?? 0)
    const offset = Number(frame.header.o ?? 0)
    if (!path || size < 0 || offset < 0) return
    const maxBytes = this.options.maxFileBytes ?? DEFAULT_MAX_BYTES
    if (size > maxBytes) {
      this.options.log(`${path} 超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB，已跳过`, 'in')
      return
    }

    const target = join(this.options.dir, path)
    let state = this.incoming.get(path)
    if (!state) {
      state = { size, received: 0, temp: `${target}.btpart` }
      this.incoming.set(path, state)
      await fsp.mkdir(dirname(target), { recursive: true }).catch(() => undefined)
      await fsp.writeFile(state.temp, Buffer.alloc(0)).catch(() => undefined)
    }
    if (offset !== state.received) {
      // 乱序（正常不会发生）：重置
      state.received = 0
      await fsp.writeFile(state.temp, Buffer.alloc(0)).catch(() => undefined)
    }
    await fsp.appendFile(state.temp, frame.payload)
    state.received += frame.payload.length
    this.options.onProgress?.({ path, sent: state.received, total: size, outgoing: false })
    if (state.received >= size) {
      this.incoming.delete(path)
      this.requested.delete(path)
      await fsp.rename(state.temp, target).catch(async () => {
        await fsp.copyFile(state.temp, target)
        await fsp.rm(state.temp, { force: true }).catch(() => undefined)
      })
      // 用发送方的修改时间，保证两端清单一致，不会来回反复同步
      const mtime = Number(frame.header.m ?? 0)
      if (mtime > 0 && this.options.applyMtime !== false) {
        const seconds = mtime / 1000
        await fsp.utimes(target, seconds, seconds).catch(() => undefined)
      }
      if (mtime > 0) {
        const stat = await fsp.stat(target).catch(() => null)
        this.receivedStamp.set(path, {
          reportMtime: mtime,
          diskMtime: Math.round(stat?.mtimeMs ?? Date.now())
        })
      }
      // 刚收完：30 秒内不再为同一个文件去请求（防止两端 mtime 对不齐时来回重传）
      this.completed.set(path, { size, at: Date.now() })
      this.emitProgress(null)
      this.options.log(`收到 ${path}（${(size / 1024).toFixed(0)} KB）`, 'in', { path, size })
      await this.refreshLocal(true)
    }
  }
}
