<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument, Delete, Refresh, Switch } from '@element-plus/icons-vue'
import { NAMING_MODES, convertNaming } from '../utils/naming'
import { copyText } from '../utils/clipboard'

const mode = ref(NAMING_MODES[0].id)
const input = ref('user_name')
const output = ref('')
const autoConvert = ref(true)

const currentMode = computed(() => NAMING_MODES.find((item) => item.id === mode.value) ?? NAMING_MODES[0])

const inputLines = computed(() => input.value.split('\n').filter((line) => line.trim() !== '').length)

function convert(): void {
  const style = currentMode.value.style
  const lines = input.value.split('\n')
  output.value = lines
    .map((line) => (line.trim() === '' ? '' : convertNaming(line, style)))
    .join('\n')
}

function swap(): void {
  const previous = output.value
  if (!previous) return
  input.value = previous
}

async function copyOutput(): Promise<void> {
  if (!output.value) return
  const ok = await copyText(output.value)
  if (ok) ElMessage.success('已复制到剪贴板')
  else ElMessage.error('复制失败')
}

function clearAll(): void {
  input.value = ''
  output.value = ''
}

function loadExample(): void {
  const examples: Record<string, string> = {
    'snake-camel': 'user_name\norder_detail_id\napi_base_url',
    'camel-snake': 'userName\norderDetailId\napiBaseURL',
    'camel-constant': 'userName\nmaxRetryCount',
    'snake-pascal': 'user_name\nhttp_server_config',
    'camel-kebab': 'userName\nbackgroundColor',
    'kebab-camel': 'user-name\nbackground-color',
    'camel-dot': 'userName\naddressDetail',
    'camel-space': 'userName',
    'camel-title': 'userName\norderDetail'
  }
  input.value = examples[mode.value] ?? 'user_name'
}

watch([input, mode], () => {
  if (autoConvert.value) convert()
})

watch(mode, () => convert(), { immediate: true })
</script>

<template>
  <div class="page">
    <div class="page-toolbar">
      <span class="small muted">转换类型</span>
      <el-select v-model="mode" style="width: 220px" placeholder="选择转换方式">
        <el-option v-for="item in NAMING_MODES" :key="item.id" :label="item.label" :value="item.id" />
      </el-select>

      <el-button type="primary" :icon="Switch" @click="convert">转换</el-button>
      <el-button :icon="Refresh" @click="swap">结果作为输入</el-button>
      <el-button :icon="CopyDocument" :disabled="!output" @click="copyOutput">复制结果</el-button>
      <el-button :icon="Delete" @click="clearAll">清空</el-button>
      <el-checkbox v-model="autoConvert" size="small">输入时自动转换</el-checkbox>

      <div class="spacer" />
      <el-button text type="primary" @click="loadExample">示例</el-button>
    </div>

    <div class="mode-hint">
      <el-tag size="small" effect="plain">{{ currentMode.from }}</el-tag>
      <span class="arrow">→</span>
      <el-tag size="small" effect="plain" type="success">{{ currentMode.to }}</el-tag>
      <span class="example mono">{{ currentMode.example }}</span>
      <span class="spacer" />
      <span class="small muted">支持多行批量转换（每行一个命名）</span>
    </div>

    <div class="page-body">
      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">输入</span>
          <span class="spacer" />
          <span class="small muted">{{ inputLines }} 行</span>
        </div>
        <div class="panel-body">
          <el-input
            v-model="input"
            type="textarea"
            class="fill-textarea"
            resize="none"
            spellcheck="false"
            placeholder="请输入需要转换的命名，例如 user_name"
          />
        </div>
      </section>

      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">结果</span>
          <span class="spacer" />
          <el-button size="small" :icon="CopyDocument" :disabled="!output" @click="copyOutput">复制</el-button>
        </div>
        <div class="panel-body">
          <pre v-if="output" class="code-block">{{ output }}</pre>
          <div v-else class="placeholder-box">
            <el-icon :size="26"><Switch /></el-icon>
            <span>转换结果会显示在这里</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.mode-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 8px 12px;
  border: 1px dashed var(--app-border-strong);
  border-radius: 8px;
  background: var(--app-panel);
}

.arrow {
  color: var(--app-text-3);
}

.example {
  font-size: 12px;
  color: var(--app-text-3);
  margin-left: 4px;
}
</style>
