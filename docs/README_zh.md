# dsh-plugin-agy（中文文档）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.18.1-brightgreen.svg)](https://nodejs.org/)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-orange.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)

**dsh-plugin-agy** 是专为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 打造的 Google Antigravity (agy) 模型接入插件与独立命令行工具。提供全流程自动化 OAuth 2.0 登录、带配额感知的多账号池与 429 智能轮换、双滚动配额窗口监控（5 小时与周额度）、设备指纹伪装，以及原生内嵌的 Web 设置面板与终端管理套件。

> 🌐 **语言导航**  
> [简体中文文档](docs/README_zh.md) | [English Documentation](../README.md)

---

> 💡 **致谢与项目渊源 (Acknowledgement)**  
> 本项目（`dsh-plugin-agy`）遵循 **MIT 开源协议**，基于并深度优化自 [chaos-03x/dsh-agy](https://github.com/chaos-03x/dsh-agy)。衷心感谢原作者 [@chaos-03x](https://github.com/chaos-03x) 及其社区贡献者的开创性探索与卓越架构设计！本项目在此基础上保持活跃维护，并持续推进面向 DeepSeek Harness 最新生态的体验与工程优化。

---

## 📑 目录

- [核心功能](#-核心功能)
- [界面演示](#-界面演示)
- [快速开始](#-快速开始)
  - [路径 A：DSH Web UI 用户（推荐，0 CLI 命令）](#路径-adsh-web-ui-用户推荐0-cli-命令)
  - [路径 B：无桌面 / 纯终端环境（独立 CLI）](#路径-b无桌面--纯终端环境独立-cli)
  - [路径 C：本地源码开发与 Link 调试](#路径-c本地源码开发与-link-调试)
- [CLI 命令行参考](#-cli-命令行参考)
  - [每账号独立代理管理](#每账号独立代理管理)
- [深入核心机制](#-深入核心机制)
  - [1. 5 小时与周额度双窗口配额与轮换机制](#1-5-小时与周额度双窗口配额与轮换机制)
  - [2. 429 智能分流与限流状态机](#2-429-智能分流与限流状态机)
  - [3. 思考预算（Reasoning Effort）深度分析](#3-思考预算reasoning-effort深度分析)
  - [4. 上游缓存机制对比（Antigravity vs DeepSeek）](#4-上游缓存机制对比antigravity-vs-deepseek)
  - [5. 存储架构与密钥安全](#5-存储架构与密钥安全)
- [风险管控与环境变量](#-风险管控与环境变量)
- [卸载指南](#-卸载指南)
- [风险声明](#-风险声明)
- [参考项目与致谢](#-参考项目与致谢)
- [开源协议](#-开源协议)

---

## ✨ 核心功能

- **🔑 零摩擦 OAuth 2.0 认证**:
  - 本地回环回调一键登录：浏览器点击授权，自动回调完成握手。
  - 支持 Headless 纯文本终端 URL 复制粘贴授权。
  - 支持跨设备凭据 Blob（`--blob`）导入导出通道，无需在远端服务器重新登录。

- **🔄 智能多账号池与 429 自动轮换**:
  - 本地加密存储多账号，用量感知调度（基于模型族配额与 OMP 对齐排名算法）。
  - **双窗口独立配额监控**：精确跟踪 5 小时滚动窗口与 7 天自然周窗口，杜绝周配额耗尽造成的长时间锁死。
  - **精准 429 状态分类器**：自动区分软限流（极速同号重试）、服务端指定 reset 冷却（自动轮换下一号）、以及真实额度耗尽（冷却至重置时间）。
  - 自动账号冷却对齐，服务恢复自动解除锁定。

- **🎨 深度融合的 DSH 原生设置界面**:
  - 直接嵌入 DSH 核心设置：位于 **设置 → Antigravity**（无需启动独立前端服务或记忆独立端口）。
  - **账号页（Accounts）**：多账号登录、一键激活、5h/周配额条图、端到端接口健康测试、设备指纹与专属代理配置。
  - **模型页（Models）**：逐模型可见性开关，黑名单语义设计（官方新增模型默认自动显示）。
  - **配置页（Config）**：自定义推理思考 Token 预算（Low/Medium/High/最高 65535）与多模态非图片文件单文件内联上限（1-100 MB）。
  - **用量页（Usage）**：精准累计输入、输出、缓存读、缓存写 Token 统计，涵盖请求数、失败率、轮换次数及 TTFT 首字延迟。
  - **凭据页（Credentials）**：安全导出和导入凭据文件与加密 Blob。

- **🏷️ 会话头部实时配额徽章（Quota Badge）**:
  - 原生内嵌于 DSH 会话顶部标题栏。
  - 实时提炼当前活动账号最紧绷的配额余量（5h 与周额度之最小值）。
  - 鼠标悬停即刻展开各模型族窗口余量百分比与服务端重置倒计时。

- **🛡️ 银行级安全加密与环境隔离**:
  - 账号落盘采用 AES-256-GCM 工业级加密；主密钥严格保存在 `~/.dsh/.credentials.yaml` 中，权限锁定 `0600`。
  - Loopback 本地防线，外部网络无法探测管理接口。
  - 支持每账号独立绑定 SOCKS5 / HTTP 代理，内置 2 秒 TCP 快速连通性探测。
  - 动态指纹混淆与稳定指纹策略自由切换。

- **💻 跨平台独立命令行（`dsh-plugin-agy` / `dsh-agy`）**:
  - 全套命令行支持，脱离 DSH harness 亦可在纯 Linux VPS、CI/CD 自动化脚本中稳定运行。

---

## 📸 界面演示与视觉预览

原生无缝集成到 DeepSeek Harness 设置中心与聊天会话顶栏：

### 1. 会话顶栏配额胶囊与多模型族状态浮层
实时提炼当前活动账号的紧缩配额水位，悬停即见 Gemini、Claude/GPT、Gemini 4 Argon 各分组的 5 小时与周度配额余量及倒计时：

<p align="center">
  <img src="../assets/quota_badge_popover.png" alt="会话顶栏配额胶囊与状态浮层" width="460" />
</p>

### 2. 多账号池管理与性能指标看板
多账号状态监控、一键设为当前、一键验证、专属代理配置、设备指纹重建以及端到端延迟与 Token 吞吐量统计：

<p align="center">
  <img src="../assets/settings_accounts.png" alt="多账号管理与性能指标看板" width="680" />
</p>

### 3. 智能调度偏好与顶栏胶囊配置
支持自动轮换开关、高精度配额重置倒计时、智能休眠（闲置与耗尽时自适应暂停轮询）、会话顶栏胶囊与详细分组轮播模式：

<p align="center">
  <img src="../assets/settings_preferences.png" alt="智能偏好与顶栏胶囊配置" width="680" />
</p>

### 4. 逐模型可见性与用量分析看板

| 逐模型可见性黑名单控制 | 全周期用量统计分析 |
|:---:|:---:|
| ![模型可见性](../assets/zh_models.png) | ![用量统计](../assets/zh_usage.png) |

---

## 🚀 快速开始

### 路径 A：DSH Web UI 用户（推荐，0 CLI 命令）

适用于使用 DeepSeek Harness 桌面端或浏览器工作台的用户：

```sh
# 1. 向 DSH web profile 添加 dsh-plugin-agy 插件
dsh plugin --profile web add dsh-plugin-agy
# 若未将 dsh 加入全局 PATH，可直接使用 npx：
# npx @deepseek-ai/dsh plugin --profile web add dsh-plugin-agy

# 2. 启动 DSH Web 界面
dsh web

# 3. 点击顶部导航「设置」→「Antigravity」
# 在账号标签页点击「Google 账号登录」，完成授权后立即开启对话！
```

> **管理界面在哪里？**  
> 打开 DSH 界面中的 **设置 → Antigravity**（与通用设置、模型设置同级）。所有配置与用量直接在设置中查看。

---

### 路径 B：无桌面 / 纯终端环境（独立 CLI）

适用于 Linux VPS、远程 SSH 会话或无图形界面的 CI/CD 自动化流水线：

```sh
# 免全局安装快速执行（通过 npx / pnpx）
npx dsh-plugin-agy login
npx dsh-plugin-agy status

# 或全局安装 CLI
npm install -g dsh-plugin-agy

# 交互式 OAuth 登录（支持浏览器自动回调、--headless 粘贴重定向 URL 或 --blob 导出）
dsh-plugin-agy login

# 查看当前已绑定的账号池、活动账号及配额状态
dsh-plugin-agy status

# 手动触发逐账号 Token 刷新与可用性校验
dsh-plugin-agy verify

# 批量后台健康检查巡检
dsh-plugin-agy health

# 导入现有的 agy CLI auth.json 或凭据 blob
dsh-plugin-agy import <file>

# 移除指定账号
dsh-plugin-agy logout
```

*(说明：原命令行别名 `dsh-agy` 完全保留，功能完全一致)*

---

### 路径 C：本地源码开发与 Link 调试

适用于希望对插件进行二次开发或本地源码调试的开发者：

```sh
# 1. 克隆代码仓库
git clone https://github.com/base404/dsh-agy.git
cd dsh-agy

# 2. 安装依赖并编译打包
pnpm install
pnpm run build

# 3. 将本地项目软链至 DSH 插件目录
dsh plugin --profile web link .

# 4. 执行本地测试套件
pnpm test
```

> 运行环境要求：Node.js >= 20.18.1（推荐 Node 22 以上版本）。

---

## 🛠️ CLI 命令行参考

| 命令 | 常用参数 | 描述 |
|---|---|---|
| `dsh-plugin-agy login` | `--headless`：打印授权 URL，等待粘贴重定向地址<br>`--blob`：直接输出凭据 blob 而不保存到本地<br>`--port <n>`：回调监听端口（默认 `51121`）<br>`--project <id>`：绑定至指定项目 ID<br>`--timeout <ms>`：登录等待超时（默认 `300000`） | 交互式 Google OAuth 授权验证 |
| `dsh-plugin-agy status` | — | 列出账号池中所有账号、启用状态、独立代理及各模型族配额概览 |
| `dsh-plugin-agy import <files...>` | `--blob`：输入为凭据 blob<br>`--email <email>`：指定邮箱地址<br>`--overwrite`：覆盖同邮箱的已有账号记录 | 导入外部 `auth.json` 或凭据 blob（支持多文件/批量导入） |
| `dsh-plugin-agy export` | `--index <n>`：仅导出指定索引账号（默认导出全部）<br>`--out <dir>`：按账号写入独立 blob 文件 | 将本地已存储账号导出为安全凭据 blob |
| `dsh-plugin-agy verify` | `--index <n>`：仅校验指定账号 | 执行 OAuth Token 刷新与 userinfo 端到端健康检查 |
| `dsh-plugin-agy health` | `--index <n...>`：指定检查账号<br>`--interval <ms>`：按设定时间间隔重复检测 | 自动化健康检查守护，凭据恢复正常的账号将自动解除挂起 |
| `dsh-plugin-agy logout` | `--index <n>`：账号序号（默认活动账号）<br>`--email <email>`：指定邮箱 | 从本地安全数据库中注销并移除该账号 |
| `dsh-plugin-agy proxy ...` | `set`、`clear`、`test`、`list` | 详细查看与配置逐账号专属网络代理 |

### 每账号独立代理管理

多账号池场景下，每个账号支持绑定专有的代理通道；代理凭据在本地 AES 加密，输出时自动脱敏为 `protocol://host:port`。

```sh
# 登录或导入时直接指定账号专属代理
dsh-plugin-agy login --proxy socks5://user:pass@127.0.0.1:1080
dsh-plugin-agy import --proxy http://127.0.0.1:7890 auth.json

# 为已有账号配置或更新代理
dsh-plugin-agy proxy set --index 0 --proxy socks5://127.0.0.1:1080
dsh-plugin-agy proxy test --index 0               # 执行 2 秒 TCP 连通性快速探测
dsh-plugin-agy proxy clear --index 0              # 清除专属代理（自动回退至全局环境变量）
dsh-plugin-agy proxy list                         # 查看所有账号的脱敏代理清单
```

- **代理回退机制**：
  - 配置了专属代理的账号：请求严格走专属代理，且自动忽略 `NO_PROXY` 规则。
  - 未配置专属代理的账号：自动继承系统环境变量代理（`HTTP_PROXY` / `HTTPS_PROXY`，遵守 `NO_PROXY`）。
  - 本地回环地址（`127.0.0.1`、`localhost`、`::1`）始终强制直连。
  - 代理探测遵循 Fail-Closed 原则：当专属代理不可达时，立即跳过该账号轮换至下一账号，避免无意义的错误重试。

---

## 🧠 深入核心机制

### 1. 5 小时与周额度双窗口配额与轮换机制

Google Antigravity 针对各模型族（`gemini-*`、`claude-*`、`gpt-*`）采取差异化的双层限流模型，两层周期的补充机制截然不同：

| 配额窗口 | 恢复刷新周期 | 判定耗尽阈值 | 阻断冷却时长 |
|---|---|---|---|
| **5 小时滚动窗口** | 每 5 小时持续补充 | 剩余配额低于 15% | 阻断至该 5 小时周期重置点 |
| **每周自然窗口** | 每 7 天整体刷新 | 剩余配额低于或等于 1% | **阻断至自然周刷新重置点** |

- **为什么必须双窗口联动监控？** 一个账号的 5 小时窗口完全可能剩余 90%，但其周度总配额已经耗尽。如果只看短期窗口，请求依然会失败并触发长时间封锁。本插件独立监控两个闸门，提前感知周配额耗尽并主动绕开，保护账号不陷入长时间停摆。
- **“不用白不用”（Use it or lose it）算法**：在多个可用账号中，算法优先选派配额即将刷新且仍有宽裕余额的账号，实现全池用量最大化。

### 2. 429 智能分流与限流状态机

HTTP 429 不代表粗暴的失败。`dsh-plugin-agy` 内置精准的状态机处理管道：

```mermaid
flowchart TD
    Err[上游返回 429 / 限流信号] --> Classify{状态分类器}
    Classify -->|Retry-After < 3s| Soft[soft_rate_limit: 同账号极速重试, 不写冷却]
    Classify -->|上报明确 Reset 时间| Rate[rate_limited: 冷却至重置时间, 自动切换账号]
    Classify -->|RESOURCE_EXHAUSTED / 配额触顶| Quota[quota_exhausted: 阻断该账号至多24小时]
    Classify -->|短暂网络波动 / 未知错误| Exp[unknown: 指数退避重试]
```

- **401/403 甄别**：普通 401 标记账号需重新认证；对于包含 `RESOURCE_EXHAUSTED` 字样的 403 错误，系统自动识别为临时配额触顶，绝不误杀吊销正常账号。

### 3. 思考预算（Reasoning Effort）深度分析

Gemini 推理模型支持通过内部参数调节思维链（CoT）深度。本插件支持用户自定义填入思考 Token 预算（数值范围 1 至 65535）：

- **低档提智**：在 `Low` 填入适中数值，让模型既保持低消耗又具备充分思考。
- **高档控量**：在 `High` 设置较小上限，防止简单任务陷入过度发散思考，节省配额与时间。
- **顶格思考**：填入 `65535`，在极具挑战的逻辑和代码推导中完全释放模型最强算力。

*Gemini 3.8 Flash 在不同题目难度与思考预算下的实测消耗对比（单位：Token）：*

| 预算设置 | 简单运算题 | 中等数论推导题 | 困难组合递推题 |
|---|:---:|:---:|:---:|
| **默认设置 (Default)** | ~135 | ~1,100 | ~48,700 |
| **低档 (Low)** | ~50 | 0 | ~9,000 |
| **中档 (Medium)** | ~150 | ~870 | ~60,400 |
| **高档 (High)** | ~165 | ~1,855 | ~63,400 |
| **顶格填入 65535** | ~185 | ~2,130 | ~62,900 |

### 4. 上游缓存机制对比（Antigravity vs DeepSeek）

很多用户疑问：*为什么使用 agy 时前几轮缓存命中率不是像 DeepSeek 那样直接达到 99%？*

1. **启用门槛不同**：DeepSeek 缓存零门槛生效；Antigravity 的 Gemini 系列模型要求系统提示词与请求前缀累计达到约 **16k Token** 时才触发缓存写入。因此新对话的前 1-2 轮通常显示 0% 命中，待上下文越过 16k 门槛后命中率将迅速拉升。
2. **缓存更新存在滞后**：DeepSeek 每轮结束即刻更新缓存；Antigravity 缓存落盘存在约 2 轮的延迟——第 N 轮新增的上下文通常在第 N+2 轮才开始生效。随着长对话进行，整体命中率会稳定收敛至极高水平。

### 5. 存储架构与密钥安全

所有数据统一收敛至用户根目录 `~/.dsh/agy/` 下（支持 `$DSH_HOME` 环境变量整体迁移）：

```text
~/.dsh/
├── .credentials.yaml        # 存储主密钥 AGY_MASTER_KEY (0600 权限)
└── agy/
    ├── agy-accounts.json     # AES-256-GCM 加密账号数据库 (0600 权限)
    ├── agy-stats.json        # 累计 Token 与请求统计账本 (0600 权限)
    ├── agy-models.json       # 隐藏模型黑名单 (0600 权限)
    ├── agy-thinking.json     # 用户自定义思考预算映射 (0600 权限)
    ├── agy-multimodal.json   # 多模态文件内联上限设定 (0600 权限)
    ├── agy-recent.json       # 最近 200 条请求与轮换活动环形缓冲区 (0600 权限)
    └── agy-ui-prefs.json     # 前端 UI 个性化配置 (自动刷新与智能模式)
```

- **绝对隐私保护**：统计文件和请求日志中只记录脱敏后的账号邮箱与模型名称，**绝不记录明文 Access Token、Refresh Token 或 Project ID**。

---

## ⚙️ 风险管控与环境变量

| 环境变量 | 默认值 | 功能说明 |
|---|---|---|
| `DSH_AGY_DISABLE=1` | `0` | **一键紧急熔断开关**：阻止插件加载任何组件（Adapter、设置面板、配额徽章），CLI 拒绝执行。 |
| `DSH_AGY_FINGERPRINT_MODE` | `dynamic` | `dynamic`：逐请求动态随机化请求头；<br>`stable`：单账号绑定固定设备指纹标识。 |
| `DSH_AGY_MULTIMODAL_MAX_INLINE_MB` | `20` | 非图片多模态文件的单文件内联大小上限（MB，取值范围 1–100）。 |
| `DSH_AGY_HEALTH_INTERVAL_MS` | `0` (关闭) | DSH 内部后台全自动健康巡检间隔时间（自动 refresh + userinfo）。 |
| `DSH_AGY_IDLE_TIMEOUT_MS` | `180000` | SSE 数据流断流超时时间（默认 3 分钟）。防止由于连接挂起阻塞对话进程。 |
| `AGY_CLIENT_ID`<br>`AGY_CLIENT_SECRET` | *(内置)* | 自备 Google OAuth 客户端密钥逃生通道，用于覆盖内置的公共客户端。 |

---

## 🗑️ 卸载指南

```sh
# 1. 从 DSH 移除插件
dsh plugin --profile web remove dsh-plugin-agy

# 2. 卸载全局 CLI（如已安装）
npm uninstall -g dsh-plugin-agy

# 3.（可选）删除本地存储的全部加密账号与配置数据
rm -rf ~/.dsh/agy

# 4.（可选）撤销 Google 侧授权
# 前往：Google 账号安全中心 → 第三方访问权限 → 撤销 "Antigravity"
```

---

## ⚠️ 风险声明

本插件基于 Antigravity 客户端内置的公开 Google consumer OAuth 客户端，并在该应用生态外调用相关接口。这可能违反上游服务条款。**使用风险完全由个人承担**——账号可能面临限流、降级或限制策略。多账号轮换及指纹伪装仅供开发与研究测试，请合理规范使用。

---

## 🤝 参考项目与致谢

本项目由衷感谢以下开源生态项目的灵感与代码借鉴：

| 来源项目 | 协议 | 借鉴与贡献内容 |
|---|:---:|---|
| [chaos-03x/dsh-agy](https://github.com/chaos-03x/dsh-agy) | **MIT** | **核心上游起源**：多账号存储设计、DSH 原生设置集成、配额双窗口轮换算法及完整 CLI 工具链。 |
| [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) | MIT | OAuth 流程规范、账号存储 Schema、429 指数退避概念及设备指纹模型。 |
| [antigravity-claude-proxy](https://github.com/badrisnarayanan/antigravity-claude-proxy) | MIT | 设备指纹生成算法（经 opencode 移植）。 |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | MIT | Wire 通信协议、SSE 解析、凭据 blob 编解码、thoughtSignature 重放及 429 智能分类引擎。 |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | 插件生命周期规范、`LlmAdapter` 适配机制与 Web 扩展能力。 |

---

## 📄 开源协议

本项目基于 [MIT 协议](LICENSE) 开源。
