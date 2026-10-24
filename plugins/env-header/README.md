# env-header

pi 环境抬头：在**输入框上方**常驻显示

1. **时间 · 地点 · 天气**（时间每秒刷新，地点走 IP 定位，天气走 Open-Meteo）
2. **当前会话概述**（本地启发式摘要始终可用，可选叠加模型生成的一句话概述）

```
 🕒 11:06:36 2026-09-17 星期四  ·  📍 杭州, 浙江, 中国  ·  ⛅ 局部多云 29.1°C  ·  体感 30.5°C, 湿度 44%
 📋 概述 正在给 pi 做 env-header 插件，widget 与模型概述已就绪，正在收尾验证。
```

窄终端会**整段丢弃**后面的信息（先丢天气附加项，再丢天气，再丢地点），不会拦腰截断中文：

```
 🕒 11:06:36 2026-09-17 星期四  ·  📍 杭州, 浙江, 中国  ·  ⛅ 局部多云 29.1°C…     # 110 列
 🕒 11:06:36 2026-09-17 星期四…                                                    # 60 列
```

## 能力

### 1. 时间

`clock` 段控制：秒显示、12/24 小时制、星期、时区。

默认带秒，因此 widget 每 1 秒刷新一次（TUI 里就是一个实时时钟）。如果你走 RPC / pi web，
觉得每秒一次 `setWidget` 事件太吵，就把 `clock.showSeconds` 设为 `false`：内容没变时插件不会重复推送，
刷新频率会自动降到**每分钟一次**。

`clock.timeZone` 四种取值：

| 值 | 含义 |
|---|---|
| `null`（默认） | 跟随系统本地时区 |
| `"auto"` | 跟随定位到的城市时区（VPN 出口不对时容易错，慎用） |
| `"Asia/Shanghai"` | 固定 IANA 时区 |

### 2. 地点

`location.mode`：

| 值 | 含义 |
|---|---|
| `"auto"`（默认） | 公网 IP 定位，依次尝试 `ipwho.is` → `ipinfo.io` → `ip-api.com` |
| `"manual"` | 用 `location.manual`（`/env where <城市>` 会自动写好这一段） |
| `"off"` | 不显示地点，也不请求天气 |

结果按 `location.cacheMinutes`（默认 12 小时）缓存到磁盘，启动时先用缓存渲染再后台刷新。

> IP 定位在开着 VPN / 代理时通常会指向出口机房（例如美国）。要固定到真实城市用：
> ```
> /env where 杭州
> ```

### 3. 天气

Open-Meteo `current`：气温、体感、湿度、风速、WMO 天气代码（映射成 emoji + 中文/英文文案）。按 `weather.cacheMinutes`（默认 10 分钟）刷新；请求失败时继续展示上一次的数据并标注 `缓存`，没有数据则显示 `天气不可用`。

### 4. 会话概述

两层，第二层覆盖第一层：

- **启发式摘要（零成本，永远有）**：`12 轮 · 3 文件 · 起于「…」 · 最近「…」`，直接从会话条目统计。
- **模型概述（可选）**：把会话记录（含工具调用名）压成摘要喂给模型，让它用一句话概括"在做什么 / 进展到哪 / 下一步"。只有当
  1. 会话消息数 ≥ 6，
  2. 距上次生成新增消息数 ≥ `summary.minNewMessages`（默认 8），
  3. 距上次生成间隔 ≥ `summary.minIntervalSeconds`（默认 120s），
  4. `summary.useModel = true` 且能解析到已配置鉴权的模型

  才触发；生成期间显示 `⟳`，失败不会覆盖已有的概述。想完全关掉模型调用：把 `summary.useModel` 设为 `false`（只保留启发式摘要）。

  使用的模型：`summary.model`（`"provider/id"` 或 `"id"`），默认 `null` = 当前会话模型。想省钱就指一个小模型，例如 `"anthropic/claude-haiku-4-5"`。

## 命令

| 命令 | 作用 |
|---|---|
| `/env` | 查看当前状态（地点 / 天气 / 概述 / 配置文件路径） |
| `/env refresh` | 立刻刷新地点 + 天气 |
| `/env summary` | 立刻用模型重新生成会话概述 |
| `/env on` \| `/env off` | 临时开 / 关 widget（仅本次会话） |
| `/env where <城市>` | 把地点固定在某个城市，并写入配置文件 |
| `/env auto` | 地点改回公网 IP 定位 |
| `/env config` | 打印配置文件路径 + 生效配置 |

## 安装

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$HOME/pi-extensions/plugins/env-header" ~/.pi/agent/extensions/env-header
```

改完在 pi 里执行 `/reload`，或重启 pi。

## 配置

默认值写在 [`config.ts`](./config.ts)（有中文注释）。想动默认值但不想改代码，就写一份**同名子集**到：

```
~/.pi/agent/env-header.json          # 或 $PI_CODING_AGENT_DIR/env-header.json
```

会被**深合并**覆盖默认值，例如：

```json
{
  "lang": "zh",
  "clock": { "showSeconds": false, "timeZone": "Asia/Shanghai" },
  "location": { "mode": "manual", "manual": { "name": "杭州" } },
  "weather": { "units": "metric", "showWind": true },
  "summary": { "useModel": true, "model": "anthropic/claude-haiku-4-5", "minNewMessages": 12 }
}
```

缓存文件：`~/.pi/agent/env-header-cache.json`（地点 + 天气，删掉不影响使用）。

## 隐私 / 网络

插件只用免鉴权的公开接口，除以下请求外不发送任何本地内容：

| 用途 | 域名 |
|---|---|
| IP 定位 | `ipwho.is`、`ipinfo.io`、`ip-api.com`（HTTP） |
| 城市名解析 | `geocoding-api.open-meteo.com` |
| 天气 | `api.open-meteo.com` |
| 会话概述 | 你配置的模型 provider（内容为压缩后的会话记录，上限 `summary.maxInputChars` 字符） |

不想产生这些请求：`location.mode = "off"` 关掉定位与天气、`summary.enabled = false` 关掉概述行。所有请求都带超时（默认 6s，概述 45s），失败只降级不打断。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `⚠ 天气不可用` | 无网 / 接口被墙 / 超时；可调大 `weather.timeoutMs` |
| `📍 定位失败` | 三个 IP 接口都失败；用 `/env where <城市>` 固定地点 |
| 地点是国外机房 | VPN / 代理出口；`/env where <城市>` |
| 概述一直是启发式那一行 | 模型没配好（`/env summary` 会说明原因）、消息数不够阈值、或 `summary.useModel = false` |
| widget 不显示 | `/env` 看 `on/off`；确认已 `/reload` 加载插件 |
| pi web / IDE 客户端里 widget 行被截断 | RPC 模式只支持字符串 widget，没有真实宽度，插件按 140 列预折叠 |
| 每轮对话后多花 token | 调大 `summary.minNewMessages` / `minIntervalSeconds`，或 `summary.useModel = false` |
