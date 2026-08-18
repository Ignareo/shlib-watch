# 图书难借吗

周期性观测**上海图书馆**指定图书的馆藏状态，用积累的数据回答：这本书，到底有多难借？

- 数据来源：上海图书馆馆藏书目查询系统公开页面（`vufind.library.sh.cn`），无需登录
- 采样器：Node.js 脚本，可跑在 **GitHub Actions（定时）** 或 **你自己的电脑（本地模式）**
- 看板：纯静态网页，部署在 **GitHub Pages**，数据全部来自仓库里积累的 JSON

```
books.txt（书单）→ 采样器定时抓取馆藏 → docs/data/*.json（提交回仓库）→ GitHub Pages 看板
```

---

## 一、部署（约 5 分钟）

1. **建仓库**：把本项目所有文件推到你自己的 GitHub 仓库（public 仓库 Actions 免费）。
2. **开 Pages**：仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支选 `main`、目录选 `/docs`。等一两分钟，`https://<你的用户名>.github.io/<仓库名>/` 即可访问。
3. **开 Actions**：仓库 Actions 页启用 workflow。`.github/workflows/sample.yml` 已内置「每天上午 10:05（北京时间）」的定时任务，也可以在 Actions 页手动点 **Run workflow** 立即采样一次。

> ⚠️ GitHub 运行机是数据中心 IP，**可能触发上海图书馆的人机验证**导致采样失败。如果 Actions 日志里出现「触发了上海图书馆的人机验证」，请改用下面的本地模式（家庭宽带一般不会触发）。

## 二、添加要追踪的书

编辑仓库根目录的 `books.txt`，每行一本：

```
书名 | 索书号 | record_id（可选）
```

- 不填 `record_id` 时，采样器按「书名检索 → 索书号精确匹配」自动锁定记录；同名多版本时取副本数最多者，并在网页标注「版本待核对」
- 填了 `record_id`（检索结果页网址 `https://vufind.library.sh.cn/Record/<这串>` 里的部分）则 100% 锁定版本
- **多卷册**：一行支持多个索书号，用 `;` 或全角 `；` 分隔，各卷馆藏会合并成一条观测记录，例如：
  `中国建筑史 | TU-092/3965-20; TU-092/3965-17; TU-092/3965-19`
  多索书号行不适用第三列 `record_id`（写了会被忽略并警告）；任一索书号匹配失败会在网页标注「版本待核对」，全部失败才算未匹配
- 看板底部的「书单助手」支持录入/导入 txt、校验格式、生成标准 books.txt 内容

## 三、采样周期

编辑 `config.json`：

```json
{
  "schedule": {
    "frequency": "daily",        // daily 每天 / weekly 每周 / biweekly 每两周 / monthly 每月
    "weeklyDays": [3, 6],        // weekly/biweekly：周几采样（3=周三 6=周六，工作日+周末各一次）
    "anchorDate": "2026-08-17",  // biweekly：以哪天为第 0 周锚点
    "monthlyDay": 1              // monthly：每月几号
  }
}
```

Actions 每天到点都会唤醒，是否真正采样由上面的设置决定。改完提交即生效。

### 请求参数与采样速度

如果采样时频繁超时，可编辑 `config.json` 的 `request` 字段：

```json
{
  "request": {
    "intervalMs": 3000,
    "timeoutMs": 25000,
    "retries": 3
  }
}
```

- `intervalMs`：请求间隔（毫秒），默认 3000。越小采样越快，但过短可能被服务端限流
- `timeoutMs`：单次请求超时（毫秒），默认 25000。偶发慢响应可增大到 40000–60000
- `retries`：失败重试次数，默认 3

上海图书馆检索接口较慢（常需 6–13 秒），首次解析新书耗时较长；record_id 会缓存到 `.cache/records.json`，后续采样直接命中缓存、跳过慢检索。实测 7 本书：首次解析约 1 分 30 秒，缓存命中后约 15–20 秒。本地网络稳定时 `intervalMs: 1500` + `timeoutMs: 45000` 是较快的组合。

## 四、本地模式（推荐，稳定不触发风控）

```bash
node server.js          # 启动本地看板：http://localhost:8765
```

- 本地服务器既托管看板，也能**真实触发采样**：看板「书单助手」里的按钮此时显示为「重新采样」，点击即执行 `npm run sample:force`，日志实时显示在页面上；采样完成后自动重载数据
- 采样器本身也可单独跑：

```bash
cd sampler
npm install
node src/index.js sample --force   # 立即采样一次（忽略周期）
```

- 采样完成后会**自动 git commit + push** 数据回仓库（首次使用请确保本地 git 已配置推送凭据；不想自动推送可在 `config.json` 关掉 `git.autoPush`）
- 若触发人机验证，程序会**自动弹出浏览器窗口**，手动划一下验证码即可，会话 Cookie 缓存于 `.cache/session.json`，下次直接复用
  - 弹窗功能需要 Playwright：`npm install playwright && npx playwright install chromium`
- 定时执行：macOS/Linux 用 cron，Windows 用「任务计划程序」，例如每天上午 10 点运行 `node src/index.js sample`（不带 `--force`，尊重周期设置）

常用命令：

```bash
node src/index.js check              # 查看今天是否为采样日
node src/index.js sample             # 按周期采样（今天是采样日才执行）
node src/index.js sample --force     # 强制采样一次
node src/index.js prune --before 2026-06-01                # 删除 6 月前的历史
node src/index.js prune --dates 2026-08-01,2026-08-02      # 删除指定日期
```

## 五、看板功能

- **难借分**（0–100，越高越难借）= 在架率（80%）+ 周末落差（20%），配三档评级：随手可借 / 需要蹲点 / 极其抢手。指标按**普通外借册**口径计算（保存资料、参考外借、仅供阅览不计入；无普通外借册的书显示「仅馆内阅览」，不出分；采样不足 3 次暂不出分）
- **当前可借情况**：顶部按最新一次采样把书目分为「现在可外借」和「仅馆内浏览」两组，点击书名可定位到对应书卡
- **筛选**：可按「全部 / 可以外借 / 仅馆内浏览」过滤书卡
- 每本书：当前状态、分馆在架情况（淮海路馆/东馆平铺，其他分馆折叠）、借阅类型构成色带、在架率走势、工作日/周末对比。观测口径固定为淮海路馆＋东馆（采样时已抓取全部分馆数据）
- **书单助手**：自动载入当前追踪书目，可增删、启用/禁用、编辑；所有修改自动保存在浏览器（localStorage），刷新数据不会丢失，「重置为仓库书单」可丢弃草稿。生成 books.txt 后复制或下载（静态页面不直接改仓库，需人工提交）。「刷新数据」按钮：本地服务器（`node server.js`）下为「重新采样」，真实执行一次采样；静态托管（GitHub Pages）下重新拉取仓库数据，并可用「远程采样」入口触发 GitHub Actions（workflow_dispatch，也可在 Actions 页面手动点 Run workflow）
- **历史数据栏**：勾选特定日期或设置「删除早于某日」，生成 `prune.json` 提交到 `docs/data/`，下次采样自动清理

## 六、目录结构

```
├── books.txt                 # 追踪书单（唯一权威来源）
├── config.json               # 采样周期、请求、git 等配置
├── server.js                 # 本地看板服务器（零依赖，可触发真实采样）
├── .github/workflows/        # 定时采样 workflow
├── sampler/                  # 采样器（Node.js ≥ 20，依赖仅 cheerio）
│   └── src/                  # client(抓取) parsers(解析) captcha(过码) store(存储) …
└── docs/                     # GitHub Pages 站点
    ├── index.html / app.js / styles.css / vendor/echarts.min.js
    └── data/                 # 采样数据（index.json + history/*.json）
```

## 说明与免责

- 本项目为非官方工具，仅读取上海图书馆公开书目页面，低频采样（每书每日 2 个请求），不涉及账号与隐私
- 网页结构若改版会导致解析失效，采样器日志会报警，届时需要更新 `sampler/src/parsers.js`
- 数据采集自公开页面，准确性以图书馆系统实时状态为准
