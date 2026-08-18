/* 图书难借吗 · 看板逻辑 */
"use strict";

// ---------------- 全局状态 ----------------
const state = {
  index: null,          // docs/data/index.json
  histories: {},        // bookId -> history json
  filter: "全部",       // 书卡筛选：全部 / 可以外借 / 全部借出 / 仅馆内阅览
  tag: null,            // 标签筛选：null 为不限；书单里有 tags 时筛选条才出现标签 chips
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
// 观测口径：用户可在筛选条旁勾选分馆（偏好存 localStorage，键 branch-prefs，值为分馆名数组）；
// 无偏好或偏好为空时回落默认口径——淮海路馆 + 东馆；默认口径无匹配则返回 null（= 全部分馆）
const BRANCH_PREFS_KEY = "branch-prefs";

function branchPrefs() {
  try {
    const arr = JSON.parse(localStorage.getItem(BRANCH_PREFS_KEY) ?? "null");
    return Array.isArray(arr) ? arr.filter((n) => typeof n === "string") : null;
  } catch {
    return null; // 隐私模式 / 数据损坏时按无偏好处理
  }
}

function mainBranches() {
  const all = state.index?.branches ?? [];
  const prefs = branchPrefs();
  if (prefs?.length) {
    // 只认当前 index.json 里仍存在的分馆，避免历史偏好里的消失分馆污染口径
    const chosen = all.filter((n) => prefs.includes(n));
    if (chosen.length) return chosen;
  }
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

  // ---------------- 难借分新口径（0–100，越高越难借） ----------------
  // 1) 周末落差：周末样本 <5 次时噪声太大，整个维度剔除，权重全部让给在架率（即在架率独占 100 分）；
  //    周末样本 ≥5 次时才启用「在架率 80 + 周末落差 20」的旧结构
  const useWeekend = weekendRows.length >= 5 && weekdayRate !== null && weekendRate !== null;
  const gap = useWeekend ? Math.max(0, weekdayRate - weekendRate) : 0;

  // 2) 副本基数折减：1 册在架率 100% ≠ 10 册 100%。册数越少，单册被借走对在架率的冲击越大，
  //    同样的在架率对读者越不可靠（到馆越可能扑空），故按平均普通外借册数对「有书可借率」分档折减：
  //    约 1 册 ×0.6 / 约 2 册 ×0.8 / 3–4 册 ×0.9 / ≥5 册 ×1.0（系数随册数单调不减，阈值取半档避免整数抖动）
  const avgCopies = rows.reduce((a, r) => a + r.total, 0) / n;
  const copyFactor = avgCopies < 1.5 ? 0.6 : avgCopies < 2.5 ? 0.8 : avgCopies < 4.5 ? 0.9 : 1;
  const rateAdj = rate * copyFactor;

  // 3) 连续无书信号：最新连续「普通外借 0 册在架」的采样天数按档加分（在架率是平均值，
  //    捕捉不到「此刻正连续借空」的紧迫状态）：连续 ≥3 天 +5 / ≥7 天 +10 / ≥14 天 +20；总分封顶 100
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && rows[i].available === 0; i--) streak++;
  const streakBonus = streak >= 14 ? 20 : streak >= 7 ? 10 : streak >= 3 ? 5 : 0;

  const score = Math.round(Math.min(100, (1 - rateAdj) * (useWeekend ? 80 : 100) + gap * 20 + streakBonus));

  return {
    samples: n, rate, weekdayRate, weekendRate, score,
    avgCopies: Math.round(avgCopies * 10) / 10, // 平均普通外借册数（折减依据，展示/调试可用）
    streak,                                     // 最新连续无书天数（加分依据）
    latest: rows.at(-1),
    rows,
  };
}

// 三档评级：新公式仍是 0–100 同一量纲（折减只影响低册数书、加分封顶不破 100），阈值 35/65 维持不变
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

// 按当前可借状态分组（口径同难借分，均为普通外借册）：
// "available" 现在可外借 / "borrowed_out" 普通外借册全部借出（可蹲点，过段时间可能有）
// "inhouse" 仅馆内阅览（馆藏均为保存/参考/阅览类，永远借不出） / "nodata" 无数据
function availabilityGroup(bookId) {
  const latest = latestCounts(bookId);
  if (!latest) return "nodata";
  if (latest.total <= 0) return "inhouse"; // 有采样但该口径下没有任何普通外借册
  return latest.available >= 1 ? "available" : "borrowed_out";
}

// ---------------- 「新可借」高亮 ----------------
// localStorage 记录上次访问时各书的分组；本次加载后从「非 available」变为「available」的书
// 在顶部看板 chip 和书卡上加「新可借」标记。demo 模式不写不读。
const LAST_AVAIL_KEY = "last-availability";
const LAST_AVAIL_TTL = 30 * 86400_000; // 超过 30 天未访问不提示，避免刷屏
let currentGroups = null;       // 本会话当前分组（数据刷新后作为下一次对比基准）
let newlyAvailable = new Set(); // 本次「新可借」的书 id

function trackAvailability() {
  const groups = {};
  for (const book of state.index.books) groups[book.id] = availabilityGroup(book.id);
  if (state.demo) {
    newlyAvailable = new Set();
    return;
  }
  // 分组无变化（如切换筛选触发的重绘）时保留已有高亮，不重复对比
  if (currentGroups && Object.keys(groups).every((id) => currentGroups[id] === groups[id])) return;
  // 对比基准：本会话上一次分组（数据刷新场景）优先，否则读 localStorage 的上次访问记录
  let baseline = currentGroups ? { ts: Date.now(), groups: currentGroups } : null;
  if (!baseline) {
    try {
      baseline = JSON.parse(localStorage.getItem(LAST_AVAIL_KEY) ?? "null");
    } catch {
      baseline = null;
    }
  }
  newlyAvailable = new Set();
  if (baseline && Date.now() - (baseline.ts ?? 0) <= LAST_AVAIL_TTL) {
    for (const [id, g] of Object.entries(groups)) {
      const before = baseline.groups?.[id];
      if (before && before !== "available" && g === "available") newlyAvailable.add(id);
    }
  }
  currentGroups = groups;
  try {
    localStorage.setItem(LAST_AVAIL_KEY, JSON.stringify({ ts: Date.now(), groups }));
  } catch {
    /* 隐私模式等写不进去的场景直接忽略 */
  }
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

  trackAvailability(); // 每次渲染前更新「新可借」标记（分组无变化时内部直接返回）
  renderBranchPrefs();
  renderFilterBar();
  renderOverview();
  renderAvailability();
  renderBooks();
  renderHistoryPanel();
}

// 观测口径选择：从 index.json 的 branches 全量列表生成 chips，勾选哪些馆计入统计
// （顶部可借分组、书卡在架数、难借分、图表全链路都走 mainBranches()，改口径后自动跟随）。
// 偏好存 localStorage（branch-prefs，分馆名数组）；demo 模式同样可用（用 demo 数据的 branches）。
function renderBranchPrefs() {
  const box = $("#branch-prefs");
  if (!box) return;
  const all = state.index?.branches ?? [];
  if (!all.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const effective = new Set(mainBranches() ?? all); // 当前生效口径；null（=全部分馆）时全部点亮
  box.innerHTML =
    `<span class="branch-prefs-label" title="勾选哪些分馆计入在架率 / 难借分 / 可借分组统计">观测口径：</span>` +
    all
      .map(
        (name) =>
          `<button class="branch-pill ${effective.has(name) ? "active" : ""}" data-branch="${escapeHtml(name)}">${escapeHtml(shortBranchName(name))}</button>`
      )
      .join("") +
    `<button class="btn-subtle" id="btn-branch-reset" title="清除本地偏好，恢复默认口径（淮海路馆＋东馆）">恢复默认</button>`;
  box.querySelectorAll(".branch-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = new Set(mainBranches() ?? all);
      const name = btn.dataset.branch;
      if (next.has(name)) next.delete(name);
      else next.add(name);
      try {
        // 全部取消勾选 = 清空偏好，回落默认口径（避免「一个馆都不选」的空口径）
        if (next.size) localStorage.setItem(BRANCH_PREFS_KEY, JSON.stringify([...next]));
        else localStorage.removeItem(BRANCH_PREFS_KEY);
      } catch {
        /* 隐私模式写不进去时仅本次会话生效 */
      }
      render();
    });
  });
  $("#btn-branch-reset")?.addEventListener("click", () => {
    try {
      localStorage.removeItem(BRANCH_PREFS_KEY);
    } catch {
      /* 同上 */
    }
    render();
  });
}

function formatTs(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 筛选 pills：按当前可借状态过滤书卡（分馆口径见 mainBranches()，可在分馆偏好中调整）
// 书单里有 tags 时追加标签 chips，与状态 pills 叠加过滤（再点选中的标签可取消）
function renderFilterBar() {
  const bar = $("#branch-bar");
  bar.hidden = false;
  const filters = ["全部", "可以外借", "全部借出", "仅馆内阅览"];
  $("#branch-pills").innerHTML = filters
    .map((f) => `<button class="branch-pill ${f === state.filter ? "active" : ""}" data-filter="${f}">${f}</button>`)
    .join("");
  $("#branch-pills").querySelectorAll(".branch-pill").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filter = btn.dataset.filter;
      render();
    });
  });

  const allTags = [...new Set((state.index?.books ?? []).flatMap((b) => b.tags ?? []))];
  const tagBox = $("#tag-chips");
  if (!allTags.length) {
    tagBox.hidden = true;
    tagBox.innerHTML = "";
    state.tag = null;
    return;
  }
  if (state.tag && !allTags.includes(state.tag)) state.tag = null; // 书单里已没有该标签
  tagBox.hidden = false;
  tagBox.innerHTML = `<span class="tag-chips-label">标签：</span>` + allTags
    .map((t) => `<button class="tag-chip ${t === state.tag ? "active" : ""}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</button>`)
    .join("");
  tagBox.querySelectorAll(".tag-chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tag = state.tag === btn.dataset.tag ? null : btn.dataset.tag;
      render();
    });
  });
}

// 顶部「当前可借情况」：按最新一次采样（普通外借口径）分三组展示
function renderAvailability() {
  const board = $("#avail-board");
  board.hidden = false;
  const groups = { available: [], borrowed_out: [], inhouse: [], nodata: [] };
  for (const book of state.index.books) {
    groups[availabilityGroup(book.id)].push(book);
  }
  const chip = (book, cls) =>
    `<button class="chip ${cls}" data-book="${escapeHtml(book.id)}" title="定位到书卡">${escapeHtml(book.title)}${newlyAvailable.has(book.id) ? `<span class="new-badge">新可借</span>` : ""}</button>`;
  $("#chips-available").innerHTML =
    groups.available.map((b) => chip(b, "ok")).join("") || `<span class="chips-empty">无</span>`;
  $("#chips-borrowed").innerHTML =
    groups.borrowed_out.map((b) => chip(b, "warn")).join("") || `<span class="chips-empty">无</span>`;
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
  $("#stat-score").innerHTML = avgScore !== null ? String(avgScore) : `<small>数据积累中</small>`;
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
      (!state.tag || (x.book.tags ?? []).includes(state.tag)) &&
      (state.filter === "全部" ||
        (state.filter === "可以外借" && x.group === "available") ||
        (state.filter === "全部借出" && x.group === "borrowed_out") ||
        (state.filter === "仅馆内阅览" && x.group === "inhouse"))
  );

  // 按书单分组（group 字段）分节，保持书单原顺序；无分组的书归入默认节
  // 全部书都无分组（旧数据）时不渲染节标题，与旧版展示一致
  const hasGroups = visible.some((x) => x.book.group);
  const sections = new Map(); // group|null -> items（Map 保持插入顺序）
  for (const x of visible) {
    const g = x.book.group || null;
    if (!sections.has(g)) sections.set(g, []);
    sections.get(g).push(x);
  }
  for (const [groupName, sectionItems] of sections) {
    if (hasGroups) {
      const h = document.createElement("h2");
      h.className = "group-title";
      h.textContent = groupName ?? "其他";
      list.appendChild(h);
    }
    for (const { book, stats } of sectionItems) {
      list.appendChild(buildBookCard(book, stats));
    }
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
    // 书单标签（books.txt 第四列）：小徽章展示
    book.tags?.length ? book.tags.map((t) => `<span class="book-tag">${escapeHtml(t)}</span>`).join("") : null,
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
    // 文案区分「今天没了，可蹲点」（borrowed_out）和「只能去馆里看」（inhouse）
    const statusHtml = noOrdinary
      ? `<span class="v">仅馆内阅览 —— 只能去馆里看，馆藏均为保存 / 参考 / 阅览类资料，不可外借</span>`
      : latest.available >= 1
        ? `<span class="v ok">当前可借（普通外借在架 ${latest.available}/${latest.total} 册）</span>`
        : latest.inLibrary >= 1
          ? `<span class="v">今天借完了（0/${latest.total} 册普通外借在架），可蹲点；另有 ${latest.inLibrary} 册仅馆内阅览</span>`
          : `<span class="v bad">今天借完了（0/${latest.total} 册普通外借在架），可蹲点</span>`;

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
      ${actionLineHtml(book)}
      ${branchRowsHtml(book)}
      ${circulationHtml(latest)}
      ${statsHtml}
      ${!noOrdinary && stats.samples < 3 ? warmupRowHtml(stats) : ""}`;
  }

  card.innerHTML = `
    <div class="score-col">
      <div>
        ${scoreHtml}
        <span class="score-badge ${rating.cls}">${rating.text}</span>
        <div class="score-meter"><i style="width:${stats && !noOrdinary && stats.samples >= 3 ? stats.score : 0}%"></i></div>
        <div class="score-caption">难借分越高越难借<br>按普通外借册：在架率（按册数折减）· 周末落差（样本≥5 才计）· 连续借空加分</div>
      </div>
    </div>
    <div>
      <h3 class="book-title">${titleHtml}${newlyAvailable.has(book.id) ? `<span class="new-badge">新可借</span>` : ""}</h3>
      <div class="book-meta">${metaBits.join("")}</div>
      ${bodyHtml}
    </div>`;
  return card;
}

// 书卡顶部一行行动建议：按优先级取第一条命中
// 1. 主馆有可借（精确到馆藏位置）→ 2. 网借中心可约 → 3. 全部借出（有 dueDate 给最早归还日）→ 4. 仅馆内阅览
function actionLineHtml(book) {
  const sample = bookSamples(book.id).at(-1);
  if (!sample) return "";
  const branches = sample.branches ?? {};
  const names = Object.keys(branches);
  const main = mainBranches() ?? names;
  // 某馆普通外借在架册列表（无册级明细的旧数据用分馆聚合值兜底）
  const availableCopiesAt = (name) => {
    const b = branches[name];
    if (!b) return [];
    const copies = Array.isArray(b.copies) ? b.copies : [];
    if (!copies.length) return (b.available ?? 0) >= 1 ? [{}] : [];
    return copies.filter((c) => bucketOf(c.circulationType) === "normal" && c.availability === "available");
  };

  // 1. 主馆有可借：多个馆都有时逐馆分行列出
  const spots = main
    .map((name) => {
      const ok = availableCopiesAt(name);
      if (!ok.length) return null;
      const locs = [...new Set(ok.map((c) => c.location).filter(Boolean))];
      const locText = locs.length ? `（${locs.map(escapeHtml).join("；")}）` : "";
      return `${escapeHtml(shortBranchName(name))} ${ok.length} 册在架${locText}`;
    })
    .filter(Boolean);
  if (spots.length)
    return spots.map((s) => `<div class="action-line ok">${s}</div>`).join("");

  // 2. 网借中心有可借：线上下单送书，对读者最友好的渠道
  if (names.some((n) => n.includes("网借中心") && availableCopiesAt(n).length)) {
    return `<div class="action-line">📦 网借中心可约，支持线上下单送书</div>`;
  }

  const group = availabilityGroup(book.id);
  // 3. 全部借出：copy 级 dueDate 为 sampler 侧契约（"YYYY-MM-DD" 或 null），缺失时降级为「全部借出」
  if (group === "borrowed_out") {
    const dues = [];
    for (const name of names) {
      for (const c of branches[name]?.copies ?? []) {
        if (bucketOf(c.circulationType) !== "normal" || typeof c.dueDate !== "string") continue;
        const m = c.dueDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
        if (m) dues.push({ key: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, text: `${+m[2]}月${+m[3]}日` });
      }
    }
    dues.sort((a, b) => a.key.localeCompare(b.key));
    return dues.length
      ? `<div class="action-line warn">⏳ 全部借出，最早预计 ${dues[0].text} 归还</div>`
      : `<div class="action-line warn">⏳ 全部借出</div>`;
  }
  // 4. 仅馆内阅览
  if (group === "inhouse") return `<div class="action-line muted">🏛 仅馆内阅览，不可外借</div>`;
  return "";
}

// 冷启动期兜底：采样未满 3 次不出难借分，但展示已有信息（采样天数 / 较上次的在架册数变化）
function warmupRowHtml(stats) {
  const parts = [`已采样 ${stats.samples} 天，满 3 次后出难借分`];
  if (stats.rows.length >= 2) {
    const delta = stats.rows.at(-1).available - stats.rows.at(-2).available;
    parts.push(delta === 0 ? "在架册数与上次持平" : `较上次 ${delta > 0 ? "+" : ""}${delta} 册在架`);
  }
  return `<div class="kv-row"><span class="k">积累中</span><span class="v">${parts.join("；")}</span></div>`;
}

// 分馆小表：口径内分馆（mainBranches，默认淮海路/东馆）与网借中心平铺（网借支持线上下单，单独提级），其余分馆折叠；无数据显示「无数据」
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
  const online = all.filter((n) => !main.includes(n) && n.includes("网借中心"));
  const others = all.filter((n) => !main.includes(n) && !n.includes("网借中心"));

  return `
    <div class="branch-rows">
      ${main.map(rowHtml).join("")}
      ${online.map(rowHtml).join("")}
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
  $("#btn-export-csv").addEventListener("click", exportCsv);
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

// ---------------- 数据导出 CSV ----------------
// CSV 单元格转义：含逗号/引号/换行时加引号，内部引号双写
function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 导出粒度：书 × 分馆 × 采样日期，导出全部历史（与 prune 勾选无关）、全部分馆（不按主馆口径过滤）
// 无册级明细的旧数据由 sampleCounts 用分馆聚合值兜底（全部视为普通外借）；错误样本由 bookSamples 剔除
function buildCsvRows() {
  const rows = [];
  for (const book of state.index?.books ?? []) {
    const callNumber = callNumberText(book, "; ");
    const samples = bookSamples(book.id).slice().sort((a, b) => a.date.localeCompare(b.date));
    for (const s of samples) {
      for (const branch of Object.keys(s.branches ?? {}).sort()) {
        const c = sampleCounts(s, [branch]);
        if (!c) continue;
        rows.push([
          s.date,
          WEEK_NAMES[s.weekday] ?? "",
          book.title,
          callNumber,
          branch,
          c.available,
          c.total,
          c.ref,
          c.keep,
          c.total > 0 ? Math.round((c.available / c.total) * 100) : "",
        ]);
      }
    }
  }
  return rows;
}

function buildCsvText() {
  const header = ["日期", "星期", "书名", "索书号", "分馆", "普通外借在架", "普通外借总数", "参考外借", "保存/阅览", "在架率%"];
  const lines = [header, ...buildCsvRows()].map((r) => r.map(csvCell).join(","));
  // 加 BOM 保证 Excel 打开中文不乱码
  return "\ufeff" + lines.join("\r\n");
}

function exportCsv() {
  const today = new Date().toISOString().slice(0, 10);
  downloadText(`图书难借吗-${today}.csv`, buildCsvText(), "text/csv;charset=utf-8");
  toast("已导出 CSV —— 含全部历史与全部分馆，与上方勾选无关");
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
  let currentGroup = null; // 「## 组名」组头行作用于其后的书，空组头回到未分组
  for (const [i, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("##")) {
      currentGroup = line.slice(2).trim() || null;
      continue;
    }
    if (line.startsWith("#")) continue;
    const parts = splitBookLine(line);
    const [title, callNumber, recordId, tagsField] = parts;
    const tags = String(tagsField ?? "")
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const problems = [];
    if (!title && !callNumber) problems.push("书名和索书号不能都为空");
    const cnProblem = callNumberProblem(callNumber);
    if (cnProblem) problems.push(cnProblem);
    if (recordId && callNumber && callNumber.split(/[;；]/).length > 1) problems.push("多索书号行的 record_id 会被采样器忽略");
    if (recordId && !/^[0-9a-fA-F-]{8,}$/.test(recordId)) problems.push("record_id 格式可疑");
    if (parts.length > 4) problems.push("超过 4 列");
    results.push({ line: i + 1, title, callNumber, recordId, group: currentGroup, tags, problems });
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
      <td><input type="text" class="book-group" placeholder="可选" value="${escapeHtml(book.group ?? "")}"></td>
      <td><input type="text" class="book-tags" placeholder="可选，逗号分隔" value="${escapeHtml((book.tags ?? []).join(","))}"></td>
      <td class="tc row-status">${statusTagHtml(book.resolveStatus ?? "new")}</td>
      <td class="tc"><button class="btn-delete" title="删除">删除</button></td>
    `;
    tr.querySelector(".btn-delete").addEventListener("click", () => { tr.remove(); saveDraft(); });
    tr.querySelector(".book-enabled").addEventListener("change", () => { updateRowStyle(tr); saveDraft(); });
    // 编辑过内容后，原来的匹配状态失效，标记为「已修改」；同时自动保存草稿
    tr.querySelectorAll(".book-title, .book-call, .book-record, .book-group, .book-tags").forEach((input) => {
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
      group: tr.querySelector(".book-group").value.trim() || null,
      tags: tr.querySelector(".book-tags").value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
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
      "# 格式：书名 | 索书号 | record_id（可选）| 标签（可选，逗号分隔）",
      "# 多卷册：索书号用 ; 分隔（如 TU-092/3965-20; TU-092/3965-17），此时 record_id 不适用",
      "# 分组：以「## 组名」行开始一个分组，作用于其后的所有书",
      "",
    ].join("\n");
    // 按分组聚类输出：相邻同组的书共享一个「## 组名」组头，组间空行；未分组书不打组头
    const lines = [];
    let lastGroup = undefined;
    for (const r of rows) {
      if (r.group !== lastGroup) {
        if (lines.length) lines.push("");
        if (r.group) lines.push(`## ${r.group}`);
        else if (lastGroup) lines.push("##"); // 空组头：从分组回到未分组
        lastGroup = r.group;
      }
      const line = [r.title, r.callNumber, r.recordId, r.tags.length ? r.tags.join(",") : null].filter(Boolean).join(" | ");
      lines.push(r.disabled ? `# ${line}` : line);
    }
    return `${header}${lines.join("\n")}\n`;
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
      books.forEach((b) => addRow({ title: b.title, callNumber: callNumberText(b, "; "), recordId: b.recordId, group: b.group, tags: b.tags, disabled: false, resolveStatus: b.resolveStatus }));
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
      parsed.forEach((r) => addRow({ title: r.title, callNumber: r.callNumber, recordId: r.recordId, group: r.group, tags: r.tags, disabled: false }));
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
