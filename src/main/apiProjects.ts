import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  ApiAttemptResult,
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
 * API 请求数据（多项目 + 请求记录）的本地持久化。
 *
 * 设计目标：所有请求记录都写进一个可读的 JSON 文件（默认与 settings.json 同目录），
 * 既能在重启后恢复，也能直接拷贝 / 导出到另一台机器继续使用。
 */

/** 数据结构版本，后续调整结构时可据此做迁移 */
const STORE_VERSION = 2

const MAX_PROJECTS = 50
const MAX_REQUESTS_PER_PROJECT = 500
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
    lastStatus: optionalNumber(value.lastStatus),
    lastOk: typeof value.lastOk === 'boolean' ? value.lastOk : undefined,
    lastDurationMs: optionalNumber(value.lastDurationMs),
    lastSentAt: optionalNumber(value.lastSentAt),
    createdAt: num(value.createdAt, now),
    updatedAt: num(value.updatedAt, now)
  }
}

function normalizeProject(value: unknown, index: number, now: number): ApiProject | null {
  if (!isObject(value)) return null
  const requests = Array.isArray(value.requests)
    ? value.requests
        .map((item, itemIndex) => normalizeRecord(item, `请求 ${itemIndex + 1}`, now))
        .filter((item): item is ApiRequestRecord => item !== null)
    : []
  return {
    id: str(value.id) || newProjectId(),
    name: normalizeProjectName(value.name) || `项目 ${index + 1}`,
    requests: dedupeById(requests).slice(0, MAX_REQUESTS_PER_PROJECT),
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
            createdAt: now,
            updatedAt: now
          }
        ]
      : []
  }

  if (!isObject(parsed) || !Array.isArray(parsed.projects)) {
    throw new Error('数据文件格式无法识别（缺少 projects 字段）')
  }

  const projects = parsed.projects
    .map((item, index) => normalizeProject(item, index, now))
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
      lastStatus: normalized.lastStatus ?? existing.lastStatus,
      lastOk: normalized.lastOk ?? existing.lastOk,
      lastDurationMs: normalized.lastDurationMs ?? existing.lastDurationMs,
      lastSentAt: normalized.lastSentAt ?? existing.lastSentAt
    }
    project.requests[index] = record
  } else {
    record = { ...normalized, id: newRequestId(), createdAt: now, updatedAt: now }
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
        updatedAt: now
      }
      projects.push(project)
      target = project
      projectCount += 1
    }

    const existingIds = new Set(target.requests.map((item) => item.id))
    for (const request of source.requests) {
      if (existingIds.has(request.id)) continue
      const copy: ApiRequestRecord = request.id ? request : { ...request, id: newRequestId() }
      target.requests.unshift(copy)
      existingIds.add(copy.id)
      requestCount += 1
    }
    target.updatedAt = now
  }

  return { projects: projectCount, requests: requestCount }
}
