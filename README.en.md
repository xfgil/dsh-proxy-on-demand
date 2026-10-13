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
| [`dsh-onebot-guard`](https://github.com/xfgil/dsh-onebot-guard) — QQ channel outbound gate |

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

The profile manifest (`dsh.profile.bundles`) is updated for you, and the host's
HMR picks up the change and reconciles — the plugin is live **without a restart**.

> Installing by hand also works: add
> `"dsh-proxy-on-demand": "link:D:/path/to/plugins/dsh-proxy-on-demand"` to the profile's
> `package.json`, add `"dsh-proxy-on-demand"` to the `dsh.profile.bundles` array,
> then create a link to the plugin directory inside the profile's `node_modules`
> (`mklink /J` or a symlink — either works).

## Usage

### Inside DSH

Once installed, a card appears under **Settings → Plugins → On-demand proxy**
(see below). The HTTP API is also available:

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
dsh-proxy -- <command> [args...]     # run one command through the proxy
```

The last form is the common one:

```bash
dsh-proxy -- git clone https://github.com/some/repo
dsh-proxy --idle 0 -- curl.exe -sS https://api.ipify.org    # shut down right after
dsh-proxy --idle 600 -- npm install                          # stay up for 10 idle minutes
```

It injects into the child process:

| Variable | Value |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` | `http://127.0.0.1:<port>` |
| `NO_PROXY` | `localhost,127.0.0.1,::1,192.168.*,10.*,172.16.*` |

`NO_PROXY` matters — without it, even local services (like DSH's own 19387) would
be routed through the proxy.

## Settings UI

After installing, **Settings → Plugins** shows an "On-demand proxy" card with
three sections:

**Status** — running / port taken / stopped; kernel PID; seconds left until
auto-shutdown; buttons for *start now*, *stop now* and *renew idle timer*.
Refreshes every 4 seconds.

**Nodes** — three ways to supply a config:

| Method | What it does |
|---|---|
| Subscription URL | Paste and click *Fetch subscription*; the plugin downloads it and rewrites paths |
| Import from FlClash | Reads your local FlClash `config.yaml` and rewrites rule-provider absolute paths to relative ones |
| Paste manually | Drop in a Clash/mihomo YAML directly |

**Parameters** — proxy port, idle timeout (seconds), enable/disable the plugin,
and whether to auto-import FlClash on first run. Changes apply immediately.

> A port change needs a kernel restart: *stop now*, then *start now*.

The UI **does not go through DSH's `settings` service**; it reads and writes the
settings file and talks to the plugin's own HTTP endpoints. See
[Implementation notes](#implementation-notes) for why.

## Configuration

The plugin's own settings live in `<plugin>/runtime/settings.json`:

```json
{
  "enabled": true,
  "port": 7890,
  "idleMs": 120000,
  "subscriptionUrl": "",
  "autoImportFlClash": true,
  "configSource": "flclash",
  "lastSyncAt": 1760000000000,
  "lastSyncNote": "已从 FlClash 导入（规则 44 条）"
}
```

The `runtime/` directory (excluded by `.gitignore`) holds runtime artifacts:

| File | Purpose |
|---|---|
| `mihomo.exe` | the kernel (downloaded on first use) |
| `config.yaml` | the config handed to the kernel |
| `providers/rules/` | rule-provider files |
| `settings.json` | the user settings above |
| `core.pid` | PID of the current kernel (used only to kill our own) |
| `lease.json` | the lease — "in use until" |
| `core.log` | kernel log |

## HTTP API

Everything listens on **loopback only** (`127.0.0.1` / `::1`); other origins get 403.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-proxy/status` | kernel running?, PID, seconds remaining |
| GET | `/dsh-proxy/settings` | read settings + current config summary |
| POST | `/dsh-proxy/settings` | write settings |
| POST | `/dsh-proxy/prepare` | download kernel + prepare config |
| POST | `/dsh-proxy/start` | start the kernel |
| POST | `/dsh-proxy/stop` | stop the kernel |
| POST | `/dsh-proxy/renew` | renew the idle timer |
| POST | `/dsh-proxy/config/from-subscription` | `{"url":"..."}` — fetch a subscription |
| POST | `/dsh-proxy/config/import-flclash` | import from local FlClash |
| POST | `/dsh-proxy/config/manual` | `{"text":"..."}` — write a config by hand |
| GET | `/dsh-proxy/config/example` | get a template |
| POST | `/dsh-proxy/fetch` | `{"url":"https://..."}` — fetch once through the proxy |

## How it works

### Auto-shutdown: lease + guard

```
any use ──renew()──> write lease.json { deadline: now + idleMs }
                          │
guard timer (every 15s) ──┘
   deadline passed? ──no──> keep sleeping
        │yes
        └─> did **we** start the kernel? ──no──> drop the lease, leave the process alone
                 │yes
                 └─> kill the PID in core.pid, delete pid/lease files
```

Three deliberate decisions:

1. **Only kill the PID we started.** The state file records `core.pid`; it never
   kills by process name — that would risk killing the user's own FlClash or
   another mihomo.
2. **Never fight for the port.** If 7890 is already listening (say the user has
   FlClash open), the plugin does not start a kernel; it marks the state
   `external`, keeps working, and **will not** shut down a process it doesn't own.
3. **The CLI waits it out.** The guard timer is `unref()`'d (it doesn't keep Node
   alive), so `dsh-proxy start` stays in the foreground until the kernel is
   actually auto-shut-down — otherwise the command would exit and nobody would be
   left to run the "kill on expiry" step.

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
- **`settings.json` and `config.yaml` are stored separately.** Changing the
  subscription won't lose your switches and port settings; conversely, editing
  `config.yaml` by hand won't sync into the UI beyond the node count.
- **It does not take over the system proxy.** The plugin only exposes a local HTTP
  proxy port; setting `HTTP_PROXY` is the caller's business.

## Implementation notes

A few decisions that aren't obvious:

**The UI does not depend on the `settings` service.** The usual approach is
`ctx.settings.installSection(ctx, NS, Config, defaults, hooks)` on the host side,
where `Config` is a `z.object({...})` from `@deepseek-ai/schemastery`. But
`schemastery` often doesn't resolve on the profile side (on this machine the
package has `LICENSE`/`package.json`/`README.md` but **no `lib`**). Exporting a
non-schema object makes the loader throw while projecting config. So the UI talks
to the plugin's own HTTP endpoints, and the host side just reads and writes
`settings.json`.

**No `Config` schema is exported.** Same reason.

**Stats live on `globalThis[Symbol.for(...)]`.** A hot reload re-executes the
module's top level, zeroing ordinary module-level variables; a Symbol key on
`globalThis` survives reloads.

**The client half needs no bundling.** `package.json` declares
`dsh.client = { platform: "web", inject: [...] }`, and the entry `lib/client.js`
is a `window.__ModuleLoader__.load({ id, factory })` form that `require("react")`s
internally and exports `apply` / `inject` / `name`.

**It registers into the `settings.plugin.item` slot**, which appears under
Settings → Plugins:

```js
ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
  name: 'settings.plugin.item',
  id: 'dsh-proxy-on-demand-settings',
  key: 'dsh-proxy-on-demand',
  order: 60,
}, Card));
```

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
node test/dl-test.mjs              # kernel download only (fast)
node test/selftest.mjs             # end-to-end: import config → download → start → go abroad → idle shutdown
```

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
