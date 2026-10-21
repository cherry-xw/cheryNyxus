# 独立计划工具与通用包

工具仅使用 Node.js 20 以上内置模块，不需要安装依赖。规则见[计划规范](../plans.md)，检查边界和使用时机见[静态检查](../plan-checks.md)。工具读取指定计划，不自动写入、修复或删除资料。

## 解压后使用

通用 ZIP 保留规则的 `docs/standards/documentation/` 路径、工具源码 `tools/plan-viewer/` 和一个可检查的样例计划，包含[需求调查与设计方法](../requirements-design.md)。不要用样例覆盖已有项目的计划；采用步骤见[采用指南](../adoption-guide.md)。工具只检查明确的结构和记录，不能替代场景、技术适配或需求满足情况的审核。

在解压目录运行：

```sh
node docs/standards/documentation/tools/lint.mjs --plan-dir=docs/plan
node docs/standards/documentation/tools/plan-viewer.mjs --plan-dir=docs/plan
```

页面默认 `http://127.0.0.1:4173`，可用 `--port=5000` 更换端口（`--port=0` 随机空闲端口）、`--host=0.0.0.0` 开放局域网访问。也可以只复制两个单文件工具，通过 `--plan-dir` 指向目标项目计划目录。`lint.mjs --json` 输出机器可读差异，`--strict` 也将待核对项作为失败。执行权限、审批、业务测试仍由采用项目配置。

## 集成与维护

任务状态变化、文件移动、交接和最终清理前后运行 lint；自动集成检查调用同一命令，遇到退出码 1 阻止合入，退出码 2 表示参数或运行失败。页面仅展示同一报告，不能代替命令行的合入限制。

源码包含 Markdown 解析器、共享检查器、页面、服务、测试及构建器。修改源码后在解压根运行 `node tools/plan-viewer/build.mjs` 重新生成两个独立文件，再执行 `node --test tools/plan-viewer/tests/*.test.mjs`。构建产物可重建，不手工修改。

重新打 ZIP 使用 Python 3 标准库与 Node.js：`python3 tools/plan-viewer/package-kit.py --output=/tmp/plan-management-kit.zip`。打包按明确文件清单选择规则与工具，不包含当前项目的真实计划、凭据、日志、缓存或依赖目录。ZIP 附带 `MANIFEST.json`，列出内容及 SHA-256；交付时同时提供 ZIP 的 SHA-256 文件。校验清单完整性不等于功能正确，发布前仍需解压运行检查。
