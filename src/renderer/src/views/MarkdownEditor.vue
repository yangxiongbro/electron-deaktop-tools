<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { ElMessage } from 'element-plus'
import {
  ArrowDown,
  ArrowLeft,
  CaretBottom,
  CaretRight,
  CopyDocument,
  Document,
  Download,
  EditPen,
  Expand,
  Files,
  Fold,
  FolderOpened,
  Grid,
  Link,
  List,
  Minus,
  Picture,
  Tickets,
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

/** 代码块下拉可选的常用语言 */
const CODE_LANGS: { label: string; value: string }[] = [
  { label: 'JavaScript', value: 'javascript' },
  { label: 'TypeScript', value: 'typescript' },
  { label: 'Python', value: 'python' },
  { label: 'Java', value: 'java' },
  { label: 'Go', value: 'go' },
  { label: 'Rust', value: 'rust' },
  { label: 'C / C++', value: 'cpp' },
  { label: 'C#', value: 'csharp' },
  { label: 'PHP', value: 'php' },
  { label: 'Ruby', value: 'ruby' },
  { label: 'SQL', value: 'sql' },
  { label: 'Shell', value: 'bash' },
  { label: 'JSON', value: 'json' },
  { label: 'YAML', value: 'yaml' },
  { label: 'HTML', value: 'html' },
  { label: 'CSS', value: 'css' },
  { label: 'XML', value: 'xml' },
  { label: '纯文本', value: 'text' }
]

const content = ref(DEFAULT_CONTENT)
const viewMode = ref('split')
const currentPath = ref('')
const syncScroll = ref(true)
/** 工具栏（插入菜单）是否折叠，给编辑区腾出更多空间 */
const toolbarCollapsed = ref(false)
const editorRef = ref<HTMLTextAreaElement | null>(null)
const previewRef = ref<HTMLElement | null>(null)

/**
 * 预览里的标题锚点序号。
 * 每渲染一次都从 0 开始，目录项与标题按同一顺序编号，点击即可精确定位。
 */
let headingSeq = 0

md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet('id', `md-heading-${headingSeq}`)
  headingSeq += 1
  return self.renderToken(tokens, idx, options)
}

const rendered = computed(() => {
  headingSeq = 0
  return md.render(content.value)
})

interface OutlineNode {
  index: number
  level: number
  text: string
  children: OutlineNode[]
}

/** 预览模式下左侧的文档目录：由标题生成，并按层级组成树 */
const outlineTree = computed<OutlineNode[]>(() => {
  const tokens = md.parse(content.value, {})
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  let index = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.type !== 'heading_open') continue
    const inline = tokens[i + 1]
    const text = (inline?.content ?? '')
      .replace(/[*_`~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const node: OutlineNode = {
      index,
      level: Number(token.tag.slice(1)) || 1,
      text: text || '未命名标题',
      children: []
    }
    // 回到比当前标题更高的层级，再挂到父节点下
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop()
    if (stack.length) stack[stack.length - 1].children.push(node)
    else roots.push(node)
    stack.push(node)
    index += 1
  }
  return roots
})

function countNodes(nodes: OutlineNode[]): number {
  let total = 0
  for (const node of nodes) total += 1 + countNodes(node.children)
  return total
}

const outlineCount = computed(() => countNodes(outlineTree.value))

/** 目录侧边栏是否收起成窄条 */
const outlineCollapsed = ref(false)
/** 被折叠的标题（记录标题序号；编辑后序号可能偏移，属于可接受的取舍） */
const collapsedHeadings = ref<number[]>([])

interface OutlineRow extends OutlineNode {
  depth: number
  hasChildren: boolean
  collapsed: boolean
}

/** 按折叠状态把树摊平成可渲染的行 */
const outlineRows = computed<OutlineRow[]>(() => {
  const rows: OutlineRow[] = []
  const walk = (nodes: OutlineNode[], depth: number): void => {
    for (const node of nodes) {
      const collapsed = collapsedHeadings.value.includes(node.index)
      rows.push({ ...node, depth, hasChildren: node.children.length > 0, collapsed })
      if (!collapsed) walk(node.children, depth + 1)
    }
  }
  walk(outlineTree.value, 0)
  return rows
})

/** 有子标题的节点序号，用于「全部折叠 / 全部展开」 */
const collapsibleIndexes = computed<number[]>(() => {
  const indexes: number[] = []
  const walk = (nodes: OutlineNode[]): void => {
    for (const node of nodes) {
      if (node.children.length) indexes.push(node.index)
      walk(node.children)
    }
  }
  walk(outlineTree.value)
  return indexes
})

const allHeadingsCollapsed = computed(
  () =>
    collapsibleIndexes.value.length > 0 &&
    collapsibleIndexes.value.every((index) => collapsedHeadings.value.includes(index))
)

function toggleHeading(index: number): void {
  const set = new Set(collapsedHeadings.value)
  if (set.has(index)) set.delete(index)
  else set.add(index)
  collapsedHeadings.value = [...set]
}

function toggleAllHeadings(): void {
  collapsedHeadings.value = allHeadingsCollapsed.value ? [] : [...collapsibleIndexes.value]
}

/** 滚动到指定标题 */
function scrollToHeading(index: number): void {
  const host = previewRef.value
  if (!host) return
  const target = host.querySelector<HTMLElement>(`#md-heading-${index}`)
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

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

function insertCodeBlock(lang: string): void {
  insertBlock('```' + lang + '\n\n```', 4)
}

function insertTable(): void {
  insertBlock('| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |')
}

/** 「插入」下拉菜单里的常用片段 */
function onInsertCommand(command: string | number | object): void {
  switch (String(command)) {
    case 'ul':
      prefixLines('- ')
      break
    case 'ol':
      prefixLines('1. ')
      break
    case 'link':
      wrapSelection('[', '](https://)', '链接文字')
      break
    case 'image':
      wrapSelection('![', '](图片地址)', '图片描述')
      break
    case 'table':
      insertTable()
      break
    case 'divider':
      insertBlock('---')
      break
    default:
      break
  }
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

/**
 * 分屏模式下的同步滚动（双向）。
 *
 * 以前只实现了「编辑区 → 预览区」，滚动右侧预览时左边不动，看起来像同步滚动没生效。
 * 现在两边互相驱动；用 `programmaticScroll` 记住「这个位置是我自己写进去的」，
 * 对应元素随后抛出的 scroll 事件直接忽略，避免两端互相拉扯或抖动。
 */
let programmaticScroll: { target: 'editor' | 'preview'; value: number } | null = null

function syncScrollBetween(source: 'editor' | 'preview'): void {
  if (!syncScroll.value || viewMode.value !== 'split') return
  const editor = editorRef.value
  const preview = previewRef.value
  if (!editor || !preview) return

  const element = source === 'editor' ? editor : preview
  if (
    programmaticScroll &&
    programmaticScroll.target === source &&
    Math.abs(element.scrollTop - programmaticScroll.value) <= 1
  ) {
    // 自己刚写进去的位置触发的事件，不处理
    programmaticScroll = null
    return
  }
  programmaticScroll = null

  const editorMax = editor.scrollHeight - editor.clientHeight
  const previewMax = preview.scrollHeight - preview.clientHeight
  if (editorMax <= 0 || previewMax <= 0) return

  if (source === 'editor') {
    const value = (editor.scrollTop / editorMax) * previewMax
    programmaticScroll = { target: 'preview', value }
    preview.scrollTop = value
  } else {
    const value = (preview.scrollTop / previewMax) * editorMax
    programmaticScroll = { target: 'editor', value }
    editor.scrollTop = value
  }
}

function onEditorScroll(): void {
  syncScrollBetween('editor')
}

function onPreviewScroll(): void {
  syncScrollBetween('preview')
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
      <SegmentedControl v-model="viewMode" :options="VIEW_OPTIONS" size="small" />
      <el-divider direction="vertical" />

      <el-tooltip :content="toolbarCollapsed ? '展开工具栏' : '折叠工具栏'" placement="bottom">
        <el-button
          size="small"
          class="collapse-btn"
          :icon="toolbarCollapsed ? Expand : Fold"
          @click="toolbarCollapsed = !toolbarCollapsed"
        />
      </el-tooltip>

      <el-button size="small" :icon="FolderOpened" @click="openFile">打开</el-button>
      <el-button size="small" :icon="Document" @click="saveFile(false)">保存</el-button>
      <el-button size="small" :icon="Download" @click="saveFile(true)">另存为</el-button>

      <template v-if="!toolbarCollapsed">
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

        <el-dropdown
          trigger="click"
          @command="(lang: string | number | object) => insertCodeBlock(String(lang))"
        >
          <el-button size="small" text>
            代码块<el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="lang in CODE_LANGS" :key="lang.value" :command="lang.value">
                {{ lang.label }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <el-button size="small" text @click="prefixLines('> ')">引用</el-button>

        <el-dropdown trigger="click" @command="onInsertCommand">
          <el-button size="small" text>
            插入<el-icon class="el-icon--right"><ArrowDown /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="ul" :icon="List">无序列表</el-dropdown-item>
              <el-dropdown-item command="ol" :icon="Tickets">有序列表</el-dropdown-item>
              <el-dropdown-item command="link" :icon="Link" divided>链接</el-dropdown-item>
              <el-dropdown-item command="image" :icon="Picture">图片</el-dropdown-item>
              <el-dropdown-item command="table" :icon="Grid" divided>表格</el-dropdown-item>
              <el-dropdown-item command="divider" :icon="Minus">分割线</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <div class="spacer" />
        <el-button size="small" text :icon="CopyDocument" @click="copyMarkdown">复制</el-button>
        <el-button size="small" text @click="clearDocument">清空</el-button>
      </template>

      <template v-else>
        <span class="spacer" />
        <span class="small muted">{{ stats.lines }} 行 · {{ stats.chars }} 字符 · {{ stats.words }} 词</span>
      </template>
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
        <div class="md-preview-body">
          <aside v-if="viewMode === 'preview'" class="md-outline" :class="{ collapsed: outlineCollapsed }">
            <div
              v-if="outlineCollapsed"
              class="outline-rail"
              role="button"
              tabindex="0"
              title="展开目录"
              @click="outlineCollapsed = false"
              @keydown.enter.prevent="outlineCollapsed = false"
            >
              <el-icon :size="14"><Expand /></el-icon>
              <span class="rail-text">目录</span>
            </div>

            <template v-else>
              <div class="outline-head">
                <el-icon :size="13"><List /></el-icon>
                <span>目录</span>
                <span class="outline-count">{{ outlineCount }}</span>
                <span class="spacer" />
                <el-tooltip
                  :content="allHeadingsCollapsed ? '全部展开' : '全部折叠'"
                  placement="bottom"
                  :show-after="150"
                >
                  <button class="outline-action" type="button" @click="toggleAllHeadings">
                    <el-icon :size="13">
                      <Expand v-if="allHeadingsCollapsed" />
                      <Fold v-else />
                    </el-icon>
                  </button>
                </el-tooltip>
                <el-tooltip content="收起目录" placement="bottom" :show-after="150">
                  <button class="outline-action" type="button" @click="outlineCollapsed = true">
                    <el-icon :size="13"><ArrowLeft /></el-icon>
                  </button>
                </el-tooltip>
              </div>

              <div class="outline-list">
                <div
                  v-for="item in outlineRows"
                  :key="item.index"
                  class="outline-row"
                  :style="{ paddingLeft: `${6 + item.depth * 12}px` }"
                >
                  <button
                    v-if="item.hasChildren"
                    class="outline-caret"
                    type="button"
                    :title="item.collapsed ? '展开子标题' : '折叠子标题'"
                    @click.stop="toggleHeading(item.index)"
                  >
                    <el-icon :size="11">
                      <CaretRight v-if="item.collapsed" />
                      <CaretBottom v-else />
                    </el-icon>
                  </button>
                  <span v-else class="outline-caret placeholder" />
                  <button
                    type="button"
                    class="outline-item"
                    :class="`lv-${item.level}`"
                    :title="item.text"
                    @click="scrollToHeading(item.index)"
                  >
                    {{ item.text }}
                  </button>
                </div>
                <div v-if="!outlineRows.length" class="outline-empty">文档中还没有标题</div>
              </div>
            </template>
          </aside>
          <div ref="previewRef" class="panel-body md-preview-scroll" @scroll="onPreviewScroll">
            <article class="markdown-body" v-html="rendered" />
          </div>
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

.collapse-btn {
  flex: none;
  padding: 0 7px;
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

.md-preview-body {
  flex: 1;
  min-height: 0;
  display: flex;
  min-width: 0;
}

/* 预览模式下的目录侧边栏（可收起成窄条） */
.md-outline {
  width: 210px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--app-border);
  background: var(--app-panel-muted);
  transition: width 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.md-outline.collapsed {
  width: 34px;
}

.outline-rail {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  color: var(--app-text-3);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.outline-rail:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.rail-text {
  writing-mode: vertical-rl;
  font-size: 11.5px;
  letter-spacing: 3px;
}

.outline-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--app-text-2);
  border-bottom: 1px solid var(--app-border);
}

.outline-count {
  margin-left: 2px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--app-primary-soft);
  color: var(--app-primary);
  font-size: 11px;
  font-weight: 600;
  line-height: 16px;
}

.outline-action {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--app-text-3);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.outline-action:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.outline-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 6px 16px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.outline-row {
  display: flex;
  align-items: center;
  gap: 1px;
  min-width: 0;
}

.outline-caret {
  flex: none;
  width: 14px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--app-text-3);
  cursor: pointer;
}

.outline-caret:hover {
  color: var(--app-primary);
}

.outline-caret.placeholder {
  visibility: hidden;
}

.outline-item {
  flex: 1;
  min-width: 0;
  display: block;
  padding: 3px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-2);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: background 0.15s ease, color 0.15s ease;
}

.outline-item:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.outline-item.lv-1 {
  font-weight: 650;
  color: var(--app-text);
}

.outline-item.lv-2 {
  font-weight: 500;
}

.outline-item.lv-4,
.outline-item.lv-5,
.outline-item.lv-6 {
  color: var(--app-text-3);
}

.outline-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--app-text-3);
}

.md-textarea {
  display: block;
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

/*
 * 编辑区只让 textarea 自己滚动。
 * textarea 是行内元素，height:100% 会留下行盒的基线间距，导致外层 .panel-body
 * 也跟着出现一条滚动条（长内容时就是两条上下叠着的滚动条）。
 */
.md-editor-panel .panel-body {
  overflow: hidden;
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
