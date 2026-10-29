<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { CopyDocument, Delete, Key, Refresh } from '@element-plus/icons-vue'
import SegmentedControl from '../components/SegmentedControl.vue'
import { copyText } from '../utils/clipboard'
import {
  base64Decode,
  base64Encode,
  compareHash,
  decodeJwt,
  hexDecode,
  hexEncode,
  htmlDecode,
  htmlEncode,
  md5,
  sha1,
  sha256,
  unicodeDecode,
  unicodeEncode,
  urlDecode,
  urlEncode
} from '../utils/codec'

type Category = 'url' | 'base64' | 'hash' | 'html' | 'unicode' | 'hex' | 'jwt'
type Direction = 'encode' | 'decode'
type HashAlgo = 'md5' | 'sha1' | 'sha256'

const CATEGORIES = [
  { label: 'URL', value: 'url' },
  { label: 'Base64', value: 'base64' },
  { label: '哈希', value: 'hash' },
  { label: 'HTML', value: 'html' },
  { label: 'Unicode', value: 'unicode' },
  { label: 'Hex', value: 'hex' },
  { label: 'JWT', value: 'jwt' }
]

const DIRECTIONS = [
  { label: '编码', value: 'encode' },
  { label: '解码', value: 'decode' }
]

const HASH_ALGOS = [
  { label: 'MD5', value: 'md5' },
  { label: 'SHA-1', value: 'sha1' },
  { label: 'SHA-256', value: 'sha256' }
]

const category = ref<Category>('url')
const direction = ref<Direction>('encode')
const algo = ref<HashAlgo>('md5')
const input = ref('')
const expected = ref('')

const reversible = computed(() => !['hash', 'jwt'].includes(category.value))
const effectiveDirection = computed<Direction>(() =>
  category.value === 'hash' ? 'encode' : category.value === 'jwt' ? 'decode' : direction.value
)

const description = computed(() => {
  if (category.value === 'hash') {
    const name = algo.value === 'md5' ? 'MD5' : algo.value === 'sha1' ? 'SHA-1' : 'SHA-256'
    return `${name} 是单向散列算法，只能计算摘要、无法还原原文；可填写预期摘要进行一致性校验。`
  }
  if (category.value === 'jwt') return 'JWT 解析（仅解码，不校验签名）：分别展示 Header 与 Payload。'
  const verb = effectiveDirection.value === 'encode' ? '编码' : '解码'
  const names: Record<string, string> = {
    url: 'URL',
    base64: 'Base64',
    html: 'HTML 实体',
    unicode: 'Unicode 转义',
    hex: '十六进制'
  }
  return `对文本进行 ${names[category.value] ?? ''} ${verb}`
})

const result = computed<{ text: string; error: string }>(() => {
  const source = input.value
  if (!source) return { text: '', error: '' }
  try {
    switch (category.value) {
      case 'url':
        return { text: effectiveDirection.value === 'encode' ? urlEncode(source) : urlDecode(source), error: '' }
      case 'base64':
        return { text: effectiveDirection.value === 'encode' ? base64Encode(source) : base64Decode(source), error: '' }
      case 'hash':
        return {
          text: algo.value === 'md5' ? md5(source) : algo.value === 'sha1' ? sha1(source) : sha256(source),
          error: ''
        }
      case 'html':
        return { text: effectiveDirection.value === 'encode' ? htmlEncode(source) : htmlDecode(source), error: '' }
      case 'unicode':
        return {
          text: effectiveDirection.value === 'encode' ? unicodeEncode(source) : unicodeDecode(source),
          error: ''
        }
      case 'hex':
        return { text: effectiveDirection.value === 'encode' ? hexEncode(source) : hexDecode(source), error: '' }
      case 'jwt': {
        const decoded = decodeJwt(source)
        const status =
          decoded.expired === null ? '未包含过期时间（exp）' : decoded.expired ? '已过期' : '在有效期内'
        return {
          text:
            `# Header\n${decoded.header}\n\n# Payload\n${decoded.payload}\n\n` +
            `# 签名\n${decoded.signature}\n\n# 状态\n${status}` +
            (decoded.expiresAt ? `\n过期时间：${new Date(decoded.expiresAt * 1000).toLocaleString()}` : ''),
          error: ''
        }
      }
      default:
        return { text: '', error: '' }
    }
  } catch (error) {
    return { text: '', error: (error as Error).message }
  }
})

const hashMatched = computed<boolean | null>(() => {
  if (category.value !== 'hash' || !expected.value.trim() || !input.value) return null
  return compareHash(input.value, expected.value, algo.value)
})

async function copyOutput(): Promise<void> {
  if (!result.value.text) return
  const ok = await copyText(result.value.text)
  if (ok) ElMessage.success('已复制到剪贴板')
  else ElMessage.error('复制失败')
}

function clearAll(): void {
  input.value = ''
  expected.value = ''
}

function swap(): void {
  if (!result.value.text || !reversible.value) return
  input.value = result.value.text
  direction.value = effectiveDirection.value === 'encode' ? 'decode' : 'encode'
}

function loadExample(): void {
  const examples: Record<string, string> = {
    url: 'https://example.com/搜索?q=你好 世界',
    base64: 'Hello, 世界！',
    hash: 'hello world',
    html: '<div class="card">Tom & Jerry</div>',
    unicode: '你好，世界',
    hex: 'Hello',
    jwt:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
  }
  input.value = examples[category.value] ?? ''
}
</script>

<template>
  <div class="page">
    <div class="page-toolbar">
      <SegmentedControl v-model="category" :options="CATEGORIES" @update:model-value="expected = ''" />
      <SegmentedControl
        v-if="reversible"
        v-model="direction"
        :options="DIRECTIONS"
        size="small"
      />
      <el-button :icon="CopyDocument" :disabled="!result.text" @click="copyOutput">复制结果</el-button>
      <el-button :icon="Refresh" :disabled="!reversible || !result.text" @click="swap">结果作为输入</el-button>
      <el-button :icon="Delete" @click="clearAll">清空</el-button>
      <div class="spacer" />
      <el-button text type="primary" @click="loadExample">示例</el-button>
    </div>

    <div class="hint-bar">
      <span class="small muted">{{ description }}</span>
      <div class="spacer" />
      <template v-if="category === 'hash'">
        <span class="small muted">算法</span>
        <SegmentedControl v-model="algo" :options="HASH_ALGOS" size="small" />
        <el-input
          v-model="expected"
          size="small"
          placeholder="填入预期摘要进行校验"
          class="expected-input"
          clearable
        />
        <el-tag v-if="hashMatched === true" type="success" size="small">校验一致</el-tag>
        <el-tag v-else-if="hashMatched === false" type="danger" size="small">校验不一致</el-tag>
      </template>
    </div>

    <div class="page-body">
      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">{{ category === 'jwt' ? 'JWT Token' : '输入' }}</span>
          <span class="spacer" />
          <span class="small muted">{{ input.length }} 字符</span>
        </div>
        <div class="panel-body">
          <el-input
            v-model="input"
            type="textarea"
            class="fill-textarea"
            resize="none"
            spellcheck="false"
            :placeholder="category === 'jwt' ? '粘贴 JWT token' : '粘贴需要编解码的文本'"
          />
        </div>
      </section>

      <section class="panel flex-1">
        <div class="panel-header">
          <span class="panel-title">结果</span>
          <span class="spacer" />
          <el-button size="small" :icon="CopyDocument" :disabled="!result.text" @click="copyOutput">复制</el-button>
        </div>
        <div class="panel-body">
          <el-alert v-if="result.error" type="error" :closable="false" show-icon :title="result.error" class="body-alert" />
          <pre v-else-if="result.text" class="code-block">{{ result.text }}</pre>
          <div v-else class="placeholder-box">
            <el-icon :size="26"><Key /></el-icon>
            <span>转换结果会显示在这里</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.hint-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  min-height: 30px;
}

.expected-input {
  width: 220px;
}

.body-alert {
  margin: 12px;
}

.code-block {
  word-break: break-all;
  white-space: pre-wrap;
}
</style>
