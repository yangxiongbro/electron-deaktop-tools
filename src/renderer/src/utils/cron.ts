/* -------------------------------------------------------------------------
 * Cron 表达式工具
 *
 * 支持四种方言：
 *   - Quartz：秒 分 时 日 月 周 年（周 1=周日，日 / 周 用 ? 互斥）
 *   - Spring：秒 分 时 日 月 周
 *   - Linux ：分 时 日 月 周
 *   - Node  ：秒 分 时 日 月 周
 *
 * 包含三部分能力：
 *   1. buildExpression —— 把「时间选择器」的状态拼成表达式；
 *   2. parseCron / selectionFromExpression —— 解析表达式，并可回填到选择器；
 *   3. nextRuns —— 按指定时区推算最近 N 次运行时间。
 *
 * 时间推算在「计算时区」的墙上时间上逐级递进：年 → 月 → 日 → 时 → 分 → 秒，
 * 不匹配就直接跳到下一级，所以「每年第一天」这类稀疏表达式也只需要几十次循环。
 * ---------------------------------------------------------------------- */

export type CronDialect = 'quartz' | 'spring' | 'linux' | 'node'

export type CronFieldKey = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'week' | 'year'

export type FieldMode =
  | 'every'
  | 'none'
  | 'range'
  | 'step'
  | 'specify'
  | 'nearestWeekday'
  | 'lastDay'
  | 'lastWeekday'
  | 'nthWeekday'
  | 'lastWeekdayOfMonth'

export interface FieldSelection {
  mode: FieldMode
  /** 范围：起止值 */
  from: number
  to: number
  /** 周期：起始值与步长 */
  start: number
  step: number
  /** 指定：选中的值 */
  values: number[]
  /** 最近工作日：每月几号 */
  dayOfMonth: number
  /** 第几个星期 / 最后一个星期：星期几（0 = 周日） */
  weekday: number
  /** 第几个星期：第几个 */
  nth: number
}

export type CronSelection = Record<CronFieldKey, FieldSelection>

export interface DialectMeta {
  value: CronDialect
  label: string
  /** 表达式里各字段的中文名 */
  fields: string[]
  /** 与 fields 一一对应的字段键，用来把表达式里的第 n 段映射回选择器 */
  fieldKeys: CronFieldKey[]
  hasSeconds: boolean
  hasYear: boolean
  /** 日 / 周 互斥时另一侧用来占位的符号 */
  mask: '*' | '?'
  /** 周字段的数值基准：Quartz 的 1 表示周日，其余方言的 0 表示周日 */
  weekBase: number
  /** 是否支持 L / W / # 扩展语法 */
  extended: boolean
  /** 是否支持 ? 占位符 */
  supportsQuestion: boolean
  /** 一句话说明 */
  summary: string
}

export const DIALECT_META: Record<CronDialect, DialectMeta> = {
  quartz: {
    value: 'quartz',
    label: 'Quartz',
    fields: ['秒', '分', '时', '日', '月', '周', '年'],
    fieldKeys: ['second', 'minute', 'hour', 'day', 'month', 'week', 'year'],
    hasSeconds: true,
    hasYear: true,
    mask: '?',
    weekBase: 1,
    extended: true,
    supportsQuestion: true,
    summary: '7 个字段，含秒与年；日 / 周 必须有一个写成 ?'
  },
  spring: {
    value: 'spring',
    label: 'Spring',
    fields: ['秒', '分', '时', '日', '月', '周'],
    fieldKeys: ['second', 'minute', 'hour', 'day', 'month', 'week'],
    hasSeconds: true,
    hasYear: false,
    mask: '*',
    weekBase: 0,
    extended: true,
    supportsQuestion: true,
    summary: '6 个字段，含秒；不支持年字段'
  },
  linux: {
    value: 'linux',
    label: 'Linux',
    fields: ['分', '时', '日', '月', '周'],
    fieldKeys: ['minute', 'hour', 'day', 'month', 'week'],
    hasSeconds: false,
    hasYear: false,
    mask: '*',
    weekBase: 0,
    extended: false,
    supportsQuestion: false,
    summary: '5 个字段（crontab），无秒字段，不支持 L / W / #'
  },
  node: {
    value: 'node',
    label: 'Node',
    fields: ['秒', '分', '时', '日', '月', '周'],
    fieldKeys: ['second', 'minute', 'hour', 'day', 'month', 'week'],
    hasSeconds: true,
    hasYear: false,
    mask: '*',
    weekBase: 0,
    extended: false,
    supportsQuestion: false,
    summary: '6 个字段（node-cron），支持秒，不支持 L / W / #'
  }
}

export const DIALECT_LIST: DialectMeta[] = [
  DIALECT_META.quartz,
  DIALECT_META.spring,
  DIALECT_META.linux,
  DIALECT_META.node
]

export const WEEKDAY_LABELS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
export const WEEKDAY_SHORT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const CHINESE_MONTHS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

const MONTH_NAMES: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12
}

const WEEK_NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6
}

/** 年字段的可选范围：当前年份起 31 年（与需求里的选择器截图一致） */
const YEAR_MIN = new Date().getFullYear()
const YEAR_MAX = YEAR_MIN + 30

export interface FieldConfig {
  key: CronFieldKey
  title: string
  /** 单位文案（用在「从 x 到 y 单位」里） */
  unit: string
  everyLabel: string
  everyHint: string
  min: number
  max: number
  /** 数字补零宽度，用于「指定」里的按钮文本 */
  pad: number
  modes: FieldMode[]
}

export const FIELD_CONFIGS: Record<CronFieldKey, FieldConfig> = {
  second: {
    key: 'second',
    title: '秒',
    unit: '秒',
    everyLabel: '每秒',
    everyHint: '秒字段匹配每一秒（*）',
    min: 0,
    max: 59,
    pad: 2,
    modes: ['every', 'range', 'step', 'specify']
  },
  minute: {
    key: 'minute',
    title: '分钟',
    unit: '分钟',
    everyLabel: '每分',
    everyHint: '分钟字段匹配每一分钟（*）',
    min: 0,
    max: 59,
    pad: 2,
    modes: ['every', 'range', 'step', 'specify']
  },
  hour: {
    key: 'hour',
    title: '小时',
    unit: '小时',
    everyLabel: '每时',
    everyHint: '小时字段匹配每一小时（*）',
    min: 0,
    max: 23,
    pad: 2,
    modes: ['every', 'range', 'step', 'specify']
  },
  day: {
    key: 'day',
    title: '日',
    unit: '日',
    everyLabel: '每日',
    everyHint: '日期字段匹配每一天（*）',
    min: 1,
    max: 31,
    pad: 2,
    modes: ['every', 'none', 'range', 'step', 'specify', 'nearestWeekday', 'lastDay', 'lastWeekday']
  },
  month: {
    key: 'month',
    title: '月',
    unit: '月',
    everyLabel: '每月',
    everyHint: '月份字段匹配每一个月（*）',
    min: 1,
    max: 12,
    pad: 2,
    modes: ['every', 'range', 'step', 'specify']
  },
  week: {
    key: 'week',
    title: '周',
    unit: '个星期',
    everyLabel: '每周',
    everyHint: '星期字段匹配每一天（*）',
    min: 0,
    max: 6,
    pad: 1,
    modes: ['every', 'none', 'range', 'nthWeekday', 'lastWeekdayOfMonth', 'specify']
  },
  year: {
    key: 'year',
    title: '年',
    unit: '年',
    everyLabel: '每年',
    everyHint: '年份字段匹配每一年（*）',
    min: YEAR_MIN,
    max: YEAR_MAX,
    pad: 0,
    modes: ['every', 'range', 'step', 'specify']
  }
}

/** 选择器里的字段顺序 */
export const FIELD_ORDER: CronFieldKey[] = ['second', 'minute', 'hour', 'day', 'month', 'week', 'year']

/** 依赖 L / W / # 扩展语法的模式，Linux 与 Node 不支持 */
const EXTENDED_MODES: FieldMode[] = ['nearestWeekday', 'lastDay', 'lastWeekday', 'nthWeekday', 'lastWeekdayOfMonth']

/** 当前表达式类型下应当禁用的模式 */
export function disabledModesFor(dialect: CronDialect): FieldMode[] {
  return DIALECT_META[dialect].extended ? [] : EXTENDED_MODES
}

/** 当前表达式类型是否包含该字段（Linux 没有秒，非 Quartz 没有年） */
export function hasField(dialect: CronDialect, key: CronFieldKey): boolean {
  const meta = DIALECT_META[dialect]
  if (key === 'second') return meta.hasSeconds
  if (key === 'year') return meta.hasYear
  return true
}

/** 字段不被当前表达式类型支持时的说明文案 */
export function missingFieldHint(dialect: CronDialect, key: CronFieldKey): string {
  if (hasField(dialect, key) || (key !== 'second' && key !== 'year')) return ''
  const meta = DIALECT_META[dialect]
  return `${meta.label} 表达式没有「${key === 'second' ? '秒' : '年'}」字段`
}

export const MODE_LABELS: Record<FieldMode, string> = {
  every: '每',
  none: '不指定',
  range: '范围',
  step: '周期',
  specify: '指定',
  nearestWeekday: '最近工作日',
  lastDay: '最后一天',
  lastWeekday: '最后工作日',
  nthWeekday: '第几个星期',
  lastWeekdayOfMonth: '最后一个星期'
}

/** 「指定」里按钮上显示的文字 */
export function formatFieldValue(key: CronFieldKey, value: number, pad = 0): string {
  if (key === 'month') return `${CHINESE_MONTHS[value - 1]}月`
  if (key === 'week') return WEEKDAY_LABELS[value] ?? String(value)
  if (key === 'year') return String(value)
  return String(value).padStart(pad, '0')
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** 星期（0=周日）换算成各方言里的数值 */
function weekValue(canonical: number, dialect: CronDialect): number {
  return ((canonical % 7) + 7) % 7 + DIALECT_META[dialect].weekBase
}

export function createFieldSelection(
  key: CronFieldKey,
  mode: FieldMode = 'every',
  overrides: Partial<FieldSelection> = {}
): FieldSelection {
  const config = FIELD_CONFIGS[key]
  return {
    mode,
    from: config.min,
    to: Math.min(config.min + 1, config.max),
    start: config.min,
    step: 1,
    values: [],
    dayOfMonth: config.min,
    weekday: 1,
    nth: 1,
    ...overrides
  }
}

/** 默认表达式：每天 09:00:00 */
export function createDefaultSelection(): CronSelection {
  return {
    second: createFieldSelection('second', 'specify', { values: [0] }),
    minute: createFieldSelection('minute', 'specify', { values: [0] }),
    hour: createFieldSelection('hour', 'specify', { values: [9] }),
    day: createFieldSelection('day', 'every'),
    month: createFieldSelection('month', 'every'),
    week: createFieldSelection('week', 'none'),
    year: createFieldSelection('year', 'every')
  }
}

export function cloneSelection(selection: CronSelection): CronSelection {
  return {
    second: { ...selection.second, values: [...selection.second.values] },
    minute: { ...selection.minute, values: [...selection.minute.values] },
    hour: { ...selection.hour, values: [...selection.hour.values] },
    day: { ...selection.day, values: [...selection.day.values] },
    month: { ...selection.month, values: [...selection.month.values] },
    week: { ...selection.week, values: [...selection.week.values] },
    year: { ...selection.year, values: [...selection.year.values] }
  }
}

/** 该字段是否限制了取值（「全部」和「不指定」都算未限制） */
export function isRestricted(selection: FieldSelection): boolean {
  return selection.mode !== 'every' && selection.mode !== 'none'
}

/* ------------------------------ 生成表达式 ------------------------------ */

function fieldExpression(key: CronFieldKey, selection: FieldSelection, dialect: CronDialect): string {
  const config = FIELD_CONFIGS[key]
  const name = (value: number): string =>
    key === 'week' ? String(weekValue(value, dialect)) : String(value)

  switch (selection.mode) {
    case 'every':
      return '*'
    case 'none':
      return DIALECT_META[dialect].mask
    case 'range': {
      const low = Math.min(clamp(selection.from, config.min, config.max), clamp(selection.to, config.min, config.max))
      const high = Math.max(clamp(selection.from, config.min, config.max), clamp(selection.to, config.min, config.max))
      return `${name(low)}-${name(high)}`
    }
    case 'step': {
      const start = clamp(selection.start, config.min, config.max)
      const step = Math.max(1, Math.floor(selection.step) || 1)
      // 从最小值开始时用 */n（crontab 只认这种写法），否则写成「起点-上限/n」
      if (start === config.min && key !== 'year') return `*/${step}`
      return `${name(start)}-${name(config.max)}/${step}`
    }
    case 'specify': {
      const values = [...new Set(selection.values.map((value) => clamp(value, config.min, config.max)))]
      if (!values.length) return '*'
      values.sort((left, right) => left - right)
      return values.map(name).join(',')
    }
    case 'nearestWeekday':
      return `${clamp(selection.dayOfMonth, 1, 31)}W`
    case 'lastDay':
      return 'L'
    case 'lastWeekday':
      return 'LW'
    case 'nthWeekday':
      return `${weekValue(selection.weekday, dialect)}#${clamp(selection.nth, 1, 5)}`
    case 'lastWeekdayOfMonth':
      return `${weekValue(selection.weekday, dialect)}L`
    default:
      return '*'
  }
}

export function buildExpression(selection: CronSelection, dialect: CronDialect): string {
  const meta = DIALECT_META[dialect]
  const dayRestricted = isRestricted(selection.day)
  const weekRestricted = isRestricted(selection.week)

  let dayText: string
  let weekText: string
  if (dayRestricted && !weekRestricted) {
    // 日受限 → 周写占位符
    dayText = fieldExpression('day', selection.day, dialect)
    weekText = meta.mask
  } else if (weekRestricted && !dayRestricted) {
    // 周受限 → 日写占位符
    dayText = meta.mask
    weekText = fieldExpression('week', selection.week, dialect)
  } else {
    dayText = dayRestricted ? fieldExpression('day', selection.day, dialect) : '*'
    weekText = weekRestricted ? fieldExpression('week', selection.week, dialect) : meta.mask
  }

  const parts: string[] = []
  if (meta.hasSeconds) parts.push(fieldExpression('second', selection.second, dialect))
  parts.push(fieldExpression('minute', selection.minute, dialect))
  parts.push(fieldExpression('hour', selection.hour, dialect))
  parts.push(dayText)
  parts.push(fieldExpression('month', selection.month, dialect))
  parts.push(weekText)
  if (meta.hasYear) parts.push(fieldExpression('year', selection.year, dialect))
  return parts.join(' ')
}

/* ------------------------------ 解析表达式 ------------------------------ */

export class CronParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CronParseError'
  }
}

function toNumberToken(token: string, label: string): number {
  const text = token.trim()
  if (!/^\d+$/.test(text)) throw new CronParseError(`${label}字段里的「${token}」不是有效数字`)
  return Number(text)
}

function toValue(
  token: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
  label: string
): number {
  const text = token.trim().toLowerCase()
  if (names && Object.prototype.hasOwnProperty.call(names, text)) return names[text]
  if (!/^\d+$/.test(text)) throw new CronParseError(`${label}字段里的「${token}」不是有效取值`)
  const value = Number(text)
  if (value < min || value > max) throw new CronParseError(`${label}字段取值 ${value} 超出 ${min}~${max} 的范围`)
  return value
}

function expandPiece(
  piece: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
  label: string
): number[] {
  const slashIndex = piece.indexOf('/')
  const body = slashIndex >= 0 ? piece.slice(0, slashIndex) : piece
  let step = 1
  if (slashIndex >= 0) {
    step = toNumberToken(piece.slice(slashIndex + 1), label)
    if (step <= 0) throw new CronParseError(`${label}字段的步长必须大于 0`)
  }

  let start: number
  let end: number
  if (body === '*' || body === '?') {
    start = min
    end = max
  } else if (body.includes('-')) {
    const [left, right] = body.split('-')
    start = toValue(left, min, max, names, label)
    end = toValue(right, min, max, names, label)
    if (end < start) throw new CronParseError(`${label}字段的范围「${body}」起点大于终点`)
  } else {
    start = toValue(body, min, max, names, label)
    end = slashIndex >= 0 ? max : start
  }

  const values: number[] = []
  for (let value = start; value <= end; value += step) values.push(value)
  return values
}

function parseNumericField(
  text: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
  label: string
): Set<number> {
  const result = new Set<number>()
  for (const rawPiece of text.split(',')) {
    const piece = rawPiece.trim()
    if (!piece) throw new CronParseError(`${label}字段里有多余的逗号`)
    for (const value of expandPiece(piece, min, max, names, label)) result.add(value)
  }
  if (result.size === 0) throw new CronParseError(`${label}字段没有有效取值`)
  return result
}

function weekNamesWithBase(base: number): Record<string, number> {
  const names: Record<string, number> = {}
  for (const [name, canonical] of Object.entries(WEEK_NAMES)) names[name] = canonical + base
  return names
}

function toWeekday(token: string, dialect: CronDialect): number {
  const base = DIALECT_META[dialect].weekBase
  const value = toValue(token, base, base + 6, weekNamesWithBase(base), '周')
  return (((value - base) % 7) + 7) % 7
}

export interface DomMatcher {
  days: Set<number>
  /** L / L-n：当月倒数第几天（0 表示最后一天） */
  lastOffset: number | null
  lastWeekday: boolean
  nearestWeekday: number | null
}

export interface DowMatcher {
  days: Set<number>
  /** nL：当月最后一个星期 n */
  lastOf: number | null
  /** n#m：当月第 m 个星期 n */
  nthWeekday: { weekday: number; nth: number } | null
}

export interface CronSchedule {
  dialect: CronDialect
  source: string
  hasSeconds: boolean
  raw: Record<CronFieldKey, string>
  seconds: Set<number>
  minutes: Set<number>
  hours: Set<number>
  months: Set<number>
  years: Set<number> | null
  dom: DomMatcher
  dow: DowMatcher
  domRestricted: boolean
  dowRestricted: boolean
}

/** 把表达式拆成 7 个字段（缺失的秒 / 年补默认值），顺便校验字段个数 */
function toFieldMap(tokens: string[], dialect: CronDialect): Record<CronFieldKey, string> {
  const meta = DIALECT_META[dialect]
  if (dialect === 'quartz') {
    if (tokens.length !== 6 && tokens.length !== 7) {
      throw new CronParseError('Quartz 表达式需要 6 个或 7 个字段：秒 分 时 日 月 周 [年]')
    }
    return {
      second: tokens[0],
      minute: tokens[1],
      hour: tokens[2],
      day: tokens[3],
      month: tokens[4],
      week: tokens[5],
      year: tokens[6] ?? '*'
    }
  }
  if (dialect === 'linux') {
    if (tokens.length !== 5) {
      throw new CronParseError('Linux 表达式需要 5 个字段：分 时 日 月 周')
    }
    return {
      second: '0',
      minute: tokens[0],
      hour: tokens[1],
      day: tokens[2],
      month: tokens[3],
      week: tokens[4],
      year: '*'
    }
  }
  if (dialect === 'node') {
    // node-cron 5 个字段时按「分 时 日 月 周」理解
    if (tokens.length !== 5 && tokens.length !== 6) {
      throw new CronParseError('Node 表达式需要 5 个或 6 个字段：秒 分 时 日 月 周')
    }
    if (tokens.length === 5) {
      return {
        second: '0',
        minute: tokens[0],
        hour: tokens[1],
        day: tokens[2],
        month: tokens[3],
        week: tokens[4],
        year: '*'
      }
    }
  }
  if (tokens.length !== 6) {
    throw new CronParseError(`${meta.label} 表达式需要 6 个字段：秒 分 时 日 月 周`)
  }
  return {
    second: tokens[0],
    minute: tokens[1],
    hour: tokens[2],
    day: tokens[3],
    month: tokens[4],
    week: tokens[5],
    year: '*'
  }
}

function parseDayOfMonthField(text: string): DomMatcher {
  const matcher: DomMatcher = { days: new Set(), lastOffset: null, lastWeekday: false, nearestWeekday: null }
  const trimmed = text.trim().toUpperCase()
  if (trimmed === '?' || trimmed === '*') return matcher

  for (const rawPiece of trimmed.split(',')) {
    const piece = rawPiece.trim()
    if (!piece) throw new CronParseError('日字段里有多余的逗号')
    if (piece === 'L') {
      matcher.lastOffset = 0
    } else if (piece === 'LW' || piece === 'WL') {
      matcher.lastWeekday = true
    } else if (/^L-\d+$/.test(piece)) {
      matcher.lastOffset = Number(piece.slice(2))
    } else if (/^\d+W$/.test(piece)) {
      matcher.nearestWeekday = Number(piece.slice(0, -1))
    } else if (/[LW]/.test(piece)) {
      throw new CronParseError(`不支持的日字段写法「${piece}」，支持 L、LW、nW、L-n`)
    } else {
      for (const value of expandPiece(piece, 1, 31, null, '日')) matcher.days.add(value)
    }
  }
  return matcher
}

function parseDayOfWeekField(text: string, dialect: CronDialect): DowMatcher {
  const matcher: DowMatcher = { days: new Set(), lastOf: null, nthWeekday: null }
  const trimmed = text.trim().toUpperCase()
  if (trimmed === '?' || trimmed === '*') return matcher

  const base = DIALECT_META[dialect].weekBase
  const names = weekNamesWithBase(base)
  for (const rawPiece of trimmed.split(',')) {
    const piece = rawPiece.trim()
    if (!piece) throw new CronParseError('周字段里有多余的逗号')
    if (piece === 'L') {
      // Quartz 里单独写 L 表示「最后一个星期六」
      matcher.lastOf = 6
    } else if (piece.includes('#')) {
      const [left, right] = piece.split('#')
      const nth = toNumberToken(right, '周')
      if (nth < 1 || nth > 5) throw new CronParseError('「第几个星期」只能是 1~5')
      matcher.nthWeekday = { weekday: toWeekday(left, dialect), nth }
    } else if (piece.endsWith('L')) {
      matcher.lastOf = toWeekday(piece.slice(0, -1), dialect)
    } else {
      for (const value of expandPiece(piece, base, base + 6, names, '周')) {
        matcher.days.add((((value - base) % 7) + 7) % 7)
      }
    }
  }
  return matcher
}

export function parseCron(expression: string, dialect: CronDialect): CronSchedule {
  const tokens = expression.trim().split(/\s+/).filter((token) => token.length > 0)
  if (!tokens.length) throw new CronParseError('表达式不能为空')

  const meta = DIALECT_META[dialect]
  const raw = toFieldMap(tokens, dialect)

  const seconds = meta.hasSeconds ? parseNumericField(raw.second, 0, 59, null, '秒') : new Set<number>([0])
  const minutes = parseNumericField(raw.minute, 0, 59, null, '分')
  const hours = parseNumericField(raw.hour, 0, 23, null, '时')
  const months = parseNumericField(raw.month, 1, 12, MONTH_NAMES, '月')

  const dayRaw = raw.day.trim().toUpperCase()
  const weekRaw = raw.week.trim().toUpperCase()
  const domRestricted = dayRaw !== '?' && dayRaw !== '*'
  const dowRestricted = weekRaw !== '?' && weekRaw !== '*'

  const dom: DomMatcher = domRestricted
    ? parseDayOfMonthField(raw.day)
    : { days: new Set(), lastOffset: null, lastWeekday: false, nearestWeekday: null }
  const dow: DowMatcher = dowRestricted
    ? parseDayOfWeekField(raw.week, dialect)
    : { days: new Set(), lastOf: null, nthWeekday: null }

  const yearText = raw.year.trim().toUpperCase()
  const years = meta.hasYear && yearText === '*' ? null : parseNumericField(raw.year, 1970, 2199, null, '年')

  return {
    dialect,
    source: expression.trim(),
    hasSeconds: meta.hasSeconds,
    raw,
    seconds,
    minutes,
    hours,
    months,
    years,
    dom,
    dow,
    domRestricted,
    dowRestricted
  }
}

/* --------------------------- 表达式回填选择器 --------------------------- */

function selectionValue(key: CronFieldKey, dialect: CronDialect, value: number): number {
  if (key !== 'week') return value
  const base = DIALECT_META[dialect].weekBase
  return (((value - base) % 7) + 7) % 7
}

/** 把表达式里的一个取值换算成选择器里的取值（周字段统一成 0=周日） */
function selectionNumber(key: CronFieldKey, dialect: CronDialect, token: string, fallback: number): number {
  if (key !== 'week') {
    const value = Number(token)
    return Number.isFinite(value) ? value : fallback
  }
  try {
    return toWeekday(token, dialect)
  } catch {
    return fallback
  }
}

function fieldSelectionFromText(key: CronFieldKey, rawText: string, dialect: CronDialect): FieldSelection {
  const config = FIELD_CONFIGS[key]
  const base = createFieldSelection(key, 'every')
  const text = rawText.trim().toUpperCase()

  if (text === '*') return base
  if (text === '?') return { ...base, mode: 'none' }

  if (key === 'day') {
    if (text === 'L' || /^L-\d+$/.test(text)) return { ...base, mode: 'lastDay' }
    if (text === 'LW') return { ...base, mode: 'lastWeekday' }
    if (/^\d+W$/.test(text)) return { ...base, mode: 'nearestWeekday', dayOfMonth: Number(text.slice(0, -1)) }
  }
  if (key === 'week') {
    if (text.includes('#')) {
      const [left, right] = text.split('#')
      return {
        ...base,
        mode: 'nthWeekday',
        weekday: selectionNumber('week', dialect, left, 1),
        nth: Number(right) || 1
      }
    }
    // 单独的 L 在 Quartz 里表示「最后一个星期六」
    if (text === 'L') return { ...base, mode: 'lastWeekdayOfMonth', weekday: 6 }
    if (text.endsWith('L') && text.length > 1) {
      return {
        ...base,
        mode: 'lastWeekdayOfMonth',
        weekday: selectionNumber('week', dialect, text.slice(0, -1), 5)
      }
    }
  }

  if (text.includes('/')) {
    const [left, right] = text.split('/')
    const step = Number(right)
    const start = left === '*' ? config.min : selectionNumber(key, dialect, left, config.min)
    return { ...base, mode: 'step', start, step: Number.isFinite(step) && step > 0 ? step : 1 }
  }

  if (!text.includes(',') && text.includes('-')) {
    const [left, right] = text.split('-')
    const first = selectionNumber(key, dialect, left, config.min)
    const second = selectionNumber(key, dialect, right, config.max)
    return { ...base, mode: 'range', from: Math.min(first, second), to: Math.max(first, second) }
  }

  const values: number[] = []
  if (key === 'week') {
    const weekBase = DIALECT_META[dialect].weekBase
    for (const value of parseNumericField(text, weekBase, weekBase + 6, weekNamesWithBase(weekBase), '周')) {
      values.push(selectionValue('week', dialect, value))
    }
  } else {
    // 年字段的取值可能超出选择器范围（例如解析历史表达式），这里放宽后再收敛到可选区间
    const low = key === 'year' ? 1970 : config.min
    const high = key === 'year' ? 2199 : config.max
    for (const value of parseNumericField(rawText, low, high, null, config.title)) {
      values.push(clamp(value, config.min, config.max))
    }
  }
  values.sort((left, right) => left - right)
  return { ...base, mode: 'specify', values }
}

/**
 * 把表达式解析后回填到选择器。
 * 解析失败会抛出 CronParseError。
 */
export function selectionFromExpression(expression: string, dialect: CronDialect): CronSelection {
  const tokens = expression.trim().split(/\s+/).filter((token) => token.length > 0)
  const raw = toFieldMap(tokens, dialect)
  // 先整体校验一遍，保证回填的表达式确实可用
  parseCron(expression, dialect)

  const meta = DIALECT_META[dialect]
  const selection: CronSelection = {
    second: meta.hasSeconds ? fieldSelectionFromText('second', raw.second, dialect) : createFieldSelection('second', 'specify', { values: [0] }),
    minute: fieldSelectionFromText('minute', raw.minute, dialect),
    hour: fieldSelectionFromText('hour', raw.hour, dialect),
    day: fieldSelectionFromText('day', raw.day, dialect),
    month: fieldSelectionFromText('month', raw.month, dialect),
    week: fieldSelectionFromText('week', raw.week, dialect),
    year: meta.hasYear ? fieldSelectionFromText('year', raw.year, dialect) : createFieldSelection('year', 'every')
  }
  return selection
}

/* ---------------------------- 最近运行时间 ---------------------------- */

export interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export interface NextRun {
  /** 真实时刻 */
  date: Date
  /** 该时刻在计算时区里的墙上时间 */
  parts: WallTime
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

export function wallTimeInZone(date: Date, timeZone: string): WallTime {
  const parts = formatterFor(timeZone).formatToParts(date)
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)
    return found ? Number(found.value) : 0
  }
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second')
  }
}

/** 该时刻在指定时区相对 UTC 的偏移（毫秒） */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const wall = wallTimeInZone(new Date(instantMs), timeZone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return asUtc - instantMs
}

/** 墙上时间 → 真实时刻（夏令时重叠时取第一次出现的时刻） */
export function dateFromWall(wall: WallTime, timeZone: string): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  let stamp = naive - zoneOffsetMs(naive, timeZone)
  stamp = naive - zoneOffsetMs(stamp, timeZone)
  return new Date(stamp)
}

function normalizeWall(wall: WallTime): void {
  const date = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second))
  wall.year = date.getUTCFullYear()
  wall.month = date.getUTCMonth() + 1
  wall.day = date.getUTCDate()
  wall.hour = date.getUTCHours()
  wall.minute = date.getUTCMinutes()
  wall.second = date.getUTCSeconds()
}

function daysInMonthOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/** 墙上时间对应的星期（0 = 周日），与运行在哪个时区无关 */
export function wallWeekday(wall: WallTime): number {
  return weekdayOf(wall.year, wall.month, wall.day)
}

/** 每月 target 号最近的工作日（Quartz 的 nW） */
function nearestWeekdayDay(year: number, month: number, target: number): number {
  const total = daysInMonthOf(year, month)
  const day = Math.min(target, total)
  const weekday = weekdayOf(year, month, day)
  if (weekday === 6) return day === 1 ? 3 : day - 1
  if (weekday === 0) return day === total ? total - 2 : day + 1
  return day
}

function lastWeekdayOfMonth(year: number, month: number): number {
  let day = daysInMonthOf(year, month)
  while (day > 1) {
    const weekday = weekdayOf(year, month, day)
    if (weekday !== 0 && weekday !== 6) break
    day -= 1
  }
  return day
}

function matchDayOfMonth(matcher: DomMatcher, year: number, month: number, day: number): boolean {
  const total = daysInMonthOf(year, month)
  if (matcher.lastOffset !== null) return day === total - matcher.lastOffset
  if (matcher.lastWeekday) return day === lastWeekdayOfMonth(year, month)
  if (matcher.nearestWeekday !== null) return day === nearestWeekdayDay(year, month, matcher.nearestWeekday)
  return matcher.days.has(day)
}

function matchDayOfWeek(matcher: DowMatcher, year: number, month: number, day: number): boolean {
  const weekday = weekdayOf(year, month, day)
  if (matcher.lastOf !== null) {
    return weekday === matcher.lastOf && day + 7 > daysInMonthOf(year, month)
  }
  if (matcher.nthWeekday) {
    return weekday === matcher.nthWeekday.weekday && Math.ceil(day / 7) === matcher.nthWeekday.nth
  }
  return matcher.days.has(weekday)
}

function dayMatches(schedule: CronSchedule, wall: WallTime): boolean {
  const domOk = schedule.domRestricted ? matchDayOfMonth(schedule.dom, wall.year, wall.month, wall.day) : true
  const dowOk = schedule.dowRestricted ? matchDayOfWeek(schedule.dow, wall.year, wall.month, wall.day) : true
  // 日与周同时受限时按 cron 惯例取「或」；只有一边受限时另一边必然为真
  if (schedule.domRestricted && schedule.dowRestricted) return domOk || dowOk
  return domOk && dowOk
}

/**
 * 推算接下来 count 次运行时间。
 * @param from 起始时刻，默认当前时间
 */
export function nextRuns(schedule: CronSchedule, count: number, timeZone: string, from = new Date()): NextRun[] {
  const results: NextRun[] = []
  if (count <= 0) return results

  const cursor: WallTime = { ...wallTimeInZone(from, timeZone) }
  // 从「下一次」开始：有秒字段就往后推 1 秒，否则推 1 分钟
  if (schedule.hasSeconds) {
    cursor.second += 1
  } else {
    cursor.minute += 1
    cursor.second = 0
  }
  normalizeWall(cursor)

  const maxYear = cursor.year + 60
  let guard = 0
  while (results.length < count && guard < 400_000) {
    guard += 1
    if (cursor.year > maxYear) break

    if (schedule.years && !schedule.years.has(cursor.year)) {
      cursor.year += 1
      cursor.month = 1
      cursor.day = 1
      cursor.hour = 0
      cursor.minute = 0
      cursor.second = 0
      continue
    }
    if (!schedule.months.has(cursor.month)) {
      cursor.month += 1
      cursor.day = 1
      cursor.hour = 0
      cursor.minute = 0
      cursor.second = 0
      normalizeWall(cursor)
      continue
    }
    if (!dayMatches(schedule, cursor)) {
      cursor.day += 1
      cursor.hour = 0
      cursor.minute = 0
      cursor.second = 0
      normalizeWall(cursor)
      continue
    }
    if (!schedule.hours.has(cursor.hour)) {
      cursor.hour += 1
      cursor.minute = 0
      cursor.second = 0
      normalizeWall(cursor)
      continue
    }
    if (!schedule.minutes.has(cursor.minute)) {
      cursor.minute += 1
      cursor.second = 0
      normalizeWall(cursor)
      continue
    }
    if (!schedule.seconds.has(cursor.second)) {
      cursor.second += 1
      normalizeWall(cursor)
      continue
    }

    results.push({ date: dateFromWall(cursor, timeZone), parts: { ...cursor } })
    if (schedule.hasSeconds) {
      cursor.second += 1
    } else {
      cursor.minute += 1
      cursor.second = 0
    }
    normalizeWall(cursor)
  }

  return results
}

/* ------------------------------ 常用定时 ------------------------------ */

export interface CronPreset {
  key: string
  label: string
  create: () => CronSelection
}

function preset(
  second: FieldSelection,
  minute: FieldSelection,
  hour: FieldSelection,
  day: FieldSelection,
  month: FieldSelection,
  week: FieldSelection
): CronSelection {
  return { second, minute, hour, day, month, week, year: createFieldSelection('year', 'every') }
}

const everyDay = (): FieldSelection => createFieldSelection('day', 'every')
const everyMonth = (): FieldSelection => createFieldSelection('month', 'every')
const noWeek = (): FieldSelection => createFieldSelection('week', 'none')

export const CRON_PRESETS: CronPreset[] = [
  {
    key: 'minute',
    label: '每分钟',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'every'),
        createFieldSelection('hour', 'every'),
        everyDay(),
        everyMonth(),
        noWeek()
      )
  },
  {
    key: 'minute10',
    label: '每10分钟',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'step', { start: 0, step: 10 }),
        createFieldSelection('hour', 'every'),
        everyDay(),
        everyMonth(),
        noWeek()
      )
  },
  {
    key: 'hour',
    label: '每小时',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'specify', { values: [0] }),
        createFieldSelection('hour', 'every'),
        everyDay(),
        everyMonth(),
        noWeek()
      )
  },
  {
    key: 'hour2',
    label: '每2小时',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'specify', { values: [0] }),
        createFieldSelection('hour', 'step', { start: 0, step: 2 }),
        everyDay(),
        everyMonth(),
        noWeek()
      )
  },
  {
    key: 'daily930',
    label: '每天9:30',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'specify', { values: [30] }),
        createFieldSelection('hour', 'specify', { values: [9] }),
        everyDay(),
        everyMonth(),
        noWeek()
      )
  },
  {
    key: 'workday9',
    label: '工作日9点',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'specify', { values: [0] }),
        createFieldSelection('hour', 'specify', { values: [9] }),
        createFieldSelection('day', 'none'),
        everyMonth(),
        createFieldSelection('week', 'range', { from: 1, to: 5 })
      )
  },
  {
    key: 'monday9',
    label: '每周一9点',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'specify', { values: [0] }),
        createFieldSelection('hour', 'specify', { values: [9] }),
        createFieldSelection('day', 'none'),
        everyMonth(),
        createFieldSelection('week', 'specify', { values: [1] })
      )
  },
  {
    key: 'saturday10',
    label: '每周六10点',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'specify', { values: [0] }),
        createFieldSelection('hour', 'specify', { values: [10] }),
        createFieldSelection('day', 'none'),
        everyMonth(),
        createFieldSelection('week', 'specify', { values: [6] })
      )
  },
  {
    key: 'month1',
    label: '每个月1号',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'specify', { values: [0] }),
        createFieldSelection('hour', 'specify', { values: [0] }),
        createFieldSelection('day', 'specify', { values: [1] }),
        everyMonth(),
        noWeek()
      )
  },
  {
    key: 'monthLast',
    label: '每个月最后一天',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'specify', { values: [0] }),
        createFieldSelection('hour', 'specify', { values: [0] }),
        createFieldSelection('day', 'lastDay'),
        everyMonth(),
        noWeek()
      )
  },
  {
    key: 'quarterFirst',
    label: '每季度第一天',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'specify', { values: [0] }),
        createFieldSelection('hour', 'specify', { values: [0] }),
        createFieldSelection('day', 'specify', { values: [1] }),
        createFieldSelection('month', 'specify', { values: [1, 4, 7, 10] }),
        noWeek()
      )
  },
  {
    key: 'yearFirst',
    label: '每年第一天',
    create: () =>
      preset(
        createFieldSelection('second', 'specify', { values: [0] }),
        createFieldSelection('minute', 'specify', { values: [0] }),
        createFieldSelection('hour', 'specify', { values: [0] }),
        createFieldSelection('day', 'specify', { values: [1] }),
        createFieldSelection('month', 'specify', { values: [1] }),
        noWeek()
      )
  }
]

/* ------------------------------ 时区列表 ------------------------------ */

export interface TimeZoneOption {
  label: string
  value: string
}

export const TIME_ZONES: TimeZoneOption[] = [
  { label: '中国标准时间（Asia/Shanghai）', value: 'Asia/Shanghai' },
  { label: 'UTC（协调世界时）', value: 'UTC' },
  { label: '东京（Asia/Tokyo）', value: 'Asia/Tokyo' },
  { label: '新加坡（Asia/Singapore）', value: 'Asia/Singapore' },
  { label: '伦敦（Europe/London）', value: 'Europe/London' },
  { label: '巴黎（Europe/Paris）', value: 'Europe/Paris' },
  { label: '纽约（America/New_York）', value: 'America/New_York' },
  { label: '洛杉矶（America/Los_Angeles）', value: 'America/Los_Angeles' },
  { label: '悉尼（Australia/Sydney）', value: 'Australia/Sydney' }
]
