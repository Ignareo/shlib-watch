// record_id 缓存：按索书号缓存已解析出的 record_id，避免每次采样都走慢检索
// 缓存值兼容两种形态：字符串（旧格式，仅 record_id）
// 或对象 { recordId, meta }（meta 含 authors/publisher 等元数据，供 index.json 回填）
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

// 读取缓存条目，统一成 { recordId, meta? }（兼容旧的字符串值）
export function readCacheEntry(cache, key) {
  const value = cache[key];
  if (typeof value === "string") return value ? { recordId: value } : null;
  if (value && typeof value === "object" && value.recordId) return value;
  return null;
}

// 从解析结果中提取可缓存的元数据子集（没有有效信息时返回 null，仍按旧格式存字符串）
export function pickCacheMeta(meta) {
  if (!meta) return null;
  const picked = {
    title: meta.title ?? null,
    authors: meta.authors ?? [],
    publisher: meta.publisher ?? null,
    publishedYear: meta.publishedYear ?? null,
    materialType: meta.materialType ?? null,
  };
  const hasInfo =
    picked.title || picked.authors.length || picked.publisher ||
    picked.publishedYear || picked.materialType;
  return hasInfo ? picked : null;
}
