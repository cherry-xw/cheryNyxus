# 样式（less）

> 源码 [App.vue](../../../web/src/App.vue) / [PetStage.vue](../../../web/src/features/pets/PetStage.vue) / [PetSprite.vue](../../../web/src/features/pets/PetSprite.vue) ｜ 上级 [README.md](./README.md) ｜ 渲染分层见 [rendering.md](./rendering.md)

三个 vue 组件的 `<style>` 块均改用 `lang="less"`：[App.vue](../../../web/src/App.vue)（全局 reset）、[PetStage.vue](../../../web/src/features/pets/PetStage.vue)（舞台/toolbar）、[PetSprite.vue](../../../web/src/features/pets/PetSprite.vue)（pet 部件，原 ~363 行 CSS 为主简化目标）。less 经 Vite 内置预处理器自动编译——仅装 `less` devDep，无需 vite 插件。

- **变量提取**：深色文字/边框色（`@ink`/`@ink-soft`/`@ink-bg`，取代散落的 `#24262d` 与 `rgba(20,22,26,…)` 字面量）、`@glyph-fonts`（颜文字/emoji 字体栈）、`@tribe-hue` 派生色等抽为 less 变量，消除重复。
- **mixin**：`.face`/`.hand` 共享的字体栈抽 `.glyph-font()` mixin（原 7 行 `font-family` 重复两次）。
- **嵌套**：`.pet.is-master .name`、`.tool-icon:hover .tip`、`.tools.more-open .tools-extra` 等父子选择器归并嵌套。
- **不抽独立文件**：变量/mixin 就地定义在各组件 scoped 块内（pet 样式与组件强内聚，无跨文件复用诉求）。
- **CSS 变量保持不变**：`--pet-color`/`--pet-scale`/`--pet-direction`/`--char-i`/`--tribe-hue` 等 inline 动态变量保留——less 变量编译期定值，CSS 自定义属性运行期动态（由 `:style` 注入），二者职责分离，不混用。
