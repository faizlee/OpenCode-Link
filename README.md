# Codex PWA

面向手机的 Codex 极简界面。Codex、线程、项目文件、知识库与工具都运行在 Windows 电脑上，手机只负责选择线程、发送消息、查看实时输出、处理确认和停止任务。

## 先看这个结论

Codex Desktop 现在已经提供官方 Remote Control，ChatGPT 手机 App 的 Remote 标签可以直接继续电脑端正在运行的任务。它才是“电脑和手机同时控制同一个活动任务”的首选方案。

这个自建 PWA 是备用方案：它可以完整接管当前没有被其他 Codex 进程占用的任务；对于此刻正在 Codex Desktop 中打开的任务，可以读取历史，但独立的 `app-server` 会因为活动写入锁而拒绝第二个控制端。界面会明确显示只读提示，不会伪装成已经接管成功。

## 当前范围

- 读取并搜索本机已保存的 Codex 线程
- 恢复未被占用的现有线程并显示历史消息
- 向已接管的原线程发送新消息
- 只读查看当前被 Codex Desktop 占用的任务，并在电脑端回复完成后自动同步
- 实时显示由 PWA 控制的任务回答；命令、文件修改、推理和工具过程不在手机端展示
- 显示命令、文件修改、权限和用户问题请求
- 批准、拒绝或停止当前任务
- 手机断线后自动重连
- 安装为 PWA

目前不包含文件浏览器、代码编辑器、Git 面板或终端。

## 本地开发

需要 Node.js 22+ 和可用的 Codex Desktop/CLI 登录状态。

```powershell
npm install
npm run dev
```

浏览器打开 `http://127.0.0.1:5173`。开发模式默认只监听本机；未设置密码时不要对外开放端口。

## 构建与运行

复制 `.env.example` 为 `.env` 并通过进程环境提供密码，或直接：

```powershell
$env:CODEX_PWA_PASSWORD = '使用一个足够长的密码'
npm run build
npm start
```

默认地址为 `http://127.0.0.1:8787`。推荐让 Tailscale 的 HTTPS 入口反向代理这个本机地址，而不是把服务监听到公网。

也可以使用：

```powershell
.\scripts\start.ps1 -Password '使用一个足够长的密码'
```

脚本会重新构建当前源码再启动，避免页面仍是上一次的旧版本。`.env` 中的密码也会被脚本读取。

## 从手机进入

### 推荐：官方 Remote

1. 保持 Windows 上的 ChatGPT/Codex 桌面 App 打开，电脑不要休眠。
2. 手机更新到最新版 ChatGPT，并登录和电脑相同的账号与工作区。
3. 在手机 ChatGPT 中打开 **Remote** 标签，选择这台电脑，再进入目标任务。

本机状态显示这台电脑曾经完成过手机设备连接。如果手机看不到电脑，先到桌面 App 的 Remote Control 设置重新允许或配对。

### 备用：本 PWA

本机已经安装 Tailscale，但当前处于退出登录状态。先在电脑和手机登录同一个 Tailscale 网络，再把本地 `8787` 服务通过 Tailscale Serve 的 HTTPS 入口转发；不要直接向公网开放端口。

PWA 路径主要用于自定义界面或官方 Remote 不可用时。Codex Desktop 保持打开时，PWA 可以查看历史，并在电脑端回复完成保存后自动同步；它不能实时接收电脑端正在生成的片段，也不能同时写入该任务，这是当前 App Server 的写入锁边界。

## 安全边界

- 网页不接收或保存 Codex/ChatGPT 登录凭据。
- 浏览器只能调用转接服务公开的线程、对话、确认和停止操作，不能发送任意 App Server 方法。
- 登录会话保存在电脑内存中；电脑重启后需要重新登录。
- 生产访问必须使用密码与 HTTPS。
- 不要把 `8787` 端口直接暴露到公网。

## 协议兼容

本项目基于本机 `codex app-server` 的 JSON-RPC 协议。升级 Codex 后可执行：

```powershell
npm run protocol:generate
npm run typecheck
npm test
```

生成文件仅用于本地兼容检查，保存在 `work/protocol-schema`，不会提交到 Git。
