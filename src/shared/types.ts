/**
 * 主进程与渲染进程共享的类型定义。
 * 该文件只能包含类型与常量，不能被 main 或 renderer 的运行时依赖污染。
 */

export type ThemeMode = 'light' | 'dark'

export interface AppSettings {
  /** 界面主题 */
  theme: ThemeMode
  /** 文件下载默认目录（API 响应、JSON 处理结果等默认保存位置） */
  downloadDir: string
  /** 左侧导航是否折叠 */
  sidebarCollapsed: boolean
  /** 最近打开的工具 id，用于下次启动恢复 */
  lastToolId: string
}

export const DEFAULT_SETTINGS: Omit<AppSettings, 'downloadDir'> = {
  theme: 'light',
  sidebarCollapsed: false,
  lastToolId: 'json'
}

export interface FileDialogFilter {
  name: string
  extensions: string[]
}

export interface OpenFileOptions {
  title?: string
  filters?: FileDialogFilter[]
  defaultPath?: string
}

export interface SaveFileOptions {
  title?: string
  filters?: FileDialogFilter[]
  /** 指定完整路径，优先级最高 */
  defaultPath?: string
  /** 未指定 defaultPath 时，用默认下载目录 + 该文件名 */
  defaultFileName?: string
}

export interface FilePickResult {
  canceled: boolean
  filePath?: string
  fileName?: string
  size?: number
}

export interface ReadTextResult {
  ok: boolean
  content?: string
  size?: number
  error?: string
}

export interface WriteTextResult {
  ok: boolean
  filePath?: string
  bytes?: number
  error?: string
}

/* ------------------------------------------------------------------ */
/* JSON 文件处理                                                       */
/* ------------------------------------------------------------------ */

export interface JsonFileRequest {
  inputPath: string
  outputPath: string
  /** 缩进空格数，或传入 'tab' 使用制表符 */
  indent: number | 'tab'
  /** 是否压缩为单行 */
  minify?: boolean
}

export interface JsonFileOk {
  ok: true
  outputPath: string
  inputBytes: number
  outputBytes: number
  durationMs: number
}

export interface JsonFileFail {
  ok: false
  error: {
    message: string
    line: number
    column: number
    offset: number
    snippet: string
  }
}

export type JsonFileResult = JsonFileOk | JsonFileFail

/* ------------------------------------------------------------------ */
/* API 请求                                                            */
/* ------------------------------------------------------------------ */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export type AuthType = 'none' | 'bearer' | 'basic' | 'api-key'

export type BodyType = 'none' | 'json' | 'text' | 'xml' | 'form-urlencoded' | 'form-data' | 'binary'

export type ResponseMode = 'display' | 'file'

export interface KeyValueRow {
  id: string
  enabled: boolean
  key: string
  value: string
}

export interface FormRow {
  id: string
  enabled: boolean
  kind: 'text' | 'file'
  key: string
  value: string
  filePath: string
}

export interface HttpAuthConfig {
  type: AuthType
  token: string
  username: string
  password: string
  /** api-key 名称 */
  keyName: string
  /** api-key 值 */
  keyValue: string
  /** api-key 放在请求头还是查询参数 */
  addTo: 'header' | 'query'
}

export interface HttpBodyConfig {
  type: BodyType
  /** json / text / xml 原始内容 */
  raw: string
  /** 自定义 Content-Type，留空则自动推断 */
  contentType: string
  /** form-data 与 form-urlencoded 的表单项 */
  form: FormRow[]
  /** binary 类型的文件路径 */
  filePath: string
}

export interface HttpOptions {
  timeoutMs: number
  followRedirects: boolean
  ignoreTlsErrors: boolean
  responseMode: ResponseMode
  outputPath: string
  /** 展示模式下最多返回的字节数 */
  maxDisplayBytes: number
}

export interface HttpRequestConfig {
  requestId: string
  method: HttpMethod
  url: string
  params: KeyValueRow[]
  headers: KeyValueRow[]
  auth: HttpAuthConfig
  body: HttpBodyConfig
  options: HttpOptions
}

export interface HttpResponseResult {
  ok: boolean
  requestId: string
  status?: number
  statusText?: string
  httpVersion?: string
  headers?: { name: string; value: string }[]
  contentType?: string
  /** 响应体字节数 */
  size: number
  durationMs: number
  /** 展示模式下的响应文本（可能被截断） */
  bodyText?: string
  bodyTruncated?: boolean
  /** 保存模式下的文件路径 */
  bodyPath?: string
  finalUrl?: string
  error?: string
}

export interface HttpProgress {
  requestId: string
  loaded: number
  total: number
}

/* ------------------------------------------------------------------ */
/* API 请求历史                                                        */
/* ------------------------------------------------------------------ */

export interface ApiHistoryOptions {
  timeoutMs: number
  followRedirects: boolean
  ignoreTlsErrors: boolean
  responseMode: ResponseMode
}

/** 一次请求的完整快照，保存下来可在「请求列表」中直接回填 */
export interface ApiHistoryEntry {
  id: string
  method: HttpMethod
  url: string
  params: KeyValueRow[]
  headers: KeyValueRow[]
  auth: HttpAuthConfig
  body: HttpBodyConfig
  options: ApiHistoryOptions
  /** 最近一次发送的结果（仅用于展示） */
  status?: number
  ok?: boolean
  durationMs?: number
  createdAt: number
}

export type ApiHistoryDraft = Omit<ApiHistoryEntry, 'id' | 'createdAt'>

/* ------------------------------------------------------------------ */
/* 应用信息                                                            */
/* ------------------------------------------------------------------ */

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  v8: string
  userDataPath: string
  defaultDownloadDir: string
  /** 配置文件所在目录（打包后优先为安装目录） */
  configDir: string
  /** 配置文件完整路径 */
  settingsFile: string
}

/* ------------------------------------------------------------------ */
/* preload 暴露给渲染进程的 API                                        */
/* ------------------------------------------------------------------ */

export interface DesktopApi {
  settings: {
    get(): Promise<AppSettings>
    update(patch: Partial<AppSettings>): Promise<AppSettings>
    chooseDownloadDir(): Promise<{ canceled: boolean; dirPath?: string }>
    onChanged(cb: (settings: AppSettings) => void): () => void
  }
  dialog: {
    openFile(options?: OpenFileOptions): Promise<FilePickResult>
    saveFile(options?: SaveFileOptions): Promise<FilePickResult>
  }
  file: {
    readText(filePath: string): Promise<ReadTextResult>
    writeText(filePath: string, content: string): Promise<WriteTextResult>
  }
  json: {
    formatFile(request: JsonFileRequest): Promise<JsonFileResult>
    onProgress(cb: (p: { loaded: number; total: number }) => void): () => void
  }
  http: {
    request(config: HttpRequestConfig): Promise<HttpResponseResult>
    abort(requestId: string): Promise<void>
    onProgress(cb: (p: HttpProgress) => void): () => void
  }
  history: {
    list(): Promise<ApiHistoryEntry[]>
    add(entry: ApiHistoryDraft): Promise<ApiHistoryEntry[]>
    remove(id: string): Promise<ApiHistoryEntry[]>
    clear(): Promise<ApiHistoryEntry[]>
  }
  app: {
    info(): Promise<AppInfo>
    openPath(targetPath: string): Promise<string>
    showItemInFolder(targetPath: string): Promise<void>
    openExternal(url: string): Promise<void>
  }
  /** 当前运行平台，如 win32 / linux */
  platform: string
}
