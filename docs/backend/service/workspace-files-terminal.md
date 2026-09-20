# 工作区文件与 Terminal 服务

**状态：** 实施中

## 职责

本模块负责把当前 chat 的 `metadata.workspace` 映射为受控文件根，提供懒加载目录、只读文件读取、文件引用校验，以及本机/SSH Terminal 会话生命周期。设置页的 `config.workspace.browse.*` 仍负责选择目录，不由本模块扩大为任意路径浏览器。

## 文件安全

所有请求以 chatId 查找工作区，再解析客户端提交的相对路径。服务端拒绝绝对路径、`..` 穿越、软链逃逸、`.chery` 目录和非文件读取。列表可以返回普通隐藏项；读取敏感文件时沿用现有环境变量脱敏规则。读取内容必须有大小/范围上限，二进制只返回元数据或受支持的图片数据。

## 文件引用执行

Agent 消息中间件消费最新用户消息中的 `[[file:...]]`，验证后追加仅用于本次执行的路径说明。说明包含相对路径、绝对路径和类型，不读取正文；Agent 后续通过 `read_file` 获取内容。引用无效时保留消息事实，在路径说明中标记错误，供 Agent 向用户解释。

## Terminal

Terminal manager 持有 node-pty 本机伪终端和 SSH2 client/channel。本机工作目录必须在当前 chat 工作区内；SSH 使用 keepalive 和后端首次信任（TOFU）：首次成功认证后由服务端保存目标的 SHA256 主机指纹，后续连接发现指纹变化即拒绝。可使用临时密码、临时私钥或 secretStore 保存的密码。设置页预设只保存凭据标识，密码在服务端以密文保存，创建 SSH 会话时由后端临时解密并交给 `ssh2` 完成认证，不向前端返回明文。主机指纹也只保存在服务端，不通过 RPC 返回前端。会话只属于创建它的 WebSocket 连接，每连接最多 4 个，全局最多 32 个。关闭、断线、30 分钟无输入和服务停止时移除会话记录并调用依赖的关闭接口；输出分段发送，连接积压超过 2 MiB 时关闭。

`ssh2` 与 `node-pty` 在创建终端时通过 Node 的 `createRequire` 加载，不能作为 SSR 静态导入打包：SSH 的可选本机加速模块可能没有构建产物。桌面运行依赖准备与验证见[打包手册](../../frontend/pack-guide.md)。

实现入口为 `src/service/workspace/` 与 `src/service/terminal/`，RPC 注册在 `src/service/index.ts`，公共类型归 `src/service/message/types.ts`。验证入口为 `test/service/workspace/files.test.ts` 与 `test/service/terminal/manager.test.ts`；后者使用本机伪终端和临时回环 SSH 服务验证输入输出、连接归属和主机指纹。
