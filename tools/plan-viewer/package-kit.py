#!/usr/bin/env python3
"""Build a portable documentation and plan kit from an explicit source allowlist."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile


def build_kit(output: Path) -> None:
    tool = Path(__file__).resolve().parent
    repo = tool.parent.parent
    subprocess.run(['node', str(tool / 'build.mjs')], cwd=repo, check=True)
    files = {}
    rules = repo / 'docs/standards/documentation'
    for name in ['README.md', 'requirements-design.md', 'content.md', 'structure.md', 'plans.md', 'plan-checks.md', 'entry-template.md', 'adoption-guide.md', 'existing-project-guide.md', 'tools/README.md', 'tools/plan-viewer.mjs', 'tools/lint.mjs']:
        source = rules / name
        files[source.relative_to(repo).as_posix()] = source.read_bytes()
    for name in ['README.md', 'package.json', 'audit.mjs', 'server.mjs', 'lint-source.mjs', 'build.mjs', 'package-kit.py']:
        source = tool / name
        files[source.relative_to(repo).as_posix()] = source.read_bytes()
    for folder, suffixes in [('public', {'.js', '.css', '.html'}), ('tests', {'.mjs'})]:
        for source in sorted((tool / folder).iterdir()):
            if source.is_file() and not source.is_symlink() and source.suffix in suffixes:
                files[source.relative_to(repo).as_posix()] = source.read_bytes()
    files['README.md'] = '''# 通用文档与 Plan 管理包

从 [采用指南](docs/standards/documentation/adoption-guide.md) 开始；工具运行见 [独立工具](docs/standards/documentation/tools/README.md)。

需求讨论、技术方案选择、项目需求审核与开发交接见 [需求设计规范](docs/standards/documentation/requirements-design.md)。它提供按场景选方法、主动调研、结果检查点和终版交接要求；具体执行权限由采用项目配置。

需要 Node.js 20 以上，无需安装依赖。在此目录执行：

```sh
node docs/standards/documentation/tools/lint.mjs --plan-dir=docs/plan
node docs/standards/documentation/tools/plan-viewer.mjs --plan-dir=docs/plan
```

`docs/plan/` 是演示资料，采用时不要覆盖已有计划。状态、目录和引用差异会在命令行及页面同时展示。规则与源码随包提供，MANIFEST.json 包含各文件 SHA-256。
'''.encode()
    files['docs/plan/README.md'] = '''# 计划入口

| 任务 | 状态 | 范围 |
| --- | --- | --- |
| [示例任务](example/README.md) | 规划中 | 演示单页任务及恢复入口 |
'''.encode()
    created = datetime.now(timezone.utc).isoformat(timespec='seconds')
    files['docs/plan/example/README.md'] = f'''# 示例任务

**文档创建时间：** {created}

**状态：** 规划中

**计划形式：** 单页

## 目标与边界

演示任务结构，不代表任何产品实施。复杂度 1：明确的文档示例。

## 当前恢复检查点

下一步由采用者建立实际目标、当前授权和完成条件；当前未授权产品修改。

## 完成条件与验证

实际任务应同步文档、引用并清理本任务临时文件；按项目政策完成必要验证和用户审批。本示例尚未执行产品验证。
'''.encode()
    manifest = {'format': 1, 'createdAt': created, 'files': [{'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()} for name, data in sorted(files.items())]}
    files['MANIFEST.json'] = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(files.items()):
            archive.writestr(name, data)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(output.suffix + '.sha256').write_text(f'{digest}  {output.name}\n')
    print(f'ZIP: {output}\n文件: {len(files)}\nSHA-256: {digest}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    build_kit(parser.parse_args().output)
