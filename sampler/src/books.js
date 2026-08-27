// books.txt 解析与 record_id 自动匹配
// 本模块为纯逻辑（无 Node API），两端（Node / App）共用；读文件由调用方负责
import { cacheKey, readCacheEntry } from "./record-cache.js";
import { CaptchaRequiredError } from "./client.js";

// 每行：书名 | 索书号 | record_id（可选）| 标签（可选，逗号分隔）
// 也支持只填索书号：| 索书号
// 索书号字段支持多卷册：用 ; 或全角 ；分隔多个索书号（此时第三列 record_id 不适用，会被忽略）
// 组头行：## 组名 —— 作用于其后的所有书，直到下一个组头；「##」空组头表示回到未分组
export function parseBooksText(raw) {
  const books = [];
  let currentGroup = null;
  for (const [index, lineRaw] of String(raw ?? "").split(/\r?\n/).entries()) {
    const line = lineRaw.trim();
    if (!line) continue;
    if (line.startsWith("##")) {
      currentGroup = line.slice(2).trim() || null;
      continue;
    }
    if (line.startsWith("#")) continue;
    const parts = line.split(/[|｜]/).map((p) => p.trim());
    const [title, callNumberField, recordId, tagsField] = parts;
    const tags = String(tagsField ?? "")
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const callNumbers = String(callNumberField ?? "")
      .split(/[;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!callNumbers.length) {
      console.warn(`[books] 第 ${index + 1} 行格式不正确（需要「书名 | 索书号」或「| 索书号」），已跳过：${line}`);
      continue;
    }
    if (callNumbers.length > 1 && recordId) {
      console.warn(`[books] 第 ${index + 1} 行有多个索书号，第三列 record_id 不适用，已忽略：${line}`);
    }
    books.push({
      id: `b${books.length + 1}`,
      title: title || null,
      callNumber: callNumbers.join("; "), // 拼接字符串，向后兼容旧用法
      callNumbers,
      recordId: callNumbers.length > 1 ? null : recordId || null,
      group: currentGroup,
      tags,
    });
  }
  return books;
}

// 稳定 id 分配：book id 直接对应历史文件 data/history/{id}.json，
// 按行号分配的 id 会在书单增删/调序/合并行后错位，污染历史数据（曾发生：汉口路上 b4 显示上海文学散步的旧采样）。
// 采样前对 parseBooksText 的结果调用：
//   1. 索书号集合与现有 index.json 某书一致 → 沿用其 id（改书名/调行序不影响）
//   2. 否则书名在两侧都唯一 → 沿用其 id（容忍修正索书号笔误）
//   3. 全新书目 → 分配未占用的最小新 id；不复用任何存在过历史文件的 id（含已删除的书），避免旧数据串书
// takenIds：历史上出现过的所有 id（history 目录下的文件名去后缀）
export function assignStableIds(books, existingBooks = [], takenIds = []) {
  const cnKeyOf = (b) => {
    const list = Array.isArray(b.callNumbers) && b.callNumbers.length
      ? b.callNumbers
      : Array.isArray(b.callNumber) ? b.callNumber : [b.callNumber];
    return list.map((s) => String(s ?? "").replace(/\s+/g, "").toLowerCase()).filter(Boolean).sort().join(";");
  };

  const consumed = new Set(); // 本轮已分配的 id
  const oldByCn = new Map();  // 索书号集合 -> 旧 id
  const oldIdsByTitle = new Map(); // 书名 -> 旧 id 列表
  for (const old of existingBooks) {
    if (!old?.id) continue;
    const key = cnKeyOf(old);
    if (key && !oldByCn.has(key)) oldByCn.set(key, old.id);
    if (old.title) {
      const list = oldIdsByTitle.get(old.title) ?? [];
      list.push(old.id);
      oldIdsByTitle.set(old.title, list);
    }
  }

  // 第 1 步：索书号集合一致
  const unmatched = [];
  for (const book of books) {
    const oldId = oldByCn.get(cnKeyOf(book));
    if (oldId && !consumed.has(oldId)) {
      book.id = oldId;
      consumed.add(oldId);
    } else {
      unmatched.push(book);
    }
  }

  // 第 2 步：书名双侧唯一匹配
  const newCountByTitle = new Map();
  for (const b of unmatched) {
    if (b.title) newCountByTitle.set(b.title, (newCountByTitle.get(b.title) ?? 0) + 1);
  }
  const stillUnmatched = [];
  for (const book of unmatched) {
    const candidates = (book.title ? oldIdsByTitle.get(book.title) ?? [] : []).filter((id) => !consumed.has(id));
    if (book.title && candidates.length === 1 && newCountByTitle.get(book.title) === 1) {
      book.id = candidates[0];
      consumed.add(book.id);
    } else {
      stillUnmatched.push(book);
    }
  }

  // 第 3 步：全新书目分配新 id（跳过所有存在过历史文件的 id）
  const historical = new Set([...takenIds, ...consumed]);
  let next = 1;
  for (const book of stillUnmatched) {
    while (historical.has(`b${next}`)) next++;
    book.id = `b${next}`;
    historical.add(book.id);
    consumed.add(book.id);
    next++;
  }
  return books;
}

function sameCallNumber(a, b) {
  const norm = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();
  return norm(a) && norm(a) === norm(b);
}

// 自动匹配：优先用缓存 record_id → 索书号检索 → 书名检索兜底；多候选取副本数最多者
// 若未填书名，则只按索书号检索，并用结果回填书名
export async function resolveBook(client, book, { parseSearchResults, fetchHoldingsCount, recordCache = {} }) {
  if (book.recordId) {
    return { status: "resolved", recordId: book.recordId, needsReview: false, candidates: [] };
  }

  const key = cacheKey(book);
  const cached = readCacheEntry(recordCache, key);
  if (cached) {
    console.log(`[resolve] 命中缓存 record_id：${cached.recordId}`);
    // 缓存里存过元数据则一并返回，供 index.json 回填
    return {
      status: "resolved",
      recordId: cached.recordId,
      needsReview: false,
      candidates: [],
      ...(cached.meta ? { meta: cached.meta } : {}),
    };
  }

  // 优先按索书号检索：更精确、通常更快；没命中再按书名兜底
  const searches = book.title
    ? [
        { query: book.callNumber, type: "CallNumber" },
        { query: book.title, type: "AllFields" },
      ]
    : [{ query: book.callNumber, type: "CallNumber" }];

  let candidates = [];
  let captchaHit = false;
  for (const s of searches) {
    try {
      const html = await client.fetchSearch(s.query, s.type);
      candidates = parseSearchResults(html);
    } catch (error) {
      if (error instanceof CaptchaRequiredError) {
        captchaHit = true;
      }
      console.warn(`[resolve] 检索失败（${s.type}: ${s.query}）：${error.message}`);
      continue;
    }
    const exact = candidates.filter((c) => sameCallNumber(c.callNumber, book.callNumber));
    if (exact.length) {
      candidates = exact;
      break;
    }
  }

  const exactMatches = candidates.filter((c) => sameCallNumber(c.callNumber, book.callNumber));
  if (!exactMatches.length) {
    return {
      status: captchaHit ? "captcha" : "unresolved",
      recordId: null,
      needsReview: true,
      candidates: candidates.slice(0, 5),
    };
  }

  if (exactMatches.length === 1) {
    return { status: "resolved", recordId: exactMatches[0].recordId, needsReview: false, candidates: exactMatches, meta: exactMatches[0] };
  }

  // 多个版本命中同一索书号：抓馆藏数，取副本最多者
  let best = null;
  let bestCount = -1;
  for (const candidate of exactMatches.slice(0, 3)) {
    let count = 0;
    try {
      count = await fetchHoldingsCount(candidate.recordId);
    } catch { /* 抓不到就按 0 算 */ }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return {
    status: "resolved",
    recordId: best.recordId,
    needsReview: true, // 多版本，提示人工核对
    candidates: exactMatches.slice(0, 5),
    meta: best,
  };
}
