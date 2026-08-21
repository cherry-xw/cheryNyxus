# 角色行为权限与命令安全

`senseGroup` 只决定角色能看到哪些工具；`roles.<name>.permissions` 决定该角色每次调用工具时是允许、要求人工审核，还是直接拒绝。检查位于统一工具中间件，因此内置 Sense、MCP 和子角色工具都不能通过直接持有写工具来绕过。

## 策略模板

- `read-only`：禁止写工具，命令只允许只读沙箱，MCP 与派遣默认拒绝。
- `workspace-developer`：允许工作区内读写；未知 MCP 要审核；命令最多使用工作区可写沙箱。
- `supervised`：变更类工具、未知 MCP 与派遣默认审核；这是未声明策略的安全默认值。
- `trusted`：减少语义审批，但仍不能绕过系统路径守卫、参数绑定和 OS 沙箱。

可继续配置 `filesystem.read/write`、`commands.shells/maxSandboxMode/categories`、`mcp.default/tools`、`spawn.effect/allowedRoles` 与工具名通配规则 `tools`。设置页“角色 → 行为权限”提供常用选项。

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

## OS 沙箱

- Windows：DeepSeek Harness 的 `@deepseek-ai/dsh-sandbox-windows-acl` restricted-token/ACL runner。
- Linux：Bubblewrap（`bwrap`），不可用时拒绝执行。
- macOS：Seatbelt `sandbox-exec`，不可用时拒绝执行。

执行始终采用精确 argv，禁用 Node `shell: true`。没有有效会话工作区、沙箱不可用或初始化失败时均 fail closed，不会静默重试为裸命令。Windows ACL 后端主要限制写入；读取、网络和进程可见性仍受其平台机制限制，不能视为完整机密隔离。
