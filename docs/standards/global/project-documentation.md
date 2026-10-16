# cheryNyxus 文档管理项目配置

本文件维护通用规则在本项目的参数和政策选择，不重定义[通用文档规范](../documentation/README.md)。任何适用操作开始前读取相应配置。稳定一级路由由根 [AGENTS.md](../../../AGENTS.md) 的项目配置区维护；[文档总索引](../../README.md) 提供相同目标的浏览入口，分类变化时同步两处导航。

## 1. 目录与实现边界

后端实现位于 `apps/backend/src/`，前端位于 `apps/web/`；领域路由详见根入口。模块文档映射稳定职责，具体符号由领域入口维护。跨端架构、消息、数据模型与状态机统一由 `docs/shared/` 维护。

实际模块与验证入口分别从[后端](../../backend/README.md)、[前端](../../frontend/README.md)、[质量](../../quality/README.md)进入；长期测试使用项目已有测试设施（包括 Vitest），按目标模块的文件和命令验证，不在通用包中固化命令。文档检查命令由根 `package.json` 维护，机器可读的受管范围和来源策略见 [`scripts/docs/config.mjs`](../../../scripts/docs/config.mjs)。

本区是项目配置的唯一维护位置：

1. 领域路由由根 `AGENTS.md` 的“项目配置”表维护，完整导航由 `docs/README.md` 提供。
2. 源码与测试根分别为 `apps/backend/src/`、`apps/web/`、`apps/relay/`、`apps/backend/test/`；生成物和第三方代码不作为文档定位入口。
3. 验证入口由 `docs/quality/` 和目标模块 README 维护；允许的自动化范围遵守本文件第 3 节及[项目协作规范](./ai-collaboration.md)。
4. 必须由用户完成的真实界面、视觉、交互和主观体验确认，属于人工验收边界；执行人是用户，除非用户明确授权 AI 查看或操作。
5. 计划采用显式用户审批关口，审批人为当前任务用户；审批和收口规则见本文件第 2 节。
6. 计划入口和未完成恢复文档纳入 Git，`verify/out/` 与运行产物忽略；长期证据迁入 `docs/quality/verification/`。
7. 项目协作规范为[ai-collaboration.md](./ai-collaboration.md)，提交、图片验证和协作流程变化前读取。
8. 文档检查命令为 `pnpm docs:test`、`pnpm docs:check-links`、`pnpm docs:check-structure`、`pnpm docs:check-plan`、`pnpm docs:check-metadata` 和综合入口 `pnpm docs:check`；检查器实现位于 `scripts/docs/`。
9. 自动检查入口为 [`.github/workflows/docs.yml`](../../../.github/workflows/docs.yml)，在文档、规则、检查器、计划工具或命令配置变化时运行 `pnpm docs:test` 和 `pnpm docs:check`。检查结论以当前工作区的实际执行结果为准；必须完整报告阻断错误与待核对项，不得把历史通过写成永久事实。

## 1.1 文档受管范围和来源边界

本项目的文档检查按以下范围识别文档，不把所有 Markdown 文件机械地塞入 `docs/README.md`：

| 范围 | 路径 | 事实归属和导航规则 |
|---|---|---|
| 仓库文档中心 | `docs/` | 由 `docs/README.md`、领域 README 和模块入口导航；`archive/` 与 `quality/verification/` 按各自规则排除当前事实检查 |
| 根入口 | `AGENTS.md`、根 `README.md` | 维护项目入口、启动和全局规则；不承载模块正文 |
| cheryNyxus 模板/运行文档 | `apps/backend/.chery/docs/`、`apps/backend/.chery.template/docs/` | 由各自目录的 README 和模板 owner 维护，不复制到 `docs/README.md`；模板与运行副本的同步关系由模板工具维护；其链接按安装后的模板环境解析，不参加仓库相对路径检查 |
| 计划和验证 | `docs/plan/`、`docs/quality/verification/` | 由计划规范和验证证据规范维护，不当作普通模块文档 |
| 开发工具文档 | `tools/plan-viewer/README.md` | 由工具自身维护；工具只读 `docs/plan/`，不承担全仓文档检查 |

其他 Markdown 文件必须在本任务后续的来源盘点中明确归类、移动、声明为外部/临时内容或登记为待处理项；检查器不得静默把未归类文件当作权威文档，也不得把未归类文件自动加入文档总索引。

当前项目暂不使用独立公开文档发布仓库、翻译镜像仓库或外部文档同步源，生成文档和外部来源镜像均为“无”。后续启用时必须先在本文件登记源文件、输出目录、来源版本、同步命令和版本控制策略。

当前项目暂不强制使用页面元信息；`title`、`summary`、`read_when`、`source`、`generated` 只能作为后续可选扩展，启用前必须在本文件登记字段和检查命令。

## 2. 计划政策

采用[通用计划规范](../documentation/plans.md)的活动状态与显式用户审批关口。全部必要验证通过后进入“待用户审批”；用户明确批准后，将长期事实迁入权威位置，从计划总入口移除任务并删除整个总任务目录，不保留“已完成”计划台账，也不再等待单独的删除指令。

复杂度、任务状态、反馈处理、文档同步及临时文件管理统一遵守通用计划规范。任务启动时说明复杂度与能力建议；用户确认的 Agent 在同一任务及已授权批次内继续有效，实质变更时才重新评估确认。

本项目实施过程中只做必要最小校验；整体实现完成并逐项核对需求后，集中执行类型、构建及相关测试。最终真实界面验收由用户完成。抽样检查由用户按需要选择，不强制所有任务额外抽样。

计划静态检查入口为 `pnpm plan:lint` 与 `pnpm docs:check-plan`，两者和 Plan 页面共享检查逻辑；阻断错误必须修正，不得静默跳过。待核对项明确保留，不能编造业务完成。使用场景及报告见[静态检查说明](../documentation/plan-checks.md)。

计划入口、当前小任务、可交接脚本与验证说明纳入 Git；运行产物在 `verify/out/` 忽略。一次性草稿和调试文件放系统临时目录中的任务专用目录。收尾检查本任务新增文件及临时目录，不能删除继承的用户或其他任务文件。可复用验证说明迁入[验证说明目录](../../quality/verification/README.md)，原始输出不要求成为长期开发历史。

恢复任务从[计划总入口](../../plan/README.md)开始。

## 3. 验证与协作政策

提交和图片验证前读取[项目协作规范](./ai-collaboration.md)。图片读取限制由该文件唯一维护。

自动验证不得启动或操控浏览器等图形界面，不得执行页面截图、录屏、像素比对、浏览器 UI 自动化或以程序化 DOM/CSS 检查代替 UI 验收；浏览器构建本身不属于启动界面。浏览器实机操作、视觉与交互验收由用户按最后的手动清单执行并记录，除非用户对具体任务另有明确授权。自动检查通过而必要人工验收未完成时，任务仍处于“待综合验证”。

本项目的语音纠正和首次用户交互原则由根入口的项目约定区维护，不随通用规则包迁移。

## 仓库结构约定

组件源码、专用测试、资源与交付归属见[仓库组件结构](../../shared/architecture/repository-structure.md)。ESP32 专用实现与 C/CMake 测试分别位于 `platform/ESP32/`、`platform/ESP32/test/`；根测试仅承载跨组件检查。实际部署配置、凭据、数据与备份放仓库外 `/home/chery/docker/`，源码路径调整不授权重命名持久数据目录或重启生产。构建输出不入 Git。
