/**
 * 借道探测 —— 离线判定测试
 *
 * 用途：验证 lib/peers.js 的借道规则，**完全不碰真实网络**。
 *   判定核心 evaluateBorrow() 是纯函数（吃构造的端口探测结果、吐结论），
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
  BORROW_TTL_MS, COMMON_PROXY_PORTS, evaluateBorrow,
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

const ORDER = COMMON_PROXY_PORTS;

console.log('=== 借道探测 离线测试 ===\n');

// ── 1. 基础：都没人监听 → 没得借 ─────────────────────────────────
{
  const d = evaluateBorrow({ ownPort: 7899, results: [down(7890), down(10808)], order: ORDER });
  check('1 端口全空 → 没有可借目标', d === null);
}

// ── 2. FlClash 在跑（7890）→ 借它 ────────────────────────────────
{
  const d = evaluateBorrow({
    ownPort: 7899, results: [up(7890), down(10808)], order: ORDER,
  });
  check('2 7890 在监听 → 借道 7890', d?.port === 7890, `port=${d?.port}`);
  check('2b note 说明「不启动自己的内核」', /不启动自己的内核/.test(d?.note ?? ''), d?.note);
  check('2c note 带上端口号', /7890/.test(d?.note ?? ''));
}

// ── 3. ★ 名单顺序即优先级：7890 与 7897 都开着 → 选 7890 ──────────
{
  const d = evaluateBorrow({
    ownPort: 7899, results: [up(7897), up(7890)], order: ORDER,
  });
  check('3 ★ 按名单顺序而非端口号：选 7890（FlClash 优先）', d?.port === 7890, `port=${d?.port}`);

  // 反过来构造（results 顺序颠倒）结论必须一样
  const d2 = evaluateBorrow({
    ownPort: 7899, results: [up(7890), up(7897)], order: ORDER,
  });
  check('3b results 顺序不影响结论', d2?.port === 7890);
}

// ── 4. ★ 自己的端口永远不算「可借」 ──────────────────────────────
{
  const d = evaluateBorrow({ ownPort: 7899, results: [up(7899)], order: ORDER });
  check('4 ★ 只有自己的端口在监听 → 不借（否则自己借自己）', d === null);

  const d2 = evaluateBorrow({
    ownPort: 7899, results: [up(7899), up(7890)], order: ORDER,
  });
  check('4b 自己 + 别人都在 → 借别人的', d2?.port === 7890, `port=${d2?.port}`);
}

// ── 5. extraPorts 优先于名单 ────────────────────────────────────
{
  const d = evaluateBorrow({
    ownPort: 7899, results: [up(7890), up(12345)], order: [12345, ...ORDER],
  });
  check('5 extraPorts 排前面 → 优先借 12345', d?.port === 12345, `port=${d?.port}`);
}

// ── 6. 边界：空输入 / 缺字段 / null 都不崩 ───────────────────────
{
  const a = evaluateBorrow();
  check('6 无参数 → null 且不崩', a === null);
  const b = evaluateBorrow({ results: [] });
  check('6b 空 results → null', b === null);
  const c = evaluateBorrow({ results: [null, undefined, {}, { port: 10808 }] });
  check('6c 残缺条目被忽略（缺 up 不算被监听）', c === null);
  const e = evaluateBorrow({
    ownPort: 7899, results: [up(10808), null, up(1080)], order: ORDER,
  });
  check('6d 混合残缺条目仍能挑出正确目标', e?.port === 10808, `port=${e?.port}`);
  const f = evaluateBorrow({ ownPort: 7899, results: [up(10808)], order: [] });
  check('6e order 为空 → 不挑', f === null);
  const g = evaluateBorrow({ ownPort: 7899, results: [up(7890)], order: [null, undefined, 7890] });
  check('6f order 里的残缺项被跳过', g?.port === 7890);
}

// ── 7. 端口名单 ──────────────────────────────────────────────────
{
  check('7 名单里没有本插件自己的端口 7899', !COMMON_PROXY_PORTS.includes(7899));
  check('7b 名单含主流代理端口', [7890, 10808, 1080, 7897].every((p) => COMMON_PROXY_PORTS.includes(p)));
  check('7c 名单无重复', new Set(COMMON_PROXY_PORTS).size === COMMON_PROXY_PORTS.length,
    `n=${COMMON_PROXY_PORTS.length}`);
  check('7d 名单全是合法端口号', COMMON_PROXY_PORTS.every((p) => Number.isInteger(p) && p > 0 && p < 65536));
  check('7e 名单不含 9090（FlClashCore 的控制器端口，不是代理端口）',
    !COMMON_PROXY_PORTS.includes(9090));
}

// ── 8. 缓存时长是个正数 ─────────────────────────────────────────
{
  check('8 BORROW_TTL_MS 是正数', Number.isFinite(BORROW_TTL_MS) && BORROW_TTL_MS > 0, `${BORROW_TTL_MS}`);
}

console.log(`\n=== ${pass}/${pass + fail} PASS ===`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
