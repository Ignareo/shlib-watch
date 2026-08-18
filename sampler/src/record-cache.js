// record_id 缓存：按索书号缓存已解析出的 record_id，避免每次采样都走慢检索
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "./paths.js";

const CACHE_FILE = path.join(CACHE_DIR, "records.json");

export function loadRecordCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (raw && typeof raw === "object") return raw;
  } catch {
    /* 无缓存或损坏 */
  }
  return {};
}

export function saveRecordCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

export function cacheKey(book) {
  // 用「书名 + 索书号」做 key，避免同名不同索书号串号
  return `${book.title ?? ""}|${book.callNumber}`;
}
