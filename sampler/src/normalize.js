// 馆藏流通状态归一化：available / unavailable / in_library / unknown
export function normalizeWhitespace(value) {
  return String(value ?? "").split(/\s+/).filter(Boolean).join(" ");
}

export function classifyAvailability(rawStatus, circulationType) {
  const statusText = normalizeWhitespace(rawStatus).toLowerCase();
  const circulationText = normalizeWhitespace(circulationType).toLowerCase();
  const combined = `${statusText} ${circulationText}`.trim();
  if (!combined) return "unknown";

  const inLibraryMarkers = [
    "in-library", "in library", "馆内", "仅供阅览", "阅览", "reference",
  ];
  const notAvailableMarkers = [
    "checked out", "on loan", "borrowed", "not for borrowing",
    "cataloging", "processing", "预约", "借出", "处理中", "不可借", "暂不可借",
  ];
  const availableMarkers = ["available", "可借", "在架", "shelf", "归还"];

  // 注意顺序：先判馆内阅览，再判不可借，最后判可借
  if (inLibraryMarkers.some((m) => combined.includes(m))) return "in_library";
  if (notAvailableMarkers.some((m) => combined.includes(m))) return "unavailable";
  if (availableMarkers.some((m) => combined.includes(m))) return "available";
  return "unknown";
}
