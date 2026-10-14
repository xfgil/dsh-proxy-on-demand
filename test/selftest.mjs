#!/usr/bin/env node
/**
 * dsh-proxy-on-demand 端到端自测（不联网发消息，只在本机跑通链路）。
 *
 * 用真实的 FlClash 配置验证：
 *   1. materialize 能把绝对路径改成相对路径（含双反斜杠陷阱）
 *   2. ensureKernel 能下载并解压出内核
 *   3. ProxyCore 能真正拉起内核、端口可用
 *   4. 代理真的能出国
 *   5. 空闲后自动关闭（只杀自己的 PID）
 *
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证。
 * 自用免责：按「原样」提供、无担保，使用后果自负。
 * 自动安装提醒：**本测试会真的联网下载内核（约 61MB）**并真的启动进程。
 */
import { promises as fsp } from 'node:fs';
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createServer as createNetServer } from 'node:net';

import { materialize, findFlClashConfig, forceExternalController, forceDnsPort, readExternalController } from '../lib/config.js';
import { ensureKernel, latestVersion } from '../lib/downloader.js';
import { ProxyCore } from '../lib/core.js';
import { countProxies, countRules, configSummary, writeManualConfig } from '../lib/settings.js';
import { listProxies, testConnectivity, testGroupDelay, sampleActivity, FAILED_AT_MS } from '../lib/nodes.js';
import { buildRestoreScript } from '../lib/systemproxy.js';

const RUNTIME = 'C:\\Users\\暝\\AppData\\Local\\Temp\\dsh-proxy-selftest';
/** 管理 API 端口与密钥（自测专用；真实运行由 index.js 动态分配）。 */
const CTL_PORT = 9099;
const CTL_SECRET = 'selftest-secret';
const results = [];
const check = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail });

// 清掉上一轮的产物，但**保留已下载的内核**。
//
// 原来是 `rmSync(RUNTIME, {recursive:true})` —— 整目录删掉，于是每次自测都要
// 重新下载 61MB。后果是「验证插件逻辑」这件事被绑死在 GitHub 连通性上：
// 直连超时 / 镜像抽风时，步骤 3 抛一句 `aborted`，自测就停在 24/25，
// 而代码本身毫无问题（同一次改动，重跑可能 38/38 也可能 24/25）。
// 内核是下载产物、与逻辑无关，没理由每轮重下。
//
// 做法：先把内核挪到临时处，清完目录再挪回来 —— 让 `ensureKernel` 走缓存分支。
const KERNEL_EXE = join(RUNTIME, 'mihomo.exe');
const STASH = join(dirname(RUNTIME), 'dsh-proxy-selftest-kernel.bin');
const hadKernel = existsSync(KERNEL_EXE);
if (hadKernel) {
  await fsp.copyFile(KERNEL_EXE, STASH);
} else if (existsSync(STASH)) {
  console.log(`   [prep] 复用上次留存的内核（${Math.round((await fsp.stat(STASH)).size / 1e6)}MB），本轮不联网下载`);
}
rmSync(RUNTIME, { recursive: true, force: true });
await fsp.mkdir(join(RUNTIME, 'providers', 'rules'), { recursive: true });
if (existsSync(STASH)) await fsp.copyFile(STASH, KERNEL_EXE);

try {
  // 0. 纯离线：系统代理「还原脚本」的防线（只拼字符串，**不碰注册表**）
  //
  // 2026-10-13 真实事故：用户自定的 17 项绕过列表
  // （`*zhihu.com;*zhimg.com;*jd.com;...`，与 FlClash shared_preferences 里的
  //  bypassDomain 完全一致）被抹成了空。成因是**备份基线本身已被污染** ——
  //  备份里 `override` 就是空，于是每次「精确还原」都把空值写回去；而验证脚本
  //  逐字段比对备份与还原结果，两边都是空，反而**全部通过**，把问题掩盖了。
  //
  // 所以这里锁死一条规则：**空 override 绝不主动写回**。宁可留下我们写的自环
  // 保护项，也绝不把用户的绕过列表抹掉。断言直接查生成的脚本文本，
  // 比拿真注册表做实验安全得多。
  {
    const withOv = buildRestoreScript({
      enable: 1, server: 'x:1', override: 'a;b', autoConfig: '',
    });
    check('0a 非空绕过列表照常写回',
      withOv.includes("Set-ItemProperty -Path $k -Name ProxyOverride -Value 'a;b'"), '');

    const emptyOv = buildRestoreScript({
      enable: 1, server: 'x:1', override: '', overrideExisted: true, autoConfig: '',
    });
    check('0b 空绕过列表绝不写回（保留现值）',
      !emptyOv.includes('Set-ItemProperty -Path $k -Name ProxyOverride'),
      '备份被污染时不该拿空值覆盖用户的绕过列表');

    const neverHad = buildRestoreScript({
      enable: 1, server: 'x:1', override: '', overrideExisted: false, autoConfig: '',
    });
    check('0c 原本就没有该值时才删除它',
      neverHad.includes('Remove-ItemProperty -Path $k -Name ProxyOverride'), '');

    const legacy = buildRestoreScript({ enable: 0, server: '', override: '', autoConfig: '' });
    check('0d 老备份（无 overrideExisted 字段）既不写也不删',
      !legacy.includes('Set-ItemProperty -Path $k -Name ProxyOverride')
      && !legacy.includes('Remove-ItemProperty -Path $k -Name ProxyOverride'), '');

    check('0e 跳过绕过列表不影响其余字段照常还原',
      legacy.includes('-Value 0 -Type DWord')
      && legacy.includes('ProxyServer')
      && legacy.includes('AutoConfigURL'), '');
  }

  // 1. 找 FlClash 配置
  const found = await findFlClashConfig();
  check('1 找到本机 FlClash 配置', found.found, found.path ?? '');
  if (!found.found) throw new Error('SKIP');

  // 2. materialize：绝对路径 → 相对路径
  //
  // ⚠️ 必须传 controllerPort —— 否则 materialize 不会打开管理 API，
  // 后面「节点列表 / 选节点」就全废了（这正是 2026-10-13 那个事故的根因之一：
  // 导入的 FlClash 配置里 external-controller 是空串）。
  const r = await materialize(found.path, RUNTIME, {
    controllerPort: CTL_PORT, controllerSecret: CTL_SECRET,
  });
  check('2 识别出 rule-provider 绝对路径', r.rulesTotal > 0, `共 ${r.rulesTotal} 条，新拷 ${r.copied}`);
  const cfgText = await fsp.readFile(join(RUNTIME, 'config.yaml'), 'utf8');
  // 有换行转义，检查替换是否生效（相对路径出现 & 绝对路径残留）
  const remaining = (cfgText.match(/C:\\+Users/gi) || []).length;
  const relative = (cfgText.match(/providers\/rules\//g) || []).length;
  check('2b 绝对路径已全部改为相对路径', remaining === 0, `残留 ${remaining} 处`);

  // ── 2e/2f：节点数与规则数必须数得出来 ─────────────────────────────────────
  //
  // 这一节是 2026-10-13 事故的回归锁。原实现只认「`- ` 后紧跟 `name:`」和
  // 「`- ` 后紧跟规则类型」，而 mihomo / FlClash 写的是**规范化输出**：
  // 节点键按字母序重排（`hop-interval` 排在 `name` 前），规则条目带引号。
  // 结果两个计数**恒为 0** —— 界面显示「0 个节点」，用户看到的就是
  // 「节点根本导入不进去」，尽管 config.yaml 里明明有 143 个节点。
  {
    const summary = await configSummary(RUNTIME);
    check('2e 从真实 FlClash 配置数出节点数', summary.nodeCount > 0, `${summary.nodeCount} 个节点`);
    check('2f 从真实 FlClash 配置数出规则数', summary.ruleCount > 0, `${summary.ruleCount} 条规则`);

    // 规范化输出（键序打乱 + 规则带引号）也必须数对。
    const normalized = [
      'mixed-port: 7890',
      'proxies:',
      '  - hop-interval: 30',
      '    name: "节点甲"',
      '    server: 1.2.3.4',
      '    type: hysteria2',
      '  - name: "节点乙"',
      '    server: 5.6.7.8',
      '    type: trojan',
      '  - {name: "节点丙", server: 9.9.9.9, type: ss}',
      'proxy-groups:',
      '  - name: PROXY',
      '    type: select',
      'rules:',
      '  - "DOMAIN-SUFFIX,zoom.com.cn,DIRECT"',
      '  - DOMAIN,example.com,PROXY',
      '  - "AND,((NETWORK,UDP),(DST-PORT,443)),REJECT"',
      '  - MATCH,PROXY',
      '',
    ].join('\n');
    check('2g 键序打乱时仍数得对节点', countProxies(normalized) === 3, `得到 ${countProxies(normalized)}`);
    check('2h 规则带引号时仍数得对', countRules(normalized) === 4, `得到 ${countRules(normalized)}`);
    // 反例：没有 proxies: 段时必须是 0（别把 proxy-groups 的条目算进去）
    check('2i 没有 proxies 段 → 0', countProxies('mixed-port: 7890\nrules:\n  - MATCH,DIRECT\n') === 0);
    check('2j 没有 rules 段 → 0', countRules('mixed-port: 7890\nproxies:\n  - name: a\n') === 0);
  }
  check('2c 相对路径已写入', relative === r.rulesTotal, `${relative}/${r.rulesTotal}`);
  check('2d 规则文件已拷贝到位', existsSync(join(RUNTIME, 'providers', 'rules')), '');

  // ── 2k~2o：管理 API 与 DNS 端口（2026-10-13 事故的两个根因）──────────────
  //
  // 2k/2l 对应「没有节点列表、选不了节点」：导入的 FlClash 配置把
  // external-controller 写成空串，管理 API 根本没开。
  // 2n/2o 对应「测速全部超时」：DNS 端口 1053 被 FlClashCore 占着，
  // 内核 DNS 起不来 → 域名解析不了 → 任何节点都连不出去。
  {
    const t = await fsp.readFile(join(RUNTIME, 'config.yaml'), 'utf8');
    const ec = readExternalController(t);
    check('2k 配置里已打开管理 API', Number.isInteger(ec.port) && ec.port > 0, `port=${ec.port}`);
    check('2l 管理 API 只绑本机', ec.host === '127.0.0.1', ec.host);
    check('2m 已写入 secret', typeof ec.secret === 'string' && ec.secret.length > 0, `${ec.secret.length} 字符`);

    // forceExternalController 的纯函数行为（三种输入都要覆盖成唯一一条）
    const cases = [
      ['空串', 'external-controller: ""\nsecret: ""\n'],
      ['根本没有这一行', 'mixed-port: 7890\n'],
      ['写成别的端口', 'external-controller: 0.0.0.0:9999\n'],
    ];
    for (const [label, src] of cases) {
      const out = forceExternalController(src, 9099, 'SEC');
      const got = readExternalController(out.text);
      check(`2n external-controller 覆盖正确（${label}）`,
        got.port === 9099 && got.host === '127.0.0.1' && got.secret === 'SEC',
        `port=${got.port} host=${got.host}`);
      // 只应有一条，不能重复（重复会让内核解析失败）
      const n = (out.text.match(/^external-controller:/gm) || []).length;
      check(`2n2 只有一条 external-controller（${label}）`, n === 1, `找到 ${n} 条`);
    }

    // DNS 端口：不能插到文件开头（会把 YAML 打断），且必须落到 dns 段内
    const dnsSrc = '# 注释\nmixed-port: 7890\ndns:\n  enable: true\n  listen: 127.0.0.1:1053\n';
    const dnsOut = await forceDnsPort(dnsSrc, 1053);
    check('2o DNS listen 被改写', /^\s+listen: 127\.0\.0\.1:\d+$/m.test(dnsOut.text), dnsOut.text.split('\n').find((l) => /listen:/.test(l)) ?? '');
    check('2o2 DNS 没被插到文件开头', !/^dns:|^  listen:/.test(dnsOut.text.split('\n')[0]), dnsOut.text.split('\n')[0]);
    check('2o3 store-selected 被打开', /store-selected:\s*true/.test(t), '');

    // ── 2p/2q：另外两条写配置入口必须与 materialize 做同款修补 ──────────────
    //
    // 2026-10-13 漏过一次：`applySubscription` / `writeManualConfig` 只补了管理
    // API，忘了 DNS 端口 —— 走订阅或手贴配置的用户照样会撞上「1053 被 FlClash
    // 占着 → 内核 DNS 起不来 → 测速全超时」。
    // 2p 锁住修补生效，2q 锁住**没顺手篡改用户的测速目标**（那次误判的另一半）。
    {
      const dir = join(RUNTIME, 'manual-probe');
      await fsp.mkdir(dir, { recursive: true });
      // ⚠️ 冲突要**自己造**，不能指望环境里正好有人占着 1053。
      //
      // 这条断言原来写的是「m.dnsPort !== 1053」，直接假定 1053 被 FlClash
      // 占着。可 FlClash 一关、插件内核一停，1053 就是空闲的 —— 此时
      // pickFreePort(1053) 合法地返回 1053，断言就假失败（2026-10-13 实测
      // 39/40 就是这么来的）。「避开冲突」这件事只有在**冲突存在**时才可判，
      // 所以这里先自己绑一个 TCP 监听占住 1053，再验插件会让开。
      const squatter = createNetServer();
      const squatting = await new Promise((resolve) => {
        squatter.once('error', () => resolve(false));          // 已被别人占着更好，同样构成冲突
        squatter.listen(1053, '127.0.0.1', () => resolve(true));
      });
      let m = null;
      let mt = '';
      try {
        m = await writeManualConfig(dir, t);
        mt = await fsp.readFile(join(dir, 'config.yaml'), 'utf8');
      } finally {
        if (squatting) await new Promise((r) => squatter.close(r));
        else squatter.close();
      }
      const mListen = mt.split('\n').find((l, i) => /^\s+listen:/.test(l) && mt.split('\n').slice(0, i).some((x) => /^dns:\s*$/.test(x))) ?? '';
      check('2p 手动粘贴的配置也避开 DNS 端口冲突', /listen: 127\.0\.0\.1:\d+/.test(mListen) && m?.dnsPort !== 1053, `${mListen.trim()} (dnsPort=${m?.dnsPort}${squatting ? '，1053 由本测试占着' : '，1053 本来就被占着'})`);
      const gSrc = (t.match(/www\.gstatic\.com\/generate_204/g) || []).length;
      const gOut = (mt.match(/www\.gstatic\.com\/generate_204/g) || []).length;
      check('2q 没有篡改用户配置里的测速目标', gSrc === gOut, `${gSrc} 处 → ${gOut} 处`);
    }
  }

  // 3. 内核可执行文件就位（**缓存优先，不联网**）
  //
  // 原来是「先调 latestVersion() 查 GitHub API，再 ensureKernel()」，于是整个
  // 自测被绑死在 GitHub 连通性上：直连超时、镜像抽风、**未认证 api.github.com
  // 配额用尽（60 次/小时 —— 排查期间反复重跑必然触发，表现为所有源一起 403）**，
  // 任何一条都会让自测在第 3 步抛 `FAIL EXCEPTION`，而插件代码本身毫无问题。
  //
  // 内核是下载产物、与插件逻辑无关，没理由每轮都去问一次版本。已缓存就直接用；
  // 只有缓存真的缺失时才联网，那时才需要版本号。
  const kernelPath = join(RUNTIME, 'mihomo.exe');
  const cachedBytes = existsSync(kernelPath) ? (await fsp.stat(kernelPath)).size : 0;
  if (cachedBytes > 20e6) {
    check('3 复用已缓存的内核（不联网）', true, `${Math.round(cachedBytes / 1e6)}MB`);
    check('3b 内核可执行文件已就位', true, `${Math.round(cachedBytes / 1e6)}MB`);
  } else {
    const tag = await latestVersion('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest');
    check('3 取到最新内核版本', !!tag, tag ?? '');
    const ver = tag.startsWith('v') ? tag : `v${tag}`;
    const k = await ensureKernel({
      dir: RUNTIME,
      url: `https://github.com/MetaCubeX/mihomo/releases/download/${ver}/mihomo-windows-amd64-${ver}.zip`,
      entry: 'mihomo-windows-amd64.exe',
      exe: 'mihomo.exe',
      // 打印走的哪个源 —— 下载失败时这是唯一能看出"卡在哪一步"的线索
      // （之前它只报一句 "aborted"，完全无法定位）。
      onLog: (m) => console.log(`   [dl] ${m}`),
    });
    check('3b 内核下载并解压成功', k.ok && k.bytes > 20e6, `${Math.round(k.bytes / 1e6)}MB`);
  }

  // 4. 拉起内核（用 7891 避开可能占用的 7890）
  const port = 7891;
  const core = new ProxyCore({
    dir: RUNTIME, exe: 'mihomo.exe', config: 'config.yaml',
    port, idleMs: 20000, tickMs: 3000, log: (l, m) => console.log(`   [${l}] ${m}`),
  });
  // 改端口：直接改写生成的 config
  let t = await fsp.readFile(join(RUNTIME, 'config.yaml'), 'utf8');
  t = t.replace(/mixed-port:\s*\d+/, `mixed-port: ${port}`);
  // DNS 1053 可能被占，换掉以免干扰自测
  t = t.replace(/listen:\s*"?[0-9.]+:1053"?/, 'listen: "127.0.0.1:1054"');
  await fsp.writeFile(join(RUNTIME, 'config.yaml'), t, 'utf8');

  const started = await core.start();
  check('4 内核启动成功', started.started === true, `pid=${started.pid} ${started.ms}ms`);
  check('4b 端口已监听', await core.portUp(port), `port=${port}`);

  // 5. 代理真的能用
  const net = await import('node:net');
  const sockOk = await new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(2000, () => { s.destroy(); resolve(false); });
  });
  check('5 能连上代理端口', sockOk, '');

  // 真出国验证：https 必须先 CONNECT 建隧道，不能直接把 https 请求打给代理端口
  // （那样会因为 TLS 握手打在明文代理端口上而失败 —— 这不是插件的问题，是测试方法的问题）
  const https = await import('node:https');
  const net2 = await import('node:net');
  const ok = await new Promise((resolve) => {
    const s = net2.createConnection({ host: '127.0.0.1', port }, () => {
      s.write('CONNECT api.ipify.org:443 HTTP/1.1\r\nHost: api.ipify.org\r\n\r\n');
    });
    let buf = '';
    let upgraded = false;
    s.on('data', (chunk) => {
      if (upgraded) return;
      buf += chunk.toString('binary');
      if (!buf.includes('\r\n\r\n')) return;
      const head = buf.slice(0, buf.indexOf('\r\n\r\n'));
      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        resolve({ code: 0, err: 'tunnel: ' + head.split('\r\n')[0] });
        s.destroy();
        return;
      }
      upgraded = true;
      // 隧道建好，在其上发起真正的 TLS 请求
      const req = https.request({
        socket: s, agent: false, servername: 'api.ipify.org',
        host: 'api.ipify.org', path: '/', method: 'GET',
      }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ code: res.statusCode, ip: d.trim() }));
      });
      req.on('error', (e) => resolve({ code: 0, err: e.message }));
      req.setTimeout(20000, () => { req.destroy(); resolve({ code: 0, err: 'timeout' }); });
      req.end();
    });
    s.on('error', (e) => resolve({ code: 0, err: e.message }));
    s.setTimeout(25000, () => resolve({ code: 0, err: 'tunnel timeout' }));
  }).catch((e) => ({ code: 0, err: String(e.message) }));
  check('5b 走内核代理能出国（CONNECT 隧道）', ok.code === 200, `HTTP ${ok.code} ip=${ok.ip ?? ok.err}`);

  // ── 5c~5e：节点面板的后端（2026-10-13 新增）────────────────────────────
  //
  // 这一段是「节点列表 / 选节点 / 连通性测试」的真实验证：
  // 内核已在跑，所以能直接问管理 API，不必 mock。
  {
    const ep = readExternalController(await fsp.readFile(join(RUNTIME, 'config.yaml'), 'utf8'));
    const list = await listProxies(ep);
    check('5c 内核在跑时能读到节点', list.coreRunning === true && (list.nodes?.length ?? 0) > 0,
      `${list.nodes?.length ?? 0} 个节点 / ${list.groups?.length ?? 0} 个分组`);
    check('5d 节点里不含 DIRECT/REJECT 等内建项',
      !list.nodes?.some((n) => /^(DIRECT|REJECT)$/.test(n.name)), '');
    check('5e 信息伪节点已过滤',
      !list.nodes?.some((n) => /^(剩余流量|套餐到期|距离下次)/.test(n.name)), '');

    // 延迟语义（2026-10-13 用户报「全部超时」的回归锁）。
    //
    // 两个坑：
    //   ① `delay === 0` 是「**这一次**没测通」，不是「节点坏了」。实测 history
    //      常是 `246,0,197` —— 中间那次失败，前后都正常。旧面板把它渲染成红色的
    //      「超时」，用户以为 140 个节点全挂了。
    //   ② **`delay` 顶到 timeout 上限也是失败**。实测两种档位都有：
    //      `悦·🇸🇬新加坡2 · A` history `3000,2999,0`（3000 档打满）、
    //      `悦·🇦🇺澳大利亚2 · A` 末条 5000（5000 档打满）。旧代码把它们渲染成
    //      绿色的「3000 ms / 5000 ms」，语义正好反了。
    //      阈值是常数 4999 —— 因为 mihomo 的 `/proxies` **不回读 timeout 字段**，
    //      分组的真上限拿不到（实测全部自动测速分组都是 undefined）。
    const withDelay = (list.nodes ?? []).filter((n) => n.delay != null);
    check('5i 每个节点都带 failed 判据（界面不必自己猜 0 的含义）',
      (list.nodes ?? []).every((n) => typeof n.failed === 'boolean'),
      `${withDelay.length} 个节点有延迟值`);
    check('5j delay===0 判为失败',
      (list.nodes ?? []).every((n) => n.delay !== 0 || n.failed === true), '');
    check('5k delay 顶到超时上限同样判为失败（不能只判 0）',
      (list.nodes ?? []).every((n) => n.delay == null || n.delay < FAILED_AT_MS || n.failed === true),
      `阈值 ${FAILED_AT_MS}ms`);
    check('5l 正常延迟不误判为失败',
      (list.nodes ?? []).every((n) => !(n.failed === true && n.delay != null && n.delay > 0 && n.delay < FAILED_AT_MS)), '');

    // 连通性测试：真的以某个节点为出口发一次请求。
    // 不强求「必须有可用节点」—— 节点可用性取决于订阅本身，
    // 这里只验证**API 能调通、返回结构正确**（这才是我们能控制的部分）。
    const probe = list.nodes?.[0]?.name;
    if (probe) {
      const c = await testConnectivity(ep, probe, { timeoutMs: 8000 });
      check('5f 连通性测试能调通并返回结构',
        typeof c.ok === 'boolean' && typeof c.verdict === 'string',
        `${probe} → ${c.ok ? c.delay + 'ms' : c.verdict}`);
    }

    // 5m/5n：整组测延迟（2026-10-14 用户报「全部超时」的回归锁）。
    //
    // 根因：**Selector 分组不传 url 时，内核拿着空 url 去测**，每个成员都在
    // `urlToMetadata('')` 上判 "scheme not Support" → 整组 4ms 内全失败 →
    // 接口回 `504 all proxies timeout`。而面板点「测延迟」时操作的正是
    // **第一个可手选分组**（Selector），并且不传 url —— 于是那颗按钮 100% 失败，
    // 界面满屏「超时」。
    //
    // 这里**故意不传 url**，锁的就是这条路径：自动组无所谓（它们自己重写了
    // URLTest），但 Selector 必须靠我们补上目标。
    const sel = (list.groups ?? []).find((x) => x.selectable === true);
    if (sel) {
      const t0 = Date.now();
      const gr = await testGroupDelay(ep, sel.name, { timeoutMs: 4000 });
      const cost = Date.now() - t0;
      check('5m 整组测延迟（不传 url）不再全部失败', gr.ok === true,
        gr.ok ? `${sel.name} ← ${gr.url}（${cost}ms）` : `❌ ${gr.error}`);

      const after = await listProxies(ep);
      const grp = (after.groups ?? []).find((x) => x.name === sel.name);
      const names = new Set(grp?.members ?? []);
      const members = (after.nodes ?? []).filter((n) => names.has(n.name));
      const got = members.filter((n) => n.delay != null);
      // 阈值取一半：节点本身的可用性取决于订阅，但「全部超时」这个 bug
      // 下拿到延迟的成员恒为 0，与半数阈值差得很远，足以区分。
      check('5n 测延迟后成员拿到了延迟值', got.length >= Math.ceil(members.length / 2),
        `${got.length}/${members.length} 个成员有延迟`);
    }
  }

  // 5g/5h：自动续租（修「用 github 时关闭倒计时仍在继续」）
  //
  // 事故：租约只由 renew() 写入，而 renew 只在 CLI 命令里调用；浏览器走代理的
  // 流量插件感知不到 → 用户正用着，倒计时照样走完把内核杀了。
  // 修法：守护 tick 先问一次「代理还有没有流量」，有就自动续租。
  {
    let lastAct = null;
    const probeFn = async () => {
      const a = await sampleActivity(readExternalController(
        await fsp.readFile(join(RUNTIME, 'config.yaml'), 'utf8'),
      ), lastAct);
      lastAct = { up: a.up, down: a.down };
      return a;
    };
    // 首次采样只是建立基线，不算活跃
    const a0 = await probeFn();
    check('5g 活跃探测首次采样不算活跃', a0.active === false, a0.detail);
    // 结构必须对：有 up/down 才能做前后比较
    check('5h 活跃探测返回累计字节', Number.isFinite(a0.up) && Number.isFinite(a0.down), `up=${a0.up} down=${a0.down}`);
  }

  // 6. 空闲自动关
  // 注意：这里要把 activityWatch 摘掉 —— 否则一旦有流量就会自动续租，
  // 永远等不到「空闲关闭」，这条用例会误判为失败。
  core.activityWatch = null;
  const beforePid = (await core.status()).pid;
  const aliveBefore = await core.pidAlive(beforePid);
  check('6 内核 PID 已记录', aliveBefore === true, `pid=${beforePid}`);

  await new Promise((r) => setTimeout(r, 24000)); // 等待 idleMs(20s) + tick
  await core.checkIdle();
  await new Promise((r) => setTimeout(r, 1500));
  const aliveAfter = await core.pidAlive(beforePid);
  check('6b 空闲后已自动关闭', aliveAfter === false, `pid=${beforePid} alive=${aliveAfter}`);
  // 状态文件是 `.state` 不是 `.json` —— 见 lib/core.js 的说明：只有 `.json`
  // 会触发宿主热重载，所以哪怕只是「写个租约」也不能用 `.json`。
  const leaseGone = !existsSync(join(RUNTIME, 'lease.state'));
  check('6c 租约文件已清理', leaseGone, '');

  core.dispose();
} catch (e) {
  if (e.message === 'SKIP') {
    check('SKIPPED', false, '本机无 FlClash 配置，跳过');
  } else {
    check('EXCEPTION', false, String(e?.message ?? e));
  }
}

const pass = results.filter((r) => r.pass).length;
console.log('\n' + '='.repeat(64));
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  (' + r.detail + ')' : ''}`);
}
console.log('='.repeat(64));
console.log(`RESULT: ${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
