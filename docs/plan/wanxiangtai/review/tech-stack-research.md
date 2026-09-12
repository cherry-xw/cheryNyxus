# 万象台关键技术栈调研与评估

> **评审中间产物**（tech-researcher / 任务 t2）。供后续整体评审整合，不是实施决策。
> 输入：[design-and-history.md](../design-and-history.md) §4～§10（含附录复审缺口 H3/M4），辅以 [C03](../03-C03-source-snapshots.md)、[C08](../08-C08-discussion-scheduler.md)、[C10](../10-C10-context-management.md)、[C12](../12-C12-integration.md)、[C16](../16-C16-scenes-and-skins.md) 子计划细节。
> 方法：按六个需求领域逐一对比业界现有方案；每个领域给出「设计需求点 → 候选对比 → 结论（直接采用 / 借鉴思想 / 自研+要点）→ 来源」。调研时间为 2026-02，来源为官方文档与工程实践文章，未读取任何 node_modules 内容。

---

## 总判断（先给结论）

六个领域中，**没有任何一个存在可直接套用的现成技术栈**。万象台的核心形态（回合制停等会议 + 组织树逐级裁定 + 快照/工作区/回写 + 三层上下文）是"团队协作语义"与"文件安全语义"的组合，业界框架各覆盖一角。但设计本身已经站在业界成熟模式之上（乐观并发、outbox、幂等消费、结构化压缩都是教科书做法），真正的缺口在两个工程点：**等待关系图环检测**（领域 1）与**跨平台 COW 能力探测**（领域 2 二期）。推荐全部为"自研 + 借鉴思想"，与设计文档"一期普通复制、不引入重依赖"的取向一致。

---

## 1. 多 Agent 编排与同层通信

### 1.1 设计需求点

| 需求 | 来源 |
| --- | --- |
| 回合制停等：发起方停等、回复即唤醒；多方讨论按轮记录"必需回复者集合"并栅栏收集、去重 | D21、§7.2 |
| 同一组长一次只参加一个活动讨论，其余邀请排队；参与者未占齐不部分锁定 | R11、C08 步骤 1 |
| 等待回复期间释放模型请求配额（合法等待≠模型卡死，看门狗语义需分离） | §7.2、§10 |
| 新阻塞边成环 → 拒绝并上报；轮数上限只防活锁，不是死锁处理 | §7.2、C08 步骤 3 |
| 僵局逐级裁定：成员→组长→调度者→用户；安全审批永远直达用户 | D23、R12、R13 |
| 用户暂停/取消走确定性控制，不等模型同意 | §7.2 |
| peer 等待关系跨重启恢复（现有 `rebuildWaitedChildren` 只认父子链） | 附录 H3.1 |
| 同层 peer 通信通道（现状只有父子树 `wakeParent` 单向） | 附录 6.2.1 |

### 1.2 候选技术栈对比

| 框架 | 通信/调度模型 | 与本设计的贴合度 |
| --- | --- | --- |
| **AutoGen / AG2（Group Chat）** | GroupChatManager 主持一条共享会话流；`speaker_selection_method` 支持 auto（LLM 选人）/ round-robin / manual / 自定义函数；`max_round` 硬上限 + termination condition 终止。所有人看全部消息，**无按对停等、无组织层级、无栅栏** | 中。`max_round`＝设计"轮数上限"；自定义 speaker selection 思想可对应"本轮必需回复者集合"，但它是"选下一个说话者"而非"等齐一组人"。AG2 新版 patterns 仍是主持人驱动 |
| **CrewAI** | sequential / hierarchical 两种 process；hierarchical 由 manager LLM 委派任务给成员、成员回交 manager。**成员间无 peer 通道**，本质是星型委派 | 低。星型委派≈设计"组长唯一对外"（D1），但缺会议、缺同层讨论 |
| **LangGraph（supervisor/swarm）** | 显式状态图：supervisor 以 handoff 工具路由，swarm 节点间 `Command(goto)` 转移；每超步（super-step）写 checkpoint 持久化；`interrupt()` 打断进入人工审批、`Command(resume)` 恢复；循环必须显式画进图里（结构上可控）；多 agent 消息经共享 state / Send API 传递 | 高（思想层面）。"检查点+中断+恢复"与设计"持久控制状态 + 跨重启恢复 + 用户审批直达"完全同构；图结构防环对应"新阻塞边成环拒绝"。但它是**图执行引擎**，不是会议协议 |
| **OpenAI Agents SDK（handoff）** | handoff 把控制权转移给另一个 agent，同一时刻只有一个活跃 agent；支持 input_filter 裁剪交接内容。**无 peer 并行、无会议**，是接力链不是圆桌 | 低。handoff 的"交接上下文裁剪"可借鉴到 C10 实例接替 |
| **Claude Code 子代理 / Agent Teams** | 子代理＝隔离上下文窗口跑完返回单份报告（orchestrator-worker，Anthropic 工程博客确认并行子代理省 token）；Agent Teams＝队长 + 成员邮箱（mailbox）+ 共享任务板，消息即回合、唤醒成员、attempt_id 所有权与失效机制防并发写，队长轮询状态推进 | **最高**。成员邮箱≈双边各记（D22）、共享任务板≈待办/交付记录、"一条消息一个回合"≈回合制停等（D21）、attempt 失效≈操作版本控制。但它是产品内建 harness，**不可嵌入复用** |
| **MetaGPT** | SOP 流水线：角色按标准作业程序发布消息到共享环境（message pool），其他角色按订阅消费 | 中。发布/订阅公共流正是 D22"正式会议公共流"的思想原型；但流水线是单向串行，无裁定、无停等 |

### 1.3 结论

**自研调度器（C08 方向正确），无现成栈可整体采用。** 借鉴要点：

1. **状态机显式化 + 检查点**（学 LangGraph）：讨论等待关系（谁在等谁、第几轮、必需回复者集合）作为可持久化状态，服务重启后重建等待图——这是设计 H3.1 缺口的补法，而不是依赖父子的 `rebuildWaitedChildren`。
2. **按轮必需回复者栅栏**（学 AG2 自定义 speaker selection，但反其道）：不是"选下一个说话者"，而是"本轮配置的必需者集合全部响应才进入下一轮"，去重后缺员即挂起——这是设计 §7.2 原文语义，业界没有现成实现，必须自写。
3. **邮箱 + 任务板 + 回合消息**（学 Claude Agent Teams）：peer 消息以"投递+去重+代际"进入对方邮箱，等待方消费后唤醒；任务所有权用 attempt 语义（对应设计的 operationId/期望版本）。
4. **死锁预防**：运行时 wait-for 图（组间邀请、父等子、审批等待统一入图），新增阻塞边前做环检测（O(V+E) DFS），成环拒绝并逐级上报——轮数上限只作为活锁保险（设计已正确区分，C08 步骤 3 的"有类型的等待关系检查"应明确落为 wait-for 图）。
5. **配额语义**：等待回复时释放模型槽位＝"不占并发配额"，由领域 6 的网关排队实现，两处设计（§7.2 与 M4）在此汇合。

### 1.4 来源

- AG2 Group Chat orchestration patterns: <https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/orchestration/group-chat/patterns/>
- AutoGen GroupChat speaker selection（源码级）: <https://github.com/microsoft/autogen/blob/2e519b016a8bfa7a807721a1fc8a93b5d3be6c32/autogen/agentchat/groupchat.py>
- AutoGen 0.2 自定义 speaker selection 教程: <https://microsoft.github.io/autogen/0.2/docs/notebooks/agentchat_groupchat_customized/>
- AG2 GroupChat 架构解析: <https://deepwiki.com/ag2ai/ag2/2.4-groupchat-and-multi-agent-orchestration>
- CrewAI Processes（sequential/hierarchical）: <https://docs.crewai.com/en/concepts/processes>
- CrewAI Hierarchical Process: <https://docs.crewai.com/en/learn/hierarchical-process>
- LangGraph `interrupt()` 参考（人审/恢复）: <https://reference.langchain.com/python/langgraph/types/interrupt>
- LangGraph JS swarm 参考: <https://reference.langchain.com/javascript/langchain-langgraph-swarm>
- LangGraph supervisor 包: <https://www.npmjs.com/package/@langchain/langgraph-supervisor>
- OpenAI Agents SDK Handoffs: <https://openai.github.io/openai-agents-python/handoffs/>
- Claude Code 并行子代理文档: <https://code.claude.com/docs/en/agents>
- Claude Code Agent Teams 文档（邮箱/任务板/hooks）: <https://code.claude.com/docs/en/agent-teams>
- Anthropic《How we built our multi-agent research system》（orchestrator-worker、token 成本、并行子代理）: <https://www.anthropic.com/engineering/built-multi-agent-research-system>（转述见 <https://simonwillison.net/2025/Jun/14/multi-agent-research-system/>）
- MetaGPT 多智能体教程（角色/消息订阅）: <https://docs.deepwisdom.ai/main/en/guide/tutorials/multi_agent_101.html>
- MetaGPT 框架模式页: <https://www.agentpatternscatalog.org/compositions/metagpt/>

---

## 2. 文件快照与实例隔离

### 2.1 设计需求点

| 需求 | 来源 |
| --- | --- |
| 不可变快照：manifest＋逐文件哈希＋大小/类型清单；preparing→临时目录→校验→发布 | C03、§5.3 |
| 每执行实例独立 work 完整复制；不用可写硬链接；一期普通复制 | §5.4、§2.3 |
| 三方合并：交付基线＋交付内容＋当前集成内容；同路径文本合并、二进制/删除冲突上报 | C12、§6.2 |
| 阶段基线更新：S0/自身修改/S1 在候选目录三方更新，成功才切换 | §6.3 |
| 回写：逐文件备份＋恢复日志；失败按日志恢复 | §6.4 |
| 同时支持 Git 项目与普通目录；快照不含 git 历史 | R14、§5.4 |
| 一期明确不做：VFS、实时回读、可写硬链接、强依赖 COW 的存储 | §2.3 |

### 2.2 候选技术栈对比

**（a）git worktree**：同一仓库多工作树，`.git` 元数据共享、切换轻量，是 AI 并行代理的流行做法（多个 agent 各占一个 worktree）。但：要求项目必须是 git 仓库；共享分支/索引在某些操作下互斥；不含依赖安装。设计与 R14（普通目录也要支持）、"快照不含 git 历史"决定了它**只能作为 Git 项目的辅助手段**（例如集成候选目录、差异计算），不能当实例隔离的通用底座——设计"不以 worktree 等同零复制"的判断成立。

**（b）写时复制文件系统**：

| 机制 | 平台 | 可用性 |
| --- | --- | --- |
| APFS clonefile | macOS | Node `fs.copyFile` 经 libuv `UV_FS_COPYFILE_FICLONE` 可自动走块克隆（issue 长期跟进中） |
| ReFS block cloning | Windows Dev Drive（ReFS），Win11 24H2 / Server 2025 起官方支持 | 微软官方文档确认；但要求用户的开发盘是 Dev Drive/ReFS，NTFS 系统盘无块克隆 |
| Btrfs / XFS reflink | Linux | 原生支持 |
| Windows VSS | Windows | 卷影副本是系统级快照服务，程序化创建/挂载复杂、面向备份场景，不适合逐实例工作区 |
| overlayfs | Linux | 联合挂载：低层只读快照＋高层实例私有写，正是"固定基线＋自身修改"的理想模型，但仅 Linux（Docker 分层同原理），且写时复制粒度是整个文件 |

结论：**没有跨平台的统一 COW API**。可行演进路径是能力探测分派：`clonefile`（macOS）→ `ReFS block clone`（Windows Dev Drive，可用 `CopyFile2`/`fsutil` 或 rust/原生模块）→ `reflink`（Linux）→ 普通复制回退。一期不做（设计正确）；二期以"复制策略接口"预留位置即可。

**（c）内容寻址存储（CAS）**：restic、git 对象库、casq 等都以"内容哈希→blob 存储＋引用清单"实现去重与不可变。设计的 `files/<来源ID>/<相对路径>`＋manifest 哈希已具备演进为 CAS 的全部前提：二期把"全局 blob 池＋快照=引用清单"替换"逐快照全量文件树"，可把多实例磁盘成本从 N×项目大小降到 ≈1×项目＋各实例增量。

**（d）三方合并**：

| 方案 | 能力 | 评估 |
| --- | --- | --- |
| **node-diff3**（salto-io） | 纯 JS 文本 diff＋`mergeDiff3` 三方合并，浏览器/Node 通用 | **一期首选**：无原生依赖，可直接用于交付合并与基线更新；输出冲突块列表交人工/集成团队裁定 |
| **git merge-file / git merge-tree** | git 自带三方合并（`merge-file` 对三个临时文件做合并；`merge-tree` 对树对象） | Git 项目质量最高、经过最充分实战；普通目录不可用。可作为 Git 来源路径的"更优后端"，普通目录回退 node-diff3 |
| isomorphic-git | 纯 JS git 实现 | merge 能力有限、冲突自动处理弱、issue 显示非 fast-forward 冲突场景不可靠；**不建议**承担合并职责 |
| nodegit | libgit2 绑定 | 原生模块在 Electron 下需重编译，维护活跃度一般；收益不比 `git merge-file` 子进程大 |

**（e）大项目复制性能**：Node `fs.cp`/`fs.cpSync` 近年持续优化（递归 readdir 去 stat、copyDir fast path 等 PR 已合入）。一期瓶颈是海量小文件（前端项目动辄数万文件）＋逐文件 SHA-256。工程要点：复制与哈希流水线化（异步并发 4–8）、排除规则先行（node_modules/构建产物默认排除已是设计 R20）、进度与可取消。磁盘成本以设计的 20 GiB/任务预算＋预检空间预览＋排队（R21）兜底，一期可接受。

### 2.3 结论

**一期：自研普通复制＋manifest（维持设计），三方合并用 node-diff3（普通目录）＋ git merge-file（Git 项目可选加速）。**
**二期演进：** ① 复制策略接口挂接平台 COW（clonefile / ReFS block cloning / reflink），探测失败回退普通复制；② 快照存储升级为全局 CAS（内容哈希 blob 池＋引用清单），实例 work 变"基线引用＋私有增量"，磁盘从 N 倍降到约 1 倍＋增量；③ 环境允许时可评估 overlayfs 式"只读基线＋写时上浮"（仅 Linux 部署形态）。VSS 不推荐进入任何阶段。

### 2.4 来源

- git worktree 与并行 AI agent 实践: <https://dev.to/recca0120/git-worktree-multiple-working-directories-per-repo-and-the-key-to-parallel-ai-agents-40>
- Windows Dev Drive（ReFS、block cloning，Win11 24H2/Server 2025）官方文档: <https://learn.microsoft.com/windows/dev-drive/>
- Dev Drive / ReFS 权衡分析: <https://www.infoq.com/news/2023/06/windows-dev-drive/>
- Node/libuv FICLONE 支持跟进: <https://github.com/nodejs/node/issues/19152>、<https://github.com/libuv/libuv/issues/2936>
- overlayfs 分层原理（Docker 存储驱动文档）: <https://chromium.googlesource.com/external/github.com/docker/docker/+/99a396902f0ea9d81ef87a683489b2435408f415/docs/userguide/storagedriver/overlayfs-driver.md>
- node-diff3（JS 三方合并库）: <https://github.com/salto-io/node-diff3>
- git merge-file 官方文档: <https://git-scm.com/docs/git-merge-file>
- isomorphic-git merge 能力讨论: <https://github.com/isomorphic-git/isomorphic-git/pull/2121>
- Node fs.cp 性能优化实例: <https://github.com/nodejs/node/pull/58461>
- 内容寻址存储参考实现（casq，"minimal restic backend"）: <https://github.com/roobie/casq>

---

## 3. 有限上下文管理

### 3.1 设计需求点

| 需求 | 来源 |
| --- | --- |
| 三层上下文：完整历史（分页回忆）/ 有效任务记录（结构化业务状态）/ 当前上下文（本轮预算内） | §7.4 |
| 每次模型请求前计量：最终消息＋工具定义，计入输出与安全预留（128k 示例：输出 16k＋安全 16k） | §7.4、§10 |
| 60% 提前压缩、有界工具结果、按页回忆；必需材料超预算→拆议题或阻塞，禁止静默丢约束 | §7.4、C10 步骤 3 |
| 中文/代码/工具结果混合计量；字符数÷4 不可靠；无合适 tokenizer 用保守估计＋usage 校准 | §7.4、C10 步骤 2 |
| 压缩不得丢：已生效决策、异议、未处理消息、待办、成果版本、工作区基线 | §7.4 |
| 实例接替交接：目标/验收/决策版本/待办/基线/事件消费位置 | §7.5 |

### 3.2 候选技术栈对比

**（a）tokenizer 计量**：

- **tiktoken**（OpenAI 官方 BPE）与 **js-tiktoken**（浏览器/WASM 移植）对 OpenAI 系模型精确；o200k_base 为当前默认编码。
- 中文效率：主流 BPE 对 CJK 约 0.6～1.5 token/字，且模型间差异大（"字符÷4"对中文会**系统性低估 2～4 倍**，设计弃用它完全正确）；第三方基准（如 tokenizer efficiency benchmark）给出各模型每字符 token 数量级参考。
- 国产模型：Qwen 官方文档提供 token 计数接口/工具；DeepSeek 有自有 tokenizer。跨厂商精确计量需要"每模型 tokenizer 映射"，否则退化为保守系数＋usage 回报校准。
- **业界通行做法正是设计 §7.4 的方案**：本地精确或保守估算，再以服务商返回的 `usage` 做回归校准。可直接落地：`估算值 × 校准系数（滚动均值）`，按 (provider, model) 维护。

**（b）提示压缩**：**LLMLingua**（微软，EMNLP'23/ACL'24）用小型 LM 对提示做 token 级删减，官方声称最高 20x、常规 2x～5x，LongLLMLingua 针对长上下文。风险：压缩是**信息有损**的，高压缩率下强约束、异议可能被删——与设计"禁止静默丢约束"直接冲突。定位建议：**只允许作用于低风险大块**（工具原始输出、已归档历史正文的回忆副本），决策/约束/待办白名单禁止压缩；一期可不做，二期作为"工具结果有界化"的备选。

**（c）记忆层**：

| 方案 | 机制 | 对"三层"的覆盖 |
| --- | --- | --- |
| **mem0** | 对话中抽取事实→向量库＋检索注入 | 只覆盖"事实回忆"，无结构化业务状态 |
| **Letta（MemGPT）** | 分页式主上下文＋外部存储，agent 自编辑记忆（memory hierarchy） | 覆盖"按页回忆"思想；但管理的是自由文本记忆，不理解"决策版本/交付/基线" |
| **Zep** | 时序知识图谱，时间感知检索 | 事实型回忆＋时效处理，同样无业务结构 |

共同缺口：三者管理的都是**语义记忆**，而设计第二层"有效任务记录"（当前目标、有效决策＋revision、议题、交付、待办、消费位置）本质是**结构化业务状态**——应由数据库承载并按 ID/版本重载（设计 §7.4"已有事实和决策按 ID/版本重载"正确），向量记忆层解决不了也不该由它解决。可借鉴的是 MemGPT 的分页/召回组织方式。

**（d）自动压缩对照物**：Claude Code 的 auto-compact 在上下文逼近阈值时把历史压成**结构化摘要**（固定分段：目标、决策、状态、待办等），再继续；Anthropic Cookbook 亦发布"自动上下文压缩"工具模式（阈值触发→旧历史替换为结构化摘要→新会话延续）。与设计"60% 提前压缩＋压缩不丢白名单字段"同构，且证实"提前压缩＋结构化保留"是业界已验证路径。Claude Code 的教训（第三方设计分析）还显示：压缩后必须保留摘要之后未消费消息的待消费指针——设计 §7.5"事件消费位置"与 C10 步骤 3 已覆盖。

### 3.3 结论

**自研三层（C10 方向正确）；业界无现成"三层上下文"实现。** 要点：

1. 计量：模型 tokenizer 映射（tiktoken 系精确、国产模型官方计数或保守系数）＋ usage 滚动校准；压缩请求自身也要过预算检查（C10 定向测试已列）。
2. 第二层用数据库结构化记录按 ID/版本注入，**不引入向量记忆框架**；完整历史分页回忆可参考 MemGPT 的组织方式。
3. LLMLingua 列为二期"低风险大块压缩"可选项，决策/约束白名单永不压缩。
4. 压缩摘要采用固定结构化分段（对齐 Claude Code auto-compact），保证"异议/待办/基线/消费位置"作为字段级保留而非叙事性丢失。

### 3.4 来源

- tiktoken（OpenAI 官方 BPE tokenizer）: <https://github.com/openai/tiktoken>
- Qwen token 计数官方文档: <https://platform.qianwenai.com/docs/developer-guides/run-and-scale/token-counting>
- Tokenizer 效率基准（各模型 chars/token，含 CJK 讨论）: <https://vibeengines.com/handbook/tokenizer-efficiency-benchmark>
- LLMLingua（GitHub）: <https://github.com/microsoft/LLMLingua>
- LLMLingua 论文: <https://ar5iv.labs.arxiv.org/html/2310.05736>
- LongLLMLingua（ACL 2024）: <https://aclanthology.org/2024.acl-long.91.pdf>
- Agent 记忆框架对比（mem0/Letta/Zep 等，2026）: <https://atlan.com/know/best-ai-agent-memory-frameworks-2026/>
- 记忆系统机制对比笔记: <https://github.com/zycaskevin/Vault-Agent-Memory/blob/main/docs/memory_system_comparison.md>
- MemGPT 记忆层级研究综述: <https://agentic-ai.readthedocs.io/en/latest/AgentMemory/research-papers/#memory-architecture-patterns>
- Claude Code auto-compact 设计解析: <https://github.com/6551Team/claude-code-design-guide/blob/main/part5/15-compact_en.md>
- Anthropic Cookbook 自动上下文压缩: <https://platform.claude.com/cookbook/tool-use-automatic-context-compaction>

---

## 4. 桌面前端渲染

### 4.1 设计需求点

| 需求 | 来源 |
| --- | --- |
| DOM 人物层（pet/气泡/审批/思考流全复用）＋ Canvas 氛围层垫底（连线/粒子/涟漪/光效），canvas 端点 rAF 跟随 DOM 位置 | D14 |
| 离席制移动：讨论临时向彼此移动、结束归锚点；拖拽设锚点，自动移动不覆盖锚点 | D15 |
| 场景皮肤＝词表＋场景模板，数据驱动语义区域（工位区/会议区/休息室） | D11、D17、C16 |
| 业务不等待动画；不可见桌面停装饰 rAF、继续同步事件；减少动态效果 | §9、C16 步骤 3 |
| Vue 3 体系；皮肤版本随任务持久化 | C16、S04 |

### 4.2 候选技术栈对比

**（a）氛围层引擎选型**：

| 方案 | 特点 | 对本设计的适配 |
| --- | --- | --- |
| **原生 Canvas 2D** | 零依赖；连线/粒子/涟漪/光效均为基础图元；单层 2D context 足够 | **一期首选**。氛围层无交互无命中，场景图引擎的能力用不上 |
| **Konva** | 2D canvas 场景图：图层、节点、事件、序列化；官方 vue-konva 绑定；官方"如何选 canvas 库"指南把 Konva 定位为交互型 2D 应用 | 交互/命中是它的核心卖点，本层恰好不需要；若二期氛围层要复杂编辑能力可再上 |
| **PixiJS** | WebGL/WebGPU（v8），渲染性能天花板，体积与上下文开销大；vue3-pixi 集成 | 一期过重；设计 §附录 6.1 已预留"氛围层升级 WebGL（如 PixiJS）"的演进位——**作为二期特效升级路径保留** |
| Fabric.js | SVG/Canvas 双后端，编辑器场景见长 | 不需要 |

**（b）动效资产管线**（人物待机/表情动效的可选项）：

| 方案 | 适配 | 结论 |
| --- | --- | --- |
| **Lottie** | 设计师 AE 导出 JSON，web 运行时轻，替换现有 CSS sprite 动效成本低 | 二期可选（皮肤动效增强） |
| **Rive** | 状态机驱动（待机/思考/讨论可切换），运行时 ~100KB，交互性强 | 二期可选；状态机与"运行状态绑定动画"契合 |
| **Spine** | 骨骼动画，游戏级表现 | 美术管线成本最高，**不推荐** |

一期人物层继续复用现有 pet CSS 组件（设计 D14 前提），动画管线不进入关键路径。

**（c）DOM＋Canvas 双层同步的通行做法与坑**（设计 D14 的"端点 rAF 跟随"在业界的标准形态）：

1. **单一 rAF 循环**驱动整个场景；禁止两个循环各自写 canvas/DOM。
2. **读写分离防 layout thrashing**：每帧先批量读（优先从**状态中直接取人物坐标**——移动本身由状态机驱动，DOM transform 只是投影；确需 DOM 值时缓存 `getBoundingClientRect`，窗口变化时经 `ResizeObserver` 失效）再统一写 canvas。业界常见坑正是"每条连线端点都实时 `getBoundingClientRect`"导致每帧多次强制布局。
3. **人物移动用 `transform: translate3d`**（合成层动画，不触发 layout/paint）；`will-change: transform` 限定在移动中的人物上。
4. **canvas 用 `pointer-events: none`**，让 DOM 人物层独占命中；拖拽（锚点）在人物层用 Pointer Events 处理，自动移动只读不写锚点（对应设计"拖拽不被自动移动覆盖"）。
5. **缩放/重排**：统一 zoom 因子（DOM 与 canvas 同乘），场景模板区域尺寸变化后人物按区域相对坐标重排（C16 步骤 2 的"区域内相对位置"）。
6. **资源释放**：`visibilitychange` / 组件卸载时 cancel rAF、清空粒子数组、移除 ResizeObserver（C16 步骤 4 与定向测试已列，这是业界 WebGL/canvas 应用的标准清理清单）。
7. **devicePixelRatio**：canvas 尺寸＝CSS 尺寸×DPR，避免高分屏模糊。

**（d）Vue 3 集成**：氛围层用 composable（`useCanvasScene`：onMounted 建 canvas/rAF、onBeforeUnmount 清理、watch 同步皮肤/场景数据）；若选 Konva/PixiJS 则用 vue-konva / vue3-pixi 声明式绑定。皮肤模板本身是纯数据（词表＋区域布局），与渲染引擎解耦——设计 C16-scene-v1 模板格式的做法正确，建议保持"模板数据 ↔ 渲染适配器"单向依赖。

### 4.3 结论

**一期：原生 Canvas 2D＋单 rAF 跟随循环＋transform 合成层移动（直接落实 D14，零新依赖）；借鉴 Konva 的"多层分离"思想（背景/连线/粒子分 canvas 层）。** 二期：氛围层特效升级可平滑迁 PixiJS（人物层不动，仅换氛围层渲染器——设计附录 6.1 已预留）；人物动效增强可选 Lottie/Rive；Spine 放弃。业界对该混合架构的成熟共识（rAF 单循环、读写分离、DPR、释放清单）应直接进入 C16 实现规范。

### 4.4 来源

- Canvas 库对比（Fabric.js vs Konva vs PixiJS，2026）: <https://www.pkgpulse.com/guides/fabricjs-vs-konva-vs-pixijs-canvas-2d-graphics-2026>
- Konva 官方"如何选择 canvas 库"（中文）: <https://konvajs.org/zh-Hans/docs/guides/best-canvas-library.html>
- PixiJS v8 发布（WebGPU/WebGL）: <https://pixijs.com/blog/pixi-v8-launches>
- vue-konva（Vue 3 官方绑定）: <https://github.com/konvajs/vue-konva>
- vue3-pixi（Vue 3 渲染器）: <https://www.npmjs.com/package/vue3-pixi>
- Rive vs Lottie 对比: <https://framer.rive.app/blog/rive-as-a-lottie-alternative>、<https://lottiefiles.com/blog/lottie-animations/lottiefiles-or-rive>
- Canvas overlay 与 DOM 内容对齐实践: <https://stackoverflow.com/questions/77346607/drawing-into-a-position-fixed-overlay-aligned-with-scrolling-inline-content>
- CSS transform 合成层动画性能参考: <https://github.com/oakoss/agent-skills/blob/main/skills/css-animation-patterns/references/transforms-and-performance.md>

---

## 5. 协议与一致性

### 5.1 设计需求点

| 需求 | 来源 |
| --- | --- |
| 变更带操作 ID；修改已有对象带期望版本；版本断档→重取快照；身份来自执行上下文不可由模型传入 | §4.3 |
| 业务状态＋待投递记录在系统库**同事务**写入；跨消息库投递以唯一 deliveryId 幂等处理，不宣称跨库原子 | §4.2 |
| 桌面接口：快照＋增量订阅（wanxiang.desktop）；锚点/皮肤随任务持久化 | §4.3、§9 |
| 发布 `preparing→临时→校验→发布→ready`；崩溃后按 operationId 补完或保持失败 | §4.2 |

### 5.2 业界对照

**（a）操作 ID＋期望版本＝乐观并发控制（OCC）的教科书形态**。HTTP 世界对应 ETag/If-Match→412 Precondition Failed（CEDAR 等学术 API 的标准做法）；JSON 业务 API 惯例是请求体显式 `version`/`expectedVersion` 字段＋冲突时返回当前版本。设计"版本断档重取快照"即"冲突→重读→重放"，与惯例一致。补充建议：操作 ID 同时充当**幂等键**（同 operationId 重试不产生第二个副作用），与"崩溃后按 operationId 补完或保持失败"的恢复语义闭环。

**（b）快照＋增量订阅＝事件溯源/投影读模型**。事件溯源模式的读模型（projection）就是"当前状态快照＋其后增量事件"；客户端同步的通行协议是**游标/最后事件 ID**（SSE 原生支持 `Last-Event-ID` 重连），服务端保留有界事件日志，游标落后超窗时下发全量快照重建。设计 wanxiang.desktop 的"快照、增量订阅"正是此模式，无业界争议点。

**（c）deliveryId 去重＝幂等消费者＋事务性发件箱**。设计 §4.2"业务状态＋待投递记录同事务写入、跨库投递幂等"逐字对应两个微服务标准模式：

- **Transactional outbox**（microservices.io）：业务状态与待发消息在同一本地事务落库，后台发布器轮询外发——解决"跨存储无分布式事务" exactly；
- **Idempotent consumer**（microservices.io / Azure 架构中心）：消费方以唯一消息 ID 去重表保证 at-least-once 投递下的 exactly-once 效果。

落地要点：deliveryId 用数据库**唯一约束**做最后防线（防并发双投）；投递代际/游标随任务持久化（设计 wake.ts 已有"结果投递代际"可复用）；SSE 重连用 Last-Event-ID。

### 5.3 结论

**业界有成熟模式，设计已与模式对齐 → 按标准模式自研即可，无需引入消息中间件**（单机 Electron/Node 形态下 outbox＝本地数据库表＋轮询发布器，不引入 Kafka/MQ）。唯一提醒：把"operationId 幂等键语义"和"deliveryId 唯一约束"写进 C01 契约冻结项，避免实施时只靠应用层去重。

### 5.4 来源

- Transactional Outbox 模式: <https://microservices.io/patterns/data/transactional-outbox.html>
- Idempotent Consumer 模式（microservices.io）: <https://microservices.io/patterns/communication-style/idempotent-consumer.html>
- Idempotent Consumer（Microsoft Azure 架构中心）: <https://learn.microsoft.com/azure/architecture/patterns/idempotent-consumer>（源文档: <https://raw.githubusercontent.com/MicrosoftDocs/architecture-center/refs/heads/main/docs/patterns/idempotent-consumer.md>）
- ETag/If-Match 乐观并发惯例实例: <https://metadatacenter.readthedocs.io/en/latest/developer-guide/cedar-rest-apis/etag-concurrency/>
- 事件溯源读模型（projection）解析: <https://api.pgxn.org/src/pg_trickle/pg_trickle-0.76.0/blog/event-sourcing-read-models.md>
- Outbox 模式参考实现: <https://github.com/whiskels/outbox-example>

---

## 6. LLM 网关层

### 6.1 设计需求点

| 需求 | 来源 |
| --- | --- |
| 多实例共享同一 provider/key（同 key 同模型并发请求数量级上升）→ 需并发上限/排队/优先级 | 附录 M4、§5.5 |
| 429 退避；速率限制、retry 风暴防护 | M4 |
| 配额分账：单任务模型请求并发默认 8；等待回复不占模型槽位；任务/角色配额分开 | §10、§5.5、§7.2 |

### 6.2 候选方案对比

| 方案 | 能力 | 取舍 |
| --- | --- | --- |
| **LiteLLM（Router/Proxy）** | 每 deployment 的 rpm/tpm 限制、`allowed_fails`＋cooldown 熔断、优先级路由（priority-based）、重试＋指数退避＋多 deployment 负载均衡；429 时尊重 Retry-After（近期 PR 已在路由错误上透传 Retry-After） | 语义最全，但是 **Python 代理**：CheryClaw（Node/TS 单机产品）要么内嵌 sidecar 进程要么要求用户部署，运维面/打包体积不划算。**语义值得抄，进程不建议嵌** |
| **OpenRouter** | 托管统一网关，自带按 credits/模型的 rate limits（402/429 明确语义） | 引入外部依赖、数据路径与费用，限流策略不在自己手里；**只适合作为可选 provider 接入，不适合当内部网关** |
| **自建进程内网关（推荐）** | Node 生态：`p-limit`（并发信号量）/ `p-queue`（并发＋interval＋优先级＋暂停/恢复）按 (provider, key) 建队列组 | 与现有 `src/service/chat` 同进程，"排队不占模型槽位"天然成立（排队只是不发起请求）；可控、可持久化任务配额 |

**自建要点（吸收 LiteLLM 语义）**：

1. **并发闸门**：按 (provider, apiKey) 全局信号量（默认＝设计单任务 8 并发，多任务共享时按权重轮转），跨团队 round-robin/加权公平队列防单任务饿死。
2. **429 处理**：读 `Retry-After`；无则指数退避＋full jitter（业界防 retry 风暴的标准组合）；连续 N 次 429/5xx 触发 cooldown 熔断（LiteLLM `allowed_fails` 语义），冷却期内该 key 的队列整体暂停并向上游返回"资源不足排队"（R21 入口）。
3. **优先级**：用户交互/安全审批链 > 讨论回合 > 后台执行；等待中的讨论回合不占并发（§7.2）由网关出队后才计费实现。
4. **TPM 令牌桶**（可选二期）：以 usage 估算滚动 TPM，接近 provider 上限时主动降速，减少 429。
5. **公平性可观测**：队列深度/等待时长投影到任务中心（复用 overview 投影），支撑 R21"调整范围/预算"入口。

### 6.3 结论

**自建进程内网关（p-limit/p-queue ＋ Retry-After/退避/jitter ＋ cooldown 熔断），直接采纳 LiteLLM Router 的限流/熔断/优先级语义作为行为规格。** LiteLLM 留作二期"多 provider 复杂路由/预算分账"的 sidecar 备选；OpenRouter 仅作为可选 provider，不承担内部网关职责。设计 M4 提出的"全局并发上限"一期就应做（成本极低：一个按 key 的信号量）。

### 6.4 来源

- LiteLLM Router（负载均衡/限流/cooldown/优先级）: <https://docs.litellm.ai/docs/routing>
- LiteLLM routing 文档源文件: <https://github.com/BerriAI/litellm/blob/main/docs/my-website/docs/routing.md>
- LiteLLM Retry-After 透传 PR: <https://github.com/BerriAI/litellm/pull/27678>
- OpenRouter API 限额（402/429 语义）: <https://openrouter.ai/docs/api-reference/limits>
- AI API 限流处理最佳实践（2026）: <https://www.assisters.io/blogs/how-to-handle-rate-limits-on-ai-apis>
- p-queue（并发/interval/优先级/暂停）: <https://www.jsdocs.io/package/p-queue>

---

## 汇总：一期建议采用 / 二期演进

| 领域 | 一期建议采用 | 二期演进 | 关键借鉴 |
| --- | --- | --- | --- |
| 1 多 Agent 编排 | 自研讨论调度器（C08）：回合制停等＋必需回复者栅栏＋邮箱投递去重；**wait-for 图环检测**作为死锁防线；讨论等待状态可持久化可重建 | 讨论/等待状态机接入更通用的检查点恢复；紧急打断两档化 | LangGraph（checkpoint/interrupt/resume）、Claude Agent Teams（邮箱/任务板/attempt 所有权）、AG2（按轮选人→按轮等齐）、MetaGPT（公共流） |
| 2 快照与隔离 | 自研普通复制＋manifest＋哈希（C03 原案）；三方合并 **node-diff3**（普通目录）＋可选 `git merge-file`（Git 项目）；复制/哈希流水线化 | 平台 COW 能力探测（APFS clonefile / ReFS block cloning / Btrfs reflink，失败回退）；全局 **CAS** 去重存储（restic 式 blob 池＋引用清单）；Linux 形态评估 overlayfs | restic/git 对象模型；Docker overlayfs 分层 |
| 3 上下文管理 | 自研三层（C10 原案）：DB 结构化记录按 ID/版本注入；tokenizer 映射（tiktoken/官方计数）＋usage 滚动校准；结构化分段压缩摘要 | LLMLingua 仅用于工具输出等低风险大块；TPM 联动压缩 | MemGPT（分页回忆）、Claude Code auto-compact（结构化摘要＋消费指针） |
| 4 桌面渲染 | **原生 Canvas 2D**＋单 rAF 跟随循环＋transform 合成层移动；读写分离防 layout thrashing；visibilitychange/卸载释放清单进 C16 规范 | 氛围层迁 PixiJS（人物层不动）；皮肤动效可选 Lottie/Rive；Spine 放弃 | Konva（多层分离思想）；设计附录 6.1 已预留 PixiJS 演进位 |
| 5 协议一致性 | 按标准模式自研：operationId 兼幂等键＋expectedVersion（冲突重取）；本地库 outbox 表＋轮询发布器；deliveryId **数据库唯一约束**去重；SSE `Last-Event-ID` 游标增量 | 事件日志分窗归档（游标超窗→全量快照重建） | Transactional Outbox、Idempotent Consumer、ETag/If-Match、事件溯源投影 |
| 6 LLM 网关 | 自建进程内网关：按 (provider,key) 信号量＋优先级队列（审批>讨论>后台）＋Retry-After/退避/full jitter＋cooldown 熔断 | TPM 令桶；多 provider 路由/预算分账（届时再评 LiteLLM sidecar） | LiteLLM Router 语义（allowed_fails/cooldown/priority）；OpenRouter 仅作可选 provider |

### 对设计的三个具体补充建议（供评审整合）

1. **C08 补"wait-for 图环检测"为显式步骤**：§7.2 只说"新阻塞边形成环时拒绝"，建议把组间邀请、父等子、审批等待统一入一张有类型等待图，环检测作为协议级闸门（对应附录 H2"禁止跨层讨论的强制面"同款 fail-loud 传统）。
2. **C03/C04 预留"复制策略接口"**：一期普通复制实现为该接口的一个实现类，二期 COW/CAS 不动调用方；同时把"平台 COW 能力探测"列入预检（影响空间预估与提示文案）。
3. **C01 契约冻结两个语义**：operationId 的幂等键语义（重试不重复生效）与 deliveryId 的唯一约束；这两点是跨存储一致性的最后防线，不能只靠应用层自律。

---

*调研局限说明：来源以官方文档与工程实践文章为主，个别对比（如国产模型 tokenizer 精确比率、海量小文件复制耗时）给出的是数量级判断，实施时以 C03/C10 的定向基准测试为准（C03 步骤 4 已要求"记录大文件与大量小文件基准"）。*
