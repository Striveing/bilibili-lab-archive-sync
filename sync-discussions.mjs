#!/usr/bin/env node
// 把上游 GitHub 的 issue / PR 描述补进 Codeberg 副本(幂等:按标题去重,可反复执行)。
// 需要 .secrets/codeberg_token.txt(read:issue + write:issue + write:repository),
// GITHUB_TOKEN 可选;带上 Actions 自带 token 时被拒会自动退回匿名。
import { readFileSync } from 'node:fs';

const UP = process.env.UPSTREAM_SLUG ?? 'jichuo1/Bilibili_Innocent_Lab';
const DST = process.env.CODEBERG_OWNER ?? 'IST';
const DST_NAME = process.env.DST_NAME ?? 'Bilibili_Innocent_Lab';
const GH = `https://api.github.com/repos/${UP}`;
const CB = `https://codeberg.org/api/v1/repos/${DST}/${DST_NAME}`;
const GH_TOKEN = secret('GITHUB_TOKEN', true);
// 声明必须在使用点之前:这是顶层 await 的脚本,let/const 不会有函数那样的提升。
let sentToken = GH_TOKEN;
const CB_TOKEN = secret('CODEBERG_TOKEN');
const CB_ = () => ({ Authorization: `token ${CB_TOKEN}`, 'Content-Type': 'application/json' });

const items = await ghPages(`${GH}/issues?state=all&per_page=100`);
const have = new Set((await cbPages(`${CB}/issues?state=all&per_page=50`)).map((i) => i.title));
let made = 0;
for (const it of items) {
  const isPR = 'pull_request' in it;
  if (have.has(it.title)) continue;
  let extra = '';
  if (isPR) {
    const pr = await gh(`${GH}/pulls/${it.number}`);
    extra = `\n- 合并状态:${pr.merged ? '已合并' : pr.state === 'closed' ? '已关闭、未合并' : '开放'}\n- 提交数 ${pr.commits},+${pr.additions} −${pr.deletions}\n- head \`${pr.head.sha}\`:已作为本仓库分支 \`archive/pr-${pr.number}\` 归档`;
  }
  const body = `${it.body ?? '(原文无正文)'}\n\n---\n> 上游归档:原 ${isPR ? 'PR' : 'issue'} [#${it.number}](${it.html_url}),由 @${it.user.login} 于 ${it.created_at} 创建${it.closed_at ? `,${it.closed_at} 关闭` : ''}。正文原样保留,归属原作者。${extra}`;
  const r = await fetch(`${CB}/issues`, { method: 'POST', headers: CB_(), body: JSON.stringify({ title: it.title, body, labels: [await labelId(isPR ? 'archived-pull-request' : 'archived-issue', isPR ? 'd1c4e6' : '6ba546')] }) });
  if (!r.ok) { console.error(`搬运上游#${it.number} 失败 ${r.status}: ${(await r.text()).slice(0, 200)}`); process.exitCode = 1; continue; }
  const c = await r.json();
  if (it.state === 'closed') await fetch(`${CB}/issues/${c.number}`, { method: 'PATCH', headers: CB_(), body: JSON.stringify({ state: 'closed', state_reason: 'done' }) });
  made++;
  console.log(`+ 上游#${it.number} -> ${DST}/${DST_NAME}#${c.number} [${it.state}] ${it.title.slice(0, 44)}`);
}
console.log(`上游 ${items.length} 条讨论,副本原有 ${have.size} 条,本次新增 ${made} 条`);

// 第二阶段:补评论。上游 issue/PR 正文下的讨论往往比正文更有信息量。
// 副本里没有上游编号,靠正文脚注 `[#N](url)` 反查对应的 Codeberg issue。
const local = await cbPages(`${CB}/issues?state=all&per_page=50`);
const byUpstream = new Map();
for (const l of local) {
  const n = /原 (?:PR|issue) \[#(\d+)\]/.exec(l.body ?? '');
  if (n) byUpstream.set(Number(n[1]), l);
}
let posted = 0, already = 0, orphan = 0, pending = 0, limited = false;
// Codeberg 对普通用户限流"6 条评论 / 5 分钟"(实测 429),所以每轮主动只写 5 条,
// 剩下的靠幂等标记留到下一轮 —— 不能把限流当成同步失败报红。
const CAP = 5;
for (const it of items) {
  const target = byUpstream.get(it.number);
  if (!target) { if ((it.comments ?? 0) > 0) orphan++; continue; }
  const existing = await cbPages(`${CB}/issues/${target.number}/comments?per_page=50`);
  const seen = new Set(existing.map((c) => /<!--upstream-comment:(\d+)-->/ .exec(c.body ?? '')?.[1]).filter(Boolean));
  const src = await ghPages(`${GH}/issues/${it.number}/comments?per_page=100`);
  for (const c of src) {
    if (seen.has(String(c.id))) { already++; continue; }
    if (posted >= CAP || limited) { pending++; continue; }
    const body = `<!--upstream-comment:${c.id}--> > 上游 [@${c.user.login}](${c.user.html_url}) · ${c.created_at} · 原评论 [#${c.number ?? ''}](${c.html_url})\n\n${c.body ?? ''}`;
    const r = await fetch(`${CB}/issues/${target.number}/comments`, { method: 'POST', headers: CB_(), body: JSON.stringify({ body }) });
    if (r.status === 429) { limited = true; pending++; console.log('  触到 Codeberg 限流(6 条/5 分钟),本轮停笔,余下的下一轮续传'); continue; }
    if (!r.ok) { console.error(`写评论 ${c.id} 失败 ${r.status}: ${(await r.text()).slice(0, 140)}`); process.exitCode = 1; continue; }
    posted++;
  }
}
console.log(`[评论] 本次新写 ${posted} 条,已存在跳过 ${already} 条${limited ? '(因限流提前收笔)' : ''}${pending ? `,仍有 ${pending} 条待下轮` : ''}${orphan ? `,${orphan} 条上游讨论在副本里没有宿主(重跑一次)` : ''}`);

async function labelId(name, color) {
  const list = await cb(`${CB}/labels`);
  const hit = list.find((l) => l.name === name);
  if (hit) return hit.id;
  const r = await fetch(`${CB}/labels`, { method: 'POST', headers: CB_(), body: JSON.stringify({ name, color }) });
  if (!r.ok) throw new Error(`建标签 ${name} 失败 ${r.status}`);
  return (await r.json()).id;
}

async function gh(url) {
  const r = await ghRaw(url);
  return r.json();
}
async function ghRaw(url) {
  let r = await fetch(url, { headers: ghHeaders(sentToken) });
  if ((r.status === 401 || r.status === 403) && sentToken) {
    console.log(`GitHub 拒绝了 token(${r.status}),改用匿名请求。`);
    sentToken = '';
    r = await fetch(url, { headers: ghHeaders('') });
  }
  if (!r.ok) throw new Error(`GitHub 返回 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}
function ghHeaders(token) {
  return { 'User-Agent': 'discussion-archiver', Accept: 'application/vnd.github+json', ...(token && { Authorization: `Bearer ${token}` }) };
}
async function ghPages(url) {
  const out = [];
  let n = url;
  while (n) {
    const r = await ghRaw(n);
    out.push(...(await r.json()));
    n = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1];
  }
  return out;
}
async function cb(url) { return (await cbRaw(url)).json(); }
async function cbRaw(url) {
  const r = await fetch(url, { headers: CB_() });
  if (!r.ok) throw new Error(`Codeberg 返回 ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}
async function cbPages(url) {
  const out = [];
  let n = url;
  while (n) {
    const r = await cbRaw(n);
    out.push(...(await r.json()));
    n = /<([^>]+)>;\s*rel="next"/.exec(r.headers.get('link') ?? '')?.[1];
  }
  return out;
}
function secret(name, optional = false) {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv.trim();
  try {
    return readFileSync(new URL(`.secrets/${name.toLowerCase()}.txt`, `file:${process.cwd()}/`), 'utf8').trim();
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`读取 ${name} 时出错(不是"文件不存在"): ${err.message}`);
    if (optional) return '';
    throw new Error(`缺少 ${name}:设为环境变量或写入 .secrets/${name.toLowerCase()}.txt`);
  }
}
