# 角色行为权限与命令安全

`senseGroup` 只决定角色能看到哪些工具；`roles.<name>.permissions` 决定该角色每次调用工具时是允许、要求人工审核，还是直接拒绝。检查位于统一工具中间件，因此内置 Sense、MCP 和子角色工具都不能通过直接持有写工具来绕过。

## 策略模板

- `read-only`：禁止写工具，命令只允许只读沙箱，MCP 与派遣默认拒绝。
- `workspace-developer`：允许工作区内读写；未知 MCP 要审核；命令最多使用工作区可写沙箱。
- `supervised`：变更类工具、未知 MCP 与派遣默认审核；这是未声明策略的安全默认值。
- `trusted`：减少语义审批，但仍不能绕过系统路径守卫、参数绑定和 OS 沙箱。

可继续配置 `filesystem.read/write`、`commands.shells/maxSandboxMode/categories`、`mcp.default/tools`、`spawn.effect/allowedRoles` 与工具名通配规则 `tools`。设置页进入预设 → 「编辑角色」→ 角色详情「行为权限」提供常用选项。

## 智能命令审核

`execute_command` 必须提交：

```json
{
  "shell": "powershell",
  "command": "Get-ChildItem",
  "description": "列出工作区文件",
  "workdir": "."
}
```

Bash 使用 `unbash` AST；PowerShell 使用 `System.Management.Automation.Language.Parser.ParseInput`。分析器遍历嵌套命令，识别删除、系统修改、提权、网络、凭据、动态代码、混淆、重定向与未知程序。解析失败、动态命令名和未知命令均不能自动放行。

审批卡显示角色、风险项、源码片段和要求的沙箱模式。批准只绑定当前工具参数、风险评估哈希和角色策略哈希；参数被 Hook 修改或策略变化后，旧批准立即失效。

## 风险等级

工具安全判定（`authorizeToolCall` 的 findings）固定四档，透传到前端风险徽章与审批卡：

- `safe`（安全，绿）：读操作等无副作用调用，直接放行、无审批卡。
- `medium`（中风险，黄）：有明确且受控的副作用，需人工审批后才执行。
- `high`（高风险，红）：高危副作用（系统级修改、凭据、提权、网络外联等），需审批并强调核对。
- `unknown`（未知，灰）：未声明副作用 / 未被既有规则覆盖的工具，按安全默认值处理（受监管角色要求审批）。

**config_manage（配置管理）**：已声明副作用，不再落入「未知」。读操作（`get` / `asset_get`）在受监管角色直接放行且无判定（安全）；写操作（`patch` 等）要求审批并给出**中风险**判定（将修改 `.chery` 配置或受管资产，批准后才会落盘）。前端 lite 详情抽屉的徽章呈现见 `mcu-lite-workbench-ui.md` §4.4。

## OS 沙箱

- Windows：DeepSeek Harness 的 `@deepseek-ai/dsh-sandbox-windows-acl` restricted-token/ACL runner。
- Linux：Bubblewrap（`bwrap`），不可用时拒绝执行。
- macOS：Seatbelt `sandbox-exec`，不可用时拒绝执行。

执行始终采用精确 argv，禁用 Node `shell: true`。没有有效会话工作区、沙箱不可用或初始化失败时均 fail closed，不会静默重试为裸命令。Windows ACL 后端主要限制写入；读取、网络和进程可见性仍受其平台机制限制，不能视为完整机密隔离。
