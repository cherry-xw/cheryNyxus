# 基础中文显示与实体键盘编辑

本页维护已批准的裁剪字体与 LVGL textarea 基础切片；不是完整输入法、会话客户端或 SD 资源加载器。完整字体来源、重复生成、真实 LVGL host 和孤立目标 probe 本次通过后，已接入 [main/adv_ui.cpp](main/adv_ui.cpp) 与正式 CMake，正式目标构建退出0。从诊断页进入编辑子页，不新增常驻应用或第二个 display；公共硬件及 port 锁保持不变。实机显示和输入体验仍待用户验收。

## 字体与许可

字体源固定 Adobe Source Han Sans 2.004R，提交 `a8b073bbf80f7226af03abeeb31e27017d5e3f67`，`SubsetOTF/CN/SourceHanSansCN-Regular.otf`；上游为 SIL OFL 1.1，版权 2014–2021 Adobe，保留名称 Source。裁剪衍生字体用户可见名为 `cheryNyxus Basic`，保留版权及完整 OFL，不沿用保留名称。许可证位于 `main/fonts/OFL.txt`。生成工具 `lv_font_conv@1.5.3` 为 MIT，开发期使用，不进入设备；禁止未经兼容验证升级到需要 LVGL 9.3 stride 的工具。

生成入口 `tools/generate-font.py` 固定源提交、字体摘要及工具版本；读取 `main/fonts/basic-characters.txt`，生成 `main/fonts/adv_font_basic.c`。转换器必须显式传入 `--lv-include lvgl.h`，兼容 IDF managed LVGL 的头文件根目录，不依赖 `lvgl/lvgl.h` 路径；生成产物需随脚本重新生成，不能只手改产物。基础集合含 ASCII、中文页面说明、示例中文及替代符；候选引擎未获采用条件通过，当前没有内置候选集合。每次加入基础候选必须先将全部实际候选字形加入集合并验证覆盖，不能声称当前裁剪集合支持任意中文。字体为 16px、2bpp、无压缩/无字距，Flash 只读；不全量加载 RAM，未知字形由 LVGL 缺字显示，不承诺完整 Unicode/emoji。

完整上游文件为8331636字节，Git blob `c13789be298515b27311fd017aaa32a3c41d42b9`，SHA-256 `c0aa89a70f92a820ff95490fea6d472cd19621a71c9a748a4950eb2eafe6438e`。生成器同时拒绝长度、blob或SHA-256不匹配，不能使用超时下载留下的部分文件。可从固定提交的Git checkout取得该路径，或下载[官方固定文件](https://raw.githubusercontent.com/adobe-fonts/source-han-sans/a8b073bbf80f7226af03abeeb31e27017d5e3f67/SubsetOTF/CN/SourceHanSansCN-Regular.otf)并按[官方元数据](https://api.github.com/repos/adobe-fonts/source-han-sans/contents/SubsetOTF/CN/SourceHanSansCN-Regular.otf?ref=a8b073bbf80f7226af03abeeb31e27017d5e3f67)核准完整blob；失败下载不得继续转换。

## 编辑与导航边界

正式UI已实现以下入口；[main/text_editor.h](main/text_editor.h)共享实际LVGL操作与草稿验证，host测试直接使用该适配。

诊断页 Enter 打开文本基础页；普通实体键插入 ASCII，Shift 切换大写/符号，Enter 换行；Backspace 删除前一个 Unicode 码点，Fn+Backspace 删除后一个；Fn+方向键移动光标。Tab 返回诊断页并保留本次 RAM 草稿，Fn+Esc 仍走原应用退出/重启流程。确认、编辑、返回都不发送任何业务消息。Ctrl/Alt/Opt 修饰组合不插入普通字符；释放事件只更新修饰状态。

正文由 LVGL textarea 管理 UTF-8、光标及滚动，不自建编辑器。薄适配只判断按键与插入容量；正文最多 256 码点、1024 UTF-8 字节（不含终止符），拒绝超限或无效 UTF-8，不截断字符。草稿独立 1025 字节静态缓冲，返回后重建控件恢复，非秘密、无 SD/Flash 写入、不承诺重启恢复或多会话隔离。页面离开删除 textarea，不保留后台任务。此处限额是基础切片的实现上限，不是最终聊天容量。

## 输入法采用门槛与既定备用

`zh_pinyin_decoder` 固定 `7e842df890047199288ec096508dabc640bcf2b6`：引擎 LICENSE.txt 为 MIT，但基础字表指向 `GBK-code-table`；后者固定 `ffb170d9ad9bdad8861ae5e0037c1faa1234bdfa`，完整 Git 树无许可证，README 无再分发授权；README 还说明附带 webdict 派生词典。MIT 引擎许可不能代替导入数据的来源授权。因此未引入基础 bin/YAML、词典或附带 simhei.ttf；不从零自造替代输入法。

微软双拼仍按第1项 A：固定成熟规则与合法音节后离线生成多值表；当前无已许可的候选/合法音节配套源，没有正式接入或声称支持。待上游确认基础资源授权后继续孤立 probe（编码、歧义、分页、越界、无卡），通过才正式集成。原保留备用是 LVGL 查表核心（基础候选）及 libime 局部解析（双拼）；切换需依据原计划重新确认，不静默换路线。SD 扩展仍为已确认 B+B1，当前未实现加载/版本检验；无卡编辑和基础字形独立可用。

## 本批步骤与验证状态

1. 来源许可：字体与转换器来源已固定；候选字表授权门槛未通过。
2. 字形：完整固定文件核准，原expected摘要正确；重新生成169字形、58593字节，两个独立来源生成结果逐字节一致，头路径为 `lvgl.h`。OFL与固定checkout许可证一致。
3. 文本编辑：本次host 2/2退出0与孤立目标probe退出0后接入正式诊断编辑子页及CMake；Tab保存RAM草稿并删除控件，Fn+Esc保存后删除控件再沿原流程重启，修饰释放跨页持续跟踪。
4. 候选：采用条件未满足，不引入未授权字表、不替换既定方案。
5. 验证：本次重新运行host 2/2退出0，并补实际编辑适配的1024字节/256码点边界、删除和草稿重建。孤立目标probe及正式ADV构建均退出0；正式bin `0x100cf0`，3.5MiB槽余 `0x27f310`。没有烧录或实机结果；编译不证明界面尺寸、清晰度、快速按键、滚动或堆峰值。

## 验证入口

[按键/容量测试](test/text_input_test.cpp) 覆盖物理位置、修饰释放、Fn 导航、UTF-8 与双限额；[真实 LVGL host 工程](test/text/CMakeLists.txt) 验证实际 textarea 插入、中文光标删除、容量、草稿重建及字形覆盖。孤立 ESP-IDF probe 先验证同一生成字体与 textarea API，再构建正式 ADV；构建通过不等于键盘快速输入、方向颜色、字体清晰度或运行堆峰值通过，真实显示/交互由用户最终验收。无烧录、擦除、安全部署或后端变更。
