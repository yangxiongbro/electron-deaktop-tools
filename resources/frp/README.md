# FRP 客户端放置目录

把 frp 官方的 `frpc` 可执行文件放到这里，打包时会一起带进安装包
（打包后位于 `<安装目录>/resources/frp/frpc.exe`），本地聊天里的「跨网络（FRP）」
就不用再手动选路径了。

- 下载地址：<https://github.com/fatedier/frp/releases>（选 `*_windows_amd64.zip` 之类的平台包）
- Windows 放 `frpc.exe`，Linux / macOS 放 `frpc` 并保留可执行权限
- 这个目录里只放 frpc 即可，`frps` 是服务器端的程序，不需要放进安装包
