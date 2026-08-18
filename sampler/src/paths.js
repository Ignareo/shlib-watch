// 仓库根目录定位：无论从哪个目录运行，都以本文件位置推导（sampler/src/paths.js → 上两级）
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CACHE_DIR = path.join(ROOT, ".cache");
