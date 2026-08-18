// 采样完成后自动 git commit / push
import { execFileSync } from "node:child_process";
import { ROOT } from "./paths.js";

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (allowFail) return null;
    throw error;
  }
}

export function commitAndPush(message, { autoCommit = true, autoPush = true } = {}) {
  if (!autoCommit) {
    console.log("[git] 配置为不自动提交，跳过。请手动 commit 数据文件。");
    return false;
  }

  if (git(["rev-parse", "--is-inside-work-tree"], { allowFail: true }) !== "true") {
    console.log("[git] 当前目录还不是 git 仓库，跳过自动提交。部署到 GitHub 后此步骤会自动生效。");
    return false;
  }

  // 不覆盖用户已有配置，仅在缺失时补一个默认身份
  if (!git(["config", "user.name"], { allowFail: true })) {
    git(["config", "user.name", "book-borrow-tracker"]);
    git(["config", "user.email", "book-borrow-tracker@localhost"]);
  }

  git(["add", "docs/data", "books.txt", "config.json"]);
  const status = git(["status", "--porcelain"], { allowFail: true });
  if (!status) {
    console.log("[git] 数据无变化，无需提交。");
    return false;
  }

  git(["commit", "-m", message]);
  console.log(`[git] 已提交：${message}`);

  if (autoPush) {
    try {
      git(["push"]);
      console.log("[git] 已推送到远端仓库。");
    } catch (error) {
      console.warn(`[git] 推送失败（数据已提交到本地，可稍后手动 push）：${error.message}`);
    }
  }
  return true;
}
