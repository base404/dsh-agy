# dsh-plugin-agy

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.18.1-brightgreen.svg)](https://nodejs.org/)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-orange.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)

**dsh-plugin-agy** is a feature-rich, high-performance Google Antigravity (agy) access plugin and standalone CLI for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It delivers seamless OAuth 2.0 authentication, an encrypted multi-account pool with quota-aware 429 rotation, dual rolling quota tracking (5-hour and weekly), dynamic device fingerprinting, and first-class Web UI and terminal management.

> 🌐 **Language / 语言导航**  
> [English](README.md) | [简体中文文档](docs/README_zh.md)

---

> 💡 **致谢与项目渊源 (Acknowledgement & Lineage)**  
> 本项目（`dsh-plugin-agy`）遵循 **MIT 开源协议**，基于并深度优化自 [chaos-03x/dsh-agy](https://github.com/chaos-03x/dsh-agy)。衷心感谢原作者 [@chaos-03x](https://github.com/chaos-03x) 及相关贡献者的卓越开拓与实现！本项目在此基础上持续维护并提供针对 DeepSeek Harness 最新特性的深度体验优化。  
> *This project is forked and heavily optimized under the MIT License from [chaos-03x/dsh-agy](https://github.com/chaos-03x/dsh-agy). Sincere gratitude to the original author [@chaos-03x](https://github.com/chaos-03x) and contributors for their outstanding foundation.*

---

## 📑 Table of Contents

- [Features](#-features)
- [UI Screenshots](#-ui-screenshots)
- [Quickstart](#-quickstart)
  - [Path A: DSH Web GUI Users (Recommended)](#path-a-dsh-web-gui-users-recommended)
  - [Path B: Headless Terminal / Linux VPS (CLI)](#path-b-headless-terminal--linux-vps-cli)
  - [Path C: Local Source Development & Link](#path-c-local-source-development--link)
- [CLI Reference](#-cli-reference)
  - [Per-Account Proxy Management](#per-account-proxy-management)
- [Core Architecture & Mechanisms](#-core-architecture--mechanisms)
  - [1. Dual-Window Quota Tracking & Rotation](#1-dual-window-quota-tracking--rotation)
  - [2. Intelligent 429 Rate-Limit Classification](#2-intelligent-429-rate-limit-classification)
  - [3. Thinking Budget (Reasoning Effort)](#3-thinking-budget-reasoning-effort)
  - [4. Upstream Cache Mechanics (Antigravity vs DeepSeek)](#4-upstream-cache-mechanics-antigravity-vs-deepseek)
  - [5. Secure Storage & Secrets Architecture](#5-secure-storage--secrets-architecture)
- [Risk Controls & Environment Variables](#-risk-controls--environment-variables)
- [Uninstallation](#-uninstallation)
- [Disclaimer](#-disclaimer)
- [Credits & References](#-credits--references)
- [License](#-license)

---

## ✨ Features

- **🔑 Frictionless OAuth 2.0 Access**:
  - One-click authorization in desktop browsers via automated local loopback callback.
  - Headless paste-URL mode for remote/VPS environments.
  - Paste-credential blob channel (`--blob`) to safely transport credentials between machines without re-authorizing.

- **🔄 Intelligent Multi-Account Pool & Auto-Rotation**:
  - Encrypted account store with usage-aware, OMP-aligned candidate selection across model families (`gemini-*`, `claude-*`, `gpt-*`).
  - Independent **Dual-Window Tracking**: monitors both rolling 5-hour and 7-day weekly refill windows to prevent exhausting weekly allotments.
  - Smart 429 / `RESOURCE_EXHAUSTED` state classification: differentiates soft rate limits, reset-bound cooldowns, and genuine quota exhaustion.
  - Automatic fallback, cool-down, and failover across accounts matching upstream server reset timestamps.

- **🎨 DeepSeek Harness Native Web Settings Section**:
  - Cleanly integrated under **Settings → Antigravity** (no external dashboard or separate port needed).
  - **Accounts Tab**: Login, activate, inspect per-account 5h/weekly quotas, conduct end-to-end test calls, manage fingerprints, and set dedicated proxies.
  - **Models Tab**: Model visibility switches with blacklist semantics — newly added upstream models appear automatically.
  - **Config Tab**: Fine-tune thinking token budgets (Low/Medium/High/Custom) and customize multimodal inline file limits (1–100 MB).
  - **Usage Tab**: Cumulative tokens (input, output, cache-read, cache-write), total requests, failure rates, rotations, and latency breakdown by account and model.
  - **Credentials Tab**: Convenient import and export of credential blobs and JSON configurations.

- **🏷️ Conversation Header Quota Badge**:
  - Live visual indicator right in the DSH chat session header.
  - Displays the active account's tightest quota window at a glance.
  - Hover tooltip reveals detailed breakdown and real-time reset wall countdowns.

- **🛡️ Enterprise-Grade Security & Isolation**:
  - Credentials encrypted at rest with AES-256-GCM; master key guarded under `0600` POSIX permissions.
  - Loopback trust fence preventing unauthorized external access to management endpoints.
  - Per-account SOCKS5 / HTTP proxy routing with TCP fast-fail diagnostics and loopback direct bypass.
  - Dynamic request header randomization and stable device fingerprint posture options.

- **💻 Standalone CLI (`dsh-plugin-agy` / `dsh-agy`)**:
  - Complete command suite (`login`, `status`, `verify`, `health`, `import`, `export`, `proxy`, `logout`) functioning independently of DSH runtime.

---

## 📸 UI Screenshots & Visual Tour

Native Antigravity management and real-time quota status seamlessly integrated into DeepSeek Harness:

### 1. Conversation Header Quota Badge & Status Popover
Real-time quota monitoring directly in your chat header with multi-family breakdown (Gemini, Claude/GPT, Gemini 4 Argon) and live countdown to the server reset wall:

<p align="center">
  <img src="assets/quota_badge_popover.png" alt="Conversation Header Quota Badge & Status Popover" width="460" />
</p>

### 2. Multi-Account Pool & Diagnostics
Account switching, verification, per-account proxy, device fingerprint status, latency, and throughput metrics:

<p align="center">
  <img src="assets/settings_accounts.png" alt="Multi-Account Pool & Diagnostics" width="680" />
</p>

### 3. Preferences, Smart Idle Mode & Badge Customization
Granular control over auto-rotation, precision reset countdowns, refresh cadences, smart idle pause, and header badge display modes:

<p align="center">
  <img src="assets/settings_preferences.png" alt="Preferences & Badge Configuration" width="680" />
</p>

### 4. Model Blacklist & Cumulative Usage Analytics

| Model Visibility Toggles | Cumulative Usage Ledger |
|:---:|:---:|
| ![Models](assets/zh_models.png) | ![Usage](assets/zh_usage.png) |

---

## 🚀 Quickstart

### Path A: DSH Web GUI Users (Recommended)

For users running the DeepSeek Harness desktop or browser interface:

```sh
# 1. Install dsh-plugin-agy into your DSH web profile
dsh plugin --profile web add dsh-plugin-agy
# Or via npx:
# npx @deepseek-ai/dsh plugin --profile web add dsh-plugin-agy

# 2. Launch DSH Web
dsh web

# 3. Open Settings → Antigravity, click "登录" (Login)
# Complete Google OAuth authorization in your browser and start chatting immediately!
```

> **Where is the management UI?**  
> Go to **Settings → Antigravity** in the DSH top navigation. Everything is configured directly inside the native interface.

---

### Path B: Headless Terminal / Linux VPS (CLI)

Ideal for headless servers, SSH terminal environments, or automated workflows:

```sh
# Run on-demand without global installation (npx / pnpx)
npx dsh-plugin-agy login
npx dsh-plugin-agy status

# Or install globally for everyday convenience
npm install -g dsh-plugin-agy

# Interactive OAuth login (browser, --headless URL paste, or --blob output)
dsh-plugin-agy login

# Check active pool accounts and quota status
dsh-plugin-agy status

# Verify token validity and run diagnostic health checks
dsh-plugin-agy verify

# Run batch background health verification
dsh-plugin-agy health

# Import credentials (auth.json or paste-blob)
dsh-plugin-agy import <file>

# Remove an account
dsh-plugin-agy logout
```

*(Note: The legacy command alias `dsh-agy` is fully retained and operates identically).*

---

### Path C: Local Source Development & Link

For contributors modifying code or testing development builds:

```sh
# 1. Clone repository
git clone https://github.com/base404/dsh-agy.git
cd dsh-agy

# 2. Install dependencies & build
pnpm install
pnpm run build

# 3. Link plugin into DSH
dsh plugin --profile web link .

# 4. Run test suite
pnpm test
```

> Requires Node.js >= 20.18.1 (recommended Node 22+).

---

## 🛠️ CLI Reference

| Command | Key Options | Description |
|---|---|---|
| `dsh-plugin-agy login` | `--headless`<br>`--blob`<br>`--port <n>` (default: `51121`)<br>`--project <id>`<br>`--timeout <ms>` (default: `300000`) | Interactive Google OAuth sign-in. Prints browser callback or waits for pasted redirect URL. |
| `dsh-plugin-agy status` | — | Displays all configured accounts, active index, proxies, and per-model quota status. |
| `dsh-plugin-agy import <files...>` | `--blob`<br>`--email <email>`<br>`--overwrite` | Imports Google Cloud Code `auth.json` files or paste blobs (supports batch import). |
| `dsh-plugin-agy export` | `--index <n>` (default: all)<br>`--out <dir>` | Exports accounts into portable encrypted/base64 credential blobs. |
| `dsh-plugin-agy verify` | `--index <n>` (default: all) | Refreshes OAuth access token and verifies Cloud Code backend userinfo. |
| `dsh-plugin-agy health` | `--index <n...>`<br>`--interval <ms>` | Batch health probe. Re-enables accounts whose credentials have recovered. |
| `dsh-plugin-agy logout` | `--index <n>` (default: active)<br>`--email <email>` | Removes an account from local encrypted storage. |
| `dsh-plugin-agy proxy ...` | `set`, `clear`, `test`, `list` | Inspects and configures per-account proxy settings. |

### Per-Account Proxy Management

Each account in your pool can be routed through its own dedicated proxy. Credentials are encrypted at rest and displayed masked (`protocol://host:port`).

```sh
# Configure proxy during login or import
dsh-plugin-agy login --proxy socks5://user:pass@127.0.0.1:1080
dsh-plugin-agy import --proxy http://127.0.0.1:7890 auth.json

# Manage proxy on an existing account
dsh-plugin-agy proxy set --index 0 --proxy socks5://127.0.0.1:1080
dsh-plugin-agy proxy test --index 0               # Fast 2s TCP probe
dsh-plugin-agy proxy clear --index 0              # Clear proxy (falls back to env)
dsh-plugin-agy proxy list                         # List accounts with masked proxies
```

- **Routing Rules**:
  - Accounts with a configured proxy use that proxy strictly (ignoring `NO_PROXY`).
  - Accounts without an explicit proxy automatically inherit system environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, respecting `NO_PROXY`).
  - Loopback destinations (`127.0.0.1`, `localhost`, `::1`) are always forced direct.
  - Proxy failures are fail-closed: an unreachable proxy skips the account immediately without incurring unnecessary cooldown locks.

---

## 🧠 Core Architecture & Mechanisms

### 1. Dual-Window Quota Tracking & Rotation

Upstream Antigravity enforces quota resets across two disparate timeframes that refill on different schedules. Tracking only one window leads to unexpected outages:

| Quota Window | Refill Schedule | Exhaustion Threshold | Lockout Duration |
|---|---|---|---|
| **Rolling 5-Hour** | Every 5 hours | Remaining < 15% | Until 5-hour reset |
| **Weekly Window** | Every 7 days | Remaining ≤ 1% | Until **weekly** reset |

- **Why Dual Windows Matter**: An account may possess 95% of its 5-hour allowance while its weekly quota is completely drained. Four 5-hour refills cannot restore a depleted weekly quota. The rotation engine evaluates both gates independently.
- **"Use It or Lose It" Policy**: Accounts whose remaining quota is about to reset are prioritized, maximizing overall pool efficiency.

### 2. Intelligent 429 Rate-Limit Classification

HTTP 429 errors are not treated as generic failures. `dsh-plugin-agy` runs a state machine to apply targeted cooldowns:

```mermaid
flowchart TD
    Err[Upstream 429 / Rate Limit] --> Classify{Response Classifier}
    Classify -->|Retry-After < 3s| Soft[soft_rate_limit: Immediate retry, same account]
    Classify -->|Server Reset Time Reported| Rate[rate_limited: Cooldown to reset time, switch account]
    Classify -->|RESOURCE_EXHAUSTED / Quota Reached| Quota[quota_exhausted: Park account up to 24h]
    Classify -->|Transient / Network Glitch| Exp[unknown: Exponential backoff]
```

- **401/403 Handling**: Standard 401s mark an account for re-authentication. 403s containing quota-exhaustion messages are safely redirected to cooldown rather than permanently invalidating healthy accounts.

### 3. Thinking Budget (Reasoning Effort)

Google's reasoning models support a hidden parameter controlling thinking token depth. Custom budgets let you adjust reasoning effort beyond basic `low`, `medium`, and `high` settings:

- **Elevate Low Tier**: Increase tokens on `Low` for deeper analysis while maintaining fast responses.
- **Throttle High Tier**: Cap `High` to save quota and speed up answers.
- **Maximum Reasoning**: Set to `65535` for uncompromising depth on complex problems.

*Empirical tokens consumed by Gemini 3.8 Flash across difficulty tiers:*

| Setting | Easy Problem (Arithmetic) | Medium Problem (Number Theory) | Hard Problem (Combinatorics) |
|---|:---:|:---:|:---:|
| **Default** | ~135 | ~1,100 | ~48,700 |
| **Low** | ~50 | 0 | ~9,000 |
| **Medium** | ~150 | ~870 | ~60,400 |
| **High** | ~165 | ~1,855 | ~63,400 |
| **Custom 65535** | ~185 | ~2,130 | ~62,900 |

### 4. Upstream Cache Mechanics (Antigravity vs DeepSeek)

Why does Antigravity's cache hit rate not hit 99% right away like DeepSeek V4?

1. **Prefix Threshold**: DeepSeek caches from the very first token. In contrast, Antigravity Gemini models require a prompt prefix of ~16k tokens before caching activates. The initial 1–2 turns of a conversation will report 0% cache hit until context exceeds ~16k tokens.
2. **Lagged Cache Writing**: DeepSeek writes updates immediately at the end of each turn. Antigravity updates lag by approximately two turns. Content submitted in turn N only hits the cache in turn N+2. Long conversations will see hit rates climb steadily as context expands.

### 5. Secure Storage & Secrets Architecture

All data files are centralized in `~/.dsh/agy/` (relocatable via `$DSH_HOME`):

```text
~/.dsh/
├── .credentials.yaml        # Holds AGY_MASTER_KEY (0600, owner-only)
└── agy/
    ├── agy-accounts.json     # Encrypted accounts pool (AES-256-GCM, 0600)
    ├── agy-stats.json        # Cumulative token & request usage ledger (0600)
    ├── agy-models.json       # Hidden models blacklist (0600)
    ├── agy-thinking.json     # Stored thinking budgets (0600)
    ├── agy-multimodal.json   # Multimodal inline cap in MB (0600)
    ├── agy-recent.json       # Ring buffer of recent 200 requests/rotations (0600)
    └── agy-ui-prefs.json     # User UI preferences (badge auto-refresh, smart mode)
```

- **Zero Token Leakage**: Statistical and recent-history files store only account emails and model identifiers — never raw tokens, secrets, or project IDs.

---

## ⚙️ Risk Controls & Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DSH_AGY_DISABLE=1` | `0` | **Master Kill Switch**: Prevents plugin registration (provider, Settings UI, quota badge) and terminates CLI. |
| `DSH_AGY_FINGERPRINT_MODE` | `dynamic` | `dynamic`: per-request header randomization.<br>`stable`: fixed client identity per account without header randomization. |
| `DSH_AGY_MULTIMODAL_MAX_INLINE_MB` | `20` | Max inline file size (MB) for non-image multimodal documents (valid: 1–100). |
| `DSH_AGY_HEALTH_INTERVAL_MS` | `0` (off) | Background automated health probe interval inside DSH (token refresh + userinfo). |
| `DSH_AGY_IDLE_TIMEOUT_MS` | `180000` | Silence budget for SSE stream reads (3 minutes). Drops hung connections without interrupting long reasoning pauses. |
| `AGY_CLIENT_ID`<br>`AGY_CLIENT_SECRET` | *(built-in)* | BYO OAuth App escape hatch to override embedded client credentials. |

---

## 🗑️ Uninstallation

```sh
# 1. Remove the plugin from DSH web profile
dsh plugin --profile web remove dsh-plugin-agy

# 2. Uninstall global CLI if installed
npm uninstall -g dsh-plugin-agy

# 3. (Optional) Remove local encrypted accounts and data
rm -rf ~/.dsh/agy

# 4. (Optional) Revoke Google OAuth permissions
# Navigate to: Google Account Settings → Security → Third-party apps → Revoke "Antigravity"
```

---

## ⚠️ Disclaimer

This plugin interfaces with Google's consumer OAuth client and Cloud Code APIs outside of the official Antigravity IDE. This may contravene Google's Terms of Service. **Use at your own risk.** Accounts may experience rate limits, temporary cooldowns, or account restrictions. Multi-account rotation and device fingerprinting are provided for research and workflow continuity; you remain solely responsible for your usage and account security.

---

## 🤝 Credits & References

This project is built with gratitude upon the work of the following open-source projects:

| Project | License | Heritage & Description |
|---|:---:|---|
| [chaos-03x/dsh-agy](https://github.com/chaos-03x/dsh-agy) | **MIT** | **Direct Upstream Origin**: Multi-account pool architecture, DSH Settings client integration, quota management, and CLI suite. |
| [opencode-antigravity-auth](https://github.com/NoeFabris/opencode-antigravity-auth) | MIT | OAuth flow structure, account store schema, 429 backoff concepts, and fingerprint design. |
| [antigravity-claude-proxy](https://github.com/badrisnarayanan/antigravity-claude-proxy) | MIT | Device fingerprint generation logic (via opencode-antigravity-auth). |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | MIT | Wire format, SSE stream handling, credential blob encoding, thoughtSignature replay, and 429 classifier. |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | MIT | Plugin system, `LlmAdapter` abstraction, and web architecture. |

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
