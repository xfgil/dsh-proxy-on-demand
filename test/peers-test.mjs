/**
 * 代理礼让 —— 离线判定测试
 *
 * 用途：验证 lib/peers.js 的判定规则，**完全不碰真实网络**。
 *   判定核心 evaluatePeers() 是纯函数（吃构造的端口探测结果、吐结论），
 *   所以这里能精确覆盖每种组合，不受测试机上当时开着什么代理影响。
 *
 * 上游程序：本项目运行时会下载 mihomo（© MetaCubeX，GPL-3.0）；
 *   本测试文件不联网、不下载、不启动任何内核。
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2（Electron 44.0.0）。
 * 自动安装提醒：本测试**不会**触发内核下载。
 * 免责声明：自用工具，按现状提供；端口名单不可能覆盖所有代理软件。
 *
 * 运行：node test/peers-test.mjs
 */
import {
  COMMON_PROXY_PORTS, describePeer, evaluatePeers, PEER_DEFAULTS,
} from '../lib/peers.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`PASS ${pass + fail} ${name}${extra ? ` (${extra})` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`FAIL ${pass + fail} ${name}${extra ? ` (${extra})` : ''}`);
  }
}

/** 造一条端口探测结果。 */
const up = (port) => ({ port, up: true, ms: 1 });
const down = (port) => ({ port, up: false, ms: 1 });

console.log('=== 代理礼让 离线测试 ===\n');

// ── 1. 基础：都没人监听 → 不让路 ─────────────────────────────────
{
  const d = evaluatePeers({ ownPort: 7890, ownAlive: false, results: [down(7890), down(10808)] });
  check('1 端口全空 → 不让路', d.peerRunning === false);
  check('1b 不让路时无 hit', d.hits.length === 0);
  check('1c describePeer 说没检测到', describePeer(d) === '未检测到其它代理');
}

// ── 2. 常见代理端口有人监听 → 让路 ───────────────────────────────
{
  const d = evaluatePeers({ ownPort: 7890, ownAlive: false, results: [down(7890), up(10808)] });
  check('2 常见代理端口被监听 → 让路', d.peerRunning === true);
  check('2b hit 的 kind 是 port', d.hits[0]?.kind === 'port', `kind=${d.hits[0]?.kind}`);
  check('2c hit 记录端口号', d.hits[0]?.port === 10808);
}

// ── 3. ★ 自己的内核监听自己的端口 → 不算「别人」 ─────────────────
{
  const d = evaluatePeers({ ownPort: 7890, ownAlive: true, results: [up(7890)] });
  check('3 ★ 自己的内核占自己的端口 → 不让路（否则永远自我阻断）', d.peerRunning === false);

  // 同一端口，但内核没活（说明是别的程序占的）
  const d2 = evaluatePeers({ ownPort: 7890, ownAlive: false, results: [up(7890)] });
  check('3b 同一端口但自己没活 → 那是别人的，让路', d2.peerRunning === true);
  check('3c 这种 hit 的 kind 是 own-port', d2.hits[0]?.kind === 'own-port', `kind=${d2.hits[0]?.kind}`);
  check('3d own-port 的说明提到「本插件要用的端口」', /本插件要用的端口/.test(d2.hits[0]?.note ?? ''));
}

// ── 4. 自己的内核活着，同时还有别的代理 → 仍然让路 ───────────────
{
  const d = evaluatePeers({ ownPort: 7890, ownAlive: true, results: [up(7890), up(10808)] });
  check('4 自己活着但还有别人 → 让路', d.peerRunning === true);
  check('4b 只把别人算进 hit（自己的被排除）', d.hits.length === 1 && d.hits[0].port === 10808);
}

// ── 5. 多个端口被占：hit 按端口升序 ──────────────────────────────
{
  const d = evaluatePeers({ ownPort: 7890, ownAlive: false, results: [up(20171), up(1080), up(7897)] });
  check('5 多个端口被占 → 全部记录', d.hits.length === 3, `n=${d.hits.length}`);
  check('5b hit 按端口升序', d.hits.map((h) => h.port).join(',') === '1080,7897,20171',
    d.hits.map((h) => h.port).join(','));
  check('5c describePeer 列出端口', /1080、7897、20171/.test(describePeer(d)), describePeer(d));
}

// ── 6. 边界：空输入 / 缺字段 / null 都不崩 ───────────────────────
{
  const a = evaluatePeers();
  check('6 无参数 → 不让路且不崩', a.peerRunning === false && Array.isArray(a.hits));
  const b = evaluatePeers({ results: [] });
  check('6b 空 results → 不让路', b.peerRunning === false);
  const c = evaluatePeers({ results: [null, undefined, {}, { port: 10808 }] });
  check('6c 残缺条目被忽略（缺 up 不算被占）', c.peerRunning === false, `hits=${c.hits.length}`);
  const e = evaluatePeers({ results: [up(10808), null, up(1080)] });
  check('6d 混合残缺条目仍能正确统计', e.hits.length === 2, `n=${e.hits.length}`);
  check('6e describePeer(null) 不崩', typeof describePeer(null) === 'string');
}

// ── 7. 默认值与端口名单 ──────────────────────────────────────────
{
  check('7 PEER_DEFAULTS.yieldToPeer 默认开', PEER_DEFAULTS.yieldToPeer === true);
  check('7b 默认端口 7890 在名单里', COMMON_PROXY_PORTS.includes(7890));
  check('7c 名单含主流代理端口', [10808, 1080, 7897].every((p) => COMMON_PROXY_PORTS.includes(p)));
  check('7d 名单无重复', new Set(COMMON_PROXY_PORTS).size === COMMON_PROXY_PORTS.length,
    `n=${COMMON_PROXY_PORTS.length}`);
  check('7e 名单全是合法端口号', COMMON_PROXY_PORTS.every((p) => Number.isInteger(p) && p > 0 && p < 65536));
}

// ── 8. 用户把开关关掉时，闸门本身不拦（peerGate 的 disabled 分支）──
{
  // 这里只验证 evaluatePeers 的语义：检测结论与"要不要拦"是两回事。
  // 真正的开关判断在 peerGate() 里（见 lib/peers.js），它需要联网探测，
  // 因此不在离线测试范围内。
  const d = evaluatePeers({ ownPort: 7890, ownAlive: false, results: [up(10808)] });
  check('8 检测结论与开关解耦：检测到就是 peerRunning=true', d.peerRunning === true);
}

console.log(`\n=== ${pass}/${pass + fail} PASS ===`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
