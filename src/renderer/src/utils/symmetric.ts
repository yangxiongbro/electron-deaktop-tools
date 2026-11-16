import CryptoJS from 'crypto-js'

/* --------------------------- 对称加密 / 解密 --------------------------- */

export type SymAlgorithm = 'AES' | 'TripleDES' | 'DES'
export type SymMode = 'CBC' | 'ECB' | 'CTR' | 'CFB' | 'OFB'
export type SymPadding = 'Pkcs7' | 'ZeroPadding' | 'NoPadding'
export type TextFormat = 'utf8' | 'hex' | 'base64'
export type OutputFormat = 'base64' | 'hex'

export interface SymmetricOptions {
  algorithm: SymAlgorithm
  mode: SymMode
  padding: SymPadding
  /** 密钥的书写形式 */
  keyFormat: TextFormat
  key: string
  /** IV 的书写形式 */
  ivFormat: TextFormat
  iv: string
  /** 密文输出 / 输入的编码 */
  output: OutputFormat
}

export const SYM_ALGORITHMS: { label: string; value: SymAlgorithm; keyBytes: number[]; blockBytes: number }[] = [
  { label: 'AES', value: 'AES', keyBytes: [16, 24, 32], blockBytes: 16 },
  { label: 'TripleDES (3DES)', value: 'TripleDES', keyBytes: [24], blockBytes: 8 },
  { label: 'DES（不推荐）', value: 'DES', keyBytes: [8], blockBytes: 8 }
]

export const SYM_MODES: { label: string; value: SymMode; needIv: boolean }[] = [
  { label: 'CBC', value: 'CBC', needIv: true },
  { label: 'ECB', value: 'ECB', needIv: false },
  { label: 'CTR', value: 'CTR', needIv: true },
  { label: 'CFB', value: 'CFB', needIv: true },
  { label: 'OFB', value: 'OFB', needIv: true }
]

export const SYM_PADDINGS: { label: string; value: SymPadding; hint: string }[] = [
  { label: 'PKCS7（默认）', value: 'Pkcs7', hint: '最常用，会自动补齐块长' },
  { label: 'ZeroPadding', value: 'ZeroPadding', hint: '用 0 补齐，对接老系统时偶尔会用到' },
  { label: 'NoPadding', value: 'NoPadding', hint: '不做填充，明文长度必须是块长的整数倍' }
]

export const TEXT_FORMATS: { label: string; value: TextFormat }[] = [
  { label: '文本', value: 'utf8' },
  { label: 'Hex', value: 'hex' },
  { label: 'Base64', value: 'base64' }
]

const MODE_MAP = {
  CBC: CryptoJS.mode.CBC,
  ECB: CryptoJS.mode.ECB,
  CTR: CryptoJS.mode.CTR,
  CFB: CryptoJS.mode.CFB,
  OFB: CryptoJS.mode.OFB
}

const PAD_MAP = {
  Pkcs7: CryptoJS.pad.Pkcs7,
  ZeroPadding: CryptoJS.pad.ZeroPadding,
  NoPadding: CryptoJS.pad.NoPadding
}

export function algorithmInfo(algorithm: SymAlgorithm): (typeof SYM_ALGORITHMS)[number] {
  return SYM_ALGORITHMS.find((item) => item.value === algorithm) ?? SYM_ALGORITHMS[0]
}

export function modeInfo(mode: SymMode): (typeof SYM_MODES)[number] {
  return SYM_MODES.find((item) => item.value === mode) ?? SYM_MODES[0]
}

/** 解析「文本 / Hex / Base64」写法的密钥或 IV */
function parseValue(text: string, format: TextFormat, label: string): CryptoJS.lib.WordArray {
  const trimmed = text.trim()
  if (!trimmed) throw new Error(`${label}不能为空`)
  if (format === 'hex') {
    const cleaned = trimmed.replace(/^0x/i, '').replace(/[\s:-]/g, '')
    if (!/^[0-9a-fA-F]*$/.test(cleaned)) throw new Error(`${label}不是合法的十六进制字符串`)
    if (cleaned.length % 2 !== 0) throw new Error(`${label}的十六进制长度必须是偶数`)
    return CryptoJS.enc.Hex.parse(cleaned)
  }
  if (format === 'base64') {
    const cleaned = trimmed.replace(/\s+/g, '')
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(cleaned)) throw new Error(`${label}不是合法的 Base64 字符串`)
    return CryptoJS.enc.Base64.parse(cleaned.replace(/-/g, '+').replace(/_/g, '/'))
  }
  return CryptoJS.enc.Utf8.parse(trimmed)
}

function describeBytes(bytes: number): string {
  if (bytes === 16) return '16 字节（AES-128）'
  if (bytes === 24) return '24 字节（AES-192 / 3DES）'
  if (bytes === 32) return '32 字节（AES-256）'
  if (bytes === 8) return '8 字节（DES）'
  return `${bytes} 字节`
}

/** 检查密钥 / IV 长度，不合格时给出能直接改的建议 */
function checkLength(
  value: CryptoJS.lib.WordArray,
  allowed: number[],
  label: string,
  format: TextFormat
): number {
  const bytes = value.sigBytes
  if (allowed.includes(bytes)) return bytes
  const expected = allowed.map(describeBytes).join(' 或 ')
  const unit = format === 'utf8' ? '个字符' : format === 'hex' ? ' 个十六进制字符' : ' 字节的 Base64'
  const hint =
    format === 'hex'
      ? `（Hex 写法下 ${allowed.map((item) => item * 2).join(' / ')} 个字符）`
      : format === 'utf8'
        ? `（文本写法下就是 ${allowed.join(' / ')} 个字符）`
        : ''
  throw new Error(`${label}长度不对：当前 ${bytes}${unit}，需要 ${expected}${hint}`)
}

function buildCredentials(options: SymmetricOptions): {
  cipher: typeof CryptoJS.AES
  key: CryptoJS.lib.WordArray
  cfg: CryptoJS.lib.CipherParams
} {
  const info = algorithmInfo(options.algorithm)
  const modeCfg = modeInfo(options.mode)
  const key = parseValue(options.key, options.keyFormat, '密钥')
  checkLength(key, info.keyBytes, '密钥', options.keyFormat)

  const cfg: Record<string, unknown> = {
    mode: MODE_MAP[options.mode],
    padding: PAD_MAP[options.padding]
  }
  if (modeCfg.needIv) {
    const iv = parseValue(options.iv, options.ivFormat, 'IV（偏移量）')
    checkLength(iv, [info.blockBytes], 'IV', options.ivFormat)
    cfg.iv = iv
  }

  const cipher =
    options.algorithm === 'AES'
      ? CryptoJS.AES
      : options.algorithm === 'TripleDES'
        ? CryptoJS.TripleDES
        : CryptoJS.DES

  return { cipher, key, cfg: cfg as unknown as CryptoJS.lib.CipherParams }
}

/** 对称加密：明文 → Base64 / Hex 密文 */
export function encryptSymmetric(text: string, options: SymmetricOptions): string {
  if (!text) return ''
  const { cipher, key, cfg } = buildCredentials(options)
  try {
    const encrypted = cipher.encrypt(CryptoJS.enc.Utf8.parse(text), key, cfg)
    return options.output === 'hex'
      ? encrypted.ciphertext.toString(CryptoJS.enc.Hex)
      : encrypted.ciphertext.toString(CryptoJS.enc.Base64)
  } catch (error) {
    throw new Error(`加密失败：${(error as Error).message || '请检查密钥、IV 与填充方式'}`)
  }
}

/** 对称解密：Base64 / Hex 密文 → 明文 */
export function decryptSymmetric(text: string, options: SymmetricOptions): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  const { cipher, key, cfg } = buildCredentials(options)

  let ciphertext: CryptoJS.lib.WordArray
  if (options.output === 'hex') {
    const cleaned = trimmed.replace(/^0x/i, '').replace(/[\s:-]/g, '')
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error('密文不是合法的十六进制字符串')
    if (cleaned.length % 2 !== 0) throw new Error('密文的十六进制长度必须是偶数')
    ciphertext = CryptoJS.enc.Hex.parse(cleaned)
  } else {
    const cleaned = trimmed.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) throw new Error('密文不是合法的 Base64 字符串')
    ciphertext = CryptoJS.enc.Base64.parse(cleaned)
  }

  if (!ciphertext.sigBytes) {
    throw new Error('密文解析后为空：请确认「密文编码」选的是 Base64 还是 Hex')
  }
  if (options.padding !== 'NoPadding') {
    const block = algorithmInfo(options.algorithm).blockBytes
    if (ciphertext.sigBytes % block !== 0) {
      throw new Error(
        `密文长度 ${ciphertext.sigBytes} 字节，不是块长 ${block} 字节的整数倍：多半是密文不完整、或密文编码选错了`
      )
    }
  }

  let decrypted: CryptoJS.lib.WordArray
  try {
    decrypted = cipher.decrypt({ ciphertext } as CryptoJS.lib.CipherParams, key, cfg)
  } catch (error) {
    throw new Error(
      `解密失败：${(error as Error).message || '请检查密钥、IV、模式、填充是否与加密时一致'}`
    )
  }

  const plain = decrypted.toString(CryptoJS.enc.Utf8)
  if (!plain) {
    throw new Error('解密结果为空：通常是密钥 / IV / 模式 / 填充与加密时不一致，或密文不完整')
  }
  return plain
}

/** 生成随机密钥 / IV（按当前格式输出） */
export function randomValue(bytes: number, format: TextFormat): string {
  const wordArray = CryptoJS.lib.WordArray.random(bytes)
  if (format === 'hex') return wordArray.toString(CryptoJS.enc.Hex)
  if (format === 'base64') return wordArray.toString(CryptoJS.enc.Base64)
  // 文本形式没有正好 16 个可打印字符的随机，用 Base64 截断保证长度与可读性
  return wordArray
    .toString(CryptoJS.enc.Base64)
    .replace(/[+/=]/g, '')
    .slice(0, bytes)
    .padEnd(bytes, 'x')
}

/** 该算法 + 写法下密钥应该有多少个「字符」 */
export function keyLengthHint(algorithm: SymAlgorithm, format: TextFormat): string {
  const info = algorithmInfo(algorithm)
  const bytes = info.keyBytes
  if (format === 'hex') return `Hex 写法：${bytes.map((item) => item * 2).join(' / ')} 个字符`
  if (format === 'utf8') return `文本写法：${bytes.join(' / ')} 个字符`
  return `Base64 写法：${bytes.map((item) => Math.ceil((item * 4) / 3)).join(' / ')} 个字符左右（解码后 ${bytes.join(' / ')} 字节）`
}
