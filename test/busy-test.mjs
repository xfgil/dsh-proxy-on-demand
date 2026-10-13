// 忙锁 + 长命令续租的回归测试。
//
// 场景：idle 只有 3 秒，但命令要跑 10 秒才发请求。修复前守护会在第 3 秒就把
// 内核杀掉，命令最后一步必然连接被重置；修复后命令期间持忙锁，内核必须活着。
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'dsh-proxy.mjs');
const NODE = process.execPath;

let pass = 0, fail = 0;
const ok = (c, m, extra = '') => { c ? (pass++, console.log(`PASS ${m}${extra ? ' ' + extra : ''}`)) : (fail++, console.log(`FAIL ${m}${extra ? ' ' + extra : ''}`)); };

// 子命令：先睡 10 秒，再经代理取出口 IP —— 用 node 自己发请求，避免依赖 curl
const probe = `
const t0 = Date.now();
await new Promise((r) => setTimeout(r, 10000));
const tls = await import('node:https');
const body = await new Promise((res, rej) => {
  const rq = tls.request({ host: 'api.ipify.org', port: 443, path: '/', method: 'GET',
    proxy: undefined, agent: undefined, timeout: 30000,
    // 走 http 代理必须先 CONNECT 建隧道
    createConnection: undefined }, (r) => { let s=''; r.on('data',(c)=>s+=c); r.on('end',()=>res(s)); });
  rq.on('error', rej); rq.end();
});
console.log('PROBE ' + body.trim() + ' after ' + Math.round((Date.now()-t0)/1000) + 's');
`;

// 用 curl 更简单可靠（Windows 自带 curl 走 HTTP_PROXY/CONNECT）
const run = (args, opts = {}) => new Promise((res) => {
  const p = spawn(NODE, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('exit', (c) => res({ code: c, out, err }));
});

console.log('=== 场景：--idle 3，命令先睡 10 秒再取 IP（命令时长 > idle）===');
const t0 = Date.now();
// ping 11 次 ≈ 10 秒，且不像 `timeout /t` 那样需要 stdin（重定向会被它拒绝）
const r = await run(['--idle', '3', '--', 'cmd', '/c', 'ping -n 11 127.0.0.1 >nul & curl.exe -sS --max-time 25 https://api.ipify.org']);
const secs = Math.round((Date.now() - t0) / 1000);

console.log('--- stderr ---\n' + r.err.trim());
console.log('--- stdout ---\n' + r.out.trim());

ok(r.code === 0, '1 命令退出码为 0', `(code=${r.code}, ${secs}s)`);
const ip = r.out.trim().split(/\s+/).pop();
ok(/^\d+\.\d+\.\d+\.\d+$/.test(ip), '2 命令拿到了出口 IP（内核全程存活）', `(ip=${ip})`);
ok(!/ConnectionReset|10054|10061|无法连接|拒绝/.test(r.out + r.err), '3 没有连接被重置');

// 内核应当已被自动关掉（用完自动关的承诺）
await sleep(1500);
let pid = null;
try { pid = JSON.parse(await readFile(join(ROOT, 'runtime', 'core.pid'), 'utf8')).pid; } catch { /* 已清理 */ }
ok(pid === null, '4 内核已按空闲策略自动关闭（core.pid 已清理）');
ok(/内核已按空闲策略自动关闭/.test(r.err), '5 日志确认自动关闭');

// 忙锁文件也不应残留
let busy = null;
try { busy = await readFile(join(ROOT, 'runtime', 'busy.json'), 'utf8'); } catch { /* 已清理 */ }
ok(busy === null, '6 忙锁已释放');

console.log(`\nBUSYTEST: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
