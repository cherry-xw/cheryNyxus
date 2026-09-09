# 前端文档

本目录对应 `web/`，维护浏览器界面、桌面端容器、工作台和桌宠等前端能力。跨前后端的消息格式与状态契约统一归入 [共享协议](../shared/protocol/README.md)，可复用的强制约束统一归入 [前端规范](../standards/frontend/README.md)。

## 模块导航

| 模块 | 文档 | 内容 |
| --- | --- | --- |
| 主 Agent 运行流程 | [runtime-diagram.md](./runtime-diagram.md) | 工作台流程观察、空间分配与历史回放 |
| 桌宠与 Nyxus | [pet/](./pet/README.md) | 桌宠领域模型、状态、运动、渲染及节点树工作台 |
| 身份认证 | [auth-login.md](./auth-login.md) | 修改首次登录、连接完成反馈与失败重试 |
| 桌面工作区 | [desktop-cyber-workspace.md](./desktop-cyber-workspace.md) | 修改窗口组织、关闭保护、菜单层级与诊断入口 |
| 多窗口工作台 | [workbench-multi-window.md](./workbench-multi-window.md) | 修改会话草稿、附件提交、分支与 Electron 多窗协作 |
| 设置中心 | [settings.md](./settings.md) | 修改保存与重载、未保存提示、标签导航和动效偏好 |
| 协议绑定 | [frontend-protocol-binding.md](./frontend-protocol-binding.md) | RPC、通知和流式数据到前端状态的映射 |
| 工具渲染 | [renderer.md](./renderer.md) | Agent 工具调用的前端渲染机制 |
| MCU Lite 工作台 | [mcu-lite-workbench-ui.md](./mcu-lite-workbench-ui.md) | MCU Lite profile 的工作台界面 |

## 平台与交付

| 文档 | 内容 |
| --- | --- |
| [env.md](./env.md) | 浏览器与 Electron 的运行环境抽象 |
| [electron.md](./electron.md) | Electron 主进程、preload 与窗口管理 |
| [deployment.md](./deployment.md) | Web 前端部署拓扑 |
| [pack-guide.md](./pack-guide.md) | Electron 打包操作 |

当前仍开放的前端问题、待用户人工复核项和明确暂缓的小问题统一见 [已知问题目录](../quality/known-issues/README.md)；模块文档不重复维护问题状态。

## 局部设计约定

| 文档 | 内容 |
| --- | --- |
| [font-style-guide.md](./font-style-guide.md) | 当前前端字体与字重约定 |
| [motion-standard.md](./motion-standard.md) | 当前前端动效约定 |

新的全局强制规则应写入 [前端规范](../standards/frontend/README.md)，不再继续扩充局部约定文件。已经完成或被替代的实施记录位于 [archive/](./archive/README.md)，不能作为当前实现入口。
