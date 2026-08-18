// HTML 解析：检索结果页 & 馆藏明细页
// 结构参照上海图书馆 VuFind 目录（vufind.library.sh.cn）
import * as cheerio from "cheerio";
import { classifyAvailability, normalizeWhitespace } from "./normalize.js";

const RECORD_ID_PATTERN = /\/Record\/([0-9a-fA-F-]+)/;
const SKIP_TITLES = new Set([
  "save to list", "email this", "export record", "cite this", "封面仅供参考",
]);
const HOLDING_LINE_PATTERN =
  /(?:Call Number|索书号):\s*(?<callNumber>.*?)(?:\s+(?:barcode|条码号):\s*(?<barcode>\S+))?\s+(?:Circulation Type|借阅类型):\s*(?<circulationType>.*?)\s+(?:Circulation Status|当前状态):\s*(?<status>.*)/iu;

// ---------------- 检索结果页 ----------------
export function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $("div.result-body").each((_, el) => {
    const body = $(el);
    const anchor = body.find("a.title.getFull[href]").first();
    const href = anchor.attr("href");
    if (!href) return;
    const match = RECORD_ID_PATTERN.exec(href);
    if (!match) return;
    const recordId = match[1];
    if (seen.has(recordId)) return;

    const title = normalizeWhitespace(anchor.text()).replace(/^\/+|\/+$/g, "").trim();
    if (!title || SKIP_TITLES.has(title.toLowerCase()) || title.length <= 1) return;
    seen.add(recordId);

    const meta = extractSearchMetadata($, body);
    items.push({ recordId, title, ...meta });
  });

  // 兼容：页面结构变化时的兜底（任何指向 /Record/ 的标题链接）
  if (!items.length) {
    $("a[href*='/Record/']").each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const match = RECORD_ID_PATTERN.exec(href);
      if (!match) return;
      const recordId = match[1];
      if (seen.has(recordId)) return;
      const title = normalizeWhitespace($(el).text()).replace(/^\/+|\/+$/g, "").trim();
      if (!title || title.length <= 1 || SKIP_TITLES.has(title.toLowerCase())) return;
      seen.add(recordId);
      items.push({
        recordId, title,
        authors: [], publisher: null, publishedYear: null,
        callNumber: null, materialType: null,
      });
    });
  }

  return items;
}

function extractSearchMetadata($, body) {
  const metadataBlock = getSearchMetadataBlock($, body);
  const authors = [];
  if (metadataBlock) {
    metadataBlock.find("span.author-data").each((_, el) => {
      const block = cheerio.load(el);
      const linked = block("a").toArray()
        .map((a) => normalizeWhitespace(block(a).text()))
        .filter(Boolean);
      const source = linked.length
        ? linked
        : block.root().text().split(/\n+/).map(normalizeWhitespace)
            .filter((t) => t && !/^\(.*\)$/.test(t));
      for (const name of source) if (!authors.includes(name)) authors.push(name);
    });
  }
  return {
    authors,
    publisher: extractMetadataValue(metadataBlock, "出版社"),
    publishedYear: extractMetadataValue(metadataBlock, "出版时间"),
    callNumber: extractMetadataValue(metadataBlock, "索书号"),
    materialType:
      normalizeWhitespace(body.find("div.result-formats span.format").first().text()) || null,
  };
}

function getSearchMetadataBlock($, body) {
  for (const child of body.children("div").toArray()) {
    const el = $(child);
    const classes = new Set((child.attribs.class ?? "").split(/\s+/).filter(Boolean));
    if (
      classes.has("callnumAndLocation") ||
      classes.has("result-formats") ||
      classes.has("result-previews") ||
      el.find("a.title.getFull[href]").length > 0
    ) continue;
    return el;
  }
  return null;
}

function extractMetadataValue(block, label) {
  if (!block) return null;
  const pattern = new RegExp(`^${escapeRegExp(label)}\\s*:\\s*(.+)$`, "u");
  for (const text of block.text().split(/\n+/)) {
    const match = pattern.exec(normalizeWhitespace(text));
    if (match?.[1]) return match[1].trim() || null;
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------- 馆藏明细页 ----------------
export function parseHoldings(html) {
  const $ = cheerio.load(html);
  const fromTables = parseHoldingsTables($);
  if (fromTables.length) return fromTables;
  return parseHoldingsText($);
}

function makeCopy(branch, location, fields) {
  const availability = classifyAvailability(fields.rawStatus, fields.circulationType);
  return {
    branch: branch || null,
    location: location || null,
    callNumber: fields.callNumber || null,
    barcode: fields.barcode || null,
    circulationType: fields.circulationType || null,
    rawStatus: fields.rawStatus || null,
    availability,
  };
}

function parseHoldingsTables($) {
  const copies = [];
  $("h2").each((_, el) => {
    const header = $(el);
    const branchText = normalizeWhitespace(header.text());
    if (!branchText.startsWith("Branch:") && !branchText.startsWith("所属馆:")) return;
    const branch = branchText.split(":", 2)[1]?.trim() ?? null;

    let sibling = header.next();
    while (sibling.length) {
      if (sibling.is("h2")) break;
      if (sibling.is("div.location-item")) {
        const location =
          normalizeWhitespace(sibling.find("h3").first().text()) || null;
        sibling.find("tr[vocab='http://schema.org/']").each((__, row) => {
          const cols = $(row).find("td").toArray();
          if (cols.length < 4) return;
          const text = (i) => normalizeWhitespace(cheerio.load(cols[i]).text()) || null;
          copies.push(
            makeCopy(branch, location, {
              callNumber: text(0), barcode: text(1),
              circulationType: text(2), rawStatus: text(3),
            })
          );
        });
      }
      sibling = sibling.next();
    }
  });
  return copies;
}

function parseHoldingsText($) {
  const chunks = $.root().text().split(/\n+/)
    .map(normalizeWhitespace).filter(Boolean);
  const copies = [];
  let branch = null;
  let location = null;

  for (const text of chunks) {
    if (text.startsWith("Branch:") || text.startsWith("所属馆:")) {
      branch = text.split(":", 2)[1]?.trim() ?? null;
      location = null;
      continue;
    }
    if (
      (text.includes("Call Number:") || text.includes("索书号:")) &&
      (text.includes("Circulation Status:") || text.includes("当前状态:"))
    ) {
      const match = HOLDING_LINE_PATTERN.exec(text);
      if (match?.groups) {
        copies.push(
          makeCopy(branch, location, {
            callNumber: normalizeWhitespace(match.groups.callNumber ?? "") || null,
            barcode: normalizeWhitespace(match.groups.barcode ?? "") || null,
            circulationType: normalizeWhitespace(match.groups.circulationType ?? "") || null,
            rawStatus: normalizeWhitespace(match.groups.status ?? "") || null,
          })
        );
      }
      continue;
    }
    if (branch && !location && looksLikeLocationLine(text)) location = text;
  }
  return copies;
}

function looksLikeLocationLine(text) {
  if (text.startsWith("上海图书馆")) return true;
  const lowered = text.toLowerCase();
  const disallowed = [
    "call number:", "索书号:", "circulation status:", "当前状态:",
    "circulation type:", "借阅类型:", "holdings", "related book", "full description",
  ];
  return !disallowed.some((m) => lowered.includes(m)) && text.length > 3;
}

// 把副本数组聚合成 { branch: {total, available, inLibrary, unavailable, unknown, copies} }
export function groupByBranch(copies) {
  const branches = {};
  for (const copy of copies) {
    const key = copy.branch || "未知分馆";
    if (!branches[key]) {
      branches[key] = { total: 0, available: 0, inLibrary: 0, unavailable: 0, unknown: 0, copies: [] };
    }
    const bucket = branches[key];
    bucket.total += 1;
    if (copy.availability === "available") bucket.available += 1;
    else if (copy.availability === "in_library") bucket.inLibrary += 1;
    else if (copy.availability === "unavailable") bucket.unavailable += 1;
    else bucket.unknown += 1;
    bucket.copies.push(copy);
  }
  return branches;
}
