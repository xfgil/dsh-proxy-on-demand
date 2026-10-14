# dsh-proxy-on-demand

> 需要时才拉起代理内核，用完自动关。平时不占端口、不留后台进程。

[English](README.en.md) | 中文

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6EF5)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

| | |
|---|---|
| **`dsh-proxy-on-demand`** — 按需代理，用完自动关（本仓库） |
| [`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader) — 改完插件源码不用重启 |
| [`dsh-session-clock`](https://github.com/xfgil/dsh-session-clock) — 按会话授时与空闲间隔 |
| [`dsh-onebot-companion`](https://github.com/xfgil/dsh-onebot-companion) — QQ 通道一体化：出站沉默守卫 / 行为规则 / 对话节奏 / 人设 / 语音 |

> [!IMPORTANT]
> **首次运行会自动联网下载内核。** 本插件不含内核二进制，第一次要用时会从
> [mihomo](https://github.com/MetaCubeX/mihomo) 的官方 GitHub Release 自动下载
> `mihomo-windows-amd64`（约 **61MB**）到插件目录下的 `runtime/`，之后离线可用。
> 不需要你手动装任何东西；删掉 `runtime/` 即可完全清除，磁盘上不留残余。
> 不想自动下载就在配置里设 `autoDownload: false` 并自行放好内核。

> [!WARNING]
> **自用工具，请自行评估风险。** 本插件按「原样」提供，不附带任何明示或默示担保。
> 代理内核、节点与订阅的来源及合法性由使用者自行负责；请遵守你所在地的法律法规
> 与所使用服务的条款。作者不对使用本软件造成的任何直接或间接后果承担责任。

---

## 目录

- [这是什么](#这是什么)
- [它到底解决了什么问题](#它到底解决了什么问题)
- [环境要求](#环境要求)
- [安装](#安装)
- [使用](#使用)
- [设置界面](#设置界面)
- [游戏检测](#游戏检测)
- [礼让其它代理](#礼让其它代理)
- [配置](#配置)
- [HTTP 接口](#http-接口)
- [它是怎么做到的](#它是怎么做到的)
- [上游程序](#上游程序)
- [已知限制](#已知限制)
- [实现说明](#实现说明)
- [开发](#开发)
- [免责声明](#免责声明)
- [License](#license)

---

## 这是什么

`dsh-proxy-on-demand` 是一个 DeepSeek Harness（DSH）插件，给你一个**随叫随到、用完就走**的代理。

它把 [mihomo](https://github.com/MetaCubeX/mihomo)（Clash Meta 内核）包进插件里：

- **需要时自动拉起** —— 第一次要用的时候自己下载内核、准备配置、启动进程。
- **空闲后自动关闭** —— 默认 2 分钟没人用就杀掉内核、清掉状态文件。
- **平时什么都不占** —— 没有常驻进程，7890 端口是空的，不会和你自己开的 Clash/FlClash 抢端口。
- **打游戏时不添乱** —— 检测到全屏游戏就不启用代理，不改变你的网络环境（见[游戏检测](#游戏检测)）。
- **不跟别的代理抢** —— 你已经开着 FlClash 之类的时候，它自动静默让路，一个进程都不起（见[礼让其它代理](#礼让其它代理)）。

## 它到底解决了什么问题

用 Clash 系客户端（Clash Verge、FlClash、ClashX…）的人都有这个体验：

```
要用一下代理 → 打开客户端 → 等它起内核、拉订阅
→ 用完 → 忘了关 → 它一直挂在托盘里，占着 7890，开着系统代理
```

对**脚本、CI、爬虫、偶尔抓一次墙外数据**这类场景，这个模型是反的：代理只在几秒钟里被需要，却要一直养着一个常驻进程。

这个插件把模型倒过来：**代理是函数的调用栈，不是常驻服务**。

```bash
dsh-proxy -- curl.exe -sS https://api.github.com/repos/MetaCubeX/mihomo
# 内核按需启动 → 命令跑完 → 空闲超时后内核自动退出
```

在 DSH 里，Agent 需要抓墙外内容时直接调 `POST /dsh-proxy/fetch`，插件会顺手启动内核、抓完续一次租约，用完自己关。

### 为什么不用 FlClash 的内核

FlClash 自带的 `FlClashCore.exe` **不是标准 mihomo**，而是 GUI 专用的 IPC 从属进程。它的 `main()` 长这样：

```go
func main() {
    args := os.Args
    if len(args) <= 1 { os.Exit(1) }
    go exitOnTermination()
    startServer(args[1])   // args[1] 是管道名
}

func startServer(arg string) {
    dialed, err := dial(arg)   // 连不上就 panic
    if err != nil { panic(err.Error()) }
}
```

配置全部由界面经 IPC 下发，**无法脱离 GUI 独立启动**（实测 `FlClashCore.exe -v` 会 `panic: dial unix -v`，因为它把 `-v` 当成了管道名）。所以本插件用上游标准内核。

## 环境要求

- Node.js **≥ 22**
- DeepSeek Harness **0.2.0-rc.2**（Electron 44.0.0）—— 开发与验证所用的版本；
  作为插件运行需要它。命令行部分（`dsh-proxy`）可脱离宿主独立使用。
- 一份 Clash/mihomo 配置，来源三选一：
  - 订阅链接
  - 本机 FlClash 的 `config.yaml`（自动导入并修正路径）
  - 手动粘贴

## 安装

```bash
dsh plugin --profile <你的profile> add link:<本目录绝对路径>
```

例如：

```bash
dsh plugin --profile desktop add link:D:/path/to/plugins/dsh-proxy-on-demand
```

从 npm 安装（如果你是用发布版）：

```bash
dsh plugin --profile <你的profile> add dsh-proxy-on-demand
```

装完之后，profile 清单（`dsh.profile.bundles`）会被自动更新。

> **⚠ 对「宿主正在运行时才装的新插件」：光改清单不够，需要再关开一次这个 bundle。**
> 宿主**不会**为运行中新加入的 bundle 自动挂载 —— HMR 只 reconcile 已经存在于
> loader 树里的 entry。实测：清单写好了、`node_modules` 链接也建了，但
> `plugin_manager list_plugins` 里就是没有这个包，HTTP 端点 404。此时把它关掉再打开
> （`plugin_manager set_bundle {target, enabled:false}` → 再 `enabled:true`，两次都会返回
> `{"changed":true,"application":"applied"}`），宿主侧端点立刻 200、客户端界面同时注册进
> slot 树。**不需要重启宿主。**
>
> 反过来，如果插件目录/链接在宿主**启动之前**就存在，宿主启动时会一并加载，就不必这一步。

> 手工安装（不走 CLI）也可以：在 profile 的 `package.json` 里加
> `"dsh-proxy-on-demand": "link:D:/path/to/plugins/dsh-proxy-on-demand"`，
> 并在 `dsh.profile.bundles` 数组里补上 `"dsh-proxy-on-demand"`；
> 然后在 profile 的 `node_modules` 下建一个指向插件目录的链接（`mklink /J` 或符号链接均可）。

## 使用

### 在 DSH 里

装上之后，**设置 → 按需代理**（设置侧栏里独立的一页，不是「设置 → 插件」里的卡片）会出现完整界面（见下节）。也可以用 HTTP 接口：

```bash
curl -X POST http://127.0.0.1:19387/dsh-proxy/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://api.github.com/repos/MetaCubeX/mihomo/releases/latest"}'
```

### 命令行

插件自带 `dsh-proxy` 命令，**不依赖宿主进程**，宿主没起来也能用：

```bash
dsh-proxy status                     # 看状态
dsh-proxy prepare                    # 下载内核 + 准备配置
dsh-proxy import-flclash             # 从本机 FlClash 导入配置
dsh-proxy start                      # 启动内核，守着直到空闲自动关
dsh-proxy stop                       # 立刻关掉
dsh-proxy game                       # 看游戏检测结果
dsh-proxy -- <命令> [参数...]         # 带着代理跑一条命令
```

常用的是最后一种：

```bash
dsh-proxy -- git clone https://github.com/some/repo
dsh-proxy --idle 0 -- curl.exe -sS https://api.ipify.org    # 跑完立刻关
dsh-proxy --idle 600 -- npm install                          # 空闲 10 分钟才关
dsh-proxy --no-gate -- curl.exe -sS https://api.ipify.org    # 跳过游戏检测，强行启用
```

CLI 同样受游戏闸门约束（否则 `dsh-proxy -- ...` 就绕过了整个保护），被拦时退出码是 **3**。

它给子进程注入：

| 变量 | 值 |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | `http://127.0.0.1:<端口>` |
| `NO_PROXY` | `localhost,127.0.0.1,::1,192.168.*,10.*,172.16.*` |

`NO_PROXY` 很重要 —— 否则连本机服务（比如 DSH 自己的 19387）也会被绕进代理。

## 设置界面

装上插件后，**设置**侧栏里会多出一页「按需代理」，从上到下是：

**状态** — 两枚开关，互相独立：

| 开关 | 打开 = | 关闭 = |
|---|---|---|
| **代理内核** | 启动 mihomo（约 0.5 秒，首次要先下内核） | 停止内核，系统代理一并精确还原 |
| **Windows 系统代理** | 把全局流量交给本地内核 | 浏览器直连（内核留着不关） |

两件事分开是有意的：**内核只在 `127.0.0.1` 上监听，没人走它就是死的；真正会改变你网络环境的是系统代理。** 所以你可以「内核开着但系统代理关着」，随手用 `HTTP_PROXY` 指过去；也可以「系统代理开着但内核被关掉」—— 不会，后者插件会先确保内核在跑再开代理，否则等于把你整个网断了。

开关旁边显示内核 PID 与端口；非常驻时还显示「距离自动关还剩几秒」。每 4 秒自动刷新。

> 被其它程序占着系统代理时（比如你正开着 FlClash），这枚开关显示「未接管（被其它程序占用）」并**只报告不覆盖** —— 插件不抢别人的设置。

**节点面板** — 内核在跑时列出当前分组里的节点，每行左名右延迟，`●` 标出正在用的那个。顶部一个**测延迟**按钮触发整组测速；列表**单页固定 8 行**、超出滚动。

这里刻意**没有分组下拉框**：分组全平铺在滚动列表里，你自己滚。测速也是**只留「测延迟」一种**——「测连通性」因为实测只有极少数节点能通过（那次只有香港），判据价值低、又容易被误读成「网络坏了」，已经删掉。

测速目标**沿用每个分组自己配置的 `url:`**（通常机场给的是 `gstatic/generate_204`），插件不替你改写 —— 见[已知限制](#已知限制)里那段被推翻的误判。

**节点配置** — 三种填节点的方式：

| 方式 | 说明 |
|---|---|
| 订阅地址 | 粘贴后点「拉取订阅」，插件下载并改写成相对路径 |
| 从 FlClash 导入 | 读本机 FlClash 的 `config.yaml`，自动把规则文件的绝对路径改成相对路径 |
| 手动粘贴 | 直接贴一份 Clash/mihomo YAML |

**游戏检测** — 显示当前系统状态（`SHQueryUserNotificationState`）、前台程序，以及「有没有检测到游戏」；开关（游戏运行时禁止启用代理 / 检测到游戏连内核也一起关掉）+ 一个「立即重新检测」按钮。详见[游戏检测](#游戏检测)。

**参数** — 代理端口、空闲多久自动关（秒）、启用插件、首次是否自动导入 FlClash 配置。改完立即生效。

> 端口改动需要重启内核才生效：把「代理内核」开关关掉再打开。

界面**不走 DSH 的 settings 服务**，而是直接读写信件文件 + 自己的 HTTP 端点。原因见[实现说明](#实现说明)。

## 游戏检测

打游戏的时候不希望网络环境被改动，所以插件会在**启动内核之前**先看一眼系统状态：**检测到游戏就不让启用代理**。

### 只管自己

这里有个刻意的设计：**判据不看「这是哪个软件」**。

**没有内置的游戏清单，也没有内置的加速器白名单**——因为维护这种名单既不可能穷尽，又会因为漏列而把真正该拦的场景放过去。判据只问一件事：**现在这个场景像不像在全屏玩游戏**。

代价是可能误判（某个程序的无边框全屏被当成游戏）。误判的后果仅仅是代理插件这次不启动，游戏本身毫发无伤 —— 临时关掉开关、把它加进白名单、或命令行加 `--no-gate` 都能绕过。

### 白名单（由你自己填）

上面说的是**不由插件预置**任何名单。但你自己可能确实需要例外（比如某个远程控制、录屏、无边框视频播放器全屏时被判成了游戏），所以留了**用户白名单** —— **默认为空，只由你填**。

| 填法 | 匹配方式 |
|---|---|
| `obs64.exe` | 按**进程名**比对，大小写不敏感 |
| `D:\path\to\OBS\obs64.exe` | 按**完整路径**比对（正斜杠也认，大小写不敏感） |

填名字更耐用（程序升级换目录后名字通常不变），代价是**同名但不同目录的程序会被一起放过**；填全路径只放过那一个，但路径变了就失效。两种混着填都行。

白名单命中的是**当前前台程序**时，两条判据都不生效。界面上的「把当前前台程序加进来」直接取探测到的那一刻的前台窗口 —— 全屏被误判时点这个最省事。

### 两条判据

| 判据 | 内容 | 来源 |
|---|---|---|
| **主** | 系统状态 ∈ {忙碌, 独占全屏, 演示中} | `SHQueryUserNotificationState` |
| **辅** | 前台窗口铺满整块显示器**且**没有标题栏，且不是 shell 组件 | `GetForegroundWindow` + `GetWindowLong` + `MonitorFromWindow` |

主判据的意义在于：**这是 Windows 自己在说「现在别打扰用户」**。实测它能识别无边框全屏（不只是独占 D3D 全屏）—— 弹出 `FormBorderStyle=None` + 铺满屏幕的窗口时，QUNS 从 5（可打扰）变成 2（忙碌）。

辅判据兜住系统没报状态的无边框全屏。它必须排除 shell 组件，否则会误判：实测 `explorer.exe` 桌面被拉到前台时 `caption=false, full=true`，**朴素判据会把它当成游戏**，但同一时刻 QUNS=5，系统明确说「可打扰」—— 这正是「QUNS 必须是主判据」的原因。

`QUNS` 取值：`1=锁屏 / 2=忙碌 / 3=独占全屏 / 4=演示 / 5=可打扰 / 6=免打扰时段 / 7=应用自定`。只有 `2/3/4` 会拦。

### 只拦新的，已有的不动

`ensureRunning()` 在内核已在跑时直接续租返回，**不经过闸门**。所以：

- 游戏开始时如果代理**没在跑** → 不许启动（返回 `409 Conflict`）。
- 游戏开始时如果代理**已经在跑** → 保持不动，不打断你正在进行的下载。

想改成「游戏一起来就关掉代理」，打开设置里的「检测到游戏就关掉已在运行的代理」（`stopOnGame`）。

### 检测失败时不拦

探测进程起不来、编译失败、超时 —— 这些情况下闸门**放行**。宁可放过，也不让检测本身的问题把代理彻底锁死。

### 探测进程

检测走一个**常驻子进程** `runtime/gameprobe.exe`（内嵌 C# 源码，用 Windows 自带的 `csc.exe` 编译，不需要装 SDK）。协议是 stdin/stdout 逐行 JSON。

为什么常驻而不是每次起进程 —— 实测数据：

| 方案 | 单次成本 |
|---|---|
| 每次 `Add-Type` 编译 | 480ms |
| 编译成 exe，每次起进程 | 349ms |
| 编译成 DLL + `Assembly.LoadFrom` | 8ms |
| **常驻 exe + stdin/stdout** | **0.5ms**（冷启动 385ms，只付一次） |

界面每 4 秒轮询一次，判定还有 3 秒 TTL 缓存 —— 实际系统调用频率约 3 秒一次。

### 命令行

```bash
dsh-proxy game                        # 看检测结果：系统状态、前台程序、判定用时
dsh-proxy game --json                 # 同样的东西，JSON 形式
dsh-proxy game list                   # 列出白名单
dsh-proxy game allow obs64.exe        # 把程序加进白名单（误判时用）
dsh-proxy game --allow-fg             # 把当前前台程序加进白名单
dsh-proxy game unallow obs64.exe      # 从白名单移除
dsh-proxy --no-gate -- cmd            # 本次跳过检测，强行启用
```

被闸门拦下时 CLI 退出码是 **3**（区别于普通的 1），脚本里可以据此区分「被游戏拦了」和「真的出错了」。

## 礼让其它代理

如果你机器上已经有别的代理在跑（FlClash、Clash Verge、v2rayN……），本插件**自动静默让路**：不启动自己的内核、不抢端口、不改你的网络环境。别的代理退出后自动恢复。

### 只看端口，不认软件

判据只有一条：**常见代理端口有没有人在监听**。

| | |
|---|---|
| 探的端口 | 18 个：`7890-7893`（Clash/mihomo）、`7897/7898`（Clash Verge Rev）、`10808-10810`（v2rayN/xray）、`1080/1081`（SOCKS 惯例）、`2080/2081`（sing-box）、`20171/20172`（Clash Verge 旧版）、`8889`（Clash for Windows）、`8118`（privoxy）、`9910`，外加本插件自己的端口 |
| 成本 | 并发探完约 **2–3ms**（loopback 上的连接拒绝是瞬时的） |

为什么不看进程名：换成任何代理软件都自动适用，不需要维护「谁是代理」的名单，也不会因为某个软件不在名单里而漏判。代价是覆盖不到两种情况 —— 代理软件开着但还没开始监听端口，以及 TUN 模式不监听端口。这两种情况下本插件会照常启动，但因为那个代理还在，命令实际走的仍是对方（见下面「端口被占时复用」）。

### 必须排除自己的内核

本插件自己就监听 `port`（默认 7890）。如果检测时不排除自己，内核一跑起来就会被自己认成「别的代理」，从此**永远自我阻断**。

所以判定里有一条硬规则：`端口 === ownPort && 自己的内核活着` → 不算别人。`ownAlive` 由 `core` 算好再传给上层 —— 因为「这个端口上的监听是不是我自己」只有 core 知道。

### 端口被占时复用，端口空闲时才拦

闸门只在**准备自己起内核**时才需要开口拦人。如果 7890 已经被别人占着，`ensureRunning()` 直接标记 `external: true` 返回：命令照常能用（走的是别人已经建好的代理），而我们一个进程都不起。这是「自动静默」在正常路径上的形态。

### 检测失败时不拦

与游戏闸门同一原则：探测出错时放行 —— 宁可多起一次内核，也不要因为探测代码出问题就让代理彻底不可用。

### 命令行

```bash
dsh-proxy peers              # 看检测结果：哪些端口被占、判定用时
dsh-proxy peers --json       # 同样的东西，JSON 形式
dsh-proxy --no-peer -- cmd   # 本次跳过礼让，强行启用
```

被礼让闸门拦下时 CLI 退出码是 **4**（游戏闸门是 3，普通错误是 1）。

## 配置

插件自己的设置存在 `<插件>/runtime/settings.state`：

```json
{
  "enabled": true,
  "port": 7890,
  "idleMs": 120000,
  "subscriptionUrl": "",
  "autoImportFlClash": true,
  "configSource": "flclash",
  "lastSyncAt": 1760000000000,
  "lastSyncNote": "已从 FlClash 导入（规则 44 条）",
  "blockOnGame": true,
  "stopOnGame": false,
  "gameAllow": ["obs64.exe", "D:\\path\\to\\OBS\\obs64.exe"],
  "yieldToPeer": true,
  "systemProxy": true,
  "resident": false
}
```

`blockOnGame` 默认 `true`（游戏运行时禁止启用代理），`stopOnGame` 默认 `false`（只拦新的，已有的不动），`gameAllow` 默认 `[]`（白名单只由用户自己填，插件不预置），`yieldToPeer` 默认 `true`（检测到其它代理时自动让路）。

`systemProxy` 默认 `true`（允许插件开关 Windows 系统代理，关掉时会精确还原你的原设置）；`resident` 默认 **`false`** —— 也就是本插件原本的行为「**用完了自己关掉**」，把它打开才是常驻（不因空闲自动关闭，随 DSH 一起退出）。

> **系统代理只由面板上那枚开关控制**，内核起停不会动它（2026-10-14 更正）。
> 早先版本有过一个默认开启的 `proxyOnStart`，让「内核一起来就把系统代理指过来」；
> 那个键已删除。理由：内核只绑 `127.0.0.1`，起停没有副作用；系统代理是**全局**影响 ——
> 一个无副作用的东西不该去自动触发一个有副作用的东西，何况那个行为在面板上没有开关，
> 用户既看不见也关不掉。现在内核停了仍会**还原**系统代理，但那不是替你决定，
> 而是收回插件自己留下的痕迹（指向死端口会让你整个上不了网）。

`runtime/` 目录（已被 `.gitignore` 排除）里放的是运行期产物：

| 文件 | 作用 |
|---|---|
| `mihomo.exe` | 内核（首次用时自动下载） |
| `config.yaml` | 喂给内核的配置 |
| `providers/rules/` | rule-provider 规则文件 |
| `settings.state` | 上面那份用户设置 |
| `core.pid` | 当前内核 PID（只用来杀自己启动的那个） |
| `lease.state` | 租约，记录「用到什么时候为止」 |
| `busy.state` | 忙锁，记录「哪条长命令正在用」（按 PID 判存活） |
| `gameprobe.exe` / `gameprobe.cs` | 游戏检测用的常驻探测进程（首次用时自动编译） |
| `proxy-backup.state` | **接管系统代理前的原设置备份**（还原时逐字段写回） |
| `core.log` | 内核日志 |

> **为什么状态文件是 `.state` 而不是 `.json`？**
>
> 宿主会盯着插件目录，而它的插件监视器**只看 `.json`**（2026-10-14 用 21 种扩展名实测的矩阵：`.state`/`.log`/`.txt`/`.dat`/`.lock`/`.yaml`/`.pid`… 全都不触发，**只有 `.json` 触发**，子目录里的 `.json` 同样触发）。一触发就是一次完整的热重载：**先 dispose 旧实例，再 apply 新实例**。
>
> 所以只要状态文件叫 `.json`，每写一次盘就重建一次插件，其中最要命的一条链是：
>
> 1. 你点「开系统代理」→ 插件写 `proxy-backup.json`（备份你的原设置）；
> 2. **这一次写盘就触发了热重载**；
> 3. 新实例接手时去读注册表，而旧实例那条改注册表的 PowerShell 还没跑完（实测 ~700ms）→ 新实例判「系统代理不是我们的」→ 把刚写的备份删掉；
> 4. 注册表随后才变成「已启用」——**代理开着、备份没了**；
> 5. 于是你再也关不掉它：关的分支读不到备份，只能回一句「我们没改过」。
>
> 换成 `.state` 之后热重载**根本不会发生**，这条竞态从根上消失，而不是靠补丁躲过去。旧版本留下的 `.json` 会在启动时自动迁移（`migrateStateFiles()`），迁移完就删掉——留着它仍会继续触发热重载。

## HTTP 接口

全部只监听 **loopback**（`127.0.0.1` / `::1`），非本机请求返回 403。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-proxy/status` | 状态：内核是否在跑、PID、剩余秒数、系统代理现状 |
| GET | `/dsh-proxy/settings` | 读设置 + 当前配置概况 |
| POST | `/dsh-proxy/settings` | 写设置 |
| GET | `/dsh-proxy/system-proxy` | 系统代理现状（是否我方接管 / 是否被别人占） |
| POST | `/dsh-proxy/system-proxy` | `{"on":true\|false}` 开关系统代理（开之前会先确保内核在跑） |
| GET | `/dsh-proxy/proxies` | 列出分组与节点（加 `?fake=1` 连信息伪节点一起列） |
| POST | `/dsh-proxy/proxies/select` | `{"group":"...","node":"..."}` 切换节点，**回读确认** |
| POST | `/dsh-proxy/proxies/test` | `{"group":"...","timeoutMs":3000}` 测延迟 |
| POST | `/dsh-proxy/prepare` | 下载内核 + 准备配置 |
| POST | `/dsh-proxy/start` | 启动内核 |
| POST | `/dsh-proxy/stop` | 关闭内核 |
| POST | `/dsh-proxy/renew` | 续期空闲计时 |
| POST | `/dsh-proxy/config/from-subscription` | `{"url":"..."}` 拉订阅 |
| POST | `/dsh-proxy/config/import-flclash` | 从本机 FlClash 导入 |
| POST | `/dsh-proxy/config/manual` | `{"text":"..."}` 手动写配置 |
| GET | `/dsh-proxy/config/example` | 取一份模板 |
| POST | `/dsh-proxy/fetch` | `{"url":"https://..."}` 经代理抓一次 |
| GET | `/dsh-proxy/game` | 游戏检测状态（加 `?force=1` 绕过缓存） |
| POST | `/dsh-proxy/game/clear-cache` | 清检测缓存，强制重新检测 |
| POST | `/dsh-proxy/game/allow` | 加白名单；不传参数则取**当前前台程序** |
| POST | `/dsh-proxy/game/allow/remove` | `{"entry":"..."}` 从白名单移除 |
| GET | `/dsh-proxy/peers` | 礼让检测状态（加 `?force=1` 绕过缓存） |
| POST | `/dsh-proxy/peers/clear-cache` | 清礼让检测缓存，强制重新检测 |

被游戏闸门拦下时，`POST /start` 与 `POST /fetch` 返回 **409 Conflict**：

```json
{
  "ok": false,
  "blocked": true,
  "reason": "game-running",
  "error": "系统处于「忙碌」状态（game.exe），已按设置禁止启用代理。…"
}
```

被礼让闸门拦下时同样是 409，`reason` 是 `peer-running`：

```json
{
  "ok": false,
  "blocked": true,
  "reason": "peer-running",
  "error": "检测到其它代理正在运行（端口 10808 正在被监听），已按设置自动静默让路，不启动本插件的内核。…"
}
```

## 它是怎么做到的

### 空闲自动关：租约 + 守护

```
任何一次使用 ──renew()──> 写 lease.state { deadline: now + idleMs }
                              │
守护定时器（每 15s）───────────┘
   有命令正持忙锁？──是──> 绝不关（busy.state，按 PID 判定存活）
        │否
   deadline 到期？──否──> 继续睡
        │是
        └─> 内核是**我们**起的？──否──> 只删租约，不碰进程
                 │是
                 └─> 杀 core.pid 里的那个 PID，删 pid/lease/busy 文件
```

四个刻意的设计：

1. **只杀自己启动的 PID。** 状态文件里记着 `core.pid`，绝不按进程名扫杀 —— 否则会误杀用户自己开的 FlClash 或其他 mihomo。
2. **端口被占时不抢。** 如果 7890 已经被别的程序监听（比如用户开了 FlClash），插件不启动内核，只标记 `external` 后照常可用，也**不会**在空闲时去关那个不属于自己的进程。
3. **长命令期间持忙锁。** `dsh-proxy -- <命令>` 跑起来时会写 `busy.state`（内容是自己的 PID）并持续续租。只要锁在，`checkIdle()` 一律不动内核 —— 否则一条比 `idleMs` 更久的命令（比如 `npm install`、`git clone`）会在跑到一半时被自己的守护掐断，表现为 `ConnectionReset`。持有者进程若已消失，锁按 PID 自动失效，不会永久卡住。
4. **命令行守到最后。** 守护定时器是 `unref()` 的（不阻止 Node 退出）。所以 `dsh-proxy start` 与 `dsh-proxy -- <命令>` 都会一直守着，直到内核真的被自动关掉才返回 —— 否则命令一跑完就退出，没人执行「到期杀内核」那一步，内核会一直挂着，正是本插件要消灭的情况。

### 游戏闸门插在哪

闸门只插在**起核路径**上，不影响已在运行的内核：

```
POST /start ─┐
POST /fetch ─┼─> ensureAndStart() ─> core.ensureRunning()
CLI -- cmd  ─┘                            │
                                          内核已在跑？──是──> 续租返回（不查闸门）
                                               │否
                                        gameGate() ──blocked──> 抛 GAME_BLOCKED ─> HTTP 409
                                               │放行
                                          core.start()
```

`gate` 与 `gameWatch` 是用**闭包回调**注入 `core` 的，不是让 `core.js` 直接 `import games.js` —— 这样 `core.js` 只管进程生命周期，判据与设置留在上层，也能被单独测试。

白名单在 `evaluateGate()` 里生效：命中时**两条判据都不参与**（`hit` 直接为 `null`），而不是"判完之后再撤销"。这样"为什么这次没拦"只有一个解释，界面也能明确告诉你命中的是名字还是路径。

`stopOnGame` 的钩子挂在守护的 `checkIdle()` 里（在忙锁判断之后、租约判断之前）：有命令持锁时绝不关，否则检测到游戏就把内核关掉。

### 礼让闸门插在哪

礼让闸门与游戏闸门是**姊妹机制**，同一个位置、同一个原则（只拦新的、检测失败放行），但**先于游戏闸门判定**：

```
POST /start ─┐
POST /fetch ─┼─> ensureAndStart() ─> core.ensureRunning()
CLI -- cmd  ─┘                            │
                                          内核已在跑？──是──> 续租返回
                                               │否
                                          端口被别人占？──是──> 标记 external 复用，不起内核
                                               │否
                                          peerGate() ──blocked──> 抛 PEER_BLOCKED ─> HTTP 409
                                               │放行
                                          gameGate() ──blocked──> 抛 GAME_BLOCKED ─> HTTP 409
                                               │放行
                                          core.start()
```

顺序有讲究：**礼让在前**。如果别的代理已经占了端口，「能不能起」这件事根本轮不到游戏状态来回答；先让路可以少探一次系统状态，也让用户看到的被拦原因更准确。

`peerGate` 同样是闭包回调注入 `core`，但签名不同 —— 它接收 `{ ownAlive }`：

```js
const peerGateFn = ({ ownAlive } = {}) => peerGate({
  yieldToPeer: user.yieldToPeer !== false,
  ownPort: user.port,
  ownAlive: ownAlive === true,
});
```

`ownAlive` 必须由 `core` 现算再传下去 —— 上层（`index.js`）拿不到「7890 上的监听是不是我自己」这个判断依据。

### 内核获取：自包含下载 + 解压

不引入任何第三方依赖：

- **下载**：`node:https` + 手动跟随 302（GitHub release 必跳一次到 `objects.githubusercontent.com`）
- **解压**：手写 zip 解析（EOCD 签名 `0x06054b50` → 中央目录 `0x02014b50` → 本地头 `0x04034b50`），method 0 直接取、method 8 走 `zlib.inflateRaw`

**镜像回退**是必需的：直连 `github.com` 的 release 下载在国内会**挂死**（TCP 连得上、请求发得出去、响应永远不来，实测 12 秒后 socket hang up），而不是快速失败。所以每个源都有 12 秒首字节超时，超时就换下一个：

```js
export const DEFAULT_MIRRORS = [
  '',                          // 直连
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://ghfast.top/',
];
```

实测：直连超时 12s → `gh-proxy.com` 7.8 秒下完 61MB 并解压成功。

### 配置路径：两个必踩的坑

**坑 1 — SAFE_PATHS 沙盒。** mihomo 只允许访问 `-d` 目录内的**相对路径**。FlClash 的配置里 rule-provider 写的是绝对路径，直接启动会：

```
Parse config error: path is not subpath of home directory or SAFE_PATHS:
C:\Users\<user>\AppData\Roaming\com.follow\clash\profiles\...\rules\59aaf94a...
allowed paths: [D:\path\to\plugins\dsh-proxy-on-demand\runtime]
```

修法：把规则文件拷进 `runtime/providers/rules/`，路径改写成 `providers/rules/<hash>`。

**坑 2 — YAML 里是双反斜杠。** 文件里写作 `C:\\Users\\暝\\...`。如果按**单**反斜杠写 `-replace`，会**静默不匹配** —— 而且此时再查「还剩几个单反斜杠」同样返回 0，造成「已经改好了」的假象。必须按字面的双反斜杠匹配：

```js
const SEP = '\\\\\\\\?';   // 一个或两个字面反斜杠都认
```

## 上游程序

本插件**不含**代理内核，只负责按需拉起和关掉它。真正的代理能力来自上游：

| | |
|---|---|
| 项目 | [mihomo](https://github.com/MetaCubeX/mihomo)（即 Clash.Meta 内核） |
| 版权 | © MetaCubeX 及 mihomo 贡献者 |
| 授权 | **GPL-3.0**（独立于本仓库的 MIT） |
| 本插件与它的关系 | 仅在其官方 GitHub Release 下载 `mihomo-windows-amd64` 二进制，**不修改、不重新打包、不静态链接**；以独立进程方式调用 |
| 实测版本 | `v1.19.32`（`Mihomo Meta v1.19.32 windows amd64 with go1.26.8`），约 61MB |
| 版本策略 | 默认取 `/releases/latest`；可用配置项 `kernelVersion` 固定版本 |

上游程序的许可证、行为与安全性由上游项目负责。若你要分发本插件，请注意
**下载** GPL-3.0 程序与**再分发**它是两回事：本仓库只做前者。

## 已知限制

- **Windows 优先。** 内核资产名目前写死 `mihomo-windows-amd64`。换平台需要改 `lib/index.js` 的 `prepareKernel()`。
- **首次要联网下内核**（约 61MB）。下好之后缓存在 `runtime/`，之后离线可用。
- **端口被占时不自启。** 这是刻意的：宁可复用别人已经开着的代理，也不去抢端口。
- **`settings.state` 与 `config.yaml` 分开存。** 换订阅不会丢你的开关和端口设置，但反过来，手动改 `config.yaml` 不会同步进界面显示的「节点数」以外的字段。
- **游戏检测基于场景推断，不看软件身份。** 这是刻意的（见[游戏检测](#游戏检测)），代价是某些程序的无边框全屏会被误判成游戏。误判只是本次不启动代理，不会影响游戏本身；也可以把那个程序加进[白名单](#白名单由你自己填)。
- **探测进程需要 `csc.exe`。** 用的是 Windows 自带的 .NET Framework 编译器（`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`），不需要装 SDK。极端精简的系统上若缺失，闸门会退化成「检测失败 → 放行」。
- **礼让检测只看端口，不看软件身份。** 也是刻意的（见[礼让其它代理](#礼让其它代理)）。覆盖不到「代理软件开着但还没监听端口」和「TUN 模式不监听端口」两种情况；这种情况下本插件会照常启动，但因为那个代理还在，命令实际走的仍是对方。
- **只测过 Windows 10/11 x64 + DSH 0.2.0-rc.2。**
- **会接管系统代理（可关）。** 内核起来时默认把 Windows 系统代理指到本地端口上，这是大多数人对「开了代理」的预期。原设置会备份到 `runtime/proxy-backup.state`，关闭时逐字段写回（**包括 `ProxyEnable=0`** ——你原本没开，关掉后也不会替你开着）。你要是自己开着 FlClash，插件**只报告不覆盖**。不想要这个行为就把设置里的「允许本插件管理 Windows 系统代理」关掉。

### 一个被推翻的误判：测速目标

2026-10-13 我曾在配置导入路径上做了一件事：把分组里的测速地址 `url: https://www.gstatic.com/generate_204` 全换成国内的 `connect.rom.miui.com`，理由是「gstatic 在国内被墙 → 面板满屏超时」。

**这条因果链是错的，改动已回退。** 内核测速是**经由节点**发出去的请求，走节点所在地的出口，和「本机能不能直连 gstatic」毫无关系。同一批节点、只换测速目标的对照实验（3 个自动组 × 4 成员 = 12 样本，测完回读面板读的顶层 `history`，统计拿到有效延迟的成员数）：

| 测速目标 | 有效 |
|---|---|
| 不传（内核用分组自己的目标） | **11/12 = 92%** |
| 显式传分组自己的 `testUrl` | 10/12 = 83% |
| 改传 miui | 10/12 = 83% |

三者基本等价，所以**没有任何理由去改写用户的测速目标**。「全超时」的真病根是 **DNS 端口冲突**（FlClash 占着 `1053`，内核 DNS 起不来 → 域名解析不了 → 全部超时），由 `forceDnsPort()` 自动换端口解决，与测速目标无关。

同理，节点的 `history` **不是**按测速 URL 分桶的 —— 传 miui 或 gstatic 都会更新面板读的那个顶层 `history`，所以也不存在「用别的目标测会让面板读不到」的问题。

## 实现说明

几个不那么显然的决定：

**界面不依赖 `settings` 服务。** 常规做法是宿主侧 `ctx.settings.installSection(ctx, NS, Config, defaults, hooks)`，其中 `Config` 是 `@deepseek-ai/schemastery` 的 `z.object({...})`。但 profile 侧经常解析不到 `schemastery`（本机就是：包里只有 `LICENSE`/`package.json`/`README.md`，**没有 `lib`**）。导出非 schema 对象会让 loader 投影 config 时报错。所以本插件的界面全部走自己的 HTTP 端点，宿主侧只读写 `settings.state`。

**不导出 Config schema。** 同上原因。

**统计放 `globalThis[Symbol.for(...)]`。** 热重载会重新执行模块顶层代码，普通模块级变量会归零；挂在 `globalThis` 上的 Symbol 键能跨重载累计。

**客户端半边不用打包。** `package.json` 里声明 `dsh.client = { platform: "web", inject: [...] }`，入口 `lib/client.js` 是 `window.__ModuleLoader__.load({ id, factory })` 形式，内部 `require("react")`，导出 `apply` / `inject` / `name`。

**注册到 `settings.section` slot。** 这个 slot 是「设置」侧栏里独立的一页（不是「设置 → 插件」里的一张卡片）：

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'dsh-proxy-on-demand',
  order: 60,
  label: () => '按需代理',
  icon: 'settings',
}, Card));
```

**踩坑：`settings.plugin.item` 在本机 DSH 0.2.0-rc.2 里并不存在。** 这个 slot 名是从 `dsh-session-manager` 源码里抄来的，但用 `cordis_inspect_query(client/Slots/listSubTree {root:'settings.plugin.item'})` 实测返回 `{"requestedRoot":{"name":"settings.plugin.item","available":false}}` —— 该名字根本不在 slot 树里。更麻烦的是**注册到不存在的 slot 不会报错**，整块界面只是静默不渲染，`plugin_manager` 里插件的 `fiberPhase` 照样是 `active`。

用 `listSubTree {root:'settings.section'}` 才看到真实拓扑与 `occupants` 列表，确认自己的 id 有没有进去：

```json
{ "registrant": "dsh-proxy-on-demand-client", "id": "dsh-proxy-on-demand",
  "order": 60, "active": true }
```

本机 slot 树里与设置/插件相关的真实名字：`settings.section`（设置侧栏一页）、`settings.plugins.tab`（Plugins 设置区里的一页）、`settings.general.item`（General 区里的一行偏好）、`plugins.bundle.config`（keyed，key = 包名）、`plugins.row.config`（keyed，`<包名>#<行 id>`）、`plugins.detail.section`。写客户端界面时**先 `listSubTree` 确认，再注册**。

**HTTP 面注册后 pathname 仍带前缀。** `webServer.register({ kind: 'prefix', path: '/dsh-proxy', handler })` 之后，`url.pathname` 依然是 `/dsh-proxy/status`，需要自己剥：

```js
const path = url.pathname.replace(/^\/dsh-proxy(?=-|\/|$)/, '') || '/';
```

**https 目标必须先 CONNECT。** 把 https 请求直接打到明文代理端口会失败，报 `Client network socket disconnected before secure TLS connection was established` —— 这不是代理坏了，是用法错了。`lib/index.js` 的 `proxyGet()` 里手写了 CONNECT 隧道。

**常驻子进程会让 Node 不退出。** `lib/probe.js` 起的探测进程持有 stdio 管道，事件循环因此一直非空 —— 短命令（`dsh-proxy game`）跑完却不退出，看起来像卡死。`bin/dsh-proxy.mjs` 在脚本末尾显式 `await disposeProbe()`。

**P/Invoke 三个坑。** 写 `lib/probe.js` 的内嵌 C# 时全踩过：

- `GetMonitorInfoW` / `GetWindowTextW` / `QueryFullProcessImageNameW` **必须**显式写 `EntryPoint = "...W"` 或 `CharSet = CharSet.Unicode` —— 默认会去找 `*A` 版本，而**这些函数根本没有 A 版**，运行时抛 `EntryPointNotFoundException`。
- 取窗口样式用 `GetWindowLongW`，不是 `GetWindowLongPtrW`。
- `OpenProcess` 用 `PROCESS_QUERY_LIMITED_INFORMATION (0x1000)` 就能拿进程路径，不需要提升权限。

## 开发

```bash
node --check lib/index.js          # 语法检查
node test/games-test.mjs           # 游戏判定规则（离线，61 项，纯函数喂构造数据）
node test/peers-test.mjs           # 礼让判定规则（离线，26 项，纯函数喂构造数据）
node test/client-render-test.mjs   # 客户端界面渲染（离线，37 项，不需要内核）
node test/dl-test.mjs              # 只测内核下载（快）
node test/busy-test.mjs            # 忙锁回归：命令比 idleMs 更久时内核必须活着
node test/selftest.mjs             # 端到端：导入配置 → 下内核 → 启动 → 出国 → 空闲自关
```

`test/games-test.mjs` 之所以能完全离线，是因为判定核心 `evaluateGate()` 被刻意抽成了**纯函数** —— 吃「探测帧」对象、吐结论，不碰真实系统。所以覆盖 explorer 桌面全屏、输入法宿主全屏、探测失败、字段缺失这些边界都不需要真去制造那些场景。白名单那 23 项也全在这里：名字匹配 / 路径匹配 / 大小写 / 正斜杠路径 / 只填名字会连别的目录同名程序一起放过 / 命中时两条判据都不参与 / 脏输入不崩。

`test/peers-test.mjs` 同理：判定核心 `evaluatePeers()` 也是纯函数，吃构造的端口探测结果。所以「自己的内核占自己的端口不算别人」「同一端口但自己没活那就是别人的」这两个关键分支能精确覆盖，不需要真去起一个假代理。

`test/client-render-test.mjs` 用一个最小 React 替身把 `lib/client.js` 的组件
在「数据未到位 / 数据到位 / 出错」三种状态下各渲染一遍，**不联网、不下内核**。
它抓的是两类静默失败：注册到不存在的 slot（宿主不报错，界面只是不出现）、
以及 `settings.state` 被手工改坏后渲染期抛异常（`subscriptionUrl: null` 会让
`subInput.trim()` 抛 `Cannot read properties of null`）。输入数据用的是宿主
`/dsh-proxy/status` 与 `/settings` 的实测返回形状。

`test/busy-test.mjs` 针对一个真实踩过的坑：`--idle 3` 配一条要跑 10 秒的命令，
修复前守护会在第 3 秒杀掉内核、命令最后一步报 `ConnectionReset`。现在 6 项全过
（命令拿到出口 IP、内核按策略自动关、忙锁已释放）。

`test/selftest.mjs` 用**本机真实的 FlClash 配置**跑全链路，14 项检查：

```
PASS  1  找到本机 FlClash 配置
PASS  2  识别出 rule-provider 绝对路径  (共 44 条，新拷 44)
PASS  2b 绝对路径已全部改为相对路径  (残留 0 处)
PASS  2c 相对路径已写入  (44/44)
PASS  2d 规则文件已拷贝到位
PASS  3  取到最新内核版本  (v1.19.32)
PASS  3b 内核下载并解压成功  (61MB)
PASS  4  内核启动成功  (pid=8524 564ms)
PASS  4b 端口已监听  (port=7891)
PASS  5  能连上代理端口
PASS  5b 走内核代理能出国（CONNECT 隧道）  (HTTP 200 ip=42.200.172.28)
PASS  6  内核 PID 已记录  (pid=8524)
PASS  6b 空闲后已自动关闭  (pid=8524 alive=false)
PASS  6c 租约文件已清理
RESULT: 14/14 passed
```

## 免责声明

**这是作者自用的工具，请自行评估风险后再用。**

- 本软件按「原样」（AS IS）提供，**不附带任何明示或默示的担保**，包括但不限于
  适销性、特定用途适用性与不侵权担保。
- 作者**不对**因使用或无法使用本软件而产生的任何直接、间接、偶然、特殊或
  后果性损害承担责任。
- **代理内核、节点与订阅的来源及合法性由使用者自行负责。** 本插件只是把
  [mihomo](https://github.com/MetaCubeX/mihomo) 拉起来又关掉，它不提供、
  不内置、不分发任何节点或订阅。
- 请遵守你所在地的法律法规，以及你所使用服务的使用条款。
- 内核来自上游官方 Release，作者不对上游二进制的行为或安全性作任何保证。

## License

本插件自身代码：[MIT](LICENSE)

其中下载并调用的上游内核 [mihomo](https://github.com/MetaCubeX/mihomo)
版权归 MetaCubeX 及贡献者所有，以 **GPL-3.0** 授权 —— 详见 [LICENSE](LICENSE) 末尾说明。
