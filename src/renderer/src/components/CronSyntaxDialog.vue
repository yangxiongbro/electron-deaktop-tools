<script setup lang="ts">
/**
 * Cron 语法速查弹窗
 *
 * 重点体现四种表达式类型的差异：
 *   1. 各类型的字段数量、字段顺序、是否支持秒 / 年 / ? / L·W·# ，以及周日的取值；
 *   2. 字段说明只列当前类型真实存在的字段；
 *   3. 通用符号标注每种类型是否支持，当前类型不支持的行会置灰；
 *   4. 常用示例同时给出四种类型生成出来的表达式，可对照差异。
 */
import { computed } from 'vue'
import type { CronDialect } from '../utils/cron'
import { CRON_PRESETS, DIALECT_LIST, DIALECT_META, buildExpression } from '../utils/cron'

const props = defineProps<{
  modelValue: boolean
  dialect: CronDialect
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
}>()

const visible = computed<boolean>({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const meta = computed(() => DIALECT_META[props.dialect])

const ALL: CronDialect[] = ['quartz', 'spring', 'linux', 'node']
const EXTENDED: CronDialect[] = ['quartz', 'spring']

/* ----------------------------- 类型差异 ----------------------------- */

interface DiffRow {
  value: CronDialect
  label: string
  order: string
  seconds: boolean
  year: boolean
  question: boolean
  extended: boolean
  sunday: string
}

const DIFF_ROWS: DiffRow[] = DIALECT_LIST.map((item) => ({
  value: item.value,
  label: item.label,
  order: item.fields.join(' '),
  seconds: item.hasSeconds,
  year: item.hasYear,
  question: item.supportsQuestion,
  extended: item.extended,
  sunday: item.weekBase === 1 ? '1' : '0（或 7）'
}))

/* ----------------------------- 字段说明 ----------------------------- */

interface FieldRow {
  name: string
  values: string
  note: string
}

const FIELD_NOTES: Record<string, string> = {
  秒: '支持 , - * /',
  分: '支持 , - * /',
  时: '支持 , - * /',
  月: '支持 , - * /',
  年: '支持 , - * /（可省略）'
}

/** 当前类型下该字段能用的符号（L / W / # 只有 Quartz 与 Spring 支持） */
function fieldNote(name: string): string {
  const extended = meta.value.extended
  if (name === '日') return extended ? '支持 , - * / ? L W' : '支持 , - * /'
  if (name === '周') return extended ? '支持 , - * / ? L #' : '支持 , - * /'
  return FIELD_NOTES[name] ?? '-'
}

function fieldValues(name: string): string {
  switch (name) {
    case '秒':
    case '分':
      return '0-59'
    case '时':
      return '0-23'
    case '日':
      return '1-31'
    case '月':
      return '1-12 或 JAN-DEC'
    case '周':
      // Quartz 的 1 表示周日；其他方言 0 和 7 都表示周日
      return props.dialect === 'quartz' ? '1-7（1=周日）或 SUN-SAT' : '0-7（0 和 7 都是周日）'
    case '年':
      return '1970-2099'
    default:
      return '-'
  }
}

const fieldRows = computed<FieldRow[]>(() =>
  meta.value.fields.map((name) => ({ name, values: fieldValues(name), note: fieldNote(name) }))
)

/* ----------------------------- 通用符号 ----------------------------- */

interface SymbolRow {
  symbol: string
  meaning: string
  dialects: CronDialect[]
  example: string
}

const SYMBOL_ROWS: SymbolRow[] = [
  { symbol: '*', meaning: '匹配该字段的任意取值', dialects: ALL, example: '0 0 12 * * ? —— 每天 12 点' },
  {
    symbol: '?',
    meaning: '不指定（只能用在「日」或「周」，另一侧必须写具体值）',
    dialects: EXTENDED,
    example: '0 0 12 ? * MON —— 每周一 12 点'
  },
  { symbol: ',', meaning: '枚举多个取值', dialects: ALL, example: '0 0 0 1,15 * ? —— 每月 1 号和 15 号' },
  { symbol: '-', meaning: '一个闭区间范围', dialects: ALL, example: '0 0 9-18 * * ? —— 9 点到 18 点每小时' },
  { symbol: '/', meaning: '步长，从起始值开始每隔 n 触发一次', dialects: ALL, example: '0 0/10 * * * ? —— 每 10 分钟' },
  {
    symbol: 'L',
    meaning: '日字段表示当月最后一天；周字段表示最后一个星期几',
    dialects: EXTENDED,
    example: '0 0 0 L * ? —— 每月最后一天零点'
  },
  {
    symbol: 'W',
    meaning: '离指定日期最近的工作日（周一到周五）',
    dialects: EXTENDED,
    example: '0 0 0 15W * ? —— 每月 15 号最近的工作日'
  },
  { symbol: 'LW', meaning: '当月最后一个工作日', dialects: EXTENDED, example: '0 0 0 LW * ? —— 每月最后一个工作日' },
  { symbol: '#', meaning: '当月第 n 个星期几', dialects: EXTENDED, example: '0 0 0 ? * 2#1 —— 每月第一个周一' }
]

interface SymbolView extends SymbolRow {
  supported: boolean
  scope: string
}

const symbolRows = computed<SymbolView[]>(() =>
  SYMBOL_ROWS.map((row) => ({
    ...row,
    supported: row.dialects.includes(props.dialect),
    scope: row.dialects.length === ALL.length ? '全部类型' : 'Quartz / Spring'
  }))
)

/* ----------------------------- 常用示例 ----------------------------- */

interface ExampleRow {
  label: string
  quartz: string
  spring: string
  linux: string
  node: string
}

const EXAMPLE_ROWS: ExampleRow[] = CRON_PRESETS.map((preset) => {
  const selection = preset.create()
  return {
    label: preset.label,
    quartz: buildExpression(selection, 'quartz'),
    spring: buildExpression(selection, 'spring'),
    linux: buildExpression(selection, 'linux'),
    node: buildExpression(selection, 'node')
  }
})

/** 高亮当前表达式类型所在的行 */
function diffRowClass({ row }: { row: DiffRow }): string {
  return row.value === props.dialect ? 'row-active' : ''
}

/** 当前类型不支持的符号置灰 */
function symbolRowClass({ row }: { row: SymbolView }): string {
  return row.supported ? '' : 'row-muted'
}

/** 当前类型不支持 L / W / # 时，示例里对应的写法只是对照用 */
const showsExtendedExample = computed(() => !meta.value.extended)
</script>

<template>
  <el-dialog v-model="visible" title="Cron 语法" width="900px" top="3vh">
    <div class="syntax-body">
      <section class="syntax-section">
        <div class="syntax-title">各表达式类型的差异</div>
        <el-table
          :data="DIFF_ROWS"
          size="small"
          border
          :row-class-name="diffRowClass"
          class="syntax-table"
        >
          <el-table-column prop="label" label="类型" width="90" />
          <el-table-column prop="order" label="字段顺序" width="190" />
          <el-table-column label="秒" width="56" align="center">
            <template #default="{ row }">
              <span :class="row.seconds ? 'yes' : 'no'">{{ row.seconds ? '✓' : '✗' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="年" width="56" align="center">
            <template #default="{ row }">
              <span :class="row.year ? 'yes' : 'no'">{{ row.year ? '✓' : '✗' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="?" width="56" align="center">
            <template #default="{ row }">
              <span :class="row.question ? 'yes' : 'no'">{{ row.question ? '✓' : '✗' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="L / W / #" width="96" align="center">
            <template #default="{ row }">
              <span :class="row.extended ? 'yes' : 'no'">{{ row.extended ? '✓' : '✗' }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="sunday" label="周日取值" min-width="96" />
        </el-table>
      </section>

      <section class="syntax-section">
        <div class="syntax-title">当前类型：{{ meta.label }}</div>
        <div class="field-chips">
          <span v-for="(field, index) in meta.fields" :key="field" class="field-chip">
            <span class="chip-index">{{ index + 1 }}</span>
            {{ field }}
          </span>
        </div>
        <el-alert type="info" :closable="false" show-icon :title="meta.summary" class="syntax-alert" />
        <el-table :data="fieldRows" size="small" border class="syntax-table">
          <el-table-column prop="name" label="字段" width="80" />
          <el-table-column prop="values" label="取值范围" width="200" />
          <el-table-column prop="note" label="可用符号" />
        </el-table>
      </section>

      <section class="syntax-section">
        <div class="syntax-title">通用符号</div>
        <el-table
          :data="symbolRows"
          size="small"
          border
          :row-class-name="symbolRowClass"
          class="syntax-table"
        >
          <el-table-column prop="symbol" label="符号" width="72">
            <template #default="{ row }">
              <span class="mono symbol">{{ row.symbol }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="meaning" label="含义" width="250" />
          <el-table-column prop="scope" label="支持类型" width="118" />
          <el-table-column prop="example" label="示例">
            <template #default="{ row }">
              <span class="mono">{{ row.example }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section class="syntax-section">
        <div class="syntax-title">常用示例（按当前选择器生成）</div>
        <el-table :data="EXAMPLE_ROWS" size="small" border class="syntax-table">
          <el-table-column prop="label" label="场景" width="116" />
          <el-table-column label="Quartz">
            <template #header>
              <span :class="{ 'col-active': dialect === 'quartz' }">Quartz</span>
            </template>
            <template #default="{ row }">
              <span class="mono expr" :class="{ 'col-active': dialect === 'quartz' }">{{ row.quartz }}</span>
            </template>
          </el-table-column>
          <el-table-column label="Spring">
            <template #header>
              <span :class="{ 'col-active': dialect === 'spring' }">Spring</span>
            </template>
            <template #default="{ row }">
              <span class="mono expr" :class="{ 'col-active': dialect === 'spring' }">{{ row.spring }}</span>
            </template>
          </el-table-column>
          <el-table-column label="Linux">
            <template #header>
              <span :class="{ 'col-active': dialect === 'linux' }">Linux</span>
            </template>
            <template #default="{ row }">
              <span class="mono expr" :class="{ 'col-active': dialect === 'linux' }">{{ row.linux }}</span>
            </template>
          </el-table-column>
          <el-table-column label="Node">
            <template #header>
              <span :class="{ 'col-active': dialect === 'node' }">Node</span>
            </template>
            <template #default="{ row }">
              <span class="mono expr" :class="{ 'col-active': dialect === 'node' }">{{ row.node }}</span>
            </template>
          </el-table-column>
        </el-table>
        <div v-if="showsExtendedExample" class="syntax-note">
          提示：{{ meta.label }} 不支持 L / W / # 语法，示例中「每月最后一天」这类写法仅供 Quartz / Spring 参考。
        </div>
      </section>
    </div>

    <template #footer>
      <el-button type="primary" @click="visible = false">知道了</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.syntax-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-height: 78vh;
  overflow: auto;
  padding-right: 4px;
}

.syntax-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text-2);
  margin-bottom: 8px;
}

.field-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.field-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 4px;
  border: 1px solid var(--app-border);
  border-radius: 20px;
  background: var(--app-panel-muted);
  font-size: 12.5px;
  color: var(--app-text-2);
}

.chip-index {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--app-primary-soft);
  color: var(--app-primary);
  font-size: 11px;
  font-weight: 600;
}

.syntax-alert {
  margin-bottom: 10px;
}

.syntax-table {
  font-size: 12.5px;
}

.syntax-table :deep(.row-active) {
  background: var(--app-primary-soft);
  font-weight: 600;
}

.syntax-table :deep(.row-muted) {
  color: var(--app-text-3);
  opacity: 0.72;
}

.symbol {
  font-weight: 600;
  color: var(--app-primary);
}

.yes {
  color: #22a06b;
  font-weight: 700;
}

.no {
  color: var(--app-text-3);
  font-weight: 700;
}

.col-active {
  color: var(--app-primary);
  font-weight: 700;
}

.expr {
  font-size: 11.5px;
  white-space: nowrap;
}

.syntax-note {
  margin-top: 8px;
  font-size: 12px;
  color: var(--app-text-3);
  line-height: 1.6;
}
</style>
