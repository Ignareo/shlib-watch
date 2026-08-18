// HTTP 客户端：请求上海图书馆 VuFind 目录系统
// 负责：请求间隔控制、超时、重试、反爬验证页识别、会话 Cookie 复用
import fs from "node:fs";
import path from "node:path";
import { CACHE_DIR } from "./paths.js";

export const BASE_URL = "https://vufind.library.sh.cn";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const SESSION_FILE = path.resolve(process.cwd(), ".cache/session.json");

export class CaptchaRequiredError extends Error {
  constructor(url) {
    super(`触发了上海图书馆的人机验证（权限验证页）：${url}`);
    this.name = "CaptchaRequiredError";
    this.url = url;
  }
}

export function isVerificationHtml(html) {
  return (
    html.includes("权限验证") ||
    html.includes("captcha-box") ||
    html.includes("/verification/js/")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LibraryClient {
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? BASE_URL).replace(/\/$/, "");
    this.intervalMs = options.intervalMs ?? 3000;
    this.timeoutMs = options.timeoutMs ?? 25000;
    this.retries = options.retries ?? 3;
    this.cookieHeader = "";
    this.lastRequestAt = 0;
    this.loadSession();
  }

  loadSession() {
    try {
      const raw = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
      if (raw.cookieHeader) {
        this.cookieHeader = raw.cookieHeader;
        console.log(`[client] 复用已保存的会话 Cookie（保存于 ${raw.savedAt}）`);
      }
    } catch {
      /* 没有历史会话，正常 */
    }
  }

  saveSession(cookieHeader) {
    this.cookieHeader = cookieHeader;
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(
      SESSION_FILE,
      JSON.stringify({ savedAt: new Date().toISOString(), cookieHeader }, null, 2)
    );
  }

  async pace() {
    const wait = this.intervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  async request(pathAndQuery, { method = "GET", body = null } = {}) {
    const url = `${this.baseUrl}${pathAndQuery}`;
    let lastError = null;

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      // 只在首次请求前限速；重试时不额外等待 intervalMs
      if (attempt === 1) await this.pace();
      const start = Date.now();
      try {
        const response = await fetch(url, {
          method,
          redirect: "follow",
          headers: {
            "User-Agent": USER_AGENT,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9",
            Referer: `${this.baseUrl}/`,
            ...(this.cookieHeader ? { Cookie: this.cookieHeader } : {}),
            ...(method === "POST"
              ? {
                  "Content-Type":
                    "application/x-www-form-urlencoded;charset=UTF-8",
                  "X-Requested-With": "XMLHttpRequest",
                }
              : {}),
          },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        // 收集响应里的 Set-Cookie（验证码通过后风控会种 Cookie）
        const setCookies =
          response.headers.getSetCookie?.() ??
          (response.headers.get("set-cookie")
            ? [response.headers.get("set-cookie")]
            : []);
        if (setCookies.length) {
          const pairs = setCookies.map((c) => c.split(";")[0]);
          const existing = new Set(
            (this.cookieHeader ? this.cookieHeader.split("; ") : []).filter(Boolean)
          );
          for (const p of pairs) existing.add(p);
          this.cookieHeader = [...existing].join("; ");
        }

        const finalUrl = response.url || url;
        const html = await response.text();

        if (finalUrl.includes("/verification") || isVerificationHtml(html)) {
          throw new CaptchaRequiredError(url);
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const elapsed = Date.now() - start;
        if (elapsed > 5000) {
          console.log(`[client] ${method} ${pathAndQuery} 完成，耗时 ${elapsed}ms`);
        }
        return html;
      } catch (error) {
        if (error instanceof CaptchaRequiredError) throw error; // 验证码不重试，直接上抛
        lastError = error;
        const elapsed = Date.now() - start;
        const backoff = 2000 * attempt;
        console.warn(
          `[client] 请求失败（第 ${attempt}/${this.retries} 次，已耗时 ${elapsed}ms）：${error.message}，${backoff}ms 后重试`
        );
        if (attempt < this.retries) await sleep(backoff);
      }
    }
    throw lastError;
  }

  // 关键词检索（type: AllFields / Title / CallNumber ...）
  fetchSearch(query, type = "AllFields", page = 1) {
    const params = new URLSearchParams({
      lookfor: query,
      type,
      searchtype: "vague",
      lng: "zh-cn",
    });
    if (page > 1) params.set("page", String(page));
    return this.request(`/Search/Results?${params.toString()}`);
  }

  // 馆藏明细（按 record_id）
  fetchHoldings(recordId) {
    return this.request(`/Record/${recordId}/AjaxTab`, {
      method: "POST",
      body: new URLSearchParams({
        tab: "holdings",
        folioLocations: "",
        libraryId: "",
      }).toString(),
    });
  }

  // 书目详情页（用于兜底解析标题等）
  fetchRecord(recordId) {
    return this.request(`/Record/${recordId}?lng=zh-cn`);
  }
}
