<script setup lang="ts">
import { computed, ref } from 'vue'
import { CopyDocument, Delete, Expand, Fold, FolderOpened, Search } from '@element-plus/icons-vue'
import type { ApiRequestRecord } from '@shared/types'
import { formatDuration } from '../utils/format'

const props = defineProps<{
  /** 当前项目下的请求记录，最新的在最前 */
  requests: ApiRequestRecord[]
  /** 当前选中的请求 id */
  currentId: string
  /** 有未保存修改的请求 id */
  dirtyId: string
  /** 数据文件完整路径，用于提示数据保存在哪里 */
  dataFile: string
  /** 是否折叠为窄条 */
  collapsed?: boolean
}>()

const emit = defineEmits<{
  (event: 'select', id: string): void
  (event: 'duplicate', id: string): void
  (event: 'remove', id: string): void
  (event: 'reveal'): void
  (event: 'toggle'): void
}>()

const query = ref('')

const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return props.requests
  return props.requests.filter(
    (item) =>
      item.name.toLowerCase().includes(keyword) ||
      item.url.toLowerCase().includes(keyword) ||
      item.method.toLowerCase().includes(keyword)
  )
})

const dataFileName = computed(() => props.dataFile.split(/[\\/]/).pop() || 'api-projects.json')

const METHOD_COLORS: Record<string, string> = {
  GET: '#22a06b',
  POST: '#2f6fed',
  PUT: '#d97706',
  PATCH: '#8b5cf6',
  DELETE: '#dc2626',
  HEAD: '#0891b2',
  OPTIONS: '#64748b'
}

function methodColor(method: string): string {
  return METHOD_COLORS[method] ?? '#64748b'
}

/** 折叠态只显示一个字符，保证窄条里也能区分方法 */
function methodShort(method: string): string {
  const map: Record<string, string> = {
    GET: 'G',
    POST: 'P',
    PUT: 'U',
    PATCH: 'A',
    DELETE: 'D',
    HEAD: 'H',
    OPTIONS: 'O'
  }
  return map[method] ?? method.slice(0, 1)
}

function statusClass(status?: number): string {
  if (!status) return 'unknown'
  if (status < 300) return 'success'
  if (status < 400) return 'info'
  if (status < 500) return 'warning'
  return 'danger'
}

function paramCount(record: ApiRequestRecord): number {
  return record.params.filter((row) => row.enabled && row.key).length
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '-'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <section class="panel request-list" :class="{ collapsed }">
    <header v-if="!collapsed" class="panel-header">
      <span class="panel-title">请求列表</span>
      <span class="count">{{ requests.length }}</span>
      <span class="spacer" />
      <el-input
        v-model="query"
        size="small"
        class="list-search"
        placeholder="搜索"
        :prefix-icon="Search"
        clearable
      />
      <button class="icon-toggle" type="button" title="折叠请求列表" @click="emit('toggle')">
        <el-icon :size="14"><Fold /></el-icon>
      </button>
    </header>

    <header v-else class="rail-header">
      <button class="icon-toggle" type="button" title="展开请求列表" @click="emit('toggle')">
        <el-icon :size="14"><Expand /></el-icon>
      </button>
      <span class="count">{{ requests.length }}</span>
    </header>

    <div v-if="!collapsed" class="list-body">
      <div v-if="requests.length === 0" class="list-empty">
        <span>当前项目还没有请求</span>
        <span class="tip">点击右上角「新请求」创建第一条请求记录</span>
      </div>

      <div v-else-if="filtered.length === 0" class="list-empty">
        <span>没有匹配的请求</span>
        <span class="tip">换个关键字试试</span>
      </div>

      <div
        v-for="item in filtered"
        :key="item.id"
        class="req-item"
        :class="{ active: item.id === currentId }"
        role="button"
        tabindex="0"
        :title="`${item.method} ${item.url || '未填写请求地址'}`"
        @click="emit('select', item.id)"
        @keydown.enter.prevent="emit('select', item.id)"
      >
        <div class="req-top">
          <span class="method-badge" :style="{ background: methodColor(item.method) }">{{ item.method }}</span>
          <span class="req-name">{{ item.name }}</span>
          <span v-if="item.id === dirtyId" class="unsaved-dot" title="有未保存的修改" />
          <span v-if="item.lastStatus" class="status" :class="statusClass(item.lastStatus)">
            {{ item.lastStatus }}
          </span>
        </div>
        <div class="req-url">{{ item.url || '未填写请求地址' }}</div>
        <div class="req-meta">
          <span>{{ formatTime(item.updatedAt) }}</span>
          <span v-if="item.lastDurationMs !== undefined">{{ formatDuration(item.lastDurationMs) }}</span>
          <span v-if="paramCount(item)">{{ paramCount(item) }} 个参数</span>
          <span v-if="item.body.type !== 'none'">{{ item.body.type }}</span>
        </div>

        <div class="req-actions">
          <button class="mini-btn" title="复制为新请求" type="button" @click.stop="emit('duplicate', item.id)">
            <el-icon :size="13"><CopyDocument /></el-icon>
          </button>
          <button class="mini-btn danger" title="删除该请求" type="button" @click.stop="emit('remove', item.id)">
            <el-icon :size="13"><Delete /></el-icon>
          </button>
        </div>
      </div>
    </div>

    <div v-else class="rail-body">
      <el-tooltip
        v-for="item in filtered"
        :key="item.id"
        :content="`${item.method} ${item.name}`"
        placement="right"
        :show-after="120"
      >
        <button
          class="rail-item"
          :class="{ active: item.id === currentId }"
          type="button"
          @click="emit('select', item.id)"
        >
          <span class="rail-method" :style="{ color: methodColor(item.method) }">{{ methodShort(item.method) }}</span>
          <span v-if="item.id === dirtyId" class="rail-dot" />
        </button>
      </el-tooltip>
      <div v-if="requests.length === 0" class="rail-empty">空</div>
    </div>

    <footer v-if="!collapsed" class="list-footer">
      <el-icon :size="13" class="footer-icon"><FolderOpened /></el-icon>
      <span class="file-name" :title="dataFile || '请求数据文件'">{{ dataFileName }}</span>
      <span class="spacer" />
      <el-button link size="small" @click="emit('reveal')">打开位置</el-button>
    </footer>

    <footer v-else class="list-footer rail-footer">
      <el-tooltip content="打开数据文件位置" placement="right" :show-after="120">
        <button class="rail-item" type="button" @click="emit('reveal')">
          <el-icon :size="14"><FolderOpened /></el-icon>
        </button>
      </el-tooltip>
    </footer>
  </section>
</template>

<style scoped>
.request-list {
  width: 258px;
  flex: none;
  transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.request-list.collapsed {
  width: 54px;
}

.count {
  min-width: 20px;
  height: 17px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--app-primary-soft);
  color: var(--app-primary);
  font-size: 11px;
  line-height: 17px;
  text-align: center;
  font-weight: 600;
}

.list-search {
  width: 100px;
}

.list-search :deep(.el-input__wrapper) {
  padding: 1px 8px;
}

.icon-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-3);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.icon-toggle:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.rail-header {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.list-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.rail-item {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-2);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.rail-item:hover {
  background: var(--app-hover);
  border-color: var(--app-border);
}

.rail-item.active {
  background: var(--app-primary-soft);
  border-color: rgba(47, 111, 237, 0.32);
}

.rail-method {
  font-family: var(--app-mono);
  font-size: 12px;
  font-weight: 700;
}

.rail-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #ef4444;
}

.rail-empty {
  font-size: 11px;
  color: var(--app-text-3);
  padding: 8px 0;
}

.list-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 40px 12px;
  color: var(--app-text-3);
  font-size: 13px;
  text-align: center;
}

.tip {
  font-size: 11.5px;
  color: var(--app-text-3);
}

.req-item {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
  outline: none;
}

.req-item:hover,
.req-item:focus-visible {
  background: var(--app-hover);
  border-color: var(--app-border);
}

.req-item.active {
  background: var(--app-primary-soft);
  border-color: rgba(47, 111, 237, 0.32);
}

.req-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.method-badge {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  font-family: var(--app-mono);
  font-size: 10px;
  font-weight: 700;
  line-height: 16px;
  color: #fff;
  letter-spacing: 0.2px;
}

.req-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unsaved-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #ef4444;
}

.status {
  flex: none;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 15px;
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

.req-url {
  font-family: var(--app-mono);
  font-size: 11.5px;
  color: var(--app-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.req-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--app-text-3);
}

.req-actions {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 2px;
  padding: 1px;
  border-radius: 6px;
  background: var(--app-panel);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.req-item:hover .req-actions,
.req-item:focus-within .req-actions {
  opacity: 1;
}

.mini-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text-3);
  cursor: pointer;
}

.mini-btn:hover {
  background: var(--app-hover);
  color: var(--app-primary);
}

.mini-btn.danger:hover {
  background: rgba(220, 38, 38, 0.12);
  color: #dc2626;
}

.list-footer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
  border-top: 1px solid var(--app-border);
  background: var(--app-panel-muted);
}

.rail-footer {
  justify-content: center;
  padding: 6px 0;
}

.footer-icon {
  color: var(--app-text-3);
}

.file-name {
  font-family: var(--app-mono);
  font-size: 11px;
  color: var(--app-text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
