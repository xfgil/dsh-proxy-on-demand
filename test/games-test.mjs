/**
 * 游戏检测 —— 离线判定测试
 *
 * 用途：验证 lib/games.js 的判定规则，**完全不碰真实系统**。
 *   判定核心 evaluateGate() 是纯函数（吃构造数据、吐结论），
 *   所以这里能精确覆盖每种判据组合，不受测试机上当时在跑什么影响。
 *
 * 上游程序：本项目运行时会下载 mihomo（© MetaCubeX，GPL-3.0）；
 *   本测试文件不联网、不下载、不启动任何内核。
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2（Electron 44.0.0）。
 * 自动安装提醒：本测试**不会**触发内核下载。
 * 免责声明：自用工具，按现状提供，不保证覆盖所有游戏。
 *
 * 运行：node test/games-test.mjs
 */
import { describeHit, evaluateGate, gameGate, QUNS_NAMES } from '../lib/games.js';

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

/** 造一个探测帧。quns=5 表示系统认为「可打扰」。 */
const frame = (o = {}) => ({
  ok: true,
  quns: o.quns ?? 5,
  pid: o.pid ?? 1000,
  caption: o.caption ?? true,
  full: o.full ?? false,
  rect: o.rect ?? [100, 100, 800, 600],
  mon: [0, 0, 1920, 1080],
  fgPath: o.fgPath ?? 'C:\\Windows\\explorer.exe',
  title: o.title ?? 'Desktop',
  ms: 0,
});

const GAME = 'D:\\Games\\SomeGame\\bin\\game.exe';

console.log('=== 游戏检测 离线测试 ===\n');

// ── 1. 基础：没游戏时不拦 ──────────────────────────────────────
{
  const d = evaluateGate({ probe: frame() });
  check('1 普通窗口前台 → 不算游戏', d.gameRunning === false, 'quns=5 full=false');
  check('1b 不拦时无 hit', d.hit === null);
  check('1c probeOk=true', d.probeOk === true);
}

// ── 2. 主判据：QUNS=2（忙碌）──────────────────────────────────
{
  const d = evaluateGate({
    probe: frame({ quns: 2, fgPath: GAME, caption: false, full: true, title: 'Some Game' }),
  });
  check('2 QUNS=2 → 判定游戏运行', d.gameRunning === true);
  check('2b hit.kind=quns', d.hit?.kind === 'quns', `kind=${d.hit?.kind}`);
  check('2c qunsName 中文', d.hit?.qunsName === '忙碌', `qunsName=${d.hit?.qunsName}`);
  check('2d 带上前台程序名', d.hit?.label === 'game.exe', `label=${d.hit?.label}`);
}

// ── 3. 主判据：QUNS=3（独占全屏）/ 4（演示）────────────────────
for (const [q, name] of [[3, '独占全屏'], [4, '演示模式']]) {
  const d = evaluateGate({
    probe: frame({ quns: q, fgPath: GAME, caption: false, full: true }),
  });
  check(`3 QUNS=${q} → 判定游戏运行`, d.gameRunning === true && d.hit?.kind === 'quns', name);
}

// ── 4. QUNS=5/6/7 不拦 ────────────────────────────────────────
for (const q of [5, 6, 7]) {
  const d = evaluateGate({
    probe: frame({ quns: q, fgPath: GAME, caption: true, full: false }),
  });
  check(`4 QUNS=${q} 不判游戏`, d.gameRunning === false, `qunsName=${d.qunsName}`);
}

// ── 5. 辅判据：无边框全屏窗口（QUNS 没报）──────────────────────
{
  const d = evaluateGate({
    probe: frame({ quns: 5, fgPath: GAME, caption: false, full: true, title: 'Borderless' }),
  });
  check('5 无边框全屏 → 判定游戏运行', d.gameRunning === true);
  check('5b hit.kind=fullscreen', d.hit?.kind === 'fullscreen', `kind=${d.hit?.kind}`);
}

// ── 6. 关键误报防护：explorer 桌面全屏不算游戏 ──────────────────
{
  // 这是实测过的真实场景：ToggleDesktop() 把桌面拉前台，caption=false full=true
  // 但 QUNS=5 —— 系统明确说「可打扰」，所以绝不能判成游戏。
  const d = evaluateGate({
    probe: frame({ quns: 5, fgPath: 'C:\\Windows\\explorer.exe', caption: false, full: true }),
  });
  check('6 explorer 桌面全屏不算游戏', d.gameRunning === false, `kind=${d.hit?.kind ?? 'none'}`);
}

// ── 7. 关键误报防护：TextInputHost 全屏不算游戏 ────────────────
{
  const d = evaluateGate({
    probe: frame({
      quns: 5, caption: false, full: true,
      fgPath: 'C:\\Windows\\SystemApps\\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\\TextInputHost.exe',
    }),
  });
  check('7 输入法宿主全屏不算游戏', d.gameRunning === false);
}

// ── 8. 系统说忙就是忙：不因前台是 shell 组件而推翻 ─────────────
{
  // 判据 2 会排除 shell 组件，但判据 1（系统状态）不该被 shell 例外推翻：
  // 系统说「忙碌」，那就拦 —— 这是 QUNS 作为主判据的意义。
  const d = evaluateGate({
    probe: frame({ quns: 2, fgPath: 'C:\\Windows\\explorer.exe', caption: true, full: false }),
  });
  check('8 QUNS=2 时即使前台是 explorer 也拦', d.gameRunning === true && d.hit?.kind === 'quns');
}

// ── 9. 大写/小写路径都能识别 ──────────────────────────────────
{
  const d = evaluateGate({
    probe: frame({ quns: 2, fgPath: 'D:\\GAMES\\SOMEGAME\\BIN\\GAME.EXE', caption: false, full: true }),
  });
  check('9 大写路径也能取对名字', d.hit?.label === 'game.exe', `label=${d.hit?.label}`);
}

// ── 10. 反斜杠/正斜杠都能取名字 ───────────────────────────────
{
  const d = evaluateGate({
    probe: frame({ quns: 2, fgPath: 'D:/Games/SomeGame/bin/game.exe', caption: false, full: true }),
  });
  check('10 正斜杠路径也能取对名字', d.hit?.label === 'game.exe', `label=${d.hit?.label}`);
}

// ── 11. 探测失败时不崩、不拦 ──────────────────────────────────
{
  const d = evaluateGate({ probe: { ok: false, error: '探测不可用' } });
  check('11 探测失败 → 不判游戏（宁可放过）', d.gameRunning === false);
  check('11b probeOk=false', d.probeOk === false);
  check('11c probeError 透传', d.probeError === '探测不可用', `err=${d.probeError}`);
  check('11d hit 为 null', d.hit === null);
}

// ── 12. 探测帧缺字段时不崩 ────────────────────────────────────
{
  const d = evaluateGate({ probe: { ok: true } });
  check('12 只有 ok 的探测帧不崩', d.gameRunning === false);
  check('12b quns=null', d.quns === null);

  const d2 = evaluateGate({ probe: null });
  check('12c probe=null 不崩', d2.gameRunning === false && d2.probeOk === false);

  const d3 = evaluateGate({});
  check('12d 无参数不崩', d3.gameRunning === false);
}

// ── 13. QUNS=1（锁屏）不判游戏 ────────────────────────────────
{
  // 锁屏时不该拦 —— 用户没在玩游戏，可能只是锁屏挂机。
  const d = evaluateGate({ probe: frame({ quns: 1, caption: true, full: false }) });
  check('13 锁屏（QUNS=1）不判游戏', d.gameRunning === false, `qunsName=${d.qunsName}`);
}

// ── 14. 全屏但有标题栏 → 不判游戏（判据 2 要求无标题栏）────────
{
  const d = evaluateGate({
    probe: frame({ quns: 5, fgPath: GAME, caption: true, full: true }),
  });
  check('14 有标题栏的全屏窗口不算游戏', d.gameRunning === false, `kind=${d.hit?.kind ?? 'none'}`);
}

// ── 15. 无标题栏但没铺满 → 不判游戏 ───────────────────────────
{
  const d = evaluateGate({
    probe: frame({ quns: 5, fgPath: GAME, caption: false, full: false }),
  });
  check('15 无标题栏但没铺满不算游戏', d.gameRunning === false);
}

// ── 16. describeHit 措辞 ──────────────────────────────────────
{
  const d = evaluateGate({
    probe: frame({ quns: 3, fgPath: GAME, caption: false, full: true, title: 'G' }),
  });
  const s = describeHit(d);
  check('16 describeHit 出人话', typeof s === 'string' && s.length > 0, s);
  check('16b 提到系统状态', /独占全屏/.test(s), s);

  const none = evaluateGate({ probe: frame() });
  check('16c 无游戏时 describeHit 返回 null', describeHit(none) === null);

  const fs = evaluateGate({ probe: frame({ quns: 5, fgPath: GAME, caption: false, full: true }) });
  check('16d 全屏命中措辞', /无边框全屏/.test(describeHit(fs)), describeHit(fs));
}

// ── 17. QUNS_NAMES 完整 ───────────────────────────────────────
{
  check('17 QUNS_NAMES 七个状态齐全', Object.keys(QUNS_NAMES).length === 7);
  check('17b 2/3/4 名称正确',
    QUNS_NAMES[2] === '忙碌' && QUNS_NAMES[3] === '独占全屏' && QUNS_NAMES[4] === '演示模式');
}

// ── 18. gameGate 开关语义 ─────────────────────────────────────
{
  const off = await gameGate({ blockOnGame: false });
  check('18 blockOnGame=false → disabled', off.blocked === false && off.reason === 'disabled');

  // useProbe:false 让检测走「探测已跳过」路径 → 不拦（detect-failed 也算放过）
  const skip = await gameGate({ blockOnGame: true, useProbe: false });
  check('18b 探测跳过时不拦', skip.blocked === false, `reason=${skip.reason}`);
}

console.log(`\n=== ${pass}/${pass + fail} PASS ===`);
if (fail) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('GAMETEST: PASS');
