/**
 * 节点管理：通过 mihomo 的管理 API 列出节点、读取当前选择、切换节点。
 *
 * 用途：dsh-proxy-on-demand 的「节点面板」后端 —— 把 config.yaml 里那 143 个节点
 *       和 14 个分组变成界面上能点、能切的东西。
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 *       REST API：`GET /proxies`、`PUT /proxies/<组名>`（body `{"name":"节点名"}`）
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证；只用 Node 内建模块。
 * 自用免责：按「原样」提供、无担保，使用后果自负。
 *
 * ## 为什么需要它（2026-10-13）
 *
 * 在此之前本插件**只有「导入配置」，没有「看节点、选节点」**：143 个节点配 14 个
 * `type: select` 分组，界面上一块死数据，想换节点只能去手改 config.yaml。
 * 而选节点这件事 mihomo 本来就提供了 API，只是导入的 FlClash 配置把
 * `external-controller` 写成了空字符串，等于把门锁上了。
 *
 * ## 安全边界
 *
 *   · 只连 **127.0.0.1**（管理 API 本身也只绑 loopback，见 config.js）；
 *   · 带上 `secret`（随机生成、随配置落盘）；
 *   · **内核没跑时不报错**，返回 `{ coreRunning: false }` 让界面显示「未运行」——
 *     这符合「按需」定位：不开代理时不该有任何节点查询发生。
 *
 * ## 一个刻意的设计：不缓存
 *
 * 节点列表与「当前选中」都直接问内核。缓存会带来「界面显示已切换、实际没切」的
 * 假象 —— 这类"看起来生效了"的 bug 今天已经踩过两次（计数恒为 0、注入格式不对），
 * 宁可多一次本地 HTTP 往返（实测 <5ms）。
 */

/** 管理 API 请求超时（本地 loopback，正常在毫秒级）。 */
const API_TIMEOUT_MS = 4000;

/**
 * 一次请求 mihomo 管理 API。
 *
 * `timeoutMs` 可覆盖默认的 4 秒 —— **某些接口是同步阻塞的**，4 秒不够：
 * `GET /group/<名>/delay` 会真的等整组节点测完才返回。实测 148 个成员的分组
 * 耗时 3006ms，只剩 1 秒余量，稍一抖动就被 abort，面板上表现为
 * 「测延迟 → 管理 API 超时（4000ms）」，而内核其实正在正常测速。
 */
async function apiCall({ host, port, secret }, method, path, body, timeoutMs = API_TIMEOUT_MS) {
  const url = `http://${host}:${port}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {};
    if (secret) headers.Authorization = `Bearer ${secret}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`管理 API ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    if (text === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 只保留有意义的错误信息（fetch 的报错原文很含糊）。 */
function describeThrown(error, timeoutMs = API_TIMEOUT_MS) {
  if (error?.name === 'AbortError') return `管理 API 超时（${timeoutMs}ms）`;
  const msg = error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);
  // 内核没跑时 fetch 只会给一句 "fetch failed"，对用户毫无信息量。
  if (/fetch failed|ECONNREFUSED|socket hang up/i.test(msg)) {
    return '连不上内核的管理 API —— 内核当前没有运行（按需代理平时是关着的）';
  }
  return msg;
}

/**
 * 判断一个 proxy 条目是不是「能选的真节点」。
 *
 * 订阅里常混着**信息伪节点**（本机实测 3 条）：
 *   · `剩余流量：198.50 GB`
 *   · `距离下次重置剩余：5 天`
 *   · `套餐到期：2026-11-17`
 * 选中它们没有任何意义，列进面板只会误导。
 *
 * 判据用 mihomo 自己给的字段：`type` 为 `Selector`/`URLTest`/`Fallback`/
 * `LoadBalance`/`Relay`/`Compatible`/`Pass` 的是**分组**（不是节点）；
 * 其余（`Hysteria2`/`Vless`/`Trojan`…）是节点。
 *
 * ⚠️ 实测发现 mihomo 的 `GET /proxies` **不返回 `server` 字段**（本机 179 个
 * 条目全是 `undefined`），所以伪节点只能靠**名字特征**识别 —— 别指望用
 * `server: 127.0.0.1` 判断（那条路是死的）。
 */
const GROUP_TYPES = new Set([
  'Selector', 'URLTest', 'Fallback', 'LoadBalance', 'Relay', 'Compatible', 'Pass',
]);

/**
 * mihomo 的**内建策略**，不是用户节点，也不该出现在「可选节点」里。
 *
 * 实测（本机）：`DIRECT`(Direct)、`REJECT`(Reject)、`REJECT-DROP`(RejectDrop)、
 * `PASS`(PassRule)。它们永远存在，列进面板等于噪声。
 */
const BUILTIN_TYPES = new Set(['Direct', 'Reject', 'RejectDrop', 'PassRule', 'Compatible', 'Dns']);

/** 系统内建分组：`COMPATIBLE` / `PASS` 这类占位组，没有可选项。 */
const BUILTIN_GROUPS = new Set(['COMPATIBLE', 'PASS', 'GLOBAL']);

/** 信息伪节点的名字特征（中文机场订阅的惯例写法）。 */
const FAKE_NODE_RE = /^(剩余流量|距离下次|套餐到期|到期时间|官网|订阅|流量|重置|有效期)/;

export function isProxyGroup(info) {
  return GROUP_TYPES.has(String(info?.type ?? ''));
}

/** 系统内建策略（DIRECT/REJECT/…）—— 不算用户节点。 */
export function isBuiltinNode(info) {
  return BUILTIN_TYPES.has(String(info?.type ?? ''));
}

/** 系统内建分组（COMPATIBLE/PASS/…）—— 面板里不显示。 */
export function isBuiltinGroup(name) {
  return BUILTIN_GROUPS.has(String(name ?? '').toUpperCase());
}

export function isFakeNode(name) {
  return FAKE_NODE_RE.test(String(name ?? ''));
}

/**
 * 列出所有分组与节点，并标出当前选中。
 *
 * @param {{host:string, port:number, secret:string}} endpoint - 来自 readExternalController
 * @param {{includeFake?: boolean}} [opts]
 * @returns 结构化结果；内核没跑时 `{ coreRunning: false }`
 */
export async function listProxies(endpoint, { includeFake = false } = {}) {
  if (!Number.isInteger(endpoint?.port)) {
    return { coreRunning: false, reason: '配置里没有可用的 external-controller（内核可能还没起过）' };
  }

  let data;
  try {
    data = await apiCall(endpoint, 'GET', '/proxies');
  } catch (error) {
    return { coreRunning: false, reason: describeThrown(error) };
  }

  const all = data?.proxies ?? {};
  const groups = [];
  const nodes = [];
  let hidden = 0;

  for (const [name, info] of Object.entries(all)) {
    if (isProxyGroup(info)) {
      // 系统内建分组（COMPATIBLE / PASS）没有可选项，不进面板。
      if (isBuiltinGroup(name)) {
        hidden += 1;
        continue;
      }
      const members = Array.isArray(info.all) ? info.all : [];
      groups.push({
        name,
        type: String(info.type),
        // 只有 Selector 能「手动选」；URLTest/Fallback/LoadBalance 是自动的，
        // 面板上标出来，但切换它们没有意义（内核会自己决定）。
        selectable: String(info.type) === 'Selector',
        now: typeof info.now === 'string' ? info.now : null,
        count: members.length,
        members,
        // 内核自己配的测速目标。mihomo 的 `/proxies` **会**把它回读出来
        // （2026-10-13 实测：`testUrl: "https://www.gstatic.com/generate_204"`）。
        // 面板手动测速要用它，而不是硬编码一个别的地址 —— 理由见 testGroupDelay。
        testUrl: typeof info.testUrl === 'string' && info.testUrl ? info.testUrl : null,
      });
    } else {
      if (isBuiltinNode(info)) {
        hidden += 1;
        continue;
      }
      const fake = isFakeNode(name);
      if (fake && !includeFake) {
        hidden += 1;
        continue;
      }
      nodes.push({
        name,
        type: String(info?.type ?? '?'),
        // mihomo 会给历史延迟；没测过就是 null，界面显示为「未测速」
        delay: Number.isFinite(info?.history?.[info.history.length - 1]?.delay)
          ? info.history[info.history.length - 1].delay
          : null,
        fake,
      });
    }
  }

  groups.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  return {
    coreRunning: true,
    total: Object.keys(all).length,
    groups,
    nodes,
    /** 被过滤掉的：系统内建策略/分组 + 信息伪节点。 */
    hidden,
  };
}

/**
 * 切换某个分组选中的节点。
 *
 * @param endpoint - 同上
 * @param group - 分组名（必须是 `type: select` 的组）
 * @param node - 目标节点名
 * @returns `{ ok, group, now, verified }`；`verified` 是**回读确认**的结果
 */
export async function selectProxy(endpoint, group, node) {
  if (!Number.isInteger(endpoint?.port)) {
    return { ok: false, error: '内核未运行，无法切换节点' };
  }
  const g = String(group ?? '').trim();
  const n = String(node ?? '').trim();
  if (!g || !n) return { ok: false, error: 'group 与 node 都不能为空' };

  try {
    await apiCall(endpoint, 'PUT', `/proxies/${encodeURIComponent(g)}`, { name: n });
  } catch (error) {
    return { ok: false, error: describeThrown(error), group: g, node: n };
  }

  // 回读确认 —— 不接受「发出去就算成功」。今天已经两次栽在「报告成功但实际没生效」上。
  let now = null;
  try {
    const after = await apiCall(endpoint, 'GET', `/proxies/${encodeURIComponent(g)}`);
    now = typeof after?.now === 'string' ? after.now : null;
  } catch {
    /* 回读失败不影响「已下发」这个事实，界面会显示未确认 */
  }

  return { ok: true, group: g, node: n, now, verified: now === n };
}

/**
 * 批量给分组里的节点测速（触发 mihomo 的延迟测试）。
 *
 * 面板上「测延迟」按钮用它。mihomo 的测速是**同步阻塞**的：要等整组测完才
 * 返回，返回体是 `{节点名: 延迟}` 映射。
 *
 * ## 测速目标：**默认交给内核**，不自己指定（2026-10-13 更正）
 *
 * 调用时不传 `url` → mihomo 就用**这个分组自己配置的 `url:`**。
 * 这与用户在 FlClash 里看到的行为一致：FlClash 从不改写分组的目标，
 * 每个组用它自己配的那一个。
 *
 * ⚠️ 这里记一次**被推翻的诊断**，免得以后又照错的改：
 * 我一度认为「分组的目标是 `www.gstatic.com/generate_204`，而 gstatic 在国内
 * 被墙 → 所有节点必然测速失败」，于是写了个 `forceTestUrl()` 把配置里 9 处
 * 目标全换成国内的 miui，并且在这里硬编码传 miui。
 *
 * **这条因果链是错的。** 内核测速是**经由节点**发出去的请求，走节点所在地的
 * 出口，跟「本机能不能直连 gstatic」毫无关系。同一批节点、只换测速目标的
 * 对照实验（2026-10-13，3 个自动组 × 4 成员 = 12 个样本，测完回读面板读的
 * 顶层 `history`，统计拿到有效延迟的成员数）：
 *
 *   · 不传 url（内核用分组自己的目标）→ 11/12 = 92%
 *   · 显式传分组自己的 testUrl        → 10/12 = 83%
 *   · 改传 miui                       → 10/12 = 83%
 *
 * 三者基本等价（差异在噪声范围内），所以**没有任何理由去改写用户的测速目标**。
 * （我一度还写下过「不传 url 只探到 2/4」—— 那是单次采样噪声，被这 12 个样本推翻。）
 *
 * 顺带也证伪了另一条推断：节点的 `history` **不是**按测速 URL 分桶的 ——
 * 传 miui 或 gstatic 都会更新顶层 `history`（面板读的正是它），所以
 * 「用别的 URL 测会让面板读不到」这个担心不成立。
 *
 * 结论就是：**不改写、不自作主张，让分组用自己的目标**。真病根是 DNS
 * 端口冲突（`forceDnsPort` 已修），不是测速目标被墙。
 *
 * @param endpoint - 管理端点
 * @param group - 分组名
 * @param {object} [opts] - `{ timeoutMs, url }`；`url` 留空即「用分组自己的」
 */
export async function testGroupDelay(endpoint, group, { timeoutMs = 3000, url } = {}) {
  if (!Number.isInteger(endpoint?.port)) return { ok: false, error: '内核未运行' };
  const g = String(group ?? '').trim();
  if (!g) return { ok: false, error: 'group 不能为空' };
  // 只有显式传了 url 才带这个参数 —— 留空时**不带**，让内核用分组的 testUrl。
  const target = String(url ?? '').trim();
  const qs = new URLSearchParams();
  qs.set('timeout', String(timeoutMs));
  if (target) qs.set('url', target);
  // 这个接口是**同步阻塞**的：要等整组测完才返回。148 个成员实测 3006ms，
  // 所以 HTTP 层给足余量（单节点 timeoutMs 只是内核侧的每个节点上限）。
  const httpTimeoutMs = Math.max(API_TIMEOUT_MS, timeoutMs + 30000);
  try {
    await apiCall(endpoint, 'GET', `/group/${encodeURIComponent(g)}/delay?${qs.toString()}`, undefined, httpTimeoutMs);
    return { ok: true, group: g, url: target || null, note: '已触发测速，稍后刷新看结果' };
  } catch (error) {
    return { ok: false, error: describeThrown(error, httpTimeoutMs) };
  }
}

/**
 * **连通性测试**：真的通过某个节点发出一次请求，看能不能通。
 *
 * ## 与「测延迟」的区别（用户 2026-10-13 明确指出缺的就是这个）
 *
 *   · 测延迟（`/proxies/{name}/delay`）：只问内核「这个节点握手要多久」，
 *     得到的是一个毫秒数。**它不告诉你这个节点能不能真正上网** ——
 *     实测里就出现过「有延迟、但请求全部失败」的假象。
 *   · 连通性测试：真的让内核**以这个节点为出口**发一次 HTTP 请求，
 *     只有拿到预期状态码才算通过。这才是「这个节点能用」的判据。
 *
 * ## 实现
 *
 * 利用 mihomo 的**管理 API 自带代理能力**：给 `GET /proxies/{name}/delay`
 * 传一个 `url` 参数，内核就会用该节点去请求这个 URL。返回 2xx/3xx 且
 * `delay > 0` 即视为连通。
 *
 * 为什么不用「切换节点 → 用 7890 端口发请求」：那会**改动用户当前的选中**，
 * 而测完还得切回去，中间任何异常都会把用户配置留在半路状态。用 delay API
 * 的 url 参数是只读的，不碰当前选择。
 *
 * @param endpoint - 管理端点
 * @param node - 节点名
 * @param {object} [opts] - `{ url, timeoutMs }`
 * @returns `{ ok, node, delay, url, verdict }`
 */
export async function testConnectivity(endpoint, node, { url, timeoutMs = 8000 } = {}) {
  const n = String(node ?? '').trim();
  if (!n) return { ok: false, error: 'node 不能为空' };
  if (!Number.isInteger(endpoint?.port)) {
    return { ok: false, error: '内核未运行，无法测试连通性' };
  }

  const target = String(url ?? '').trim() || DEFAULT_TEST_URL;
  const qs = new URLSearchParams({ timeout: String(timeoutMs), url: target });

  let data;
  try {
    data = await apiCall(endpoint, 'GET', `/proxies/${encodeURIComponent(n)}/delay?${qs.toString()}`);
  } catch (error) {
    return { ok: false, node: n, url: target, error: describeThrown(error), verdict: '请求失败' };
  }

  const delay = Number(data?.delay ?? 0);
  // mihomo 约定：delay === 0 表示不可达/超时。
  if (!Number.isFinite(delay) || delay <= 0) {
    return {
      ok: false, node: n, url: target, delay: 0,
      verdict: '超时或不可达',
      error: `请求 ${target} 超时（${timeoutMs}ms）。若所有节点都超时，先检查 DNS 端口是否被 FlClash 占了 —— 插件会自动换一个空闲端口，换完要重启内核。`,
    };
  }

  return { ok: true, node: n, url: target, delay, verdict: '连通' };
}

/**
 * 批量测一组节点的连通性（并发，但限流以免打爆内核）。
 *
 * @returns `{ ok, results[], reachable, total, url }`
 */
export async function testConnectivityMany(endpoint, nodes, { url, timeoutMs = 8000, concurrency = 4 } = {}) {
  const list = (Array.isArray(nodes) ? nodes : []).map((x) => String(x)).filter(Boolean);
  const results = [];
  // 简单分批并发：一次 concurrency 个。
  for (let i = 0; i < list.length; i += concurrency) {
    const batch = list.slice(i, i + concurrency);
    const got = await Promise.all(batch.map((n) => testConnectivity(endpoint, n, { url, timeoutMs })));
    results.push(...got);
  }
  const reachable = results.filter((r) => r.ok).length;
  return { ok: true, results, reachable, total: results.length, url: url || DEFAULT_TEST_URL };
}

/**
 * 默认连通性测试目标。
 *
 * 为什么不是 `gstatic.com/generate_204`（mihomo 默认）：那个域名在国内**不可达**，
 * 用它测会「明明能上网、却全部超时」。这里挑一个国内直连就能通的 204 端点。
 */
export const DEFAULT_TEST_URL = 'http://connect.rom.miui.com/generate_204';

/**
 * **活跃探测**：看代理端口最近是不是真有流量在走。
 *
 * 用途：给 core 的自动续租用 —— 判断「用户还在用代理吗」。
 *
 * ## 为什么需要（2026-10-13 事故：「用 github 时关闭倒计时仍在继续」）
 *
 * 插件原本只在 **CLI 命令**（`POST /fetch` 之类）里续租。而用户实际用代理的方式
 * 是**浏览器访问 GitHub** —— 那些流量走的是代理端口，插件完全感知不到，
 * 于是倒计时照样走完，把正在下载中的内核杀掉。
 *
 * ## 判据：累计字节数在增长，而不是「有没有连接」
 *
 * 长连接（比如网页开着不动）挂着但不传数据，那也是空闲 —— 只看连接数会误判。
 * 所以用 mihomo 管理 API 的 `/connections` 拿 **downloadTotal + uploadTotal**，
 * 与上次采样比较：涨了才算活跃。
 *
 * @param endpoint - 管理端点
 * @param {object} prev - 上一次的 `{ up, down }`；不给则视为「首次采样」（不算活跃）
 * @returns `{ active, up, down, detail }`
 */
export async function sampleActivity(endpoint, prev = null) {
  if (!Number.isInteger(endpoint?.port)) {
    return { active: false, up: 0, down: 0, detail: '内核未运行' };
  }
  let data;
  try {
    data = await apiCall(endpoint, 'GET', '/connections');
  } catch {
    // 查不到就当不活跃 —— 宁可让它按空闲关掉，也不要因为探测失败卡住关不掉。
    return { active: false, up: 0, down: 0, detail: '管理 API 不可用' };
  }

  const down = Number(data?.downloadTotal ?? 0);
  const up = Number(data?.uploadTotal ?? 0);

  if (!prev) return { active: false, up, down, detail: '首次采样（需两次比较）' };

  const grew = (down - Number(prev.down ?? 0)) + (up - Number(prev.up ?? 0));
  return {
    active: grew > 0,
    up,
    down,
    detail: grew > 0 ? `新增 ${grew} 字节` : '无新增流量',
  };
}

export { describeThrown as describeApiError, API_TIMEOUT_MS };
