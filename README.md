# dsh-proxy-on-demand

> 需要时才拉起代理内核，用完自动关。平时不占端口、不留后台进程、不碰你的系统代理。
> 给 Agent 用的工具，不是给人用的客户端 —— 内核用 7899（避开 FlClash 的 7890），
> 本机已有代理在跑时直接借道，一个进程都不起。

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
| [`dsh-second-opinion`](https://github.com/xfgil/dsh-second-opinion) — 卡住时把问题交给另一个独立会话，要一份第二意见 |
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
- [借道已有代理](#借道已有代理)
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

`dsh-proxy-on-demand` 是一个 DeepSeek Harness（DSH）插件，给 Agent 一个**随叫随到、用完就走**的代理。

> **定位是「给 Agent 用的工具」，不是「给人用的客户端」。** 它没有托盘图标、不抢系统代理、不替你做「现在该不该上网」的决定。设置页存在，是因为你要往里填节点（订阅 / 从 FlClash 导入 / 手动粘贴）—— 填完就可以忘了它。

它把 [mihomo](https://github.com/MetaCubeX/mihomo)（Clash Meta 内核）包进插件里：

- **需要时自动拉起** —— 第一次要用的时候自己下载内核、准备配置、启动进程。
- **空闲后自动关闭** —— 默认 2 分钟没人用就杀掉内核、清掉状态文件。
- **不跟 FlClash 抢端口** —— 内核用 **7899**，故意避开 FlClash/Clash 系默认的 `7890`；管理 API 从 **19090** 起、DNS 从 **15353** 起，再各自找空闲端口（也避开了 FlClashCore 惯例的 `9090` 和它会占的 `1053`）。所以你那边 FlClash 该开就开，不受影响。
- **永不碰系统代理** —— 插件只把内核绑在 `127.0.0.1` 上，**一个字节都不写 Windows 系统代理注册表**。要不要让流量走代理，由你自己（`HTTP_PROXY`、或你自己的代理软件）决定。(2026-10-16 之前的版本会接管系统代理，那段逻辑已整个删除。)
- **本机已有代理就直接借道** —— 你已经开着 FlClash 之类的时候，插件复用它的出口，自己**一个进程都不起**（见[借道已有代理](#借道已有代理)）。
- **自带节点面板** —— 内核是自己起的时候，可以在设置页列分组、列节点、切节点（切完**回读确认**）、一键测延迟。

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

在 DSH 里，Agent 需要抓墙外内容时直接调 `POST /dsh-proxy/fetch`，插件会顺手准备出口（本机已有代理就借道，否则起内核）、抓完续一次租约，用完自己关。

**它已经不是「一个给你用的软件」了。** 2026-10-16 做过一次大改造，删掉了三块「客户端」性质的东西：

| 删掉的 | 为什么 |
|---|---|
| **Windows 系统代理接管** | 那是**全局**影响，一个按需拉起的内核不该顺手改你的网络环境；而且它正是「插件一起来，FlClash 内核就起不来」的一部分原因（抢端口之外还抢系统代理）。现在插件**一个字节都不写注册表**。 |
| **游戏检测** | 需要编译并常驻一个 C# 探测进程、维护白名单，只为回答「现在该不该用代理」—— 这个判断应该是你的，不是插件的。 |
| **礼让（别的代理在跑就不启动）** | 方向错了：用户要的是「插件能用**且**别碍着 FlClash」，而不是「二者只能活一个」。改成反向的[借道](#借道已有代理)。 |

留下的是：HTTP 接口、CLI、内核按需起停，以及**配置来源那一小块设置页**（订阅 / 从 FlClash 导入 / 手动粘贴）—— 没有它你就没法往里填节点。

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
dsh-proxy status                     # 看状态（含出口端口、有没有在借道）
dsh-proxy prepare                    # 下载内核 + 准备配置（顺手把 7890 / 1053 挪开）
dsh-proxy import-flclash             # 从本机 FlClash 导入配置
dsh-proxy peers                      # 看本机有没有可借道的代理
dsh-proxy start                      # 启动内核（或借道），守着直到空闲自动关
dsh-proxy stop                       # 立刻关掉（只关自己起的）
dsh-proxy -- <命令> [参数...]         # 带着代理跑一条命令
```

`status` 长这样（本机 FlClash 开着的时候）：

```
运行时目录 : D:\Plugins\dsh-proxy-on-demand\runtime
端口       : 7899
空闲自动关 : 120 秒
内核状态   : 未运行
剩余计时   : -
借道探测   : 可以借 127.0.0.1:7890（自己的内核不必起）
配置       : 143 个节点，482 条规则
```

`端口` 是**插件自己内核**的端口，`借道探测` 是「真要用的时候能不能借到」。
`status` **只探端口、不起内核**（约 2ms）—— 看一眼状态不该顺手拉起一个进程。
内核真跑起来时还会多一行 `出口端口`，那才是 `-- <cmd>` 实际会用到的那个。

常用的是最后一种：

```bash
dsh-proxy -- git clone https://github.com/some/repo
dsh-proxy --idle 0 -- curl.exe -sS https://api.ipify.org    # 跑完立刻关
dsh-proxy --idle 600 -- npm install                          # 空闲 10 分钟才关
dsh-proxy --no-borrow -- curl.exe -sS https://api.ipify.org   # 不用本机已有的代理，坚持起自己的内核
```

它给子进程注入：

| 变量 | 值 |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | `http://127.0.0.1:<出口端口>` |
| `NO_PROXY` | `localhost,127.0.0.1,::1,192.168.*,10.*,172.16.*` |

`NO_PROXY` 很重要 —— 否则连本机服务（比如 DSH 自己的 19387）也会被绕进代理。

注意出口端口是**运行期现算的**：本机已有代理在跑时它是借来的那个端口（多半是 7890），否则才是插件自己的 7899。CLI 不会想当然用设置里的端口 —— 那会指向一个没人监听的端口。

## 设置界面

装上插件后，**设置**侧栏里会多出一页「按需代理」，从上到下是：

**状态** — 一眼看内核在不在跑，旁边一枚**代理内核**开关：

| 显示 | 含义 |
|---|---|
| `内核运行中` | 插件自己起的 mihomo 正在跑，显示 PID 与出口端口，非常驻时还显示「距离自动关还剩几秒」 |
| `端口被占用` | 7899 上已经有别的程序在听 —— 插件不起内核，直接用那个（见[借道已有代理](#借道已有代理)） |
| `内核未运行` | 还没起过，下次用到会自动拉起。**本机已有代理在跑时也是这个 badge** —— 状态行里会写明「未启动（借道中）」并给出实际出口端口 |

借道时开关会**置灰**：不需要启动自己的内核，点了也没意义。借道情况下也不显示倒计时 —— 那个内核不是我们的，它的寿命我们既不知道也不该管。每 4 秒自动刷新。

**节点配置** — 三种填节点的方式：

| 方式 | 说明 |
|---|---|
| 订阅地址 | 粘贴后点「拉取订阅」，插件下载并改写成相对路径 |
| 从 FlClash 导入 | 读本机 FlClash 的 `config.yaml`，自动把规则文件的绝对路径改成相对路径 |
| 手动粘贴 | 直接贴一份 Clash/mihomo YAML |

**节点面板** — 内核在跑时列出当前分组里的节点，每行左名右延迟，`●` 标出正在用的那个。顶部一个**测延迟**按钮触发整组测速；列表**单页固定 8 行**、超出滚动。

这里刻意**没有分组下拉框**：分组全平铺在滚动列表里，你自己滚。测速也是**只留「测延迟」一种**——「测连通性」因为实测只有极少数节点能通过（那次只有香港），判据价值低、又容易被误读成「网络坏了」，已经删掉。

测速目标是**分组自己配的 `url:`**（通常机场给的是 `gstatic/generate_204`）；分组没配（多数**手选分组**都没配）就回落到一个国内可达的 `generate_204`。插件**不替你改写配置文件**里的目标 —— 见[已知限制](#已知限制)里那段被推翻的误判，以及下面这条更要紧的实现细节。

> **为什么不能让内核「用分组自己的 url」就完事？** 2026-10-14 查明：mihomo 的 **Selector 分组没有重写 `URLTest()`**，不带 `url` 参数调延迟接口时它把空串原样传下去 → `urlToMetadata("")` 判 "scheme not Support" → 组里**每个成员都失败**，接口 4ms 内回 `504 all proxies timeout`。而面板点「测延迟」操作的正是第一个 Selector。所以现在**由插件自己解析目标并始终带上**：分组有自己的 `testUrl` 就用它，没有就用兜底的 `generate_204`。自动组（URLTest/Fallback/LoadBalance）会忽略传进来的 url、仍用自己的，因此这样做对它们无害。

> **借道时节点面板用不了，这是正常的。** 列节点、切节点全走 mihomo 的管理 API，而管理 API 的地址与 secret 是插件给自己内核配的；借来的那个内核是别人的，secret 不同、地址也不同。这种时候插件会老老实实说「借道中」，不会假装能切。

**参数** — 代理端口、空闲多久自动关（秒）、启用插件、首次是否自动导入 FlClash 配置、内核常驻。改完立即生效。

> 端口默认 **7899**，故意不是 7890 —— 那是 FlClash / Clash 系的默认端口，撞在一起会把对方的内核顶掉。端口改动需要重启内核才生效：把「代理内核」开关关掉再打开。

界面**不走 DSH 的 settings 服务**，而是直接读写信件文件 + 自己的 HTTP 端点。原因见[实现说明](#实现说明)。

## 借道已有代理

如果你机器上已经有别的代理在跑（FlClash、Clash Verge、v2rayN……），本插件**直接借道它的出口**，自己**一个进程都不起**、不抢端口、不碰你的设置。别的代理退出后，插件下次要用时才自己起内核。

> **这里 2026-10-16 改过语义，以前是反的。** 老版本叫「礼让」：检测到别的代理在跑就**拒绝启动**，宁可没有代理。那是个错误的方向 —— 用户报的现象是「我代理的时候 fl 内核连不上」：插件占着 `7890`，FlClash 的内核反而起不来。礼让只管「别人占了我就不起」，管不了反方向。现在换成借道：别人在跑就用别人的，没人跑才自己起（端口 7899，与所有常见代理端口都不同）。结果是两边永远不会抢，而且大部分时候插件连进程都不用起。

### 只看端口，不认软件

判据只有一条：**常见代理端口有没有人在监听**。

| | |
|---|---|
| 探的端口 | 18 个：`7890-7893`（Clash/mihomo）、`7897/7898`（Clash Verge Rev）、`10808-10810`（v2rayN/xray）、`1080/1081`（SOCKS 惯例）、`2080/2081`（sing-box）、`20171/20172`（Clash Verge 旧版）、`8889`（Clash for Windows）、`8118`（privoxy）、`9910` |
| 成本 | 并发探完约 **2–3ms**（loopback 上的连接拒绝是瞬时的） |
| 优先级 | **按名单顺序**，不按端口号排序 —— `7890` 排第一，也就是「FlClash 优先」 |

为什么不看进程名：换成任何代理软件都自动适用，不需要维护「谁是代理」的名单，也不会因为某个软件不在名单里而漏判。代价是覆盖不到两种情况 —— 代理软件开着但还没开始监听端口，以及 TUN 模式不监听端口。这两种情况下插件会照常起自己的内核（借道没借到），但**不会**去动对方。

借道结果有 **3 秒缓存**：一轮里连续几次抓取只会探一次端口。探端口用 `net.createConnection`，不起外部进程 —— 后者（`netstat` 之类）单次要 100–300ms，而这里并发探 18 个端口总共 1–2ms。

### 必须排除自己的内核

上表**不含 `7899`** —— 那是本插件自己的端口。这不是小事：如果把它列进候选，在「自己的内核刚被杀、端口还没被系统释放」那一瞬间，插件会**把自己借给自己**，然后发现出口其实不存在。

所以名单里坚决不写自己的端口，而不是靠「判断这个监听是不是我」来绕 —— 后者在端口复用的情况下并不可靠。

### 端口被占时复用

借道只在**准备自己起内核**时才发生。走一遍 `ensureRunning()`：

```
自己的内核已经在跑？──────是──> 续租返回（不探测、不动任何东西）
        │否
找得到可借道的代理？──────是──> 记下出口端口，本插件不起内核
        │否
自己的 7899 被别人占着？──是──> 就用它（同样不起内核）
        │否
   才 core.start() 起自己的内核
```

借道时**不写租约**：那个内核是别人家的，我们没资格替它改寿命。空闲守护也会跳过 —— 别人的进程不归我们关。

### 命令行

```bash
dsh-proxy peers              # 看借道检测结果：哪个端口可以借、判定用时
dsh-proxy peers --json       # 同样的东西，JSON 形式
dsh-proxy --no-borrow -- cmd # 本次不用别人的，坚持起自己的内核
```

借道是**正常状态**，不是错误：这时候没有退出码、也不会被拦。以前那套「被礼让闸门拦下 → 退出码 4」已经删除。

## 配置

插件自己的设置存在 `<插件>/runtime/settings.state`：

```json
{
  "enabled": true,
  "port": 7899,
  "idleMs": 120000,
  "subscriptionUrl": "",
  "autoImportFlClash": true,
  "configSource": "flclash",
  "lastSyncAt": 1760000000000,
  "lastSyncNote": "已从 FlClash 导入（143 个节点 / 482 条规则）",
  "resident": false
}
```

`port` 默认 **`7899`**，故意不是 7890（见[借道已有代理](#借道已有代理)）。

`resident` 默认 **`false`** —— 也就是本插件原本的行为「**用完了自己关掉**」，把它打开才是常驻（不因空闲自动关闭，随 DSH 一起退出）。

> **2026-10-16 删掉了五个键**：`systemProxy`（接管系统代理的开关，整段逻辑也没了）、`blockOnGame` / `stopOnGame` / `gameAllow`（游戏检测）、`yieldToPeer`（礼让）。现在插件**永不写系统代理注册表**，也**不评判别的代理软件** —— 读设置时按白名单过滤，这些旧键留在文件里也不会被读进来。以前那套「系统代理只由面板开关控制、内核停时精确还原」的设计（连同一个删掉的 `proxyOnStart`）一并作废：**不碰就是真正的还原**。

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
| `core.log` | 内核日志 |

> **为什么状态文件是 `.state` 而不是 `.json`？**
>
> 宿主会盯着插件目录，而它的插件监视器**只看 `.json`**（2026-10-14 用 21 种扩展名实测的矩阵：`.state`/`.log`/`.txt`/`.dat`/`.lock`/`.yaml`/`.pid`… 全都不触发，**只有 `.json` 触发**，子目录里的 `.json` 同样触发）。一触发就是一次完整的热重载：**先 dispose 旧实例，再 apply 新实例**。
>
> 所以只要状态文件叫 `.json`，每写一次盘就重建一次插件。这条约定是被一次真事故逼出来的：老版本的「开系统代理」会写一份 `proxy-backup.json`，而那一次写盘正好触发热重载 —— 新实例接手时旧实例改注册表还没跑完，于是新实例判定「系统代理不是我们的」、把刚写的备份删掉；注册表随后才生效，结果是**代理开着、备份没了、再也关不掉**。
>
> 换成 `.state` 之后热重载**根本不会发生**，这条竞态从根上消失，而不是靠补丁躲过去。接管系统代理那段代码 2026-10-16 已经删掉了，但**这条约定继续有效** —— 同样一次重载也会让刚写进去的 `settings.state` 被另一个实例读走一半。旧版本留下的 `.json` 会在启动时自动迁移（`migrateStateFiles()`），迁移完就删掉 —— 留着它仍会继续触发热重载。

## HTTP 接口

全部只监听 **loopback**（`127.0.0.1` / `::1`），非本机请求返回 403。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-proxy/status` | 状态：内核是否在跑、PID、**出口端口 `exitPort`、是否借道 `borrowed`**、剩余秒数 |
| GET | `/dsh-proxy/settings` | 读设置 + 当前配置概况 |
| POST | `/dsh-proxy/settings` | 写设置 |
| GET | `/dsh-proxy/proxies` | 列出分组与节点（加 `?fake=1` 连信息伪节点一起列） |
| POST | `/dsh-proxy/proxies/select` | `{"group":"...","node":"..."}` 切换节点，**回读确认** |
| POST | `/dsh-proxy/proxies/test` | `{"group":"...","timeoutMs":3000}` 测延迟 |
| POST | `/dsh-proxy/proxies/connectivity` | `{"node":"..."}` 或 `{"nodes":[...]}` 真的以该节点为出口发一次请求（**只有接口，界面上没有按钮** —— 判据价值低、容易误读成「网络坏了」） |
| POST | `/dsh-proxy/prepare` | 下载内核 + 准备配置 |
| POST | `/dsh-proxy/start` | 启动内核（本机已有代理时改为借道，返回里带 `borrowed: true`） |
| POST | `/dsh-proxy/stop` | 关闭内核（只关自己起的，借来的不动） |
| POST | `/dsh-proxy/renew` | 续期空闲计时 |
| POST | `/dsh-proxy/config/from-subscription` | `{"url":"..."}` 拉订阅 |
| POST | `/dsh-proxy/config/import-flclash` | 从本机 FlClash 导入 |
| POST | `/dsh-proxy/config/manual` | `{"text":"..."}` 手动写配置 |
| GET | `/dsh-proxy/config/example` | 取一份模板 |
| POST | `/dsh-proxy/fetch` | `{"url":"https://..."}` 经代理抓一次 |
| GET | `/dsh-proxy/peers` | 借道检测状态（加 `?force=1` 绕过缓存） |
| POST | `/dsh-proxy/peers/clear-cache` | 借道检测缓存失效，强制重新探测 |

**没有系统代理端点，也没有游戏端点** —— 那两类能力 2026-10-16 已整个删除。所有端点都只在 loopback 上监听，且不再有「被拦下 → 409」这条路径：借道是正常状态，最坏情况也只是自己多起一个内核，代理始终可用。请求出错时统一回 500。

> **`/fetch` 必须用 `exitPort()`，不是设置里的端口。** 借道时出口是**借来的**那个（多半是 7890），照设置里的 7899 发请求会打到一个没人监听的端口上。返回体里带着 `via`（实际用的 `127.0.0.1:<端口>`）与 `borrowed`（这一发是不是走的别人的代理），排查时看这两个字段。

> **`/fetch` 会带上 `User-Agent`。** 2026-10-14 修的一个真缺陷：它的两个分支原先
> **一个请求头都不带**，于是 GitHub 的 REST API 一律回 **403**
> （`Request forbidden by administrative rules. Please make sure your request has
> a User-Agent header.`）—— **不是限流**：同一个 URL、同一个代理端口，换
> `Invoke-WebRequest` 走一遍就是 200（`x-ratelimit-remaining: 58`）。GitHub 对
> **所有** REST 请求强制要求 UA，而 `/fetch` 最常见的用途恰恰就是抓
> `api.github.com`（上面命令行示例就是它）。现在两个分支都带
> `dsh-proxy-on-demand (+https://github.com/xfgil/dsh-proxy-on-demand)`。

## 它是怎么做到的

### 空闲自动关：租约 + 守护

```
任何一次使用 ──renew()──> 写 lease.state { deadline: now + idleMs }
                              │
守护定时器（每 15s）───────────┘
   走的是借道？──是──> 直接返回（不写租约、也永不「关」别人的内核）
        │否
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
2. **端口被占时不抢。** 如果自己的端口已经被别的程序监听（比如正好是 FlClash 占了 7899），插件不启动内核，只标记一下后照常可用，也**不会**在空闲时去关那个不属于自己的进程。更常见的情况是[借道](#借道已有代理)：别人的代理在 7890 上跑着，插件连自己的端口都不碰。
3. **长命令期间持忙锁。** `dsh-proxy -- <命令>` 跑起来时会写 `busy.state`（内容是自己的 PID）并持续续租。只要锁在，`checkIdle()` 一律不动内核 —— 否则一条比 `idleMs` 更久的命令（比如 `npm install`、`git clone`）会在跑到一半时被自己的守护掐断，表现为 `ConnectionReset`。持有者进程若已消失，锁按 PID 自动失效，不会永久卡住。
4. **命令行守到最后。** 守护定时器是 `unref()` 的（不阻止 Node 退出）。所以 `dsh-proxy start` 与 `dsh-proxy -- <命令>` 都会一直守着，直到内核真的被自动关掉才返回 —— 否则命令一跑完就退出，没人执行「到期杀内核」那一步，内核会一直挂着，正是本插件要消灭的情况。（借道时不守：没有自己的内核要守，也没人需要关，`dsh-proxy start` 打完一行提示就直接返回。）

### 借道插在哪

借道探测只在**起核路径**上跑，不影响已在运行的内核：

```
POST /start ─┐
POST /fetch ─┼─> ensureAndStart() ─> core.ensureRunning()
CLI -- cmd  ─┘                            │
                                       自己的内核已在跑？──是──> 续租返回（不探测）
                                            │否
                                       找到可借道的代理？──是──> 用它的出口，本插件不起内核
                                            │否
                                       自己的端口被别人占？──是──> 就用它，同样不起内核
                                            │否
                                       core.start()  ← 唯一的起核分支
```

借道判定用**闭包回调**注入 `core`，不是让 `core.js` 直接 `import peers.js` —— 这样 `core.js` 只管进程生命周期，探测规则留在上层，也能被单独测试：

```js
// lib/index.js：宿主侧直接借，交给 core 决定什么时候问
const borrowFn = async ({ ownPort } = {}) => findBorrowableProxy({
  ownPort: Number.isInteger(ownPort) ? ownPort : user.port,
});

// bin/dsh-proxy.mjs：命令行多一层开关（--no-borrow 干脆传 null 把这条路径关掉）
const borrowPort = opts.noBorrow ? null : ({ ownAlive } = {}) => findBorrowableProxy({
  ownPort: port,
  force: ownAlive !== true,
});
```

`ownPort` 必须由 `core` 现算再传下去 —— 上层（`index.js`）拿不到「这个端口上的监听是不是我自己」这个判断依据。探测失败时回调返回 `null`，`core` 就当「没人可借」自己起内核：**宁可多起一个内核，也不要因为探测代码出问题就让代理彻底不可用**。

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
- **自己的端口（默认 7899）被占时不自启。** 这是刻意的：宁可复用那个已经开着的代理，也不去抢端口。
- **借道时节点面板与切节点不可用。** 列节点、切节点走的是 mihomo 管理 API，而借来的内核是别人的，controller 地址与 secret 都对不上。这时候界面会显示「借道中」并置灰内核开关，不会假装能操作。想切节点就先让别的代理退掉，或者用 `--no-borrow` 让插件起自己的内核。
- **借道检测只看端口，不看软件身份。** 这是刻意的（见[借道已有代理](#借道已有代理)）。覆盖不到「代理软件开着但还没监听端口」和「TUN 模式不监听端口」两种情况；这种情况下插件会照常起自己那个 7899 的内核（借道没借到），代价是多一个进程，**不会**去动对方。
- **`settings.state` 与 `config.yaml` 分开存。** 换订阅不会丢你的开关和端口设置，但反过来，手动改 `config.yaml` 不会同步进界面显示的「节点数」以外的字段。
- **只测过 Windows 10/11 x64 + DSH 0.2.0-rc.2。**
- **不再有任何「让路」逻辑。** 打游戏时、别的代理在跑时，插件都不会拒绝工作 —— 最坏情况是自己多起一个内核。以前那套「检测到游戏 / 别的代理就不启动，CLI 退出码 3 或 4」2026-10-16 已整个删除。判断「现在该不该用代理」还给你自己。
- **永不改系统代理（2026-10-16 起）。** 面板上没有系统代理开关，插件也不写注册表 —— 连备份/还原那套逻辑都删了，因为「不碰」本身就是最彻底的还原。要让流量走代理，请自己设 `HTTP_PROXY`，或者用你自己的代理客户端。

### 一个被推翻的误判：测速目标

2026-10-13 我曾在配置导入路径上做了一件事：把分组里的测速地址 `url: https://www.gstatic.com/generate_204` 全换成国内的 `connect.rom.miui.com`，理由是「gstatic 在国内被墙 → 面板满屏超时」。

**这条因果链是错的，改动已回退。** 内核测速是**经由节点**发出去的请求，走节点所在地的出口，和「本机能不能直连 gstatic」毫无关系。同一批节点、只换测速目标的对照实验（3 个自动组 × 4 成员 = 12 样本，测完回读面板读的顶层 `history`，统计拿到有效延迟的成员数）：

| 测速目标 | 有效 |
|---|---|
| 不传（内核用分组自己的目标） | **11/12 = 92%** |
| 显式传分组自己的 `testUrl` | 10/12 = 83% |
| 改传 miui | 10/12 = 83% |

三者基本等价，所以**没有任何理由去改写用户的测速目标**。「全超时」的真病根是 **DNS 端口冲突**（FlClash 占着 `1053`，内核 DNS 起不来 → 域名解析不了 → 全部超时），由 `forceDnsPort()` 自动换端口解决，与测速目标无关。

不过上面那 12 个样本用的是**自动组**（URLTest/Fallback/LoadBalance 这些会自己重写 `URLTest()`、用自己的 `url:`），所以「传不传 url 等价」这个结论**对它们成立、对 Selector 不成立**。面板点「测延迟」操作的是第一个 **Selector**，而 Selector 不重写 `URLTest()` —— 不带 url 时它把空串传下去，成员逐个失败，接口直接 `504 all proxies timeout`。这就是当天你看到的「点测延迟全部超时」。修法是 `testGroupDelay()` **自己解析目标并始终带上**（分组有 `testUrl` 就用它，否则回落 `DEFAULT_TEST_URL`），**依然不改写配置文件里的任何一行**。

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

**借道判定不做系统调用。** 探测端口用 `net.createConnection`，不是 `netstat` —— 后者要起一个外部进程，单次 100–300ms；这里是纯 loopback 连接尝试，并发探完 18 个端口总共 1–2ms。代价是只能知道「有没有人在听」，不知道是谁在听 —— 而这正是设计要的（见[借道已有代理](#借道已有代理)：不看软件身份）。

## 开发

```bash
node --check lib/index.js          # 语法检查
node test/peers-test.mjs           # 借道判定规则（离线，21 项，纯函数喂构造数据）
node test/client-render-test.mjs   # 客户端界面渲染（离线，44 项，不需要内核）
node test/dl-test.mjs              # 只测内核下载（快）
node test/busy-test.mjs            # 忙锁回归：命令比 idleMs 更久时内核必须活着
node test/selftest.mjs             # 端到端：导入配置 → 下内核 → 启动 → 出国 → 空闲自关
```

`test/peers-test.mjs` 之所以能完全离线，是因为判定核心 `evaluateBorrow()` 被刻意抽成了**纯函数** —— 吃构造的端口探测结果、吐「借哪个」，不碰真实网络。所以「候选里绝不能出现本插件自己的端口」（否则自己的内核刚被杀、端口还没释放时它会把自己借给自己）、「名单顺序即优先级」、「名单里不含 9090（那是 Clash 系控制器的惯例端口，不是代理端口）」这些关键分支能精确覆盖，不需要真去起一个假代理。

`test/client-render-test.mjs` 用一个最小 React 替身把 `lib/client.js` 的组件
在「数据未到位 / 数据到位 / 出错」三种状态下各渲染一遍，**不联网、不下内核**。
它抓的是两类静默失败：注册到不存在的 slot（宿主不报错，界面只是不出现）、
以及 `settings.state` 被手工改坏后渲染期抛异常（`subscriptionUrl: null` 会让
`subInput.trim()` 抛 `Cannot read properties of null`）。输入数据用的是宿主
`/dsh-proxy/status` 与 `/settings` 的实测返回形状。
2026-10-16 改造后它多了几条**反向断言**：系统代理整块已删除、游戏检测整块已删除、
礼让整块已删除、端口说明写的是 7899 而不是 7890、配置来源三路都还在、
以及借道状态下开关置灰且不显示倒计时。

`test/busy-test.mjs` 针对一个真实踩过的坑：`--idle 3` 配一条要跑 10 秒的命令，
修复前守护会在第 3 秒杀掉内核、命令最后一步报 `ConnectionReset`。现在 6 项全过
（命令拿到出口 IP、内核按策略自动关、忙锁已释放）。

`test/selftest.mjs` 用**本机真实的 FlClash 配置**跑全链路，60 项检查：

```
PASS  0a 内置模板的默认端口是 7899 而不是 7890  (mixed-port: 7899)
PASS  0b 内置模板不含 7890
PASS  0c DNS 起始端口不再是 1053  (listen: 127.0.0.1:15353)
PASS  0c2 onlyIfPorts：安全端口不被无谓重挑  (changed=false)
PASS  0c3 onlyIfPorts：命中 1053 时照样修  (port=15353)
PASS  0d ★ 导入配置里的 7890 被换成 7899  (changed=true from=7890)
PASS  0e 已经是目标端口时不重复改（幂等）
PASS  0f 没有 mixed-port 时不瞎插一行
PASS  0g mixed-port: 0 保持不动（不替用户打开监听面）
PASS  0h 只有 port: 时也能换（老式写法）
PASS  0i ★ 旧设置文件里的 port: 7890 被迁到 7899  (port=7899)
PASS  1 找到本机 FlClash 配置  (C:\Users\<user>\AppData\Roaming\com.follow\clash\config.yaml)
PASS  2 识别出 rule-provider 绝对路径  (共 44 条，新拷 44)
PASS  2b 绝对路径已全部改为相对路径  (残留 0 处)
PASS  3 复用已缓存的内核（不联网）  (61MB)
PASS  4 内核启动成功  (pid=4016 515ms)
PASS  4b 端口已监听  (port=7899)
PASS  4c ★ 内核没有占 7890（FlClash 的默认端口）  (mixed-port=7899)
PASS  4d ★ DNS 没有占 1053（FlClashCore 的端口）  (listen: 127.0.0.1:15353)
PASS  5 能连上代理端口
PASS  5b 走内核代理能出国（CONNECT 隧道）  (HTTP 200 ip=42.200.172.28)
PASS  5b2 /fetch 带 User-Agent（GitHub API 不再 403）  (HTTP 200 Avoid administrative distraction.)
PASS  5c 内核在跑时能读到节点  (140 个节点 / 29 个分组)
PASS  5m 整组测延迟（不传 url）不再全部失败  (办公协作 ← http://connect.rom.miui.com/generate_204（4026ms）)
PASS  6 内核 PID 已记录  (pid=4016)
PASS  6b 空闲后已自动关闭  (pid=4016 alive=false)
PASS  6c 租约文件已清理
RESULT: 60/60 passed
```

（上面只摘了关键的二十几条，实际 60 条。自测用的 controller 端口是 19099、代理端口是
7899 —— 用真实 FlClash 的配置跑，同时还检查内核**没有**占用 7890 和 1053。）

> **0d / 0i 这两条是端口隔离能不能真正落地的地方。** 光把默认值从 7890 改成 7899
> 是不够的 —— **每个老用户的 `settings.state` 和 `config.yaml` 里都存着 7890**。
> 所以升级路径必须**主动改写**：`forceMixedPort()` 把导入/订阅/手贴配置里的
> `mixed-port: 7890` 换成 7899，`readSettings()` 把存量设置里的 `7890` 迁到 7899。
> 没有这两步，老用户升上来照旧会和 FlClash 抢端口。
>
> **DNS 是同一条道理，而且更隐蔽。** 存量配置里的 `dns.listen` 停在 `1053`
> （FlClashCore 占着）时，内核端口照样在听、命令照样能跑 —— 但 DNS 起不来，
> 什么都解析不了，**表现成「所有节点测速超时」**。所以 `dsh-proxy prepare` 与
> 宿主的 `ensureControllerInConfig()` 都会用
> `forceDnsPort(text, 15353, { onlyIfPorts: [1053] })` 就地修一次：**只动 1053
> 这个危险值**，上次已经挑好的安全端口（比如 1055）不重挑 —— 否则每次启动都
> 写盘一次、日志刷一行，纯属噪音。`0c2` / `0c3` 就是钉住这个「只修危险值」
> 语义的两条断言。

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
