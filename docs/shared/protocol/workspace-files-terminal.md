# 工作台文件与 Terminal 协议

**状态：** 实施中。本文是工作台文件引用、工作区文件查看和 Terminal RPC 的跨端契约 owner。

## 文件引用

输入框使用 `/`、`@`、`&` 三类结构化 token：

```text
[[command:/compact]]
[[role:@角色名]]
[[file:src/service/chat/handler.ts]]
```

`file` token 只保存工作区相对路径或以 `/` 结尾的目录路径。发送时服务端根据当前 chat 的 `metadata.workspace` 校验路径、拒绝路径穿越和软链逃逸，并把受控引用交给 Agent；服务端不自动读取正文、不把正文注入用户消息。Agent 需要内容时使用已有 `read_file`，读取失败沿现有工具错误语义返回。

没有关联工作区、工作区无效、路径不存在、超出工作区或读取权限不足时，引用保留在消息中，执行时追加的路径说明用 JSON 错误字段告知 Agent。正文不随引用自动读取。路径包含 `]` 的条目可查看，但当前 token 格式不能引用，界面禁用引用并说明原因。

## 工作区文件接口

工作台使用以当前 chat 工作区为根的 RPC，不复用设置页的全局 `config.workspace.browse.*` 根选择器：

| RPC | 请求 | 响应职责 |
| --- | --- | --- |
| `workspace.files.list` | `chatId`、相对目录 `path`、可选 `offset` | 工作区、路径、名称/类型/大小/修改时间/扩展名；每页最多 500 项，可选 `nextOffset` |
| `workspace.files.read` | `chatId`、相对文件 `path` | 路径、大小、`text/image/binary`、可选 MIME/content/truncated；最多 2 MiB 文本或 base64 图片 |

`.chery` 始终隐藏；`.git`、`.env` 等普通隐藏文件可列出。读取接口只读，不接受写入字段。文本和代码返回有界内容，图片返回可预览数据，其他二进制只返回元数据和不支持原因；敏感环境变量沿用现有脱敏规则。

## Terminal 接口

Terminal 由后端持有会话，前端只消费事件：

| RPC/事件 | 作用 |
| --- | --- |
| `terminal.create` | 创建 `local` 或 `ssh` 会话，返回 sessionId、目标类型和标签 |
| `terminal.input` | 写入标准输入 |
| `terminal.resize` | 更新伪终端行列数 |
| `terminal.close` | 主动关闭并释放会话 |
| `terminal.event` | 向所属连接推送合并输出 `output`、`exit`（code/signal）或 `error`（message） |

本机目标运行在当前后端主机；SSH 目标使用 `ssh2` 交互 shell 和伪终端。SSH 采用后端首次信任（TOFU）：首次成功认证后服务端保存目标的 SHA256 主机指纹，后续连接自动核对，指纹变化时拒绝连接；指纹不通过 RPC 传给前端。设置页保存的密码由服务端凭据池加密保存，连接时前端只提交凭据标识，后端在当前 SSH 认证过程中临时解密使用；密码不会回传前端或写入日志。临时密码、私钥及其口令仅用于当次连接，连接尝试结束后清空。工作台关闭、连接断开和空闲超时清理会话；文件面板暂时隐藏保留会话。
