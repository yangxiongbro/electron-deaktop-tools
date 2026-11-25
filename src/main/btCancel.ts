/**
 * 传输取消登记表（蓝牙同步用）。
 *
 * 一次同步会话里，任意一端取消某个文件，都应该表现为：
 *   - 该文件在本次会话中不再传输（双向）；
 *   - 本端立即停止读写、清空进度；
 *   - 对方尽快知道（skip 帧 + 清单里的取消列表，双通道）。
 *
 * 之前这些语义散落在多个 Set / 布尔标志里（localSkipped、peerSkipped、cancelRequested…），
 * 互相不同步就会出「取消后又传」「取消不到对方」「取消后新文件也被取消」这类问题。
 * 现在统一收敛到这个类：只有一个真相来源，且区分「谁取消的」用于日志文案。
 */

export type CancelSource = 'local' | 'peer'

export interface CancelEntry {
  path: string
  source: CancelSource
  /** 取消原因：missing = 对方没有这个文件 */
  reason?: 'missing'
  at: number
}

export class CancelRegistry {
  private readonly entries = new Map<string, CancelEntry>()

  /** 登记取消，返回是否是新登记（用于日志去重） */
  mark(path: string, source: CancelSource, reason?: 'missing'): boolean {
    if (!path) return false
    const existing = this.entries.get(path)
    if (existing) {
      // 本端取消优先于「对方取消」，避免自己的操作被当成对方的
      if (source === 'local' && existing.source === 'peer') {
        this.entries.set(path, { path, source, reason, at: Date.now() })
      }
      return false
    }
    this.entries.set(path, { path, source, reason, at: Date.now() })
    return true
  }

  has(path: string): boolean {
    return this.entries.has(path)
  }

  /** 本端取消过的路径（写进清单里的 c 字段，保证对方一定知道） */
  localPaths(): string[] {
    return [...this.entries.values()].filter((item) => item.source === 'local').map((item) => item.path)
  }

  /** 全部已取消的路径（含对方取消的） */
  allPaths(): string[] {
    return [...this.entries.keys()]
  }

  get(path: string): CancelEntry | undefined {
    return this.entries.get(path)
  }

  /** 解除某个文件的取消（文件内容变了，应该重新允许同步） */
  release(path: string): void {
    this.entries.delete(path)
  }

  /** 会话结束 / 重新开始同步时清空 */
  clear(): void {
    this.entries.clear()
  }

  /** 合并对方清单里的取消列表，返回新登记的路径 */
  mergeRemote(paths: readonly string[]): string[] {
    const added: string[] = []
    for (const path of paths) {
      if (!path) continue
      if (this.mark(path, 'peer')) added.push(path)
    }
    return added
  }

  get size(): number {
    return this.entries.size
  }
}
