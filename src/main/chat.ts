import { BrowserWindow, Notification } from 'electron'
import { promises as fsp } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createConnection } from 'node:net'
import { networkInterfaces } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import type {
  ChatFriend,
  ChatFriendInput,
  ChatFriendRequest,
  ChatMessage,
  ChatMessageKind,
  ChatPeerStatus,
  ChatProfile,
  ChatRequestStatus,
  ChatState
} from '@shared/types'
import { configDir } from './store'

/**
 * 本地聊天：局域网内的点对点聊天。
 *
 * - 主进程在指定端口起一个 HTTP 服务（`POST /chat/api`）接收消息与资料变更；
 * - 好友状态用「TCP 是否可连 + 接口是否是本程序」两步判断：
 *     TCP 连不上 → 不可达；能连上但接口不是本程序 → 离线；返回了本程序的标记 → 在线；
 * - 好友、消息、自己的资料、附件保存目录全部写进 `chat.json`，方便整体迁移。
 */

const STORE_VERSION = 1
const APP_MARKER = 'devtoolbox-chat'
/** 默认端口：挑一个少见、不与常见服务冲突的端口 */
export const DEFAULT_CHAT_PORT = 45871
const MAX_MESSAGES = 1000
const MAX_REQUESTS = 100
const MAX_TEXT_LENGTH = 20000
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_BODY_BYTES = 24 * 1024 * 1024

interface ChatStore {
  me: ChatProfile
  friends: ChatFriend[]
  /** 好友申请记录 */
  requests: ChatFriendRequest[]
  messages: ChatMessage[]
  /** 图片 / 文件的保存目录 */
  chatDir: string
}

interface PeerBrief {
  id: string
  nickname: string
  avatar: string
  port: number
}

interface IncomingAttachment {
  kind: ChatMessageKind
  text: string
  fileName: string
  fileSize: number
  base64: string
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

let writeChain: Promise<unknown> = Promise.resolve()
let writeSeq = 0

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = writeChain.then(task, task)
  writeChain = result.catch(() => undefined)
  return result
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function hashCode(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

/** 本机局域网 IPv4，用于告诉好友该连哪个地址 */
export function localAddress(): string {
  const nets = networkInterfaces()
  const candidates: string[] = []
  for (const list of Object.values(nets)) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) {
        candidates.push(item.address)
      }
    }
  }
  // 优先 192.168 / 10. / 172.16-31 这类内网地址
  const isPrivate = (address: string): boolean =>
    address.startsWith('192.168.') ||
    address.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  return candidates.find(isPrivate) ?? candidates[0] ?? '127.0.0.1'
}

/* ------------------------------------------------------------------ */
/* 默认昵称与头像                                                      */
/* ------------------------------------------------------------------ */

const NICK_ADJ = ['安静的', '灵动的', '热心的', '沉稳的', '快乐的', '认真的', '爱笑的', '靠谱的', '低调的', '好奇的']
const NICK_NOUN = ['海豚', '松鼠', '企鹅', '狐狸', '熊猫', '猫头鹰', '鲸鱼', '水獭', '刺猬', '考拉']

const AVATAR_PALETTE: [string, string][] = [
  ['#4f8cff', '#6f5bff'],
  ['#f97316', '#ef4444'],
  ['#22c55e', '#0ea5e9'],
  ['#a855f7', '#ec4899'],
  ['#eab308', '#f97316'],
  ['#14b8a6', '#3b82f6'],
  ['#f43f5e', '#f59e0b'],
  ['#6366f1', '#22d3ee']
]

function randomNickname(): string {
  const adjective = NICK_ADJ[Math.floor(Math.random() * NICK_ADJ.length)]
  const noun = NICK_NOUN[Math.floor(Math.random() * NICK_NOUN.length)]
  return `${adjective}${noun}`
}

/** 用字符串种子生成一个几何图形头像（SVG data URL），无需联网 */
export function generateAvatar(seed: string): string {
  const hash = hashCode(seed || 'seed')
  const [from, to] = AVATAR_PALETTE[hash % AVATAR_PALETTE.length]
  const bubbles: string[] = []
  for (let index = 0; index < 4; index += 1) {
    const h = hashCode(`${seed}-${index}`)
    const cx = 10 + (h % 44)
    const cy = 10 + ((h >> 3) % 44)
    const radius = 5 + ((h >> 6) % 11)
    const opacity = 0.16 + ((h >> 9) % 18) / 100
    bubbles.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#ffffff" opacity="${opacity.toFixed(2)}"/>`)
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>` +
    `</linearGradient></defs>` +
    `<rect width="64" height="64" fill="url(#g)"/>` +
    bubbles.join('') +
    `</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

let cache: ChatStore | null = null

export function chatDataFile(): string {
  return join(configDir(), 'chat.json')
}

function defaultChatDir(): string {
  return join(configDir(), 'chat-files')
}

function createDefaultStore(): ChatStore {
  const id = `u-${randomSuffix()}`
  const nickname = randomNickname()
  return {
    me: {
      id,
      nickname,
      avatar: generateAvatar(`${id}-${nickname}`),
      port: DEFAULT_CHAT_PORT,
      host: localAddress()
    },
    friends: [],
    requests: [],
    messages: [],
    chatDir: defaultChatDir()
  }
}

function normalizeRequest(value: unknown, now: number): ChatFriendRequest | null {
  if (!isObject(value)) return null
  const ip = str(value.ip).trim()
  if (!ip) return null
  const status: ChatRequestStatus =
    value.status === 'accepted' || value.status === 'rejected' || value.status === 'failed'
      ? value.status
      : 'pending'
  return {
    id: str(value.id) || `req-${randomSuffix()}`,
    remoteId: str(value.remoteId),
    direction: value.direction === 'out' ? 'out' : 'in',
    peerId: str(value.peerId),
    nickname: str(value.nickname).slice(0, 40),
    avatar: str(value.avatar),
    ip,
    port: clamp(Math.round(num(value.port, DEFAULT_CHAT_PORT)), 1, 65535),
    remark: str(value.remark).slice(0, 40),
    status,
    createdAt: num(value.createdAt, now),
    respondedAt: num(value.respondedAt, 0),
    message: str(value.message).slice(0, 120)
  }
}

function normalizeMessage(value: unknown, now: number): ChatMessage | null {
  if (!isObject(value)) return null
  const kind = value.kind === 'image' || value.kind === 'file' ? value.kind : 'text'
  const friendId = str(value.friendId)
  if (!friendId) return null
  return {
    id: str(value.id) || `m-${randomSuffix()}`,
    friendId,
    direction: value.direction === 'out' ? 'out' : 'in',
    kind,
    text: str(value.text).slice(0, MAX_TEXT_LENGTH),
    fileName: str(value.fileName),
    fileSize: num(value.fileSize, 0),
    filePath: str(value.filePath),
    dataUrl: '',
    createdAt: num(value.createdAt, now),
    error: str(value.error) || undefined
  }
}

function normalizeFriend(value: unknown, now: number): ChatFriend | null {
  if (!isObject(value)) return null
  const ip = str(value.ip).trim()
  if (!ip) return null
  const port = clamp(Math.round(num(value.port, DEFAULT_CHAT_PORT)), 1, 65535)
  const nickname = str(value.nickname).slice(0, 40)
  let remark = str(value.remark).slice(0, 40)
  // 旧版本在没填备注时会把 IP 当作备注存下来；已知对方昵称时清掉，界面就能显示昵称
  if (nickname && (remark === ip || remark === `${ip}:${port}`)) remark = ''
  const status = value.status === 'online' || value.status === 'unreachable' ? value.status : 'offline'
  return {
    id: str(value.id) || `f-${randomSuffix()}`,
    remark,
    ip,
    port,
    nickname,
    avatar: str(value.avatar),
    status,
    lastSeenAt: num(value.lastSeenAt, 0),
    createdAt: num(value.createdAt, now),
    updatedAt: num(value.updatedAt, now)
  }
}

function normalizeStore(raw: unknown): ChatStore {
  const base = createDefaultStore()
  if (!isObject(raw)) return base
  const now = Date.now()

  const meRaw = isObject(raw.me) ? raw.me : {}
  const me: ChatProfile = {
    id: str(meRaw.id) || base.me.id,
    nickname: str(meRaw.nickname).slice(0, 40) || base.me.nickname,
    avatar: str(meRaw.avatar) || base.me.avatar,
    port: clamp(Math.round(num(meRaw.port, base.me.port)), 1, 65535),
    host: localAddress()
  }

  const friends = Array.isArray(raw.friends)
    ? raw.friends
        .map((item) => normalizeFriend(item, now))
        .filter((item): item is ChatFriend => item !== null)
    : []
  // 好友按 ip:port 去重
  const seen = new Set<string>()
  const uniqueFriends = friends.filter((item) => {
    const key = `${item.ip}:${item.port}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .map((item) => normalizeMessage(item, now))
        .filter((item): item is ChatMessage => item !== null)
    : []

  const requests = Array.isArray(raw.requests)
    ? raw.requests
        .map((item) => normalizeRequest(item, now))
        .filter((item): item is ChatFriendRequest => item !== null)
        .slice(-MAX_REQUESTS)
    : []

  return {
    me,
    friends: uniqueFriends.slice(0, 200),
    requests,
    messages: messages.slice(-MAX_MESSAGES),
    chatDir: str(raw.chatDir) || base.chatDir
  }
}

async function readJsonIfExists(file: string): Promise<unknown> {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.error('[chat] 读取数据文件失败', error)
    return null
  }
}

async function persist(): Promise<void> {
  if (!cache) return
  const snapshot = {
    version: STORE_VERSION,
    updatedAt: Date.now(),
    me: cache.me,
    friends: cache.friends,
    requests: cache.requests,
    messages: cache.messages,
    chatDir: cache.chatDir
  }
  const target = chatDataFile()
  await enqueueWrite(async () => {
    await fsp.mkdir(dirname(target), { recursive: true })
    writeSeq += 1
    const tmp = `${target}.${process.pid}.${writeSeq}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
    await fsp.rename(tmp, target)
  })
}

async function loadStore(): Promise<ChatStore> {
  if (cache) {
    cache.me.host = localAddress()
    return cache
  }
  const raw = await readJsonIfExists(chatDataFile())
  const existed = raw !== null
  cache = normalizeStore(raw)
  if (!existed) await persist()
  return cache
}

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

let server: Server | null = null
let listening = false
let portError = ''
let currentPort = 0

export function chatStateSync(): ChatState {
  const store = cache ?? createDefaultStore()
  return {
    me: { ...store.me, host: localAddress() },
    friends: store.friends.map((item) => ({ ...item })),
    requests: store.requests.map((item) => ({ ...item })),
    messages: store.messages.map((item) => ({ ...item })),
    dataFile: chatDataFile(),
    chatDir: store.chatDir,
    listening,
    portError
  }
}

export async function chatState(): Promise<ChatState> {
  await loadStore()
  return chatStateSync()
}

function broadcastState(): void {
  const state = chatStateSync()
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('chat:state', state)
  }
}

function broadcastMessage(message: ChatMessage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('chat:message', message)
  }
}

/* ------------------------------------------------------------------ */
/* HTTP 服务端                                                         */
/* ------------------------------------------------------------------ */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function normalizeRemoteIp(value: string | undefined): string {
  if (!value) return ''
  return value.startsWith('::ffff:') ? value.slice(7) : value
}

function peerBrief(me: ChatProfile): PeerBrief {
  return { id: me.id, nickname: me.nickname, avatar: me.avatar, port: me.port }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!req.url || !req.url.startsWith('/chat/api')) {
    sendJson(res, 404, { ok: false, error: 'not found' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }

  let body: Record<string, unknown>
  try {
    const raw = await readBody(req)
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed)) throw new Error('bad body')
    body = parsed
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad request' })
    return
  }

  const store = await loadStore()
  const remoteIp = normalizeRemoteIp(req.socket.remoteAddress)
  const fromRaw = isObject(body.from) ? body.from : {}
  const from: PeerBrief = {
    id: str(fromRaw.id),
    nickname: str(fromRaw.nickname).slice(0, 40),
    avatar: str(fromRaw.avatar),
    port: clamp(Math.round(num(fromRaw.port, 0)), 0, 65535)
  }

  switch (str(body.action)) {
    case 'ping':
      sendJson(res, 200, { ok: true, app: APP_MARKER, profile: peerBrief(store.me) })
      return
    case 'profile':
      if (from.id) await applyPeerProfile(from, remoteIp)
      sendJson(res, 200, { ok: true })
      return
    case 'deliver': {
      if (!isObject(body.payload)) {
        sendJson(res, 400, { ok: false, error: 'bad payload' })
        return
      }
      await receiveMessage(from, remoteIp, body.payload)
      sendJson(res, 200, { ok: true })
      return
    }
    case 'friend-request': {
      if (!isObject(body.payload)) {
        sendJson(res, 400, { ok: false, error: 'bad payload' })
        return
      }
      await receiveFriendRequest(from, remoteIp, body.payload)
      sendJson(res, 200, { ok: true })
      return
    }
    case 'friend-request-result': {
      if (!isObject(body.payload)) {
        sendJson(res, 400, { ok: false, error: 'bad payload' })
        return
      }
      await applyFriendRequestResult(from, remoteIp, body.payload)
      sendJson(res, 200, { ok: true })
      return
    }
    default:
      sendJson(res, 400, { ok: false, error: 'unknown action' })
  }
}

export async function startChatServer(port: number): Promise<void> {
  const store = await loadStore()
  const target = clamp(Math.round(port || DEFAULT_CHAT_PORT), 1, 65535)

  if (server && listening && currentPort === target) return
  await stopChatServer()

  portError = ''
  const instance = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      console.error('[chat] 处理请求失败', error)
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' })
    })
  })

  await new Promise<void>((resolve) => {
    instance.once('error', (error: NodeJS.ErrnoException) => {
      portError =
        error.code === 'EADDRINUSE'
          ? `端口 ${target} 已被其它程序占用，请在设置里换一个端口`
          : error.code === 'EACCES'
            ? `没有权限监听端口 ${target}，请换一个大于 1024 的端口`
            : error.message
      listening = false
      server = null
      currentPort = target
      console.error('[chat] 启动聊天服务失败', error)
      resolve()
    })
    instance.listen(target, '0.0.0.0', () => {
      server = instance
      listening = true
      currentPort = target
      portError = ''
      console.info(`[chat] 聊天服务已启动，端口 ${target}`)
      resolve()
    })
  })

  store.me.port = target
  store.me.host = localAddress()
  await persist()
  broadcastState()
}

export async function stopChatServer(): Promise<void> {
  const instance = server
  server = null
  listening = false
  if (!instance) return
  await new Promise<void>((resolve) => instance.close(() => resolve()))
}

/* ------------------------------------------------------------------ */
/* 客户端：探测 / 发送                                                 */
/* ------------------------------------------------------------------ */

function tcpReachable(ip: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: ip, port })
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

function postJson(
  ip: string,
  port: number,
  body: unknown,
  timeoutMs = 8000
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    const req = httpRequest(
      {
        host: ip,
        port,
        path: '/chat/api',
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': payload.length,
          'X-Chat-App': APP_MARKER
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            const json = JSON.parse(text) as unknown
            resolve({ status: res.statusCode ?? 0, json: isObject(json) ? json : null })
          } catch {
            resolve({ status: res.statusCode ?? 0, json: null })
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(payload)
  })
}

/** 探测某个地址：先看端口通不通，再看对面是不是本程序 */
async function probePeer(
  ip: string,
  port: number
): Promise<{ status: ChatPeerStatus; profile: PeerBrief | null }> {
  const reachable = await tcpReachable(ip, port)
  if (!reachable) return { status: 'unreachable', profile: null }

  try {
    const store = await loadStore()
    const res = await postJson(ip, port, { action: 'ping', from: peerBrief(store.me) }, 2000)
    if (res.json && res.json.app === APP_MARKER && isObject(res.json.profile)) {
      const profile = res.json.profile
      return {
        status: 'online',
        profile: {
          id: str(profile.id),
          nickname: str(profile.nickname).slice(0, 40),
          avatar: str(profile.avatar),
          port: clamp(Math.round(num(profile.port, port)), 1, 65535)
        }
      }
    }
    // 端口通、但不是本程序 → 离线
    return { status: 'offline', profile: null }
  } catch {
    return { status: 'offline', profile: null }
  }
}

/**
 * 找出这条请求对应的好友：
 * 先按对方上报的稳定 id 匹配，再按「来源 IP + 端口」匹配，
 * 最后兜底到「来源 IP 只对应一个好友」的情况（这样对方换了端口也能对上）。
 */
function matchFriend(store: ChatStore, from: PeerBrief, remoteIp: string): ChatFriend | null {
  if (from.id) {
    const byId = store.friends.find((item) => item.id === from.id)
    if (byId) return byId
  }
  if (!remoteIp) return null
  const byPort = store.friends.find((item) => item.ip === remoteIp && (!from.port || item.port === from.port))
  if (byPort) return byPort
  const sameIp = store.friends.filter((item) => item.ip === remoteIp)
  return sameIp.length === 1 ? sameIp[0] : null
}

async function refreshFriendRecord(friend: ChatFriend): Promise<ChatFriend> {
  const result = await probePeer(friend.ip, friend.port)
  friend.status = result.status
  friend.updatedAt = Date.now()
  if (result.status === 'online') {
    friend.lastSeenAt = Date.now()
    if (result.profile) {
      if (result.profile.nickname) friend.nickname = result.profile.nickname
      if (result.profile.avatar) friend.avatar = result.profile.avatar
      // 对方换了端口时，确认新端口真的能连上再更新
      if (result.profile.port && result.profile.port !== friend.port) {
        const reachable = await tcpReachable(friend.ip, result.profile.port)
        if (reachable) friend.port = result.profile.port
      }
    }
  }
  await persist()
  return friend
}

export async function refreshFriend(id: string): Promise<ChatFriend | null> {
  const store = await loadStore()
  const friend = store.friends.find((item) => item.id === id)
  if (!friend) return null
  const next = await refreshFriendRecord(friend)
  broadcastState()
  return { ...next }
}

export async function refreshAllFriends(): Promise<ChatFriend[]> {
  const store = await loadStore()
  await Promise.all(store.friends.map((friend) => refreshFriendRecord(friend)))
  broadcastState()
  return store.friends.map((item) => ({ ...item }))
}

/* ------------------------------------------------------------------ */
/* 好友维护                                                            */
/* ------------------------------------------------------------------ */

function normalizeIp(value: string): string {
  return value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
}

export async function addFriend(input: ChatFriendInput): Promise<ChatState> {
  const store = await loadStore()
  const ip = normalizeIp(str(input?.ip))
  const port = clamp(Math.round(num(input?.port, DEFAULT_CHAT_PORT)), 1, 65535)
  if (!ip) throw new Error('好友 IP 不能为空')
  if (!/^[0-9a-zA-Z.:-]+$/.test(ip)) throw new Error('好友 IP 格式不正确')
  if (store.friends.some((item) => item.ip === ip && item.port === port)) {
    throw new Error(`已经添加过 ${ip}:${port} 了`)
  }
  if (store.friends.length >= 200) throw new Error('好友数量已达上限')

  const now = Date.now()
  const friend: ChatFriend = {
    id: `f-${randomSuffix()}`,
    // 备注留空时不要拿 IP 顶上：界面会退回显示对方的昵称
    remark: str(input?.remark).trim().slice(0, 40),
    ip,
    port,
    nickname: '',
    avatar: '',
    status: 'offline',
    lastSeenAt: 0,
    createdAt: now,
    updatedAt: now
  }
  store.friends.push(friend)
  await persist()
  await refreshFriendRecord(friend)
  broadcastState()
  return chatStateSync()
}

/* ---------------------------- 好友申请 ---------------------------- */

interface PeerInfo {
  peerId: string
  nickname: string
  avatar: string
  ip: string
  port: number
  remark: string
}

/**
 * 把申请通过的好友落到好友列表。
 * 重新添加同一个对端时按新好友处理：清掉它之前的聊天记录，从空白会话开始。
 */
function createFriendFromPeer(store: ChatStore, peer: PeerInfo): ChatFriend {
  const now = Date.now()
  const existing = store.friends.find(
    (item) => (peer.peerId && item.id === peer.peerId) || (item.ip === peer.ip && item.port === peer.port)
  )

  // 重新添加：把这个对端已有的聊天记录清掉（旧好友 id 与对方稳定 id 都算）
  const doomed = new Set<string>([peer.peerId])
  if (existing) doomed.add(existing.id)
  store.messages = store.messages.filter((item) => !doomed.has(item.friendId))
  if (existing) store.friends = store.friends.filter((item) => item.id !== existing.id)

  const friend: ChatFriend = {
    id: peer.peerId || `f-${randomSuffix()}`,
    remark: peer.remark,
    ip: peer.ip,
    port: peer.port,
    nickname: peer.nickname,
    avatar: peer.avatar,
    status: 'online',
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now
  }
  store.friends.push(friend)
  return friend
}

function pruneRequests(store: ChatStore): void {
  if (store.requests.length > MAX_REQUESTS) {
    store.requests = store.requests.slice(-MAX_REQUESTS)
  }
}

/**
 * 发起好友申请。对方必须在线（能收到申请），同意后才会出现在自己的好友列表里。
 */
export async function sendFriendRequest(input: ChatFriendInput): Promise<ChatState> {
  const store = await loadStore()
  const ip = normalizeIp(str(input?.ip))
  const port = clamp(Math.round(num(input?.port, DEFAULT_CHAT_PORT)), 1, 65535)
  if (!ip) throw new Error('好友 IP 不能为空')
  if (!/^[0-9a-zA-Z.:-]+$/.test(ip)) throw new Error('好友 IP 格式不正确')
  if (ip === localAddress() && port === store.me.port) throw new Error('不能添加自己为好友')
  if (store.friends.some((item) => item.ip === ip && item.port === port)) {
    throw new Error(`${ip}:${port} 已经是你的好友了`)
  }
  if (
    store.requests.some(
      (item) => item.direction === 'out' && item.status === 'pending' && item.ip === ip && item.port === port
    )
  ) {
    throw new Error('已经发过申请了，等对方同意即可')
  }

  const probe = await probePeer(ip, port)
  if (probe.status !== 'online' || !probe.profile) {
    throw new Error('对方当前不在线（或端口不通），无法发送好友申请')
  }

  const now = Date.now()
  const request: ChatFriendRequest = {
    id: `req-${randomSuffix()}`,
    remoteId: '',
    direction: 'out',
    peerId: probe.profile.id,
    nickname: probe.profile.nickname,
    avatar: probe.profile.avatar,
    ip,
    port,
    remark: str(input?.remark).trim().slice(0, 40),
    status: 'pending',
    createdAt: now,
    respondedAt: 0,
    message: ''
  }
  store.requests.push(request)
  pruneRequests(store)
  await persist()
  broadcastState()

  try {
    await postJson(
      ip,
      port,
      {
        action: 'friend-request',
        from: peerBrief(store.me),
        payload: {
          requestId: request.id,
          remark: request.remark
        }
      },
      8000
    )
  } catch (error) {
    request.status = 'failed'
    request.message = `申请没有送达：${(error as Error).message}`
    await persist()
    broadcastState()
    throw new Error(request.message)
  }

  broadcastState()
  return chatStateSync()
}

/** 收到别人发来的好友申请：先记下来，由用户决定同意 / 拒绝 */
async function receiveFriendRequest(
  from: PeerBrief,
  remoteIp: string,
  payload: Record<string, unknown>
): Promise<void> {
  const store = await loadStore()
  const ip = remoteIp || localAddress()
  const port = clamp(Math.round(num(payload.port ?? from.port, DEFAULT_CHAT_PORT)), 1, 65535)
  const remark = str(payload.remark).slice(0, 40)
  /** 对方的申请 id —— 回执时必须原样带上，对方才能对上自己的记录 */
  const remoteId = str(payload.requestId)
  const now = Date.now()

  // 已经是好友时直接回执「已同意」，省得对方一直等
  const already = store.friends.find(
    (item) => (from.id && item.id === from.id) || (item.ip === ip && item.port === port)
  )
  if (already) {
    if (remoteId) await replyFriendRequest(already.ip, already.port, remoteId, true)
    return
  }

  // 之前已经处理过「同一条申请」：把结果再回执一次（对方上次可能没收到）。
  // 注意只认同一条申请（remoteId 相同），否则对方被拒之后重新申请就不会产生新记录了。
  const decided = remoteId
    ? store.requests.find((item) => item.direction === 'in' && item.remoteId && item.remoteId === remoteId)
    : null
  if (decided && decided.status !== 'pending' && now - decided.respondedAt < 24 * 60 * 60 * 1000) {
    void replyFriendRequest(decided.ip, decided.port, remoteId, decided.status === 'accepted')
    return
  }

  const existing = store.requests.find(
    (item) =>
      item.direction === 'in' &&
      item.status === 'pending' &&
      ((from.id && item.peerId === from.id) || (item.ip === ip && item.port === port))
  )
  let created = false
  if (existing) {
    existing.createdAt = now
    existing.nickname = from.nickname || existing.nickname
    existing.avatar = from.avatar || existing.avatar
    existing.remark = remark || existing.remark
    existing.remoteId = remoteId || existing.remoteId
  } else {
    store.requests.push({
      id: `req-${randomSuffix()}`,
      remoteId,
      direction: 'in',
      peerId: from.id,
      nickname: from.nickname,
      avatar: from.avatar,
      ip,
      port: from.port || port,
      remark,
      status: 'pending',
      createdAt: now,
      respondedAt: 0,
      message: ''
    })
    pruneRequests(store)
    created = true
  }

  await persist()
  broadcastState()
  // 重复推送（对方在等结果时的补发）不再重复弹通知
  if (created) notifyFriendRequest(from)
}

/** 别人添加我：同意 / 拒绝 */
export async function respondFriendRequest(id: string, accepted: boolean): Promise<ChatState> {
  const store = await loadStore()
  const request = store.requests.find((item) => item.id === id && item.direction === 'in')
  if (!request) throw new Error('申请不存在或已被删除')
  if (request.status !== 'pending') throw new Error('这条申请已经处理过了')

  request.status = accepted ? 'accepted' : 'rejected'
  request.respondedAt = Date.now()
  request.message = accepted ? '已同意' : '已拒绝'

  if (accepted) {
    createFriendFromPeer(store, {
      peerId: request.peerId,
      nickname: request.nickname,
      avatar: request.avatar,
      ip: request.ip,
      port: request.port,
      remark: request.remark
    })
  }

  await persist()
  // 先刷新界面，再把结果回执给对方（对方离线时回执可能很慢，不能挡住界面）
  broadcastState()
  // 用对方那条申请的 id 回执，对方才能对上自己的记录
  void replyFriendRequest(request.ip, request.port, request.remoteId, accepted)
  return chatStateSync()
}

/** 把同意 / 拒绝的结果发回给申请方 */
async function replyFriendRequest(
  ip: string,
  port: number,
  requestId: string,
  accepted: boolean
): Promise<void> {
  const store = await loadStore()
  if (!requestId) return
  try {
    await postJson(
      ip,
      port,
      {
        action: 'friend-request-result',
        from: peerBrief(store.me),
        payload: { requestId, accepted }
      },
      5000
    )
  } catch (error) {
    console.error('[chat] 回执好友申请失败', error)
  }
}

/** 收到别人对我申请的处理结果 */
async function applyFriendRequestResult(
  from: PeerBrief,
  remoteIp: string,
  payload: Record<string, unknown>
): Promise<void> {
  const store = await loadStore()
  const requestId = str(payload.requestId)
  const accepted = Boolean(payload.accepted)
  const request = store.requests.find((item) => item.id === requestId && item.direction === 'out')

  // 已经处理过这条申请：忽略重复回执
  if (request && request.status !== 'pending') return

  const peer: PeerInfo = {
    peerId: from.id || request?.peerId || '',
    nickname: from.nickname || request?.nickname || '',
    avatar: from.avatar || request?.avatar || '',
    ip: remoteIp || request?.ip || '',
    port: clamp(Math.round(num(from.port || request?.port, DEFAULT_CHAT_PORT)), 1, 65535),
    remark: request?.remark || ''
  }
  if (!peer.ip) return

  if (request) {
    request.status = accepted ? 'accepted' : 'rejected'
    request.respondedAt = Date.now()
    request.message = accepted ? '对方已同意' : '对方已拒绝'
  } else if (accepted) {
    // 本地已经没有这条申请（例如记录被清理过）：对方说同意了，照样把好友加回来
    store.requests.push({
      id: requestId || `req-${randomSuffix()}`,
      remoteId: '',
      direction: 'out',
      peerId: peer.peerId,
      nickname: peer.nickname,
      avatar: peer.avatar,
      ip: peer.ip,
      port: peer.port,
      remark: '',
      status: 'accepted',
      createdAt: Date.now(),
      respondedAt: Date.now(),
      message: '对方已同意'
    })
    pruneRequests(store)
  } else {
    return
  }

  if (accepted) {
    createFriendFromPeer(store, peer)
  }

  await persist()
  broadcastState()
}

/**
 * 重新推送还没有结果的申请。
 * 对方已经处理过的话，会直接把同意 / 拒绝的结果回执回来，
 * 用来兜住「对方点了同意但回执丢了」的情况。
 */
export async function resendPendingRequests(): Promise<ChatState> {
  const store = await loadStore()
  const pending = store.requests.filter((item) => item.direction === 'out' && item.status === 'pending')
  if (!pending.length) return chatStateSync()

  await Promise.all(
    pending.map(async (request) => {
      try {
        await postJson(
          request.ip,
          request.port,
          {
            action: 'friend-request',
            from: peerBrief(store.me),
            payload: {
              requestId: request.id,
              remark: request.remark
            }
          },
          4000
        )
      } catch {
        // 对方不在线就算了，下次打开「新好友」再试
      }
    })
  )
  return chatStateSync()
}

export async function updateFriend(id: string, patch: Partial<ChatFriendInput>): Promise<ChatState> {
  const store = await loadStore()
  const friend = store.friends.find((item) => item.id === id)
  if (!friend) throw new Error('好友不存在')

  // 备注可以清空，清空后界面展示对方昵称
  if (patch.remark !== undefined) friend.remark = str(patch.remark).trim().slice(0, 40)
  if (patch.ip !== undefined) {
    const ip = normalizeIp(str(patch.ip))
    if (!ip) throw new Error('好友 IP 不能为空')
    friend.ip = ip
  }
  if (patch.port !== undefined) friend.port = clamp(Math.round(num(patch.port, friend.port)), 1, 65535)
  friend.status = 'offline'
  friend.updatedAt = Date.now()
  await persist()
  await refreshFriendRecord(friend)
  broadcastState()
  return chatStateSync()
}

export async function removeFriend(id: string): Promise<ChatState> {
  const store = await loadStore()
  store.friends = store.friends.filter((item) => item.id !== id)
  // 聊天记录先留着（数据文件里仍可追溯）；重新加为好友时会按新好友处理，从空白记录开始
  await persist()
  broadcastState()
  return chatStateSync()
}

/** 删除一条好友申请记录（只是清列表，不影响好友关系） */
export async function dismissRequest(id: string): Promise<ChatState> {
  const store = await loadStore()
  store.requests = store.requests.filter((item) => item.id !== id)
  await persist()
  broadcastState()
  return chatStateSync()
}

/* ------------------------------------------------------------------ */
/* 资料                                                                */
/* ------------------------------------------------------------------ */

export async function updateProfile(
  patch: Partial<Pick<ChatProfile, 'nickname' | 'avatar' | 'port'>>
): Promise<ChatState> {
  const store = await loadStore()
  const oldPort = store.me.port
  if (patch.nickname !== undefined) {
    const nickname = str(patch.nickname).trim().slice(0, 40)
    if (!nickname) throw new Error('昵称不能为空')
    store.me.nickname = nickname
  }
  if (patch.avatar !== undefined) store.me.avatar = str(patch.avatar)
  if (patch.port !== undefined) store.me.port = clamp(Math.round(num(patch.port, oldPort)), 1, 65535)

  await persist()

  if (store.me.port !== oldPort) {
    await startChatServer(store.me.port)
  }
  await broadcastProfile()
  broadcastState()
  return chatStateSync()
}

/** 让好友重新读一遍我们的资料（离线好友会在下次上线时主动来 ping） */
async function broadcastProfile(): Promise<void> {
  const store = await loadStore()
  const payload = {
    action: 'profile',
    from: peerBrief(store.me),
    payload: { nickname: store.me.nickname, avatar: store.me.avatar, port: store.me.port }
  }
  await Promise.all(
    store.friends
      .filter((friend) => friend.status === 'online')
      .map(async (friend) => {
        try {
          await postJson(friend.ip, friend.port, payload, 4000)
        } catch {
          // 对方刚好下线，忽略
        }
      })
  )
}

/**
 * 收到好友的资料变更广播。地址用连接的来源 IP，避免对端伪造。
 */
async function applyPeerProfile(from: PeerBrief, remoteIp: string): Promise<void> {
  const store = await loadStore()
  const friend = matchFriend(store, from, remoteIp)
  if (!friend) return

  if (from.nickname) friend.nickname = from.nickname
  if (from.avatar) friend.avatar = from.avatar
  if (remoteIp) friend.ip = remoteIp
  if (from.port > 0) friend.port = from.port
  friend.status = 'online'
  friend.lastSeenAt = Date.now()
  friend.updatedAt = Date.now()
  await persist()
  broadcastState()
}

/* ------------------------------------------------------------------ */
/* 附件                                                                */
/* ------------------------------------------------------------------ */

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']

function safeFileName(name: string, fallback: string): string {
  const base = basename(name || fallback).replace(/[\\/:*?"<>|]/g, '_')
  return base.slice(0, 80) || fallback
}

function uniqueFileName(dir: string, name: string): string {
  const ext = extname(name)
  const stem = basename(name, ext) || 'file'
  return join(dir, `${stem}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}${ext}`)
}

async function saveAttachment(base64: string, fileName: string): Promise<{ filePath: string; fileSize: number }> {
  const store = await loadStore()
  await fsp.mkdir(store.chatDir, { recursive: true })
  const buffer = Buffer.from(base64, 'base64')
  const target = uniqueFileName(store.chatDir, safeFileName(fileName, 'file'))
  await fsp.writeFile(target, buffer)
  return { filePath: target, fileSize: buffer.length }
}

/** 把本地文件复制一份到聊天目录，返回副本路径 */
async function copyFileToChatDir(sourcePath: string): Promise<{ filePath: string; fileSize: number }> {
  const store = await loadStore()
  const stat = await fsp.stat(sourcePath)
  if (stat.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB，无法发送`)
  const buffer = await fsp.readFile(sourcePath)
  await fsp.mkdir(store.chatDir, { recursive: true })
  const target = uniqueFileName(store.chatDir, safeFileName(basename(sourcePath), 'file'))
  await fsp.writeFile(target, buffer)
  return { filePath: target, fileSize: buffer.length }
}

/** 图片消息展示用：按需读取成 data URL */
const imageCache = new Map<string, string>()

export async function readImageDataUrl(filePath: string): Promise<string> {
  const cached = imageCache.get(filePath)
  if (cached) return cached
  const ext = extname(filePath).toLowerCase()
  if (!IMAGE_EXTENSIONS.includes(ext)) return ''
  try {
    const buffer = await fsp.readFile(filePath)
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.svg'
              ? 'image/svg+xml'
              : ext === '.bmp'
                ? 'image/bmp'
                : 'image/jpeg'
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
    if (imageCache.size > 60) imageCache.clear()
    imageCache.set(filePath, dataUrl)
    return dataUrl
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

function trimMessages(store: ChatStore): void {
  if (store.messages.length > MAX_MESSAGES) {
    store.messages.splice(0, store.messages.length - MAX_MESSAGES)
  }
}

function appendMessage(store: ChatStore, message: ChatMessage): void {
  store.messages.push(message)
  trimMessages(store)
}

function notifyIncoming(message: ChatMessage, friend: ChatFriend): void {
  if (!Notification.isSupported()) return
  const wins = BrowserWindow.getAllWindows()
  if (wins.some((win) => !win.isDestroyed() && win.isFocused())) return
  const title = friend.remark || friend.nickname || friend.ip
  const body =
    message.kind === 'text'
      ? message.text.slice(0, 120)
      : `[${message.kind === 'image' ? '图片' : '文件'}] ${message.fileName}`
  try {
    new Notification({ title, body }).show()
  } catch (error) {
    console.error('[chat] 发送系统通知失败', error)
  }
}

/** 有人加你为好友时弹个系统通知 */
function notifyFriendRequest(from: PeerBrief): void {
  if (!Notification.isSupported()) return
  try {
    new Notification({
      title: '新的好友申请',
      body: `${from.nickname || from.id || '有人'} 想加你为好友，打开「新好友」处理`
    }).show()
  } catch (error) {
    console.error('[chat] 发送好友申请通知失败', error)
  }
}

async function receiveMessage(from: PeerBrief, remoteIp: string, payload: Record<string, unknown>): Promise<void> {
  const store = await loadStore()
  let friend = matchFriend(store, from, remoteIp)
  const now = Date.now()

  // 陌生人发来的消息也保留下来，自动加为好友
  if (!friend) {
    friend = {
      id: from.id || `f-${randomSuffix()}`,
      remark: from.nickname || remoteIp || '新好友',
      ip: remoteIp || '0.0.0.0',
      port: from.port || DEFAULT_CHAT_PORT,
      nickname: from.nickname,
      avatar: from.avatar,
      status: 'online',
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now
    }
    store.friends.push(friend)
  }

  friend.status = 'online'
  friend.lastSeenAt = now
  friend.updatedAt = now
  if (from.nickname) friend.nickname = from.nickname
  if (from.avatar) friend.avatar = from.avatar

  const kind: ChatMessageKind = payload.kind === 'image' || payload.kind === 'file' ? payload.kind : 'text'
  const incoming = payload as unknown as IncomingAttachment
  let filePath = ''
  let fileSize = num(payload.fileSize, 0)
  let fileName = str(payload.fileName)

  if (kind !== 'text' && typeof incoming.base64 === 'string' && incoming.base64) {
    try {
      const saved = await saveAttachment(incoming.base64, fileName || (kind === 'image' ? 'image.png' : 'file'))
      filePath = saved.filePath
      fileSize = saved.fileSize
      fileName = basename(saved.filePath)
    } catch (error) {
      console.error('[chat] 保存附件失败', error)
    }
  }

  const message: ChatMessage = {
    id: str(payload.id) || `m-${randomSuffix()}`,
    friendId: friend.id,
    direction: 'in',
    kind,
    text: str(payload.text).slice(0, MAX_TEXT_LENGTH),
    fileName,
    fileSize,
    filePath,
    dataUrl: '',
    createdAt: now
  }

  appendMessage(store, message)
  await persist()
  broadcastMessage(message)
  broadcastState()
  notifyIncoming(message, friend)
}

async function deliverToFriend(friend: ChatFriend, payload: Record<string, unknown>): Promise<string> {
  const store = await loadStore()
  try {
    const res = await postJson(
      friend.ip,
      friend.port,
      { action: 'deliver', from: peerBrief(store.me), payload },
      12000
    )
    if (res.status >= 400) return `对方返回 ${res.status}`
    return ''
  } catch (error) {
    return (error as Error).message
  }
}

export interface SendTextInput {
  friendId: string
  kind: ChatMessageKind
  text: string
}

export async function sendText(input: SendTextInput): Promise<ChatMessage> {
  const store = await loadStore()
  const friend = store.friends.find((item) => item.id === input.friendId)
  if (!friend) throw new Error('好友不存在')

  const text = str(input.text).slice(0, MAX_TEXT_LENGTH)
  if (!text.trim()) throw new Error('消息内容不能为空')

  const message: ChatMessage = {
    id: `m-${randomSuffix()}`,
    friendId: friend.id,
    direction: 'out',
    kind: input.kind === 'image' || input.kind === 'file' ? input.kind : 'text',
    text,
    fileName: '',
    fileSize: 0,
    filePath: '',
    dataUrl: '',
    createdAt: Date.now()
  }
  appendMessage(store, message)
  await persist()
  broadcastMessage(message)

  const error = await deliverToFriend(friend, {
    id: message.id,
    kind: message.kind,
    text: message.text
  })
  if (error) {
    message.error = error
    await persist()
    broadcastState()
  }
  return { ...message }
}

export async function sendImage(friendId: string, dataUrl: string, fileName: string): Promise<ChatMessage> {
  const store = await loadStore()
  const friend = store.friends.find((item) => item.id === friendId)
  if (!friend) throw new Error('好友不存在')

  const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl)
  if (!match) throw new Error('图片数据格式不正确')
  const base64 = match[2]
  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > MAX_FILE_BYTES) throw new Error('图片过大，无法发送')

  const saved = await saveAttachment(base64, fileName || 'image.png')
  const message: ChatMessage = {
    id: `m-${randomSuffix()}`,
    friendId: friend.id,
    direction: 'out',
    kind: 'image',
    text: '',
    fileName: basename(saved.filePath),
    fileSize: saved.fileSize,
    filePath: saved.filePath,
    dataUrl: '',
    createdAt: Date.now()
  }
  appendMessage(store, message)
  await persist()
  broadcastMessage(message)

  const error = await deliverToFriend(friend, {
    id: message.id,
    kind: 'image',
    text: '',
    fileName: message.fileName,
    fileSize: message.fileSize,
    base64
  })
  if (error) {
    message.error = error
    await persist()
    broadcastState()
  }
  return { ...message }
}

export async function sendFile(friendId: string, sourcePath: string): Promise<ChatMessage> {
  const store = await loadStore()
  const friend = store.friends.find((item) => item.id === friendId)
  if (!friend) throw new Error('好友不存在')

  const copied = await copyFileToChatDir(sourcePath)
  const buffer = await fsp.readFile(copied.filePath)

  const message: ChatMessage = {
    id: `m-${randomSuffix()}`,
    friendId: friend.id,
    direction: 'out',
    kind: 'file',
    text: '',
    fileName: basename(copied.filePath),
    fileSize: copied.fileSize,
    filePath: copied.filePath,
    dataUrl: '',
    createdAt: Date.now()
  }
  appendMessage(store, message)
  await persist()
  broadcastMessage(message)

  const error = await deliverToFriend(friend, {
    id: message.id,
    kind: 'file',
    text: '',
    fileName: message.fileName,
    fileSize: message.fileSize,
    base64: buffer.toString('base64')
  })
  if (error) {
    message.error = error
    await persist()
    broadcastState()
  }
  return { ...message }
}

export async function clearHistory(friendId: string): Promise<ChatState> {
  const store = await loadStore()
  store.messages = store.messages.filter((item) => item.friendId !== friendId)
  await persist()
  broadcastState()
  return chatStateSync()
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export async function setChatDir(dir: string): Promise<ChatState> {
  const store = await loadStore()
  store.chatDir = dir
  await fsp.mkdir(dir, { recursive: true }).catch(() => undefined)
  await persist()
  broadcastState()
  return chatStateSync()
}

/** 应用启动时调用：加载数据并开始监听 */
export async function bootstrapChat(): Promise<void> {
  const store = await loadStore()
  await startChatServer(store.me.port)
}
