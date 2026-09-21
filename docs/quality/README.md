# 质量文档

本目录维护验证边界与需保留的证据：测试基线与门控、流程测试规约、Mock Provider 用法、已结束计划的验收证据和当前开放问题。它不重复模块实现说明（实现事实见 [后端](../backend/README.md)、[前端](../frontend/README.md)），也不定义强制规则（见 [开发规范](../standards/README.md)）。

## 模块导航

| 目录 | 内容 |
| --- | --- |
| [testing/](./testing/README.md) | 测试基线、门控约定、流程测试规约和 Mock Provider 用法 |
| [verification/](./verification/README.md) | 已结束实施计划的长期验收证据：按 `<task-id>/` 子目录组织，含自动输出、人工结论与批准记录 |
| [known-issues/](./known-issues/README.md) | 当前开放问题的短目录、人工复核项和暂缓处理项 |

## 常见任务路由

| 修改意图 | 先读 |
| --- | --- |
| 判断测试门控、TSC 基线或回归判定 | [testing/baseline.md](./testing/baseline.md) |
| 新增或修改流程测试场景 | [testing/flows.md](./testing/flows.md) |
| 用 Mock Provider 做离线测试 | [testing/mock-provider.md](./testing/mock-provider.md) |
| 计划收口时迁移长期验收证据 | [verification/README.md](./verification/README.md) |
| 登记或处理当前开放问题 | [known-issues/README.md](./known-issues/README.md) |

## 跨领域边界

质量文档说明验证边界和证据，不重复模块实现说明。查看仍需处理或复核的事项时先读已知问题短目录，只在需要复现、验收或修复时进入对应详情。
