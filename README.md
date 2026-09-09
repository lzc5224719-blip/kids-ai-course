# 儿童 AI 课程 · 星星大冒险（在线版）

面向 9-12 岁孩子的「用 AI 造游戏」课堂项目：孩子认领角色 → 在制作台指挥 AI 改游戏（调参数/加玩法/写脚本）→ 存版本 → 分享给朋友玩，朋友玩完可给创作者提建议。

## 技术栈
- 纯前端 4 页 + 零依赖 Node 后端（无 npm 依赖，只需 Node 运行时）
- 端口：环境变量 PORT 或 9000
- AI：DeepSeek（OpenAI 兼容），key 走环境变量 `DEEPSEEK_API_KEY`

## 一键部署到 Render（免费，推荐）
1. **注册 GitHub**（免费）：github.com → 建一个 **Private** 仓库（如 `kids-ai-course`）。
2. 把本目录内容推上去（不要含 `ai-config.json`——.gitignore 已挡）：
   ```bash
   git init && git add . && git commit -m "init"
   git remote add origin https://github.com/<你的用户名>/kids-ai-course.git
   git push -u origin main
   ```
3. **注册 Render**（免费）：render.com → New → Web Service → 连接 GitHub 选该仓库。
4. 服务类型选 Web，其余按 `render.yaml` 自动；**关键一步**：在 Render 的 Environment 里添加环境变量：
   - key：`DEEPSEEK_API_KEY`
   - value：你在 platform.deepseek.com 生成的 key（保密，勿外传）
5. 点 Deploy，等 1-2 分钟。打开 Render 给的 `https://xxx.onrender.com` 验证：
   - `/api/health` 返回 `{"ok":true,"mock":false}`
   - 打开首页能认领角色、进制作台能跟 AI 对话。
6. （可选）在 Render 后台 Settings 里加自定义域名，比如 `star.你的域名.com`。

## 部署后怎么用分享/裂变
- 用 **Render 的 https 域名**打开工坊 → 制作台存版本 → 点「🔗 分享」→ 生成的链接就是公网的，发朋友圈/微信，任何设备打开即玩；
- 朋友玩完可提建议，建议存在服务器 `.wb-data/suggestions.json`，创作者回工坊首页「💌 大家给我的建议」可见。

## 安全提醒
- `ai-config.json` 与 `.wb-data/` 已被 .gitignore 和 server 双重拒绝对外（server 会 404）。
- 正式环境不要放 `ai-config.json`，只用 `DEEPSEEK_API_KEY` 环境变量。
- 本地开发仍可放 `ai-config.json`（不入库）。

## 已知限制（免费版）
- Render 免费实例的磁盘是临时的：服务重启/重新部署后，`.wb-data/` 里的建议会清空。
- 课堂使用没问题；若要让建议长期保存，后续可接一个免费数据库（如 Render 的 Postgres 或 SQLite 持久盘）。

## 本地跑
```bash
node server.js   # 打开 http://localhost:9000/workshop_v1/
```
