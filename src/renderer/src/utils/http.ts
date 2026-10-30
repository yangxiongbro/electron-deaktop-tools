import type {
  BodyType,
  FormRow,
  HttpAuthConfig,
  HttpBodyConfig,
  HttpMethod,
  HttpRequestConfig,
  KeyValueRow,
  ResponseMode
} from '@shared/types'

export interface HttpFormOptions {
  timeoutMs: number
  followRedirects: boolean
  ignoreTlsErrors: boolean
  responseMode: ResponseMode
}

export interface HttpFormState {
  method: HttpMethod
  url: string
  params: KeyValueRow[]
  headers: KeyValueRow[]
  auth: HttpAuthConfig
  body: HttpBodyConfig
  options: HttpFormOptions
}

function plainRow(row: KeyValueRow): KeyValueRow {
  return { id: row.id, enabled: row.enabled, key: row.key, value: row.value }
}

/**
 * 去掉地址里的查询串。
 *
 * 界面上的「参数」表格与地址栏的 `?a=1&b=2` 是双向同步的，发送时参数由主进程统一
 * 追加到 URL 上；这里必须先去掉地址自带的查询串，否则同一批参数会被发送两次。
 */
export function baseUrlOf(rawUrl: string): string {
  const url = rawUrl.trim()
  const queryIndex = url.indexOf('?')
  if (queryIndex === -1) return url
  const hashIndex = url.indexOf('#')
  if (hashIndex !== -1 && hashIndex < queryIndex) return url
  return url.slice(0, queryIndex)
}

function plainFormRow(row: FormRow): FormRow {
  return {
    id: row.id,
    enabled: row.enabled,
    kind: row.kind,
    key: row.key,
    value: row.value,
    filePath: row.filePath
  }
}

/**
 * 把界面的响应式表单状态转成「纯对象」再交给 IPC。
 *
 * 直接把 Vue 的 `reactive` / `ref` 代理传给 `ipcRenderer.invoke` 会报
 * `An object could not be cloned.` —— 结构化克隆不支持 Proxy。
 * 这里逐字段重建，既避开代理，也保证只传出主进程需要的字段。
 */
export function buildHttpRequestConfig(
  state: HttpFormState,
  requestId: string,
  outputPath: string,
  maxDisplayBytes: number
): HttpRequestConfig {
  const params = state.params.map(plainRow)
  // 参数表已经镜像了地址里的查询串，两者同时存在时以参数表为准（否则会重复发送）
  const hasParams = params.some((row) => row.enabled && row.key.trim() !== '')
  return {
    requestId,
    method: state.method,
    url: hasParams ? baseUrlOf(state.url) : state.url.trim(),
    params,
    headers: state.headers.map(plainRow),
    auth: {
      type: state.auth.type,
      token: state.auth.token,
      username: state.auth.username,
      password: state.auth.password,
      keyName: state.auth.keyName,
      keyValue: state.auth.keyValue,
      addTo: state.auth.addTo
    },
    body: {
      type: state.body.type as BodyType,
      raw: state.body.raw,
      contentType: state.body.contentType,
      form: state.body.form.map(plainFormRow),
      filePath: state.body.filePath
    },
    options: {
      timeoutMs: state.options.timeoutMs,
      followRedirects: state.options.followRedirects,
      ignoreTlsErrors: state.options.ignoreTlsErrors,
      responseMode: state.options.responseMode,
      outputPath,
      maxDisplayBytes
    }
  }
}
