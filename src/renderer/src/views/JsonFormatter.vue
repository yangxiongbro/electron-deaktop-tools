<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { ElMessage } from 'element-plus'
import {
  CopyDocument,
  Delete,
  Download,
  FolderOpened,
  MagicStick,
  Minus,
  Upload
} from '@element-plus/icons-vue'
import type { JsonErrorInfo } from '@shared/jsonValidate'
import { validateJsonText } from '@shared/jsonValidate'
import type { FilePickResult, JsonFileOk, JsonFileFail } from '@shared/types'
import JsonTree from '../components/JsonTree.vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { copyText } from '../utils/clipboard'
import { formatBytes, formatDuration } from '../utils/format'

const VIEW_OPTIONS = [
  { label: '树形', value: 'tree' },
  { label: '文本', value: 'text' }
]

const input = ref('')
const outputText = ref('')
const parsed = shallowRef<unknown>(undefined)
const error = ref<JsonErrorInfo | null>(null)
const viewMode = ref('tree')
const indent = ref<'2' | '4' | 'tab'>('2')
const autoFormat = ref(true)

const TEXT_RENDER_LIMIT = 300_000

const renderedText = computed(() =>
  outputText.value.length > TEXT_RENDER_LIMIT ? outputText.value.slice(0, TEXT_RENDER_LIMIT) : outputText.value
)
const textTruncated = computed(() => outputText.value.length > TEXT_RENDER_LIMIT)

const inputStats = computed(() => {
  const length = input.value.length
  if (length === 0) return '空'
  const lines = input.value.split('\n').length
  return `${length.toLocaleString()} 字符 · ${lines.toLocaleString()} 行`
})

const outputStats = computed(() => {
  if (!outputText.value) return ''
  const bytes = new TextEncoder().encode(outputText.value).length
  return `${formatBytes(bytes)} · ${outputText.value.split('\n').length.toLocaleString()} 行`
})

function indentUnit(value: '2' | '4' | 'tab'): string {
  return value === 'tab' ? '\t' : ' '.repeat(Number(value))
}

function resetResult(): void {
  outputText.value = ''
  parsed.value = undefined
  error.value = null
}

function format(): void {
  const source = input.value
  if (!source.trim()) {
    resetResult()
    return
  }
  const result = validateJsonText(source)
  if (!result.ok) {
    error.value = result.error
    outputText.value = ''
    parsed.value = undefined
    return
  }
  error.value = null
  parsed.value = result.value
  outputText.value = JSON.stringify(result.value, null, indentUnit(indent.value))
}

function minify(): void {
  const source = input.value
  if (!source.trim()) return
  const result = validateJsonText(source)
  if (!result.ok) {
    error.value = result.error
    outputText.value = ''
    parsed.value = undefined
    return
  }
  error.value = null
  parsed.value = result.value
  outputText.value = JSON.stringify(result.value)
  viewMode.value = 'text'
}

function reformat(): void {
  if (parsed.value !== undefined) {
    outputText.value = JSON.stringify(parsed.value, null, indentUnit(indent.value))
  }
}

function clearAll(): void {
  input.value = ''
  resetResult()
}

async function copyOutput(): Promise<void> {
  if (!outputText.value) return
  const ok = await copyText(outputText.value)
  if (ok) ElMessage.success('已复制到剪贴板')
  else ElMessage.error('复制失败，请手动选择后复制')
}

async function importFile(): Promise<void> {
  const result = await window.api.dialog.openFile({
    title: '导入 JSON 文件',
    filters: [
      { name: 'JSON 文件', extensions: ['json', 'txt', 'log'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePath) return
  const read = await window.api.file.readText(result.filePath)
  if (!read.ok) {
    ElMessage.error(read.error ?? '读取失败')
    return
  }
  input.value = read.content ?? ''
  ElMessage.success(`已导入 ${result.fileName ?? ''}`)
}

/* ------------------------------ 超大文件处理 ------------------------------ */

const fileDialog = ref(false)
const inputFile = ref<FilePickResult | null>(null)
const outputPath = ref('')
const fileIndent = ref<'2' | '4' | 'tab'>('2')
const fileMinify = ref(false)
const processing = ref(false)
const progress = ref(0)
const fileResult = ref<JsonFileOk | JsonFileFail | null>(null)

function suggestOutput(inputPath: string): string {
  const dot = inputPath.lastIndexOf('.')
  const sep = Math.max(inputPath.lastIndexOf('/'), inputPath.lastIndexOf('\\'))
  if (dot > sep + 1) return `${inputPath.slice(0, dot)}.formatted${inputPath.slice(dot)}`
  return `${inputPath}.formatted.json`
}

async function pickInputFile(): Promise<void> {
  const result = await window.api.dialog.openFile({
    title: '选择要处理的 JSON 文件',
    filters: [
      { name: 'JSON 文件', extensions: ['json', 'txt', 'log'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePath) return
  inputFile.value = result
  outputPath.value = suggestOutput(result.filePath)
  fileResult.value = null
  progress.value = 0
}

async function pickOutputFile(): Promise<void> {
  const result = await window.api.dialog.saveFile({
    title: '选择输出文件',
    defaultPath: outputPath.value || undefined,
    filters: [{ name: 'JSON 文件', extensions: ['json'] }]
  })
  if (result.canceled || !result.filePath) return
  outputPath.value = result.filePath
}

async function runFile(): Promise<void> {
  if (!inputFile.value?.filePath) {
    ElMessage.warning('请先选择输入文件')
    return
  }
  if (!outputPath.value) {
    ElMessage.warning('请先选择输出文件')
    return
  }
  processing.value = true
  progress.value = 0
  fileResult.value = null
  try {
    const result = await window.api.json.formatFile({
      inputPath: inputFile.value.filePath,
      outputPath: outputPath.value,
      indent: fileIndent.value === 'tab' ? 'tab' : Number(fileIndent.value),
      minify: fileMinify.value
    })
    fileResult.value = result
    if (result.ok) {
      progress.value = 100
      ElMessage.success(`处理完成，用时 ${formatDuration(result.durationMs)}`)
    } else {
      ElMessage.error('JSON 校验失败，已停止处理')
    }
  } catch (err) {
    fileResult.value = {
      ok: false,
      error: { message: (err as Error).message, line: 0, column: 0, offset: 0, snippet: '' }
    }
  } finally {
    processing.value = false
  }
}

async function openResultFolder(): Promise<void> {
  if (fileResult.value?.ok) {
    await window.api.app.showItemInFolder(fileResult.value.outputPath)
  }
}

let progressUnsubscribe: (() => void) | undefined
onMounted(() => {
  progressUnsubscribe = window.api.json.onProgress((payload) => {
    if (payload.total > 0) {
      progress.value = Math.min(99, Math.round((payload.loaded / payload.total) * 100))
    }
  })
})
onUnmounted(() => progressUnsubscribe?.())

let timer: number | undefined
watch(input, () => {
  if (!autoFormat.value) return
  if (timer) window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    if (input.value.length > 3 * 1024 * 1024) return
    format()
  }, 350)
})

watch(indent, reformat)
</script>

<template>
  <div class="page">
    <div class="page-toolbar">
      <el-button type="primary" :icon="MagicStick" @click="format">格式化</el-button>
      <el-button :icon="Minus" @click="minify">压缩</el-button>
      <el-button :icon="CopyDocument" :disabled="!outputText" @click="copyOutput">复制结果</el-button>
      <el-button :icon="Delete" @click="clearAll">一键清空</el-button>

      <el-divider direction="vertical" />

      <span class="small muted">缩进</span>
      <el-select v-model="indent" size="small" style="width: 92px">
        <el-option label="2 空格" value="2" />
        <el-option label="4 空格" value="4" />
        <el-option label="Tab" value="tab" />
      </el-select>
      <el-checkbox v-model="autoFormat" size="small">自动格式化</el-checkbox>

      <div class="spacer" />

      <el-button :icon="Upload" @click="importFile">导入文件</el-button>
      <el-button :icon="Download" @click="fileDialog = true">超大文件处理</el-button>
    </div>

    <el-alert v-if="error" type="error" :closable="false" show-icon class="json-error">
      <template #title>
        第 {{ error.line }} 行第 {{ error.column }} 列：{{ error.message }}
      </template>
      <pre class="error-snippet mono">{{ error.snippet }}</pre>
    </el-alert>

    <div class="page-body">
      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">输入</span>
          <span class="spacer" />
          <span class="small muted">{{ inputStats }}</span>
        </div>
        <div class="panel-body">
          <el-input
            v-model="input"
            type="textarea"
            class="fill-textarea"
            resize="none"
            spellcheck="false"
            placeholder="在此粘贴 JSON 字符串，或点击「导入文件」&#10;支持 Ctrl + Enter 快速格式化"
            @keydown.ctrl.enter.prevent="format"
          />
        </div>
      </section>

      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">结果</span>
          <SegmentedControl v-model="viewMode" :options="VIEW_OPTIONS" size="small" />
          <span class="spacer" />
          <span class="small muted">{{ outputStats }}</span>
          <el-button size="small" :icon="CopyDocument" :disabled="!outputText" @click="copyOutput">复制</el-button>
        </div>
        <div class="panel-body">
          <template v-if="outputText">
            <JsonTree
              v-if="viewMode === 'tree' && parsed !== undefined"
              :data="parsed"
              :expand-depth="2"
              class="tree-wrap"
            />
            <template v-else>
              <pre class="code-block">{{ renderedText }}</pre>
              <div v-if="textTruncated" class="truncate-hint small">
                内容较大，仅显示前 30 万字符；完整内容可点击「复制」或在「超大文件处理」中直接输出到文件
              </div>
            </template>
          </template>
          <div v-else class="placeholder-box">
            <el-icon :size="26"><MagicStick /></el-icon>
            <span>格式化结果会显示在这里</span>
          </div>
        </div>
      </section>
    </div>

    <el-dialog v-model="fileDialog" title="超大文件处理" width="680px" :close-on-click-modal="false">
      <div class="file-form">
        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="大文件采用流式读取与流式写出，不会占用大量内存，结果直接写入输出文件，不在界面展示。"
        />

        <div class="file-row">
          <span class="file-label">输入文件</span>
          <el-input :model-value="inputFile?.filePath ?? ''" readonly placeholder="请选择要格式化的 JSON 文件" />
          <el-button :icon="FolderOpened" @click="pickInputFile">选择</el-button>
        </div>

        <div class="file-row">
          <span class="file-label">输出文件</span>
          <el-input v-model="outputPath" placeholder="请选择输出文件路径" />
          <el-button :icon="FolderOpened" @click="pickOutputFile">选择</el-button>
        </div>

        <div class="file-row">
          <span class="file-label">格式化方式</span>
          <el-select v-model="fileIndent" :disabled="fileMinify" style="width: 120px">
            <el-option label="2 空格" value="2" />
            <el-option label="4 空格" value="4" />
            <el-option label="Tab" value="tab" />
          </el-select>
          <el-checkbox v-model="fileMinify">压缩为单行</el-checkbox>
          <span class="spacer" />
          <span v-if="inputFile?.size" class="small muted">文件大小：{{ formatBytes(inputFile.size) }}</span>
        </div>

        <el-progress v-if="processing" :percentage="progress" :stroke-width="8" />

        <div v-if="fileResult" class="file-result">
          <el-alert v-if="fileResult.ok" type="success" :closable="false" show-icon>
            <template #title>处理完成</template>
            <div class="result-lines small">
              <div>输出文件：{{ fileResult.outputPath }}</div>
              <div>
                输入 {{ formatBytes(fileResult.inputBytes) }} → 输出 {{ formatBytes(fileResult.outputBytes) }}，用时
                {{ formatDuration(fileResult.durationMs) }}
              </div>
            </div>
          </el-alert>
          <el-alert v-else type="error" :closable="false" show-icon>
            <template #title>
              <span v-if="fileResult.error.line > 0">
                第 {{ fileResult.error.line }} 行第 {{ fileResult.error.column }} 列：{{ fileResult.error.message }}
              </span>
              <span v-else>{{ fileResult.error.message }}</span>
            </template>
            <pre v-if="fileResult.error.snippet" class="error-snippet mono">{{ fileResult.error.snippet }}</pre>
          </el-alert>
        </div>
      </div>

      <template #footer>
        <el-button @click="fileDialog = false">关闭</el-button>
        <el-button v-if="fileResult?.ok" :icon="FolderOpened" @click="openResultFolder">打开所在目录</el-button>
        <el-button type="primary" :loading="processing" @click="runFile">开始处理</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.json-error {
  flex: none;
}

.error-snippet {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.05);
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre;
}

html.dark .error-snippet {
  background: rgba(255, 255, 255, 0.06);
}

.tree-wrap {
  padding: 10px 4px 16px;
}

.truncate-hint {
  padding: 6px 12px 12px;
  color: var(--app-text-3);
}

.file-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.file-label {
  width: 72px;
  flex: none;
  font-size: 13px;
  color: var(--app-text-2);
}

.file-result {
  margin-top: 4px;
}

.result-lines {
  line-height: 1.7;
  word-break: break-all;
}
</style>
