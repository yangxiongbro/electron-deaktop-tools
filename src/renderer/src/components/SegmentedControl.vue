<script setup lang="ts">
import type { SegmentOption } from './segment'

withDefaults(
  defineProps<{
    modelValue: string
    options: SegmentOption[]
    size?: 'small' | 'default'
  }>(),
  { size: 'default' }
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void
}>()
</script>

<template>
  <div class="segmented" :class="size">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="segmented-item"
      :class="{ active: modelValue === option.value }"
      @click="emit('update:modelValue', option.value)"
    >
      <el-icon v-if="option.icon" :size="14">
        <component :is="option.icon" />
      </el-icon>
      <span>{{ option.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
}

.segmented-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 12px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-2);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
}

.segmented-item:hover {
  color: var(--app-text);
}

.segmented-item.active {
  background: var(--app-panel);
  color: var(--app-primary);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(16, 24, 40, 0.12);
}

.segmented.small .segmented-item {
  height: 22px;
  padding: 0 9px;
  font-size: 12px;
}
</style>
