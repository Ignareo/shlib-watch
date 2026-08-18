/* 图书难借吗 · 看板逻辑 */
"use strict";

// ---------------- 全局状态 ----------------
const state = {
  index: null,          // docs/data/index.json
  histories: {},        // bookId -> history json
  filter: "全部",       // 书卡筛选：全部 / 可以外借 / 仅馆内浏览
  demo: false,
  localServer: false,   // 是否由 server.js 托管（决定刷新按钮行为）
  charts: [],           // echarts 实例，重绘前销毁
};

const WEEK_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const $ = (sel) => document.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

// ---------------- 数据加载 ----------------
async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function loadAll() {
  let index = null;
  try {
    index = await fetchJson("data/index.json");
  } catch {
    index = null;
  }

  // data/index.json 不存在（本地直接打开 / 预览环境）→ 自动进入示例模式
  if (!index || !Array.isArray(index.books)) {
    enterDemoMode(true);
    return;
  }

  state.index = index;
  state.demo = false;

  if (!index.books.length) {
    showEmptyState();
    return;
  }

  await loadHistories(index.books);
  render();
  state.initBooksHelper?.();
}

async function loadHistories(books, onProgress) {
  state.histories = {};
  let done = 0;
  await Promise.all(
    books.map(async (book) => {
      try {
        state.histories[book.id] = await fetchJson(book.historyFile ?? `data/history/${book.id}.json`);
      } catch {
        state.histories[book.id] = { bookId: book.id, samples: [] };
      }
      onProgress?.(++done, books.length);
    })
  );
}

// 「刷新数据」：重新拉取 index.json + 全部历史并整页重渲染；书单助手的本地草稿不受影响
async function refreshData() {
  const btn = $("#btn-refresh");
  const status = $("#refresh-status");
  btn.disabled = true;
  try {
    status.textContent = "正在加载书目索引…";
    let index = null;
    try {
      index = await fetchJson("data/index.json");
    } catch {
      index = null;
    }
    if (!index || !Array.isArray(index.books)) {
      enterDemoMode(true);
      status.textContent = "未找到 data/index.json，已切换为示例数据";
      return;
    }
    state.index = index;
    state.demo = false;
    if (!index.books.length) {
      showEmptyState();
      status.textContent = "完成（书单为空）";
      return;
    }
    await loadHistories(index.books, (done, total) => {
      status.textContent = `正在加载历史数据 ${done}/${total}…`;
    });
    render();
    state.initBooksHelper?.(); // 有本地草稿时保留草稿，无草稿同步为最新书目
    status.textContent = "完成";
    toast("数据已刷新");
  } catch (err) {
    status.textContent = "刷新失败";
    toast(`刷新失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function showEmptyState() {
  $("#empty-state").hidden = false;
  $("#stats-band").hidden = true;
  $("#avail-board").hidden = true;
  $("#branch-bar").hidden = true;
  $("#history-section").hidden = true;
  $("#book-list").innerHTML = "";
  $("#updated-at").textContent = "尚无数据";
  $("#footer-schedule").textContent = "采样周期：见 config.json";
  $("#btn-demo").addEventListener("click", () => enterDemoMode(false));
  state.initBooksHelper?.();
}

// ---------------- 统计计算 ----------------
// 观测口径固定为主馆：淮海路馆 + 东馆（无匹配时退化为全部分馆）
function mainBranches() {
  const all = state.index?.branches ?? [];
  const main = [...all.filter((n) => n.includes("淮海路")), ...all.filter((n) => n.includes("东馆"))];
  return main.length ? main : null;
}

function shortBranchName(name) {
  return String(name).replace(/^上海图书馆[（(]?/, "").replace(/[）)]?$/, "") || name;
}

// 索书号兼容：index.json 里可能是字符串（旧数据）或数组（多卷册，新格式）
function callNumberText(book, sep = " / ") {
  return Array.isArray(book.callNumber) ? book.callNumber.join(sep) : String(book.callNumber ?? "");
}

// 流通类型分桶：普通外借（含 null/未知）/ 参考外借 / 保存·阅览
function bucketOf(circulationType) {
  const t = circulationType ?? "";
  if (t.includes("参考外借")) return "ref";
  if (t.includes("保存") || t.includes("仅供阅览")) return "keep";
  return "normal";
}

// 某次采样在选定口径下的册数汇总
// total/available 为「普通外借册」口径（在架率、难借分的依据）；ref/keep 为构成展示用
function sampleCounts(sample, names) {
  const list = names ?? Object.keys(sample.branches ?? {});
  let total = 0, available = 0, inLibrary = 0, ref = 0, keep = 0, allTotal = 0;
  let present = false, hasCopies = false;
  for (const name of list) {
    const b = (sample.branches ?? {})[name];
    if (!b) continue;
    present = true;
    inLibrary += b.inLibrary ?? 0;
    allTotal += b.total ?? 0;
    const copies = Array.isArray(b.copies) ? b.copies : [];
    if (copies.length) {
      hasCopies = true;
      for (const c of copies) {
        const bucket = bucketOf(c.circulationType);
        if (bucket === "ref") ref++;
        else if (bucket === "keep") keep++;
        else {
          total++;
          if (c.availability === "available") available++;
        }
      }
    } else {
      // 无册级明细（旧数据）时按分馆聚合值兜底，全部视为普通外借
      total += b.total ?? 0;
      available += b.available ?? 0;
    }
  }
  return present ? { total, available, inLibrary, ref, keep, allTotal, hasCopies } : null;
}

function bookSamples(bookId) {
  return (state.histories[bookId]?.samples ?? []).filter((s) => !s.error);
}

function computeStats(bookId) {
  const names = mainBranches();
  const rows = [];
  let onlyNonOrdinary = false; // 有采样数据但没有任何普通外借册
  for (const sample of bookSamples(bookId)) {
    const counts = sampleCounts(sample, names);
    if (!counts) continue; // 该口径下无馆藏
    if (counts.total === 0) {
      if (counts.hasCopies && counts.allTotal > 0) onlyNonOrdinary = true;
      continue; // 无普通外借册，不参与在架率/难借分
    }
    rows.push({ date: sample.date, weekday: sample.weekday, ...counts, ok: counts.available >= 1 });
  }
  if (!rows.length) {
    // 馆藏全部为保存/参考/阅览类资料：不出难借分，标记「仅馆内阅览」
    if (onlyNonOrdinary) return { noOrdinary: true, latest: latestCounts(bookId) };
    return null;
  }

  const n = rows.length;
  const okCount = rows.filter((r) => r.ok).length;
  const rate = okCount / n;

  const weekdayRows = rows.filter((r) => r.weekday >= 1 && r.weekday <= 5);
  const weekendRows = rows.filter((r) => r.weekday >= 6);
  const rateOf = (list) => (list.length ? list.filter((r) => r.ok).length / list.length : null);
  const weekdayRate = rateOf(weekdayRows);
  const weekendRate = rateOf(weekendRows);

  // 难借分：在架率 80 + 周末落差 20
  const gap = weekdayRate !== null && weekendRate !== null ? Math.max(0, weekdayRate - weekendRate) : 0;
  const score = Math.round(Math.min(100, (1 - rate) * 80 + gap * 20));

  return {
    samples: n, rate, weekdayRate, weekendRate, score,
    latest: rows.at(-1),
    rows,
  };
}

function ratingOf(score, samples) {
  if (samples < 3) return { text: "数据积累中", cls: "na" };
  if (score < 35) return { text: "随手可借", cls: "easy" };
  if (score <= 65) return { text: "需要蹲点", cls: "mid" };
  return { text: "极其抢手", cls: "hard" };
}

// 口径下最近一次有数据的采样汇总（构成色带/徽章/可借状态用）
function latestCounts(bookId) {
  const names = mainBranches();
  const samples = bookSamples(bookId);
  for (let i = samples.length - 1; i >= 0; i--) {
    const counts = sampleCounts(samples[i], names);
    if (counts) return { ...counts, date: samples[i].date };
  }
  return null;
}

// 按当前可借状态分组："available" 现在可外借 / "inhouse" 仅馆内浏览 / "nodata" 无数据
function availabilityGroup(bookId) {
  const latest = latestCounts(bookId);
  if (!latest) return "nodata";
  return latest.total > 0 && latest.available >= 1 ? "available" : "inhouse";
}

function allDates() {
  const map = new Map(); // date -> {weekday, books}
  for (const [bookId, history] of Object.entries(state.histories)) {
    for (const s of history.samples ?? []) {
      if (!map.has(s.date)) map.set(s.date, { weekday: s.weekday, books: 0 });
      map.get(s.date).books += 1;
    }
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

// ---------------- 渲染 ----------------
function render() {
  const { index } = state;
  $("#updated-at").textContent = index.updatedAt
    ? `更新于 ${formatTs(index.updatedAt)}`
    : "尚无数据";
  $("#footer-schedule").textContent = `采样周期：${index.schedule ?? "见 config.json"}`;
  $("#demo-banner").hidden = !state.demo;

  renderFilterBar();
  renderOverview();
  renderAvailability();
  renderBooks();
  renderHistoryPanel();
}

function formatTs(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 筛选 pills：按当前可借状态过滤书卡（分馆口径固定为淮海路馆+东馆）
function renderFilterBar() {
  const bar = $("#branch-bar");
  bar.hidden = false;
  const filters = ["全部", "可以外借", "仅馆内浏览"];
  $("#branch-pills").innerHTML = filters
    .map((f) => `<button class="branch-pill ${f === state.filter ? "active" : ""}" data-filter="${f}">${f}</button>`)
    .join("");
  $("#branch-pills").querySelectorAll(".branch-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filter = btn.dataset.filter;
      render();
    });
  });
}

// 顶部「当前可借情况」：按最新一次采样（普通外借口径）分两组展示
function renderAvailability() {
  const board = $("#avail-board");
  board.hidden = false;
  const groups = { available: [], inhouse: [], nodata: [] };
  for (const book of state.index.books) {
    groups[availabilityGroup(book.id)].push(book);
  }
  const chip = (book, cls) =>
    `<button class="chip ${cls}" data-book="${escapeHtml(book.id)}" title="定位到书卡">${escapeHtml(book.title)}</button>`;
  $("#chips-available").innerHTML =
    groups.available.map((b) => chip(b, "ok")).join("") || `<span class="chips-empty">无</span>`;
  $("#chips-inhouse").innerHTML =
    groups.inhouse.map((b) => chip(b, "muted")).join("") || `<span class="chips-empty">无</span>`;
  $("#avail-note").textContent = groups.nodata.length
    ? `另有 ${groups.nodata.length} 本暂无采样数据：${groups.nodata.map((b) => b.title).join("、")}`
    : "";
  board.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById(`card-${btn.dataset.book}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderOverview() {
  const dates = allDates();
  $("#issue-no").textContent = dates.length ? `第 ${dates.length} 期` : "第 — 期";

  const books = state.index.books;
  const withStats = books.map((b) => ({ book: b, stats: computeStats(b.id), group: availabilityGroup(b.id) }));
  const measurable = withStats.filter((x) => x.group !== "nodata");
  const availableNow = withStats.filter((x) => x.group === "available").length;
  const scored = withStats.filter((x) => x.stats && x.stats.samples >= 3);
  const avgScore = scored.length
    ? Math.round(scored.reduce((a, x) => a + x.stats.score, 0) / scored.length)
    : null;

  $("#stats-band").hidden = false;
  $("#stat-books").innerHTML = `${books.length} <small>本</small>`;
  $("#stat-available").innerHTML = `${availableNow} <small>/ ${measurable.length} 本</small>`;
  $("#stat-score").textContent = avgScore ?? "—";
  $("#stat-days").innerHTML = `${dates.length} <small>天</small>`;
}

function renderBooks() {
  state.charts.forEach((c) => c.dispose());
  state.charts = [];

  const list = $("#book-list");
  list.innerHTML = "";

  const items = state.index.books.map((book) => ({
    book,
    stats: computeStats(book.id),
    group: availabilityGroup(book.id),
  }));
  const visible = items.filter(
    (x) =>
      state.filter === "全部" ||
      (state.filter === "可以外借" && x.group === "available") ||
      (state.filter === "仅馆内浏览" && x.group === "inhouse")
  );

  for (const { book, stats } of visible) {
    list.appendChild(buildBookCard(book, stats));
  }

  // 初始化图表（需要 DOM 已挂载）
  for (const { book, stats } of visible) {
    if (!stats || stats.noOrdinary) continue;
    drawTrendChart(`trend-${book.id}`, stats.rows);
    drawWeekChart(`week-${book.id}`, stats.weekdayRate, stats.weekendRate);
  }
}

function buildBookCard(book, stats) {
  const card = document.createElement("article");
  card.className = "book-card";
  card.id = `card-${book.id}`;

  const noOrdinary = Boolean(stats?.noOrdinary);
  const rating = noOrdinary
    ? { text: "仅馆内阅览", cls: "na" }
    : stats
      ? ratingOf(stats.score, stats.samples)
      : { text: "未匹配", cls: "na" };
  const scoreHtml = stats && !noOrdinary
    ? `<div class="score-num">${stats.samples >= 3 ? stats.score : "—"}<span class="of"> /100</span></div>`
    : `<div class="score-num">—<span class="of"> /100</span></div>`;

  const metaBits = [
    `<span class="callnumber">${escapeHtml(callNumberText(book))}</span>`,
    book.authors?.length ? escapeHtml(book.authors.join("，")) : null,
    [book.publisher, book.publishedYear].filter(Boolean).map(escapeHtml).join(" ") || null,
    book.materialType ? escapeHtml(book.materialType) : null,
    book.needsReview ? `<span class="review-flag" title="${escapeHtml(candidatesTitle(book))}">版本待核对</span>` : null,
  ].filter(Boolean);

  const titleHtml = book.recordUrl
    ? `<a href="${escapeHtml(book.recordUrl)}" target="_blank" rel="noopener">${escapeHtml(book.title)}</a>`
    : escapeHtml(book.title);

  let bodyHtml;
  if (book.resolveStatus === "unresolved") {
    bodyHtml = `
      <div class="kv-row"><span class="k">状态</span><span class="v bad">未能在上海图书馆匹配到「书名 + 索书号」完全一致的记录</span></div>
      ${candidatesHtml(book)}`;
  } else if (!stats) {
    bodyHtml = `<div class="kv-row"><span class="k">状态</span><span class="v">该口径下暂无馆藏采样数据</span></div>`;
  } else {
    // latest：普通外借口径的最新汇总（noOrdinary 时来自 latestCounts）
    const latest = stats.latest;
    const statusHtml = noOrdinary
      ? `<span class="v">仅馆内阅览 —— 馆藏均为保存 / 参考 / 阅览类资料，无可外借普通册</span>`
      : latest.available >= 1
        ? `<span class="v ok">当前可借（普通外借在架 ${latest.available}/${latest.total} 册）</span>`
        : latest.inLibrary >= 1
          ? `<span class="v">当前普通外借册全部借出，另有 ${latest.inLibrary} 册仅馆内阅览</span>`
          : `<span class="v bad">当前全部借出（0/${latest.total} 册普通外借在架）</span>`;

    let statsHtml;
    if (!noOrdinary) {
      const pct = (r) => (r === null ? "—" : `${Math.round(r * 100)}%`);
      statsHtml = `
      <div class="kv-row">
        <span class="k">当前状态</span>${statusHtml}
        <span class="k">在架率</span><span class="v">${pct(stats.rate)}（${stats.samples} 次采样，按普通外借册计）</span>
      </div>
      <div class="charts">
        <div class="chart-box"><div class="chart-label">在架率走势（普通外借册）</div><div class="chart-trend" id="trend-${book.id}"></div></div>
        <div class="chart-box"><div class="chart-label">工作日 / 周末</div><div class="chart-week" id="week-${book.id}"></div></div>
      </div>`;
    } else {
      statsHtml = `<div class="kv-row"><span class="k">当前状态</span>${statusHtml}</div>`;
    }

    bodyHtml = `
      ${branchRowsHtml(book)}
      ${circulationHtml(latest)}
      ${statsHtml}`;
  }

  card.innerHTML = `
    <div class="score-col">
      <div>
        ${scoreHtml}
        <span class="score-badge ${rating.cls}">${rating.text}</span>
        <div class="score-meter"><i style="width:${stats && !noOrdinary && stats.samples >= 3 ? stats.score : 0}%"></i></div>
        <div class="score-caption">难借分越高越难借<br>按普通外借册：在架率 80% · 周末落差 20%</div>
      </div>
    </div>
    <div>
      <h3 class="book-title">${titleHtml}</h3>
      <div class="book-meta">${metaBits.join("")}</div>
      ${bodyHtml}
    </div>`;
  return card;
}

// 分馆小表：主馆（淮海路/东馆）平铺，其余分馆折叠；无数据显示「无数据」
function branchRowsHtml(book) {
  const samples = bookSamples(book.id);
  const latestSample = samples.at(-1) ?? null;

  const rowHtml = (name) => {
    const counts = latestSample ? sampleCounts(latestSample, [name]) : null;
    let dotCls, text;
    if (!counts) {
      dotCls = "none";
      text = "无数据";
    } else if (counts.hasCopies && counts.total === 0) {
      dotCls = "none";
      text = `无普通外借册（共 ${counts.allTotal} 册馆内资料）`;
    } else {
      dotCls = counts.available >= 1 ? "ok" : "bad";
      text = `在架 ${counts.available} / 共 ${counts.total}`;
    }
    return `<div class="branch-row"><span class="dot ${dotCls}"></span><span class="bname">${escapeHtml(shortBranchName(name))}</span><span class="bstat">${text}</span></div>`;
  };

  const all = state.index.branches ?? [];
  const main = mainBranches() ?? all;
  const others = all.filter((n) => !main.includes(n));

  return `
    <div class="branch-rows">
      ${main.map(rowHtml).join("")}
      ${others.length ? `<details class="branch-more"><summary>展开其他分馆（${others.length}）</summary>${others.map(rowHtml).join("")}</details>` : ""}
    </div>`;
}

// 借阅类型构成：堆叠色带 + 徽章行（按当前口径最新一次采样）
function circulationHtml(counts) {
  if (!counts || !counts.hasCopies) return "";
  const normal = counts.total, ref = counts.ref, keep = counts.keep;
  const all = normal + ref + keep;
  if (!all) return "";

  const segs = [
    { n: normal, cls: "normal", label: "普通外借" },
    { n: ref, cls: "ref", label: "参考外借" },
    { n: keep, cls: "keep", label: "保存/阅览" },
  ].filter((s) => s.n > 0);
  const barHtml = segs
    .map((s) => `<i class="seg ${s.cls}" style="flex-grow:${s.n}" title="${s.label} ${s.n} 册"></i>`)
    .join("");

  const badges = [
    normal
      ? `<span class="circ-badge normal" title="普通外借资料：可借回家">普通外借 · 可外借 ${counts.available}/${normal}</span>`
      : "",
    ref
      ? `<span class="circ-badge ref" title="参考外借资料：仅限当日馆内借读，当天归还">参考外借 · 馆内借读 × ${ref}</span>`
      : "",
    keep
      ? `<span class="circ-badge keep" title="保存资料 / 仅供阅览资料：保存资料或仅供馆内阅览，不外借">保存/阅览 × ${keep}</span>`
      : "",
  ].join("");

  return `
    <div class="circ-row">
      <div class="circ-bar">${barHtml}</div>
      <div class="circ-badges">${badges}</div>
    </div>`;
}

function candidatesTitle(book) {
  const list = (book.candidates ?? [])
    .map((c) => `${c.title} / ${(c.authors ?? []).join(",")} / ${c.publishedYear ?? "?"} / ${c.recordId}`)
    .join("\n");
  return list ? `匹配到多个版本，候选：\n${list}\n如需锁定版本，请把 record_id 填进 books.txt 第三列。` : "请核对书目版本";
}

function candidatesHtml(book) {
  if (!book.candidates?.length) return "";
  const items = book.candidates
    .map(
      (c) =>
        `<div class="kv-row"><span class="k">候选</span><span class="v">${escapeHtml(c.title ?? "")}</span><span>${escapeHtml((c.authors ?? []).join("，"))} ${escapeHtml(c.publishedYear ?? "")}</span><span style="font-family:var(--mono);font-size:11px;color:var(--faint)">${escapeHtml(c.recordId ?? "")}</span></div>`
    )
    .join("");
  return `<div style="margin-top:8px">${items}</div>`;
}

// ---------------- 图表 ----------------
const CHART_FONT = { fontFamily: "JetBrains Mono, monospace" };

function drawTrendChart(domId, rows) {
  const dom = document.getElementById(domId);
  if (!dom) return;
  const chart = echarts.init(dom, null, { renderer: "svg" });
  chart.setOption({
    grid: { left: 34, right: 8, top: 10, bottom: 20 },
    xAxis: {
      type: "category",
      data: rows.map((r) => r.date.slice(5)),
      axisLine: { lineStyle: { color: "#d8cdbd" } },
      axisLabel: { color: "#8a7d6b", fontSize: 10, ...CHART_FONT },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      max: 100,
      axisLabel: { color: "#8a7d6b", fontSize: 10, formatter: "{value}%", ...CHART_FONT },
      splitLine: { lineStyle: { color: "#f4f0ea" } },
    },
    series: [
      {
        type: "line",
        data: rows.map((r) => Math.round((r.available / r.total) * 100)),
        symbol: "circle",
        symbolSize: 4,
        lineStyle: { color: "#f54001", width: 1.5 },
        itemStyle: { color: "#f54001" },
        areaStyle: { color: "#ffc198", opacity: 0.25 },
      },
    ],
    tooltip: {
      trigger: "axis",
      formatter: (ps) => {
        const r = rows[ps[0].dataIndex];
        return `${r.date} ${WEEK_NAMES[r.weekday] ?? ""}<br>在架 ${r.available}/${r.total} 册（${ps[0].data}%）`;
      },
    },
  });
  state.charts.push(chart);
}

function drawWeekChart(domId, weekdayRate, weekendRate) {
  const dom = document.getElementById(domId);
  if (!dom) return;
  const chart = echarts.init(dom, null, { renderer: "svg" });
  const pct = (r) => (r === null ? 0 : Math.round(r * 100));
  chart.setOption({
    grid: { left: 34, right: 8, top: 10, bottom: 20 },
    xAxis: {
      type: "category",
      data: ["工作日", "周末"],
      axisLine: { lineStyle: { color: "#d8cdbd" } },
      axisLabel: { color: "#8a7d6b", fontSize: 10, ...CHART_FONT },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      max: 100,
      axisLabel: { color: "#8a7d6b", fontSize: 10, formatter: "{value}%", ...CHART_FONT },
      splitLine: { lineStyle: { color: "#f4f0ea" } },
    },
    series: [
      {
        type: "bar",
        barWidth: 26,
        data: [
          { value: pct(weekdayRate), itemStyle: { color: "#5a7a3a" } },
          { value: pct(weekendRate), itemStyle: { color: "#c7371f" } },
        ],
        label: { show: true, position: "top", color: "#8a7d6b", fontSize: 10, formatter: "{c}%", ...CHART_FONT },
      },
    ],
    tooltip: { trigger: "axis", formatter: (ps) => `${ps[0].name}在架率 ${ps[0].data}%` },
  });
  state.charts.push(chart);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ---------------- 历史数据管理 ----------------
function renderHistoryPanel() {
  const dates = allDates();
  const section = $("#history-section");
  if (!dates.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  const tbody = $("#history-tbody");
  tbody.innerHTML = dates
    .map(
      ([date, info]) => `
      <tr data-date="${date}">
        <td><input type="checkbox" class="prune-check" value="${date}"></td>
        <td>${date}</td>
        <td>${WEEK_NAMES[info.weekday] ?? ""}</td>
        <td>${info.books} 本</td>
      </tr>`
    )
    .join("");
  tbody.querySelectorAll(".prune-check").forEach((cb) => {
    cb.addEventListener("change", () => {
      cb.closest("tr").classList.toggle("selected", cb.checked);
    });
  });
}

function buildPruneJson() {
  const dates = [...document.querySelectorAll(".prune-check:checked")].map((cb) => cb.value);
  const before = $("#prune-before").value || null;
  if (!dates.length && !before) {
    toast("请先勾选日期，或设置「删除早于某日」");
    return null;
  }
  return JSON.stringify({ dates: dates.sort(), before }, null, 2);
}

function setupHistoryPanel() {
  $("#btn-select-all").addEventListener("click", () => setAllChecks(true));
  $("#btn-select-none").addEventListener("click", () => setAllChecks(false));
  $("#btn-prune-copy").addEventListener("click", async () => {
    const json = buildPruneJson();
    if (!json) return;
    await navigator.clipboard.writeText(json);
    toast("已复制 —— 粘贴为仓库 docs/data/prune.json 并提交");
  });
  $("#btn-prune-download").addEventListener("click", () => {
    const json = buildPruneJson();
    if (!json) return;
    downloadText("prune.json", json);
    toast("已下载 —— 放到仓库 docs/data/ 目录并提交");
  });
}

function setAllChecks(checked) {
  document.querySelectorAll(".prune-check").forEach((cb) => {
    cb.checked = checked;
    cb.closest("tr").classList.toggle("selected", checked);
  });
}

function downloadText(filename, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------- 书单助手 ----------------
function splitBookLine(line) {
  return line.split(/[|｜]/).map((p) => p.trim());
}

// 索书号校验：支持用 ; 或 ；分隔的多卷册写法，不允许空段
function callNumberProblem(callNumber) {
  if (!callNumber) return "缺索书号";
  if (String(callNumber).split(/[;；]/).some((s) => !s.trim())) return "索书号含空段";
  return null;
}

function parseBookLines(text) {
  const results = [];
  for (const [i, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = splitBookLine(line);
    const [title, callNumber, recordId] = parts;
    const problems = [];
    if (!title && !callNumber) problems.push("书名和索书号不能都为空");
    const cnProblem = callNumberProblem(callNumber);
    if (cnProblem) problems.push(cnProblem);
    if (recordId && callNumber && callNumber.split(/[;；]/).length > 1) problems.push("多索书号行的 record_id 会被采样器忽略");
    if (recordId && !/^[0-9a-fA-F-]{8,}$/.test(recordId)) problems.push("record_id 格式可疑");
    if (parts.length > 3) problems.push("超过 3 列");
    results.push({ line: i + 1, title, callNumber, recordId, problems });
  }
  return results;
}

function setupBooksHelper() {
  const tbody = $("#books-tbody");

  function statusTagHtml(status) {
    switch (status) {
      case "resolved": return `<span class="resolve-tag ok">已匹配</span>`;
      case "unresolved": return `<span class="resolve-tag bad">未匹配</span>`;
      case "new": return `<span class="resolve-tag">新增</span>`;
      case "draft": return `<span class="resolve-tag">草稿</span>`;
      default: return `<span class="resolve-tag">${escapeHtml(status || "—")}</span>`;
    }
  }

  function addRow(book = {}) {
    const tr = document.createElement("tr");
    tr.dataset.id = book.id || `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    tr.innerHTML = `
      <td class="tc"><input type="checkbox" class="book-enabled" ${book.disabled ? "" : "checked"}></td>
      <td><input type="text" class="book-title" placeholder="可留空" value="${escapeHtml(book.title ?? "")}"></td>
      <td><input type="text" class="book-call" placeholder="必填" value="${escapeHtml(book.callNumber ?? "")}"></td>
      <td><input type="text" class="book-record" placeholder="可选" value="${escapeHtml(book.recordId ?? "")}"></td>
      <td class="tc row-status">${statusTagHtml(book.resolveStatus ?? "new")}</td>
      <td class="tc"><button class="btn-delete" title="删除">删除</button></td>
    `;
    tr.querySelector(".btn-delete").addEventListener("click", () => { tr.remove(); saveDraft(); });
    tr.querySelector(".book-enabled").addEventListener("change", () => { updateRowStyle(tr); saveDraft(); });
    // 编辑过内容后，原来的匹配状态失效，标记为「已修改」；同时自动保存草稿
    tr.querySelectorAll(".book-title, .book-call, .book-record").forEach((input) => {
      input.addEventListener("input", () => {
        tr.querySelector(".row-status").innerHTML = `<span class="resolve-tag warn">已修改</span>`;
        saveDraft();
      });
    });
    tbody.appendChild(tr);
    updateRowStyle(tr);
  }

  function updateRowStyle(tr) {
    const enabled = tr.querySelector(".book-enabled").checked;
    tr.classList.toggle("disabled", !enabled);
  }

  function getRows() {
    return [...tbody.querySelectorAll("tr")].map((tr) => ({
      title: tr.querySelector(".book-title").value.trim() || null,
      callNumber: tr.querySelector(".book-call").value.trim() || null,
      recordId: tr.querySelector(".book-record").value.trim() || null,
      disabled: !tr.querySelector(".book-enabled").checked,
    }));
  }

  function validate() {
    const rows = getRows();
    let bad = 0;
    rows.forEach((r, i) => {
      const tr = tbody.children[i];
      const callEl = tr.querySelector(".book-call");
      const hasProblem = Boolean(callNumberProblem(r.callNumber));
      callEl.classList.toggle("bad", hasProblem);
      if (hasProblem) bad++;
    });
    $("#helper-valid").innerHTML = bad
      ? `<span class="bad">${bad} 行索书号缺失或含空段（多卷册用 ; 分隔，如 TU-092/3965-20; TU-092/3965-17）</span>`
      : `<span class="ok">${rows.length} 本书格式正确</span>`;
    return { rows, bad };
  }

  function generateText() {
    const { rows, bad } = validate();
    if (bad) {
      toast("请补全标红的索书号后再生成");
      return null;
    }
    if (!rows.length) {
      toast("书单为空，请至少添加一本书");
      return null;
    }
    const header = [
      "# 图书难借吗 · 追踪书单",
      `# 由书单助手生成于 ${new Date().toISOString().slice(0, 10)}`,
      "# 格式：书名 | 索书号 | record_id（可选）",
      "# 多卷册：索书号用 ; 分隔（如 TU-092/3965-20; TU-092/3965-17），此时 record_id 不适用",
      "",
    ].join("\n");
    const body = rows
      .map((r) => {
        const line = [r.title, r.callNumber, r.recordId].filter(Boolean).join(" | ");
        return r.disabled ? `# ${line}` : line;
      })
      .join("\n");
    return `${header}${body}\n`;
  }

  // ---------- 本地草稿（localStorage 自动保存） ----------
  const DRAFT_KEY = "booklist-draft";

  function saveDraft() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(getRows()));
  }

  function readDraft() {
    try {
      const rows = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
      return Array.isArray(rows) && rows.length ? rows : null;
    } catch {
      return null;
    }
  }

  function loadDraftRows(rows) {
    tbody.innerHTML = "";
    rows.forEach((r) => addRow({ ...r, resolveStatus: "draft" }));
    $("#helper-draft-note").hidden = false;
    $("#helper-valid").innerHTML = "";
  }

  // 初始化：用 index.json（或 demo 数据）里已有的书目填入
  function initFromIndex() {
    tbody.innerHTML = "";
    const books = state.index?.books ?? [];
    if (books.length) {
      books.forEach((b) => addRow({ title: b.title, callNumber: callNumberText(b, "; "), recordId: b.recordId, disabled: false, resolveStatus: b.resolveStatus }));
    } else {
      addRow();
    }
    $("#helper-draft-note").hidden = true;
    $("#helper-valid").innerHTML = "";
  }

  // 加载优先级：浏览器里有草稿用草稿，否则用 index.json
  function initBooklist() {
    const draft = readDraft();
    if (draft) loadDraftRows(draft);
    else initFromIndex();
  }
  state.initBooksHelper = initBooklist;

  $("#btn-add-book").addEventListener("click", () => { addRow(); saveDraft(); });

  $("#btn-import").addEventListener("click", () => $("#books-file").click());
  $("#books-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseBookLines(text);
    tbody.innerHTML = "";
    if (parsed.length) {
      parsed.forEach((r) => addRow({ title: r.title, callNumber: r.callNumber, recordId: r.recordId, disabled: false }));
    } else {
      addRow();
    }
    saveDraft();
    $("#helper-draft-note").hidden = false;
    toast(`已导入 ${file.name}，共 ${parsed.length} 本（已自动保存到浏览器）`);
    validate();
  });

  $("#btn-reset-books").addEventListener("click", () => {
    if (!confirm("清除浏览器中保存的书单草稿，恢复为仓库 books.txt 对应的书目？")) return;
    localStorage.removeItem(DRAFT_KEY);
    initFromIndex();
    toast("已重置为仓库书单");
  });

  $("#btn-validate").addEventListener("click", () => validate());

  $("#btn-generate").addEventListener("click", () => {
    const text = generateText();
    if (text === null) return;
    const output = $("#helper-output");
    output.textContent = text;
    output.classList.add("show");
    $("#btn-copy-books").disabled = false;
    $("#btn-download-books").disabled = false;
    toast(`已生成 ${getRows().length} 条书目`);
  });

  $("#btn-copy-books").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#helper-output").textContent);
    toast("已复制 —— 粘贴到仓库根目录 books.txt 并提交");
  });

  $("#btn-download-books").addEventListener("click", () => {
    downloadText("books.txt", $("#helper-output").textContent, "text/plain");
    toast("已下载 —— 替换仓库根目录 books.txt 并提交");
  });

  $("#btn-refresh").addEventListener("click", () => {
    if (state.localServer) startLocalSampling();
    else refreshData();
  });
}

// ---------------- 采样触发（本地服务器 / GitHub Actions） ----------------
// 探测是否由 server.js 托管（静态托管时 /api/* 不存在）
async function detectLocalServer() {
  try {
    const res = await fetch("/api/sample/status", { cache: "no-store" });
    if (!res.ok) return false;
    const st = await res.json();
    return typeof st.running === "boolean";
  } catch {
    return false;
  }
}

// 本地服务器模式：POST 触发真实采样，轮询状态并透传日志尾部
async function startLocalSampling() {
  const btn = $("#btn-refresh");
  const status = $("#refresh-status");
  const logEl = $("#sample-log");
  btn.disabled = true;
  logEl.hidden = false;
  try {
    const res = await fetch("/api/sample", { method: "POST" });
    if (res.status === 409) toast("已有采样在进行中，等待其完成…");
    else if (!res.ok) throw new Error(`HTTP ${res.status}`);
    for (;;) {
      await sleep(1500);
      const st = await fetchJson("/api/sample/status");
      logEl.textContent = st.log.filter((l) => l.trim()).slice(-6).join("\n");
      status.textContent = st.running ? "正在采样…" : "采样结束";
      if (!st.running) {
        if (st.exitCode === 0) {
          logEl.hidden = true;
          toast("采样完成，正在重新加载数据…");
          await refreshData(); // 复用现有重新拉取逻辑
        } else {
          status.textContent = `采样失败（exit ${st.exitCode ?? "?"}），日志见上方`;
          toast("采样失败 —— 日志输出见书单助手区域");
        }
        break;
      }
    }
  } catch (err) {
    status.textContent = "采样触发失败";
    toast(`采样触发失败：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// GitHub Actions 远程采样；token/repo 只存 localStorage，不写入任何文件
const GH_KEY = "gh-actions-config";

function ghConfig() {
  try {
    return JSON.parse(localStorage.getItem(GH_KEY)) ?? {};
  } catch {
    return {};
  }
}

function ghActionsUrl() {
  const { repo } = ghConfig();
  return repo ? `https://github.com/${repo}/actions/workflows/sample.yml` : null;
}

async function ghFetch(apiPath, { method = "GET", body } = {}) {
  const { token } = ghConfig();
  const res = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.status === 204 ? null : res.json();
}

function updateGhBox() {
  const { repo, token } = ghConfig();
  $("#gh-repo").value = repo ?? "";
  $("#gh-token").value = token ?? "";
  const url = ghActionsUrl();
  const openLink = $("#gh-open");
  openLink.href = url ?? "#";
  openLink.classList.toggle("disabled", !url);
  $("#btn-gh-run").hidden = !(repo && token);
  $("#gh-status").textContent = !repo
    ? "先填写仓库地址（owner/repo）"
    : !token
      ? "未填 Token：可打开 Actions 页面手动运行"
      : "";
}

async function triggerGhSample() {
  const { repo } = ghConfig();
  const btn = $("#btn-gh-run");
  const status = $("#gh-status");
  btn.disabled = true;
  try {
    status.textContent = "正在获取默认分支…";
    let ref = "main";
    try {
      ref = (await ghFetch(`/repos/${repo}`)).default_branch ?? "main";
    } catch { /* 仓库信息拿不到就用 main 兜底 */ }
    const triggeredAt = new Date().toISOString();
    await ghFetch(`/repos/${repo}/actions/workflows/sample.yml/dispatches`, { method: "POST", body: { ref } });
    status.textContent = "已触发，等待运行入队…";
    for (let i = 0; i < 90; i++) { // 每 10s 轮询，最长约 15 分钟
      await sleep(10000);
      const data = await ghFetch(`/repos/${repo}/actions/workflows/sample.yml/runs?per_page=1`);
      const run = data?.workflow_runs?.[0];
      if (!run || run.created_at < triggeredAt) {
        status.textContent = "等待运行入队…";
        continue;
      }
      if (run.status !== "completed") {
        status.textContent = `GitHub Actions 运行中（${run.status}）…`;
        continue;
      }
      if (run.conclusion === "success") {
        status.textContent = "远程采样完成";
        toast("GitHub Actions 采样完成，正在重新加载数据…");
        await refreshData();
      } else {
        status.textContent = `远程采样结束：${run.conclusion ?? "未知"}（详见 Actions 页面）`;
        toast(`远程采样结果：${run.conclusion ?? "未知"}`);
      }
      return;
    }
    status.textContent = "等待超时，请到 Actions 页面查看运行状态";
  } catch (err) {
    // CORS 或鉴权失败时降级为手动打开 Actions 页面
    status.textContent = `触发失败：${err.message}（可改用「打开 GitHub Actions 手动运行」）`;
  } finally {
    btn.disabled = false;
  }
}

function setupGhBox() {
  updateGhBox();
  $("#btn-gh-save").addEventListener("click", () => {
    const repo = $("#gh-repo").value.trim();
    const token = $("#gh-token").value.trim();
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      toast("仓库格式应为 owner/repo");
      return;
    }
    localStorage.setItem(GH_KEY, JSON.stringify({ repo: repo || null, token: token || null }));
    updateGhBox();
    toast("已保存（仅存储在本浏览器）");
  });
  $("#btn-gh-run").addEventListener("click", () => triggerGhSample());
  $("#gh-open").addEventListener("click", (e) => {
    if (!ghActionsUrl()) {
      e.preventDefault();
      toast("请先填写仓库地址（owner/repo）");
    }
  });
}

// ---------------- 示例数据 ----------------
function enterDemoMode(auto) {
  const demo = buildDemoData();
  state.index = demo.index;
  state.histories = demo.histories;
  state.demo = true;
  $("#empty-state").hidden = true;
  if (!auto) toast("正在展示示例数据");
  render();
  state.initBooksHelper?.();
}

function buildDemoData() {
  // 固定的伪随机序列，保证每次刷新画面一致
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  // copies: 每个分馆的副本数范围；p: 单册在架概率；drought: 连续借出期（概率/长度）
  const books = [
    { id: "b1", title: "城市研究 : 理论与方法", callNumber: "C912.81/4422", recordId: "a1b2c3d4-1111-4000-8000-000000000001", resolveStatus: "resolved", needsReview: false, authors: ["张明"], publisher: "同济大学出版社", publishedYear: "2021", materialType: "图书", copies: [3, 5], p: 0.85, drought: [0.03, 1, 3], hasBranch: [true, true, true] },
    { id: "b2", title: "活着", callNumber: "I247.5/8030-23", recordId: "a1b2c3d4-2222-4000-8000-000000000002", resolveStatus: "resolved", needsReview: true, authors: ["余华"], publisher: "作家出版社", publishedYear: "2012", materialType: "图书", copies: [1, 2], p: 0.3, drought: [0.05, 2, 5], hasBranch: [true, true, true], candidates: [{ recordId: "a1b2c3d4-2222-4000-8000-000000000002", title: "活着", authors: ["余华"], publishedYear: "2012" }, { recordId: "a1b2c3d4-2222-4000-8000-000000000099", title: "活着", authors: ["余华"], publishedYear: "2021" }] },
    { id: "b3", title: "三体（多卷册示例）", callNumber: ["I247.55/4821-1", "I247.55/4821-2", "I247.55/4821-3"], recordId: "a1b2c3d4-3333-4000-8000-000000000003", resolveStatus: "resolved", needsReview: false, authors: ["刘慈欣"], publisher: "重庆出版社", publishedYear: "2017", materialType: "图书", copies: [1, 1], p: 0.1, drought: [0.15, 8, 16], hasBranch: [true, true, true] },
    { id: "b4", title: "东京八平米", callNumber: "I313.65/4434", recordId: "a1b2c3d4-4444-4000-8000-000000000004", resolveStatus: "resolved", needsReview: false, authors: ["吉井忍"], publisher: "上海三联书店", publishedYear: "2022", materialType: "图书", copies: [2, 3], p: 0.55, drought: [0.05, 2, 5], hasBranch: [true, false, true] },
  ];

  const branchNames = ["上海图书馆（淮海路馆）", "上海图书馆（东馆）", "上海图书馆网借中心"];
  const histories = {};
  const days = 45;
  const today = new Date();

  for (const book of books) {
    const samples = [];
    // 每本书一条「热度曲线」，中间模拟一段连续借出期
    let droughtLeft = 0;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400_000);
      const weekday = d.getDay() === 0 ? 7 : d.getDay();
      const isWeekend = weekday >= 6;
      let p = book.p * (isWeekend ? 0.55 : 1);
      const [droughtChance, droughtMin, droughtMax] = book.drought;
      if (droughtLeft > 0) { p = 0; droughtLeft--; }
      else if (rand() < droughtChance) {
        droughtLeft = droughtMin + Math.floor(rand() * (droughtMax - droughtMin));
        p = 0;
      }

      const branches = {};
      const cnText = callNumberText(book);
      for (const [bi, name] of branchNames.entries()) {
        if (!book.hasBranch[bi]) continue; // 该分馆没有这本书的馆藏
        const total = book.copies[0] + Math.floor(rand() * (book.copies[1] - book.copies[0] + 1));
        // 册级构成：普通外借为主，少量参考外借 / 保存 / 仅供阅览
        const copies = [];
        for (let c = 0; c < total; c++) {
          copies.push({
            branch: name,
            callNumber: cnText,
            circulationType: "普通外借资料",
            availability: rand() < p ? "available" : "unavailable",
          });
        }
        if (rand() < 0.45) {
          copies.push({ branch: name, callNumber: cnText, circulationType: "参考外借资料", availability: rand() < 0.5 ? "available" : "unavailable" });
        }
        if (rand() < 0.35) {
          const isReading = rand() < 0.5;
          copies.push({
            branch: name,
            callNumber: cnText,
            circulationType: isReading ? "仅供阅览资料" : "保存资料",
            availability: isReading ? "in_library" : rand() < 0.5 ? "available" : "unavailable",
          });
        }
        const count = (pred) => copies.filter(pred).length;
        const available = count((c) => c.availability === "available");
        const inLibrary = count((c) => c.availability === "in_library");
        const unavailable = count((c) => c.availability === "unavailable");
        branches[name] = {
          total: copies.length,
          available,
          inLibrary,
          unavailable,
          unknown: 0,
          copies,
        };
      }
      const pad = (n) => String(n).padStart(2, "0");
      samples.push({
        ts: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:05:00+08:00`,
        date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        weekday,
        error: null,
        branches,
      });
    }
    histories[book.id] = { bookId: book.id, samples };
  }

  return {
    index: {
      updatedAt: new Date().toISOString(),
      schedule: "每天（示例数据）",
      books: books.map(({ p, ...b }) => ({
        ...b,
        recordUrl: `https://vufind.library.sh.cn/Record/${b.recordId}`,
        historyFile: `data/history/${b.id}.json`,
        candidates: b.candidates ?? [],
      })),
      branches: branchNames,
    },
    histories,
  };
}

// ---------------- 启动 ----------------
window.addEventListener("resize", () => state.charts.forEach((c) => c.resize()));
setupHistoryPanel();
setupBooksHelper();
setupGhBox();
detectLocalServer().then((ok) => {
  state.localServer = ok;
  $("#btn-refresh").textContent = ok ? "重新采样" : "刷新数据";
  $("#btn-refresh").title = ok
    ? "本地服务器模式：真实执行一次采样（npm run sample:force）"
    : "静态托管模式：重新拉取仓库里已有的数据";
});
loadAll();
