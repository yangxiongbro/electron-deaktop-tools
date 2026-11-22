<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import JsonFormatter from './JsonFormatter.vue'
import NamingConverter from './NamingConverter.vue'
import CodecTool from './CodecTool.vue'
import TextTool from './TextTool.vue'

/**
 * 文本类工具：把 JSON / 命名转换 / 编解码 / 字符处理 四个纯文本工具
 * 收进同一页面，用顶部标签页切换（各自的状态用 KeepAlive 保留）。
 */

const TABS = [
  { label: 'JSON 格式化', value: 'json' },
  { label: '命名规范转换', value: 'naming' },
  { label: '编码 / 解码', value: 'codec' },
  { label: '字符处理', value: 'text' }
]

const TAB_KEY = 'devtoolbox.workbench.tab'

const COMPONENTS = {
  json: JsonFormatter,
  naming: NamingConverter,
  codec: CodecTool,
  text: TextTool
} as const

type TabId = keyof typeof COMPONENTS

function readTab(): TabId {
  try {
    const saved = localStorage.getItem(TAB_KEY)
    if (saved && saved in COMPONENTS) return saved as TabId
  } catch {
    // 忽略 localStorage 不可用
  }
  return 'json'
}

const activeTab = ref<TabId>(readTab())
const current = computed(() => COMPONENTS[activeTab.value] ?? JsonFormatter)

watch(activeTab, (value) => {
  try {
    localStorage.setItem(TAB_KEY, value)
  } catch {
    // 忽略
  }
})
</script>

<template>
  <div class="page workbench">
    <div class="workbench-tabs">
      <SegmentedControl v-model="activeTab" :options="TABS" />
    </div>
    <div class="workbench-body">
      <KeepAlive>
        <component :is="current" />
      </KeepAlive>
    </div>
  </div>
</template>

<style scoped>
.workbench {
  gap: 10px;
}

.workbench-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.workbench-body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.workbench-body > :deep(*) {
  flex: 1;
  min-width: 0;
}
</style>
