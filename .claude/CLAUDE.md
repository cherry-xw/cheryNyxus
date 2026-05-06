# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

cheryClaw 是一个基于 LangGraph.js 的智能代理框架项目，使用 TypeScript 构建 ESM 模块。

## 常用命令

```bash
# 安装依赖
yarn install

# 构建项目
yarn build

# 运行单元测试 (.test.ts 文件)
yarn test

# 运行集成测试 (.int.test.ts 文件)
yarn test:int

# 运行所有测试
yarn test:all

# ESLint 检查
yarn lint

# 格式化代码
yarn format

# 运行所有 lint 检查 (ESLint + langgraph.json 验证 + 格式检查)
yarn lint:all

# 验证 langgraph.json 中的路径配置
yarn lint:langgraph-json

# 清理构建产物
yarn clean
```

## 核心架构

### Agent 图结构

- **入口点**: `src/agent/graph.ts:graph` (定义在 `langgraph.json`)
- **状态定义**: `src/agent/state.ts` - 使用 `StateAnnotation` 定义消息状态和 reducer
- **图构建**: 使用 `StateGraph` 构建节点和边，支持条件路由 (`addConditionalEdges`)
- **路由函数**: `route()` 决定图执行流程，返回 `"__end__"` 或节点名称

### Middleware 系统

使用 `chery-fetch` 包的 Middleware 类实现中间件链：
- `src/middleware/index.ts` - 中间件入口和组合
- `src/middleware/mdwLLMError.ts` - LLM 错误处理
- `src/middleware/mdwToolCall.ts` - 工具调用处理
- `src/middleware/mdwMemory.ts` - 内存/状态管理

### Tools

工具定义在 `src/tool/` 目录，为 agent 提供具体能力：
- `read.ts` - 文件读取
- `write.ts` - 文件写入
- `ls.ts` - 目录列表

## 配置说明

- **包管理器**: yarn 1.22.22 (通过 `yarn install --immutable` 安装)
- **Node.js**: 需要 20+ 版本
- **模块类型**: ESM (`"type": "module"`)
- **LLM 配置**: `config.json` 定义 API 配置 (apiKey, baseUrl, model)
- **环境变量**: `.env` 中配置 `LANGSMITH_API_KEY`

## 测试约定

- 单元测试: `*.test.ts` 文件后缀
- 集成测试: `*.int.test.ts` 文件后缀
- Jest 配置支持 ESM，使用 ts-jest preset
- 测试超时默认 20 秒，可在测试中覆盖

## 代码风格

- ESLint 配置禁止直接使用 `process.env` (rule: `no-process-env: 2`)
- 禁止使用 `instanceof` (使用 `chery-fetch` 提供的类型检查替代)
- Biome 作为默认 formatter (配置在 `biome.json`)
- Prettier 用于额外格式化
- 导入必须带 `.js` 扩展名 (`import/extensions: [2, "ignorePackages"]`)