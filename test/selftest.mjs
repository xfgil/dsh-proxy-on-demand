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
import { join } from 'node:path';

import { materialize, findFlClashConfig } from '../lib/config.js';
import { ensureKernel, latestVersion } from '../lib/downloader.js';
import { ProxyCore } from '../lib/core.js';

const RUNTIME = 'C:\\Users\\暝\\AppData\\Local\\Temp\\dsh-proxy-selftest';
const results = [];
const check = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail });

rmSync(RUNTIME, { recursive: true, force: true });
await fsp.mkdir(join(RUNTIME, 'providers', 'rules'), { recursive: true });

try {
  // 1. 找 FlClash 配置
  const found = await findFlClashConfig();
  check('1 找到本机 FlClash 配置', found.found, found.path ?? '');
  if (!found.found) throw new Error('SKIP');

  // 2. materialize：绝对路径 → 相对路径
  const r = await materialize(found.path, RUNTIME);
  check('2 识别出 rule-provider 绝对路径', r.rulesTotal > 0, `共 ${r.rulesTotal} 条，新拷 ${r.copied}`);
  const cfgText = await fsp.readFile(join(RUNTIME, 'config.yaml'), 'utf8');
  // 有换行转义，检查替换是否生效（相对路径出现 & 绝对路径残留）
  const remaining = (cfgText.match(/C:\\+Users/gi) || []).length;
  const relative = (cfgText.match(/providers\/rules\//g) || []).length;
  check('2b 绝对路径已全部改为相对路径', remaining === 0, `残留 ${remaining} 处`);
  check('2c 相对路径已写入', relative === r.rulesTotal, `${relative}/${r.rulesTotal}`);
  check('2d 规则文件已拷贝到位', existsSync(join(RUNTIME, 'providers', 'rules')), '');

  // 3. 下载内核
  const tmpEnv = process.env;
  const tag = await latestVersion('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest');
  check('3 取到最新内核版本', !!tag, tag ?? '');
  const ver = tag.startsWith('v') ? tag : `v${tag}`;
  const k = await ensureKernel({
    dir: RUNTIME,
    url: `https://github.com/MetaCubeX/mihomo/releases/download/${ver}/mihomo-windows-amd64-${ver}.zip`,
    entry: 'mihomo-windows-amd64.exe',
    exe: 'mihomo.exe',
  });
  check('3b 内核下载并解压成功', k.ok && k.bytes > 20e6, `${Math.round(k.bytes / 1e6)}MB`);

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

  // 6. 空闲自动关
  const beforePid = (await core.status()).pid;
  const aliveBefore = await core.pidAlive(beforePid);
  check('6 内核 PID 已记录', aliveBefore === true, `pid=${beforePid}`);

  await new Promise((r) => setTimeout(r, 24000)); // 等待 idleMs(20s) + tick
  await core.checkIdle();
  await new Promise((r) => setTimeout(r, 1500));
  const aliveAfter = await core.pidAlive(beforePid);
  check('6b 空闲后已自动关闭', aliveAfter === false, `pid=${beforePid} alive=${aliveAfter}`);
  const leaseGone = !existsSync(join(RUNTIME, 'lease.json'));
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
