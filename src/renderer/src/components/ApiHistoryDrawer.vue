<script setup lang="ts">
import { computed, ref } from 'vue'
import { Delete, Refresh, Search } from '@element-plus/icons-vue'
import type { ApiHistoryEntry } from '@shared/types'

const props = defineProps<{
  modelValue: boolean
  entries: ApiHistoryEntry[]
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'select', entry: ApiHistoryEntry): void
  (event: 'remove', id: string): void
  (event: 'clear'): void
}>()

const query = ref('')

const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return props.entries
  return props.entries.filter(
    (entry) => entry.url.toLowerCase().includes(keyword) || entry.method.toLowerCase().includes(keyword)
  )
})

function formatTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function statusClass(status?: number): string {
  if (!status) return 'unknown'
  if (status < 300) return 'success'
  if (status < 400) return 'info'
  if (status < 500) return 'warning'
  return 'danger'
}

function paramCount(entry: ApiHistoryEntry): number {
  return entry.params.filter((row) => row.enabled && row.key).length
}

function close(): void {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-drawer
    :model-value="modelValue"
    direction="ltr"
    size="420px"
    :with-header="false"
    class="history-drawer"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="history-shell">
      <header class="history-header">
        <div class="history-title">
          <span>请求列表</span>
          <span class="count">{{ entries.length }}</span>
        </div>
        <button class="close-btn" title="关闭" @click="close">×</button>
      </header>

      <div class="history-search">
        <el-input v-model="query" size="small" placeholder="搜索地址或方法" :prefix-icon="Search" clearable />
      </div>

      <div class="history-list">
        <div v-if="filtered.length === 0" class="history-empty">
          <span>还没有请求记录</span>
          <span class="tip">发送请求后会自动保存到这里</span>
        </div>

        <button
          v-for="item in filtered"
          :key="item.id"
          class="history-item"
          :title="`${item.method} ${item.url}`"
          @click="emit('select', item)"
        >
          <span class="method" :class="`m-${item.method.toLowerCase()}`">{{ item.method }}</span>
          <span class="item-main">
            <span class="item-url">{{ item.url }}</span>
            <span class="item-meta">
              <span v-if="item.status" class="status" :class="statusClass(item.status)">{{ item.status }}</span>
              <span>{{ formatTime(item.createdAt) }}</span>
              <span v-if="paramCount(item)">{{ paramCount(item) }} 个参数</span>
              <span v-if="item.body.type !== 'none'">{{ item.body.type }}</span>
            </span>
          </span>
          <span class="item-remove" title="删除" @click.stop="emit('remove', item.id)">
            <el-icon :size="13"><Delete /></el-icon>
          </span>
        </button>
      </div>

      <footer class="history-footer">
        <el-button size="small" :icon="Refresh" :disabled="entries.length === 0" @click="emit('clear')">
          清空历史
        </el-button>
        <span class="tip">最多保留 100 条，重复请求会自动置顶</span>
      </footer>
    </div>
  </el-drawer>
</template>

<style scoped>
.history-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.history-header {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--app-border);
  flex: none;
}

.history-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 650;
  color: var(--app-text);
}

.count {
  min-width: 20px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--app-primary-soft);
  color: var(--app-primary);
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  font-weight: 600;
}

.close-btn {
  margin-left: auto;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-3);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}

.close-btn:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.history-search {
  padding: 10px 16px;
  flex: none;
}

.history-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.history-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 48px 12px;
  color: var(--app-text-3);
  font-size: 13px;
}

.tip {
  font-size: 11.5px;
  color: var(--app-text-3);
}

.history-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.history-item:hover {
  background: var(--app-hover);
  border-color: var(--app-border);
}

.method {
  flex: none;
  min-width: 46px;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 700;
  font-family: var(--app-mono);
  text-align: center;
  color: #fff;
  background: #64748b;
}

.method.m-get {
  background: #22a06b;
}

.method.m-post {
  background: #2f6fed;
}

.method.m-put {
  background: #d97706;
}

.method.m-patch {
  background: #8b5cf6;
}

.method.m-delete {
  background: #dc2626;
}

.method.m-head {
  background: #0891b2;
}

.item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.item-url {
  font-size: 12.5px;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--app-mono);
}

.item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--app-text-3);
}

.status {
  padding: 0 5px;
  border-radius: 3px;
  font-weight: 600;
  color: #fff;
}

.status.success {
  background: #16a34a;
}

.status.info {
  background: #0891b2;
}

.status.warning {
  background: #d97706;
}

.status.danger {
  background: #dc2626;
}

.status.unknown {
  background: #94a3b8;
}

.item-remove {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  color: var(--app-text-3);
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.history-item:hover .item-remove {
  opacity: 1;
}

.item-remove:hover {
  background: rgba(220, 38, 38, 0.12);
  color: #dc2626;
}

.history-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid var(--app-border);
}
</style>
