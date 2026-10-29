<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  ArrowDown,
  CopyDocument,
  Document,
  Download,
  EditPen,
  Files,
  FolderOpened,
  View
} from '@element-plus/icons-vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import SegmentedControl from '../components/SegmentedControl.vue'
import { copyText } from '../utils/clipboard'


const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch {
        // 落到下面的转义分支
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(code)}</code></pre>`
  }
})

const DEFAULT_CONTENT = `# Markdown 编辑器

在这里写 Markdown，右侧实时预览。

## 功能

- 支持 **粗体**、*斜体*、~~删除线~~、\`行内代码\`
- 支持标题分级、引用、列表、表格
- 代码块支持语法高亮
- 可以打开本地 \`.md\` 文件编辑，或保存到本地

### 代码块示例

\`\`\`javascript
function hello(name) {
  return \`Hello, \${name}!\`
}
\`\`\`

> 提示：选中文本后点击工具栏按钮，会自动包裹或加前缀。

| 快捷键 | 说明 |
| --- | --- |
| Ctrl + S | 保存文件 |
| Tab | 插入两个空格 |
`

const VIEW_OPTIONS = [
  { label: '编辑', value: 'edit', icon: EditPen },
  { label: '分屏', value: 'split', icon: Files },
  { label: '预览', value: 'preview', icon: View }
]

const content = ref(DEFAULT_CONTENT)
const viewMode = ref('split')
const currentPath = ref('')
const syncScroll = ref(true)
const editorRef = ref<HTMLTextAreaElement | null>(null)
const previewRef = ref<HTMLElement | null>(null)

const rendered = computed(() => md.render(content.value))

const stats = computed(() => {
  const text = content.value
  const lines = text ? text.split('\n').length : 0
  const chars = text.replace(/\s/g, '').length
  const words = (text.match(/[\u4e00-\u9fa5]/g)?.length ?? 0) + (text.match(/[a-zA-Z0-9_]+/g)?.length ?? 0)
  return { lines, chars, words }
})

const fileName = computed(() => {
  if (!currentPath.value) return '未命名文档'
  return currentPath.value.split(/[\\/]/).pop() ?? currentPath.value
})

function replaceRange(start: number, end: number, text: string, selectStart: number, selectEnd: number): void {
  content.value = content.value.slice(0, start) + text + content.value.slice(end)
  void nextTick(() => {
    const el = editorRef.value
    if (!el) return
    el.focus()
    el.setSelectionRange(selectStart, selectEnd)
  })
}

function wrapSelection(before: string, after: string, placeholder: string): void {
  const el = editorRef.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  const selected = content.value.slice(start, end) || placeholder
  replaceRange(start, end, before + selected + after, start + before.length, start + before.length + selected.length)
}

function prefixLines(prefix: string): void {
  const el = editorRef.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  const lineStart = content.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const nextBreak = content.value.indexOf('\n', end)
  const lineEnd = nextBreak === -1 ? content.value.length : nextBreak
  const block = content.value.slice(lineStart, lineEnd)
  const replaced = block
    .split('\n')
    .map((line) => (line.trim() === '' ? line : `${prefix}${line}`))
    .join('\n')
  replaceRange(lineStart, lineEnd, replaced, lineStart, lineStart + replaced.length)
}

function insertBlock(text: string, cursorBack = 0): void {
  const el = editorRef.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  const prefix = start > 0 && content.value[start - 1] !== '\n' ? '\n\n' : ''
  const suffix = content.value[end] && content.value[end] !== '\n' ? '\n' : ''
  const inserted = `${prefix}${text}${suffix}`
  const cursor = start + prefix.length + text.length - cursorBack
  replaceRange(start, end, inserted, cursor, cursor)
}

function insertCodeBlock(): void {
  insertBlock('```javascript\n\n```', 4)
}

function insertTable(): void {
  insertBlock('| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |')
}

async function copyMarkdown(): Promise<void> {
  const ok = await copyText(content.value)
  if (ok) ElMessage.success('Markdown 已复制')
  else ElMessage.error('复制失败')
}

async function openFile(): Promise<void> {
  const pick = await window.api.dialog.openFile({
    title: '打开 Markdown 文件',
    filters: [
      { name: 'Markdown 文件', extensions: ['md', 'markdown', 'txt'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  })
  if (pick.canceled || !pick.filePath) return
  const read = await window.api.file.readText(pick.filePath)
  if (!read.ok) {
    ElMessage.error(read.error ?? '读取失败')
    return
  }
  content.value = read.content ?? ''
  currentPath.value = pick.filePath
  ElMessage.success(`已打开 ${pick.fileName ?? ''}`)
}

async function saveFile(forceNewPath = false): Promise<void> {
  let target = currentPath.value
  if (!target || forceNewPath) {
    const pick = await window.api.dialog.saveFile({
      title: '保存 Markdown 文件',
      defaultFileName: currentPath.value || 'untitled.md',
      filters: [{ name: 'Markdown 文件', extensions: ['md'] }]
    })
    if (pick.canceled || !pick.filePath) return
    target = pick.filePath
  }
  const write = await window.api.file.writeText(target, content.value)
  if (!write.ok) {
    ElMessage.error(write.error ?? '保存失败')
    return
  }
  currentPath.value = target
  ElMessage.success('已保存')
}

function clearDocument(): void {
  content.value = ''
  currentPath.value = ''
}

function onEditorScroll(): void {
  if (!syncScroll.value || viewMode.value !== 'split') return
  const editor = editorRef.value
  const preview = previewRef.value
  if (!editor || !preview) return
  const editorMax = editor.scrollHeight - editor.clientHeight
  const previewMax = preview.scrollHeight - preview.clientHeight
  if (editorMax <= 0 || previewMax <= 0) return
  preview.scrollTop = (editor.scrollTop / editorMax) * previewMax
}

function handleTab(event: KeyboardEvent): void {
  const el = editorRef.value
  if (!el) return
  event.preventDefault()
  const start = el.selectionStart
  const end = el.selectionEnd
  replaceRange(start, end, '  ', start + 2, start + 2)
}
</script>

<template>
  <div class="page">
    <div class="page-toolbar md-toolbar">
      <el-button size="small" :icon="FolderOpened" @click="openFile">打开</el-button>
      <el-button size="small" :icon="Document" @click="saveFile(false)">保存</el-button>
      <el-button size="small" :icon="Download" @click="saveFile(true)">另存为</el-button>

      <el-divider direction="vertical" />

      <el-dropdown
        trigger="click"
        @command="(level: string | number | object) => prefixLines('#'.repeat(Number(level)) + ' ')"
      >
        <el-button size="small" text>
          标题<el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item v-for="level in 6" :key="level" :command="level">
              H{{ level }} 标题
            </el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <el-button size="small" text class="fmt-btn" title="粗体" @click="wrapSelection('**', '**', '粗体文本')">
        <strong>B</strong>
      </el-button>
      <el-button size="small" text class="fmt-btn" title="斜体" @click="wrapSelection('*', '*', '斜体文本')">
        <em>I</em>
      </el-button>
      <el-button size="small" text class="fmt-btn" title="删除线" @click="wrapSelection('~~', '~~', '删除线')">
        <s>S</s>
      </el-button>
      <el-button size="small" text class="fmt-btn" title="行内代码" @click="wrapSelection('`', '`', 'code')">
        <span class="mono">&lt;/&gt;</span>
      </el-button>
      <el-button size="small" text @click="insertCodeBlock">代码块</el-button>
      <el-button size="small" text @click="prefixLines('> ')">引用</el-button>
      <el-button size="small" text @click="prefixLines('- ')">无序列表</el-button>
      <el-button size="small" text @click="prefixLines('1. ')">有序列表</el-button>
      <el-button size="small" text @click="wrapSelection('[', '](https://)', '链接文字')">链接</el-button>
      <el-button size="small" text @click="wrapSelection('![', '](图片地址)', '图片描述')">图片</el-button>
      <el-button size="small" text @click="insertTable">表格</el-button>
      <el-button size="small" text @click="insertBlock('---')">分割线</el-button>

      <div class="spacer" />
      <el-button size="small" text :icon="CopyDocument" @click="copyMarkdown">复制</el-button>
      <el-button size="small" text @click="clearDocument">清空</el-button>
      <SegmentedControl v-model="viewMode" :options="VIEW_OPTIONS" size="small" />
    </div>

    <div class="md-body">
      <section v-show="viewMode !== 'preview'" class="panel md-editor-panel">
        <div class="panel-header">
          <span class="panel-title">{{ fileName }}</span>
          <span class="spacer" />
          <span class="small muted">Markdown</span>
        </div>
        <div class="panel-body">
          <textarea
            ref="editorRef"
            v-model="content"
            class="md-textarea"
            spellcheck="false"
            placeholder="开始编写 Markdown…"
            @scroll="onEditorScroll"
            @keydown.tab.prevent="handleTab"
            @keydown.ctrl.s.prevent="saveFile(false)"
          />
        </div>
      </section>

      <section v-show="viewMode !== 'edit'" class="panel md-preview-panel">
        <div class="panel-header">
          <span class="panel-title">预览</span>
          <span class="spacer" />
          <el-checkbox v-if="viewMode === 'split'" v-model="syncScroll" size="small">同步滚动</el-checkbox>
        </div>
        <div ref="previewRef" class="panel-body md-preview-scroll">
          <article class="markdown-body" v-html="rendered" />
        </div>
      </section>
    </div>

    <div class="md-footer small muted">
      <span>{{ stats.lines }} 行</span>
      <span>{{ stats.chars }} 字符</span>
      <span>{{ stats.words }} 词</span>
      <span class="spacer" />
      <span class="mono">{{ currentPath || '尚未保存到文件' }}</span>
    </div>
  </div>
</template>

<style scoped>
.md-toolbar {
  gap: 2px;
}

.fmt-btn {
  min-width: 30px;
  padding: 0 6px;
}

.md-body {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: 12px;
}

.md-editor-panel,
.md-preview-panel {
  flex: 1;
  min-width: 0;
}

.md-textarea {
  width: 100%;
  height: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 14px 16px;
  background: transparent;
  color: var(--app-text);
  font-family: var(--app-mono);
  font-size: 13px;
  line-height: 1.75;
  tab-size: 2;
}

.md-preview-scroll {
  padding: 16px 20px 40px;
}

.md-footer {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: none;
  padding: 2px 4px 0;
}

/* ---------------------------- Markdown 排版 ---------------------------- */
.markdown-body {
  color: var(--app-text);
  font-size: 14px;
  line-height: 1.75;
  word-wrap: break-word;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4),
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  margin: 1.2em 0 0.6em;
  font-weight: 650;
  line-height: 1.3;
}

.markdown-body :deep(h1) {
  font-size: 1.8em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--app-border);
}

.markdown-body :deep(h2) {
  font-size: 1.45em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid var(--app-border);
}

.markdown-body :deep(h3) {
  font-size: 1.2em;
}

.markdown-body :deep(h4) {
  font-size: 1.05em;
}

.markdown-body :deep(p) {
  margin: 0.6em 0;
}

.markdown-body :deep(a) {
  color: var(--app-primary);
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 1.6em;
  margin: 0.6em 0;
}

.markdown-body :deep(li) {
  margin: 0.2em 0;
}

.markdown-body :deep(blockquote) {
  margin: 0.8em 0;
  padding: 6px 14px;
  border-left: 3px solid var(--app-primary);
  background: var(--app-panel-muted);
  border-radius: 0 6px 6px 0;
  color: var(--app-text-2);
}

.markdown-body :deep(blockquote p) {
  margin: 0.2em 0;
}

.markdown-body :deep(code) {
  font-family: var(--app-mono);
  font-size: 0.88em;
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
}

.markdown-body :deep(pre) {
  margin: 0.8em 0;
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
  overflow: auto;
}

.markdown-body :deep(pre code) {
  padding: 0;
  border: none;
  background: transparent;
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre;
}

.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 0.8em 0;
  width: 100%;
  font-size: 13px;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--app-border);
  padding: 6px 10px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: var(--app-panel-muted);
  font-weight: 600;
}

.markdown-body :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}

.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--app-border);
  margin: 1.4em 0;
}

/* 代码高亮（自定义配色，跟随主题） */
.markdown-body :deep(.hljs-comment),
.markdown-body :deep(.hljs-quote) {
  color: #8b949e;
  font-style: italic;
}

.markdown-body :deep(.hljs-keyword),
.markdown-body :deep(.hljs-selector-tag),
.markdown-body :deep(.hljs-literal) {
  color: #c026d3;
}

.markdown-body :deep(.hljs-string),
.markdown-body :deep(.hljs-regexp),
.markdown-body :deep(.hljs-addition) {
  color: #117a45;
}

.markdown-body :deep(.hljs-number),
.markdown-body :deep(.hljs-symbol) {
  color: #b45309;
}

.markdown-body :deep(.hljs-title),
.markdown-body :deep(.hljs-section),
.markdown-body :deep(.hljs-name) {
  color: #1a56b3;
  font-weight: 600;
}

.markdown-body :deep(.hljs-attr),
.markdown-body :deep(.hljs-attribute),
.markdown-body :deep(.hljs-variable) {
  color: #7c3aed;
}

.markdown-body :deep(.hljs-built_in),
.markdown-body :deep(.hljs-type) {
  color: #0e7490;
}

html.dark .markdown-body :deep(.hljs-string),
html.dark .markdown-body :deep(.hljs-regexp) {
  color: #7ec699;
}

html.dark .markdown-body :deep(.hljs-number),
html.dark .markdown-body :deep(.hljs-symbol) {
  color: #f0a35e;
}

html.dark .markdown-body :deep(.hljs-title),
html.dark .markdown-body :deep(.hljs-section),
html.dark .markdown-body :deep(.hljs-name) {
  color: #7aa2f7;
}

html.dark .markdown-body :deep(.hljs-built_in),
html.dark .markdown-body :deep(.hljs-type) {
  color: #56b6c2;
}
</style>
