<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Connection, CopyDocument, Delete, FolderOpened, Refresh, VideoPlay, VideoPause } from '@element-plus/icons-vue'
import type { BtSyncStatus, SerialPortInfo, SyncPeerState, SyncState } from '@shared/types'
import { formatBytes } from '../utils/format'
import { copyText } from '../utils/clipboard'

const state = ref<SyncState | null>(null)
/** PC ↔ PC：连接另一台电脑 */
const peer = ref<SyncPeerState>({
  running: false,
  host: '',
  port: 45872,
  connected: false,
  lastError: '',
  remoteCount: 0,
  downloaded: 0,
  uploaded: 0,
  transfer: null
})
const peerAddress = ref(localStorage.getItem('devtoolbox.sync.peer') ?? '')
const peerBusy = ref(false)
/** 已取消（不再自动同步）的文件记录 */
const cancelRecords = ref<{ path: string; at: number; fingerprint: string }[]>([])
const cancelDialog = ref(false)
const loading = ref(false)
const busy = ref(false)
const portInput = ref(45872)

let timer: number | undefined
/** 蓝牙模式下 1 秒刷新一次状态（进度变化快） */
let btTimer: number | undefined
const retryTimers: number[] = []
/** 取消「传输进度」推送订阅 */
let stopTransferPush: (() => void) | undefined
/** 取消「蓝牙状态」推送订阅 */
let stopBtStatusPush: (() => void) | undefined
/** 取消「PC ↔ PC 状态」推送订阅 */
let stopPeerPush: (() => void) | undefined

const devices = computed(() => state.value?.devices ?? [])
const events = computed(() => state.value?.events ?? [])
const addresses = computed(() => (state.value?.addresses ?? []).filter((item) => !item.virtual))
const running = computed(() => state.value?.running ?? false)

/** 连接方式：WiFi / 蓝牙（合并成一套界面） */
type SyncMode = 'wifi' | 'bt'
const MODE_KEY = 'devtoolbox.sync.mode'
const mode = ref<SyncMode>((localStorage.getItem(MODE_KEY) as SyncMode) === 'bt' ? 'bt' : 'wifi')

/** 当前连接方式是否在同步 */
const activeRunning = computed(() => (mode.value === 'wifi' ? running.value : btStatus.value.running))

/** 当前正在传输的文件（WiFi 用 sync.transfer，蓝牙用 btStatus.transfer） */
const activeTransfer = computed(() =>
  mode.value === 'wifi' ? state.value?.transfer ?? null : btStatus.value.transfer ?? null
)

const transferPercent = computed(() => {
  const item = activeTransfer.value
  if (!item || !item.total) return 0
  return Math.min(100, Math.round((item.sent / item.total) * 100))
})

/** 本次会话已完成的下发 / 上传数量（按「最近同步」记录统计） */
const sentCount = computed(() => events.value.filter((item) => item.direction === 'out').length)
const receivedCount = computed(() => events.value.filter((item) => item.direction === 'in').length)

/** 传输状态文案：未开启 / 空闲 / 正在传输 */
const transferStatusText = computed(() => {
  if (activeTransfer.value) return activeTransfer.value.outgoing ? '正在发送' : '正在接收'
  const running = mode.value === 'wifi' ? Boolean(state.value?.running) : Boolean(btStatus.value.running)
  return running ? '已连接（空闲）' : '未开启'
})

const transferPillClass = computed(() => {
  if (activeTransfer.value) return 'active'
  const running = mode.value === 'wifi' ? Boolean(state.value?.running) : Boolean(btStatus.value.running)
  return running ? 'idle' : 'off'
})

const idleTransferHint = computed(() => {
  const running = mode.value === 'wifi' ? Boolean(state.value?.running) : Boolean(btStatus.value.running)
  if (!running) return '文件同步还没开启'
  return '当前没有正在传输的文件'
})

const statusText = computed(() => {
  if (mode.value === 'wifi') {
    return running.value ? `WiFi 运行中 · ${state.value?.port ?? ''}` : 'WiFi 未开启'
  }
  if (!btStatus.value.running) return '蓝牙未开启'
  return `蓝牙已开启 · ${btStatus.value.device || '等待手机连接'}`
})

function onModeChange(): void {
  localStorage.setItem(MODE_KEY, mode.value)
}

/** 工具栏的「开启 / 停止同步」按当前连接方式走 */
async function toggleCurrent(): Promise<void> {
  if (mode.value === 'wifi') {
    await toggle()
    return
  }
  if (btStatus.value.running) {
    await stopBt()
    return
  }
  await startBt()
}

/** 取消正在传输的任务（WiFi 或蓝牙） */
async function cancelTransfer(): Promise<void> {
  try {
    const result = await window.api.sync.cancelTransfer()
    if (!result.ok) {
      ElMessage.info('当前没有正在传输的任务')
      return
    }
    state.value = state.value ? { ...state.value, transfer: null } : state.value
    ElMessage.success('已取消传输')
    await refresh()
    await refreshBtStatus()
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/** 连接 / 断开另一台电脑（PC ↔ PC） */
async function togglePeer(): Promise<void> {
  peerBusy.value = true
  try {
    if (peer.value.running) {
      peer.value = await window.api.sync.peerStop()
      ElMessage.success('已断开与对端电脑的连接')
      return
    }
    const address = peerAddress.value.trim()
    const index = address.lastIndexOf(':')
    if (index <= 0) {
      ElMessage.warning('请填写对端地址，例如 192.168.1.8:45872')
      return
    }
    const host = address.slice(0, index)
    const port = Number(address.slice(index + 1))
    if (!host || !Number.isFinite(port) || port <= 0) {
      ElMessage.warning('地址格式不对，应为 IP:端口')
      return
    }
    localStorage.setItem('devtoolbox.sync.peer', address)
    peer.value = await window.api.sync.peerStart({ host, port })
    if (!peer.value.connected) ElMessage.error(peer.value.lastError || '连接失败')
    else ElMessage.success('已连接对端电脑')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    peerBusy.value = false
  }
}

/** 取消当前的 PC ↔ PC 传输 */
async function cancelPeer(): Promise<void> {
  const result = await window.api.sync.peerCancel()
  if (result.ok) {
    peer.value = await window.api.sync.peerState()
    ElMessage.success('已取消当前传输')
  } else {
    ElMessage.info('当前没有正在传输的文件')
  }
}

/** 读取「已取消」记录 */
async function loadCancelRecords(): Promise<void> {
  try {
    cancelRecords.value = await window.api.sync.cancelledRecords()
  } catch {
    cancelRecords.value = []
  }
}

/** 清空取消记录：这些文件恢复自动同步 */
async function clearCancelled(): Promise<void> {
  const count = await window.api.sync.clearCancelledRecords()
  cancelRecords.value = []
  cancelDialog.value = false
  ElMessage.success(count > 0 ? `已恢复 ${count} 个文件的同步` : '没有需要恢复的文件')
}

async function refreshAll(): Promise<void> {
  await refresh()
  if (mode.value === 'bt') await refreshPorts()
  await refreshBtStatus()
}

async function refresh(): Promise<void> {
  try {
    const next = await window.api.sync.state()
    state.value = next
    portInput.value = next.port
  } catch (error) {
    ElMessage.error(`读取同步状态失败：${(error as Error).message}`)
  }
}

async function toggle(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    state.value = running.value ? await window.api.sync.stop() : await window.api.sync.start()
    ElMessage.success(running.value ? '同步服务已开启' : '同步服务已停止')
    if (!running.value && state.value.settings.enabled === false) {
      // 停止后端口可能已被释放，重新读一次确保状态一致
      await refresh()
    }
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    busy.value = false
  }
}

async function savePort(): Promise<void> {
  const port = Number(portInput.value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    ElMessage.warning('端口需要在 1024 - 65535 之间')
    return
  }
  busy.value = true
  try {
    state.value = await window.api.sync.save({ port })
    ElMessage.success('端口已保存')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    busy.value = false
  }
}

async function openDir(): Promise<void> {
  if (!state.value?.syncDir) return
  await window.api.app.openPath(state.value.syncDir)
}

async function removeDevice(id: string, name: string): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定移除设备「${name}」吗？下次它连上来会重新出现在列表里。`, '移除设备', {
      type: 'warning',
      confirmButtonText: '移除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  state.value = await window.api.sync.removeDevice(id)
}

async function clearEvents(): Promise<void> {
  state.value = await window.api.sync.clearEvents()
}

async function copyAddress(address: string): Promise<void> {
  const port = state.value?.port ?? portInput.value
  const ok = await copyText(`${address}:${port}`)
  if (ok) ElMessage.success('已复制连接地址')
}

/* ------------------------------ 蓝牙同步 ------------------------------ */

const serialPorts = ref<SerialPortInfo[]>([])
const btPort = ref('')
const btBusy = ref<'' | 'start'>('')
const btStatus = ref<BtSyncStatus>({ running: false, port: '', device: '', lastLog: '', received: 0, sent: 0, since: 0 })

/** 传输速度：根据两次采样估算 */
const transferSpeed = ref('')
let lastSample = { at: 0, sent: 0, path: '' }
watch(activeTransfer, (item: { path: string; sent: number } | null) => {
  if (!item) {
    transferSpeed.value = ''
    lastSample = { at: 0, sent: 0, path: '' }
    return
  }
  const now = Date.now()
  const previous = lastSample
  lastSample = { at: now, sent: item.sent, path: item.path }
  if (!previous.at || previous.path !== item.path || now - previous.at < 200) return
  const bytes = item.sent - previous.sent
  const seconds = (now - previous.at) / 1000
  if (bytes <= 0 || seconds <= 0) return
  transferSpeed.value = `${formatBytes(bytes / seconds)}/s`
})

const portLoading = ref(false)

/** 有设备但没有可用串口时，提示去系统里补一个 COM 端口 */
const missingPort = computed(
  () => serialPorts.value.length > 0 && serialPorts.value.every((item) => !item.path)
)

/** 下拉框显示：直接显示配对的设备名，串口作为右侧附注 */
function portLabel(port: SerialPortInfo): string {
  return port.name || port.device || port.path
}

/** 右侧附注：说明实际用哪个口 */
function portHint(port: SerialPortInfo): string {
  if (!port.path) return '无可用串口'
  return port.viaIncoming ? `${port.path} · 传入` : port.path
}

async function refreshPorts(): Promise<void> {
  portLoading.value = true
  try {
    serialPorts.value = await window.api.sync.serialPorts()
    const stillThere = serialPorts.value.some((item) => portKey(item) === btPort.value)
    if (!stillThere) {
      const preferred = serialPorts.value.find((item) => item.path) ?? serialPorts.value[0]
      btPort.value = preferred ? portKey(preferred) : ''
    }
  } catch (error) {
    ElMessage.error(`读取串口失败：${(error as Error).message}`)
  } finally {
    portLoading.value = false
  }
}

function portKey(port: SerialPortInfo): string {
  return port.mac || port.path || port.name
}

/** 选中的设备 → 实际要打开的串口 */
function selectedPort(): SerialPortInfo | null {
  return serialPorts.value.find((item) => portKey(item) === btPort.value) ?? null
}

async function startBt(): Promise<void> {
  const target = selectedPort()
  if (!target || !target.path || btBusy.value) {
    ElMessage.warning('先选择一台有可用串口的设备')
    return
  }
  btBusy.value = 'start'
  try {
    btStatus.value = await window.api.sync.btStart(target.path)
    if (!btStatus.value.running) {
      ElMessage.error(btStatus.value.lastLog || '蓝牙同步启动失败')
    } else {
      ElMessage.success('蓝牙同步已开启')
    }
  } catch (error) {
    ElMessage.error(`开启失败：${(error as Error).message}`)
  } finally {
    btBusy.value = ''
  }
}

async function stopBt(): Promise<void> {
  try {
    btStatus.value = await window.api.sync.btStop()
    ElMessage.success('蓝牙同步已停止')
  } catch (error) {
    ElMessage.error(`停止失败：${(error as Error).message}`)
  }
}

async function refreshBtStatus(): Promise<void> {
  try {
    btStatus.value = await window.api.sync.btStatus()
  } catch {
    // 忽略轮询错误
  }
}
function whenText(at: number): string {
  if (!at) return '-'
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return new Date(at).toLocaleDateString()
}

onMounted(() => {
  // 先注册推送订阅与计时器：不能等下面的 IO（枚举串口 / 读状态）——那些一旦慢下来，
  // 蓝牙进度就会一直不刷新（1.5.4 的真实问题就在这里）。
  stopBtStatusPush = window.api.sync.onBtStatus((next) => {
    btStatus.value = next
  })

  // PC ↔ PC 状态（含进度）
  void loadCancelRecords()

  stopPeerPush = window.api.sync.onPeerState((next) => {
    peer.value = next
  })
  void window.api.sync.peerState().then((next) => {
    peer.value = next
    if (next.host) peerAddress.value = `${next.host}:${next.port}`
  })

  stopTransferPush = window.api.sync.onTransfer((next) => {
    if (!state.value) return
    state.value = { ...state.value, transfer: next }
    // 传完立刻拉一次状态：本次数量与「最近同步」不用等 4 秒轮询
    if (!next) void refresh()
  })

  timer = window.setInterval(() => {
    if (document.hidden) return
    void refresh()
    void refreshBtStatus()
  }, 4000)

  // 蓝牙页签下每秒拉一次状态：进度更新频繁，只靠推送容易漏
  btTimer = window.setInterval(() => {
    if (document.hidden) return
    if (mode.value !== 'bt') return
    void refreshBtStatus()
  }, 1000)

  // 初始化放最后，异步进行
  void (async () => {
    loading.value = true
    await refresh()
    await refreshPorts()
    loading.value = false
    // 首次枚举偶尔会被 PowerShell 启动拖慢（拿到空结果），这里补两次
    retryTimers.push(
      window.setTimeout(() => {
        if (!serialPorts.value.length) void refreshPorts()
      }, 4000),
      window.setTimeout(() => {
        if (!serialPorts.value.length) void refreshPorts()
      }, 10000)
    )
    await refreshBtStatus()
  })()
})

onUnmounted(() => {
  if (timer) window.clearInterval(timer)
  if (btTimer) window.clearInterval(btTimer)
  for (const handle of retryTimers) window.clearTimeout(handle)
  stopTransferPush?.()
  stopTransferPush = undefined
  stopBtStatusPush?.()
  stopBtStatusPush = undefined
  stopPeerPush?.()
  stopPeerPush = undefined
})
</script>

<template>
  <div class="page sync-page">
    <div class="page-toolbar">
      <el-button
        :type="activeRunning ? 'danger' : 'primary'"
        :icon="activeRunning ? VideoPause : VideoPlay"
        :loading="busy || btBusy === 'start'"
        @click="toggleCurrent"
      >
        {{ activeRunning ? '停止同步' : '开启同步' }}
      </el-button>
      <el-button :icon="FolderOpened" @click="openDir">打开同步文件夹</el-button>
      <el-button :icon="Refresh" @click="refreshAll">刷新</el-button>

      <template v-if="mode === 'wifi'">
        <span class="small muted">端口</span>
        <el-input-number v-model="portInput" :min="1024" :max="65535" size="small" controls-position="right" style="width: 130px" />
        <el-button size="small" @click="savePort">保存端口</el-button>
      </template>

      <div class="spacer" />
      <el-tag :type="activeRunning ? 'success' : 'info'" effect="plain" size="small">
        {{ statusText }}
      </el-tag>
    </div>

    <div class="sync-main">
      <section class="panel sync-side">
        <div class="panel-header">
          <span class="panel-title">连接方式</span>
          <span class="spacer" />
          <el-button v-if="mode === 'bt'" size="small" text :loading="portLoading" @click="refreshPorts">刷新设备</el-button>
        </div>
        <div class="panel-body sync-info">
          <el-radio-group v-model="mode" size="small" class="mode-switch" @change="onModeChange">
            <el-radio-button value="wifi">WiFi / 局域网</el-radio-button>
            <el-radio-button value="bt">蓝牙</el-radio-button>
          </el-radio-group>

          <div class="info-row">
            <span class="small muted">同步文件夹</span>
            <span class="mono small path-text">{{ state?.syncDir || '-' }}</span>
          </div>
          <div class="info-row">
            <span class="small muted">文件数量</span>
            <span class="small">{{ state?.fileCount ?? 0 }} 个（清单版本 {{ state?.version || '-' }}）</span>
          </div>

          <div class="small muted">单个文件上限、同步文件夹在「应用设置 → 文件同步」里修改。</div>

          <div class="divider" />

          <!-- WiFi 连接 -->
          <template v-if="mode === 'wifi'">
            <div class="small muted">
              手机安装「录屏助手」（android-tools）后在「文件同步」里选 WiFi，填下面任意一个地址即可。
              手机与电脑需要在同一个 WiFi / 局域网内。
            </div>
            <div v-if="!addresses.length" class="small muted">没有可用的局域网地址，请检查网络连接。</div>
            <div v-for="item in addresses" :key="item.address" class="address-row">
              <span class="mono">{{ item.address }}:{{ state?.port ?? portInput }}</span>
              <span class="small muted iface">{{ item.label }}</span>
              <el-tooltip content="复制地址" placement="top">
                <button class="icon-btn" type="button" @click="copyAddress(item.address)">
                  <el-icon :size="13"><CopyDocument /></el-icon>
                </button>
              </el-tooltip>
            </div>
            <div class="small muted tips">
              <div>· 手机 → 电脑：把文件放进手机端同步文件夹，会自动发送到这里。</div>
              <div>· 电脑 → 手机：往这个文件夹里放文件 / 改文件，手机会按清单变化自动拉取。</div>
              <div>· 所有类型的文件都会同步，超过上限的会跳过。</div>
            </div>
          </template>

          <!-- 蓝牙连接 -->
          <template v-else>
            <div class="small muted">
              先在 Windows「设置 → 蓝牙和其他设备」与手机配对，选那台设备后点左上角「开启同步」即可，和 WiFi 一样自动互传。
            </div>
            <el-select v-model="btPort" size="small" placeholder="选择蓝牙设备" style="width: 100%">
              <el-option
                v-for="port in serialPorts"
                :key="portKey(port)"
                :label="portLabel(port)"
                :value="portKey(port)"
                :disabled="!port.path"
              >
                <span>{{ portLabel(port) }}</span>
                <span class="port-hint">{{ portHint(port) }}</span>
              </el-option>
            </el-select>
            <div v-if="!serialPorts.length" class="small muted">
              没有检测到已配对的蓝牙设备。先在 Windows「设置 → 蓝牙和其他设备」里配对手机。
            </div>
            <div class="small muted tips">
              <div>· 手机端「文件同步」选蓝牙，选中这台电脑后开启同步。</div>
              <div>· 电脑 → 手机 / 手机 → 电脑 都是最后写入的一方生效。</div>
            </div>
            <div v-if="missingPort" class="small bt-hint">
              设备已配对但 Windows 没给它建串口：打开「蓝牙和其他设备 → 更多蓝牙选项 → COM 端口 → 添加 → 传入」，加完点「刷新设备」。
            </div>
          </template>
        </div>
      </section>

      <section v-if="mode === 'wifi'" class="panel sync-side">
        <div class="panel-header">
          <span class="panel-title">连接另一台电脑</span>
          <span class="spacer" />
          <span class="status-pill" :class="peer.running ? (peer.connected ? 'idle' : 'active') : 'off'">
            <span class="status-dot"></span>
            {{ peer.running ? (peer.connected ? '已连接' : '连接中') : '未连接' }}
          </span>
        </div>
        <div class="panel-body sync-info">
          <el-input v-model="peerAddress" size="small" placeholder="192.168.1.8:45872" clearable />
          <el-button size="small" :type="peer.running ? 'danger' : 'primary'" :loading="peerBusy" @click="togglePeer">
            {{ peer.running ? '断开对端电脑' : '连接对端电脑' }}
          </el-button>
          <div class="small muted">对端电脑也要打开「文件同步」并点「开启同步」，两台电脑在同一网络下即可互传。</div>
          <div v-if="peer.running" class="small muted">
            对端 {{ peer.remoteCount }} 个文件 · 已接收 {{ peer.downloaded }} 个 · 已发送 {{ peer.uploaded }} 个
          </div>
          <div v-if="peer.lastError" class="small" style="color: var(--el-color-danger)">{{ peer.lastError }}</div>
          <template v-if="peer.transfer">
            <div class="transfer-head">
              <el-tag size="small" :type="peer.transfer.outgoing ? 'primary' : 'success'" effect="plain">
                {{ peer.transfer.outgoing ? '发送' : '接收' }}
              </el-tag>
              <span class="transfer-path" :title="peer.transfer.path">{{ peer.transfer.path }}</span>
            </div>
            <el-progress
              :percentage="peer.transfer.total ? Math.min(100, Math.round((peer.transfer.sent / peer.transfer.total) * 100)) : 0"
              :stroke-width="8"
            />
            <div class="transfer-meta small muted">
              <span>{{ formatBytes(peer.transfer.sent) }} / {{ formatBytes(peer.transfer.total) }}</span>
              <el-button size="small" type="danger" plain @click="cancelPeer">取消</el-button>
            </div>
          </template>
        </div>
      </section>

      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">连接状态</span>
          <span class="spacer" />
          <span class="small muted">{{ mode === 'wifi' ? `${devices.length} 台` : btStatus.running ? '已连接' : '未连接' }}</span>
        </div>
        <div class="panel-body device-body">
          <div class="transfer-card">
            <div class="transfer-card-head">
              <span class="panel-title">传输状态</span>
              <span class="spacer" />
              <span class="status-pill" :class="transferPillClass">
                <span class="status-dot"></span>
                {{ transferStatusText }}
              </span>
            </div>
            <template v-if="activeTransfer">
              <div class="transfer-head">
                <el-tag size="small" :type="activeTransfer.outgoing ? 'primary' : 'success'" effect="plain">
                  {{ activeTransfer.outgoing ? '发送' : '接收' }}
                </el-tag>
                <span class="transfer-path" :title="activeTransfer.path">{{ activeTransfer.path }}</span>
                <el-button size="small" type="danger" plain @click="cancelTransfer">取消</el-button>
              </div>
              <el-progress
                :percentage="transferPercent"
                :stroke-width="8"
                :status="transferPercent >= 100 ? 'success' : undefined"
              />
              <div class="transfer-meta small muted">
                <span>{{ formatBytes(activeTransfer.sent) }} / {{ formatBytes(activeTransfer.total) }}</span>
                <span v-if="transferSpeed">{{ transferSpeed }}</span>
                <span>本次已发送 {{ sentCount }} 个 · 已接收 {{ receivedCount }} 个</span>
              </div>
            </template>
            <div v-else class="transfer-empty small muted">
              <span>{{ idleTransferHint }}</span>
              <span>本次已发送 {{ sentCount }} 个 · 已接收 {{ receivedCount }} 个</span>
            </div>
          </div>
          <template v-if="mode === 'wifi'">
            <div v-if="!devices.length" class="placeholder-box">
              <el-icon :size="26"><Connection /></el-icon>
              <span>还没有设备连接</span>
              <span class="small muted">手机端连上来之后会出现在这里</span>
            </div>
            <div v-for="device in devices" :key="device.id" class="device-row">
              <div class="device-avatar">{{ (device.name || 'D').slice(0, 1) }}</div>
              <div class="device-main">
                <div class="device-name">
                  {{ device.name }}
                  <el-tag size="small" effect="plain" type="info">{{ device.platform }}</el-tag>
                </div>
                <div class="small muted">
                  {{ device.ip }}:{{ device.port || '-' }} · 最近联系 {{ whenText(device.lastSeenAt) }}
                  · 已同步 {{ device.filesSynced }} 个文件
                </div>
              </div>
              <el-tooltip content="移除设备" placement="top">
                <button class="icon-btn" type="button" @click="removeDevice(device.id, device.name)">
                  <el-icon :size="14"><Delete /></el-icon>
                </button>
              </el-tooltip>
            </div>
          </template>

          <template v-else>
            <div v-if="!btStatus.running" class="placeholder-box">
              <el-icon :size="26"><Connection /></el-icon>
              <span>蓝牙同步未开启</span>
              <span class="small muted">在上面的「连接方式」里选好设备，再点「开启同步」</span>
            </div>
            <div v-else class="device-row">
              <div class="device-avatar">{{ (btStatus.device || '蓝').slice(0, 1) }}</div>
              <div class="device-main">
                <div class="device-name">
                  {{ btStatus.device || '等待手机连接' }}
                  <el-tag size="small" effect="plain" type="info">蓝牙</el-tag>
                </div>
                <div class="small muted">
                  {{ btStatus.port || '未选设备' }} · 已发送 {{ btStatus.sent }} 个 · 已接收 {{ btStatus.received }} 个
                </div>
                <div v-if="btStatus.lastLog" class="small muted">{{ btStatus.lastLog }}</div>
              </div>
            </div>
          </template>
        </div>
      </section>



      <section class="panel sync-side">
        <div class="panel-header">
          <span class="panel-title">最近同步</span>
          <el-button v-if="cancelRecords.length" size="small" text @click="cancelDialog = true">
            已取消 {{ cancelRecords.length }}
          </el-button>
          <span class="spacer" />
          <el-button size="small" text :disabled="!events.length" @click="clearEvents">清空</el-button>
        </div>
        <div class="panel-body event-body">
          <div v-if="!events.length" class="small muted event-empty">还没有同步记录</div>
          <div v-for="(event, index) in events" :key="`${event.at}-${index}`" class="event-row">
            <el-tag size="small" :type="event.direction === 'in' ? 'success' : 'primary'" effect="plain">
              {{ event.direction === 'in' ? '接收' : '发送' }}
            </el-tag>
            <div class="event-main">
              <div class="event-path mono">{{ event.path }}</div>
              <div class="small muted">{{ event.device }} · {{ formatBytes(event.size) }} · {{ whenText(event.at) }}</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>

    <el-dialog v-model="cancelDialog" title="已取消的文件" width="540px">
      <div class="muted small" style="margin-bottom: 8px">
        这些文件取消过传输，不会再自动同步。文件内容变化后会自动恢复，也可以在这里一次性恢复。
      </div>
      <div class="cancel-list">
        <div v-for="item in cancelRecords" :key="item.path" class="cancel-row" :title="item.path">
          {{ item.path }}
        </div>
      </div>
      <template #footer>
        <el-button @click="cancelDialog = false">关闭</el-button>
        <el-button type="primary" @click="clearCancelled">清空并恢复同步</el-button>
      </template>
    </el-dialog>
</template>

<style scoped>
.sync-page {
  gap: 12px;
}

.sync-main {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}

.sync-side {
  flex: 0 0 280px;
  min-width: 250px;
}

.sync-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  overflow: auto;
}

.info-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.path-text {
  word-break: break-all;
  line-height: 1.5;
}

.divider {
  height: 1px;
  background: var(--app-border);
  margin: 4px 0;
}

.address-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-panel-muted);
}

.iface {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tips {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.6;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-panel);
  color: var(--app-text-2);
  cursor: pointer;
}

.icon-btn:hover {
  color: var(--app-primary);
  border-color: var(--app-primary);
}

.transfer-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  border-radius: 10px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
}

.transfer-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.transfer-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.transfer-empty {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.transfer-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.transfer-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.transfer-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  background: var(--el-fill-color-light);
  color: var(--el-text-color-regular);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--el-color-info);
}

.status-pill.active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.status-pill.active .status-dot {
  background: var(--el-color-primary);
}

.status-pill.idle .status-dot {
  background: var(--el-color-success);
}

.device-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
}

.device-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-muted);
}

.device-avatar {
  width: 34px;
  height: 34px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  background: linear-gradient(135deg, #4f8cff, #6f5bff);
  color: #fff;
  font-weight: 600;
}

.device-main {
  flex: 1;
  min-width: 0;
}

.device-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
}

.event-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
}

.event-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px dashed var(--app-border);
}

.event-row:last-child {
  border-bottom: none;
}

.event-main {
  min-width: 0;
  flex: 1;
}

.event-path {
  font-size: 12px;
  word-break: break-all;
}

.event-empty {
  padding: 12px 0;
}
.bt-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.bt-ok {
  color: #16a34a;
}

.bt-fail {
  color: #dc2626;
}
.port-hint {
  float: right;
  color: var(--app-text-3);
  font-size: 11px;
  margin-left: 12px;
}
.bt-hint {
  padding: 6px 8px;
  border: 1px dashed rgba(217, 119, 6, 0.5);
  border-radius: 6px;
  background: rgba(245, 158, 11, 0.1);
  color: #b45309;
  line-height: 1.6;
}
.bt-status {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel-2);
}

.bt-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  background: #9ca3af;
}

.bt-dot.on {
  background: #16a34a;
}
.mode-switch {
  width: 100%;
  display: flex;
}

.mode-switch :deep(.el-radio-button) {
  flex: 1;
}

.mode-switch :deep(.el-radio-button__inner) {
  width: 100%;
}
.cancel-list {
  max-height: 280px;
  overflow-y: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 6px 8px;
}

.cancel-row {
  font-size: 12px;
  line-height: 1.8;
  color: var(--el-text-color-regular);
  word-break: break-all;
}

</style>
