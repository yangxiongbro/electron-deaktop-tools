import {
  X509Certificate,
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type CipherGCM,
  type DecipherGCM,
  type KeyObject
} from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'

import { configDir } from './store'

/**
 * 本地聊天的加密与证书。
 *
 * - 传输：HTTPS，首次启动生成一张自签名证书（RSA 2048 / SHA-256），存在配置目录
 * - 内容：X25519 协商 + HKDF 派生 AES-256-GCM 密钥，消息正文端到端加密，
 *   即使中间经过 FRP 服务器转发也读不到内容
 */

export interface ChatIdentity {
  /** X25519 公钥（base64url，SPKI DER） */
  pub: string
  /** X25519 私钥（base64url，PKCS8 DER） */
  priv: string
  /** 自签名证书（PEM） */
  certPem: string
  /** 证书私钥（PEM） */
  keyPem: string
  /** 证书指纹（SHA-256，大写冒号分隔），用于首次见面时记住对方证书 */
  fingerprint: string
  /** 证书主体，界面上展示用 */
  subject: string
}

export interface SealedPayload {
  iv: string
  tag: string
  data: string
}

/* ------------------------------------------------------------------ */
/* 极简 DER 编码：够拼一张 X.509 v3 证书即可                            */
/* ------------------------------------------------------------------ */

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let value = length
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items))
const setOf = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items))
const octetString = (value: Buffer): Buffer => tlv(0x04, value)
const utf8String = (value: string): Buffer => tlv(0x0c, Buffer.from(value, 'utf8'))
const boolean = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]))
const nullValue = (): Buffer => Buffer.from([0x05, 0x00])

function integer(value: Buffer): Buffer {
  // 正整数：最高位为 1 时补一个 0x00，避免被当成负数
  const body = value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value
  return tlv(0x02, body)
}

function bitString(value: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), value]))
}

function encodeOid(oid: string): Buffer {
  const parts = oid.split('.').map((item) => Number(item))
  const bytes: number[] = [parts[0] * 40 + parts[1]]
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f]
    let value = part >>> 7
    while (value > 0) {
      chunk.unshift((value & 0x7f) | 0x80)
      value >>>= 7
    }
    bytes.push(...chunk)
  }
  return Buffer.from(bytes)
}

const oid = (value: string): Buffer => tlv(0x06, encodeOid(value))

/** 上下文相关标签（构造型） */
const explicit = (index: number, content: Buffer): Buffer => tlv(0xa0 + index, content)
const implicit = (index: number, constructed: boolean, content: Buffer): Buffer =>
  tlv((constructed ? 0xa0 : 0x80) + index, content)

function utcTime(date: Date): Buffer {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const text =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  return tlv(0x17, Buffer.from(text, 'ascii'))
}

function distinguishedName(commonName: string): Buffer {
  const cn = setOf(seq(oid('2.5.4.3'), utf8String(commonName)))
  const org = setOf(seq(oid('2.5.4.10'), utf8String('DevToolbox')))
  return seq(cn, org)
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(oid(id), boolean(true), octetString(value)) : seq(oid(id), octetString(value))
}

const SHA256_WITH_RSA = seq(oid('1.2.840.113549.1.1.11'), nullValue())

function buildSelfSignedCert(
  commonName: string,
  publicKey: KeyObject,
  privateKey: KeyObject,
  altNames: string[],
  altIps: string[]
): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const now = new Date()
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const notAfter = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000)
  const serial = randomBytes(16)
  serial[0] &= 0x7f

  const san: Buffer[] = [
    ...altNames.map((host) => implicit(2, false, Buffer.from(host, 'ascii'))),
    ...altIps.map((ip) => implicit(7, false, Buffer.from(ip.split('.').map((item) => Number(item)))))
  ]

  const extensions = explicit(
    3,
    seq(
      // basicConstraints：不是 CA
      extension('2.5.29.19', true, seq()),
      // keyUsage：digitalSignature + keyEncipherment
      extension('2.5.29.15', true, bitString(Buffer.from([0xa0]), 5)),
      // extKeyUsage：serverAuth
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      // subjectAltName
      extension('2.5.29.17', false, seq(...san))
    )
  )

  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    SHA256_WITH_RSA,
    distinguishedName(commonName),
    seq(utcTime(notBefore), utcTime(notAfter)),
    distinguishedName(commonName),
    spki,
    extensions
  )

  const signature = sign('sha256', tbs, privateKey)
  const der = seq(tbs, SHA256_WITH_RSA, bitString(signature))

  const body = der.toString('base64').match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${body.join('\n')}\n-----END CERTIFICATE-----\n`
}

/* ------------------------------------------------------------------ */
/* 身份                                                                */
/* ------------------------------------------------------------------ */

let cached: ChatIdentity | null = null
let cachedPrivateKey: KeyObject | null = null
const keyCache = new Map<string, Buffer>()

export function identityFile(): string {
  return join(configDir(), 'chat-identity.json')
}

function localIpCandidates(): string[] {
  const result: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) result.push(item.address)
    }
  }
  return result
}

function createIdentity(): ChatIdentity {
  const chatKeys = generateKeyPairSync('x25519')
  const tlsKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const certPem = buildSelfSignedCert(
    'DevToolbox Chat',
    tlsKeys.publicKey,
    tlsKeys.privateKey,
    ['localhost', 'devtoolbox-chat'],
    ['127.0.0.1', ...localIpCandidates()]
  )
  const keyPem = tlsKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const cert = new X509Certificate(certPem)

  return {
    pub: (chatKeys.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url'),
    priv: (chatKeys.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64url'),
    certPem,
    keyPem,
    fingerprint: cert.fingerprint256,
    subject: cert.subject.replace(/\n/g, ', ')
  }
}

/** 读取（或首次生成）本机聊天身份 */
export function chatIdentity(): ChatIdentity {
  if (cached) return cached

  try {
    const raw = JSON.parse(readFileSync(identityFile(), 'utf8')) as Partial<ChatIdentity>
    if (raw.pub && raw.priv && raw.certPem && raw.keyPem) {
      const cert = new X509Certificate(raw.certPem)
      // 证书快过期就重新生成
      if (new Date(cert.validTo).getTime() > Date.now() + 24 * 60 * 60 * 1000) {
        cached = {
          pub: raw.pub,
          priv: raw.priv,
          certPem: raw.certPem,
          keyPem: raw.keyPem,
          fingerprint: cert.fingerprint256,
          subject: cert.subject.replace(/\n/g, ', ')
        }
        return cached
      }
    }
  } catch {
    // 没有或损坏 → 重新生成
  }

  const created = createIdentity()
  try {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(identityFile(), JSON.stringify(created, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (error) {
    console.error('[chat] 保存聊天身份失败', error)
  }
  cached = created
  return created
}

function identityPrivateKey(): KeyObject {
  if (!cachedPrivateKey) {
    cachedPrivateKey = createPrivateKey({
      key: Buffer.from(chatIdentity().priv, 'base64url'),
      format: 'der',
      type: 'pkcs8'
    })
  }
  return cachedPrivateKey
}

export function tlsOptions(): { key: string; cert: string } {
  const identity = chatIdentity()
  return { key: identity.keyPem, cert: identity.certPem }
}

/** 证书指纹统一成大写、只留十六进制字符，方便比较 */
export function normalizeFingerprint(value: string | undefined): string {
  return (value ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
}

/* ------------------------------------------------------------------ */
/* 端到端加密                                                          */
/* ------------------------------------------------------------------ */

function sharedKey(peerPub: string): Buffer {
  const hit = keyCache.get(peerPub)
  if (hit) return hit

  const identity = chatIdentity()
  const peerKey = createPublicKey({ key: Buffer.from(peerPub, 'base64url'), format: 'der', type: 'spki' })
  const secret = diffieHellman({ privateKey: identityPrivateKey(), publicKey: peerKey })
  // 双方用同样的盐（两个公钥排序后拼接），派生出来的密钥一致
  const salt = Buffer.from([identity.pub, peerPub].sort().join('|'), 'utf8')
  const key = Buffer.from(hkdfSync('sha256', secret, salt, 'devtoolbox-chat-e2e-v1', 32))
  keyCache.set(peerPub, key)
  return key
}

const AAD = Buffer.from('devtoolbox-chat-v1', 'utf8')

/** 用对方公钥派生的密钥加密内容 */
export function sealPayload(peerPub: string, value: unknown): SealedPayload {
  const iv = randomBytes(12)
  const cipher: CipherGCM = createCipheriv('aes-256-gcm', sharedKey(peerPub), iv)
  cipher.setAAD(AAD)
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), 'utf8')), cipher.final()])
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

/** 解开对方加密的内容；失败返回 null */
export function openPayload(peerPub: string, envelope: unknown): unknown {
  if (!peerPub || !envelope || typeof envelope !== 'object') return null
  const sealed = envelope as Partial<SealedPayload>
  if (typeof sealed.iv !== 'string' || typeof sealed.tag !== 'string' || typeof sealed.data !== 'string') return null
  try {
    const decipher: DecipherGCM = createDecipheriv(
      'aes-256-gcm',
      sharedKey(peerPub),
      Buffer.from(sealed.iv, 'base64')
    )
    decipher.setAAD(AAD)
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    const plain = Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()])
    return JSON.parse(plain.toString('utf8')) as unknown
  } catch (error) {
    console.error('[chat] 解密失败', error)
    return null
  }
}

/** 对方公钥是否可用（格式不对时不要拿它去加密） */
export function isValidPeerKey(peerPub: string | undefined): boolean {
  if (!peerPub || peerPub.length < 40) return false
  try {
    createPublicKey({ key: Buffer.from(peerPub, 'base64url'), format: 'der', type: 'spki' })
    return true
  } catch {
    return false
  }
}

/** 指纹缩略显示：AB12 CD34 EF56 7890 */
export function shortFingerprint(value: string): string {
  return normalizeFingerprint(value).slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ')
}

/**
 * 会话密钥指纹：把派生出来的 AES 密钥再做一次 SHA-256，取前 16 位十六进制。
 * 双方算出来的密钥相同 → 指纹相同；两个人屏幕上对得上，就说明确实是同一把端到端密钥，
 * 中间人拿不到（它没有双方任何一方的私钥，算出来的指纹会对不上）。
 */
export function sessionKeyPrint(peerPub: string): string {
  if (!isValidPeerKey(peerPub)) return ''
  try {
    const digest = createHash('sha256').update(sharedKey(peerPub)).digest('hex').slice(0, 16)
    return digest.toUpperCase().replace(/(.{4})(?=.)/g, '$1 ')
  } catch {
    return ''
  }
}
