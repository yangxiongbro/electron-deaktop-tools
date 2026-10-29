import { createReadStream, promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type { JsonFileFail, JsonFileOk, JsonFileRequest, JsonFileResult } from '@shared/types'

/**
 * 流式 JSON 校验 + 美化输出。
 *
 * 之所以不用 `JSON.parse` + `JSON.stringify`：
 * 1. 超大文件（数百 MB）整体读入内存再 stringify 会带来 3~5 倍文件大小的内存峰值；
 * 2. 流式解析可以在读到错误的第一时间定位到行列，并且已经处理的内容可以边读边写。
 *
 * 输出与 `JSON.stringify(value, null, indent)` 的排版保持一致，
 * 但字符串转义与数字字面量保持原文，不做语义上的改写。
 */

type ContainerType = 'object' | 'array'

type Expect =
  | 'value'
  | 'arrayValueOrEnd'
  | 'keyOrEnd'
  | 'key'
  | 'colon'
  | 'commaOrEnd'
  | 'done'

type TokenKind = 'none' | 'string' | 'number' | 'literal'

interface Container {
  type: ContainerType
  empty: boolean
}

export class JsonFormatError extends Error {
  readonly detail: JsonFileFail['error']

  constructor(detail: JsonFileFail['error']) {
    super(detail.message)
    this.name = 'JsonFormatError'
    this.detail = detail
  }
}

const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/
const HEX_RE = /^[0-9a-fA-F]$/
const LITERALS = ['true', 'false', 'null']

function describeChar(ch: string): string {
  if (ch === '') return '文件结尾'
  const code = ch.charCodeAt(0)
  if (code < 0x20) return `控制字符 (0x${code.toString(16).padStart(2, '0')})`
  return `"${ch}"`
}

class StreamJsonFormatter {
  private readonly indentUnit: string
  private readonly minify: boolean

  private stack: Container[] = []
  private expect: Expect = 'value'

  private pending: TokenKind = 'none'
  private tokenBuf = ''
  /** 0 普通字符，1 反斜杠之后，2 \u 之后等待十六进制 */
  private escapeState = 0
  private unicodeRemaining = 0
  private tokenStartLine = 1
  private tokenStartColumn = 1
  private tokenStartOffset = 0

  private out: string[] = []
  private outLength = 0

  /** 已经消费的字符数（等价于下一个字符的绝对偏移） */
  private offset = 0
  private line = 1
  private column = 1

  private chunkAbsStart = 0
  private chunkText = ''
  private prevTail = ''
  private sawContent = false

  constructor(indent: number | 'tab', minify: boolean) {
    this.minify = minify
    this.indentUnit = minify ? '' : indent === 'tab' ? '\t' : ' '.repeat(Math.max(0, indent))
  }

  push(chunk: string): void {
    this.chunkAbsStart = this.offset
    this.chunkText = chunk
    let i = 0
    while (i < chunk.length) {
      const ch = chunk[i]
      const consumed = this.step(ch)
      if (consumed) {
        this.advance(ch)
        i += 1
      }
      // consumed === false 表示当前字符需要被重新分派，不前进也不消费
    }
    this.prevTail = (this.prevTail + chunk).slice(-512)
  }

  finish(): void {
    if (this.pending === 'number' || this.pending === 'literal') {
      this.closeToken()
    }
    if (this.pending === 'string') {
      throw this.fail('字符串没有闭合，缺少结束的双引号')
    }
    if (this.stack.length > 0) {
      const top = this.stack[this.stack.length - 1]
      throw this.fail(
        top.type === 'object' ? 'JSON 内容不完整，对象缺少结束的 "}"' : 'JSON 内容不完整，数组缺少结束的 "]"'
      )
    }
    if (this.expect !== 'done') {
      throw this.fail(this.sawContent ? 'JSON 内容不完整，缺少一个值' : '文件内容为空，没有可解析的 JSON')
    }
    this.out.push('\n')
  }

  takeOutput(): string {
    if (this.out.length === 0) return ''
    const text = this.out.join('')
    this.out = []
    this.outLength = 0
    return text
  }

  /* ---------------------------------------------------------------- */

  private step(ch: string): boolean {
    if (this.pending !== 'none') return this.stepToken(ch)

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') return true

    this.sawContent = true

    switch (this.expect) {
      case 'value':
      case 'arrayValueOrEnd': {
        if (ch === ']' && this.expect === 'arrayValueOrEnd') {
          this.closeContainer()
          return true
        }
        return this.beginValue(ch)
      }
      case 'keyOrEnd': {
        if (ch === '"') return this.beginString()
        if (ch === '}') {
          this.closeContainer()
          return true
        }
        throw this.fail(`${this.hintObjectKey()}，但遇到 ${describeChar(ch)}`)
      }
      case 'key': {
        if (ch === '"') return this.beginString()
        throw this.fail(`对象成员之间需要用逗号 "," 分隔，随后是键名，但遇到 ${describeChar(ch)}`)
      }
      case 'colon': {
        if (ch === ':') {
          this.write(this.minify ? ':' : ': ')
          this.expect = 'value'
          return true
        }
        throw this.fail(`键名后面需要冒号 ":"，但遇到 ${describeChar(ch)}`)
      }
      case 'commaOrEnd': {
        const top = this.stack[this.stack.length - 1]
        if (ch === ',' && top) {
          this.write(',')
          this.expect = top.type === 'object' ? 'key' : 'value'
          this.writeIndent()
          return true
        }
        if (ch === '}' && top?.type === 'object') {
          this.closeContainer()
          return true
        }
        if (ch === ']' && top?.type === 'array') {
          this.closeContainer()
          return true
        }
        throw this.fail(`这里需要逗号 "," 或者结束标记，但遇到 ${describeChar(ch)}`)
      }
      case 'done': {
        throw this.fail(`JSON 已经结束，后面还有多余内容 ${describeChar(ch)}`)
      }
      default:
        return true
    }
  }

  private beginValue(ch: string): boolean {
    if (ch === '"') return this.beginString()
    if (ch === '{') {
      this.openContainer('object')
      return true
    }
    if (ch === '[') {
      this.openContainer('array')
      return true
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) return this.beginToken('number', ch)
    if (ch === 't' || ch === 'f' || ch === 'n') return this.beginToken('literal', ch)
    throw this.fail(`这里需要一个合法的 JSON 值，但遇到 ${describeChar(ch)}`)
  }

  private beginString(): boolean {
    this.pending = 'string'
    this.tokenBuf = '"'
    this.escapeState = 0
    this.unicodeRemaining = 0
    this.rememberTokenStart()
    return true
  }

  private beginToken(kind: 'number' | 'literal', firstChar: string): boolean {
    this.rememberTokenStart()
    this.pending = kind
    this.tokenBuf = firstChar
    return true
  }

  private rememberTokenStart(): void {
    this.tokenStartLine = this.line
    this.tokenStartColumn = this.column
    this.tokenStartOffset = this.offset
  }

  private stepToken(ch: string): boolean {
    if (this.pending === 'string') return this.stepString(ch)
    if (this.pending === 'number') {
      if ((ch >= '0' && ch <= '9') || ch === '.' || ch === 'e' || ch === 'E' || ch === '+' || ch === '-') {
        this.tokenBuf += ch
        return true
      }
      this.closeToken()
      return false
    }
    // literal
    if (ch >= 'a' && ch <= 'z') {
      this.tokenBuf += ch
      return true
    }
    this.closeToken()
    return false
  }

  private stepString(ch: string): boolean {
    if (this.escapeState === 1) {
      if (ch === 'u') {
        this.escapeState = 2
        this.unicodeRemaining = 4
        this.tokenBuf += ch
        return true
      }
      if (!'"\\/bfnrt'.includes(ch)) {
        throw this.fail(`字符串中的转义序列非法：\\${ch}`)
      }
      this.escapeState = 0
      this.tokenBuf += ch
      return true
    }
    if (this.escapeState === 2) {
      if (!HEX_RE.test(ch)) {
        throw this.fail('"\\u" 之后需要 4 位十六进制数字')
      }
      this.tokenBuf += ch
      this.unicodeRemaining -= 1
      if (this.unicodeRemaining === 0) this.escapeState = 0
      return true
    }
    if (ch === '\\') {
      this.escapeState = 1
      this.tokenBuf += ch
      return true
    }
    if (ch === '"') {
      this.tokenBuf += ch
      this.pending = 'none'
      this.emitToken(this.tokenBuf)
      return true
    }
    if (ch.charCodeAt(0) < 0x20) {
      throw this.fail('字符串中不能出现未转义的控制字符（换行、制表符等需要写成 \\n、\\t）')
    }
    this.tokenBuf += ch
    return true
  }

  private closeToken(): void {
    const raw = this.tokenBuf
    const kind = this.pending
    this.pending = 'none'
    this.tokenBuf = ''

    if (kind === 'number' && !NUMBER_RE.test(raw)) {
      throw this.errorAt(this.tokenStartOffset, this.tokenStartLine, this.tokenStartColumn, `数字格式非法："${raw}"`)
    }
    if (kind === 'literal' && !LITERALS.includes(raw)) {
      throw this.errorAt(
        this.tokenStartOffset,
        this.tokenStartLine,
        this.tokenStartColumn,
        `无法识别的字面量："${raw}"（只允许 true / false / null）`
      )
    }
    this.emitToken(raw)
  }

  private emitToken(raw: string): void {
    const isKey = this.expect === 'keyOrEnd' || this.expect === 'key'
    this.beginChild()
    this.write(raw)
    if (isKey) {
      this.expect = 'colon'
    } else {
      this.afterValue()
    }
  }

  private openContainer(type: ContainerType): void {
    this.beginChild()
    this.write(type === 'object' ? '{' : '[')
    this.stack.push({ type, empty: true })
    this.expect = type === 'object' ? 'keyOrEnd' : 'arrayValueOrEnd'
  }

  private closeContainer(): void {
    const container = this.stack.pop()
    if (!container) throw this.fail('多余的结束括号')
    if (!container.empty) this.writeIndent()
    this.write(container.type === 'object' ? '}' : ']')
    this.afterValue()
  }

  private afterValue(): void {
    this.expect = this.stack.length === 0 ? 'done' : 'commaOrEnd'
  }

  /** 写入容器中的第一个子元素前，先换行缩进 */
  private beginChild(): void {
    const parent = this.stack[this.stack.length - 1]
    if (!parent) return
    if (parent.empty) {
      parent.empty = false
      this.writeIndent()
    }
  }

  private writeIndent(): void {
    if (this.minify) return
    this.write('\n')
    if (this.stack.length > 0 && this.indentUnit) this.write(this.indentUnit.repeat(this.stack.length))
  }

  private write(text: string): void {
    if (!text) return
    this.out.push(text)
    this.outLength += text.length
  }

  private hintObjectKey(): string {
    return '这里需要一个用双引号包裹的对象键名，或者结束的 "}"'
  }

  private advance(ch: string): void {
    this.offset += 1
    if (ch === '\n') {
      this.line += 1
      this.column = 1
    } else {
      this.column += 1
    }
  }

  private fail(message: string): JsonFormatError {
    return this.errorAt(this.offset, this.line, this.column, message)
  }

  private errorAt(offset: number, line: number, column: number, message: string): JsonFormatError {
    return new JsonFormatError({
      message,
      line,
      column,
      offset,
      snippet: this.buildSnippet(offset)
    })
  }

  private buildSnippet(offset: number): string {
    const text = this.chunkText
    const local = offset - this.chunkAbsStart
    const idx = Math.min(Math.max(local, 0), text.length)

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
    const safeCaret = Math.min(Math.max(caret, 0), lineText.length)
    return `${lineText}\n${' '.repeat(safeCaret)}^`
  }
}

/**
 * 校验并格式化一个 JSON 文件，结果直接写入 outputPath。
 * 成功返回统计信息；失败返回带行列号的错误信息，不会留下半截输出文件。
 */
export async function formatJsonFile(
  request: JsonFileRequest,
  onProgress?: (loaded: number, total: number) => void
): Promise<JsonFileResult> {
  const started = Date.now()
  const { inputPath, outputPath, indent, minify = false } = request

  if (inputPath === outputPath) {
    return {
      ok: false,
      error: {
        message: '输出文件不能与输入文件相同，请选择另一个输出路径',
        line: 0,
        column: 0,
        offset: 0,
        snippet: ''
      }
    }
  }

  let inputStat
  try {
    inputStat = await fsp.stat(inputPath)
  } catch (error) {
    return {
      ok: false,
      error: {
        message: `无法读取输入文件：${(error as Error).message}`,
        line: 0,
        column: 0,
        offset: 0,
        snippet: inputPath
      }
    }
  }

  const formatter = new StreamJsonFormatter(indent, minify)
  const readStream = createReadStream(inputPath, { highWaterMark: 1024 * 1024, encoding: 'utf8' })
  let handle: FileHandle | undefined

  try {
    handle = await fsp.open(outputPath, 'w')
    let firstChunk = true
    for await (const chunk of readStream) {
      let text = chunk as string
      if (firstChunk) {
        firstChunk = false
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      }
      formatter.push(text)
      const output = formatter.takeOutput()
      if (output) await handle.write(output)
      onProgress?.(readStream.bytesRead, inputStat.size)
    }
    formatter.finish()
    const tail = formatter.takeOutput()
    if (tail) await handle.write(tail)

    const outputStat = await fsp.stat(outputPath)
    const ok: JsonFileOk = {
      ok: true,
      outputPath,
      inputBytes: inputStat.size,
      outputBytes: outputStat.size,
      durationMs: Date.now() - started
    }
    return ok
  } catch (error) {
    readStream.destroy()
    await fsp.rm(outputPath, { force: true }).catch(() => undefined)

    if (error instanceof JsonFormatError) {
      return { ok: false, error: error.detail }
    }
    return {
      ok: false,
      error: {
        message: `处理失败：${(error as Error).message}`,
        line: 0,
        column: 0,
        offset: 0,
        snippet: ''
      }
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

