# T04 工作台空间布局

所属总任务：[主 Agent 运行流程图](README.md)。状态：未开始。批次：B。复杂度：3（中等），因为需要同时处理方向、卡片轨道、输入区域和两个独立视口。依赖：T01。

## 范围与交付

新增工具栏流程开关与空间布局，给 T05 提供独立流程区域。尺寸预算和模式组合以[需求说明第 9 节](requirements.md#9-空间分配与模式组合)为准，不在本文件复制数值。

保留现有卡片和树的业务 owner，不重写 Pixi 布局或引入第二张 Canvas，不改变 `paperMode` 的派生语义。初次窗口打开流程默认关闭。

## 已完成事实

- [x] 已确认卡片绝对定位与树百分比宽度存在二次收缩风险。
- [x] 已确定横向上下布局、竖向三栏、窄窗保持下限后滚动、输入区域预留高度。
- [ ] 前端容器与开关实现尚未开始。

## 剩余步骤

- [ ] 按 T01 前端权威专题更新组件职责与状态归属；实现前读取适用前端规范。
- [ ] 在 [WorkbenchDialog.vue](../../../web/src/features/agent/workbench/WorkbenchDialog.vue) 的既有工具栏增加图标按钮与独立可见状态，接入窗口关闭、会话切换和最小化生命周期。
- [ ] 保留 [useWorkbenchViewPreferences.ts](../../../web/src/features/agent/workbench/useWorkbenchViewPreferences.ts) 的树偏好；流程开关不写 `paperMode` 或强制方向。
- [ ] 建立水平模式的上下容器、竖直模式的组合区加右栏；无卡片的竖向情况不保留空卡片轨道。
- [ ] 用同源尺寸管理 [MessageBranchTree](../../../web/src/features/pets/nyxus/components/MessageBranchTree.styles.less) 与 [NodePaperStack](../../../web/src/features/pets/nyxus/components/NodePaperStack.styles.less) 的轨道，避免叠加百分比。
- [ ] 输入框展开时预留实际高度，处理 titlebar/上下文用量条/工具栏的安全空间与 stacking，不遮挡关键控件。
- [ ] 添加窄窗横向/低窗纵向滚动，固定宿主工具栏；只在首次打开时让新栏可达，不移动树相机。
- [ ] 保持 resize、主题、窗口形态和卡片选择；高亮数据变化不得触发布局计算或 fit。
- [ ] 把尺寸计算提取为可验证纯函数；根据实际宿主尺寸计算，不依赖屏幕宽度猜测。

## 定向自动验证

- `pnpm web:type-check`；新增布局纯计算与开关状态用例通过项目 Web Vitest 入口执行。
- 覆盖横/竖、卡片开/关、流程开/关、低宽高、输入区开/关的轨道结果和最小尺寸。
- 验证流程可见状态不改变树方向、折叠偏好或卡片 selection；销毁可清理观察回调占位。
- 不使用 DOM/CSS 程序检查代替 UI 验收。真实滚动、遮挡与相机观感由 T07 统一验证。

## 完成标准

提供稳定的流程挂载区域和布局计算入口；尺寸与状态纯逻辑通过定向检查。T05 可接入图形而不再次修改卡片所有权。回写组件入口、验证命令与最终 UI 验收场景后删除本文件。
