// 平台抽象：sampler 核心的一切 I/O 都经 platform 注入，
// 使同一套代码可跑在 Node（CLI / server.js / GitHub Actions）与手机 WebView（Capacitor）两端。
// 本文件是 Node 实现；App 端实现见 mobile/sampler-entry.js。
//
// 逻辑路径约定（两端一致）：
//   "config.json" / "books.txt" / ".cache/*.json" → 仓库根目录（App 端为 Filesystem 根）
//   "data/..."                                    → docs/data/（App 端为 Filesystem 下同名路径）
//
// platform 接口：
//   fetch(url, init)         fetch 兼容函数（App 端为 CapacitorHttp 包装）
//   manageCookies            true = 手动收集 Set-Cookie 拼 Cookie 头（Node）；
//                            false = 原生层自动管理 cookie（App）
//   readText(path)           → string | null（不存在返回 null）
//   writeText(path, text)    自动创建父目录
//   removeFile(path)         不存在不报错
//   listJsonIds(path)        目录下 *.json 文件名（去后缀），目录不存在返回 []
//   log(msg) / warn(msg)
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.js";

// 可用环境变量 BBT_DATA_DIR 覆盖（测试用）
const DATA_DIR = process.env.BBT_DATA_DIR
  ? path.resolve(process.env.BBT_DATA_DIR)
  : path.join(ROOT, "docs", "data");

function resolvePath(logicalPath) {
  return logicalPath.startsWith("data/")
    ? path.join(DATA_DIR, logicalPath.slice("data/".length))
    : path.join(ROOT, logicalPath);
}

export const nodePlatform = {
  fetch: (...args) => globalThis.fetch(...args),
  manageCookies: true,
  async readText(logicalPath) {
    try {
      return fs.readFileSync(resolvePath(logicalPath), "utf8");
    } catch {
      return null;
    }
  },
  async writeText(logicalPath, text) {
    const file = resolvePath(logicalPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  },
  async removeFile(logicalPath) {
    fs.rmSync(resolvePath(logicalPath), { force: true });
  },
  async listJsonIds(logicalPath) {
    try {
      return fs
        .readdirSync(resolvePath(logicalPath))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  },
  log: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
};
