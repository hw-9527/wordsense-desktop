# 词境 WordSense · 桌面端 (macOS & Windows)

基于 **Tauri v2 + Web** 技术的跨平台系统级划词查词工具，具备类似 **PopClip** 的自动划词检测能力，并在任何应用（浏览器、文本编辑器、终端、文档阅读器等）中结合上下文理解单词含义。

---

## 🌟 核心特性

- 🎯 **全系统自动划词检测（PopClip 体验）**：
  - **macOS**：通过 `Accessibility API (AXUIElement)` + 鼠标状态检测，在鼠标选中文本后自动在光标附近弹出「词境」按钮。
  - **Windows**：通过低级别鼠标钩子 (`SetWindowsHookExW`) + `UI Automation (ITextPattern)` 实现全系统划词感知。
- 🧠 **语境感知分析**：
  - 自动获取选中词附近的上下文句子（前后 ~300 字符），利用 AI 准确分析当前语境确切含义，避免机械式罗列词典解释。
  - 自动识别固定搭配（Collocations）与习语（Idioms）。
- 🖥️ **无侵入浮动面板**：
  - 非激活面板设计（macOS `NSNonactivatingPanelMask` / Windows `WS_EX_NOACTIVATE`），不抢占当前聚焦应用的焦点。
  - 结果面板支持发音朗读、一键复制、暗色模式自适应。
- ⚙️ **多模型与服务商兼容**：
  - 兼容 OpenAI、DeepSeek、通义千问、Kimi、智谱 GLM、本地 Ollama 等所有兼容 OpenAI 格式的接口。

---

## 📂 项目结构

```
wordsense-desktop/
├── index.html                 # 主浮动面板 & 按钮入口
├── settings.html              # 设置窗口入口
├── vite.config.js             # 多页面 Vite 构建配置
├── package.json               # 前端依赖配置
├── src/
│   ├── main.js                # 浮动窗口状态与事件流处理
│   ├── panel.js               # 词典结果渲染逻辑
│   ├── panel.css              # 浮动面板样式
│   ├── lookup.js              # AI API 调用与重试机制
│   ├── settings.js            # 设置窗口交互逻辑
│   ├── settings.css           # 设置窗口样式
│   └── lib/
│       └── core.js            # 核心纯函数（Prompt 构建、JSON 容错解析）
└── src-tauri/
    ├── Cargo.toml             # Rust 依赖配置
    ├── tauri.conf.json        # Tauri v2 窗口及权限配置
    ├── Entitlements.plist     # macOS 辅助功能权限声明
    ├── capabilities/
    │   └── default.json       # Tauri 权限清单
    ├── icons/                 # 应用图标
    └── src/
        ├── main.rs            # 桌面端启动入口
        ├── lib.rs             # 系统托盘、窗口管理、命令注册
        ├── config.rs          # 设置本地存储模块
        └── selection/
            ├── mod.rs         # 划词监控抽象层
            ├── macos.rs       # macOS (Accessibility API) 划词实现
            └── windows.rs     # Windows (UI Automation) 划词实现
```

---

## 🚀 开发与构建

### 1. 环境准备
- **Node.js** (v18+) & **npm**
- **Rust** (1.78+) & **Cargo**
- **macOS**：需在系统设置中授予应用的「辅助功能 (Accessibility)」权限以便读取选中文本。
- **Windows**：系统需支持 UI Automation（Windows 10/11 自带）。

### 2. 安装依赖与启动开发模式
```bash
# 1. 安装前端依赖
npm install

# 2. 启动 Tauri 开发模式
npm run tauri dev
```

### 3. 构建发布包
```bash
npm run tauri build
```
构建产物位于 `src-tauri/target/release/bundle/` 下。
