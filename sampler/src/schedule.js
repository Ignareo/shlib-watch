// 采样周期判断：daily / weekly / biweekly / monthly
// GitHub Actions 每天到点都会唤醒本程序，由这里决定「今天是否采样日」

export function isSamplingDay(schedule, now = new Date()) {
  const frequency = schedule.frequency ?? "daily";
  const weekday = isoWeekday(now); // 1=周一 ... 7=周日
  const dateStr = toLocalDateStr(now);

  switch (frequency) {
    case "daily":
      return true;

    case "weekly": {
      const days = schedule.weeklyDays?.length ? schedule.weeklyDays : [3, 6];
      return days.includes(weekday);
    }

    case "biweekly": {
      const days = schedule.weeklyDays?.length ? schedule.weeklyDays : [3];
      if (!days.includes(weekday)) return false;
      const anchor = new Date(`${schedule.anchorDate ?? dateStr}T00:00:00+08:00`);
      const diffWeeks = Math.floor((startOfDay(now) - startOfDay(anchor)) / (7 * 86400_000));
      return diffWeeks % 2 === 0;
    }

    case "monthly": {
      const day = schedule.monthlyDay ?? 1;
      return now.getDate() === day;
    }

    default:
      console.warn(`[schedule] 未知频率「${frequency}」，按每天处理`);
      return true;
  }
}

export function describeSchedule(schedule) {
  const names = { daily: "每天", weekly: "每周", biweekly: "每两周", monthly: "每月" };
  const weekNames = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  let desc = names[schedule.frequency] ?? "每天";
  if (schedule.frequency === "weekly" || schedule.frequency === "biweekly") {
    const days = (schedule.weeklyDays ?? [3, 6]).map((d) => weekNames[d]).join("、");
    desc += `（${days}）`;
  }
  if (schedule.frequency === "monthly") desc += `（每月 ${schedule.monthlyDay ?? 1} 日）`;
  return desc;
}

function isoWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
