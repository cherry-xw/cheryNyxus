# 外部默认的来源核对方法

各项真实状态、保存限制与接手责任由[台账](README.md#小任务事实与恢复条件)维护；本文只说明恢复调查时具体核对什么，不补造默认值。

## 共用方法与证据

从项目正式消费者倒查所用协议、端点、型号和已装依赖版本，随后核对同一版本的官方说明。分别回答字段支持、显式值处理、字段缺省和服务端返回，不把示例填写值或 SDK 类型等同于运行默认。

记录来源 URL、查阅日期、接口/型号或版本、相关原文和项目发送位置。资料无法取得时保留阻塞及已有检索结果；不重复请求超时入口，不执行模型试探、MCP 启动或依赖升级。不读取安装目录源码或构建产物。需要改变行为时提出具体方案、影响的旧值与验证条件，取得所需确认后实施。

## ED01 Gemini

官方入口为 [Gemini 图像生成](https://ai.google.dev/gemini-api/docs/image-generation.md.txt)。先核对项目 `generateContent` 的 REST 请求形状及具体图片型号，再查 `imageConfig.aspectRatio / imageSize` 的合法值与缺省解释。当前 SDK `ImageResponseFormat` 的说明不能代替 REST 字段，旧版 ImageConfig 或其他型号的 1K 不得套用。

完成调查必须能指出“当前接口当前型号，未发送该字段时会怎样”的明确来源；只有字段枚举或示例不够。缺省无法核实时继续未核实，不为填表新增请求参数。

## ED02 Seedream

官方入口为 [图像生成 API](https://ark.volcengine.com/docs/image-generation-api.md)。按实际 model/接入点分开 pro/flash 与其他型号，核对非 pro/flash 的 seed 是否支持、允许范围及省略处理。

当前已取得正文仍缺该项依据；不能由其他模型 seed 随机规则或客户端示例 `-1` 推定。若官方确认不支持，先提出入口、已有显式值与发送行为的处理方案，不直接删除或拒绝。

## ED03 Images multipart

官方入口为 [Images edit](https://developers.openai.com/api/reference/resources/images/methods/edit)。先固定 multipart 编辑而非 JSON 编辑、生成或 Responses；核对相应型号是否接受 moderation，以及未传时行为。

正文访问受限时，搜索摘录未明确该分支不能补成 auto。若只能取得生成/JSON 分支，记录为不满足本项证据，不改变共用字段当前接受或发送规则。

## ED04 MCP stdio

官方入口为 [TypeScript SDK v1 客户端说明](https://ts.sdk.modelcontextprotocol.io/client.html)。核对项目 `StdioClientTransport` 构造参数和实际 `cfg.env` 传递位置，官方说明需适用于当前 v1 系列，解释未传 env、显式对象与进程环境的关系。

不能从 v2、其他语言 SDK 或自己启动进程的结果推定 v1 默认。查资料不读取或回显实际环境变量值，不启动 MCP 服务器；资料仍不足时保留未核实，不增加“查询当前环境”功能。
