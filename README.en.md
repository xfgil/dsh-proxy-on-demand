# dsh-proxy-on-demand

> A proxy that starts when you need it and shuts itself down when you're done. No port held, no background process left behind.

English | [中文](README.md)

![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6EF5)
![License](https://img.shields.io/badge/license-MIT-green)
![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

| | |
|---|---|
| **`dsh-proxy-on-demand`** — on-demand proxy, auto-shutdown (this repo) |
| [`dsh-hot-reloader`](https://github.com/xfgil/dsh-hot-reloader) — edit plugin source without restarting |
| [`dsh-session-clock`](https://github.com/xfgil/dsh-session-clock) — per-session clock and idle gaps |
| [`dsh-second-opinion`](https://github.com/xfgil/dsh-second-opinion) — hand a stuck problem to another session for a second opinion |
| [`dsh-onebot-companion`](https://github.com/xfgil/dsh-onebot-companion) — QQ channel all-in-one: outbound gate, rules, rhythm, persona, voice |

> [!IMPORTANT]
> **The first run downloads the kernel automatically.** This plugin ships **no**
> kernel binary. On first use it fetches `mihomo-windows-amd64` (about **61 MB**)
> from the official [mihomo](https://github.com/MetaCubeX/mihomo) GitHub Release
> into the plugin's `runtime/` directory, and works offline afterwards.
> Nothing needs to be installed by hand; delete `runtime/` to remove it entirely —
> no leftovers anywhere on disk. Set `autoDownload: false` to opt out and supply
> your own kernel.

> [!WARNING]
> **A personal-use tool — assess the risk yourself.** Provided "AS IS", without
> warranty of any kind. You are responsible for the origin and legality of the
> kernel, nodes and subscriptions you use; comply with the laws of your
> jurisdiction and the terms of any service you use. The author accepts no
> liability for any direct or indirect consequences of using this software.

---

## Contents

- [What this is](#what-this-is)
- [The problem it actually solves](#the-problem-it-actually-solves)
- [Requirements](#requirements)
- [Install](#install)
- [Usage](#usage)
- [Settings UI](#settings-ui)
- [Borrowing an existing proxy](#borrowing-an-existing-proxy)
- [Configuration](#configuration)
- [HTTP API](#http-api)
- [How it works](#how-it-works)
- [Upstream](#upstream)
- [Known limitations](#known-limitations)
- [Implementation notes](#implementation-notes)
- [Development](#development)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## What this is

`dsh-proxy-on-demand` is a DeepSeek Harness (DSH) plugin that gives you a proxy
**on call**: there when you need it, gone when you don't.

It wraps [mihomo](https://github.com/MetaCubeX/mihomo) (the Clash.Meta core):

- **Starts on demand** — the first time you need it, it downloads the kernel,
  prepares a config and spawns the process.
- **Shuts down when idle** — after 2 minutes of no use by default, it kills the
  kernel and cleans up its state files.
- **Holds nothing in between** — no resident process, its own port is free, and it
  never fights with the Clash/FlClash you run yourself.
- **Never fights another proxy — it borrows it.** When FlClash or anything similar
  is already listening, the plugin sends its traffic **through that proxy** and
  starts no process of its own (see
  [Borrowing an existing proxy](#borrowing-an-existing-proxy)). Its own port is
  **7899**, not the 7890 every Clash-family client defaults to, so starting it can
  never take the port out from under your own client. The management API starts
  looking at **19090** and DNS at **15353**, each then picking a free port — also
  clear of FlClashCore's habitual `9090` and the `1053` it holds.
- **Never touches your Windows proxy settings.** There is no system-proxy switch and
  no registry write anywhere in the plugin: the kernel binds `127.0.0.1` only, and
  traffic reaches it solely through `HTTP_PROXY` handed to a child process. Your
  network environment is yours to configure.
- **A node panel is built in** — no need to open another client: list groups,
  list nodes, switch nodes (with a read-back confirmation), test latency in one click.

## The problem it actually solves

Anyone using a Clash-family client (Clash Verge, FlClash, ClashX…) knows this loop:

```
need a proxy for a second → open the client → wait for it to start the core and pull the subscription
→ done → forget to quit → it sits in the tray forever, holding 7890, with the system proxy on
```

For **scripts, CI, scrapers, the occasional cross-border fetch**, that model is
backwards: the proxy is needed for a few seconds but you keep a resident process
alive the whole time.

This plugin inverts the model: **the proxy is a call frame, not a service.**

```bash
dsh-proxy -- curl.exe -sS https://api.github.com/repos/MetaCubeX/mihomo
# kernel starts on demand → command runs → kernel exits after the idle timeout
```

Inside DSH, when the agent needs to fetch something unreachable directly, it calls
`POST /dsh-proxy/fetch`; the plugin starts the kernel, fetches, renews the lease,
and lets it shut itself down.

### Why not reuse FlClash's core

FlClash's bundled `FlClashCore.exe` **is not stock mihomo** — it's an IPC slave
process for the GUI. Its `main()` looks like this:

```go
func main() {
    args := os.Args
    if len(args) <= 1 { os.Exit(1) }
    go exitOnTermination()
    startServer(args[1])   // args[1] is a pipe name
}

func startServer(arg string) {
    dialed, err := dial(arg)   // panics if it can't connect
    if err != nil { panic(err.Error()) }
}
```

All configuration is pushed over IPC by the UI, so it **cannot run without the
GUI** (measured: `FlClashCore.exe -v` panics with `dial unix -v`, because it
treats `-v` as the pipe name). That's why this plugin uses the upstream kernel.

## Requirements

- Node.js **≥ 22**
- DeepSeek Harness **0.2.0-rc.2** (Electron 44.0.0) — the version this was built
  and verified against; required to run as a plugin. The CLI (`dsh-proxy`) works
  standalone, without the host.
- A Clash/mihomo config, from one of three sources:
  - a subscription URL
  - your local FlClash `config.yaml` (imported and path-corrected automatically)
  - pasted by hand

## Install

```bash
dsh plugin --profile <your-profile> add link:<absolute path to this directory>
```

For example:

```bash
dsh plugin --profile desktop add link:D:/path/to/plugins/dsh-proxy-on-demand
```

From npm (if you're using a published release):

```bash
dsh plugin --profile <your-profile> add dsh-proxy-on-demand
```

The profile manifest (`dsh.profile.bundles`) is updated for you.

> **⚠ For a plugin installed while the host is already running: editing the
> manifest is not enough — toggle this bundle off and on once.**
> The host does **not** auto-mount a bundle that appears mid-run; HMR only
> reconciles entries already present in the loader tree. Measured: manifest
> written, `node_modules` link created, yet the package was simply absent from
> `plugin_manager list_plugins` and its HTTP endpoint returned 404. Toggling it
> (`plugin_manager set_bundle {target, enabled:false}` then `enabled:true`; both
> return `{"changed":true,"application":"applied"}`) made the host endpoint return
> 200 immediately and registered the client UI into the slot tree. **No host
> restart was needed.**
>
> Conversely, if the plugin directory/link already existed **before** the host
> started, it is loaded at startup and this step is unnecessary.

> Installing by hand also works: add
> `"dsh-proxy-on-demand": "link:D:/path/to/plugins/dsh-proxy-on-demand"` to the profile's
> `package.json`, add `"dsh-proxy-on-demand"` to the `dsh.profile.bundles` array,
> then create a link to the plugin directory inside the profile's `node_modules`
> (`mklink /J` or a symlink — either works).

## Usage

### Inside DSH

Once installed, a page of its own — **Settings → On-demand proxy** — appears in
the Settings sidebar (not a card under Settings → Plugins; see below). The HTTP
API is also available:

```bash
curl -X POST http://127.0.0.1:19387/dsh-proxy/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://api.github.com/repos/MetaCubeX/mihomo/releases/latest"}'
```

### Command line

The plugin ships a `dsh-proxy` command that **does not need the host process**:

```bash
dsh-proxy status                     # show status (exit port, whether borrowing)
dsh-proxy prepare                    # download kernel + prepare config (also moves 7890 / 1053 out of the way)
dsh-proxy import-flclash             # import config from local FlClash
dsh-proxy peers                      # is there a proxy on this machine we can borrow?
dsh-proxy start                      # start kernel (or borrow); waits until it auto-shuts down
dsh-proxy stop                       # stop immediately (only what we started)
dsh-proxy -- <command> [args...]     # run one command through the proxy
```

`status` looks like this (with FlClash running on this machine). The field names
stay Chinese because this *is* the real output:

```
运行时目录 : D:\Plugins\dsh-proxy-on-demand\runtime
端口       : 7899
空闲自动关 : 120 秒
内核状态   : 未运行
剩余计时   : -
借道探测   : 可以借 127.0.0.1:7890（自己的内核不必起）
配置       : 143 个节点，482 条规则
```

Three things to read off it:

- `端口` is **our own kernel's** port, while `借道探测` answers a different
  question — "if we actually needed it right now, could we borrow one?"
- `status` **only probes ports; it never starts a kernel** (about 2ms). Looking at
  the status should not quietly spawn a process as a side effect.
- Once the plugin has actually acquired an exit — its own kernel running, or
  borrowing someone else's — one more line appears: `出口端口`, and *that* is the
  port `-- <cmd>` will really use.

The last form is the common one:

```bash
dsh-proxy -- git clone https://github.com/some/repo
dsh-proxy --idle 0 -- curl.exe -sS https://api.ipify.org    # shut down right after
dsh-proxy --idle 600 -- npm install                          # stay up for 10 idle minutes
dsh-proxy --no-borrow -- curl.exe -sS https://api.ipify.org  # insist on our own kernel
```

The CLI goes through the same borrow logic as everything else: if something is
already listening on a common proxy port, the command simply uses it and no kernel
is started.

It injects into the child process:

| Variable | Value |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | `http://127.0.0.1:<exit port>` |
| `NO_PROXY` | `localhost,127.0.0.1,::1,192.168.*,10.*,172.16.*` |

`NO_PROXY` matters — without it, even local services (like DSH's own 19387) would
be routed through the proxy.

Note "exit port" rather than "port": when borrowing, the port handed to the child is
**the other proxy's**, not our own. See
[Where the borrow hook sits](#where-the-borrow-hook-sits).

## Settings UI

After installing, the Settings sidebar gains an "On-demand proxy" page. From top
to bottom:

**Status** — one switch, plus a badge and a line of detail:

| Switch | On = | Off = |
|---|---|---|
| **Proxy kernel** | start mihomo (~0.5 s; the first run downloads the kernel) | stop the kernel (only if it's ours) |

The switch is deliberately alone. **The plugin is a tool for the agent, not a proxy
client for the user** — starting and stopping its own kernel is the only thing worth
a control; everything else happens on its own or is configured once below. Two
earlier generations of controls have been removed: the three big buttons (*start now*
/ *stop* / *renew the idle timer*), and the Windows-system-proxy switch with its
game-detection and peer-yielding sections below it.

Next to the switch you get the kernel PID and the **exit port**, and in non-resident
mode also "seconds left until auto-shutdown". Refreshes every 4 seconds.

The status line distinguishes the states that actually differ:

| Badge | Meaning |
|---|---|
| *kernel running* | our own mihomo is up on its own port |
| *port taken* | our own port is busy but **not** with our kernel — we reuse it and start nothing |
| *kernel stopped* | nothing of ours is running |

Below the badge there is always an **exit** line (`127.0.0.1:<exitPort>` — the port
traffic is actually sent to), and when the plugin is borrowing it adds: *"another
proxy is already running on this machine; the plugin borrows it, takes no port and
starts no process."* The kernel switch itself reads "borrowed" and is disabled —
there is nothing to start, the exit already exists. See
[Borrowing an existing proxy](#borrowing-an-existing-proxy).

**Node panel** — while a kernel is available, lists the nodes of the current group,
name on the left and delay on the right, with `●` marking the one in use. A
**Test delay** button at the top triggers a group-wide speed test; the list is a
**fixed 8 rows per page** and scrolls beyond that.

There is deliberately **no group dropdown**: groups all live in that one
scrolling list. Speed testing is **delay only** — the connectivity test was
dropped *from this panel* because in practice very few nodes passed it (only Hong
Kong did, that one time), so it had little diagnostic value and was easily misread
as "the network is broken". The endpoint behind it (`POST /proxies/connectivity`)
is still there for programmatic use — it is the panel's button that went away, not
the capability.

The test target is **whatever `url:` each group already configures** (usually
the provider's `gstatic/generate_204`); when a group configures none — most
**manual-select groups** don't — it falls back to a domestically reachable
`generate_204`. The plugin **never rewrites the target inside your config file** —
see the corrected misdiagnosis under [Known limitations](#known-limitations), plus
the more important implementation detail below.

> **Why can't we just let the kernel "use the group's own url"?** Established
> 2026-10-14: mihomo's **Selector does not override `URLTest()`**. When the delay
> endpoint is called without a `url`, it passes the empty string straight down →
> `urlToMetadata("")` says "scheme not Support" → **every member of the group fails**
> and the endpoint returns `504 all proxies timeout` within 4 ms. And the "test
> latency" button operates on the first Selector. So the plugin now **resolves the
> target itself and always passes it**: the group's own `testUrl` when it has one,
> otherwise the fallback `generate_204`. Automatic groups
> (URLTest/Fallback/LoadBalance) ignore the passed url and keep using their own, so
> this is harmless for them.

**Nodes** — three ways to supply a config:

| Method | What it does |
|---|---|
| Subscription URL | Paste and click *Fetch subscription*; the plugin downloads it and rewrites paths |
| Import from FlClash | Reads your local FlClash `config.yaml` and rewrites rule-provider absolute paths to relative ones |
| Paste manually | Drop in a Clash/mihomo YAML directly |

**Parameters** — proxy port, idle timeout (seconds), enable/disable the plugin,
auto-import FlClash on first run, and resident mode (never auto-shutdown). Changes
apply immediately.

> The default port is **7899**, deliberately not 7890 — that is the Clash-family
> default, and sharing it means the plugin's kernel can take 7890 first and lock
> your own FlClash out of it. And when another proxy is already running, this port
> isn't used at all (we borrow instead).

> A port change needs a kernel restart: flip the **Proxy kernel** switch off and
> back on.

The UI **does not go through DSH's `settings` service**; it reads and writes the
settings file and talks to the plugin's own HTTP endpoints. See
[Implementation notes](#implementation-notes) for why.

> **Nothing in this panel touches Windows.** There is no system-proxy switch, and no
> code path that writes the registry. What the plugin changes on your machine is
> exactly one thing: it may spawn a `mihomo.exe` process of its own, and it may kill
> **that** process (never anyone else's — see
> [Auto-shutdown: lease + guard](#auto-shutdown-lease-guard)).

## Borrowing an existing proxy

If a proxy is already running on your machine (FlClash, Clash Verge, v2rayN…), this
plugin **borrows it**: it points its exits at that proxy's port and starts no kernel
of its own — no port grabbed, no process spawned, your network environment left
alone. It recovers automatically once that other proxy exits.

> **This is the inverse of the old behaviour, and the inversion is the whole point.**
> The plugin used to *yield*: on seeing another proxy it refused to start, which in
> practice meant "the moment you open FlClash, this plugin stops working." The
> original request (2026-10-16) was *"I don't want it fighting with Fl"* — and
> borrowing is the best possible answer to that: there is nothing left to fight over,
> and most of the time not a single process needs to be started.

### Ports only, not software identity

There is exactly one criterion: **is anyone listening on a common proxy port**.

| | |
|---|---|
| Ports probed | 18: `7890-7893` (Clash/mihomo), `7897/7898` (Clash Verge Rev), `10808-10810` (v2rayN/xray), `1080/1081` (the usual SOCKS ports), `2080/2081` (sing-box), `20171/20172` (older Clash Verge), `8889` (Clash for Windows), `8118` (privoxy), `9910` |
| Cost | about **1–2ms** for the whole concurrent probe (a connection refused on loopback is instantaneous) |
| Pick order | whichever port answers first in the list above; extra ports supplied by the caller take priority |

Why not look at process names: this way it applies to any proxy software
automatically, needs no maintained list of "who counts as a proxy", and can't miss
one just because it isn't on the list. The price is two uncovered cases — proxy
software that is open but hasn't started listening on a port yet, and TUN mode,
which doesn't listen on a port at all. In those two cases this plugin starts its own
kernel as usual, which is the old behaviour rather than an error.

### The probe list must not contain our own port

This plugin listens on `port` itself (7899 by default). If that port were in the
common-port list, the plugin would find **itself** and happily "borrow" a kernel it
started — the worst case being the moment our own kernel is killed and the port
hasn't been released yet: the plugin would borrow a dead port and every request
would fail.

So **7899 is deliberately absent from the 18 ports**, and the probe additionally
always filters `p !== ownPort`. The two protections are independent on purpose —
the filter is code, the missing entry is data, and the test suite pins both
(`test/peers-test.mjs`, 21 checks).

### Reuse when our own port is taken

There is a second, separate case: our **own** port is busy but not with our kernel
(someone else took 7899, or a stale process holds it). Then `ensureRunning()`
simply marks the state `external` and reuses whatever is there — commands work as
usual and no process is started. This is a fallback, not the main path.

### Fails open

Same principle as everything else here: when probing errors out, let it through —
better to start one extra kernel than to have a bug in the probing code make the
proxy unusable for good. **There is no longer any path by which detection can refuse
to start the proxy.** Borrowing is not a gate; it is a source of exits.

### Command line

```bash
dsh-proxy peers              # show the detection result: which ports are taken, time taken
dsh-proxy peers --json       # the same, as JSON
dsh-proxy --no-borrow -- cmd # skip borrowing for this run, insist on our own kernel
```

Two exit codes are gone with the mechanisms behind them: **3** (blocked by a game)
and **4** (blocked by another proxy). Borrowing cannot block, so the only non-zero
code left is a plain **1** for a genuine failure.

Borrowing is a **normal state, not an error** — no exit code, nothing blocked. The
old behaviour ("stopped by the yielding gate → exit code 4") has been deleted along
with the gate itself.

## Configuration

The plugin's own settings live in `<plugin>/runtime/settings.state`:

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

That is the whole schema — **nine keys**. The three game-detection keys
(`blockOnGame` / `stopOnGame` / `gameAllow`), the old peer key (`yieldToPeer`) and the
system-proxy key (`systemProxy`) no longer exist anywhere in the code, together with
the mechanisms they configured. Unknown keys are discarded on read, so a stale
`settings.state` carrying them simply loses them.

`port` defaults to **7899**; `resident` defaults to **`false`** — i.e. the plugin's
original behaviour, **shut down when done**. Turn `resident` on for resident mode
(never auto-shutdown when idle; exits with DSH).

> **Old `7890` is migrated to `7899` on read.** Every existing user's
> `settings.state` has `7890` in it, because that was the old default, and the
> whitelist filter above would faithfully read it back — making the whole port
> isolation pointless and reproducing the original complaint ("the moment the plugin
> proxies, FlClash's kernel can't connect"). So a stored `7890` is rewritten to
> `7899` (`readSettings()` in `lib/settings.js`). If you genuinely typed `7890` by
> hand, it is migrated too — but that is precisely the value you want to avoid. The
> migration is idempotent and lands on disk with the next `writeSettings()`.

The `runtime/` directory (excluded by `.gitignore`) holds runtime artifacts:

| File | Purpose |
|---|---|
| `mihomo.exe` | the kernel (downloaded on first use) |
| `config.yaml` | the config handed to the kernel |
| `providers/rules/` | rule-provider files |
| `settings.state` | the user settings above |
| `core.pid` | PID of the current kernel (used only to kill our own) |
| `lease.state` | the lease — "in use until" |
| `busy.state` | the busy lock — "which long command is using it" (liveness by PID) |
| `core.log` | kernel log |

There is no `gameprobe.exe`, no `probe.js`, no `proxy-backup.state`. The plugin
compiles nothing, runs no helper process, and keeps no copy of your system settings.

> **Why are the state files `.state` and not `.json`?**
>
> The host watches the plugin directory, and its plugin watcher **only reacts to `.json`** (a 21-extension matrix measured on 2026-10-14: `.state`/`.log`/`.txt`/`.dat`/`.lock`/`.yaml`/`.pid`… none of them trigger, **only `.json` does** — including `.json` inside subdirectories). One trigger means a full hot reload: **the old instance is disposed first, then the new one is applied**.
>
> So as long as a state file is named `.json`, every write rebuilds the plugin. The nastiest chain was:
>
> 1. You flip a switch → the plugin writes `proxy-backup.json` (a backup of your original settings);
> 2. **That single write triggers a hot reload**;
> 3. The new instance reads the registry while the old instance's `powershell` call is still running (measured ~700ms) → it concludes "the system proxy is not ours" → it deletes the backup that was just written;
> 4. Only afterwards does the registry flip to "enabled" — **proxy on, backup gone**;
> 5. Now you can never turn it off: the disable path finds no backup and can only answer "we never changed it".
>
> Renaming to `.state` means the hot reload **never happens at all**, so the race disappears at its root rather than being dodged by a patch. Leftover `.json` files from older versions are migrated automatically on startup (`migrateStateFiles()`) and then deleted — keeping them around would keep triggering hot reloads.
>
> That whole chain is now historical: the plugin no longer writes `proxy-backup.*` at all, because it no longer touches the system proxy. The naming rule still stands for the files that remain.

## HTTP API

Everything listens on **loopback only** (`127.0.0.1` / `::1`); other origins get 403.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-proxy/status` | kernel running?, PID, **exit port**, borrowing?, seconds remaining |
| GET | `/dsh-proxy/settings` | read settings + current config summary |
| POST | `/dsh-proxy/settings` | write settings |
| GET | `/dsh-proxy/proxies` | list groups and nodes (add `?fake=1` to include the informational pseudo-nodes) |
| POST | `/dsh-proxy/proxies/select` | `{"group":"...","node":"..."}` — switch node, then **read back to confirm** |
| POST | `/dsh-proxy/proxies/test` | `{"group":"...","timeoutMs":3000}` — test delay |
| POST | `/dsh-proxy/proxies/connectivity` | `{"node":"..."\|"nodes":[...],"url"?}` — actually send one request through that node |
| POST | `/dsh-proxy/prepare` | download kernel + prepare config |
| POST | `/dsh-proxy/start` | start the kernel (or borrow) |
| POST | `/dsh-proxy/stop` | stop the kernel |
| POST | `/dsh-proxy/renew` | renew the idle timer |
| POST | `/dsh-proxy/config/from-subscription` | `{"url":"..."}` — fetch a subscription |
| POST | `/dsh-proxy/config/import-flclash` | import from local FlClash |
| POST | `/dsh-proxy/config/manual` | `{"text":"..."}` — write a config by hand |
| GET | `/dsh-proxy/config/example` | get a template |
| POST | `/dsh-proxy/fetch` | `{"url":"https://..."}` — fetch once through the proxy |
| GET | `/dsh-proxy/peers` | what can we borrow (add `?force=1` to bypass the cache) |
| POST | `/dsh-proxy/peers/clear-cache` | clear the borrow-detection cache and re-probe |

That is the complete surface. The two `/system-proxy` routes and the four `/game*`
routes are gone; there is no `POST /system-proxy` to flip Windows proxy state,
because the mechanism behind it was removed.

Two routes behave differently now:

- **`POST /start`** no longer reports "blocked". When another proxy is available it
  returns `{"started":false,"borrowed":true,"port":<theirs>}` and a note; otherwise
  it starts a kernel as before. Either way the response carries
  `proxy: "http://127.0.0.1:<exitPort>"`.
- **`POST /fetch`** sends the request to **`core.exitPort()`**, not to the
  configured port — when borrowing, the exit is the *other* proxy's port. Getting
  this wrong was the one real correctness bug the borrow rewrite had to fix; the
  response tells you which it was (`via`, and `borrowed: true|false`).

There is no 409 branch left. A failure is a plain **500** with `{"ok":false,
"error":"..."}`; the only other non-200 codes are 403 (non-loopback origin) and 413
(body over 2 MB).

> **`/fetch` always sends a `User-Agent`.** A real defect fixed on 2026-10-14: neither
> branch sent **any** request header, so GitHub's REST API answered **403** every time
> (`Request forbidden by administrative rules. Please make sure your request has a
> User-Agent header.`) — and that is **not** rate limiting: the same URL through the
> same proxy port returns 200 via `Invoke-WebRequest` (`x-ratelimit-remaining: 58`).
> GitHub requires a UA on **every** REST request, and `api.github.com` happens to be
> the most common thing `/fetch` is used for (it's the example in the CLI section
> above). Both branches now send
> `dsh-proxy-on-demand (+https://github.com/xfgil/dsh-proxy-on-demand)`.

## How it works

### Auto-shutdown: lease + guard

```
any use ──renew()──> write lease.state { deadline: now + idleMs }
                          │
guard timer (every 15s) ──┘
   a command holds the busy lock? ──yes──> never shut down (busy.state, liveness by PID)
        │no
   deadline passed? ──no──> keep sleeping
        │yes
        └─> did **we** start the kernel? ──no──> drop the lease, leave the process alone
                 │yes
                 └─> kill the PID in core.pid, delete pid/lease/busy files
```

Four deliberate decisions:

1. **Only kill the PID we started.** The state file records `core.pid`; it never
   kills by process name — that would risk killing the user's own FlClash or
   another mihomo.
2. **Never fight for the port.** If a common proxy port is already listening (say
   the user has FlClash open), the plugin borrows that exit and starts no kernel of
   its own — it **will not** shut down a process it doesn't own. A borrowed kernel
   is never killed, and it is never used as a reason to renew a lease we don't own:
   we have no standing to extend someone else's lifetime, and nothing of ours is
   being held, so there is nothing to reclaim.
3. **A long command holds the busy lock.** When `dsh-proxy -- <command>` runs, it
   writes `busy.state` (holding its own PID) and keeps renewing the lease. While
   that lock is held, `checkIdle()` never touches the kernel — otherwise a command
   that outlives `idleMs` (`npm install`, `git clone`, …) would be cut off
   mid-flight by the plugin's own guard, showing up as `ConnectionReset`. If the
   holder process is gone, the lock expires by PID, so it can never wedge.
4. **The CLI waits it out.** The guard timer is `unref()`'d (it doesn't keep Node
   alive), so both `dsh-proxy start` and `dsh-proxy -- <command>` stay in the
   foreground until the kernel is actually auto-shut-down — otherwise the command
   would exit and nobody would be left to run the "kill on expiry" step, leaving
   the kernel running, which is exactly what this plugin exists to prevent.

### Where the borrow hook sits

Acquisition is a four-step ladder, and **borrowing comes before anything is
started**:

```
POST /start ─┐
POST /fetch ─┼─> ensureAndStart() ─> core.ensureRunning()
CLI -- cmd  ─┘                            │
                                          our own kernel already alive? ──yes──> renew lease, return
                                               │no
                                          anything on a common proxy port? ──yes──> borrow it
                                               │                                      (currentExitPort = theirs,
                                               │                                       start no process)
                                               │no
                                          our own port busy (not ours)? ──yes──> reuse it, start no kernel
                                               │no
                                          core.start()
```

The order carries the meaning:

- **Borrowing is first**, so the common case — the user already has a proxy running —
  costs one port probe and **zero processes**. The old design could only reuse a peer
  when the two ports happened to match, which in practice meant it almost never did;
  now we go looking for one.
- **Reuse of our own occupied port is a fallback**, kept for the custom configuration
  where someone sets the plugin's port to 7890. With the default 7899 it essentially
  never fires.
- **Nothing here can refuse.** Every branch above produces an exit; the worst outcome
  is starting one extra kernel.

The borrow callback is injected into `core` as a **closure callback**
(`borrowPort: borrowFn`) rather than having `core.js` `import peers.js` directly —
that way `core.js` only deals with process lifecycle, while port policy and settings
stay in the layer above and can be tested on their own. `test/peers-test.mjs` does
exactly that: it feeds constructed probe results to the pure `evaluateBorrow()` and
never stands up a real proxy.

`core` exposes the result as `exitPort()` — `currentExitPort ?? cfg.port` — and
**every consumer uses it**: the CLI's `HTTP_PROXY`, `POST /fetch`, the `proxy` field
in `/start`'s response, and `core.status()`. That single accessor is what makes
"borrowed" correct everywhere instead of only on the happy path.

`core.status()` reports `exitPort`, `exitPortUp`, and

```js
borrowed: !alive && exitUp && ep !== this.cfg.port
```

— i.e. "our own kernel is not alive, but something is answering on a port that isn't
ours, therefore we are borrowing". `alive` is computed by `core` at that moment: the
layer above has no way to know whether the listener on our own port is ourselves.

### Kernel acquisition: self-contained download + unzip

No third-party dependencies at all:

- **Download**: `node:https` with manual 302 following (GitHub releases always
  redirect once to `objects.githubusercontent.com`)
- **Unzip**: hand-written zip parsing (EOCD `0x06054b50` → central directory
  `0x02014b50` → local header `0x04034b50`), method 0 copied verbatim, method 8
  through `zlib.inflateRaw`

**Mirror fallback is not optional**: a direct `github.com` release download
**hangs** from mainland China (TCP connects, the request goes out, the response
never arrives — measured: `socket hang up` after 12s) rather than failing fast.
So every candidate source has a 12-second first-byte timeout, and it moves on:

```js
export const DEFAULT_MIRRORS = [
  '',                          // direct
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://ghfast.top/',
];
```

Measured: direct times out at 12s → `gh-proxy.com` pulls and unpacks 61 MB in 7.8s.

### Config paths: two traps you will hit

**Trap 1 — the SAFE_PATHS sandbox.** mihomo only accepts **relative** paths inside
its `-d` directory. FlClash's config uses absolute rule-provider paths, which
fails outright:

```
Parse config error: path is not subpath of home directory or SAFE_PATHS:
C:\Users\<user>\AppData\Roaming\com.follow\clash\profiles\...\rules\59aaf94a...
allowed paths: [D:\path\to\plugins\dsh-proxy-on-demand\runtime]
```

Fix: copy the rule files into `runtime/providers/rules/` and rewrite the paths to
`providers/rules/<hash>`.

**Trap 2 — the YAML uses doubled backslashes.** The file says
`C:\\Users\\暝\\...`. Matching on a **single** backslash **silently fails** — and
worse, re-checking "how many single backslashes are left" also returns 0, so it
looks like the rewrite succeeded. Match the literal doubled backslash:

```js
const SEP = '\\\\\\\\?';   // accept one or two literal backslashes
```

## Upstream

This plugin ships **no** proxy kernel — it only starts and stops one. The actual
proxy comes from upstream:

| | |
|---|---|
| Project | [mihomo](https://github.com/MetaCubeX/mihomo) (the Clash.Meta core) |
| Copyright | © MetaCubeX and mihomo contributors |
| License | **GPL-3.0** (independent of this repo's MIT) |
| Relationship | Downloads the `mihomo-windows-amd64` binary from its official GitHub Release. **Not modified, not repackaged, not statically linked**; invoked as a separate process |
| Version tested | `v1.19.32` (`Mihomo Meta v1.19.32 windows amd64 with go1.26.8`), ~61 MB |
| Version policy | `/releases/latest` by default; pin with the `kernelVersion` config key |

Upstream's license, behaviour and security are upstream's responsibility. If you
redistribute this plugin, note that **downloading** a GPL-3.0 program and
**redistributing** it are different things — this repo only does the former.

## Known limitations

- **Windows first.** The kernel asset name is hard-coded to
  `mihomo-windows-amd64`. Porting means editing `prepareKernel()` in `lib/index.js`.
- **First run needs network** (~61 MB). Afterwards it's cached in `runtime/` and works offline.
- **It borrows rather than fights.** If a proxy is already listening on one of the
  common ports, this plugin uses it and starts nothing. Only when nothing is there
  does it bring up its own kernel — on **7899**, not 7890, so the two can coexist.
- **`settings.state` and `config.yaml` are stored separately.** Changing the
  subscription won't lose your switches and port settings; conversely, editing
  `config.yaml` by hand won't sync into the UI beyond the node count.
- **Borrow detection looks at ports only, not software identity.** Deliberate (see
  [Borrowing an existing proxy](#borrowing-an-existing-proxy)). It doesn't cover the
  two cases of "proxy software is open but not listening on a port yet" and "TUN mode,
  which listens on no port"; in those cases this plugin starts its own kernel as usual.
  That is not a failure — it just means one more `mihomo.exe` than strictly necessary,
  and with TUN mode in play the traffic is captured by that other proxy anyway.
- **Tested only on Windows 10/11 x64 + DSH 0.2.0-rc.2.**
- **It never touches your Windows proxy settings (changed 2026-10-16).** There is no
  system-proxy toggle any more, and no code that writes the registry: the kernel binds
  `127.0.0.1` only, and with nobody using it, it is inert. Pointing a browser or a
  game at the proxy is your call, not the plugin's.

### A misdiagnosis, corrected: the speed-test target

On 2026-10-13 I made the config-import path do this: replace the per-group test
address `url: https://www.gstatic.com/generate_204` with the domestic
`connect.rom.miui.com`, reasoning "gstatic is blocked in China → the panel is all
timeouts".

**That causal chain is wrong, and the change has been reverted.** A kernel speed
test is a request **sent through the node**, leaving from wherever the node is —
it has nothing to do with whether *this machine* can reach gstatic directly. The
controlled comparison (3 automatic groups × 4 members = 12 samples; after testing,
read back the top-level `history` the panel reads and count members with a valid
delay):

| Test target | Valid |
|---|---|
| Not passed (kernel uses the group's own target) | **11/12 = 92%** |
| The group's own `testUrl` passed explicitly | 10/12 = 83% |
| Rewritten to miui | 10/12 = 83% |

All three are equivalent, so there is **no reason to rewrite the user's test
target**. The real cause of "everything times out" was a **DNS port conflict**
(FlClash holding `1053`, so the kernel's DNS never came up → nothing resolved →
every target timed out at once), fixed by `forceDnsPort()` switching ports — and
unrelated to the test target.

> The start port for that search moved from `1053` to **`15353`** in the 2026-10-16
> cleanup (`forceDnsPort(text, startPort = 15353)` in `lib/config.js`). `1053` was
> the wrong end of the range to scan from: it is the port Clash-family cores grab
> first, so the very first candidate was the one most likely to be occupied.

That said, those 12 samples used **automatic groups** (URLTest/Fallback/LoadBalance,
which override `URLTest()` and use their own `url:`), so "passing url or not is
equivalent" holds **for them but not for Selector**. The "test latency" button
operates on the first **Selector**, and Selector does not override `URLTest()` —
without a url it passes the empty string down, members fail one by one, and the
endpoint returns `504 all proxies timeout`. That is the "everything times out"
you saw that day. The fix is for `testGroupDelay()` to **resolve the target itself
and always pass it** (the group's `testUrl` when present, otherwise
`DEFAULT_TEST_URL`) — **still without rewriting a single line of your config file**.

Likewise, a node's `history` is **not** bucketed by test URL — passing miui or
gstatic both update the same top-level `history` the panel reads, so there is no
"testing against another target makes the panel blind" problem either.

## Implementation notes

A few decisions that aren't obvious:

**The UI does not depend on the `settings` service.** The usual approach is
`ctx.settings.installSection(ctx, NS, Config, defaults, hooks)` on the host side,
where `Config` is a `z.object({...})` from `@deepseek-ai/schemastery`. But
`schemastery` often doesn't resolve on the profile side (on this machine the
package has `LICENSE`/`package.json`/`README.md` but **no `lib`**). Exporting a
non-schema object makes the loader throw while projecting config. So the UI talks
to the plugin's own HTTP endpoints, and the host side just reads and writes
`settings.state`.

**No `Config` schema is exported.** Same reason.

**Stats live on `globalThis[Symbol.for(...)]`.** A hot reload re-executes the
module's top level, zeroing ordinary module-level variables; a Symbol key on
`globalThis` survives reloads.

**The client half needs no bundling.** `package.json` declares
`dsh.client = { platform: "web", inject: [...] }`, and the entry `lib/client.js`
is a `window.__ModuleLoader__.load({ id, factory })` form that `require("react")`s
internally and exports `apply` / `inject` / `name`.

**It registers into the `settings.section` slot**, a page of its own in the
Settings sidebar (not a card under Settings → Plugins):

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'dsh-proxy-on-demand',
  order: 60,
  label: () => '按需代理',
  icon: 'settings',
}, Card));
```

**Gotcha: `settings.plugin.item` does not exist on DSH 0.2.0-rc.2 here.** That
name was copied out of `dsh-session-manager`'s source, but
`cordis_inspect_query(client/Slots/listSubTree {root:'settings.plugin.item'})`
returns `{"requestedRoot":{"name":"settings.plugin.item","available":false}}` —
the name is simply absent from the live slot tree. Worse, **registering into a
nonexistent slot throws nothing**: the whole panel silently fails to render while
`plugin_manager` still reports the plugin's `fiberPhase` as `active`.

Only `listSubTree {root:'settings.section'}` reveals the real topology and its
`occupants`, letting you confirm your own id made it in:

```json
{ "registrant": "dsh-proxy-on-demand-client", "id": "dsh-proxy-on-demand",
  "order": 60, "active": true }
```

Real settings/plugins-related slot names on this host: `settings.section` (a
sidebar page), `settings.plugins.tab` (a page inside the Plugins section),
`settings.general.item` (one preference row inside General), `plugins.bundle.config`
(keyed by package name), `plugins.row.config` (keyed `<pkg>#<rowId>`),
`plugins.detail.section`. When writing a client half, **call `listSubTree` first,
then register.**

**After `webServer.register({ kind: 'prefix' })`, the pathname still carries the
prefix.** `url.pathname` is still `/dsh-proxy/status`, so strip it yourself:

```js
const path = url.pathname.replace(/^\/dsh-proxy(?=-|\/|$)/, '') || '/';
```

**HTTPS targets need CONNECT first.** Sending an HTTPS request straight at a
plaintext proxy port fails with `Client network socket disconnected before secure
TLS connection was established` — that's a usage error, not a broken proxy.
`proxyGet()` in `lib/index.js` implements the CONNECT tunnel by hand.

## Development

```bash
node --check lib/index.js          # syntax check
node test/peers-test.mjs           # borrow rules (offline, 21 checks, pure function fed fixture data)
node test/client-render-test.mjs   # client UI rendering (offline, 44 checks, no kernel needed)
node test/dl-test.mjs              # kernel download only (fast)
node test/busy-test.mjs            # busy-lock regression: kernel must survive a command longer than idleMs
node test/selftest.mjs             # end-to-end: import config → download → start → go abroad → idle shutdown
```

`test/peers-test.mjs` is fully offline because its decision core, `evaluateBorrow()`,
was deliberately factored out as a **pure function**: it takes constructed port-probe
results and returns a verdict, never touching the real system. The branches that
matter are covered exactly — "every common port is down, so there is nothing to
borrow", "7890 answers, so borrow 7890 and say so in the note", "**our own port is
never borrowable**, or we would borrow from ourselves", "the first live port in list
order wins, regardless of the order the results arrive in", "caller-supplied extra
ports outrank the built-in list", "garbage input doesn't crash" — plus the 5 checks
that pin down the port list itself: it must contain the mainstream proxy ports, must
not contain **7899** (our own port), must have no duplicates, must be all valid port
numbers, and must not contain **9090** (FlClashCore's controller port, which is an
API, not a proxy).

`test/client-render-test.mjs` renders `lib/client.js`'s component through a minimal
React stand-in in three states — data not yet loaded, data loaded, and errored —
**with no network access and no kernel download**. It catches two classes of silent
failure: registering into a nonexistent slot (the host reports nothing; the UI just
never appears), and a render-time throw after `settings.state` is hand-edited into a
bad shape (`subscriptionUrl: null` makes `subInput.trim()` throw
`Cannot read properties of null`). Its fixtures mirror the real response shapes of
the host's `/dsh-proxy/status` and `/settings`.

`test/busy-test.mjs` covers a real bug that bit us: with `--idle 3` and a command
that takes 10 seconds, the guard used to kill the kernel at second 3 and the
command's last step failed with `ConnectionReset`. All 6 checks now pass (the
command gets an exit IP, the kernel shuts down on policy, the busy lock is released).

It is also the one test whose assumptions shift under borrowing: if a proxy really is
listening on `127.0.0.1:7890` when you run it, the CLI borrows it and no `core.pid` is
ever written — so check 4 ("the kernel was auto-shut-down") passes vacuously. Run it
with `--no-borrow` in the args if you want to be sure you exercised the kernel path.

`test/selftest.mjs` runs the whole chain against **your real FlClash config**. It is
the only test that touches the network and the real kernel, so it prints a lot; the
core of a passing run looks like this (the check names are Chinese because this is
the literal output):

```
PASS  0a 内置模板的默认端口是 7899 而不是 7890
PASS  0b 内置模板不含 7890
PASS  0c DNS 起始端口不再是 1053
PASS  0c2 onlyIfPorts：安全端口不被无谓重挑  (changed=false)
PASS  0c3 onlyIfPorts：命中 1053 时照样修  (port=15353)
PASS  0d ★ 导入配置里的 7890 被换成 7899
PASS  0i ★ 旧设置文件里的 port: 7890 被迁到 7899  (port=7899)
PASS  1 找到本机 FlClash 配置  (C:\Users\...\com.follow\clash\config.yaml)
PASS  2 识别出 rule-provider 绝对路径  (共 44 条，新拷 44)
PASS  2b 绝对路径已全部改为相对路径  (残留 0 处)
PASS  2c 相对路径已写入  (44/44)
PASS  2d 规则文件已拷贝到位
PASS  2k 配置里已打开管理 API  (port=19099)
PASS  3 取到最新内核版本  (v1.19.32)
PASS  3b 内核下载并解压成功  (61MB)
PASS  4 内核启动成功  (pid=8524 564ms)
PASS  4b 端口已监听  (port=7899)
PASS  4c ★ 内核没有占 7890（FlClash 的默认端口）  (mixed-port=7899)
PASS  4d ★ DNS 没有占 1053（FlClashCore 的端口）  (listen: 127.0.0.1:15353)
PASS  5 能连上代理端口
PASS  5b 走内核代理能出国（CONNECT 隧道）  (HTTP 200 ip=42.200.172.28)
PASS  6 内核 PID 已记录  (pid=8524)
PASS  6b 空闲后已自动关闭  (pid=8524 alive=false)
PASS  6c 租约文件已清理
RESULT: <n>/<n> passed
```

(The exact count depends on whether the optional node tests can reach the internet;
the run exits non-zero the moment any check fails.)

The port-isolation checks are the regression guard for this whole cleanup: the
built-in template must default to 7899 (`0a`), an imported config carrying `7890`
must be rewritten (`0d ★`), and a `settings.state` still holding the old `7890` must
be migrated on read (`0i ★`).

DNS follows the same reasoning, and it is the subtler half. A config left on
`1053` (FlClashCore's port) still listens on the proxy port and still runs
commands — but DNS never comes up, nothing resolves, and the symptom is *"every
node times out on the speed test"*. So both `dsh-proxy prepare` and the host's
`ensureControllerInConfig()` repair it in place with
`forceDnsPort(text, 15353, { onlyIfPorts: [1053] })`, which rewrites **only that
dangerous value** and leaves an already-safe port (say `1055`) alone — otherwise
every start would rewrite the file and log a line for nothing. `0c2` and `0c3`
pin down exactly that "only the dangerous value" semantics.

Group 4 repeats the port guard against the live kernel — `4c ★` asserts the
running core did not take 7890, `4d ★` that DNS did not take 1053. If someone
ever reverts the port, selftest fails loudly instead of the collision quietly
coming back.

## Disclaimer

**This is a personal-use tool. Assess the risk before using it.**

- Provided "AS IS", **without warranty of any kind**, express or implied,
  including but not limited to merchantability, fitness for a particular purpose
  and non-infringement.
- The author is **not liable** for any direct, indirect, incidental, special or
  consequential damages arising from the use of, or inability to use, this software.
- **You are responsible for the origin and legality of the kernel, nodes and
  subscriptions you use.** This plugin merely starts and stops
  [mihomo](https://github.com/MetaCubeX/mihomo); it does not provide, bundle or
  distribute any nodes or subscriptions.
- Comply with the laws of your jurisdiction and the terms of any service you use.
- The kernel comes from the upstream official Release; the author makes no
  guarantee about the behaviour or safety of upstream binaries.

## License

This plugin's own code: [MIT](LICENSE)

The upstream kernel it downloads and runs,
[mihomo](https://github.com/MetaCubeX/mihomo), is © MetaCubeX and its
contributors under **GPL-3.0** — see the note at the end of [LICENSE](LICENSE).
