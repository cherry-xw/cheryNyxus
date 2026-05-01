# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

cheryClaw 是一个 TypeScript 项目，用于与多个 LLM 提供商（Ollama、OpenAI、LongCat）进行交互。

## 常用命令

```bash
# 开发模式（热重载）
yarn dev

# 编译 TypeScript
yarn build

# 运行编译后的代码
yarn start
```

## 架构

```
src/
├── agent/index.ts    # 应用入口点
├── config.ts         # 配置加载器，从 config.yaml 读取并替换环境变量
└── llm/              # LLM 提供商封装
    ├── ollama.ts     # Ollama API 客户端
    └── longcat.ts    # LongCat API 客户端（待实现）
```

## 配置

- `config.yaml` 定义 LLM 提供商配置（URL、模型名称、API 密钥）
- 使用 `$ENV_VAR_NAME` 语法引用环境变量
- `.env` 文件存储环境变量（OLLAMA_HOST、OPENAI_API_KEY、LONGCAT_API_KEY）

## TypeScript 配置

项目使用严格的 TypeScript 配置，启用 `noUncheckedIndexedAccess` 和 `exactOptionalPropertyTypes`。模块系统为 ESM（`"type": "module"` in package.json）。

开发后不用编译验证，项目已经启动，保存会自动重新执行，人工验证即可。
