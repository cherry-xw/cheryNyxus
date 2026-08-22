# 前端字体字重规范

> 全局 UI 字体规范（2026-08-22 确立）。适用于 `web/src/` 全部 Vue 组件与样式文件。
> 遵循用户统一视觉要求：**内容字段一律不加粗，标题才用加粗，小字体用细体**。

## 核心原则

1. **字体与字重搭配**：小字体尽量用细体（400）；大字体视情况可加粗（600）。
2. **加粗使用原则**：整个项目尽量不用加粗。仅部分**标题字段**允许加粗，**内容字段一律不加粗**（使用自重 400）。
3. **字重数值**：绝大部分为 `400`，少部分为 `600`，且 600 只出现在标题层级。

## 字重映射表

| 用途 | 字重 |
|-----|------|
| 正文 / 描述 / 参数值 / 选项文字 / 输入框 / 弱化文字 | `400` |
| 标题 / 标题栏 / 角色名 / kicker / legend / 卡片标题 | `600` |
| 主按钮（高亮色） | `600` |
| 次级 / 幽灵按钮 | `400` |
| 图标字形（✓ ? 箭头等图形符号） | 保留原值 |
| 计数徽标数字 | 保留原值 |
| markdown 内容 `strong`（内容作者语义加粗） | 保留 `700` |

## 豁免清单（保持不动）

以下类别为刻意设计，**不**套用 400/600 收敛规则：

- **图标字形**：`.question-symbol`(?) `.choice-mark`(✓) `.question-control`(✓) `.pending-panel-glyph`(!) `.routing-trace-check` `.approval-icon` `.key-clear-glyph` 等图形符号
- **计数徽标**：`.pending-panel-count` `.resource-badge` `.question-progress` 等数字徽标
- **pet 特殊视觉**：
  - 气泡小字：`PetBubble.vue` `.speech`（800@10px）——极小字号维持可读的刻意设计
  - CRT 终端：`nyxusPopoverTheme.less`、`ExecutionNodePopover.vue` 状态字形、`AnchoredRunCrt.vue`
  - 钢琴键：`NyxusPianoStrip.vue` 键面 700/800@7-9px
  - paper 像素：`PaperGameCard.vue` / `NodePaperStack.vue`（`font-synthesis: none` + 单字重像素字体，900/950 声明在像素字体下不生效）
- **markdown 内容 `strong`**：内容作者显式语义加粗，浏览器默认 700 保留

## 判别流程

对每一处 `font-weight` 声明：

1. 属于**豁免清单** → 保留不动
2. 属于**标题/头部/名称/角色名/kicker/legend** → `600`
3. 属于**正文/描述/参数/选项/标签** → `400`
4. 属于**按钮** → 主按钮 `600`，次级/幽灵 `400`
5. 原值 650/550/500 → 一律 `400`（弱化文字用 `color`/`opacity` 区分，不靠字重）

## 参考范本

`web/src/styles/markdown.less` 已是规范结构范本：正文 `p/li/th/td` = 400，标题 `h1-h6` = 600。

## 注意事项

- 项目当前**无字号/字重 CSS token**（`theme.css` 仅颜色 token），字重全部硬编码。本次只收敛字重数值，不引入 token 体系。
- 弱化文字（description/hint 等）用 `color-mix` 透明度区分层级，不依赖更小字重。
