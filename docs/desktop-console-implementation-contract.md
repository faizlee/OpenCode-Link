# OpenCodex Link 托盘与 Redline 管理台实施合同

> Feature：`DESKTOP-TRAY-WEB-CONSOLE-001`
> 状态：`contract_ready` / 源码为 `implementation_candidate`；未做真实 NotifyIcon 与换版人工验收，不是 `delivery_integrated`
> 基线：分支 `codex/desktop-tray-redline`，工作区 `E:/work/project/codexPWA`
> 实施主控：Cursor CLI
> 用户授权：2026-08-27 当前对话明确要求开始实施

## 1. 真实用户成果

用户解压或更新 OpenCodex Link 后，只需启动一次即可看到 Windows 托盘图标。托盘负责后台服务的启动、停止、重启、状态、版本、退出和新旧版本切换；点击托盘后使用默认浏览器打开 Redline 风格电脑管理台。用户不再需要理解命令行进程，也不会因为打开新版压缩包而继续误用旧服务。

## 2. 当前运行合同

以下描述的是本分支已经落地的实现候选，不是人工验收通过。

2026-08-29 新确认并获授权实施的产品决定覆盖旧的多入口选择：用户绑定的是手机与电脑，添加手机只显示一个由服务端选定可靠初始入口的二维码；局域网、固定名称、Tailscale 与后续连接方式由软件内部探测和切换。当前源码已经移除三个用户选项，并把原先依赖旧地址在线的短时迁移票据升级为设备级可撤销路径凭据：每个来源地址获得独立 HttpOnly 会话，旧地址失联后仍可从浏览器缓存的可信候选切换，设备解除会同时使路径凭据和所有来源会话失效。仍需真实手机和目标机验收，不能据此写成 `delivery_integrated`。

- `OpenCodex Link.cmd -> scripts/launch.ps1` 只负责唤醒托盘；`scripts/tray.ps1` 是服务生命周期唯一 Owner。
- 开发目录若存在 `src` 才构建；便携包不含源码，日常启动只运行已构建产物。
- `GET /api/health` 在兼容字段之外提供 `productId`、`version`、`buildId`、`instanceId`。`GET /api/runtime` 仅回环，不返回 `controlToken`。停止优先走回环 `POST /api/runtime/shutdown` 加控制令牌。
- `scripts/stop.ps1` 先请求托盘，再按 `runtime.json`、进程与回环身份证明停止；分类为 Unknown/Unproven 时拒绝，不按端口杀进程。
- 托盘命名管道只负责入队；命令由 UI/Headless 主线程处理，避免独立 runspace 调用主线程函数。
- 设备授权仍在 `%LOCALAPPDATA%/OpenCodexLink/trusted-devices.json`，不在便携包目录；二维码是唯一授权入口，旧版密码配置不再参与认证。
- 路径凭据只由已认证设备获取，使用设备主令牌哈希签名，不暴露主会话令牌；浏览器通过 URL fragment 携带凭据到可信私网候选，新地址验证后签发独立 HttpOnly 会话并立即清除 fragment。候选只允许物理私网、`opencodexlink.local`、Tailscale CGNAT 与 `.ts.net`，不得把凭据带到任意公网来源。
- 手机页面每 8 秒以及网络恢复、窗口聚焦和重新可见时刷新候选；当前地址失联时使用已缓存候选继续探测。当前地址可用时只向更稳定的固定名称或 Tailscale 迁移，避免在可用来源之间循环跳转。
- `/setup/*` 进入五区管理台；二维码按需签发。手机 `/` 仍是原任务界面。
- 手机读取 Desktop 历史时，同一任务存在多份续接 JSONL 必须选择最后修改的有效文件；已经缓存的旧文件需定期重新发现并切换到新文件，不能要求用户重启或清缓存。
- Windows 便携包含 `dist`、`dist-server`、生产 `node_modules`、捆绑 Node、托盘模块/脚本/图标、README、cmd 与 package 元数据；不含 `src`、`server` 源码、`.env`、真实设备数据或凭据。覆盖同一解压目录时保留其他 `.env` 配置并移除旧版密码项。

## 3. 技术选型

使用 Windows 自带 `powershell.exe -STA`、`System.Windows.Forms.NotifyIcon` 和现有打包内 Node 运行时：

- 不增加 Electron、Tauri、WebView2 或完整原生窗口。
- 托盘只承载菜单、状态和生命周期控制；管理内容继续使用现有 React 网页。
- 托盘图标从本仓库现有 OpenCodex Link 图标资产派生，不引入第三方品牌资产。
- 开机启动和便携包日常启动只运行已构建产物，不在每次登录时执行 `npm install` 或 `npm run build`。

## 4. Owner 与身份

### 托盘 Owner

- 每个 Windows 用户只允许一个托盘实例，使用用户级命名互斥量。
- 托盘是服务生命周期唯一 Owner；命令脚本只负责唤醒、交接或应急入口。
- 托盘提供：打开管理台、启动、停止、重启、日志、开机启动、版本、退出。
- 关闭浏览器不停止服务；退出托盘时必须明确是否同时停止服务。

### 持久运行证明

在 `%LOCALAPPDATA%/OpenCodexLink/` 保存：

- `tray.json`：schema、productId、trayPid、version、buildId、installRoot、startedAt、controlPipe。
- `runtime.json`：schema、productId、servicePid、version、buildId、instanceId、installRoot、port、startedAt、controlToken。

运行证明只能用于识别本产品；PID 必须同时核对进程仍存在、启动时间/命令行/安装根和回环握手，不能单凭陈旧文件结束进程。

### HTTP 身份

- `GET /api/health` 保留现有兼容字段，并新增无敏感信息的 `productId`、`version`、`buildId`、`instanceId`。
- `GET /api/runtime` 只允许回环访问，返回服务身份、安装根、数据根、端口和启动时间，不返回控制令牌。
- 停止/重启/替换由托盘执行；网页若提供操作，只能向托盘提出请求，不能自行成为 Owner。

## 5. 新旧版本安全切换

1. 新入口读取托盘运行证明并尝试与已知托盘通信。
2. 同一版本/安装根已运行时只唤醒托盘并打开管理台。
3. 版本或安装根不同且旧托盘身份可证明时，先请求旧托盘停止其服务并退出。
4. 再核对服务 `runtime.json`、回环 `/api/runtime` 与真实进程；身份一致才允许停止。
5. 等待端口释放后启动新版服务，核对新 version/buildId/instanceId，再打开管理台。
6. 新版启动失败时保留错误和日志，不删除用户数据，不自动启动未知旧目录。
7. 端口被未知进程占用、旧服务身份无法证明或基线漂移时停止切换并给出明确错误；禁止按端口强制结束未知进程。

当前没有 `/api/runtime` 的旧 OpenCodex Link 只允许在健康响应、命令行、工作目录和产品文件多项证据同时匹配时作为前任替换。开发态服务可以明确识别或明确拒绝，但不得误杀其他 Node 进程。

## 6. 数据与配置

- 保持 `%LOCALAPPDATA%/OpenCodexLink/trusted-devices.json` 和 `uploads/` 位置不变。
- 安装、换目录、升级、停止或重启不得清空、迁移或按名称合并受信任设备。
- 设备改名只修改 `name`；不修改 id、tokenHash、cookie 或创建新记录。
- 批量解除只处理用户明确选择的设备 ID。
- 长期未使用设备只在界面折叠，不自动删除；首版折叠阈值为 30 天。
- `.env` 仍属于安装目录；启动器只维护 Host、端口和局域网名称，并清除旧版 `CODEX_PWA_PASSWORD`。换目录启动不得覆盖设备登记表。

## 7. 电脑管理台

路由仅作用于电脑管理台：

- `/setup`：概览。
- `/setup/devices`：设备。
- `/setup/connection`：连接。
- `/setup/settings`：设置。
- `/setup/about`：关于。

`/setup/*` 必须始终进入管理台；手机 `/`、`/thread/*`、消息和附件职责不变。手机认证改为二维码唯一授权，未配对设备只显示扫码指引。

### 概览

- 服务状态、Codex 可用性、服务/托盘版本、设备数、固定地址状态和异常。
- 主操作“添加手机”，次操作“复制访问地址”。
- 二维码只在用户点击后签发，带倒计时和刷新；添加手机主路径只显示一个二维码。检测到 Tailscale 时服务端优先把该地址放入唯一二维码，否则退回物理局域网或固定名称；局域网、固定名称与 Tailscale 选择全部退出用户操作面并收进技术详情，用户不得被要求复制、记忆或手工打开技术地址。

### 设备

- 名称、类型、最近使用、首次添加、可靠时的当前设备标记。
- 默认名称优先使用请求中可靠提供的手机型号：先用 `Sec-CH-UA-Model`，再用 Android User-Agent 中 `Build/` 前的型号；缺失或降级值只回退到可证明的设备类型，不猜具体机型。
- 同一设备的泛化默认名称可以在后续有效访问时升级为型号；用户手动改名是更高优先级，后续识别不得覆盖。
- 改名、单独解除、勾选批量解除、30 天未使用折叠。
- 不按名称、IP 或 User-Agent 自动合并设备。

### 连接

- 固定名称、当前物理局域网地址、Tailscale 候选、软件当前使用路径、80 转发/8787 回退状态；这些只用于状态和诊断。
- 网络技术详情默认折叠；状态读取不得签发配对票据。
- mDNS 只广播物理局域网地址；Tailscale 只作为内部连接候选、技术状态和已授权设备的同身份迁移路径，不提供独立用户二维码。

### 设置与关于

- 展示开机启动、启动后打开管理台、浏览器关闭后保持服务、附件清理说明。
- 生命周期变化由托盘确认和执行。
- 展示托盘/服务版本、buildId、instanceId、最近启动、日志与数据目录。

## 8. Redline 适配

只把 faizleecom `time-ai-arms-race-2023@0.1.0` 的已确认视觉语言转成本仓库静态 token，不建立跨仓库运行时依赖：

- 暖白 `#fffcf8`、近黑 `#1b1b1b`、信号红 `#e7131a`、次要文字 `#594d46`、细线 `#efe3dc`。
- 一级标题使用中文衬线字体栈；操作、正文、状态和数据使用无衬线字体栈。
- `4/8/12/16/24/32/48` 间距、1px 边框、无装饰阴影。
- 使用扁平分区和行式信息，不使用卡片矩阵、蓝紫霓虹、玻璃拟态、发光 AI 装饰或程序灰盒。
- 不复制 TIME Logo、刊名、封面框、图片、专有字体或文章语义组件。
- 信号红不能单独表示运行、成功、警告、错误和解除；状态必须有文字或图标。
- Redline 样式只挂在 `/setup/*` 管理台根节点，不污染手机深色任务界面。

## 9. 精确实现范围

允许修改：

- `OpenCodex Link.cmd`、`Stop OpenCodex Link.cmd`。
- `scripts/launch.ps1`、`scripts/stop.ps1`、`scripts/start.ps1`、`scripts/package-windows.ps1`，新增托盘脚本与必要的 PowerShell 辅助模块/测试。
- `package.json` 和构建/打包元数据。
- `server/index.ts`、`server/session.ts`，新增运行身份、连接状态、托盘控制适配及对应测试。
- `src/App.tsx`、`src/styles.css`、`src/navigation.ts`，新增隔离的管理台组件和测试。
- 当前产品 README、设计、生命周期 manifest/receipt 与交付证据。

永久禁止：

- force push、release、PR、远端分支删除或外部发布。
- 结束未知进程、清理用户数据、变更设备凭证语义。
- 完整原生桌面重做或引入明显膨胀运行时。
- 用灰盒占位交付管理台，或复制第三方品牌/资产。
- 借机修改手机任务、消息、附件或 Codex 生命周期语义。

## 10. 验收矩阵

### 自动验证

- `npm run typecheck`、`npm test`、`npm run build`、`npm run package:windows`。
- 身份分类：新版、本产品前任、未知占用、陈旧 PID、版本/安装根不一致。
- 隔离 Headless 托盘 IPC：ping/status/open/stop/start、同版本第二次 launch 唤醒、不同版本 shutdown-for-replace 释放 mutex；不启动真实 NotifyIcon，不触碰 live LOCALAPPDATA 与 8787。
- 设备改名不新增、不换 token；批量解除精确；重启保留；坏 JSON 不被空表覆盖。
- `/setup/*` 路由不落入手机授权页；概览不自动签发二维码；连接状态查询不签发票据；空密码和旧密码均不能放行未配对设备。
- Tailscale CGNAT 地址只从 Tailscale 网卡进入内部候选，不进入物理 LAN/mDNS 列表；添加手机界面只显示一个二维码，跨路径自动切换不新增设备记录。
- 日志读取覆盖“启动时已有新旧两份同 ID 文件”和“运行中新增更晚文件”两种路径；两者都必须返回新文件内容，当前任务列表摘要也必须取最新用户消息。
- Redline 管理台与手机样式作用域隔离。

### 本机真实验收

1. 托盘图标可见，菜单显示真实运行/停止/异常状态。
2. 点击托盘打开默认浏览器 `/setup`；关闭浏览器后服务继续响应。
3. 托盘可以停止和重启服务，页面重连后状态正确。
4. 从两个不同目录模拟旧版与新版：新版停止旧托盘和旧服务后启动，设备 ID 与数量不变。
5. 无关进程占用目标端口时，新版明确拒绝且该进程仍存活。
6. 五区可导航；二维码按需且只显示一个绑定入口，不出现局域网/固定名称/Tailscale 选择；设备改名/单删/批量；连接状态不发票据。
7. 桌面 Redline 体验完整；390px 无严重横向溢出、主操作可达、状态不只靠颜色。
8. 手机 `/` 仍是原有任务界面；真实历史、消息和附件路径没有回归。
9. Windows 便携包包含 Node、托盘、图标与说明，不包含 `.env`，目标机不要求额外安装运行时。

## 11. 停止线

遇到无法证明的进程身份、需要改写设备 schema/凭证、必须引入新大型运行时、产品语义冲突或无法保留现有数据时立即停止并报告。普通实现与测试问题由 Cursor 在本分支内继续修复，不上升为用户阻塞。
