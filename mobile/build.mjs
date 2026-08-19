// 安卓构建脚本：docs/ + books.txt + config.json → mobile/www/，再打包 sampler 核心，最后 cap sync
// 用法：cd mobile && npm install && npm run build
// 产出 APK：npm run open（Android Studio）或 cd android && ./gradlew assembleDebug（需 Android SDK）
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const MOBILE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MOBILE, "..");
const WWW = path.join(MOBILE, "www");

// 1. 拷贝看板与种子数据（docs/ 原样打包；books.txt / config.json 作为 App 内置默认）
console.log("[build] 拷贝 docs/ → mobile/www/");
fs.rmSync(WWW, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, "docs"), WWW, { recursive: true });
fs.copyFileSync(path.join(ROOT, "books.txt"), path.join(WWW, "books.txt"));
fs.copyFileSync(path.join(ROOT, "config.json"), path.join(WWW, "config.json"));

// 2. 打包 sampler 核心（含 cheerio，纯 JS 依赖，可在 WebView 运行）
console.log("[build] esbuild 打包 sampler-entry.js → www/vendor/sampler-bundle.js");
await esbuild.build({
  entryPoints: [path.join(MOBILE, "sampler-entry.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome110", // 安卓 WebView（Android 10+）内核
  outfile: path.join(WWW, "vendor", "sampler-bundle.js"),
  logLevel: "warning",
});

// 3. 同步到原生安卓工程（首次构建先 cap add android）
console.log("[build] cap sync android");
if (!fs.existsSync(path.join(MOBILE, "android"))) {
  console.log("[build] 首次构建，生成安卓工程…");
  execFileSync("npx", ["cap", "add", "android"], { cwd: MOBILE, stdio: "inherit" });
}
execFileSync("npx", ["cap", "sync", "android"], { cwd: MOBILE, stdio: "inherit" });

console.log("[build] 完成。打开 Android Studio（npm run open）构建 APK，或：");
console.log("  cd mobile/android && ./gradlew assembleDebug");
console.log("  产物：mobile/android/app/build/outputs/apk/debug/app-debug.apk");
