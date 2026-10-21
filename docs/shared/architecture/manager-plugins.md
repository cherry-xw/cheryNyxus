# cheryNyxus 插件体系：Manager 管理模块

本文拥有 Manager 动态资源、HTTP 路径、版本和权限边界。统一包、能力授予及 Backend 管理注册见[统一宿主](ingress-plugins.md)。资源保存及失败分类见[管理业务](manager-management.md)，认证见[Manager 认证](../protocol/manager-auth.md)。

## 职责与入口

Manager 本体保留登录、认证、Session、受控本地进程监管、基础状态与插件容器管理。**Backend 管理插件（`cherynyxus-backend-manager`）作为默认预装插件随 Manager 内置提供**（无需依赖 Backend 在线即可展示运行状态、CPU/内存/运行时长、stdout/stderr 环形日志、切换“随插件启动 Backend”开关、手动触发启动、在 5s/15s/30s 最多 3 次异常重试等待期取消重试，以及维护 AI Web 独立业务登录参数；接口为 `/api/backend-plugin/{status,start,cancel-retry,config}` 与 `/api/business-login/config`）。QQ、设置（`capabilities`）等依赖 Backend 的业务插件与 Backend 管理插件**平级展示**；当 Backend 未启动或离线时，`/api/plugins` 从本地 `.chery/ingress/registry.json` 安全只读已安装插件列表并标记 `backendUnavailable: true`（原因：`依赖 Backend 运行，当前不可用`），前端卡片置灰操作按钮而不报错。连接凭据通过显式配置的 `connectionCredentials` 映射提供通用受保护接口 `/api/connections/<moduleId>/credential`（GET）与 `/rotate`（POST/PUT）；只允许已安装并登记管理页面的模块，未配置不创建文件。部署提供既有凭据文件路径，读取不轮换，写入原子替换并回读。QQ 说明、复制和重建提示归 QQ 页面。实际复用的页面请求、页面外壳、下拉框和样式归 `packages/manager-ui`，插件不引用 Manager 私有源码。QQ/设置完整页面随 Backend 包构建；本体不静态导入业务面板或服务端工厂，不提供旧固定页面兜底。无业务包仍可登录和管理插件。关闭管理网页不影响实时业务；整体进程关系见[后端运行](../../guides/backend-runtime.md)。

| 修改意图 | 实现入口 | 验证入口 |
| --- | --- | --- |
| 动态目录、资源和有限分发 | [dynamic.ts](../../../apps/manager/src/modules/dynamic.ts) 的 `DynamicModules` | [dynamicPlugins.test.ts](../../../apps/manager/test/dynamicPlugins.test.ts) |
| Session 后接入 HTTP | [server.ts](../../../apps/manager/src/server.ts) 的 `createManager` | [management.test.ts](../../../apps/manager/test/management.test.ts) |
| 管理安装来源 | [pluginConfig.ts](../../../apps/manager/src/pluginConfig.ts) 的 `readManagerPlugins` | Manager 类型检查 |
| 页面导航和配置操作 | [usePlugins.ts](../../../apps/manager/ui/usePlugins.ts)、[pluginPage.ts](../../../packages/manager-ui/src/pluginPage.ts) | 动态插件测试及用户验收 |
| 包业务处理 | [设置包](../../../plugins/settings/src/index.ts)、[QQ 包](../../../plugins/qq/src/index.ts) | [设置测试](../../../plugins/settings/test/settingsPackage.test.ts)、[管理接入测试](../../../apps/manager/test/management.test.ts) |
| HTTP 类型 | [ingress.ts](../../../packages/protocol/src/ingress.ts) 的 `IngressHttpRequestSchemas`、`IngressHttpResponseSchemas` | 动态插件测试 |

## 动态资源边界

API 对象只引用[统一宿主 API2](ingress-plugins.md#backend-宿主管理-rpc-与共享-schema)，不维护第二套安装系统。旧静态注册器、启用列表、工厂和内联业务页面已删除，页面由 Backend 包的管理注册决定。

### Manager 本体与加载

QQ moduleId 为 `qq`，设置 moduleId 为 `capabilities`，既有业务 HTTP 前缀保持。页面采用预构建 HTML，仅通过 Manager 内部弹窗的 `/modules/<moduleId>?embedded=1` 加载；直接浏览器导航拒绝访问。嵌入响应去除独立页面的外框和返回导航，插件业务内容及管理操作保持完整。Manager 按动态登记的插件归属在内部可拖动窗口中嵌入完整页面，不生成插件专属顶层导航；多个管理页面在同一插件窗口内切换并保留页面状态。外层插件卡片仅提供打开、启用、停止和卸载，包配置读写与页面诊断位于内部窗口。本体不执行包的 Manager 服务端代码。包新增不要求重建 Manager。同源可信页面不是隔离沙箱，不承诺独立进程或不可信代码隔离。

`manager.plugins.packageSourceRoot` 必须由管理员配置为绝对安装来源根。未配置时安装/升级不可用，其他管理仍可用。Backend `IngressHostOptions.packageSourceRoot` 采用同一受控来源语义，两端实际目录可不同；Manager 仅传根内相对 packagePath，不把浏览器输入当任意宿主路径。不提供 URL 下载、上传或解压接口。

### 公开 HTTP

所有插件 API 返回 `{data:T}` 或 `{error:{code,message}}`，类型复用共享 schema；操作携带 contractVersion=2。业务 API 从登记 routes 规范化 pathParams/query/body，只调用固定 `ingress.management.call`；无任意 RPC 或浏览器指定 Backend 地址。

| 方法/路径 | 映射与响应 |
| --- | --- |
| GET `/api/plugins` | 无 query；`ingress.list`，返回 `IngressListResult` |
| POST `/api/plugins/install`、`upgrade` | 复用宿主操作 schema；保存后回读 list |
| POST `/api/plugins/<id>/enable`、`disable`、`uninstall` | body 含 contractVersion、expectedRegistryRevision、requestId；安全路径提供 id |
| GET/PUT `/api/plugins/<id>/config` | 配置读取/保存；写入含 expectedBaseRevision、requestId，保存后回读 |
| GET `/api/modules` | `ingress.ui.list`，含 managerApiVersion=2 与 registryRevision |
| GET `/modules/<moduleId>` | 读取登记 descriptor.entry；返回受保护 HTML |
| GET `/modules/<moduleId>/assets/<resourceVersion>/<path>` | `ingress.ui.read`；原始字节/MIME，版本不同409 |
| `/api/modules/<moduleId>/...` | 登记的有限业务处理；停用仍允许管理 |

`ManagerUiRegistration` 为宿主 `IngressUiRegistration` 加 pagePath、assetPrefix 和 manager 状态（apiVersion、resourceVersion、ready/unavailable/version_mismatch、reason）。包版本、savedVersion/activeVersion、UI resourceVersion 与 Manager 已加载状态分别展示；list 成功不能代表页面已加载。目录变化重新读取描述，卸载不继续使用旧缓存。Backend 离线显示不可用，不退回本地业务配置。

Manager 在 HTML head 中加入唯一 `<base href="/modules/<moduleId>/assets/<resourceVersion>/">`，包不自带 base，资源使用相对 URL，不硬编码公开 `/assets/`。业务 API 使用绝对同源 apiPrefix。拒绝跨模块资源、点段、双重编码、反斜杠、符号链接及 config/data 读取；资源只能来自声明目录。

管理主窗口按内容增高，不强制占满屏幕。安装与更新构建包使用已安装列表上方的统一入口，来源目录与权限限制不变。插件列表分开显示运行状态、保存和活动版本、配置应用状态及操作；依赖和能力详情可展开。插件内部窗口可拖动、调整尺寸和最大化，受当前可见范围限制；页面自身负责设置分类、保存操作及记录浏览，不由 Manager 识别 QQ 字段。

HTML、后续资产及 API 全部先校验 Session、Host；带 Origin 必须可信同源，拒绝 Sec-Fetch-Site=cross-site，写入继续要求 Origin。不开放 CORS。响应 no-store、nosniff；机器密钥不能代替 Session。基础 `/api/auth/`、`/api/machine/`、状态/连接/凭据、进程/relay、本体 `/`/`index.html`/`assets/` 不可覆盖；重复 moduleId、路径或前缀拒绝。

Backend 离线503 unavailable，接口版本不同409 api_version_mismatch，未安装模块404 not_found，未登录401，Host/Origin拒绝403，revision冲突409。Backend认证失败502 backend_auth_failed，不能解释为 Manager 登出。服务端仍完成 Backend challenge/login，不因 Session 跳过认证。

### 保存、停用与双端生效状态

写入保留 requestId 和 expected revision；保存后回读相同对象/版本。未知写入502 save_unconfirmed，不自动重试。配置显示 applied/pending/failed/restart_required；代码保存版本与活动版本分开，需重启明确展示，不自动重启。

停用撤业务但保留已安装包配置、诊断 UI 和管理 API。卸载必须先完成有界停止，再撤导航、HTML、资产和专用 API，默认保留长期数据。旧页面下次资源/API 请求不可用。Manager 账号、凭据、Session 和连接配置不属于删除对象。

## 构建与验证

[QQ 页面构建](../../../plugins/qq/ui.vite.config.ts) 与[设置页面构建](../../../plugins/settings/ui.vite.config.ts) 分别将本插件页面打入独立包。运行 `pnpm manager:test`、`pnpm manager:type-check`、`pnpm manager:build` 及服务端构建 `pnpm exec vite build --config apps/manager/vite.config.ts --ssr`。动态测试覆盖合成非 QQ 包、撤销、权限、路径、版本、未知写入；管理接入测试使用真实临时 Backend HTTP/WS 与 Session 验证两包资源及保存回读。自动测试不代替生产部署、用户视觉或主动真实 QQ 验收，不启动浏览器或检查 DOM/CSS。
