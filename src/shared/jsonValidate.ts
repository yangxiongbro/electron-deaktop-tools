export interface JsonErrorInfo {
  message: string
  line: number
  column: number
  offset: number
  snippet: string
}

/** 从文本中按绝对偏移计算行列号 */
export function locate(text: string, offset: number): { line: number; column: number } {
  let line = 1
  let lastBreak = -1
  const end = Math.min(Math.max(offset, 0), text.length)
  for (let i = 0; i < end; i += 1) {
    if (text[i] === '\n') {
      line += 1
      lastBreak = i
    }
  }
  return { line, column: end - lastBreak }
}

/** 生成"出错行 + 插入符号"的定位片段 */
export function snippetOf(text: string, offset: number): string {
  const idx = Math.min(Math.max(offset, 0), text.length)
  const lineStart = text.lastIndexOf('\n', Math.max(0, idx - 1)) + 1
  const nextBreak = text.indexOf('\n', idx)
  const lineEnd = nextBreak === -1 ? text.length : nextBreak
  let lineText = text.slice(lineStart, lineEnd).replace(/\r$/, '')
  let caret = idx - lineStart
  const MAX = 160
  if (lineText.length > MAX) {
    const from = Math.max(0, caret - MAX / 2)
    lineText = lineText.slice(from, from + MAX)
    caret -= from
  }
  if (lineText.trim() === '') lineText = '(空行)'
  return `${lineText}\n${' '.repeat(Math.min(Math.max(caret, 0), lineText.length))}^`
}

/** 解析 JSON 文本并返回精确到行列的错误位置（V8 的报错只带 position，这里补上行列与片段） */
export function validateJsonText(
  text: string
): { ok: true; value: unknown } | { ok: false; error: JsonErrorInfo } {
  try {
    const value = JSON.parse(text)
    return { ok: true, value }
  } catch (error) {
    const message = (error as Error).message
    const posMatch = /position\s+(\d+)/i.exec(message)
    const offset = posMatch ? Math.min(Number(posMatch[1]), text.length) : 0
    const { line, column } = locate(text, offset)
    return {
      ok: false,
      error: {
        message: message.replace(/\s*in JSON at position \d+.*$/i, '').trim() || message,
        line,
        column,
        offset,
        snippet: snippetOf(text, offset)
      }
    }
  }
}
