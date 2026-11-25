import { CancelRegistry } from './btCancel'

/**
 * 传输中枢：所有通道（WiFi / 蓝牙 / PC↔PC）共用一套「当前传输 + 取消」状态。
 *
 * 以前每个通道各自维护自己的 currentTransfer 和取消标志，取消按钮只能按
 * WiFi → 蓝牙 的顺序挨个试探，PC↔PC 甚至没接进来。现在：
 *   - 任何通道开始传输都先 `report()` 到中枢 → 同一时刻只有一个「当前传输」；
 *   - 取消只问中枢：它知道这次是哪个通道、哪个文件；
 *   - 取消登记表（CancelRegistry）也放在中枢，通道只负责「停 + 通知对端」。
 */
export type TransportKind = 'wifi' | 'bt' | 'peer'

export interface ActiveTransfer {
  kind: TransportKind
  path: string
  outgoing: boolean
  sent: number
  total: number
  /** 最近一次进度更新的时间 */
  at: number
}

export interface CancelResult {
  ok: boolean
  kind: TransportKind | ''
  path: string
}

type CancelHandler = () => boolean

export class TransferHub {
  private active: ActiveTransfer | null = null
  private readonly registry = new CancelRegistry()
  private readonly handlers = new Map<TransportKind, CancelHandler>()

  /** 各通道注册自己的取消实现（停传输 + 通知对端） */
  register(kind: TransportKind, handler: CancelHandler): void {
    this.handlers.set(kind, handler)
  }

  /** 通道上报进度：同一时刻只保留一个当前传输 */
  report(kind: TransportKind, path: string, outgoing: boolean, sent: number, total: number): void {
    if (!path) return
    this.active = { kind, path, outgoing, sent, total, at: Date.now() }
  }

  /** 通道结束传输（完成 / 取消 / 断开） */
  finish(kind: TransportKind, path?: string): void {
    if (!this.active) return
    if (this.active.kind !== kind) return
    if (path && this.active.path !== path) return
    this.active = null
  }

  current(): ActiveTransfer | null {
    return this.active
  }

  /** 取消当前传输：统一入口（界面按钮走这里） */
  cancel(): CancelResult {
    const current = this.active
    if (current) {
      this.registry.mark(current.path, 'local')
      const handler = this.handlers.get(current.kind)
      const ok = handler ? handler() : false
      this.active = null
      return { ok, kind: current.kind, path: current.path }
    }
    // 兜底：没有记录当前传输时，按通道顺序试一次（兼容旧状态）
    for (const kind of ['wifi', 'bt', 'peer'] as TransportKind[]) {
      const handler = this.handlers.get(kind)
      if (handler?.()) return { ok: true, kind, path: '' }
    }
    return { ok: false, kind: '', path: '' }
  }

  /** 取消登记表（各通道判断「这个文件还要不要传」时统一查这里） */
  cancelledPaths(): CancelRegistry {
    return this.registry
  }

  isCancelled(path: string): boolean {
    return this.registry.has(path)
  }

  markCancelled(path: string, source: 'local' | 'peer'): boolean {
    return this.registry.mark(path, source)
  }

  /** 开始新一轮同步：清空登记与当前传输 */
  reset(): void {
    this.registry.clear()
    this.active = null
  }
}

export const transferHub = new TransferHub()
