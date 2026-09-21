# CheryNyxus Electron 前端壳打包

> 源码入口：[web/electron/](../../web/electron/)、[web/electron-builder.yml](../../web/electron-builder.yml)
> 相关：[electron.md](electron.md)、[deployment.md](deployment.md)

## 当前边界

Electron 安装包只包含前端静态资源、主进程和 preload。后端 bundle、Node runtime、`.chery` 模板、数据库和 Terminal 运行时由独立后端/管理器发布物提供，不能通过 Electron 打包流程带入安装包。

## 打包命令

```bash
pnpm electron:pack
```

该命令执行：

1. `pnpm --filter web build`，生成前端和 Electron 主进程/preload 产物；
2. `web/scripts/dist-electron.mjs` 调用 electron-builder；
3. 产物写入 `web/release/`。

增量调用仍可使用：

```bash
pnpm electron:pack:fast
```

`--only-build`、`--skip-deps`、`--skip-check` 和 `--force` 只为旧命令兼容保留，不再下载或准备后端运行时；它们不会改变纯前端打包边界。

## 镜像与代理

环境变量可以覆盖根 `package.json` 的 `packConfig`：

| 环境变量                           | 用途                                |
| ---------------------------------- | ----------------------------------- |
| `ELECTRON_PACK_PROXY`              | Electron 下载和构建所需的 HTTP 代理 |
| `ELECTRON_MIRROR`                  | Electron 本体下载镜像               |
| `ELECTRON_BUILDER_BINARIES_MIRROR` | electron-builder 辅助二进制镜像     |

例如：

```bash
ELECTRON_PACK_PROXY=http://company-proxy:8080 pnpm electron:pack
```

## 资源检查

`web/electron-builder.yml` 的 `files` 只允许包含：

```yaml
files:
  - dist/**
  - dist-electron/**
```

发布前应静态确认：

- `web/electron/main.ts` 没有启动后端的子进程入口；
- `web/electron/preload.ts` 没有注入后端端口、session token 或 Node 路径；
- 配置没有 `extraResources` 指向后端 bundle、Node runtime 或 `.chery`；
- 安装包资源没有 `dist/index.js`、`build/node`、`build/terminal-runtime` 或 `.chery`。

Electron 启动、窗口交互和安装包运行属于 `relay-gateway` 的 H 人工验收，不能用本页的静态检查代替。
