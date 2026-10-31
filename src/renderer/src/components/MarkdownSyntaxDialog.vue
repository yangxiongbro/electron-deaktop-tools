<script setup lang="ts">
/**
 * Markdown 语法速查弹窗。
 * 除了查阅，也可以直接点「插入」把示例片段写进编辑器光标处。
 */
import { computed, ref } from 'vue'

const props = defineProps<{
  modelValue: boolean
}>()

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'insert', snippet: string): void
}>()

const visible = computed<boolean>({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

interface SyntaxItem {
  label: string
  syntax: string
  description: string
  snippet: string
}

interface SyntaxGroup {
  title: string
  items: SyntaxItem[]
}

const GROUPS: SyntaxGroup[] = [
  {
    title: '文本样式',
    items: [
      { label: '粗体', syntax: '**文本**', description: '用两个星号包裹，快捷键 Ctrl + B 也可以', snippet: '**粗体文本**' },
      { label: '斜体', syntax: '*文本*', description: '用一个星号或下划线包裹', snippet: '*斜体文本*' },
      { label: '粗斜体', syntax: '***文本***', description: '三个星号同时表示粗体与斜体', snippet: '***粗斜体文本***' },
      { label: '删除线', syntax: '~~文本~~', description: '用两个波浪线包裹', snippet: '~~删除线文本~~' },
      { label: '行内代码', syntax: '`code`', description: '用反引号包裹，内容不会被当作语法解析', snippet: '`code`' },
      { label: '转义', syntax: '\\*', description: '在符号前加反斜杠，让符号按普通文本显示', snippet: '\\*' }
    ]
  },
  {
    title: '标题与段落',
    items: [
      { label: '一级标题', syntax: '# 标题', description: '一个 # 加空格，最多支持六级', snippet: '# 标题' },
      { label: '二级标题', syntax: '## 标题', description: '两个 # 加空格', snippet: '## 标题' },
      { label: '三级标题', syntax: '### 标题', description: '三个 # 加空格', snippet: '### 标题' },
      { label: '分割线', syntax: '---', description: '三个或更多连续的 - 或 *，需要单独一行', snippet: '---' },
      { label: '段落', syntax: '空行分隔', description: '空一行表示新段落；行尾加两个空格表示同一段内换行', snippet: '\n\n' }
    ]
  },
  {
    title: '列表',
    items: [
      { label: '无序列表', syntax: '- 项目', description: '也可以用 * 或 + 开头', snippet: '- 列表项' },
      { label: '有序列表', syntax: '1. 项目', description: '数字加点和空格，序号会自动生成', snippet: '1. 列表项' },
      { label: '任务列表', syntax: '- [ ] 待办', description: '[x] 表示已完成，[ ] 表示未完成', snippet: '- [ ] 待办事项' },
      { label: '嵌套列表', syntax: '缩进两个空格', description: '在列表项下缩进两个空格即可产生子级', snippet: '  - 子项' }
    ]
  },
  {
    title: '链接与图片',
    items: [
      { label: '链接', syntax: '[文字](地址)', description: '方括号里是显示文字，圆括号里是链接地址', snippet: '[链接文字](https://example.com)' },
      { label: '图片', syntax: '![描述](地址)', description: '在链接语法前加感叹号', snippet: '![图片描述](https://example.com/image.png)' },
      { label: '自动链接', syntax: '<https://example.com>', description: '用尖括号包裹，直接显示为可点击链接', snippet: '<https://example.com>' },
      { label: '带标题的链接', syntax: '[文字](地址 "标题")', description: '鼠标悬停时显示标题文字', snippet: '[链接文字](https://example.com "悬停提示")' }
    ]
  },
  {
    title: '引用与代码',
    items: [
      { label: '引用', syntax: '> 引用内容', description: '一个 > 加空格，可以嵌套', snippet: '> 引用内容' },
      { label: '多级引用', syntax: '>> 内容', description: '每多一个 > 就多一层嵌套', snippet: '>> 嵌套引用' },
      { label: '代码块', syntax: '```语言', description: '三个反引号加语言名开头，三个反引号结尾，支持语法高亮', snippet: '```javascript\n\n```' },
      { label: '无语言代码块', syntax: '```', description: '不写语言名时按纯文本展示', snippet: '```\n\n```' }
    ]
  },
  {
    title: '表格',
    items: [
      { label: '表格', syntax: '| 列 1 | 列 2 |', description: '第二行用 --- 分隔表头与内容', snippet: '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |' },
      { label: '对齐', syntax: ':---:', description: '左边冒号左对齐，两边冒号居中，右边冒号右对齐', snippet: '| 左对齐 | 居中 | 右对齐 |\n| :--- | :---: | ---: |\n| 内容 | 内容 | 内容 |' }
    ]
  }
]

const keyword = ref('')

const filteredGroups = computed<SyntaxGroup[]>(() => {
  const query = keyword.value.trim().toLowerCase()
  if (!query) return GROUPS
  return GROUPS.map((group) => ({
    title: group.title,
    items: group.items.filter((item) =>
      `${item.label} ${item.syntax} ${item.description} ${group.title}`.toLowerCase().includes(query)
    )
  })).filter((group) => group.items.length > 0)
})

function insert(snippet: string): void {
  emit('insert', snippet)
  visible.value = false
}
</script>

<template>
  <el-dialog v-model="visible" title="Markdown 语法" width="780px" top="6vh">
    <div class="syntax-body">
      <el-input
        v-model="keyword"
        placeholder="搜索语法，例如「表格」「粗体」"
        clearable
        size="default"
        class="syntax-search"
      />

      <section v-for="group in filteredGroups" :key="group.title" class="syntax-group">
        <div class="group-title">{{ group.title }}</div>
        <div class="group-items">
          <div v-for="item in group.items" :key="item.label" class="syntax-item">
            <div class="item-main">
              <span class="item-label">{{ item.label }}</span>
              <code class="item-syntax">{{ item.syntax }}</code>
            </div>
            <div class="item-desc">{{ item.description }}</div>
            <el-button size="small" text type="primary" @click="insert(item.snippet)">插入</el-button>
          </div>
        </div>
      </section>

      <div v-if="!filteredGroups.length" class="syntax-empty">没有匹配的语法</div>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="本编辑器出于安全考虑不渲染 HTML 标签，如需展示标签请放进代码块里用反引号包裹。"
      />
    </div>

    <template #footer>
      <el-button type="primary" @click="visible = false">知道了</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.syntax-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 64vh;
  overflow: auto;
  padding-right: 4px;
}

.syntax-search {
  flex: none;
}

.syntax-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.group-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--app-text-2);
}

.group-items {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  overflow: hidden;
}

.syntax-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'main action'
    'desc action';
  align-items: center;
  gap: 2px 12px;
  padding: 7px 12px;
  border-bottom: 1px solid var(--app-border);
  background: var(--app-panel);
}

.syntax-item:last-child {
  border-bottom: none;
}

.syntax-item:hover {
  background: var(--app-panel-muted);
}

.item-main {
  grid-area: main;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.item-label {
  flex: none;
  width: 84px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--app-text);
}

.item-syntax {
  min-width: 0;
  padding: 1px 7px;
  border-radius: 5px;
  border: 1px solid var(--app-border);
  background: var(--app-panel-muted);
  color: var(--app-primary);
  font-family: var(--app-mono);
  font-size: 12px;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

.item-desc {
  grid-area: desc;
  padding-left: 94px;
  font-size: 12px;
  color: var(--app-text-3);
}

.syntax-item .el-button {
  grid-area: action;
}

.syntax-empty {
  padding: 24px;
  text-align: center;
  color: var(--app-text-3);
  font-size: 13px;
}
</style>
