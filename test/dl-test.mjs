#!/usr/bin/env node
/**
 * 只测「内核获取」这一段：镜像回退 + 下载 + 解压。
 * 单独拆出来是因为完整自测要拉起内核、等 24 秒空闲，迭代太慢。
 *
 * 上游：mihomo（Clash.Meta 内核）© MetaCubeX — https://github.com/MetaCubeX/mihomo
 * DSH 版本：面向 DeepSeek Harness 0.2.0-rc.2 开发验证。
 * 自用免责：按「原样」提供、无担保，使用后果自负。
 * 自动安装提醒：本测试**会真的联网下载内核（约 61MB）**到临时目录。
 */
import { promises as fsp } from 'node:fs';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { ensureKernel, latestVersion, DEFAULT_MIRRORS } from '../lib/downloader.js';

const DIR = 'C:\\Users\\暝\\AppData\\Local\\Temp\\dsh-proxy-dl-test';
rmSync(DIR, { recursive: true, force: true });
await fsp.mkdir(DIR, { recursive: true });

const t0 = Date.now();
const tag = await latestVersion('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest', {
  onLog: (m) => console.log('   ' + m),
});
console.log(`latestVersion -> ${tag}  (${Date.now() - t0}ms)`);

const ver = tag.startsWith('v') ? tag : `v${tag}`;
const t1 = Date.now();
const k = await ensureKernel({
  dir: DIR,
  url: `https://github.com/MetaCubeX/mihomo/releases/download/${ver}/mihomo-windows-amd64-${ver}.zip`,
  entry: 'mihomo-windows-amd64.exe',
  exe: 'mihomo.exe',
  mirrors: DEFAULT_MIRRORS,
  onLog: (m) => console.log('   ' + m),
});
console.log(`ensureKernel -> ${JSON.stringify(k)}  (${Date.now() - t1}ms)`);

// 内核必须能跑起来：`-v` 打印版本号后退出
const { execFileSync } = await import('node:child_process');
let verOut = '';
try {
  verOut = execFileSync(join(DIR, 'mihomo.exe'), ['-v'], { encoding: 'utf8', timeout: 20000 }).trim();
} catch (e) {
  verOut = 'ERR ' + (e?.message ?? e);
}
console.log(`mihomo -v -> ${verOut}`);

const ok = k.ok && k.bytes > 20e6 && /mihomo/i.test(verOut) && existsSync(join(DIR, 'mihomo.exe'));
console.log(ok ? '\nDLTEST: PASS' : '\nDLTEST: FAIL');
process.exit(ok ? 0 : 1);
