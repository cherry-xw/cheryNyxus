# Manager 认证与机器接口

Manager 登录独立于后端。入口为 `apps/manager/src/index.ts`，HTTP 实现在 `apps/manager/src/server.ts`；账号、会话和 OIDC 分别由 `accountStore.ts`、`auth.ts`、`oidc.ts` 负责。本说明是页面、CLI 和部署共同遵守的唯一认证契约，不定义聊天后端登录。

## 账号与配置

本机运行 `pnpm manager:dev auth setup` 首次设置，运行 `pnpm manager:dev auth reset` 恢复账号。两者必须在交互终端输入用户名及两次隐藏密码；不接受密码参数，不输出密码。密码长度 12–1024 字符，不裁剪密码。受限文件 `.chery/manager-auth.json` 仅存版本、用户名、随机盐、scrypt 派生值和随机账号版本。Unix 权限为 0600；Windows 需由部署者限制目录 ACL。首次设置不覆盖已有文件，恢复替换账号版本，所有旧 Session 和待完成 OIDC 登录失效。不提供远程初始化/重置 API。

网页登录后的改密通过 [`AccountStore.save`](../../../apps/manager/src/accountStore.ts) 保存：取得账号文件锁后，重新核对已验证账号的用户名、盐、密码派生值和版本；不一致返回 409 `account_changed`。保存前还比较文件原文，拒绝覆盖未使用文件锁的其他写入。并发保护验证见 [`accountTransactions.test.ts`](../../../apps/manager/test/accountTransactions.test.ts)，共享文件锁验证见 [`configTransaction.test.ts`](../../../apps/backend/test/service/configTransaction.test.ts)。

`manager.host` 保留监听设置。`manager.auth` 配置以下启动参数（修改后重启 Manager）：

监听端口默认 39980，可用 `CHERY_MANAGER_PORT` 明确覆盖；CLI 使用同一环境变量连接本机端口。启动测试可设为 0 取得临时端口，CLI 不接受 0。

- `trustedOrigins`：完整 origin 数组，例如 `https://manager.example.com`，必须无路径。默认仅信任实际监听端口的回环 origin；远程域名和局域网 IP 必须显式登记，禁止通配符。
- `trustedProxies`：反向代理的精确 socket IP 数组；仅这些来源可提供 `X-Forwarded-Host` 和 `X-Forwarded-Proto`。不得在代理后暴露 Manager 原端口；代理必须覆盖这些头。机器接口始终使用直接 socket 地址，不使用转发头。
- `sessionTtlMs`：会话最长生存期，默认 8 小时，最大 24 小时。
- `allowInitialSetup`：允许首次从 Manager 页面创建账号，缺省为 true；首次创建成功后持久化为 false。账号文件存在时始终视为已初始化，不能通过该入口覆盖或重置账号。
- `oidc`：显式 `issuer`、`clientId`、`clientSecret`、`redirectUri`、`adminSubjects`。回调 URI 必须在可信 origin 下且路径为 `/api/auth/oidc/callback`。空 subject 名单或不完整配置禁用 OIDC。生产 issuer、discovery 端点及回调均需 HTTPS；仅回环 HTTP 允许用于本机测试。

OIDC 通过 issuer 的 discovery 获取真实 authorization/token/JWKS 地址；校验 discovery issuer、RS256/ES256 签名、state 的浏览器绑定、nonce、PKCE S256、iss/aud/sub/iat/exp/nbf/azp。仅名单内 subject 登录。网络请求禁止重定向，限时 5 秒、JSON 上限 256 KiB；待登录记录 5 分钟到期且单次使用。认证材料不返回浏览器。失败返回安全错误码，不回显提供方响应或秘密。

## 普通浏览器 HTTP

`/` 和 `/index.html` 是公开登录页面外壳，不授予管理权限。所有请求验证 Host 对应的完整 origin，拒绝未登记 Host 和非可信代理转发头。普通 API 仅接受内存 Session Cookie，不接受 URL token、旧 token Cookie 或任何 header token，包括回环请求。带机器凭据请求普通页面/API 被拒绝。

| 方法与路径 | 请求与响应 |
| --- | --- |
| GET `/api/auth/capabilities` | `{password:boolean,oidc:boolean,allowInitialSetup:boolean,initialized:boolean}`；不返回任何哈希、secret 或密码 |
| POST `/api/auth/setup` | 同源 JSON `{username,password}`；仅在无账号且 `allowInitialSetup=true` 时允许一次，成功 200 `{initialized:true,allowInitialSetup:false}`；已初始化、关闭开关或并发创建返回 409 |
| GET `/api/auth/me` | 有会话返回 `{authenticated:true,username,provider,expiresAt}`；无会话 401 `{authenticated:false,error:"unauthorized"}` |
| POST `/api/auth/login` | JSON `{username,password}`；成功 200 `{authenticated:true}` 并设置 Session Cookie；失败 401，未设置账号 503，限流 429 |
| POST `/api/auth/logout` | 必须有会话；删除服务端记录、清 Cookie，返回 `{authenticated:false}` |
| GET `/api/auth/oidc/login` | 启动绑定浏览器的登录，302 至提供方；未配置 503 |
| GET `/api/auth/oidc/callback` | 验证并消费待登录记录；成功设置 Session Cookie、302 至 `/`；失败 401 |
| GET `/api/auth/oidc/config` | 需要 Session；返回 issuer、clientId、redirectUri、adminSubjects、`clientSecretConfigured`、`configured`，不返回 secret；响应带 `restartRequired:true` |
| POST/PUT `/api/auth/oidc/validate` | 需要 Session 和同源 Origin；校验 issuer/clientId/clientSecret/redirectUri/adminSubjects，返回 `{data:{valid,errors}}`，不保存 |
| POST/PUT `/api/auth/oidc/config` | 需要 Session 和同源 Origin；保存到当前 `.chery/config.yaml` 的 `manager.auth.oidc`，secret 只写入不回显；返回脱敏视图和 `restartRequired:true`，重启 Manager 后生效 |

Cookie `chery-manager-session` 为随机不透明 ID，HttpOnly、SameSite=Lax、Path=/，HTTPS 设置 Secure；不设置 Domain。Session 仅存 Manager 内存，重启失效，登出后复制旧 Cookie 无效，恢复账号后旧 Cookie 无效。登录使请求所携带的旧 Session 立即失效，并始终签发新的随机 Session ID，不能固定 Session ID；同账号并发会话允许，由 `sessionTtlMs` 与容量上限共同约束。Session 上限 1000，待 OIDC 登录上限 200。

普通 API 的 POST/PUT/DELETE/PATCH（包括登录和登出）必须提供与当前请求 origin 完全相同、且可信的 `Origin`；拒绝缺失 Origin、跨来源 Origin 和 `Sec-Fetch-Site: cross-site`。JSON 请求限 16 KiB，错误 JSON 返回 400。认证及会话响应 no-store；无 CORS 放行。按 socket IP 限制密码/OIDC 登录启动，每分钟最多 10 次，并有全局每分钟 100 次上限；同时进行的密码校验最多 4 个。可信代理并不授权客户端自报 IP。

已有 `/api/status`、`/api/connection`、进程 start/stop/restart、`/api/credentials`、凭据轮换及 relay 接口全部须 Session。后端离线时仍可登录、查状态、控制 Manager 的子进程、持久保存后端凭据；后端登录自检不可达必须如实返回，不伪报生效。

## 本机机器 HTTP

仅 `/api/machine/status`、`/api/machine/connection` 和 `/api/machine/{backend|rathole}/{start|stop|restart}`。前两项 GET；控制项 POST/PUT。要求直接回环 socket、当前监听端口的回环 Host、`X-Chery-Manager-Machine-Key` 当前机器密钥，拒绝 Origin、Cookie、Sec-Fetch-Site 或代理转发头。其他机器路径 404，尤其不提供凭据读取/轮换。

机器密钥仍保存在 `.chery/manager-token.json`，保留现有文件和轮换机制，但旧密钥宽限不能授权机器接口。显式密钥来源仍为 `CHERY_MANAGER_TOKEN`，它仅用于机器访问，永不打印、不写 URL、不授予用户权限。CLI status/info/start/stop/restart 从当前机器文件或环境读取，使用机器专用 header 和路径；文件缺失报错，不生成新密钥。

## 验证

运行 `pnpm manager:test`（Manager 专用 Vitest 配置）、`pnpm manager:type-check`、`pnpm manager:build`。测试用临时文件和本机 mock HTTP/OIDC，不访问真实 QQ、模型或账号。页面由前端任务消费此契约；真实 OIDC、HTTPS 反代与界面操作由最终用户验收，不由 mock 代替。
