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
- [Game detection](#game-detection)
- [Yielding to other proxies](#yielding-to-other-proxies)
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
- **Holds nothing in between** — no resident process, port 7890 is free, and it
  never fights with the Clash/FlClash you run yourself.
- **No meddling while you game** — a detected fullscreen game keeps the proxy
  off, leaving your network untouched (see [Game detection](#game-detection)).
- **Never fights another proxy** — when you already have FlClash or similar
  running, it silently steps aside and starts no process of its own (see
  [Yielding to other proxies](#yielding-to-other-proxies)).

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
dsh-proxy status                     # show status
dsh-proxy prepare                    # download kernel + prepare config
dsh-proxy import-flclash             # import config from local FlClash
dsh-proxy start                      # start kernel; waits until it auto-shuts down
dsh-proxy stop                       # stop immediately
dsh-proxy game                       # show game-detection result
dsh-proxy -- <command> [args...]     # run one command through the proxy
```

The last form is the common one:

```bash
dsh-proxy -- git clone https://github.com/some/repo
dsh-proxy --idle 0 -- curl.exe -sS https://api.ipify.org    # shut down right after
dsh-proxy --idle 600 -- npm install                          # stay up for 10 idle minutes
dsh-proxy --no-gate -- curl.exe -sS https://api.ipify.org    # skip game detection, force it on
```

The CLI is bound by the game gate too (otherwise `dsh-proxy -- ...` would bypass
the whole protection); when it's blocked the exit code is **3**.

It injects into the child process:

| Variable | Value |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | `http://127.0.0.1:<port>` |
| `NO_PROXY` | `localhost,127.0.0.1,::1,192.168.*,10.*,172.16.*` |

`NO_PROXY` matters — without it, even local services (like DSH's own 19387) would
be routed through the proxy.

## Settings UI

After installing, the Settings sidebar gains an "On-demand proxy" page. From top
to bottom:

**Status** — two switches, independent of each other:

| Switch | On = | Off = |
|---|---|---|
| **Proxy kernel** | start mihomo (~0.5 s; the first run downloads the kernel) | stop the kernel, and restore the system proxy exactly |
| **Windows system proxy** | send global traffic through the local kernel | browsers go direct (the kernel stays up) |

Keeping these apart is deliberate: **the kernel only listens on `127.0.0.1`, so
nobody is using it if you don't point anything at it; what actually changes your
network environment is the system proxy.** So you can leave the kernel running
with the system proxy off and just point `HTTP_PROXY` at it. The reverse is not
allowed: turning the system proxy on first makes sure the kernel is up —
pointing Windows at a port nobody is listening on would cut off your whole
network, which is far worse than having no proxy.

Next to the switches you get the kernel PID and port; in non-resident mode you
also get "seconds left until auto-shutdown". Refreshes every 4 seconds.

> If another program holds the system proxy (FlClash, say), the switch reads
> "not taken over (held by another program)" and the plugin **reports it without
> overriding** — it does not fight over your settings.

**Node panel** — while the kernel runs, lists the nodes of the current group,
name on the left and delay on the right, with `●` marking the one in use. A
**Test delay** button at the top triggers a group-wide speed test; the list is a
**fixed 8 rows per page** and scrolls beyond that.

There is deliberately **no group dropdown**: groups all live in that one
scrolling list. Speed testing is **delay only** — the connectivity test was
dropped because in practice very few nodes passed it (only Hong Kong did, that
one time), so it had little diagnostic value and was easily misread as "the
network is broken".

The test target is **whatever `url:` each group already configures** (usually
the provider's `gstatic/generate_204`); the plugin does not rewrite it — see the
corrected misdiagnosis under [Known limitations](#known-limitations).

**Nodes** — three ways to supply a config:

| Method | What it does |
|---|---|
| Subscription URL | Paste and click *Fetch subscription*; the plugin downloads it and rewrites paths |
| Import from FlClash | Reads your local FlClash `config.yaml` and rewrites rule-provider absolute paths to relative ones |
| Paste manually | Drop in a Clash/mihomo YAML directly |

**Game detection** — shows the current system state
(`SHQueryUserNotificationState`), the foreground program, and whether a game was
detected; switches (*block enabling the proxy while a game runs* / *shut the
kernel down too when a game is detected*) plus a *re-check now* button. See
[Game detection](#game-detection) for details.

**Parameters** — proxy port, idle timeout (seconds), enable/disable the plugin,
and whether to auto-import FlClash on first run. Changes apply immediately.

> A port change needs a kernel restart: flip the **Proxy kernel** switch off and
> back on.

The UI **does not go through DSH's `settings` service**; it reads and writes the
settings file and talks to the plugin's own HTTP endpoints. See
[Implementation notes](#implementation-notes) for why.

## Game detection

You don't want your network environment changed while you're gaming, so before
**starting the kernel** the plugin takes a look at the system state: **if a game
is detected, the proxy is not enabled**.

### Only manages itself

There's a deliberate decision here: **the criteria never ask "which program is
this"**.

There is no built-in game list, and no built-in accelerator whitelist either —
such a list can never be exhaustive, and any missing entry would let through
exactly the scenarios that should be blocked. The criteria ask one thing only:
**does this situation look like playing a game in fullscreen**.

The price is the occasional false positive (a borderless-fullscreen window taken
for a game). But the consequence is merely that the proxy plugin doesn't start
this once; the game itself is untouched — flip the switch off temporarily, add
the program to the whitelist, or add `--no-gate` on the command line, and you're
through.

### Whitelist (filled in by you)

What's above means **the plugin preloads no list of its own**. But you may well
need exceptions yourself (say a remote-control tool, a screen recorder, or a
borderless video player gets taken for a game in fullscreen), so there is a
**user whitelist** — **empty by default, filled in only by you**.

| How to fill it | How it matches |
|---|---|
| `obs64.exe` | by **process name**, case-insensitive |
| `D:\path\to\OBS\obs64.exe` | by **full path** (forward slashes work too, case-insensitive) |

Filling in the name is more durable (the name usually survives an upgrade that
moves the program to a new directory), at the cost of **letting through every
program with that name, whatever directory it lives in**; filling in the full
path lets through only that one, but stops working once the path changes. Mixing
the two is fine.

When the whitelist hit is the **current foreground program**, neither criterion
applies. The *add the current foreground program* button in the UI takes the
foreground window as of the moment it probes — the easiest thing to click when a
fullscreen window is misjudged.

### Two criteria

| Criterion | What it is | Source |
|---|---|---|
| **Primary** | system state ∈ {busy, exclusive fullscreen, presentation} | `SHQueryUserNotificationState` |
| **Secondary** | the foreground window fills a whole monitor **and** has no caption, and is not a shell component | `GetForegroundWindow` + `GetWindowLong` + `MonitorFromWindow` |

What makes the primary criterion meaningful: **Windows itself is saying "don't
interrupt the user right now"**. Measured, it catches borderless fullscreen (not
just exclusive D3D fullscreen) — popping a `FormBorderStyle=None` window that
fills the screen moves QUNS from 5 (accepts notifications) to 2 (busy).

The secondary criterion covers borderless fullscreen the system doesn't report.
It must exclude shell components or it misfires: measured, with the `explorer.exe`
desktop pulled to the foreground `caption=false, full=true`, so **the naive
criterion takes it for a game** — while at that same moment QUNS=5, the system
plainly saying "interruptible". That is exactly why **QUNS has to be the primary
criterion**.

`QUNS` values: `1=locked / 2=busy / 3=exclusive fullscreen / 4=presentation / 5=accepts notifications / 6=quiet time / 7=app-defined`. Only `2/3/4` block.

### Blocks only new starts

`ensureRunning()` returns a lease renewal directly when the kernel is already
running, **without passing through the gate**. So:

- If the proxy is **not running** when a game starts → starting is refused
  (returns `409 Conflict`).
- If the proxy is **already running** when a game starts → it's left alone, and
  the download you have in flight is not interrupted.

To make it "shut the proxy down the moment a game starts", turn on *shut the
running proxy down when a game is detected* (`stopOnGame`) in Settings.

### Fails open

The probe won't start, compilation fails, it times out — in all those cases the
gate **lets it through**. Better to let one slip than to have the detection
machinery itself lock the proxy out for good.

### The probe process

Detection goes through a **resident child process**, `runtime/gameprobe.exe`
(embedded C# source, compiled with Windows' own `csc.exe` — no SDK needed). The
protocol is line-delimited JSON over stdin/stdout.

Why keep it resident rather than spawning per call — measured numbers:

| Approach | Cost per call |
|---|---|
| `Add-Type` compile every time | 480ms |
| compile to an exe, spawn per call | 349ms |
| compile to a DLL + `Assembly.LoadFrom` | 8ms |
| **resident exe + stdin/stdout** | **0.5ms** (385ms cold start, paid once) |

The UI polls every 4 seconds, and a verdict is cached for 3 seconds — so the real
system-call rate is about once every 3 seconds.

### Command line

```bash
dsh-proxy game                        # show the detection result: system state, foreground program, time taken
dsh-proxy game --json                 # the same, as JSON
dsh-proxy game list                   # list the whitelist
dsh-proxy game allow obs64.exe        # add a program to the whitelist (for false positives)
dsh-proxy game --allow-fg             # add the current foreground program to the whitelist
dsh-proxy game unallow obs64.exe      # remove a program from the whitelist
dsh-proxy --no-gate -- cmd            # skip detection for this run, force it on
```

When the gate blocks you the CLI exit code is **3** (as opposed to the ordinary
1), so a script can tell "blocked by a game" from "it genuinely failed".

## Yielding to other proxies

If another proxy is already running on your machine (FlClash, Clash Verge,
v2rayN…), this plugin **silently steps aside**: it starts no kernel of its own,
grabs no port and leaves your network environment alone. It recovers
automatically once that other proxy exits.

### Ports only, not software identity

There is exactly one criterion: **is anyone listening on a common proxy port**.

| | |
|---|---|
| Ports probed | 18: `7890-7893` (Clash/mihomo), `7897/7898` (Clash Verge Rev), `10808-10810` (v2rayN/xray), `1080/1081` (the usual SOCKS ports), `2080/2081` (sing-box), `20171/20172` (older Clash Verge), `8889` (Clash for Windows), `8118` (privoxy), `9910`, plus this plugin's own port |
| Cost | about **2–3ms** for the whole concurrent probe (a connection refused on loopback is instantaneous) |

Why not look at process names: this way it applies to any proxy software
automatically, needs no maintained list of "who counts as a proxy", and can't miss
one just because it isn't on the list. The price is two uncovered cases — proxy
software that is open but hasn't started listening on a port yet, and TUN mode,
which doesn't listen on a port at all. In those two cases this plugin starts as
usual, but since that other proxy is still there, your commands actually keep
going through it (see "Reuse when the port is taken" below).

### Must exclude your own kernel

This plugin listens on `port` itself (7890 by default). If detection didn't
exclude itself, the kernel would be taken for "another proxy" the moment it came
up and would then **block itself forever**.

So the verdict carries one hard rule: `port === ownPort && our own kernel is
alive` → not someone else. `ownAlive` is computed by `core` and handed upward —
because "is the listener on this port me" is something only core knows.

### Reuse when the port is taken, block only when it is free

The gate only needs to speak up when we are **about to start our own kernel**. If
7890 is already taken by someone else, `ensureRunning()` simply marks
`external: true` and returns: commands work as usual (through the proxy that
someone else already built), and we start not a single process. That is what
"silently steps aside" looks like on the normal path.

### Fails open

Same principle as the game gate: when probing errors out, let it through — better
to start a kernel one extra time than to have a bug in the probing code make the
proxy unusable for good.

### Command line

```bash
dsh-proxy peers              # show the detection result: which ports are taken, time taken
dsh-proxy peers --json       # the same, as JSON
dsh-proxy --no-peer -- cmd   # skip yielding for this run, force it on
```

When the peer gate blocks you the CLI exit code is **4** (the game gate is 3, an
ordinary error is 1).

## Configuration

The plugin's own settings live in `<plugin>/runtime/settings.state`:

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

`blockOnGame` defaults to `true` (block enabling the proxy while a game runs),
`stopOnGame` defaults to `false` (block new starts only; leave a running kernel
alone), `gameAllow` defaults to `[]` (the whitelist is filled in by the user
alone; the plugin preloads nothing), `yieldToPeer` defaults to `true` (step aside
automatically when another proxy is detected).

`systemProxy` defaults to `true` (let the plugin switch the Windows system proxy;
turning it off restores your original settings exactly); `resident` defaults to
**`false`** — i.e. the plugin's original behaviour, **shut down when done**. Turn
it on for resident mode (never auto-shutdown when idle; exits with DSH).

> **The system proxy is controlled solely by that toggle on the panel**; starting
> or stopping the kernel never touches it (corrected 2026-10-14). Earlier versions
> had a default-on `proxyOnStart` that pointed the system proxy at us as soon as
> the kernel came up; that key has been removed. Why: the kernel binds only
> `127.0.0.1`, so starting it has no side effects, whereas the system proxy is
> **global** — something with no side effects should not automatically trigger
> something that has them. That behaviour also had no switch on the panel, so the
> user could neither see nor disable it. The kernel stopping still **restores**
> the system proxy, but that is not deciding for you — it is retracting a trace the
> plugin itself left behind (pointing at a dead port would cut off your network).

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
| `gameprobe.exe` / `gameprobe.cs` | the resident probe process for game detection (compiled on first use) |
| `proxy-backup.state` | **your original system-proxy settings**, saved before the plugin takes over (written back field by field) |
| `core.log` | kernel log |

> **Why are the state files `.state` and not `.json`?**
>
> The host watches the plugin directory, and its plugin watcher **only reacts to `.json`** (a 21-extension matrix measured on 2026-10-14: `.state`/`.log`/`.txt`/`.dat`/`.lock`/`.yaml`/`.pid`… none of them trigger, **only `.json` does** — including `.json` inside subdirectories). One trigger means a full hot reload: **the old instance is disposed first, then the new one is applied**.
>
> So as long as a state file is named `.json`, every write rebuilds the plugin. The nastiest chain was:
>
> 1. You click "enable system proxy" → the plugin writes `proxy-backup.json` (a backup of your original settings);
> 2. **That single write triggers a hot reload**;
> 3. The new instance reads the registry while the old instance's `powershell` call is still running (measured ~700ms) → it concludes "the system proxy is not ours" → it deletes the backup that was just written;
> 4. Only afterwards does the registry flip to "enabled" — **proxy on, backup gone**;
> 5. Now you can never turn it off: the disable path finds no backup and can only answer "we never changed it".
>
> Renaming to `.state` means the hot reload **never happens at all**, so the race disappears at its root rather than being dodged by a patch. Leftover `.json` files from older versions are migrated automatically on startup (`migrateStateFiles()`) and then deleted — keeping them around would keep triggering hot reloads.

## HTTP API

Everything listens on **loopback only** (`127.0.0.1` / `::1`); other origins get 403.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-proxy/status` | kernel running?, PID, seconds remaining, current system-proxy state |
| GET | `/dsh-proxy/settings` | read settings + current config summary |
| POST | `/dsh-proxy/settings` | write settings |
| GET | `/dsh-proxy/system-proxy` | current system-proxy state (ours? held by someone else?) |
| POST | `/dsh-proxy/system-proxy` | `{"on":true\|false}` — switch the system proxy (makes sure the kernel is up first when turning it on) |
| GET | `/dsh-proxy/proxies` | list groups and nodes (add `?fake=1` to include the informational pseudo-nodes) |
| POST | `/dsh-proxy/proxies/select` | `{"group":"...","node":"..."}` — switch node, then **read back to confirm** |
| POST | `/dsh-proxy/proxies/test` | `{"group":"...","timeoutMs":3000}` — test delay |
| POST | `/dsh-proxy/prepare` | download kernel + prepare config |
| POST | `/dsh-proxy/start` | start the kernel |
| POST | `/dsh-proxy/stop` | stop the kernel |
| POST | `/dsh-proxy/renew` | renew the idle timer |
| POST | `/dsh-proxy/config/from-subscription` | `{"url":"..."}` — fetch a subscription |
| POST | `/dsh-proxy/config/import-flclash` | import from local FlClash |
| POST | `/dsh-proxy/config/manual` | `{"text":"..."}` — write a config by hand |
| GET | `/dsh-proxy/config/example` | get a template |
| POST | `/dsh-proxy/fetch` | `{"url":"https://..."}` — fetch once through the proxy |
| GET | `/dsh-proxy/game` | game-detection status (add `?force=1` to bypass the cache) |
| POST | `/dsh-proxy/game/clear-cache` | clear the detection cache and re-check |
| POST | `/dsh-proxy/game/allow` | add a whitelist entry; with no argument it takes the **current foreground program** |
| POST | `/dsh-proxy/game/allow/remove` | `{"entry":"..."}` — remove an entry from the whitelist |
| GET | `/dsh-proxy/peers` | peer-yield detection status (add `?force=1` to bypass the cache) |
| POST | `/dsh-proxy/peers/clear-cache` | clear the peer-yield detection cache and re-check |

When the game gate blocks you, `POST /start` and `POST /fetch` return
**409 Conflict**:

```json
{
  "ok": false,
  "blocked": true,
  "reason": "game-running",
  "error": "系统处于「忙碌」状态（game.exe），已按设置禁止启用代理。…"
}
```

Blocked by the peer gate it's a 409 as well, with `reason` set to `peer-running`:

```json
{
  "ok": false,
  "blocked": true,
  "reason": "peer-running",
  "error": "检测到其它代理正在运行（端口 10808 正在被监听），已按设置自动静默让路，不启动本插件的内核。…"
}
```

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
2. **Never fight for the port.** If 7890 is already listening (say the user has
   FlClash open), the plugin does not start a kernel; it marks the state
   `external`, keeps working, and **will not** shut down a process it doesn't own.
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

### Where the gate hooks in

The gate hooks into the **kernel-start path** only; it never touches a kernel
that's already running:

```
POST /start ─┐
POST /fetch ─┼─> ensureAndStart() ─> core.ensureRunning()
CLI -- cmd  ─┘                            │
                                          kernel already running? ──yes──> renew lease and return (gate not consulted)
                                               │no
                                        gameGate() ──blocked──> throw GAME_BLOCKED ─> HTTP 409
                                               │allowed
                                          core.start()
```

`gate` and `gameWatch` are injected into `core` as **closure callbacks**, rather
than having `core.js` `import games.js` directly — that way `core.js` only deals
with process lifecycle, while the criteria and settings stay in the layer above,
and can be tested on their own.

The whitelist takes effect inside `evaluateGate()`: on a hit **neither criterion
participates** (`hit` is simply `null`), rather than "decide first, then undo".
That way there is only one explanation for "why wasn't this blocked", and the UI
can tell you plainly whether the name or the path matched.

The `stopOnGame` hook hangs off the guard's `checkIdle()` (after the busy-lock
check, before the lease check): while a command holds the lock it never shuts
down; otherwise a detected game takes the kernel down.

### Where the peer gate hooks in

The peer gate is a **sister mechanism** to the game gate — same position, same
principle (block new starts only, fail open), but it **decides before the game
gate does**:

```
POST /start ─┐
POST /fetch ─┼─> ensureAndStart() ─> core.ensureRunning()
CLI -- cmd  ─┘                            │
                                          kernel already running? ──yes──> renew lease and return
                                               │no
                                          port taken by someone else? ──yes──> mark external, reuse it, start no kernel
                                               │no
                                          peerGate() ──blocked──> throw PEER_BLOCKED ─> HTTP 409
                                               │allowed
                                          gameGate() ──blocked──> throw GAME_BLOCKED ─> HTTP 409
                                               │allowed
                                          core.start()
```

The order matters: **yielding comes first**. If another proxy already holds the
port, then "can we even start" is not a question the game state gets to answer;
stepping aside first saves one system-state probe and makes the block reason the
user sees more accurate.

`peerGate` is likewise injected into `core` as a closure callback, but with a
different signature — it receives `{ ownAlive }`:

```js
const peerGateFn = ({ ownAlive } = {}) => peerGate({
  yieldToPeer: user.yieldToPeer !== false,
  ownPort: user.port,
  ownAlive: ownAlive === true,
});
```

`ownAlive` has to be computed by `core` at that moment and passed down — the layer
above (`index.js`) has no way to know whether the listener on 7890 is itself.

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
- **It won't start when the port is taken.** Deliberate: better to reuse a proxy
  someone already has running than to fight over the port.
- **`settings.state` and `config.yaml` are stored separately.** Changing the
  subscription won't lose your switches and port settings; conversely, editing
  `config.yaml` by hand won't sync into the UI beyond the node count.
- **Game detection infers from the situation, not the software's identity.** This
  is deliberate (see [Game detection](#game-detection)); the price is that some
  programs' borderless fullscreen gets taken for a game. A false positive only
  means the proxy doesn't start this once, and never affects the game itself; you
  can also add that program to the
  [whitelist](#whitelist-filled-in-by-you).
- **The probe process needs `csc.exe`.** It uses the .NET Framework compiler that
  ships with Windows
  (`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) — no SDK required.
  On an extremely stripped-down system where it's missing, the gate degrades to
  "detection failed → let it through".
- **Peer detection looks at ports only, not software identity.** Also deliberate
  (see [Yielding to other proxies](#yielding-to-other-proxies)). It doesn't cover
  the two cases of "proxy software is open but not listening on a port yet" and
  "TUN mode, which listens on no port"; in those cases this plugin starts as usual,
  but since that other proxy is still there, your commands actually keep going
  through it.
- **Tested only on Windows 10/11 x64 + DSH 0.2.0-rc.2.**
- **Takes over the system proxy (can be turned off).** When the kernel comes up it
  points the Windows system proxy at the local port by default, which is what most
  people mean by "the proxy is on". Your original settings are backed up to
  `runtime/proxy-backup.state` and written back field by field when it's turned off
  (**including `ProxyEnable=0`** — if you hadn't turned it on, it won't leave it on
  for you). If you run FlClash yourself, the plugin **reports without overriding**.
  Turn off "let this plugin manage the Windows system proxy" in settings to disable
  the behaviour entirely.

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

**A resident child process keeps Node from exiting.** The probe process started by
`lib/probe.js` holds the stdio pipes, so the event loop never empties — a short
command (`dsh-proxy game`) finishes but doesn't exit, looking like a hang.
`bin/dsh-proxy.mjs` explicitly `await disposeProbe()`s at the end of the script.

**Three P/Invoke traps.** All hit while writing the embedded C# in `lib/probe.js`:

- `GetMonitorInfoW` / `GetWindowTextW` / `QueryFullProcessImageNameW` **must**
  spell out `EntryPoint = "...W"` or `CharSet = CharSet.Unicode` — the default
  looks for the `*A` versions, and **these functions have no A version at all**,
  so it throws `EntryPointNotFoundException` at runtime.
- Read window styles with `GetWindowLongW`, not `GetWindowLongPtrW`.
- `OpenProcess` with `PROCESS_QUERY_LIMITED_INFORMATION (0x1000)` is enough to get
  the process path, no elevation required.

## Development

```bash
node --check lib/index.js          # syntax check
node test/games-test.mjs           # game-detection rules (offline, 61 checks, pure function fed fixture data)
node test/peers-test.mjs           # peer-yield rules (offline, 26 checks, pure function fed fixture data)
node test/client-render-test.mjs   # client UI rendering (offline, 37 checks, no kernel needed)
node test/dl-test.mjs              # kernel download only (fast)
node test/busy-test.mjs            # busy-lock regression: kernel must survive a command longer than idleMs
node test/selftest.mjs             # end-to-end: import config → download → start → go abroad → idle shutdown
```

`test/games-test.mjs` manages to be fully offline because the decision core,
`evaluateGate()`, was deliberately factored out as a **pure function** — it takes
a "probe frame" object and returns a verdict, never touching the real system. So
covering edges like a fullscreen explorer desktop, a fullscreen IME host, a failed
probe or missing fields needs none of those situations to actually be staged. The
23 whitelist checks live here too: name matching / path matching / case / forward
slashes / filling in a name alone lets through same-named programs in other
directories / neither criterion participates on a hit / dirty input doesn't crash.

`test/peers-test.mjs` works the same way: its decision core, `evaluatePeers()`, is
a pure function fed constructed port-probe results. So the two key branches — "a
listener on our own port held by our own kernel doesn't count as someone else"
and "the same port, but we're not alive, so it is someone else" — are covered
exactly, with no need to actually stand up a fake proxy.

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

`test/selftest.mjs` runs the whole chain against **your real FlClash config**,
with 14 checks:

```
PASS  1  found local FlClash config
PASS  2  detected absolute rule-provider paths  (44 found, 44 copied)
PASS  2b all absolute paths rewritten to relative  (0 left)
PASS  2c relative paths written  (44/44)
PASS  2d rule files copied into place
PASS  3  fetched latest kernel version  (v1.19.32)
PASS  3b kernel downloaded and unpacked  (61MB)
PASS  4  kernel started  (pid=8524, 564ms)
PASS  4b port is listening  (port=7891)
PASS  5  can connect to the proxy port
PASS  5b traffic goes abroad through the kernel (CONNECT tunnel)  (HTTP 200 ip=42.200.172.28)
PASS  6  kernel PID recorded  (pid=8524)
PASS  6b auto-shutdown after idle  (pid=8524 alive=false)
PASS  6c lease file cleaned up
RESULT: 14/14 passed
```

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
