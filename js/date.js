// ============================================================================
// date.js — 日期工具（§6）
// 重點：日期、星期由「程式」依系統時間計算，不由 AI 猜（根治「今天記成昨天」）。
// 相對日期（昨天/前天/上週三）的字串解析，留待「輸入翻譯」段再補；
// 本段先提供：今天、星期幾、給確認卡用的日期格式。
// ============================================================================

const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// 系統今天 → 'YYYY-MM-DD'
export function todayStr() {
  const d = new Date();
  return ymd(d);
}

export function ymd(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 把 'YYYY-MM-DD' 轉成本地 Date（以中午建構，避開時區把日期推前一天的陷阱）
export function parseYMD(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
}

// 兩個日期相差幾天（a − b，可正可負）。給查重的「≤10 天視窗」用。
export function daysBetween(a, b) {
  const da = parseYMD(a), db = parseYMD(b);
  if (!da || !db) return Infinity;
  return Math.round((da.getTime() - db.getTime()) / 86400000);
}

// 星期幾（由日期算，供確認卡交叉檢查）
export function weekdayZh(dateStr) {
  const d = parseYMD(dateStr);
  if (!d) return '';
  return WEEK[d.getDay()];
}

// 確認卡用：'6月9日（星期一）'
export function formatWithWeekday(dateStr) {
  const d = parseYMD(dateStr);
  if (!d) return dateStr || '';
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
}

// ----------------------------------------------------------------------------
// 相對日期回推（§6）
// 「昨天/前天/三天前/上週三」→ 程式用「系統今天」回推實際日期。
// 回推結果一律進確認流程（顯示星期幾交叉檢查）；判不準回 null，交給使用者，不腦補。
// ----------------------------------------------------------------------------

// 全形數字 → 半形
function toHalfWidth(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// 中文數字 → 整數（支援 一~九十九，足夠日常「幾天前」）
function cnNumToInt(s) {
  s = s.trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map = { 零: 0, 一: 1, 兩: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  if (s.length === 1) return map[s] ?? null;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    const tens = a === '' ? 1 : (map[a] ?? null);
    const ones = b === '' ? 0 : (map[b] ?? null);
    if (tens == null || ones == null) return null;
    return tens * 10 + ones;
  }
  return null;
}

// 星期字 → 索引（以「週一=0 … 週日=6」的台灣慣例）
function weekdayCharToMonIdx(ch) {
  const m = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6, 末: 5 };
  return m[ch] ?? null;
}

function addDays(base, n) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
}

// 解析相對日期。base 預設系統今天（可注入以利測試）。
// 回傳 { date:'YYYY-MM-DD', matched:'命中的詞', offsetDesc:'說明' } 或 null（判不準）。
export function parseRelativeDate(text, base = new Date()) {
  if (!text) return null;
  let s = toHalfWidth(String(text)).replace(/\s/g, '');
  base = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12, 0, 0);

  // 固定詞
  const fixed = [
    [/^(今天|今日|本日)$/, 0], [/^(昨天|昨日|昨)$/, -1], [/^(前天|前日)$/, -2],
    [/^大前天$/, -3], [/^(明天|明日)$/, 1], [/^後天$/, 2], [/^大後天$/, 3],
  ];
  for (const [re, off] of fixed) {
    if (re.test(s)) return { date: ymd(addDays(base, off)), matched: s, offsetDesc: `${off} 天` };
  }

  // N 天前 / N 日前 / 前 N 天
  let m = s.match(/^(\d+|[零一二兩三四五六七八九十]+)(天|日)前$/) || s.match(/^前(\d+|[零一二兩三四五六七八九十]+)(天|日)$/);
  if (m) { const n = cnNumToInt(m[1]); if (n != null) return { date: ymd(addDays(base, -n)), matched: s, offsetDesc: `${-n} 天` }; }
  // N 天後 / 後 N 天
  m = s.match(/^(\d+|[零一二兩三四五六七八九十]+)(天|日)後$/) || s.match(/^後(\d+|[零一二兩三四五六七八九十]+)(天|日)$/);
  if (m) { const n = cnNumToInt(m[1]); if (n != null) return { date: ymd(addDays(base, n)), matched: s, offsetDesc: `+${n} 天` }; }

  // 上週X / 這週X / 下週X（週可為「週/禮拜/星期」）
  m = s.match(/^(上|這|本|下)(週|周|禮拜|星期)([一二三四五六日天末])$/);
  if (m) {
    const which = m[1];
    const idx = weekdayCharToMonIdx(m[3]);
    if (idx == null) return null;
    const todayMonIdx = (base.getDay() + 6) % 7;       // 週一=0
    const thisMonday = addDays(base, -todayMonIdx);
    const weekShift = which === '下' ? 7 : ((which === '上') ? -7 : 0);
    const target = addDays(thisMonday, weekShift + idx);
    return { date: ymd(target), matched: s, offsetDesc: `${which}週` };
  }

  // 單獨「週X / 星期X」沒有上/這/下 → 含義不明（這週還上週？）→ 不猜，回 null
  return null;
}
