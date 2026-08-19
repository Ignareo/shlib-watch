// 数据存取：data/index.json + data/history/{bookId}.json + 清理（prune）
// 所有 I/O 经 platform 注入（见 platform.js），两端（Node / App）共用

export function createStore(platform) {
  async function loadIndex() {
    const raw = await platform.readText("data/index.json");
    try {
      if (raw != null) return JSON.parse(raw);
    } catch {
      /* 文件损坏时回落默认 */
    }
    return { updatedAt: null, books: [], branches: [] };
  }

  async function saveIndex(index) {
    await platform.writeText("data/index.json", JSON.stringify(index, null, 2));
  }

  async function loadHistory(bookId) {
    const raw = await platform.readText(`data/history/${bookId}.json`);
    try {
      if (raw != null) return JSON.parse(raw);
    } catch {
      /* 文件损坏时回落默认 */
    }
    return { bookId, samples: [] };
  }

  async function saveHistory(history) {
    await platform.writeText(
      `data/history/${history.bookId}.json`,
      JSON.stringify(history, null, 2)
    );
  }

  // ---------------- 历史数据清理 ----------------
  // prune.json 格式：{ "dates": ["2026-08-01"], "before": "2026-06-01" }
  async function readPruneRequest() {
    try {
      const raw = JSON.parse(await platform.readText("data/prune.json"));
      return {
        dates: Array.isArray(raw.dates) ? raw.dates : [],
        before: raw.before ?? null,
      };
    } catch {
      return null;
    }
  }

  async function clearPruneRequest() {
    await platform.removeFile("data/prune.json");
  }

  async function applyPrune({ dates = [], before = null } = {}) {
    const index = await loadIndex();
    let removed = 0;
    for (const book of index.books ?? []) {
      const history = await loadHistory(book.id);
      const keep = history.samples.filter((s) => {
        const hitByDate = dates.includes(s.date);
        const hitByBefore = before && s.date < before;
        if (hitByDate || hitByBefore) removed += 1;
        return !(hitByDate || hitByBefore);
      });
      if (keep.length !== history.samples.length) {
        history.samples = keep;
        await saveHistory(history);
      }
    }
    return removed;
  }

  async function collectBranches(index) {
    const set = new Set(index.branches ?? []);
    for (const book of index.books ?? []) {
      const history = await loadHistory(book.id);
      const latest = history.samples.at(-1);
      for (const branch of Object.keys(latest?.branches ?? {})) set.add(branch);
    }
    return [...set].sort();
  }

  return {
    loadIndex, saveIndex, loadHistory, saveHistory,
    readPruneRequest, clearPruneRequest, applyPrune, collectBranches,
  };
}

// 删除某本书某次采样（同一天只保留最新一次采样）——纯逻辑，两端共用
export function upsertSample(history, sample) {
  history.samples = history.samples.filter((s) => s.date !== sample.date);
  history.samples.push(sample);
  history.samples.sort((a, b) => a.ts.localeCompare(b.ts));
}
