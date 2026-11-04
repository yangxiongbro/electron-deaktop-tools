import type { Component } from 'vue'
import {
  ChatDotRound,
  DataLine,
  Switch,
  Key,
  Promotion,
  EditPen,
  Timer,
  Setting
} from '@element-plus/icons-vue'
import JsonFormatter from './views/JsonFormatter.vue'
import NamingConverter from './views/NamingConverter.vue'
import CodecTool from './views/CodecTool.vue'
import ApiClient from './views/ApiClient.vue'
import MarkdownEditor from './views/MarkdownEditor.vue'
import CronGenerator from './views/CronGenerator.vue'
import LocalChat from './views/LocalChat.vue'
import SettingsView from './views/SettingsView.vue'

export interface ToolMeta {
  id: string
  name: string
  description: string
  icon: Component
  component: Component
}

export const TOOLS: ToolMeta[] = [
  {
    id: 'json',
    name: 'JSON 格式化',
    description: '校验、格式化、折叠查看 JSON，支持超大文件流式处理',
    icon: DataLine,
    component: JsonFormatter
  },
  {
    id: 'naming',
    name: '命名规范转换',
    description: '下划线、驼峰、中划线等常见命名格式互相转换',
    icon: Switch,
    component: NamingConverter
  },
  {
    id: 'codec',
    name: '编码 / 解码',
    description: 'URL、Base64、MD5、SHA、HTML、Unicode、Hex、JWT 常用编解码',
    icon: Key,
    component: CodecTool
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
    id: 'cron',
    name: 'Cron 生成器',
    description: '按字段选择时间生成 Quartz / Spring / Linux / Node 表达式，并推算最近运行时间',
    icon: Timer,
    component: CronGenerator
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
