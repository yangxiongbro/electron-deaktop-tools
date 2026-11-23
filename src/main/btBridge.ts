import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { configDir } from './store'

/* ------------------------------------------------------------------ */
/* 蓝牙串口长连接：把 COM 口包装成一个可双向读写的通道                    */
/*                                                                     */
/* Node 自己打不开 COM 口（libuv 不支持），这里用一个常驻 PowerShell 进程  */
/* 做字节搬运工：                                                       */
/*   Node → 脚本：每行 `W <base64>`，脚本写进串口                        */
/*   脚本 → Node：每行 `R <base64>`，脚本从串口读到什么就吐什么           */
/* ------------------------------------------------------------------ */

export interface BtLinkHandlers {
  onData: (chunk: Buffer) => void
  onClose: (reason: string) => void
}

export interface BtLink {
  /** 写入串口；缓冲满时返回 Promise，等底层真的写出去再 resolve */
  write: (chunk: Buffer) => void | Promise<void>
  close: () => void
}

const BRIDGE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { Add-Type -AssemblyName System.IO.Ports } catch { }

$PortName = $env:BT_PORT
$logPath = $env:BT_LOG

function Note([string]$text) {
  if ($logPath) { [System.IO.File]::AppendAllText($logPath, $text + [Environment]::NewLine) }
}

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

# 打开端口：没连上就每隔 3 秒重试（手机端什么时候连上都行）
$port = $null
while ($true) {
  try {
    $candidate = Open-BtPort $PortName
    $candidate.Open()
    $port = $candidate
    Note "opened $PortName"
    break
  } catch {
    Note ("open failed: " + $_.Exception.Message)
    Start-Sleep -Seconds 3
  }
}

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

$stream = $port.BaseStream
$stdin = [Console]::OpenStandardInput()
$stdinBuffer = New-Object byte[] 8192
$serialBuffer = New-Object byte[] 4096
$pending = New-Object System.Text.StringBuilder
$async = $stdin.BeginRead($stdinBuffer, 0, $stdinBuffer.Length, $null, $null)

try {
  while ($true) {
    # 1) 串口有数据就转给 Node
    while ($port.IsOpen -and $port.BytesToRead -gt 0) {
      $want = [Math]::Min($port.BytesToRead, $serialBuffer.Length)
      $read = $stream.Read($serialBuffer, 0, $want)
      if ($read -le 0) { break }
      Write-Output ('R ' + [Convert]::ToBase64String($serialBuffer, 0, $read))
      [Console]::Out.Flush()
    }

    # 2) stdin 有整行就写进串口
    if ($async.IsCompleted) {
      $count = $stdin.EndRead($async)
      if ($count -le 0) { break }
      [void]$pending.Append([System.Text.Encoding]::UTF8.GetString($stdinBuffer, 0, $count))
      $text = $pending.ToString()
      $lines = $text.Split([char]10)
      for ($i = 0; $i -lt $lines.Length - 1; $i++) {
        $line = $lines[$i].Trim()
        if ($line -eq 'QUIT') { break }
        if ($line.StartsWith('W ')) {
          try {
            $bytes = [Convert]::FromBase64String($line.Substring(2))
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush()
            Write-Output 'A'
            [Console]::Out.Flush()
          } catch {
            Note ("write failed: " + $_.Exception.Message)
          }
        }
      }
      $pending.Clear() | Out-Null
      [void]$pending.Append($lines[$lines.Length - 1])
      $async = $stdin.BeginRead($stdinBuffer, 0, $stdinBuffer.Length, $null, $null)
    }

    Start-Sleep -Milliseconds 8
  }
} catch {
  Note ("loop failed: " + $_.Exception.Message)
} finally {
  try { if ($port -and $port.IsOpen) { $port.Close() } } catch { }
  try { if ($port) { $port.Dispose() } } catch { }
  Note 'closed'
}
`

function bridgeDir(): string {
  return join(configDir(), 'bt')
}

/** 打开一个蓝牙串口长连接（内部会自动重试，直到手机连上来） */
export async function openBtLink(portName: string, handlers: BtLinkHandlers): Promise<BtLink> {
  const dir = bridgeDir()
  await fsp.mkdir(dir, { recursive: true }).catch(() => undefined)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const scriptFile = join(dir, `bridge-${stamp}.ps1`)
  const logFile = join(dir, `bridge-${stamp}.log`)
  await fsp.writeFile(scriptFile, `\uFEFF${BRIDGE_SCRIPT}`, 'utf8')

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile],
    {
      windowsHide: true,
      env: { ...process.env, BT_PORT: portName, BT_LOG: logFile }
    }
  ) as ChildProcessWithoutNullStreams

  let closed = false
  let buffer = ''

  const finish = (reason: string): void => {
    if (closed) return
    closed = true
    handlers.onClose(reason)
  }

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.startsWith('R ')) {
        try {
          handlers.onData(Buffer.from(line.slice(2), 'base64'))
        } catch {
          // 忽略单行解析失败
        }
      } else if (line === 'READY') {
        handlers.onData(Buffer.alloc(0))
      } else if (line === 'A') {
        if (inFlight > 0) inFlight -= 1
        if (inFlight < limit) {
          const next = waiters.shift()
          if (next) next()
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    void fsp.appendFile(logFile, chunk).catch(() => undefined)
  })
  child.on('exit', (code) => finish(`串口进程退出（${code ?? 0}）`))
  child.on('error', (error) => finish(`串口进程启动失败：${error.message}`))

  /** 已写入但还没收到 ack 的块数（用于背压） */
  let inFlight = 0
  const waiters: (() => void)[] = []
  const limit = 8

  return {
    write(chunk: Buffer): void | Promise<void> {
      if (closed || child.killed) return
      inFlight += 1
      child.stdin.write(`W ${chunk.toString('base64')}\n`)
      if (inFlight < limit) return undefined
      // 缓冲太多：等 ack 消化一部分再继续，避免「瞬间发完 50MB，界面看不到进度」
      return new Promise<void>((resolve) => {
        waiters.push(resolve)
        // 兜底：万一 ack 丢了，最多等 3 秒，避免卡死
        setTimeout(() => resolve(), 3000)
      })
    },
    close(): void {
      if (closed) return
      closed = true
      try {
        child.stdin.write('QUIT\n')
      } catch {
        // 忽略
      }
      setTimeout(() => {
        if (!child.killed) child.kill()
      }, 500)
      void fsp.rm(scriptFile, { force: true }).catch(() => undefined)
    }
  }
}
