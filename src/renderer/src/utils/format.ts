export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatDate(date: Date): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

const ESCAPE_MAP: Record<string, string> = {
  '"': '"',
  "'": "'",
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '0': '\0'
}

/**
 * 去除文本里的转义字符。
 *
 * 先把整体是一个 JSON 字符串的输入（`"{\"a\":1}"`）解析出内容，
 * 再还原 `\" \\ \/ \b \f \n \r \t \v \0`、`\uhhhh`、`\u{hhhhh}`、`\xhh` 这些转义；
 * 无法识别的转义（例如 `\z`）原样保留。
 */
export function unescapeText(source: string): string {
  let text = source.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const value: unknown = JSON.parse(text)
      if (typeof value === 'string') text = value
    } catch {
      // 不是合法的 JSON 字符串，按普通文本处理
    }
  }
  return text.replace(
    /\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([\s\S]))/g,
    (match: string, braced?: string, four?: string, two?: string, single?: string): string => {
      if (braced) return String.fromCodePoint(parseInt(braced, 16))
      if (four) return String.fromCharCode(parseInt(four, 16))
      if (two) return String.fromCharCode(parseInt(two, 16))
      if (single !== undefined && Object.prototype.hasOwnProperty.call(ESCAPE_MAP, single)) {
        return ESCAPE_MAP[single]
      }
      return match
    }
  )
}
