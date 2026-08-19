// 图书难借吗 · 采样器入口（Node CLI）
// 用法：
//   node src/index.js check            查看今天是否为采样日
//   node src/index.js sample [--force] 执行一次采样（--force 忽略周期判断）
//   node src/index.js prune --dates 2026-08-01,2026-08-02 --before 2026-06-01
// 采样主流程在 run-sampling.js（两端共用），这里只负责：CLI 参数、组装 nodePlatform、
// 交互式过码（Playwright）、采样后的 git 自动提交
import { LibraryClient } from "./client.js";
import { createStore } from "./store.js";
import { runSampling } from "./run-sampling.js";
import { isSamplingDay, describeSchedule, toLocalDateStr } from "./schedule.js";
import { solveCaptchaInteractively } from "./captcha.js";
import { commitAndPush } from "./git.js";
import { nodePlatform } from "./platform.js";

async function loadConfig() {
  try {
    const raw = await nodePlatform.readText("config.json");
    if (raw != null) return JSON.parse(raw);
  } catch {
    /* 文件损坏时回落默认 */
  }
  console.warn("[config] 未找到 config.json，使用默认配置");
  return {};
}

async function loadBooksText() {
  const text = await nodePlatform.readText("books.txt");
  if (text === null) console.warn("[books] 未找到 books.txt，按空书单处理");
  return text ?? "";
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

async function cmdSample({ force }) {
  const config = await loadConfig();
  const result = await runSampling({
    platform: nodePlatform,
    client: new LibraryClient({ ...(config.request ?? {}), platform: nodePlatform }),
    store: createStore(nodePlatform),
    config,
    booksText: await loadBooksText(),
    force,
    // 仅交互终端（本地开发机）弹 Playwright 过码；CI / Actions 环境直接放弃本次采样
    solveCaptcha:
      process.stdout.isTTY && !process.env.CI && !process.env.GITHUB_ACTIONS
        ? solveCaptchaInteractively
        : null,
  });
  if (!result) return; // 非采样日 / 空书单 / 验证码未通过
  commitAndPush(
    `sample: ${result.dateStr}（${result.sampled}/${result.total} 本）`,
    config.git ?? {}
  );
}

async function cmdPrune({ dates, before }) {  if (!dates.length && !before) {
    console.error("用法：node src/index.js prune --dates 2026-08-01,2026-08-02 --before 2026-06-01");
    process.exit(1);
  }
  const store = createStore(nodePlatform);
  const removed = await store.applyPrune({ dates, before });
  console.log(`[清理] 已删除 ${removed} 条历史采样。`);
  const config = await loadConfig();
  commitAndPush(`prune: 删除 ${removed} 条历史采样`, config.git ?? {});
}

async function cmdCheck() {
  const config = await loadConfig();
  const now = new Date();
  console.log(`周期设置：${describeSchedule(config.schedule ?? {})}`);
  console.log(`今天（${toLocalDateStr(now)}）是否采样日：${isSamplingDay(config.schedule ?? {}, now) ? "是" : "否"}`);
}

const args = parseArgs(process.argv);
try {
  if (args.command === "sample") await cmdSample(args);
  else if (args.command === "prune") await cmdPrune(args);
  else if (args.command === "check") await cmdCheck();
  else {
    console.error(`未知命令：${args.command}（可用：sample / prune / check）`);
    process.exit(1);
  }
} catch (error) {
  console.error(`\n[错误] ${error.message}`);
  process.exit(1);
}
