// 自测：解析器（fixture）、状态归一化、调度、清理、书单解析、归还日期、元数据回填
// 运行：cd sampler && npm install && node test/run.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { parseSearchResults, parseHoldings, groupByBranch, cleanStatusText, parseRecordMetadata } from "../src/parsers.js";
import { classifyAvailability } from "../src/normalize.js";
import { isSamplingDay } from "../src/schedule.js";
import { parseBooksFile, resolveBook, assignStableIds } from "../src/books.js";
import { parseReturnDateResponse, fillDueDates } from "../src/duedate.js";
import { readCacheEntry, pickCacheMeta } from "../src/record-cache.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}\n    ${error.message}`);
    process.exitCode = 1;
  }
}

// ---------- fixture：检索结果页 ----------
const SEARCH_HTML = `
<html><body>
<div class="result-body">
  <a class="title getFull" href="/Record/abc12345-1111-4000-8000-aaaaaaaaaaaa">城市研究 : 理论与方法 /</a>
  <div>
    <span class="author-data"><a href="/Author/Home?author=%E5%BC%A0%E6%98%8E">张明</a></span>
    出版社 : 同济大学出版社
    出版时间 : 2021
    索书号 : C912.81/4422
  </div>
  <div class="result-formats"><span class="format">图书</span></div>
</div>
<div class="result-body">
  <a class="title getFull" href="/Record/abc12345-2222-4000-8000-bbbbbbbbbbbb">活着</a>
  <div>
    <span class="author-data"><a>余华</a></span>
    出版社 : 作家出版社
    出版时间 : 2012
    索书号 : I247.5/8030-23
  </div>
  <div class="result-formats"><span class="format">图书</span></div>
</div>
</body></html>`;

// ---------- fixture：馆藏明细页（表格结构） ----------
const HOLDINGS_HTML = `
<html><body>
<h2>Branch: 上海图书馆</h2>
<div class="location-item">
  <h3>淮海路馆 3F 外借室</h3>
  <table>
    <tr vocab="http://schema.org/"><td>C912.81/4422</td><td>541210001</td><td>普通外借</td><td>在架</td></tr>
    <tr vocab="http://schema.org/"><td>C912.81/4422</td><td>541210002</td><td>普通外借</td><td>已借出</td></tr>
  </table>
</div>
<div class="location-item">
  <h3>东馆 2F 阅览区</h3>
  <table>
    <tr vocab="http://schema.org/"><td>C912.81/4422</td><td>541210003</td><td>参考阅览</td><td>仅供阅览</td></tr>
  </table>
</div>
<h2>Branch: 浦东新区图书馆</h2>
<div class="location-item">
  <h3>成人外借区</h3>
  <table>
    <tr vocab="http://schema.org/"><td>C912.81/4422</td><td>541210004</td><td>普通外借</td><td>在架</td></tr>
  </table>
</div>
</body></html>`;

// ---------- fixture：馆藏明细页（纯文本结构，兜底） ----------
const HOLDINGS_TEXT_HTML = `
<html><body><pre>
Branch: 上海图书馆
淮海路馆 3F 外借室
Call Number: I247.5/8030-23 barcode: 99001 Circulation Type: 普通外借 Circulation Status: 在架
Call Number: I247.5/8030-23 barcode: 99002 Circulation Type: 普通外借 Circulation Status: 已借出
</pre></body></html>`;

// ---------- fixture：馆藏明细页（借出册，状态列含内嵌 JS 与 data-itemid） ----------
const HOLDINGS_BORROWED_HTML = `
<html><body>
<h2>Branch: 上海图书馆</h2>
<div class="location-item">
  <h3>淮海路馆 3F 外借室</h3>
  <table>
    <tr vocab="http://schema.org/"><td>C912.81/4422</td><td>541210001</td><td>普通外借</td>
      <td>已借出
        <span class="item-return-date" data-itemid="987654">预计归还时间: <span></span><p style="display:none"></p></span>
        <script>$(".item-return-date").click(function () { const itemId = $(this).data('itemid'); $.ajax({ url : VuFind.path + "/AJAX/JSON?method=itemReturnDate", data: {itemId: itemId} }); })</script>
      </td></tr>
    <tr vocab="http://schema.org/"><td>C912.81/4422</td><td>541210002</td><td>普通外借</td><td>已归还</td></tr>
  </table>
</div>
</body></html>`;

// 真实采样数据里混入的内嵌 JS 原文（取自 docs/data/history/b1.json）
const POLLUTED_RAW_STATUS =
  '已借出 预计归还时间: $(".item-return-date").click(function () { if($(this).find("p").is(":hidden")){ ' +
  "const itemThis = this; const itemId = $(itemThis).data('itemid'); $(itemThis).find(\"p\").show(); " +
  '$.ajax({ type : \'GET\', url : VuFind.path + "/AJAX/JSON?method=itemReturnDate", data: {itemId: itemId} }); } })';

// ---------- fixture：书目详情页（元数据回填） ----------
const RECORD_PAGE_HTML = `
<html><head><meta property="og:title" content="城市研究 : 理论与方法"></head><body>
<script>var noop = function () {};</script>
<h1>城市研究 : 理论与方法</h1>
<table class="citation">
  <tr><th>主要责任者</th><td>张明 著; 李华 译</td></tr>
  <tr><th>出版社</th><td>同济大学出版社</td></tr>
  <tr><th>出版时间</th><td>2021</td></tr>
  <tr><th>资料类型</th><td>图书</td></tr>
</table>
</body></html>`;

const RECORD_PAGE_TEXT_HTML = `
<html><body><div>
作者 : 余华
出版社 : 作家出版社
出版日期 : 2012年5月
</div></body></html>`;

console.log("\n[1] 检索结果解析");
test("解析出两条记录及元数据", () => {
  const items = parseSearchResults(SEARCH_HTML);
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].recordId, "abc12345-1111-4000-8000-aaaaaaaaaaaa");
  assert.strictEqual(items[0].title, "城市研究 : 理论与方法");
  assert.strictEqual(items[0].callNumber, "C912.81/4422");
  assert.deepStrictEqual(items[0].authors, ["张明"]);
  assert.strictEqual(items[0].publisher, "同济大学出版社");
  assert.strictEqual(items[0].publishedYear, "2021");
  assert.strictEqual(items[0].materialType, "图书");
  assert.strictEqual(items[1].callNumber, "I247.5/8030-23");
});

console.log("\n[2] 馆藏明细解析");
test("表格结构：两个分馆四册，状态归一化正确", () => {
  const copies = parseHoldings(HOLDINGS_HTML);
  assert.strictEqual(copies.length, 4);
  assert.strictEqual(copies[0].branch, "上海图书馆");
  assert.strictEqual(copies[0].location, "淮海路馆 3F 外借室");
  assert.strictEqual(copies[0].availability, "available");
  assert.strictEqual(copies[1].availability, "unavailable");
  assert.strictEqual(copies[2].availability, "in_library");
  assert.strictEqual(copies[3].branch, "浦东新区图书馆");
});

test("按分馆聚合统计正确", () => {
  const branches = groupByBranch(parseHoldings(HOLDINGS_HTML));
  assert.strictEqual(branches["上海图书馆"].total, 3);
  assert.strictEqual(branches["上海图书馆"].available, 1);
  assert.strictEqual(branches["上海图书馆"].inLibrary, 1);
  assert.strictEqual(branches["上海图书馆"].unavailable, 1);
  assert.strictEqual(branches["浦东新区图书馆"].available, 1);
});

test("多条记录的 copies 拼接后按分馆合并（多卷册采样）", () => {
  // 模拟多索书号书：两条记录各抓一次馆藏，copies 拼接后统一聚合
  const merged = [...parseHoldings(HOLDINGS_HTML), ...parseHoldings(HOLDINGS_HTML)];
  const branches = groupByBranch(merged);
  assert.strictEqual(merged.length, 8);
  assert.strictEqual(branches["上海图书馆"].total, 6);
  assert.strictEqual(branches["上海图书馆"].available, 2);
  assert.strictEqual(branches["上海图书馆"].inLibrary, 2);
  assert.strictEqual(branches["上海图书馆"].copies.length, 6);
  assert.strictEqual(branches["浦东新区图书馆"].total, 2);
});

test("纯文本结构兜底解析", () => {
  const copies = parseHoldings(HOLDINGS_TEXT_HTML);
  assert.strictEqual(copies.length, 2);
  assert.strictEqual(copies[0].barcode, "99001");
  assert.strictEqual(copies[0].availability, "available");
  assert.strictEqual(copies[1].availability, "unavailable");
});

console.log("\n[2b] 借出册 rawStatus 清洗与 itemId 提取");
test("状态列内嵌 JS 被剔除，data-itemid 被提取", () => {
  const copies = parseHoldings(HOLDINGS_BORROWED_HTML);
  assert.strictEqual(copies.length, 2);
  assert.strictEqual(copies[0].rawStatus, "已借出"); // 不含「预计归还时间」和 JS
  assert.strictEqual(copies[0].itemId, "987654");
  assert.strictEqual(copies[0].dueDate, null); // 解析阶段不填，由主流程补查
  assert.strictEqual(copies[0].availability, "unavailable");
  assert.strictEqual(copies[1].rawStatus, "已归还");
  assert.strictEqual(copies[1].itemId, null);
});

test("cleanStatusText 清洗真实采样中的脏 rawStatus", () => {
  assert.strictEqual(cleanStatusText(POLLUTED_RAW_STATUS), "已借出");
  assert.strictEqual(cleanStatusText("已归还"), "已归还");
  assert.strictEqual(cleanStatusText("在架"), "在架");
  assert.strictEqual(cleanStatusText(""), null);
  assert.strictEqual(cleanStatusText(null), null);
});

console.log("\n[2c] 预计归还日期接口");
test("parseReturnDateResponse 各种响应形态", () => {
  assert.strictEqual(parseReturnDateResponse('{"status":true,"data":"2026-08-25"}'), "2026-08-25");
  assert.strictEqual(parseReturnDateResponse('{"status":true,"data":"<span>2026年8月5日</span>"}'), "2026-08-05");
  assert.strictEqual(parseReturnDateResponse('{"status":true,"data":"2026/8/5 23:59"}'), "2026-08-05");
  assert.strictEqual(parseReturnDateResponse("2026-8-5"), "2026-08-05"); // 非 JSON 纯文本兜底
  assert.strictEqual(parseReturnDateResponse('{"status":false,"msg":"无记录"}'), null);
  assert.strictEqual(parseReturnDateResponse(""), null);
  assert.strictEqual(parseReturnDateResponse(null), null);
});

test("fillDueDates 只查借出册，单册失败不影响其他册", async () => {
  const copies = [
    { itemId: "111", availability: "unavailable", rawStatus: "已借出", dueDate: null },
    { itemId: "222", availability: "available", rawStatus: "在架", dueDate: null },   // 在架不查
    { itemId: null, availability: "unavailable", rawStatus: "已借出", dueDate: null }, // 无 itemId 不查
    { itemId: "333", availability: "unavailable", rawStatus: "预约", dueDate: null },  // 非借出不查
    { itemId: "444", availability: "unavailable", rawStatus: "已借出", dueDate: null }, // 接口失败 → null
  ];
  const calls = [];
  const fakeClient = {
    async fetchItemReturnDate(itemId) {
      calls.push(itemId);
      if (itemId === "444") throw new Error("网络错误");
      return '{"status":true,"data":"2026-09-01"}';
    },
  };
  await fillDueDates(fakeClient, copies);
  assert.deepStrictEqual(calls, ["111", "444"]);
  assert.strictEqual(copies[0].dueDate, "2026-09-01");
  assert.strictEqual(copies[1].dueDate, null);
  assert.strictEqual(copies[4].dueDate, null); // 失败册置 null，不抛出
});

console.log("\n[3] 状态归一化");
test("常见状态分类", () => {
  assert.strictEqual(classifyAvailability("在架", "普通外借"), "available");
  assert.strictEqual(classifyAvailability("已借出", "普通外借"), "unavailable");
  assert.strictEqual(classifyAvailability("仅供阅览", "参考阅览"), "in_library");
  assert.strictEqual(classifyAvailability("已归还", "普通外借"), "available");
  assert.strictEqual(classifyAvailability("已归还 (流转中，查看实时状态)", "普通外借"), "available");
  assert.strictEqual(classifyAvailability("Checked out", null), "unavailable");
  assert.strictEqual(classifyAvailability("Available", null), "available");
  assert.strictEqual(classifyAvailability("", ""), "unknown");
});

console.log("\n[4] 采样周期");
test("daily 每天都是采样日", () => {
  assert.strictEqual(isSamplingDay({ frequency: "daily" }, new Date("2026-08-17T10:00:00+08:00")), true);
});
test("weekly 只在指定星期采样（2026-08-17 是周一，08-19 周三，08-22 周六）", () => {
  const cfg = { frequency: "weekly", weeklyDays: [3, 6] };
  assert.strictEqual(isSamplingDay(cfg, new Date("2026-08-17T10:00:00+08:00")), false);
  assert.strictEqual(isSamplingDay(cfg, new Date("2026-08-19T10:00:00+08:00")), true);
  assert.strictEqual(isSamplingDay(cfg, new Date("2026-08-22T10:00:00+08:00")), true);
});
test("biweekly 以锚点隔周（锚点 2026-08-17 周一；下个周一 08-24 不采，08-31 采）", () => {
  const cfg = { frequency: "biweekly", weeklyDays: [1], anchorDate: "2026-08-17" };
  assert.strictEqual(isSamplingDay(cfg, new Date("2026-08-17T10:00:00+08:00")), true);
  assert.strictEqual(isSamplingDay(cfg, new Date("2026-08-24T10:00:00+08:00")), false);
  assert.strictEqual(isSamplingDay(cfg, new Date("2026-08-31T10:00:00+08:00")), true);
});
test("monthly 只在指定日采样", () => {
  const cfg = { frequency: "monthly", monthlyDay: 1 };
  assert.strictEqual(isSamplingDay(cfg, new Date("2026-09-01T10:00:00+08:00")), true);
  assert.strictEqual(isSamplingDay(cfg, new Date("2026-09-02T10:00:00+08:00")), false);
});

console.log("\n[5] 书单解析");
test("books.txt 格式解析与容错", () => {
  const tmp = path.join(os.tmpdir(), `books-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "# 注释\n城市研究 | C912.81/4422\n活着 | I247.5/8030-23 | abc12345-aaaa\n| TU-092.2/4443\n坏行没有分隔符\n\n");
  const books = parseBooksFile(tmp);
  assert.strictEqual(books.length, 3);
  assert.strictEqual(books[0].id, "b1");
  assert.strictEqual(books[0].recordId, null);
  assert.strictEqual(books[1].recordId, "abc12345-aaaa");
  assert.strictEqual(books[2].title, null);
  assert.strictEqual(books[2].callNumber, "TU-092.2/4443");
  assert.deepStrictEqual(books[0].callNumbers, ["C912.81/4422"]); // 单索书号行向后兼容
  fs.rmSync(tmp);
});

test("多索书号（多卷册）解析：分号、全角分号、空格容忍", () => {
  const tmp = path.join(os.tmpdir(), `books-multi-${Date.now()}.txt`);
  fs.writeFileSync(
    tmp,
    [
      "中国建筑史 | TU-092/3965-20; TU-092/3965-17; TU-092/3965-19",
      "穿墙透壁 | TU-092.2/4443；TU-092.2/4443-2",
      "半个分号也容忍 |  A/1 ; ; B/2 ；", // 空段被丢弃
    ].join("\n")
  );
  const books = parseBooksFile(tmp);
  assert.strictEqual(books.length, 3);
  assert.deepStrictEqual(books[0].callNumbers, ["TU-092/3965-20", "TU-092/3965-17", "TU-092/3965-19"]);
  assert.strictEqual(books[0].callNumber, "TU-092/3965-20; TU-092/3965-17; TU-092/3965-19"); // 拼接字符串
  assert.deepStrictEqual(books[1].callNumbers, ["TU-092.2/4443", "TU-092.2/4443-2"]);
  assert.deepStrictEqual(books[2].callNumbers, ["A/1", "B/2"]);
  fs.rmSync(tmp);
});

test("多索书号行的 record_id 被忽略", () => {
  const tmp = path.join(os.tmpdir(), `books-rid-${Date.now()}.txt`);
  fs.writeFileSync(tmp, "中国建筑史 | TU-092/3965-20; TU-092/3965-17 | abc12345-aaaa\n单索书号 | TU-092/3965-20 | abc12345-bbbb\n");
  const books = parseBooksFile(tmp);
  assert.strictEqual(books[0].recordId, null); // 多卷册行忽略第三列
  assert.strictEqual(books[1].recordId, "abc12345-bbbb"); // 单索书号行不受影响
  fs.rmSync(tmp);
});

test("组头行解析：## 组名作用于其后书目，空组头回到未分组", () => {
  const tmp = path.join(os.tmpdir(), `books-group-${Date.now()}.txt`);
  fs.writeFileSync(
    tmp,
    [
      "# 普通注释行不算组头",
      "无组书 | A/1",
      "## 古建筑",
      "穿墙透壁 | TU-092.2/4443",
      "中国建筑史 | TU-092/3965-20",
      "## 香港",
      "香港影像志 | K296.58-64/4422",
      "##",
      "又是无组书 | B/2",
    ].join("\n")
  );
  const books = parseBooksFile(tmp);
  assert.strictEqual(books.length, 5);
  assert.strictEqual(books[0].group, null); // 组头前的书无分组
  assert.strictEqual(books[1].group, "古建筑");
  assert.strictEqual(books[2].group, "古建筑");
  assert.strictEqual(books[3].group, "香港");
  assert.strictEqual(books[4].group, null); // 空组头重置
  fs.rmSync(tmp);
});

test("第四列标签解析：逗号 / 全角逗号分隔，空段丢弃，旧格式行为不变", () => {
  const tmp = path.join(os.tmpdir(), `books-tags-${Date.now()}.txt`);
  fs.writeFileSync(
    tmp,
    [
      "## 上海城市行走",
      "上海文学散步 | I209.951/4122 | abc12345-aaaa | 散步,城市",
      "汉口路上 | K295.1/3754 | | 散步，历史，", // 全角逗号 + 尾逗号
      "旧格式行 | C/3", // 无第四列
      "多卷册带标签 | D/4; D/5 | abc12345-bbbb | 合集", // record_id 被忽略但标签保留
    ].join("\n")
  );
  const books = parseBooksFile(tmp);
  assert.deepStrictEqual(books[0].tags, ["散步", "城市"]);
  assert.strictEqual(books[0].group, "上海城市行走");
  assert.deepStrictEqual(books[1].tags, ["散步", "历史"]);
  assert.deepStrictEqual(books[2].tags, []);
  assert.strictEqual(books[2].group, "上海城市行走");
  assert.deepStrictEqual(books[3].tags, ["合集"]);
  assert.strictEqual(books[3].recordId, null); // 多索书号行第三列仍被忽略
  fs.rmSync(tmp);
});

console.log("\n[6] 历史数据清理");
test("prune 按日期与 before 删除", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prune-test-"));
  const dataDir = path.join(tmpRoot, "data");
  fs.mkdirSync(path.join(dataDir, "history"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "index.json"), JSON.stringify({
    updatedAt: null, books: [{ id: "b1" }], branches: [],
  }));
  fs.writeFileSync(path.join(dataDir, "history", "b1.json"), JSON.stringify({
    bookId: "b1",
    samples: [
      { ts: "2026-05-01T10:00:00+08:00", date: "2026-05-01", weekday: 5, branches: {} },
      { ts: "2026-06-15T10:00:00+08:00", date: "2026-06-15", weekday: 1, branches: {} },
      { ts: "2026-08-01T10:00:00+08:00", date: "2026-08-01", weekday: 6, branches: {} },
    ],
  }));
  process.env.BBT_DATA_DIR = dataDir; // store.js 支持用环境变量覆盖数据目录
  try {
    const { applyPrune, loadHistory } = await import("../src/store.js");
    const removed = applyPrune({ dates: ["2026-08-01"], before: "2026-06-01" });
    assert.strictEqual(removed, 2); // 05-01 被 before 删除，08-01 被 dates 删除
    const history = loadHistory("b1");
    assert.strictEqual(history.samples.length, 1);
    assert.strictEqual(history.samples[0].date, "2026-06-15");
  } finally {
    delete process.env.BBT_DATA_DIR;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

console.log("\n[7] 元数据回填");
test("parseRecordMetadata：表格结构详情页", () => {
  const meta = parseRecordMetadata(RECORD_PAGE_HTML);
  assert.strictEqual(meta.title, "城市研究 : 理论与方法");
  assert.deepStrictEqual(meta.authors, ["张明 著", "李华 译"]);
  assert.strictEqual(meta.publisher, "同济大学出版社");
  assert.strictEqual(meta.publishedYear, "2021");
  assert.strictEqual(meta.materialType, "图书");
});

test("parseRecordMetadata：纯文本行兜底，年份从日期中提取", () => {
  const meta = parseRecordMetadata(RECORD_PAGE_TEXT_HTML);
  assert.deepStrictEqual(meta.authors, ["余华"]);
  assert.strictEqual(meta.publisher, "作家出版社");
  assert.strictEqual(meta.publishedYear, "2012");
});

test("缓存读取兼容旧字符串与新对象两种形态", () => {
  assert.deepStrictEqual(readCacheEntry({ "书|A/1": "rid-1" }, "书|A/1"), { recordId: "rid-1" });
  assert.deepStrictEqual(
    readCacheEntry({ "书|A/1": { recordId: "rid-2", meta: { publisher: "某社" } } }, "书|A/1"),
    { recordId: "rid-2", meta: { publisher: "某社" } }
  );
  assert.strictEqual(readCacheEntry({}, "书|A/1"), null);
});

test("pickCacheMeta 提取元数据子集，空信息返回 null", () => {
  const meta = pickCacheMeta({
    recordId: "rid-1", title: "活着", authors: ["余华"],
    publisher: "作家出版社", publishedYear: "2012", callNumber: "I247.5/8030-23", materialType: "图书",
  });
  assert.deepStrictEqual(meta, {
    title: "活着", authors: ["余华"], publisher: "作家出版社",
    publishedYear: "2012", materialType: "图书",
  });
  assert.strictEqual(pickCacheMeta({ recordId: "rid-1", callNumber: "A/1" }), null);
  assert.strictEqual(pickCacheMeta(null), null);
});

test("resolveBook 缓存命中时带回缓存的元数据", async () => {
  const deps = {
    parseSearchResults,
    fetchHoldingsCount: async () => 0,
    recordCache: {
      "活着|I247.5/8030-23": {
        recordId: "rid-cached",
        meta: { title: "活着", authors: ["余华"], publisher: "作家出版社", publishedYear: "2012", materialType: "图书" },
      },
    },
  };
  const resolution = await resolveBook(null, { title: "活着", callNumber: "I247.5/8030-23" }, deps);
  assert.strictEqual(resolution.status, "resolved");
  assert.strictEqual(resolution.recordId, "rid-cached");
  assert.deepStrictEqual(resolution.meta.authors, ["余华"]);
  assert.strictEqual(resolution.meta.publisher, "作家出版社");
});

test("resolveBook 旧格式字符串缓存仍可用（无 meta）", async () => {
  const deps = {
    parseSearchResults,
    fetchHoldingsCount: async () => 0,
    recordCache: { "活着|I247.5/8030-23": "rid-legacy" },
  };
  const resolution = await resolveBook(null, { title: "活着", callNumber: "I247.5/8030-23" }, deps);
  assert.strictEqual(resolution.recordId, "rid-legacy");
  assert.strictEqual(resolution.meta, undefined);
});

// ---------- 稳定 id 分配 ----------
const mkBook = (id, title, callNumbers) => ({
  id,
  title,
  callNumber: callNumbers.join("; "),
  callNumbers,
});

test("assignStableIds：书单中间插入新书，原有书 id 不变（按索书号集合匹配）", () => {
  const existing = [
    { id: "b1", title: "甲", callNumber: "A/1" },
    { id: "b2", title: "乙", callNumber: "B/2" },
    { id: "b3", title: "丙", callNumber: "C/3" },
  ];
  const books = [mkBook("b1", "甲", ["A/1"]), mkBook("b2", "新", ["N/9"]), mkBook("b3", "乙", ["B/2"]), mkBook("b4", "丙", ["C/3"])];
  assignStableIds(books, existing, ["b1", "b2", "b3"]);
  assert.deepStrictEqual(books.map((b) => b.id), ["b1", "b4", "b2", "b3"]);
});

test("assignStableIds：多卷册合并行后与拆分前索书号集合一致，沿用旧 id", () => {
  const existing = [{ id: "b2", title: "营建的文明", callNumber: ["TU-092.2/4952-9", "TU-092.2/4952-1"] }];
  const books = [mkBook("b1", "营建的文明", ["TU-092.2/4952-9", "TU-092.2/4952-1"])];
  assignStableIds(books, existing, ["b1", "b2"]);
  assert.strictEqual(books[0].id, "b2");
});

test("assignStableIds：改书名不改索书号沿用 id；改索书号且书名唯一也沿用 id", () => {
  const existing = [
    { id: "b5", title: "旧书名", callNumber: "D/4" },
    { id: "b7", title: "汉口路上", callNumber: "K295.1/0000" },
  ];
  const books = [mkBook("b1", "新书名", ["D/4"]), mkBook("b2", "汉口路上", ["K295.1/3754"])];
  assignStableIds(books, existing, ["b5", "b7"]);
  assert.deepStrictEqual(books.map((b) => b.id), ["b5", "b7"]);
});

test("assignStableIds：不复用已删除书的 id（无历史污染）", () => {
  const books = [mkBook("b1", "全新书", ["Z/9"])];
  assignStableIds(books, [], ["b1", "b2", "b3"]); // b1-b3 都有历史文件
  assert.strictEqual(books[0].id, "b4");
});

test("assignStableIds：无既有数据时保持行号 id", () => {
  const books = [mkBook("b1", "甲", ["A/1"]), mkBook("b2", "乙", ["B/2"])];
  assignStableIds(books, [], []);
  assert.deepStrictEqual(books.map((b) => b.id), ["b1", "b2"]);
});

console.log(`\n${process.exitCode ? "存在失败用例" : `全部通过（${passed} 项）`}\n`);