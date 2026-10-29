<script setup lang="ts">
import { Delete, Plus } from '@element-plus/icons-vue'
import type { KeyValueRow } from '@shared/types'
import { randomId } from '../utils/format'

const props = withDefaults(
  defineProps<{
    modelValue: KeyValueRow[]
    keyPlaceholder?: string
    valuePlaceholder?: string
    keyWidth?: string
  }>(),
  {
    keyPlaceholder: 'Key',
    valuePlaceholder: 'Value',
    keyWidth: '34%'
  }
)

const emit = defineEmits<{
  (event: 'update:modelValue', rows: KeyValueRow[]): void
}>()

function update(id: string, patch: Partial<KeyValueRow>): void {
  emit(
    'update:modelValue',
    props.modelValue.map((row) => (row.id === id ? { ...row, ...patch } : row))
  )
}

function remove(id: string): void {
  emit(
    'update:modelValue',
    props.modelValue.filter((row) => row.id !== id)
  )
}

function add(): void {
  emit('update:modelValue', [...props.modelValue, { id: randomId(), enabled: true, key: '', value: '' }])
}
</script>

<template>
  <div class="kv-editor">
    <div v-if="modelValue.length === 0" class="kv-empty muted small">暂无内容</div>
    <div v-for="row in modelValue" :key="row.id" class="kv-row">
      <el-checkbox :model-value="row.enabled" @update:model-value="update(row.id, { enabled: Boolean($event) })" />
      <div class="kv-key" :style="{ width: keyWidth }">
        <el-input
          :model-value="row.key"
          :placeholder="keyPlaceholder"
          size="small"
          @update:model-value="update(row.id, { key: String($event ?? '') })"
        />
      </div>
      <el-input
        class="kv-value"
        :model-value="row.value"
        :placeholder="valuePlaceholder"
        size="small"
        @update:model-value="update(row.id, { value: String($event ?? '') })"
      />
      <el-button text size="small" :icon="Delete" class="kv-delete" @click="remove(row.id)" />
    </div>
    <el-button text type="primary" size="small" :icon="Plus" class="kv-add" @click="add">添加一项</el-button>
  </div>
</template>

<style scoped>
.kv-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kv-empty {
  padding: 10px 4px;
}

.kv-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.kv-key {
  flex: none;
}

.kv-value {
  flex: 1;
  min-width: 0;
}

.kv-delete {
  flex: none;
  color: var(--app-text-3);
}

.kv-delete:hover {
  color: #ef4444;
}

.kv-add {
  align-self: flex-start;
}
</style>
