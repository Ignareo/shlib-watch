# AGENTS.md

给 AI 代理的项目说明。详细信息见 [README.md](README.md)。

## 项目概述

「图书难借吗」：周期性观测上海图书馆指定图书的馆藏状态，积累数据回答"这本书有多难借"。纯静态架构、无数据库：

```
books.txt（书单）→ sampler 抓取馆藏 → docs/data/*.json（git 提交回仓库）→ docs/ 静态看板
```

## 目录结构

- `books.txt` — 追踪书单，**唯一权威来源**。格式：`书名 | 索书号 | record_id(可选) | 标签(可选，逗号分隔)`；多卷册一行多索书号，用 `;`/`；` 分隔（多索书号行不适用 record_id）；`#` 开头为注释（即"停用"）；`## 组名` 为分组标题行，作用于其后所有书（单独的 `##` 回到未分组）
- `config.json` — 采样周期（schedule）、请求限速（request）、git 自动提交（git.autoCommit/autoPush）配置
- `server.js` — 本地看板服务器（Node ≥20，**零依赖**，ESM）。托管 `docs/` + `POST /api/sample`（执行采样）+ `GET /api/sample/status`（进度）。环境变量：`PORT`（默认 8765）、`SAMPLE_CMD`（覆盖采样命令，测试用）
- `sampler/` — 采样器（Node ≥20，ESM，唯一依赖 cheerio）
  - `src/index.js` CLI 入口（sample/prune/check，薄壳）；`run-sampling.js` 采样主流程（**两端共用**）；`platform.js` **平台抽象**（Node 实现；接口约定见文件头注释）；`client.js` HTTP（限速/重试/验证码识别，fetch 与 cookie 策略经 platform 注入）；`parsers.js` HTML 解析；`normalize.js` 状态归一化；`books.js` books.txt 解析（`parseBooksText` 纯文本入参）+ record_id 匹配；`store.js` JSON 读写（`createStore(platform)` 工厂）+ prune；`git.js` 采样后自动 commit/push（仅 Node）；`captcha.js` Playwright 人工过码（仅 Node）；`duedate.js` 借出册预计归还日期补查
  - **核心同构约定**：`run-sampling/parsers/normalize/books/store/record-cache/schedule/duedate/client` 禁止 import `node:*`，一切 I/O 走 platform 注入；新增平台相关逻辑一律加在 platform 接口上，不要写进核心模块
  - `test/run.js` 手写的 node:assert 单测（fixture HTML 驱动，无测试框架；含内存 platform 的 runSampling 端到端用例）
- `mobile/` — 安卓 App（Capacitor 7）：`sampler-entry.js` App 端 platform 实现（CapacitorHttp 绕 CORS / Filesystem 存储 / WebView 内过码，暴露 `window.BbtApp`）；`build.mjs` 构建（拷 docs/ → www/ + esbuild 打 sampler 核心 + cap sync）；`android/` 原生工程；`www/` 为构建产物（已 gitignore）
- `docs/` — GitHub Pages 站点（原生 HTML/CSS/JS + vendored ECharts，**无框架无构建**）
  - `app.js` 全部前端逻辑（看板渲染、难借分计算与易借指数换算、书单助手、历史清理）
  - `data/index.json` 书目索引 + 分馆列表；`data/history/{bookId}.json` 每书采样历史
- `.github/workflows/sample.yml` — 每天 10:05（北京时间）定时采样，支持 workflow_dispatch 手动触发
- `.cache/` — record_id 缓存（records.json）、验证码会话（session.json），已 gitignore

## 常用命令

```bash
node server.js                        # 本地看板 http://localhost:8765（书单助手按钮变为「重新采样」）
cd sampler && npm install && npm test # 运行单测（改动 sampler 后必须跑）
cd sampler && npm run sample:force    # 强制采样一次（会请求真实网站并自动 git commit+push）
cd sampler && npm run check           # 查看今天是否为采样日
cd mobile && npm install && npm run build  # 构建安卓工程（APK 需 Android Studio / gradle assembleDebug）
```

## 关键约定

- **易借指数**（UI 层，0–5 星，星越多越好借）由内部「难借分」换算：难借分只在前端（docs/app.js `computeStats`）即时计算，不持久化：在架率按册数折减（约 1 册 ×0.6 / 2 册 ×0.8 / 3–4 册 ×0.9 / ≥5 册 ×1.0）；周末样本 ≥5 次时启用「在架率 80 + 周末落差 20」，不足则在架率独占 100 分；最新连续 0 册在架 ≥3/≥7/≥14 天加 5/10/20 分，封顶 100。UI 换算 `starsOf`：(100 − 难借分) ÷ 20 四舍五入取整星。采样 <3 次不出星（显示「数据积累中」）。口径为**普通外借册**：circulationType 含"保存"/"仅供阅览"/"参考外借"的册不计入分母；无普通外借册的书显示「仅馆内阅览」
- **App 模式**（`docs/app.js` 顶部 `isNative` 检测 `window.Capacitor` + `window.BbtApp`）：`fetchJson("data/*")` 分流到本机 Filesystem（读不到时回退 APK 内置种子）；「刷新数据」变为本机「重新采样」；「下载 books.txt」变为「保存到本机」；隐藏 GitHub Actions 区；App 打开时今天无样本则自动补采（周期判断在 sampler 核心，非采样日自动跳过；手动点为强制）。**网页端 `vendor/sampler-bundle.js` 恒 404，属预期**
- **观测口径默认淮海路馆＋东馆**（前端 `mainBranches()`），用户可在「观测口径」chips 勾选分馆（偏好存 localStorage 键 `branch-prefs`，分馆名数组；无偏好/空偏好/偏好全部失效时回落默认，默认无匹配返回 null = 全部分馆），采样时抓取全部分馆。**书卡分馆小表（`branchRowsHtml`）与行动建议的网借提示只显示口径内分馆**（未勾选的一律不出现）；分馆行文案为「可外借 X/Y 册 · 馆内借读 Z 册」（X/Y=普通外借在架/总数，Z=参考外借；保存/阅览不单列，仅有保存/阅览册的馆兜底一行），无册级明细的旧数据按聚合值兜底「在架 X / 共 Y 册」
- 借阅类型分桶（前端 `bucketOf()`）：含"参考外借"→橙（馆内借读）；含"保存"/"仅供阅览"→灰；含"普通外借"或 null→绿
- index.json 中 `callNumber` 兼容两种形态：字符串（单索书号）或数组（多卷册），前端用 `callNumberText()` 统一处理
- **book id 关联历史文件** `data/history/{id}.json`：采样前 `assignStableIds`（sampler/src/books.js）按索书号集合→书名沿用既有 index.json 的 id，新书分配未占用 id（不复用已删除书的 id）；勿让 id 随 books.txt 行号漂移，否则历史串书
- 书单助手草稿存浏览器 localStorage（key `booklist-draft`），不写入仓库；生效必须提交 books.txt。编辑器为**数据模型驱动**（`rows` 数组渲染成分段表格）：分组段标题行可重命名/解散分组，行首 ⠿ 手柄拖拽调序/换组（HTML5 DnD，仅桌面端）；索书号**随改随校验**（无手动校验按钮）；产物只保留「下载 books.txt」（无生成预览/复制按钮）；草稿不再含 tags（读取旧草稿时忽略该字段）
- 筛选条两段：在馆状态 pills（单选）＋分组 chips（有分组数据才出现，再点取消），可叠加过滤；书卡按 `group` 分节渲染，未分组节标题为「未分组」。**前端已不再展示/编辑标签**（books.txt 第 4 列标签 sampler 仍会解析写入 index.json，前端忽略）
- **易借指数的计算说明在书卡星星的悬浮/点击气泡里**（`.stars-tip`，按该书实际生效维度逐项列出；桌面 :hover、触屏点击切换 .open，全站不再有独立说明条）；分享：书卡标题旁「分享」按钮（移动端 Web Share API / 桌面端复制 `#card-id` 锚点链接，渲染后补一次 hash 定位），分享卡片图 `docs/og-image.png`（1200×630，og:image 用相对路径，部署域名确定后改绝对 URL）
- 采样器修改后同步更新 `sampler/test/run.js` 的 fixture 测试；前端改动需验证真实数据和 demo 两种模式
- 代码注释、commit message 用中文，风格参照现有代码

## 已知问题 / 注意事项

- App 端待真机实测点：① CapacitorHttp 的重定向 URL（`response.url`）与 form POST 行为；② 验证码 WebView 跳转后 cookie 是否被原生层共享；③ 手机网络 IP 触发风控的频率可能高于家庭宽带（可调大 config.json `request.intervalMs`）
- 借出册 copy 级新增 `itemId` / `dueDate` 字段：itemId 来自馆藏页「预计归还时间」组件的 data-itemid，dueDate 由采样时补查 `AJAX/JSON?method=itemReturnDate` 接口回填（仅借出册发请求，失败置 null）；`rawStatus` 已在解析层剔除内嵌 JS（`cleanStatusText`）
- 元数据回填：resolve 缓存命中时优先用 `.cache/records.json` 里存的 meta 回填 index.json；缓存也没有则补抓一次记录页（`parseRecordMetadata`）回填并写回缓存。缓存值兼容旧字符串与新对象 `{recordId, meta}` 两种形态
- 触发人机验证时 sampler 会弹 Playwright 窗口需人工过码（需 `npm install playwright && npx playwright install chromium`）
- 上图网页改版会导致解析失效，需更新 `sampler/src/parsers.js`（`parseRecordMetadata` 的详情页结构未经在线验证，为防御性解析）
