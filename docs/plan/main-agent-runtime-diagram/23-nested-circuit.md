# T23 多层共存电路与运行跟随

**文档创建时间：** 2026-09-12T13:05:11+08:00

状态：进行中。所属[总任务](README.md)。复杂度 5/5：递归尺寸、跨层引脚接续、运行与手动导航生命周期共同变化。用户已确认当前 GPT-6 Agent 串行实施。本任务合并尚未实施的 T21；依赖既有 T22，实现范围以[展示契约](../../frontend/runtime-diagram.md)为准。

- [x] 定位当前单板投影、导航、状态和验证入口，先更新展示契约。
- [ ] 递归原位布局、引脚内外接续、独立展开集合，保持拖拽锁定。
- [ ] 精简元器件信息，接入可暂停的实时自动展开/收起与相机跟随。
- [ ] 定向布局、关系守恒、导航和运行生命周期测试；类型、ESLint、构建及文档检查。

完成标准：代码级验证通过，无丢失关系、重叠元器件或失控跟随。实机视觉和交互统一由 T07 验收，不属于本实现任务的完成条件。

下一入口：`headerLayout.ts`、`headerGraph.ts`、`useHeaderBoardNavigation.ts`；定向命令 `pnpm exec vitest run --config web/vitest.config.ts web/test/agent/workflowHeaderLayout.test.ts web/test/agent/workflowHeaderNavigation.test.ts`。
