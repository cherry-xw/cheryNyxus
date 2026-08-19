# 样式（less）

> 源码 [App.vue](../../../web/src/App.vue) / [PetStage.vue](../../../web/src/features/pets/PetStage.vue) / [PetSprite.vue](../../../web/src/features/pets/PetSprite.vue) ｜ 上级 [README.md](./README.md) ｜ 渲染分层见 [rendering.md](./rendering.md)

三个 vue 组件的 `<style>` 块均改用 `lang="less"`：[App.vue](../../../web/src/App.vue)（全局 reset）、[PetStage.vue](../../../web/src/features/pets/PetStage.vue)（舞台/toolbar）、[PetSprite.vue](../../../web/src/features/pets/PetSprite.vue)（pet 部件，原 ~363 行 CSS 为主简化目标）。less 经 Vite 内置预处理器自动编译——仅装 `less` devDep，无需 vite 插件。

- **变量提取**：深色文字/边框色（`@ink`/`@ink-soft`/`@ink-bg`，取代散落的 `#24262d` 与 `rgba(20,22,26,…)` 字面量）、`@glyph-fonts`（颜文字/emoji 字体栈）、`@tribe-hue` 派生色等抽为 less 变量，消除重复。
- **mixin**：`.face`/`.hand` 共享的字体栈抽 `.glyph-font()` mixin（原 7 行 `font-family` 重复两次）。
- **颜文字神性光辉**：光效独立为 `PetDivineHalo.vue`，只包含中心向外渐隐的橄榄球形光晕和 68 根叶脉式细长光刺。每根光刺由柔光叶片与中央亮叶脉组成，左右最长、上方次之、下方较短，单刺最长 19px（不超过 96px 光效画布的约 20%）。每根拥有独立生长距离、消失时机、速度和正反微旋转；部分刺仅生长一半便虚化消失。浅色主题为深靛光背 + 浅色颜文字，深色主题为象牙金光背 + 深紫颜文字/手部；`prefers-reduced-motion` 下退化为静态光辉。名字与工具组成共享实色控制台：名字常驻、工具在 hover/focus 展开，按钮只保留统一外壳和 hover 底色，危险按钮有独立淡红分区；触屏环境始终显示工具。
- **嵌套**：`.pet.is-master .name`、`.tool-icon:hover .tip`、`.tools.more-open .tools-extra` 等父子选择器归并嵌套。
- **组件复用**：动态颜色变量仍就地定义在 `PetBody.vue` 的 `.pet` 上；跨主/子 pet 复用的圣环结构与动画集中在 `PetDivineHalo.vue`。
- **CSS 变量保持不变**：`--pet-color`/`--pet-scale`/`--pet-direction`/`--tribe-hue` 等 inline 动态变量保留——less 变量编译期定值，CSS 自定义属性运行期动态（由 `:style` 注入），二者职责分离，不混用。
