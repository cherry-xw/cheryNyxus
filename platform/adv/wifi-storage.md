# Wi-Fi 板载凭据与启动恢复

本页负责凭据保护、保存与恢复规则；非敏感小设置使用板载 NVS，大资源和普通用户数据优先 SD。分区布局见 [模块入口](README.md#flash-分区构建契约)，本功能不改变已批准双 OTA 布局。

## 现行边界

用户已确认 HMAC eFuse 派生 NVS 密钥作为设计路线；仅授权隔离目标编译与静态核查，未授权保护部署。日常开发配置仍以 `ADV_WIFI_PROTECTION_OFF` 默认开启。凭据写入和启动加载均拒绝，临时联网不是最终成品。Wi-Fi SDK 始终禁用自身 NVS 并使用 `WIFI_STORAGE_RAM`，避免在另一个命名空间留下明文副本。非敏感偏好可单独提交，auto_connect 只有在偏好读取成功、已开启、保护已部署、凭据记录有效时才触发一次异步连接；失败不擦除凭据、不阻塞启动器、不无限重试。

[保护初始化](main/wifi_security.cpp) `adv_nvs_init` 替代普通 `nvs_flash_init`。后者在启用加密时可能生成 NVS 密钥，HMAC 路线缺密钥时甚至会自动烧 eFuse，因此不能直接保留该入口。当前关闭状态只初始化普通小设置 NVS；若 SDK 开启加密但应用未选择保护，拒绝初始化，不降级明文。选定后只调用读取/派生已有密钥与 `nvs_flash_secure_init`，不调用密钥生成、烧写或擦除接口。初始化错误不重置存储。

[凭据服务](main/wifi_credentials.cpp) `save_credentials`、`load_credentials` 由主任务串行调用；单命名空间、单 blob 保存版本、认证方式、SSID 和密码。固定字节格式与长度校验，不序列化 C++ 结构填充。未知版本、坏长度、非法字段或读取错误拒绝覆盖；保存前重新读取，`nvs_set_blob` 后显式 `nvs_commit`，失败不报告已保存。提交失败后的硬件持久状态未知，下一次读取重新确认，不承诺多记录事务或断电恢复。NVS XTS 加密不提供来源认证或防回滚，版本/格式校验不能替代认证。

连接恢复不固定旧 AP 的 BSSID/信道，允许同名网络 AP 变化；认证方式下限保留，支持开放及 WPA2/WPA3 Personal，不支持企业网、隐藏网络手输和 64 位十六进制 PSK。失败输出清零，局部密码、blob、命令和 SDK 配置清零，不记录 SSID/密码。队列收发和空槽清理同步，UI 返回只清编辑密码，不关闭系统共享连接；只有明确重启退出才停止网络。偏好保存失败不先断网。

## 保护方案：HMAC 设计路线已确认，部署待批准

依据 [ESP-IDF 5.4.2 官方说明](https://docs.espressif.com/projects/esp-idf/en/v5.4.2/esp32s3/api-reference/storage/nvs_encryption.html)，日常工程未启用 NVS Encryption、Flash Encryption、Secure Boot，没有 nvs_keys 或设备部署证据；隔离探针仅启用 HMAC NVS 编译。

| 方案 | 优点 | 限制与恢复差异 |
| --- | --- | --- |
| HMAC eFuse 派生 NVS 密钥（设计已确认，未部署） | ESP32-S3 原生支持；不需要 nvs_keys、不改当前 OTA 布局、不要求整个 Flash 加密；密钥不存 Flash | 占一个 eFuse key block；须确定块号、读写及用途写保护，烧写不可逆。重刷相同设备需保留相同块/用途及 NVS 地址；换板不能直接解密旧数据，恢复依赖另定备份/重新录入策略 |
| Flash Encryption 保护 nvs_keys | 与以后整机 Flash 保密部署统一；使用官方 NVS 密钥分区读取接口 | 需要另批至少 4KiB encrypted nvs_keys 分区，当前尾部预留不是授权用途；实现只接受release模式及受读写/用途保护的Flash key，开发模式拒绝。须决定烧写/更新/救援限制、密钥及分区备份。丢失/更换 XTS 密钥无法恢复原 NVS，不能自动重建 |
| 暂不部署保护 | 不做不可逆操作，继续编译/模拟验证 | 只能明确标记本次连接；不能满足保存后开机恢复的最终验收 |

推荐 HMAC 作为当前凭据专用保护路线，因为不修改已批准分区、不顺带锁定整机 Flash 加密。但 HMAC/Flash Encryption 都不能阻止可运行任意固件的软件读取秘密。本实现选定保护后额外要求设备 Secure Boot 已启用；签名链、调试/下载口限制、救援、授权应用与 crash dump 收集仍需部署策略和实机核验，不能用一个运行时布尔值声称完整防物理攻击。Secure Boot 本身不加密秘密。

HMAC 设计路线已确认；用户仍需选择：威胁范围；Secure Boot 签名/更新与救援策略；每设备密钥生成、保管、备份或明确不备份；HMAC 块号与用途保护或 nvs_keys 分区变更；现有 NVS 明文小设置的迁移（加密开关不能直接读取原明文记录）；允许何时部署及由谁操作。程序不迁移、格式化、生成替代密钥或自动烧熔丝。编译开关不是部署授权；任何可能首启部署 Flash/Secure Boot 的配置必须另批。

## 修改与验证入口

- [Kconfig](main/Kconfig.projbuild)：保护默认关闭，仅在相应 SDK NVS 方案下可选择；HMAC 分支已隔离目标编译通过，Flash 分支未验证。
- [安全入口](main/wifi_security.cpp)：实际 Secure Boot、Flash Encryption/密钥分区，或指定 HMAC 块用途与读写/用途保护检查。
- [保存服务](main/wifi_credentials.cpp)：单 blob 格式及失败保持规则。
- [启动恢复](main/wifi_boot.cpp) `restore_at_boot`：启动加载与非阻塞请求；[网络所有者](main/adv_wifi.cpp)保持SDK单任务所有权。
- [设置入口](main/adv_ui.cpp)：明确保存与本次连接，启动恢复入口及失败显示。
- [模拟测试](test/wifi_credentials_test.cpp)：真实服务源码＋模拟 NVS/保护状态，覆盖保护缺失、无记录、未知格式、读写/commit 失败、恢复策略与清零；不是真实 SDK、eFuse 或网络证据。

父会话已获审批执行 ESP-IDF 5.4.2 目标构建，退出码 0；默认关闭分支及保存/启动恢复源码编译链接成功，固件大小 `0xfe600`，最小应用槽 `0x380000`，剩余 72%。未烧录。默认关闭分支通过不证明加密分支可编译/运行；选定后需独立编译相应分支、核验最终配置与密钥部署，再分别验证保存、重启恢复、连接失败、旧版本拒绝、掉电和救援。没有真实设备结果，不宣称凭据已安全落盘。

### HMAC 隔离编译结果

父会话执行隔离 ESP32-S3 构建退出码 0，产物在 `/home/chery/.hermes/cache/scratch/adv-hmac-validation/build/cheryNyxus_adv.bin`，大小 `0x100a50`，槽余 71%。生成头文件确认 `NVS_ENCRYPTION`、`NVS_SEC_KEY_PROTECT_USING_HMAC` 和 `ADV_WIFI_PROTECTION_HMAC` 启用；Secure Boot 与 Flash Encryption 部署选项关闭。块号 0 仅为编译探针值，不是设备部署选择。日常配置未变。

已修正 HMAC provider 生命周期：复用 SDK 默认 scheme 并校验类型及 key id，不重复注册后释放，避免默认浅拷贝悬空。本应用额外要求硬件 Secure Boot 状态，这是应用策略，不是 SDK HMAC NVS 必要条件。仅编译，不烧录、不生成生产密钥、不写 eFuse；尚无真实密钥派生、持久化或重启联网证据。
