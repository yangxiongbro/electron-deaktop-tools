<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Moon, Sunny } from '@element-plus/icons-vue'
import AppSidebar from './components/AppSidebar.vue'
import { TOOLS, TOOL_SETTINGS_ID, resolveToolId } from './tools'
import { setLastTool, setSidebarCollapsed, setTheme, useSettings } from './stores/settings'
const { settings } = useSettings()

const currentId = ref('json')

/** Windows 上用了自定义标题栏，右上角要给系统窗口按钮留出位置 */
const isWindowsCustomTitleBar = window.api.platform === 'win32'

const currentTool = computed(() => TOOLS.find((tool) => tool.id === currentId.value) ?? TOOLS[0])
const isDark = computed(() => settings.theme === 'dark')
/** 工具列表（不含设置）与设置项分开渲染：设置固定放在侧边栏底部 */
const toolList = computed(() => TOOLS.filter((tool) => tool.id !== TOOL_SETTINGS_ID))
const settingsTool = computed(() => TOOLS.find((tool) => tool.id === TOOL_SETTINGS_ID) ?? TOOLS[TOOLS.length - 1])

function selectTool(id: string): void {
  currentId.value = id
  void setLastTool(id)
}

function toggleTheme(): void {
  void setTheme(isDark.value ? 'light' : 'dark')
}

function toggleSidebar(): void {
  void setSidebarCollapsed(!settings.sidebarCollapsed)
}

onMounted(() => {
  // 旧版本的 json / naming / codec / text / sql 入口已合并到文本工具箱，这里做一次迁移
  const resolved = resolveToolId(settings.lastToolId)
  if (resolved.tab) {
    try {
      localStorage.setItem('devtoolbox.workbench.tab', resolved.tab)
    } catch {
      // 忽略 localStorage 不可用
    }
  }
  if (TOOLS.some((tool) => tool.id === resolved.toolId)) {
    currentId.value = resolved.toolId
  }

  window.__toolbox = {
    setTool: (id: string) => selectTool(id),
    setTheme: (theme: 'light' | 'dark') => {
      void setTheme(theme)
    },
    setCollapsed: (value: boolean) => {
      void setSidebarCollapsed(value)
    }
  }
})
</script>

<template>
  <div class="app-shell" :class="{ 'custom-titlebar': isWindowsCustomTitleBar }">
    <AppSidebar
      :tools="toolList"
      :settings-tool="settingsTool"
      :current-id="currentId"
      :collapsed="settings.sidebarCollapsed"
      @select="selectTool"
      @toggle="toggleSidebar"
    />

    <div class="app-main">
      <header class="app-header">
        <div class="title-block">
          <h1>{{ currentTool.name }}</h1>
          <div class="subtitle">{{ currentTool.description }}</div>
        </div>
        <div class="spacer" />
        <el-tooltip :content="isDark ? '切换到亮色主题' : '切换到暗色主题'" placement="bottom">
          <button class="icon-btn" @click="toggleTheme">
            <el-icon :size="17">
              <Sunny v-if="isDark" />
              <Moon v-else />
            </el-icon>
          </button>
        </el-tooltip>
      </header>

      <main class="app-content">
        <KeepAlive>
          <component :is="currentTool.component" :key="currentTool.id" />
        </KeepAlive>
      </main>
    </div>
  </div>
</template>

<style scoped>
.title-block {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
</style>
