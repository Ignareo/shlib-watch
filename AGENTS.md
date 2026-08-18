# AGENTS.md

给 AI 代理的项目说明。详细信息见 [README.md](README.md)。

## 项目概述

「图书难借吗」：周期性观测上海图书馆指定图书的馆藏状态，积累数据回答"这本书有多难借"。纯静态架构、无数据库：

```
books.txt（书单）→ sampler 抓取馆藏 → docs/data/*.json（git 提交回仓库）→ docs/ 静态看板
```

## 目录结构

- `books.txt` — 追踪书单，**唯一权威来源**。格式：`书名 | 索书号 | record_id(可选)`；多卷册一行多索书号，用 `;`/`；` 分隔（多索书号行不适用 record_id）；`#` 开头为注释（即"停用"）
- `config.json` — 采样周期（schedule）、请求限速（request）、git 自动提交（git.autoCommit/autoPush）配置
- `server.js` — 本地看板服务器（Node ≥20，**零依赖**，ESM）。托管 `docs/` + `POST /api/sample`（执行采样）+ `GET /api/sample/status`（进度）。环境变量：`PORT`（默认 8765）、`SAMPLE_CMD`（覆盖采样命令，测试用）
- `sampler/` — 采样器（Node ≥20，ESM，唯一依赖 cheerio）
  - `src/index.js` CLI 入口（sample/prune/check）；`client.js` HTTP（限速/重试/验证码识别）；`parsers.js` HTML 解析；`normalize.js` 状态归一化；`books.js` books.txt 解析 + record_id 匹配；`store.js` JSON 读写 + prune；`git.js` 采样后自动 commit/push；`captcha.js` Playwright 人工过码
  - `test/run.js` 手写的 node:assert 单测（fixture HTML 驱动，无测试框架）
- `docs/` — GitHub Pages 站点（原生 HTML/CSS/JS + vendored ECharts，**无框架无构建**）
  - `app.js` 全部前端逻辑（看板渲染、难借分计算、书单助手、历史清理）
  - `data/index.json` 书目索引 + 分馆列表；`data/history/{bookId}.json` 每书采样历史
- `.github/workflows/sample.yml` — 每天 10:05（北京时间）定时采样，支持 workflow_dispatch 手动触发
- `.cache/` — record_id 缓存（records.json）、验证码会话（session.json），已 gitignore

## 常用命令

```bash
node server.js                        # 本地看板 http://localhost:8765（书单助手按钮变为「重新采样」）
cd sampler && npm install && npm test # 运行单测（改动 sampler 后必须跑）
cd sampler && npm run sample:force    # 强制采样一次（会请求真实网站并自动 git commit+push）
cd sampler && npm run check           # 查看今天是否为采样日
```

## 关键约定

- **难借分**只在前端（docs/app.js `computeStats`）即时计算，不持久化：`(1-在架率)×80 + 周末落差×20`，采样 <3 次不出分。口径为**普通外借册**：circulationType 含"保存"/"仅供阅览"/"参考外借"的册不计入分母；无普通外借册的书显示「仅馆内阅览」
- **观测口径固定为淮海路馆＋东馆**（前端 `mainBranches()`），采样时抓取全部分馆
- 借阅类型分桶（前端 `bucketOf()`）：含"参考外借"→橙（馆内借读）；含"保存"/"仅供阅览"→灰；含"普通外借"或 null→绿
- index.json 中 `callNumber` 兼容两种形态：字符串（单索书号）或数组（多卷册），前端用 `callNumberText()` 统一处理
- 书单助手草稿存浏览器 localStorage（key `booklist-draft`），不写入仓库；生效必须提交 books.txt
- 采样器修改后同步更新 `sampler/test/run.js` 的 fixture 测试；前端改动需验证真实数据和 demo 两种模式
- 代码注释、commit message 用中文，风格参照现有代码

## 已知问题 / 注意事项

- 借出册的 `rawStatus` 偶尔混入页面内嵌 JS 文本（parsers.js 状态列提取问题），不影响分类，未修
- index.json 中作者/出版社等元数据多为 null（resolve 走缓存路径时不回填）
- 触发人机验证时 sampler 会弹 Playwright 窗口需人工过码（需 `npm install playwright && npx playwright install chromium`）
- 上图网页改版会导致解析失效，需更新 `sampler/src/parsers.js`
