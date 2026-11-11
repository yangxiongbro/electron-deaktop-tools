<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Coin, CopyDocument, Delete, MagicStick } from '@element-plus/icons-vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { copyText } from '../utils/clipboard'
import {
  changeSqlKeywordCase,
  fillMybatisParams,
  formatSql,
  minifySql,
  parseMybatisParams,
  shouldQuoteValue,
  stripSqlComments
} from '../utils/sql'

type SqlMode = 'format' | 'minify' | 'upper' | 'lower' | 'strip'

const MODES: { label: string; value: SqlMode }[] = [
  { label: '格式化', value: 'format' },
  { label: '压缩', value: 'minify' },
  { label: '大写', value: 'upper' },
  { label: '小写', value: 'lower' },
  { label: '去注释', value: 'strip' }
]

const EXAMPLE = `select u.id, u.user_name, u.create_time, d.dept_name
from sys_user u
left join sys_dept d on d.id = u.dept_id
where u.status = #{status} and u.user_name like concat('%', #{keyWord}, '%')
  and u.dept_id in (select id from sys_dept where parent_id = \${parentId}) -- 只查这个部门
order by u.create_time desc
limit 20;`

const mode = ref<SqlMode>('format')
const input = ref(EXAMPLE)
const output = ref('')
const autoRun = ref(true)

const paramDialog = ref(false)
const paramValues = ref<Record<string, string>>({})

const params = computed(() => parseMybatisParams(input.value))
const inputLines = computed(() => input.value.split('\n').length)

function run(): void {
  const sql = input.value
  if (!sql.trim()) {
    output.value = ''
    return
  }
  switch (mode.value) {
    case 'format':
      output.value = formatSql(sql, { keywordCase: 'upper' })
      break
    case 'minify':
      output.value = minifySql(sql)
      break
    case 'upper':
      output.value = changeSqlKeywordCase(sql, 'upper')
      break
    case 'lower':
      output.value = changeSqlKeywordCase(sql, 'lower')
      break
    case 'strip':
      output.value = stripSqlComments(sql)
      break
    default:
      output.value = sql
  }
}

watch(
  [input, mode],
  () => {
    if (autoRun.value) run()
  },
  { immediate: true }
)

watch(
  params,
  (list) => {
    // 新出现的参数给个空值，已填的保留
    const next: Record<string, string> = {}
    for (const item of list) next[item.name] = paramValues.value[item.name] ?? ''
    paramValues.value = next
  },
  { immediate: true }
)

function openParamDialog(): void {
  if (!params.value.length) {
    ElMessage.warning('这段 SQL 里没有找到 #{...} / ${...} 参数')
    return
  }
  paramDialog.value = true
}

/** 参数在 SQL 里的原始写法，例如 #{userName} */
function paramLabel(param: { kind: 'bind' | 'raw'; name: string }): string {
  const open = param.kind === 'bind' ? '#' : '$'
  return `${open}{${param.name}}`
}

function fillParams(): void {
  const quoteMap: Record<string, boolean> = {}
  for (const item of params.value) quoteMap[item.name] = shouldQuoteValue(paramValues.value[item.name] ?? '')
  output.value = fillMybatisParams(input.value, paramValues.value, quoteMap)
  paramDialog.value = false
  autoRun.value = false
  ElMessage.success(`已替换 ${params.value.length} 个参数`)
}

async function copyOutput(): Promise<void> {
  if (!output.value) return
  const ok = await copyText(output.value)
  if (ok) ElMessage.success('已复制到剪贴板')
  else ElMessage.error('复制失败')
}

function useOutputAsInput(): void {
  if (!output.value) return
  input.value = output.value
}

function clearAll(): void {
  input.value = ''
  output.value = ''
}

function loadExample(): void {
  input.value = EXAMPLE
  mode.value = 'format'
}
</script>

<template>
  <div class="page">
    <div class="page-toolbar">
      <SegmentedControl v-model="mode" :options="MODES" />

      <el-button type="primary" :icon="MagicStick" :disabled="!params.length" @click="openParamDialog">
        MyBatis 填充<span v-if="params.length">（{{ params.length }}）</span>
      </el-button>
      <el-button :icon="CopyDocument" :disabled="!output" @click="copyOutput">复制</el-button>
      <el-button :icon="Coin" :disabled="!output" @click="useOutputAsInput">结果转输入</el-button>
      <el-button :icon="Delete" @click="clearAll">清空</el-button>
      <el-checkbox v-model="autoRun" size="small">输入时自动处理</el-checkbox>

      <div class="spacer" />
      <el-button text type="primary" @click="loadExample">示例</el-button>
    </div>

    <div class="page-body">
      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">SQL 输入</span>
          <span class="spacer" />
          <span v-if="params.length" class="small muted">识别到 {{ params.length }} 个 MyBatis 参数</span>
          <span class="small muted">{{ inputLines }} 行</span>
        </div>
        <div class="panel-body">
          <el-input
            v-model="input"
            type="textarea"
            class="fill-textarea"
            resize="none"
            spellcheck="false"
            placeholder="粘贴 SQL，支持 #{} / ${} 形式的 MyBatis 参数"
          />
        </div>
      </section>

      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">输出</span>
          <span class="spacer" />
          <span v-if="output" class="small muted">{{ output.length }} 字符</span>
          <el-button size="small" :icon="CopyDocument" :disabled="!output" @click="copyOutput">复制</el-button>
        </div>
        <div class="panel-body">
          <pre v-if="output" class="code-block">{{ output }}</pre>
          <div v-else class="placeholder-box">
            <el-icon :size="26"><Coin /></el-icon>
            <span>处理结果会显示在这里</span>
          </div>
        </div>
      </section>
    </div>

    <el-dialog v-model="paramDialog" title="MyBatis 参数填充" width="560px" append-to-body>
      <div class="param-list">
        <div v-for="param in params" :key="`${param.kind}-${param.name}`" class="param-row">
          <span class="param-name mono">
            {{ paramLabel(param) }}
            <span v-if="param.extra" class="small muted">{{ param.extra }}</span>
          </span>
          <el-input
            v-model="paramValues[param.name]"
            size="default"
            :placeholder="param.kind === 'raw' ? '原样拼进 SQL（不加引号）' : '参数值，数字会原样输出'"
            @keyup.enter="fillParams"
          />
          <span class="small muted param-hint">{{ param.kind === 'bind' ? '预编译参数' : '字符串替换' }}</span>
        </div>
      </div>
      <template #footer>
        <el-button @click="paramDialog = false">取消</el-button>
        <el-button type="primary" @click="fillParams">填充到输出</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.param-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 50vh;
  overflow: auto;
}

.param-row {
  display: grid;
  grid-template-columns: 180px 1fr 64px;
  align-items: center;
  gap: 10px;
}

.param-name {
  font-size: 12.5px;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.param-hint {
  text-align: right;
}
</style>
