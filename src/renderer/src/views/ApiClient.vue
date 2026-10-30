<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowDown,
  Check,
  CopyDocument,
  Delete,
  DocumentAdd,
  Download,
  EditPen,
  FolderOpened,
  Plus,
  Promotion,
  Refresh,
  Setting,
  Upload,
  VideoPause
} from '@element-plus/icons-vue'
import { DEFAULT_CONTENT_TYPES } from '@shared/types'
import type {
  ApiAttemptResult,
  ApiProject,
  ApiRequestDraft,
  ApiRequestRecord,
  AuthType,
  BodyType,
  FormRow,
  HttpAuthConfig,
  HttpBodyConfig,
  HttpMethod,
  HttpResponseResult,
  KeyValueRow,
  ResponseMode
} from '@shared/types'
import KeyValueEditor from '../components/KeyValueEditor.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import JsonTree from '../components/JsonTree.vue'
import ApiRequestList from '../components/ApiRequestList.vue'
import { setApiContentTypes, setApiSidebarCollapsed, useSettings } from '../stores/settings'
import { copyText } from '../utils/clipboard'
import { formatBytes, formatDuration, randomId } from '../utils/format'
import { baseUrlOf, buildHttpRequestConfig } from '../utils/http'
import type { SegmentOption } from '../components/segment'

interface RequestForm {
  method: HttpMethod
  url: string
  params: KeyValueRow[]
  headers: KeyValueRow[]
  auth: HttpAuthConfig
  body: HttpBodyConfig
  options: {
    timeoutMs: number
    followRedirects: boolean
    ignoreTlsErrors: boolean
    responseMode: ResponseMode
  }
}

/** 记住上次选中的项目 / 请求，下次打开直接回到现场 */
const SELECTION_KEY = 'devtoolbox.api.selection.v2'
/** 旧版本把单个草稿存在 localStorage，这里顺手清理 */
const LEGACY_STATE_KEY = 'devtoolbox.api.state.v1'

const MAX_DISPLAY_BYTES = 5 * 1024 * 1024
const TREE_LIMIT = 1024 * 1024
/** 停止输入后多久自动保存到数据文件（仅在开启自动保存时生效） */
const AUTOSAVE_DELAY = 600

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
const RESPONSE_SECTIONS: SegmentOption[] = [
  { label: '响应体', value: 'body' },
  { label: '响应头', value: 'headers' },
  { label: '请求详情', value: 'request' }
]

const { settings } = useSettings()

const newRow = (key = '', value = '', enabled = true): KeyValueRow => ({ id: randomId(), key, value, enabled })
const newFormRow = (kind: 'text' | 'file' = 'text'): FormRow => ({
  id: randomId(),
  enabled: true,
  kind,
  key: '',
  value: '',
  filePath: ''
})

/** 新请求默认带上常用的通用请求头，省得每次手填 */
function defaultHeaders(): KeyValueRow[] {
  return [
    newRow('Accept', 'application/json, text/plain, */*'),
    newRow('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.8'),
    newRow('User-Agent', 'DevToolbox (+Electron)'),
    newRow('Connection', 'keep-alive')
  ]
}

function defaultForm(): RequestForm {
  return {
    method: 'GET',
    url: '',
    params: [newRow()],
    headers: defaultHeaders(),
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

/* ------------------------------ 界面状态 ------------------------------ */

const projects = ref<ApiProject[]>([])
const dataFile = ref('')
const currentProjectId = ref('')
const currentRequestId = ref('')
const draftName = ref('')

const state = reactive<RequestForm>(defaultForm())
const loading = ref(true)
const dirty = ref(false)
const saveError = ref('')
const lastSavedAt = ref(0)
const pendingSaves = ref(0)

const requestTab = ref('params')
const responseSection = ref('body')
const bodyView = ref<'pretty' | 'tree'>('pretty')
const sending = ref(false)
const progress = ref(0)
const activeRequestId = ref('')
const response = ref<HttpResponseResult | null>(null)
const sentRequest = shallowRef<{ method: string; url: string; headers: KeyValueRow[] } | null>(null)

const contentTypeDialog = ref(false)
const newContentType = ref('')

const listCollapsed = computed(() => settings.apiSidebarCollapsed)
const autoSaveEnabled = computed(() => settings.apiAutoSave)

const currentProject = computed(() => projects.value.find((item) => item.id === currentProjectId.value) ?? null)
const currentRequests = computed(() => currentProject.value?.requests ?? [])
const currentRecord = computed(
  () => currentRequests.value.find((item) => item.id === currentRequestId.value) ?? null
)
const saving = computed(() => pendingSaves.value > 0)

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
const currentBodyType = computed(() => state.body.type)
const showRawEditor = computed(() => ['json', 'text', 'xml'].includes(state.body.type))
const showFormEditor = computed(() => ['form-urlencoded', 'form-data'].includes(state.body.type))

/** 响应是不是二进制（图片 / 压缩包 / office 文档等），需要导出而不是展示 */
const isBinaryResponse = computed(() => Boolean(response.value?.binary && response.value?.bodyBase64))
const canSaveResponse = computed(() => {
  const current = response.value
  if (!current) return false
  return Boolean(current.bodyText || current.bodyBase64 || current.bodyPath)
})
const imagePreviewSrc = computed(() => {
  const current = response.value
  if (!current?.bodyBase64) return ''
  if (!(current.contentType ?? '').startsWith('image/')) return ''
  return `data:${current.contentType};base64,${current.bodyBase64}`
})

/** 「请求详情」优先展示主进程回传的真实请求快照 */
const requestSnapshot = computed<{ method: string; url: string; headers: { name: string; value: string }[] }>(() => {
  const info = response.value?.requestInfo
  if (info) return info
  const fallback = sentRequest.value
  return {
    method: fallback?.method ?? state.method,
    url: response.value?.finalUrl || fallback?.url || state.url,
    headers: (fallback?.headers ?? [])
      .filter((row) => row.enabled && row.key)
      .map((row) => ({ name: row.key, value: row.value }))
  }
})

const requestBodyLabel = computed(() => {
  const type = currentBodyType.value
  if (type === 'none') return '无请求体'
  return state.body.contentType ? `${type} · ${state.body.contentType}` : type
})

/* --------------------------- 地址 / 参数同步 --------------------------- */

/**
 * 地址栏与「参数」表格双向同步：
 * - 在地址里输入 `?a=1&b=2`，参数表会自动出现对应行；
 * - 在参数表里增删改，地址栏的查询串随之更新。
 * `urlSyncBusy` 用来打断两者互相触发形成的循环。
 */
let urlSyncBusy = false

function queryRowsFromUrl(raw: string): KeyValueRow[] {
  const queryIndex = raw.indexOf('?')
  if (queryIndex === -1) return []
  let query = raw.slice(queryIndex + 1)
  const hashIndex = query.indexOf('#')
  if (hashIndex !== -1) query = query.slice(0, hashIndex)
  if (!query) return []
  const rows: KeyValueRow[] = []
  try {
    for (const [key, value] of new URLSearchParams(query)) {
      if (!key) continue
      rows.push({ id: randomId(), key, value, enabled: true })
    }
  } catch {
    return []
  }
  return rows
}

function queryStringFromRows(rows: KeyValueRow[]): string {
  const search = new URLSearchParams()
  for (const row of rows) {
    const key = row.key.trim()
    if (!row.enabled || !key) continue
    search.append(key, row.value)
  }
  return search.toString()
}

/** 地址变化 → 重建参数表（保留被手动禁用的参数行，避免它们被悄悄删掉） */
function applyUrlToParams(): void {
  if (urlSyncBusy) return
  urlSyncBusy = true
  try {
    const parsed = queryRowsFromUrl(state.url)
    const disabled = state.params.filter((row) => !row.enabled && row.key.trim() !== '')
    const next = [...parsed, ...disabled]
    // 没有参数时保留一个空行，方便直接在表格里补参数
    state.params = next.length ? next : [newRow()]
  } finally {
    urlSyncBusy = false
  }
}

/** 参数表变化 → 把查询串写回地址 */
function applyParamsToUrl(): void {
  if (urlSyncBusy) return
  urlSyncBusy = true
  try {
    const base = baseUrlOf(state.url)
    const query = queryStringFromRows(state.params)
    const next = query ? `${base}?${query}` : base
    if (next !== state.url) state.url = next
  } finally {
    urlSyncBusy = false
  }
}

/** 载入记录时做一次合并，兼容「参数与地址各存一份」的旧数据 */
function reconcileUrlAndParams(): void {
  urlSyncBusy = true
  try {
    const parsed = queryRowsFromUrl(state.url)
    if (parsed.length) {
      const parsedKeys = new Set(parsed.map((row) => row.key))
      const extra = state.params.filter((row) => row.key.trim() !== '' && !parsedKeys.has(row.key.trim()))
      state.params = [...parsed, ...extra]
    }
    const base = baseUrlOf(state.url)
    const query = queryStringFromRows(state.params)
    const next = query ? `${base}?${query}` : base
    if (next !== state.url) state.url = next
  } finally {
    urlSyncBusy = false
  }
}

watch(() => state.url, applyUrlToParams, { flush: 'sync' })
watch(() => state.params, applyParamsToUrl, { deep: true, flush: 'sync' })

/* --------------------------- 未保存状态提示 --------------------------- */

function snapshotForm(): RequestForm {
  return {
    method: state.method,
    url: state.url,
    params: state.params.map((row) => ({ ...row })),
    headers: state.headers.map((row) => ({ ...row })),
    auth: { ...state.auth },
    body: { ...state.body, form: state.body.form.map((row) => ({ ...row })) },
    options: { ...state.options }
  }
}

function formSignature(): string {
  return JSON.stringify({ name: draftName.value, form: snapshotForm() })
}

/** 记录「当前表单对应哪份已落盘的内容」，用于判断是否有未保存修改 */
let lastSavedSignature = ''

let suspendTracking = false

function markDirty(): void {
  if (suspendTracking || !currentRequestId.value) return
  const changed = formSignature() !== lastSavedSignature
  if (changed) saveError.value = ''
  dirty.value = changed
  if (changed) {
    if (autoSaveEnabled.value) scheduleAutosave()
    else clearAutosave()
  } else {
    clearAutosave()
  }
}

watch(state, markDirty, { deep: true, flush: 'sync' })
watch(draftName, markDirty, { flush: 'sync' })

/* ------------------------------ 自动保存 ------------------------------ */

let autosaveTimer: number | undefined
let saveChain: Promise<void> = Promise.resolve()

function clearAutosave(): void {
  if (autosaveTimer !== undefined) {
    window.clearTimeout(autosaveTimer)
    autosaveTimer = undefined
  }
}

function scheduleAutosave(): void {
  clearAutosave()
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = undefined
    void flushSave()
  }, AUTOSAVE_DELAY)
}

/** 所有保存串行执行，避免并发写同一个数据文件 */
function queueSave(): Promise<void> {
  const task = (): Promise<void> => saveOnce()
  saveChain = saveChain.then(task, task)
  return saveChain
}

/**
 * 把当前修改写入数据文件。
 * 自动保存关闭时只有强制调用（手动保存 / 切换前的确认）才会落盘。
 */
async function flushSave(force = false): Promise<void> {
  clearAutosave()
  if (!dirty.value || !currentRequestId.value) return saveChain
  if (!force && !autoSaveEnabled.value) return saveChain
  await queueSave()
}

async function saveOnce(): Promise<void> {
  if (!dirty.value || !currentRequestId.value || !currentProjectId.value) return

  const projectId = currentProjectId.value
  const requestId = currentRequestId.value
  const sentSignature = formSignature()

  pendingSaves.value += 1
  saveError.value = ''
  try {
    const result = await window.api.projects.saveRequest(projectId, buildDraft())
    applyProjects(result.projects)

    if (currentRequestId.value !== requestId) return

    // 名称为空时由主进程按地址补全，同步回输入框
    if (result.record.name !== draftName.value) {
      suspendTracking = true
      draftName.value = result.record.name
      suspendTracking = false
    }

    lastSavedAt.value = Date.now()
    if (formSignature() === sentSignature) {
      lastSavedSignature = formSignature()
      dirty.value = false
    } else {
      // 保存期间又改动了内容，稍后再存一次
      dirty.value = true
      if (autoSaveEnabled.value) scheduleAutosave()
    }
  } catch (error) {
    saveError.value = (error as Error).message
    dirty.value = true
    ElMessage.error(`保存请求失败：${saveError.value}`)
  } finally {
    pendingSaves.value = Math.max(0, pendingSaves.value - 1)
  }
}

const saveStateText = computed(() => {
  if (saveError.value) return '保存失败，点击「保存」重试'
  if (saving.value) return '正在保存…'
  if (dirty.value) {
    return autoSaveEnabled.value ? '有未保存的修改，即将自动保存' : '有未保存的修改（自动保存已关闭）'
  }
  return lastSavedAt.value ? `已保存 ${clockText(lastSavedAt.value)}` : '已保存到本地文件'
})

const saveTooltip = computed(() => {
  if (!currentRequestId.value) return '先点击「新请求」创建一条请求记录'
  if (saveError.value) return `保存失败：${saveError.value}`
  if (dirty.value) {
    return autoSaveEnabled.value
      ? '有未保存的修改，停止输入后会自动保存（Ctrl+S 立即保存）'
      : '自动保存已关闭，点击「保存」或按 Ctrl+S 才会写入数据文件'
  }
  return lastSavedAt.value
    ? `已保存于 ${clockText(lastSavedAt.value)}（Ctrl+S 立即保存）`
    : '已保存到本地文件（Ctrl+S 立即保存）'
})

function clockText(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 切换请求 / 项目前的保护：
 * 开启自动保存时直接落盘；关闭时弹窗让用户决定「保存」「放弃」还是取消切换。
 */
async function ensureSavedBeforeLeave(): Promise<boolean> {
  clearAutosave()
  if (!dirty.value || !currentRequestId.value) return true
  if (autoSaveEnabled.value) {
    await flushSave(true)
    return true
  }
  try {
    await ElMessageBox.confirm('当前请求有未保存的修改，是否保存后继续？', '未保存的修改', {
      type: 'warning',
      confirmButtonText: '保存并继续',
      cancelButtonText: '放弃修改',
      distinguishCancelAndClose: true
    })
    await flushSave(true)
    return true
  } catch (action) {
    // cancel = 放弃修改；close（右上角 ×）= 取消切换
    if (action === 'cancel') {
      dirty.value = false
      return true
    }
    return false
  }
}

/* ---------------------------- 项目 / 请求数据 ---------------------------- */

function applyProjects(next: ApiProject[]): void {
  projects.value = next
  if (!next.some((item) => item.id === currentProjectId.value)) {
    currentProjectId.value = next[0]?.id ?? ''
  }
}

function saveSelection(): void {
  try {
    localStorage.setItem(
      SELECTION_KEY,
      JSON.stringify({ projectId: currentProjectId.value, requestId: currentRequestId.value })
    )
  } catch {
    // 忽略 localStorage 不可用
  }
}

function readSelection(): { projectId?: string; requestId?: string } {
  try {
    const raw = localStorage.getItem(SELECTION_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { projectId?: unknown; requestId?: unknown }
    return {
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : undefined,
      requestId: typeof parsed.requestId === 'string' ? parsed.requestId : undefined
    }
  } catch {
    return {}
  }
}

/** 把一条请求记录载入表单；传入 null 表示进入「未选中」状态 */
function loadRecord(record: ApiRequestRecord | null): void {
  suspendTracking = true
  urlSyncBusy = true
  currentRequestId.value = record?.id ?? ''
  if (record) {
    Object.assign(state, {
      method: record.method,
      url: record.url,
      params: record.params.length ? record.params.map((row) => ({ ...row, id: randomId() })) : [newRow()],
      headers: record.headers.length ? record.headers.map((row) => ({ ...row, id: randomId() })) : defaultHeaders(),
      auth: { ...record.auth },
      body: {
        ...record.body,
        form: record.body.form.length
          ? record.body.form.map((row) => ({ ...row, id: randomId() }))
          : [newFormRow()]
      },
      options: { ...state.options, ...record.options }
    })
    draftName.value = record.name
  } else {
    Object.assign(state, defaultForm())
    draftName.value = ''
  }
  urlSyncBusy = false
  reconcileUrlAndParams()
  if (record) {
    requestTab.value = record.body.type === 'none' ? 'params' : 'body'
  } else {
    requestTab.value = 'params'
  }
  suspendTracking = false
  dirty.value = false
  saveError.value = ''
  lastSavedAt.value = 0
  lastSavedSignature = formSignature()
  response.value = null
  sentRequest.value = null
  responseSection.value = 'body'
  bodyView.value = 'pretty'
}

function buildDraft(): ApiRequestDraft {
  const form = snapshotForm()
  return {
    id: currentRequestId.value,
    name: draftName.value.trim(),
    ...form
  }
}

/* ------------------------------ 选择切换 ------------------------------ */

async function selectRequest(id: string): Promise<void> {
  if (!id || id === currentRequestId.value) return
  if (!(await ensureSavedBeforeLeave())) return
  const record = currentRequests.value.find((item) => item.id === id) ?? null
  loadRecord(record)
  saveSelection()
}

async function switchProject(projectId: string): Promise<void> {
  if (!projectId || projectId === currentProjectId.value) return
  if (!projects.value.some((item) => item.id === projectId)) return
  if (!(await ensureSavedBeforeLeave())) return
  currentProjectId.value = projectId
  const project = projects.value.find((item) => item.id === projectId)
  loadRecord(project?.requests[0] ?? null)
  saveSelection()
}

/* ------------------------------ 新建 / 删除 ------------------------------ */

function emptyDraft(name: string): ApiRequestDraft {
  return { id: '', name, ...defaultForm() }
}

async function createRequest(): Promise<void> {
  const project = currentProject.value
  if (!project) {
    ElMessage.warning('请先创建一个项目')
    return
  }
  if (!(await ensureSavedBeforeLeave())) return
  try {
    const result = await window.api.projects.saveRequest(
      project.id,
      emptyDraft(`新请求 ${project.requests.length + 1}`)
    )
    applyProjects(result.projects)
    currentProjectId.value = project.id
    loadRecord(result.record)
    saveSelection()
    ElMessage.success(`已创建请求「${result.record.name}」`)
  } catch (error) {
    ElMessage.error(`创建请求失败：${(error as Error).message}`)
  }
}

async function duplicateRequest(id: string): Promise<void> {
  const project = currentProject.value
  const record = currentRequests.value.find((item) => item.id === id)
  if (!project || !record) return
  if (!(await ensureSavedBeforeLeave())) return
  try {
    const result = await window.api.projects.saveRequest(project.id, {
      id: '',
      name: `${record.name} 副本`,
      method: record.method,
      url: record.url,
      params: record.params.map((row) => ({ ...row })),
      headers: record.headers.map((row) => ({ ...row })),
      auth: { ...record.auth },
      body: { ...record.body, form: record.body.form.map((row) => ({ ...row })) },
      options: { ...record.options }
    })
    applyProjects(result.projects)
    loadRecord(result.record)
    saveSelection()
    ElMessage.success(`已复制为「${result.record.name}」`)
  } catch (error) {
    ElMessage.error(`复制请求失败：${(error as Error).message}`)
  }
}

async function deleteRequest(id: string): Promise<void> {
  const project = currentProject.value
  const record = currentRequests.value.find((item) => item.id === id)
  if (!project || !record) return
  try {
    await ElMessageBox.confirm(`确定删除请求「${record.name}」吗？删除后无法恢复。`, '删除请求', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    const next = await window.api.projects.removeRequest(project.id, id)
    applyProjects(next)
    if (currentRequestId.value === id) {
      loadRecord(next.find((item) => item.id === project.id)?.requests[0] ?? null)
      saveSelection()
    }
  } catch (error) {
    ElMessage.error(`删除请求失败：${(error as Error).message}`)
  }
}

/* ------------------------------ 项目管理 ------------------------------ */

async function promptProjectName(title: string, initial: string): Promise<string | null> {
  try {
    const result = (await ElMessageBox.prompt('项目名称', title, {
      inputValue: initial,
      inputPlaceholder: '请输入项目名称',
      inputValidator: (value: string) => (value && value.trim() ? true : '项目名称不能为空'),
      confirmButtonText: '确定',
      cancelButtonText: '取消'
    })) as unknown as { value?: string }
    return String(result.value ?? '').trim() || null
  } catch {
    return null
  }
}

async function onProjectCommand(command: string | number | object): Promise<void> {
  switch (String(command)) {
    case 'create':
      await createProject()
      break
    case 'rename':
      await renameCurrentProject()
      break
    case 'remove':
      await removeCurrentProject()
      break
    case 'export':
      await exportProjects()
      break
    case 'import':
      await importProjects()
      break
    case 'reveal':
      await revealDataFile()
      break
    default:
      break
  }
}

async function createProject(): Promise<void> {
  const name = await promptProjectName('新建项目', `项目 ${projects.value.length + 1}`)
  if (!name) return
  if (!(await ensureSavedBeforeLeave())) return
  try {
    const next = await window.api.projects.create(name)
    applyProjects(next)
    const created = next.find((item) => item.name === name) ?? next[next.length - 1]
    currentProjectId.value = created.id
    loadRecord(null)
    saveSelection()
    ElMessage.success(`项目「${created.name}」已创建`)
  } catch (error) {
    ElMessage.error(`新建项目失败：${(error as Error).message}`)
  }
}

async function renameCurrentProject(): Promise<void> {
  const project = currentProject.value
  if (!project) return
  const name = await promptProjectName('重命名项目', project.name)
  if (!name || name === project.name) return
  try {
    applyProjects(await window.api.projects.rename(project.id, name))
    ElMessage.success('项目已重命名')
  } catch (error) {
    ElMessage.error(`重命名失败：${(error as Error).message}`)
  }
}

async function removeCurrentProject(): Promise<void> {
  const project = currentProject.value
  if (!project) return
  try {
    await ElMessageBox.confirm(
      `确定删除项目「${project.name}」及其中 ${project.requests.length} 条请求记录吗？删除后无法恢复。`,
      '删除项目',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  clearAutosave()
  dirty.value = false
  try {
    const next = await window.api.projects.remove(project.id)
    applyProjects(next)
    const fallback = next[0]
    currentProjectId.value = fallback?.id ?? ''
    loadRecord(fallback?.requests[0] ?? null)
    saveSelection()
    ElMessage.success('项目已删除')
  } catch (error) {
    ElMessage.error(`删除项目失败：${(error as Error).message}`)
  }
}

async function exportProjects(): Promise<void> {
  await flushSave()
  try {
    const result = await window.api.projects.exportAll()
    if (result.canceled) return
    if (result.error) {
      ElMessage.error(`导出失败：${result.error}`)
      return
    }
    ElMessage.success(`已导出 ${result.requests ?? 0} 条请求到 ${result.filePath ?? ''}`)
    if (result.filePath) await window.api.app.showItemInFolder(result.filePath)
  } catch (error) {
    ElMessage.error(`导出失败：${(error as Error).message}`)
  }
}

async function importProjects(): Promise<void> {
  await flushSave()
  try {
    const result = await window.api.projects.importFile()
    if (result.canceled) return
    if (result.error) {
      ElMessage.error(`导入失败：${result.error}`)
      return
    }
    if (result.projects) {
      applyProjects(result.projects)
      await reloadCurrentSelection()
    }
    ElMessage.success(
      `导入完成：新增 ${result.importedProjects ?? 0} 个项目、${result.importedRequests ?? 0} 条请求`
    )
  } catch (error) {
    ElMessage.error(`导入失败：${(error as Error).message}`)
  }
}

async function reloadCurrentSelection(): Promise<void> {
  const project = projects.value.find((item) => item.id === currentProjectId.value) ?? projects.value[0]
  currentProjectId.value = project?.id ?? ''
  const record =
    project?.requests.find((item) => item.id === currentRequestId.value) ?? project?.requests[0] ?? null
  loadRecord(record)
  saveSelection()
}

async function revealDataFile(): Promise<void> {
  try {
    await window.api.projects.reveal()
  } catch (error) {
    ElMessage.error(`打开数据文件位置失败：${(error as Error).message}`)
  }
}

function toggleRequestList(): void {
  void setApiSidebarCollapsed(!settings.apiSidebarCollapsed)
}

/* ------------------------------ 发送请求 ------------------------------ */

function suggestFileName(): string {
  const suggested = response.value?.suggestedFileName
  if (suggested) return suggested
  const raw = state.url.trim()
  if (!raw) return 'response.txt'
  try {
    const url = new URL(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw) ? raw : `http://${raw}`)
    const last = url.pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
  } catch {
    // 忽略
  }
  const contentType = (response.value?.contentType ?? '').toLowerCase()
  if (contentType.includes('json')) return 'response.json'
  if (contentType.includes('html')) return 'response.html'
  if (contentType.includes('xml')) return 'response.xml'
  if (contentType.startsWith('text/')) return 'response.txt'
  if (contentType.startsWith('image/')) return 'response.png'
  if (contentType.includes('pdf')) return 'response.pdf'
  if (contentType.includes('zip')) return 'response.zip'
  return response.value?.binary ? 'response.bin' : 'response.txt'
}

async function send(): Promise<void> {
  if (sending.value) return
  if (!currentRequestId.value) {
    ElMessage.warning('请先点击「新请求」创建一条请求记录')
    return
  }
  if (!state.url.trim()) {
    ElMessage.warning('请先填写请求地址')
    return
  }

  // 开启自动保存时，发送前先把当前内容落盘，确保请求与记录一致
  await flushSave()

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
  requestTab.value = 'response'
  responseSection.value = 'body'
  sentRequest.value = { method: state.method, url: state.url, headers: state.headers.map((row) => ({ ...row })) }

  const requestConfig = buildHttpRequestConfig(state, requestId, outputPath, MAX_DISPLAY_BYTES)
  let status: number | undefined
  let ok = false
  let durationMs = 0

  try {
    const result = await window.api.http.request(requestConfig)
    response.value = result
    progress.value = 100
    status = result.status
    ok = result.ok
    durationMs = result.durationMs
    if (result.error) {
      ElMessage.error(result.error)
    } else if ((result.status ?? 0) >= 400) {
      ElMessage.warning(`请求已返回 ${result.status} ${result.statusText ?? ''}`)
    } else if (result.binary) {
      ElMessage.success(`请求成功（${result.status}），收到 ${formatBytes(result.size)} 二进制内容`)
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
    void persistAttempt({ status, ok, durationMs })
  }
}

/** 把最近一次发送结果写回请求记录，便于在列表中看到状态码 */
async function persistAttempt(result: ApiAttemptResult): Promise<void> {
  const projectId = currentProjectId.value
  const requestId = currentRequestId.value
  if (!projectId || !requestId) return
  try {
    applyProjects(await window.api.projects.recordResult(projectId, requestId, result))
  } catch (error) {
    console.error('[api] 保存请求结果失败', error)
  }
}

async function abort(): Promise<void> {
  if (!activeRequestId.value) return
  await window.api.http.abort(activeRequestId.value)
}

/* ------------------------------ 响应操作 ------------------------------ */

async function copyResponseBody(): Promise<void> {
  const text = prettyBody.value.text || response.value?.bodyText || ''
  if (!text) return
  const ok = await copyText(text)
  if (ok) ElMessage.success('已复制响应内容')
  else ElMessage.error('复制失败')
}

/** 导出二进制响应（图片 / 压缩包 / office 文档…），按原始字节落盘 */
async function saveBinaryResponse(): Promise<void> {
  const current = response.value
  if (!current?.bodyBase64) {
    ElMessage.warning('当前响应没有可导出的二进制内容')
    return
  }
  if (current.bodyTruncated) {
    ElMessage.warning('响应内容超过展示上限已被截断，请把「响应处理」切换为「保存到文件」后重新发送')
    return
  }
  const pick = await window.api.dialog.saveFile({
    title: '导出二进制文件',
    defaultFileName: suggestFileName()
  })
  if (pick.canceled || !pick.filePath) return
  const write = await window.api.file.writeBinary(pick.filePath, current.bodyBase64)
  if (write.ok) {
    ElMessage.success(`已导出二进制文件（${formatBytes(write.bytes ?? 0)}）`)
    await window.api.app.showItemInFolder(pick.filePath)
  } else {
    ElMessage.error(write.error ?? '导出失败')
  }
}

async function saveResponseBody(): Promise<void> {
  const current = response.value
  if (!current) return
  if (current.bodyPath) {
    void window.api.app.showItemInFolder(current.bodyPath)
    return
  }
  if (current.binary) {
    await saveBinaryResponse()
    return
  }
  const text = current.bodyText
  if (!text) return
  if (current.bodyTruncated) {
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

function openSavedFile(): void {
  const target = response.value?.bodyPath
  if (target) void window.api.app.showItemInFolder(target)
}

/* --------------------------- Content-Type 管理 --------------------------- */

async function rememberContentType(value?: string): Promise<void> {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return
  if (settings.apiContentTypes.includes(trimmed)) return
  await setApiContentTypes([...settings.apiContentTypes, trimmed])
}

async function addContentType(): Promise<void> {
  const value = newContentType.value.trim()
  if (!value) {
    ElMessage.warning('请输入 Content-Type')
    return
  }
  if (settings.apiContentTypes.includes(value)) {
    ElMessage.info('该 Content-Type 已存在')
    newContentType.value = ''
    return
  }
  await setApiContentTypes([...settings.apiContentTypes, value])
  newContentType.value = ''
  ElMessage.success(`已添加 ${value}`)
}

async function removeContentType(value: string): Promise<void> {
  await setApiContentTypes(settings.apiContentTypes.filter((item) => item !== value))
  if (state.body.contentType === value) state.body.contentType = ''
}

async function resetContentTypes(): Promise<void> {
  await setApiContentTypes([...DEFAULT_CONTENT_TYPES])
  ElMessage.success('已恢复默认 Content-Type 列表')
}

/* ------------------------------ 表单操作 ------------------------------ */

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
  row.kind = row.kind === 'file' ? 'text' : 'file'
  if (row.kind === 'text') row.filePath = ''
}

function resetForm(): void {
  if (!currentRequestId.value) return
  Object.assign(state, defaultForm())
  response.value = null
  sentRequest.value = null
}

async function manualSave(): Promise<void> {
  if (!currentRequestId.value) {
    ElMessage.warning('请先点击「新请求」创建一条请求记录')
    return
  }
  if (!dirty.value) {
    ElMessage.success('当前没有需要保存的修改')
    return
  }
  await flushSave(true)
  if (!dirty.value && !saveError.value) ElMessage.success('已保存到本地数据文件')
}

/* ------------------------------ 生命周期 ------------------------------ */

let active = false
let progressUnsubscribe: (() => void) | undefined

function onKeydown(event: KeyboardEvent): void {
  if (!active) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void manualSave()
  }
}

/** 窗口失焦 / 切到后台时立即保存（仅在开启自动保存时生效） */
function onWindowBlur(): void {
  if (active) void flushSave()
}

function onVisibilityChange(): void {
  if (active && document.visibilityState === 'hidden') void flushSave()
}

/** 自动保存开关变化后立即刷新定时器状态 */
watch(autoSaveEnabled, (enabled) => {
  if (enabled && dirty.value) scheduleAutosave()
  else clearAutosave()
})

async function loadAll(): Promise<void> {
  loading.value = true
  try {
    const store = await window.api.projects.load()
    projects.value = store.projects
    dataFile.value = store.dataFile

    const selection = readSelection()
    const project = store.projects.find((item) => item.id === selection.projectId) ?? store.projects[0]
    currentProjectId.value = project?.id ?? ''
    const record =
      project?.requests.find((item) => item.id === selection.requestId) ?? project?.requests[0] ?? null
    loadRecord(record)
    saveSelection()
  } catch (error) {
    ElMessage.error(`读取请求数据失败：${(error as Error).message}`)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  progressUnsubscribe = window.api.http.onProgress((payload) => {
    if (payload.requestId !== activeRequestId.value) return
    progress.value = payload.total > 0 ? Math.min(99, Math.round((payload.loaded / payload.total) * 100)) : 0
  })
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('blur', onWindowBlur)
  document.addEventListener('visibilitychange', onVisibilityChange)
  try {
    localStorage.removeItem(LEGACY_STATE_KEY)
  } catch {
    // 忽略
  }
  await loadAll()
})

onActivated(() => {
  active = true
})

onDeactivated(() => {
  active = false
  void flushSave()
})

onUnmounted(() => {
  active = false
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('blur', onWindowBlur)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  progressUnsubscribe?.()
  void flushSave()
})
</script>

<template>
  <div class="page api-page">
    <div class="page-toolbar project-bar">
      <span class="bar-label">项目</span>
      <el-select
        :model-value="currentProjectId"
        class="project-select"
        placeholder="选择项目"
        :disabled="loading || projects.length === 0"
        @change="switchProject"
      >
        <el-option v-for="project in projects" :key="project.id" :label="project.name" :value="project.id">
          <div class="project-option">
            <span class="option-name">{{ project.name }}</span>
            <span class="option-count">{{ project.requests.length }}</span>
          </div>
        </el-option>
      </el-select>

      <el-dropdown trigger="click" :disabled="!currentProject" @command="onProjectCommand">
        <el-button class="project-menu-btn">
          项目管理
          <el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="create" :icon="Plus">新建项目</el-dropdown-item>
            <el-dropdown-item command="rename" :icon="EditPen">重命名当前项目</el-dropdown-item>
            <el-dropdown-item command="remove" :icon="Delete" divided>删除当前项目</el-dropdown-item>
            <el-dropdown-item command="export" :icon="Download" divided>导出全部数据…</el-dropdown-item>
            <el-dropdown-item command="import" :icon="Upload">导入数据…</el-dropdown-item>
            <el-dropdown-item command="reveal" :icon="FolderOpened">打开数据文件位置</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <span class="spacer" />
      <span v-if="currentProject" class="small muted project-summary">
        {{ currentProject.requests.length }} 条请求 · {{ autoSaveEnabled ? '自动保存' : '手动保存' }}
      </span>
      <el-button :icon="Plus" @click="createRequest">新请求</el-button>
      <el-tooltip :content="saveTooltip" placement="bottom">
        <el-badge is-dot :hidden="!dirty" class="save-badge">
          <el-button :icon="Check" :disabled="!currentRequestId" :loading="saving" @click="manualSave">
            保存
          </el-button>
        </el-badge>
      </el-tooltip>
    </div>

    <div class="page-body">
      <ApiRequestList
        :requests="currentRequests"
        :current-id="currentRequestId"
        :dirty-id="dirty ? currentRequestId : ''"
        :data-file="dataFile"
        :collapsed="listCollapsed"
        @select="selectRequest"
        @duplicate="duplicateRequest"
        @remove="deleteRequest"
        @reveal="revealDataFile"
        @toggle="toggleRequestList"
      />

      <div v-if="!currentRequestId" class="panel empty-main">
        <el-icon :size="34" class="empty-icon"><DocumentAdd /></el-icon>
        <div class="empty-title">还没有选中请求</div>
        <div class="small muted empty-desc">
          点击右上角「新请求」创建一条请求记录；也可以从左侧列表选择已有请求。
        </div>
        <el-button type="primary" :icon="Plus" @click="createRequest">新请求</el-button>
      </div>

      <div v-else class="api-main">
        <div class="name-bar">
          <span class="small muted bar-label-inline">名称</span>
          <el-input
            v-model="draftName"
            size="small"
            class="name-input"
            maxlength="60"
            placeholder="给这条请求起个名字，例如：获取用户列表"
          />
          <span class="save-state" :class="{ pending: dirty && !saveError, failed: Boolean(saveError) }">
            {{ saveStateText }}
          </span>
          <span class="spacer" />
          <span class="small muted request-info" v-if="currentRecord">
            最近更新 {{ new Date(currentRecord.updatedAt).toLocaleString('zh-CN', { hour12: false }) }}
          </span>
        </div>

        <div class="url-bar">
          <el-select v-model="state.method" class="method-select" :style="{ color: methodColor }">
            <el-option v-for="method in METHODS" :key="method" :label="method" :value="method" />
          </el-select>
          <el-input
            v-model="state.url"
            class="url-input"
            placeholder="请输入请求地址，例如 https://httpbin.org/get?page=1"
            clearable
            @keydown.enter="send"
          />
          <el-button v-if="!sending" type="primary" :icon="Promotion" class="send-btn" @click="send">发送</el-button>
          <el-button v-else type="danger" :icon="VideoPause" class="send-btn" @click="abort">取消</el-button>
          <el-button :icon="Refresh" @click="resetForm">重置</el-button>
        </div>

        <el-progress
          v-if="sending && progress > 0"
          :percentage="progress"
          :stroke-width="4"
          :show-text="false"
          class="send-progress"
        />

        <section class="panel request-panel">
          <el-tabs v-model="requestTab" class="request-tabs">
            <el-tab-pane name="params">
              <template #label>
                <span>参数</span>
                <span class="tab-badge">{{ state.params.filter((row) => row.enabled && row.key).length }}</span>
              </template>
              <div class="tab-scroll">
                <div class="small muted hint-line">
                  地址栏里的查询串会自动解析到下面的表格；在这里增删改也会同步回地址栏。
                </div>
                <KeyValueEditor v-model="state.params" key-placeholder="参数名" value-placeholder="参数值" />
              </div>
            </el-tab-pane>

            <el-tab-pane name="headers">
              <template #label>
                <span>请求头</span>
                <span class="tab-badge">{{ state.headers.filter((row) => row.enabled && row.key).length }}</span>
              </template>
              <div class="tab-scroll">
                <div class="small muted hint-line">已预置常用通用请求头，可取消勾选或直接删除。</div>
                <KeyValueEditor v-model="state.headers" key-placeholder="Header 名称" value-placeholder="Header 值" />
              </div>
            </el-tab-pane>

            <el-tab-pane label="鉴权" name="auth">
              <div class="tab-scroll">
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
              </div>
            </el-tab-pane>

            <el-tab-pane label="请求体" name="body">
              <div class="tab-scroll">
                <div class="body-form">
                  <div class="form-row">
                    <span class="form-label">类型</span>
                    <el-select v-model="state.body.type" style="width: 200px">
                      <el-option v-for="item in BODY_TYPES" :key="item.value" :label="item.label" :value="item.value" />
                    </el-select>
                  </div>

                  <div v-if="currentBodyType !== 'none'" class="form-row">
                    <span class="form-label nowrap">Content-Type</span>
                    <el-select
                      v-model="state.body.contentType"
                      class="content-type-select"
                      placeholder="留空则自动推断"
                      filterable
                      allow-create
                      clearable
                      default-first-option
                      @change="rememberContentType"
                    >
                      <el-option v-for="item in settings.apiContentTypes" :key="item" :label="item" :value="item" />
                    </el-select>
                    <el-button size="small" :icon="Setting" @click="contentTypeDialog = true">管理</el-button>
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
              </div>
            </el-tab-pane>

            <el-tab-pane label="选项" name="options">
              <div class="tab-scroll">
                <div class="options-form">
                  <div class="form-row">
                    <span class="form-label">超时时间</span>
                    <el-input-number
                      v-model="state.options.timeoutMs"
                      :min="1000"
                      :max="600000"
                      :step="1000"
                      controls-position="right"
                    />
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
                          ? '发送前选择保存路径，响应直接写入文件（适合大文件 / 二进制）'
                          : `响应内容最多展示 ${formatBytes(MAX_DISPLAY_BYTES)}，二进制内容可导出为文件`
                      }}
                    </span>
                  </div>
                </div>
              </div>
            </el-tab-pane>

            <el-tab-pane name="response">
              <template #label>
                <span>响应</span>
                <span v-if="response?.status" class="tab-status" :class="`is-${statusType}`">
                  {{ response.status }}
                </span>
                <span v-else-if="sending" class="tab-status is-pending">…</span>
              </template>

              <div class="response-wrap">
                <div class="response-meta">
                  <template v-if="response">
                    <span v-if="response.status" class="status-pill" :class="`is-${statusType}`">
                      {{ response.status }} {{ response.statusText }}
                    </span>
                    <span class="small muted">耗时 {{ formatDuration(response.durationMs) }}</span>
                    <span class="small muted">大小 {{ formatBytes(response.size) }}</span>
                    <span v-if="response.contentType" class="small muted type-text">{{ response.contentType }}</span>
                  </template>
                  <span v-else class="small muted">尚未发送请求</span>
                  <span class="spacer" />
                  <el-button v-if="response?.bodyPath" size="small" :icon="FolderOpened" @click="openSavedFile">
                    打开所在目录
                  </el-button>
                  <el-button v-if="canSaveResponse" size="small" :icon="Download" @click="saveResponseBody">
                    {{ isBinaryResponse ? '导出二进制文件' : '保存响应' }}
                  </el-button>
                  <el-button v-if="response?.bodyText" size="small" :icon="CopyDocument" @click="copyResponseBody">
                    复制
                  </el-button>
                </div>

                <div v-if="!hasResponse" class="placeholder-box response-empty">
                  <el-icon :size="28"><Promotion /></el-icon>
                  <span>填写地址后点击「发送」，响应会显示在这里</span>
                </div>

                <template v-else>
                  <div class="response-subbar">
                    <SegmentedControl v-model="responseSection" :options="RESPONSE_SECTIONS" size="small" />
                    <span class="spacer" />
                    <SegmentedControl
                      v-if="responseSection === 'body' && canShowTree"
                      v-model="bodyView"
                      :options="[
                        { label: '格式化', value: 'pretty' },
                        { label: '树形', value: 'tree' }
                      ]"
                      size="small"
                    />
                    <span v-if="response?.bodyTruncated" class="small warning-text">
                      响应内容过大，仅展示前 {{ formatBytes(MAX_DISPLAY_BYTES) }}
                    </span>
                    <span v-if="responseSection === 'body' && response?.bodyText" class="small muted">
                      {{ response.bodyText.length.toLocaleString() }} 字符
                    </span>
                    <span v-if="responseSection === 'headers'" class="small muted">
                      {{ (response?.headers ?? []).length }} 个响应头
                    </span>
                  </div>

                  <div class="response-content">
                    <template v-if="responseSection === 'body'">
                      <div v-if="response?.error" class="padded">
                        <el-alert type="error" :closable="false" show-icon :title="response.error" />
                      </div>
                      <div v-else-if="response?.bodyPath" class="padded">
                        <el-alert type="success" :closable="false" show-icon title="响应已保存到文件">
                          <div class="mono small">{{ response.bodyPath }}</div>
                        </el-alert>
                      </div>
                      <div v-else-if="isBinaryResponse" class="binary-box">
                        <img v-if="imagePreviewSrc" :src="imagePreviewSrc" class="binary-preview" alt="二进制响应预览" />
                        <div class="binary-info">
                          <el-icon v-if="!imagePreviewSrc" :size="30" class="binary-icon"><Download /></el-icon>
                          <div class="binary-title">二进制响应（{{ formatBytes(response?.size ?? 0) }}）</div>
                          <div class="small muted mono">{{ response?.contentType || 'application/octet-stream' }}</div>
                          <div class="small muted binary-desc">
                            内容不是文本，无法直接展示。可以导出为文件后用对应程序打开。
                          </div>
                          <el-button type="primary" size="small" :icon="Download" @click="saveBinaryResponse">
                            导出二进制文件
                          </el-button>
                        </div>
                      </div>
                      <JsonTree
                        v-else-if="bodyView === 'tree' && canShowTree"
                        :data="prettyBody.data"
                        :expand-depth="2"
                        class="response-tree"
                      />
                      <pre v-else-if="response?.bodyText" class="code-block response-code">{{ prettyBody.text }}</pre>
                      <div v-else class="placeholder-box"><span>响应体为空</span></div>
                    </template>

                    <div v-else-if="responseSection === 'headers'" class="padded">
                      <div v-if="!(response?.headers ?? []).length" class="small muted">没有收到响应头</div>
                      <div v-for="(header, index) in response?.headers ?? []" :key="index" class="header-row">
                        <span class="header-name mono">{{ header.name }}</span>
                        <span class="header-value mono">{{ header.value }}</span>
                      </div>
                    </div>

                    <div v-else class="padded">
                      <div class="detail-row">
                        <span class="detail-label">请求方法</span>
                        <span class="mono">{{ requestSnapshot.method }}</span>
                      </div>
                      <div class="detail-row">
                        <span class="detail-label">请求地址</span>
                        <span class="mono wrap">{{ requestSnapshot.url }}</span>
                      </div>
                      <div class="detail-row">
                        <span class="detail-label">请求体</span>
                        <span class="mono">{{ requestBodyLabel }}</span>
                      </div>
                      <div class="detail-row">
                        <span class="detail-label">HTTP 版本</span>
                        <span class="mono">{{ response?.httpVersion ?? '-' }}</span>
                      </div>

                      <div class="section-label">
                        已配置的请求头
                        <span class="detail-count">{{ requestSnapshot.headers.length }}</span>
                      </div>
                      <div v-if="!requestSnapshot.headers.length" class="small muted">
                        本次请求没有附加任何请求头（也未使用鉴权信息）
                      </div>
                      <div v-for="header in requestSnapshot.headers" :key="header.name" class="header-row">
                        <span class="header-name mono">{{ header.name }}</span>
                        <span class="header-value mono">{{ header.value }}</span>
                      </div>
                    </div>
                  </div>
                </template>
              </div>
            </el-tab-pane>
          </el-tabs>
        </section>
      </div>
    </div>

    <el-dialog v-model="contentTypeDialog" title="管理 Content-Type" width="520px" append-to-body>
      <div class="ct-add-row">
        <el-input
          v-model="newContentType"
          placeholder="例如 application/vnd.api+json"
          @keydown.enter.prevent="addContentType"
        />
        <el-button type="primary" :icon="Plus" @click="addContentType">添加</el-button>
      </div>
      <div class="ct-list">
        <div v-for="item in settings.apiContentTypes" :key="item" class="ct-item">
          <span class="mono">{{ item }}</span>
          <el-button text size="small" :icon="Delete" class="ct-delete" @click="removeContentType(item)" />
        </div>
        <div v-if="!settings.apiContentTypes.length" class="small muted">列表为空，添加后会出现在下拉选项里。</div>
      </div>
      <div class="small muted ct-tip">
        列表保存在本地设置中；在请求体里直接输入新的 Content-Type 也会自动加入。
      </div>
      <template #footer>
        <el-button @click="resetContentTypes">恢复默认</el-button>
        <el-button type="primary" @click="contentTypeDialog = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.api-page {
  gap: 10px;
}

.project-bar {
  gap: 8px;
}

.bar-label {
  font-size: 12px;
  color: var(--app-text-3);
}

.project-select {
  width: 200px;
  flex: none;
}

.project-option {
  display: flex;
  align-items: center;
  gap: 10px;
}

.option-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.option-count {
  flex: none;
  font-size: 11px;
  color: var(--app-text-3);
}

.project-summary {
  white-space: nowrap;
}

/* 窗口较窄时先隐藏辅助说明，避免工具栏换行 */
@media (max-width: 1180px) {
  .project-summary {
    display: none;
  }
}

.save-badge {
  flex: none;
}

.save-badge :deep(.el-badge__content.is-dot) {
  width: 8px;
  height: 8px;
  border-width: 1px;
  background: #ef4444;
}

.empty-main {
  flex: 1;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--app-text-2);
}

.empty-icon {
  color: var(--app-text-3);
}

.empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--app-text);
}

.empty-desc {
  max-width: 360px;
  text-align: center;
  line-height: 1.6;
  margin-bottom: 4px;
}

.api-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.name-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  min-height: 26px;
}

.bar-label-inline {
  flex: none;
}

.name-input {
  width: 320px;
  flex: none;
}

.save-state {
  font-size: 11.5px;
  color: var(--app-text-3);
  white-space: nowrap;
}

.save-state.pending {
  color: #d97706;
}

.save-state.failed {
  color: #dc2626;
}

.request-info {
  white-space: nowrap;
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
  flex: 1;
  min-height: 0;
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
  overflow: hidden;
  padding: 0;
}

.request-tabs :deep(.el-tab-pane) {
  height: 100%;
  min-height: 0;
}

.tab-scroll {
  height: 100%;
  overflow: auto;
  padding: 12px;
}

.hint-line {
  margin-bottom: 8px;
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

.tab-status {
  display: inline-block;
  margin-left: 5px;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 10.5px;
  font-weight: 700;
  line-height: 15px;
  color: #fff;
  background: #94a3b8;
}

.tab-status.is-success {
  background: #16a34a;
}

.tab-status.is-info {
  background: #0891b2;
}

.tab-status.is-warning {
  background: #d97706;
}

.tab-status.is-danger {
  background: #dc2626;
}

.tab-status.is-pending {
  background: var(--app-border-strong);
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

.form-label.nowrap {
  width: 92px;
  white-space: nowrap;
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

.content-type-select {
  width: 300px;
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

/* ---------------------------- 响应区域 ---------------------------- */

.response-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.response-meta {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--app-border);
  min-height: 40px;
  flex-wrap: wrap;
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

.response-subbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.response-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}

.response-content .padded {
  padding: 12px;
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

/* 二进制响应 */
.binary-box {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 20px;
  overflow: auto;
}

.binary-preview {
  max-width: min(100%, 560px);
  max-height: 42vh;
  object-fit: contain;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.binary-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  text-align: center;
}

.binary-icon {
  color: var(--app-text-3);
}

.binary-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--app-text);
}

.binary-desc {
  max-width: 420px;
  line-height: 1.6;
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

.section-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0 6px;
  padding-top: 10px;
  border-top: 1px solid var(--app-border);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--app-text-2);
}

.detail-count {
  padding: 0 6px;
  border-radius: 8px;
  background: var(--app-primary-soft);
  color: var(--app-primary);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
}

.wrap {
  word-break: break-all;
}

.warning-text {
  color: #d97706;
}

/* Content-Type 管理弹窗 */
.ct-add-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.ct-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 320px;
  overflow: auto;
}

.ct-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 4px 10px;
  border: 1px solid var(--app-border);
  border-radius: 7px;
  font-size: 12.5px;
}

.ct-delete {
  color: var(--app-text-3);
}

.ct-delete:hover {
  color: #ef4444;
}

.ct-tip {
  margin-top: 10px;
}
</style>
