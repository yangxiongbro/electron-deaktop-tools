import type { Component } from 'vue'
import {
  DataLine,
  Switch,
  Key,
  Promotion,
  EditPen,
  Setting
} from '@element-plus/icons-vue'
import JsonFormatter from './views/JsonFormatter.vue'
import NamingConverter from './views/NamingConverter.vue'
import CodecTool from './views/CodecTool.vue'
import ApiClient from './views/ApiClient.vue'
import MarkdownEditor from './views/MarkdownEditor.vue'
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
    description: '编辑与预览 Markdown，支持标题、代码块等快捷插入',
    icon: EditPen,
    component: MarkdownEditor
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
