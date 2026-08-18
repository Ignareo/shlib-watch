// 图书难借吗 · 采样器入口
// 用法：
//   node src/index.js check            查看今天是否为采样日
//   node src/index.js sample [--force] 执行一次采样（--force 忽略周期判断）
//   node src/index.js prune --dates 2026-08-01,2026-08-02 --before 2026-06-01
import fs from "node:fs";
import path from "node:path";
import { LibraryClient, CaptchaRequiredError } from "./client.js";
import { parseSearchResults, parseHoldings, parseRecordMetadata, groupByBranch } from "./parsers.js";
import { parseBooksFile, resolveBook, assignStableIds } from "./books.js";
import { fillDueDates } from "./duedate.js";
import { isSamplingDay, describeSchedule, toLocalDateStr } from "./schedule.js";
import {
  loadIndex, saveIndex, loadHistory, saveHistory, upsertSample,
  readPruneRequest, clearPruneRequest, applyPrune, collectBranches,
  HISTORY_DIR,
} from "./store.js";
import { solveCaptchaInteractively } from "./captcha.js";
import { commitAndPush } from "./git.js";
import { ROOT } from "./paths.js";
import { loadRecordCache, saveRecordCache, pickCacheMeta } from "./record-cache.js";

const CONFIG_FILE = path.join(ROOT, "config.json");
const BOOKS_FILE = path.join(ROOT, "books.txt");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    console.warn("[config] 未找到 config.json，使用默认配置");
    return {};
  }
}

function parseArgs(argv) {
  const args = { command: argv[2] ?? "sample", force: false, dates: [], before: null };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === "--force") args.force = true;
    else if (argv[i] === "--dates") args.dates = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--before") args.before = argv[++i] ?? null;
  }
  return args;
}

// history 目录下所有已存在的书 id（去 .json 后缀）：分配新 id 时跳过，防止复用已删除书的 id 串历史
function existingHistoryIds() {
  try {
    return fs
      .readdirSync(HISTORY_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

async function withCaptchaRetry(client, fn) {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof CaptchaRequiredError)) throw error;
    const canInteract =
      process.stdout.isTTY && !process.env.CI && !process.env.GITHUB_ACTIONS;
    if (!canInteract) {
      console.error(`
[采样] 当前环境无法人工过验证码（非交互终端 / CI 环境）。
本次采样取消，已有数据不受影响。建议：
  · 在本地电脑上运行 npm run sample:force（家庭网络通常不会触发验证）
  · 或在本地完成一次采样后，会话 Cookie 会缓存在 .cache/session.json
`);
      return null;
    }
    const solved = await solveCaptchaInteractively(client, error.url);
    if (!solved) return null;
    return await fn(); // 过码后重试一次
  }
}

async function cmdSample({ force }) {
  const config = loadConfig();
  const recordCache = loadRecordCache();
  const now = new Date();

  // 1. 周期判断
  if (!force && !isSamplingDay(config.schedule ?? {}, now)) {
    console.log(`[采样] 当前周期：${describeSchedule(config.schedule ?? {})}，今天不是采样日，退出。`);
    return;
  }
  console.log(`[采样] 周期：${describeSchedule(config.schedule ?? {})}，开始采样 ${toLocalDateStr(now)}`);

  // 2. 先执行网页端生成的历史数据清理任务
  const pruneRequest = readPruneRequest();
  if (pruneRequest && (pruneRequest.dates.length || pruneRequest.before)) {
    const removed = applyPrune(pruneRequest);
    clearPruneRequest();
    console.log(`[清理] 按 prune.json 删除了 ${removed} 条历史采样。`);
  }

  // 3. 读取书单
  const books = parseBooksFile(BOOKS_FILE);
  if (!books.length) {
    console.log("[采样] books.txt 为空，没有需要追踪的书。请在 books.txt 中按「书名 | 索书号」添加。");
    return;
  }
  console.log(`[采样] 共 ${books.length} 本书`);

  const client = new LibraryClient(config.request ?? {});
  const index = loadIndex();

  // 3b. 稳定 id：沿用既有数据中的书 id，避免书单增删/调序/合并行后历史错位
  assignStableIds(books, index.books ?? [], existingHistoryIds());

  const nowIso = now.toISOString();
  const dateStr = toLocalDateStr(now);
  const weekday = now.getDay() === 0 ? 7 : now.getDay();
  let sampled = 0;

  const resolveDeps = {
    parseSearchResults,
    fetchHoldingsCount: async (recordId) => parseHoldings(await client.fetchHoldings(recordId)).length,
    recordCache,
  };

  for (const book of books) {
    const callNumbers = book.callNumbers ?? [book.callNumber];
    console.log(`\n[采样] 《${book.title ?? "（未命名）"}》 ${callNumbers.join("; ")}`);

    // 3a. 逐索书号匹配 record_id（缓存 key「书名|索书号」按单个索书号不变）
    const resolutions = [];
    let aborted = false;
    for (const callNumber of callNumbers) {
      const resolution = await withCaptchaRetry(client, () =>
        resolveBook(client, { ...book, callNumber }, resolveDeps)
      );
      if (resolution === null) { aborted = true; break; } // 验证码未通过，终止本次运行
      resolutions.push({ callNumber, ...resolution });
      // 缓存解析成功的 record_id（多版本且需要核对时，暂不缓存）；有元数据则一并缓存
      if (resolution.status === "resolved" && resolution.recordId && !resolution.needsReview) {
        const key = `${book.title ?? ""}|${callNumber}`;
        const meta = pickCacheMeta(resolution.meta);
        recordCache[key] = meta ? { recordId: resolution.recordId, meta } : resolution.recordId;
      }
    }
    if (aborted) break;

    const resolved = resolutions.filter((r) => r.recordId);
    const failed = resolutions.filter((r) => !r.recordId);
    const primary = resolved[0] ?? resolutions[0] ?? null;

    const entry = {
      id: book.id,
      title: book.title ?? primary?.meta?.title ?? null,
      callNumber: callNumbers.length > 1 ? callNumbers : callNumbers[0], // 多卷册写入数组
      recordId: primary?.recordId ?? null,
      recordUrl: primary?.recordId
        ? `https://vufind.library.sh.cn/Record/${primary.recordId}`
        : null,
      resolveStatus: resolved.length ? "resolved" : "unresolved",
      needsReview: resolutions.some((r) => r.needsReview) || failed.length > 0,
      authors: primary?.meta?.authors ?? [],
      publisher: primary?.meta?.publisher ?? null,
      publishedYear: primary?.meta?.publishedYear ?? null,
      materialType: primary?.meta?.materialType ?? null,
      candidates: resolutions.flatMap((r) => r.candidates ?? []).slice(0, 5).map((c) => ({
        recordId: c.recordId, title: c.title, callNumber: c.callNumber,
        authors: c.authors, publishedYear: c.publishedYear,
      })),
      historyFile: `data/history/${book.id}.json`,
    };
    // 分组 / 标签：有值才输出，保持 index.json schema 干净
    if (book.group) entry.group = book.group;
    if (book.tags?.length) entry.tags = book.tags;
    if (failed.length) {
      entry.unresolvedCallNumbers = failed.map((f) => f.callNumber);
      console.warn(`[采样]   部分索书号未匹配：${entry.unresolvedCallNumbers.join("、")}，已记 needsReview`);
    }

    // 3a+. 元数据回填：缓存命中（且缓存里没存元数据）或手写 record_id 时 meta 为空，
    // 补抓一次记录页解析回填；结果写回缓存，下次采样直接命中不再重复抓。失败不影响采样。
    const metadataMissing =
      entry.recordId && (!entry.authors?.length || !entry.publisher || !entry.publishedYear);
    if (metadataMissing) {
      try {
        const recordHtml = await withCaptchaRetry(client, () => client.fetchRecord(entry.recordId));
        if (recordHtml) {
          const meta = parseRecordMetadata(recordHtml);
          if (!entry.authors?.length && meta.authors.length) entry.authors = meta.authors;
          entry.publisher ??= meta.publisher;
          entry.publishedYear ??= meta.publishedYear;
          entry.materialType ??= meta.materialType;
          entry.title ??= meta.title;
          console.log(`[采样]   已从记录页回填元数据（作者 ${entry.authors.length} 位）`);
          // 回填到缓存（仅限已有缓存条目；needsReview / 手写 record_id 的仍不新增缓存）
          const primaryKey = `${book.title ?? ""}|${primary?.callNumber ?? callNumbers[0]}`;
          const cached = recordCache[primaryKey];
          const cacheMeta = pickCacheMeta(meta);
          if (cacheMeta) {
            if (typeof cached === "string") {
              recordCache[primaryKey] = { recordId: cached, meta: cacheMeta };
            } else if (cached && typeof cached === "object") {
              cached.meta = cacheMeta;
            }
          }
        }
      } catch (error) {
        console.warn(`[采样]   元数据回填失败（不影响采样）：${error.message}`);
      }
    }

    // 3b. 抓馆藏：每个 record 各取一次，copies 拼接后统一按分馆聚合，写成一条 sample
    if (resolved.length) {
      const allCopies = [];
      for (const r of resolved) {
        const holdingsHtml = await withCaptchaRetry(client, () => client.fetchHoldings(r.recordId));
        if (holdingsHtml === null) { aborted = true; break; }
        allCopies.push(...parseHoldings(holdingsHtml));
      }
      if (aborted) break;
      // 借出册补查「预计归还日期」（只对借出册发请求，单册失败不影响整体）
      await withCaptchaRetry(client, () => fillDueDates(client, allCopies));
      const branches = groupByBranch(allCopies);
      console.log(
        `[采样]   ${allCopies.length} 册 / ${Object.keys(branches).length} 个分馆；` +
        Object.entries(branches)
          .map(([name, b]) => `${name} 可借 ${b.available}/${b.total}`)
          .join("；")
      );

      const history = loadHistory(book.id);
      upsertSample(history, {
        ts: nowIso,
        date: dateStr,
        weekday,
        error: null,
        branches,
      });
      saveHistory(history);
      sampled += 1;
    } else {
      console.warn(`[采样]   未能匹配到书目记录，已记录候选，请在网页端核对`);
      const history = loadHistory(book.id);
      upsertSample(history, {
        ts: nowIso, date: dateStr, weekday,
        error: "unresolved",
        branches: {},
      });
      saveHistory(history);
    }

    // 更新索引（保留每本书最近一次解析出的元数据）
    const existingPos = (index.books ?? []).findIndex((b) => b.id === book.id);
    if (existingPos >= 0) index.books[existingPos] = entry;
    else (index.books ??= []).push(entry);
  }

  // 4. 写索引
  index.updatedAt = nowIso;
  index.schedule = describeSchedule(config.schedule ?? {});
  index.branches = collectBranches(index);
  saveIndex(index);
  console.log(`\n[采样] 完成，成功采样 ${sampled}/${books.length} 本。`);

  // 5. 缓存 & 提交
  saveRecordCache(recordCache);
  commitAndPush(`sample: ${dateStr}（${sampled}/${books.length} 本）`, config.git ?? {});
}

function cmdPrune({ dates, before }) {
  if (!dates.length && !before) {
    console.error("用法：node src/index.js prune --dates 2026-08-01,2026-08-02 --before 2026-06-01");
    process.exit(1);
  }
  const removed = applyPrune({ dates, before });
  console.log(`[清理] 已删除 ${removed} 条历史采样。`);
  const config = loadConfig();
  commitAndPush(`prune: 删除 ${removed} 条历史采样`, config.git ?? {});
}

function cmdCheck() {
  const config = loadConfig();
  const now = new Date();
  console.log(`周期设置：${describeSchedule(config.schedule ?? {})}`);
  console.log(`今天（${toLocalDateStr(now)}）是否采样日：${isSamplingDay(config.schedule ?? {}, now) ? "是" : "否"}`);
}

const args = parseArgs(process.argv);
try {
  if (args.command === "sample") await cmdSample(args);
  else if (args.command === "prune") cmdPrune(args);
  else if (args.command === "check") cmdCheck();
  else {
    console.error(`未知命令：${args.command}（可用：sample / prune / check）`);
    process.exit(1);
  }
} catch (error) {
  console.error(`\n[错误] ${error.message}`);
  process.exit(1);
}
