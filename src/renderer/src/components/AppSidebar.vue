<script setup lang="ts">
import { Fold, Expand } from '@element-plus/icons-vue'
import type { ToolMeta } from '../tools'

defineProps<{
  tools: ToolMeta[]
  currentId: string
  collapsed: boolean
  version?: string
}>()

const emit = defineEmits<{
  (event: 'select', id: string): void
  (event: 'toggle'): void
}>()
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="brand">
      <div class="brand-logo">DT</div>
      <transition name="fade">
        <div v-if="!collapsed" class="brand-text">
          <span class="brand-name">DevToolbox</span>
          <span class="brand-sub">开发工具箱</span>
        </div>
      </transition>
      <button class="collapse-btn" :title="collapsed ? '展开侧边栏' : '折叠侧边栏'" @click="emit('toggle')">
        <el-icon :size="16">
          <Expand v-if="collapsed" />
          <Fold v-else />
        </el-icon>
      </button>
    </div>

    <nav class="nav">
      <el-tooltip
        v-for="tool in tools"
        :key="tool.id"
        :content="tool.name"
        placement="right"
        :disabled="!collapsed"
        :show-after="120"
      >
        <button
          class="nav-item"
          :class="{ active: currentId === tool.id }"
          :title="collapsed ? tool.name : undefined"
          @click="emit('select', tool.id)"
        >
          <el-icon class="nav-icon" :size="17">
            <component :is="tool.icon" />
          </el-icon>
          <span v-if="!collapsed" class="nav-label">{{ tool.name }}</span>
        </button>
      </el-tooltip>
    </nav>

    <div class="nav-footer">
      <div v-if="!collapsed" class="footer-hint">
        <span class="dot" />
        <span>本地运行 · 数据不出设备</span>
      </div>
      <div v-if="!collapsed && version" class="footer-version">v{{ version }}</div>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--app-sidebar);
  border-right: 1px solid var(--app-border);
  transition: width 0.22s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.sidebar.collapsed {
  width: var(--sidebar-width-collapsed);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 12px;
  height: 64px;
  flex: none;
  border-bottom: 1px solid var(--app-border);
}

.brand-logo {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: -0.5px;
  color: #fff;
  background: linear-gradient(135deg, #4f8cff, #2f6fed 55%, #6f5bff);
  box-shadow: 0 2px 6px rgba(47, 111, 237, 0.35);
}

.brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.2;
}

.brand-name {
  font-size: 14px;
  font-weight: 650;
  color: var(--app-text);
  white-space: nowrap;
}

.brand-sub {
  font-size: 11px;
  color: var(--app-text-3);
  white-space: nowrap;
}

.collapse-btn {
  margin-left: auto;
  width: 28px;
  height: 28px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--app-text-3);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.collapse-btn:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.sidebar.collapsed .brand {
  flex-direction: column;
  height: auto;
  padding: 10px 0 8px;
  gap: 6px;
}

.sidebar.collapsed .collapse-btn {
  margin-left: 0;
  background: transparent;
}

.nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 40px;
  padding: 0 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text-2);
  font-size: 13.5px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}

.nav-item:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.nav-item.active {
  background: var(--app-primary-soft);
  color: var(--app-primary);
  font-weight: 600;
}

.nav-icon {
  flex: none;
}

.sidebar.collapsed .nav-item {
  justify-content: center;
  padding: 0;
  gap: 0;
}

.nav-footer {
  flex: none;
  padding: 10px 14px 14px;
  border-top: 1px solid var(--app-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.footer-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--app-text-3);
  white-space: nowrap;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.15);
}

.footer-version {
  font-size: 11px;
  color: var(--app-text-3);
  opacity: 0.8;
}
</style>
