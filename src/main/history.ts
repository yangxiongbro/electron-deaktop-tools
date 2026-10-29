import { promises as fsp, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiHistoryDraft, ApiHistoryEntry } from '@shared/types'
import { configDir } from './store'

/** 历史记录上限，超出后丢弃最旧的 */
const MAX_ENTRIES = 100

let cache: ApiHistoryEntry[] | null = null

/** 写入串行化，避免并发写同一个临时文件造成内容撕裂 */
let writeChain: Promise<unknown> = Promise.resolve()
let writeSeq = 0

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = writeChain.then(task, task)
  writeChain = result.catch(() => undefined)
  return result
}

export function historyFile(): string {
  return join(configDir(), 'api-history.json')
}

function isEntry(value: unknown): value is ApiHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<ApiHistoryEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.url === 'string' &&
    typeof entry.method === 'string' &&
    typeof entry.createdAt === 'number' &&
    Array.isArray(entry.params) &&
    Array.isArray(entry.headers) &&
    !!entry.auth &&
    !!entry.body &&
    Array.isArray(entry.body.form)
  )
}

/** 相同「方法 + 地址 + 参数 + 请求头 + 鉴权 + 请求体」视为同一个请求 */
function signatureOf(entry: ApiHistoryEntry): string {
  const params = entry.params
    .filter((row) => row.enabled && row.key)
    .map((row) => `${row.key}=${row.value}`)
    .sort()
    .join('&')
  const headers = entry.headers
    .filter((row) => row.enabled && row.key)
    .map((row) => `${row.key.toLowerCase()}:${row.value}`)
    .sort()
    .join('|')
  const form = entry.body.form
    .filter((row) => row.enabled)
    .map((row) => `${row.kind}:${row.key}=${row.kind === 'file' ? row.filePath : row.value}`)
    .join('&')
  const auth = entry.auth
  return [
    entry.method,
    entry.url,
    params,
    headers,
    auth.type,
    auth.token,
    auth.keyName,
    auth.keyValue,
    entry.body.type,
    entry.body.raw,
    form,
    entry.body.filePath
  ].join('\u0001')
}

async function persist(list: ApiHistoryEntry[]): Promise<void> {
  await enqueueWrite(async () => {
    try {
      await fsp.mkdir(configDir(), { recursive: true })
      const target = historyFile()
      writeSeq += 1
      const tmp = `${target}.${process.pid}.${writeSeq}.tmp`
      await fsp.writeFile(tmp, JSON.stringify(list, null, 2), 'utf8')
      await fsp.rename(tmp, target)
    } catch (error) {
      console.error('[history] 写入失败（内存中的记录仍然可用）', error)
    }
  })
}

export async function loadHistory(): Promise<ApiHistoryEntry[]> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(readFileSync(historyFile(), 'utf8')) as unknown
    cache = Array.isArray(parsed) ? parsed.filter(isEntry).slice(0, MAX_ENTRIES) : []
  } catch {
    cache = []
  }
  return cache
}

export async function addHistory(draft: ApiHistoryDraft): Promise<ApiHistoryEntry[]> {
  const list = await loadHistory()
  const entry: ApiHistoryEntry = {
    ...draft,
    id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now()
  }
  const signature = signatureOf(entry)
  const next = [entry, ...list.filter((item) => signatureOf(item) !== signature)].slice(0, MAX_ENTRIES)
  cache = next
  await persist(next)
  return next
}

export async function removeHistory(id: string): Promise<ApiHistoryEntry[]> {
  const list = await loadHistory()
  const next = list.filter((item) => item.id !== id)
  cache = next
  await persist(next)
  return next
}

export async function clearHistory(): Promise<ApiHistoryEntry[]> {
  cache = []
  await persist([])
  return cache
}
