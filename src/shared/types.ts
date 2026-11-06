/**
 * 主进程与渲染进程共享的类型定义。
 * 该文件只能包含类型与常量，不能被 main 或 renderer 的运行时依赖污染。
 */

export type ThemeMode = 'light' | 'dark'

/** API 请求体 Content-Type 的内置候选项，用户可以在界面上增删 */
export const DEFAULT_CONTENT_TYPES: string[] = [
  'application/json',
  'application/json;charset=UTF-8',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'text/plain;charset=UTF-8',
  'text/html',
  'text/csv',
  'text/xml',
  'application/xml',
  'application/javascript',
  'application/octet-stream',
  'application/x-ndjson',
  'application/grpc'
]

export interface AppSettings {
  /** 界面主题 */
  theme: ThemeMode
  /** 文件下载默认目录（API 响应、JSON 处理结果等默认保存位置） */
  downloadDir: string
  /** 左侧导航是否折叠 */
  sidebarCollapsed: boolean
  /** 最近打开的工具 id，用于下次启动恢复 */
  lastToolId: string
  /** API 请求：是否在停止输入后自动保存（默认关闭，关闭后需手动保存） */
  apiAutoSave: boolean
  /** API 请求：请求体 Content-Type 的候选项（可增删） */
  apiContentTypes: string[]
  /** API 请求：左侧请求列表是否折叠 */
  apiSidebarCollapsed: boolean
}

export const DEFAULT_SETTINGS: Omit<AppSettings, 'downloadDir'> = {
  theme: 'light',
  sidebarCollapsed: false,
  lastToolId: 'json',
  apiAutoSave: false,
  apiContentTypes: [...DEFAULT_CONTENT_TYPES],
  apiSidebarCollapsed: false
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

/** 文件状态，用于 Markdown 编辑器的「文件是否被其它程序改过」判断 */
export interface FileStatResult {
  exists: boolean
  /** 最后修改时间（毫秒） */
  mtimeMs: number
  size: number
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

/** 实际发出的请求快照，用于「请求详情」展示 */
export interface HttpRequestSnapshot {
  method: string
  url: string
  headers: { name: string; value: string }[]
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
  /**
   * 展示模式下遇到二进制响应（图片、压缩包、office 等）时，
   * 按 base64 返回原始字节，界面可原样导出为文件。
   */
  bodyBase64?: string
  /** 响应是否为二进制内容（此时 bodyText 为空、bodyBase64 有值） */
  binary?: boolean
  /** 从 Content-Disposition 解析出的建议文件名 */
  suggestedFileName?: string
  /** 保存模式下的文件路径 */
  bodyPath?: string
  finalUrl?: string
  /** 实际发出的请求（方法 / 地址 / 请求头），包含自动补充的通用请求头 */
  requestInfo?: HttpRequestSnapshot
  error?: string
}

export interface HttpProgress {
  requestId: string
  loaded: number
  total: number
}

/* ------------------------------------------------------------------ */
/* API 请求：多项目 + 请求记录                                          */
/* ------------------------------------------------------------------ */

export interface ApiRequestOptions {
  timeoutMs: number
  followRedirects: boolean
  ignoreTlsErrors: boolean
  responseMode: ResponseMode
}

/** 一条请求记录：完整保存了发送该请求所需的全部信息 */
export interface ApiRequestRecord {
  id: string
  /** 请求名称，用于在左侧列表里区分同名接口 */
  name: string
  method: HttpMethod
  url: string
  params: KeyValueRow[]
  headers: KeyValueRow[]
  auth: HttpAuthConfig
  body: HttpBodyConfig
  options: ApiRequestOptions
  /** 所属文件夹 id，null 表示在项目根目录 */
  folderId: string | null
  /** 手动排序用的顺序值（越小越靠前；默认按创建时间排序） */
  order?: number
  /** 最近一次发送的结果（仅用于列表展示） */
  lastStatus?: number
  lastOk?: boolean
  lastDurationMs?: number
  lastSentAt?: number
  createdAt: number
  updatedAt: number
}

/** 请求列表里的文件夹，支持多级嵌套 */
export interface ApiFolder {
  id: string
  name: string
  /** 上级文件夹 id，null 表示项目根目录 */
  parentId: string | null
  /** 手动排序用的顺序值（越小越靠前） */
  order?: number
  createdAt: number
  updatedAt: number
}

/** 渲染进程提交给主进程的保存草稿（id 为空表示新建） */
export type ApiRequestDraft = Omit<ApiRequestRecord, 'createdAt' | 'updatedAt'> & {
  createdAt?: number
  updatedAt?: number
}

/** 一个项目下挂着自己的请求记录与文件夹 */
export interface ApiProject {
  id: string
  name: string
  requests: ApiRequestRecord[]
  folders: ApiFolder[]
  createdAt: number
  updatedAt: number
}

export interface ApiProjectsState {
  projects: ApiProject[]
  /** 数据文件完整路径，界面可展示并一键打开所在目录 */
  dataFile: string
}

export interface ApiRequestSaveResult {
  projects: ApiProject[]
  record: ApiRequestRecord
}

/** 一次发送的结果，用于回写请求记录 */
export interface ApiAttemptResult {
  status?: number
  ok: boolean
  durationMs: number
}

export interface ApiExportResult {
  canceled: boolean
  filePath?: string
  requests?: number
  error?: string
}

export interface ApiImportResult {
  canceled: boolean
  projects?: ApiProject[]
  importedProjects?: number
  importedRequests?: number
  error?: string
}

/* ------------------------------------------------------------------ */
/* 本地聊天                                                            */
/* ------------------------------------------------------------------ */

/** 好友状态：在线（在用本程序）/ 离线（端口通但不是本程序）/ 不可达 */
export type ChatPeerStatus = 'online' | 'offline' | 'unreachable'

/** 本机资料，修改后会广播给在线好友 */
export interface ChatProfile {
  /** 稳定身份标识，用于对方识别「同一个人」 */
  id: string
  nickname: string
  /** 头像：data URL（空字符串表示用昵称首字生成） */
  avatar: string
  /** 监听端口 */
  port: number
  /** 本机局域网 IP，只读，用于告诉好友该连哪个地址 */
  host: string
}

export interface ChatFriend {
  id: string
  /** 备注名，优先显示 */
  remark: string
  ip: string
  port: number
  nickname: string
  avatar: string
  status: ChatPeerStatus
  /** 最近一次探测到在线的时间 */
  lastSeenAt: number
  createdAt: number
  updatedAt: number
}

export type ChatMessageKind = 'text' | 'image' | 'file'

/** 好友申请方向：in = 别人添加我，out = 我添加别人 */
export type ChatRequestDirection = 'in' | 'out'

/** 好友申请状态；同意 / 拒绝都会记录在本次申请里 */
export type ChatRequestStatus = 'pending' | 'accepted' | 'rejected' | 'failed'

export interface ChatFriendRequest {
  id: string
  /** 对方的申请 id：响应时要用它回执，否则申请方对不上自己的记录 */
  remoteId: string
  direction: ChatRequestDirection
  /** 对方的稳定 id（用于匹配同一个人） */
  peerId: string
  nickname: string
  avatar: string
  ip: string
  port: number
  /** 备注：我加的备注，或对方申请时填的备注 */
  remark: string
  status: ChatRequestStatus
  createdAt: number
  respondedAt: number
  /** 失败原因等附加说明 */
  message: string
}

export interface ChatMessage {  id: string
  /** 所属好友 */
  friendId: string
  direction: 'in' | 'out'
  kind: ChatMessageKind
  /** 文字内容；图片 / 文件消息为说明文字（可为空） */
  text: string
  /** 原始文件名（图片 / 文件） */
  fileName: string
  /** 文件大小（图片 / 文件） */
  fileSize: number
  /** 已保存到本地的完整路径（图片 / 文件） */
  filePath: string
  /** 图片缩略 / 原图 data URL（仅图片消息，用于直接展示） */
  dataUrl: string
  createdAt: number
  /** 发送失败时的错误信息 */
  error?: string
}

export interface ChatState {
  me: ChatProfile
  friends: ChatFriend[]
  /** 好友申请记录（添加别人 / 别人添加我） */
  requests: ChatFriendRequest[]
  /** 聊天记录，按时间升序 */
  messages: ChatMessage[]
  dataFile: string
  /** 图片 / 文件的保存目录 */
  chatDir: string
  /** 服务是否正在监听 */
  listening: boolean
  /** 监听失败时的原因（端口被占用等） */
  portError: string
}

export interface ChatFriendInput {
  ip: string
  port: number
  remark: string
}

export interface ChatSendInput {
  friendId: string
  kind: ChatMessageKind
  text: string
  fileName?: string
  /** 图片 / 文件的 base64（不含 data URL 前缀） */
  base64?: string
}

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
  /** API 请求数据文件完整路径（多项目 + 请求记录） */
  apiDataFile: string
  /** 本地聊天数据文件完整路径 */
  chatDataFile: string
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
    /** 把 base64 内容按原始字节写入文件，用于导出二进制响应 */
    writeBinary(filePath: string, base64: string): Promise<WriteTextResult>
    /** 读取文件状态，用于判断文件是否被其它程序改动 */
    stat(filePath: string): Promise<FileStatResult>
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
  projects: {
    /** 读取全部项目；数据文件不存在时会自动创建默认项目 */
    load(): Promise<ApiProjectsState>
    create(name: string): Promise<ApiProject[]>
    rename(id: string, name: string): Promise<ApiProject[]>
    remove(id: string): Promise<ApiProject[]>
    /** 新建或更新一条请求记录（带 id 即更新） */
    saveRequest(projectId: string, draft: ApiRequestDraft): Promise<ApiRequestSaveResult>
    removeRequest(projectId: string, requestId: string): Promise<ApiProject[]>
    /** 新建文件夹（parentId 为空表示项目根目录） */
    createFolder(projectId: string, name: string, parentId: string | null): Promise<ApiProject[]>
    renameFolder(projectId: string, folderId: string, name: string): Promise<ApiProject[]>
    /** 删除文件夹，连同其子文件夹与其中的请求一起删除 */
    removeFolder(projectId: string, folderId: string): Promise<ApiProject[]>
    /** 把请求移动到指定文件夹（folderId 为空表示根目录） */
    moveRequest(projectId: string, requestId: string, folderId: string | null): Promise<ApiProject[]>
    /** 手动排序：按传入的 id 顺序重排同一层级下的请求 */
    reorderRequests(projectId: string, folderId: string | null, orderedIds: string[]): Promise<ApiProject[]>
    /** 手动排序：按传入的 id 顺序重排同一层级下的文件夹 */
    reorderFolders(projectId: string, parentId: string | null, orderedIds: string[]): Promise<ApiProject[]>
    /** 发送完成后把结果写回记录 */
    recordResult(projectId: string, requestId: string, result: ApiAttemptResult): Promise<ApiProject[]>
    /** 导出全部项目与请求到用户选择的文件，便于迁移到其他机器 */
    exportAll(): Promise<ApiExportResult>
    /** 从文件导入并与本地数据合并 */
    importFile(): Promise<ApiImportResult>
    /** 在文件管理器中定位数据文件 */
    reveal(): Promise<void>
  }
  chat: {
    /** 读取聊天状态（首次会生成随机昵称与头像） */
    state(): Promise<ChatState>
    /** 修改自己的资料（昵称 / 头像 / 端口），会广播给在线好友 */
    updateProfile(patch: Partial<Pick<ChatProfile, 'nickname' | 'avatar' | 'port'>>): Promise<ChatState>
    addFriend(input: ChatFriendInput): Promise<ChatState>
    /** 发送好友申请（对方同意后才会出现在好友列表） */
    sendFriendRequest(input: ChatFriendInput): Promise<ChatState>
    /** 处理别人发来的好友申请：同意 / 拒绝 */
    respondFriendRequest(id: string, accepted: boolean): Promise<ChatState>
    /** 删除一条申请记录 */
    dismissRequest(id: string): Promise<ChatState>
    /** 重新推送还没结果的申请（对方已处理过会直接回执结果） */
    resendRequests(): Promise<ChatState>
    updateFriend(id: string, patch: Partial<ChatFriendInput>): Promise<ChatState>
    removeFriend(id: string): Promise<ChatState>
    /** 重新探测一个好友的在线状态并同步其资料 */
    refreshFriend(id: string): Promise<ChatFriend | null>
    refreshAll(): Promise<ChatFriend[]>
    send(input: ChatSendInput): Promise<ChatMessage>
    /** 发送图片（dataUrl 由渲染进程压缩后传入） */
    sendImage(friendId: string, dataUrl: string, fileName: string): Promise<ChatMessage>
    /** 发送任意文件（按路径读取后发给对方） */
    sendFile(friendId: string, filePath: string): Promise<ChatMessage>
    clearHistory(friendId: string): Promise<ChatState>
    /** 读取图片消息的内容，返回 data URL 供界面直接展示 */
    readImage(filePath: string): Promise<string>
    chooseChatDir(): Promise<{ canceled: boolean; dirPath?: string }>
    /** 打开聊天文件保存目录 */
    openChatDir(): Promise<void>
    /** 用系统默认程序打开聊天里的文件 */
    openFile(filePath: string): Promise<void>
    /** 在文件管理器中定位聊天里的文件 */
    revealFile(filePath: string): Promise<void>
    onMessage(cb: (message: ChatMessage) => void): () => void
    onState(cb: (state: ChatState) => void): () => void
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
