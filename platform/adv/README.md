# cheryNyxus Cardputer-Adv 客户端

产品目标：实现与 Web 客户端一致的业务能力，适配小屏和实体键盘；现阶段实现启动器、非敏感设置及硬件诊断，不是完整客户端。技术选型、资源限制和兼容性验证见 [基础选型调研](research.md)，批准范围见[系统底座计划](../../docs/plan/adv-client/system-foundation.md)。

## 底座开发进度

已接入固定Mooncake/LVGL/port/WS依赖及依赖锁。[底座组件](components/adv_foundation/include/adv_foundation.hpp)提供按需创建、单实例限制、退出保存、非敏感偏好NVS版本记录与显式提交、SD分块持久数据服务。硬件由 `main/adv_main.c` 唯一初始化；Mooncake由主任务调用，LVGL持port锁。亮度和auto_connect是非敏感板载小设置。上批双OTA布局目标构建通过，bin为0xfdf80 bytes；本批受保护保存与启动恢复源码已接入，保护默认关闭，本批目标构建待父会话，不以旧bin证明新源码。

主机逻辑验证入口：[测试工程](test/foundation/CMakeLists.txt)。使用真实Mooncake与模拟SDK存储/重启接口，不代替NVS掉电或SD实机验证。依赖使用Git固定提交，SDK组件管理器下载到本地managed_components；参考SDK环境见[系统底座计划](../../docs/plan/adv-client/system-foundation.md)。

## 中文显示与实体键编辑准备

[字体、文本编辑与许可](text-input.md)记录固定完整字体、生成入口、按键薄适配及真实 LVGL host 测试。本次host、孤立目标probe与正式目标构建均退出0，已接入诊断编辑子页与正式CMake；支持基础字形显示和实体键ASCII编辑，不是拼音输入法。基础候选资源许可未清楚，不引入词表，不改变已确认选型；实机显示/按键体验未验证。

## SD 用户数据契约

`adv::SdStore` 由主任务串行调用，挂载者显式设置可用状态；默认不可用，无卡返回 `ESP_ERR_INVALID_STATE`。硬件当前只提供启动挂载结果，不宣称热拔卡检测；每次操作开关文件，实际 I/O 失败返回错误，恢复使用前必须由挂载者重新确认卡状态。服务不挂载、不格式化、不擦除用户目录。

非敏感用户数据保存到 `/sdcard/userdata/`，键名只接受1—32位小写英文字母、数字、下划线和短横线，无子目录。单文件最大64KiB，读块最大1024字节，保存通过调用方分块提供数据，服务使用512字节缓冲，不全量复制。应用自行定义普通文件内容和版本；秘密不得使用此服务。

保存顺序：写 `<key>.tmp`，flush/fsync/close，重读检查长度和CRC32，再将当前 `<key>.dat` 移到 `<key>.bak`，最后将临时文件移到当前文件。下一次保存仅在当前文件存在时轮换前版；遇到遗留临时文件或仅有前版时拒绝写入，不自动清理或猜测恢复。普通读取只读取当前文件，`read_previous` 显式读取前版；调用者检查应用内容后决定恢复，服务不会静默把前版当当前版。I/O失败可能留下临时文件或前版，需明确处理后才能再次保存。用户数据与前版不是可自动删除的缓存。

CRC只验证本次临时文件写入与重读一致，不是持久完整性元数据。FAT rename及目录更新不保证掉电事务；掉电可能失去当前名、留下前版/临时文件或文件系统损坏，不能承诺总有完整前版。host测试只证明普通文件流程及模拟SDK行为，卡满、掉电、拔卡仍需实机验证。

设置读取未知版本、坏长度或I/O失败时使用可见的临时默认值并禁止保存（包含退出保存）；不擦除NVS。保存前再次读取原记录，避免用默认值覆盖无法解释的数据。亮度统一限定10—100，旧记录低于10判为错误并保持可见的默认亮度，不自动改写。Runtime登记项的ID和名称由调用者持有，必须存活到Runtime销毁；当前两项使用静态字符串。注册表与UI行数须共同检查，当前只注册Settings/Diagnostics，不新增未实现应用。

## Wi-Fi设置与保护边界

凭据保护及恢复的权威规则见 [Wi-Fi板载凭据](wifi-storage.md)。新增保护检测、SDK安全初始化、单blob保存和启动异步恢复；方案默认关闭，未部署时拒绝秘密读写。HMAC与Flash保护候选、Secure Boot及救援决定仍待用户选择，不自动生成密钥或烧eFuse。

当前本地sdkconfig未启用NVS加密、Flash Encryption或Secure Boot，双OTA布局无nvs_keys。当前保护缺失会明确拒绝启动恢复；auto_connect不能越过保护条件。本批目标构建交父会话，两个加密分支未编译、无硬件部署证据。

实现入口 `main/adv_wifi.cpp`：启动恢复或设置操作按需创建唯一网络任务，命令与状态各1槽，最多展示12个AP；扫描及连接/IP获取限时，无无限重试。任务独占SDK，不操作LVGL/Mooncake，禁用SDK NVS副本并设置 `WIFI_STORAGE_RAM`。UI返回不停止系统连接；明确重启时先提交偏好，失败留设置且不先断网，再异步释放网络并重启。队列同步清理秘密；不打印密码或网络名。

实体键使用现有官方导航映射；密码采用可打印ASCII字符选择器而非猜测新增键位：左右选字符、Enter添加，Tab选择删除/连接/返回。最多63字节，仅显示星号；受限为开放网络及WPA2/WPA3 Personal，不支持企业网、隐藏SSID手输或64位十六进制PSK。连接明确为仅本次使用，取得IP不等于互联网/TLS/业务可用。真实扫描、连接、错误恢复、清理资源和键盘体验留实机验收。

## Flash 分区构建契约

用户已批准8MiB布局：首64KiB用于启动与系统配置，`ota_0`/`ota_1`各3.5MiB，尾960KiB保持未分配，不增加factory第三槽或文件系统。源文件为 [partitions.csv](partitions.csv)，[sdkconfig.defaults](sdkconfig.defaults)选择 `CONFIG_PARTITION_TABLE_CUSTOM`，分区表偏移保持 `0x8000`。父会话分区批构建退出0；本次反解生成分区表和flasher_args确认已切换，不再沿用旧布局待构建描述。本批凭据代码仍需重新构建。

| 用途 | 起始偏移 | 大小 |
| --- | --- | --- |
| ESP32-S3 bootloader保留区域（不列入CSV） | `0x000000` | `0x8000` |
| 分区表扇区（不列入CSV） | `0x008000` | `0x1000` |
| 普通NVS | `0x009000` | `0x4000` |
| otadata | `0x00d000` | `0x2000` |
| phy_init | `0x00f000` | `0x1000` |
| ota_0 | `0x010000` | `0x380000` |
| ota_1 | `0x390000` | `0x380000` |
| 未分配预留（不列入CSV） | `0x710000` | `0x0f0000` |

必要中文核心随固件，大资源和用户数据优先SD。新增密钥/诊断分区需另批，预留区不是已授权用途，当前普通NVS不是加密存储。布局只保留双槽空间；OTA下载、签名、自检及rollback未实现。上批新布局bin为 `0xfdf80` bytes；本批及最终组合/签名余量需重建测量。标准应用OTA不迁移分区表；设备从旧布局切换须另批备份与迁移，不能假设既有NVS兼容。

## 当前硬件与界面边界

启动器仅展示设置和硬件诊断，按需创建Mooncake应用；退出设置先停网络再提交偏好，失败留在应用内，成功关闭卸载后重启。键盘采用官方物理映射：Tab或Fn＋方向键移动，Enter确认；Fn＋Esc退出并重启。设置可调整亮度、切换auto_connect偏好、显式保存并进入Wi-Fi页面；auto_connect因保护未部署而阻塞。诊断保留共享硬件读取，不把设备扫描当成完整外设驱动。LVGL使用RGB565局部DMA缓冲，无PSRAM，全局唯一display及port任务，主任务持port锁更新对象。

## 可复用硬件

独立 ESP-IDF v5.4.2 项目，目标 K132-Adv / ESP32-S3，不依赖 Backend，不替换 [ESP32 平台](../ESP32/README.md)。支持 LCD 状态页、TCA8418 键盘事件、共享 I²C 设备扫描、SD 卡挂载检测（演示不写文件）及电池 ADC 原始采样。音频、BMI270 数据采集、无线连接和红外发射不在本演示范围内；设备被 I²C 检测到不表示驱动已完成。

## 定位与流程

| 修改意图 | 代码入口 / 符号 | 验证 |
| --- | --- | --- |
| 改硬件引脚、屏幕初始化 | [main/adv_main.c](main/adv_main.c) `display_init` | 完整构建；设备观察方向、颜色 |
| 改键盘解析 | [main/key_event.h](main/key_event.h) `adv_decode_key` | [键盘测试](test/key_event_test.c) |
| 改启动器、设置或应用工厂 | [main/adv_ui.cpp](main/adv_ui.cpp) `adv_ui_init` | 目标构建与foundation测试 |
| 改SD持久数据服务 | [components/adv_foundation/sd_store.cpp](components/adv_foundation/sd_store.cpp) `SdStore::save` | foundation测试与目标构建；实机掉电/卡满单独验证 |
| 改实体键导航 | [main/ui_input.h](main/ui_input.h) `adv_ui_decode` | [导航测试](test/ui_input_test.c) |
| 改Wi-Fi及密码边界 | [main/adv_wifi.cpp](main/adv_wifi.cpp) `start`、[main/wifi_model.hpp](main/wifi_model.hpp) `Password` | [模型测试](test/wifi_model_test.cpp)及目标构建；网络/退出生命周期实机另验 |
| 改总线、SD、ADC | [main/adv_main.c](main/adv_main.c) `app_main` | 完整构建；设备串口和屏幕 |
| 改Flash布局 | [partitions.csv](partitions.csv)、[sdkconfig.defaults](sdkconfig.defaults) `CONFIG_PARTITION_TABLE_CUSTOM` | SDK分区生成工具、目标build及有效配置/生成分区表核对 |

启动通过 `adv_nvs_init` 初始化NVS（失败不擦除），初始化公共硬件、SD及LVGL启动器，再按保护与已保存偏好尝试异步恢复网络。当前保护关闭，不加载秘密、不自动连接。每20ms读取键盘并更新应用，每秒采样ADC。硬件失败显示不可用，LCD失败停止启动。两应用不写SD；挂载状态只在启动确认，未实现拔卡检测。扩展外设复用GPIO8/9共享总线。

引脚依据 [官方产品页](https://docs.m5stack.com/zh_CN/core/Cardputer-Adv)。键盘采用控制器 7×8 扫描矩阵（不是物理 4×14 布局），重映射依据 [官方键盘实现](https://github.com/m5stack/M5Cardputer-UserDemo/blob/CardputerADV/main/hal/keyboard/keyboard.cpp)；TCA8418 寄存器依据 [TI 数据手册](https://www.ti.com/lit/ds/symlink/tca8418.pdf)。电池仅显示未经校准的 ADC 原始值，不伪造百分比。无 PSRAM 依赖，Flash 配置为 8MB。

## 构建与人工验证

```bash
export PATH="$HOME/.local/share/uv/python/cpython-3.12.13-linux-x86_64-gnu/bin:$PATH"
source "$HOME/esp/esp-idf-v5.4.2/export.sh"
idf.py -C platform/adv build
cc -std=c11 -Wall -Wextra -Werror platform/adv/test/key_event_test.c -o "$TMPDIR/adv-key-test"
"$TMPDIR/adv-key-test"
cc -std=c11 -Wall -Wextra -Werror platform/adv/test/ui_input_test.c -o "$TMPDIR/adv-ui-input-test"
"$TMPDIR/adv-ui-input-test"
```

构建产物在 `build/`，本地生成的 `sdkconfig` 不提交；默认配置见 [sdkconfig.defaults](sdkconfig.defaults)。`idf.py -C platform/adv -p PORT flash monitor` 会覆盖设备现有固件，只在确认串口并备份所需内容后由操作者执行。人工检查：屏幕方向/颜色、连续按键与释放、SD 插入与缺卡启动、电池采样、缺失外设失败提示。自动构建不证明实机功能通过。
