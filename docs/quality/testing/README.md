# 测试文档

本目录维护仓库测试的基线与门控约定，说明哪些验证可自动执行、哪些必须交用户人工复核。它不重复模块实现事实（见 [后端](../../backend/README.md)、[前端](../../frontend/README.md)），只提供验证边界与门禁依据。

## 文档导航

| 文档 | 定位 |
| --- | --- |
| [baseline.md](./baseline.md) | 仓库测试基线与门控约定：test/ 模块推迟、TSC 基线预存错误、套件预存失败与回归判定流程 |
| [flows.md](./flows.md) | 主子 Agent、审批、工具、恢复等流程测试规约（S1–S17 场景矩阵） |
| [mock-provider.md](./mock-provider.md) | 无网络环境下的脚本化 Provider 使用说明 |

## 常见任务路由

| 修改意图 | 先读 |
| --- | --- |
| 判断本次改动是否构成回归、跑什么门控 | [baseline.md](./baseline.md) |
| 新增或修改流程测试场景 | [flows.md](./flows.md) |
| 配置 mock 脚本做离线验证 | [mock-provider.md](./mock-provider.md) |

当基线约定和已落地测试发生冲突时，必须先修正文档状态，再把它作为门禁依据。
