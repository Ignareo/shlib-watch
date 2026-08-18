// 图书难借吗 · 本地看板服务器（零依赖，Node ≥ 20）
// 用法：node server.js    →  http://localhost:8765
// 功能：
//   1. 静态托管 docs/（替代 python3 -m http.server）
//   2. POST /api/sample         触发一次真实采样（sampler/ 下 npm run sample:force）
//   3. GET  /api/sample/status  查询采样状态与日志尾部（前端据此判断是否本地服务器）
// 环境变量：PORT 覆盖端口；SAMPLE_CMD 覆盖采样命令（用于测试，避免真实请求上图网站）
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(ROOT, "docs");
const SAMPLER_DIR = path.join(ROOT, "sampler");
const PORT = Number(process.env.PORT ?? 8765);
const SAMPLE_CMD = process.env.SAMPLE_CMD ?? "npm run sample:force";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// ---------------- 采样进程状态 ----------------
const LOG_LIMIT = 200; // 内存环形日志上限
const sampling = { running: false, startedAt: null, exitCode: null, log: [], error: null };
let logTail = ""; // 跨 chunk 的半行缓冲

function appendLog(chunk) {
  const text = logTail + chunk;
  const lines = text.split(/\r?\n/);
  logTail = lines.pop(); // 最后一段可能还没换行
  for (const line of lines) {
    sampling.log.push(line);
    if (sampling.log.length > LOG_LIMIT) sampling.log.shift();
  }
}

function sampleStatus() {
  return {
    running: sampling.running,
    startedAt: sampling.startedAt,
    exitCode: sampling.exitCode,
    log: sampling.log.slice(-80),
    ...(sampling.error ? { error: sampling.error } : {}),
  };
}

function startSampling() {
  if (sampling.running) return false;
  sampling.running = true;
  sampling.startedAt = new Date().toISOString();
  sampling.exitCode = null;
  sampling.error = null;
  sampling.log = [];
  logTail = "";
  appendLog(`$ ${SAMPLE_CMD}（cwd: sampler/）\n`);

  // shell: true 以便 SAMPLE_CMD 支持整条命令串；输出同时透传到服务器终端（含验证码提示）
  const child = spawn(SAMPLE_CMD, { cwd: SAMPLER_DIR, shell: true, env: process.env });
  child.stdout.on("data", (d) => { process.stdout.write(d); appendLog(d.toString()); });
  child.stderr.on("data", (d) => { process.stderr.write(d); appendLog(d.toString()); });
  child.on("error", (err) => {
    sampling.running = false;
    sampling.error = err.message;
    appendLog(`[server] 采样进程启动失败：${err.message}\n`);
  });
  child.on("close", (code) => {
    if (logTail) { sampling.log.push(logTail); logTail = ""; }
    sampling.running = false;
    sampling.exitCode = code;
    appendLog(`[server] 采样进程退出，exit code ${code}\n`);
  });
  return true;
}

// ---------------- HTTP ----------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function serveStatic(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end("Bad Request");
    return;
  }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(DOCS_DIR, rel));
  // 防路径穿越
  if (file !== DOCS_DIR && !file.startsWith(DOCS_DIR + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/api/sample/status" && req.method === "GET") {
    sendJson(res, 200, sampleStatus());
    return;
  }
  if (url.pathname === "/api/sample" && req.method === "POST") {
    if (!startSampling()) {
      sendJson(res, 409, { error: "采样正在进行中", ...sampleStatus() });
      return;
    }
    sendJson(res, 202, sampleStatus());
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "unknown api" });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`图书难借吗 · 本地看板已启动`);
  console.log(`  看板地址：http://localhost:${PORT}/`);
  console.log(`  「重新采样」按钮将执行：cd sampler && ${SAMPLE_CMD}`);
  console.log(`  （采样完成后 sampler 会按 config.json 的 git 设置自动 commit/push）`);
});
