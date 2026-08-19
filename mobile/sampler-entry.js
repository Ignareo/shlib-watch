// App 端入口：把 sampler 核心（../sampler/src/，与 Node 端同一份代码）包装成
// window.BbtApp 暴露给 docs/app.js。由 mobile/build.mjs 用 esbuild 打包为
// www/vendor/sampler-bundle.js（仅存在于 APK 内；网页端 404，app.js 自动回落网页模式）。
//
// 平台适配要点（对照 sampler/src/platform.js 的接口约定）：
//   fetch         → CapacitorHttp（原生网络栈，绕过 WebView CORS）
//   manageCookies → false：cookie 由原生 CookieManager 自动管理（与 WebView 共享）
//   存储          → @capacitor/filesystem 的 Directory.Data；
//                   读取时若本机还没有该文件，回退到 APK 内置种子资源（fetch 相对路径）
import { CapacitorHttp } from "@capacitor/core";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { LibraryClient } from "../sampler/src/client.js";
import { createStore } from "../sampler/src/store.js";
import { runSampling } from "../sampler/src/run-sampling.js";

// ---------------- fetch 兼容包装 ----------------
// client.js 只用到这些响应字段：ok / status / statusText / url / headers.get / text()
async function nativeFetch(url, init = {}) {
  const res = await CapacitorHttp.request({
    method: init.method ?? "GET",
    url,
    headers: init.headers ?? {},
    data: init.body ?? undefined,
    responseType: "text",
  });
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    statusText: "",
    url: res.url ?? url,
    headers: {
      get: (key) => res.headers?.[key] ?? null,
      getSetCookie: () => [], // cookie 原生层自动管理，无需手动收集
    },
    text: async () => (typeof res.data === "string" ? res.data : JSON.stringify(res.data)),
  };
}

// ---------------- 平台实现 ----------------
let logSink = null; // 采样期间指向 UI 日志回调

const appPlatform = {
  fetch: nativeFetch,
  manageCookies: false,
  async readText(path) {
    try {
      const result = await Filesystem.readFile({
        path,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      return typeof result.data === "string" ? result.data : await result.data.text();
    } catch {
      // 本机还没有该文件（首次启动）→ 回退到 APK 内置种子资源
      try {
        const res = await fetch(path, { cache: "no-store" });
        if (res.ok) return await res.text();
      } catch {
        /* 种子资源也没有 */
      }
      return null;
    }
  },
  async writeText(path, text) {
    await Filesystem.writeFile({
      path,
      directory: Directory.Data,
      data: text,
      encoding: Encoding.UTF8,
      recursive: true,
    });
  },
  async removeFile(path) {
    try {
      await Filesystem.deleteFile({ path, directory: Directory.Data });
    } catch {
      /* 文件不存在，正常 */
    }
  },
  async listJsonIds(dir) {
    try {
      const result = await Filesystem.readdir({ path: dir, directory: Directory.Data });
      return result.files
        .map((f) => f.name ?? f)
        .filter((n) => n.endsWith(".json"))
        .map((n) => n.replace(/\.json$/, ""));
    } catch {
      // 首次启动目录不存在：从内置种子 index.json 推导已有书 id，避免 id 重分配串历史
      const raw = await appPlatform.readText("data/index.json");
      try {
        return (JSON.parse(raw).books ?? []).map((b) => b.id).filter(Boolean);
      } catch {
        return [];
      }
    }
  },
  log: (msg) => {
    console.log(msg);
    logSink?.(msg);
  },
  warn: (msg) => {
    console.warn(msg);
    logSink?.(msg);
  },
};

// ---------------- 验证码：WebView 内人工过码 ----------------
// 直接让 WebView 跳转到验证页，用户完成滑块后 cookie 进入共享 CookieManager；
// 按系统返回键回到 App（页面重载，数据都在 Filesystem 里不丢），再点「重新采样」即带 cookie。
async function solveCaptchaInWebView(client, url) {
  appPlatform.log(
    "[captcha] 触发人机验证。即将打开验证页面，请完成验证后按系统返回键回到 App，再点一次「重新采样」。"
  );
  await new Promise((resolve) => setTimeout(resolve, 1500)); // 让用户看到提示
  window.location.href = url;
  return new Promise(() => {}); // 页面即将跳转，此 promise 不会 resolve
}

// ---------------- 暴露给 docs/app.js 的接口 ----------------
let samplingRunning = false;

window.BbtApp = {
  // app.js 的 fetchJson 分流到这里：读本机 data/*（含种子回退）
  async fetchJson(path) {
    const text = await appPlatform.readText(path);
    if (text == null) throw new Error(`${path} 不存在`);
    return JSON.parse(text);
  },

  async saveBooksText(text) {
    await appPlatform.writeText("books.txt", text);
  },

  // onLog(line)：采样日志回调；force=false 时先做采样日判断（自动补采用）
  async runSampling({ force = false, onLog } = {}) {
    if (samplingRunning) throw new Error("已有采样在进行中");
    samplingRunning = true;
    logSink = onLog ?? null;
    try {
      let config = {};
      try {
        config = JSON.parse(await appPlatform.readText("config.json")) ?? {};
      } catch {
        /* 用默认配置 */
      }
      const booksText = (await appPlatform.readText("books.txt")) ?? "";
      return await runSampling({
        platform: appPlatform,
        client: new LibraryClient({ ...(config.request ?? {}), platform: appPlatform }),
        store: createStore(appPlatform),
        config,
        booksText,
        force,
        solveCaptcha: solveCaptchaInWebView,
      });
    } finally {
      samplingRunning = false;
      logSink = null;
    }
  },
};
