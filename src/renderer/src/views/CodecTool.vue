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
import {
  SYM_ALGORITHMS,
  SYM_MODES,
  SYM_PADDINGS,
  TEXT_FORMATS,
  algorithmInfo,
  decryptSymmetric,
  encryptSymmetric,
  keyLengthHint,
  modeInfo,
  randomValue,
  type OutputFormat,
  type SymAlgorithm,
  type SymMode,
  type SymPadding,
  type TextFormat
} from '../utils/symmetric'

type Category = 'url' | 'base64' | 'hash' | 'html' | 'unicode' | 'hex' | 'jwt' | 'symmetric'
type Direction = 'encode' | 'decode'
type HashAlgo = 'md5' | 'sha1' | 'sha256'

const CATEGORIES = [
  { label: 'URL', value: 'url' },
  { label: 'Base64', value: 'base64' },
  { label: '哈希', value: 'hash' },
  { label: 'HTML', value: 'html' },
  { label: 'Unicode', value: 'unicode' },
  { label: 'Hex', value: 'hex' },
  { label: 'JWT', value: 'jwt' },
  { label: '对称加密', value: 'symmetric' }
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

/* ---------------- 对称加密 ---------------- */

const symAlgorithm = ref<SymAlgorithm>('AES')
const symMode = ref<SymMode>('CBC')
const symPadding = ref<SymPadding>('Pkcs7')
const symOutput = ref<OutputFormat>('base64')
const keyFormat = ref<TextFormat>('utf8')
const keyText = ref('1234567890abcdef')
const ivFormat = ref<TextFormat>('utf8')
const ivText = ref('abcdef1234567890')

const symOptions = computed(() => ({
  algorithm: symAlgorithm.value,
  mode: symMode.value,
  padding: symPadding.value,
  keyFormat: keyFormat.value,
  key: keyText.value,
  ivFormat: ivFormat.value,
  iv: ivText.value,
  output: symOutput.value
}))

const needIv = computed(() => modeInfo(symMode.value).needIv)
const keyHint = computed(() => keyLengthHint(symAlgorithm.value, keyFormat.value))
const paddingHint = computed(
  () => SYM_PADDINGS.find((item) => item.value === symPadding.value)?.hint ?? ''
)

function fillRandom(target: 'key' | 'iv'): void {
  const info = algorithmInfo(symAlgorithm.value)
  if (target === 'key') {
    const bytes = info.keyBytes[info.keyBytes.length - 1]
    keyText.value = randomValue(bytes, keyFormat.value)
  } else {
    ivText.value = randomValue(info.blockBytes, ivFormat.value)
  }
}

function fillSymExample(): void {
  symAlgorithm.value = 'AES'
  symMode.value = 'CBC'
  symPadding.value = 'Pkcs7'
  symOutput.value = 'base64'
  keyFormat.value = 'utf8'
  keyText.value = '1234567890abcdef'
  ivFormat.value = 'utf8'
  ivText.value = 'abcdef1234567890'
}

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
  if (category.value === 'symmetric') {
    return effectiveDirection.value === 'encode'
      ? '对称加密：明文 → 密文，密钥 / 模式 / 填充 / IV 要和解密端完全一致'
      : '对称解密：把密文还原成明文，密钥 / 模式 / 填充 / IV 要和加密时完全一致'
  }
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
      case 'symmetric': {
        const text =
          effectiveDirection.value === 'encode'
            ? encryptSymmetric(source, symOptions.value)
            : decryptSymmetric(source, symOptions.value)
        return { text, error: '' }
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
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    symmetric: '你好，这是一段用来做对称加密的文本。'
  }
  if (category.value === 'symmetric') {
    fillSymExample()
    direction.value = 'encode'
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

    <!-- 对称加密的配置：算法 / 模式 / 填充 / 编码 / 密钥 / IV -->
    <div v-if="category === 'symmetric'" class="crypto-bar">
      <span class="small muted">算法</span>
      <el-select v-model="symAlgorithm" size="small" class="w-150">
        <el-option v-for="item in SYM_ALGORITHMS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <span class="small muted">模式</span>
      <el-select v-model="symMode" size="small" class="w-90">
        <el-option v-for="item in SYM_MODES" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <span class="small muted">填充</span>
      <el-select v-model="symPadding" size="small" class="w-170">
        <el-option v-for="item in SYM_PADDINGS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <span class="small muted">{{ direction === 'encode' ? '密文输出' : '密文编码' }}</span>
      <el-select v-model="symOutput" size="small" class="w-90">
        <el-option label="Base64" value="base64" />
        <el-option label="Hex" value="hex" />
      </el-select>
      <div class="spacer" />
      <span class="small muted">{{ paddingHint }}</span>
    </div>

    <div v-if="category === 'symmetric'" class="crypto-bar">
      <span class="small muted">密钥</span>
      <el-select v-model="keyFormat" size="small" class="w-90">
        <el-option v-for="item in TEXT_FORMATS" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-input v-model="keyText" size="small" class="grow mono" placeholder="密钥（长度见右侧提示）" clearable />
      <el-button size="small" @click="fillRandom('key')">生成</el-button>
      <span class="small muted key-hint">{{ keyHint }}</span>

      <template v-if="needIv">
        <span class="small muted">IV</span>
        <el-select v-model="ivFormat" size="small" class="w-90">
          <el-option v-for="item in TEXT_FORMATS" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
        <el-input v-model="ivText" size="small" class="grow mono" placeholder="IV / 初始向量" clearable />
        <el-button size="small" @click="fillRandom('iv')">生成</el-button>
      </template>
      <span v-else class="small muted">ECB 模式不需要 IV</span>
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
            :placeholder="
              category === 'jwt'
                ? '粘贴 JWT token'
                : category === 'symmetric'
                  ? direction === 'encode'
                    ? '粘贴要加密的明文'
                    : '粘贴要解密的密文'
                  : '粘贴需要编解码的文本'
            "
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

.crypto-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  flex-wrap: wrap;
  padding: 8px 10px;
  border: 1px dashed var(--app-border-strong);
  border-radius: 8px;
  background: var(--app-panel);
}

.crypto-bar .grow {
  flex: 1;
  min-width: 200px;
}

.w-90 {
  width: 90px;
}

.w-150 {
  width: 150px;
}

.w-170 {
  width: 170px;
}

.key-hint {
  font-size: 11px;
  white-space: nowrap;
}

.body-alert {
  margin: 12px;
}

.code-block {
  word-break: break-all;
  white-space: pre-wrap;
}
</style>
