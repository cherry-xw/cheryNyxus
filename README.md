# cheryClaw - Qt6 字符动画桌宠

一个基于Qt6 QML的桌面宠物应用，角色形象由纯字符动画构成。

## 功能特性

- 无边框透明窗口，始终置顶
- **YAML配置驱动** - 外观、动画、交互区域全部可配置
- **点击区域交互** - 不同身体部位触发不同指令
- **热加载支持** - 修改配置文件自动生效
- 系统托盘支持
- 右键菜单
- 设置面板

## 构建要求

- Qt6 (Quick, QuickControls2, Widgets)
- yaml-cpp
- CMake 3.16+
- C++17

## 构建步骤

```bash
mkdir build && cd build
cmake -DCMAKE_PREFIX_PATH=/path/to/Qt6 ..
make
```

## 运行

```bash
./cheryClaw
```

## 配置文件 (pet.yaml)

配置文件支持以下内容：

```yaml
# 全局设置
animation_speed: 500      # 动画切换速度(ms)
character_color: "#ffffff" # 字符颜色
default_frame: "idle"     # 默认动画帧

# 动画帧定义
frames:
  - name: "idle"
    lines:
      - "   /\\_/\\  "
      - "  ( o.o ) "
      - "   > ^ <  "
    hit_areas:
      - name: "head"
        x: 30
        y: 0
        width: 90
        height: 30
        action_type: "builtin"
        action_value: "happy"
```

### 点击区域交互类型

| action_type | 说明 |
| ------------ | ----- |
| `builtin` | 内置动作 (happy/sleep/idle/walk_left/walk_right) |
| `signal` | QML信号 (moveLeft/moveRight) |
| `shell` | 执行Shell命令 |

### 身体部位划分

- `head` - 头部区域
- `body` - 身体区域
- `feet` - 脚部区域

## 项目结构

```
src/
├── cpp/
│   ├── main.cpp           # 应用入口
│   ├── PetConfig.h        # 配置类头文件
│   └── PetConfig.cpp      # 配置类实现
└── qml/
    ├── main.qml           # 主窗口
    ├── components/
    │   ├── AsciiPet.qml   # 字符动画桌宠
    │   └── TrayIcon.qml   # 系统托盘
    └── pages/
        └── SettingsPage.qml # 设置面板
pet.yaml                   # 桌宠配置文件
```

## 扩展交互

AsciiPet组件预留以下接口：

```qml
// 信号
hitAreaTriggered(areaName, actionType, actionValue)
shellCommandRequested(command)
positionChanged(dx, dy)

// 函数
setAnimation(name)
moveLeft()
moveRight()
happy()
sleep()
idle()
forceUpdate()
```