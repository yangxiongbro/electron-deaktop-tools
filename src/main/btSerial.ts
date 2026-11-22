import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './store'

/* ------------------------------------------------------------------ */
/* 蓝牙文件同步（Windows）：走手机配对后出现的那个「标准串口」COM 口      */
/*                                                                     */
/* 安卓端用 RFCOMM（SPP UUID 00001101-…），Windows 把它映射成一个 COM 口， */
/* 这里用 PowerShell 的 System.IO.Ports 驱动它。                        */
/* 分帧与安卓端一致：2 字节大端头部长度 + UTF-8 JSON 头（name/size）+ 数据 */
/* ------------------------------------------------------------------ */

export interface SerialPortInfo {
  /** 真正要打开的串口（可能是通用的「传入端口」） */
  path: string
  /** 串口友好名，例如「蓝牙链接上的标准串行 (COM5)」 */
  name: string
  /** 对应的蓝牙设备名（配对名），拿不到时为空 */
  device: string
  /** 设备 MAC，用来把端口和设备对上 */
  mac?: string
  /** 看起来是蓝牙串口 */
  bluetooth: boolean
  /** 实际使用的串口（与 path 相同，方便界面展示） */
  attachedPort?: string
  /** 是不是借用了通用「传入端口」 */
  viaIncoming?: boolean
}

export interface BtTransferResult {
  ok: boolean
  message: string
  /** 收到 / 发出的文件路径 */
  filePath?: string
  size?: number
}

const HEADER_LIMIT = 64 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024

function btWorkDir(): string {
  return join(configDir(), 'bt')
}

export function isBluetoothPort(name: string, device: string): boolean {
  const text = `${name} ${device}`.toLowerCase()
  return text.includes('bluetooth') || text.includes('蓝牙') || text.includes('rfcomm') || text.includes('bthenum')
}

/** PowerShell 脚本统一前缀：固定 UTF-8 输出 + 显式加载串口程序集 */
const PS_PROLOGUE = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { Add-Type -AssemblyName System.IO.Ports } catch { }
`

/** 结果通过 UTF-8 文件回传（PowerShell 5.1 的控制台代码页会把中文弄乱） */
const PS_RESULT_HELPER = `
function Write-Result([object]$Value) {
  $json = ConvertTo-Json -InputObject $Value -Compress
  [System.IO.File]::WriteAllText($env:BT_RESULT_FILE, $json, (New-Object System.Text.UTF8Encoding($false)))
}
`

/** 打开一个蓝牙串口：属性逐个赋值，避免 5 参构造里的枚举解析问题 */
const PS_OPEN_HELPER = `
function Open-BtPort([string]$name) {
  $sp = New-Object System.IO.Ports.SerialPort
  $sp.PortName = $name
  $sp.BaudRate = 115200
  $sp.Parity = 0
  $sp.DataBits = 8
  $sp.StopBits = 1
  $sp.Handshake = 0
  $sp.DtrEnable = $true
  $sp.RtsEnable = $true
  return $sp
}
`

interface PowerShellOutput {
  code: number
  out: string
  err: string
  result: Record<string, unknown> | null
}

/** 参数走环境变量：PowerShell 的 param() 必须是脚本第一句，前面不能再放 prologue */
async function runPowerShell(
  script: string,
  params: Record<string, string | number>,
  timeoutMs: number
): Promise<PowerShellOutput> {
  const dir = btWorkDir()
  await fsp.mkdir(dir, { recursive: true }).catch(() => undefined)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const file = join(dir, `bt-${stamp}.ps1`)
  const resultFile = join(dir, `bt-${stamp}.json`)

  // PowerShell 5.1 读脚本需要带 BOM 的 UTF-8
  await fsp.writeFile(file, `\uFEFF${PS_PROLOGUE}${PS_RESULT_HELPER}${PS_OPEN_HELPER}${script}`, 'utf8')

  const env: NodeJS.ProcessEnv = { ...process.env, BT_RESULT_FILE: resultFile }
  for (const [name, value] of Object.entries(params)) {
    env[`BT_${name.toUpperCase()}`] = String(value)
  }
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file]

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, env })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('蓝牙操作超时'))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', async (code) => {
      clearTimeout(timer)
      let result: Record<string, unknown> | null = null
      try {
        const text = await fsp.readFile(resultFile, 'utf8')
        const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
        if (parsed && typeof parsed === 'object') result = parsed as Record<string, unknown>
      } catch {
        // 没有结果文件时用 stdout / stderr 兜底
      }
      await fsp.rm(resultFile, { force: true }).catch(() => undefined)
      resolve({ code: code ?? -1, out: out.trim(), err: err.trim(), result })
    })
  })
}

/**
 * 枚举串口，并尽量把 COM 口映射到「配对的蓝牙设备名」：
 * 蓝牙串口的父设备就是那台手机 / 电脑，名字比「蓝牙链接上的标准串行 (COM5)」有用得多。
 */
const LIST_SCRIPT = `
$devices = @()
$ports = @()
$seen = @{}

# 1) 已配对的蓝牙设备（BTHENUM\\DEV_<MAC>）—— 电脑上「能看到手机」靠的是这一步
try {
  foreach ($d in (Get-PnpDevice -Class Bluetooth -ErrorAction Stop | Where-Object { $_.InstanceId -like 'BTHENUM\\DEV_*' })) {
    $macMatch = [regex]::Match([string]$d.InstanceId, 'DEV_([0-9A-F]{12})')
    $mac = $macMatch.Groups[1].Value
    $devices += [pscustomobject]@{ name = [string]$d.FriendlyName; mac = $mac }
  }
} catch { }

# 2) 蓝牙串口：带 MAC 的是某台设备的传出端口，LOCALMFG 的是「传入端口」
try {
  foreach ($p in (Get-PnpDevice -Class Ports -ErrorAction Stop)) {
    $match = [regex]::Match([string]$p.FriendlyName, 'COM(\\d+)')
    if (-not $match.Success) { continue }
    $com = 'COM' + $match.Groups[1].Value
    $instanceId = [string]$p.InstanceId
    $isBt = $instanceId -like 'BTHENUM*' -or $p.FriendlyName -like '*蓝牙*' -or $p.FriendlyName -like '*Bluetooth*'
    if (-not $isBt) { continue }
    $mac = ''
    $incoming = $false
    $macMatch = [regex]::Match($instanceId, '([0-9A-F]{12})_C0')
    if ($macMatch.Success -and $macMatch.Groups[1].Value -ne '000000000000') {
      $mac = $macMatch.Groups[1].Value
    } elseif ($instanceId -like '*LOCALMFG*' -or $instanceId -like '*000000000000*') {
      $incoming = $true
    }
    $ports += [pscustomobject]@{ path = $com; name = [string]$p.FriendlyName; mac = $mac; incoming = $incoming }
    $seen[$com] = $true
  }
} catch { }

# 3) 兜底：WMI 里的其它串口
try {
  foreach ($item in (Get-CimInstance Win32_SerialPort -ErrorAction Stop)) {
    $com = [string]$item.DeviceID
    if (-not $com -or $seen[$com]) { continue }
    $ports += [pscustomobject]@{ path = $com; name = [string]$item.Name; mac = ''; incoming = $false }
  }
} catch { }

Write-Result ([pscustomobject]@{ devices = $devices; ports = $ports })
`

/** 列出本机串口（Windows）；蓝牙串口排在前面 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  if (process.platform !== 'win32') return []
  try {
    const { result } = await runPowerShell(LIST_SCRIPT, {}, 25_000)
    const rawDevices = Array.isArray((result as { devices?: unknown })?.devices)
      ? ((result as { devices: unknown[] }).devices as unknown[])
      : []
    const rawPorts = Array.isArray((result as { ports?: unknown })?.ports)
      ? ((result as { ports: unknown[] }).ports as unknown[])
      : []

    const ports: Array<{ path: string; name: string; mac: string; incoming: boolean }> = []
    for (const item of rawPorts) {
      if (!item || typeof item !== 'object') continue
      const record = item as { path?: string; name?: string; mac?: string; incoming?: boolean }
      const path = String(record.path ?? '').trim()
      if (!/^COM\d+$/i.test(path)) continue
      ports.push({
        path,
        name: String(record.name ?? '').trim() || path,
        mac: String(record.mac ?? '').trim(),
        incoming: record.incoming === true
      })
    }
    const incomingPort = ports.find((item) => item.incoming)

    const devices: SerialPortInfo[] = []
    for (const item of rawDevices) {
      if (!item || typeof item !== 'object') continue
      const record = item as { name?: string; mac?: string }
      const name = String(record.name ?? '').trim()
      const mac = String(record.mac ?? '').trim()
      if (!name) continue
      const own = ports.find((port) => mac && port.mac === mac)
      // 自己的传出端口优先；没有就用通用「传入端口」（手机连上来就能同步）
      const port = own ?? incomingPort
      devices.push({
        path: port?.path ?? '',
        name,
        device: name,
        mac,
        bluetooth: true,
        attachedPort: port ? port.path : '',
        viaIncoming: Boolean(port && !own && port.incoming)
      })
    }

    // 端口里出现了、但没在上面列出的（例如耳机）：也补上，方便手动指定
    for (const port of ports) {
      if (devices.some((item) => item.attachedPort === port.path)) continue
      devices.push({
        path: port.path,
        name: port.incoming ? '蓝牙传入端口（任意已配对设备）' : port.name,
        device: port.incoming ? '蓝牙传入端口（任意已配对设备）' : port.name,
        mac: port.mac,
        bluetooth: true,
        attachedPort: port.path,
        viaIncoming: port.incoming
      })
    }
    return devices
  } catch {
    return []
  }
}

const RECEIVE_SCRIPT = `
$PortName = $env:BT_PORT
$OutFile = $env:BT_OUTFILE
$TimeoutSec = [int]$env:BT_TIMEOUTSEC
$port = Open-BtPort $PortName
$port.ReadTimeout = $TimeoutSec * 1000
try {
  $port.Open()
  $stream = $port.BaseStream
  function Read-Exact([int]$count) {
    $buffer = New-Object byte[] $count
    $offset = 0
    while ($offset -lt $count) {
      $read = $stream.Read($buffer, $offset, $count - $offset)
      if ($read -le 0) { throw '连接已关闭' }
      $offset += $read
    }
    return $buffer
  }
  $lenBytes = Read-Exact 2
  $headerLen = ([int]$lenBytes[0] * 256) + [int]$lenBytes[1]
  if ($headerLen -le 0 -or $headerLen -gt ${HEADER_LIMIT}) { throw "头部长度非法：$headerLen" }
  $headerText = [System.Text.Encoding]::UTF8.GetString((Read-Exact $headerLen))
  $meta = $headerText | ConvertFrom-Json
  $size = [int]$meta.size
  if ($size -le 0 -or $size -gt ${MAX_FILE_BYTES}) { throw "文件大小非法：$size" }
  $data = Read-Exact $size
  [System.IO.File]::WriteAllBytes($OutFile, $data)
  Write-Result ([pscustomobject]@{ ok = $true; name = [string]$meta.name; size = $size; file = $OutFile })
} catch {
  Write-Result ([pscustomobject]@{ ok = $false; error = $_.Exception.Message })
  exit 1
} finally {
  if ($port.IsOpen) { $port.Close() }
  $port.Dispose()
}
`

/** 用户选的串口 + 其它蓝牙串口（Windows 同一台设备会有进 / 出两个口，很容易选错） */
async function portsToTry(selected: string): Promise<string[]> {
  const ports = await listSerialPorts()
  const order = [selected]
  for (const port of ports) {
    const path = port.attachedPort || port.path
    if (port.bluetooth && path && !order.includes(path)) order.push(path)
  }
  return order.filter(Boolean)
}

/** 等手机通过蓝牙发一个文件过来，存到同步目录 */
export async function receiveOverBluetooth(portName: string, targetDir: string): Promise<BtTransferResult> {
  if (process.platform !== 'win32') return { ok: false, message: '蓝牙同步目前只支持 Windows' }
  if (!/^COM\d+$/i.test(portName.trim())) return { ok: false, message: '请选择配对后出现的串口（COMx）' }

  const dir = btWorkDir()
  await fsp.mkdir(dir, { recursive: true }).catch(() => undefined)
  await fsp.mkdir(targetDir, { recursive: true }).catch(() => undefined)
  const outFile = join(dir, `incoming-${Date.now()}.bin`)

  // Windows 会给同一台设备建两个串口（进 / 出），选错那个会一直等不到数据；
  // 这里先试用户选的，再按顺序自动试其它蓝牙串口。
  const candidates = await portsToTry(portName)
  let output: PowerShellOutput = { code: -1, out: '', err: '没有可用的蓝牙串口', result: null }
  const tried: string[] = []
  for (const port of candidates) {
    tried.push(port)
    try {
      output = await runPowerShell(RECEIVE_SCRIPT, { Port: port, OutFile: outFile, TimeoutSec: 25 }, 40_000)
    } catch (error) {
      output = { code: -1, out: '', err: (error as Error).message, result: null }
    }
    const done = output.result ?? {}
    if (output.code === 0 && done.ok === true) break
  }
  const triedHint = tried.length > 1 ? `（已尝试 ${tried.join(' / ')}）` : ''

  const result = output.result ?? {}
  if (output.code !== 0 || result.ok !== true) {
    await fsp.rm(outFile, { force: true }).catch(() => undefined)
    const reason = String(result.error ?? '') || output.err || '接收失败（手机端是否点了「选择文件并发送」？）'
    return { ok: false, message: `${reason}${triedHint}` }
  }

  const fileName = String(result.name ?? '').replace(/[\\/]/g, '_').trim() || `bluetooth-${Date.now()}.bin`
  const target = join(targetDir, fileName)
  await fsp.rename(outFile, target).catch(async () => {
    await fsp.copyFile(outFile, target)
    await fsp.rm(outFile, { force: true }).catch(() => undefined)
  })
  const size = Number(result.size ?? 0)
  return { ok: true, message: `已收到 ${fileName}（${(size / 1024).toFixed(0)} KB）`, filePath: target, size }
}

const SEND_SCRIPT = `
$PortName = $env:BT_PORT
$FrameFile = $env:BT_FRAMEFILE
$TimeoutSec = [int]$env:BT_TIMEOUTSEC
$port = Open-BtPort $PortName
$port.WriteTimeout = $TimeoutSec * 1000
try {
  $port.Open()
  $bytes = [System.IO.File]::ReadAllBytes($FrameFile)
  $port.BaseStream.Write($bytes, 0, $bytes.Length)
  $port.BaseStream.Flush()
  Start-Sleep -Milliseconds 500
  Write-Result ([pscustomobject]@{ ok = $true; size = $bytes.Length })
} catch {
  Write-Result ([pscustomobject]@{ ok = $false; error = $_.Exception.Message })
  exit 1
} finally {
  if ($port.IsOpen) { $port.Close() }
  $port.Dispose()
}
`

/** 把本机文件通过蓝牙（SPP 串口）发给手机 */
export async function sendOverBluetooth(portName: string, filePath: string): Promise<BtTransferResult> {
  if (process.platform !== 'win32') return { ok: false, message: '蓝牙同步目前只支持 Windows' }
  if (!/^COM\d+$/i.test(portName.trim())) return { ok: false, message: '请选择配对后出现的串口（COMx）' }
  const stat = await fsp.stat(filePath).catch(() => null)
  if (!stat || !stat.isFile()) return { ok: false, message: '文件不存在或已被删除' }
  if (stat.size > MAX_FILE_BYTES) return { ok: false, message: '超过 64 MB 的文件不支持蓝牙发送' }

  const data = await fsp.readFile(filePath)
  const fileName = filePath.split(/[\\/]/).pop() ?? 'file'
  const frame = buildBluetoothFrame(fileName, data)

  const dir = btWorkDir()
  await fsp.mkdir(dir, { recursive: true }).catch(() => undefined)
  const frameFile = join(dir, `outgoing-${Date.now()}.bin`)
  await fsp.writeFile(frameFile, frame)

  // 与接收一样：先试用户选的串口，再自动试其它蓝牙串口（进 / 出端口容易选错）
  const candidates = await portsToTry(portName)
  let output: PowerShellOutput = { code: -1, out: '', err: '没有可用的蓝牙串口', result: null }
  const tried: string[] = []
  try {
    for (const port of candidates) {
      tried.push(port)
      try {
        output = await runPowerShell(SEND_SCRIPT, { Port: port, FrameFile: frameFile, TimeoutSec: 15 }, 30_000)
      } catch (error) {
        output = { code: -1, out: '', err: (error as Error).message, result: null }
      }
      const done = output.result ?? {}
      if (output.code === 0 && done.ok === true) break
    }
  } finally {
    await fsp.rm(frameFile, { force: true }).catch(() => undefined)
  }
  const triedHint = tried.length > 1 ? `（已尝试 ${tried.join(' / ')}）` : ''

  const result = output.result ?? {}
  if (output.code !== 0 || result.ok !== true) {
    const reason = String(result.error ?? '') || output.err || '发送失败（手机端是否在「开始接收」？）'
    return { ok: false, message: `${reason}${triedHint}` }
  }
  return { ok: true, message: `已发送 ${fileName}（${(data.length / 1024).toFixed(0)} KB）`, filePath, size: data.length }
}

/**
 * 组帧：与安卓端约定一致 —— 2 字节大端「头部长度」+ UTF-8 JSON 头 {name,size} + 原始字节。
 * 安卓侧用 DataInputStream.readUTF 读头（ASCII 名称下与 UTF-8 等价），再读 size 字节。
 */
export function buildBluetoothFrame(fileName: string, data: Buffer): Buffer {
  const header = Buffer.from(JSON.stringify({ name: fileName, size: data.length }), 'utf8')
  const frame = Buffer.alloc(2 + header.length + data.length)
  frame.writeUInt16BE(header.length, 0)
  header.copy(frame, 2)
  data.copy(frame, 2 + header.length)
  return frame
}

/** 解析一帧（自测用，正式接收在 PowerShell 里做） */
export function parseBluetoothFrame(frame: Buffer): { name: string; data: Buffer } | null {
  if (frame.length < 3) return null
  const headerLength = frame.readUInt16BE(0)
  if (headerLength <= 0 || frame.length < 2 + headerLength) return null
  let meta: { name?: string; size?: number }
  try {
    meta = JSON.parse(frame.subarray(2, 2 + headerLength).toString('utf8')) as {
      name?: string
      size?: number
    }
  } catch {
    return null
  }
  const size = Number(meta.size ?? 0)
  if (!Number.isFinite(size) || size < 0 || frame.length < 2 + headerLength + size) return null
  return { name: String(meta.name ?? ''), data: frame.subarray(2 + headerLength, 2 + headerLength + size) }
}
