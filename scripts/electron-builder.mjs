// electron-builder 包装器，解决三类在普通 Windows 账户 / 沙箱 / 受管终端下必现的打包失败：
//
// 1. 下载缓存写到用户目录被拒：
//    默认情况下 Electron 压缩包会被下载到 %LOCALAPPDATA%\Electron\Cache，
//    nsis / winCodeSign 等工具链会被下载到 %LOCALAPPDATA%\electron-builder\Cache。
//    在沙箱、受管终端或某些安全软件环境下，这两个目录不可写，打包就会失败：
//      ⨯ open C:\Users\<user>\AppData\Local\Electron\Cache\xxxx.zip.partN: Access is denied.
//      app-builder.exe process failed ERR_ELECTRON_BUILDER_CANNOT_EXECUTE
//    这里把两类缓存固定到项目内的 `.cache/`，无论环境是否受限都能正常下载，也不污染用户目录。
//
// 2. winCodeSign 工具链解压需要符号链接权限：
//    winCodeSign-2.6.0.7z 里带有 macOS 的 .dylib 符号链接，Windows 上解压它会要求
//    「创建符号链接」特权（管理员运行或开启“开发者模式”才有），普通账户直接报：
//      ERROR: Cannot create symbolic link : 客户端没有所需的特权 : ...\darwin\10.12\lib\libcrypto.dylib
//    而 Windows 打包只需要其中的 rcedit / signtool，darwin 部分完全用不到。
//    因此打包前先自行解压一次（跳过 darwin 目录）到 electron-builder 期望的缓存位置，
//    这样无需管理员权限即可打包。
//
// 3. NSIS 的 !tempfile 在受限环境里会失败：
//    electron-builder 用 makensis 编译安装包脚本，脚本里 `${Switch}`（LogicLib 的 _Switch 宏）
//    依赖 !tempfile 写临时文件。若 TEMP/TMP 指向工作区之外的目录（沙箱、受管终端会限制写入），
//    就会报：
//      !tempfile: Unable to create temporary file!
//      Error in macro _Switch on macroline 8
//      Error in macro PAGE_INSTALL_MODE on macroline 17
//    所以把构建期的 TEMP/TMP 指到项目内的 `.tmp/`，避免这类与项目本身无关的失败。
//
// 用法与 electron-builder 完全一致（多出的参数会原样透传）：
//   node scripts/electron-builder.mjs --win --x64 --ia32 --arm64
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const cliArgs = process.argv.slice(2)

const cacheRoot = join(projectRoot, '.cache')
const buildTemp = join(projectRoot, '.tmp')
const caches = {
  // Electron 二进制（app-builder 下载的 electron-vX-win32-x64.zip 等）
  ELECTRON_CACHE: join(cacheRoot, 'electron'),
  // electron-builder 工具链（nsis、winCodeSign、app-builder 等）
  ELECTRON_BUILDER_CACHE: join(cacheRoot, 'electron-builder')
}

// 与 electron-builder 24.x 内部使用的工具链版本保持一致；版本不一致时 electron-builder
// 只会当作没命中缓存、按自己的方式重新下载，不会因此打包失败。
const WIN_CODE_SIGN_DIR = 'winCodeSign-2.6.0'

for (const dir of Object.values(caches)) {
  mkdirSync(dir, { recursive: true })
}
mkdirSync(buildTemp, { recursive: true })

function isWindowsTarget() {
  const flags = cliArgs.map((arg) => arg.toLowerCase())
  if (flags.some((arg) => arg === '--win' || arg === '--windows' || arg === '-w')) {
    return true
  }
  if (flags.some((arg) => arg === '--linux' || arg === '-l' || arg === '--mac' || arg === '-m')) {
    return false
  }
  // 不指定平台时 electron-builder 按当前系统打包
  return process.platform === 'win32'
}

async function ensureWinCodeSign() {
  if (!isWindowsTarget()) {
    return
  }

  const codeSignDir = join(caches.ELECTRON_BUILDER_CACHE, 'winCodeSign')
  const targetDir = join(codeSignDir, WIN_CODE_SIGN_DIR)
  if (existsSync(join(targetDir, 'rcedit-x64.exe'))) {
    return
  }

  try {
    const archive = await findWinCodeSignArchive(codeSignDir)
    const sevenZip = require('7zip-bin').path7za
    mkdirSync(codeSignDir, { recursive: true })

    // 跳过 darwin：这些文件是指向 macOS 库的符号链接，Windows 上既用不到也创建不了
    const result = spawnSync(
      sevenZip,
      ['x', '-bd', `-o${targetDir}`, archive, '-x!darwin\\*'],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    )
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      throw new Error(`7za exited with code ${result.status}`)
    }
    if (!existsSync(join(targetDir, 'rcedit-x64.exe'))) {
      throw new Error('rcedit-x64.exe 未解压出来')
    }
    console.log(`[electron-builder] winCodeSign 已预置：${targetDir}`)
  } catch (error) {
    // 失败就交回 electron-builder 自己处理（例如管理员/开发者模式下它能直接解压成功），
    // 只是别让这里抛错掩盖真正的打包结果。
    console.warn(`[electron-builder] 预置 winCodeSign 失败，交由 electron-builder 自行下载解压：${error.message}`)
    rmSync(targetDir, { recursive: true, force: true })
  }
}

async function findWinCodeSignArchive(codeSignDir) {
  if (existsSync(codeSignDir)) {
    // electron-builder 之前下载失败时会把 .7z 留在缓存里，直接复用
    const cached = readdirSync(codeSignDir).find((name) => name.toLowerCase().endsWith('.7z'))
    if (cached != null) {
      return join(codeSignDir, cached)
    }
  }

  // 与 electron-builder 的 binDownload 相同的镜像解析顺序，保证内网/镜像环境一致
  const baseUrl =
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    process.env.npm_config_electron_builder_binaries_mirror ||
    'https://github.com/electron-userland/electron-builder-binaries/releases/download/'
  const middleUrl =
    process.env.ELECTRON_BUILDER_BINARIES_CUSTOM_DIR ||
    process.env.npm_config_electron_builder_binaries_custom_dir ||
    WIN_CODE_SIGN_DIR
  const url = `${baseUrl.replace(/\/?$/, '/')}${middleUrl}/${WIN_CODE_SIGN_DIR}.7z`

  console.log(`[electron-builder] 下载 winCodeSign：${url}`)
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`下载失败 ${response.status} ${response.statusText}`)
  }

  const archive = join(codeSignDir, `${WIN_CODE_SIGN_DIR}.7z`)
  mkdirSync(codeSignDir, { recursive: true })
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
  return archive
}

await ensureWinCodeSign()

const electronBuilderPkg = require.resolve('electron-builder/package.json')
const electronBuilder = require(electronBuilderPkg)
const cliEntry = join(dirname(electronBuilderPkg), electronBuilder.bin['electron-builder'])

const args = [
  cliEntry,
  // 显式传入配置，确保 Electron 下载缓存落在项目内（环境变量之外的双保险）
  `-c.electronDownload.cache=${caches.ELECTRON_CACHE}`,
  ...cliArgs
]

console.log(`[electron-builder] cache: ${cacheRoot}`)
console.log(`[electron-builder] temp: ${buildTemp}`)

const child = spawn(process.execPath, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    ...caches,
    // NSIS 的 !tempfile 需要可写目录，统一放到项目内（见文件头说明 3）
    TEMP: buildTemp,
    TMP: buildTemp
  }
})

child.on('error', (error) => {
  console.error(`[electron-builder] failed to start: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    // 让父进程以同样的方式被终止，保留 Ctrl+C 等行为
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
