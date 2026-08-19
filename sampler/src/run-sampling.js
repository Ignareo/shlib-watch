// 采样主流程（两端共用）：周期判断 → prune → 逐书 resolve + 抓馆藏 + 写 JSON
// 平台相关能力全部注入：
//   platform     见 platform.js（Node 端为 nodePlatform，App 端见 mobile/sampler-entry.js）
//   client       已注入 platform 的 LibraryClient
//   store        createStore(platform) 的返回值
//   solveCaptcha (client, url) => Promise<boolean>；null 表示当前环境无法人工过码
// 返回 { dateStr, sampled, total }；非采样日或书单为空返回 null
import { CaptchaRequiredError } from "./client.js";
import { parseSearchResults, parseHoldings, parseRecordMetadata, groupByBranch } from "./parsers.js";
import { parseBooksText, resolveBook, assignStableIds } from "./books.js";
import { fillDueDates } from "./duedate.js";
import { isSamplingDay, describeSchedule, toLocalDateStr } from "./schedule.js";
import { upsertSample } from "./store.js";
import { loadRecordCache, saveRecordCache, pickCacheMeta } from "./record-cache.js";

export async function runSampling({
  platform, client, store, config = {}, booksText,
  force = false, solveCaptcha = null,
}) {
  const log = (msg) => platform.log(msg);
  const warn = (msg) => platform.warn(msg);
  const recordCache = await loadRecordCache(platform);
  const now = new Date();

  async function withCaptchaRetry(fn) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof CaptchaRequiredError)) throw error;
      if (!solveCaptcha) {
        warn(`
[采样] 当前环境无法人工过验证码（非交互终端 / CI 环境）。
本次采样取消，已有数据不受影响。建议：
  · 在本地电脑上运行 npm run sample:force（家庭网络通常不会触发验证）
  · 或在本地完成一次采样后，会话 Cookie 会缓存在 .cache/session.json
`);
        return null;
      }
      const solved = await solveCaptcha(client, error.url);
      if (!solved) return null;
      return await fn(); // 过码后重试一次
    }
  }

  // 1. 周期判断
  if (!force && !isSamplingDay(config.schedule ?? {}, now)) {
    log(`[采样] 当前周期：${describeSchedule(config.schedule ?? {})}，今天不是采样日，退出。`);
    return null;
  }
  log(`[采样] 周期：${describeSchedule(config.schedule ?? {})}，开始采样 ${toLocalDateStr(now)}`);

  // 2. 先执行网页端生成的历史数据清理任务
  const pruneRequest = await store.readPruneRequest();
  if (pruneRequest && (pruneRequest.dates.length || pruneRequest.before)) {
    const removed = await store.applyPrune(pruneRequest);
    await store.clearPruneRequest();
    log(`[清理] 按 prune.json 删除了 ${removed} 条历史采样。`);
  }

  // 3. 读取书单
  const books = parseBooksText(booksText);
  if (!books.length) {
    log("[采样] books.txt 为空，没有需要追踪的书。请在 books.txt 中按「书名 | 索书号」添加。");
    return null;
  }
  log(`[采样] 共 ${books.length} 本书`);

  const index = await store.loadIndex();

  // 3b. 稳定 id：沿用既有数据中的书 id，避免书单增删/调序/合并行后历史错位
  assignStableIds(books, index.books ?? [], await platform.listJsonIds("data/history"));

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
    log(`\n[采样] 《${book.title ?? "（未命名）"}》 ${callNumbers.join("; ")}`);

    // 3a. 逐索书号匹配 record_id（缓存 key「书名|索书号」按单个索书号不变）
    const resolutions = [];
    let aborted = false;
    for (const callNumber of callNumbers) {
      const resolution = await withCaptchaRetry(() =>
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
      warn(`[采样]   部分索书号未匹配：${entry.unresolvedCallNumbers.join("、")}，已记 needsReview`);
    }

    // 3a+. 元数据回填：缓存命中（且缓存里没存元数据）或手写 record_id 时 meta 为空，
    // 补抓一次记录页解析回填；结果写回缓存，下次采样直接命中不再重复抓。失败不影响采样。
    const metadataMissing =
      entry.recordId && (!entry.authors?.length || !entry.publisher || !entry.publishedYear);
    if (metadataMissing) {
      try {
        const recordHtml = await withCaptchaRetry(() => client.fetchRecord(entry.recordId));
        if (recordHtml) {
          const meta = parseRecordMetadata(recordHtml);
          if (!entry.authors?.length && meta.authors.length) entry.authors = meta.authors;
          entry.publisher ??= meta.publisher;
          entry.publishedYear ??= meta.publishedYear;
          entry.materialType ??= meta.materialType;
          entry.title ??= meta.title;
          log(`[采样]   已从记录页回填元数据（作者 ${entry.authors.length} 位）`);
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
        warn(`[采样]   元数据回填失败（不影响采样）：${error.message}`);
      }
    }

    // 3b. 抓馆藏：每个 record 各取一次，copies 拼接后统一按分馆聚合，写成一条 sample
    if (resolved.length) {
      const allCopies = [];
      for (const r of resolved) {
        const holdingsHtml = await withCaptchaRetry(() => client.fetchHoldings(r.recordId));
        if (holdingsHtml === null) { aborted = true; break; }
        allCopies.push(...parseHoldings(holdingsHtml));
      }
      if (aborted) break;
      // 借出册补查「预计归还日期」（只对借出册发请求，单册失败不影响整体）
      await withCaptchaRetry(() => fillDueDates(client, allCopies));
      const branches = groupByBranch(allCopies);
      log(
        `[采样]   ${allCopies.length} 册 / ${Object.keys(branches).length} 个分馆；` +
        Object.entries(branches)
          .map(([name, b]) => `${name} 可借 ${b.available}/${b.total}`)
          .join("；")
      );

      const history = await store.loadHistory(book.id);
      upsertSample(history, {
        ts: nowIso,
        date: dateStr,
        weekday,
        error: null,
        branches,
      });
      await store.saveHistory(history);
      sampled += 1;
    } else {
      warn(`[采样]   未能匹配到书目记录，已记录候选，请在网页端核对`);
      const history = await store.loadHistory(book.id);
      upsertSample(history, {
        ts: nowIso, date: dateStr, weekday,
        error: "unresolved",
        branches: {},
      });
      await store.saveHistory(history);
    }

    // 更新索引（保留每本书最近一次解析出的元数据）
    const existingPos = (index.books ?? []).findIndex((b) => b.id === book.id);
    if (existingPos >= 0) index.books[existingPos] = entry;
    else (index.books ??= []).push(entry);
  }

  // 4. 写索引
  index.updatedAt = nowIso;
  index.schedule = describeSchedule(config.schedule ?? {});
  index.branches = await store.collectBranches(index);
  await store.saveIndex(index);
  log(`\n[采样] 完成，成功采样 ${sampled}/${books.length} 本。`);

  // 5. 写 record_id 缓存（git 提交由 Node 端 CLI 负责，App 端无此步骤）
  await saveRecordCache(platform, recordCache);
  return { dateStr, sampled, total: books.length };
}
