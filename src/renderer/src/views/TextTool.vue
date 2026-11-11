<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument, Delete, Operation } from '@element-plus/icons-vue'
import { copyText } from '../utils/clipboard'
import {
  DEFAULT_TEXT_OPTIONS,
  processText,
  textStats,
  type CaseMode,
  type SortMode,
  type TextOptions
} from '../utils/textLines'

const EXAMPLE = `  第一行内容  
第二行内容

第三行内容
第二行内容
  空行下面还有一句  `

const input = ref(EXAMPLE)
const autoRun = ref(true)
const options = ref<TextOptions>({ ...DEFAULT_TEXT_OPTIONS })
const output = ref('')

const SORT_OPTIONS: { label: string; value: SortMode }[] = [
  { label: '不排序', value: 'none' },
  { label: '升序（A → Z）', value: 'asc' },
  { label: '降序（Z → A）', value: 'desc' },
  { label: '按长度升序', value: 'length-asc' },
  { label: '按长度降序', value: 'length-desc' }
]

const CASE_OPTIONS: { label: string; value: CaseMode }[] = [
  { label: '不改变大小写', value: 'keep' },
  { label: '全部大写', value: 'upper' },
  { label: '全部小写', value: 'lower' },
  { label: '首字母大写', value: 'capitalize' }
]

const inputStats = computed(() => textStats(input.value))
const outputStats = computed(() => textStats(output.value))

function run(): void {
  output.value = input.value ? processText(input.value, options.value) : ''
}

watch(
  [input, options],
  () => {
    if (autoRun.value) run()
  },
  { deep: true, immediate: true }
)

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

function resetOptions(): void {
  options.value = { ...DEFAULT_TEXT_OPTIONS }
}

function loadExample(): void {
  input.value = EXAMPLE
}
</script>

<template>
  <div class="page">
    <div class="page-toolbar">
      <el-button type="primary" :icon="Operation" @click="run">处理</el-button>
      <el-button :icon="CopyDocument" :disabled="!output" @click="copyOutput">复制</el-button>
      <el-button :disabled="!output" @click="useOutputAsInput">结果转输入</el-button>
      <el-button :icon="Delete" @click="clearAll">清空</el-button>
      <el-button text @click="resetOptions">重置选项</el-button>
      <el-checkbox v-model="autoRun" size="small">输入时自动处理</el-checkbox>

      <div class="spacer" />
      <el-button text type="primary" @click="loadExample">示例</el-button>
    </div>

    <div class="page-body">
      <aside class="panel options-panel">
        <div class="panel-header">
          <span class="panel-title">处理方式</span>
        </div>
        <div class="panel-body option-body">
          <el-checkbox v-model="options.trimLines">每行去掉首尾空白</el-checkbox>
          <el-checkbox v-model="options.removeEmpty">去除空行</el-checkbox>
          <el-checkbox v-model="options.removeDuplicate">去除重复行</el-checkbox>
          <el-checkbox v-model="options.reverse">反转行序</el-checkbox>

          <div class="option-field">
            <span class="small muted">排序</span>
            <el-select v-model="options.sort" size="small">
              <el-option v-for="item in SORT_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </div>
          <div class="option-field">
            <span class="small muted">大小写</span>
            <el-select v-model="options.caseMode" size="small">
              <el-option v-for="item in CASE_OPTIONS" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </div>
          <div class="small muted option-note">
            顺序：去首尾空白 → 去空行 → 去重 → 排序 → 反转 → 大小写
          </div>
        </div>
      </aside>

      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">输入</span>
          <span class="spacer" />
          <span class="small muted">{{ inputStats.lines }} 行 · {{ inputStats.characters }} 字符</span>
        </div>
        <div class="panel-body">
          <el-input
            v-model="input"
            type="textarea"
            class="fill-textarea"
            resize="none"
            spellcheck="false"
            placeholder="粘贴多行文本，例如日志、SQL 列表、清单"
          />
        </div>
      </section>

      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">结果</span>
          <span class="spacer" />
          <span class="small muted">
            {{ outputStats.nonEmptyLines }} 非空行 · {{ outputStats.characters }} 字符
          </span>
          <el-button size="small" :icon="CopyDocument" :disabled="!output" @click="copyOutput">复制</el-button>
        </div>
        <div class="panel-body">
          <pre v-if="output" class="code-block">{{ output }}</pre>
          <div v-else class="placeholder-box">
            <el-icon :size="26"><Operation /></el-icon>
            <span>处理结果会显示在这里</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.options-panel {
  flex: 0 0 232px;
  min-width: 232px;
}

.option-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
}

.option-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}

.option-note {
  margin-top: auto;
  font-size: 11px;
  line-height: 1.6;
}
</style>
