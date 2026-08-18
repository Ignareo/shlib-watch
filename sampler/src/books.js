// books.txt 解析与 record_id 自动匹配
import fs from "node:fs";
import { cacheKey } from "./record-cache.js";

// 每行：书名 | 索书号 | record_id（可选）
// 也支持只填索书号：| 索书号
// 索书号字段支持多卷册：用 ; 或全角 ；分隔多个索书号（此时第三列 record_id 不适用，会被忽略）
export function parseBooksFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const books = [];
  for (const [index, lineRaw] of raw.split(/\r?\n/).entries()) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[|｜]/).map((p) => p.trim());
    const [title, callNumberField, recordId] = parts;
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
    });
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
  const cachedId = recordCache[key];
  if (cachedId) {
    console.log(`[resolve] 命中缓存 record_id：${cachedId}`);
    return { status: "resolved", recordId: cachedId, needsReview: false, candidates: [] };
  }

  // 优先按索书号检索：更精确、通常更快；没命中再按书名兜底
  const searches = book.title
    ? [
        { query: book.callNumber, type: "CallNumber" },
        { query: book.title, type: "AllFields" },
      ]
    : [{ query: book.callNumber, type: "CallNumber" }];

  let candidates = [];
  for (const s of searches) {
    try {
      const html = await client.fetchSearch(s.query, s.type);
      candidates = parseSearchResults(html);
    } catch (error) {
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
      status: "unresolved",
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
