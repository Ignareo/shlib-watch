// 数据存取：docs/data/index.json + docs/data/history/{bookId}.json + 清理（prune）
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";

// 可用环境变量 BBT_DATA_DIR 覆盖（测试用）
export const DATA_DIR = process.env.BBT_DATA_DIR
  ? path.resolve(process.env.BBT_DATA_DIR)
  : path.join(ROOT, "docs", "data");
export const HISTORY_DIR = path.join(DATA_DIR, "history");
const INDEX_FILE = path.join(DATA_DIR, "index.json");
const PRUNE_FILE = path.join(DATA_DIR, "prune.json");

export function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  } catch {
    return { updatedAt: null, books: [], branches: [] };
  }
}

export function saveIndex(index) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

export function loadHistory(bookId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, `${bookId}.json`), "utf8"));
  } catch {
    return { bookId, samples: [] };
  }
}

export function saveHistory(history) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(HISTORY_DIR, `${history.bookId}.json`),
    JSON.stringify(history, null, 2)
  );
}

// 删除某本书某次采样（同一天只保留最新一次采样）
export function upsertSample(history, sample) {
  history.samples = history.samples.filter((s) => s.date !== sample.date);
  history.samples.push(sample);
  history.samples.sort((a, b) => a.ts.localeCompare(b.ts));
}

// ---------------- 历史数据清理 ----------------
// prune.json 格式：{ "dates": ["2026-08-01"], "before": "2026-06-01" }
export function readPruneRequest() {
  try {
    const raw = JSON.parse(fs.readFileSync(PRUNE_FILE, "utf8"));
    return {
      dates: Array.isArray(raw.dates) ? raw.dates : [],
      before: raw.before ?? null,
    };
  } catch {
    return null;
  }
}

export function clearPruneRequest() {
  fs.rmSync(PRUNE_FILE, { force: true });
}

export function applyPrune({ dates = [], before = null } = {}) {
  const index = loadIndex();
  let removed = 0;
  for (const book of index.books ?? []) {
    const history = loadHistory(book.id);
    const keep = history.samples.filter((s) => {
      const hitByDate = dates.includes(s.date);
      const hitByBefore = before && s.date < before;
      if (hitByDate || hitByBefore) removed += 1;
      return !(hitByDate || hitByBefore);
    });
    if (keep.length !== history.samples.length) {
      history.samples = keep;
      saveHistory(history);
    }
  }
  return removed;
}

export function collectBranches(index) {
  const set = new Set(index.branches ?? []);
  for (const book of index.books ?? []) {
    const history = loadHistory(book.id);
    const latest = history.samples.at(-1);
    for (const branch of Object.keys(latest?.branches ?? {})) set.add(branch);
  }
  return [...set].sort();
}
