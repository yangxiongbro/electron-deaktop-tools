import { createSocket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

/**
 * 本机网络地址探测。
 *
 * 多网卡（Hyper-V / VMware / Docker / VPN / WSL 虚拟网卡等）时，简单地取「第一个内网地址」
 * 很容易拿到一块连不通的网卡，好友按那个地址根本连不上。
 * 这里改成：
 *   1. 优先用「默认路由出口」的地址（UDP connect 拿到的本地地址，不会真的发包）；
 *   2. 拿不到就按网卡类型 / 网段排序，虚拟网卡排最后；
 *   3. 用户也可以手动指定用哪块网卡的地址。
 */

export interface NetworkOption {
  address: string
  /** 网卡名，界面上展示用 */
  iface: string
  /** 看起来是虚拟网卡（VPN / 虚拟机 / 容器） */
  virtual: boolean
}

/** 虚拟网卡的名字特征：这类地址通常只有本机能访问，不适合告诉好友 */
const VIRTUAL_PATTERNS = [
  /vethernet/i,
  /hyper-?v/i,
  /vmware/i,
  /vmnet/i,
  /virtualbox/i,
  /vbox/i,
  /docker/i,
  /wsl/i,
  /loopback/i,
  /^lo\b/i,
  /tap/i,
  /tun/i,
  /vpn/i,
  /zerotier/i,
  /tailscale/i,
  /wireguard/i,
  /clash/i,
  /radmin/i,
  /hamachi/i,
  /npcap/i
]

export function isVirtualInterface(name: string): boolean {
  return VIRTUAL_PATTERNS.some((pattern) => pattern.test(name))
}

function isPrivate(address: string): boolean {
  return (
    address.startsWith('192.168.') ||
    address.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  )
}

/** 所有可作为「对外地址」的 IPv4（排除回环、链路本地、内部地址） */
export function listNetworkOptions(): NetworkOption[] {
  const result: NetworkOption[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal) continue
      if (item.address.startsWith('169.254.') || item.address === '0.0.0.0') continue
      result.push({ address: item.address, iface: name, virtual: isVirtualInterface(name) })
    }
  }
  // 真实网卡优先、内网地址优先，同分时保持稳定顺序
  return result.sort((left, right) => {
    if (left.virtual !== right.virtual) return left.virtual ? 1 : -1
    if (isPrivate(left.address) !== isPrivate(right.address)) return isPrivate(left.address) ? -1 : 1
    if (left.address.startsWith('192.168.') !== right.address.startsWith('192.168.')) {
      return left.address.startsWith('192.168.') ? -1 : 1
    }
    return left.address.localeCompare(right.address)
  })
}

/** 只按网卡排序挑一个（探测不到默认路由时的兜底） */
export function rankedAddress(): string {
  const options = listNetworkOptions()
  return options[0]?.address ?? '127.0.0.1'
}

/**
 * 默认路由出口的本地 IP。
 * UDP connect 只设置对端地址、不发送任何数据包，所以断网也不会报错（只要有默认路由），
 * 拿到的就是系统真正用于对外通信的那块网卡。
 */
export function routeAddress(timeoutMs = 800): Promise<string> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4')
    let settled = false
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // 已经关了
      }
      resolve(value)
    }
    const timer = setTimeout(() => finish(''), timeoutMs)
    socket.once('error', () => finish(''))
    try {
      socket.connect(53, '8.8.8.8', () => {
        try {
          const address = socket.address().address
          finish(address && address !== '0.0.0.0' ? address : '')
        } catch {
          finish('')
        }
      })
    } catch {
      finish('')
    }
  })
}

/** 判断某个地址当前是否还挂在本机网卡上 */
export function isLocalAddress(address: string): boolean {
  return listNetworkOptions().some((item) => item.address === address)
}
