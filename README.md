# bilibili-lab-sync-tools

检测上游 github.com/jichuo1/Bilibili_Innocent_Lab 的变化,并把 Codeberg 归档副本 IST/Bilibili_Innocent_Lab 推到最新。

本仓库被导入 GitHub 后由 GitHub Actions 每 5 分钟跑一次。需要在仓库 Settings → Secrets 里配一个名为 CODEBERG_TOKEN 的 secret(有 repository 写权限的 Codeberg access token);凭据不写在本仓库任何文件里。

- backup-codeberg.mjs — refs 比对与同步决策,退出码 2 表示需要推送
- .github/workflows/upstream-watch.yml — 定时任务本体
