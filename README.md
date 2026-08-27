# OpenCodex Link

> **文档处置**：`current-source`。这是当前产品范围、使用方式与安全边界入口；正式产品决定见 `docs/product-decisions.json`，交付证据导航见 `docs/README.md`。

面向手机的 Codex 极简界面。Codex、任务、项目文件、知识库与工具都运行在 Windows 电脑上，手机只负责选择任务、发送消息和查看回答。

## 工作方式

这个 PWA 不远程传输电脑画面。手机只读取电脑上的 Codex 任务，消息通过 Codex 本机队列投递给 Desktop，Desktop 运行同一个任务，PWA 再同步回答。

PWA 永远不会调用 `thread/resume` 或直接启动回合，因此不会成为任务的第二个写入者，也不会阻止 Desktop 打开任务。电脑端不需要为了手机查看或发消息而关闭 Codex。

## 当前范围

- 读取并搜索本机已保存的 Codex 线程
- 只读打开现有任务并显示历史消息，不获取写入锁
- 向电脑端任务排入消息，并自动同步电脑端回答
- 从手机一次选择并发送多个附件；优先使用 Codex 原生图片输入，不可用时自动改用电脑本地附件
- 命令、文件修改、推理和工具过程留在电脑端，不在手机端展示
- 手机断线后自动重连
- 完整的移动网页界面；通过 HTTPS 访问时可安装为 PWA

目前不包含文件浏览器、代码编辑器、Git 面板或终端。

附件入口不按扩展名限制 Codex 的能力。图片会按文件内容识别为 JPEG、PNG 或 WebP，并优先通过 `codex queue --image` 发送。当前 Windows Desktop 队列若拒绝原生图片，OpenCodex Link 会自动保留图片到 `%LOCALAPPDATA%\OpenCodexLink\uploads` 并把本地路径送进同一任务，不要求手机重新发送；PDF、Office、文本、代码、音频、压缩包等其他文件也走电脑本地附件。最终能否读取及如何处理，由电脑端 Codex 当前已有工具和权限决定。当前每次最多20个附件、单个不超过50MB、总计不超过200MB，成功排队的临时副本24小时后自动清理。

## 当前验证边界

- 当前源码必须通过 `npm run typecheck`、`npm test` 和 `npm run build`。
- 本机宿主验证覆盖设置页、任务列表、历史同步、移动端布局、可信设备重启恢复与解除、固定名称端口转发和 Windows 便携包。
- 不把电脑浏览器验证冒充手机验收。真实手机上的 `.local` 解析、桌面图标安装和附件发送仍需在目标手机与 Wi-Fi 环境中复验；不支持固定名称时继续使用扫码得到的 IP 入口。

## 电脑端托盘与管理台（实现候选）

源码已落地轻量 Windows 托盘作为后台服务生命周期的唯一 Owner，以及默认浏览器中的五区 Redline 管理台。这是实现候选，不是已完成交付：真实 NotifyIcon 可见性、跨目录换版、目标机便携包和手机回归仍待主控人工验收，因此不把状态写成 `delivery_integrated`。

- 双击 `OpenCodex Link.cmd` 会唤醒托盘；由托盘启动或交接后台服务，并用默认浏览器打开本机管理台。
- 关闭浏览器不会停止服务；退出托盘时会确认是否同时停止服务。
- 管理台路由为 `/setup`、`/setup/devices`、`/setup/connection`、`/setup/settings`、`/setup/about`。二维码只在点击「添加手机」后签发。
- 新版只停止能够证明属于 OpenCodex Link 的旧实例；端口被未知进程占用时明确拒绝，不按端口杀进程。
- 设备授权仍在 `%LOCALAPPDATA%\OpenCodexLink\`，不在便携包目录。升级或换目录不得把凭据打进压缩包。

手机端继续使用现有网页/PWA 任务界面。详细设计见 [`docs/desktop-console-design.md`](docs/desktop-console-design.md)。

## 本地开发

需要 Node.js 22+ 和可用的 Codex Desktop/CLI 登录状态。

```powershell
npm install
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。开发模式默认只监听本机；未设置密码时不要对外开放端口。

## 最简单的局域网使用方式

双击项目根目录的 `OpenCodex Link.cmd`。日常启动由托盘 Owner 管理：开发目录若仍有 `src` 会先构建，便携包没有源码则直接启动已构建产物。托盘负责后台服务，并在电脑浏览器打开管理台：

```text
http://127.0.0.1:8787/setup
```

在概览中点击「添加手机」后再扫描二维码。二维码只包含局域网地址和一个五分钟有效的临时凭证，不包含 Codex/ChatGPT 登录信息。

手机端的日常入口优先使用固定名称，不需要记住电脑 IP 或端口：

```text
http://opencodexlink.local
```

第一次扫码始终使用最可靠的当前 Wi-Fi/网线地址。进入后页面会在后台探测固定名称：当前手机和网络支持时自动切换，以后电脑 IP 变化也不受影响；不支持时留在已经可用的入口，不要求手机用户判断或配置。电脑端会自动完成局域网名称广播和内部端口转发。如果电脑的默认 HTTP 端口已经被其他程序占用，固定入口会自动退回 `:8787`，主服务仍可正常使用。

二维码只负责新增尚未授权的设备。扫码成功后，手机会登记为长期受信任设备；以后在同一个局域网里直接打开页面或手机桌面入口即可，会话会在每次使用时自动续期，不需要定期重新扫码。同一浏览器重复扫码只刷新原设备，不会增加重复记录；首次配对后从 IP 入口自动切换到固定名称时，也沿用同一个设备身份。只有主动解除该设备、清理手机浏览器数据，或原设备身份确实丢失后，重新配对才会新增记录。通过固定名称访问时，电脑局域网 IP 变化不需要重新配对。

第一次扫码进入后，页面会引导把 OpenCodex Link 添加到手机桌面。浏览器会要求用户确认一次，这是手机系统禁止网页静默安装图标的安全规则。完成后日常路径只有“点击桌面图标”，网络地址、端口和会话续期全部由电脑端软件处理。

电脑配对页会显示全部受信任设备，可以单独解除某台手机。设备授权保存在 Windows 用户数据目录，而不是便携包目录，因此移动或升级软件包不会自动丢失配对记录。

软件只选择真实的 Wi-Fi 或有线网卡地址，会排除 Tailscale、蒲公英、WSL、Hyper-V 等虚拟网卡。停止时双击 `Stop OpenCodex Link.cmd`。

## 构建与运行

复制 `.env.example` 为 `.env` 并通过进程环境提供密码，或直接：

```powershell
$env:CODEX_PWA_PASSWORD = '使用一个足够长的密码'
npm run build
npm start
```

默认监听 `0.0.0.0:8787`，供同一局域网内的手机访问。不要在路由器上把这个端口映射到公网。

也可以使用：

```powershell
.\scripts\start.ps1 -Password '使用一个足够长的密码'
```

脚本会重新构建当前源码再启动，避免页面仍是上一次的旧版本。`.env` 中的密码也会被脚本读取。

## Windows 便携包

```powershell
npm run package:windows
```

生成 `release/OpenCodexLink-Windows.zip`。解压后即可使用，包含：

- 前端 `dist`、服务 `dist-server`、生产 `node_modules`、捆绑的 `runtime/node.exe`
- `package.json`、`package-lock.json`、`build-info.json`、README
- 托盘脚本与模块、图标、`OpenCodex Link.cmd` / `Stop OpenCodex Link.cmd`

包内不含 `src`、`server` 源码、`.env`、真实设备数据或凭据。目标电脑不需要另装 Node.js。启动默认由托盘管理；设备数据继续使用固定的 `%LOCALAPPDATA%\OpenCodexLink\`。覆盖同一解压目录时保留已有 `.env` 密码，但密码不会进入 zip。

仓库内可用 `npm run test:package` 校验包清单，并在临时目录、随机非 8787 端口探测 `/api/health`、`/api/runtime` 和 `/setup`。`scripts/OpenCodexLink.Tests.ps1` 另含隔离 Headless 托盘 IPC（ping/status/stop/start/同版本唤醒/换版释放 mutex），不创建真实 NotifyIcon，也不触碰 live LOCALAPPDATA 与 8787。

## 从手机进入

保持 Windows 上的 Codex Desktop 和本服务运行，电脑不要休眠。手机连接同一个 Wi-Fi 后扫描电脑配对页上的二维码。

Desktop 占用的任务通过本机队列接收手机消息。PWA 每 2 秒增量读取 Desktop 正在写入的本机任务日志，因此长任务经过上下文压缩后也会继续显示最新对话；页面标题下会显示最近同步时间。回答可能比电脑界面晚几秒出现，也不显示尚未写入日志的流式片段。

## 安全边界

- 网页不接收或保存 Codex/ChatGPT 登录凭据。
- 手机上传的附件只进入这台电脑的本地临时目录，不上传到 OpenCodex Link 自建云服务；是否由 Codex 进一步处理取决于用户发送的任务及 Codex 本身的运行方式。
- 浏览器只能调用转接服务公开的线程、对话、确认和停止操作，不能发送任意 App Server 方法。
- 受信任设备凭证保存在 Windows 用户数据目录并在正常使用时续期；电脑服务重启不会自动取消设备授权。
- 手工输入密码的登录方式仍然保留；局域网扫码使用短时配对凭证。
- 短时二维码只用于新增设备；有效设备重复扫码及 IP→固定名称迁移都会复用原设备身份，不会重复登记。
- 扫码后的受信任设备没有固定30天失效规则，并在正常使用时持续续期。
- 电脑端可以单独撤销任何已配对设备；手机主动退出也会撤销当前设备。
- 当前局域网方式使用 HTTP，只适合可信的家庭或办公局域网。
- 局域网 HTTP 可以完整使用页面，但部分手机浏览器只允许把它添加为桌面快捷方式；正式 PWA 安装需要后续的 HTTPS 外网通道。
- 不要把 `8787` 端口直接暴露到公网。

## 协议兼容

本项目基于本机 `codex app-server` 的 JSON-RPC 协议。升级 Codex 后可执行：

```powershell
npm run protocol:generate
npm run typecheck
npm test
```

生成文件仅用于本地兼容检查，保存在 `work/protocol-schema`，不会提交到 Git。
