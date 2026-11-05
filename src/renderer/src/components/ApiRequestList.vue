<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  ArrowDown,
  Check,
  CopyDocument,
  Delete,
  DocumentAdd,
  EditPen,
  Expand,
  Fold,
  FolderAdd,
  FolderOpened,
  MoreFilled,
  Rank,
  Search,
  Sort
} from '@element-plus/icons-vue'
import type { ApiFolder, ApiRequestRecord } from '@shared/types'

interface FolderRow {
  type: 'folder'
  id: string
  depth: number
  folder: ApiFolder
  /** 文件夹下（含子文件夹）的请求数 */
  count: number
  expanded: boolean
}

interface RequestRow {
  type: 'request'
  id: string
  depth: number
  record: ApiRequestRecord
}

type ApiListRow = FolderRow | RequestRow

const props = defineProps<{
  /** 当前项目下的请求记录 */
  requests: ApiRequestRecord[]
  /** 当前项目下的文件夹 */
  folders: ApiFolder[]
  /** 当前选中的请求 id */
  currentId: string
  /** 有未保存修改的请求 id */
  dirtyId: string
  /** 数据文件完整路径，用于提示数据保存在哪里 */
  dataFile: string
  /** 是否折叠为窄条 */
  collapsed?: boolean
  /** 手动排序模式：可以拖拽调整顺序 */
  manualSort?: boolean
}>()

const emit = defineEmits<{
  (event: 'select', id: string): void
  (event: 'duplicate', id: string): void
  (event: 'remove', id: string): void
  (event: 'create-request', folderId: string | null): void
  (event: 'create-folder', parentId: string | null): void
  (event: 'rename-folder', id: string): void
  (event: 'remove-folder', id: string): void
  (event: 'move', id: string): void
  (event: 'reorder', kind: 'folder' | 'request', parentId: string | null, ids: string[]): void
  (event: 'sort-mode', mode: 'created' | 'manual'): void
  (event: 'reveal'): void
  (event: 'toggle'): void
}>()

const query = ref('')

/** 被折叠的文件夹 id；不在列表里就是展开的（新加的文件夹默认展开） */
const collapsedIds = ref<string[]>([])

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

function statusClass(record: ApiRequestRecord): string {
  if (record.lastOk === false) return 'danger'
  const status = record.lastStatus ?? 0
  if (!status) return 'unknown'
  if (status < 300) return 'success'
  if (status < 400) return 'info'
  if (status < 500) return 'warning'
  return 'danger'
}

/** 列表里只展示「请求结果」：状态码，没发过就显示 — */
function statusText(record: ApiRequestRecord): string {
  if (record.lastStatus) return String(record.lastStatus)
  if (record.lastOk === false) return '失败'
  return '—'
}

const keyword = computed(() => query.value.trim().toLowerCase())

function matches(record: ApiRequestRecord): boolean {
  if (!keyword.value) return true
  return (
    record.name.toLowerCase().includes(keyword.value) ||
    record.url.toLowerCase().includes(keyword.value) ||
    record.method.toLowerCase().includes(keyword.value)
  )
}

/**
 * 排序规则：
 * - 默认按「创建时间」倒序，新建的请求排在最上面；
 * - 手动排序模式下按 order 从小到大，由拖拽维护。
 */
function sortRequests(list: ApiRequestRecord[]): ApiRequestRecord[] {
  return [...list].sort((left, right) => {
    if (props.manualSort) {
      const orderLeft = left.order ?? 0
      const orderRight = right.order ?? 0
      if (orderLeft !== orderRight) return orderLeft - orderRight
    }
    return right.createdAt - left.createdAt
  })
}

function sortFolders(list: ApiFolder[]): ApiFolder[] {
  return [...list].sort((left, right) => {
    if (props.manualSort) {
      const orderLeft = left.order ?? 0
      const orderRight = right.order ?? 0
      if (orderLeft !== orderRight) return orderLeft - orderRight
    }
    return left.createdAt - right.createdAt
  })
}

const childrenOf = (parentId: string | null): ApiFolder[] =>
  sortFolders(props.folders.filter((item) => (item.parentId ?? null) === parentId))

const requestsOf = (folderId: string | null): ApiRequestRecord[] =>
  sortRequests(props.requests.filter((item) => (item.folderId ?? null) === folderId))

/** 文件夹下的请求（含所有子文件夹），用于显示数量与级联搜索 */
function collectRequests(folderId: string): ApiRequestRecord[] {
  const direct = props.requests.filter((item) => item.folderId === folderId)
  const children = childrenOf(folderId)
  return [...direct, ...children.flatMap((child) => collectRequests(child.id))]
}

const folderCounts = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  for (const folder of props.folders) map[folder.id] = collectRequests(folder.id).length
  return map
})

/**
 * 把「文件夹 + 请求」摊平成可渲染的行。
 * 搜索时只保留命中的请求与其祖先文件夹，并自动展开。
 */
const rows = computed<ApiListRow[]>(() => {
  const result: ApiListRow[] = []

  const searchActive = Boolean(keyword.value)

  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of childrenOf(parentId)) {
      if (searchActive && collectRequests(folder.id).filter(matches).length === 0) continue
      const expanded = searchActive || !collapsedIds.value.includes(folder.id)
      result.push({
        type: 'folder',
        id: folder.id,
        depth,
        folder,
        count: folderCounts.value[folder.id] ?? 0,
        expanded
      })
      if (expanded) walk(folder.id, depth + 1)
    }
    for (const record of requestsOf(parentId)) {
      if (!matches(record)) continue
      result.push({ type: 'request', id: record.id, depth, record })
    }
  }
  walk(null, 0)
  return result
})

const hasContent = computed(() => props.requests.length > 0 || props.folders.length > 0)

function toggleFolder(id: string): void {
  const set = new Set(collapsedIds.value)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  collapsedIds.value = [...set]
}

function expandAll(): void {
  collapsedIds.value = []
}

function collapseAll(): void {
  collapsedIds.value = props.folders.map((item) => item.id)
}

function onRowClick(row: ApiListRow): void {
  if (row.type === 'folder') toggleFolder(row.id)
  else emit('select', row.id)
}

/* ------------------------------ 拖拽排序 ------------------------------ */

const dragRow = ref<ApiListRow | null>(null)
const dragOverId = ref('')

/** 手动排序模式、且没有在搜索时才允许拖动 */
const canDrag = computed(() => Boolean(props.manualSort) && !keyword.value)

function rowParent(row: ApiListRow): string | null {
  return row.type === 'folder' ? (row.folder.parentId ?? null) : (row.record.folderId ?? null)
}

function onDragStart(row: ApiListRow, event: DragEvent): void {
  if (!canDrag.value) {
    event.preventDefault()
    return
  }
  dragRow.value = row
  event.dataTransfer?.setData('text/plain', row.id)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(row: ApiListRow, event: DragEvent): void {
  const source = dragRow.value
  if (!source || !canDrag.value) return
  if (source.id === row.id || source.type !== row.type) return
  if (rowParent(source) !== rowParent(row)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverId.value = row.id
}

function onDragLeave(row: ApiListRow): void {
  if (dragOverId.value === row.id) dragOverId.value = ''
}

function onDrop(row: ApiListRow): void {
  const source = dragRow.value
  dragOverId.value = ''
  dragRow.value = null
  if (!source || source.id === row.id || source.type !== row.type) return

  // 只在同一层级内重排
  const parentId = rowParent(source)
  if (parentId !== rowParent(row)) return

  const siblings = source.type === 'folder' ? childrenOf(parentId) : requestsOf(parentId)
  const ids = siblings.map((item) => item.id)
  const from = ids.indexOf(source.id)
  const to = ids.indexOf(row.id)
  if (from < 0 || to < 0 || from === to) return
  ids.splice(from, 1)
  ids.splice(to, 0, source.id)
  emit('reorder', source.type, parentId, ids)
}

function onDragEnd(): void {
  dragRow.value = null
  dragOverId.value = ''
}

function onRowCommand(row: ApiListRow, command: string | number | object): void {
  const action = String(command)
  if (row.type === 'folder') {
    switch (action) {
      case 'new-request':
        emit('create-request', row.id)
        break
      case 'new-folder':
        emit('create-folder', row.id)
        break
      case 'rename':
        emit('rename-folder', row.id)
        break
      case 'remove':
        emit('remove-folder', row.id)
        break
      default:
        break
    }
    return
  }
  switch (action) {
    case 'duplicate':
      emit('duplicate', row.id)
      break
    case 'move':
      emit('move', row.id)
      break
    case 'remove':
      emit('remove', row.id)
      break
    default:
      break
  }
}

function onHeaderCommand(command: string | number | object): void {
  switch (String(command)) {
    case 'new-folder':
      emit('create-folder', null)
      break
    case 'sort-created':
      emit('sort-mode', 'created')
      break
    case 'sort-manual':
      emit('sort-mode', 'manual')
      break
    case 'expand':
      expandAll()
      break
    case 'collapse':
      collapseAll()
      break
    case 'reveal':
      emit('reveal')
      break
    default:
      break
  }
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
      <el-dropdown trigger="click" placement="bottom-end" @command="onHeaderCommand">
        <button class="icon-toggle" type="button" title="列表操作">
          <el-icon :size="14"><MoreFilled /></el-icon>
        </button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="new-folder" :icon="FolderAdd">新建文件夹</el-dropdown-item>
            <el-dropdown-item command="sort-created" :icon="Sort" divided>
              <span class="menu-item">
                按创建时间排序
                <el-icon v-if="!manualSort" :size="13"><Check /></el-icon>
              </span>
            </el-dropdown-item>
            <el-dropdown-item command="sort-manual" :icon="Rank">
              <span class="menu-item">
                手动排序（可拖拽）
                <el-icon v-if="manualSort" :size="13"><Check /></el-icon>
              </span>
            </el-dropdown-item>
            <el-dropdown-item command="expand" :icon="Expand" divided>全部展开</el-dropdown-item>
            <el-dropdown-item command="collapse" :icon="Fold">全部折叠</el-dropdown-item>
            <el-dropdown-item command="reveal" :icon="FolderOpened" divided>打开数据文件位置</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
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
      <div v-if="!hasContent" class="list-empty">
        <span>当前项目还没有请求</span>
        <span class="tip">点击右上角「新请求」创建第一条请求记录</span>
      </div>

      <div v-else-if="rows.length === 0" class="list-empty">
        <span>没有匹配的请求</span>
        <span class="tip">换个关键字试试</span>
      </div>

      <div v-if="manualSort && !query" class="sort-hint small muted">
        手动排序中：拖动行可调整同一层级内的顺序
      </div>

      <div
        v-for="row in rows"
        :key="`${row.type}-${row.id}`"
        class="list-row"
        :class="{
          folder: row.type === 'folder',
          active: row.type === 'request' && row.id === currentId,
          draggable: canDrag,
          dragging: dragRow?.id === row.id,
          'drop-target': dragOverId === row.id
        }"
        :style="{ paddingLeft: `${6 + row.depth * 12}px` }"
        :draggable="canDrag"
        role="button"
        tabindex="0"
        :title="row.type === 'folder' ? row.folder.name : row.record.url || '未填写请求地址'"
        @click="onRowClick(row)"
        @keydown.enter.prevent="onRowClick(row)"
        @dragstart="onDragStart(row, $event)"
        @dragover="onDragOver(row, $event)"
        @dragleave="onDragLeave(row)"
        @drop.prevent="onDrop(row)"
        @dragend="onDragEnd"
      >
        <span v-if="canDrag" class="drag-handle" title="拖动排序">
          <el-icon :size="12"><Rank /></el-icon>
        </span>
        <template v-if="row.type === 'folder'">
          <el-icon class="folder-caret" :size="12">
            <ArrowDown v-if="row.expanded" />
            <Expand v-else />
          </el-icon>
          <el-icon class="folder-icon" :size="14"><FolderOpened /></el-icon>
          <span class="row-name folder-name">{{ row.folder.name }}</span>
          <span class="folder-count">{{ row.count }}</span>
          <el-dropdown
            trigger="click"
            placement="bottom-end"
            @command="(cmd: string | number | object) => onRowCommand(row, cmd)"
          >
            <button class="row-more" type="button" title="更多操作" @click.stop>
              <el-icon :size="13"><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="new-request" :icon="DocumentAdd">新建请求</el-dropdown-item>
                <el-dropdown-item command="new-folder" :icon="FolderAdd">新建子文件夹</el-dropdown-item>
                <el-dropdown-item command="rename" :icon="EditPen" divided>重命名</el-dropdown-item>
                <el-dropdown-item command="remove" :icon="Delete">删除文件夹</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>

        <template v-else>
          <span class="method-badge" :style="{ background: methodColor(row.record.method) }">
            {{ row.record.method }}
          </span>
          <span class="row-name">{{ row.record.name }}</span>
          <span v-if="row.id === dirtyId" class="unsaved-dot" title="有未保存的修改" />
          <span class="status" :class="statusClass(row.record)">
            {{ statusText(row.record) }}
          </span>
          <el-dropdown
            trigger="click"
            placement="bottom-end"
            @command="(cmd: string | number | object) => onRowCommand(row, cmd)"
          >
            <button class="row-more" type="button" title="更多操作" @click.stop>
              <el-icon :size="13"><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="duplicate" :icon="CopyDocument">复制为副本</el-dropdown-item>
                <el-dropdown-item command="move" :icon="FolderOpened">移动到文件夹…</el-dropdown-item>
                <el-dropdown-item command="remove" :icon="Delete" divided>删除</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </template>
      </div>
    </div>

    <div v-else class="rail-body">
      <el-tooltip
        v-for="item in requests"
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
  /* 随窗口变宽：最小保持原来的 268px，最宽 460px */
  flex: 0 0 21%;
  min-width: 268px;
  max-width: 460px;
  transition: flex-basis 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

.request-list .panel-title {
  flex: none;
  white-space: nowrap;
}

.request-list.collapsed {
  flex: 0 0 54px;
  min-width: 54px;
  max-width: 54px;
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
  width: 96px;
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
  padding: 8px 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
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

/* 一行一条：请求类型 + 接口名称 + 请求结果，操作收进弹出菜单 */
.list-row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding-right: 4px;
  border: 1px solid transparent;
  border-radius: 7px;
  cursor: pointer;
  outline: none;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.list-row:hover,
.list-row:focus-visible {
  background: var(--app-hover);
  border-color: var(--app-border);
}

.list-row.active {
  background: var(--app-primary-soft);
  border-color: rgba(47, 111, 237, 0.32);
}

.list-row.folder {
  color: var(--app-text-2);
}

/* 手动排序：拖拽手柄与落点提示 */
.sort-hint {
  padding: 2px 8px 6px;
  font-size: 11px;
  color: var(--app-text-3);
}

.drag-handle {
  flex: none;
  display: inline-flex;
  align-items: center;
  color: var(--app-text-3);
  cursor: grab;
  opacity: 0.55;
}

.list-row:hover .drag-handle {
  opacity: 1;
}

.list-row.dragging {
  opacity: 0.4;
}

.list-row.drop-target {
  border-color: var(--app-primary);
  box-shadow: inset 0 0 0 1px var(--app-primary);
}

.menu-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 132px;
}

.folder-caret {
  flex: none;
  color: var(--app-text-3);
}

.folder-icon {
  flex: none;
  color: #d9a441;
}

.folder-name {
  font-weight: 600;
  color: var(--app-text-2);
}

.folder-count {
  flex: none;
  font-size: 11px;
  color: var(--app-text-3);
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

.row-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--app-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unsaved-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ef4444;
}

.status {
  flex: none;
  min-width: 22px;
  padding: 0 5px;
  border-radius: 3px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 15px;
  text-align: center;
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
  background: var(--app-border-strong);
  color: var(--app-text-3);
}

.row-more {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text-3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.list-row:hover .row-more,
.list-row.active .row-more,
.row-more:focus-visible {
  opacity: 1;
}

.row-more:hover {
  background: var(--app-panel);
  color: var(--app-primary);
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
