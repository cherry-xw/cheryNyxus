# Manager 与插件管理交互

**文档创建时间：** 2026-10-17T13:48:56+08:00

**状态：** 待综合验证

**计划形式：单页**

## 范围与当前状态

Manager内容尺寸、可调整插件窗口、插件列表、QQ设置分类、队列/历史及管理员详情均已实现。Manager与QQ新包已部署，QQ活动版本0.1.32，配置已应用，NapCat连接与可信身份正常。保留登录、配置、权限及用户文件。设置包保持既有运行版本，不能把构建版本当成已安装版本。

当前契约见[Manager插件](../../shared/architecture/manager-plugins.md)、[QQ管理接口](../../shared/architecture/ingress-plugins.md#qq-管理api)和[QQ模块](../../../plugins/qq/README.md)。

## 当前恢复检查点

源码、构建和部署已完成，剩余为[人工验收](verify/manual-final.md)。Manager178项、QQ84项测试及类型、构建检查已通过，不代替真实界面验证。自动验证不启动浏览器、不读取图片、不向真实QQ发送测试消息。

## 验证入口

- `pnpm manager:type-check`、`pnpm qq-ingress:type-check`、`pnpm manager:test`、`pnpm qq-ingress:test`。
- `pnpm manager:build`、`pnpm qq-ingress:build`。
- Vue类型检查：根目录运行 `pnpm --filter web exec vue-tsc --noEmit -p ../../docs/plan/manager-plugin-interactions/verify/tsconfig.ui.json`，只检查源码，不操作页面。
- `pnpm docs:check` 与 `pnpm docs:test`。

## 剩余完成条件

用户核对窗口大小/拖动/最大化、分类切换保留草稿、保存后读回、记录分页及详情的实际显示。版本冲突和未知写入不得自动重试。人工验收完成后移除此计划及临时验证入口，有效验证方法归正式模块。
