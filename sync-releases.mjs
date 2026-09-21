#!/usr/bin/env node
// 把上游 GitHub releases(含 APK 附件)补进 Codeberg 副本。
//   node sync-releases.mjs            全量同步(可重复执行,已存在且大小一致的会跳过)
//   node sync-releases.mjs --check    只比对清单,不下载不上传
// 退出码: 0 完成 / 1 出错
// 需要 .secrets/github_token.txt 与 .secrets/codeberg_token.txt(或同名环境变量)。
//
// 为什么单独写这个:Codeberg 的 git-only 迁移不带 releases,而且迁移来的仓库
// has_releases 默认是 false(实测接口 404),要先 PATCH 打开单元才能建 release。
import { readFileSync } from 'node:fs';

// 已知凭证 + 常见 token 形态,在写任何错误信息前先打码:Forgejo/GitHub 会把请求里的
// token 原样回显进报错正文,不打码就会进日志、进 Actions 输出、进对话记录。
const REDACT = [];
function keep(v) { REDACT.push(v); return v; }
function redact(s) {
  return REDACT.reduce((acc, v) => acc.split(v).join('[MASKED]'), s)
    .replace(/[0-9a-f]{40}/g, '[MASKED]')
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[MASKED]');
}

import { createHash } from 'node:crypto';

const UP = 'jichuo1/Bilibili_Innocent_Lab';
const DST = 'IST/Bilibili_Innocent_Lab';
const GH = `https://api.github.com/repos/${UP}`;
const CB = `https://codeberg.org/api/v1/repos/${DST}`;
// 每个 release 自带的 SHA256SUMS.txt 用来核对 APK;缓存避免重复下载。
const sumCache = new Map();
const CHECK = process.argv.includes('--check');
// --only <tag> 只处理指定 release,便于在匿名限流下分批推进或单独重试。
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i > 0 ? process.argv[i + 1] : null; })();

const GH_TOKEN = secret('GITHUB_TOKEN', true);
const CB_TOKEN = secret('CODEBERG_TOKEN');
if (!GH_TOKEN) console.log('提示:无 GITHUB_TOKEN,走匿名 API(60 次/小时),约 135 次调用要分批。');
// Actions 自带的 GITHUB_TOKEN 只对本仓库有效,读别人的仓库可能被拒;那时退回匿名而不是停摆。
let sentToken = GH_TOKEN;
function ghHeaders() {
  return { 'User-Agent': 'release-sync', Accept: 'application/vnd.github+json', ...(sentToken && { Authorization: `Bearer ${sentToken}` }) };
}
const cbHeaders = (extra = {}) => ({ Authorization: `token ${CB_TOKEN}`, 'Content-Type': 'application/json', ...extra });

const upList = (await ghPages(`${GH}/releases?per_page=100`)).filter((r) => !ONLY || r.tag_name === ONLY);
const upAssets = upList.reduce((n, r) => n + r.assets.length, 0);
const downList = await cbPages(`${CB}/releases?per_page=50`);
const index = new Map(downList.map((r) => [r.tag_name, r]));
console.log(`上游 ${upList.length} 个 release / ${upAssets} 个附件;Codeberg 现有 ${downList.length} 个`);

let made = 0, madeAssets = 0, skipped = 0, bad = [];
for (const up of upList) {
  let local = index.get(up.tag_name);
  if (!local) {
    if (CHECK) { console.log(`[缺] ${up.tag_name}`); bad.push(up.tag_name); continue; }
    local = await json('Codeberg', await fetch(`${CB}/releases`, {
      method: 'POST',
      headers: cbHeaders(),
      body: JSON.stringify({
        tag_name: up.tag_name,
        name: up.name ?? up.tag_name,
        body: `${up.body ?? ''}\n\n---\n从 ${up.html_url} 同步的归档副本(${new Date().toISOString().slice(0, 10)})。`,
        draft: false,
        prerelease: !!up.prerelease,
      }),
    }));
    made++;
  }
  const have = new Map((local.assets ?? []).map((a) => [a.name, a]));
  for (const a of up.assets) {
    if (have.get(a.name)?.size === a.size) { skipped++; continue; }
    if (CHECK) { bad.push(`${up.tag_name}/${a.name}`); continue; }
    const bytes = await download(a);
    const sum = await sumsFor(up);
    if (sum && /\.apk$/i.test(a.name)) {
      const want = (sum[a.name] ?? Object.entries(sum).find(([k]) => k.includes(a.name))?.[1] ?? '').toLowerCase();
      const got = createHash('sha256').update(bytes).digest('hex');
      if (want && want !== got) { bad.push(`${up.tag_name}/${a.name} 哈希不符`); continue; }
      if (!want) console.log(`  ! ${up.tag_name}/${a.name} 在 SHA256SUMS.txt 里没有对应条目,未做哈希校验`);
    }
    const res = await fetch(`${CB}/releases/${local.id}/assets?name=${encodeURIComponent(a.name)}`, {
      method: 'POST',
      headers: { Authorization: `token ${CB_TOKEN}`, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!res.ok) { bad.push(`${up.tag_name}/${a.name} 上传失败 ${res.status}: ${(await res.text()).slice(0, 120)}`); continue; }
    madeAssets++;
    console.log(`  + ${up.tag_name}/${a.name} ${(bytes.length / 1048576).toFixed(2)}MB`);
  }
}

if (CHECK) {
  console.log(bad.length ? `待补 ${bad.length} 项:\n  ${bad.join('\n  ')}` : '✅ releases 已与上游一致');
  process.exitCode = bad.length ? 1 : 0;
} else {
  console.log(`完成:新建 release ${made} 个、附件 ${madeAssets} 个,跳过已存在 ${skipped} 个`);
  if (bad.length) { console.error(`❌ ${bad.length} 项有问题:\n  ${bad.join('\n  ')}`); process.exitCode = 1; }
}

async function sumsFor(release) {
  const a = release.assets.find((x) => x.name === 'SHA256SUMS.txt');
  if (!a) return null;
  if (!sumCache.has(a.id)) {
    // 格式是 "<hash>  <filename>",翻转让文件名做键。
    const text = (await download(a)).toString('utf8');
    sumCache.set(a.id, Object.fromEntries(text.split('\n').map((l) => l.trim().split(/\s+/).reverse()).filter(([n, h]) => n && h)));
  }
  return sumCache.get(a.id);
}

async function download(asset) {
  const res = await fetch(asset.url, { headers: { ...ghHeaders, Accept: 'application/octet-stream' } });
  if (!res.ok) throw new Error(`下载 ${asset.name} 失败 ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== asset.size) throw new Error(`${asset.name} 下载不完整: ${buf.length} != ${asset.size}`);
  return buf;
}

// 两边的列表接口都会静默截断(GitHub 的 refs 给 30 条、Forgejo 的 releases 也给 30 条),
// 必须跟 Link 头翻页,否则会把已存在的东西判成缺失、把备份漏掉。
async function pages(label, url, headers) {
  const all = [];
  let next = url;
  while (next) {
    const hdr = () => (typeof headers === 'function' ? headers() : headers);
    let res = await fetch(next, { headers: hdr() });
    if (label === 'GitHub' && (res.status === 401 || res.status === 403) && sentToken) {
      console.log(`GitHub 拒绝了 token(${res.status}),改用匿名请求。`);
      sentToken = '';
      res = await fetch(next, { headers: hdr() });
    }
    all.push(...(await json(label, res)));
    next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
  }
  return all;
}
function ghPages(url) { return pages('GitHub', url, () => ghHeaders()); }
function cbPages(url) { return pages('Codeberg', url, cbHeaders); }

async function json(who, res) {
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${who} 返回 ${res.status}: ${redact(JSON.stringify(data).slice(0, 400))}`);
  return data;
}

function secret(name, optional = false) {
  const fromEnv = process.env[name];
  if (fromEnv) return keep(fromEnv.trim());
  try {
    return keep(readFileSync(new URL(`.secrets/${name.toLowerCase()}.txt`, `file:${process.cwd()}/`), 'utf8').trim());
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`读取 ${name} 时出错(不是"文件不存在"): ${err.message}`);
    if (optional) return '';
    throw new Error(`缺少 ${name}:设为环境变量或写入 .secrets/${name.toLowerCase()}.txt`);
  }
}
