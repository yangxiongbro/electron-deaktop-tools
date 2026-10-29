<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  CopyDocument,
  Download,
  FolderOpened,
  Promotion,
  Refresh,
  VideoPause
} from '@element-plus/icons-vue'
import type {
  AuthType,
  BodyType,
  FormRow,
  HttpAuthConfig,
  HttpBodyConfig,
  HttpMethod,
  HttpOptions,
  HttpResponseResult,
  KeyValueRow,
  ResponseMode
} from '@shared/types'
import KeyValueEditor from '../components/KeyValueEditor.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import JsonTree from '../components/JsonTree.vue'
import { copyText } from '../utils/clipboard'
import { formatBytes, formatDuration, randomId } from '../utils/format'
import { buildHttpRequestConfig } from '../utils/http'

interface RequestState {
  method: HttpMethod
  url: string
  params: KeyValueRow[]
  headers: KeyValueRow[]
  auth: HttpAuthConfig
  body: HttpBodyConfig
  options: Pick<HttpOptions, 'timeoutMs' | 'followRedirects' | 'ignoreTlsErrors' | 'responseMode'>
}

const STORAGE_KEY = 'devtoolbox.api.state.v1'
const MAX_DISPLAY_BYTES = 5 * 1024 * 1024
const TREE_LIMIT = 1024 * 1024

const METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const BODY_TYPES: { label: string; value: BodyType }[] = [
  { label: 'none', value: 'none' },
  { label: 'JSON', value: 'json' },
  { label: 'Text', value: 'text' },
  { label: 'XML', value: 'xml' },
  { label: 'form-urlencoded', value: 'form-urlencoded' },
  { label: 'form-data', value: 'form-data' },
  { label: 'binary', value: 'binary' }
]
const AUTH_TYPES: { label: string; value: AuthType }[] = [
  { label: '无鉴权', value: 'none' },
  { label: 'Bearer Token', value: 'bearer' },
  { label: 'Basic Auth', value: 'basic' },
  { label: 'API Key', value: 'api-key' }
]
const RESPONSE_MODES = [
  { label: '直接展示', value: 'display' },
  { label: '保存到文件', value: 'file' }
]

const newRow = (key = '', value = '', enabled = true): KeyValueRow => ({ id: randomId(), key, value, enabled })
const newFormRow = (kind: 'text' | 'file' = 'text'): FormRow => ({
  id: randomId(),
  enabled: true,
  kind,
  key: '',
  value: '',
  filePath: ''
})

function defaultState(): RequestState {
  return {
    method: 'GET',
    url: '',
    params: [newRow()],
    headers: [newRow()],
    auth: {
      type: 'none',
      token: '',
      username: '',
      password: '',
      keyName: '',
      keyValue: '',
      addTo: 'header'
    },
    body: { type: 'none', raw: '', contentType: '', form: [newFormRow()], filePath: '' },
    options: { timeoutMs: 30000, followRedirects: true, ignoreTlsErrors: false, responseMode: 'display' }
  }
}

function loadState(): RequestState {
  const fallback = defaultState()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<RequestState>
    return {
      ...fallback,
      ...parsed,
      auth: { ...fallback.auth, ...(parsed.auth ?? {}) },
      body: { ...fallback.body, ...(parsed.body ?? {}) },
      options: { ...fallback.options, ...(parsed.options ?? {}) },
      params: Array.isArray(parsed.params) && parsed.params.length ? parsed.params : fallback.params,
      headers: Array.isArray(parsed.headers) && parsed.headers.length ? parsed.headers : fallback.headers
    }
  } catch {
    return fallback
  }
}

const state = reactive<RequestState>(loadState())
const requestTab = ref('params')
const responseTab = ref('body')
const bodyView = ref<'pretty' | 'tree'>('pretty')
const sending = ref(false)
const progress = ref(0)
const activeRequestId = ref('')
const response = ref<HttpResponseResult | null>(null)
const sentRequest = shallowRef<{ method: string; url: string; headers: KeyValueRow[] } | null>(null)

const methodColor = computed(() => {
  const map: Record<string, string> = {
    GET: '#22a06b',
    POST: '#2f6fed',
    PUT: '#d97706',
    PATCH: '#8b5cf6',
    DELETE: '#dc2626',
    HEAD: '#0891b2',
    OPTIONS: '#64748b'
  }
  return map[state.method] ?? '#64748b'
})

const statusType = computed<'success' | 'info' | 'warning' | 'danger'>(() => {
  const status = response.value?.status ?? 0
  if (!status) return 'info'
  if (status < 300) return 'success'
  if (status < 400) return 'info'
  if (status < 500) return 'warning'
  return 'danger'
})

const prettyBody = computed<{ text: string; isJson: boolean; data: unknown }>(() => {
  const raw = response.value?.bodyText ?? ''
  if (!raw) return { text: '', isJson: false, data: undefined }
  const trimmed = raw.trim()
  const contentType = response.value?.contentType ?? ''
  if (contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const data = JSON.parse(trimmed) as unknown
      return { text: JSON.stringify(data, null, 2), isJson: true, data }
    } catch {
      return { text: raw, isJson: false, data: undefined }
    }
  }
  return { text: raw, isJson: false, data: undefined }
})

const canShowTree = computed(() => prettyBody.value.isJson && prettyBody.value.text.length < TREE_LIMIT)

const hasResponse = computed(() => response.value !== null)

let saveTimer: number | undefined
watch(
  state,
  () => {
    if (saveTimer) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
      } catch {
        // 忽略持久化失败
      }
    }, 400)
  },
  { deep: true }
)

function suggestFileName(): string {
  const raw = state.url.trim()
  if (!raw) return 'response.txt'
  try {
    const url = new URL(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw) ? raw : `http://${raw}`)
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
  } catch {
    // 忽略
  }
  return 'response.txt'
}

async function send(): Promise<void> {
  if (sending.value) return
  if (!state.url.trim()) {
    ElMessage.warning('请先填写请求地址')
    return
  }

  let outputPath = ''
  if (state.options.responseMode === 'file') {
    const pick = await window.api.dialog.saveFile({
      title: '响应内容保存到',
      defaultFileName: suggestFileName()
    })
    if (pick.canceled || !pick.filePath) return
    outputPath = pick.filePath
  }

  const requestId = randomId()
  activeRequestId.value = requestId
  sending.value = true
  progress.value = 0
  response.value = null
  sentRequest.value = { method: state.method, url: state.url, headers: state.headers.map((row) => ({ ...row })) }

  try {
    const result = await window.api.http.request(
      buildHttpRequestConfig(state, requestId, outputPath, MAX_DISPLAY_BYTES)
    )
    response.value = result
    progress.value = 100
    if (result.error) {
      ElMessage.error(result.error)
    } else if ((result.status ?? 0) >= 400) {
      ElMessage.warning(`请求已返回 ${result.status} ${result.statusText ?? ''}`)
    } else {
      ElMessage.success(`请求成功（${result.status}），耗时 ${formatDuration(result.durationMs)}`)
    }
  } catch (error) {
    response.value = {
      ok: false,
      requestId,
      size: 0,
      durationMs: 0,
      error: (error as Error).message
    }
    ElMessage.error((error as Error).message)
  } finally {
    sending.value = false
    activeRequestId.value = ''
  }
}

async function abort(): Promise<void> {
  if (!activeRequestId.value) return
  await window.api.http.abort(activeRequestId.value)
}

async function copyResponseBody(): Promise<void> {
  const text = prettyBody.value.text || response.value?.bodyText || ''
  if (!text) return
  const ok = await copyText(text)
  if (ok) ElMessage.success('已复制响应内容')
  else ElMessage.error('复制失败')
}

async function saveResponseBody(): Promise<void> {
  const text = response.value?.bodyText
  if (!text) return
  if (response.value?.bodyTruncated) {
    ElMessage.warning('当前响应内容已被截断，请把「响应处理」切换为「保存到文件」后重新发送')
    return
  }
  const pick = await window.api.dialog.saveFile({ title: '保存响应内容', defaultFileName: suggestFileName() })
  if (pick.canceled || !pick.filePath) return
  const write = await window.api.file.writeText(pick.filePath, text)
  if (write.ok) {
    ElMessage.success('已保存到文件')
    await window.api.app.showItemInFolder(pick.filePath)
  } else {
    ElMessage.error(write.error ?? '保存失败')
  }
}

async function pickBodyFile(): Promise<void> {
  const pick = await window.api.dialog.openFile({ title: '选择要上传的文件' })
  if (pick.canceled || !pick.filePath) return
  state.body.filePath = pick.filePath
}

async function pickFormFile(row: FormRow): Promise<void> {
  const pick = await window.api.dialog.openFile({ title: '选择要上传的文件' })
  if (pick.canceled || !pick.filePath) return
  row.filePath = pick.filePath
  if (!row.key) row.key = pick.fileName ?? 'file'
}

function addFormRow(): void {
  state.body.form.push(newFormRow('text'))
}

function removeFormRow(id: string): void {
  state.body.form = state.body.form.filter((row) => row.id !== id)
}

function toggleFormKind(row: FormRow): void {
  row.kind = row.kind === 'text' ? 'file' : 'text'
  if (row.kind === 'text') row.filePath = ''
}

function resetRequest(): void {
  const fresh = defaultState()
  Object.assign(state, fresh)
  response.value = null
  sentRequest.value = null
}

function openSavedFile(): void {
  const target = response.value?.bodyPath
  if (target) void window.api.app.showItemInFolder(target)
}

let progressUnsubscribe: (() => void) | undefined
onMounted(() => {
  progressUnsubscribe = window.api.http.onProgress((payload) => {
    if (payload.requestId !== activeRequestId.value) return
    progress.value = payload.total > 0 ? Math.min(99, Math.round((payload.loaded / payload.total) * 100)) : 0
  })
})
onUnmounted(() => progressUnsubscribe?.())

const currentBodyType = computed(() => state.body.type)
const showRawEditor = computed(() => ['json', 'text', 'xml'].includes(state.body.type))
const showFormEditor = computed(() => ['form-urlencoded', 'form-data'].includes(state.body.type))
</script>

<template>
  <div class="page api-page">
    <div class="url-bar">
      <el-select v-model="state.method" class="method-select" :style="{ color: methodColor }">
        <el-option v-for="method in METHODS" :key="method" :label="method" :value="method" />
      </el-select>
      <el-input
        v-model="state.url"
        class="url-input"
        placeholder="请输入请求地址，例如 https://httpbin.org/get"
        clearable
        @keydown.enter="send"
      />
      <el-button v-if="!sending" type="primary" :icon="Promotion" class="send-btn" @click="send">发送</el-button>
      <el-button v-else type="danger" :icon="VideoPause" class="send-btn" @click="abort">取消</el-button>
      <el-button :icon="Refresh" @click="resetRequest">重置</el-button>
    </div>

    <el-progress v-if="sending && progress > 0" :percentage="progress" :stroke-width="4" :show-text="false" class="send-progress" />

    <section class="panel request-panel">
      <el-tabs v-model="requestTab" class="request-tabs">
        <el-tab-pane name="params">
          <template #label>
            <span>参数</span>
            <span class="tab-badge">{{ state.params.filter((row) => row.enabled && row.key).length }}</span>
          </template>
          <KeyValueEditor v-model="state.params" key-placeholder="参数名" value-placeholder="参数值" />
        </el-tab-pane>

        <el-tab-pane name="headers">
          <template #label>
            <span>请求头</span>
            <span class="tab-badge">{{ state.headers.filter((row) => row.enabled && row.key).length }}</span>
          </template>
          <KeyValueEditor v-model="state.headers" key-placeholder="Header 名称" value-placeholder="Header 值" />
        </el-tab-pane>

        <el-tab-pane label="鉴权" name="auth">
          <div class="auth-form">
            <div class="form-row">
              <span class="form-label">鉴权方式</span>
              <el-select v-model="state.auth.type" style="width: 200px">
                <el-option v-for="item in AUTH_TYPES" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </div>

            <template v-if="state.auth.type === 'bearer'">
              <div class="form-row">
                <span class="form-label">Token</span>
                <el-input v-model="state.auth.token" placeholder="粘贴 Bearer Token" show-password />
              </div>
              <div class="small muted form-tip">发送时会自动附加请求头 Authorization: Bearer &lt;token&gt;</div>
            </template>

            <template v-else-if="state.auth.type === 'basic'">
              <div class="form-row">
                <span class="form-label">用户名</span>
                <el-input v-model="state.auth.username" placeholder="Username" />
              </div>
              <div class="form-row">
                <span class="form-label">密码</span>
                <el-input v-model="state.auth.password" type="password" show-password placeholder="Password" />
              </div>
            </template>

            <template v-else-if="state.auth.type === 'api-key'">
              <div class="form-row">
                <span class="form-label">参数名</span>
                <el-input v-model="state.auth.keyName" placeholder="例如 X-API-KEY" style="width: 260px" />
                <span class="form-label">参数值</span>
                <el-input v-model="state.auth.keyValue" placeholder="API Key" show-password style="width: 260px" />
              </div>
              <div class="form-row">
                <span class="form-label">添加位置</span>
                <SegmentedControl
                  :model-value="state.auth.addTo"
                  :options="[
                    { label: '请求头', value: 'header' },
                    { label: '查询参数', value: 'query' }
                  ]"
                  size="small"
                  @update:model-value="(value) => (state.auth.addTo = value === 'query' ? 'query' : 'header')"
                />
              </div>
            </template>

            <div v-else class="small muted">当前请求不附加鉴权信息。</div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="请求体" name="body">
          <div class="body-form">
            <div class="form-row">
              <span class="form-label">类型</span>
              <el-select v-model="state.body.type" style="width: 200px">
                <el-option v-for="item in BODY_TYPES" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
              <template v-if="currentBodyType !== 'none'">
                <span class="form-label">Content-Type</span>
                <el-input
                  v-model="state.body.contentType"
                  placeholder="留空则自动推断"
                  style="width: 280px"
                />
              </template>
            </div>

            <template v-if="showRawEditor">
              <el-input
                v-model="state.body.raw"
                type="textarea"
                :rows="7"
                resize="none"
                class="body-raw mono"
                :placeholder="
                  state.body.type === 'json'
                    ? '{&quot;name&quot;: &quot;devtoolbox&quot;}'
                    : state.body.type === 'xml'
                      ? '&lt;root&gt;&lt;/root&gt;'
                      : '纯文本内容'
                "
              />
            </template>

            <template v-else-if="showFormEditor">
              <div v-if="state.body.form.length === 0" class="small muted">暂无字段</div>
              <div v-for="row in state.body.form" :key="row.id" class="form-data-row">
                <el-checkbox v-model="row.enabled" />
                <el-input v-model="row.key" size="small" placeholder="字段名" style="width: 220px" />
                <template v-if="row.kind === 'file'">
                  <el-input :model-value="row.filePath" size="small" readonly placeholder="未选择文件" class="flex-1" />
                  <el-button size="small" :icon="FolderOpened" @click="pickFormFile(row)">选择</el-button>
                </template>
                <el-input v-else v-model="row.value" size="small" placeholder="字段值" class="flex-1" />
                <el-button size="small" text @click="toggleFormKind(row)">
                  {{ row.kind === 'file' ? '改为文本' : '改为文件' }}
                </el-button>
                <el-button size="small" text type="danger" @click="removeFormRow(row.id)">删除</el-button>
              </div>
              <el-button size="small" text type="primary" @click="addFormRow">+ 添加字段</el-button>
            </template>

            <template v-else-if="currentBodyType === 'binary'">
              <div class="form-row">
                <span class="form-label">文件</span>
                <el-input :model-value="state.body.filePath" readonly placeholder="选择要作为请求体的文件" class="flex-1" />
                <el-button :icon="FolderOpened" @click="pickBodyFile">选择文件</el-button>
              </div>
            </template>

            <div v-else class="small muted">该请求不携带请求体。</div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="选项" name="options">
          <div class="options-form">
            <div class="form-row">
              <span class="form-label">超时时间</span>
              <el-input-number v-model="state.options.timeoutMs" :min="1000" :max="600000" :step="1000" controls-position="right" />
              <span class="small muted">毫秒</span>
            </div>
            <div class="form-row">
              <span class="form-label">跟随重定向</span>
              <el-switch v-model="state.options.followRedirects" />
              <span class="form-label" style="margin-left: 24px">忽略证书错误</span>
              <el-switch v-model="state.options.ignoreTlsErrors" />
            </div>
            <div class="form-row">
              <span class="form-label">响应处理</span>
              <SegmentedControl
                :model-value="state.options.responseMode"
                :options="RESPONSE_MODES"
                size="small"
                @update:model-value="(value) => (state.options.responseMode = value as ResponseMode)"
              />
              <span class="small muted">
                {{
                  state.options.responseMode === 'file'
                    ? '发送前选择保存路径，响应直接写入文件'
                    : `响应内容最多展示 ${formatBytes(MAX_DISPLAY_BYTES)}`
                }}
              </span>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </section>

    <section class="panel response-panel">
      <div class="panel-header response-head">
        <span class="panel-title">响应</span>
        <template v-if="response">
          <span v-if="response.status" class="status-pill" :class="`is-${statusType}`">
            {{ response.status }} {{ response.statusText }}
          </span>
          <span class="small muted">耗时 {{ formatDuration(response.durationMs) }}</span>
          <span class="small muted">大小 {{ formatBytes(response.size) }}</span>
          <span v-if="response.contentType" class="small muted type-text">{{ response.contentType }}</span>
        </template>
        <span class="spacer" />
        <el-button
          v-if="response?.bodyPath"
          size="small"
          :icon="FolderOpened"
          @click="openSavedFile"
        >
          打开所在目录
        </el-button>
        <el-button
          v-if="response?.bodyText"
          size="small"
          :icon="Download"
          @click="saveResponseBody"
        >
          保存响应
        </el-button>
        <el-button
          v-if="response?.bodyText"
          size="small"
          :icon="CopyDocument"
          @click="copyResponseBody"
        >
          复制
        </el-button>
      </div>

      <el-tabs v-if="hasResponse" v-model="responseTab" class="response-tabs">
        <el-tab-pane label="响应体" name="body">
          <div v-if="response?.error" class="response-body">
            <el-alert type="error" :closable="false" show-icon :title="response.error" />
          </div>
          <div v-else-if="response?.bodyPath" class="response-body">
            <el-alert type="success" :closable="false" show-icon title="响应已保存到文件">
              <div class="mono small">{{ response.bodyPath }}</div>
            </el-alert>
          </div>
          <div v-else-if="response?.bodyText" class="response-body">
            <div class="body-toolbar">
              <SegmentedControl
                v-if="canShowTree"
                v-model="bodyView"
                :options="[
                  { label: '格式化', value: 'pretty' },
                  { label: '树形', value: 'tree' }
                ]"
                size="small"
              />
              <span v-if="response.bodyTruncated" class="small warning-text">
                响应内容过大，仅展示前 {{ formatBytes(MAX_DISPLAY_BYTES) }}
              </span>
              <span class="spacer" />
              <span class="small muted">{{ response.bodyText.length.toLocaleString() }} 字符</span>
            </div>
            <JsonTree
              v-if="bodyView === 'tree' && canShowTree"
              :data="prettyBody.data"
              :expand-depth="2"
              class="response-tree"
            />
            <pre v-else class="code-block response-code">{{ prettyBody.text }}</pre>
          </div>
          <div v-else class="placeholder-box">
            <span>响应体为空</span>
          </div>
        </el-tab-pane>

        <el-tab-pane label="响应头" name="headers">
          <div class="response-body padded">
            <div v-for="(header, index) in response?.headers ?? []" :key="index" class="header-row">
              <span class="header-name mono">{{ header.name }}</span>
              <span class="header-value mono">{{ header.value }}</span>
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="请求详情" name="request">
          <div class="response-body padded">
            <div class="detail-row">
              <span class="detail-label">请求方法</span>
              <span class="mono">{{ sentRequest?.method }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">最终地址</span>
              <span class="mono wrap">{{ response?.finalUrl || sentRequest?.url }}</span>
            </div>
            <div class="detail-label" style="margin-top: 10px">已配置的请求头</div>
            <div v-for="row in (sentRequest?.headers ?? []).filter((item) => item.enabled && item.key)" :key="row.id" class="header-row">
              <span class="header-name mono">{{ row.key }}</span>
              <span class="header-value mono">{{ row.value }}</span>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>

      <div v-else class="placeholder-box response-empty">
        <el-icon :size="28"><Promotion /></el-icon>
        <span>填写地址后点击「发送」，响应会显示在这里</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.api-page {
  gap: 10px;
}

.url-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.method-select {
  width: 112px;
  flex: none;
}

.method-select :deep(.el-select__selected-item) {
  font-weight: 700;
  font-family: var(--app-mono);
}

.url-input {
  flex: 1;
  min-width: 0;
}

.send-btn {
  width: 92px;
  flex: none;
}

.send-progress {
  flex: none;
}

.request-panel {
  flex: none;
  height: 288px;
}

.request-tabs {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.request-tabs :deep(.el-tabs__header) {
  flex: none;
  margin: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.request-tabs :deep(.el-tabs__nav-wrap::after) {
  display: none;
}

.request-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}

.request-tabs :deep(.el-tab-pane) {
  height: 100%;
}

.tab-badge {
  display: inline-block;
  margin-left: 4px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--app-primary-soft);
  color: var(--app-primary);
  font-size: 11px;
  line-height: 15px;
}

.form-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.form-label {
  width: 84px;
  flex: none;
  font-size: 13px;
  color: var(--app-text-2);
}

.form-tip {
  margin-top: -4px;
  margin-bottom: 8px;
}

.options-form,
.body-form,
.auth-form {
  display: flex;
  flex-direction: column;
}

.body-raw :deep(.el-textarea__inner) {
  font-family: var(--app-mono);
  font-size: 13px;
}

.form-data-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.response-panel {
  flex: 1;
  min-height: 0;
}

.response-head {
  gap: 12px;
}

.type-text {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 10px;
  border-radius: 11px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  letter-spacing: 0.2px;
  flex: none;
}

.status-pill.is-success {
  background: #16a34a;
}

.status-pill.is-info {
  background: #0891b2;
}

.status-pill.is-warning {
  background: #d97706;
}

.status-pill.is-danger {
  background: #dc2626;
}

.response-tabs {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.response-tabs :deep(.el-tabs__header) {
  flex: none;
  margin: 0;
  padding: 0 12px;
  border-bottom: 1px solid var(--app-border);
}

.response-tabs :deep(.el-tabs__nav-wrap::after) {
  display: none;
}

.response-tabs :deep(.el-tabs__content) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.response-tabs :deep(.el-tab-pane) {
  height: 100%;
}

.response-body {
  height: 100%;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.response-body.padded {
  padding: 12px;
}

.body-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--app-border);
  flex: none;
}

.response-code {
  flex: 1;
  min-height: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.response-tree {
  padding: 10px 4px;
  overflow: auto;
  flex: 1;
}

.response-empty {
  flex: 1;
}

.header-row {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--app-border);
  font-size: 12.5px;
}

.header-name {
  width: 240px;
  flex: none;
  color: var(--app-text-2);
  word-break: break-all;
}

.header-value {
  flex: 1;
  word-break: break-all;
  color: var(--app-text);
}

.detail-row {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  font-size: 12.5px;
}

.detail-label {
  width: 84px;
  flex: none;
  color: var(--app-text-3);
}

.wrap {
  word-break: break-all;
}

.warning-text {
  color: #d97706;
}
</style>
