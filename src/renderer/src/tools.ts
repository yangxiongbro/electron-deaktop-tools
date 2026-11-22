import type { Component } from 'vue'
import {
  ChatDotRound,
  Coin,
  Connection,
  Files,
  Promotion,
  EditPen,
  Timer,
  Setting,
  Switch,
  Key,
  Operation,
  DataLine
} from '@element-plus/icons-vue'
import TextWorkbench from './views/TextWorkbench.vue'
import SqlTool from './views/SqlTool.vue'
import ApiClient from './views/ApiClient.vue'
import MarkdownEditor from './views/MarkdownEditor.vue'
import CronGenerator from './views/CronGenerator.vue'
import LocalChat from './views/LocalChat.vue'
import FileSync from './views/FileSync.vue'
import SettingsView from './views/SettingsView.vue'

export interface ToolMeta {
  id: string
  name: string
  description: string
  icon: Component
  component: Component
  /** 文本类工具里的子工具（用于旧版 lastToolId 迁移到对应标签页） */
  tab?: string
}

export const TOOLS: ToolMeta[] = [
  {
    id: 'text-workbench',
    name: '文本类工具',
    description: 'JSON 格式化、命名转换、编码解码、字符处理，一页 TAB 切换',
    icon: Files,
    component: TextWorkbench
  },
  {
    id: 'sql',
    name: 'SQL 工具',
    description: 'SQL 格式化、压缩、去注释，以及 MyBatis 参数填充',
    icon: Coin,
    component: SqlTool
  },
  {
    id: 'cron',
    name: 'Cron 生成器',
    description: '按字段选择时间生成 Quartz / Spring / Linux / Node 表达式，并推算最近运行时间',
    icon: Timer,
    component: CronGenerator
  },
  {
    id: 'api',
    name: 'API 请求',
    description: '按项目管理请求记录，支持鉴权、请求头、form-data 上传与响应保存',
    icon: Promotion,
    component: ApiClient
  },
  {
    id: 'markdown',
    name: 'Markdown 编辑器',
    description: '编辑与预览 Markdown，支持标题、代码块等快捷插入与语法速查',
    icon: EditPen,
    component: MarkdownEditor
  },
  {
    id: 'sync',
    name: '文件同步',
    description: '局域网 / WiFi 内把同步文件夹的变化实时推送到手机等多个设备',
    icon: Connection,
    component: FileSync
  },
  {
    id: 'chat',
    name: '本地聊天',
    description: '局域网内点对点聊天，支持文字、图片、文件、表情与聊天记录搜索',
    icon: ChatDotRound,
    component: LocalChat
  },
  {
    id: 'settings',
    name: '应用设置',
    description: '切换主题、设置文件下载默认目录',
    icon: Setting,
    component: SettingsView
  }
]

export const TOOL_SETTINGS_ID = 'settings'

/** 文本类工具里各个 TAB 的元信息（侧边栏右侧说明、旧 id 迁移都用它） */
export const WORKBENCH_TABS: Record<string, { name: string; description: string; icon: Component }> = {
  json: { name: 'JSON 格式化', description: '校验、格式化、折叠查看 JSON，支持超大文件流式处理', icon: DataLine },
  naming: { name: '命名规范转换', description: '下划线、驼峰、中划线等命名风格互转，支持整文件处理', icon: Switch },
  codec: { name: '编码 / 解码', description: 'URL、Base64、哈希、HTML、Unicode、Hex、JWT 与对称加密', icon: Key },
  text: { name: '字符处理', description: '去空行、去重、排序、大小写等整文件或整段文本处理', icon: Operation }
}

/**
 * 旧版本每个工具是独立入口，升级后合并成 `text-workbench` 一个页面。
 * 这里把旧的 id 映射成「工具箱 + 对应 TAB」，老用户的 lastToolId 不会失效。
 */
export const LEGACY_TOOL_TABS: Record<string, string> = {
  json: 'json',
  naming: 'naming',
  codec: 'codec',
  text: 'text'
}

export function resolveToolId(id: string): { toolId: string; tab?: string } {
  if (LEGACY_TOOL_TABS[id]) return { toolId: 'text-workbench', tab: LEGACY_TOOL_TABS[id] }
  return { toolId: id }
}
