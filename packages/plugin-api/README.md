# 插件公共接口

`src/index.ts` 拥有插件生命周期、资源、请求身份、配置和管理路由契约；`sense.ts` 与 `hooks.ts` 提供插件注册所需的结构类型。只依赖协议包和 Zod，不导入 Backend 实现。

Backend 的宿主适配由 `apps/backend/src/service/ingress` 实现。插件通过 `@chery/plugin-api` 导入契约，通过 `context` 使用受保护能力。验证：`pnpm exec tsc --noEmit -p packages/plugin-api/tsconfig.json`。
