# Nyxus 星系形态与交互实施路线

> 相关实现：[Nyxus 输入调度](../../../web/src/features/pets/nyxus/composables/useNyxusParticleInput.ts) ｜ [目标场](../../../web/src/features/pets/nyxus/particles/targets.ts) ｜ [渲染器](../../../web/src/features/pets/nyxus/particles/nyxusRenderer.ts) ｜ [色调](../../../web/src/features/pets/nyxus/particles/tone.ts)

## 目标与边界

Nyxus 的常态应读作一个小尺度、风格化的星系：受控暖核、蓝紫外盘、沿旋臂局部出现青蓝或玫红恒星形成区、可辨白色恒星核心。参考图用于校正结构、层次和色彩分布，不复制任一张图的构图或调色。

服务端 `disconnected` 时，Nyxus 固定渲染为黑洞/吸积盘；黑洞不再加入 idle 的随机形态。`connecting` 保持正常星系但降低活动度，`connected` 正常调度 idle 形态。Nyxus 仍是独立组件，不进入 `PetInstance`，也不获得主 Pet UI。

## 视觉决定

| 主题 | 决定 | 理由 |
|---|---|---|
| 默认星系 | 主体为正面或轻倾斜的双臂/棒旋星系 | 比均匀彩色云团更容易被识别为星系。 |
| 色彩分布 | 中心小范围暖白/浅金；外盘冷蓝靛蓝；玫红、青蓝只作旋臂结 | 接近恒星族群、尘埃与恒星形成区的层次，避免全场霓虹散点。 |
| 恒星 | 核心继续纯白；彩色仅留在极少数恒星光晕、诞生和消亡环 | 延续现有可见性约束。 |
| 双星系 | 改为完整的伴星系并合循环，而非两个点状星核 | 满足“合并又拆分”的连续叙事。 |
| 黑洞 | 断连状态专属：暗中心、窄暖/蓝吸积环、弱透镜弧 | 给服务状态明确但不刺眼的视觉含义。 |

## 实施顺序

### 0. 建立状态和类型契约（前置，串行）

涉及：

- `web/src/features/pets/nyxus/particles/types.ts`
- `web/src/features/pets/nyxus/composables/useNyxusParticleInput.ts`
- `web/src/features/pets/nyxus/particles/nyxusParticleEngine.ts`

操作：

1. 将“连接状态驱动的系统形态”与“connected 时的 idle 形态”分开表示；不能再让 `blackHole` 与普通随机模式共用调度入口。
2. 为输入增加可测试的服务呈现态：`connected`、`connecting`、`disconnected`。
3. 为 idle 形态保留明确的形态枚举；第一批包含 `spiral`、`barredSpiral`、`inclinedDisk`、`merger`、`pulsar`、`starburst`。`tidalRings` 迁移为 `merger` 的潮汐尾阶段，而非独立的规则圆环。
4. 决定优先级：`disconnected 黑洞 > dragging/release/menu > working/reach > idle 形态`。断连时仍允许单击打开工具，但不应恢复普通星系。
5. 从 `useNyxusWorkState.ts` 的现有 `working`、`runningTools`、`approval`、`questionBatches` 和流式内容派生一个只读运行呈现态：`idle`、`thinking`、`toolRunning`、`waitingForUser`、`responding`、`error`。该呈现态只驱动粒子，不改变对话、审批或工具业务逻辑。

验收：断连不会启动随机黑洞，也不会因为鼠标靠近切回普通星系；重新连接后平滑回到默认星系。

### 1. 先完成主星系的结构性配色（依赖阶段 0）

涉及：

- `web/src/features/pets/nyxus/particles/colors.ts`
- `web/src/features/pets/nyxus/particles/tone.ts`
- `web/src/features/pets/nyxus/particles/targets.ts`
- `web/src/features/pets/nyxus/particles/nyxusRenderer.ts`

操作：

1. 以粒子的旋臂编号、半径和局部密度决定颜色，不再主要依据随机云团索引。
2. 增加小尺寸暖核与暗尘带；外盘用低饱和蓝靛雾，旋臂上仅保留低占比青蓝/玫红发光结。
3. 将 `spiral` 作为常驻基底；新增 `barredSpiral`（短棒状核 + 两主臂）和 `inclinedDisk`（薄盘、核球、尘带）两个低风险变体。
4. 保持云层最终合成透明度 `≤80%`、白色星核和外围可见性约束。

验收：最散、最聚及形态过渡中都没有大块灰白或均匀霓虹；静态截图可辨“中心—盘—旋臂”的三级结构。

### 2. 实现双星系合并—拆分循环（依赖阶段 1）

涉及：

- `web/src/features/pets/nyxus/particles/targets.ts`
- `web/src/features/pets/nyxus/particles/nyxusRenderer.ts`
- `web/src/features/pets/nyxus/particles/physics.ts`
- `web/src/features/pets/nyxus/composables/useNyxusParticleInput.ts`

`merger` 在一次长形态内经过以下连续阶段；全部位置都从同一粒子种子计算，禁止瞬移换场：

| 进度 | 画面 | 粒子目标场 |
|---|---|---|
| 0–22% | 两个大小不等的独立星系靠近 | 两个椭圆盘，各自保持旋臂相位。 |
| 22–45% | 第一次掠过 | 低 `armRank` 粒子形成弯曲星系桥和一条潮汐尾。 |
| 45–65% | 双核并合 | 两个暖核靠近成双核，再收成单个受控核球。 |
| 65–82% | 合并后星暴 | 外盘松散、局部形成区短暂增强；不使用纯白爆闪。 |
| 82–100% | 反向舒展并回归默认盘 | 潮汐尾收回，两个盘平滑分离；阶段末回到普通星系。 |

验收：任意时间截取均看得出前后因果；“合并”和“拆分”均有桥/尾作为过渡，而不是仅两个中心点变成一个点。

### 3. 断连黑洞与状态过渡（依赖阶段 0，可与阶段 2 并行）

涉及：

- `web/src/features/pets/nyxus/composables/useNyxusParticleInput.ts`
- `web/src/features/pets/nyxus/particles/targets.ts`
- `web/src/features/pets/nyxus/particles/tone.ts`
- `web/src/features/pets/nyxus/particles/nyxusRenderer.ts`

操作：

1. `disconnected` 强制进入黑洞目标场：中心保留真正的暗区，周围为扁平吸积盘和少量透镜弧。
2. `connecting` 不切黑洞，使用低活动、低闪烁的普通星系，避免连接重试时频繁跳态。
3. 连接状态变化走 2–4 秒形态插值：星系向吸积盘塌缩、或由吸积盘重建出旋臂。
4. 离线状态点同步淡出，避免与黑洞中心竞争焦点。

验收：关闭/断开服务后仅出现黑洞；恢复连接不闪白、不突然出现星系。

### 4. 多层环绕核心与运行态行为（依赖阶段 0、1）

环状结构不是单独的“环状星系”特效，而是所有常态星系共享的核周轨道层：1–3 条不完整、互相倾斜的细环围绕同一小暖核缓慢进动。它们能在旋涡、棒旋、倾斜盘和合并过程中改变倾角、偏心率、断裂位置与旋转方向，因此形态切换看起来是同一星系在重构，而不是换一套动画。

| 运行呈现态 | 环绕核心行为 | 关联的真实状态 |
|---|---|---|
| `idle` | 1–2 条低亮环慢速进动，偶尔改变倾角和开口 | 无运行、无工具、无审批/提问。 |
| `thinking` | 内环略收紧、外环保持缓慢反向旋转；不提高白色中心亮度 | 仅 thinking 流或工作中尚未输出内容。 |
| `toolRunning` | 每个并发工具映射为一个低亮轨道信标；一颗“数据星尘”沿对应环运行 | `runningTools` 非空。 |
| `waitingForUser` | 环停止进动并留下一个朝上的缺口，形成“悬停等待”的视觉节拍 | approval 或 questionBatch 存在。 |
| `responding` | 从内环向旋臂发出低频、有限次数的波纹，模拟内容向外扩散 | 流式 content 正在增长。 |
| `error` | 环断裂、褪为低饱和暗紫；不与 disconnected 黑洞混淆 | 运行错误；服务仍可连接。 |

实现限制：不按每个 token 触发一次波纹；使用节流后的内容增量或 1–2 秒节拍。工具数量只决定最多三条轨道/信标，避免工具并发时画面失控。

涉及：

- `web/src/features/pets/nyxus/composables/useNyxusWorkState.ts`
- `web/src/features/pets/nyxus/components/NyxusCore.vue`
- `web/src/features/pets/nyxus/components/NyxusParticle.vue`
- `web/src/features/pets/nyxus/composables/useNyxusParticleInput.ts`
- `web/src/features/pets/nyxus/particles/types.ts`
- `web/src/features/pets/nyxus/particles/targets.ts`
- `web/src/features/pets/nyxus/particles/nyxusRenderer.ts`

验收：用户可从星系的节奏辨别“思考、工具运行、等待输入、输出内容”，但不需要读取文字或新增任何状态栏；所有环仍围绕同一核心，且不会盖住白色恒星。

### 5. 丰富鼠标交互（依赖阶段 0；可与阶段 2、3、4 并行）

现有 `reach`、拖拽、释放尾迹、工具环星尘桥均保留。新增交互必须是短暂的局部扰动，不能打断长 idle 形态。

| 手势/条件 | 效果 | 实现落点 |
|---|---|---|
| 中心附近悬停 | 微弱引力透镜与局部剪切，不提高中心白度 | `targets.ts` + `nyxusRenderer.ts` |
| 鼠标持续绕圈 | 按绕行方向让旋臂相位缓慢推进/回卷 | `useNyxusParticleInput.ts` 记录角速度；`targets.ts` 消费相位偏移 |
| 快速掠过 | 在运动反方向留下短暂潮汐尘埃尾 | 复用 `pointerVelocity` / `release` 参数 |
| 在旋臂停留 | 点亮一个低亮度、限时的恒星形成结 | 输入记录 dwell 区域；renderer 绘制局部彩色结 |
| 点击外盘 | 播下一颗新恒星，进入已有渐生—稳定—消亡周期 | `physics.ts` 选择普通粒子并提升为出生态 |

手势阈值保持克制：连续绕行只累计同向角位移并以数秒衰减为旋臂相位，不改变 idle
形态；快速掠过只在 1.6 秒内保留局部尘埃尾；旋臂停留约 0.9 秒才出现一个低亮、
约 5 秒后消退的形成结。外盘点击须在菜单关闭、未进入拖拽且落点离核心足够远时才
晋升一个普通粒子，继续复用既有出生—稳定—消亡周期。

### 6. 与其他 Pet 的“关联”效果（依赖阶段 0，最后实现）

现有 Nyxus—Pet 大斥力不变。只有两者处于安全距离之外、但仍在视觉关联范围内时，渲染极淡的非交互式引力桥或借色星尘；不拉近、不遮挡、不改变任何 Pet 的位置或 UI。该效果需要由 `NyxusCore.vue` 向粒子输入提供邻近 Pet 的只读中心和主题色。

关联范围只选择最近的一个普通 Pet；输入为相对中心、主题主色与距离。渲染器在
安全距离外才绘制透明度不高于 0.12 的断续桥/星尘，距离过远则不绘制。它不参与
`useStandaloneNyxusMotion` 的目标选择，因此不会降低既有斥力或改变普通 Pet 位置。

## 多 Agent 实施编排

阶段 0 必须由一个集成 Agent 串行完成，冻结类型和优先级后再并行：

| Agent | 可并行任务 | 主要文件 | 交付物 |
|---|---|---|---|
| A：星系结构 | 阶段 1 | `colors.ts`、`tone.ts`、`targets.ts`、`nyxusRenderer.ts` | 三种常态星系结构与配色。 |
| B：合并叙事 | 阶段 2 | `targets.ts`、`physics.ts`、`nyxusRenderer.ts` | 双星系合并—拆分状态场。 |
| C：连接状态 | 阶段 3 | `useNyxusParticleInput.ts`、`targets.ts`、`tone.ts` | 断连黑洞与连接插值。 |
| D：运行态环系 | 阶段 4 | `useNyxusWorkState.ts`、`NyxusCore.vue`、`useNyxusParticleInput.ts`、`targets.ts`、`nyxusRenderer.ts` | 多层环绕核心与 thinking/tool/waiting/responding 行为。 |
| E：鼠标手势 | 阶段 5 | `useNyxusParticleInput.ts`、`targets.ts`、`nyxusRenderer.ts` | 环绕、掠过、停留、外盘点击。 |

由于 A/B/C/D/E 都会触及 `targets.ts` 或 `nyxusRenderer.ts`，各 Agent 应在独立 worktree 完成后由集成 Agent 按“阶段 1 → 2/3/4/5 → 6”的顺序合并并处理冲突；不要在共享工作区并发写这些文件。阶段 6 依赖 `NyxusCore.vue` 的邻近 Pet 输入，放在全部核心形态稳定后执行。

## 验收与回归

1. 补充 `test/web/nyxusParticleEngine.test.ts`：断连强制黑洞、connected 不随机黑洞、合并关键进度的有限性与形态差异、各 idle 形态最小时长。
2. 为环绕/停留手势提取纯函数，补单测；避免依赖真实 DOM 时钟。
3. 视觉验收至少覆盖：connected 默认盘、棒旋、倾斜盘、合并五阶段、disconnected 黑洞、connecting、思考、工具运行、等待输入、内容输出、hover、环绕、快速掠过、外盘点击、工具环与邻近 Pet。
4. 所有云层保持合成上限 80%；恒星核心仍为白色；普通 Pet 不出现名称、状态条或工具栏变更。
