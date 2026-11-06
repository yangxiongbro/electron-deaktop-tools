<script setup lang="ts">
/**
 * 本地聊天
 *
 * 交友方式：手动填对方的 IP 与端口；双方都在用本程序时即为「在线」。
 * 所有收发都由主进程负责（HTTP 服务 + 请求），渲染层只做展示与交互。
 */
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Delete,
  Document,
  EditPen,
  FolderOpened,
  MoreFilled,
  Plus,
  Position,
  Refresh,
  Search,
  User
} from '@element-plus/icons-vue'
import type { ChatFriend, ChatFriendRequest, ChatMessage, ChatPeerStatus, ChatState } from '@shared/types'
import { formatBytes } from '../utils/format'

const STATUS_TEXT: Record<ChatPeerStatus, string> = {
  online: '在线',
  offline: '离线',
  unreachable: '不可达'
}

const EMOJIS = [
  '😀', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂',
  '😉', '😍', '🥰', '😘', '😜', '🤪', '🤔', '🤨', '😐', '😑',
  '😴', '😪', '😷', '🤒', '🥳', '😎', '🤓', '🧐', '😕', '😟',
  '🙁', '😮', '😯', '😲', '😳', '🥺', '😢', '😭', '😱', '😤',
  '😠', '😡', '🤬', '🤯', '👍', '👎', '👏', '🙏', '💪', '🤝',
  '✌️', '👌', '🤞', '❤️', '💔', '💯', '🔥', '✨', '🎉', '🎊',
  '🌈', '☀️', '🌙', '⭐', '🌟', '🍀', '🌸', '🎁', '☕', '🍺',
  '🍰', '🎂', '🐱', '🐶', '🐼', '🦊', '🐳', '🐧'
]

const state = ref<ChatState | null>(null)
const loading = ref(true)
const currentFriendId = ref('')
const drafts = reactive<Record<string, string>>({})
const unread = reactive<Record<string, number>>({})
const historyQuery = ref('')
const friendQuery = ref('')
const emojiVisible = ref(false)
const sending = ref(false)
const refreshing = ref(false)
const panelWidth = ref(264)
const messageListRef = ref<HTMLElement | null>(null)
const imageInputRef = ref<HTMLInputElement | null>(null)
const avatarInputRef = ref<HTMLInputElement | null>(null)

/* ------------------------------ 派生数据 ------------------------------ */

const friends = computed(() => state.value?.friends ?? [])
const me = computed(() => state.value?.me ?? null)
const messages = computed(() => state.value?.messages ?? [])

const filteredFriends = computed(() => {
  const keyword = friendQuery.value.trim().toLowerCase()
  const list = [...friends.value]
  list.sort((left, right) => {
    // 在线优先，其次按最近消息时间
    if (left.status !== right.status) {
      if (left.status === 'online') return -1
      if (right.status === 'online') return 1
    }
    return lastMessageAt(right.id) - lastMessageAt(left.id)
  })
  if (!keyword) return list
  return list.filter((friend) =>
    `${friend.remark} ${friend.nickname} ${friend.ip}`.toLowerCase().includes(keyword)
  )
})

const currentFriend = computed(
  () => friends.value.find((item) => item.id === currentFriendId.value) ?? null
)

const currentMessages = computed(() =>
  messages.value.filter((item) => item.friendId === currentFriendId.value)
)

/** 聊天记录搜索：直接过滤当前会话的消息 */
const visibleMessages = computed(() => {
  const keyword = historyQuery.value.trim().toLowerCase()
  if (!keyword) return currentMessages.value
  return currentMessages.value.filter((item) =>
    `${item.text} ${item.fileName}`.toLowerCase().includes(keyword)
  )
})

interface MessageRow {
  message: ChatMessage
  showDay: boolean
}

const messageRows = computed<MessageRow[]>(() => {
  const rows: MessageRow[] = []
  let lastDay = ''
  for (const message of visibleMessages.value) {
    const day = new Date(message.createdAt).toDateString()
    rows.push({ message, showDay: day !== lastDay })
    lastDay = day
  }
  return rows
})

function lastMessageOf(friendId: string): ChatMessage | null {
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    if (messages.value[index].friendId === friendId) return messages.value[index]
  }
  return null
}

function lastMessageAt(friendId: string): number {
  return lastMessageOf(friendId)?.createdAt ?? 0
}

function previewOf(friendId: string): string {
  const message = lastMessageOf(friendId)
  if (!message) return '还没有聊天记录'
  return previewText(message)
}

function previewText(message: ChatMessage): string {
  if (message.kind === 'image') return '[图片]'
  if (message.kind === 'file') return `[文件] ${message.fileName}`
  return message.text
}

/* ------------------------------ 工具函数 ------------------------------ */

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function clockOf(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function dayOf(timestamp: number): string {
  const date = new Date(timestamp)
  const today = new Date()
  if (date.toDateString() === today.toDateString()) return '今天'
  const yesterday = new Date(today.getTime() - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) return '昨天'
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\uFE0F|\u200D|\s)+$/u

function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed.length <= 16 && EMOJI_ONLY.test(trimmed)
}

function statusClass(status: ChatPeerStatus): string {
  return `status-${status}`
}

function statusText(status: ChatPeerStatus): string {
  return STATUS_TEXT[status] ?? '未知'
}

/* ---------------------------- 图片懒加载 ---------------------------- */

const imageCache = ref<Record<string, string>>({})

async function loadImages(list: ChatMessage[]): Promise<void> {
  for (const message of list) {
    if (message.kind !== 'image' || !message.filePath) continue
    if (imageCache.value[message.filePath]) continue
    const dataUrl = await window.api.chat.readImage(message.filePath)
    if (dataUrl) imageCache.value = { ...imageCache.value, [message.filePath]: dataUrl }
  }
}

watch(
  visibleMessages,
  (list) => {
    void loadImages(list)
  },
  { immediate: true }
)

/* ------------------------------ 数据同步 ------------------------------ */

function applyState(next: ChatState): void {
  state.value = next
  if (currentFriendId.value && !next.friends.some((item) => item.id === currentFriendId.value)) {
    currentFriendId.value = next.friends[0]?.id ?? ''
  }
  if (!currentFriendId.value && next.friends.length) currentFriendId.value = next.friends[0].id
}

async function reload(): Promise<void> {
  try {
    applyState(await window.api.chat.state())
  } catch (error) {
    ElMessage.error(`读取聊天数据失败：${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}

let offMessage: (() => void) | undefined
let offState: (() => void) | undefined

function scrollToBottom(): void {
  void nextTick(() => {
    const el = messageListRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

watch(
  () => [currentFriendId.value, historyQuery.value, currentMessages.value.length],
  () => scrollToBottom()
)

/* ------------------------------ 好友操作 ------------------------------ */

async function selectFriend(friend: ChatFriend): Promise<void> {
  currentFriendId.value = friend.id
  historyQuery.value = ''
  emojiVisible.value = false
  unread[friend.id] = 0
  // 切换好友时主动同步一次对方的昵称 / 头像 / 端口
  try {
    const updated = await window.api.chat.refreshFriend(friend.id)
    if (updated && state.value) {
      state.value.friends = state.value.friends.map((item) => (item.id === updated.id ? updated : item))
    }
  } catch {
    // 探测失败不影响聊天窗口
  }
}

async function refreshCurrent(): Promise<void> {
  if (!currentFriend.value || refreshing.value) return
  refreshing.value = true
  try {
    const updated = await window.api.chat.refreshFriend(currentFriend.value.id)
    if (updated && state.value) {
      state.value.friends = state.value.friends.map((item) => (item.id === updated.id ? updated : item))
    }
    ElMessage.success(`已刷新：${statusText(updated?.status ?? 'unreachable')}`)
  } catch (error) {
    ElMessage.error(`刷新失败：${(error as Error).message}`)
  } finally {
    refreshing.value = false
  }
}

async function refreshAllSilently(): Promise<void> {
  if (refreshing.value || loading.value) return
  refreshing.value = true
  try {
    const list = await window.api.chat.refreshAll()
    if (state.value) state.value.friends = list
  } catch {
    // 忽略：下次定时器还会重试
  } finally {
    refreshing.value = false
  }
}

/* ---------------------------- 添加 / 编辑好友 ---------------------------- */

const friendDialog = ref(false)
const editingFriendId = ref('')
const friendForm = reactive({ ip: '', port: '45871', remark: '' })

function openAddFriend(): void {
  editingFriendId.value = ''
  friendForm.ip = ''
  friendForm.port = String(me.value?.port ?? 45871)
  friendForm.remark = ''
  friendDialog.value = true
}

function openEditFriend(friend: ChatFriend): void {
  editingFriendId.value = friend.id
  friendForm.ip = friend.ip
  friendForm.port = String(friend.port)
  friendForm.remark = friend.remark
  friendDialog.value = true
}

async function submitFriend(): Promise<void> {
  const ip = friendForm.ip.trim()
  const port = Number(friendForm.port)
  if (!ip) {
    ElMessage.warning('请填写好友 IP')
    return
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    ElMessage.warning('端口需要在 1 ~ 65535 之间')
    return
  }
  try {
    if (editingFriendId.value) {
      applyState(
        await window.api.chat.updateFriend(editingFriendId.value, {
          ip,
          port,
          remark: friendForm.remark.trim()
        })
      )
      ElMessage.success('好友信息已更新')
    } else {
      // 现在加好友要对方同意，同意后才会出现在好友列表
      applyState(
        await window.api.chat.sendFriendRequest({
          ip,
          port,
          remark: friendForm.remark.trim()
        })
      )
      ElMessage.success('好友申请已发送，等待对方同意')
    }
    friendDialog.value = false
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/* ---------------------------- 好友申请 ---------------------------- */

const requestDialog = ref(false)

const requests = computed(() => state.value?.requests ?? [])

const pendingIncoming = computed(
  () => requests.value.filter((item) => item.direction === 'in' && item.status === 'pending').length
)

const sortedRequests = computed(() =>
  [...requests.value].sort((left, right) => right.createdAt - left.createdAt)
)

function requestPeerName(request: ChatFriendRequest): string {
  return request.remark || request.nickname || request.ip
}

/** 打开「新好友」时顺带补发还没结果的申请，对方若已处理会把结果回执回来 */
function openRequests(): void {
  requestDialog.value = true
  void window.api.chat
    .resendRequests()
    .then((next) => applyState(next))
    .catch(() => undefined)
}

function requestStatusText(request: ChatFriendRequest): string {
  switch (request.status) {
    case 'pending':
      return request.direction === 'in' ? '等待你处理' : '等待对方同意'
    case 'accepted':
      return '已同意'
    case 'rejected':
      return '已拒绝'
    default:
      return request.message || '发送失败'
  }
}

function requestTime(request: ChatFriendRequest): string {
  const stamp = request.respondedAt || request.createdAt
  const date = new Date(stamp)
  return `${date.getMonth() + 1}-${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function respondRequest(request: ChatFriendRequest, accepted: boolean): Promise<void> {
  try {
    const next = await window.api.chat.respondFriendRequest(request.id, accepted)
    applyState(next)
    if (accepted) {
      const friend = next.friends.find(
        (item) => item.id === request.peerId || (item.ip === request.ip && item.port === request.port)
      )
      if (friend) currentFriendId.value = friend.id
      ElMessage.success('已同意好友申请')
    } else {
      ElMessage.success('已拒绝该好友申请')
    }
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function dismissRequest(id: string): Promise<void> {
  try {
    applyState(await window.api.chat.dismissRequest(id))
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function removeFriend(friend: ChatFriend): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确定删除好友「${friend.remark || friend.nickname || friend.ip}」吗？重新添加时需要对方再次同意，并会从空白记录开始。`,
      '删除好友',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    applyState(await window.api.chat.removeFriend(friend.id))
    if (currentFriendId.value === friend.id) currentFriendId.value = friends.value[0]?.id ?? ''
    ElMessage.success('好友已删除')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function clearHistory(): Promise<void> {
  if (!currentFriend.value) return
  try {
    await ElMessageBox.confirm('确定清空当前会话的聊天记录吗？该操作无法恢复。', '清空聊天记录', {
      type: 'warning',
      confirmButtonText: '清空',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    applyState(await window.api.chat.clearHistory(currentFriend.value.id))
    ElMessage.success('聊天记录已清空')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function onFriendCommand(command: string | number | object): Promise<void> {
  const friend = currentFriend.value
  if (!friend) return
  switch (String(command)) {
    case 'refresh':
      await refreshCurrent()
      break
    case 'edit':
      openEditFriend(friend)
      break
    case 'clear':
      await clearHistory()
      break
    case 'remove':
      await removeFriend(friend)
      break
    default:
      break
  }
}

/* ------------------------------ 我的资料 ------------------------------ */

const profileDialog = ref(false)
const profileForm = reactive({ nickname: '', port: '', avatar: '' })

function openProfile(): void {
  if (!me.value) return
  profileForm.nickname = me.value.nickname
  profileForm.port = String(me.value.port)
  profileForm.avatar = me.value.avatar
  profileDialog.value = true
}

/** 随机头像：渐变 + 气泡，和主进程生成的默认头像是一类风格 */
function randomAvatar(seedText: string): string {
  const palettes: [string, string][] = [
    ['#4f8cff', '#6f5bff'],
    ['#f97316', '#ef4444'],
    ['#22c55e', '#0ea5e9'],
    ['#a855f7', '#ec4899'],
    ['#eab308', '#f97316'],
    ['#14b8a6', '#3b82f6'],
    ['#f43f5e', '#f59e0b'],
    ['#6366f1', '#22d3ee']
  ]
  const hash = (text: string): number => {
    let value = 0
    for (let index = 0; index < text.length; index += 1) value = (value * 31 + text.charCodeAt(index)) | 0
    return Math.abs(value)
  }
  const base = hash(seedText)
  const [from, to] = palettes[base % palettes.length]
  const bubbles: string[] = []
  for (let index = 0; index < 4; index += 1) {
    const h = hash(`${seedText}-${index}`)
    const cx = 10 + (h % 44)
    const cy = 10 + ((h >> 3) % 44)
    const radius = 5 + ((h >> 6) % 11)
    const opacity = (0.16 + ((h >> 9) % 18) / 100).toFixed(2)
    bubbles.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#ffffff" opacity="${opacity}"/>`)
  }
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">' +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    '<rect width="64" height="64" fill="url(#g)"/>' +
    bubbles.join('') +
    '</svg>'
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
}

const NICK_ADJ = ['安静的', '灵动的', '热心的', '沉稳的', '快乐的', '认真的', '爱笑的', '靠谱的', '低调的', '好奇的']
const NICK_NOUN = ['海豚', '松鼠', '企鹅', '狐狸', '熊猫', '猫头鹰', '鲸鱼', '水獭', '刺猬', '考拉']

function randomNickname(): void {
  const adjective = NICK_ADJ[Math.floor(Math.random() * NICK_ADJ.length)]
  const noun = NICK_NOUN[Math.floor(Math.random() * NICK_NOUN.length)]
  profileForm.nickname = `${adjective}${noun}`
}

function rerollAvatar(): void {
  profileForm.avatar = randomAvatar(`${profileForm.nickname}-${Date.now()}-${Math.random()}`)
}

function pickAvatar(): void {
  avatarInputRef.value?.click()
}

async function saveProfile(): Promise<void> {
  const nickname = profileForm.nickname.trim()
  const port = Number(profileForm.port)
  if (!nickname) {
    ElMessage.warning('昵称不能为空')
    return
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    ElMessage.warning('端口建议使用 1024 ~ 65535 之间未被占用的值')
    return
  }
  try {
    applyState(
      await window.api.chat.updateProfile({ nickname, port, avatar: profileForm.avatar })
    )
    profileDialog.value = false
    if (state.value?.portError) ElMessage.error(state.value.portError)
    else ElMessage.success('资料已更新，并已广播给在线好友')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/* ------------------------------ 发送消息 ------------------------------ */

const messageText = computed<string>({
  get: () => drafts[currentFriendId.value] ?? '',
  set: (value) => {
    drafts[currentFriendId.value] = value
  }
})

const canSend = computed(() => Boolean(currentFriend.value) && messageText.value.trim().length > 0)

async function sendText(): Promise<void> {
  const friend = currentFriend.value
  const text = messageText.value.trim()
  if (!friend || !text || sending.value) return
  drafts[friend.id] = ''
  sending.value = true
  try {
    await window.api.chat.send({ friendId: friend.id, kind: 'text', text })
  } catch (error) {
    ElMessage.error(`发送失败：${(error as Error).message}`)
  } finally {
    sending.value = false
  }
}

function onComposerKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void sendText()
  }
}

function appendEmoji(emoji: string): void {
  messageText.value = `${messageText.value}${emoji}`
}

/** 图片压缩到最长边 1600px，避免聊天数据过大 */
function compressImage(file: File, maxSize = 1600, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const image = new Image()
      image.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(image.width * scale))
        canvas.height = Math.max(1, Math.round(image.height * scale))
        const context = canvas.getContext('2d')
        if (!context) {
          resolve(String(reader.result))
          return
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', quality))
      }
      image.onerror = () => reject(new Error('图片解析失败'))
      image.src = String(reader.result)
    }
    reader.onerror = () => reject(new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

function pickImage(): void {
  if (!currentFriend.value) {
    ElMessage.warning('请先选择一位好友')
    return
  }
  imageInputRef.value?.click()
}

async function onImagePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const friend = currentFriend.value
  if (!file || !friend) return
  try {
    const dataUrl = await compressImage(file)
    await window.api.chat.sendImage(friend.id, dataUrl, file.name.replace(/\.[^.]+$/, '') + '.jpg')
  } catch (error) {
    ElMessage.error(`发送图片失败：${(error as Error).message}`)
  }
}

async function pickFile(): Promise<void> {
  const friend = currentFriend.value
  if (!friend) {
    ElMessage.warning('请先选择一位好友')
    return
  }
  const pick = await window.api.dialog.openFile({ title: '选择要发送的文件' })
  if (pick.canceled || !pick.filePath) return
  try {
    await window.api.chat.sendFile(friend.id, pick.filePath)
  } catch (error) {
    ElMessage.error(`发送文件失败：${(error as Error).message}`)
  }
}

async function onAvatarPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const dataUrl = await compressImage(file, 192, 0.9)
    profileForm.avatar = dataUrl
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/* ---------------------------- 打开聊天文件 ---------------------------- */

async function openMessageFile(message: ChatMessage): Promise<void> {
  if (!message.filePath) return
  try {
    await window.api.chat.openFile(message.filePath)
  } catch (error) {
    ElMessage.error(`打开文件失败：${(error as Error).message}`)
  }
}

async function revealMessageFile(message: ChatMessage): Promise<void> {
  if (!message.filePath) return
  await window.api.chat.revealFile(message.filePath)
}

async function openChatDir(): Promise<void> {
  try {
    await window.api.chat.openChatDir()
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/* ------------------------------ 列表伸缩 ------------------------------ */

let resizing = false
let resizeStartX = 0
let resizeStartWidth = 0

function startResize(event: MouseEvent): void {
  resizing = true
  resizeStartX = event.clientX
  resizeStartWidth = panelWidth.value
  window.addEventListener('mousemove', onResizeMove)
  window.addEventListener('mouseup', stopResize)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

function onResizeMove(event: MouseEvent): void {
  if (!resizing) return
  const next = resizeStartWidth + (event.clientX - resizeStartX)
  panelWidth.value = Math.min(460, Math.max(210, next))
}

function stopResize(): void {
  resizing = false
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', stopResize)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
}

/* ------------------------------ 生命周期 ------------------------------ */

let refreshTimer: number | undefined
let active = false

onMounted(async () => {
  offMessage = window.api.chat.onMessage((message) => {
    if (!state.value) return
    if (!state.value.messages.some((item) => item.id === message.id)) {
      state.value.messages = [...state.value.messages, message]
    }
    if (message.direction === 'in' && message.friendId !== currentFriendId.value) {
      unread[message.friendId] = (unread[message.friendId] ?? 0) + 1
      // 不在当前会话里收到消息时，给一个轻提示（系统通知由主进程负责）
      const friend = state.value.friends.find((item) => item.id === message.friendId)
      ElMessage({
        type: 'info',
        duration: 3500,
        message: `${friend?.remark || friend?.nickname || '好友'}：${previewText(message).slice(0, 40)}`
      })
    }
  })
  offState = window.api.chat.onState((next) => {
    applyState(next)
  })
  await reload()
  active = true
  void refreshAllSilently()
  refreshTimer = window.setInterval(() => {
    if (active) void refreshAllSilently()
  }, 30_000)
})

onActivated(() => {
  active = true
  void refreshAllSilently()
})

onDeactivated(() => {
  active = false
})

onUnmounted(() => {
  offMessage?.()
  offState?.()
  if (refreshTimer) window.clearInterval(refreshTimer)
  window.removeEventListener('mousemove', onResizeMove)
  window.removeEventListener('mouseup', stopResize)
})
</script>

<template>
  <div class="page chat-page">
    <div class="page-body chat-body">
      <!-- 左：我的资料 + 好友列表（可拖拽伸缩） -->
      <aside class="panel user-panel" :style="{ width: `${panelWidth}px` }">
        <div class="me-card">
          <button class="avatar-btn" type="button" title="编辑我的资料" @click="openProfile">
            <img v-if="me?.avatar" class="avatar avatar-lg" :src="me.avatar" alt="" />
            <span v-else class="avatar avatar-lg avatar-fallback">{{ me?.nickname?.slice(0, 1) ?? '我' }}</span>
            <span class="avatar-edit"><el-icon :size="11"><EditPen /></el-icon></span>
          </button>
          <div class="me-info">
            <div class="me-name">{{ me?.nickname ?? '未命名' }}</div>
            <div class="me-addr small muted mono">
              {{ me?.host || '-' }}:{{ me?.port ?? '-' }}
            </div>
          </div>
          <el-tooltip :content="state?.listening ? '正在监听端口' : state?.portError || '未启动'" placement="bottom">
            <span class="listen-dot" :class="{ on: state?.listening }" />
          </el-tooltip>
          <el-tooltip content="聊天文件保存目录" placement="bottom">
            <button class="mini-btn" type="button" @click="openChatDir">
              <el-icon :size="13"><FolderOpened /></el-icon>
            </button>
          </el-tooltip>
        </div>

        <div class="friend-toolbar">
          <el-input
            v-model="friendQuery"
            size="small"
            placeholder="搜索好友"
            :prefix-icon="Search"
            clearable
            class="friend-search"
          />
          <el-tooltip :content="`新好友（${pendingIncoming} 个待处理）`" placement="bottom">
            <el-badge :value="pendingIncoming" :hidden="pendingIncoming === 0" :max="99" class="friend-badge">
              <el-button size="small" :icon="User" @click="openRequests" />
            </el-badge>
          </el-tooltip>
          <el-tooltip content="添加好友" placement="bottom">
            <el-button size="small" :icon="Plus" @click="openAddFriend" />
          </el-tooltip>
        </div>

        <div class="friend-list">
          <div v-if="!friends.length" class="friend-empty">
            <el-icon :size="24"><User /></el-icon>
            <span>还没有好友</span>
            <span class="tip">点右上角「+」填对方的 IP 和端口，对方同意后就会出现在这里</span>
          </div>
          <div
            v-for="friend in filteredFriends"
            :key="friend.id"
            class="friend-item"
            :class="{ active: friend.id === currentFriendId }"
            role="button"
            tabindex="0"
            @click="selectFriend(friend)"
            @keydown.enter.prevent="selectFriend(friend)"
          >
            <div class="friend-avatar">
              <img v-if="friend.avatar" class="avatar" :src="friend.avatar" alt="" />
              <span v-else class="avatar avatar-fallback">
                {{ (friend.remark || friend.nickname || friend.ip).slice(0, 1) }}
              </span>
              <span class="dot" :class="statusClass(friend.status)" />
            </div>
            <div class="friend-main">
              <div class="friend-top">
                <span class="friend-name">{{ friend.remark || friend.nickname || friend.ip }}</span>
                <span v-if="unread[friend.id]" class="unread">{{ unread[friend.id] }}</span>
              </div>
              <div class="friend-preview small muted">{{ previewOf(friend.id) }}</div>
            </div>
          </div>
        </div>
      </aside>

      <div class="resizer" title="拖动调整好友列表宽度" @mousedown.prevent="startResize" />

      <!-- 右：聊天窗口 -->
      <section class="panel chat-main">
        <template v-if="currentFriend">
          <header class="panel-header chat-header">
            <img v-if="currentFriend.avatar" class="avatar" :src="currentFriend.avatar" alt="" />
            <span v-else class="avatar avatar-fallback">
              {{ (currentFriend.remark || currentFriend.nickname || currentFriend.ip).slice(0, 1) }}
            </span>
            <div class="chat-title">
              <div class="name-row">
                <span class="chat-name">{{ currentFriend.remark || currentFriend.nickname || currentFriend.ip }}</span>
                <span class="status-tag" :class="statusClass(currentFriend.status)">
                  {{ statusText(currentFriend.status) }}
                </span>
              </div>
              <div class="small muted mono">{{ currentFriend.ip }}:{{ currentFriend.port }}</div>
            </div>
            <span class="spacer" />
            <el-input
              v-model="historyQuery"
              size="small"
              class="history-search"
              placeholder="搜索聊天记录"
              :prefix-icon="Search"
              clearable
            />
            <el-dropdown trigger="click" @command="onFriendCommand">
              <button class="mini-btn" type="button" title="更多">
                <el-icon :size="14"><MoreFilled /></el-icon>
              </button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="refresh" :icon="Refresh">刷新好友信息</el-dropdown-item>
                  <el-dropdown-item command="edit" :icon="EditPen">编辑好友</el-dropdown-item>
                  <el-dropdown-item command="clear" :icon="Delete" divided>清空聊天记录</el-dropdown-item>
                  <el-dropdown-item command="remove" :icon="Delete">删除好友</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </header>

          <div ref="messageListRef" class="message-list">
            <div v-if="historyQuery" class="filter-hint small muted">
              筛选出 {{ visibleMessages.length }} 条包含「{{ historyQuery }}」的消息
            </div>
            <div v-if="!messageRows.length" class="message-empty">
              <el-icon :size="26"><Document /></el-icon>
              <span>{{ historyQuery ? '没有匹配的聊天记录' : '还没有消息，打个招呼吧' }}</span>
            </div>

            <template v-for="row in messageRows" :key="row.message.id">
              <div v-if="row.showDay" class="day-divider">{{ dayOf(row.message.createdAt) }}</div>
              <div class="message-row" :class="row.message.direction === 'out' ? 'out' : 'in'">
                <img
                  v-if="row.message.direction === 'in' && currentFriend.avatar"
                  class="avatar avatar-sm"
                  :src="currentFriend.avatar"
                  alt=""
                />
                <span
                  v-else-if="row.message.direction === 'in'"
                  class="avatar avatar-sm avatar-fallback"
                >{{ (currentFriend.remark || currentFriend.nickname || '友').slice(0, 1) }}</span>

                <div class="bubble-wrap">
                  <div
                    class="bubble"
                    :class="{
                      'emoji-only': row.message.kind === 'text' && isEmojiOnly(row.message.text),
                      media: row.message.kind !== 'text'
                    }"
                  >
                    <template v-if="row.message.kind === 'text'">
                      <span class="bubble-text">{{ row.message.text }}</span>
                    </template>

                    <template v-else-if="row.message.kind === 'image'">
                      <div class="image-box">
                        <img
                          v-if="imageCache[row.message.filePath]"
                          class="chat-image"
                          :src="imageCache[row.message.filePath]"
                          alt="图片消息"
                          @click="openMessageFile(row.message)"
                        />
                        <div v-else class="image-loading small muted">图片加载中…</div>
                        <div class="media-actions">
                          <el-tooltip content="打开" placement="top" :show-after="200">
                            <button class="media-action" type="button" @click="openMessageFile(row.message)">
                              <el-icon :size="13"><Document /></el-icon>
                            </button>
                          </el-tooltip>
                          <el-tooltip content="定位" placement="top" :show-after="200">
                            <button class="media-action" type="button" @click="revealMessageFile(row.message)">
                              <el-icon :size="13"><FolderOpened /></el-icon>
                            </button>
                          </el-tooltip>
                        </div>
                      </div>
                    </template>

                    <template v-else>
                      <div class="file-box">
                        <el-icon :size="20" class="file-icon"><Document /></el-icon>
                        <div class="file-info">
                          <div class="file-name">{{ row.message.fileName }}</div>
                          <div class="small muted">
                            {{ formatBytes(row.message.fileSize) }}
                            <span v-if="row.message.error" class="file-error">· 发送失败</span>
                          </div>
                        </div>
                      </div>
                      <div class="media-actions">
                        <el-tooltip content="打开" placement="top" :show-after="200">
                          <button class="media-action" type="button" @click="openMessageFile(row.message)">
                            <el-icon :size="13"><Document /></el-icon>
                          </button>
                        </el-tooltip>
                        <el-tooltip content="定位" placement="top" :show-after="200">
                          <button class="media-action" type="button" @click="revealMessageFile(row.message)">
                            <el-icon :size="13"><FolderOpened /></el-icon>
                          </button>
                        </el-tooltip>
                      </div>
                    </template>
                  </div>
                  <div class="bubble-meta small muted">
                    <span>{{ clockOf(row.message.createdAt) }}</span>
                    <span v-if="row.message.direction === 'out' && row.message.error" class="send-error">
                      发送失败：{{ row.message.error }}
                    </span>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <div class="composer">
            <div class="composer-tools">
              <el-popover v-model:visible="emojiVisible" placement="top-start" :width="292" trigger="click">
                <template #reference>
                  <button class="tool-btn emoji-btn" type="button" title="表情">😊</button>
                </template>
                <div class="emoji-grid">
                  <button
                    v-for="emoji in EMOJIS"
                    :key="emoji"
                    class="emoji-item"
                    type="button"
                    @click="appendEmoji(emoji)"
                  >
                    {{ emoji }}
                  </button>
                </div>
              </el-popover>
              <el-tooltip content="发送图片" placement="top">
                <button class="tool-btn" type="button" @click="pickImage">
                  <svg class="tool-svg" viewBox="0 0 1024 1024" aria-hidden="true">
                    <path
                      d="M938.666667 553.92V768c0 64.8-52.533333 117.333333-117.333334 117.333333H202.666667c-64.8 0-117.333333-52.533333-117.333334-117.333333V256c0-64.8 52.533333-117.333333 117.333334-117.333333h618.666666c64.8 0 117.333333 52.533333 117.333334 117.333333v297.92z m-64-74.624V256a53.333333 53.333333 0 0 0-53.333334-53.333333H202.666667a53.333333 53.333333 0 0 0-53.333334 53.333333v344.48A290.090667 290.090667 0 0 1 192 597.333333a286.88 286.88 0 0 1 183.296 65.845334C427.029333 528.384 556.906667 437.333333 704 437.333333c65.706667 0 126.997333 16.778667 170.666667 41.962667z m0 82.24c-5.333333-8.32-21.130667-21.653333-43.648-32.917333C796.768 511.488 753.045333 501.333333 704 501.333333c-121.770667 0-229.130667 76.266667-270.432 188.693334-2.730667 7.445333-7.402667 20.32-13.994667 38.581333-7.68 21.301333-34.453333 28.106667-51.370666 13.056-16.437333-14.634667-28.554667-25.066667-36.138667-31.146667A222.890667 222.890667 0 0 0 192 661.333333c-14.464 0-28.725333 1.365333-42.666667 4.053334V768a53.333333 53.333333 0 0 0 53.333334 53.333333h618.666666a53.333333 53.333333 0 0 0 53.333334-53.333333V561.525333zM320 480a96 96 0 1 1 0-192 96 96 0 0 1 0 192z m0-64a32 32 0 1 0 0-64 32 32 0 0 0 0 64z"
                      fill="currentColor"
                    />
                  </svg>
                </button>
              </el-tooltip>
              <el-tooltip content="发送文件" placement="top">
                <button class="tool-btn" type="button" @click="pickFile">
                  <el-icon :size="15"><FolderOpened /></el-icon>
                </button>
              </el-tooltip>
              <span class="small muted composer-hint">Enter 发送 · Shift + Enter 换行</span>
            </div>
            <textarea
              v-model="messageText"
              class="composer-input"
              rows="3"
              placeholder="输入消息…"
              @keydown="onComposerKeydown"
            />
            <div class="composer-footer">
              <el-button type="primary" size="small" :icon="Position" :disabled="!canSend" @click="sendText">
                发送
              </el-button>
            </div>
          </div>
        </template>

        <div v-else class="chat-empty">
          <el-icon :size="34"><User /></el-icon>
          <div class="empty-title">{{ friends.length ? '选择一位好友开始聊天' : '先添加一位好友' }}</div>
          <div class="small muted">
            好友之间通过 IP + 端口直连，双方都需要打开本程序；端口在「我的资料」里配置。
          </div>
          <el-button type="primary" :icon="Plus" @click="openAddFriend">添加好友</el-button>
        </div>
      </section>
    </div>

    <!-- 添加 / 编辑好友 -->
    <el-dialog
      v-model="friendDialog"
      :title="editingFriendId ? '编辑好友' : '添加好友'"
      width="460px"
      append-to-body
    >
      <div class="form-stack">
        <div class="form-row">
          <span class="form-label">IP 地址</span>
          <el-input v-model="friendForm.ip" placeholder="例如 192.168.1.20" />
        </div>
        <div class="form-row">
          <span class="form-label">端口</span>
          <el-input v-model="friendForm.port" placeholder="对方程序监听的端口，默认 45871" />
        </div>
        <div class="form-row">
          <span class="form-label">备注</span>
          <el-input v-model="friendForm.remark" placeholder="给这位好友起个名字，例如：隔壁老王" />
        </div>
        <div v-if="!editingFriendId" class="small muted">
          发送申请后需要对方同意才会出现在好友列表；同意后从空白记录开始聊天。
        </div>
        <div v-else class="small muted">修改 IP / 端口后会重新探测在线状态；备注只影响本地显示。</div>
      </div>
      <template #footer>
        <el-button @click="friendDialog = false">取消</el-button>
        <el-button type="primary" @click="submitFriend">
          {{ editingFriendId ? '保存' : '发送申请' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 新好友：添加 / 被添加的申请记录 -->
    <el-dialog v-model="requestDialog" title="新好友" width="560px" append-to-body>
      <div v-if="!sortedRequests.length" class="request-empty">
        还没有好友申请。点好友列表右上角的「+」填写对方 IP 与端口即可发起申请。
      </div>
      <div v-else class="request-list">
        <div v-for="request in sortedRequests" :key="request.id" class="request-item">
          <span class="request-tag" :class="request.direction">
            {{ request.direction === 'in' ? '添加我' : '我添加' }}
          </span>
          <div class="request-main">
            <div class="request-name">
              {{ requestPeerName(request) }}
              <span class="small muted mono">{{ request.ip }}:{{ request.port }}</span>
            </div>
            <div class="request-sub small muted">
              {{ requestStatusText(request) }} · {{ requestTime(request) }}
            </div>
          </div>
          <template v-if="request.status === 'pending' && request.direction === 'in'">
            <el-button size="small" type="primary" @click="respondRequest(request, true)">同意</el-button>
            <el-button size="small" @click="respondRequest(request, false)">拒绝</el-button>
          </template>
          <template v-else>
            <span class="request-state" :class="request.status">{{ requestStatusText(request) }}</span>
            <el-tooltip v-if="request.status !== 'pending'" content="从列表中移除这条记录" placement="top">
              <button class="mini-btn" type="button" @click="dismissRequest(request.id)">
                <el-icon :size="13"><Delete /></el-icon>
              </button>
            </el-tooltip>
          </template>
        </div>
      </div>
      <template #footer>
        <el-button @click="requestDialog = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 我的资料 -->
    <el-dialog v-model="profileDialog" title="我的资料" width="480px" append-to-body>
      <div class="form-stack">
        <div class="profile-avatar-row">
          <img v-if="profileForm.avatar" class="avatar avatar-xl" :src="profileForm.avatar" alt="" />
          <span v-else class="avatar avatar-xl avatar-fallback">{{ profileForm.nickname.slice(0, 1) || '我' }}</span>
          <div class="avatar-actions">
            <el-button size="small" @click="pickAvatar">上传头像</el-button>
            <el-button size="small" @click="rerollAvatar">随机头像</el-button>
          </div>
        </div>
        <div class="form-row">
          <span class="form-label">昵称</span>
          <el-input v-model="profileForm.nickname" maxlength="40">
            <template #append>
              <el-button @click="randomNickname">随机</el-button>
            </template>
          </el-input>
        </div>
        <div class="form-row">
          <span class="form-label">端口</span>
          <el-input v-model="profileForm.port" placeholder="1024 ~ 65535" />
        </div>
        <div class="small muted">
          修改昵称、头像或端口后会广播给在线好友；端口被占用时界面底部会提示。
        </div>
      </div>
      <template #footer>
        <el-button @click="profileDialog = false">取消</el-button>
        <el-button type="primary" @click="saveProfile">保存</el-button>
      </template>
    </el-dialog>

    <input ref="imageInputRef" type="file" accept="image/*" class="hidden-input" @change="onImagePicked" />
    <input ref="avatarInputRef" type="file" accept="image/*" class="hidden-input" @change="onAvatarPicked" />
  </div>
</template>

<style scoped>
.chat-page {
  min-height: 0;
}

.chat-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 0;
}

/* -------------------------------- 左侧 -------------------------------- */
.user-panel {
  flex: none;
  min-width: 210px;
  max-width: 460px;
}

.me-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-muted);
  flex: none;
}

.avatar-btn {
  position: relative;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  border-radius: 50%;
}

.avatar-edit {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  color: var(--app-text-2);
}

.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  flex: none;
  background: var(--app-panel-muted);
}

.avatar-sm {
  width: 26px;
  height: 26px;
}

.avatar-lg {
  width: 42px;
  height: 42px;
}

.avatar-xl {
  width: 64px;
  height: 64px;
}

.avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #4f8cff, #6f5bff);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
}

.avatar-xl.avatar-fallback {
  font-size: 22px;
}

.me-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  /* 昵称与 IP:PORT 之间的行距拉开一点，两行更好区分 */
  gap: 5px;
}

.me-name {
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.me-addr {
  font-size: 11px;
  line-height: 1.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.listen-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  background: #cbd5e1;
}

.listen-dot.on {
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.16);
}

.friend-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--app-border);
  flex: none;
}

.friend-search {
  flex: 1;
  min-width: 0;
}

.friend-badge :deep(.el-badge__content) {
  z-index: 2;
}

.friend-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.friend-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 40px 12px;
  color: var(--app-text-3);
  font-size: 12.5px;
  text-align: center;
}

.friend-empty .tip {
  font-size: 11.5px;
}

.friend-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  outline: none;
}

.friend-item:hover,
.friend-item:focus-visible {
  background: var(--app-hover);
  border-color: var(--app-border);
}

.friend-item.active {
  background: var(--app-primary-soft);
  border-color: rgba(47, 111, 237, 0.32);
}

.friend-avatar {
  position: relative;
  flex: none;
}

.friend-avatar .dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 2px solid var(--app-panel);
}

.status-online {
  background: #22c55e;
}

.status-offline {
  background: #f59e0b;
}

.status-unreachable {
  background: #94a3b8;
}

.friend-main {
  flex: 1;
  min-width: 0;
}

.friend-top {
  display: flex;
  align-items: center;
  gap: 6px;
}

.friend-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unread {
  flex: none;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: #ef4444;
  color: #fff;
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
}

.friend-preview {
  font-size: 11.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.resizer {
  width: 6px;
  flex: none;
  cursor: col-resize;
  background: transparent;
  position: relative;
}

.resizer::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 2px;
  width: 2px;
  height: 28px;
  transform: translateY(-50%);
  border-radius: 1px;
  background: var(--app-border-strong);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.resizer:hover::after {
  opacity: 1;
}

/* -------------------------------- 右侧 -------------------------------- */
.chat-main {
  flex: 1;
  min-width: 0;
}

.chat-header {
  gap: 10px;
}

.chat-title {
  min-width: 0;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.chat-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--app-text);
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-tag {
  flex: none;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10.5px;
  line-height: 16px;
  color: #fff;
}

.history-search {
  width: 168px;
}

.message-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 6px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--app-panel);
}

.filter-hint {
  align-self: center;
  padding: 2px 10px;
  border-radius: 10px;
  background: var(--app-panel-muted);
}

.message-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--app-text-3);
  font-size: 13px;
}

.day-divider {
  align-self: center;
  padding: 1px 10px;
  border-radius: 9px;
  background: var(--app-panel-muted);
  color: var(--app-text-3);
  font-size: 11px;
}

.message-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 100%;
}

.message-row.out {
  flex-direction: row-reverse;
}

.bubble-wrap {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  max-width: 72%;
}

.message-row.out .bubble-wrap {
  align-items: flex-end;
}

.bubble {
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
  font-size: 13px;
  line-height: 1.6;
  color: var(--app-text);
  word-break: break-word;
  white-space: pre-wrap;
}

.message-row.out .bubble {
  background: var(--app-primary);
  border-color: var(--app-primary);
  color: #fff;
}

.bubble.emoji-only {
  background: transparent;
  border-color: transparent;
  font-size: 28px;
  line-height: 1.2;
  padding: 2px 4px;
}

.bubble.media {
  padding: 6px;
}

.bubble-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10.5px;
}

.send-error {
  color: #dc2626;
}

.image-box {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chat-image {
  max-width: 260px;
  max-height: 260px;
  border-radius: 7px;
  cursor: zoom-in;
  display: block;
}

.image-loading {
  padding: 18px 24px;
}

/* 图片与文件消息共用同一套「打开 / 定位」按钮 */
.media-actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
  margin-top: 6px;
}

/* 只保留图标，鼠标悬停时用 tooltip 显示「打开 / 定位」 */
.media-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: var(--app-primary-soft);
  color: var(--app-primary);
  cursor: pointer;
  transition: background 0.15s ease;
}

.media-action:hover {
  background: rgba(47, 111, 237, 0.2);
}

/* 自己发出的蓝色气泡上用半透明白，保证对比度 */
.message-row.out .media-action {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}

.message-row.out .media-action:hover {
  background: rgba(255, 255, 255, 0.32);
}

.file-box {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 200px;
}

.file-icon {
  color: var(--app-primary);
}

.message-row.out .file-icon {
  color: #fff;
}

.file-info {
  flex: 1;
  min-width: 0;
}

.file-name {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.file-error {
  color: #fecaca;
}

.composer {
  flex: none;
  border-top: 1px solid var(--app-border);
  background: var(--app-panel);
  padding: 8px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.composer-tools {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tool-btn {
  width: 28px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-2);
  font-size: 14px;
  cursor: pointer;
}

.tool-btn:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.emoji-btn {
  font-size: 15px;
}

/* 发送图片按钮用的是图片图标，颜色跟发送文件一致（跟随 currentColor） */
.tool-svg {
  width: 15px;
  height: 15px;
  display: block;
  fill: currentColor;
}

.composer-hint {
  margin-left: 6px;
  font-size: 11px;
}

/* 发送按钮固定在输入框右下角 */
.composer-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 6px;
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 2px;
}

.emoji-item {
  border: none;
  background: transparent;
  font-size: 17px;
  line-height: 24px;
  cursor: pointer;
  border-radius: 5px;
}

.emoji-item:hover {
  background: var(--app-hover);
}

.composer-input {
  width: 100%;
  resize: none;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.6;
  color: var(--app-text);
  background: var(--app-panel-muted);
  outline: none;
}

.composer-input:focus {
  border-color: var(--app-primary);
  background: var(--app-panel);
}

.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px;
  color: var(--app-text-3);
  text-align: center;
}

.chat-empty .empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--app-text-2);
}

.mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 5px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text-3);
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
}

.mini-btn:hover {
  background: var(--app-hover);
  color: var(--app-primary);
}

.hidden-input {
  display: none;
}

.form-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.form-label {
  width: 64px;
  flex: none;
  font-size: 13px;
  color: var(--app-text-2);
}

.profile-avatar-row {
  display: flex;
  align-items: center;
  gap: 14px;
}

.avatar-actions {
  display: flex;
  gap: 8px;
}

/* ---------------------------- 新好友申请 ---------------------------- */
.request-empty {
  padding: 18px 4px;
  color: var(--app-text-3);
  font-size: 12.5px;
  line-height: 1.7;
}

.request-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 420px;
  overflow: auto;
}

.request-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel);
}

.request-tag {
  flex: none;
  padding: 1px 7px;
  border-radius: 4px;
  font-size: 11px;
  line-height: 17px;
  color: #fff;
}

.request-tag.in {
  background: #16a34a;
}

.request-tag.out {
  background: #2f6fed;
}

.request-main {
  flex: 1;
  min-width: 0;
}

.request-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.request-sub {
  margin-top: 2px;
  font-size: 11.5px;
}

.request-state {
  flex: none;
  font-size: 12px;
  color: var(--app-text-3);
}

.request-state.accepted {
  color: #16a34a;
}

.request-state.rejected {
  color: #dc2626;
}

.request-state.failed {
  color: #d97706;
}
</style>
