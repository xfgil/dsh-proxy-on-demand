/**
 * dsh-proxy-on-demand / 客户端设置界面。
 *
 * 定位：本插件是**给 Agent 用的工具**，界面只是「配置来源」（订阅 / 从 FlClash
 *   导入 / 手动粘贴）与状态查看的入口 —— 不是给用户日常使用的一整套客户端软件。
 *   历史上这里有过系统代理开关、游戏检测、礼让其它代理三整块，2026-10-16 全部移除：
 *   本插件**永不改 Windows 系统代理注册表**，也**不评判别的代理软件**。
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证。依赖的宿主接口：
 *   - 模块加载器 window.__ModuleLoader__.load({ id, factory })
 *   - client slot `settings.section`（设置侧栏里独立的一页）
 *   - 宿主侧 HTTP 端点（前缀 /dsh-proxy）
 *   换版本时这三处是首先要核对的。
 * 自用免责：按「原样」提供、无担保，使用后果自负。
 * 自动安装提醒：界面上的「拉取订阅 / 从 FlClash 导入 / 首次启动」都会触发
 *   内核自动下载（约 61MB），见 lib/downloader.js。
 *
 * 注册到 `settings.section`，在「设置」侧栏里多出一页（标签「按需代理」）。
 * 注意：早期版本这里写的是 `settings.plugin.item`，但本机 DSH 0.2.0-rc.2 的
 * slot 树里**不存在**该名字（实测 listSubTree 返回 available:false），
 * 于是整块界面静默不渲染。真实可用的是 `settings.section`（list，
 * 注册字段 id 必填 / order / label）——dsh-onebot-qq 与 dsh-workbuddy-xdpool
 * 用的都是它。
 *
 * 界面读写全部走宿主侧自有的 HTTP 端点（/dsh-proxy/*），**不依赖 settings
 * 服务的 configForms**：本机 profile 里的 schemastery 是个空壳（只有
 * README/LICENSE，没有 lib），依赖它会在别的机器上直接炸。自己走 HTTP
 * 既稳定，也让"从 FlClash 导入""填订阅"这类动作天然可用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-proxy-on-demand',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    /** 所有端点都挂在同一个前缀下。 */
    const BASE = '/dsh-proxy';

    /**
     * 节点列表一屏显示多少行，以及每行的高度（像素）。
     *
     * 容器高度 = NODE_ROWS * NODE_ROW_H，所以"单页 8 个"是**算出来的**而不是
     * 靠内容撑的 —— 后者会随字体/缩放在 7~9 之间漂，做不到稳定。
     * 28px 是"12px 字 + 上下呼吸"的舒适值，同时保证 8 行不会把设置页撑得太长。
     */
    const NODE_ROWS = 8;
    const NODE_ROW_H = 28;

    async function api(path, { method = 'GET', body } = {}) {
      const res = await fetch(BASE + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let j;
      try { j = JSON.parse(text); } catch { j = { ok: false, raw: text }; }
      if (!res.ok || j.ok === false) {
        throw new Error(j.error || j.reason || `HTTP ${res.status}`);
      }
      return j;
    }

    const S = {
      card: {
        border: '1px solid var(--dsh-border, #3a3a3a)',
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 12,
      },
      label: { fontSize: 13, opacity: 0.75, marginBottom: 4, display: 'block' },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 9px',
        borderRadius: 6, border: '1px solid var(--dsh-border, #3a3a3a)',
        background: 'var(--dsh-input-bg, transparent)', color: 'inherit', fontSize: 13,
      },
      btn: {
        padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
        border: '1px solid var(--dsh-border, #3a3a3a)',
        background: 'var(--dsh-btn-bg, transparent)', color: 'inherit',
      },
      btnPrimary: {
        padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
        border: '1px solid transparent', background: '#4B6EF5', color: '#fff',
      },
      row: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 },
      hint: { fontSize: 12, opacity: 0.6, marginTop: 4, lineHeight: 1.5 },
      notice: {
        fontSize: 12, lineHeight: 1.6, marginTop: 4,
        padding: '8px 10px', borderRadius: 6,
        border: '1px solid rgba(210,153,34,.45)', background: 'rgba(210,153,34,.10)',
      },
      err: { color: '#e5534b', fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap' },
      ok: { color: '#3fb950', fontSize: 12, marginTop: 6 },
      badge: (on) => ({
        display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 12,
        background: on ? 'rgba(63,185,80,.18)' : 'rgba(128,128,128,.18)',
        color: on ? '#3fb950' : 'inherit',
      }),
    };

    // ── 开关（toggle）组件 ─────────────────────────────────────────────────
    //
    // 用户原话（2026-10-13，附带一张 iOS 风格开关的截图）：
    //
    // > 「搞两个这种开关，不要摆三个大按钮在那」
    //
    // 于是状态卡里原先把「立即启动 / 停止内核 / 续期空闲计时」摆成三个大按钮
    // 的那一行，收成一个开关；系统代理那个按钮也换成同一种样式。
    //
    // **必须是无状态组件**：client-render-test.mjs 按 useState 的**位置**构造
    // 状态队列，组件里再塞 state 会把后面所有的索引顶乱。
    const toggleStyle = (on) => ({
      position: 'relative', flexShrink: 0,
      width: 44, height: 24, borderRadius: 12,
      border: 'none', padding: 0,
      background: on ? '#4B6EF5' : 'rgba(128,128,128,.35)',
      transition: 'background .15s',
      cursor: 'pointer',
    });
    const knobStyle = (on) => ({
      position: 'absolute', top: 3, left: on ? 23 : 3,
      width: 18, height: 18, borderRadius: '50%',
      background: '#fff',
      boxShadow: '0 1px 3px rgba(0,0,0,.35)',
      transition: 'left .15s',
      pointerEvents: 'none',
    });
    const Toggle = ({ on, disabled, busyNow, title, onClick }) => h('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': on === true,
      title: title || undefined,
      disabled: disabled === true,
      onClick,
      style: {
        ...toggleStyle(on === true),
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
      },
    }, busyNow
      ? h('span', {
          style: {
            position: 'absolute', inset: 0, display: 'flex',
            alignItems: 'center', justifyContent: 'center',
            fontSize: 10, color: '#fff',
          },
        }, '…')
      : h('span', { style: knobStyle(on === true) }));

    function Card() {
      const [st, setSt] = useState(null);
      const [cfg, setCfg] = useState(null);
      const [cfgInfo, setCfgInfo] = useState(null);
      const [busy, setBusy] = useState('');
      const [msg, setMsg] = useState(null);
      const [err, setErr] = useState(null);
      const [subInput, setSubInput] = useState('');
      const [manual, setManual] = useState('');
      const [showManual, setShowManual] = useState(false);
      // ── 节点面板 state ──────────────────────────────────────────────────
      // proxies: 宿主 GET /proxies 的结果（含 coreRunning 判定）
      // nodeBusy: 正在切换的节点名（该行显示半透明）
      //
      // 2026-10-13 用户裁决「只留滚动的列表，分组删光」+「把连通性删了留测延迟」，
      // 于是原先的 nodeGroup（分组下拉）、conn / testUrl（连通性）三个 state
      // 都成了死变量，一并删掉。
      //
      // 2026-10-16 再次收窄：游戏检测（含白名单 allowInput）、系统代理开关
      // （proxyBusy）、礼让三整块功能**整体从插件移除** —— 本插件回归「给 Agent
      // 用的工具」，不再接管系统代理、不再探测游戏、不再评判别的代理软件。
      // 见 README「为什么没有系统代理开关」。**state 顺序又变了**：
      //   st cfg cfgInfo busy msg err subInput manual showManual
      //   proxies nodeBusy          ← 现在共 11 个，nodeBusy 是索引 10
      // test/client-render-test.mjs 按位置构造队列，必须同步改。
      const [proxies, setProxies] = useState(null);
      const [nodeBusy, setNodeBusy] = useState('');

      const refresh = useCallback(async () => {
        try {
          const [s, c] = await Promise.all([api('/status'), api('/settings')]);
          setSt(s);
          setCfg(c?.settings ?? null);
          setCfgInfo(c?.config ?? null);
          const url = c?.settings?.subscriptionUrl;
          if (typeof url === 'string' && url) setSubInput((prev) => (prev ? prev : url));
        } catch (e) {
          setErr(String(e.message || e));
        }
        // 节点列表单独拉：**内核没跑时它是"未运行"而不是错误**，
        // 不能和上面那批一起 throw（否则整个面板会显示成报错）。
        try {
          const p = await api('/proxies');
          setProxies(p);
        } catch (e) {
          setProxies({ ok: false, coreRunning: false, reason: String(e.message || e) });
        }
      }, []);

      useEffect(() => { void refresh(); }, [refresh]);
      useEffect(() => {
        const t = setInterval(() => { void refresh(); }, 4000);
        return () => clearInterval(t);
      }, [refresh]);

      const run = async (name, fn, { settleMs = 0 } = {}) => {
        setBusy(name); setErr(null); setMsg(null);
        try {
          const r = await fn();
          setMsg(r?.note || r?.message || '完成');
          // 测延迟这类接口：内核返回时 history 还在异步落盘，立刻刷新会读到
          // **上一次**的旧值（面板上表现为「点了没反应」）。等一小会儿再刷。
          if (settleMs > 0) await new Promise((res) => setTimeout(res, settleMs));
          await refresh();
        } catch (e) {
          setErr(String(e.message || e));
        } finally {
          setBusy('');
        }
      };

      const save = (patch) => run('save', async () => {
        await api('/settings', { method: 'POST', body: patch });
        return { message: '设置已保存' };
      });

      if (!cfg) {
        return h('div', { style: S.card }, h('div', null, '加载中…'), err ? h('div', { style: S.err }, err) : null);
      }

      const alive = st?.coreAlive === true;
      const portUp = st?.portUp === true;
      const remain = st?.remainingMs ?? 0;
      const remainStr = remain > 0 ? `${Math.ceil(remain / 1000)} 秒后自动关闭` : '未计时（当前不在使用中）';
      // 常驻模式下内核不因空闲而关 —— 倒计时那行只在"非常驻"时才有意义。
      const resident = cfg?.resident === true;
      // 借道状态：本机已有别的代理在跑时，本插件**不启动自己的内核**，
      // 直接复用它的端口。st.borrowed 为真时 exitPort 就是被借用的那个。
      const borrowed = st?.borrowed === true;
      const exitPort = st?.exitPort ?? cfg.port;
      // settings.state 是普通 JSON 文件，可能被手工改成 null；这里兜一下，
      // 否则 `subInput.trim()` 会抛 "Cannot read properties of null"。
      const sub = typeof subInput === 'string' ? subInput : '';
      const manualText = typeof manual === 'string' ? manual : '';

      return h('div', null,
        // ── 状态 ───────────────────────────────────────────────────────────
        h('div', { style: S.card },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('div', { style: { fontWeight: 600 } }, '按需代理'),
            h('span', { style: S.badge(alive || portUp) }, alive ? '内核运行中' : (portUp ? '端口被占用' : '内核未运行')),
          ),
          h('div', { style: S.hint },
            `内核：${alive ? `PID ${st?.pid}` : (borrowed ? '未启动（借道中）' : '未启动')}　`,
            `出口：127.0.0.1:${exitPort}`,
            borrowed
              ? '（本机已有其它代理在跑，本插件直接借道，不抢端口、不起进程）'
              : `　自己的端口：${cfg.port}`,
          ),
          // 非常驻时才显示倒计时 —— 常驻下这行永远是"未计时"，只会让人困惑。
          borrowed || resident ? null : h('div', { style: S.hint }, remainStr),
          resident && !borrowed
            ? h('div', { style: S.hint }, '常驻运行（不会自动关闭，只有手动关或退出 DSH 才会停）')
            : null,

          // ── 内核开关 ────────────────────────────────────────────────────
          //
          // 原先这里摆着「立即启动 / 停止内核 / 续期空闲计时」三个大按钮，
          // 用户明确反对：「搞两个这种开关，不要摆三个大按钮在那」。
          // 现在就是一个开关 —— 开了就是启动，关了就是停止。
          h('div', {
            style: {
              marginTop: 10, padding: '10px 12px', borderRadius: 8,
              border: `1px solid ${alive ? 'rgba(63,185,80,.5)' : 'var(--dsh-border, #3a3a3a)'}`,
              background: alive ? 'rgba(63,185,80,.10)' : 'transparent',
            },
          },
            h('div', { style: { ...S.row, justifyContent: 'space-between' } },
              h('div', { style: { fontWeight: 600, fontSize: 13 } }, '代理内核',
                ' ',
                h('span', { style: { fontSize: 12, opacity: 0.75, fontWeight: 400 } },
                  alive ? '运行中' : (borrowed ? '借道中' : '已停止'))),
              h(Toggle, {
                on: alive,
                disabled: !!busy || borrowed,
                busyNow: busy === 'start' || busy === 'stop',
                title: borrowed
                  ? '正在借道本机已有的代理，不需要启动自己的内核'
                  : (alive ? '关掉 = 停止内核' : '打开 = 启动内核'),
                onClick: () => {
                  if (alive) run('stop', () => api('/stop', { method: 'POST' }));
                  else run('start', () => api('/start', { method: 'POST' }));
                },
              }),
            ),
            h('div', { style: S.hint },
              borrowed
                ? `本机已有代理在 127.0.0.1:${exitPort} 上待命，本插件借道使用，自己的内核保持关闭。`
                : (alive
                  ? '内核正在 127.0.0.1 上待命，用完会自动关掉。'
                  : '打开内核才会启动 mihomo。平时不需要开 —— 发一次联网请求它会自动拉起。')),
          ),
        ),

        // ── 节点配置 ───────────────────────────────────────────────────────
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '节点配置'),
          cfgInfo?.exists
            ? h('div', { style: S.hint },
                `当前配置：${cfgInfo.nodeCount ?? 0} 个节点，${cfgInfo.ruleCount ?? 0} 条规则，端口 ${cfgInfo.port ?? '-'}`,
                cfg.configSource ? `　来源：${cfg.configSource}` : '')
            : h('div', { style: S.hint }, '还没有配置，请用下面任一方式填入节点。'),

          h('div', { style: { marginTop: 12 } },
            h('label', { style: S.label }, '订阅地址（粘贴后点「拉取订阅」）'),
            h('input', {
              style: S.input, value: sub, placeholder: 'https://example.com/subscribe?token=...',
              onChange: (e) => setSubInput(e.target.value),
            }),
            h('div', { style: { ...S.row, marginTop: 8 } },
              h('button', {
                style: S.btnPrimary, disabled: !!busy || !sub.trim(),
                onClick: () => run('sub', async () => {
                  const r = await api('/settings', { method: 'POST', body: { subscriptionUrl: sub.trim() } });
                  const a = await api('/config/from-subscription', { method: 'POST', body: { url: sub.trim() } });
                  // 用后端拼好的 note：它知道内核有没有被重启（= 新配置是不是
                  // 立刻生效了），前端自己拼会漏掉这半句。
                  return { note: a.note || `订阅已拉取：识别到 ${a.nodeCount ?? 0} 个节点` };
                }),
              }, busy === 'sub' ? '拉取中…' : '拉取订阅'),
              h('button', {
                style: S.btn, disabled: !!busy,
                onClick: () => run('imp', async () => {
                  const r = await api('/config/import-flclash', { method: 'POST' });
                  return { note: r.note || `已从 FlClash 导入${r.nodeCount ? `（${r.nodeCount} 个节点）` : ''}` };
                }),
              }, busy === 'imp' ? '导入中…' : '从 FlClash 导入'),
              h('button', {
                style: S.btn, disabled: !!busy,
                onClick: () => setShowManual((v) => !v),
              }, showManual ? '收起手动粘贴' : '手动粘贴配置'),
            ),
            h('div', { style: S.hint },
              '「从 FlClash 导入」会读取本机 FlClash 的配置，并把规则文件的绝对路径自动改写为相对路径。'),
          ),

          showManual
            ? h('div', { style: { marginTop: 12 } },
                h('label', { style: S.label }, '直接粘贴 Clash/mihomo 配置'),
                h('textarea', {
                  style: { ...S.input, minHeight: 120, fontFamily: 'monospace', fontSize: 12 },
                  value: manualText, placeholder: 'mixed-port: 7899\nproxies:\n  - name: ...',
                  onChange: (e) => setManual(e.target.value),
                }),
                h('div', { style: { ...S.row, marginTop: 8 } },
                  h('button', {
                    style: S.btnPrimary, disabled: !!busy || !manualText.trim(),
                    onClick: () => run('man', async () => {
                      const r = await api('/config/manual', { method: 'POST', body: { text: manualText } });
                      return { note: r.note || `已保存（${r.nodeCount ?? 0} 个节点）` };
                    }),
                  }, '保存这份配置'),
                ),
              )
            : null,
        ),

        // ── 节点面板 ───────────────────────────────────────────────────────
        h('div', { style: S.card },
          h('div', { style: S.row },
            h('div', { style: { fontWeight: 600 } }, '节点选择'),
            h('span', { style: S.badge(proxies?.coreRunning === true) },
              proxies?.coreRunning === true
                ? `已连接（${proxies.nodes?.length ?? 0} 个节点）`
                : '内核未运行'),
          ),

          proxies?.coreRunning !== true
            ? h('div', { style: S.hint },
                '内核当前没有运行 —— 用上面的「代理内核」开关把它打开，这里就能选节点了。',
                '（也可以直接发一次需要联网的请求，插件会按需自动启动。）',
                proxies?.reason ? h('div', { style: { marginTop: 4, opacity: 0.75 } }, `（${proxies.reason}）`) : null)
            : (() => {
                const groups = proxies.groups ?? [];
                // 2026-10-13 用户原话：「只留滚动的列表，分组删光」。
                // 于是这里不再有分组下拉，也不再把「子分组」当成列表项显示 ——
                // 就是一个能滚的节点列表。操作目标固定落在**第一个可手选分组**
                // （Selector）上；订阅里的自动分组（URLTest/LoadBalance）不给选，
                // 但它的成员照样能看。
                const selectables = groups.filter((g) => g.selectable === true);
                const cur = selectables[0] ?? groups[0] ?? null;
                if (!cur) return h('div', { style: S.hint }, '配置里没有找到任何节点。');
                const nodeByName = new Map((proxies.nodes ?? []).map((n) => [n.name, n]));
                // 只列**真节点**：mihomo 允许分组嵌套，成员里会混进子分组名与
                // DIRECT/REJECT 这类内建策略 —— 它们天然没有延迟，混在列表里
                // 只会让人以为「这几个节点坏了」（用户就是这么被我坑过一次）。
                const members = (cur.members ?? []).filter((name) => nodeByName.has(name));
                return h('div', { style: { marginTop: 10 } },
                  h('div', { style: S.row },
                    h('button', {
                      style: S.btn,
                      disabled: !!busy,
                      title: '只测握手耗时，不验证能不能真正上网',
                      onClick: () => run('ntest', async () => {
                        const r = await api('/proxies/test', { method: 'POST', body: { group: cur.name } });
                        return { note: r.note || '已触发测速' };
                      }, { settleMs: 800 }),
                    }, busy === 'ntest' ? '测速中…' : '测延迟'),
                    h('button', {
                      style: S.btnPrimary,
                      disabled: !!busy,
                      title: '逐个真的发一次请求，挑一个能连出去的节点切过去。测的是「能不能上网」，不是延迟数字',
                      onClick: () => run('auto', async () => {
                        const r = await api('/proxies/auto-select', { method: 'POST', body: { group: cur.name } });
                        return { note: r.note || '已自动选点' };
                      }, { settleMs: 500 }),
                    }, busy === 'auto' ? '正在找可用节点…' : '自动选可用节点'),
                    h('div', { style: S.hint },
                      cur.selectable
                        ? `当前：${cur.now ?? '（未知）'}　·　点列表里的节点即可切换（切换后回读确认）`
                        : `这是 ${cur.type} 类型的分组，由内核自动决定，不能手动选。`),
                  ),

                  // 节点列表：竖排、**一屏正好 8 个**、超出滚动。
                  //
                  // 为什么固定行高而不是靠内容自然撑开：要"单页 8 个"就得让可视
                  // 高度精确等于 8 行，所以行高与容器高都由常量算出来（见 ROW_H），
                  // 不依赖字体度量 —— 否则不同缩放下会变成 7 个或 9 个。
                  h('div', {
                    style: {
                      marginTop: 8,
                      maxHeight: NODE_ROWS * NODE_ROW_H + 2,   // +2 给上下边框
                      overflowY: 'auto',
                      border: '1px solid var(--dsh-border, #3a3a3a)',
                      borderRadius: 8,
                    },
                  },
                    members.map((name) => {
                      const n = nodeByName.get(name);
                      const active = cur.now === name;
                      const delay = n?.delay;
                      const failed = n?.failed === true;
                      // 0 与「顶到 timeout 上限」都是失败，但**别叫它「超时」** ——
                      // 内核只记「这一次没测通」，节点多半是好的（实测 history 常是
                      // `246,0,197`：中间那次失败，前后都正常）。叫「超时」会让用户
                      // 以为节点坏了（2026-10-13 就是这么被坑的）。
                      const rightText = delay == null ? '未测速'
                        : (failed ? '未测通' : `${delay} ms`);
                      const rightColor = delay == null ? 'inherit'
                        : (failed ? '#e5534b' : '#3fb950');
                      const title = `${n.type}　延迟：${delay == null ? '未测速' : (failed ? `这次没测通（${delay}）` : delay + ' ms')}`;
                      return h('button', {
                        key: name,
                        title,
                        disabled: !cur.selectable || nodeBusy !== '' || !!busy,
                        onClick: () => {
                          setNodeBusy(name);
                          setErr(null); setMsg(null);
                          api('/proxies/select', { method: 'POST', body: { group: cur.name, node: name } })
                            .then((r) => {
                              setMsg(r.verified === false
                                ? `已切到「${name}」，但内核回读不一致（可能被自动分组覆盖）`
                                : `已切到「${name}」`);
                              return refresh();
                            })
                            .catch((e) => setErr(String(e.message || e)))
                            .finally(() => setNodeBusy(''));
                        },
                        style: {
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          gap: 8,
                          width: '100%', height: NODE_ROW_H, boxSizing: 'border-box',
                          padding: '0 10px',
                          textAlign: 'left',
                          fontSize: 12,
                          cursor: cur.selectable ? 'pointer' : 'default',
                          border: 'none',
                          borderBottom: '1px solid var(--dsh-border, #3a3a3a)',
                          background: active ? 'rgba(75,110,245,.20)' : 'transparent',
                          color: 'inherit',
                          opacity: nodeBusy === name ? 0.5 : 1,                        },
                      },
                        h('span', {
                          style: {
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            fontWeight: active ? 600 : 400,
                          },
                        },
                          (active ? '● ' : ''),
                          name),
                        h('span', {
                          style: { flexShrink: 0, opacity: delay == null ? 0.5 : 0.8, color: rightColor },
                        }, rightText),
                      );
                    }),
                  ),

                  h('div', { style: S.hint },
                    '延迟为空的表示还没测过（点「测延迟」）；「未测通」只表示这一次没连上，不代表节点坏了。',
                    proxies.hidden > 0
                      ? `　已隐藏 ${proxies.hidden} 个系统条目。`
                      : ''),
                );
              })(),
        ),

        // ── 参数 ───────────────────────────────────────────────────────────
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '参数'),
          h('div', { style: S.grid },
            h('div', null,
              h('label', { style: S.label }, '本插件内核的端口'),
              h('input', {
                style: S.input, type: 'number', value: cfg.port,
                onChange: (e) => setCfg({ ...cfg, port: e.target.value }),
                onBlur: () => save({ port: Number(cfg.port) }),
              }),
            ),
            h('div', null,
              h('label', { style: S.label }, '空闲多久自动关（秒）'),
              h('input', {
                style: S.input, type: 'number', value: Math.round(cfg.idleMs / 1000),
                onChange: (e) => setCfg({ ...cfg, idleMs: Number(e.target.value) * 1000 }),
                onBlur: () => save({ idleMs: Math.round(cfg.idleMs / 1000) * 1000 }),
              }),
            ),
          ),
          h('div', { style: S.hint },
            '默认 7899。故意不是 7890 —— 那是 FlClash / Clash 系的默认端口，',
            '撞在一起会把对方的内核顶掉。本机已有代理在跑时这个端口根本用不上（走借道）。',
          ),
          h('div', { style: S.row },
            h('label', { style: { ...S.label, display: 'flex', gap: 6, alignItems: 'center', margin: 0 } },
              h('input', {
                type: 'checkbox', checked: cfg.enabled !== false,
                onChange: (e) => save({ enabled: e.target.checked }),
              }),
              '启用插件',
            ),
            h('label', { style: { ...S.label, display: 'flex', gap: 6, alignItems: 'center', margin: 0 } },
              h('input', {
                type: 'checkbox', checked: cfg.autoImportFlClash !== false,
                onChange: (e) => save({ autoImportFlClash: e.target.checked }),
              }),
              '首次自动导入 FlClash 配置',
            ),
            h('label', { style: { ...S.label, display: 'flex', gap: 6, alignItems: 'center', margin: 0 } },
              h('input', {
                type: 'checkbox', checked: cfg.resident === true,
                onChange: (e) => save({ resident: e.target.checked }),
              }),
              '内核常驻（不因空闲自动关闭）',
            ),
          ),
          h('div', { style: S.hint },
            '保存后立即生效。端口改动需要重启内核（把「代理内核」开关关掉再打开）。'),
        ),

        // ── 消息 ───────────────────────────────────────────────────────────
        msg ? h('div', { style: S.ok }, msg) : null,
        err ? h('div', { style: S.err }, err) : null,

        // ── 关于 ───────────────────────────────────────────────────────────
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '关于'),
          h('div', { style: S.notice },
            h('div', null, '⚠ 首次使用会自动联网下载代理内核（约 61MB）到插件目录下的 runtime/。'),
            h('div', null, '不需要手动安装；删掉 runtime/ 目录即可完全清除，磁盘上不留残余。'),
          ),
          h('div', { style: { ...S.hint, marginTop: 10 } },
            h('div', null, '上游程序：mihomo（Clash.Meta 内核）© MetaCubeX，以 GPL-3.0 授权发布。'),
            h('div', null, '本插件不含内核二进制，只从上游官方 Release 下载并以独立进程调用，不修改、不重打包。'),
            h('div', null, '适用 DSH 版本：0.2.0-rc.2（Electron 44.0.0）。'),
            h('div', null, '命令行：'),
            h('code', null, 'dsh-proxy -- <命令> [参数...]'),
          ),
          h('div', { style: { ...S.hint, marginTop: 8 } },
            '自用工具，按「原样」提供、不附带任何担保。代理内核、节点与订阅的来源及合法性由使用者自行负责；',
            '请遵守所在地法律法规与所使用服务的条款。',
          ),
        ),
      );
    }

    const name = 'dsh-proxy-on-demand-client';
    const inject = ['slots'];

    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-proxy-on-demand',
          order: 60,
          // label 支持字符串或 thunk；用 thunk 是为了将来接 locale 时无需改结构。
          label: () => '按需代理',
          icon: 'settings',
        }, Card));
      } catch (e) {
        console.error('[dsh-proxy-on-demand] 设置界面挂载失败：', e);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
