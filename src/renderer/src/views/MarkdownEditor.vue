<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
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
  Reading,
  Search,
  Tickets,
  View
} from '@element-plus/icons-vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import MarkdownSyntaxDialog from '../components/MarkdownSyntaxDialog.vue'
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

/**
 * markdown-it 会把行首 1~3 个空格当作「缩进」直接吃掉，渲染出来就没有缩进了。
 * 这里先把这类行首空白换成不换行空格（U+00A0），让缩进作为正文内容保留下来：
 * - 制表符（从记事本等编辑器粘贴进来的内容常见）按 4 空格宽度展开；
 * - 代码块（``` / ~~~）里的内容原样保留；
 * - 依赖行首缩进的语法（列表、引用、标题、表格）不动；
 * - 空行之后 4 个空格以上的行属于缩进代码块，也不动。
 */
function preserveIndent(source: string): string {
  let inFence = false
  let prevBlank = true
  return source
    .split('\n')
    .map((line) => {
      const wasBlank = prevBlank
      prevBlank = line.trim() === ''
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const match = /^([ \t]+)(\S.*)$/.exec(line)
      if (!match) return line
      const rest = match[2]
      // 列表 / 引用 / 标题 / 表格 / 链接定义依赖行首缩进或符号，不要动
      if (/^([-*+]|\d+[.)]|>|\||#{1,6}\s|\[[^\]]+\]:)/.test(rest)) return line
      let width = 0
      for (const char of match[1]) width += char === '\t' ? 4 : 1
      if (width > 3 && wasBlank) return line
      return '\u00A0'.repeat(width) + rest
    })
    .join('\n')
}

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
/** Markdown 语法速查弹窗 */
const syntaxVisible = ref(false)
const editorRef = ref<HTMLTextAreaElement | null>(null)
const previewRef = ref<HTMLElement | null>(null)

/* --------------------------- 文件状态 / 冲突 --------------------------- */

/** 上一次保存（或打开）时的内容，用来判断有没有改动 */
const savedContent = ref(DEFAULT_CONTENT)
/** 文件最后修改时间，用来发现「被其它程序改过」 */
const fileMtime = ref(0)
const fileSize = ref(0)

const dirty = computed(() => content.value !== savedContent.value)

async function refreshFileStat(): Promise<void> {
  if (!currentPath.value) {
    fileMtime.value = 0
    fileSize.value = 0
    return
  }
  const stat = await window.api.file.stat(currentPath.value)
  fileMtime.value = stat.exists ? stat.mtimeMs : 0
  fileSize.value = stat.size
}

type ConflictAction = 'overwrite' | 'saveAs' | 'cancel'

const conflictVisible = ref(false)
let conflictResolver: ((action: ConflictAction) => void) | null = null

function askSaveConflict(): Promise<ConflictAction> {
  conflictVisible.value = true
  return new Promise((resolve) => {
    conflictResolver = resolve
  })
}

function resolveConflict(action: ConflictAction): void {
  conflictVisible.value = false
  conflictResolver?.(action)
  conflictResolver = null
}

/** 磁盘上的文件是不是在我们上次保存之后又被改过 */
async function hasExternalChange(): Promise<boolean> {
  if (!currentPath.value || !fileMtime.value) return false
  const stat = await window.api.file.stat(currentPath.value)
  return stat.exists && stat.mtimeMs !== fileMtime.value
}

/**
 * 定时检查文件：如果打开之后没有任何修改、但磁盘上的文件变了，
 * 直接把最新内容载入进来，省得用户看到的是过期内容。
 */
let fileWatchTimer: number | undefined

async function checkExternalChange(): Promise<void> {
  if (!currentPath.value) return
  const stat = await window.api.file.stat(currentPath.value)
  if (!stat.exists || stat.mtimeMs === fileMtime.value) return
  // 本地有未保存的修改时不自动覆盖，交给保存时的冲突提示处理
  if (dirty.value) return
  const read = await window.api.file.readText(currentPath.value)
  if (!read.ok) return
  content.value = read.content ?? ''
  savedContent.value = content.value
  fileMtime.value = stat.mtimeMs
  fileSize.value = stat.size
  ElMessage.info('文件已被其它程序修改，已载入最新内容')
}

/* ------------------------------ 文本搜索 ------------------------------ */

interface SearchMatch {
  start: number
  end: number
}

const searchVisible = ref(false)
const searchQuery = ref('')
const searchCaseSensitive = ref(false)
const searchWholeWord = ref(false)
const searchRegex = ref(false)
const searchIndex = ref(0)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 根据当前的搜索条件与开关构造正则（编辑区和预览区共用） */
function buildSearchRegex(): { regex: RegExp | null; error: string } {
  const query = searchQuery.value
  if (!query) return { regex: null, error: '' }
  let pattern = searchRegex.value ? query : escapeRegExp(query)
  if (searchWholeWord.value) {
    pattern = `(?<![\\w\\u4e00-\\u9fa5])${pattern}(?![\\w\\u4e00-\\u9fa5])`
  }
  try {
    return { regex: new RegExp(pattern, searchCaseSensitive.value ? 'g' : 'gi'), error: '' }
  } catch (error) {
    return { regex: null, error: `正则表达式有误：${(error as Error).message}` }
  }
}

const searchResult = computed<{ matches: SearchMatch[]; error: string }>(() => {
  const { regex, error } = buildSearchRegex()
  if (!regex) return { matches: [], error }
  const matches: SearchMatch[] = []
  const text = content.value
  let found: RegExpExecArray | null
  let guard = 0
  while ((found = regex.exec(text)) !== null) {
    if (found[0].length === 0) {
      regex.lastIndex += 1
      continue
    }
    matches.push({ start: found.index, end: found.index + found[0].length })
    if (matches.length >= 2000) break
    guard += 1
    if (guard > 20000) break
  }
  return { matches, error: '' }
})

const searchMatches = computed(() => searchResult.value.matches)

/* --------------------------- 预览里的搜索高亮 --------------------------- */

const PREVIEW_HIT = 'md-search-hit'
/** 预览区一共高亮了多少处 */
const previewHitCount = ref(0)

function searchArticle(): HTMLElement | null {
  return previewRef.value?.querySelector<HTMLElement>('.markdown-body') ?? null
}

/** 把上一次插入的 <mark> 还原成普通文本 */
function clearPreviewHighlights(): void {
  const article = searchArticle()
  if (!article) return
  const marks = article.querySelectorAll(`mark.${PREVIEW_HIT}`)
  if (!marks.length) return
  marks.forEach((mark) => {
    const parent = mark.parentNode
    if (!parent) return
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
  })
  // 合并相邻文本节点，方便下次重新切分
  article.normalize()
}

/**
 * 在渲染好的预览里给命中文字套上 <mark>。
 * markdown-it 的渲染结果是 v-html 生成的，这里只在 DOM 上做标记，
 * 内容一变 Vue 会整体重写 innerHTML，不会残留。
 */
function applyPreviewHighlights(): void {
  const article = searchArticle()
  if (!article) {
    previewHitCount.value = 0
    return
  }
  clearPreviewHighlights()
  previewHitCount.value = 0
  if (!searchVisible.value) return

  const { regex } = buildSearchRegex()
  if (!regex) return

  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  let node = walker.nextNode()
  while (node) {
    textNodes.push(node as Text)
    node = walker.nextNode()
  }

  let hits = 0
  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? ''
    if (!text.trim()) continue
    regex.lastIndex = 0
    const ranges: SearchMatch[] = []
    let found: RegExpExecArray | null
    while ((found = regex.exec(text)) !== null) {
      if (found[0].length === 0) {
        regex.lastIndex += 1
        continue
      }
      ranges.push({ start: found.index, end: found.index + found[0].length })
      if (ranges.length > 300) break
    }
    if (!ranges.length) continue

    const fragment = document.createDocumentFragment()
    let last = 0
    for (const range of ranges) {
      if (range.start > last) fragment.appendChild(document.createTextNode(text.slice(last, range.start)))
      const mark = document.createElement('mark')
      mark.className = PREVIEW_HIT
      mark.textContent = text.slice(range.start, range.end)
      fragment.appendChild(mark)
      last = range.end
      hits += 1
    }
    if (last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)))
    textNode.parentNode?.replaceChild(fragment, textNode)
  }

  previewHitCount.value = hits
}

function previewHitElements(): HTMLElement[] {
  const article = searchArticle()
  if (!article) return []
  return Array.from(article.querySelectorAll<HTMLElement>(`mark.${PREVIEW_HIT}`))
}

/** 当前匹配项在预览里高亮成另一个颜色，并滚动到可视区域 */
function syncPreviewCurrent(scroll: boolean): void {
  const hits = previewHitElements()
  if (!hits.length) return
  const index = Math.min(searchIndex.value, hits.length - 1)
  hits.forEach((hit, i) => hit.classList.toggle('current', i === index))
  if (scroll) hits[index]?.scrollIntoView({ block: 'center' })
}

/** 当前应当显示的匹配总数：预览模式下以预览里实际高亮的数量为准 */
const matchTotal = computed(() =>
  viewMode.value === 'preview' ? previewHitCount.value : searchMatches.value.length
)

function openSearch(): void {
  searchVisible.value = true
  void nextTick(() => {
    const input = document.querySelector<HTMLInputElement>('.md-search-input input')
    input?.focus()
    input?.select()
  })
}

function closeSearch(): void {
  searchVisible.value = false
  searchQuery.value = ''
  clearPreviewHighlights()
  previewHitCount.value = 0
}

function gotoMatch(index: number): void {
  const total = matchTotal.value
  if (!total) return
  const normalized = ((index % total) + total) % total
  searchIndex.value = normalized

  // 编辑区：选中对应的源码位置
  const editor = editorRef.value
  const matches = searchMatches.value
  if (editor && matches.length && viewMode.value !== 'preview') {
    const match = matches[normalized % matches.length]
    editor.focus()
    editor.setSelectionRange(match.start, match.end)
    const ratio = match.start / Math.max(1, content.value.length)
    editor.scrollTop = Math.max(0, ratio * editor.scrollHeight - editor.clientHeight / 2)
  }

  // 预览区：高亮当前项并滚过去
  syncPreviewCurrent(true)
}

function nextMatch(): void {
  gotoMatch(searchIndex.value + 1)
}

function prevMatch(): void {
  gotoMatch(searchIndex.value - 1)
}

// 搜索条件变化后重新高亮；换条件时回到第一个匹配
watch(
  [searchQuery, searchCaseSensitive, searchWholeWord, searchRegex],
  () => {
    searchIndex.value = 0
    void nextTick(() => {
      if (matchTotal.value > 0) gotoMatch(0)
    })
  }
)

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
  return md.render(preserveIndent(content.value))
})

// 渲染结果 / 搜索条件 / 视图模式变化后重新给预览加高亮（等 DOM 更新完再做）
watch(
  [rendered, searchVisible, viewMode, searchQuery, searchCaseSensitive, searchWholeWord, searchRegex],
  () => {
    applyPreviewHighlights()
    if (searchIndex.value >= matchTotal.value) searchIndex.value = 0
    syncPreviewCurrent(false)
  },
  { flush: 'post' }
)

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
  const el = editorRef.value
  // v-model 重设 textarea.value 时浏览器会把光标移到末尾、连带把视图滚到最后，
  // 所以先记住当前滚动位置，插入完成后再恢复回去
  const scrollTop = el?.scrollTop ?? 0
  content.value = content.value.slice(0, start) + text + content.value.slice(end)
  void nextTick(() => {
    const target = editorRef.value
    if (!target) return
    target.focus({ preventScroll: true })
    target.setSelectionRange(selectStart, selectEnd)
    target.scrollTop = scrollTop
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

/** 从语法弹窗插入片段：单行直接插到光标处，多行按块插入 */
function insertSyntax(snippet: string): void {
  if (snippet.includes('\n')) {
    insertBlock(snippet)
    return
  }
  const el = editorRef.value
  if (!el) return
  const start = el.selectionStart
  const end = el.selectionEnd
  replaceRange(start, end, snippet, start + snippet.length, start + snippet.length)
}

async function openFile(): Promise<void> {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('当前文档有未保存的修改，打开其它文件会丢失这些修改，是否继续？', '未保存的修改', {
        type: 'warning',
        confirmButtonText: '继续打开',
        cancelButtonText: '取消'
      })
    } catch {
      return
    }
  }
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
  await refreshFileStat()
  savedContent.value = content.value
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

  // 保存前确认：磁盘上的文件在我们上次保存之后有没有被其它程序改过
  if (target === currentPath.value && currentPath.value && dirty.value && (await hasExternalChange())) {
    const action = await askSaveConflict()
    if (action === 'cancel') return
    if (action === 'saveAs') {
      await saveFile(true)
      return
    }
    // overwrite：继续往下写，覆盖其它程序的修改
  }

  const write = await window.api.file.writeText(target, content.value)
  if (!write.ok) {
    ElMessage.error(write.error ?? '保存失败')
    return
  }
  currentPath.value = target
  savedContent.value = content.value
  await refreshFileStat()
  ElMessage.success('已保存')
}

function clearDocument(): void {
  content.value = ''
  currentPath.value = ''
  savedContent.value = ''
  fileMtime.value = 0
  fileSize.value = 0
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

/* ---------------------------- 视图切换定位 ---------------------------- */

/** 从预览切回编辑区时，把编辑区滚到预览所在的位置 */
let pendingScrollRatio: number | null = null

watch(viewMode, (next, prev) => {
  if (prev !== 'edit' && next !== 'preview') {
    const preview = previewRef.value
    if (preview) {
      const max = preview.scrollHeight - preview.clientHeight
      pendingScrollRatio = max > 0 ? preview.scrollTop / max : 0
    }
  }
  if (next !== 'preview' && pendingScrollRatio !== null) {
    const ratio = pendingScrollRatio
    pendingScrollRatio = null
    void nextTick(() => {
      const editor = editorRef.value
      if (!editor) return
      const max = editor.scrollHeight - editor.clientHeight
      if (max > 0) editor.scrollTop = ratio * max
    })
  }
})

/* ------------------------------ 生命周期 ------------------------------ */

onMounted(() => {
  fileWatchTimer = window.setInterval(() => {
    void checkExternalChange()
  }, 2000)
})

onUnmounted(() => {
  if (fileWatchTimer) window.clearInterval(fileWatchTimer)
})
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
      <el-button size="small" :icon="Search" @click="openSearch">搜索</el-button>

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
        <el-button size="small" text :icon="Reading" @click="syntaxVisible = true">语法</el-button>
        <el-button size="small" text :icon="CopyDocument" @click="copyMarkdown">复制</el-button>
        <el-button size="small" text @click="clearDocument">清空</el-button>
      </template>

      <template v-else>
        <span class="spacer" />
        <span class="small muted">{{ stats.lines }} 行 · {{ stats.chars }} 字符 · {{ stats.words }} 词</span>
      </template>
    </div>

    <div v-if="searchVisible" class="md-search-bar">
      <el-input
        v-model="searchQuery"
        size="small"
        class="md-search-input"
        :placeholder="viewMode === 'preview' ? '在预览中查找' : '在文档中查找'"
        clearable
        @keydown.enter.prevent="nextMatch"
        @keydown.shift.enter.prevent="prevMatch"
        @keydown.esc.prevent="closeSearch"
      />
      <button
        type="button"
        class="search-toggle"
        :class="{ on: searchCaseSensitive }"
        title="区分大小写"
        @click="searchCaseSensitive = !searchCaseSensitive"
      >
        Aa
      </button>
      <button
        type="button"
        class="search-toggle"
        :class="{ on: searchWholeWord }"
        title="整词匹配"
        @click="searchWholeWord = !searchWholeWord"
      >
        词
      </button>
      <button
        type="button"
        class="search-toggle mono"
        :class="{ on: searchRegex }"
        title="正则表达式"
        @click="searchRegex = !searchRegex"
      >
        .*
      </button>
      <span class="search-count" :class="{ error: searchResult.error }">
        {{ searchResult.error ? '正则有误' : matchTotal ? `${searchIndex + 1} / ${matchTotal}` : '无结果' }}
      </span>
      <button type="button" class="search-btn" title="上一个（Shift + Enter）" @click="prevMatch">↑</button>
      <button type="button" class="search-btn" title="下一个（Enter）" @click="nextMatch">↓</button>
      <button type="button" class="search-btn" title="关闭" @click="closeSearch">×</button>
    </div>

    <div class="md-body">
      <section v-show="viewMode !== 'preview'" class="panel md-editor-panel">
        <div class="panel-header">
          <span class="panel-title">{{ fileName }}</span>
          <span v-if="dirty" class="dirty-dot" title="有未保存的修改" />
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
            @keydown.ctrl.f.prevent="openSearch"
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

    <MarkdownSyntaxDialog v-model="syntaxVisible" @insert="insertSyntax" />

    <el-dialog v-model="conflictVisible" title="文件已被修改" width="470px" :close-on-click-modal="false">
      <div class="conflict-body">
        <p class="conflict-file mono">{{ currentPath }}</p>
        <p>这个文件在你上次保存之后已被其它程序修改。</p>
        <p class="small muted">
          「覆盖保存」会丢弃其它程序的修改；「另存为」会写到新文件，原文件保持不变。
        </p>
      </div>
      <template #footer>
        <el-button @click="resolveConflict('cancel')">取消保存</el-button>
        <el-button @click="resolveConflict('saveAs')">另存为…</el-button>
        <el-button type="primary" @click="resolveConflict('overwrite')">覆盖保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.md-toolbar {
  gap: 2px;
}

.dirty-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: #ef4444;
}

.header-action {
  flex: none;
}

/* 文档内搜索 */
.md-search-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 6px 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-panel);
  box-shadow: var(--app-shadow);
}

.md-search-input {
  flex: 1;
  min-width: 0;
}

.search-toggle {
  flex: none;
  width: 26px;
  height: 24px;
  border: 1px solid var(--app-border);
  border-radius: 6px;
  background: var(--app-panel);
  color: var(--app-text-2);
  font-family: inherit;
  font-size: 11.5px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.search-toggle:hover {
  border-color: var(--app-primary);
  color: var(--app-primary);
}

.search-toggle.on {
  background: var(--app-primary-soft);
  border-color: var(--app-primary);
  color: var(--app-primary);
  font-weight: 600;
}

.search-count {
  flex: none;
  min-width: 58px;
  text-align: center;
  font-size: 11.5px;
  color: var(--app-text-3);
}

.search-count.error {
  color: #dc2626;
}

.search-btn {
  flex: none;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--app-text-2);
  font-size: 13px;
  cursor: pointer;
}

.search-btn:hover {
  background: var(--app-hover);
  color: var(--app-text);
}

.conflict-body p {
  margin: 0 0 8px;
  line-height: 1.6;
}

.conflict-file {
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--app-panel-muted);
  border: 1px solid var(--app-border);
  font-size: 12px;
  color: var(--app-text-2);
  word-break: break-all;
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

/* 预览模式下的目录侧边栏（可收起成窄条，随窗口变宽：最小 210px，最宽 360px） */
.md-outline {
  flex: 0 0 18%;
  min-width: 210px;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--app-border);
  background: var(--app-panel-muted);
  transition: flex-basis 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.md-outline.collapsed {
  flex: 0 0 34px;
  min-width: 34px;
  max-width: 34px;
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

/* 预览里搜索命中的文字：固定用深色字，深浅主题下都看得清 */
.markdown-body :deep(mark.md-search-hit) {
  padding: 0 1px;
  border-radius: 2px;
  background: #fde68a;
  color: #422006;
}

.markdown-body :deep(mark.md-search-hit.current) {
  background: #f59e0b;
  color: #1c1207;
  box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.35);
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
