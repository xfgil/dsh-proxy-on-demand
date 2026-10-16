# dsh-proxy-on-demand

> Starts the proxy kernel only when it's needed, shuts it down when you're done.
> Holds no port, leaves no background process, never touches your system proxy.
> A tool for the agent, not a client for humans — the kernel uses 7899 (clear of FlClash's 7890),
> and when a proxy is already running on this machine it borrows that exit and starts no process at all.

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
> kernel binary. On first use it fetches `mihomo-windows-amd64` (about **61MB**)
> from the official [mihomo](https://github.com/MetaCubeX/mihomo) GitHub Release
> into the plugin's `runtime/` directory, and works offline afterwards.
> Nothing needs to be installed by hand; delete `runtime/` to remove it entirely —
> no leftovers anywhere on disk. Set `autoDownload: false` to opt out and supply
> your own kernel. Details in [Download notes](#download-notes).

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
- [Download notes](#download-notes)
- [Upstream](#upstream)
- [Known limitations](#known-limitations)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## What this is

`dsh-proxy-on-demand` is a DeepSeek Harness (DSH) plugin that gives the agent a
proxy **on call**: there when you need it, gone when you don't.

> **The positioning is "a tool for the agent", not "a client for humans".** No tray
> icon, no grabbing the system proxy, no deciding for you whether "now" is a moment
> that should be online. The settings page exists because you have to put nodes in
> it (subscription / import from FlClash / paste by hand) — once that's done you can
> forget about it.

It wraps [mihomo](https://github.com/MetaCubeX/mihomo) (the Clash.Meta core) inside
the plugin:

- **Starts on demand** — the first time you need it, it downloads the kernel,
  prepares a config and spawns the process.
- **Shuts down when idle** — after 2 minutes of no use by default, it kills the
  kernel and cleans up its state files.
- **Never fights FlClash for ports** — the kernel uses **7899**, deliberately clear
  of the Clash/FlClash default `7890`; the management API starts at **19090** and
  DNS at **15353**, each then picking a free port (also clear of FlClashCore's
  habitual `9090` and the `1053` it holds). So your FlClash keeps running as usual,
  unaffected.
- **Never touches the system proxy** — the plugin binds the kernel to `127.0.0.1`
  only and writes **not one byte** to the Windows system-proxy registry. Whether
  traffic goes through a proxy is your call (`HTTP_PROXY`, or your own proxy
  software).
- **Borrows an existing local proxy** — when you already have FlClash or something
  similar running, the plugin reuses its exit and starts **no process of its own**
  (see [Borrowing an existing proxy](#borrowing-an-existing-proxy)).
- **A node panel is built in** — while its own kernel is running, the settings page
  can list groups, list nodes, switch nodes (with a read-back confirmation) and test
  latency in one click.

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
`POST /dsh-proxy/fetch`; the plugin prepares an exit on the way (borrowing if a local
proxy is running, otherwise starting its own kernel), fetches, renews the lease once,
and lets it shut itself down.

What is left: the HTTP API, the CLI, on-demand start/stop of the kernel, and that one
small settings page for config sources (subscription / import from FlClash / paste by
hand) — without which you'd have no way to put nodes in.

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

Once installed, **Settings → On-demand proxy** appears as a page of its own in the
Settings sidebar (not a card under Settings → Plugins) and gives you the full UI
(see below). The HTTP API is also available:

```bash
curl -X POST http://127.0.0.1:19387/dsh-proxy/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://api.github.com/repos/MetaCubeX/mihomo/releases/latest"}'
```

### Command line

The plugin ships a `dsh-proxy` command that **does not need the host process** — it
works even when the host isn't running:

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

`端口` is **our own kernel's** port, while `借道探测` answers a different question —
"if we actually needed it right now, could we borrow one?" `status` **only probes
ports; it never starts a kernel** (about 2ms) — looking at the status should not
quietly spawn a process as a side effect. Once the kernel really is up, one more
line appears: `出口端口`, and *that* is the port `-- <cmd>` will really use.

The last form is the common one:

```bash
dsh-proxy -- git clone https://github.com/some/repo
dsh-proxy --idle 0 -- curl.exe -sS https://api.ipify.org    # shut down right after
dsh-proxy --idle 600 -- npm install                          # stay up for 10 idle minutes
dsh-proxy --no-borrow -- curl.exe -sS https://api.ipify.org  # no local proxy, insist on our own kernel
```

It injects into the child process:

| Variable | Value |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | `http://127.0.0.1:<exit port>` |
| `NO_PROXY` | `localhost,127.0.0.1,::1,192.168.*,10.*,172.16.*` |

`NO_PROXY` matters — without it, even local services (like DSH's own 19387) would
be routed through the proxy.

Note that the exit port is **computed at runtime**: when a proxy is already running
on this machine it is the borrowed one (usually 7890), otherwise it is the plugin's
own 7899. The CLI doesn't assume the port from the settings — that would point at a
port nobody is listening on.

## Settings UI

After installing, the Settings sidebar gains an "On-demand proxy" page. From top to
bottom:

**Status** — see at a glance whether the kernel is up, with a **Proxy kernel**
switch next to it:

| Display | Meaning |
|---|---|
| *kernel running* | our own mihomo is up; shows the PID and the exit port, and in non-resident mode "seconds left until auto-shutdown" |
| *port taken* | something else is already listening on 7899 — the plugin starts no kernel and uses that instead (see [Borrowing an existing proxy](#borrowing-an-existing-proxy)) |
| *kernel stopped* | nothing has been started yet; the next use brings it up automatically. **A local proxy already running shows this badge too** — the status line says "not started (borrowing)" and gives the actual exit port |

While borrowing, the switch is **greyed out**: there is no kernel of ours to start,
so clicking it would mean nothing. No countdown is shown either — that kernel isn't
ours, and its lifetime is something we neither know nor should manage. Refreshes
every 4 seconds.

**Node config** — three ways to supply nodes:

| Method | What it does |
|---|---|
| Subscription URL | Paste and click *Fetch subscription*; the plugin downloads it and rewrites paths to relative ones |
| Import from FlClash | Reads your local FlClash `config.yaml` and rewrites rule-provider absolute paths to relative ones |
| Paste manually | Drop in a Clash/mihomo YAML directly |

**Node panel** — while a kernel is available, lists the nodes of the current group,
name on the left and delay on the right, with `●` marking the one in use. A
**Test delay** button at the top triggers a group-wide speed test; the list is a
**fixed 8 rows per page** and scrolls beyond that.

There is deliberately **no group dropdown**: groups all live in that one scrolling
list and you scroll it yourself. Speed testing is **delay only** — the connectivity
test was dropped because in practice very few nodes passed it (only Hong Kong did,
that one time), so it had little diagnostic value and was easily misread as "the
network is broken".

The test target is **whatever `url:` each group already configures** (usually the
provider's `gstatic/generate_204`); when a group configures none — most
**manual-select groups** don't — it falls back to a domestically reachable
`generate_204`. The plugin **never rewrites the target inside your config file**.

> **Why not just "let the kernel use the group's own url" and be done?** mihomo's
> **Selector does not override `URLTest()`**. When the delay endpoint is called
> without a `url`, it passes the empty string straight down → `urlToMetadata("")`
> says "scheme not Support" → **every member of the group fails** and the endpoint
> returns `504 all proxies timeout` within 4ms. And the "test latency" button
> operates on the first Selector. So now the **plugin resolves the target itself and
> always passes it**: the group's own `testUrl` when it has one, otherwise the
> fallback `generate_204`. Automatic groups (URLTest/Fallback/LoadBalance) ignore the
> passed url and keep using their own, so this is harmless for them.

> **The node panel does not work while borrowing, and that is normal.** Listing and
> switching nodes go through mihomo's management API, and its address and secret are
> what the plugin configured for **its own** kernel; the borrowed kernel belongs to
> someone else, with a different secret and a different address. In that situation
> the plugin honestly says "borrowing" and does not pretend it can switch.

**Parameters** — proxy port, idle timeout (seconds), enable/disable the plugin,
auto-import FlClash on first run, and resident mode. Changes apply immediately.

> The default port is **7899**, deliberately not 7890 — that is the Clash-family
> default, and sharing it means the plugin's kernel can take 7890 first and knock
> your own kernel out of it. A port change needs a kernel restart: flip the
> **Proxy kernel** switch off and back on.

The UI goes through the plugin's own HTTP endpoints and reads/writes the state files
directly; it does not depend on DSH's `settings` service.

## Borrowing an existing proxy

If a proxy is already running on your machine (FlClash, Clash Verge, v2rayN…), this
plugin **borrows its exit** and starts **no process of its own** — no port grabbed,
nothing of yours touched. After that other proxy exits, the plugin starts its own
kernel the next time it is needed.

There is exactly one criterion: **is anyone listening on a common proxy port**. It
does **not** look at process names, and it doesn't require the other side to be any
particular software: it applies to any proxy software automatically, needs no
maintained list of "who counts as a proxy", and can't miss one just because it isn't
on the list. The price is two uncovered cases — proxy software that is open but
hasn't started listening on a port yet, and TUN mode, which doesn't listen on a port
at all. In those two cases the plugin starts its own kernel as usual (nothing was
borrowed), but it **will not** touch the other side.

### Ports only, not software identity

| | |
|---|---|
| Ports probed | 18: `7890-7893` (Clash/mihomo), `7897/7898` (Clash Verge Rev), `10808-10810` (v2rayN/xray), `1080/1081` (the usual SOCKS ports), `2080/2081` (sing-box), `20171/20172` (older Clash Verge), `8889` (Clash for Windows), `8118` (privoxy), `9910` |
| Cost | about **2–3ms** for the whole concurrent probe (a connection refused on loopback is instantaneous) |
| Priority | **in list order**, not sorted by port number — `7890` comes first, i.e. "FlClash wins" |

Borrow results are cached for **3 seconds**: a handful of fetches in one round probe
the ports only once. Probing uses `net.createConnection` and spawns no external
process — the latter (`netstat` and friends) takes 100–300ms per call, while probing
all 18 ports concurrently takes 1–2ms total here.

### The probe list must not contain our own port

The table above **excludes `7899`** — that's this plugin's own port. This is not a
detail: if it were in the candidate list, then in the instant "our own kernel was
just killed but the port hasn't been released by the system yet" the plugin would
**borrow from itself** and then discover that the exit doesn't exist.

So the list firmly omits our own port, rather than routing around it with "check
whether this listener is me" — the latter is unreliable once ports are being reused.

### Reuse when our own port is taken

Borrowing only happens when the plugin is **about to start its own kernel**. One pass
through `ensureRunning()`:

```
is our own kernel already running? ──────yes──> renew the lease and return
        │no
is there a proxy we can borrow? ──────yes──> note the exit port; start no kernel
        │no
is our own 7899 taken by someone else? ──yes──> use it (also start no kernel)
        │no
   only then core.start()
```

While borrowing **no lease is written**: that kernel belongs to someone else and we
have no standing to change its lifetime. The idle guard skips it too — someone
else's process is not ours to shut down.

### Command line

```bash
dsh-proxy peers              # detection result: which port can be borrowed, how long it took
dsh-proxy peers --json       # the same, as JSON
dsh-proxy --no-borrow -- cmd # skip borrowing for this run, insist on our own kernel
```

Borrowing is a **normal state, not an error**: no exit code, nothing blocked.

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

`port` defaults to **`7899`**, deliberately not 7890 (see
[Borrowing an existing proxy](#borrowing-an-existing-proxy)).

`resident` defaults to **`false`** — i.e. the plugin's original behaviour,
**shut down when done**. Turn it on for resident mode (never auto-shutdown when idle;
exits with DSH).

Settings are read through a **whitelist filter** over exactly these keys, so dead
keys left behind by older versions (say `systemProxy`, from the era when the plugin
took over the system proxy) stay in the file without ever being read.

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

> **Why are the state files `.state` and not `.json`?**
>
> The host watches the plugin directory, and its plugin watcher **only reacts to `.json`** (a 21-extension matrix measured with the real thing: `.state`/`.log`/`.txt`/`.dat`/`.lock`/`.yaml`/`.pid`… none of them trigger, **only `.json` does** — including `.json` inside subdirectories). One trigger means a full hot reload: **the old instance is disposed first, then the new one is applied**.
>
> So as long as a state file is named `.json`, every write rebuilds the plugin, and half-written state gets read by another instance. Renaming to `.state` means the hot reload **never happens at all**, so the race disappears at its root. Leftover `.json` files from older versions are migrated automatically on startup (`migrateStateFiles()`) and then deleted.

## HTTP API

Everything listens on **loopback only** (`127.0.0.1` / `::1`); other origins get 403.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-proxy/status` | kernel running?, PID, **exit port `exitPort`, whether borrowing `borrowed`**, seconds remaining |
| GET | `/dsh-proxy/settings` | read settings + current config summary |
| POST | `/dsh-proxy/settings` | write settings |
| GET | `/dsh-proxy/proxies` | list groups and nodes (add `?fake=1` to include the informational pseudo-nodes) |
| POST | `/dsh-proxy/proxies/select` | `{"group":"...","node":"..."}` — switch node, then **read back to confirm** |
| POST | `/dsh-proxy/proxies/test` | `{"group":"...","timeoutMs":3000}` — test delay |
| POST | `/dsh-proxy/proxies/connectivity` | `{"node":"..."}` or `{"nodes":[...]}` — actually send one request through that node (**endpoint only; there is no button in the UI** — little diagnostic value, easily misread as "the network is broken") |
| POST | `/dsh-proxy/prepare` | download kernel + prepare config |
| POST | `/dsh-proxy/start` | start the kernel (borrows instead when a local proxy exists; the response carries `borrowed: true`) |
| POST | `/dsh-proxy/stop` | stop the kernel (only what we started; a borrowed one is left alone) |
| POST | `/dsh-proxy/renew` | renew the idle timer |
| POST | `/dsh-proxy/config/from-subscription` | `{"url":"..."}` — fetch a subscription |
| POST | `/dsh-proxy/config/import-flclash` | import from local FlClash |
| POST | `/dsh-proxy/config/manual` | `{"text":"..."}` — write a config by hand |
| GET | `/dsh-proxy/config/example` | get a template |
| POST | `/dsh-proxy/fetch` | `{"url":"https://..."}` — fetch once through the proxy |
| GET | `/dsh-proxy/peers` | borrow-detection status (add `?force=1` to bypass the cache) |
| POST | `/dsh-proxy/peers/clear-cache` | invalidate the borrow-detection cache and re-probe |

**There is no system-proxy endpoint and no game endpoint.** All endpoints listen on
loopback only, and there is no "blocked → 409" path either: borrowing is a normal
state, and the worst case is simply starting one extra kernel of our own — the proxy
is always available. A failing request is a plain 500.

> **`/fetch` must use `exitPort()`, not the configured port.** While borrowing the
> exit is **the borrowed one** (usually 7890); sending the request to the configured
> 7899 would hit a port nobody is listening on. The response body carries `via` (the
> actual `127.0.0.1:<port>` used) and `borrowed` (whether this request went through
> someone else's proxy) — those two fields are where you look when debugging.

> **`/fetch` always sends a `User-Agent`.** GitHub's REST API requires a UA on
> **every** request and answers **403** without one (`Request forbidden by
> administrative rules...`) — that is **not** rate limiting. And the most common use
> of `/fetch` is exactly fetching `api.github.com` (the curl example above is one),
> so it always sends
> `dsh-proxy-on-demand (+https://github.com/xfgil/dsh-proxy-on-demand)`.

## How it works

### Auto-shutdown: lease + guard

```
any use ──renew()──> write lease.state { deadline: now + idleMs }
                          │
guard timer (every 15s) ──┘
   are we borrowing? ──yes──> return immediately (no lease written, and someone else's kernel is never "shut down")
        │no
   does a command hold the busy lock? ──yes──> never shut down (busy.state, liveness by PID)
        │no
   deadline passed? ──no──> keep sleeping
        │yes
        └─> did **we** start the kernel? ──no──> drop the lease only, leave the process alone
                 │yes
                 └─> kill the PID in core.pid, delete pid/lease/busy files
```

Four deliberate decisions:

1. **Only kill the PID we started.** The state file records `core.pid`; it never
   kills by process name — that would risk killing the user's own FlClash or
   another mihomo.
2. **Never fight for the port.** If our own port is already listened on by another
   program, the plugin starts no kernel, just notes it and stays usable, and it
   **will not** shut down that process when it goes idle either. The more common case
   is [borrowing](#borrowing-an-existing-proxy): someone else's proxy runs on 7890 and
   the plugin doesn't touch even its own port.
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
   the kernel running, which is exactly what this plugin exists to prevent. (Not
   while borrowing: there is no kernel of ours to wait on and nobody needs to shut
   anything down, so `dsh-proxy start` prints one line and returns.)

### Where the borrow hook sits

Borrow detection runs only on the **start path** and never disturbs a kernel that is
already running:

```
POST /start ─┐
POST /fetch ─┼─> ensureAndStart() ─> core.ensureRunning()
CLI -- cmd  ─┘                            │
                                       our own kernel already alive? ──yes──> renew lease, return (no probing)
                                           │no
                                       a proxy we can borrow? ──yes──> use its exit; start no kernel
                                           │no
                                       our own port taken by someone? ──yes──> use it, also start no kernel
                                           │no
                                       core.start()  ← the only branch that starts a kernel
```

The borrow decision is injected into `core` as a **closure callback** instead of
having `core.js` `import peers.js` directly — that way `core.js` only deals with
process lifecycle, the probing policy stays in the layer above, and it can be tested
on its own:

```js
// lib/index.js: the host side borrows directly, leaving it to core to decide when to ask
const borrowFn = async ({ ownPort } = {}) => findBorrowableProxy({
  ownPort: Number.isInteger(ownPort) ? ownPort : user.port,
});

// bin/dsh-proxy.mjs: the CLI adds one more switch (--no-borrow passes null and closes this path entirely)
const borrowPort = opts.noBorrow ? null : ({ ownAlive } = {}) => findBorrowableProxy({
  ownPort: port,
  force: ownAlive !== true,
});
```

`ownPort` must be computed by `core` and passed down — the layer above has no way to
know whether the listener on that port is ourselves. When probing fails the callback
returns `null` and `core` treats it as "nothing to borrow" and starts its own kernel:
**better to start one extra kernel than to have a bug in the probing code make the
proxy unusable for good**.

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
const SEP = '\\\\\\\\?';   // a regex matching one or two literal backslashes
```

## Download notes

The plugin's only network download is **fetching the proxy kernel**; there is nothing
else.

| | |
|---|---|
| What | the `mihomo-windows-amd64` binary (the upstream stock mihomo kernel, not FlClash's customized build) |
| Size | about **61MB** (version measured: `v1.19.32`) |
| From where | the official GitHub Release of [MetaCubeX/mihomo](https://github.com/MetaCubeX/mihomo), `/releases/latest` by default; pin a version with the `kernelVersion` config key |
| Where it lands | `<plugin directory>/runtime/mihomo.exe` |
| When | the first time a proxy is really needed (`prepare` / `start` / `fetch` / `-- <command>`). **It never downloads behind your back while you install the plugin** |
| Skipping it | set `autoDownload: false` in the config and place the kernel at `runtime/mihomo.exe` yourself. After that the plugin performs no download at all |
| Removing it | just delete `<plugin directory>/runtime/` — kernel, config, rules and state files all live inside; nothing is left on disk |

**Mirror fallback.** A direct `github.com` release download **hangs** from mainland
China (TCP connects, the request goes out, the response never arrives) instead of
failing fast. So the plugin tries several sources in order, each with a
**12-second first-byte timeout**, moving on when it expires:

| Order | Source |
|---|---|
| 1 | direct `github.com` |
| 2 | `https://gh-proxy.com/` |
| 3 | `https://ghproxy.net/` |
| 4 | `https://ghfast.top/` |

When the download finishes it is unzipped locally (zip) and only `mihomo.exe` is
taken. Afterwards it **works offline** and never goes online again.

> Apart from downloading the kernel, the plugin itself never initiates an outbound
> connection — fetching pages is something **you** ask it to do (`/fetch` or
> `-- <command>`), not something it starts on its own. Borrow detection only
> connects to `127.0.0.1`.

## Upstream

This plugin ships **no** proxy kernel — it only starts and stops one. The actual
proxy comes from upstream:

| | |
|---|---|
| Project | [mihomo](https://github.com/MetaCubeX/mihomo) (the Clash.Meta core) |
| Copyright | © MetaCubeX and mihomo contributors |
| License | **GPL-3.0** (independent of this repo's MIT) |
| Relationship | Downloads the `mihomo-windows-amd64` binary from its official GitHub Release only. **Not modified, not repackaged, not statically linked**; invoked as a separate process |
| Version tested | `v1.19.32` (`Mihomo Meta v1.19.32 windows amd64 with go1.26.8`), ~61MB |
| Version policy | `/releases/latest` by default; pin with the `kernelVersion` config key |

Upstream's license, behaviour and security are upstream's responsibility. If you
redistribute this plugin, note that **downloading** a GPL-3.0 program and
**redistributing** it are different things — this repo only does the former.

## Known limitations

- **Windows first.** The kernel asset name is hard-coded to
  `mihomo-windows-amd64`. Porting means editing `prepareKernel()` in `lib/index.js`.
- **The first run downloads the kernel over the network** (~61MB). Once cached in
  `runtime/` it works offline. See [Download notes](#download-notes).
- **It does not start its own kernel when its own port (7899 by default) is taken.**
  Deliberate: better to reuse the proxy already listening than to fight for the port.
- **The node panel and node switching are unavailable while borrowing.** Listing and
  switching nodes go through mihomo's management API, and the borrowed kernel's
  controller address and secret don't match. In that state the UI says "borrowing"
  and greys out the kernel switch rather than pretending it can operate. To switch
  nodes, quit the other proxy first, or use `--no-borrow` to make the plugin start
  its own kernel.
- **Borrow detection looks at ports only, not software identity.** Deliberate (see
  [Borrowing an existing proxy](#borrowing-an-existing-proxy)). It doesn't cover the
  two cases of "proxy software is open but not listening on a port yet" and "TUN
  mode, which listens on no port"; in those cases this plugin starts its own 7899
  kernel as usual (nothing borrowed) at the cost of one more process, and it **will
  not** touch the other side.
- **`settings.state` and `config.yaml` are stored separately.** Changing the
  subscription won't lose your switches and port settings; conversely, editing
  `config.yaml` by hand won't sync into the UI beyond the node count it displays.
- **Tested only on Windows 10/11 x64 + DSH 0.2.0-rc.2.**
- **It does not decide for you whether a proxy should be used right now.** While
  gaming, or with another proxy running, it never refuses to work — the worst case is
  starting one extra kernel of its own. That judgement stays with you.
- **It never changes the system proxy.** There is no system-proxy switch on the
  panel and the plugin writes no registry. To send traffic through the proxy, set
  `HTTP_PROXY` yourself or use your own proxy client.

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
