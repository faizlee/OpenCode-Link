# OpenCodex Link 文档与证据入口

> **文档处置**：`current-source`。这是产品决定、功能传播记录与交付证据的唯一导航；产品使用方式仍以仓库根目录 `README.md` 为准。

## 事实源顺序

1. `docs/product-decisions.json`：用户已确认的产品决定及明确延期项。
2. `README.md`：当前产品范围、运行方式、安全边界和验证边界。
3. `docs/desktop-console-design.md`：已确认的托盘、电脑管理台与 Redline 风格设计；源码为实现候选，真实验收仍待主控。
4. 当前 Git 提交与源码：真实实现状态。
5. `docs/lifecycle/*.decision.json`：每项决定同步到哪些当前消费者，以及下一步允许做什么。
6. `docs/lifecycle/*.receipt.json`：由校验器从对应 decision 文件生成的结构化回执，不代替真实手机验收或 Git 提交。

## 当前交付基线

- 实现提交：`3c97bac`（完整移动端交付）与 `0ffa34c`（重复扫码及固定名称迁移复用设备身份）。
- 自动验证：`npm run typecheck`、`npm test`、`npm run build` 通过；当前为 16 个测试文件、42 项测试，另有 PowerShell 5.1 身份/语法、隔离 Headless 托盘 IPC，以及便携包清单与隔离冒烟。
- 本机宿主验证：设置页、任务列表、历史同步、移动端布局、桌面入口说明、可信设备重启恢复与解除、重复扫码不新增设备、固定名称迁移不新增设备、固定名称 80→8787 转发通过。
- 历史正文保护：手机页面不再显示启动时注入的插件清单、AGENTS 指令和环境上下文，只显示真实用户消息。
- 启动配置：重复运行启动脚本后，四项 `CODEX_PWA_*` 受管配置各保留一份，现有密码不被替换。

## 已确认的下一阶段方向

- `DESKTOP-TRAY-WEB-CONSOLE-001` 仍保持 `contract_ready`：源码、托盘 Owner、五区 Redline 管理台和便携包已是实现候选，但真实 NotifyIcon、跨目录换版、目标机便携包和手机回归尚未人工验收。
- 管理台使用 faizleecom `time-ai-arms-race-2023@0.1.0` 的 Redline 视觉合同做界面化适配，不把文章组件或第三方品牌资产直接复制进软件。
- 下一步只允许主控完成合同中的本机真实验收；在此之前不把状态提升为 `delivery_integrated`，也不做 force、PR 或 release。

## 仍需真实手机复验

- 目标手机与当前 Wi-Fi 对 `.local` 的实际解析；失败时应继续停留在扫码得到的 IP 入口。
- 浏览器要求用户确认后的桌面图标安装与再次进入。
- 手机选择多附件、原生图片队列失败时的本地路径回退，以及电脑任务中的实际可读结果。

上述三项完成前，不把本轮状态提升为 `delivery_integrated`，也不宣称已经发布或具备公网访问能力。
