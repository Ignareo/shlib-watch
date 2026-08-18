// 验证码人工过码：检测到风控验证页时，弹出真实浏览器请用户过一次验证，
// 拿到会话 Cookie 后继续本批次所有抓取。
import { isVerificationHtml } from "./client.js";

export async function solveCaptchaInteractively(client, url) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error(`
[captcha] 需要人工过验证码，但未安装 Playwright。
请先执行：
  cd sampler
  npm install playwright
  npx playwright install chromium
然后重新运行采样。
`);
    return false;
  }

  console.log(`
[captcha] 上海图书馆触发了人机验证。
即将弹出浏览器窗口，请在其中完成滑块验证（只需一次），
通过后程序会自动继续，请不要手动关闭窗口……
`);

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "zh-CN",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // 轮询等待用户过完验证：验证成功后页面会跳回目标地址且不再是验证页
    const deadline = Date.now() + 5 * 60_000; // 最多等 5 分钟
    let passed = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      const currentUrl = page.url();
      if (currentUrl.includes("/verification")) continue;
      let html = "";
      try {
        html = await page.content();
      } catch {
        continue; // 页面正在跳转
      }
      if (!isVerificationHtml(html)) {
        passed = true;
        break;
      }
    }

    if (!passed) {
      console.error("[captcha] 等待超时（5 分钟），本次采样取消。请稍后重试。");
      return false;
    }

    const cookies = await context.cookies("https://vufind.library.sh.cn");
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    client.saveSession(cookieHeader);
    console.log("[captcha] 验证通过，会话已保存，继续采样。");
    return true;
  } finally {
    await browser.close();
  }
}
