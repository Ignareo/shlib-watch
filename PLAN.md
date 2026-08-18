# PLAN · 读者视角改进计划

面向普通读者的两个出发点：①书单上哪些书现在能借、去哪个馆借、哪些只能馆内看；②图书馆有没有、难不难借，作为买不买的参考。

多 agent 并行开发，按**文件归属**分组以最大限度避免合并冲突。`docs/app.js` 是冲突热点，凡涉及它的组已在下面标注各自负责的函数区间，开发时不越界。

---

## 组 1 · 采样器数据层（sampler/）

**归属文件**：`sampler/src/parsers.js`、`sampler/src/books.js`、`sampler/src/index.js`、`sampler/src/store.js`、`sampler/test/`（fixture 与单测）

### 1. 修复借出册「预计归还时间」解析
- 现状：`rawStatus` 混入整段页面 JS（已知问题），真实归还日期在 `itemReturnDate` AJAX 接口后。
- 方案：解析 HTML 时提取每册 `data-itemid`；借出册额外请求 `AJAX/JSON?method=itemReturnDate&itemId=...` 拿归还日期；清洗 `rawStatus`（剔除 JS 文本，只保留「已借出/已归还」等纯状态）。
- 数据格式：copy 级新增 `dueDate`（ISO 日期字符串或 null）；`rawStatus` 保持干净原文。
- 限速权衡：每册多一次请求，仅在借出册上触发；受 `config.json.request.intervalMs` 节制。
- 必须同步更新 `sampler/test/run.js` fixture 测试。

### 3. 元数据回填
- 现状：resolve 走 `.cache/records.json` 缓存路径时不回填作者/出版社/年份，index.json 大量 null。
- 方案：缓存命中时若 index.json 元数据缺失，用缓存中已存的候选信息回填；缓存也没有则补一次记录页解析。
- 顺带：检查 `branches` 列表对消失分馆的容忍（history 有而 index 无的分馆不应崩溃）。

**产出契约**（供前端组依赖）：
```jsonc
// history copy 级
{ "dueDate": "2026-08-25" | null, "rawStatus": "已借出", ... }
// index.json book 级
{ "authors": [...], "publisher": "...", "publishedYear": "...", "materialType": "..." }
```

---

## 组 2 · 书单分组 / 标签（预研 + 实现）

**归属文件**：`books.txt`、`sampler/src/books.js`、`sampler/src/index.js`（index.json 生成）、`docs/app.js` 仅 `书单助手` 段落（生成 books.txt 的函数区间）

### 7. 书单分组 / 分 tag
- **先预研、写结论再动手**，候选方案：
  - A. books.txt 增加组头语法（如 `## 建筑` 行），解析为每书的 `group` 字段；
  - B. 行尾第四列写 tag（`书名 | 索书号 | record_id | tag1,tag2`）；
  - C. 组与 tag 都支持（组用于分节展示，tag 用于筛选）。
- 评估维度：books.txt 的人类可写性、向后兼容（旧格式必须照常工作）、书单助手的编辑/生成成本、index.json schema 变化。
- 实现：解析进 index.json（book 级 `group` / `tags`）；前端书卡按组分节、按 tag 筛选（筛选条扩展，与组 3 的筛选区间协调）；书单助手支持分组编辑。
- 现有 books.txt 的空行分组（建筑/上海 citywalk/香港…）可作为首批分组数据。

**产出契约**：index.json book 级新增 `group?: string`、`tags?: string[]`。

### 预研结论（选 C：组头 + 行尾 tag）

- **人类可写性**：组头 `## 组名` 与 markdown 直觉一致，一目了然；tag 写行尾第四列（逗号分隔），与现有三列管道风格统一。两者都比"每行重复写组名"（纯方案 B 代替分组）省字。
- **向后兼容（决定性因素）**：`## 组名` 以 `#` 开头，旧版 sampler 本来就把 `#` 行当注释跳过，旧格式书单在旧/新代码里都照常工作；第四列 tag 同理——旧 `parseBooksFile` 只解构前三列，多出的列天然被忽略。旧 index.json 无 `group`/`tags` 字段，前端按"无分组默认节、无 tag 不出筛选 chips"处理，零迁移成本。
- **书单助手成本**：A 只需在生成时按组聚类输出 `##` 行；B 只需表格加一列；C 是两者叠加，增量都很小，且导入侧 `##` 行与第四列均可无损还原。
- **schema 变化**：book 级两个可选字段，有值才输出，不污染旧数据；分节（group）与筛选（tag）职责正交——组解决"书单长了之后的浏览结构"，tag 解决"跨组主题筛选"（如"散步"横跨上海/香港两组）。
- 结论：C。A 或 B 单独都会留下另一半需求（分节 or 筛选）无着落，而 C 的额外成本仅是一行组头语法 + 一个表格列。

---

## 组 3 · 前端展示与交互（docs/app.js 主体）

**归属文件**：`docs/app.js` 的 `renderAvailability / availabilityGroup / buildBookCard / renderFilterBar` 区间，`docs/index.html`、`docs/styles.css`

### 2. 拆分「仅馆内浏览」为三组
- `availabilityGroup()` 拆为：`available`（现在可外借）/ `borrowed_out`（普通外借册全部借出，可蹲点）/ `inhouse`（仅馆内阅览，无普通外借册）/ `nodata`。
- 顶部可借看板、筛选 pills、书卡状态文案同步更新；区分「今天没了」和「永远借不出」。

### 5. 每书一行「行动建议」
- 书卡顶部生成一句话建议，按优先级取第一条命中的：
  - 主馆有可借 →「✅ 东馆 3 册在架（2 楼普通借阅区）」（location 精确到楼层）
  - 网借中心有可借 →「📦 网借中心可约，支持线上下单送书」
  - 全部借出且有 dueDate →「⏳ 全部借出，最早预计 8-25 归还」（依赖组 1 的 dueDate；无 dueDate 时降级为「全部借出」）
  - 仅馆内阅览 →「🏛 仅馆内阅览，不可外借」
- 网借中心从「其他分馆」折叠中提出来，单独一行展示（享借是对读者最友好的渠道）。

### 6. 「新变得可借」高亮
- localStorage 记录上次访问时各书的 `availabilityGroup`；本次加载后对比，从「不可借」变为「可借」的书在顶部看板和书卡上加「新可借」标记。
- 键名建议 `last-availability`，存 `{ bookId: group }` + 时间戳；超过 N 天（如 30 天）未访问则不提示，避免刷屏。

### 9. 冷启动期兜底
- 采样 <3 次不出分的现状保留，但书卡不再显示「—」了事：显示已有采样天数、最近一次状态、与上一次采样的变化（在架册数增减）。
- 顶部「平均难借分」在无一本书出分时显示「数据积累中」而非「—」。

---

## 组 4 · 口径与指标（docs/app.js 统计区间）

**归属文件**：`docs/app.js` 的 `mainBranches / sampleCounts / computeStats / ratingOf` 区间，`docs/index.html` 设置入口

> 与组 3 同改 app.js，**按函数区间划分边界**，建议错时合并或同一分支串行。

### 4. 可借判定口径可配置
- 默认仍为淮海路馆＋东馆；书卡区加分馆选择（checkbox/chips），选择存 localStorage（`branch-prefs`）。
- `mainBranches()` 改为读偏好，无偏好回落默认；筛选、分组、难借分全部跟随新口径。
- index.json `branches` 全量列表作为可选项来源。

### 8. 难借分公式迭代
- 现状：`(1-在架率)×80 + 周末落差×20`。
- 改进点：
  - 周末落差在周末样本 <5 次时降权或剔除（小样本噪声大）；
  - 引入副本基数折减：1 册在架率 100% ≠ 10 册 100%（如按 `log(册数)` 或分档）；
  - 引入连续无书信号：最新连续全部借出的天数越长分越高。
- 公式与三档评级文案同步更新；`computeStats` 注释写明新口径；评分卡说明文字（`score-caption`）同步。

---

## 组 5 · 数据导出

**归属文件**：`docs/app.js` 历史数据栏段落、`docs/index.html`

### 10. 数据导出 CSV
- 「历史数据栏」加「导出 CSV」按钮：逐行输出 `日期, 星期, 书名, 索书号, 分馆, 普通外借在架/总数, 参考外借, 保存/阅览`（粒度：书 × 分馆 × 日期）。
- 前端即时生成 Blob 下载，纯静态可实现；注意 Excel 打开中文 CSV 的 BOM（`\ufeff`）。

---

## 依赖与顺序

```
组 1（dueDate/元数据） ──→ 组 3-5 行动建议（dueDate 降级可用，不阻塞）
组 2（分组 tag 预研） ──→ 组 3 筛选条扩展（预研结论先出，避免返工）
组 3 与组 4 同改 app.js ──→ 按函数区间分工，先后合并
组 5 独立，随时可做
```

- 建议第一批并行：组 1、组 2（预研）、组 3、组 5。
- 组 4 在组 3 合并后启动，或与组 3 约定区间后并行。
- 每组验收：sampler 改动必须 `cd sampler && npm test` 通过；前端改动需验证真实数据 + demo 两种模式；commit message 用中文。
