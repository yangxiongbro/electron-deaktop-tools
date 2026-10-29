<script setup lang="ts">
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    data: unknown
    nodeKey?: string
    isIndex?: boolean
    depth?: number
    expandDepth?: number
  }>(),
  {
    nodeKey: undefined,
    isIndex: false,
    depth: 0,
    expandDepth: 2
  }
)

type JsonKind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'

const kind = computed<JsonKind>(() => {
  const value = props.data
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'object') return 'object'
  if (type === 'number') return 'number'
  if (type === 'boolean') return 'boolean'
  return 'string'
})

const isContainer = computed(() => kind.value === 'object' || kind.value === 'array')
const expanded = ref(props.depth < props.expandDepth)

const entries = computed<{ key: string; value: unknown }[]>(() => {
  if (kind.value === 'array') {
    return (props.data as unknown[]).map((item, index) => ({ key: String(index), value: item }))
  }
  if (kind.value === 'object') {
    return Object.entries(props.data as Record<string, unknown>).map(([key, value]) => ({ key, value }))
  }
  return []
})

const LIMIT = 100
const limit = ref(LIMIT)
const visibleEntries = computed(() => entries.value.slice(0, limit.value))
const hiddenCount = computed(() => Math.max(0, entries.value.length - limit.value))

const summary = computed(() =>
  kind.value === 'array' ? `Array(${entries.value.length})` : `Object(${entries.value.length})`
)

const displayValue = computed(() => {
  if (kind.value === 'string') return JSON.stringify(props.data)
  if (kind.value === 'null') return 'null'
  return String(props.data)
})

function toggle(): void {
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="jt-node">
    <div class="jt-row" :style="{ paddingLeft: `${depth * 16 + 8}px` }">
      <span v-if="isContainer" class="jt-arrow" @click="toggle">{{ expanded ? '▾' : '▸' }}</span>
      <span v-else class="jt-arrow jt-arrow-empty" />

      <template v-if="nodeKey !== undefined">
        <span class="jt-key" :class="{ 'jt-index': isIndex }">{{ isIndex ? nodeKey : JSON.stringify(nodeKey) }}</span>
        <span class="jt-punct">: </span>
      </template>

      <template v-if="isContainer">
        <span class="jt-punct">{{ kind === 'array' ? '[' : '{' }}</span>
        <span v-if="!expanded" class="jt-collapsed" @click="toggle">
          {{ summary }} …
          <span class="jt-punct">{{ kind === 'array' ? ']' : '}' }}</span>
        </span>
      </template>
      <span v-else class="jt-value" :class="`jt-${kind}`">{{ displayValue }}</span>
    </div>

    <template v-if="isContainer && expanded">
      <JsonTree
        v-for="entry in visibleEntries"
        :key="entry.key"
        :data="entry.value"
        :node-key="entry.key"
        :is-index="kind === 'array'"
        :depth="depth + 1"
        :expand-depth="expandDepth"
      />
      <div v-if="hiddenCount > 0" class="jt-more" :style="{ paddingLeft: `${(depth + 1) * 16 + 8}px` }">
        <span class="jt-more-btn" @click="limit += LIMIT">还有 {{ hiddenCount }} 项，点击加载更多</span>
      </div>
      <div class="jt-row" :style="{ paddingLeft: `${depth * 16 + 8}px` }">
        <span class="jt-arrow jt-arrow-empty" />
        <span class="jt-punct">{{ kind === 'array' ? ']' : '}' }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.jt-node {
  font-family: var(--app-mono);
  font-size: 13px;
  line-height: 1.75;
}

.jt-row {
  display: flex;
  align-items: flex-start;
  padding-right: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.jt-arrow {
  width: 16px;
  flex: none;
  color: var(--app-text-3);
  cursor: pointer;
  user-select: none;
  font-size: 11px;
  line-height: 22px;
}

.jt-arrow-empty {
  cursor: default;
}

.jt-key {
  color: var(--json-key);
}

.jt-index {
  color: var(--app-text-3);
}

.jt-punct {
  color: var(--app-text-2);
}

.jt-string {
  color: var(--json-string);
}

.jt-number {
  color: var(--json-number);
}

.jt-boolean {
  color: var(--json-boolean);
}

.jt-null {
  color: var(--json-null);
  font-style: italic;
}

.jt-collapsed {
  color: var(--app-text-3);
  cursor: pointer;
  font-size: 12px;
}

.jt-collapsed:hover {
  color: var(--app-primary);
}

.jt-more {
  padding-top: 2px;
  padding-bottom: 2px;
}

.jt-more-btn {
  font-size: 12px;
  color: var(--app-primary);
  cursor: pointer;
  font-family: inherit;
}
</style>
