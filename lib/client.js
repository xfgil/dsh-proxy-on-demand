/**
 * dsh-proxy-on-demand / 客户端设置界面。
 *
 * 用途：在「设置」侧栏里多出一页「按需代理」，用来填节点、看状态、开关代理。
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
      }, []);

      useEffect(() => { void refresh(); }, [refresh]);
      useEffect(() => {
        const t = setInterval(() => { void refresh(); }, 4000);
        return () => clearInterval(t);
      }, [refresh]);

      const run = async (name, fn) => {
        setBusy(name); setErr(null); setMsg(null);
        try {
          const r = await fn();
          setMsg(r?.note || r?.message || '完成');
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
      // settings.json 是普通 JSON 文件，可能被手工改成 null；这里兜一下，
      // 否则 `subInput.trim()` 会抛 "Cannot read properties of null"。
      const sub = typeof subInput === 'string' ? subInput : '';
      const manualText = typeof manual === 'string' ? manual : '';

      return h('div', null,
        // ── 状态 ───────────────────────────────────────────────────────────
        h('div', { style: S.card },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('div', { style: { fontWeight: 600 } }, '按需代理'),
            h('span', { style: S.badge(alive || portUp) }, alive ? '运行中' : (portUp ? '端口被占用' : '未运行')),
          ),
          h('div', { style: S.hint },
            `内核：${alive ? `PID ${st?.pid}` : '未启动'}　端口：${cfg.port}　`,
            `空闲自动关：${Math.round((cfg.idleMs || 0) / 1000)} 秒`,
          ),
          h('div', { style: S.hint }, remainStr),
          st?.externalPort
            ? h('div', { style: S.hint }, `注意：${cfg.port} 端口已被其他程序占用（可能是 FlClash），本插件不会抢占。`)
            : null,
          h('div', { style: { ...S.row, marginTop: 10 } },
            h('button', {
              style: S.btnPrimary, disabled: !!busy,
              onClick: () => run('start', () => api('/start', { method: 'POST' })),
            }, busy === 'start' ? '启动中…' : '立即启动'),
            h('button', {
              style: S.btn, disabled: !!busy,
              onClick: () => run('stop', () => api('/stop', { method: 'POST' })),
            }, '立即关闭'),
            h('button', {
              style: S.btn, disabled: !!busy,
              onClick: () => run('renew', () => api('/renew', { method: 'POST' })),
            }, '续期空闲计时'),
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
                  return { note: `订阅已拉取：识别到 ${a.nodeCount ?? 0} 个节点` };
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
                  value: manualText, placeholder: 'mixed-port: 7890\nproxies:\n  - name: ...',
                  onChange: (e) => setManual(e.target.value),
                }),
                h('div', { style: { ...S.row, marginTop: 8 } },
                  h('button', {
                    style: S.btnPrimary, disabled: !!busy || !manualText.trim(),
                    onClick: () => run('man', async () => {
                      const r = await api('/config/manual', { method: 'POST', body: { text: manualText } });
                      return { note: `已保存（${r.nodeCount ?? 0} 个节点）` };
                    }),
                  }, '保存这份配置'),
                ),
              )
            : null,
        ),

        // ── 参数 ───────────────────────────────────────────────────────────
        h('div', { style: S.card },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '参数'),
          h('div', { style: S.grid },
            h('div', null,
              h('label', { style: S.label }, '代理端口'),
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
          ),
          h('div', { style: S.hint },
            '保存后立即生效。端口改动需要重启内核（先「立即关闭」再「立即启动」）。'),
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
