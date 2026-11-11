import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ApiAttemptResult,
  ApiFolder,
  ApiProject,
  ApiRequestDraft,
  ApiRequestOptions,
  ApiRequestRecord,
  AuthType,
  BodyType,
  FormRow,
  HttpAuthConfig,
  HttpBodyConfig,
  HttpMethod,
  KeyValueRow
} from '@shared/types'
import { configDir } from './store'

/**
 * API 请求数据（多项目 + 请求记录 + 文件夹）的本地持久化。
 *
 * 设计目标：所有请求记录都写进一个可读的 JSON 文件（默认与 settings.json 同目录），
 * 既能在重启后恢复，也能直接拷贝 / 导出到另一台机器继续使用。
 */

/** 数据结构版本，后续调整结构时可据此做迁移（3：新增文件夹） */
const STORE_VERSION = 4

const MAX_PROJECTS = 50
const MAX_REQUESTS_PER_PROJECT = 500
const MAX_FOLDERS_PER_PROJECT = 200
const MAX_ROWS = 300

const DEFAULT_PROJECT_NAME = '默认项目'
const IMPORT_MAX_BYTES = 64 * 1024 * 1024

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
const AUTH_TYPES = ['none', 'bearer', 'basic', 'api-key'] as const
const BODY_TYPES = ['none', 'json', 'text', 'xml', 'form-urlencoded', 'form-data', 'binary'] as const
const RESPONSE_MODES = ['display', 'file'] as const

let cache: ApiProject[] | null = null

/** 写入串行化，避免并发写同一个临时文件造成内容撕裂 */
let writeChain: Promise<unknown> = Promise.resolve()
let writeSeq = 0

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const result = writeChain.then(task, task)
  writeChain = result.catch(() => undefined)
  return result
}

export function dataFile(): string {
  return join(configDir(), 'api-projects.json')
}

/** 旧版本使用的「自动请求历史」文件，仅用于首次启动时迁移 */
function legacyHistoryFile(): string {
  return join(configDir(), 'api-history.json')
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)
}

function newProjectId(): string {
  return `p-${randomSuffix()}`
}

function newRequestId(): string {
  return `r-${randomSuffix()}`
}

function newRowId(): string {
  return `k-${randomSuffix()}`
}

function newFolderId(): string {
  return `f-${randomSuffix()}`
}

/** 请求名称为空时，用地址生成一个可读名称 */
export function deriveNameFromUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return '未命名请求'
  try {
    const parsed = new URL(/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    if (last) return `${parsed.hostname}/${decodeURIComponent(last)}`.slice(0, 60)
    return parsed.hostname.slice(0, 60) || trimmed.slice(0, 60)
  } catch {
    return trimmed.slice(0, 60)
  }
}

function normalizeProjectName(value: unknown): string {
  return str(value).replace(/\s+/g, ' ').trim().slice(0, 60)
}

function normalizeFolderName(value: unknown): string {
  return str(value).replace(/\s+/g, ' ').trim().slice(0, 40)
}

function uniqueProjectName(projects: ApiProject[], base: string): string {
  const name = normalizeProjectName(base) || DEFAULT_PROJECT_NAME
  const taken = new Set(projects.map((project) => project.name))
  if (!taken.has(name)) return name
  let index = 2
  while (taken.has(`${name} ${index}`)) index += 1
  return `${name} ${index}`
}

/* ------------------------------------------------------------------ */
/* 数据校验 / 归一化                                                    */
/* ------------------------------------------------------------------ */

function normalizeRows(value: unknown): KeyValueRow[] {
  if (!Array.isArray(value)) return []
  const rows: KeyValueRow[] = []
  for (const item of value) {
    if (!isObject(item)) continue
    const key = str(item.key)
    const rowValue = str(item.value)
    if (!key && !rowValue) continue
    rows.push({
      id: str(item.id) || newRowId(),
      enabled: bool(item.enabled, true),
      key,
      value: rowValue
    })
    if (rows.length >= MAX_ROWS) break
  }
  return rows
}

function normalizeFormRows(value: unknown): FormRow[] {
  if (!Array.isArray(value)) return []
  const rows: FormRow[] = []
  for (const item of value) {
    if (!isObject(item)) continue
    const key = str(item.key)
    const rowValue = str(item.value)
    const filePath = str(item.filePath)
    if (!key && !rowValue && !filePath) continue
    rows.push({
      id: str(item.id) || newRowId(),
      enabled: bool(item.enabled, true),
      kind: item.kind === 'file' ? 'file' : 'text',
      key,
      value: rowValue,
      filePath
    })
    if (rows.length >= MAX_ROWS) break
  }
  return rows
}

function normalizeAuth(value: unknown): HttpAuthConfig {
  const raw = isObject(value) ? value : {}
  const type: AuthType = oneOf(raw.type, AUTH_TYPES, 'none')
  return {
    type,
    token: str(raw.token),
    username: str(raw.username),
    password: str(raw.password),
    keyName: str(raw.keyName),
    keyValue: str(raw.keyValue),
    addTo: raw.addTo === 'query' ? 'query' : 'header'
  }
}

function normalizeBody(value: unknown): HttpBodyConfig {
  const raw = isObject(value) ? value : {}
  const type: BodyType = oneOf(raw.type, BODY_TYPES, 'none')
  return {
    type,
    raw: str(raw.raw),
    contentType: str(raw.contentType),
    form: normalizeFormRows(raw.form),
    filePath: str(raw.filePath)
  }
}

function normalizeOptions(value: unknown): ApiRequestOptions {
  const raw = isObject(value) ? value : {}
  return {
    timeoutMs: clamp(num(raw.timeoutMs, 30000), 1000, 600000),
    followRedirects: bool(raw.followRedirects, true),
    ignoreTlsErrors: bool(raw.ignoreTlsErrors, false),
    responseMode: oneOf(raw.responseMode, RESPONSE_MODES, 'display')
  }
}

function normalizeRecord(value: unknown, fallbackName: string, now: number): ApiRequestRecord | null {
  if (!isObject(value)) return null
  const url = str(value.url)
  return {
    id: str(value.id) || newRequestId(),
    name: normalizeProjectName(value.name) || fallbackName || deriveNameFromUrl(url),
    method: oneOf(value.method, METHODS, 'GET') as HttpMethod,
    url,
    params: normalizeRows(value.params),
    headers: normalizeRows(value.headers),
    auth: normalizeAuth(value.auth),
    body: normalizeBody(value.body),
    options: normalizeOptions(value.options),
    folderId: str(value.folderId) || null,
    order: optionalNumber(value.order),
    lastStatus: optionalNumber(value.lastStatus),
    lastOk: typeof value.lastOk === 'boolean' ? value.lastOk : undefined,
    lastDurationMs: optionalNumber(value.lastDurationMs),
    lastSentAt: optionalNumber(value.lastSentAt),
    createdAt: num(value.createdAt, now),
    updatedAt: num(value.updatedAt, now)
  }
}

function normalizeFolder(value: unknown, now: number): ApiFolder | null {
  if (!isObject(value)) return null
  const name = normalizeFolderName(value.name)
  if (!name) return null
  return {
    id: str(value.id) || newFolderId(),
    name,
    parentId: str(value.parentId) || null,
    order: optionalNumber(value.order),
    createdAt: num(value.createdAt, now),
    updatedAt: num(value.updatedAt, now)
  }
}

/**
 * 列表顺序：order 是唯一依据。
 *
 * - 新数据 / 老数据都先按创建时间生成一个默认顺序：
 *   请求「新的在前」（order 小），文件夹「旧的在前」；
 * - 之后用户拖拽时由 reorderRequests / reorderFolders 把 order 重写成 0..n-1；
 * - reset = true 用于升级迁移：整体按创建时间重排一次，避免旧的「手动排序」顺序
 *   和新规则混在一起看不出规律。
 */
type OrderDirection = 'newest-first' | 'oldest-first'

function assignMissingOrder<T extends { order?: number; createdAt: number }>(
  items: T[],
  direction: OrderDirection,
  reset = false
): void {
  const sorted = [...items].sort((left, right) =>
    direction === 'newest-first' ? right.createdAt - left.createdAt : left.createdAt - right.createdAt
  )
  if (reset) {
    sorted.forEach((item, index) => {
      item.order = index
    })
    return
  }
  let next = sorted.reduce((max, item) => Math.max(max, item.order ?? -1), -1) + 1
  for (const item of sorted) {
    if (item.order === undefined) {
      item.order = next
      next += 1
    }
  }
}

function normalizeProject(
  value: unknown,
  index: number,
  now: number,
  resetOrder = false
): ApiProject | null {
  if (!isObject(value)) return null

  const folders = Array.isArray(value.folders)
    ? dedupeFolders(
        value.folders
          .map((item) => normalizeFolder(item, now))
          .filter((item): item is ApiFolder => item !== null)
      ).slice(0, MAX_FOLDERS_PER_PROJECT)
    : []
  const folderIds = new Set(folders.map((item) => item.id))
  // 上级文件夹不存在的挂到根目录，避免出现孤儿节点
  for (const folder of folders) {
    if (folder.parentId && (!folderIds.has(folder.parentId) || folder.parentId === folder.id)) {
      folder.parentId = null
    }
  }

  const requests = Array.isArray(value.requests)
    ? value.requests
        .map((item, itemIndex) => normalizeRecord(item, `请求 ${itemIndex + 1}`, now))
        .filter((item): item is ApiRequestRecord => item !== null)
    : []
  // 指向已删除文件夹的请求回落到根目录
  for (const record of requests) {
    if (record.folderId && !folderIds.has(record.folderId)) record.folderId = null
  }
  assignMissingOrder(folders, 'oldest-first', resetOrder)
  assignMissingOrder(requests, 'newest-first', resetOrder)

  return {
    id: str(value.id) || newProjectId(),
    name: normalizeProjectName(value.name) || `项目 ${index + 1}`,
    requests: dedupeById(requests).slice(0, MAX_REQUESTS_PER_PROJECT),
    folders,
    createdAt: num(value.createdAt, now),
    updatedAt: num(value.updatedAt, now)
  }
}

/** 旧版 api-history.json 中的记录：没有名称，只有「最近一次结果」字段 */
function normalizeLegacyEntry(value: unknown, index: number, now: number): ApiRequestRecord | null {
  if (!isObject(value)) return null
  const url = str(value.url)
  const record = normalizeRecord(value, deriveNameFromUrl(url) || `历史请求 ${index + 1}`, now)
  if (!record) return null
  const status = optionalNumber(value.status)
  return {
    ...record,
    lastStatus: status,
    lastOk: typeof value.ok === 'boolean' ? value.ok : undefined,
    lastDurationMs: optionalNumber(value.durationMs),
    lastSentAt: status !== undefined ? record.createdAt : undefined
  }
}

function dedupeById(records: ApiRequestRecord[]): ApiRequestRecord[] {
  const seen = new Set<string>()
  const result: ApiRequestRecord[] = []
  for (const record of records) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    result.push(record)
  }
  return result
}

function dedupeFolders(folders: ApiFolder[]): ApiFolder[] {
  const seen = new Set<string>()
  const result: ApiFolder[] = []
  for (const folder of folders) {
    if (seen.has(folder.id)) continue
    seen.add(folder.id)
    result.push(folder)
  }
  return result
}

function normalizeDraft(draft: ApiRequestDraft, now: number): ApiRequestRecord {
  const raw = (draft ?? {}) as Partial<ApiRequestRecord>
  const url = str(raw.url)
  return {
    id: str(raw.id),
    name: normalizeProjectName(raw.name) || deriveNameFromUrl(url),
    method: oneOf(raw.method, METHODS, 'GET') as HttpMethod,
    url,
    params: normalizeRows(raw.params),
    headers: normalizeRows(raw.headers),
    auth: normalizeAuth(raw.auth),
    body: normalizeBody(raw.body),
    options: normalizeOptions(raw.options),
    folderId: str(raw.folderId) || null,
    order: optionalNumber(raw.order),
    lastStatus: optionalNumber(raw.lastStatus),
    lastOk: typeof raw.lastOk === 'boolean' ? raw.lastOk : undefined,
    lastDurationMs: optionalNumber(raw.lastDurationMs),
    lastSentAt: optionalNumber(raw.lastSentAt),
    createdAt: num(raw.createdAt, now),
    updatedAt: now
  }
}

/* ------------------------------------------------------------------ */
/* 文件读写                                                            */
/* ------------------------------------------------------------------ */

async function readTextIfExists(file: string): Promise<string | null> {
  try {
    return stripBom(await fsp.readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Windows 记事本等编辑器保存 JSON 时会带 UTF-8 BOM，解析前先去掉 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await fsp.mkdir(dirname(target), { recursive: true })
  writeSeq += 1
  const tmp = `${target}.${process.pid}.${writeSeq}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fsp.rename(tmp, target)
}

function persist(projects: ApiProject[]): Promise<void> {
  const snapshot = { version: STORE_VERSION, updatedAt: Date.now(), projects }
  return enqueueWrite(() => writeJsonAtomic(dataFile(), snapshot))
}

function buildDefaultProject(now = Date.now()): ApiProject {
  return {
    id: newProjectId(),
    name: DEFAULT_PROJECT_NAME,
    requests: [],
    folders: [],
    createdAt: now,
    updatedAt: now
  }
}

function parseProjectsFile(text: string): ApiProject[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('数据文件不是合法的 JSON')
  }

  const now = Date.now()

  // 兼容旧版 api-history.json（纯数组）
  if (Array.isArray(parsed)) {
    const requests = parsed
      .map((item, index) => normalizeLegacyEntry(item, index, now))
      .filter((item): item is ApiRequestRecord => item !== null)
    return requests.length
      ? [
          {
            id: newProjectId(),
            name: DEFAULT_PROJECT_NAME,
            requests: dedupeById(requests).slice(0, MAX_REQUESTS_PER_PROJECT),
            folders: [],
            createdAt: now,
            updatedAt: now
          }
        ]
      : []
  }

  if (!isObject(parsed) || !Array.isArray(parsed.projects)) {
    throw new Error('数据文件格式无法识别（缺少 projects 字段）')
  }

  // 4 之前「按创建时间」和「手动排序」是两种模式，升级时统一按创建时间重排一次
  const resetOrder = num(parsed.version, 1) < STORE_VERSION

  const projects = parsed.projects
    .map((item, index) => normalizeProject(item, index, now, resetOrder))
    .filter((item): item is ApiProject => item !== null)

  if (!projects.length) throw new Error('数据文件中没有任何项目')
  return projects.slice(0, MAX_PROJECTS)
}

async function migrateLegacyHistory(): Promise<ApiProject[] | null> {
  const text = await readTextIfExists(legacyHistoryFile())
  if (!text || !text.trim()) return null
  try {
    const projects = parseProjectsFile(text)
    if (!projects.length) return null
    console.info('[api-projects] 已从旧版 api-history.json 迁移请求记录')
    return projects
  } catch (error) {
    console.error('[api-projects] 旧版请求历史迁移失败，已跳过', error)
    return null
  }
}

async function backupBrokenFile(): Promise<void> {
  const target = dataFile()
  const backup = `${target}.broken-${Date.now()}.json`
  try {
    await fsp.rename(target, backup)
    console.error(`[api-projects] 数据文件无法解析，已备份到 ${backup}`)
  } catch (error) {
    console.error('[api-projects] 备份损坏的数据文件失败', error)
  }
}

/* ------------------------------------------------------------------ */
/* 读取 / 查询                                                          */
/* ------------------------------------------------------------------ */

export async function loadProjects(): Promise<ApiProject[]> {
  if (cache) return cache

  let projects: ApiProject[] | null = null
  let needsPersist = false
  const text = await readTextIfExists(dataFile())

  if (text !== null) {
    try {
      projects = parseProjectsFile(text)
    } catch (error) {
      console.error('[api-projects] 读取数据文件失败', error)
      await backupBrokenFile()
      needsPersist = true
    }
  } else {
    needsPersist = true
  }

  if (projects === null) {
    projects = await migrateLegacyHistory()
    if (projects) needsPersist = true
  }

  if (!projects || projects.length === 0) {
    projects = [buildDefaultProject()]
  }

  cache = projects

  if (needsPersist) {
    try {
      await persist(projects)
    } catch (error) {
      // 首次写入失败不影响本次使用，后续保存时还会重试
      console.error('[api-projects] 初始化数据文件失败', error)
    }
  }

  return cache
}

export async function projectsState(): Promise<{ projects: ApiProject[]; dataFile: string }> {
  return { projects: await loadProjects(), dataFile: dataFile() }
}

function requireProject(projects: ApiProject[], projectId: string): ApiProject {
  const project = projects.find((item) => item.id === projectId)
  if (!project) throw new Error('项目不存在或已被删除，请重新选择项目')
  return project
}

/* ------------------------------------------------------------------ */
/* 项目维护                                                            */
/* ------------------------------------------------------------------ */

export async function createProject(name: string): Promise<ApiProject[]> {
  const projects = await loadProjects()
  if (projects.length >= MAX_PROJECTS) throw new Error(`最多只能创建 ${MAX_PROJECTS} 个项目`)

  const now = Date.now()
  const project: ApiProject = {
    id: newProjectId(),
    name: uniqueProjectName(projects, normalizeProjectName(name) || `项目 ${projects.length + 1}`),
    requests: [],
    folders: [],
    createdAt: now,
    updatedAt: now
  }
  projects.push(project)
  await persist(projects)
  return projects
}

export async function renameProject(id: string, name: string): Promise<ApiProject[]> {
  const projects = await loadProjects()
  const project = requireProject(projects, id)
  const nextName = normalizeProjectName(name)
  if (!nextName) throw new Error('项目名称不能为空')

  const duplicate = projects.some((item) => item.id !== id && item.name === nextName)
  if (duplicate) throw new Error(`已存在名为「${nextName}」的项目`)

  project.name = nextName
  project.updatedAt = Date.now()
  await persist(projects)
  return projects
}

export async function removeProject(id: string): Promise<ApiProject[]> {
  const projects = await loadProjects()
  const next = projects.filter((item) => item.id !== id)
  // 至少保留一个项目，避免界面进入无项目可用状态
  const result = next.length ? next : [buildDefaultProject()]
  projects.splice(0, projects.length, ...result)
  await persist(projects)
  return projects
}

/* ------------------------------------------------------------------ */
/* 请求记录维护                                                        */
/* ------------------------------------------------------------------ */

export async function saveRequest(
  projectId: string,
  draft: ApiRequestDraft
): Promise<{ projects: ApiProject[]; record: ApiRequestRecord }> {
  const projects = await loadProjects()
  const project = requireProject(projects, projectId)

  const now = Date.now()
  const normalized = normalizeDraft(draft, now)
  // 目标文件夹可能已被删除，回落到根目录
  if (normalized.folderId && !project.folders.some((item) => item.id === normalized.folderId)) {
    normalized.folderId = null
  }
  const index = normalized.id
    ? project.requests.findIndex((item) => item.id === normalized.id)
    : -1

  let record: ApiRequestRecord
  if (index >= 0) {
    const existing = project.requests[index]
    record = {
      ...normalized,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      // 手动顺序由「拖拽排序」维护，保存草稿时保持原位置
      order: existing.order,
      lastStatus: normalized.lastStatus ?? existing.lastStatus,
      lastOk: normalized.lastOk ?? existing.lastOk,
      lastDurationMs: normalized.lastDurationMs ?? existing.lastDurationMs,
      lastSentAt: normalized.lastSentAt ?? existing.lastSentAt
    }
    project.requests[index] = record
  } else {
    // 新请求排在最上面（默认顺序 = 创建时间「新的在前」）
    const siblings = project.requests.filter((item) => (item.folderId ?? null) === (normalized.folderId ?? null))
    const minOrder = siblings.reduce(
      (min, item) => Math.min(min, item.order ?? 0),
      siblings.length ? Number.POSITIVE_INFINITY : 0
    )
    const nextOrder = Number.isFinite(minOrder) ? minOrder - 1 : 0
    record = { ...normalized, id: newRequestId(), order: nextOrder, createdAt: now, updatedAt: now }
    project.requests.unshift(record)
    if (project.requests.length > MAX_REQUESTS_PER_PROJECT) {
      project.requests
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .splice(MAX_REQUESTS_PER_PROJECT)
    }
  }

  project.updatedAt = now
  await persist(projects)
  return { projects, record }
}

export async function removeRequest(projectId: string, requestId: string): Promise<ApiProject[]> {
  const projects = await loadProjects()
  const project = requireProject(projects, projectId)
  const next = project.requests.filter((item) => item.id !== requestId)
  project.requests.splice(0, project.requests.length, ...next)
  project.updatedAt = Date.now()
  await persist(projects)
  return projects
}

/* ------------------------------------------------------------------ */
/* 文件夹维护                                                          */
/* ------------------------------------------------------------------ */

function requireFolder(project: ApiProject, folderId: string): ApiFolder {
  const folder = project.folders.find((item) => item.id === folderId)
  if (!folder) throw new Error('文件夹不存在或已被删除')
  return folder
}

export async function createFolder(
  projectId: string,
  name: string,
  parentId: string | null
): Promise<ApiProject[]> {
  const projects = await loadProjects()
  const project = requireProject(projects, projectId)
  if (project.folders.length >= MAX_FOLDERS_PER_PROJECT) {
    throw new Error(`每个项目最多创建 ${MAX_FOLDERS_PER_PROJECT} 个文件夹`)
  }

  const folderName = normalizeFolderName(name)
  if (!folderName) throw new Error('文件夹名称不能为空')

  const parent = parentId ? requireFolder(project, parentId) : null
  const parentKey = parent?.id ?? null
  if (project.folders.some((item) => item.parentId === parentKey && item.name === folderName)) {
    throw new Error(`当前层级已存在名为「${folderName}」的文件夹`)
  }

  const now = Date.now()
  const siblingFolders = project.folders.filter((item) => (item.parentId ?? null) === parentKey)
  const nextOrder = siblingFolders.reduce((max, item) => Math.max(max, item.order ?? 0), 0) + 1
  project.folders.push({
    id: newFolderId(),
    name: folderName,
    parentId: parentKey,
    order: nextOrder,
    createdAt: now,
    updatedAt: now
  })
  project.updatedAt = now
  await persist(projects)
  return projects
}

export async function renameFolder(projectId: string, folderId: string, name: string): Promise<ApiProject[]> {
  const projects = await loadProjects()
  const project = requireProject(projects, projectId)
  const folder = requireFolder(project, folderId)

  const folderName = normalizeFolderName(name)
  if (!folderName) throw new Error('文件夹名称不能为空')
  if (project.folders.some((item) => item.id !== folderId && item.parentId === folder.parentId && item.name === folderName)) {
    throw new Error(`当前层级已存在名为「${folderName}」的文件夹`)
  }

  folder.name = folderName
  folder.updatedAt = Date.now()
  project.updatedAt = folder.updatedAt
  await persist(projects)
  return projects
}

/** 删除文件夹时，连同它的子文件夹与这些文件夹里的请求一起删除 */
export async function removeFolder(projectId: string, folderId: string): Promise<ApiProject[]> {
  const projects = await loadProjects()
  const project = requireProject(projects, projectId)
  requireFolder(project, folderId)

  const doomed = new Set<string>([folderId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of project.folders) {
      if (folder.parentId && doomed.has(folder.parentId) && !doomed.has(folder.id)) {
        doomed.add(folder.id)
        changed = true
      }
    }
  }

  project.folders = project.folders.filter((item) => !doomed.has(item.id))
  project.requests = project.requests.filter((item) => !item.folderId || !doomed.has(item.folderId))
  project.updatedAt = Date.now()
  await persist(projects)
  return projects
}

export async function moveRequest(
  projectId: string,
  requestId: string,
  folderId: string | null
): Promise<ApiProject[]> {
  const projects = await loadProjects()
  const project = requireProject(projects, projectId)
  const record = project.requests.find((item) => item.id === requestId)
  if (!record) throw new Error('请求不存在或已被删除')

  if (folderId) requireFolder(project, folderId)
  const targetKey = folderId || null
  if ((record.folderId ?? null) !== targetKey) {
    // 换文件夹后放到目标层级最上面（和「新建请求」一致）
    const siblings = project.requests.filter(
      (item) => item.id !== record.id && (item.folderId ?? null) === targetKey
    )
    const minOrder = siblings.reduce(
      (min, item) => Math.min(min, item.order ?? 0),
      siblings.length ? Number.POSITIVE_INFINITY : 0
    )
    record.order = Number.isFinite(minOrder) ? minOrder - 1 : 0
  }
  record.folderId = targetKey
  record.updatedAt = Date.now()
  project.updatedAt = record.updatedAt
  await persist(projects)
  return projects
}

/** 手动排序：按传入顺序给同一层级下的请求重新编号 */
export async function reorderRequests(
  projectId: string,
  folderId: string | null,
  orderedIds: string[]
): Promise<ApiProject[]> {
  const projects = await loadProjects()
  const project = requireProject(projects, projectId)
  const parentKey = folderId || null
  applyOrder(
    project.requests.filter((item) => (item.folderId ?? null) === parentKey),
    orderedIds
  )
  project.updatedAt = Date.now()
  await persist(projects)
  return projects
}

/** 手动排序：按传入顺序给同一层级下的文件夹重新编号 */
export async function reorderFolders(
  projectId: string,
  parentId: string | null,
  orderedIds: string[]
): Promise<ApiProject[]> {
  const projects = await loadProjects()
  const project = requireProject(projects, projectId)
  const parentKey = parentId || null
  applyOrder(
    project.folders.filter((item) => (item.parentId ?? null) === parentKey),
    orderedIds
  )
  project.updatedAt = Date.now()
  await persist(projects)
  return projects
}

/** 把 orderedIds 里的顺序写成 0..n-1，没列到的排在最后 */
function applyOrder(items: { id: string; order?: number }[], orderedIds: string[]): void {
  const listed = new Set<string>()
  let index = 0
  for (const id of orderedIds) {
    const item = items.find((entry) => entry.id === id)
    if (!item || listed.has(id)) continue
    item.order = index
    listed.add(id)
    index += 1
  }
  for (const item of items) {
    if (listed.has(item.id)) continue
    item.order = index
    index += 1
  }
}

export async function recordResult(
  projectId: string,
  requestId: string,
  result: ApiAttemptResult
): Promise<ApiProject[]> {
  const projects = await loadProjects()
  const project = projects.find((item) => item.id === projectId)
  const record = project?.requests.find((item) => item.id === requestId)
  // 记录可能刚被删除，静默跳过即可，不影响请求本身
  if (!project || !record) return projects

  record.lastStatus = optionalNumber(result?.status)
  record.lastOk = Boolean(result?.ok)
  record.lastDurationMs = optionalNumber(result?.durationMs)
  record.lastSentAt = Date.now()
  await persist(projects)
  return projects
}

/* ------------------------------------------------------------------ */
/* 导入 / 导出（迁移到其他机器）                                        */
/* ------------------------------------------------------------------ */

export async function exportProjectsTo(filePath: string): Promise<{ requests: number }> {
  const projects = await loadProjects()
  const payload = {
    version: STORE_VERSION,
    exportedAt: Date.now(),
    generator: 'DevToolbox',
    projects
  }
  await writeJsonAtomic(filePath, payload)
  return { requests: projects.reduce((total, project) => total + project.requests.length, 0) }
}

export async function importProjectsFrom(
  filePath: string
): Promise<{ projects: ApiProject[]; importedProjects: number; importedRequests: number }> {
  const stat = await fsp.stat(filePath)
  if (stat.size > IMPORT_MAX_BYTES) throw new Error('文件过大，无法导入')

  const text = stripBom(await fsp.readFile(filePath, 'utf8'))
  const incoming = parseProjectsFile(text)
  if (!incoming.length) throw new Error('文件中没有可导入的项目')

  const projects = await loadProjects()
  const summary = mergeProjects(projects, incoming)
  await persist(projects)
  return { projects, importedProjects: summary.projects, importedRequests: summary.requests }
}

/** 导入采用「合并」策略：同一项目（id 或名称相同）追加缺失的请求，避免覆盖本地数据 */
/** 把来源项目的文件夹并入目标项目，返回「旧 id → 新 id」的映射 */
function mergeFolders(target: ApiProject, source: ApiProject): Map<string, string> {
  const remap = new Map<string, string>()
  const existing = new Map(target.folders.map((item) => [item.id, item]))

  for (const folder of source.folders) {
    if (existing.has(folder.id)) {
      remap.set(folder.id, folder.id)
      continue
    }
    const copy: ApiFolder = {
      ...folder,
      parentId: folder.parentId ? (remap.get(folder.parentId) ?? folder.parentId) : null
    }
    target.folders.push(copy)
    existing.set(copy.id, copy)
    remap.set(folder.id, copy.id)
  }

  // 父级可能比子级后合并，这里再回填一次
  for (const folder of target.folders) {
    if (folder.parentId && remap.has(folder.parentId)) {
      folder.parentId = remap.get(folder.parentId) ?? null
    }
  }
  return remap
}

function mergeProjects(
  projects: ApiProject[],
  incoming: ApiProject[]
): { projects: number; requests: number } {
  const now = Date.now()
  let projectCount = 0
  let requestCount = 0

  for (const source of incoming) {
    let target = projects.find((item) => item.id === source.id) ?? projects.find((item) => item.name === source.name)

    if (!target) {
      const project: ApiProject = {
        ...source,
        id: projects.some((item) => item.id === source.id) ? newProjectId() : source.id || newProjectId(),
        name: uniqueProjectName(projects, source.name),
        requests: [],
        folders: [],
        updatedAt: now
      }
      projects.push(project)
      target = project
      projectCount += 1
    }

    const folderRemap = mergeFolders(target, source)
    const existingIds = new Set(target.requests.map((item) => item.id))
    for (const request of source.requests) {
      if (existingIds.has(request.id)) continue
      const copy: ApiRequestRecord = {
        ...(request.id ? request : { ...request, id: newRequestId() }),
        folderId: request.folderId ? (folderRemap.get(request.folderId) ?? null) : null
      }
      target.requests.unshift(copy)
      existingIds.add(copy.id)
      requestCount += 1
    }
    target.updatedAt = now
  }

  return { projects: projectCount, requests: requestCount }
}
