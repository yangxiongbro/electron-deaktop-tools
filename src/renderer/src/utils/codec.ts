import CryptoJS from 'crypto-js'

/* ------------------------------- URL ------------------------------- */

export function urlEncode(text: string): string {
  return encodeURIComponent(text)
}

export function urlDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '))
  } catch {
    throw new Error('不是合法的 URL 编码字符串（存在未转义的 % 序列）')
  }
}

/* ------------------------------ Base64 ----------------------------- */

function bytesToBinary(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return binary
}

export function base64Encode(text: string): string {
  return btoa(bytesToBinary(new TextEncoder().encode(text)))
}

export function base64Decode(text: string): string {
  const cleaned = text.replace(/\s+/g, '')
  const normalized = cleaned.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    throw new Error('不是合法的 Base64 字符串')
  }
}

/* ------------------------------- 哈希 ------------------------------ */

export function md5(text: string): string {
  return CryptoJS.MD5(text).toString()
}

export function sha1(text: string): string {
  return CryptoJS.SHA1(text).toString()
}

export function sha256(text: string): string {
  return CryptoJS.SHA256(text).toString()
}

/** 计算并比较摘要，返回是否一致 */
export function compareHash(text: string, expected: string, algorithm: 'md5' | 'sha1' | 'sha256'): boolean {
  const actual = algorithm === 'md5' ? md5(text) : algorithm === 'sha1' ? sha1(text) : sha256(text)
  return actual.toLowerCase() === expected.trim().toLowerCase()
}

/* ------------------------------- HTML ------------------------------ */

export function htmlEncode(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function htmlDecode(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

/* ----------------------------- Unicode ----------------------------- */

export function unicodeEncode(text: string): string {
  return Array.from(text)
    .map((char) => {
      const codePoint = char.codePointAt(0) ?? 0
      if (codePoint > 0xffff) return `\\u{${codePoint.toString(16).toUpperCase()}}`
      return `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
    })
    .join('')
}

export function unicodeDecode(text: string): string {
  return text
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/* -------------------------------- Hex ------------------------------ */

export function hexEncode(text: string): string {
  return Array.from(new TextEncoder().encode(text))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export function hexDecode(text: string): string {
  const cleaned = text.replace(/[\s:]/g, '').replace(/^0x/i, '')
  if (cleaned.length === 0) return ''
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error('包含非法的十六进制字符')
  if (cleaned.length % 2 !== 0) throw new Error('十六进制长度必须为偶数')
  const bytes = new Uint8Array(cleaned.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16)
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/* -------------------------------- JWT ------------------------------ */

export interface JwtDecoded {
  header: string
  payload: string
  signature: string
  expired: boolean | null
  issuedAt: number | null
  expiresAt: number | null
}

function decodeBase64Url(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function decodeJwt(token: string): JwtDecoded {
  const parts = token.trim().split('.')
  if (parts.length < 2) throw new Error('JWT 格式不正确，至少需要 header.payload 两段')
  let header: string
  let payload: string
  try {
    header = JSON.stringify(JSON.parse(decodeBase64Url(parts[0])), null, 2)
    payload = JSON.stringify(JSON.parse(decodeBase64Url(parts[1])), null, 2)
  } catch {
    throw new Error('无法解析 JWT 内容，请检查 token 是否完整')
  }

  let expiresAt: number | null = null
  let issuedAt: number | null = null
  try {
    const parsed = JSON.parse(decodeBase64Url(parts[1])) as { exp?: number; iat?: number }
    if (typeof parsed.exp === 'number') expiresAt = parsed.exp
    if (typeof parsed.iat === 'number') issuedAt = parsed.iat
  } catch {
    // 忽略
  }

  return {
    header,
    payload,
    signature: parts[2] ?? '',
    expired: expiresAt === null ? null : expiresAt * 1000 < Date.now(),
    issuedAt,
    expiresAt
  }
}
