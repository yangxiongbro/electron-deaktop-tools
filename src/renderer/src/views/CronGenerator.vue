<script setup lang="ts">
/**
 * Cron 生成器
 *
 * 布局：左侧自上而下是「Cron 表达式 → 常用定时 → 选择时间」，右侧只有「最近运行时间」。
 * 表达式类型放在 Cron 表达式的表头；时间选择器固定展示秒/分/时/日/月/周/年七个字段，
 * 当前表达式类型用不到的字段（Linux 的秒、非 Quartz 的年）与不支持的写法（L / W / #）会被禁用。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument, Reading, Right, WarningFilled } from '@element-plus/icons-vue'
import CronFieldPanel from '../components/CronFieldPanel.vue'
import CronSyntaxDialog from '../components/CronSyntaxDialog.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import type { SegmentOption } from '../components/segment'
import { copyText } from '../utils/clipboard'
import type {
  CronDialect,
  CronFieldKey,
  CronPreset,
  CronSchedule,
  CronSelection,
  FieldSelection,
  NextRun,
  WallTime
} from '../utils/cron'
import {
  CRON_PRESETS,
  DIALECT_LIST,
  DIALECT_META,
  FIELD_CONFIGS,
  FIELD_ORDER,
  TIME_ZONES,
  WEEKDAY_SHORT,
  buildExpression,
  createDefaultSelection,
  disabledModesFor,
  hasField,
  isRestricted,
  missingFieldHint,
  nextRuns,
  parseCron,
  selectionFromExpression,
  wallWeekday
} from '../utils/cron'

const dialect = ref<CronDialect>('quartz')
const activeField = ref<CronFieldKey>('second')
const selection = reactive<CronSelection>(createDefaultSelection())
const timeZone = ref('Asia/Shanghai')
const runCount = ref(5)
const expressionText = ref('')
const syntaxVisible = ref(false)
const presetCollapsed = ref(false)
const now = ref(Date.now())

const meta = computed(() => DIALECT_META[dialect.value])

const dialectOptions = computed<SegmentOption[]>(() =>
  DIALECT_LIST.map((item) => ({ label: item.label, value: item.value }))
)

/** 当前表达式类型下不可用的「日 / 周」写法 */
const disabledModes = computed(() => disabledModesFor(dialect.value))

const generated = computed(() => buildExpression(selection, dialect.value))

watch(
  generated,
  (value) => {
    expressionText.value = value
  },
  { immediate: true }
)

/** 切换表达式类型后，如果当前字段不再可用就跳到第一个可用字段 */
watch(dialect, () => {
  if (!hasField(dialect.value, activeField.value)) {
    activeField.value = FIELD_ORDER.find((key) => hasField(dialect.value, key)) ?? 'minute'
  }
})

function selectField(key: CronFieldKey): void {
  if (!hasField(dialect.value, key)) return
  activeField.value = key
}

function onSelectionChange(value: FieldSelection): void {
  selection[activeField.value] = value
}

/* ------------------------------ 解析结果 ------------------------------ */

interface ParseState {
  ok: boolean
  schedule: CronSchedule | null
  error: string
}

const parsed = computed<ParseState>(() => {
  try {
    return { ok: true, schedule: parseCron(expressionText.value, dialect.value), error: '' }
  } catch (error) {
    return { ok: false, schedule: null, error: error instanceof Error ? error.message : String(error) }
  }
})

/** 「表达式字段」里的每一格：与当前类型无关，始终显示完整字段，方便对照 */
const expressionFields = computed(() =>
  meta.value.fieldKeys.map((key, index) => ({
    key,
    label: meta.value.fields[index] ?? '',
    value: expressionText.value.trim().split(/\s+/).filter(Boolean)[index] ?? '',
    active: key === activeField.value
  }))
)

/** 表达式与当前方言不完全兼容时的提示（不阻塞生成） */
const hints = computed<string[]>(() => {
  const list: string[] = []
  const current = meta.value
  if (!current.hasYear && isRestricted(selection.year)) {
    list.push(`${current.label} 表达式没有「年」字段，已忽略年份限制`)
  }
  const zeroSecond =
    selection.second.mode === 'specify' &&
    selection.second.values.length === 1 &&
    selection.second.values[0] === 0
  if (!current.hasSeconds && !zeroSecond) {
    list.push(`${current.label} 表达式没有「秒」字段，到点后的秒数固定为 0`)
  }
  const blocked = disabledModes.value
  if (blocked.length && (blocked.includes(selection.day.mode) || blocked.includes(selection.week.mode))) {
    list.push(`${current.label} 不支持 L / W / # 扩展语法，这部分取值可能无法被解析引擎识别`)
  }
  if (isRestricted(selection.day) && isRestricted(selection.week)) {
    list.push('「日」与「周」同时受限，按 cron 惯例会在任一条件满足时触发')
  }
  return list
})

/* ---------------------------- 最近运行时间 ---------------------------- */

interface RunRow {
  key: string
  time: string
  relative: string
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

function formatWallTime(wall: WallTime): string {
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
}

function formatRelative(ms: number): string {
  if (ms <= 0) return '即将执行'
  const totalSeconds = Math.floor(ms / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days} 天 ${hours} 小时后`
  if (hours > 0) return `${hours} 小时 ${minutes} 分后`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒后`
  return `${seconds} 秒后`
}

const runs = computed<RunRow[]>(() => {
  const schedule = parsed.value.schedule
  if (!schedule) return []
  let upcoming: NextRun[] = []
  try {
    upcoming = nextRuns(schedule, runCount.value, timeZone.value, new Date(now.value))
  } catch {
    return []
  }
  return upcoming.map((run) => ({
    key: `${run.parts.year}-${run.parts.month}-${run.parts.day}-${run.parts.hour}-${run.parts.minute}-${run.parts.second}`,
    time: `${formatWallTime(run.parts)} ${WEEKDAY_SHORT[wallWeekday(run.parts)]}`,
    relative: formatRelative(run.date.getTime() - now.value)
  }))
})

let ticker: number | undefined
onMounted(() => {
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 10_000)
})
onUnmounted(() => {
  if (ticker) window.clearInterval(ticker)
})

/* ------------------------------ 交互动作 ------------------------------ */

function applyPreset(preset: CronPreset): void {
  Object.assign(selection, preset.create())
  ElMessage.success(`已应用「${preset.label}」`)
}

function analyze(): void {
  try {
    Object.assign(selection, selectionFromExpression(expressionText.value, dialect.value))
    ElMessage.success('表达式解析成功，已回填到时间选择器')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '表达式解析失败')
  }
}

async function copyExpression(): Promise<void> {
  const ok = await copyText(expressionText.value)
  if (ok) ElMessage.success('表达式已复制')
  else ElMessage.error('复制失败，请手动选择后复制')
}
</script>

<template>
  <div class="page cron-page">
    <div class="page-body cron-body">
      <div class="cron-main">
        <!-- 1. Cron 表达式 -->
        <section class="panel cron-expr">
          <div class="panel-header">
            <span class="panel-title">Cron 表达式</span>
            <span class="spacer" />
            <SegmentedControl v-model="dialect" :options="dialectOptions" size="small" />
            <el-button size="small" text :icon="Reading" class="syntax-btn" @click="syntaxVisible = true">
              语法
            </el-button>
          </div>
          <div class="panel-body padded expr-panel">
            <div class="expr-fields">
              <div
                v-for="item in expressionFields"
                :key="item.key"
                class="expr-field"
                :class="{ active: item.active }"
              >
                <span class="expr-label">{{ item.label }}</span>
                <span class="expr-value mono">{{ item.value || '—' }}</span>
              </div>
            </div>

            <div class="expr-input-row">
              <el-input
                v-model="expressionText"
                class="expr-input"
                placeholder="Cron 表达式"
                spellcheck="false"
                @keydown.enter="analyze"
              />
              <el-button :icon="CopyDocument" @click="copyExpression">复制</el-button>
              <el-button type="primary" :icon="Right" @click="analyze">解析分析</el-button>
            </div>

            <div v-if="!parsed.ok" class="expr-error">
              <el-icon :size="14"><WarningFilled /></el-icon>
              <span>{{ parsed.error }}</span>
            </div>
            <el-alert v-else-if="hints.length" type="warning" :closable="false" show-icon class="expr-hints">
              <div v-for="hint in hints" :key="hint" class="hint-line">{{ hint }}</div>
            </el-alert>
            <div v-else class="expr-ok small">表达式有效，正在按「{{ timeZone }}」推算运行时间</div>
          </div>
        </section>

        <!-- 2. 常用定时 -->
        <section class="panel cron-presets">
          <div class="panel-header">
            <span class="panel-title">常用定时</span>
            <span class="spacer" />
            <el-button size="small" text @click="presetCollapsed = !presetCollapsed">
              {{ presetCollapsed ? '展开' : '收起' }}
            </el-button>
          </div>
          <div v-show="!presetCollapsed" class="panel-body padded preset-list">
            <button
              v-for="preset in CRON_PRESETS"
              :key="preset.key"
              type="button"
              class="preset-chip"
              @click="applyPreset(preset)"
            >
              {{ preset.label }}
            </button>
          </div>
        </section>

        <!-- 3. 选择时间 -->
        <section class="panel cron-picker">
          <div class="panel-header">
            <span class="panel-title">选择时间</span>
            <span class="spacer" />
            <span class="small muted field-summary">{{ meta.summary }}</span>
          </div>
          <div class="cron-tabs">
            <el-tooltip
              v-for="key in FIELD_ORDER"
              :key="key"
              :content="missingFieldHint(dialect, key)"
              :disabled="hasField(dialect, key)"
              placement="top"
              :show-after="150"
            >
              <button
                type="button"
                class="cron-tab"
                :class="{ active: activeField === key, disabled: !hasField(dialect, key) }"
                @click="selectField(key)"
              >
                {{ FIELD_CONFIGS[key].title }}
              </button>
            </el-tooltip>
          </div>
          <div class="cron-panel-body">
            <CronFieldPanel
              :key="`${dialect}-${activeField}`"
              :field-key="activeField"
              :mask="meta.mask"
              :disabled-modes="disabledModes"
              :disabled-reason="`${meta.label} 表达式不支持 L / W / # 语法`"
              :model-value="selection[activeField]"
              @update:model-value="onSelectionChange"
            />
          </div>
        </section>
      </div>

      <!-- 右侧：最近运行时间 -->
      <aside class="cron-runs-col">
        <section class="panel">
          <div class="panel-header">
            <span class="panel-title">最近运行时间</span>
            <span class="spacer" />
            <el-select v-model="runCount" size="small" class="count-select">
              <el-option v-for="count in [5, 10, 20]" :key="count" :label="`${count} 次`" :value="count" />
            </el-select>
          </div>
          <div class="runs-tz">
            <span class="small muted">时区</span>
            <el-select v-model="timeZone" size="small" class="tz-select">
              <el-option v-for="zone in TIME_ZONES" :key="zone.value" :label="zone.label" :value="zone.value" />
            </el-select>
          </div>
          <div class="panel-body">
            <div v-if="!parsed.ok" class="runs-empty">表达式有误，无法推算运行时间</div>
            <div v-else-if="!runs.length" class="runs-empty">未来 60 年内没有匹配的运行时间</div>
            <div v-else class="run-list">
              <div v-for="(run, index) in runs" :key="run.key" class="run-row">
                <span class="run-index">{{ index + 1 }}</span>
                <div class="run-main">
                  <span class="run-time mono">{{ run.time }}</span>
                  <span class="run-relative">{{ run.relative }}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </aside>
    </div>

    <CronSyntaxDialog v-model="syntaxVisible" :dialect="dialect" />
  </div>
</template>

<style scoped>
.cron-page {
  min-height: 0;
}

.cron-body {
  flex: 1;
  min-height: 0;
}

.syntax-btn {
  flex: none;
}

.tz-select {
  flex: 1;
  min-width: 0;
}

.runs-tz {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 6px 12px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel);
}

.runs-tz .small {
  flex: none;
}

.cron-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.cron-main > .panel {
  flex: none;
}

.cron-main > .cron-picker {
  flex: 1;
  min-height: 0;
}

.cron-runs-col {
  width: 300px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.cron-runs-col > .panel {
  flex: 1;
  min-height: 0;
}

.field-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ------------------------------ 表达式 ------------------------------ */
.expr-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

.expr-fields {
  display: flex;
  gap: 8px;
}

.expr-field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 5px 0 6px;
  border: 1px solid var(--app-border);
  border-radius: 7px;
  background: var(--app-panel-muted);
  transition: background 0.15s ease, border-color 0.15s ease;
}

/* 正在编辑的字段：淡蓝底 + 蓝边 */
.expr-field.active {
  background: var(--app-primary-soft);
  border-color: var(--app-primary);
}

.expr-label {
  font-size: 11px;
  color: var(--app-text-3);
}

.expr-field.active .expr-label {
  color: var(--app-primary);
}

.expr-value {
  max-width: 100%;
  padding: 0 6px;
  font-size: 13px;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.expr-field.active .expr-value {
  color: var(--app-primary);
  font-weight: 600;
}

.expr-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.expr-input {
  flex: 1;
  min-width: 0;
}

.expr-input :deep(.el-input__inner) {
  font-family: var(--app-mono);
  font-size: 13px;
}

.expr-error {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 7px;
  background: rgba(245, 108, 108, 0.12);
  color: #e34d4d;
  font-size: 12.5px;
  line-height: 1.5;
}

.expr-hints {
  padding: 4px 0;
}

.hint-line {
  line-height: 1.6;
}

.expr-ok {
  color: var(--app-text-3);
}

/* ------------------------------ 常用定时 ------------------------------ */
/* 常用定时是横条，压扁一点给下面的时间选择器腾空间 */
.cron-presets .panel-header {
  min-height: 34px;
  padding: 3px 12px;
}

.preset-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
}

.preset-chip {
  height: 26px;
  padding: 0 11px;
  border: 1px solid var(--app-border);
  border-radius: 14px;
  background: var(--app-panel);
  color: var(--app-text-2);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.preset-chip:hover {
  border-color: var(--app-primary);
  color: var(--app-primary);
  background: var(--app-primary-soft);
}

/* ------------------------------ 选择时间 ------------------------------ */
.cron-tabs {
  display: flex;
  flex: none;
  gap: 2px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel);
}

.cron-tab {
  flex: 1;
  height: 34px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-2);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.cron-tab:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.cron-tab.active {
  background: var(--app-primary-soft);
  color: var(--app-primary);
  font-weight: 600;
}

/* 当前表达式类型用不到的字段：禁用 */
.cron-tab.disabled {
  color: var(--app-text-3);
  opacity: 0.45;
  cursor: not-allowed;
}

.cron-tab.disabled:hover {
  background: transparent;
  color: var(--app-text-3);
}

.cron-panel-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* ---------------------------- 最近运行时间 ---------------------------- */
.count-select {
  width: 84px;
}

.run-list {
  display: flex;
  flex-direction: column;
  padding: 4px 12px 8px;
}

.run-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--app-border);
}

.run-row:last-child {
  border-bottom: none;
}

.run-index {
  width: 18px;
  height: 18px;
  flex: none;
  margin-top: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--app-primary-soft);
  color: var(--app-primary);
  font-size: 11px;
  font-weight: 600;
}

.run-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.run-time {
  font-size: 12.5px;
  color: var(--app-text);
  white-space: nowrap;
}

.run-relative {
  font-size: 11.5px;
  color: var(--app-text-3);
}

.runs-empty {
  padding: 20px 12px;
  font-size: 12.5px;
  color: var(--app-text-3);
}
</style>
