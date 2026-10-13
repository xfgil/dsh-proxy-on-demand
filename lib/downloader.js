/**
 * 内核获取：自己下载、自己解压，不依赖任何外部包。
 *
 * ⚠ 自动安装提醒：**这里会联网下载第三方二进制**。
 *   上游：mihomo（Clash.Meta 内核）© MetaCubeX
 *         https://github.com/MetaCubeX/mihomo  （GPL-3.0）
 *   来源：仅从该项目的官方 GitHub Release 下载，原样保存，不做任何改动。
 *   落点：插件目录下的 runtime/（约 61MB），删掉即完全清除。
 *   DSH 版本：面向 0.2.0-rc.2 开发验证；本文件只用 Node 内建模块，无版本耦合。
 *   免责：自用工具，按「原样」提供、无担保；下载与使用产生的后果由使用者自负。
 *
 * 为什么不用 npm 装 mihomo：
 *   1. 它是 Go 二进制，没有官方 npm 包；
 *   2. 用户在 profile 侧，额外的 pnpm install 会动 node_modules，有把别的插件
 *      一并重装的风险（0.9.0 那次升级就是这样把 29 处补丁冲掉的）。
 *
 * 所以这里只用 Node 内建能力：
 *   - 下载：https.request + 跟随 302（GitHub release 下载必跳一次）
 *   - 解压：zlib.inflateRaw（zip 的 deflate 条目），自己解析 zip 中央目录
 */

import { createWriteStream } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { get as httpsGetRaw, request as httpsRequest } from 'node:https';
import { get as httpGetRaw } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const UA = 'dsh-proxy-on-demand';

/**
 * GitHub 直连在国内经常**挂死**而不是快速失败：TCP 连得上、请求发得出去，
 * 但响应永远不来（实测 12s 后 socket hang up）。所以每个候选源都要有
 * **首字节超时**，超时就换下一个源，而不是傻等。
 */
const FIRST_BYTE_TIMEOUT_MS = 12000;

/**
 * 下载镜像。
 *
 * 直连 github.com 的 release 下载在国内不稳（实测直接超时），而 release 资产
 * 才是内核本体。这里按顺序回退；每个镜像都是 `前缀 + 原始 URL` 的形式。
 * 顺序按实测速度排：ghproxy.net 971ms / gh-proxy.com 904ms / ghfast.top 1060ms。
 */
export const DEFAULT_MIRRORS = [
  '',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://ghfast.top/',
];

/**
 * 一次 GET，返回 {stream} 或 {redirect}。
 *
 * GitHub Releases 的下载链接会 302 到 objects.githubusercontent.com，
 * 所以必须自己跟随重定向（http 与 https 都得支持）。
 */
function onceDownload(url) {
  return new Promise((resolve, reject) => {
    const isHttp = url.startsWith('http://');
    const doGet = isHttp ? httpGetRaw : httpsGetRaw;
    const req = doGet(url, { headers: { 'user-agent': UA } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        const next = new URL(headers.location, url).href;
        return void resolve({ redirect: next });
      }
      if (statusCode !== 200 && statusCode !== 206) {
        res.resume();
        return void reject(new Error(`下载失败 HTTP ${statusCode}: ${url}`));
      }
      resolve({ stream: res });
    });
    req.on('error', reject);
    // 关键：直连挂死时靠这个超时脱身，换下一个源
    req.setTimeout(FIRST_BYTE_TIMEOUT_MS, () => {
      req.destroy(new Error(`连接超时（${FIRST_BYTE_TIMEOUT_MS}ms 内无响应）`));
    });
  });
}

async function httpsGet(url, redirects = 5) {
  for (let i = 0; ; i++) {
    const r = await onceDownload(url);
    if (r.stream) return r.stream;
    if (i >= redirects) throw new Error('重定向次数过多');
    url = r.redirect;
  }
}

/**
 * 带镜像回退的 GET。
 *
 * @param {string} url       原始 URL（通常是 github.com/...）
 * @param {string[]} mirrors 前缀列表；空串代表直连
 * @param {(msg:string)=>void} [onLog]
 */
async function getWithMirrors(url, mirrors = DEFAULT_MIRRORS, onLog) {
  const errors = [];
  for (const prefix of mirrors) {
    // 只对 github.com 走镜像；其它域名（订阅等）直连即可
    const target = prefix && /^https?:\/\/github\.com\//i.test(url) ? prefix + url : url;
    try {
      const stream = await httpsGet(target);
      if (prefix) onLog?.(`经镜像下载：${prefix}`);
      return stream;
    } catch (e) {
      errors.push(`${prefix || '直连'}: ${e?.message ?? e}`);
      onLog?.(`源失败（${prefix || '直连'}）：${e?.message ?? e}`);
      if (!prefix) continue;
    }
  }
  throw new Error(`所有下载源都失败：\n  ${errors.join('\n  ')}`);
}

/**
 * 解析 zip 中央目录并抽出一个条目。
 *
 * 手写而不是引入依赖的原因同上：profile 侧解析不到 unzip 类包。
 * zip 结构：文件数据在前，[End of Central Directory] 在最后。
 */
async function unzipOne(zipPath, outPath, wantName) {
  const buf = await fsp.readFile(zipPath);
  // EOCD 签名 0x06054b50，从尾部往前找
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');

  const total = buf.readUInt16LE(eocd + 10);
  let cdOff = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < total; n++) {
    if (buf.readUInt32LE(cdOff) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(cdOff + 10);
    const compSize = buf.readUInt32LE(cdOff + 20);
    const nameLen = buf.readUInt16LE(cdOff + 28);
    const extraLen = buf.readUInt16LE(cdOff + 30);
    const commentLen = buf.readUInt16LE(cdOff + 32);
    const localOff = buf.readUInt32LE(cdOff + 42);
    const name = buf.slice(cdOff + 46, cdOff + 46 + nameLen).toString('utf8');

    if (name === wantName || wantName === '*') {
      // 本地文件头：签名 + 30 字节固定部分，再跳过 name/extra
      if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);

      let out;
      if (method === 0) out = raw;                       // stored
      else if (method === 8) out = await inflate(raw);   // deflate
      else throw new Error(`不支持的压缩方式: ${method}`);

      await fsp.writeFile(outPath, out);
      return { name, bytes: out.length };
    }
    cdOff += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 内找不到 ${wantName}`);
}

function inflate(buf) {
  return new Promise((resolve, reject) => {
    import('node:zlib').then(({ inflateRaw }) => {
      inflateRaw(buf, (err, data) => (err ? reject(err) : resolve(data)));
    }).catch(reject);
  });
}

/**
 * 确保内核就位。已有则跳过。
 * @param {{dir:string, url:string, entry:string, exe:string, mirrors?:string[], onLog?:(m:string)=>void}} spec
 */
export async function ensureKernel(spec) {
  const exePath = join(spec.dir, spec.exe);
  try {
    const st = await fsp.stat(exePath);
    if (st.size > 1024 * 1024) return { ok: true, cached: true, path: exePath, bytes: st.size };
  } catch { /* 不存在，继续下载 */ }

  await fsp.mkdir(spec.dir, { recursive: true });
  const tmp = join(spec.dir, 'kernel.zip.tmp');

  const res = await getWithMirrors(spec.url, spec.mirrors, spec.onLog);
  // IncomingMessage 本身就是一个 Readable，直接 pipeline 即可；
  // 用 Readable.fromWeb 包一层会报 "must be an instance of ReadableStream"。
  //
  // 注意：连接已建立后没有首字节超时了，这里再补一个整体超时，
  // 否则下载中途卡住会一直挂着（自测里就卡死过一次，占着临时文件不动）。
  await withDeadline(pipeline(res, createWriteStream(tmp)), 10 * 60 * 1000, '下载内核超时（10 分钟）');

  const info = await unzipOne(tmp, exePath, spec.entry);
  await fsp.unlink(tmp).catch(() => {});
  return { ok: true, cached: false, path: exePath, bytes: info.bytes };
}

/** 给一个 promise 加整体超时。 */
function withDeadline(p, ms, msg) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms).unref?.()),
  ]);
}

/** 查询最新版本号（用于提示升级）。 */
export async function latestVersion(apiUrl, { mirrors, onLog } = {}) {
  // api.github.com 直连通常可用（实测 1.5s），但也要能回退
  const res = await getWithMirrors(apiUrl, mirrors ?? ['', ...DEFAULT_MIRRORS.slice(1)], onLog);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return j.tag_name ?? null;
}
