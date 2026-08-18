// 借出册「预计归还时间」：页面上由前端 JS 异步请求 itemReturnDate 接口获取，
// 采样时对借出册各补一次请求（走 client 的限速/重试通道），回填 copy 级 dueDate。
// 任何单册失败只记日志、dueDate 置 null，不影响整次采样。
import { CaptchaRequiredError } from "./client.js";

// 接口返回 JSON：{"status":true,"data":"..."}，data 是含日期的文本或 HTML 片段；
// 也兼容直接返回纯文本的情况。解析不出日期返回 null。
export function parseReturnDateResponse(body) {
  let text = String(body ?? "");
  try {
    const json = JSON.parse(text);
    if (json && typeof json === "object") {
      text = String(json.data ?? json.msg ?? "");
    }
  } catch {
    /* 非 JSON，按纯文本处理 */
  }
  return extractIsoDate(text);
}

function extractIsoDate(text) {
  // 中文日期：2026年8月25日
  let match = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(text);
  if (match) return toIsoDate(match[1], match[2], match[3]);
  // ISO 及常见变体：2026-08-25 / 2026/8/25 / 2026.8.25
  match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (match) return toIsoDate(match[1], match[2], match[3]);
  return null;
}

function toIsoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// 只为真正借出的册发请求（有 itemId 且状态为「已借出」），逐册失败不中断
export async function fillDueDates(client, copies) {
  let fetched = 0;
  for (const copy of copies) {
    if (!copy.itemId || copy.availability !== "unavailable") continue;
    if (!/借出|checked out|on loan/i.test(copy.rawStatus ?? "")) continue;
    try {
      const body = await client.fetchItemReturnDate(copy.itemId);
      copy.dueDate = parseReturnDateResponse(body);
      fetched += 1;
    } catch (error) {
      if (error instanceof CaptchaRequiredError) throw error; // 验证码上抛给主流程处理
      console.warn(`[采样]   获取归还日期失败（itemId=${copy.itemId}）：${error.message}`);
      copy.dueDate = null;
    }
  }
  if (fetched) console.log(`[采样]   补查了 ${fetched} 册借出册的预计归还日期`);
  return copies;
}
