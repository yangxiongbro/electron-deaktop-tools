<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { DocumentAdd } from '@element-plus/icons-vue'

/**
 * 「直接处理文件」按钮：选一个文本文件 → 用当前工具的规则处理 → 结果写成新文件。
 * 三个纯文本工具（命名转换 / 编解码 / 字符处理）共用这一个组件。
 */
const props = defineProps<{
  /** 输入文本 → 输出文本 */
  process: (input: string) => string
  /** 输出文件名的后缀，例如 '-converted' */
  suffix?: string
  disabled?: boolean
}>()

const busy = ref(false)

const TEXT_FILTERS = [
  {
    name: '文本文件',
    extensions: ['txt', 'md', 'json', 'csv', 'log', 'xml', 'yml', 'yaml', 'sql', 'properties', 'ini']
  },
  { name: '所有文件', extensions: ['*'] }
]

function splitExt(filePath: string): { base: string; ext: string } {
  const match = /(\.[^.\\/]+)$/.exec(filePath)
  if (!match) return { base: filePath, ext: '.txt' }
  return { base: filePath.slice(0, filePath.length - match[1].length), ext: match[1] }
}

async function run(): Promise<void> {
  const pick = await window.api.dialog.openFile({ title: '选择要处理的文件', filters: TEXT_FILTERS })
  if (pick.canceled || !pick.filePath) return

  busy.value = true
  try {
    const read = await window.api.file.readText(pick.filePath)
    if (!read.ok) {
      ElMessage.error(read.error ?? '读取文件失败')
      return
    }
    const { base, ext } = splitExt(pick.filePath)
    let output: string
    try {
      output = props.process(read.content ?? '')
    } catch (error) {
      ElMessage.error(`处理失败：${(error as Error).message}`)
      return
    }
    const save = await window.api.dialog.saveFile({
      title: '保存处理结果',
      defaultPath: `${base}${props.suffix ?? '-out'}${ext}`,
      filters: [{ name: '文本文件', extensions: [ext.replace('.', '') || 'txt'] }, { name: '所有文件', extensions: ['*'] }]
    })
    if (save.canceled || !save.filePath) return
    const write = await window.api.file.writeText(save.filePath, output)
    if (!write.ok) {
      ElMessage.error(write.error ?? '写入文件失败')
      return
    }
    ElMessage.success(`已处理完成，结果保存到 ${save.filePath}`)
    await window.api.app.showItemInFolder(save.filePath)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <el-tooltip content="选一个文本文件，处理结果直接写成新文件" placement="bottom">
    <el-button :icon="DocumentAdd" :loading="busy" :disabled="disabled" @click="run">处理文件</el-button>
  </el-tooltip>
</template>
