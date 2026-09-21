#!/usr/bin/env node
// 把 GitHub 仓库 jichuo1/Bilibili_Innocent_Lab 归档到 Codeberg 的控制器。
//   create   让 Codeberg 服务端一次性迁入全历史(有 GITHUB_TOKEN 时连 issues/PR/releases 一起搬)
//   watch    比对上游与 Codeberg 的 refs;有变化用退出码 2 通知 cron 去 push
//   verify   逐 ref 打印比对表,用来证明备份没漏
//   status   查看 Codeberg 侧仓库状态
// 退出码: 0 一致 / 1 出错 / 2 有变化需推送 / 3 上游已消失(此时 Codeberg 副本就是唯一副本)
// 凭证: 环境变量优先,其次读 .secrets/<名字小写>.txt。不进对话、不进 shell 历史。
//
// 为什么不是 pull mirror:Codeberg 管理员已禁用新建 pull mirror,实测报
// 403 "the site administrator has disabled the creation of new pull mirrors"。
// 所以 Codeberg 只当存储,持续同步由 Actions 的 git push --mirror 完成。
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


const UPSTREAM_OWNER = process.env.UPSTREAM_OWNER ?? 'jichuo1';
const UPSTREAM_NAME = process.env.UPSTREAM_NAME ?? 'Bilibili_Innocent_Lab';
const UPSTREAM = `https://github.com/${UPSTREAM_OWNER}/${UPSTREAM_NAME}`;
const GH_API = `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_NAME}`;
const DST_OWNER = process.env.CODEBERG_OWNER ?? 'IST';
const DST_NAME = process.env.DST_NAME ?? UPSTREAM_NAME;
const DST = `${DST_OWNER}/${DST_NAME}`;

let GH_TOKEN = '';

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = err.exitCode ?? 1;
});

async function main() {
  const CB_TOKEN = secret('CODEBERG_TOKEN');
  GH_TOKEN = secret('GITHUB_TOKEN', true);
  const cmd = process.argv[2] ?? 'watch';

  const cb = (path, init = {}) =>
    fetchJson('Codeberg', `https://codeberg.org/api/v1${path}`, {
      ...init,
      headers: { Authorization: `token ${CB_TOKEN}`, 'Content-Type': 'application/json' },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

  if (cmd === 'create') {
    const body = {
      clone_addr: UPSTREAM,
      repo_owner: DST_OWNER,
      repo_name: DST_NAME,
      mirror: false,
      private: false,
      description: `Archive of ${UPSTREAM} — 防删除副本。源码版权归原作者与贡献者,保留原 GPL-3.0 LICENSE。`,
    };
    if (GH_TOKEN) {
      // Codeberg 实测:迁移 issues/PR/release 等元数据必须带源平台 token,否则只能走纯 git 迁移。
      Object.assign(body, {
        service: 'github',
        auth_token: GH_TOKEN,
        issues: true,
        labels: true,
        milestones: true,
        releases: true,
        wiki: true,
        lfs: true,
      });
    } else {
      console.log('未提供 GITHUB_TOKEN:只迁 git 历史,issues/releases 会跳过。');
    }
    const r = await cb('/repos/migrate', { method: 'POST', body });
    console.log(`迁移已提交 -> ${r.html_url ?? DST},Codeberg 正在服务端拉取。`);
    console.log('拉完跑 verify 逐 ref 核对;之后的持续同步由 Actions 推送。');
  } else if (cmd === 'status') {
    const r = await cb(`/repos/${DST}`);
    console.log(
      JSON.stringify(
        {
          repo: r.full_name,
          mirror: r.mirror,
          empty: r.empty,
          size_kb: r.size,
          open_issues: r.open_issues_count,
          default_branch: r.default_branch,
          url: r.html_url,
        },
        null,
        2
      )
    );
  } else if (cmd === 'watch' || cmd === 'verify') {
    const down = await cb(`/repos/${DST}/git/refs`);
    const mine = new Map((down.refs ?? down).map(toRef).map((r) => [r.name, r.sha]));
    const up = await upstreamRefs();
    if (!up) bail(`上游 ${UPSTREAM} 已不可访问 —— ${DST} 现在就是唯一副本。`, 3);
    const drift = up.filter((r) => mine.get(r.name) !== r.sha);

    if (cmd === 'verify') {
      console.table(up.map((r) => ({ ref: r.name, upstream: r.sha.slice(0, 10), codeberg: (mine.get(r.name) ?? 'MISSING').slice(0, 10) })));
      console.log(`上游 ${up.length} 个分支/标签,差异 ${drift.length} 个`);
      console.log(drift.length ? '❌ 镜像落后或缺失,跑一次 push 后重验' : '✅ 每个分支和标签的 commit 都与上游逐字一致');
      if (drift.length) process.exitCode = 2;
    } else if (drift.length) {
      console.log(`检测到 ${drift.length} 个 ref 变化: ${drift.map((d) => d.name).join(', ')}`);
      bail('需要推送(见 upstream-watch.yml 的 push 步骤)', 2);
    } else {
      console.log(`✅ 上游 ${up.length} 个 ref 全部一致,无需同步。`);
    }
  } else {
    bail(`未知子命令 ${cmd}:create | watch | verify | status`);
  }
}

async function upstreamRefs() {
  const all = [];
  let url = `${GH_API}/git/refs?per_page=100`;
  let sentToken = GH_TOKEN;
  while (url) {
    const res = await fetch(url, { headers: ghHeaders(sentToken) });
    if (res.status === 404 || res.status === 451) return null;
    // Actions 自带的 GITHUB_TOKEN 只对本仓库有效,读别人的仓库可能被拒;那就退回匿名,
    // 别让整个同步因为一次 403 停摆。
    if ((res.status === 401 || res.status === 403) && sentToken) {
      console.log(`GitHub 拒绝了 token(${res.status}),改用匿名请求。`);
      sentToken = '';
      continue;
    }
    all.push(...(await handle('GitHub', res)));
    // 该接口默认只给 30 条(本仓库实测 39 条),不翻页会静默漏掉备份内容。
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('link') ?? '')?.[1];
  }
  // refs/pull/* 由 Codeberg 以 PR 记录承载,不参与分支/标签的逐字比对。
  return all.filter((r) => !r.ref.startsWith('refs/pull/')).map(toRef);
}

function ghHeaders(token) {
  return {
    'User-Agent': 'codeberg-mirror-control',
    Accept: 'application/vnd.github+json',
    ...(token && { Authorization: `Bearer ${token}` }),
  };
}

// GitHub 与 Forgejo 的 ref 字段名在各版本间有出入,统一成 { name, sha }。
function toRef(r) {
  return {
    name: (r.ref ?? r.name ?? '').replace(/^refs\//, ''),
    sha: (r.object?.sha ?? r.new_oid ?? r.sha ?? r.created?.sha ?? '').slice(0, 40),
  };
}

async function fetchJson(who, url, init) {
  return handle(who, await fetch(url, init));
}

async function handle(who, res) {
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  // Forgejo/GitHub 会把请求里的 token 原样回显进错误信息,所以输出前一律打码,
  // 否则凭证会进日志、进 Actions 输出、进对话记录。
  if (!res.ok) bail(`${who} 返回 ${res.status}: ${redact(JSON.stringify(data).slice(0, 600))}`);
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
    bail(`缺少 ${name}:设为环境变量,或把值写入 ${process.cwd()}\\.secrets\\${name.toLowerCase()}.txt`);
  }
}

function bail(msg, exitCode = 1) {
  throw Object.assign(new Error(msg), { exitCode });
}
