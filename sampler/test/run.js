// 自测：解析器（fixture）、状态归一化、调度、清理、书单解析
// 运行：cd sampler && npm install && node test/run.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { parseSearchResults, parseHoldings, groupByBranch } from "../src/parsers.js";
import { classifyAvailability } from "../src/normalize.js";
import { isSamplingDay } from "../src/schedule.js";
import { parseBooksFile } from "../src/books.js";

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

console.log(`\n${process.exitCode ? "存在失败用例" : `全部通过（${passed} 项）`}\n`);
