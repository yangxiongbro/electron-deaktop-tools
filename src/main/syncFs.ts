import { promises as fsp } from 'node:fs'
import type { Dirent } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'

/* ------------------------------------------------------------------ */
/* 同步目录的清单：WiFi 同步与蓝牙同步共用                              */
/* ------------------------------------------------------------------ */

export interface ManifestEntry {
  path: string
  size: number
  mtime: number
}

/** 默认单文件上限：100 MB（可在程序里改） */
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024
/** 兼容旧引用 */
export const MAX_FILE_BYTES = DEFAULT_MAX_FILE_BYTES
const MAX_FILES = 20000

/**
 * 只跳过「系统垃圾 + 我们自己的临时文件」，不再按类型过滤 ——
 * 图片、视频、压缩包、二进制都会参与同步，超大的文件按大小上限跳过。
 */
function shouldSkip(name: string): boolean {
  return (
    name.startsWith('.') ||
    name.startsWith('~$') ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini' ||
    name.endsWith('.part') ||
    name.endsWith('.btpart')
  )
}

/** 递归扫同步目录，返回相对路径（统一用 /）与大小、修改时间 */
export async function scanSyncFolder(root: string, maxBytes = DEFAULT_MAX_FILE_BYTES): Promise<ManifestEntry[]> {
  const out: ManifestEntry[] = []
  const queue: string[] = [root]
  while (queue.length && out.length < MAX_FILES) {
    const current = queue.shift() as string
    let entries: Dirent[] = []
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (shouldSkip(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(full)
        continue
      }
      if (!entry.isFile()) continue
      try {
        const stat = await fsp.stat(full)
        if (stat.size > maxBytes) continue
        out.push({
          path: relative(root, full).split(sep).join('/'),
          size: stat.size,
          mtime: Math.round(stat.mtimeMs)
        })
      } catch {
        // 读不到的文件直接跳过
      }
    }
  }
  return out
}

/** 清单指纹：路径 + 大小 + 修改时间 */
export function manifestVersion(files: ManifestEntry[]): string {
  const hash = createHash('sha1')
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(`${file.path}:${file.size}:${file.mtime};`)
  }
  return hash.digest('hex').slice(0, 16)
}
