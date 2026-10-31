<script setup lang="ts">
/**
 * Cron 时间选择器：单个字段的「每秒 / 范围 / 周期 / 指定 …」面板。
 * 父组件按当前激活的字段传入 fieldKey，本组件只负责该字段的交互与展示。
 */
import { computed } from 'vue'
import type { CronFieldKey, FieldMode, FieldSelection } from '../utils/cron'
import { FIELD_CONFIGS, MODE_LABELS, WEEKDAY_LABELS, formatFieldValue } from '../utils/cron'

const props = withDefaults(
  defineProps<{
    fieldKey: CronFieldKey
    modelValue: FieldSelection
    /** 日 / 周互斥时另一侧写的占位符（Quartz 是 ?，其余是 *） */
    mask?: string
    /** 当前表达式类型不支持的模式，需要置灰且不可选择 */
    disabledModes?: FieldMode[]
    /** 置灰模式的说明文案 */
    disabledReason?: string
  }>(),
  {
    mask: '?',
    disabledModes: () => [],
    disabledReason: '当前表达式类型不支持该写法'
  }
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: FieldSelection): void
}>()

const config = computed(() => FIELD_CONFIGS[props.fieldKey])
const isWeek = computed(() => props.fieldKey === 'week')

/** 「指定」里可以点的全部取值 */
const chipValues = computed(() => {
  const { min, max } = config.value
  const list: number[] = []
  for (let value = min; value <= max; value += 1) list.push(value)
  return list
})

function modeLabel(mode: FieldMode): string {
  return mode === 'every' ? config.value.everyLabel : MODE_LABELS[mode]
}

function patch(partial: Partial<FieldSelection>): void {
  emit('update:modelValue', { ...props.modelValue, ...partial })
}

function setMode(mode: FieldMode): void {
  if (isDisabled(mode)) return
  if (props.modelValue.mode === mode) return
  patch({ mode })
}

function isDisabled(mode: FieldMode): boolean {
  return props.disabledModes.includes(mode)
}

/** 数字输入：清空时回落到 fallback，避免出现 NaN；同时激活所属的模式 */
function numericHandler(
  key: 'from' | 'to' | 'start' | 'step' | 'dayOfMonth' | 'nth',
  mode: FieldMode,
  fallback?: number
): (value: unknown) => void {
  return (value: unknown): void => {
    const resolved =
      typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : (fallback ?? config.value.min)
    const next: FieldSelection = { ...props.modelValue, mode }
    next[key] = resolved
    emit('update:modelValue', next)
  }
}

const onFrom = numericHandler('from', 'range')
const onTo = numericHandler('to', 'range')
const onStart = numericHandler('start', 'step')
const onStep = numericHandler('step', 'step', 1)
const onDayOfMonth = numericHandler('dayOfMonth', 'nearestWeekday', 1)
const onNth = numericHandler('nth', 'nthWeekday', 1)

function onWeekdayFrom(value: unknown): void {
  patch({ mode: 'range', from: Number(value) })
}

function onWeekdayTo(value: unknown): void {
  patch({ mode: 'range', to: Number(value) })
}

function onNthWeekday(value: unknown): void {
  patch({ mode: 'nthWeekday', weekday: Number(value) })
}

function onLastWeekday(value: unknown): void {
  patch({ mode: 'lastWeekdayOfMonth', weekday: Number(value) })
}

function toggleValue(value: number): void {
  const set = new Set(props.modelValue.values)
  if (set.has(value)) set.delete(value)
  else set.add(value)
  patch({ values: [...set].sort((left, right) => left - right) })
}

function selectAll(): void {
  patch({ values: [...chipValues.value] })
}

function clearAll(): void {
  patch({ values: [] })
}

function chipText(value: number): string {
  return formatFieldValue(props.fieldKey, value, config.value.pad)
}
</script>

<template>
  <div class="cron-modes">
    <div
      v-for="mode in config.modes"
      :key="mode"
      class="cron-mode"
      :class="{ active: modelValue.mode === mode, disabled: isDisabled(mode) }"
      :title="isDisabled(mode) ? disabledReason : undefined"
      @click="setMode(mode)"
    >
      <div class="mode-head">
        <span class="radio" :class="{ on: modelValue.mode === mode }" />
        <span class="mode-name">{{ modeLabel(mode) }}</span>

        <div class="mode-content">
          <span v-if="isDisabled(mode) && modelValue.mode === mode" class="mode-warn">
            当前类型不支持，已按原样输出
          </span>
          <span v-if="mode === 'every'" class="mode-hint">{{ config.everyHint }}</span>
          <span v-else-if="mode === 'none'" class="mode-hint">使用 {{ mask }} 让另一个日期字段生效</span>

          <template v-else-if="mode === 'range'">
            <span class="mode-text">从</span>
            <el-select
              v-if="isWeek"
              :model-value="modelValue.from"
              size="small"
              class="week-select"
              @update:model-value="onWeekdayFrom"
            >
              <el-option
                v-for="(label, index) in WEEKDAY_LABELS"
                :key="index"
                :label="label"
                :value="index"
              />
            </el-select>
            <el-input-number
              v-else
              :model-value="modelValue.from"
              :min="config.min"
              :max="config.max"
              :controls="false"
              size="small"
              class="num-input"
              @update:model-value="onFrom"
            />
            <span class="mode-text">到</span>
            <el-select
              v-if="isWeek"
              :model-value="modelValue.to"
              size="small"
              class="week-select"
              @update:model-value="onWeekdayTo"
            >
              <el-option
                v-for="(label, index) in WEEKDAY_LABELS"
                :key="index"
                :label="label"
                :value="index"
              />
            </el-select>
            <el-input-number
              v-else
              :model-value="modelValue.to"
              :min="config.min"
              :max="config.max"
              :controls="false"
              size="small"
              class="num-input"
              @update:model-value="onTo"
            />
            <span class="mode-unit">{{ config.unit }}</span>
          </template>

          <template v-else-if="mode === 'step'">
            <span class="mode-text">从</span>
            <el-input-number
              :model-value="modelValue.start"
              :min="config.min"
              :max="config.max"
              :controls="false"
              size="small"
              class="num-input"
              @update:model-value="onStart"
            />
            <span class="mode-text">开始，每</span>
            <el-input-number
              :model-value="modelValue.step"
              :min="1"
              :max="config.max"
              :controls="false"
              size="small"
              class="num-input"
              @update:model-value="onStep"
            />
            <span class="mode-unit">{{ config.unit }}执行一次</span>
          </template>

          <template v-else-if="mode === 'nearestWeekday'">
            <span class="mode-text">每月</span>
            <el-input-number
              :model-value="modelValue.dayOfMonth"
              :min="1"
              :max="31"
              :controls="false"
              :disabled="isDisabled(mode)"
              size="small"
              class="num-input"
              @update:model-value="onDayOfMonth"
            />
            <span class="mode-text">号最近的工作日</span>
          </template>

          <span v-else-if="mode === 'lastDay'" class="mode-hint">当月最后一天</span>
          <span v-else-if="mode === 'lastWeekday'" class="mode-hint">当月最后一个工作日</span>

          <template v-else-if="mode === 'nthWeekday'">
            <span class="mode-text">每月第</span>
            <el-input-number
              :model-value="modelValue.nth"
              :min="1"
              :max="5"
              :controls="false"
              :disabled="isDisabled(mode)"
              size="small"
              class="num-input"
              @update:model-value="onNth"
            />
            <span class="mode-text">个</span>
            <el-select
              :model-value="modelValue.weekday"
              :disabled="isDisabled(mode)"
              size="small"
              class="week-select"
              @update:model-value="onNthWeekday"
            >
              <el-option
                v-for="(label, index) in WEEKDAY_LABELS"
                :key="index"
                :label="label"
                :value="index"
              />
            </el-select>
          </template>

          <template v-else-if="mode === 'lastWeekdayOfMonth'">
            <span class="mode-text">每月最后一个</span>
            <el-select
              :model-value="modelValue.weekday"
              :disabled="isDisabled(mode)"
              size="small"
              class="week-select"
              @update:model-value="onLastWeekday"
            >
              <el-option
                v-for="(label, index) in WEEKDAY_LABELS"
                :key="index"
                :label="label"
                :value="index"
              />
            </el-select>
          </template>

          <span v-else-if="mode === 'specify'" class="mode-hint">按需勾选具体的取值</span>
        </div>
      </div>

      <div v-if="mode === 'specify'" class="mode-specify">
        <div class="specify-head">
          <span class="mode-text">已选择 {{ modelValue.values.length }} 项</span>
          <span class="spacer" />
          <button type="button" class="link-btn" @click="selectAll">全选</button>
          <button type="button" class="link-btn" @click="clearAll">清空</button>
        </div>
        <div class="chip-grid" :class="`cols-${fieldKey}`">
          <button
            v-for="value in chipValues"
            :key="value"
            type="button"
            class="chip"
            :class="{ on: modelValue.values.includes(value) }"
            @click="toggleValue(value)"
          >
            {{ chipText(value) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cron-modes {
  display: flex;
  flex-direction: column;
  padding: 4px 0 12px;
}

.cron-mode {
  border-radius: 8px;
  transition: background 0.15s ease;
}

.cron-mode.active {
  background: var(--app-primary-soft);
}

/* 当前表达式类型不支持的写法：置灰且不可选择 */
.cron-mode.disabled .mode-head {
  cursor: not-allowed;
}

.cron-mode.disabled .mode-name,
.cron-mode.disabled .mode-content {
  color: var(--app-text-3);
  opacity: 0.6;
}

.cron-mode.disabled .radio {
  border-color: var(--app-border);
}

.mode-warn {
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(230, 162, 60, 0.16);
  color: #b7791f;
  font-size: 11.5px;
  opacity: 1;
}

html.dark .mode-warn {
  color: #e0a94a;
}

.mode-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 4px 14px;
  cursor: pointer;
}

.radio {
  width: 14px;
  height: 14px;
  flex: none;
  border-radius: 50%;
  border: 1.5px solid var(--app-border-strong);
  background: var(--app-panel);
  position: relative;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.radio.on {
  border-color: var(--app-primary);
}

.radio.on::after {
  content: '';
  position: absolute;
  inset: 2.5px;
  border-radius: 50%;
  background: var(--app-primary);
}

.mode-name {
  flex: none;
  width: 76px;
  font-size: 13px;
  color: var(--app-text-2);
}

.cron-mode.active .mode-name {
  color: var(--app-primary);
  font-weight: 600;
}

.mode-content {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
  color: var(--app-text-2);
  cursor: default;
}

.mode-hint {
  color: var(--app-text-3);
  font-size: 12.5px;
}

.mode-text,
.mode-unit {
  color: var(--app-text-2);
  white-space: nowrap;
}

.mode-unit {
  color: var(--app-text-3);
}

.num-input {
  width: 62px;
}

.num-input :deep(.el-input__inner) {
  text-align: center;
  font-family: var(--app-mono);
}

.week-select {
  width: 104px;
}

.mode-specify {
  padding: 0 14px 10px 124px;
}

.specify-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0 8px;
  font-size: 12px;
  color: var(--app-text-3);
}

.specify-head .spacer {
  flex: 1;
}

.link-btn {
  border: none;
  background: transparent;
  color: var(--app-primary);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 0 2px;
}

.link-btn:hover {
  text-decoration: underline;
}

.chip-grid {
  display: grid;
  gap: 6px;
}

.chip-grid.cols-second,
.chip-grid.cols-minute,
.chip-grid.cols-hour,
.chip-grid.cols-day,
.chip-grid.cols-year {
  grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
}

.chip-grid.cols-month,
.chip-grid.cols-week {
  grid-template-columns: repeat(auto-fill, minmax(74px, 1fr));
}

.chip {
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-panel);
  color: var(--app-text-2);
  font-size: 12px;
  font-family: var(--app-mono);
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.chip-grid.cols-month .chip,
.chip-grid.cols-week .chip {
  font-family: inherit;
}

.chip:hover {
  border-color: var(--app-primary);
  color: var(--app-primary);
}

.chip.on {
  background: var(--app-primary);
  border-color: var(--app-primary);
  color: #fff;
  font-weight: 600;
}
</style>
