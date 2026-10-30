import { createReadStream, createWriteStream, promises as fsp } from 'node:fs'
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { dirname, extname, basename } from 'node:path'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import type {
  HttpBodyConfig,
  HttpRequestConfig,
  HttpRequestSnapshot,
  HttpResponseResult,
  KeyValueRow
} from '@shared/types'

const MAX_REDIRECTS = 5

const activeRequests = new Map<string, ClientRequest>()

export function abortHttpRequest(requestId: string): void {
  const req = activeRequests.get(requestId)
  if (req) {
    activeRequests.delete(requestId)
    req.destroy(new Error('请求已被用户取消'))
  }
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg'
}

function mimeOf(filePath: string): string {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

function enabledRows(rows: KeyValueRow[]): KeyValueRow[] {
  return rows.filter((row) => row.enabled && row.key.trim() !== '')
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ')
}

function normalizeUrl(raw: string): URL {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('请求地址不能为空')
  const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withProtocol)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`不支持的协议：${url.protocol}`)
  }
  return url
}

interface PreparedBody {
  contentType?: string
  contentLength?: number
  createStream?: () => Readable
}

async function prepareBody(body: HttpBodyConfig): Promise<PreparedBody> {
  switch (body.type) {
    case 'none':
      return {}
    case 'json':
    case 'text':
    case 'xml': {
      const defaultType =
        body.type === 'json' ? 'application/json' : body.type === 'xml' ? 'application/xml' : 'text/plain'
      const content = Buffer.from(body.raw ?? '', 'utf8')
      return {
        contentType: body.contentType || defaultType,
        contentLength: content.length,
        createStream: () => Readable.from([content])
      }
    }
    case 'form-urlencoded': {
      const search = new URLSearchParams()
      for (const row of body.form.filter((item) => item.enabled && item.kind === 'text' && item.key.trim())) {
        search.append(row.key, row.value)
      }
      const content = Buffer.from(search.toString(), 'utf8')
      return {
        contentType: body.contentType || 'application/x-www-form-urlencoded',
        contentLength: content.length,
        createStream: () => Readable.from([content])
      }
    }
    case 'form-data': {
      const parts = body.form.filter((row) => row.enabled && row.key.trim() !== '')
      if (parts.length === 0) throw new Error('form-data 至少需要一个启用的字段')
      const boundary = `----DevToolboxBoundary${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
      const prepared: { head: Buffer; file?: string; size?: number }[] = []

      for (const part of parts) {
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.key}"`
        if (part.kind === 'file') {
          if (!part.filePath) throw new Error(`字段 "${part.key}" 选择了文件，但还没有选择文件`)
          const stat = await fsp.stat(part.filePath)
          head += `; filename="${basename(part.filePath)}"\r\nContent-Type: ${mimeOf(part.filePath)}\r\n\r\n`
          prepared.push({ head: Buffer.from(head, 'utf8'), file: part.filePath, size: stat.size })
        } else {
          head += '\r\n\r\n'
          prepared.push({ head: Buffer.from(head + part.value + '\r\n', 'utf8') })
        }
      }

      const tail = Buffer.from(`--${boundary}--\r\n`, 'utf8')
      const total = prepared.reduce((sum, item) => sum + item.head.length + (item.size ?? 0), 0) + tail.length

      return {
        contentType: `multipart/form-data; boundary=${boundary}`,
        contentLength: total,
        createStream: () =>
          Readable.from(
            (async function* generate() {
              for (const item of prepared) {
                yield item.head
                if (item.file) {
                  for await (const chunk of createReadStream(item.file)) {
                    yield chunk as Buffer
                  }
                  yield Buffer.from('\r\n')
                }
              }
              yield tail
            })()
          )
      }
    }
    case 'binary': {
      if (!body.filePath) throw new Error('binary 请求体需要选择文件')
      const stat = await fsp.stat(body.filePath)
      return {
        contentType: body.contentType || mimeOf(body.filePath),
        contentLength: stat.size,
        createStream: () => createReadStream(body.filePath)
      }
    }
    default:
      return {}
  }
}

function guessCharset(contentType: string | undefined): string {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType ?? '')
  return (match?.[1] ?? 'utf-8').toLowerCase()
}

function decodeBuffer(buffer: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

/* ------------------------------------------------------------------ */
/* 二进制响应识别                                                       */
/* ------------------------------------------------------------------ */

/** 明确属于「文本」的 application 子类型 */
const TEXTUAL_APPLICATION =
  /^(application\/(json|ld\+json|xml|xhtml\+xml|atom\+xml|rss\+xml|javascript|ecmascript|x-javascript|graphql|x-www-form-urlencoded|yaml|x-yaml|ndjson|x-ndjson|sql|csv|toml|x-sh|typescript|x-typescript|problem\+json))(\s*;|$)/i

/** 明确属于「二进制」的 application 子类型（vnd.* 涵盖 docx / xlsx / pptx 等 office 文件） */
const BINARY_APPLICATION =
  /^(application\/(octet-stream|pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|wasm|vnd\.|msword|x-protobuf|protobuf|x-binary|x-cbor|msgpack|x-msgpack))/i

/** 图片 / 音频 / 视频 / 字体等一律按二进制处理 */
const BINARY_TOP_LEVEL = /^(image|audio|video|font|model)\//i

/**
 * 判断响应该按文本展示还是按二进制导出。
 *
 * 不带 Content-Type 时按文本处理（保持旧行为）；无法识别的 application/* 按二进制处理，
 * 避免把压缩包、office 文档等解码成乱码展示。
 *
 * 注意：office 文档的 MIME（`application/vnd.openxmlformats-…spreadsheetml.sheet`）里也含有
 * "xml" 字样，所以这里只按「精确子类型」判断，不做 `includes('xml')` 这类模糊匹配。
 */
export function isTextualContentType(contentType?: string): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (!type) return true
  if (type.startsWith('text/')) return true
  // application/vnd.api+json、application/ld+json、application/atom+xml 之类
  if (type.includes('+json') || type.includes('+xml')) return true
  if (TEXTUAL_APPLICATION.test(type)) return true
  if (BINARY_TOP_LEVEL.test(type)) return false
  if (BINARY_APPLICATION.test(type)) return false
  return false
}

/** 从 Content-Disposition 里解析建议文件名，优先使用 RFC 5987 的 filename* */
export function parseDispositionFileName(disposition?: string): string | undefined {
  if (!disposition) return undefined
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(disposition)
  const candidates: string[] = []
  if (extended) {
    try {
      candidates.push(decodeURIComponent(extended[2].trim().replace(/^"|"$/g, '')))
    } catch {
      candidates.push(extended[2].trim().replace(/^"|"$/g, ''))
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)
  if (plain) {
    const raw = plain[1].trim()
    try {
      candidates.push(decodeURIComponent(raw))
    } catch {
      candidates.push(raw)
    }
  }
  return candidates.find((item) => item.trim() !== '')?.trim()
}

/** 去掉路径分隔符与 Windows 非法字符，保证解析出的文件名可以直接用于保存对话框 */
export function safeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .trim()
  return cleaned || fallback
}

interface ResponseCapture {
  bodyText?: string
  bodyTruncated?: boolean
  bodyBase64?: string
  binary?: boolean
  bodyPath?: string
  size: number
}

async function captureResponse(
  res: IncomingMessage,
  config: HttpRequestConfig,
  onProgress: (loaded: number, total: number) => void
): Promise<ResponseCapture> {
  const total = Number(res.headers['content-length'] ?? 0)
  const rawContentType = res.headers['content-type'] as string | undefined
  const charset = guessCharset(rawContentType)
  const displayMode = config.options.responseMode !== 'file'

  if (displayMode) {
    const limit = Math.max(1024, config.options.maxDisplayBytes || 5 * 1024 * 1024)
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of res) {
      const buf = chunk as Buffer
      size += buf.length
      if (size <= limit) chunks.push(buf)
      onProgress(size, total)
    }
    const collected = Buffer.concat(chunks, Math.min(size, limit))
    const truncated = size > limit

    // 二进制响应（图片、压缩包、office 文档等）不能当文本解码，否则导出会损坏文件
    if (!isTextualContentType(rawContentType)) {
      return { bodyBase64: collected.toString('base64'), binary: true, bodyTruncated: truncated, size }
    }

    return {
      bodyText: decodeBuffer(collected, charset),
      bodyTruncated: truncated,
      size
    }
  }

  const outputPath = config.options.outputPath
  if (!outputPath) throw new Error('保存响应到文件时，需要指定输出路径')
  await fsp.mkdir(dirname(outputPath), { recursive: true }).catch(() => undefined)
  const writeStream = createWriteStream(outputPath)
  let size = 0
  try {
    for await (const chunk of res) {
      const buf = chunk as Buffer
      size += buf.length
      if (!writeStream.write(buf)) await once(writeStream, 'drain')
      onProgress(size, total)
    }
    writeStream.end()
    await once(writeStream, 'close')
  } catch (error) {
    writeStream.destroy()
    throw error
  }
  return { bodyPath: outputPath, size }
}

async function sendOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: PreparedBody,
  config: HttpRequestConfig
): Promise<{ res: IncomingMessage; req: ClientRequest }> {
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      method,
      headers: { ...headers },
      rejectUnauthorized: !config.options.ignoreTlsErrors
    }
    if (body.contentLength !== undefined) {
      options.headers = { ...options.headers, 'Content-Length': String(body.contentLength) }
    }

    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requestFn(url, options, (res) => resolve({ res, req }))
    activeRequests.set(config.requestId, req)

    req.setTimeout(Math.max(100, config.options.timeoutMs || 30000), () => {
      req.destroy(new Error(`请求超时（超过 ${config.options.timeoutMs} ms 没有响应）`))
    })
    req.on('error', (error) => {
      activeRequests.delete(config.requestId)
      reject(error)
    })

    if (body.createStream) {
      const stream = body.createStream()
      stream.on('error', (error) => req.destroy(error))
      stream.pipe(req)
    } else {
      req.end()
    }
  })
}

export async function performHttpRequest(
  config: HttpRequestConfig,
  onProgress: (loaded: number, total: number) => void
): Promise<HttpResponseResult> {
  const started = Date.now()
  let body: PreparedBody = {}
  try {
    body = await prepareBody(config.body)
  } catch (error) {
    return {
      ok: false,
      requestId: config.requestId,
      size: 0,
      durationMs: Date.now() - started,
      error: (error as Error).message
    }
  }

  const headers: Record<string, string> = {}
  for (const row of enabledRows(config.headers)) {
    headers[row.key.trim()] = sanitizeHeaderValue(row.value)
  }

  if (config.auth.type === 'bearer' && config.auth.token) {
    headers.Authorization = `Bearer ${config.auth.token}`
  } else if (config.auth.type === 'basic') {
    const raw = `${config.auth.username}:${config.auth.password}`
    headers.Authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`
  } else if (config.auth.type === 'api-key' && config.auth.keyName) {
    if (config.auth.addTo === 'header') {
      headers[config.auth.keyName] = config.auth.keyValue
    }
  }

  const hasHeader = (name: string): boolean =>
    Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase())

  if (body.contentType && !hasHeader('content-type')) headers['Content-Type'] = body.contentType
  if (!hasHeader('accept')) headers.Accept = 'application/json, text/plain, */*'
  if (!hasHeader('user-agent')) headers['User-Agent'] = 'DevToolbox (+Electron)'

  let url: URL
  try {
    url = normalizeUrl(config.url)
  } catch (error) {
    return {
      ok: false,
      requestId: config.requestId,
      size: 0,
      durationMs: Date.now() - started,
      error: (error as Error).message
    }
  }
  for (const row of enabledRows(config.params)) {
    url.searchParams.append(row.key, row.value)
  }
  if (config.auth.type === 'api-key' && config.auth.addTo === 'query' && config.auth.keyName) {
    url.searchParams.append(config.auth.keyName, config.auth.keyValue)
  }

  let method = config.method.toUpperCase()
  let redirects = 0

  // 记录实际发出的请求，界面「请求详情」直接展示这份快照（含自动补充的通用请求头）
  const requestInfo: HttpRequestSnapshot = { method, url: url.toString(), headers: [] }
  const refreshRequestInfo = (): void => {
    requestInfo.method = method
    requestInfo.url = url.toString()
    requestInfo.headers = Object.entries(headers).map(([name, value]) => ({ name, value }))
  }
  refreshRequestInfo()

  try {
    for (;;) {
      refreshRequestInfo()
      const { res, req } = await sendOnce(url, method, headers, body, config)

      const status = res.statusCode ?? 0
      const location = res.headers.location

      if (config.options.followRedirects && [301, 302, 303, 307, 308].includes(status) && location && redirects < MAX_REDIRECTS) {
        redirects += 1
        res.resume()
        req.destroy()
        activeRequests.delete(config.requestId)
        url = new URL(location, url)
        if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
          method = 'GET'
          body = { contentType: undefined, contentLength: undefined }
          delete headers['Content-Type']
          delete headers['Content-Length']
        }
        continue
      }

      const captured = await captureResponse(res, config, onProgress)
      activeRequests.delete(config.requestId)

      const responseHeaders: { name: string; value: string }[] = []
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        responseHeaders.push({ name: res.rawHeaders[i], value: res.rawHeaders[i + 1] })
      }

      const contentType = (res.headers['content-type'] as string | undefined) ?? ''
      const disposition = res.headers['content-disposition'] as string | undefined

      return {
        ok: status >= 200 && status < 400,
        requestId: config.requestId,
        status,
        statusText: res.statusMessage ?? '',
        httpVersion: res.httpVersion,
        headers: responseHeaders,
        contentType,
        size: captured.size,
        durationMs: Date.now() - started,
        bodyText: captured.bodyText,
        bodyTruncated: captured.bodyTruncated,
        bodyBase64: captured.bodyBase64,
        binary: captured.binary,
        suggestedFileName: disposition
          ? safeFileName(parseDispositionFileName(disposition) ?? '', suggestedFileNameFor(contentType))
          : undefined,
        bodyPath: captured.bodyPath,
        finalUrl: url.toString(),
        requestInfo: { ...requestInfo, headers: [...requestInfo.headers] }
      }
    }
  } catch (error) {
    activeRequests.delete(config.requestId)
    const err = error as NodeJS.ErrnoException
    let message = err.message || String(error)
    if (err.code === 'ENOTFOUND') message = `域名解析失败：${url.hostname}`
    else if (err.code === 'ECONNREFUSED') message = `连接被拒绝：${url.host}`
    else if (err.code === 'ETIMEDOUT') message = '连接超时'
    else if (err.code === 'CERT_HAS_EXPIRED') message = '服务端证书已过期，可在选项中开启"忽略证书错误"'
    else if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') message = '服务端使用了自签名证书，可在选项中开启"忽略证书错误"'
    return {
      ok: false,
      requestId: config.requestId,
      size: 0,
      durationMs: Date.now() - started,
      error: message,
      finalUrl: url.toString(),
      requestInfo: { ...requestInfo, headers: [...requestInfo.headers] }
    }
  }
}

/** 根据响应 Content-Type 给出一个带正确扩展名的默认文件名 */
export function suggestedFileNameFor(contentType: string): string {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase()
  if (type.includes('json')) return 'response.json'
  if (type.includes('html')) return 'response.html'
  if (type.includes('xml')) return 'response.xml'
  if (type.includes('spreadsheet') || type.includes('ms-excel')) return 'response.xlsx'
  if (type.includes('word')) return 'response.docx'
  if (type.includes('presentation') || type.includes('powerpoint')) return 'response.pptx'
  if (type === 'application/pdf') return 'response.pdf'
  if (type.includes('zip')) return 'response.zip'
  if (type.includes('gzip')) return 'response.gz'
  if (type.startsWith('text/')) return 'response.txt'
  if (type.startsWith('image/')) {
    const ext = type.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'png'
    return `response.${ext === 'jpeg' ? 'jpg' : ext}`
  }
  return 'response.bin'
}

export function defaultFileNameFromUrl(rawUrl: string, contentType: string): string {
  try {
    const url = normalizeUrl(rawUrl)
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
  } catch {
    // 忽略解析失败，退化为默认文件名
  }
  return suggestedFileNameFor(contentType)
}
