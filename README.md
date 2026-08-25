# Codex PWA

面向手机的 Codex 极简界面。Codex、线程、项目文件、知识库与工具都运行在 Windows 电脑上，手机只负责选择线程、发送消息、查看实时输出、处理确认和停止任务。

## 工作方式

这个 PWA 不远程传输电脑画面。手机读取电脑上的 Codex 任务；如果任务正在 Codex Desktop 中打开，手机消息通过 Codex 本机队列投递给 Desktop，Desktop 继续运行同一个任务，PWA 再同步回答。

未被 Desktop 占用的任务仍可由 PWA 的 `app-server` 直接恢复和运行。因此电脑端不需要为了手机查看或发消息而关闭 Codex。

## 当前范围

- 读取并搜索本机已保存的 Codex 线程
- 恢复未被占用的现有线程并显示历史消息
- 向已接管的原线程发送新消息
- 向当前被 Codex Desktop 占用的任务排入消息，并自动同步电脑端回答
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

保持 Windows 上的 Codex Desktop 和本 PWA 服务运行，电脑不要休眠。手机连接同一个 Tailscale 网络后访问电脑的 `8787` 地址。

Desktop 占用的任务通过本机队列接收手机消息。由于 PWA 对这类任务采用每 2 秒读取一次保存结果的方式，回答可能比电脑界面晚几秒出现，也不显示电脑端尚未保存的流式片段。

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
