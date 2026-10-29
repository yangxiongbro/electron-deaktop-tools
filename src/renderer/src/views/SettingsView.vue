<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { FolderOpened, Moon, Sunny } from '@element-plus/icons-vue'
import type { AppInfo, ThemeMode } from '@shared/types'
import { setDownloadDir, setSidebarCollapsed, setTheme, useSettings } from '../stores/settings'

const { settings } = useSettings()
const info = ref<AppInfo | null>(null)

async function chooseDir(): Promise<void> {
  const result = await window.api.settings.chooseDownloadDir()
  if (result.canceled || !result.dirPath) return
  await setDownloadDir(result.dirPath)
  ElMessage.success('默认下载目录已更新')
}

async function openDir(): Promise<void> {
  if (!settings.downloadDir) return
  const error = await window.api.app.openPath(settings.downloadDir)
  if (error) ElMessage.error(`无法打开目录：${error}`)
}

async function openConfigDir(): Promise<void> {
  if (!info.value) return
  const error = await window.api.app.openPath(info.value.configDir)
  if (error) ElMessage.error(`无法打开目录：${error}`)
}

function applyTheme(theme: ThemeMode): void {
  void setTheme(theme)
}

function toggleCollapsed(value: boolean): void {
  void setSidebarCollapsed(value)
}

onMounted(async () => {
  try {
    info.value = await window.api.app.info()
  } catch {
    info.value = null
  }
})
</script>

<template>
  <div class="page settings-page">
    <div class="settings-scroll">
      <section class="card">
        <div class="card-title">外观</div>
        <div class="card-desc muted small">选择界面主题，切换后立即生效并自动保存。</div>
        <div class="theme-grid">
          <button class="theme-card" :class="{ active: settings.theme === 'light' }" @click="applyTheme('light')">
            <div class="theme-preview light">
              <span class="bar" />
              <span class="line" />
              <span class="line short" />
            </div>
            <div class="theme-name">
              <el-icon><Sunny /></el-icon>
              <span>亮色主题</span>
            </div>
          </button>
          <button class="theme-card" :class="{ active: settings.theme === 'dark' }" @click="applyTheme('dark')">
            <div class="theme-preview dark">
              <span class="bar" />
              <span class="line" />
              <span class="line short" />
            </div>
            <div class="theme-name">
              <el-icon><Moon /></el-icon>
              <span>暗色主题</span>
            </div>
          </button>
        </div>

        <div class="setting-row">
          <div>
            <div class="row-title">折叠侧边栏</div>
            <div class="row-desc muted small">折叠后只显示图标，鼠标悬停可查看工具名称。</div>
          </div>
          <el-switch :model-value="settings.sidebarCollapsed" @update:model-value="toggleCollapsed(Boolean($event))" />
        </div>
      </section>

      <section class="card">
        <div class="card-title">文件下载</div>
        <div class="card-desc muted small">
          API 响应、导出的格式化 JSON 等文件默认保存到该目录。
        </div>
        <div class="dir-row">
          <el-input :model-value="settings.downloadDir" readonly placeholder="尚未设置默认目录" />
          <el-button :icon="FolderOpened" @click="chooseDir">选择目录</el-button>
          <el-button :icon="FolderOpened" :disabled="!settings.downloadDir" @click="openDir">打开</el-button>
        </div>
      </section>

      <section class="card">
        <div class="card-title">关于</div>
        <div class="about-grid">
          <div class="about-item">
            <span class="about-label">应用版本</span>
            <span class="about-value mono">v{{ info?.version ?? '1.0.1' }}</span>
          </div>
          <div class="about-item">
            <span class="about-label">Electron</span>
            <span class="about-value mono">{{ info?.electron ?? '-' }}</span>
          </div>
          <div class="about-item">
            <span class="about-label">Chromium</span>
            <span class="about-value mono">{{ info?.chrome ?? '-' }}</span>
          </div>
          <div class="about-item">
            <span class="about-label">Node.js</span>
            <span class="about-value mono">{{ info?.node ?? '-' }}</span>
          </div>
          <div class="about-item">
            <span class="about-label">运行平台</span>
            <span class="about-value mono">{{ info?.platform ?? '-' }} / {{ info?.arch ?? '-' }}</span>
          </div>
          <div class="about-item">
            <span class="about-label">默认下载目录</span>
            <span class="about-value mono wrap">{{ info?.defaultDownloadDir ?? '-' }}</span>
          </div>
        </div>

        <div class="dir-row">
          <el-input :model-value="info?.settingsFile ?? ''" readonly />
          <el-button :icon="FolderOpened" :disabled="!info" @click="openConfigDir">打开配置目录</el-button>
        </div>

        <div class="about-note muted small">
          配置文件（settings.json）与请求历史（api-history.json）默认保存在<strong>安装目录</strong>；若安装目录不可写（如安装到
          Program Files），会自动改用用户数据目录。
        </div>

        <div class="about-note muted small">
          所有数据都在本地处理，不会上传到任何服务器。支持打包为 Windows（x86 / x64 / ARM64）与
          Linux（x64 / ARM64 / ARMv7l）应用。
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  overflow: hidden;
}

.settings-scroll {
  height: 100%;
  overflow: auto;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 920px;
}

.card {
  background: var(--app-panel);
  border: 1px solid var(--app-border);
  border-radius: 10px;
  padding: 18px 20px;
  box-shadow: var(--app-shadow);
}

.card-title {
  font-size: 14px;
  font-weight: 650;
  margin-bottom: 4px;
}

.card-desc {
  margin-bottom: 14px;
}

.theme-grid {
  display: flex;
  gap: 14px;
  margin-bottom: 18px;
}

.theme-card {
  flex: 1;
  max-width: 260px;
  padding: 10px;
  border: 1.5px solid var(--app-border);
  border-radius: 10px;
  background: var(--app-panel);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.theme-card:hover {
  border-color: var(--app-border-strong);
}

.theme-card.active {
  border-color: var(--app-primary);
  box-shadow: 0 0 0 3px var(--app-primary-soft);
}

.theme-preview {
  height: 76px;
  border-radius: 7px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  position: relative;
  overflow: hidden;
}

.theme-preview.light {
  background: #f2f4f8;
  border: 1px solid #e3e6eb;
}

.theme-preview.dark {
  background: #16181c;
  border: 1px solid #2e333b;
}

.theme-preview .bar {
  width: 26%;
  height: 100%;
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
}

.theme-preview.light .bar {
  background: #ffffff;
  border-right: 1px solid #e3e6eb;
}

.theme-preview.dark .bar {
  background: #1a1d21;
  border-right: 1px solid #2e333b;
}

.theme-preview .line {
  margin-left: 32%;
  height: 9px;
  border-radius: 4px;
}

.theme-preview .line.short {
  width: 40%;
}

.theme-preview.light .line {
  background: #d9dee8;
}

.theme-preview.dark .line {
  background: #333a44;
}

.theme-name {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 9px;
  font-size: 13px;
  color: var(--app-text);
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 6px;
  border-top: 1px solid var(--app-border);
}

.row-title {
  font-size: 13.5px;
  margin-bottom: 2px;
}

.dir-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}

.about-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 24px;
  margin: 12px 0;
}

.about-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

.about-label {
  color: var(--app-text-3);
  font-size: 12px;
}

.about-value.wrap {
  word-break: break-all;
}

.about-note {
  margin-top: 14px;
  line-height: 1.7;
  padding-top: 12px;
  border-top: 1px dashed var(--app-border);
}
</style>
